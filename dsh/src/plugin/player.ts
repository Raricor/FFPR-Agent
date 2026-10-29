/**
 * The dsh glue for the player (control plan §10.3): build the one engine the whole plugin
 * shares, give each agent its own game tools and persona, and add the opening brief on each
 * turn's first step. Nothing under engine/ knows dsh exists; every dsh interface used here is
 * named with its package.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import { BridgeLink } from "../engine/bridge.ts";
import { describeError, isMissingFile } from "../engine/errors.ts";
import { KeyEvents, Watcher } from "../engine/events.ts";
import { Game } from "../engine/game.ts";
import { HealthWaiter } from "../engine/gate.ts";
import { byKey } from "../engine/games.ts";
import { CalledProcessError, fetchProbeLogs, load as loadLaptop } from "../engine/laptop.ts";
import type { Laptop } from "../engine/laptop.ts";
import { AsyncLock } from "../engine/lock.ts";
import { DEPS } from "../engine/paths.ts";
import { createPilot, ensureAgent } from "../engine/link-pilot.ts";
import { systemPrompt } from "../engine/prompt.ts";
import { gameDefaults, type Config } from "./config.ts";
import { formatNotes, formatTactician, notesContext, tacticianContext } from "./notes-prompt.ts";
import { callTactician } from "./tactician.ts";
import { gameToolDefinitions, type GameToolHost } from "./tools.ts";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "ffpr-opening": { kind: "ffpr-opening" } & ContextFormed;
  }
}

const SEED_FILES = 3; // probe files read for the events before this run (a few game starts back)
const OPENING_SECTION = "ffpr:opening";

/** The pieces one plugin instance shares between every agent it serves. */
export interface PlayerEngine {
  readonly laptop: Laptop;
  readonly bridge: BridgeLink | undefined;
  readonly events: KeyEvents | undefined;
  readonly game: Game;
  readonly waiter: HealthWaiter;
  readonly stop: AbortController;
}

export interface PlayerLog {
  info(message: string): void;
  warn(message: string): void;
}

/** The system prompt text, with the Python placeholders filled for dsh. */
export function buildSystemPrompt(game: string, saveSlot?: number): string {
  return systemPrompt(game, saveSlot)
    .replace("目标:{goal}", "目标:用户在对话里给你的目标;用户没说就接着之前的进度玩。")
    .replace("{hint}", "");
}

/** Python's opening: what the player sees now, then the long strategy window. */
export function openingMessage(state: string, window: string): string {
  return (
    "开始。当前状态:\n" + state + (window !== "" ? `\n\n最近几小时的重要事件:\n${window}` : "")
  );
}

/**
 * Add the opening as a user message on each turn's first step only. Its source follows
 * dsh-time-context: a snapshot attributed to this plugin, so replay can show where it came from.
 */
export function withOpening(
  decision: PreStepDecision,
  step: number,
  text: string,
): PreStepDecision {
  if (step !== 1 || decision.kind !== "enter" || text === "") return decision;
  return {
    ...decision,
    messages: [
      ...decision.messages,
      createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "ffpr-opening",
          form: "snapshot",
          sections: [{ name: OPENING_SECTION, text }],
        },
      }),
    ],
  };
}

/**
 * Build the engine at plugin startup: laptop, bridge link, the event stream seeded from the
 * last probe files, the Game (notes, atlas and tactics in the same files the Python player
 * uses), and the health waiter. The caller owns `stop` and aborts the watcher on unload.
 */
export async function startEngine(
  config: Config,
  log: PlayerLog,
  signal?: AbortSignal,
): Promise<PlayerEngine> {
  const laptop = await loadLaptop(config.laptopEnv, signal);
  const defaults = gameDefaults(config.game);
  const bridge = await BridgeLink.load({
    secretsFile: config.secretsFile,
    laptopEnv: config.laptopEnv,
    url: config.bridgeUrl,
    // laptop.env's BRIDGE_URL names FF5's port; the other games use their own port.
    port: defaults.bridgePort,
    laptopUrl: defaults.game.key === "ff5",
    signal,
  });
  const stop = new AbortController();
  const events = bridge
    ? await followEvents(laptop, config.game, bridge, stop.signal, log)
    : undefined;
  const game = await Game.create({
    laptop,
    game: config.game,
    saveSlot: config.saveSlot,
    notesFile: config.notesFile,
    events,
    atlasFile: config.atlasFile,
    tacticsFile: config.tacticsFile,
    elementsFile: config.elementsFile,
    tacticianBoss: config.tacticianBoss,
    signal,
  });
  const waiter = new HealthWaiter({
    check: async (healthSignal) => {
      if (!bridge) throw new Error("没有 BRIDGE_TOKEN,连不上桥插件");
      await bridge.health(healthSignal);
    },
    everyMs: config.checkEveryMs,
    log: (level, message) => {
      if (level === "warn") log.warn(message);
      else log.info(message);
    },
  });
  return { laptop, bridge, events, game, waiter, stop };
}

/**
 * Key events for the planning windows: the last few probe files, then the bridge's stream on
 * the LAN link, exactly like cli/ds.py's follow_events.
 */
async function followEvents(
  laptop: Laptop,
  game: string,
  link: BridgeLink,
  signal: AbortSignal,
  log: PlayerLog,
): Promise<KeyEvents> {
  const events = new KeyEvents();
  try {
    await fetchProbeLogs(laptop, byKey(game), SEED_FILES, signal);
  } catch (error) {
    if (error instanceof CalledProcessError) {
      log.warn(`取探针日志失败,事件窗口只从现在开始:${describeError(error)}`);
    } else {
      signal.throwIfAborted();
      throw error;
    }
  }
  for (const path of await seedFiles(game, signal)) await events.seed(path, signal);
  new Watcher((streamSignal) => link.stream(streamSignal), events).start(signal);
  log.info(`跟随事件流;已有 ${events.entries.length} 条重要事件`);
  return events;
}

async function seedFiles(game: string, signal?: AbortSignal): Promise<string[]> {
  const directory = join(DEPS, game, "probe");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return [];
    signal?.throwIfAborted();
    throw new Error(`读不了探针目录 ${directory}:${describeError(error)}`, { cause: error });
  }
  return names
    .filter((name) => name.startsWith("probe-") && name.endsWith(".jsonl"))
    .sort()
    .slice(-SEED_FILES)
    .map((name) => join(directory, name));
}

/** The calling agent and signal, for the tactician started from inside a tool call. */
export interface TacticianBinding {
  readonly agent?: Agent;
  readonly signal: AbortSignal;
}

/** One Pilot per tool call, and one queue for every Game call: there is only one game. */
export function gameToolHost(
  engine: PlayerEngine,
  bind: (binding: TacticianBinding | null) => void = () => undefined,
): GameToolHost {
  const lock = new AsyncLock();
  return {
    pilot: (signal) =>
      createPilot(engine.laptop, engine.bridge, signal, { game: engine.game.game }),
    run: async (name, args, pilot, signal, agent) => {
      signal.throwIfAborted();
      return lock.run(async () => {
        signal.throwIfAborted();
        bind({ agent, signal });
        try {
          return await engine.game.run(name, args, pilot);
        } finally {
          bind(null);
        }
      });
    },
  };
}

/**
 * Wire the engine into dsh. Tools and the persona belong to each agent's own layer: a
 * restriction only filters inherited tools, so `allow: []` there hides the global surface and
 * keeps ours (dsh-tools `view()`). Registrations live on `agent.ctx`, with a copy of the
 * disposer on this plugin's ctx so plugin unload clears them even before agent disposal.
 */
export function installPlayer(ctx: Context, engine: PlayerEngine, log: PlayerLog): void {
  let binding: TacticianBinding | null = null;
  const host = gameToolHost(engine, (call) => {
    binding = call;
  });
  const tools = gameToolDefinitions(host, engine.game.game, engine.game.saveSlot);
  const personaText = buildSystemPrompt(engine.game.game, engine.game.saveSlot);
  const disposers = new Map<string, () => Promise<void>>();

  // The tactician runs under the same agent and cancellation as the tool call that needed it.
  engine.game.setTactician(async (facts) => {
    if (binding?.agent === undefined) {
      throw new Error("这次工具调用没有主智能体,叫不了战术官");
    }
    return await callTactician(
      ctx.subagents,
      binding.agent,
      binding.signal,
      engine.game.game,
      facts,
    );
  });

  ctx.effect(() => {
    // Notes live in memory (remember/forget update Game.notes); dsh re-reads the provider on
    // admission after agent/pre-step (dsh-agent-loop step()).
    const contexts = [
      ctx.systemPrompt.context(notesContext(() => formatNotes(engine.game.notes))),
      ctx.systemPrompt.context(
        tacticianContext(() => formatTactician(engine.game.tacticianInfo())),
      ),
    ];
    return () => {
      for (const dispose of contexts.reverse()) dispose();
    };
  });

  ctx.on("agent/created", ({ agent }) => {
    disposers.set(agent.id, registerAgent(agent, tools, personaText));
  });
  ctx.on("agent/disposed", ({ agent }) => {
    // The agent's own scope unwinds its registrations; drop our copy of the disposer only.
    disposers.delete(agent.id);
  });

  ctx.effect(() => async () => {
    const pending = [...disposers.values()].map((dispose) => dispose());
    disposers.clear();
    await Promise.all(pending);
  });

  ctx.on("agent/pre-step", async ({ step, signal }, next) => {
    // Kept from the spike: a step waits for the bridge instead of losing the user's message.
    await engine.waiter.wait(signal);
    signal.throwIfAborted();
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted || step !== 1) return decision;
    // The pilot agent quits after 30 idle minutes and dsh turns can be hours apart, so each
    // turn checks it; ffpr-ds checked once at start (10-27: every walk_to failed over SSH).
    if (await ensureAgent(engine.laptop, engine.game.game, signal))
      log.info("试玩助手没在运行,已启动");
    // Strategy's window (control plan §4.8), as Python's play(): read it before the state.
    const window = engine.game.window(1);
    const pilot = host.pilot(signal);
    return withOpening(decision, step, openingMessage(await engine.game.observe(pilot), window));
  });
}

function registerAgent(
  agent: Agent,
  tools: ReturnType<typeof gameToolDefinitions>,
  personaText: string,
): () => Promise<void> {
  return agent.ctx.effect(() => {
    const owned: (() => void)[] = [];
    for (const tool of tools) owned.push(agent.ctx.tools.register(tool));
    owned.push(agent.ctx.tools.restrict({ allow: [] }));
    // dsh-persona's own registration, inlined: the preset's complete persona is the system
    // prompt, and optional runtime facts stay out of it (10-27: the model called
    // working_directory from the base composition).
    owned.push(
      agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
        text: personaText,
        complete: true,
      }),
    );
    owned.push(agent.ctx.systemPrompt.suppressRuntimeContext());
    return () => {
      for (const dispose of owned.reverse()) dispose();
    };
  });
}

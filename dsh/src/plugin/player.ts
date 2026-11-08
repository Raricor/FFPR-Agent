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
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import { ActivityLog, activityFile } from "../engine/activity.ts";
import type { AchievementView } from "../engine/achievements.ts";
import { BridgeLink } from "../engine/bridge.ts";
import { readEnvFile } from "../engine/env.ts";
import { describeError, isMissingFile } from "../engine/errors.ts";
import { KeyEvents, WINDOWS, Watcher } from "../engine/events.ts";
import { Game } from "../engine/game.ts";
import { messageText, PlayerJournal } from "../engine/player-log.ts";
import { HealthWaiter } from "../engine/gate.ts";
import { byKey } from "../engine/games.ts";
import { LABEL, type KeyEntry } from "../engine/keylog.ts";
import { CalledProcessError, fetchProbeLogs, load as loadLaptop } from "../engine/laptop.ts";
import type { Laptop } from "../engine/laptop.ts";
import { AsyncLock } from "../engine/lock.ts";
import { DEPS } from "../engine/paths.ts";
import { createPilot, ensureAgent } from "../engine/link-pilot.ts";
import type { Pilot } from "../engine/pilot.ts";
import { systemPrompt } from "../engine/prompt.ts";
import { text } from "../engine/values.ts";
import { Redactor } from "../engine/redact.ts";
import { gameDefaults, type Config } from "./config.ts";
import { detectRunning, type DetectionResult, type RunningDetector } from "./detect.ts";
import { formatNotes, formatTactician, notesContext, tacticianContext } from "./notes-prompt.ts";
import { registerPresetMount } from "./preset-hooks.ts";
import { installPresetSwitch, playerPresetId, type PresetSelector } from "./preset-switch.ts";
import type { EngineSlot } from "./registry.ts";
import { callTactician } from "./tactician.ts";
import { gameToolDefinitions, type GameToolHost } from "./tools.ts";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "ffpr-opening": { kind: "ffpr-opening" } & ContextFormed;
    "ffpr-notice": { kind: "ffpr-notice" } & ContextFormed;
  }
}

const SEED_FILES = 3; // probe files read for the events before this run (a few game starts back)
const OPENING_SECTION = "ffpr:opening";
const NOTICE_SECTION = "ffpr:notice";

/** The pieces one plugin instance shares between every agent it serves. */
export interface PlayerEngine {
  readonly laptop: Laptop;
  readonly bridge: BridgeLink | undefined;
  readonly events: KeyEvents | undefined;
  readonly watcher: Watcher | undefined;
  readonly activity: ActivityLog;
  readonly game: Game;
  readonly waiter: HealthWaiter;
  readonly stop: AbortController;
  /** ISO time this engine started; the current-game rule uses the newest one. */
  readonly startedAt: string;
  /** The first layer's session journal, shared with the ① 玩家 page. */
  readonly journal: PlayerJournal;
  /** The most recent achievement read, for the total-control card's save count. */
  achievement: AchievementView | null;
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
export function openingMessage(state: string, window: string, notes = ""): string {
  return (
    "开始。当前状态:\n" +
    state +
    (window !== "" ? `\n\n最近几小时的重要事件:\n${window}` : "") +
    (notes !== "" ? `\n\n${notes}` : "")
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
 * Add a notice on each turn's first step, with its own source so replay can tell it apart from
 * the opening. A `reject` decision would end the step and the user would see nothing (task 31).
 */
export function withNotice(decision: PreStepDecision, step: number, text: string): PreStepDecision {
  if (step !== 1 || decision.kind !== "enter" || text === "") return decision;
  return {
    ...decision,
    messages: [
      ...decision.messages,
      createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "ffpr-notice",
          form: "snapshot",
          sections: [{ name: NOTICE_SECTION, text }],
        },
      }),
    ],
  };
}

/**
 * What the model reads when the laptop is not playing this preset's game. The wording tells it
 * both the situation and what the user can do, and forbids game tools for this turn.
 */
export function situationNotice(detection: DetectionResult, game: string): string {
  const mine = byKey(game).label;
  if (!detection.ok) {
    return (
      `查不到笔记本上开着哪一作（原因：${detection.error}）。这个会话玩的是 ${mine}。` +
      "这一轮不要调用游戏工具：请直接用一两句话把情况转告用户，并说怎么办：" +
      "先确认笔记本开着、连得上，再继续。"
    );
  }
  const running = detection.running.map((key) => byKey(key).label);
  if (running.length === 0) {
    return (
      `笔记本上没有游戏在运行，这个会话玩的是 ${mine}。` +
      "这一轮不要调用游戏工具：请直接用一两句话告诉用户先在笔记本上启动 " +
      `${mine}，然后再继续。`
    );
  }
  if (running.length === 1) {
    const other = running[0];
    return (
      `笔记本上开着的是 ${other}，这个会话玩的是 ${mine}。` +
      "这一轮不要调用游戏工具：请直接用一两句话告诉用户新建一个" +
      `「${other} 玩家」会话，或者在笔记本上关掉 ${other}、开 ${mine}。`
    );
  }
  const mineOpen = detection.running.includes(game.toLowerCase());
  return (
    `笔记本上开着 ${running.join("、")}，这个会话玩的是 ${mine}。一次只开一作。` +
    "这一轮不要调用游戏工具：请直接用一两句话告诉用户先关掉别的作品，" +
    (mineOpen ? `只留 ${mine}，再继续。` : `只留一作，然后在笔记本上开 ${mine} 再继续。`)
  );
}

/**
 * Build the engine on the slot's first use: laptop, bridge link, the event stream seeded from
 * the last probe files, the Game (notes, atlas and tactics in the same files the Python player
 * uses), and the health waiter. The caller (createEngineSlot) owns `stop`. If a later step
 * fails, the watcher and bridge are closed here before the error reaches the slot, so a retry
 * never leaves a second stream behind.
 */
export async function startEngine(
  config: Config,
  log: PlayerLog,
  signal?: AbortSignal,
  sharedJournal?: PlayerJournal,
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
  // Mask every value in secrets.env before it can reach a log line (task 24).
  const redactor = new Redactor();
  for (const value of Object.values(await readEnvFile(config.secretsFile, signal))) {
    redactor.add(value);
  }
  const journal =
    sharedJournal ??
    (await PlayerJournal.load({
      file: config.playerFile,
      warn: (message) => {
        log.warn(message);
      },
    }));
  const activity = await ActivityLog.load({
    game: config.game,
    file: activityFile(config.game),
    redact: (value) => redactor.redact(value),
    warn: (message) => {
      log.warn(message);
    },
  });
  try {
    const followed = bridge
      ? await followEvents(laptop, config.game, bridge, stop.signal, log, activity)
      : undefined;
    const events = followed?.events;
    const game = await Game.create({
      laptop,
      game: config.game,
      saveSlot: config.saveSlot,
      notesFile: config.notesFile,
      events,
      atlasFile: config.atlasFile,
      tacticsFile: config.tacticsFile,
      elementsFile: config.elementsFile,
      battlesFile: config.battlesFile,
      tacticianFile: config.tacticianFile,
      backlogFile: config.backlogFile,
      incidentsFile: config.incidentsFile,
      incidentsStateFile: config.incidentsStateFile,
      bestiarySaveFile: config.bestiarySaveFile,
      tacticianBoss: config.tacticianBoss,
      travelMaxHops: config.travelMaxHops,
      travelMaxMinutes: config.travelMaxMinutes,
      walkpathTimeoutMs: config.walkpathTimeoutMs,
      walkpathBlockedMs: config.walkpathBlockedMs,
      walkpathTurnLead: config.walkpathTurnLead,
      walkpathEventPollMs: config.walkpathEventPollMs,
      walkpathEventWaitMs: config.walkpathEventWaitMs,
      signal,
    });
    game.onIncident = (message) => {
      activity.record("error", message);
    };
    // Bridge 0.13's battle.act / battle.hit are not key events; fold them into the live battle.
    const savePilot =
      bridge === undefined ? null : createPilot(laptop, bridge, stop.signal, { game: config.game });
    events?.onRecord((record) => {
      if (record.type === "battle.act" || record.type === "battle.hit") {
        game.battles.noteEvent(record);
      }
      if (record.type === "battle.hit") game.bestiary.observeHit(record);
      // save.write is the game's own completion signal: snapshot at the new save count even
      // when the save was made outside save_game. A short wait lets pos.saves catch up.
      if (record.type === "save.write" && text(record.result) === "Success" && savePilot !== null) {
        const pilot = savePilot;
        void (async () => {
          try {
            await pilot.sleep(300);
            await game.captureBestiary(pilot);
          } catch {
            // The next save or the opening refresh will retry.
          }
        })();
      }
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
    return {
      laptop,
      bridge,
      events,
      watcher: followed?.watcher,
      activity,
      game,
      waiter,
      stop,
      startedAt: new Date().toISOString(),
      journal,
      achievement: null,
    };
  } catch (error) {
    stop.abort();
    bridge?.close();
    throw error;
  }
}

/**
 * The lazy engine slot (task 31): `apply()` only creates this, so loading the plugin touches no
 * laptop. The first caller starts the engine; a failure clears the in-flight promise so the next
 * caller retries. `stop()` also covers an unload while `startEngine` is still running.
 */
export function createEngineSlot(
  config: Config,
  log: PlayerLog,
  start: typeof startEngine = startEngine,
  journal?: PlayerJournal,
): EngineSlot {
  let engine: PlayerEngine | undefined;
  let starting: Promise<PlayerEngine> | undefined;
  let stopped = false;

  return {
    game: config.game,
    current: () => engine,
    ensure: (signal) => {
      if (engine !== undefined) return Promise.resolve(engine);
      if (starting !== undefined) return starting;
      if (stopped) {
        return Promise.reject(new Error(`${byKey(config.game).label} 的引擎已经卸载`));
      }
      const pending = start(config, log, signal, journal)
        .then((started) => {
          if (stopped) {
            stopEngine(started);
            throw new Error(`${byKey(config.game).label} 的引擎已经卸载`);
          }
          engine = started;
          return started;
        })
        .finally(() => {
          if (starting === pending) starting = undefined;
        });
      starting = pending;
      return pending;
    },
    stop: () => {
      stopped = true;
      const started = engine;
      engine = undefined;
      if (started !== undefined) stopEngine(started);
    },
  };
}

function stopEngine(engine: PlayerEngine): void {
  engine.stop.abort();
  engine.bridge?.close();
}

/**
 * One activity line per key entry (task 24 review). A story entry grows as its pages arrive, so
 * the listener sees the same KeyEntry several times; the WeakSet keeps only the first text.
 * Empty text is not marked as seen: a scene entry can be created before its first line.
 */
export function activityEntryRecorder(activity: ActivityLog): (entry: KeyEntry) => void {
  const recorded = new WeakSet<KeyEntry>();
  return (entry) => {
    if (recorded.has(entry)) return;
    if (entry.text === "" || !WINDOWS[2].types.has(entry.type)) return;
    recorded.add(entry);
    activity.record("event", `${LABEL[entry.type] ?? entry.type} ${entry.text}`);
  };
}

interface FollowedEvents {
  readonly events: KeyEvents;
  readonly watcher: Watcher;
}

/**
 * Key events for the planning windows: the last few probe files, then the bridge's stream on
 * the LAN link, exactly like cli/ds.py's follow_events. The activity page also records the
 * stream's connection changes and the tactical-layer entries the Builder produces (task 24).
 */
async function followEvents(
  laptop: Laptop,
  game: string,
  link: BridgeLink,
  signal: AbortSignal,
  log: PlayerLog,
  activity: ActivityLog,
): Promise<FollowedEvents> {
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
  // Seeded history is deliberately not logged: the page shows what happens from now on.
  events.onEntry(activityEntryRecorder(activity));
  let everUp = false;
  const watcher = new Watcher(
    (streamSignal) => link.stream(streamSignal),
    events,
    5.0,
    (status) => {
      if (status.up) {
        everUp = true;
        activity.record("link", "连上桥插件");
        return;
      }
      const reason = status.error ?? "连接已断开";
      activity.record("link", everUp ? `桥插件断开:${reason}` : "连不上桥插件，游戏可能没开");
    },
  );
  watcher.start(signal);
  log.info(`跟随事件流;已有 ${events.entries.length} 条重要事件`);
  return { events, watcher };
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

/**
 * One Pilot per tool call, and one queue for every Game call: there is only one game. The host
 * resolves the slot on every call, so an agent created before the engine started still gets the
 * real engine later, and a call before that is a Chinese tool error rather than a crash.
 */
export function gameToolHost(
  slot: EngineSlot,
  prepare: (engine: PlayerEngine) => void = () => undefined,
  bind: (binding: TacticianBinding | null) => void = () => undefined,
): GameToolHost {
  const lock = new AsyncLock();
  const engineOf = (): PlayerEngine => {
    const engine = slot.current();
    if (engine === undefined) throw new Error(`${byKey(slot.game).label} 没在运行`);
    prepare(engine);
    return engine;
  };
  return {
    pilot: (signal) => {
      const engine = engineOf();
      return createPilot(engine.laptop, engine.bridge, signal, {
        game: engine.game.game,
        // The pilot agent's auto-restart (task 28) must be visible in the overview's log.
        log: (message) => {
          engine.activity.record("event", message);
        },
      });
    },
    run: async (name, args, pilot, signal, agent) => {
      signal.throwIfAborted();
      return lock.run(async () => {
        signal.throwIfAborted();
        const engine = engineOf();
        // The overview's busy line follows the tool that actually holds the one game, not the
        // calls queued behind it.
        engine.activity.beginTool(name);
        bind({ agent, signal });
        try {
          return await engine.game.run(name, args, pilot);
        } finally {
          bind(null);
          engine.activity.endTool();
        }
      });
    },
  };
}

/**
 * Fold one `session/event` into the ① 玩家 journal (task 40). Only a direct user message, the
 * assistant's visible text (reasoning excluded), and tool calls/results are kept; subagent
 * events and harness-injected context are ignored by the source check.
 */
export function recordSessionEvent(journal: PlayerJournal, event: SessionEvent): void {
  const at = new Date(event.time).toISOString();
  switch (event.type) {
    case "user/message": {
      if (event.data.source.kind !== "user") return;
      const text = messageText(event.data.content);
      if (text !== "") journal.record({ kind: "user", at, text });
      return;
    }
    case "assistant/message": {
      const text = messageText(event.data.message.content);
      if (text !== "") journal.record({ kind: "assistant", at, text });
      return;
    }
    case "tool/call": {
      journal.record({
        kind: "tool-call",
        at,
        callId: event.data.callId,
        name: event.data.name,
        args: event.data.arguments,
      });
      return;
    }
    case "tool/result": {
      journal.record({
        kind: "tool-result",
        at,
        callId: event.data.message.toolCallId,
        ok: event.data.message.isError !== true,
        text: messageText(event.data.message.content),
      });
      return;
    }
    default:
      return;
  }
}

/**
 * Wire the slot into dsh. Tools, the persona and the dynamic contexts are built from Config,
 * never from a started engine: creating an agent must not reach the laptop (task 31). Notes and
 * tactician text are empty until the engine starts, then their provider reads the live Game.
 *
 * Tools and the persona belong to each agent's own layer: a restriction only filters inherited
 * tools, so `allow: []` there hides the global surface and keeps ours (dsh-tools `view()`).
 * Registrations live on `agent.ctx`, with a copy of the disposer on this plugin's ctx so plugin
 * unload clears them even before agent disposal.
 */
export function installPlayer(
  ctx: Context,
  slot: EngineSlot,
  config: Config,
  log: PlayerLog,
  detect: RunningDetector = (signal) => detectRunning(config, signal),
  presets?: PresetSelector,
  journal: PlayerJournal = new PlayerJournal(),
): void {
  let binding: TacticianBinding | null = null;
  const prepare = (engine: PlayerEngine): void => {
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
  };
  const host = gameToolHost(slot, prepare, (call) => {
    binding = call;
  });
  const tools = gameToolDefinitions(
    host,
    config.game,
    config.saveSlot,
    () => slot.current()?.activity,
  );
  const personaText = buildSystemPrompt(config.game, config.saveSlot);
  const disposers = new Map<string, () => Promise<void>>();

  ctx.on("session/event", (_session, event) => {
    try {
      recordSessionEvent(journal, event);
    } catch (error) {
      log.warn(`记玩家事件失败:${describeError(error)}`);
    }
  });

  ctx.effect(() => {
    // Notes live in memory (remember/forget update Game.notes); dsh re-reads the provider on
    // admission after agent/pre-step (dsh-agent-loop step()).
    const contexts = [
      ctx.systemPrompt.context(notesContext(() => formatNotes(slot.current()?.game.notes ?? []))),
      ctx.systemPrompt.context(
        tacticianContext(() => formatTactician(slot.current()?.game.tacticianInfo() ?? null)),
      ),
    ];
    return () => {
      for (const dispose of contexts.reverse()) dispose();
    };
  });

  const ownPreset = playerPresetId(config.game);
  const presetService =
    presets ?? (typeof ctx.get === "function" ? ctx.get("agentPresets") : undefined);

  /** The committed preset, or undefined when no registry can answer (compatibility path). */
  const currentPreset = (agent: Agent): string | undefined => {
    if (presetService === undefined) return undefined;
    try {
      return presetService.composedPreset(agent.ctx);
    } catch {
      return undefined;
    }
  };

  const mountAgent = (agent: Agent): void => {
    // Agent.id is a SessionId (dsh-agent types), the same key agent-preset/selected carries.
    if (disposers.has(agent.id)) return;
    try {
      disposers.set(agent.id, registerAgent(agent, tools, personaText));
    } catch (error) {
      log.warn(
        `给会话 ${agent.id} 挂 ${byKey(config.game).label} 的工具失败:${describeError(error)}`,
      );
    }
  };

  const unmountAgent = (sessionId: string): void => {
    const dispose = disposers.get(sessionId);
    if (dispose === undefined) return;
    disposers.delete(sessionId);
    void dispose().catch((error: unknown) => {
      log.warn(`撤掉会话 ${sessionId} 的工具失败:${describeError(error)}`);
    });
  };

  ctx.on("agent/created", ({ agent }) => {
    // A switch listener may have run first; mounting must follow the preset the agent is
    // actually composed from, not the plugin instance that happens to see the event first.
    const current = currentPreset(agent);
    if (current !== undefined && current !== ownPreset) return;
    mountAgent(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    // The agent's own scope unwinds its registrations; drop our copy of the disposer only.
    disposers.delete(agent.id);
  });
  // 11-02 (task 32): `select` only rebinds the agent. The old preset's per-agent tools and
  // persona stay on the agent, and the new preset's agent/created never runs. React to the
  // committed change instead: drop our set, or add the set for this preset.
  ctx.on("agent-preset/selected", (sessionId, agentPreset) => {
    try {
      if (agentPreset !== ownPreset) {
        unmountAgent(sessionId);
        return;
      }
      if (disposers.has(sessionId)) return;
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) {
        log.warn(`会话 ${sessionId} 换到 ${agentPreset},但找不到它的 Agent,没有挂上工具`);
        return;
      }
      if (agent.session.header.origin === "subagent") return;
      mountAgent(agent);
    } catch (error) {
      log.warn(`处理会话 ${sessionId} 的预设切换失败:${describeError(error)}`);
    }
  });

  // Publish this instance's per-session mount so another player preset can mount us inside the
  // same agent/created dispatch that selects us. The disposer removes only this object.
  ctx.effect(() => registerPresetMount(config.game, { mount: mountAgent, unmount: unmountAgent }));

  // 11-02 (task 32): the service comes from @deepseek-ai/dsh-agent-preset-registry (index.ts's
  // inject). Tests that build a bare fake context pass it explicitly; a real context resolves it.
  if (presetService !== undefined || typeof ctx.get === "function") {
    installPresetSwitch(ctx, presetService, config, log, detect, { unmount: unmountAgent });
  }

  ctx.effect(() => async () => {
    const pending = [...disposers.values()].map((dispose) => dispose());
    disposers.clear();
    await Promise.all(pending);
  });

  ctx.on("agent/pre-step", async ({ agent, step, signal }, next) => {
    // 11-02 real machine: after select, the new preset's plugin did not receive
    // agent-preset/selected (the registry emits on the host layer and dsh-scope filters it out
    // of the preset composition). This is only a fallback: the step's prompt and tool list are
    // already chosen, so a mount here takes effect from the next round. preset-switch.ts mounts
    // the target before the first turn; this path also catches a manual web preset change, whose
    // first round may still miss.
    if (agent.session.header.origin !== "subagent") {
      const current = currentPreset(agent);
      if (current === undefined || current === ownPreset) mountAgent(agent);
    }
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted) return decision;
    if (step !== 1) {
      // Later steps keep the old wait when an engine is running; an idle slot has nothing to
      // wait for (task 31).
      const running = slot.current();
      if (running === undefined) return decision;
      await running.waiter.wait(signal);
      signal.throwIfAborted();
      return decision;
    }

    // First step of a turn: only the game the laptop actually has open may start an engine.
    const detection = await detect(signal);
    signal.throwIfAborted();
    const mine = slot.game.toLowerCase();
    const started = slot.current();
    const bridgeConnected = started?.watcher?.connected === true;
    if (!detection.ok && bridgeConnected) {
      // The bridge answering is stronger evidence than a failed SSH check: keep the turn.
      log.warn(
        `检测笔记本上开着的作品失败,但 ${byKey(slot.game).label} 的桥插件还连着,照常开始:` +
          detection.error,
      );
    } else if (!(detection.ok && detection.running.length === 1 && detection.running[0] === mine)) {
      return withNotice(decision, step, situationNotice(detection, slot.game));
    }

    let engine: PlayerEngine;
    try {
      engine = await slot.ensure(signal);
    } catch (error) {
      signal.throwIfAborted();
      return withNotice(
        decision,
        step,
        `启动 ${byKey(slot.game).label} 的引擎失败（${describeError(error)}）。` +
          "这一轮不要调用游戏工具：请直接用一两句话把情况转告用户，并说怎么办：稍后再试。",
      );
    }
    prepare(engine);
    // Kept from the spike: a step waits for the bridge instead of losing the user's message.
    await engine.waiter.wait(signal);
    signal.throwIfAborted();
    // The pilot agent quits after 30 idle minutes and dsh turns can be hours apart, so each
    // turn checks it; ffpr-ds checked once at start (10-27: every walk failed over SSH).
    if (await ensureAgent(engine.laptop, engine.game.game, signal))
      log.info("试玩助手没在运行,已启动");
    // Strategy's window (control plan §4.8), as Python's play(): read it before the state.
    const window = engine.game.window(1);
    const pilot = host.pilot(signal);
    const openingNotes = (engine.game as { openingNotes?: (pilot: Pilot) => Promise<string> })
      .openingNotes;
    // 11-04: called detached, `this` was undefined and every turn ended at "reading 'incidents'".
    const notes = (await openingNotes?.call(engine.game, pilot)) ?? "";
    signal.throwIfAborted();
    return withOpening(
      decision,
      step,
      openingMessage(await engine.game.observe(pilot), window, notes),
    );
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

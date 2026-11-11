/**
 * The dsh glue for the player (control plan §10.3): build the one engine the whole plugin
 * shares, give each agent its own game tools and persona, and add the opening brief on each
 * turn's first step. Nothing under engine/ knows dsh exists; every dsh interface used here is
 * named with its package.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { WorkspaceController } from "@deepseek-ai/dsh-api-workspace-controller";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import { ActivityLog, activityFile } from "../engine/activity.ts";
import type { AchievementView } from "../engine/achievements.ts";
import { BridgeLink } from "../engine/bridge.ts";
import { readEnvFile } from "../engine/env.ts";
import { describeError, isMissingFile } from "../engine/errors.ts";
import { KeyEvents, WINDOWS, Watcher } from "../engine/events.ts";
import { Game, INTERNAL_CHAPTER_RUN, describeChapterReport } from "../engine/game.ts";
import { cleanIconTags } from "../engine/icons.ts";
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
import type { ToolDefinition, ToolGuard } from "@deepseek-ai/dsh-tools";
import type { ChapterPlan } from "../engine/plan/chapter-types.ts";
import { DEFAULT_SEGMENT_BUDGET_MS } from "../engine/plan/execute.ts";
import {
  CHAPTER_TOOL_DEFINITIONS,
  chapterBusyText,
  type ChapterOwner,
} from "../engine/plan/chapter-tools.ts";
import { PLAN_FACTS_TOOL, SUBMIT_PLAN_TOOL } from "../engine/plan/tools.ts";
import { systemPrompt, EXECUTE_PLAN_TOOL, PLAN_STATUS_TOOL, SCOUT_TOOL } from "../engine/prompt.ts";
import { configureInstinct } from "../engine/strategy/execute.ts";
import { isRecord, text } from "../engine/values.ts";
import { Redactor } from "../engine/redact.ts";
import { gameDefaults, type Config } from "./config.ts";
import { detectRunning, type DetectionResult, type RunningDetector } from "./detect.ts";
import { formatNotes, formatTactician, notesContext, tacticianContext } from "./notes-prompt.ts";
import {
  ProgressWatchdog,
  type GoalServiceLike,
  type GoalViewLike,
  type ProgressBuffer,
} from "./progress-watchdog.ts";
import { registerPresetMount } from "./preset-hooks.ts";
import { installPresetSwitch, playerPresetId, type PresetSelector } from "./preset-switch.ts";
import type { EngineSlot } from "./registry.ts";
import { startTactician, TACTICIAN_TIMEOUT_MS, TacticianArchiveQueue } from "./tactician.ts";
import { callStageOfficer } from "./stage-officer.ts";
import {
  DEFAULT_TIMEOUT_MS,
  gameToolDefinitions,
  type ActivitySource,
  type GameToolHost,
} from "./tools.ts";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "ffpr-opening": { kind: "ffpr-opening" } & ContextFormed;
    "ffpr-notice": { kind: "ffpr-notice" } & ContextFormed;
    "ffpr-chapter": { kind: "ffpr-chapter" } & ContextFormed;
  }
}

const SEED_FILES = 3; // probe files read for the events before this run (a few game starts back)
const OPENING_SECTION = "ffpr:opening";
const NOTICE_SECTION = "ffpr:notice";

/**
 * The model-facing goal tools from `@deepseek-ai/dsh-tool-goal` (its README.zh.md「工具」table).
 * A `restrict` mask only filters inherited tools, and task 107's `allow: []` hid all three, so
 * the model saw no goal tool and never entered goal mode (task 111).
 */
const GOAL_TOOL_NAMES: readonly string[] = ["get_goal", "create_goal", "update_goal"];

/** Task 139: the four plan tools, in the order the model reads them. */
export const PLAN_MODE_PLAN_TOOLS: readonly string[] = [
  "plan_facts",
  "submit_plan",
  "execute_plan",
  "plan_status",
];

/** Task 153: the chapter tools, in the order the model reads them. Task 155 removed the
 * executor tool: submitting the rule file is the handoff, and code runs the chapter. */
export const CHAPTER_MODE_PLAN_TOOLS: readonly string[] = [
  ...CHAPTER_TOOL_DEFINITIONS.map((tool) => tool.name),
];

/** Task 155: the tools that may not change the rule file while the executor owns the chapter. */
export const CHAPTER_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "chapter_draft_segment",
  "chapter_draft_meta",
  "submit_chapter_plan",
]);

/**
 * Task 160: the plugin's view of who owns the chapter. `chapter` is set while the executor is
 * running or waiting for repair; the optional status keeps the old test/constructor shape
 * (`{ chapter: 4 }`) meaning "running".
 */
export interface ChapterGate {
  chapter: number | null;
  status?: "running" | "blocked" | null;
}

/** The ownership a gate currently means, or null when the model may act again. */
export function chapterOwnerOf(gate: ChapterGate): ChapterOwner | null {
  if (gate.chapter === null) return null;
  return {
    chapter: gate.chapter,
    status: gate.status === "blocked" ? "blocked" : "running",
  };
}

/**
 * Task 160: the model's tool guard while the executor owns the chapter. Everything is refused
 * except the read-only `chapter_status`; the returned string is the one Chinese sentence the
 * model sees, so a stale round cannot create a goal, edit the draft, submit again or press keys.
 */
export function chapterToolGuard(chapter: () => ChapterOwner | null): ToolGuard {
  return (execution) => {
    if (execution.name === "chapter_status") return undefined;
    const owner = chapter();
    return owner === null ? undefined : chapterBusyText(owner);
  };
}

/**
 * Task 139: the only game tools plan mode keeps. Each is a read-only query: guide and atlas
 * read files/knowledge, inventory queries the bag, and look_around/terrain/entrances query the
 * bridge's entity and map data. None presses a key, moves, or changes game state.
 */
export const PLAN_MODE_READONLY_TOOLS: readonly string[] = [
  "guide",
  "atlas",
  "inventory",
  "look_around",
  "terrain",
  "entrances",
];

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
  /** Task 78: how often a waiting send checks the pilot agent's pid, from Config. */
  readonly agentCheckMs: number;
}

export interface PlayerLog {
  info(message: string): void;
  warn(message: string): void;
  /** Write warnings logged before an engine (and its activity log) existed. */
  flush?(activity: ActivityLog): void;
}

/**
 * The plugin's logger: dsh's `ctx.logger` keeps messages only in cordis's in-memory buffer
 * (LoggerService, cordis logger.d.ts) unless a host exporter is registered; the web profile
 * registers one only during startup, so a warning never reaches ~/.dsh/logs/web-ffpr.log
 * (task 46). Keep using the dsh logger, and mirror warn/error-level lines into the running
 * game's activity log, which is what the overview page reads. ActivityLog redacts secrets
 * before writing.
 */
export function createPlayerLog(
  logger: PlayerLog,
  activities: () => Iterable<ActivityLog | undefined>,
): PlayerLog {
  const pending: string[] = [];
  const record = (activity: ActivityLog, message: string): void => {
    try {
      activity.record("warn", message);
    } catch {
      // A logging sink must never break the plugin or an agent listener.
    }
  };
  return {
    info: (message) => {
      logger.info(message);
    },
    warn: (message) => {
      logger.warn(message);
      let written = false;
      for (const activity of activities()) {
        if (activity === undefined) continue;
        record(activity, message);
        written = true;
      }
      // The engine may start later (or not at all); keep the line for its activity log.
      if (!written) pending.push(message);
    },
    flush: (activity) => {
      for (const message of pending.splice(0)) record(activity, message);
    },
  };
}

/** The system prompt text, with the Python placeholders filled for dsh. */
export function buildSystemPrompt(
  game: string,
  saveSlot?: number,
  planMode = false,
  chapterMode = false,
): string {
  return systemPrompt(game, saveSlot, planMode, chapterMode)
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
  log.flush?.(activity);
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
      routeFile: config.routeFile,
      routeBattleSeconds: config.routeBattleSeconds,
      stagePlanFile: config.stagePlanFile,
      routeBookEnabled: config.routeBookEnabled,
      routeBookAutoPlan: config.routeBookAutoPlan,
      routeBookGrindMinutes: config.routeBookGrindMinutes,
      routeBookSaveMinutes: config.routeBookSaveMinutes,
      routeBookAheadSections: config.routeBookAheadSections,
      routeBookTimeBudgetMs: config.routeBookTimeBudgetMs,
      routeBookProgressFile: config.routeBookProgressFile,
      routeBookLearnedFile: config.routeBookLearnedFile,
      segmentPlanFile: config.segmentPlanFile,
      segmentReportFile: config.segmentReportFile,
      scoutDir: config.scoutDir,
      scoutMinutes: config.scoutMinutes,
      scoutMaxTargets: config.scoutMaxTargets,
      stageAutoPlan: config.stageAutoPlan,
      stageGoGate: config.stageGoGate,
      stageGoFollowPlan: config.stageGoFollowPlan,
      stageContinueAfterTravel: config.stageContinueAfterTravel,
      stageTurnBackDistance: config.stageTurnBackDistance,
      stageBossLevelGap: config.stageBossLevelGap,
      healHpPercent: config.healHpPercent,
      healMpReservePercent: config.healMpReservePercent,
      healItemHpPercent: config.healItemHpPercent,
      healFullPercent: config.healFullPercent,
      saveTimerMinSeconds: config.saveTimerMinSeconds,
      storyStuckSeconds: config.storyStuckSeconds,
      storyExploreMinutes: config.storyExploreMinutes,
      tacticianBoss: config.tacticianBoss,
      tacticianIntervalMinutes: config.tacticianIntervalMinutes,
      travelMaxHops: config.travelMaxHops,
      travelMaxMinutes: config.travelMaxMinutes,
      bestiaryDeferBattles: config.bestiaryDeferBattles,
      bestiaryMissableMinutes: config.bestiaryMissableMinutes,
      walkpathTimeoutMs: config.walkpathTimeoutMs,
      walkpathBlockedMs: config.walkpathBlockedMs,
      walkpathTurnLead: config.walkpathTurnLead,
      walkpathEventPollMs: config.walkpathEventPollMs,
      walkpathEventWaitMs: config.walkpathEventWaitMs,
      blockedTrustCount: config.blockedTrustCount,
      carryRepeatLimit: config.carryRepeatLimit,
      carryTotalLimit: config.carryTotalLimit,
      signal,
    });
    game.onIncident = (message) => {
      activity.record("error", message);
    };
    // Task 104: the same knobs for fights called directly (fight, the boss path), which carry
    // no per-call options because GameOptions cannot grow in this task.
    configureInstinct({
      itemHealHpPercent: config.battleItemHealPercent,
      fleeOnTimer: config.battleFleeOnTimer,
    });
    // Task 104: Game builds the battle hooks but its GameOptions cannot grow in this task
    // (task 100 is editing game.ts). moveState.battle is the same object Game keeps as
    // this.hooks, so setting the instinct knobs here reaches every regular fight.
    if (game.moveState.battle !== undefined) {
      game.moveState.battle.instinct = {
        itemHealHpPercent: config.battleItemHealPercent,
        fleeOnTimer: config.battleFleeOnTimer,
      };
    }
    // Task 101/141: a coordinate `go` allowed with a reason is a normal event; the segment
    // executor's step lines carry kind "plan" so the sidebar can tell them apart.
    game.onActivity = (message, kind = "event") => {
      activity.record(kind, message);
    };
    // Bridge 0.13's battle.act / battle.hit are not key events; fold them into the live battle.
    const savePilot =
      bridge === undefined
        ? null
        : createPilot(laptop, bridge, stop.signal, {
            game: config.game,
            agentCheckMs: config.agentCheckMs,
          });
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
      agentCheckMs: config.agentCheckMs,
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
    throw new Error(`读不了探针目录 ${directory}:${describeError(error)}`, {
      cause: error,
    });
  }
  return names
    .filter((name) => name.startsWith("probe-") && name.endsWith(".jsonl"))
    .sort()
    .slice(-SEED_FILES)
    .map((name) => join(directory, name));
}

/**
 * Task 105: the FF5-only scout definition. It lives here rather than in tools.ts so the ported
 * tool list (`TOOLS`) keeps matching the Python version, and the long timeout can follow Config.
 */
function scoutToolDefinition(
  host: GameToolHost,
  timeoutMs: number,
  activity: ActivitySource | undefined,
): ToolDefinition {
  const schema = SCOUT_TOOL.function;
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    timeoutMs,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [
        {
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value),
        },
      ],
    },
    async execute(args, exec) {
      const fields = isRecord(args) ? args : {};
      const started = Date.now();
      const log = typeof activity === "function" ? activity() : activity;
      try {
        const result = await host.run(
          "scout",
          fields,
          host.pilot(exec.signal),
          exec.signal,
          exec.agent,
        );
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const summary = (result.split(/\r\n|\r|\n/, 1)[0] ?? "").trim();
        log?.record(
          "tool",
          `scout ${firstChars(JSON.stringify(fields), 120)} → ${summary}(${seconds} 秒)`,
        );
        return result;
      } catch (error) {
        exec.signal.throwIfAborted();
        const message = describeError(error);
        log?.record("error", `scout 出错:${message}`);
        return `工具出错:${message}`;
      }
    },
  };
}

function firstChars(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/** One plan tool's model-facing shape, from engine/plan/tools.ts or engine/prompt.ts. */
interface PlanToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly timeoutMs: number;
}

/**
 * Task 139: the plan tools' dsh definitions. `execute_plan` may run for a whole section, so its
 * timeout follows the executor's budget instead of the ordinary tool timeout; the other three
 * are short. Registered only in plan mode, so non-plan sessions keep exactly their old set.
 */
function planToolDefinitions(
  host: GameToolHost,
  activity: ActivitySource | undefined,
): ToolDefinition[] {
  const specs: readonly PlanToolSpec[] = [
    { ...PLAN_FACTS_TOOL, timeoutMs: DEFAULT_TIMEOUT_MS },
    { ...SUBMIT_PLAN_TOOL, timeoutMs: DEFAULT_TIMEOUT_MS },
    {
      name: EXECUTE_PLAN_TOOL.function.name,
      description: EXECUTE_PLAN_TOOL.function.description,
      parameters: EXECUTE_PLAN_TOOL.function.parameters,
      timeoutMs: DEFAULT_SEGMENT_BUDGET_MS + 120_000,
    },
    {
      name: PLAN_STATUS_TOOL.function.name,
      description: PLAN_STATUS_TOOL.function.description,
      parameters: PLAN_STATUS_TOOL.function.parameters,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
  return specs.map((spec) => hostedPlanTool(host, activity, spec));
}

/**
 * Task 153/155: the chapter tools' dsh definitions. `execute_chapter` is deliberately absent:
 * a passed `submit_chapter_plan` starts the executor in the background, so the model never runs
 * the chapter itself.
 */
function chapterToolDefinitions(
  host: GameToolHost,
  activity: ActivitySource | undefined,
): ToolDefinition[] {
  const specs: readonly PlanToolSpec[] = CHAPTER_TOOL_DEFINITIONS.map((tool) => ({
    ...tool,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }));
  return specs.map((spec) => hostedPlanTool(host, activity, spec));
}

/**
 * Task 160: the engine's success line gets the model-facing handoff in the wording the task
 * fixed. The engine still owns the run; this only makes the result say "stop now, no goal".
 */
function withChapterHandoff(result: string): string {
  if (!result.includes("规则文件已定稿")) return result;
  if (result.includes("不要再调用任何工具")) return result;
  const chapter = /执行器接管第 (\d+) 章/u.exec(result)?.[1] ?? "当前";
  return (
    `${result}\n\n规则文件已定稿，执行器接管第 ${chapter} 章。` +
    "你这一轮现在就结束，不要再调用任何工具（包括建目标）。"
  );
}

function hostedPlanTool(
  host: GameToolHost,
  activity: ActivitySource | undefined,
  spec: PlanToolSpec,
): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    timeoutMs: spec.timeoutMs,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [
        {
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value),
        },
      ],
    },
    async execute(args, exec) {
      const fields = isRecord(args) ? args : {};
      const started = Date.now();
      const log = typeof activity === "function" ? activity() : activity;
      try {
        const result = await host.run(
          spec.name,
          fields,
          host.pilot(exec.signal),
          exec.signal,
          exec.agent,
        );
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const summary = (result.split(/\r\n|\r|\n/, 1)[0] ?? "").trim();
        log?.record(
          "tool",
          `${spec.name} ${firstChars(JSON.stringify(fields), 120)} → ${summary}(${seconds} 秒)`,
        );
        return spec.name === "submit_chapter_plan" ? withChapterHandoff(result) : result;
      } catch (error) {
        exec.signal.throwIfAborted();
        const message = describeError(error);
        log?.record("error", `${spec.name} 出错:${message}`);
        return `工具出错:${message}`;
      }
    },
  };
}

/**
 * Task 139: the tools one player session sees. Plan mode keeps the four plan tools plus the
 * read-only queries above; every tool that walks, presses a key, fights, buys or saves is left
 * out because the plan does those through `execute_plan`. Plan mode off returns the old set
 * (including FF5's scout).
 */
export function playerToolDefinitions(
  host: GameToolHost,
  config: Config,
  activity?: ActivitySource,
): ToolDefinition[] {
  const all = gameToolDefinitions(host, config.game, config.saveSlot, activity);
  // Task 153: chapter mode overrides plan mode. Both keep only read-only game tools; chapter
  // mode replaces the four plan tools with the seven chapter tools and drops scout.
  const planOnly = config.chapterMode || config.planMode;
  const gameTools = planOnly
    ? all.filter((tool) => PLAN_MODE_READONLY_TOOLS.includes(tool.name))
    : all;
  const planTools = config.chapterMode
    ? chapterToolDefinitions(host, activity)
    : config.planMode
      ? planToolDefinitions(host, activity)
      : [];
  const scout =
    !planOnly && byKey(config.game).key === "ff5"
      ? [
          scoutToolDefinition(host, config.scoutMinutes * 60_000 + 120_000, () =>
            typeof activity === "function" ? activity() : activity,
          ),
        ]
      : [];
  return [...gameTools, ...planTools, ...scout];
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
  chapterOwner: () => ChapterOwner | null = () => null,
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
        agentCheckMs: engine.agentCheckMs,
        // The pilot agent's auto-restart (task 28) must be visible in the overview's log.
        log: (message) => {
          engine.activity.record("event", message);
        },
      });
    },
    run: async (name, args, pilot, signal, agent) => {
      signal.throwIfAborted();
      // Task 155/160: while the executor owns the chapter (running or waiting for repair), a
      // model turn must not edit the rule file. Reject before the game lock so the call answers
      // immediately instead of waiting hours behind the executor.
      const owner = chapterOwner();
      if (owner !== null && CHAPTER_EDIT_TOOLS.has(name)) {
        return chapterBusyText(owner);
      }
      return lock.run(async () => {
        signal.throwIfAborted();
        const engine = engineOf();
        // The overview's busy line follows the tool that actually holds the one game, not the
        // calls queued behind it.
        engine.activity.beginTool(name);
        bind({ agent, signal });
        try {
          // The tool result is the model-facing boundary: no game icon tag leaves the engine.
          return cleanIconTags(await engine.game.run(name, args, pilot, signal));
        } finally {
          bind(null);
          engine.activity.endTool();
        }
      });
    },
  };
}

/** Task 155: one accepted chapter run, in the web process, with the goal round driver gated. */
export interface ChapterRunner {
  readonly game: string;
  /** Called from `submit_chapter_plan`; disarms auto rounds, then runs the chapter in the background. */
  start(plan: ChapterPlan, agent?: Agent): Promise<void>;
  /** Operator route: continue the same rule file from the progress file. */
  resume(
    signal: AbortSignal,
    agent?: Agent,
  ): Promise<{ readonly chapter: number; readonly text: string }>;
  /** Operator route: stop this run and hand planning back to the model. */
  abandon(signal: AbortSignal): Promise<string>;
  /** Task 160: running while the executor runs, blocked while it waits, null when the model owns it. */
  state(): ChapterOwner | null;
  /** Task 160: keep an armed goal from starting another round while the chapter is owned. */
  disarmGoal(agent: Agent): void;
  runningChapter(): number | null;
}

/** The process-local half of `ctx.goals` task 155 needs (dsh-goal README.zh 「驱动生命周期」). */
export interface ChapterGoalService {
  get(agent: Agent): (GoalViewLike & { readonly activation?: "armed" | "disarmed" }) | undefined;
  disarm(agent: Agent): unknown;
  resume(
    agent: Agent,
    ref: { readonly id: GoalViewLike["id"]; readonly revision: number },
  ): unknown;
}

interface ChapterGoalRef {
  readonly agent: Agent;
  readonly id: GoalViewLike["id"];
  readonly revision: number;
}

export interface ChapterRunnerDeps {
  readonly slot: EngineSlot;
  readonly host: Pick<GameToolHost, "pilot" | "run">;
  /** Shared with gameToolHost: non-null while the executor owns the chapter. */
  readonly gate: ChapterGate;
  readonly goals: () => ChapterGoalService | undefined;
  readonly log: Pick<PlayerLog, "warn">;
}

const CHAPTER_RUNNERS = Symbol.for("@local/ffpr-dsh/chapter-runners");
const runnerHolder = globalThis as unknown as Record<symbol, unknown>;

function runnerTable(): Map<string, ChapterRunner> {
  const existing = runnerHolder[CHAPTER_RUNNERS];
  if (existing instanceof Map) return existing as Map<string, ChapterRunner>;
  const created = new Map<string, ChapterRunner>();
  runnerHolder[CHAPTER_RUNNERS] = created;
  return created;
}

/** The root panel entry and a player preset may be different module instances; use globalThis. */
export function registerChapterRunner(runner: ChapterRunner): () => void {
  const game = runner.game.toLowerCase();
  runnerTable().set(game, runner);
  return () => {
    if (runnerTable().get(game) === runner) runnerTable().delete(game);
  };
}

export function chapterRunnerFor(game: string): ChapterRunner | undefined {
  return runnerTable().get(game.toLowerCase());
}

/** Abort a background run when its engine unloads; the returned cleanup is idempotent. */
function linkAbort(source: AbortSignal, controller: AbortController): () => void {
  if (source.aborted) {
    controller.abort();
    return () => undefined;
  }
  const abort = (): void => {
    controller.abort();
  };
  source.addEventListener("abort", abort, { once: true });
  return () => {
    source.removeEventListener("abort", abort);
  };
}

function chapterDoneText(report: NonNullable<PlayerEngine["game"]["lastChapterReport"]>): string {
  return (
    `第 ${report.chapter} 章已跑完，报告如下：\n\n` +
    `${describeChapterReport(report)}\n\n` +
    `请规划第 ${report.chapter + 1} 章。`
  );
}

function chapterAbandonText(chapter: number): string {
  return (
    `操作员已结束第 ${chapter} 章的自动执行，规划权交回你。` +
    "只有操作员主动结束本章（不是执行器出例外）才会发生这种情况。" +
    "请先 chapter_status 看进度和报告，再决定是否重新规划；" +
    "规则文件确实要改时，改好后用 submit_chapter_plan 重新提交，执行器会接手重跑。"
  );
}

/**
 * Task 155: the chapter executor's home in the web process. dsh's goal round driver starts a new
 * model round only when the agent is idle and the goal is `active` + `armed`; `start` calls
 * `ctx.goals.disarm(agent)` before the submit tool result returns, so the driver is not drivable
 * while the chapter runs. A done run rearms the goal and queues the fixed next-chapter prompt.
 * A blocked run stays disarmed: the operator repairs it with `scripts/chapter-resume.mjs`.
 */
export function createChapterRunner(deps: ChapterRunnerDeps): ChapterRunner {
  const game = deps.slot.game;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let agent: Agent | undefined;
  let goalRef: ChapterGoalRef | null = null;
  let abandoned = false;

  const goals = (): ChapterGoalService | undefined => {
    try {
      return deps.goals();
    } catch (error) {
      deps.log.warn(`读目标服务失败:${describeError(error)}`);
      return undefined;
    }
  };

  const disarm = (owner: Agent | undefined): void => {
    if (owner === undefined) return;
    const service = goals();
    if (service === undefined) return;
    try {
      const view = service.get(owner);
      if (view?.phase !== "active") return;
      // Only an armed goal would auto-continue after this turn. An already disarmed goal (for
      // example after a session resume) stays off; the operator keeps that authority.
      if (view.activation === "armed") {
        service.disarm(owner);
        goalRef = { agent: owner, id: view.id, revision: view.revision };
      }
    } catch (error) {
      deps.log.warn(`执行期间停自动续轮失败:${describeError(error)}`);
    }
  };

  const clearGate = (): void => {
    deps.gate.chapter = null;
    deps.gate.status = null;
  };

  const blockGate = (chapter: number): void => {
    deps.gate.chapter = chapter;
    deps.gate.status = "blocked";
  };

  const rearm = (owner: Agent | undefined): void => {
    const ref = goalRef;
    if (ref === null || owner === undefined || ref.agent !== owner) return;
    const service = goals();
    if (service === undefined) return;
    try {
      service.resume(owner, { id: ref.id, revision: ref.revision });
      goalRef = null;
    } catch (error) {
      deps.log.warn(`章跑完后恢复自动续轮失败:${describeError(error)}`);
    }
  };

  const followup = (owner: Agent | undefined, text: string): void => {
    if (owner === undefined) {
      deps.slot.current()?.activity.record("event", "章跑完,但没有可叫的模型会话;请在新会话里继续");
      return;
    }
    try {
      owner.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: {
            kind: "ffpr-chapter",
            form: "snapshot",
            sections: [{ name: "ffpr:chapter", text }],
          },
        }),
      );
    } catch (error) {
      deps.log.warn(`章跑完后叫模型失败:${describeError(error)}`);
    }
  };

  const settle = (engine: PlayerEngine, owner: Agent | undefined): void => {
    const report = engine.game.lastChapterReport;
    if (abandoned) return;
    if (report === null) {
      // Task 160: without a report the chapter is not finished; keep the model out and tell
      // the operator to inspect it instead of letting a stale round take over again.
      const chapter = engine.game.chapterPlans.current?.chapter;
      if (chapter !== undefined) blockGate(chapter);
      engine.activity.record("event", "章执行结束,但没有报告;请用续跑命令检查");
      return;
    }
    if (report.status === "done") {
      clearGate();
      engine.activity.record("event", `第 ${report.chapter} 章跑完,叫模型规划下一章`);
      rearm(owner);
      followup(owner, chapterDoneText(report));
      return;
    }
    if (report.status === "blocked" || report.status === "exception") {
      // Task 160: waiting for repair still means the executor owns the chapter. Keep the gate
      // closed so a resumed/new goal or a stale turn cannot submit the plan again.
      blockGate(report.chapter);
      engine.activity.record(
        "error",
        report.blockedText ?? `第 ${report.chapter} 章等待修复;执行器停着,没有叫模型`,
      );
      return;
    }
    clearGate();
    engine.activity.record("event", `第 ${report.chapter} 章中止;没有叫模型`);
  };

  const launch = (engine: PlayerEngine, owner: Agent | undefined): void => {
    const stop = new AbortController();
    controller = stop;
    const unlink = linkAbort(engine.stop.signal, stop);
    const run = (async () => {
      try {
        const pilot = deps.host.pilot(stop.signal);
        await deps.host.run(INTERNAL_CHAPTER_RUN, {}, pilot, stop.signal, owner);
      } catch (error) {
        if (!stop.signal.aborted) deps.log.warn(`章执行出错:${describeError(error)}`);
      } finally {
        unlink();
        controller = null;
        running = null;
        // The gate is settled by `settle` (done clears it, blocked keeps it) so a blocked
        // chapter cannot be stolen by the next model round.
        settle(engine, owner);
      }
    })();
    running = run;
  };

  return {
    game,
    runningChapter: () => {
      const owner = chapterOwnerOf(deps.gate);
      return owner?.status === "running" ? owner.chapter : null;
    },
    state: () => chapterOwnerOf(deps.gate),
    disarmGoal: (owner) => {
      disarm(owner);
    },
    start(plan, owner): Promise<void> {
      if (running !== null) throw new Error(`第 ${deps.gate.chapter ?? "?"} 章还在执行`);
      const engine = deps.slot.current();
      if (engine === undefined) throw new Error(`${byKey(game).label} 没在运行`);
      agent = owner;
      abandoned = false;
      disarm(owner);
      deps.gate.chapter = plan.chapter;
      deps.gate.status = "running";
      engine.activity.record("event", `规则文件定稿,执行器接管第 ${plan.chapter} 章`);
      launch(engine, owner);
      return Promise.resolve();
    },
    async resume(signal, owner) {
      if (running !== null) {
        return {
          chapter: deps.gate.chapter ?? 0,
          text: "执行器已经在跑这一章",
        };
      }
      const engine = await deps.slot.ensure(signal);
      const plan = engine.game.chapterPlans.current;
      if (plan === null) throw new Error("没有存盘的章计划,没法续跑;先让模型提交规则文件");
      const target = owner ?? agent;
      agent = target;
      abandoned = false;
      if (goalRef === null) disarm(target);
      deps.gate.chapter = plan.chapter;
      deps.gate.status = "running";
      engine.activity.record("event", `续跑第 ${plan.chapter} 章(从章进度接着跑)`);
      launch(engine, target);
      return { chapter: plan.chapter, text: `已开始续跑第 ${plan.chapter} 章` };
    },
    async abandon(signal) {
      const engine = await deps.slot.ensure(signal);
      abandoned = true;
      controller?.abort();
      if (running !== null) {
        try {
          await running;
        } catch {
          // launch already reports the failure; abandon only needs the run to stop.
        }
      }
      const plan = engine.game.chapterPlans.current;
      if (plan === null) throw new Error("没有存盘的章计划,没有可放弃的章");
      const text = await engine.game.abandonChapter(
        `操作员用 --abandon 结束第 ${plan.chapter} 章执行`,
      );
      clearGate();
      engine.activity.record("event", text);
      rearm(agent);
      followup(agent, chapterAbandonText(plan.chapter));
      return text;
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
 * tools, so the player keeps the three goal tools and hides the rest, while our own game tools
 * stay visible (dsh-tools `view()`). Tactician and stage officer still mask everything.
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
  // Task 67: archive finished tactician child sessions after keeping the newest few visible.
  // Read the Host service at archive time, not at plugin load (11-09: it may register later);
  // `ctx.get` is the documented optional read (@deepseek-ai/cordis reflect.get), so a host
  // without the Workspace controller still plays and just cannot archive.
  const workspaceController = (): WorkspaceController | undefined =>
    typeof ctx.get === "function" ? ctx.get("workspaceController") : undefined;
  const tacticianSessions = new TacticianArchiveQueue({
    keepVisible: config.tacticianKeepVisible,
    archive: workspaceController,
    activity: () => slot.current()?.activity,
    warn: (message) => {
      log.warn(message);
    },
  });
  let binding: TacticianBinding | null = null;
  // Task 86: the queued road trigger starts after its tool returned, when `binding` is gone.
  // The last tool's agent is still the player's live session; a fresh timeout signal is used
  // because the tool's own signal is cancelled when that call ends. dsh only honours the
  // signal until it publishes the child (dsh-subagent README.zh 「失败与恢复」).
  let lastAgent: Agent | undefined = undefined;
  const chapterGate: ChapterGate = { chapter: null, status: null };
  const chapterRunner: { current: ChapterRunner | undefined } = { current: undefined };
  const prepare = (engine: PlayerEngine): void => {
    // Task 155: a passed submit is the handoff. The runner disarms goal rounds and starts the
    // executor in the background; direct engine tests leave the callback unset.
    engine.game.onChapterAccepted = config.chapterMode
      ? (plan) => {
          const runner = chapterRunner.current;
          if (runner === undefined) throw new Error("章执行器还没装好");
          return runner.start(plan, binding?.agent ?? lastAgent);
        }
      : undefined;
    // Task 145 follow-up: plan mode must make no model calls at all. The plan's own tables are
    // the battle rules; a tactician/stage-officer child started after a plan tool was the
    // repeated child session the user saw in the dsh session directories.
    if (config.chapterMode || config.planMode) {
      engine.game.setTactician(undefined);
      engine.game.setStageOfficer(undefined);
      return;
    }
    // The tactician runs under the same agent and cancellation as the tool call that needed it.
    engine.game.setTactician((facts, options) => {
      const agent = binding?.agent ?? lastAgent;
      if (agent === undefined) {
        throw new Error("这次工具调用没有主智能体,叫不了战术官");
      }
      // A background child deliberately ignores the tool's signal: after that tool returns the
      // signal is cancelled, and dsh's signal only owns the unpublished start.
      const signal =
        options?.background === true
          ? AbortSignal.timeout(TACTICIAN_TIMEOUT_MS)
          : (binding?.signal ?? AbortSignal.timeout(TACTICIAN_TIMEOUT_MS));
      return startTactician(
        ctx.subagents,
        agent,
        signal,
        engine.game.game,
        facts,
        tacticianSessions,
      );
    });
    // Task 97: the stage officer only exists for FF5 (its preset and knowledge are FF5's).
    if (byKey(config.game).key !== "ff5") {
      engine.game.setStageOfficer(undefined);
      return;
    }
    engine.game.setStageOfficer(async (facts, factsText, signal) => {
      const agent = binding?.agent ?? lastAgent;
      if (agent === undefined) {
        throw new Error("这次工具调用没有主智能体，叫不了阶段官");
      }
      return await callStageOfficer(ctx.subagents, agent, signal, facts, factsText);
    });
  };
  const host = gameToolHost(
    slot,
    prepare,
    (call) => {
      binding = call;
      if (call?.agent !== undefined) lastAgent = call.agent;
    },
    () => chapterOwnerOf(chapterGate),
  );
  const runner = createChapterRunner({
    slot,
    host,
    gate: chapterGate,
    goals: () => {
      if (typeof ctx.get !== "function") return undefined;
      return ctx.get("goals") as ChapterGoalService | undefined;
    },
    log,
  });
  chapterRunner.current = runner;
  ctx.effect(() => registerChapterRunner(runner));
  // Task 160: while the executor owns the chapter, every model tool except chapter_status is
  // refused before it runs. The guard is mounted on the agent scope, so it also covers the
  // inherited goal tools (create_goal/update_goal).
  const guard = chapterToolGuard(() => runner.state());
  // Task 160: after a web/dsh restart the in-memory gate is gone but the progress file still
  // says running/blocked. Adopt it at the next first step so the model cannot take over.
  const adoptSavedChapter = async (
    engine: PlayerEngine,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> => {
    if (chapterGate.chapter !== null) return;
    const path = engine.game.chapterProgressFile;
    if (path === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
    } catch (error) {
      if (isMissingFile(error)) return;
      signal.throwIfAborted();
      log.warn(`读章进度失败:${describeError(error)}`);
      return;
    }
    if (!isRecord(parsed) || typeof parsed.chapter !== "number") return;
    if (parsed.status !== "running" && parsed.status !== "blocked") return;
    chapterGate.chapter = parsed.chapter;
    chapterGate.status = parsed.status;
    // A chapter restored from an earlier process still owns the round driver; keep its goal off.
    runner.disarmGoal(agent);
  };
  // Task 107: the round's new activity-log and key-event lines feed the no-progress watchdog.
  const progressBuffer = (): ProgressBuffer | undefined => {
    const engine = slot.current();
    if (engine === undefined) return undefined;
    const lines = (): string[] => [
      ...engine.activity.entries.map((entry) => entry.text),
      ...(engine.events?.entries ?? []).map(
        (entry) => `${LABEL[entry.type] ?? entry.type} ${entry.text}`,
      ),
    ];
    const current = lines();
    return { size: current.length, since: (start) => lines().slice(start) };
  };
  const watchdog = new ProgressWatchdog({
    stallRounds: config.goalStallRounds,
    // The goal service is optional: a host without dsh-goal simply has no goal to pause.
    goals: (): GoalServiceLike | undefined => {
      if (typeof ctx.get !== "function") return undefined;
      return ctx.get("goals") as GoalServiceLike | undefined;
    },
    buffer: progressBuffer,
    activity: () => slot.current()?.activity,
    warn: (message) => {
      log.warn(message);
    },
  });
  // Task 139: plan mode registers only the plan tools and read-only queries; plan mode off
  // restores the old set, including FF5's scout.
  const tools: ToolDefinition[] = playerToolDefinitions(
    host,
    config,
    () => slot.current()?.activity,
  );
  const personaText = buildSystemPrompt(
    config.game,
    config.saveSlot,
    config.planMode,
    config.chapterMode,
  );
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
      disposers.set(agent.id, registerAgent(agent, tools, personaText, guard));
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
  // 11-10 (task 109): the registry emits this on the host context, while this listener lives
  // in a preset scope; dsh-scope's filter dropped it, so a manual web preset switch missed
  // this event and only pre-step caught up from round two. `global` is cordis EventOptions
  // (@deepseek-ai/cordis events.d.ts): the listener bypasses scope filtering. `select` emits
  // before the first prompt, so the target plugin mounts in time.
  ctx.on(
    "agent-preset/selected",
    (sessionId, agentPreset) => {
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
    },
    { global: true },
  );

  // Publish this instance's per-session mount so another player preset can mount us inside the
  // same agent/created dispatch that selects us. The disposer removes only this object.
  ctx.effect(() =>
    registerPresetMount(config.game, {
      mount: mountAgent,
      unmount: unmountAgent,
    }),
  );

  // 11-02 (task 32): the service comes from @deepseek-ai/dsh-agent-preset-registry (index.ts's
  // inject). Tests that build a bare fake context pass it explicitly; a real context resolves it.
  if (presetService !== undefined || typeof ctx.get === "function") {
    installPresetSwitch(ctx, presetService, config, log, detect, {
      unmount: unmountAgent,
    });
  }

  ctx.effect(() => async () => {
    const pending = [...disposers.values()].map((dispose) => dispose());
    disposers.clear();
    await Promise.all(pending);
  });

  ctx.on("agent/turn-stopping", ({ agent }) => {
    // Task 107: a round just ended; pause the goal when the configured miss streak is reached.
    try {
      watchdog.end(agent);
    } catch (error) {
      log.warn(`检查目标进展失败:${describeError(error)}`);
    }
    // Task 160: the handoff must hold even if a goal was created/resumed before the guard was
    // mounted. Disarm at the round boundary so dsh cannot start a new round over the executor.
    if (chapterRunner.current?.state() !== null) runner.disarmGoal(agent);
  });

  ctx.on("agent/pre-step", async ({ agent, step, signal }, next) => {
    // Task 107: capture this round's starting point before the model acts.
    if (step === 1) {
      watchdog.begin(agent);
      // Task 160: a blocked chapter restored from disk must keep this round's goal disarmed.
      if (chapterRunner.current?.state() !== null) runner.disarmGoal(agent);
    }
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
    await adoptSavedChapter(engine, agent, signal);
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

/**
 * Mount the game tools, the inherited-tool mask and the complete persona on one agent.
 * Exported so the visibility test can use dsh's real ToolRuntime (task 111).
 */
export function registerAgent(
  agent: Agent,
  tools: ReturnType<typeof gameToolDefinitions>,
  personaText: string,
  guard?: ToolGuard,
): () => Promise<void> {
  return agent.ctx.effect(() => {
    const owned: (() => void)[] = [];
    for (const tool of tools) owned.push(agent.ctx.tools.register(tool));
    // Task 160: a monotonic guard denies every tool (including inherited goal tools) while the
    // chapter executor owns this agent; only chapter_status passes inside the guard itself.
    if (guard !== undefined) owned.push(agent.ctx.tools.guard(guard));
    // The goal tools are inherited from the preset's dsh-tool-goal; keep exactly those and hide
    // every other inherited tool (task 111). A preset without dsh-tool-goal has none of these
    // names, and restrict() rejects unknown names, so filter against what this agent can see.
    const visible = new Set(agent.ctx.tools.schemas(agent).map((tool) => tool.name));
    owned.push(
      agent.ctx.tools.restrict({
        allow: GOAL_TOOL_NAMES.filter((name) => visible.has(name)),
      }),
    );
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

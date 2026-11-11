/**
 * Plugin configuration (control plan §10.3 and task 21). Paths and the save slot are deployment
 * facts that depend on which game this preset plays, so `gameDefaults` is the one place that
 * knows them; the Config transform fills them once the game key is known.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { byKey, type Game } from "../engine/games.ts";
import { DEFAULT_AGENT_CHECK_MS } from "../engine/link-pilot.ts";
import { DEPS, LAPTOP_ENV } from "../engine/paths.ts";
import {
  DEFAULT_BESTIARY_DEFER_BATTLES,
  DEFAULT_BESTIARY_MISSABLE_MINUTES,
} from "../engine/skills/grind.ts";
import {
  BLOCKED_TRUST_COUNT,
  CARRY_REPEAT_LIMIT,
  CARRY_TOTAL_LIMIT,
  WALKPATH_BLOCKED_MS,
  WALKPATH_EVENT_POLL_MS,
  WALKPATH_EVENT_WAIT_MS,
  WALKPATH_TIMEOUT_MS,
  WALKPATH_TURN_LEAD,
} from "../engine/skills/move.ts";
import { DEFAULT_TRAVEL_MAX_HOPS, DEFAULT_TRAVEL_MAX_MINUTES } from "../engine/skills/travel.ts";
import { DEFAULT_ROUTE_BATTLE_SECONDS } from "../engine/route/tool.ts";
import { DEFAULT_ITEM_HEAL_PERCENT } from "../engine/skills/gambit.ts";
import { MAX_RECOVERY_DISTANCE } from "../engine/stage/gate.ts";
import { DEFAULT_FLEE_ON_TIMER } from "../engine/strategy/execute.ts";

/**
 * All six games start from a new game and write slot 20 only (10-29: the user made FF5 use the
 * same slot as the other five; its old slot 3 was the user's own save).
 */
const NEW_GAME_SAVE_SLOT = 20;
const FF5_BRIDGE_PORT = 47800;
const NEW_GAME_BRIDGE_PORT_BASE = 47800;

/** Everything that differs by title when the preset does not override it. */
export interface GameDefaults {
  readonly game: Game;
  /** 20 for every game: all six start fresh and never touch another slot. */
  readonly saveSlot: number;
  /** FF5's bridge is 47800; FFN's is 4780N (bridge 0.10.0). */
  readonly bridgePort: number;
  readonly notesFile: string;
  readonly atlasFile: string;
  readonly tacticsFile: string;
  readonly elementsFile: string;
  /** One JSON line per battle (task 36), beside the other .deps/ds files. */
  readonly battlesFile: string;
  /** The first layer's session journal: user/assistant text and tool calls (task 40). */
  readonly playerFile: string;
  /** One JSON line per tactician call (task 40), beside the other .deps/ds files. */
  readonly tacticianFile: string;
  /** Task 45: incomplete departures, missed one-time chests and the save-local bestiary. */
  readonly backlogFile: string;
  readonly incidentsFile: string;
  readonly incidentsStateFile: string;
  readonly bestiarySaveFile: string;
  /** Task 89: resumable route progress, one JSON file per game. */
  readonly routeFile: string;
  /** Task 97: the one stage plan per game. */
  readonly stagePlanFile: string;
  /** Task 117: the route book's live progress and learned handoff cells. */
  readonly routeBookProgressFile: string;
  readonly routeBookLearnedFile: string;
  /** Task 139: the saved segment plan and its last execution report. */
  readonly segmentPlanFile: string;
  readonly segmentReportFile: string;
}

/** Per-game defaults shared by the schema, the plugin and the tests. Unknown keys throw. */
export function gameDefaults(key: string): GameDefaults {
  const game = byKey(key);
  const ff5 = game.key === "ff5";
  const number = Number(game.key.slice(2));
  return {
    game,
    saveSlot: NEW_GAME_SAVE_SLOT,
    bridgePort: ff5 ? FF5_BRIDGE_PORT : NEW_GAME_BRIDGE_PORT_BASE + number,
    notesFile: join(DEPS, "ds", `notes-${game.key}.json`),
    atlasFile: join(DEPS, "ds", `atlas-${game.key}.json`),
    tacticsFile: join(DEPS, "ds", `tactics-${game.key}.json`),
    elementsFile: join(DEPS, "ds", `elements-${game.key}.json`),
    battlesFile: join(DEPS, "ds", `battles-${game.key}.jsonl`),
    playerFile: join(DEPS, "ds", `player-${game.key}.jsonl`),
    tacticianFile: join(DEPS, "ds", `tactician-${game.key}.jsonl`),
    backlogFile: join(DEPS, "ds", `backlog-${game.key}.jsonl`),
    incidentsFile: join(DEPS, "ds", `incidents-${game.key}.jsonl`),
    incidentsStateFile: join(DEPS, "ds", `incidents-state-${game.key}.json`),
    bestiarySaveFile: join(DEPS, "ds", `bestiary-save-${game.key}.json`),
    routeFile: join(DEPS, "ds", `route-${game.key}.json`),
    stagePlanFile: join(DEPS, "ds", `stage-${game.key}.json`),
    routeBookProgressFile: join(DEPS, "ds", `routebook-progress-${game.key}.json`),
    routeBookLearnedFile: join(DEPS, "ds", `routebook-learned-${game.key}.json`),
    segmentPlanFile: join(DEPS, "ds", `segment-plan-${game.key}.json`),
    segmentReportFile: join(DEPS, "ds", `segment-report-${game.key}.json`),
  };
}

const DEFAULT_SECRETS_FILE = join(homedir(), ".config", "ffpr-agent", "secrets.env");
const DEFAULT_CHECK_EVERY_MS = 60_000;
/** One laptop detection is shared by six presets and the panel; this bounds the SSH rate. */
const DEFAULT_DETECT_CACHE_MS = 10_000;
/** How long agent/created may wait for the first "which game is open" answer (task 32). */
const DEFAULT_AUTO_PRESET_WAIT_MS = 3_000;
/** Task 67: keep this many finished tactician child sessions visible per game. */
const DEFAULT_TACTICIAN_KEEP_VISIBLE = 2;
/** Task 86: two road triggers on one map are at least this many minutes apart. */
const DEFAULT_TACTICIAN_INTERVAL_MINUTES = 10;
/** Task 107: pause the goal after this many consecutive rounds without a progress signal. */
const DEFAULT_GOAL_STALL_ROUNDS = 3;

const RawConfig = Schema.object({
  /**
   * Which half of the two-layer split this plugin instance is (control plan §4.12), or the panel
   * entry: dsh serves the right-sidebar bundle only for root loader entries (task 14).
   */
  role: Schema.union([
    Schema.const("player"),
    Schema.const("tactician"),
    Schema.const("panel"),
  ]).default("player"),
  /** The tactician writes the boss table and the code fights it, instead of stopping (10-27). */
  tacticianBoss: Schema.boolean().default(true),
  /** secrets.env holding BRIDGE_TOKEN. */
  secretsFile: Schema.string().default(DEFAULT_SECRETS_FILE),
  /** laptop.env holding BRIDGE_URL and LAPTOP_HOST. */
  laptopEnv: Schema.string().default(LAPTOP_ENV),
  /** Explicit bridge address; unset means laptopEnv (FF5 only) or this game's port. */
  bridgeUrl: Schema.string(),
  /** Which title this preset plays: one DeepSeek player per game (task 21). */
  game: Schema.string().default("ff5"),
  /** Save slot written by save_game and read after a wipe; defaults by game. */
  saveSlot: Schema.number(),
  /** JSON array of notes kept between runs. */
  notesFile: Schema.string(),
  /** The maps seen so far, shared with the Python player for FF5. */
  atlasFile: Schema.string(),
  /** Battle tactics per map, shared with the Python player for FF5. */
  tacticsFile: Schema.string(),
  /** What each monster is weak to, learned from battles and the guide (FF5 only). */
  elementsFile: Schema.string(),
  /** One JSON line per battle: rules, turns and the result (task 36). */
  battlesFile: Schema.string(),
  /** The first layer's session journal (task 40). */
  playerFile: Schema.string(),
  /** One JSON line per tactician call (task 40). */
  tacticianFile: Schema.string(),
  /** Task 45: deliberate incomplete departures (JSONL). */
  backlogFile: Schema.string(),
  /** Task 45: one-time places whose missed chest count grew (JSONL). */
  incidentsFile: Schema.string(),
  /** Task 45: last seen missed count per one-time area, so an incident is logged once. */
  incidentsStateFile: Schema.string(),
  /** Task 45: save-count snapshots of this save's bestiary numbers. */
  bestiarySaveFile: Schema.string(),
  /** Task 89: resumable route progress. */
  routeFile: Schema.string(),
  /** Task 97: where the one stage plan is kept. */
  stagePlanFile: Schema.string(),
  /** Task 117: run a route book section as one `route {}` (default on). */
  routeBookEnabled: Schema.boolean().default(true),
  /** Task 131: entering a new book section generates and walks its plan (default on). */
  routeBookAutoPlan: Schema.boolean().default(true),
  /** Task 117: a missable-monster/blue-magic grind stop's time cap in minutes. */
  routeBookGrindMinutes: Schema.number().default(8),
  /** Task 136: use a book save station when the last save is this many minutes old (default 10). */
  routeBookSaveMinutes: Schema.number().default(10),
  /** Task 124: build only the current section and this many after it (default 4). */
  routeBookAheadSections: Schema.number().default(4),
  /** Task 124: stop a runtime book build after this many milliseconds (default 5 s). */
  routeBookTimeBudgetMs: Schema.number().default(5_000),
  /** Task 117: the route book's per-station progress file. */
  routeBookProgressFile: Schema.string(),
  /** Task 117: cells the model acted on at a handoff station. */
  routeBookLearnedFile: Schema.string(),
  /** Task 139: the player writes a plan and code executes it instead of step-by-step tools. */
  planMode: Schema.boolean().default(true),
  /** Task 153: one guide chapter per rule file; on overrides `planMode` (11-11). */
  chapterMode: Schema.boolean().default(true),
  /** Task 139: one current segment plan and its versions per game. */
  segmentPlanFile: Schema.string(),
  /** Task 139: the last segment report, so plan_status survives a restart. */
  segmentReportFile: Schema.string(),
  /** Task 105: snapshots and scout-window intervals live here (default .deps/ds). */
  scoutDir: Schema.string(),
  /** Task 105: scout()'s default time budget in minutes. */
  scoutMinutes: Schema.number().default(20),
  /** Task 105: never try more than this many scout targets in one run. */
  scoutMaxTargets: Schema.number().default(200),
  /** Task 97: let the code call the stage officer when leaving for another region. */
  stageAutoPlan: Schema.boolean().default(true),
  /** Task 101: refuse a coordinate `go` inside an active stage plan (default on). */
  stageGoGate: Schema.boolean().default(true),
  /** Task 113: turn that refusal into following the plan (default on). */
  stageGoFollowPlan: Schema.boolean().default(true),
  /** Task 113: after a go arrives, keep following the plan in the same call (default on). */
  stageContinueAfterTravel: Schema.boolean().default(true),
  /** Task 97: how close a recovery point must be to keep walking. */
  stageTurnBackDistance: Schema.number().default(MAX_RECOVERY_DISTANCE),
  /** Task 106: levels moved at the last checkpoint before a boss rewrite its table. */
  stageBossLevelGap: Schema.number().default(3),
  /** Task 89: estimated seconds of one road battle in the countdown check. */
  routeBattleSeconds: Schema.number().default(DEFAULT_ROUTE_BATTLE_SECONDS),
  /** Task 91: heal after battle when HP is below this percentage. */
  healHpPercent: Schema.number().default(70),
  /** Task 91: a caster keeps at least this share of max MP, except at a save point/boss. */
  healMpReservePercent: Schema.number().default(30),
  /** Task 91: spend a healing item only below this HP percentage. */
  healItemHpPercent: Schema.number().default(40),
  /** Task 104: in battle, drink a healing item below this HP share when nobody can heal. */
  battleItemHealPercent: Schema.number().default(DEFAULT_ITEM_HEAL_PERCENT),
  /** Task 104: try to flee ordinary battles while sample.timer is running (bridge 0.14.3+). */
  battleFleeOnTimer: Schema.boolean().default(DEFAULT_FLEE_ON_TIMER),
  /** Task 91: top the party up to this percentage at a save point or before a boss. */
  healFullPercent: Schema.number().default(95),
  /** Task 91: refuse save_game under a running countdown with fewer seconds left. */
  saveTimerMinSeconds: Schema.number().default(300),
  /** Task 91: stop waiting when the screen has not changed for this many seconds. */
  storyStuckSeconds: Schema.number().default(60),
  /** Task 162: minutes a story station may explore toward a direction for its trigger. */
  storyExploreMinutes: Schema.number().default(3),
  /** How often to retry the bridge while it is down. */
  checkEveryMs: Schema.number().default(DEFAULT_CHECK_EVERY_MS),
  /** Task 78: while a command waits, how often to check the pilot agent's pid is still alive. */
  agentCheckMs: Schema.number().default(DEFAULT_AGENT_CHECK_MS),
  /** How long one "which game is open" answer is shared before another SSH call. */
  detectCacheMs: Schema.number().default(DEFAULT_DETECT_CACHE_MS),
  /** How long a new session may wait for detection before staying with its own game. */
  autoPresetWaitMs: Schema.number().default(DEFAULT_AUTO_PRESET_WAIT_MS),
  /** Task 48/58: at most this many map hops in one go/explore call. */
  travelMaxHops: Schema.number().default(DEFAULT_TRAVEL_MAX_HOPS),
  /** Task 48/58: the whole call stops after this many minutes. */
  travelMaxMinutes: Schema.number().default(DEFAULT_TRAVEL_MAX_MINUTES),
  /** Task 68: a low-probability monster is deferred after at most this many battles. */
  bestiaryDeferBattles: Schema.number().default(DEFAULT_BESTIARY_DEFER_BATTLES),
  /** Task 68: a missable monster's grind stops after this many minutes. */
  bestiaryMissableMinutes: Schema.number().default(DEFAULT_BESTIARY_MISSABLE_MINUTES),
  /** Task 58: the bridge walkpath's base timeout, blocked wait and turn lead. */
  walkpathTimeoutMs: Schema.number().default(WALKPATH_TIMEOUT_MS),
  walkpathBlockedMs: Schema.number().default(WALKPATH_BLOCKED_MS),
  walkpathTurnLead: Schema.number().default(WALKPATH_TURN_LEAD),
  /** Task 63: how often and how long a walkpath Event/dialog stop is watched for battle. */
  walkpathEventPollMs: Schema.number().default(WALKPATH_EVENT_POLL_MS),
  walkpathEventWaitMs: Schema.number().default(WALKPATH_EVENT_WAIT_MS),
  /** Task 73: blocks before a "走不过去" record is trusted instead of re-walked. */
  blockedTrustCount: Schema.number().default(BLOCKED_TRUST_COUNT),
  /** Task 84: one go stops after the same carry twice, or this many carries in all. */
  carryRepeatLimit: Schema.number().default(CARRY_REPEAT_LIMIT),
  carryTotalLimit: Schema.number().default(CARRY_TOTAL_LIMIT),
  /** Task 67: finished tactician child sessions left visible; older ones are archived. */
  tacticianKeepVisible: Schema.number().default(DEFAULT_TACTICIAN_KEEP_VISIBLE),
  /** Task 86: the least gap between two road triggers on one map, in minutes. */
  tacticianIntervalMinutes: Schema.number().default(DEFAULT_TACTICIAN_INTERVAL_MINUTES),
  /** Task 107: pause the goal after this many consecutive rounds without progress. */
  goalStallRounds: Schema.number().default(DEFAULT_GOAL_STALL_ROUNDS),
});

/**
 * The schema dsh reads. The transform runs after the game key is validated/normalized, so every
 * caller gets concrete paths and a save slot; an unknown `game` fails here, not at the first tool.
 */
export const Config = Schema.transform(RawConfig, (config) => {
  const defaults = gameDefaults(config.game ?? "ff5");
  return {
    role: config.role ?? "player",
    tacticianBoss: config.tacticianBoss ?? true,
    secretsFile: config.secretsFile ?? DEFAULT_SECRETS_FILE,
    laptopEnv: config.laptopEnv ?? LAPTOP_ENV,
    bridgeUrl: config.bridgeUrl ?? undefined,
    game: defaults.game.key,
    saveSlot: config.saveSlot ?? defaults.saveSlot,
    notesFile: config.notesFile ?? defaults.notesFile,
    atlasFile: config.atlasFile ?? defaults.atlasFile,
    tacticsFile: config.tacticsFile ?? defaults.tacticsFile,
    elementsFile: config.elementsFile ?? defaults.elementsFile,
    battlesFile: config.battlesFile ?? defaults.battlesFile,
    playerFile: config.playerFile ?? defaults.playerFile,
    tacticianFile: config.tacticianFile ?? defaults.tacticianFile,
    backlogFile: config.backlogFile ?? defaults.backlogFile,
    incidentsFile: config.incidentsFile ?? defaults.incidentsFile,
    incidentsStateFile: config.incidentsStateFile ?? defaults.incidentsStateFile,
    bestiarySaveFile: config.bestiarySaveFile ?? defaults.bestiarySaveFile,
    routeFile: config.routeFile ?? defaults.routeFile,
    stagePlanFile: config.stagePlanFile ?? defaults.stagePlanFile,
    routeBookEnabled: config.routeBookEnabled ?? true,
    routeBookAutoPlan: config.routeBookAutoPlan ?? true,
    routeBookGrindMinutes: config.routeBookGrindMinutes ?? 8,
    routeBookSaveMinutes: config.routeBookSaveMinutes ?? 10,
    routeBookAheadSections: config.routeBookAheadSections ?? 4,
    routeBookTimeBudgetMs: config.routeBookTimeBudgetMs ?? 5_000,
    routeBookProgressFile: config.routeBookProgressFile ?? defaults.routeBookProgressFile,
    routeBookLearnedFile: config.routeBookLearnedFile ?? defaults.routeBookLearnedFile,
    planMode: config.planMode ?? true,
    // 11-11: chapters.ts and the cached walkthrough exist for FF5 only; other games keep plan mode.
    chapterMode: (config.chapterMode ?? true) && defaults.game.key === "ff5",
    segmentPlanFile: config.segmentPlanFile ?? defaults.segmentPlanFile,
    segmentReportFile: config.segmentReportFile ?? defaults.segmentReportFile,
    scoutDir: config.scoutDir ?? join(DEPS, "ds"),
    scoutMinutes: config.scoutMinutes ?? 20,
    scoutMaxTargets: config.scoutMaxTargets ?? 200,
    stageAutoPlan: config.stageAutoPlan ?? true,
    stageGoGate: config.stageGoGate ?? true,
    stageGoFollowPlan: config.stageGoFollowPlan ?? true,
    stageContinueAfterTravel: config.stageContinueAfterTravel ?? true,
    stageTurnBackDistance: config.stageTurnBackDistance ?? MAX_RECOVERY_DISTANCE,
    stageBossLevelGap: config.stageBossLevelGap ?? 3,
    routeBattleSeconds: config.routeBattleSeconds ?? DEFAULT_ROUTE_BATTLE_SECONDS,
    healHpPercent: config.healHpPercent ?? 70,
    healMpReservePercent: config.healMpReservePercent ?? 30,
    healItemHpPercent: config.healItemHpPercent ?? 40,
    healFullPercent: config.healFullPercent ?? 95,
    battleItemHealPercent: config.battleItemHealPercent ?? DEFAULT_ITEM_HEAL_PERCENT,
    battleFleeOnTimer: config.battleFleeOnTimer ?? DEFAULT_FLEE_ON_TIMER,
    saveTimerMinSeconds: config.saveTimerMinSeconds ?? 300,
    storyStuckSeconds: config.storyStuckSeconds ?? 60,
    storyExploreMinutes: config.storyExploreMinutes ?? 3,
    checkEveryMs: config.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS,
    agentCheckMs: config.agentCheckMs ?? DEFAULT_AGENT_CHECK_MS,
    detectCacheMs: config.detectCacheMs ?? DEFAULT_DETECT_CACHE_MS,
    autoPresetWaitMs: config.autoPresetWaitMs ?? DEFAULT_AUTO_PRESET_WAIT_MS,
    travelMaxHops: config.travelMaxHops ?? DEFAULT_TRAVEL_MAX_HOPS,
    travelMaxMinutes: config.travelMaxMinutes ?? DEFAULT_TRAVEL_MAX_MINUTES,
    bestiaryDeferBattles: config.bestiaryDeferBattles ?? DEFAULT_BESTIARY_DEFER_BATTLES,
    bestiaryMissableMinutes: config.bestiaryMissableMinutes ?? DEFAULT_BESTIARY_MISSABLE_MINUTES,
    walkpathTimeoutMs: config.walkpathTimeoutMs ?? WALKPATH_TIMEOUT_MS,
    walkpathBlockedMs: config.walkpathBlockedMs ?? WALKPATH_BLOCKED_MS,
    walkpathTurnLead: config.walkpathTurnLead ?? WALKPATH_TURN_LEAD,
    walkpathEventPollMs: config.walkpathEventPollMs ?? WALKPATH_EVENT_POLL_MS,
    walkpathEventWaitMs: config.walkpathEventWaitMs ?? WALKPATH_EVENT_WAIT_MS,
    blockedTrustCount: config.blockedTrustCount ?? BLOCKED_TRUST_COUNT,
    carryRepeatLimit: config.carryRepeatLimit ?? CARRY_REPEAT_LIMIT,
    carryTotalLimit: config.carryTotalLimit ?? CARRY_TOTAL_LIMIT,
    tacticianKeepVisible: config.tacticianKeepVisible ?? DEFAULT_TACTICIAN_KEEP_VISIBLE,
    tacticianIntervalMinutes: config.tacticianIntervalMinutes ?? DEFAULT_TACTICIAN_INTERVAL_MINUTES,
    goalStallRounds: config.goalStallRounds ?? DEFAULT_GOAL_STALL_ROUNDS,
  };
});

export type Config = ReturnType<typeof Config>;

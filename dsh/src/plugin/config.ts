/**
 * Plugin configuration (control plan §10.3 and task 21). Paths and the save slot are deployment
 * facts that depend on which game this preset plays, so `gameDefaults` is the one place that
 * knows them; the Config transform fills them once the game key is known.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { byKey, type Game } from "../engine/games.ts";
import { DEPS, LAPTOP_ENV } from "../engine/paths.ts";
import {
  WALKPATH_BLOCKED_MS,
  WALKPATH_EVENT_POLL_MS,
  WALKPATH_EVENT_WAIT_MS,
  WALKPATH_TIMEOUT_MS,
  WALKPATH_TURN_LEAD,
} from "../engine/skills/move.ts";
import { DEFAULT_TRAVEL_MAX_HOPS, DEFAULT_TRAVEL_MAX_MINUTES } from "../engine/skills/travel.ts";

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
  };
}

const DEFAULT_SECRETS_FILE = join(homedir(), ".config", "ffpr-agent", "secrets.env");
const DEFAULT_CHECK_EVERY_MS = 60_000;
/** One laptop detection is shared by six presets and the panel; this bounds the SSH rate. */
const DEFAULT_DETECT_CACHE_MS = 10_000;
/** How long agent/created may wait for the first "which game is open" answer (task 32). */
const DEFAULT_AUTO_PRESET_WAIT_MS = 3_000;

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
  /** How often to retry the bridge while it is down. */
  checkEveryMs: Schema.number().default(DEFAULT_CHECK_EVERY_MS),
  /** How long one "which game is open" answer is shared before another SSH call. */
  detectCacheMs: Schema.number().default(DEFAULT_DETECT_CACHE_MS),
  /** How long a new session may wait for detection before staying with its own game. */
  autoPresetWaitMs: Schema.number().default(DEFAULT_AUTO_PRESET_WAIT_MS),
  /** Task 48/58: at most this many map hops in one go/explore call. */
  travelMaxHops: Schema.number().default(DEFAULT_TRAVEL_MAX_HOPS),
  /** Task 48/58: the whole call stops after this many minutes. */
  travelMaxMinutes: Schema.number().default(DEFAULT_TRAVEL_MAX_MINUTES),
  /** Task 58: the bridge walkpath's base timeout, blocked wait and turn lead. */
  walkpathTimeoutMs: Schema.number().default(WALKPATH_TIMEOUT_MS),
  walkpathBlockedMs: Schema.number().default(WALKPATH_BLOCKED_MS),
  walkpathTurnLead: Schema.number().default(WALKPATH_TURN_LEAD),
  /** Task 63: how often and how long a walkpath Event/dialog stop is watched for battle. */
  walkpathEventPollMs: Schema.number().default(WALKPATH_EVENT_POLL_MS),
  walkpathEventWaitMs: Schema.number().default(WALKPATH_EVENT_WAIT_MS),
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
    checkEveryMs: config.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS,
    detectCacheMs: config.detectCacheMs ?? DEFAULT_DETECT_CACHE_MS,
    autoPresetWaitMs: config.autoPresetWaitMs ?? DEFAULT_AUTO_PRESET_WAIT_MS,
    travelMaxHops: config.travelMaxHops ?? DEFAULT_TRAVEL_MAX_HOPS,
    travelMaxMinutes: config.travelMaxMinutes ?? DEFAULT_TRAVEL_MAX_MINUTES,
    walkpathTimeoutMs: config.walkpathTimeoutMs ?? WALKPATH_TIMEOUT_MS,
    walkpathBlockedMs: config.walkpathBlockedMs ?? WALKPATH_BLOCKED_MS,
    walkpathTurnLead: config.walkpathTurnLead ?? WALKPATH_TURN_LEAD,
    walkpathEventPollMs: config.walkpathEventPollMs ?? WALKPATH_EVENT_POLL_MS,
    walkpathEventWaitMs: config.walkpathEventWaitMs ?? WALKPATH_EVENT_WAIT_MS,
  };
});

export type Config = ReturnType<typeof Config>;

/**
 * Plugin configuration (control plan §10.3 and task 21). Paths and the save slot are deployment
 * facts that depend on which game this preset plays, so `gameDefaults` is the one place that
 * knows them; the Config transform fills them once the game key is known.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { byKey, type Game } from "../engine/games.ts";
import { DEPS } from "../engine/paths.ts";

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
  };
}

const DEFAULT_SECRETS_FILE = join(homedir(), ".config", "ffpr-agent", "secrets.env");
const DEFAULT_LAPTOP_ENV = "/root/data/mediaflow/FFPR-Agent/agent/laptop.env";
const DEFAULT_CHECK_EVERY_MS = 60_000;

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
  laptopEnv: Schema.string().default(DEFAULT_LAPTOP_ENV),
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
  /** How often to retry the bridge while it is down. */
  checkEveryMs: Schema.number().default(DEFAULT_CHECK_EVERY_MS),
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
    laptopEnv: config.laptopEnv ?? DEFAULT_LAPTOP_ENV,
    bridgeUrl: config.bridgeUrl ?? undefined,
    game: defaults.game.key,
    saveSlot: config.saveSlot ?? defaults.saveSlot,
    notesFile: config.notesFile ?? defaults.notesFile,
    atlasFile: config.atlasFile ?? defaults.atlasFile,
    tacticsFile: config.tacticsFile ?? defaults.tacticsFile,
    elementsFile: config.elementsFile ?? defaults.elementsFile,
    checkEveryMs: config.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS,
  };
});

export type Config = ReturnType<typeof Config>;

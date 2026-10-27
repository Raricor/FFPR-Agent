/**
 * Plugin configuration (control plan §10.3). Paths are deployment facts, so they have defaults
 * here rather than in code that reads them; bridgeUrl is unset unless a fake or another address
 * is wanted.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";

export const Config = Schema.object({
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
  secretsFile: Schema.string().default(join(homedir(), ".config", "ffpr-agent", "secrets.env")),
  /** laptop.env holding BRIDGE_URL and LAPTOP_HOST. */
  laptopEnv: Schema.string().default("/root/data/mediaflow/FFPR-Agent/agent/laptop.env"),
  /** Explicit bridge address; unset means use laptopEnv or the default port. */
  bridgeUrl: Schema.string(),
  /** The game both engines play; ff5 is the only one with a player. */
  game: Schema.string().default("ff5"),
  /** JSON array of notes kept between runs. */
  notesFile: Schema.string().default("/root/data/mediaflow/FFPR-Agent/.deps/ds/notes-ff5.json"),
  /** The maps seen so far, shared with the Python player. */
  atlasFile: Schema.string().default("/root/data/mediaflow/FFPR-Agent/.deps/ds/atlas-ff5.json"),
  /** Battle tactics per map, shared with the Python player. */
  tacticsFile: Schema.string().default("/root/data/mediaflow/FFPR-Agent/.deps/ds/tactics-ff5.json"),
  /** How often to retry the bridge while it is down. */
  checkEveryMs: Schema.number().default(60000),
});

export type Config = ReturnType<typeof Config>;

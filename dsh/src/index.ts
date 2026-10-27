/**
 * FFPR-Agent as a dsh plugin: the entry the loader imports (name, inject, Config, apply).
 * The plan is MyDesign/FFPR-Agent/ffpr-agent-dsh接入方案.md §10; this file only starts the
 * shared engine and installs the per-agent glue (player.ts).
 */

import type { Context } from "@deepseek-ai/cordis";
import { BestiaryAreaCache } from "./engine/achievements.ts";
import { MonsterCache } from "./engine/bestiary.ts";
import type { Config as ConfigValue } from "./plugin/config.ts";
import { installCommands } from "./plugin/commands.ts";
import { installPanel } from "./plugin/panel.ts";
import { installPlayer, startEngine } from "./plugin/player.ts";
import { installTactician } from "./plugin/tactician.ts";

export { Config } from "./plugin/config.ts";

/** Loader identity. */
export const name = "ffpr";

/** Services needed before apply(): tools, the agent bus, the prompt, subagents, commands. */
export const inject = ["tools", "agents", "systemPrompt", "subagents", "commands"];

export async function apply(ctx: Context, config: ConfigValue): Promise<void> {
  const logger = ctx.logger("ffpr");
  const log = {
    info: (message: string) => {
      logger.info(message);
    },
    warn: (message: string) => {
      logger.warn(message);
    },
  };
  // The root entry only makes dsh serve lib/client.js (dsh-client-modules scans root loader
  // entries by exact package name); the panel's data comes from the player's route.
  if (config.role === "panel") return;
  if (config.role === "tactician") {
    // The second layer only reads: no laptop, no bridge, no event stream, no game engine.
    await installTactician(ctx, config, log);
    return;
  }
  const engine = await startEngine(config, log);

  // The watcher follows the bridge's stream until the plugin unloads.
  ctx.effect(() => () => {
    engine.stop.abort();
    engine.bridge?.close();
  });
  installPlayer(ctx, engine, log);
  const monsterCache = new MonsterCache();
  const bestiaryCache = new BestiaryAreaCache();
  installCommands(ctx, engine, undefined, monsterCache);
  installPanel(ctx, engine, undefined, monsterCache, bestiaryCache);
}

/**
 * FFPR-Agent as a dsh plugin: the entry the loader imports (name, inject, Config, apply).
 * The plan is MyDesign/FFPR-Agent/ffpr-agent-dsh接入方案.md §10; this file starts the
 * shared engine and installs the per-agent glue (player.ts). The root panel entry registers
 * the routes once for all six games (task 24).
 */

import type { Context } from "@deepseek-ai/cordis";
import { BestiaryAreaCache } from "./engine/achievements.ts";
import { MonsterCache } from "./engine/bestiary.ts";
import type { Config as ConfigValue } from "./plugin/config.ts";
import { installCommands } from "./plugin/commands.ts";
import { installOverview } from "./plugin/overview.ts";
import { installPanel } from "./plugin/panel.ts";
import { installPlayer, startEngine } from "./plugin/player.ts";
import { engineFor, registerEngine } from "./plugin/registry.ts";
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
  // entries by exact package name). 10-29 (task 24): it also registers the routes once, keyed by
  // ?game=, because dsh refuses a second route of the same path from each of the six presets.
  if (config.role === "panel") {
    installPanel(ctx, engineFor, undefined, new MonsterCache(), new BestiaryAreaCache());
    installOverview(ctx, engineFor);
    return;
  }
  if (config.role === "tactician") {
    // The second layer only reads: no laptop, no bridge, no event stream, no game engine.
    await installTactician(ctx, config, log);
    return;
  }
  const engine = await startEngine(config, log);
  // The root and the six players may hold different module instances: registry.ts keeps the
  // one table on globalThis so engineFor() sees every preset's engine.
  ctx.effect(() => registerEngine(engine));

  // The watcher follows the bridge's stream until the plugin unloads.
  ctx.effect(() => () => {
    engine.stop.abort();
    engine.bridge?.close();
  });
  installPlayer(ctx, engine, log);
  // 10-29 (task 24): routes moved to the root panel entry. The command name must be unique
  // across all six presets, so only the FF5 player still registers /ach.
  if (config.game !== "ff5") return;
  installCommands(ctx, engine, undefined, new MonsterCache());
}

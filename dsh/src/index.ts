/**
 * FFPR-Agent as a dsh plugin: the entry the loader imports (name, inject, Config, apply).
 * The plan is MyDesign/FFPR-Agent/ffpr-agent-dsh接入方案.md §10; this file registers a lazy
 * engine slot and installs the per-agent glue (player.ts), so loading the plugin touches no
 * laptop (task 31). The root panel entry registers the routes once for all six games (task 24).
 */

import type { Context } from "@deepseek-ai/cordis";
import { BestiaryAreaCache } from "./engine/achievements.ts";
import { MonsterCache } from "./engine/bestiary.ts";
import type { Config as ConfigValue } from "./plugin/config.ts";
import { PlayerJournal } from "./engine/player-log.ts";
import { installCommands } from "./plugin/commands.ts";
import { latestActivities, type CurrentSource } from "./plugin/current.ts";
import { detectionSource } from "./plugin/detect.ts";
import { installOverview } from "./plugin/overview.ts";
import { installPanel } from "./plugin/panel.ts";
import { createEngineSlot, installPlayer } from "./plugin/player.ts";
import { engineFor, registerSlot, slotFor, slots } from "./plugin/registry.ts";
import { installTactician } from "./plugin/tactician.ts";

export { Config } from "./plugin/config.ts";

/** Loader identity. */
export const name = "ffpr";

/** Services needed before apply(): tools, the agent bus, the prompt, subagents, commands. */
// `agentPresets` is @deepseek-ai/dsh-agent-preset-registry (task 32: new sessions follow the
// game open on the laptop).
export const inject = ["tools", "agents", "systemPrompt", "subagents", "commands", "agentPresets"];

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
    const detection = detectionSource(config);
    const current: CurrentSource = {
      detection,
      engines: () =>
        [...slots().values()].flatMap((slot) => {
          const engine = slot.current();
          return engine === undefined
            ? []
            : [{ game: engine.game.game, startedAt: engine.startedAt }];
        }),
      activities: latestActivities,
      fallback: config.game,
    };
    installPanel(ctx, engineFor, undefined, new MonsterCache(), new BestiaryAreaCache(), current);
    installOverview(ctx, engineFor, slotFor, detection, log, current);
    return;
  }
  if (config.role === "tactician") {
    // The second layer only reads: no laptop, no bridge, no event stream, no game engine.
    await installTactician(ctx, config, log);
    return;
  }
  // 10-29 (task 24): the root and the six players may hold different module instances, so
  // registry.ts keeps one table on globalThis. 11-02 (task 31): it keeps slots now, not started
  // engines; the slot also stops its watcher and bridge when the plugin unloads.
  const journal = await PlayerJournal.load({
    file: config.playerFile,
    warn: (message) => {
      log.warn(message);
    },
  });
  const slot = createEngineSlot(config, log, undefined, journal);
  ctx.effect(() => registerSlot(slot));
  installPlayer(ctx, slot, config, log, undefined, undefined, journal);
  // 10-29 (task 24): routes moved to the root panel entry. The command name must be unique
  // across all six presets, so only the FF5 player still registers /ach.
  if (config.game !== "ff5") return;
  installCommands(ctx, slot, undefined, new MonsterCache());
}

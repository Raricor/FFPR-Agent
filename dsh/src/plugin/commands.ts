/**
 * The `/ach` human command (task 13): current-save achievement progress beside Steam's unlock
 * flags. This is the one player-side surface that answers without the model; it uses
 * @deepseek-ai/dsh-commands' registry and the same Pilot seam as the game tools.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import {
  achievementView,
  formatAchievements,
  parseAchievements,
  type AchievementView,
} from "../engine/achievements.ts";
import { LinkError } from "../engine/bridge.ts";
import { describeError } from "../engine/errors.ts";
import { CalledProcessError } from "../engine/laptop.ts";
import { type MonsterCache } from "../engine/bestiary.ts";
import { createPilot } from "../engine/link-pilot.ts";
import type { Pilot } from "../engine/pilot.ts";
import type { PlayerEngine } from "./player.ts";

const BRIDGE_DOWN = "连不上桥插件，游戏可能没开";

/** Test seam: production builds one Pilot from the laptop and LAN link for this invocation. */
export type CommandPilotFactory = (engine: PlayerEngine, signal: AbortSignal) => Pilot;

function defaultPilot(engine: PlayerEngine, signal: AbortSignal): Pilot {
  return createPilot(engine.laptop, engine.bridge, signal);
}

export type AchievementRead =
  | { readonly ok: true; readonly view: AchievementView }
  | { readonly ok: false; readonly error: string };

/** One bridge read shared by `/ach` and the sidebar route: the view, or a Chinese error. */
export async function readAchievementView(
  engine: PlayerEngine,
  signal: AbortSignal,
  pilotFor: CommandPilotFactory = defaultPilot,
  monsterCache?: MonsterCache,
): Promise<AchievementRead> {
  if (engine.bridge === undefined) return { ok: false, error: BRIDGE_DOWN };
  const pilot = pilotFor(engine, signal);
  try {
    const reply = await pilot.query("achievements");
    const data = parseAchievements(reply);
    const monsters = monsterCache === undefined ? null : await monsterCache.load(pilot, signal);
    const guide = (engine as Partial<PlayerEngine>).game?.guide ?? null;
    return { ok: true, view: achievementView(data, monsters, guide) };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof LinkError || error instanceof CalledProcessError) {
      return { ok: false, error: BRIDGE_DOWN };
    }
    return { ok: false, error: `读不了成就进度:${describeError(error)}` };
  }
}

export function achievementCommand(
  engine: PlayerEngine,
  pilotFor: CommandPilotFactory = defaultPilot,
  monsterCache?: MonsterCache,
): CommandDefinition {
  return {
    name: "ach",
    description: "当前存档的成就进度(对照 Steam 解锁情况)",
    handler: async (invocation) => {
      const result = await readAchievementView(engine, invocation.signal, pilotFor, monsterCache);
      return result.ok
        ? { kind: "success", text: formatAchievements(result.view) }
        : { kind: "error", text: result.error };
    },
  };
}

/** Register `/ach` on the plugin's ctx; the returned disposer is the effect that owns it. */
export function installCommands(
  ctx: Context,
  engine: PlayerEngine,
  pilotFor: CommandPilotFactory = defaultPilot,
  monsterCache?: MonsterCache,
): void {
  ctx.effect(() => ctx.commands.register(achievementCommand(engine, pilotFor, monsterCache)));
}

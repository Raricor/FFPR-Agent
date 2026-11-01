/**
 * The six player engines registered in one place (task 24). The root panel entry serves the
 * routes and the overview page but starts no engine, so it has to find the engines the six
 * player presets started.
 *
 * The table lives on `globalThis[Symbol.for("@local/ffpr-dsh/engines")]`, not in a module
 * variable: the root entry and the player presets may hold different instances of this module
 * (hot reload, loader isolation), and they still have to see the same six engines. This is the
 * only state the games are allowed to share.
 */

import type { PlayerEngine } from "./player.ts";

const ENGINES = Symbol.for("@local/ffpr-dsh/engines");
const holder = globalThis as unknown as Record<symbol, unknown>;

function table(): Map<string, PlayerEngine> {
  const existing = holder[ENGINES];
  if (existing instanceof Map) return existing as Map<string, PlayerEngine>;
  const created = new Map<string, PlayerEngine>();
  holder[ENGINES] = created;
  return created;
}

export function engines(): ReadonlyMap<string, PlayerEngine> {
  return table();
}

export function engineFor(game: string): PlayerEngine | undefined {
  return table().get(game.toLowerCase());
}

/**
 * Register this preset's engine and return the disposer for `ctx.effect`. It removes only the
 * engine it registered: a reload of the same game has already put the new engine in the slot,
 * and the old instance unloading must not delete it.
 */
export function registerEngine(engine: PlayerEngine): () => void {
  const game = engine.game.game;
  table().set(game, engine);
  return () => {
    if (table().get(game) === engine) table().delete(game);
  };
}

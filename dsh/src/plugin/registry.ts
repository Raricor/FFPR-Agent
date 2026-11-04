/**
 * The six player engines, registered as lazy slots (task 24, task 31). The root panel entry
 * serves the routes and the overview page but starts no engine; it finds each preset's slot and
 * may start the one game that is open. A slot keeps the engine, the in-flight start and the
 * stopped flag, so `engineFor()` only ever returns an engine that has really started.
 *
 * The table lives on `globalThis[Symbol.for("@local/ffpr-dsh/engines")]`, not in a module
 * variable: the root entry and the player presets may hold different instances of this module
 * (hot reload, loader isolation), and they still have to see the same six slots. This is the
 * only state the games are allowed to share.
 */

import type { PlayerEngine } from "./player.ts";

/** What one preset registers before anything has contacted the laptop. */
export interface EngineSlot {
  readonly game: string;
  /** The started engine, or undefined before the first use and after unload. */
  current(): PlayerEngine | undefined;
  /** Start at most once; concurrent callers share the promise, failure clears it for a retry. */
  ensure(signal?: AbortSignal): Promise<PlayerEngine>;
  /** Stop a started engine; an unload during startup stops it as soon as it appears. */
  stop(): void;
}

const ENGINES = Symbol.for("@local/ffpr-dsh/engines");
const holder = globalThis as unknown as Record<symbol, unknown>;

function table(): Map<string, EngineSlot> {
  const existing = holder[ENGINES];
  if (existing instanceof Map) return existing as Map<string, EngineSlot>;
  const created = new Map<string, EngineSlot>();
  holder[ENGINES] = created;
  return created;
}

export function slots(): ReadonlyMap<string, EngineSlot> {
  return table();
}

export function slotFor(game: string): EngineSlot | undefined {
  return table().get(game.toLowerCase());
}

/** Only a started engine: the panel must not believe an idle slot is running. */
export function engineFor(game: string): PlayerEngine | undefined {
  return slotFor(game)?.current();
}

/**
 * Register this preset's slot and return the disposer for `ctx.effect`. It removes only the
 * slot it registered: a reload of the same game has already put the new slot in the table, and
 * the old instance unloading must not delete it (but its started engine is still stopped).
 */
export function registerSlot(slot: EngineSlot): () => void {
  const game = slot.game.toLowerCase();
  table().set(game, slot);
  return () => {
    if (table().get(game) === slot) table().delete(game);
    slot.stop();
  };
}

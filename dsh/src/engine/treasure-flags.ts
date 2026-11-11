/**
 * Task 135 (11-11): the bridge's whole-game treasure flag table. The old `entities` read only
 * covered the map that was loaded, so a client restart forgot that a town's chests were open and
 * kept planning the same section. Bridge 0.14.8's `treasureflags` answers every master flag at
 * once; an older bridge answers "unknown op", which must fall back to the entity read silently.
 */

import { isRecord, num } from "./values.ts";

/** What one `treasureflags` reply means. */
export type TreasureFlagRead =
  | {
      readonly kind: "flags";
      /** Flag id → true/false; null means the game threw while reading that one flag. */
      readonly flags: ReadonlyMap<number, boolean | null>;
      readonly total: number;
    }
  /** The title screen or a save load: the master data or the party is not ready yet. */
  | { readonly kind: "not-ready" }
  /** A bridge older than 0.14.8: the caller keeps its entity-based fallback. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly error: string };

/** What an old bridge calls an op it does not know (`未知的 op:treasureflags`). */
const UNKNOWN_OP = /未知的\s*op|unknown\s+op/iu;

/**
 * Read one reply from `pilot.query("treasureflags")`. Never throws: a malformed reply is just
 * another error for the caller to log or ignore.
 */
export function parseTreasureFlags(reply: unknown): TreasureFlagRead {
  const value = isRecord(reply) ? reply : {};
  if (value.ok === false) {
    const error = typeof value.error === "string" ? value.error : "treasureflags 失败";
    return UNKNOWN_OP.test(error) ? { kind: "unsupported" } : { kind: "error", error };
  }
  const body = isRecord(value.treasureflags) ? value.treasureflags : null;
  if (body === null) {
    return { kind: "error", error: "回复里没有 treasureflags" };
  }
  if (body.ready === false) return { kind: "not-ready" };
  const raw = body.flags;
  if (!isRecord(raw)) {
    return { kind: "error", error: "treasureflags 没有 flags 对象" };
  }
  const flags = new Map<number, boolean | null>();
  for (const [key, item] of Object.entries(raw)) {
    const id = Number.parseInt(key, 10);
    if (!Number.isInteger(id) || id < 0) continue;
    flags.set(id, item === true ? true : item === false ? false : null);
  }
  return { kind: "flags", flags, total: num(body.total) ?? flags.size };
}

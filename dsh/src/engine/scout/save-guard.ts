/**
 * Saving while a scout is running (task 102) must be refused: the scout relies on slot 20
 * still holding the save from before the dungeon, and writing it during the scout would make
 * that save impossible to return to. This is the pure decision; wiring it into saveGame is a
 * later task.
 */

import {
  inScoutWindow,
  type ScoutTimestamp,
  type ScoutWindow,
  type ScoutWindows,
} from "./snapshot.ts";

/** Whatever the game knows about the running scout; every field is optional so wiring is easy. */
export interface ScoutSaveState {
  readonly active?: boolean;
  readonly scouting?: boolean;
  /**
   * Task 100's state may carry the scout as a nested object. Accept the boolean forms too so
   * the caller can pass its own state shape without translating it.
   */
  readonly scout?: boolean | { readonly active?: boolean; readonly scouting?: boolean };
  /** The loaded windows, or the interval list itself. */
  readonly windows?: ScoutWindows | readonly ScoutWindow[];
  /** The time the save is being attempted; defaults to now. */
  readonly at?: ScoutTimestamp;
}

function scoutActive(state: ScoutSaveState): boolean {
  if (state.active === true || state.scouting === true) return true;
  if (state.scout === true) return true;
  if (typeof state.scout === "object") {
    return state.scout.active === true || state.scout.scouting === true;
  }
  return false;
}

const REFUSAL = "侦察进行中不能存档:只能读回进副本前的 20 号档";

/**
 * The Chinese reason saving is refused, or null when it is allowed. A scout window is checked
 * at `state.at` (default now) so a caller can judge a record that was written earlier.
 */
export function scoutSaveGuard(
  state: ScoutSaveState | boolean | null | undefined,
  at: ScoutTimestamp = new Date(),
): string | null {
  if (state === true) return REFUSAL;
  if (state === null || state === undefined) return null;
  if (typeof state === "boolean") return null;
  const when = state.at ?? at;
  if (scoutActive(state)) return REFUSAL;
  if (state.windows !== undefined && inScoutWindow(state.windows, when)) return REFUSAL;
  return null;
}

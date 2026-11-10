/**
 * Task 112: the trace of one `go` (navigate) call, one compact JSON line under
 * `.deps/ds/move-trace-<game>.jsonl` (control plan §4.9). It answers "why did this call keep
 * replanning?": where it started, the goal, every replan with the step it cut, and why it
 * ended. A failed write is one warning and never fails the walk.
 *
 * The path can be overridden with MoveState.trace; tests always pass a temporary file.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError } from "../errors.ts";
import type { Cell } from "../nav.ts";
import { DEPS } from "../paths.ts";

/** More replans than this in one call are stored head and tail, with a count of the dropped. */
export const MOVE_TRACE_REPLANS = 40;
export const MOVE_TRACE_HEAD = 10;

export interface MoveTraceReplan {
  /** Wall-clock time, ISO. */
  readonly at: string;
  /** Where the party stood when this plan was made, when the bridge could say. */
  readonly cell: Cell | null;
  readonly map: number | null;
  /** Cells in the plan, including the start cell. */
  readonly length: number;
  /** Why this plan was abandoned (short Chinese phrase). */
  readonly reason: string;
  /** Blocked steps (edge keys `x,y>x,y`) cut while walking this plan. */
  readonly cuts: readonly string[];
}

export interface MoveTraceEnd {
  readonly at: string;
  /** Stable key: arrived, timeout, stalled, blocked, interrupted, error, ... */
  readonly reason: string;
  readonly reached: boolean;
  /** Time measured with Pilot.now(), so a fake clock works in tests. */
  readonly elapsedMs: number;
  /** The closest cell a plan started from, and its distance on the known map. */
  readonly best: {
    readonly cell: Cell | null;
    readonly distance: number | null;
  };
  /** Every blocked step cut during this call, edge keys. */
  readonly cuts: readonly string[];
}

export interface MoveTraceEntry {
  readonly at: string;
  readonly game: string;
  readonly start: { readonly map: number | null; readonly cell: Cell | null };
  readonly goal: Cell;
  readonly byShip: boolean;
  readonly legs: number;
  readonly replans: readonly MoveTraceReplan[];
  /** Replans dropped by the length limit (absent when nothing was dropped). */
  readonly omitted?: number;
  readonly end: MoveTraceEnd;
}

/** `.deps/ds/move-trace-<game>.jsonl`; the game key is kept to letters, digits and `_`. */
export function moveTracePath(game: string): string {
  const safe = game.trim().replace(/[^A-Za-z0-9_-]/gu, "_");
  return join(DEPS, "ds", `move-trace-${safe === "" ? "unknown" : safe}.jsonl`);
}

/**
 * The trace file for one call: an explicit MoveState.trace wins, null or "" disables it, and
 * an undefined path falls back to the game's file. Without a game key (unit tests, a bare
 * plan) nothing is written, so tests never touch the real .deps tree by accident.
 */
export function tracePathFor(
  game: string | undefined,
  trace: string | null | undefined,
): string | null {
  if (trace === null) return null;
  if (trace !== undefined) return trace.trim() === "" ? null : trace;
  const key = game?.trim() ?? "";
  return key === "" ? null : moveTracePath(key);
}

/** Keep the first and last replans so one line stays readable (task 112). */
export function compactMoveTrace(entry: MoveTraceEntry): MoveTraceEntry {
  if (entry.replans.length <= MOVE_TRACE_REPLANS) return entry;
  const tailCount = MOVE_TRACE_REPLANS - MOVE_TRACE_HEAD;
  return {
    ...entry,
    replans: [...entry.replans.slice(0, MOVE_TRACE_HEAD), ...entry.replans.slice(-tailCount)],
    omitted: entry.replans.length - MOVE_TRACE_REPLANS,
  };
}

/**
 * Append one call's trace. It never throws: the walk matters more than its record, so a
 * broken path is reported through `warn` (the tool's say channel) and the call goes on.
 */
export async function appendMoveTrace(
  entry: MoveTraceEntry,
  file: string | null,
  warn: (message: string) => void = () => undefined,
): Promise<boolean> {
  if (file === null) return false;
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(compactMoveTrace(entry)) + "\n", {
      encoding: "utf8",
    });
    return true;
  } catch (error) {
    warn(`写不了移动轨迹 ${file}:${describeError(error)}`);
    return false;
  }
}

/**
 * Script-moved jumps (task 149): a map object such as a jump stone teleports the party by a
 * script `Move` instead of a walkable step. The export names where the party must stand, which
 * way it must face, and where it lands; the route and the walk both read this shape.
 *
 * This module is the shared vocabulary only. Reading the game files lives in `game-files.ts`;
 * turning a jump into a directed graph edge lives here so `regions.ts`, `skills/move.ts` and
 * `route/distance.ts` agree on the same from/to cells.
 */

import type { Cell, ObservedMove } from "../nav.ts";

export type JumpKind = "step" | "touch";

/** The four player directions, in the order the game's direction operands use (0-3). */
export type JumpFacing = "Up" | "Right" | "Down" | "Left";

export interface MapJump {
  /** The trigger object's cell. */
  readonly cell: Cell;
  readonly kind: JumpKind;
  /** The way the party faces when it uses the object. */
  readonly facing: JumpFacing;
  readonly land: Cell;
  /** Script file name without `.json` (`sc_30060_jump_10`). */
  readonly script: string;
}

/** The four directions, indexed the way `Move` and `BranchByPlayerDirection` number them. */
export const JUMP_FACINGS: readonly JumpFacing[] = ["Up", "Right", "Down", "Left"];

export const JUMP_DELTAS: Readonly<Record<JumpFacing, Cell>> = {
  Up: [0, -1],
  Right: [1, 0],
  Down: [0, 1],
  Left: [-1, 0],
};

/** A `step` jump is entered from the cell in front of the trigger; a `touch` one is used there. */
export function jumpStand(jump: MapJump): Cell {
  const [dx, dy] = JUMP_DELTAS[jump.facing];
  return [jump.cell[0] - dx, jump.cell[1] - dy];
}

/** The map's jumps as directed (stand → landing) moves for the layered search. */
export function jumpMoves(jumps: readonly MapJump[]): ObservedMove[] {
  const seen = new Set<string>();
  const moves: ObservedMove[] = [];
  for (const jump of jumps) {
    const from = jumpStand(jump);
    const key = `${from[0]},${from[1]}>${jump.land[0]},${jump.land[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    moves.push({ from, to: jump.land, how: "调查后跳", kind: "jump" });
  }
  return moves;
}

/** Whether a recorded move is a same-map jump edge. */
export function isJumpMove(move: ObservedMove): boolean {
  return move.kind === "jump" || move.how.includes("跳石") || move.how.includes("调查后跳");
}

/**
 * Hidden-passage cells plus, when the caller has it, the map's exported jumps. `CollisionStore`
 * hands this to the walk through the existing `MoveState.passages` callback (task 149), so the
 * walk needs no second game-file read and `game.ts` needs no new hook.
 */
export interface MapFeatures {
  readonly passages: readonly {
    readonly cell: Cell;
    readonly layer: number | null;
  }[];
  readonly jumps: readonly MapJump[];
}

/** The array form keeps old callers working while carrying the jumps beside the passages. */
export type PassageFeatures = readonly {
  readonly cell: Cell;
  readonly layer: number | null;
}[] & { readonly jumps?: readonly MapJump[] };

export function splitFeatures(value: readonly { readonly cell: Cell; readonly layer: number | null }[] | MapFeatures): {
  readonly passages: readonly { readonly cell: Cell; readonly layer: number | null }[];
  readonly jumps: readonly MapJump[];
} {
  if (Array.isArray(value)) {
    const passages = value as readonly { readonly cell: Cell; readonly layer: number | null }[];
    return { passages, jumps: (value as PassageFeatures).jumps ?? [] };
  }
  return value as MapFeatures;
}

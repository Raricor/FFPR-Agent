/**
 * Script-moved jumps (task 149): a map object such as a jump stone teleports the party by a
 * script `Move` instead of a walkable step. The export names where the party must stand, which
 * way it must face, and where it lands; the route and the walk both read this shape.
 *
 * This module is both the vocabulary and the reader: `parseJumps` turns the game files'
 * scripts and collision into chained jumps, and `jumpMoves` turns them into the directed
 * edges `regions.ts`, `skills/move.ts` and `route/distance.ts` all search.
 */

import type { Cell, ObservedMove } from "../nav.ts";
import { isRecord, list, records, text } from "../values.ts";

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

/**
 * Task 149 follow-up: an atlas link `how: "调查后跳"` is a touch jump learned on the live
 * machine. `from` is where the party stood; `to` is the landing. If that cell cannot be stood
 * on, the link was recorded from the nearest standable neighbour, so use the neighbour that
 * faces the trigger. "走不过去" links are walls and are ignored.
 */
export function jumpsFromObserved(
  moves: readonly ObservedMove[],
  isWalkable: (cell: Cell) => boolean,
): MapJump[] {
  const jumps: MapJump[] = [];
  const seen = new Set<string>();
  for (const move of moves) {
    if (!move.how.includes("调查后跳") || move.kind === "jump") continue;
    const from = move.from;
    const to = move.to;
    let stand: Cell | null = isWalkable(from) ? from : null;
    if (stand === null) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const neighbour: Cell = [from[0] + dx, from[1] + dy];
        if (isWalkable(neighbour)) {
          stand = neighbour;
          break;
        }
      }
    }
    if (stand === null) continue;
    const facing =
      stand[0] === from[0] && stand[1] === from[1]
        ? directionBetween(from, to)
        : directionBetween(stand, from);
    if (facing === null) continue;
    let cell: Cell;
    if (stand[0] === from[0] && stand[1] === from[1]) {
      const delta = JUMP_DELTAS[facing];
      cell = [from[0] + delta[0], from[1] + delta[1]];
      if (cell[0] === to[0] && cell[1] === to[1]) continue;
    } else {
      cell = from;
    }
    const key = `${cell[0]},${cell[1]}:${facing}:${to[0]},${to[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jumps.push({ cell, kind: "touch", facing, land: to, script: "atlas-link" });
  }
  return jumps;
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

export function splitFeatures(
  value: readonly { readonly cell: Cell; readonly layer: number | null }[] | MapFeatures,
): {
  readonly passages: readonly {
    readonly cell: Cell;
    readonly layer: number | null;
  }[];
  readonly jumps: readonly MapJump[];
} {
  if (Array.isArray(value)) {
    const passages = value as readonly {
      readonly cell: Cell;
      readonly layer: number | null;
    }[];
    return { passages, jumps: (value as PassageFeatures).jumps ?? [] };
  }
  return value as MapFeatures;
}

// ---------------------------------------------------------------------------------------------
// Reading jump objects and following chained step stones. The exporter (task 150) calls
// `parseJumps`; keeping the reader here means the chaining rule lives beside the edge shape.

interface ScriptInstruction {
  readonly mnemonic: string;
  readonly values: readonly number[];
  readonly texts: readonly string[];
}

type PlayerSteps = readonly (readonly [direction: number, cells: number])[];

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function propertyValue(object: unknown, name: string): unknown {
  if (!isRecord(object)) return undefined;
  for (const property of records(object.properties)) {
    if (text(property.name) === name) return property.value;
  }
  return undefined;
}

function objectType(object: unknown): number | null {
  return integer(propertyValue(object, "object_type"));
}

function objectName(object: unknown): string {
  return isRecord(object) ? (text(object.name) ?? "") : "";
}

function objectCell(object: unknown): [number, number] | null {
  if (!isRecord(object)) return null;
  const x = integer(object.x);
  const y = integer(object.y);
  if (x === null || y === null) return null;
  const gid = integer(object.gid);
  return [Math.floor(x / 16), Math.floor(y / 16) - (gid === null ? 0 : 1)];
}

function tileLayersOf(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    for (const layer of records(node.layers)) {
      found.push(layer);
      walk(layer);
    }
  };
  walk(value);
  return found;
}

function scriptProgram(value: unknown): readonly ScriptInstruction[] | null {
  if (!isRecord(value) || !Array.isArray(value.Mnemonics)) return null;
  const instructions: ScriptInstruction[] = [];
  for (const entry of records(value.Mnemonics)) {
    const mnemonic = text(entry.mnemonic) ?? "";
    if (mnemonic === "") continue;
    const operands = isRecord(entry.operands) ? entry.operands : {};
    instructions.push({
      mnemonic,
      values: list(operands.iValues).map((item) => integer(item) ?? 0),
      texts: list(operands.sValues).map((item) => text(item) ?? ""),
    });
  }
  return instructions.length === 0 ? null : instructions;
}

/**
 * The player's `Move` sequence. `SetPuppet` slot 0 with entity -1001 is the player; its third
 * operand is the script entry to run. A branchless script uses one absolute sequence for every
 * facing, so all four facings share it.
 */
function directPaths(instructions: readonly ScriptInstruction[]): Map<JumpFacing, PlayerSteps> {
  const run = (entry: number): PlayerSteps | null => {
    const steps: (readonly [number, number])[] = [];
    const returns: number[] = [];
    const seen = new Set<number>();
    let index = entry;
    for (let guard = 0; guard < 1024; guard += 1) {
      const instruction = instructions[index];
      if (instruction === undefined) break;
      if (seen.has(index)) return null;
      seen.add(index);
      if (instruction.mnemonic === "Move") {
        const direction = instruction.values[0] ?? -1;
        const cells = instruction.values[1] ?? 0;
        if (direction < 0 || direction > 3 || cells <= 0 || cells > 64) return null;
        steps.push([direction, cells]);
        index += 1;
        continue;
      }
      if (instruction.mnemonic === "SetPuppet" && instruction.values[1] === -1001) {
        const target = instruction.values[2] ?? -1;
        if (target < 0 || target >= instructions.length) return null;
        returns.push(index + 1);
        index = target;
        continue;
      }
      if (instruction.mnemonic === "Call") {
        const target = instruction.values[0] ?? -1;
        if (target < 0 || target >= instructions.length) return null;
        returns.push(index + 1);
        index = target;
        continue;
      }
      if (instruction.mnemonic === "Exit" || instruction.mnemonic === "ChangeScript") break;
      if (instruction.mnemonic === "Return") {
        const next = returns.pop();
        if (next === undefined) break;
        index = next;
        continue;
      }
      index += 1;
    }
    return steps.length === 0 ? null : steps;
  };

  const paths = new Map<JumpFacing, PlayerSteps>();
  const branch = instructions.find((item) => item.mnemonic === "BranchByPlayerDirection");
  if (branch !== undefined) {
    // The four operands are the branch labels for Up, Right, Down, Left. jump_10's
    // [5,0,2,0] points at its 上向き/下向き labels; jump_11's [0,5,0,2] at 右向き/左向き.
    JUMP_FACINGS.forEach((facing, direction) => {
      const target = branch.values[direction] ?? 0;
      if (target <= 0 || target >= instructions.length) return;
      const steps = run(target);
      if (steps !== null) paths.set(facing, steps);
    });
    return paths;
  }
  const puppet = instructions.find(
    (item) => item.mnemonic === "SetPuppet" && item.values[1] === -1001,
  );
  if (puppet === undefined) return paths;
  const steps = run(puppet.values[2] ?? -1);
  if (steps !== null) for (const facing of JUMP_FACINGS) paths.set(facing, steps);
  return paths;
}

function scriptPrograms(
  scripts: readonly { readonly file: string; readonly value: unknown }[],
): Map<string, readonly ScriptInstruction[]> {
  const programs = new Map<string, readonly ScriptInstruction[]>();
  for (const item of scripts) {
    const name = item.file.replace(/\.json$/u, "");
    const program = scriptProgram(item.value);
    if (program !== null) programs.set(name, program);
  }
  return programs;
}

function stripJson(value: string): string {
  return value.replace(/\.json$/u, "");
}

/** Follow `ChangeScript` (jump_1 → jump_2 → jump_4) and append every later player `Move`. */
function scriptPaths(
  instructions: readonly ScriptInstruction[],
  programs: ReadonlyMap<string, readonly ScriptInstruction[]>,
  seen: Set<readonly ScriptInstruction[]>,
): Map<JumpFacing, PlayerSteps> {
  const local = directPaths(instructions);
  const change = instructions.find(
    (item) => item.mnemonic === "ChangeScript" && (item.texts[0] ?? "") !== "",
  );
  if (change === undefined) return local;
  const next = programs.get(stripJson(change.texts[0] ?? ""));
  if (next === undefined || seen.has(next)) return local;
  seen.add(next);
  const more = scriptPaths(next, programs, seen);
  if (local.size === 0) return more;
  const out = new Map<JumpFacing, PlayerSteps>();
  for (const [facing, steps] of local) {
    const after = more.get(facing);
    out.set(facing, after === undefined ? steps : [...steps, ...after]);
  }
  return out;
}

/** A timer start's `SetTimer` names the script that relocates the jump stone and changes it. */
function timerJumpName(instructions: readonly ScriptInstruction[]): string | null {
  const timer = instructions.find(
    (item) => item.mnemonic === "SetTimer" && (item.texts[0] ?? "") !== "",
  );
  return timer === undefined ? null : stripJson(timer.texts[0] ?? "");
}

const JUMP_WALKABLE = new Set(["0", "2", "3", "4", "5"]);

interface JumpLayer {
  readonly width: number;
  readonly height: number;
  readonly walkable: readonly boolean[];
  readonly components: Int32Array;
}

function jumpLayerRows(rows: readonly string[]): JumpLayer | null {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (width === 0 || height === 0) return null;
  const walkable = new Array<boolean>(width * height).fill(false);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y] ?? "";
    for (let x = 0; x < width; x += 1) {
      walkable[y * width + x] = JUMP_WALKABLE.has(row[x] ?? "");
    }
  }
  const components = new Int32Array(width * height).fill(-1);
  let next = 0;
  const queue: number[] = [];
  for (let start = 0; start < walkable.length; start += 1) {
    if (walkable[start] !== true || components[start] !== -1) continue;
    components[start] = next;
    queue.length = 0;
    queue.push(start);
    for (const index of queue) {
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx;
        if (walkable[neighbour] !== true || components[neighbour] !== -1) continue;
        components[neighbour] = next;
        queue.push(neighbour);
      }
    }
    next += 1;
  }
  return { width, height, walkable, components };
}

function jumpCell(layer: JumpLayer, cell: Cell): number | null {
  if (cell[0] < 0 || cell[1] < 0 || cell[0] >= layer.width || cell[1] >= layer.height) return null;
  return cell[1] * layer.width + cell[0];
}

function jumpLanding(start: Cell, steps: PlayerSteps): Cell {
  let x = start[0];
  let y = start[1];
  for (const [direction, cells] of steps) {
    const delta = JUMP_DELTAS[JUMP_FACINGS[direction] ?? "Up"];
    x += delta[0] * cells;
    y += delta[1] * cells;
  }
  return [x, y];
}

/** The single axis direction from one cell to another, or null when it is neither row nor column. */
function directionBetween(from: Cell, to: Cell): JumpFacing | null {
  if (from[0] === to[0] && from[1] !== to[1]) return to[1] < from[1] ? "Up" : "Down";
  if (from[1] === to[1] && from[0] !== to[0]) return to[0] < from[0] ? "Left" : "Right";
  return null;
}

export interface JumpSkip {
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly scriptId: number | null;
  readonly reason: string;
}

export interface JumpParse {
  readonly jumps: readonly MapJump[];
  readonly skipped: readonly JumpSkip[];
}

interface StepTrigger {
  readonly facing: JumpFacing;
  readonly land: Cell;
}

interface RawJump {
  readonly cell: Cell;
  readonly kind: JumpKind;
  readonly facing: JumpFacing;
  readonly start: Cell;
  readonly land: Cell;
  readonly script: string;
  /** Step triggers with no walkable stand are chain-only, not exported as their own rows. */
  readonly exportable: boolean;
}

function triggerFor(
  triggers: ReadonlyMap<string, readonly StepTrigger[]>,
  cell: Cell,
  arrival: JumpFacing | null,
  previous: Cell,
): StepTrigger | null {
  const found = triggers.get(`${cell[0]},${cell[1]}`);
  if (found === undefined || found.length === 0) return null;
  if (arrival !== null) {
    const exact = found.find((item) => item.facing === arrival);
    if (exact !== undefined) return exact;
  }
  const forward = found.find(
    (item) => item.land[0] !== previous[0] || item.land[1] !== previous[1],
  );
  return forward ?? found[0] ?? null;
}

/**
 * Follow step stones the party lands on. A step trigger has no input of its own: the script
 * runs as the party arrives, so the exported landing must be the cell where the chain stops.
 * A chain that would return to a cell already visited stops on the current cell: that is the
 * stone's own landing, not an infinite loop.
 */
function chainLanding(
  start: Cell,
  landing: Cell,
  triggers: ReadonlyMap<string, readonly StepTrigger[]>,
): Cell {
  let previous = start;
  let current = landing;
  const seen = new Set<string>([`${start[0]},${start[1]}`, `${landing[0]},${landing[1]}`]);
  for (let guard = 0; guard < 32; guard += 1) {
    const trigger = triggerFor(triggers, current, directionBetween(previous, current), previous);
    if (trigger === null) break;
    const next = trigger.land;
    const key = `${next[0]},${next[1]}`;
    if (seen.has(key)) break;
    seen.add(key);
    previous = current;
    current = next;
  }
  return current;
}

/**
 * Task 149: read jump objects of one map. A candidate is an `object_type` 2 (step on) or 5
 * (touch/confirm) object whose script names the player puppet (`SetPuppet` entity -1001). A
 * landing that is another step stone's trigger is followed until it stops on a normal cell.
 * The final cell must be walkable on the same collision layer but in a different connected
 * block; everything else is reported in `skipped`.
 */
export function parseJumps(
  entity: unknown,
  scripts: readonly { readonly file: string; readonly value: unknown }[],
  scriptNames: ReadonlyMap<number, string> | undefined,
  layers: readonly { readonly rows: readonly string[] }[],
): JumpParse {
  const layersReady = layers
    .map((layer) => jumpLayerRows(layer.rows))
    .filter((layer): layer is JumpLayer => layer !== null);
  const jumps: MapJump[] = [];
  const skipped: JumpSkip[] = [];
  if (layersReady.length === 0) return { jumps, skipped };
  const programs = scriptPrograms(scripts);

  interface Candidate {
    readonly cell: Cell;
    readonly name: string;
    readonly scriptId: number;
    readonly kind: JumpKind;
    readonly scriptName: string;
    readonly paths: ReadonlyMap<JumpFacing, PlayerSteps>;
    readonly timer?: boolean;
  }

  const allTriggers = new Map<string, StepTrigger[]>();
  const addTrigger = (cell: Cell, trigger: StepTrigger): void => {
    const key = `${cell[0]},${cell[1]}`;
    const list = allTriggers.get(key) ?? [];
    if (
      list.some(
        (item) =>
          item.facing === trigger.facing &&
          item.land[0] === trigger.land[0] &&
          item.land[1] === trigger.land[1],
      )
    ) {
      return;
    }
    list.push(trigger);
    allTriggers.set(key, list);
  };

  const candidates: Candidate[] = [];
  for (const layer of tileLayersOf(entity)) {
    for (const object of records(layer.objects)) {
      const type = objectType(object);
      if (type !== 2 && type !== 5) continue;
      const scriptId = integer(propertyValue(object, "script_id"));
      const cell = objectCell(object);
      if (scriptId === null || scriptId <= 0 || cell === null) continue;
      const name = objectName(object);
      const scriptName = scriptNames?.get(scriptId);
      if (scriptName === undefined) {
        skipped.push({
          cell,
          name,
          scriptId,
          reason: `script.csv 里没有脚本 ${scriptId}`,
        });
        continue;
      }
      const script = scripts.find(
        (item) => item.file === `${scriptName}.json` || item.file === scriptName,
      );
      if (script === undefined) {
        skipped.push({
          cell,
          name,
          scriptId,
          reason: `没有脚本文件 ${scriptName}`,
        });
        continue;
      }
      const instructions = scriptProgram(script.value);
      if (instructions === null) {
        skipped.push({
          cell,
          name,
          scriptId,
          reason: `脚本 ${scriptName} 读不懂`,
        });
        continue;
      }
      const timer = timerJumpName(instructions);
      if (timer !== null) {
        const timerProgram = programs.get(timer);
        const change = timerProgram?.find(
          (item) => item.mnemonic === "ChangeScript" && (item.texts[0] ?? "") !== "",
        );
        const jumpName = change === undefined ? null : stripJson(change.texts[0] ?? "");
        const jumpProgram = jumpName === null ? undefined : programs.get(jumpName);
        if (jumpProgram !== undefined) {
          const paths = scriptPaths(jumpProgram, programs, new Set([jumpProgram]));
          const entry = [...paths.entries()][0];
          if (entry !== undefined) {
            const steps = entry[1];
            const direction = steps[0]?.[0] ?? 0;
            const facing = JUMP_FACINGS[direction] ?? "Down";
            candidates.push({
              cell,
              name,
              scriptId,
              kind: "step",
              scriptName: jumpName ?? scriptName,
              paths: new Map([[facing, steps]]),
              timer: true,
            });
            continue;
          }
        }
      }
      const movesPlayer = instructions.some(
        (item) => item.mnemonic === "SetPuppet" && item.values[1] === -1001,
      );
      if (!movesPlayer) continue;
      const paths = scriptPaths(instructions, programs, new Set([instructions]));
      if (paths.size === 0) {
        skipped.push({
          cell,
          name,
          scriptId,
          reason: `脚本 ${scriptName} 没有玩家的 Move`,
        });
        continue;
      }
      const kind: JumpKind = type === 2 ? "step" : "touch";
      candidates.push({ cell, name, scriptId, kind, scriptName, paths });
      if (kind !== "step") continue;
      // A step stone reached by another jump has no walkable stand; it still triggers when the
      // party lands on it, so its land joins the chain even though it is not exported itself.
      if (
        !layersReady.some((feature) => {
          const index = jumpCell(feature, cell);
          return index !== null && feature.walkable[index] === true;
        })
      ) {
        continue;
      }
      for (const facing of JUMP_FACINGS) {
        const steps = paths.get(facing);
        if (steps === undefined) continue;
        addTrigger(cell, { facing, land: jumpLanding(cell, steps) });
      }
    }
  }

  for (const candidate of candidates) {
    const raw: RawJump[] = [];
    if (candidate.timer === true) {
      const entry = [...candidate.paths.entries()][0];
      if (entry !== undefined) {
        const [facing, steps] = entry;
        raw.push({
          cell: candidate.cell,
          kind: "step",
          facing,
          start: candidate.cell,
          land: jumpLanding(candidate.cell, steps),
          script: candidate.scriptName,
          exportable: true,
        });
      }
    } else
      for (const feature of layersReady) {
        const cellIndex = jumpCell(feature, candidate.cell);
        if (cellIndex === null) continue;
        if (candidate.kind === "step" && feature.walkable[cellIndex] !== true) continue;
        for (const facing of JUMP_FACINGS) {
          const steps = candidate.paths.get(facing);
          if (steps === undefined) continue;
          const delta = JUMP_DELTAS[facing];
          const stand: Cell = [candidate.cell[0] - delta[0], candidate.cell[1] - delta[1]];
          const standIndex = jumpCell(feature, stand);
          const standable = standIndex !== null && feature.walkable[standIndex] === true;
          if (candidate.kind === "touch" && !standable) continue;
          const start = candidate.kind === "step" ? candidate.cell : stand;
          raw.push({
            cell: candidate.cell,
            kind: candidate.kind,
            facing,
            start,
            land: jumpLanding(start, steps),
            script: candidate.scriptName,
            exportable: candidate.kind === "touch" || standable,
          });
        }
      }
    if (raw.length === 0) {
      skipped.push({
        cell: candidate.cell,
        name: candidate.name,
        scriptId: candidate.scriptId,
        reason: `脚本 ${candidate.scriptName} 四周没有可站的格子`,
      });
      continue;
    }
    let found = false;
    for (const entry of raw) {
      if (!entry.exportable) {
        found = true;
        continue;
      }
      const final = chainLanding(entry.start, entry.land, allTriggers);
      let valid = false;
      for (const feature of layersReady) {
        const startIndex =
          entry.kind === "step" ? jumpCell(feature, entry.cell) : jumpCell(feature, entry.start);
        const landIndex = jumpCell(feature, final);
        if (startIndex === null || landIndex === null) continue;
        if (feature.walkable[landIndex] !== true) continue;
        const startBlock = feature.components[startIndex] ?? -1;
        const landBlock = feature.components[landIndex] ?? -1;
        if (startBlock < 0 || landBlock < 0 || startBlock === landBlock) continue;
        valid = true;
        break;
      }
      if (!valid) continue;
      const key = `${entry.cell[0]},${entry.cell[1]}:${entry.kind}:${entry.facing}:${final[0]},${final[1]}`;
      if (
        jumps.some(
          (jump) =>
            key ===
            `${jump.cell[0]},${jump.cell[1]}:${jump.kind}:${jump.facing}:${jump.land[0]},${jump.land[1]}`,
        )
      ) {
        found = true;
        continue;
      }
      jumps.push({
        cell: entry.cell,
        kind: entry.kind,
        facing: entry.facing,
        land: final,
        script: entry.script,
      });
      found = true;
    }
    if (!found) {
      skipped.push({
        cell: candidate.cell,
        name: candidate.name,
        scriptId: candidate.scriptId,
        reason: `脚本 ${candidate.scriptName} 的落点不可走或和起点同一块`,
      });
    }
  }
  return { jumps, skipped };
}

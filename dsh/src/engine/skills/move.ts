/**
 * Walking: closed-loop legs on the laptop, planned here, re-planned when blocked; and
 * stepping up to a chest, NPC or counter to interact with it. Ported from
 * ffpr_agent/skills/move.py.
 */

import type { Pilot, Reply } from "../pilot.ts";
import {
  cellKey,
  corners,
  edgeKey,
  hasTerrain,
  layeredGrid,
  layeredPath,
  pathToward,
  search,
  terrainRule,
} from "../nav.ts";
import type { Cell, CellGrid } from "../nav.ts";
import { isRecord, record, records, text, truthy, type Json } from "../values.ts";
import { eventBaseName } from "../view.ts";
import type { BattleHooks } from "./battle.ts";
import { regular } from "./battle.ts";

type Say = (line: string) => void;

/**
 * The wind drake's state, once a module variable in Python: where it was last left, and the
 * battle hooks passed on to fights met on the way (the Game holds both).
 */
export interface MoveState {
  drake: Cell | null;
  battle?: BattleHooks;
  /** Records a way found by walking (a conveyor ride) in the atlas; the Game wires it in. */
  link?: (mapId: unknown, from: Cell, to: Cell, how: string) => Promise<void>;
}

const EMPTY_CUT: ReadonlySet<string> = new Set<string>();

// Named events that move the party although their cells are open floor (10-27: the
// Fire-Powered Ship's conveyor 流される carried the player off the path).
const CONVEYOR_EVENTS: ReadonlySet<string> = new Set(["流される"]);

export function isConveyorEvent(name: string): boolean {
  return CONVEYOR_EVENTS.has(eventBaseName(name));
}

/** Python's tuple repr for a cell, which the messages embed. */
function cellText(cell: Cell | null): string {
  return cell === null ? "None" : `(${cell[0]}, ${cell[1]})`;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  return JSON.stringify(value);
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function sameCell(a: Cell | null, b: Cell | null): boolean {
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1];
}

function cellGridOf(value: unknown): CellGrid | null {
  if (!isRecord(value)) return null;
  const origin = cellOf(value.origin);
  const center = cellOf(value.center);
  if (origin === null || center === null || !Array.isArray(value.attr)) return null;
  const attr: (number | null)[][] = [];
  for (const row of value.attr) {
    if (!Array.isArray(row)) return null;
    attr.push(row.map((item) => (typeof item === "number" ? item : null)));
  }
  if (attr.length === 0) return null;
  return { origin, center, attr };
}

/**
 * Walk to a cell. Battles on the way are fought by the local battle skill; doors and
 * other gimmicks that briefly take control are waited out.
 */
export async function walkLeg(
  pilot: Pilot,
  x: number,
  y: number,
  say: Say,
  state: MoveState = { drake: null },
): Promise<Reply> {
  let result: Reply = {};
  for (let i = 0; i < 10; i++) {
    result = await pilot.send("walk", { to: [x, y], timeout: 30000 }, 40_000);
    const pos = record(result.pos);
    if (truthy(result.ok)) return result;
    if (truthy(pos.battle) || pos.state === "Battle") {
      say(`  途中遇敌,${await regular(pilot, state.battle ?? {}, say)}`);
    } else if (pos.state === "Gimmick" || String(result.error).includes("Gimmick")) {
      await pilot.send("wait", { timeout: 30000 }, 40_000);
    } else {
      return result;
    }
  }
  return result;
}

/**
 * Cells to keep off: chests, NPCs and shop counters (RelayInteraction: talking to it
 * talks to the keeper behind), none of them in the collision data, entrances, since
 * crossing stairs or a door on the way swaps the map, and conveyor cells, which carry
 * the party away. The caller removes the goal.
 */
export async function occupiedCells(pilot: Pilot): Promise<Cell[]> {
  return (await blockingCells(pilot)).blocked;
}

/**
 * The cells plan() must walk around, and the conveyor cells among them, from one entities
 * query per kind (a query per step would be far too slow). Conveyors stay in `conveyors`
 * even when the caller later lets a goal through, so a ride can still be recognised.
 */
async function blockingCells(
  pilot: Pilot,
): Promise<{ blocked: Cell[]; conveyors: ReadonlySet<string> }> {
  const found = new Map<string, Cell>();
  const conveyors = new Set<string>();
  for (const kind of ["TresureBox", "Npc", "RelayInteraction", "GotoMap", "Event"]) {
    const reply = record((await pilot.send("entities", { kind, max: 200 })).entities);
    for (const entity of Array.isArray(reply.entities) ? reply.entities : []) {
      if (!isRecord(entity)) continue;
      const active = entity.active === undefined ? true : truthy(entity.active);
      const cell = cellOf(entity.cell);
      if (!active || cell === null) continue;
      const name = text(entity.name) ?? "";
      // Events are ordinary floor unless they are known to move the party.
      if (kind === "Event" && !isConveyorEvent(name)) continue;
      const key = cellKey(cell[0], cell[1]);
      found.set(key, cell);
      if (kind === "Event") conveyors.add(key);
    }
  }
  return { blocked: [...found.values()], conveyors };
}

interface Planned {
  readonly here: Cell | null;
  readonly path: Cell[];
  /** Conveyor cells including the goal, so a ride onto it can be recognised. */
  readonly conveyors: ReadonlySet<string>;
}

/**
 * (start cell, path including start) toward goal on the current map, or (None, []) while a
 * map is still loading. `cut`: steps (from, to) found blocked on the way.
 */
export async function plan(
  pilot: Pilot,
  goal: Cell,
  byShip: boolean,
  cut: ReadonlySet<string> = EMPTY_CUT,
): Promise<[Cell | null, Cell[]]> {
  const { here, path } = await plannedRoute(pilot, goal, byShip, cut);
  return [here, path];
}

async function plannedRoute(
  pilot: Pilot,
  goal: Cell,
  byShip: boolean,
  cut: ReadonlySet<string>,
): Promise<Planned> {
  const cells = cellGridOf((await pilot.send("cells", { r: 24 })).cells);
  if (cells === null) return { here: null, path: [], conveyors: new Set() };
  if (hasTerrain(cells)) {
    const aloft = await flying(pilot);
    const rule = terrainRule(byShip, aloft);
    // On foot or by ship, stepping on another place's entrance walks into it (10-27, twice:
    // the way from (87, 76) to the Fire-Powered Ship at (84, 79) crossed Karnak Castle's door).
    // The drake does not land by flying over one, so flying keeps every cell.
    const grid = aloft ? cells : withoutEntrances(cells, await entranceCells(pilot), goal);
    return {
      here: cells.center,
      path: pathToward(grid, goal, rule, cut),
      conveyors: new Set(),
    };
  }
  const collision = record((await pilot.send("collision")).collision);
  const { blocked, conveyors } = await blockingCells(pilot);
  const occupied = blocked.filter((cell) => !sameCell(cell, goal));
  const grid = layeredGrid(collision, occupied);
  if (grid === null) return { here: cells.center, path: [], conveyors };
  const strict = layeredPath(grid, goal, cut);
  if (endsAt(strict, goal)) return { here: grid.center, path: strict, conveyors };
  // Stairs are climbed up or down only (Carwen, 10-20), but some 「=」 cells join two parts of
  // one height and are crossed sideways (10-27, Fire-Powered Ship 261: the columns at x 8 and
  // x 17 walled off four of the room's nine exits). Only when the strict rule cannot reach the
  // goal, plan with sideways steps allowed; a step that fails is cut like any other.
  const relaxed = layeredPath(grid, goal, cut, true);
  return { here: grid.center, path: endsAt(relaxed, goal) ? relaxed : strict, conveyors };
}

function endsAt(path: readonly Cell[], goal: Cell): boolean {
  return sameCell(path[path.length - 1] ?? null, goal);
}

/** The world map's entrance cells (GotoMap) in view. */
async function entranceCells(pilot: Pilot): Promise<Cell[]> {
  const found = record((await pilot.send("entities", { kind: "GotoMap", max: 300 })).entities);
  return records(found.entities).flatMap((entity) => {
    const cell = cellOf(entity.cell);
    return cell === null ? [] : [cell];
  });
}

/** The grid with every entrance but the goal made impassable (null crosses under no rule). */
function withoutEntrances(cells: CellGrid, entrances: readonly Cell[], goal: Cell): CellGrid {
  const [x0, y0] = cells.origin;
  const closed = entrances.filter((cell) => !sameCell(cell, goal));
  if (closed.length === 0) return cells;
  const attr = cells.attr.map((row) => [...row]);
  for (const [x, y] of closed) {
    const row = attr[y - y0];
    if (row !== undefined && x - x0 >= 0 && x - x0 < row.length) row[x - x0] = null;
  }
  return { ...cells, attr };
}

/** A conveyor on the planned path or right next to it, for a party that ended up elsewhere. */
function conveyorNear(path: readonly Cell[], conveyors: ReadonlySet<string>): Cell | null {
  for (const cell of path) {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = cell[0] + dx;
      const y = cell[1] + dy;
      if (conveyors.has(cellKey(x, y))) return [x, y];
    }
  }
  return null;
}

const RIDE_MS = 8000;
const RIDE_POLL_MS = 300;

function onConveyor(value: unknown, conveyors: ReadonlySet<string>): boolean {
  const cell = cellOf(value);
  return cell !== null && conveyors.has(cellKey(cell[0], cell[1]));
}

/** Where a belt ride ends: the first still position off the belts, or the last seen. */
async function rideEnd(pilot: Pilot, conveyors: ReadonlySet<string>): Promise<Json> {
  const deadline = pilot.now() + RIDE_MS;
  let pos = record((await pilot.send("pos")).pos);
  while (pilot.now() < deadline && (truthy(pos.moving) || onConveyor(pos.cell, conveyors))) {
    await pilot.sleep(RIDE_POLL_MS);
    pos = record((await pilot.send("pos")).pos);
  }
  return pos;
}

/**
 * A walk that ended off its planned path, with a conveyor on or beside the path, was a ride:
 * say where it started and ended, and keep it in the atlas so the next look knows the way.
 */
async function afterConveyorRide(
  pilot: Pilot,
  position: unknown,
  mapId: unknown,
  path: readonly Cell[],
  conveyors: ReadonlySet<string>,
  state: MoveState,
): Promise<[false, string] | null> {
  if (conveyors.size === 0) return null;
  let pos = record(position);
  if (pos.map !== mapId) return null;
  // The walk's reply can be read as the belt starts: the party still stands on it (10-27: the
  // atlas got "在 (13, 23) 传送带 到 (13, 23)" and the tactician took it for a loop belt).
  if (onConveyor(pos.cell, conveyors)) pos = await rideEnd(pilot, conveyors);
  if (pos.map !== mapId) return null;
  const cell = cellOf(pos.cell);
  if (cell === null || path.some((cellOnPath) => sameCell(cellOnPath, cell))) return null;
  if (conveyors.has(cellKey(cell[0], cell[1]))) return null; // never got off: no way to record
  const conveyor = conveyorNear(path, conveyors);
  if (conveyor === null) return null;
  if (state.link) await state.link(mapId, conveyor, cell, "传送带");
  return [false, `踩到传送带 ${cellText(conveyor)},被带到 ${cellText(cell)}`];
}

/**
 * The game's route (bridge `route`) as cells. Its points are local pixel positions, 16 a
 * cell, y growing upwards; the first is where the player stands (`from`), which gives the
 * offset to cells.
 *
 * Each point is taken relative to the first, a whole number of cells away. Rounding each
 * point alone, as the Python version does, breaks on maps whose points sit on half cells
 * (10-27, Fire-Powered Ship 261: x 40, 24, 8, -8 rounded to 2, 2, 0, 0 and the route came out
 * as (16,18),(16,18),(14,18),(14,18), so every route there was thrown away).
 */
export function routeCells(route: Reply): Cell[] {
  const points = Array.isArray(route.cells) ? route.cells : [];
  const start = cellOf(route.from);
  const first = points.length > 0 ? cellOf(points[0]) : null;
  if (points.length === 0 || start === null || first === null) return [];
  const cells: Cell[] = [];
  for (const point of points) {
    const cell = cellOf(point);
    if (cell === null) continue;
    const next: Cell = [
      start[0] + Math.round((cell[0] - first[0]) / 16),
      start[1] - Math.round((cell[1] - first[1]) / 16),
    ];
    if (!sameCell(cells[cells.length - 1] ?? null, next)) cells.push(next);
  }
  return cells;
}

export const FLYING: ReadonlySet<string> = new Set(["LowFlying", "HighFlying", "Flying"]);

/** On the wind drake (the field's moveState reads LowFlying, 10-21). */
export async function flying(pilot: Pilot): Promise<boolean> {
  const field = record(record((await pilot.query("sample")).sample).field);
  return typeof field.moveState === "string" && FLYING.has(field.moveState);
}

/** Grass and plains; the drake does not land on forest, desert or hills. */
export const LANDABLE: ReadonlySet<number> = new Set([3, 4]);

/**
 * Where the wind drake was last left: it stays on the cell it landed on, and standing there
 * with Enter boards it again (10-21).
 */
export async function landHere(pilot: Pilot, state: MoveState): Promise<boolean> {
  await pilot.send("keys", { keys: ["Enter"], gap: 200 });
  // The landing plays out over a second or two before the move state changes (10-21).
  const deadline = pilot.now() + 4000;
  while ((await flying(pilot)) && pilot.now() < deadline) await pilot.sleep(300);
  if (await flying(pilot)) return false;
  state.drake = cellOf(record((await pilot.send("pos")).pos).cell);
  return true;
}

/** Walk back to where the drake was left and get on (Enter on its cell). */
export async function board(
  pilot: Pilot,
  state: MoveState,
  say: Say = () => undefined,
): Promise<[boolean, string]> {
  if (await flying(pilot)) return [true, "已经骑在飞龙上了"];
  const drake = state.drake;
  if (drake === null) return [false, "不知道飞龙停在哪(还没在这次运行里降落过)"];
  const [reached, message] = await navigate(pilot, drake, false, say, 8, state);
  if (!reached) return [false, `走不到飞龙那里 ${cellText(drake)}:${message}`];
  await pilot.send("keys", { keys: ["Enter"], gap: 200 });
  const deadline = pilot.now() + 4000;
  while (!(await flying(pilot)) && pilot.now() < deadline) await pilot.sleep(300);
  return (await flying(pilot))
    ? [true, `骑上了飞龙,在 ${cellText(drake)}`]
    : [false, "按了确认没骑上"];
}

/**
 * Bring the wind drake down and step off. It lands on grass and plains only (10-21: it
 * would not land on the forest by Walse's gate, and the player never learned where it
 * could), so when the cell below will not do, fly to the nearest one that will. With `near`
 * (an entrance to walk into) only cells that connect to it on foot count, nearest by walk
 * (10-21: a landing west of Tycoon was cut off from the castle by mountains).
 */
export async function land(
  pilot: Pilot,
  state: MoveState,
  near: Cell | null = null,
  say: Say = () => undefined,
): Promise<[boolean, string]> {
  if (!(await flying(pilot))) return [false, "现在没有在飞"];
  const cells = cellGridOf((await pilot.send("cells", { r: 8 })).cells);
  let here = cells === null ? null : cells.center;
  let spots = cells === null ? [] : landingSpots(cells, near);
  if (near === null && here !== null && spots.some((spot) => sameCell(spot, here))) {
    spots = [here, ...spots.filter((spot) => !sameCell(spot, here))];
  }
  for (const spot of spots.slice(0, 4)) {
    if (!sameCell(spot, here)) {
      const [reached] = await navigate(pilot, spot, false, say, 8, state);
      if (!reached) continue;
    }
    if (await landHere(pilot, state)) {
      const pos = record((await pilot.send("pos")).pos);
      return [true, `降落了,在 ${show(pos.cell)}`];
    }
    here = cellOf(record((await pilot.send("pos")).pos).cell) ?? here;
  }
  const where = near === null ? "" : `能走到 ${cellText(near)} 的`;
  return [false, `附近 8 格内找不到${where}平原或草地可以降落,飞到开阔的平地上再试`];
}

/**
 * Grass and plains in view: those connected on foot to `near`, nearest by walk first, or
 * all of them nearest to the player first.
 */
export function landingSpots(cells: CellGrid, near: Cell | null): Cell[] {
  const [x0, y0] = cells.origin;
  const openGround = new Map<string, Cell>();
  for (let j = 0; j < cells.attr.length; j++) {
    const row = cells.attr[j] ?? [];
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (value !== null && value !== undefined && LANDABLE.has(value)) {
        const cell: Cell = [x0 + i, y0 + j];
        openGround.set(cellKey(cell[0], cell[1]), cell);
      }
    }
  }
  if (near === null) {
    const here = cells.center;
    return [...openGround.values()].sort(
      (a, b) =>
        Math.abs(a[0] - here[0]) +
        Math.abs(a[1] - here[1]) -
        (Math.abs(b[0] - here[0]) + Math.abs(b[1] - here[1])),
    );
  }
  // Breadth-first from the entrance on foot: the order of the search is the walking distance
  // (the predecessor map's keys are in visit order, like the Python dict).
  const walked = search({ ...cells, center: near }, [-1, -1], terrainRule(false));
  return [...walked.keys()].flatMap((key) => {
    const cell = openGround.get(key);
    return cell ? [cell] : [];
  });
}

/**
 * On the drake, to a town or dungeon entrance: fly near it, land on the closest open
 * ground, and walk in (the drake cannot enter; flying onto the entrance does nothing).
 */
export async function flyIn(
  pilot: Pilot,
  state: MoveState,
  goal: Cell,
  say: Say = () => undefined,
): Promise<[boolean, string]> {
  await navigate(pilot, goal, false, say, 8, state); // flying: the view then centres on the entrance
  const [ok, message] = await land(pilot, state, goal, say);
  if (!ok) return [false, message];
  say(`  ${message},走过去`);
  return navigate(pilot, goal, false, say, 8, state);
}

export async function onWorldMap(pilot: Pilot): Promise<boolean> {
  const cells = cellGridOf((await pilot.send("cells", { r: 2 })).cells);
  return cells !== null && hasTerrain(cells);
}

/**
 * The game's own route to goal, or [] when it has none. It knows stairs inside a map,
 * which the collision grid shows as walls (10-20, the Ship Graveyard's map 215).
 */
export async function gameRoute(pilot: Pilot, goal: Cell): Promise<Cell[]> {
  const route = record(
    (await pilot.send("route", { to: [goal[0], goal[1]], collision: true })).route,
  );
  // Only the collision-aware search counts: when it finds nothing, the bridge falls back to
  // SearchSimple, a straight line through walls (10-27, 261: tries {"theirs": 0, "used":
  // "simple"}, and the party walked into the same walls for dozens of steps).
  const used = text(record(route.tries).used) ?? "theirs";
  if (!used.startsWith("theirs")) return [];
  const path = routeCells(route);
  const last = path[path.length - 1] ?? null;
  if (path.length < 2 || last === null) return [];
  if (sameCell(last, goal)) return path;
  // The search stops beside a cell it cannot stand on, such as an exit: one more step.
  const beside = Math.abs(last[0] - goal[0]) + Math.abs(last[1] - goal[1]) === 1;
  return beside ? [...path, goal] : [];
}

/** How long an arrival is watched for the map change an entrance makes (10-27). */
export const SETTLE_MS = 1500;
export const SETTLE_POLL_MS = 250;

/**
 * Standing on the goal does not mean staying on the map: an entrance or stairs swaps the map a
 * moment after the last step, and the position read right after the step still shows the old
 * map (10-27, Fire-Powered Ship 258 -> 255: "到达 (4, 8)", and the player walked to (4, 8)
 * again on the new map). Watch the map briefly before calling it an arrival. Not in the Python
 * version, which has the same race.
 */
async function enteredAfterArriving(
  pilot: Pilot,
  startMap: unknown,
): Promise<[boolean, string] | null> {
  const deadline = pilot.now() + SETTLE_MS;
  while (pilot.now() < deadline) {
    await pilot.sleep(SETTLE_POLL_MS);
    const pos = record((await pilot.send("pos")).pos);
    if (pos.map !== startMap) {
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      const now = record((await pilot.send("pos")).pos);
      return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
    }
  }
  return null;
}

/**
 * Route to goal and walk it, replanning when something gets in the way. World maps use
 * the terrain codes; towns and dungeons use the map's collision grid (bridge 0.2.5+).
 * Returns (reached, message).
 */
export async function navigate(
  pilot: Pilot,
  goal: Cell,
  byShip: boolean,
  say: Say = () => undefined,
  legs = 8,
  state: MoveState = { drake: null },
): Promise<[boolean, string]> {
  const how = byShip ? "船" : "步行";
  const startMap = record((await pilot.send("pos")).pos).map;
  // Steps that turned out blocked though the map data says open (a closed gate, an object
  // the collision data lacks, a side a cell cannot be entered from): the next plan goes
  // around that step instead of into it again; the cell stays usable from other sides.
  const cut = new Set<string>();
  for (let leg = 0; leg < legs; leg++) {
    const pos = record((await pilot.send("pos")).pos);
    if (pos.map !== startMap) {
      // Walked onto an entrance or stairs: the goal's coordinates belonged to the old map.
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      const now = record((await pilot.send("pos")).pos);
      return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
    }
    const planned = await plannedRoute(pilot, goal, byShip, cut);
    const [here, initial] = [planned.here, planned.path];
    if (here === null) {
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      continue;
    }
    if (sameCell(here, goal)) {
      const entered = await enteredAfterArriving(pilot, startMap);
      return entered ?? [true, `到达 ${cellText(goal)}`];
    }
    let path = initial;
    if (!byShip && !(await onWorldMap(pilot))) {
      // Indoors the game's own search comes first: it knows heights, stairs and which
      // side a cell can be entered from (control plan §4.9). Ours is the fallback, and
      // also when the game's route takes a step that already failed or crosses a conveyor.
      const theirs = await gameRoute(pilot, goal);
      const steps = new Set<string>();
      for (let i = 1; i < theirs.length; i++) {
        const before = theirs[i - 1];
        const after = theirs[i];
        if (before && after) steps.add(edgeKey(before, after));
      }
      const crossesConveyor = theirs.some(
        (cell) => !sameCell(cell, goal) && planned.conveyors.has(cellKey(cell[0], cell[1])),
      );
      if (
        theirs.length > 0 &&
        sameCell(theirs[0] ?? null, here) &&
        !crossesConveyor &&
        ![...steps].some((step) => cut.has(step))
      ) {
        path = theirs;
      }
    }
    if (path.length < 2) {
      return [false, `在 ${cellText(here)} ${how}走不过去,这里已是离 ${cellText(goal)} 最近的地方`];
    }
    say(`  ${cellText(here)} → ${cellText(path[path.length - 1] ?? null)}:${path.length - 1} 格`);
    for (const [x, y] of corners(path)) {
      const result = await walkLeg(pilot, x, y, say, state);
      const ride = await afterConveyorRide(
        pilot,
        result.pos,
        startMap,
        path,
        planned.conveyors,
        state,
      );
      if (ride) return ride;
      if (truthy(result.ok)) continue;
      const current = record(result.pos);
      // Stepping onto an entrance swaps the map: that is arriving, not failing.
      if (
        current.state === "ChangeMap" ||
        current.state === "FieldReady" ||
        String(result.error).includes("ChangeMap")
      ) {
        await pilot.send("wait", { timeout: 30000 }, 40_000);
        const now = record((await pilot.send("pos")).pos);
        return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
      }
      if (result.error === "blocked") {
        const stuck = cellOf(current.cell);
        const at = stuck === null ? -1 : path.findIndex((cell) => sameCell(cell, stuck));
        const ahead = at >= 0 && at < path.length - 1 ? path[at + 1] : undefined;
        if (stuck !== null && ahead !== undefined) cut.add(edgeKey(stuck, ahead));
        say(
          `  在 ${show(current.cell)} 被挡住` +
            (ahead === undefined ? "" : `(到 ${cellText(ahead)} 这一步走不过去)`),
        );
        break;
      }
      return [false, `停在 ${show(current.cell)}:${show(result.error)}`];
    }
    // A goal beyond the planning window: this leg ended at the nearest cell in view, and
    // the next plan, from there, sees further. One that gets no closer stops above.
  }
  return [false, `走了 ${legs} 段还没到 ${cellText(goal)}`];
}

const FACING: readonly (readonly [number, number, string])[] = [
  [0, -1, "Up"],
  [0, 1, "Down"],
  [-1, 0, "Left"],
  [1, 0, "Right"],
];

/**
 * Stand next to a chest, NPC or object, face it, press Enter and page the dialog.
 * Shopkeepers and innkeepers stand behind a counter: when no neighbouring cell can be
 * reached, talk across one cell from two cells away, the way the games allow.
 *
 * A counter is marked by a RelayInteraction cell in front of the clerk; talking works only
 * through it, so a spot on the far side of a relay comes first (10-27, Karnak's item shop:
 * the cell behind the clerk was reachable, the player talked from there, and no shop opened).
 * When a spot turns out unreachable on the way, the next one is tried, up to three.
 */
export async function openAt(
  pilot: Pilot,
  target: Cell,
  say: Say = () => undefined,
  state: MoveState = { drake: null },
): Promise<string> {
  const [here] = await plan(pilot, target, false);
  if (here === null) return "地图还在切换,稍后再试";
  // plan() lets its goal through; a spot must not be an occupied cell.
  const taken = (await occupiedCells(pilot)).filter((cell) => !sameCell(cell, here));
  const relays = await relaysBeside(pilot, target);
  const candidates: { spot: Cell; path: Cell[]; direction: string; rank: number }[] = [];
  for (const [rank, distance] of [
    [0, 2],
    [1, 1],
    [2, 2],
  ] as const) {
    for (const [dx, dy, direction] of FACING) {
      const spot: Cell = [target[0] - dx * distance, target[1] - dy * distance];
      // Rank 0 is across a counter: the relay sits between the spot and the target.
      const across = relays.some((relay) => sameCell(relay, [target[0] - dx, target[1] - dy]));
      if (across !== (rank === 0)) continue;
      if (taken.some((cell) => sameCell(cell, spot))) continue;
      if (candidates.some((candidate) => sameCell(candidate.spot, spot))) continue;
      const [, path] = await plan(pilot, spot, false);
      const reachable =
        sameCell(spot, here) || (path.length > 0 && sameCell(path[path.length - 1] ?? null, spot));
      if (reachable) candidates.push({ spot, path, direction, rank });
    }
  }
  if (candidates.length === 0) return `${cellText(target)} 四周两格内都走不到`;
  candidates.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
  let failure = "";
  for (const best of candidates.slice(0, 3)) {
    const spot = best.spot;
    if (!sameCell(spot, here)) {
      const [reached, message] = await navigate(pilot, spot, false, say, 8, state);
      if (!reached) {
        failure = `走不到 ${cellText(target)} 旁边:${message}`;
        continue;
      }
    }
    const result = await pilot.send("keys", { keys: [`${best.direction}:60`, "Enter"], gap: 250 });
    if (!truthy(result.ok)) return `没按成:${show(result.error)}`;
    const story = await pilot.send("story", { pageMs: 2500, timeout: 600000 }, 620_000);
    const via = best.rank === 0 ? "隔着柜台" : "";
    return `站在 ${cellText(spot)} ${via}面朝${best.direction}按了确认,之后翻了 ${show(story.pages)} 页对话`;
  }
  return failure;
}

/** RelayInteraction cells next to `target`: the counter a clerk is talked to through. */
async function relaysBeside(pilot: Pilot, target: Cell): Promise<Cell[]> {
  const found = record(
    (await pilot.send("entities", { kind: "RelayInteraction", max: 60 })).entities,
  );
  return records(found.entities).flatMap((entity) => {
    const cell = cellOf(entity.cell);
    if (cell === null) return [];
    const beside = Math.abs(cell[0] - target[0]) + Math.abs(cell[1] - target[1]) === 1;
    return beside ? [cell] : [];
  });
}

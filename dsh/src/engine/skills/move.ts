/**
 * Walking: one whole route per bridge command (0.14.0's walkpath), planned here, re-planned
 * when blocked; closed-loop legs on older bridges; and stepping up to a chest, NPC or counter
 * to interact with it. Ported from ffpr_agent/skills/move.py.
 */

import type { Pilot, Reply } from "../pilot.ts";
import {
  cellKey,
  corners,
  edgeKey,
  hasTerrain,
  layeredGrid,
  layeredRoute,
  pathToward,
  search,
  terrainRule,
} from "../nav.ts";
import type { Cell, CellGrid, CellRule, LayerChange, LayerNode, ObservedMove } from "../nav.ts";
import { isRecord, num, record, records, text, truthy, type Json } from "../values.ts";
import { eventBaseName, fallMoves } from "../view.ts";
import {
  beginWalk,
  finishWalk,
  indoorBase,
  updateWalk,
  updateWalkFromReply,
  worldBase,
  type WalkBase,
  type WalkView,
} from "../walk-view.ts";
import {
  MAX_WORLD_WINDOWS,
  WORLD_RADIUS,
  createWorldCache,
  hasAt,
  mergeWindow,
  windowCenters,
  worldGrid,
} from "../world-grid.ts";
import type { WorldCache } from "../world-grid.ts";
import type { BattleHooks } from "./battle.ts";
import { regular } from "./battle.ts";
import { FIELD_HELP_STUCK, dismissFieldHelp } from "./screens.ts";

type Say = (line: string) => void;

/**
 * The wind drake's state, once a module variable in Python: where it was last left, and the
 * battle hooks passed on to fights met on the way (the Game holds both).
 */
export interface MoveState {
  drake: Cell | null;
  /** The game key (ffN), for the walk view the dsh page reads (task 61). */
  game?: string;
  /** What this walk is for, set by the Game's tool handler; `walkpath` sends it. */
  label?: string;
  /** Which map hop is walking (travel.ts), appended to the label as "第 k 跳". */
  hop?: number;
  /** The current walk view, one per game (task 61). */
  walk?: WalkView | null;
  battle?: BattleHooks;
  /** Save slot a wipe loads during a walk; the Game sets it from its config. */
  saveSlot?: number;
  /** 11-05: battles met while walking run first; set by go/explore. */
  flee?: boolean;
  /** Task 58: the bridge walkpath's base timeout, blocked wait and turn lead (Config). */
  walkpathTimeoutMs?: number;
  walkpathBlockedMs?: number;
  walkpathTurnLead?: number;
  /** Task 63: how often and how long a walkpath's Event/dialog stop is watched for battle. */
  walkpathEventPollMs?: number;
  walkpathEventWaitMs?: number;
  /** Records a way found or refused while walking in the atlas; the Game wires it in. */
  link?: (
    mapId: unknown,
    from: Cell,
    to: Cell,
    how: string,
    detail?: { kind?: string; toLayer?: number },
  ) => Promise<void>;
  /**
   * Steps found blocked in the game, keyed by map (the bridge map id), then edgeKey. Kept for
   * the whole run so the next walk on that map does not hit the same wall again (11-03,
   * Fire-Powered Ship 261: the same (8,22)→(7,22) step was walked into twice).
   */
  cuts?: Map<string, Set<string>>;
  /** Ways seen earlier on a map (conveyors, falls, layer changes), for the next plan. */
  moves?: (mapId: unknown) => readonly ObservedMove[];
  /**
   * World-map terrain read through bridge 0.14.0's `cells.at`, by map id. Memory only and one
   * per game's MoveState; the story can change terrain, so every plan rereads the player's
   * window over it (task 56).
   */
  world?: WorldCache;
}

const EMPTY_CUT: ReadonlySet<string> = new Set<string>();

// Task 58: these are the defaults; Config carries the live values on MoveState.
export const WALKPATH_TIMEOUT_MS = 60_000;
export const WALKPATH_BLOCKED_MS = 800;
export const WALKPATH_TURN_LEAD = 0.6;
// Task 63: an encounter starts on a MainState=Event frame before the battle is up (11-08).
export const WALKPATH_EVENT_POLL_MS = 200;
export const WALKPATH_EVENT_WAIT_MS = 2_500;
/** The link waits for the bridge's walk plus this margin; the bridge's own timeout is smaller. */
export const WALKPATH_WAIT_MS = WALKPATH_TIMEOUT_MS + 5_000;

/**
 * A whole-map route on the world map can run past 100 cells; a fixed 60 s would end such a walk
 * with "timeout" and stop the call (11-05 review). One second a cell, between the configured
 * base and the bridge's 300 s cap.
 */
export function walkpathTimeout(cells: number, state?: MoveState): number {
  const base = state?.walkpathTimeoutMs ?? WALKPATH_TIMEOUT_MS;
  return Math.min(300_000, Math.max(base, cells * 1_000));
}

/** The label `walkpath` and a walk push carry: the tool's base plus the current hop. */
export function walkLabel(state?: MoveState): string {
  const base = state?.label ?? "";
  if (base === "") return "";
  const hop = state?.hop;
  return (hop === undefined ? base : `${base} 第 ${hop} 跳`).slice(0, 80);
}

/** Task 58: Config's values for the bridge walkpath, defaulting like before. */
export function walkpathBlockedMs(state?: MoveState): number {
  return state?.walkpathBlockedMs ?? WALKPATH_BLOCKED_MS;
}

export function walkpathTurnLead(state?: MoveState): number {
  return state?.walkpathTurnLead ?? WALKPATH_TURN_LEAD;
}

export function walkpathEventPollMs(state?: MoveState): number {
  return state?.walkpathEventPollMs ?? WALKPATH_EVENT_POLL_MS;
}

export function walkpathEventWaitMs(state?: MoveState): number {
  return state?.walkpathEventWaitMs ?? WALKPATH_EVENT_WAIT_MS;
}
/** A whole navigate call's loop cap; battles do not count against `legs`, so this bounds them. */
const MAX_WALK_TURNS = 200;

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

/** A bridge map id as a number, for the walk view; null when it cannot be read. */
function mapNumber(value: unknown): number | null {
  const map = num(value);
  return map === undefined ? null : Math.trunc(map);
}

function sameCell(a: Cell | null, b: Cell | null): boolean {
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1];
}

function adjacent(a: Cell, b: Cell): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

/**
 * The game's route given only at its turns, filled in cell by cell. Two consecutive points
 * that are neither on one row nor in one column are not a corner pair at all (a diagonal jump
 * or a broken route), so the caller uses its own plan instead (task 56).
 */
export function expandCorners(route: readonly Cell[]): Cell[] | null {
  const out: Cell[] = [];
  for (const cell of route) {
    const before = out[out.length - 1];
    if (before === undefined || sameCell(before, cell)) {
      out.push(cell);
      continue;
    }
    const dx = cell[0] - before[0];
    const dy = cell[1] - before[1];
    if (dx !== 0 && dy !== 0) return null;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    for (let i = 1; i <= Math.abs(dx) + Math.abs(dy); i++) {
      out.push([before[0] + stepX * i, before[1] + stepY * i]);
    }
  }
  return out;
}

/**
 * The part of a planned route walkpath can walk: every cell is four-way adjacent. Our search
 * gives every cell except where a conveyor, fall or other move carries the party: that step is
 * a jump, so the command stops on the cell before it and the next plan starts from wherever the
 * game put the party (task 56).
 */
export function walkPathCells(route: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of route) {
    const before = out[out.length - 1];
    if (before === undefined || sameCell(before, cell)) {
      out.push(cell);
      continue;
    }
    if (adjacent(before, cell)) {
      out.push(cell);
      continue;
    }
    // A planned route is cell by cell except where a move carries the party; any gap is that
    // jump, even along one row or column, so the command stops on the cell before it.
    break;
  }
  return out;
}

/** The blocked steps already found on this map, created on first use. */
function cutsFor(state: MoveState, map: unknown): Set<string> {
  state.cuts ??= new Map();
  const key = show(map);
  let cut = state.cuts.get(key);
  if (cut === undefined) {
    cut = new Set();
    state.cuts.set(key, cut);
  }
  return cut;
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
      const battle = await regular(pilot, state.battle ?? {}, say, state.saveSlot, {
        flee: state.flee === true,
      });
      say(`  途中遇敌,${battle}`);
    } else if (pos.state === "FieldHelp") {
      // First visit to a map: the walk stops on the hint overlay. Close it and walk on.
      const help = await dismissFieldHelp(pilot);
      if (help === "stuck") return { ok: false, error: FIELD_HELP_STUCK, pos };
      if (help === "closed") say("  关掉了操作提示");
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
 *
 * `withTransitions` also asks for ToLayer cells, which are walkable but change the height
 * (11-03, Fire-Powered Ship 261: the game has four at the vent, (15,19), (16,19), (15,20)
 * and (16,20); the collision codes there are plain floor, so only the entities tell).
 */
async function blockingCells(
  pilot: Pilot,
  withTransitions = false,
): Promise<{
  blocked: Cell[];
  conveyors: ReadonlySet<string>;
  transitions: LayerChange[];
  falls: Cell[];
  holeMoves: ObservedMove[];
}> {
  const found = new Map<string, Cell>();
  const conveyors = new Set<string>();
  const transitions = new Map<string, LayerChange>();
  const falls = new Map<string, Cell>();
  let holeMoves: ObservedMove[] = [];
  const kinds = ["TresureBox", "Npc", "RelayInteraction", "GotoMap", "Event"];
  if (withTransitions) kinds.push("ToLayer", "PointIn");
  for (const kind of kinds) {
    const reply = record((await pilot.send("entities", { kind, max: 200 })).entities);
    for (const entity of Array.isArray(reply.entities) ? reply.entities : []) {
      if (!isRecord(entity)) continue;
      const active = entity.active === undefined ? true : truthy(entity.active);
      const cell = cellOf(entity.cell);
      if (!active || cell === null) continue;
      const name = text(entity.name) ?? "";
      const key = cellKey(cell[0], cell[1]);
      if (kind === "ToLayer") {
        transitions.set(key, { cell, to: targetLayer(entity) });
        continue;
      }
      // PointIn cells are arrival points, not obstacles; the named ones are landing spots
      // where a fall or a script puts the party (11-03, Fire-Powered Ship 261).
      if (kind === "PointIn") {
        if (name.includes("落下点")) falls.set(key, cell);
        continue;
      }
      // Events are ordinary floor unless they are known to move the party.
      if (kind === "Event" && !isConveyorEvent(name)) continue;
      found.set(key, cell);
      if (kind === "Event") conveyors.add(key);
    }
  }
  if (withTransitions) {
    const all = record((await pilot.send("entities", { kind: "All", max: 400 })).entities);
    holeMoves = fallMoves(records(all.entities));
  }
  return {
    blocked: [...found.values()],
    conveyors,
    transitions: [...transitions.values()],
    falls: [...falls.values()],
    holeMoves,
  };
}

/** The layer a ToLayer entity puts the party on: the property's `layer` (0 bottom, 1
 * ground, 2 upper) or the `changeLayer` name (0.13.4+), null when the bridge has neither. */
function targetLayer(entity: Json): number | null {
  const raw = entity.layer ?? entity.targetLayer;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    const named = raw.toLowerCase();
    if (named.includes("upper") || named.includes("top")) return 2;
    if (named.includes("ground")) return 1;
    if (named.includes("bottom")) return 0;
  }
  return null;
}

/** Which floor the walk starts and ends on, when the map has more than one. */
interface LayerInfo {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly transitions: readonly LayerChange[];
}

interface Planned {
  readonly here: Cell | null;
  readonly path: Cell[];
  /** Conveyor cells including the goal, so a ride onto it can be recognised. */
  readonly conveyors: ReadonlySet<string>;
  /** Named 落下点 cells in view, so a fall off the path can be told apart from a walk. */
  readonly falls: ReadonlySet<string>;
  /** Set on a multi-floor map (11-03, Fire-Powered Ship 261); undefined on one floor. */
  readonly layer?: LayerInfo;
  /** The grid this plan searched, for the walk view's cropped rows (task 61). */
  readonly base?: WalkBase;
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
  state?: MoveState,
  map?: unknown,
): Promise<[Cell | null, Cell[]]> {
  const { here, path } = await plannedRoute(pilot, goal, byShip, cut, state, map);
  return [here, path];
}

/**
 * The world map's known terrain, extended toward goal while the plan cannot reach it (task 56).
 * The first window is always the player's own, read over the cache so a story change is seen.
 * Extra windows need bridge 0.14.0's `at`; without it the old one-window behaviour stays.
 * At most MAX_WORLD_WINDOWS windows are read in one plan.
 */
async function worldPlanGrid(
  pilot: Pilot,
  first: unknown,
  cells: CellGrid,
  goal: Cell,
  aloft: boolean,
  rule: CellRule,
  entrances: readonly Cell[],
  cut: ReadonlySet<string>,
  state: MoveState | undefined,
  map: unknown,
): Promise<CellGrid> {
  const firstWindow = (): CellGrid => (aloft ? cells : withoutEntrances(cells, entrances, goal));
  if (state === undefined || map === undefined) return firstWindow();
  const cache = (state.world ??= createWorldCache());
  if (hasAt(first)) cache.at = true;
  const terrain = mergeWindow(cache, map, cells);
  const merged = (): CellGrid => {
    const grid = cache.at === true ? worldGrid(terrain, cells.center) : cells;
    return aloft ? grid : withoutEntrances(grid, entrances, goal);
  };
  let grid = merged();
  let path = pathToward(grid, goal, rule, cut);
  if (cache.at === false || sameCell(path[path.length - 1] ?? null, goal)) return grid;
  let reads = 1;
  const centers = windowCenters(terrain, cells.center, goal, MAX_WORLD_WINDOWS - reads);
  for (const center of centers) {
    if (reads >= MAX_WORLD_WINDOWS) break;
    // An old bridge ignores `at`; the missing echo marks it once and the old way stays.
    const raw = record(
      (await pilot.send("cells", { r: WORLD_RADIUS, at: [center[0], center[1]] })).cells,
    );
    if (!hasAt(raw)) {
      cache.at = false;
      break;
    }
    cache.at = true;
    const read = cellGridOf(raw);
    if (read === null) break;
    mergeWindow(cache, map, read);
    reads += 1;
    grid = merged();
    path = pathToward(grid, goal, rule, cut);
    if (sameCell(path[path.length - 1] ?? null, goal)) break;
  }
  return grid;
}

async function plannedRoute(
  pilot: Pilot,
  goal: Cell,
  byShip: boolean,
  cut: ReadonlySet<string>,
  state?: MoveState,
  map?: unknown,
): Promise<Planned> {
  const raw = (await pilot.send("cells", { r: WORLD_RADIUS })).cells;
  const cells = cellGridOf(raw);
  if (cells === null)
    return { here: null, path: [], conveyors: new Set(), falls: new Set<string>() };
  if (hasTerrain(cells)) {
    const aloft = await flying(pilot);
    const rule = terrainRule(byShip, aloft);
    // On foot or by ship, stepping on another place's entrance walks into it (10-27, twice:
    // the way from (87, 76) to the Fire-Powered Ship at (84, 79) crossed Karnak Castle's door).
    // The drake does not land by flying over one, so flying keeps every cell.
    const entrances = aloft ? [] : await entranceCells(pilot);
    const grid = await worldPlanGrid(
      pilot,
      raw,
      cells,
      goal,
      aloft,
      rule,
      entrances,
      cut,
      state,
      map,
    );
    return {
      here: cells.center,
      path: pathToward(grid, goal, rule, cut),
      conveyors: new Set(),
      falls: new Set(),
      base: worldBase(state?.game ?? "", mapNumber(map), grid),
    };
  }
  const collision = record((await pilot.send("collision")).collision);
  const floors = Array.isArray(collision.layers) ? collision.layers.length : 0;
  const { blocked, conveyors, transitions, falls, holeMoves } = await blockingCells(
    pilot,
    floors > 1,
  );
  const moves = [...(state?.moves && map !== undefined ? state.moves(map) : []), ...holeMoves];
  // A conveyor or fall whose landing we have seen is a directed edge; until then it stays
  // an occupied cell, so the party does not walk onto it blind.
  const forced = new Set(
    moves
      .filter(
        (move) =>
          move.kind === "conveyor" ||
          move.kind === "fall" ||
          move.how.includes("传送带") ||
          move.how.includes("掉下去"),
      )
      .map((move) => cellKey(move.from[0], move.from[1])),
  );
  const occupied = blocked.filter(
    (cell) => !sameCell(cell, goal) && !forced.has(cellKey(cell[0], cell[1])),
  );
  const grid = layeredGrid(collision, occupied, transitions, moves);
  if (grid === null) {
    return {
      here: cells.center,
      path: [],
      conveyors,
      falls: new Set(falls.map((cell) => cellKey(cell[0], cell[1]))),
    };
  }
  // 3/5 are directional walls, not a rule to relax: a route that crosses their walled side
  // is one the game refuses (11-03, Fire-Powered Ship 261). The old sideways-stairs fallback
  // is gone; the game's own route is still tried first in navigate().
  const route = layeredRoute(grid, goal, cut);
  return {
    here: grid.center,
    path: cellsOf(route),
    conveyors,
    falls: new Set(falls.map((cell) => cellKey(cell[0], cell[1]))),
    layer: layerInfo(grid, route, transitions),
    base: indoorBase(state?.game ?? "", mapNumber(map), grid),
  };
}

function cellsOf(route: readonly LayerNode[]): Cell[] {
  return route.map(([x, y]) => [x, y] as const);
}

function layerInfo(
  grid: { readonly z: number; readonly heights: ReadonlyMap<number, unknown> },
  route: readonly LayerNode[],
  transitions: readonly LayerChange[],
): LayerInfo | undefined {
  if (grid.heights.size < 2) return undefined;
  return {
    start: grid.z,
    end: route[route.length - 1]?.[2] ?? grid.z,
    count: grid.heights.size,
    transitions,
  };
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

/** The layer the route searcher reports right now, or null when the bridge cannot say. */
async function collisionLayer(pilot: Pilot): Promise<number | null> {
  const collision = record((await pilot.send("collision")).collision);
  const layer = collision.searchLayer;
  return typeof layer === "number" && Number.isFinite(layer) ? Math.trunc(layer) : null;
}

/** The ToLayer cell on the walked path that put the party on `layer`, else the last one. */
function transitionOnPath(
  path: readonly Cell[],
  changes: readonly LayerChange[],
  layer: number,
): Cell | null {
  let fallback: Cell | null = null;
  for (const change of changes) {
    if (!path.some((cell) => sameCell(cell, change.cell))) continue;
    fallback = change.cell;
    if (change.to === layer) return change.cell;
  }
  return fallback;
}

/**
 * What the game did to the party during a walk, beyond the planned steps: a conveyor ride, a
 * fall onto a 落下点, or a layer change. Each is kept in the atlas as a directed way, so the
 * next plan on this map can use it (11-03, Fire-Powered Ship 261).
 */
async function afterWalk(
  pilot: Pilot,
  position: unknown,
  mapId: unknown,
  planned: Planned,
  path: readonly Cell[],
  state: MoveState,
  seen: Set<string>,
): Promise<[false, string] | null> {
  let pos = record(position);
  if (pos.map !== mapId) return null;
  if (planned.conveyors.size > 0 && onConveyor(pos.cell, planned.conveyors)) {
    // The walk reply can be read as the belt starts: the party still stands on it (10-27: the
    // atlas got "在 (13, 23) 传送带 到 (13, 23)" and the tactician took it for a loop belt).
    pos = await rideEnd(pilot, planned.conveyors);
  }
  if (pos.map !== mapId) return null;
  const cell = cellOf(pos.cell);
  if (cell === null) return null;
  const onPath = path.some((cellOnPath) => sameCell(cellOnPath, cell));
  const layer = planned.layer === undefined ? null : await collisionLayer(pilot);

  if (!onPath && planned.conveyors.size > 0 && !onConveyor(pos.cell, planned.conveyors)) {
    const conveyor = conveyorNear(path, planned.conveyors);
    if (conveyor !== null) {
      const key = `conveyor:${cellKey(conveyor[0], conveyor[1])}>${cellKey(cell[0], cell[1])}`;
      if (state.link && !seen.has(key)) {
        seen.add(key);
        await state.link(mapId, conveyor, cell, "传送带", {
          kind: "conveyor",
          ...(layer === null ? {} : { toLayer: layer }),
        });
      }
      return [false, `踩到传送带 ${cellText(conveyor)},被带到 ${cellText(cell)}`];
    }
  }

  if (!onPath && planned.falls.size > 0) {
    const fall = conveyorNear(path, planned.falls);
    if (fall !== null) {
      const key = `fall:${cellKey(fall[0], fall[1])}>${cellKey(cell[0], cell[1])}`;
      if (state.link && !seen.has(key)) {
        seen.add(key);
        await state.link(mapId, fall, cell, "掉下去", {
          kind: "fall",
          ...(layer === null ? {} : { toLayer: layer }),
        });
      }
      return [false, `踩到落下点 ${cellText(fall)},掉到 ${cellText(cell)}`];
    }
  }

  if (layer !== null && planned.layer && layer !== planned.layer.start) {
    const change = transitionOnPath(path, planned.layer.transitions, layer);
    const key = `layer:${cellKey(change?.[0] ?? -1, change?.[1] ?? -1)}:${layer}`;
    if (change !== null && state.link && !seen.has(key)) {
      seen.add(key);
      await state.link(mapId, change, change, `换层到第 ${layer} 层`, {
        kind: "layer",
        toLayer: layer,
      });
    }
  }
  return null;
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
 * What a walkpath's Event/dialog stop turned out to be: `battle` once the fight is up, `clear`
 * when the party is back in Player/Transport, `event` when it is still a story stop.
 */
export type EventSettle =
  | { readonly outcome: "battle"; readonly pos: Reply }
  | { readonly outcome: "clear"; readonly pos: Reply }
  | { readonly outcome: "event"; readonly pos: Reply };

/**
 * Task 63: an encounter starts on a MainState=Event frame (11-08, bridge 0.14.1: walkpath
 * stopped at `state:Event` with battle false, and 1.5 s later the battle was up). Watch pos
 * rather than trust that first frame: a fight takes over, a short cutscene leaves the party in
 * Player/Transport, and anything still in Event or dialog is a real story stop.
 */
export async function settleWalkEvent(pilot: Pilot, state: MoveState): Promise<EventSettle> {
  const pollMs = Math.max(1, walkpathEventPollMs(state));
  const deadline = pilot.now() + Math.max(0, walkpathEventWaitMs(state));
  let pos: Reply = {};
  for (;;) {
    const left = deadline - pilot.now();
    if (left <= 0) return { outcome: "event", pos };
    await pilot.sleep(Math.min(pollMs, left));
    pos = record((await pilot.send("pos")).pos);
    if (truthy(pos.battle) || pos.state === "Battle") return { outcome: "battle", pos };
    if (!truthy(pos.dialog) && (pos.state === "Player" || pos.state === "Transport")) {
      return { outcome: "clear", pos };
    }
  }
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
  // the collision data lacks, the walled side of a 3/5 cell): the next plan goes around that
  // step instead of into it again; the cell stays usable from other sides. Kept on the map
  // in MoveState, so the next go on the same map also knows (11-03, Fire-Powered Ship
  // 261: the same step was walked into twice).
  const cut = cutsFor(state, startMap);
  const seen = new Set<string>();
  // A bridge without walkpath (0.13.x) or a LAN that cannot be reached falls back to the
  // old corner-by-corner walk for the rest of this call; the pilot remembers it across calls.
  let useWalkpath = true;
  let plans = 0;
  let turns = 0;
  // A fight met on the way does not use up one of the caller's legs; the next plan is free.
  let freePlan = false;
  const endWalk = (reason: string): void => {
    if (state.walk !== null && state.walk !== undefined) {
      state.walk = finishWalk(state.walk, reason, new Date().toISOString());
    }
  };
  for (;;) {
    if (turns >= MAX_WALK_TURNS) break;
    turns += 1;
    if (!freePlan) {
      if (plans >= legs) break;
      plans += 1;
    }
    freePlan = false;
    const pos = record((await pilot.send("pos")).pos);
    if (pos.map !== startMap) {
      // Walked onto an entrance or stairs: the goal's coordinates belonged to the old map.
      endWalk("map_changed");
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      const now = record((await pilot.send("pos")).pos);
      return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
    }
    const planned = await plannedRoute(pilot, goal, byShip, cut, state, startMap);
    const [here, initial] = [planned.here, planned.path];
    if (here === null) {
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      continue;
    }
    if (sameCell(here, goal)) {
      endWalk("arrived");
      const entered = await enteredAfterArriving(pilot, startMap);
      const floor = planned.layer
        ? `,第 ${planned.layer.end} 层(共 ${planned.layer.count} 层)`
        : "";
      return entered ?? [true, `到达 ${cellText(goal)}${floor}`];
    }
    let path = walkPathCells(initial);
    if (!byShip && !(await onWorldMap(pilot))) {
      // Indoors the game's own search comes first: it knows heights, stairs and which
      // side a cell can be entered from (control plan §4.9). Ours is the fallback, and
      // also when the game's route takes a step that already failed or crosses a conveyor.
      // 0.14.0: its points may only be the turns; fill them into cells first, and drop the
      // route when two points are diagonal (task 56).
      const theirs = expandCorners(await gameRoute(pilot, goal));
      if (theirs !== null && theirs.length > 0) {
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
          sameCell(theirs[0] ?? null, here) &&
          !crossesConveyor &&
          ![...steps].some((step) => cut.has(step))
        ) {
          path = theirs;
        }
      }
    }
    if (planned.layer) {
      const exits = planned.layer.transitions
        .slice(0, 6)
        .map((change) => {
          const where = cellText(change.cell);
          return change.to === null ? where : `${where}→第 ${change.to} 层`;
        })
        .join("、");
      say(
        `  第 ${planned.layer.start} 层(共 ${planned.layer.count} 层)` +
          (exits === "" ? "" : `,换层格 ${exits}`),
      );
    }
    if (path.length < 2) {
      endWalk("blocked");
      const floor = planned.layer
        ? `(第 ${planned.layer.start} 层,共 ${planned.layer.count} 层)`
        : "";
      return [
        false,
        `在 ${cellText(here)} ${how}走不过去${floor},这里已是离 ${cellText(goal)} 最近的地方`,
      ];
    }
    say(`  ${cellText(here)} → ${cellText(path[path.length - 1] ?? null)}:${path.length - 1} 格`);

    if (useWalkpath) {
      const timeoutMs = walkpathTimeout(path.length, state);
      const label = walkLabel(state);
      // The map view belongs to this command: a push from an earlier walk has another seq,
      // and the page would otherwise show the last route against the new one.
      if (planned.base !== undefined) {
        state.walk = beginWalk(planned.base, path, goal, label, new Date().toISOString());
      }
      let result = await pilot.send(
        "walkpath",
        {
          path: path.map((cell) => [cell[0], cell[1]]),
          goal: [goal[0], goal[1]],
          label,
          timeoutMs,
          blockedMs: walkpathBlockedMs(state),
          turnLead: walkpathTurnLead(state),
        },
        timeoutMs + 5_000,
      );
      if (text(result.error) === "walkpath_unsupported") {
        useWalkpath = false;
        // No push and no walkpath reply: the old closed-loop walk below moves the view on
        // segment by segment, so keep the plan that is about to be walked.
      } else {
        state.walk = updateWalkFromReply(state.walk ?? null, result, new Date().toISOString());
        let current = record(result.pos);
        let reason = text(result.reason) ?? (truthy(result.ok) ? "arrived" : "");
        if (reason === "state:Event" || reason === "dialog") {
          // Task 63: an encounter's opening Event frame looks like a story stop; wait to see
          // whether it turns into a battle or just a short cutscene.
          const settled = await settleWalkEvent(pilot, state);
          if (settled.outcome === "clear") continue;
          if (settled.outcome === "battle") {
            result = { ...result, reason: "battle", pos: settled.pos };
            state.walk = updateWalkFromReply(state.walk ?? null, result, new Date().toISOString());
            current = record(result.pos);
            reason = "battle";
          }
        }
        if (reason === "battle" || truthy(current.battle) || current.state === "Battle") {
          // The bridge stops on the frame a fight starts, so the keypresses cannot reach the
          // battle menu; the ordinary battle handler takes over from here.
          const battle = await regular(pilot, state.battle ?? {}, say, state.saveSlot, {
            flee: state.flee === true,
          });
          say(`  途中遇敌,${battle}`);
          const moved = await afterWalk(pilot, result.pos, startMap, planned, path, state, seen);
          if (moved) return moved;
          // Not one of the caller's legs: a long walk may meet several fights (task 56).
          freePlan = true;
          continue;
        }
        const moved = await afterWalk(pilot, result.pos, startMap, planned, path, state, seen);
        if (moved) return moved;
        if (truthy(result.ok) || reason === "arrived") {
          if (sameCell(cellOf(current.cell), goal)) {
            const entered = await enteredAfterArriving(pilot, startMap);
            const floor = planned.layer
              ? `,第 ${planned.layer.end} 层(共 ${planned.layer.count} 层)`
              : "";
            return entered ?? [true, `到达 ${cellText(goal)}${floor}`];
          }
          // The command stopped on the cell before a jump or at the window's edge: replan.
          continue;
        }
        if (reason === "state:FieldHelp" || current.state === "FieldHelp") {
          const help = await dismissFieldHelp(pilot);
          if (help === "stuck") return [false, FIELD_HELP_STUCK];
          if (help === "closed") say("  关掉了操作提示");
          continue;
        }
        if (
          reason === "state:Gimmick" ||
          current.state === "Gimmick" ||
          String(result.error).includes("Gimmick")
        ) {
          // The bridge already waited 5 s for the door; one more wait then replan.
          await pilot.send("wait", { timeout: 30000 }, 40_000);
          continue;
        }
        if (
          reason === "map_changed" ||
          reason === "state:ChangeMap" ||
          reason === "state:FieldReady" ||
          current.state === "ChangeMap" ||
          current.state === "FieldReady" ||
          String(result.error).includes("ChangeMap")
        ) {
          await pilot.send("wait", { timeout: 30000 }, 40_000);
          const now = record((await pilot.send("pos")).pos);
          return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
        }
        if (reason === "blocked") {
          const index =
            typeof result.index === "number" && Number.isFinite(result.index)
              ? Math.trunc(result.index)
              : -1;
          const stuck =
            index >= 0 && index < path.length
              ? (path[index] ?? cellOf(current.cell))
              : cellOf(current.cell);
          const ahead = cellOf(result.next) ?? (index >= 0 ? path[index + 1] : undefined);
          if (stuck !== null && ahead !== undefined) {
            cut.add(edgeKey(stuck, ahead));
            if (state.link) await state.link(startMap, stuck, ahead, "走不过去");
          }
          say(
            `  在 ${show(current.cell)} 被挡住` +
              (ahead === undefined ? "" : `(到 ${cellText(ahead)} 这一步走不过去)`),
          );
          continue;
        }
        if (reason === "off_path") continue;
        if (reason === "dialog" || reason.startsWith("state:")) {
          return [
            false,
            `停在 ${show(current.cell)}:${show(`interrupted:${reason || "walkpath"}`)}`,
          ];
        }
        return [false, `停在 ${show(current.cell)}:${show(reason === "" ? result.error : reason)}`];
      }
    }

    // The old way, kept for bridge 0.13.x and a LAN that is down: one closed-loop walk per
    // turn of the route. Battles inside walkLeg do not use a leg either.
    for (const [x, y] of corners(path)) {
      const result = await walkLeg(pilot, x, y, say, state);
      const reached = cellOf(record(result.pos).cell);
      if (state.walk !== null && state.walk !== undefined && reached !== null) {
        const index = path.findIndex((cell) => sameCell(cell, reached));
        state.walk = updateWalk(state.walk, {
          ...(index < 0 ? {} : { index }),
          cell: reached,
          steps: Math.max(0, path.length - 1),
        });
      }
      const moved = await afterWalk(pilot, result.pos, startMap, planned, path, state, seen);
      if (moved) {
        endWalk("stopped");
        return moved;
      }
      if (truthy(result.ok)) continue;
      const current = record(result.pos);
      // Stepping onto an entrance swaps the map: that is arriving, not failing.
      if (
        current.state === "ChangeMap" ||
        current.state === "FieldReady" ||
        String(result.error).includes("ChangeMap")
      ) {
        endWalk("map_changed");
        await pilot.send("wait", { timeout: 30000 }, 40_000);
        const now = record((await pilot.send("pos")).pos);
        return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
      }
      if (result.error === "blocked") {
        const stuck = cellOf(current.cell);
        const at = stuck === null ? -1 : path.findIndex((cell) => sameCell(cell, stuck));
        const ahead = at >= 0 && at < path.length - 1 ? path[at + 1] : undefined;
        if (stuck !== null && ahead !== undefined) {
          cut.add(edgeKey(stuck, ahead));
          if (state.link) await state.link(startMap, stuck, ahead, "走不过去");
        }
        say(
          `  在 ${show(current.cell)} 被挡住` +
            (ahead === undefined ? "" : `(到 ${cellText(ahead)} 这一步走不过去)`),
        );
        endWalk("blocked");
        break;
      }
      endWalk("stopped");
      return [false, `停在 ${show(current.cell)}:${show(result.error)}`];
    }
    endWalk("arrived");
    // A goal beyond the planning window: this leg ended at the nearest cell in view, and
    // the next plan, from there, sees further. One that gets no closer stops above.
  }
  if (turns >= MAX_WALK_TURNS) {
    endWalk("timeout");
    return [false, `走了 ${turns} 次还没到 ${cellText(goal)}`];
  }
  endWalk("stopped");
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
  // A first-visit FieldHelp would swallow the Enter meant for the chest or clerk.
  const firstHelp = await dismissFieldHelp(pilot);
  if (firstHelp === "stuck") return FIELD_HELP_STUCK;
  let helpNote = firstHelp === "closed" ? "关掉了操作提示\n" : "";
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
    const help = await dismissFieldHelp(pilot);
    if (help === "stuck") return FIELD_HELP_STUCK;
    if (help === "closed") helpNote = "关掉了操作提示\n";
    const result = await pilot.send("keys", { keys: [`${best.direction}:60`, "Enter"], gap: 250 });
    if (!truthy(result.ok)) return `没按成:${show(result.error)}`;
    const story = await pilot.send("story", { pageMs: 2500, timeout: 600000 }, 620_000);
    const via = best.rank === 0 ? "隔着柜台" : "";
    return (
      helpNote +
      `站在 ${cellText(spot)} ${via}面朝${best.direction}按了确认,` +
      `之后翻了 ${show(story.pages)} 页对话`
    );
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

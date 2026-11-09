/**
 * Moving between maps (task 48): the atlas's map exits as a graph, so a route over maps is
 * planned in code instead of the model remembering a fifteen-map maze (10-27, the
 * Fire-Powered Ship). Extracted from `grind.ts`'s private `mapPath`/`travelToMap`.
 *
 * `travelToMap` walks a whole route for the `go` tool, checking task 45's `guardLeave` on every
 * map it leaves.
 * `explore` finds the nearest exit whose destination this save has not visited yet, walking
 * inside the current map first and travelling to another map only when this one has none.
 * The world map is an ordinary hop (task 57): walking or the wind drake; a ship or chocobo
 * stops the route because it cannot enter a town.
 */

import type { Atlas, Ride } from "../atlas.ts";
import type { Cell } from "../nav.ts";
import type { Pilot } from "../pilot.ts";
import { isRecord, num, record, records, text, type Json } from "../values.ts";
import { RegionIndex, type CollisionStore, type RegionBlock } from "../regions.ts";
import { RIDES } from "../view.ts";
import {
  canReach,
  flyIn,
  flying,
  landingCells,
  navigate,
  plan,
  rideAt,
  type Landing,
  type MoveState,
} from "./move.ts";

type Say = (line: string) => void;

/** The world map's map id in the atlas and in the bridge's position reply (atlas `mark`). */
const WORLD_MAP = 1;
/** A route longer than this is not a maze any more; stop and report instead. */
export const DEFAULT_TRAVEL_MAX_HOPS = 12;
/** One map-travel call's wall-clock budget; grind has its own max_minutes and passes Infinity. */
export const DEFAULT_TRAVEL_MAX_MINUTES = 10;

export interface TravelLimits {
  readonly maxHops: number;
  readonly maxMinutes: number;
}

export interface TravelContext {
  readonly atlas: Atlas;
  readonly moveState: MoveState;
  readonly limits?: Partial<TravelLimits>;
  readonly say?: Say;
  /** Task 75: cached collision regions, written by the Game on each indoor map entry. */
  readonly collisions?: CollisionStore;
}

/** What `guardLeave` says when a map must not be left; text is handed to the model verbatim. */
export interface LeaveRefusal {
  readonly text: string;
  readonly early?: boolean;
}

export interface TravelOptions {
  /** Task 45's leave check. `origin` is true on the map the call starts from. */
  readonly guard?: (pilot: Pilot, goal: Cell, origin: boolean) => Promise<LeaveRefusal | null>;
  readonly maxHops?: number;
  readonly maxMinutes?: number;
}

export interface TravelHop {
  readonly from: number;
  /** Where the atlas said this exit or ride leads. */
  readonly to: number;
  /** Where the game actually put the party (an elevator may have changed). */
  readonly actual: number;
  readonly cell: Cell;
  /** "exit" for a walked exit, "ride" for a lift (task 71). */
  readonly kind: "exit" | "ride";
  /** The direction pressed on a ride (absent for an exit). */
  readonly dir?: string;
  /** The interact target on a ride (absent for an exit). */
  readonly press?: Cell;
  readonly changed: boolean;
}

export interface TravelResult {
  readonly reached: boolean;
  readonly mapId: number | null;
  readonly cell: Cell | null;
  readonly hops: readonly TravelHop[];
  /** Exits that did not work in this call, one line each. */
  readonly blocked: readonly string[];
  readonly stop: string;
  /** One line for grind's report: why it stopped or that it arrived. */
  readonly detail: string;
  readonly text: string;
}

export interface MapExit {
  readonly cell: Cell;
  readonly to: number;
  readonly name: string;
  /** Task 75: where this exit dropped the party on the destination map, when seen. */
  readonly land?: Cell;
  readonly landLayer?: number;
}

interface RawMapExit {
  readonly cell: Cell;
  readonly to: number | null;
  readonly name: string;
}

export function isWorldMap(mapId: unknown): boolean {
  return String(mapId) === String(WORLD_MAP);
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function sameCell(left: Cell | null, right: Cell | null): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
}

/** Every recorded exit, including ones whose `to` the atlas could not read. */
function rawExits(atlas: Atlas, mapId: number): RawMapExit[] {
  const entry = atlas.maps.get(String(mapId));
  return records(entry?.exits).flatMap((exit): RawMapExit[] => {
    const cell = cellOf(exit.cell);
    if (cell === null) return [];
    const to = num(exit.to);
    return [{ cell, to: to === undefined ? null : Math.trunc(to), name: text(exit.name) ?? "" }];
  });
}

/** The exits a route may use: those with a known destination. */
export function mapExits(atlas: Atlas, mapId: number): MapExit[] {
  const entry = atlas.maps.get(String(mapId));
  const savedExits = new Map<string, Json>();
  for (const exit of Array.isArray(entry?.exits) ? entry.exits : []) {
    if (!isRecord(exit)) continue;
    const cell = cellOf(exit.cell);
    const to = num(exit.to);
    if (cell !== null && to !== undefined) savedExits.set(`${cell[0]},${cell[1]}:${to}`, exit);
  }
  return rawExits(atlas, mapId).flatMap((exit) => {
    if (exit.to === null) return [];
    const saved = savedExits.get(`${exit.cell[0]},${exit.cell[1]}:${exit.to}`);
    const land = cellOf(saved?.land);
    const landLayer = num(saved?.landLayer);
    return [
      {
        cell: exit.cell,
        to: exit.to,
        name: exit.name,
        ...(land === null ? {} : { land }),
        ...(landLayer === undefined ? {} : { landLayer: Math.trunc(landLayer) }),
      },
    ];
  });
}

/** Exits whose destination this save has not visited yet (or whose `to` was never read). */
export function unknownExits(atlas: Atlas, mapId: number): RawMapExit[] {
  return rawExits(atlas, mapId).filter(
    (exit) => exit.to === null || (!isWorldMap(exit.to) && !atlas.visited(exit.to)),
  );
}

export function mapName(atlas: Atlas, mapId: number): string {
  return text(atlas.maps.get(String(mapId))?.name) ?? `地图 ${mapId}`;
}

/** A map for the result text; an unknown map has no name to quote. */
function mapLabel(atlas: Atlas, mapId: number): string {
  const name = text(atlas.maps.get(String(mapId))?.name) ?? "";
  return name === "" ? `地图 ${mapId}` : `地图 ${mapId}「${name}」`;
}

interface MapHop {
  readonly from: number;
  readonly to: number;
  readonly cell: Cell;
  readonly kind: "exit" | "ride";
  readonly dir?: string;
  readonly press?: Cell;
}

/** One exit or ride edge, without saying which region of the map it was tried from. */
function edgeKey(from: number, cell: Cell, to: number, kind: "exit" | "ride" = "exit"): string {
  return `${from}:${cell[0]},${cell[1]}:${to}:${kind}`;
}

/**
 * Task 74: an exit is only "unavailable" from the region the party tried it from. The region
 * is named by a cell in it (the actual landing), so the same exit may still be tried after
 * entering the map somewhere else. `null` (an unknown landing) never matches a key, which
 * keeps the optimistic "try it and see" for a map the route has not entered yet.
 */
function hopKey(
  from: number,
  region: Cell | null,
  cell: Cell,
  to: number,
  kind: "exit" | "ride" = "exit",
): string {
  const where = region === null ? "?" : `${region[0]},${region[1]}`;
  return `${from}@${where}:${cell[0]},${cell[1]}:${to}:${kind}`;
}

/** A landing observed on an exit edge in this call: where and on which floor (task 75). */
export interface ObservedLanding {
  readonly cell: Cell;
  readonly layer: number | null;
}

/** A map node is (map, block); null blocks means "whole map, as before task 75". */
function blocksKey(blocks: readonly RegionBlock[] | null): string {
  if (blocks === null || blocks.length === 0) return "*";
  return [...blocks]
    .map((block) => block.id)
    .sort()
    .join("|");
}

function nodeKey(mapId: number, blocks: readonly RegionBlock[] | null): string {
  return `${mapId}@${blocksKey(blocks)}`;
}

/** The blocks a landing belongs to, or null when the map has no cached region. */
function landingBlocks(
  regions: RegionIndex | undefined,
  mapId: number,
  cell: Cell | null,
  layer: number | null,
): RegionBlock[] | null {
  if (regions === undefined || cell === null) return null;
  const region = regions.region(mapId);
  if (region === undefined) return null;
  const blocks = region.blocksAt(cell, layer);
  // A landing the cached grid does not cover is treated like a missing record: keep the map
  // as one whole node and try its exits, rather than declaring the route impossible.
  return blocks.length === 0 ? null : blocks;
}

/** Whether this block of the map can walk to or ride from the cell. */
function blockReaches(
  regions: RegionIndex | undefined,
  mapId: number,
  blocks: readonly RegionBlock[] | null,
  cell: Cell,
): boolean {
  if (regions === undefined || blocks === null) return true;
  const region = regions.region(mapId);
  if (region === undefined) return true;
  return region.reachable(blocks, cell, null).ok;
}

/** The lift edges recorded on a map, as map edges a route may use (task 71). */
export function mapRides(atlas: Atlas, mapId: number): Ride[] {
  return atlas.rides(mapId);
}

/** Task 74/75: where the route is coming from, so failed exits are judged per region. */
export interface MapPathOptions {
  /** The cell the party stands on in `from`; absent or null means unknown. */
  readonly start?: Cell | null;
  /** The floor the party stands on in `from`, when the live collision reply named it. */
  readonly startLayer?: number | null;
  /** Landings observed for exit edges, keyed by edgeKey; rides carry their own `land`. */
  readonly landings?: ReadonlyMap<string, ObservedLanding>;
  /** Task 75: cached collision regions; absent keeps the plain map-to-map planner. */
  readonly regions?: RegionIndex;
}

/**
 * A route over the atlas's exits, or null. `unavailable` closes exits that failed in this
 * call, from the region named in each key (task 74). `viaWorld` lets the route treat the
 * world map as an ordinary hop (task 57); without it the world map is not used, which keeps
 * the pure map-to-map query available.
 *
 * Task 75: a node is (map, block) when the map has cached collision and the landing is known,
 * so 255's south half cannot be assumed to reach its north exits. A map without a cache, or
 * an edge whose landing was never recorded, is a single "whole map" node and behaves as
 * before: walk into it and see. A route may come back to a map it has already left when it
 * lands in another block (255's north half after 634 → 255).
 */
export function mapPath(
  atlas: Atlas,
  from: number,
  to: number,
  unavailable: ReadonlySet<string> = new Set(),
  viaWorld = false,
  options: MapPathOptions = {},
): MapHop[] | null {
  if (from === to) return [];
  if (!viaWorld && (isWorldMap(from) || isWorldMap(to))) return null;
  const regions = options.regions;
  const start = options.start ?? null;
  const startBlocks = landingBlocks(regions, from, start, options.startLayer ?? null);
  const queue: {
    readonly id: number;
    readonly path: MapHop[];
    readonly land: Cell | null;
    readonly blocks: readonly RegionBlock[] | null;
  }[] = [{ id: from, path: [], land: start, blocks: startBlocks }];
  const seen = new Set<string>([nodeKey(from, startBlocks)]);
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const region = item.land;
    for (const exit of mapExits(atlas, item.id)) {
      if (!viaWorld && isWorldMap(exit.to)) continue;
      // Task 58: the last hop may enter a map this save has never recorded.
      if (!atlas.maps.has(String(exit.to)) && exit.to !== to) continue;
      if (unavailable.has(hopKey(item.id, region, exit.cell, exit.to))) continue;
      if (!blockReaches(regions, item.id, item.blocks, exit.cell)) continue;
      const hop: MapHop = { from: item.id, to: exit.to, cell: exit.cell, kind: "exit" };
      if (exit.to === to) return [...item.path, hop];
      const observed = options.landings?.get(edgeKey(item.id, exit.cell, exit.to));
      const land = observed === undefined ? (exit.land ?? null) : observed.cell;
      const layer = observed === undefined ? (exit.landLayer ?? null) : observed.layer;
      const blocks = landingBlocks(regions, exit.to, land, layer);
      const key = nodeKey(exit.to, blocks);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ id: exit.to, path: [...item.path, hop], land, blocks });
    }
    // A lift changes the map by pressing, not by walking onto an exit (task 71). Exits are
    // tried first so a normal door still wins on an equal path.
    for (const ride of mapRides(atlas, item.id)) {
      if (!viaWorld && isWorldMap(ride.to)) continue;
      if (!atlas.maps.has(String(ride.to)) && ride.to !== to) continue;
      if (unavailable.has(hopKey(item.id, region, ride.cell, ride.to, "ride"))) continue;
      if (!blockReaches(regions, item.id, item.blocks, ride.cell)) continue;
      const hop: MapHop = {
        from: item.id,
        to: ride.to,
        cell: ride.cell,
        kind: "ride",
        dir: ride.dir,
        press: ride.press,
      };
      if (ride.to === to) return [...item.path, hop];
      const blocks = landingBlocks(regions, ride.to, ride.land, ride.landLayer ?? null);
      const key = nodeKey(ride.to, blocks);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ id: ride.to, path: [...item.path, hop], land: ride.land, blocks });
    }
  }
  return null;
}

/**
 * The layer the party is on after a map change. The live reply is also written to the collision
 * cache and replaces that map's region, so a map first entered on this trip is planned from the
 * block the party actually landed in (task 75). A test or an older bridge without the reply
 * leaves it unknown, and the block is read from any layer.
 */
async function readLandingLayer(
  pilot: Pilot,
  regions: RegionIndex,
  store: CollisionStore | undefined,
  mapId: number,
  cell: Cell,
): Promise<number | null> {
  if (store === undefined || isWorldMap(mapId)) return null;
  try {
    const collision = record((await pilot.send("collision")).collision);
    await store.remember(mapId, collision);
    return regions.setLive(mapId, collision, cell)?.layer ?? null;
  } catch {
    return null;
  }
}

/**
 * Task 75: why the (map, block) planner found no route. Says whether the map record itself is
 * disconnected, and which maps have no cached collision or whose exits were never seen to land
 * anywhere, so the model can tell "not visited yet" from "really no way".
 */
function explainNoPath(
  atlas: Atlas,
  regions: RegionIndex,
  from: number,
  start: Cell | null,
  target: number,
): string {
  const missingCache: number[] = [];
  const missingLand: string[] = [];
  for (const key of atlas.maps.keys()) {
    const id = Number(key);
    if (!Number.isFinite(id) || isWorldMap(id) || id === target) continue;
    const rides = atlas.rides(id);
    const exits = mapExits(atlas, id);
    if (exits.length === 0 && rides.length === 0) continue;
    if (!regions.has(id)) missingCache.push(id);
    for (const exit of exits) {
      if (exit.land !== undefined || !regions.has(exit.to)) continue;
      missingLand.push(`地图 ${id} (${exit.cell[0]}, ${exit.cell[1]})→地图 ${exit.to}`);
    }
  }
  const plain = mapPath(atlas, from, target, new Set(), true, { start });
  const lines: string[] = ["规划失败的原因:"];
  if (plain === null) lines.push(`  地图记录本身就没有从 ${from} 到 ${target} 的出口路线`);
  else lines.push("  地图记录本身是通的,但按 (地图, 块) 走不到;落点或碰撞缓存可能过时");
  if (missingCache.length > 0) {
    const list = missingCache
      .slice(0, 6)
      .map((id) => `地图 ${id}`)
      .join("、");
    const more = missingCache.length > 6 ? ` 等 ${missingCache.length} 张` : "";
    lines.push(`  没有碰撞缓存的图:${list}${more}(没进去过,或那次的 collision 没读到)`);
  }
  if (missingLand.length > 0) {
    const list = missingLand.slice(0, 6).join("、");
    const more = missingLand.length > 6 ? ` 等 ${missingLand.length} 个` : "";
    lines.push(`  没记过落点的出口:${list}${more}`);
  }
  if (missingCache.length === 0 && missingLand.length === 0 && plain !== null) {
    lines.push("  缓存和落点都有;先走到记过落点的入口,再从这里重新规划");
  }
  return lines.join("\n");
}

export interface TravelPosition {
  readonly map: number | null;
  readonly cell: Cell | null;
  readonly state: string;
}

async function readPosition(pilot: Pilot): Promise<TravelPosition> {
  const row = record((await pilot.send("pos")).pos);
  const map = num(row.map);
  return {
    map: map === undefined ? null : Math.trunc(map),
    cell: cellOf(row.cell),
    state: text(row.state) ?? "",
  };
}

export async function currentMapAndCell(pilot: Pilot): Promise<[number | null, Cell | null]> {
  const position = await readPosition(pilot);
  return [position.map, position.cell];
}

export async function travelToCell(
  pilot: Pilot,
  context: { readonly moveState: MoveState },
  cell: Cell,
  say: Say,
): Promise<[boolean, string]> {
  return navigate(pilot, cell, false, say, 30, context.moveState);
}

function cellText(cell: Cell | null): string {
  return cell === null ? "None" : `(${cell[0]}, ${cell[1]})`;
}

/**
 * Whether this map's own layers connect the party to an exit. World maps are left to the
 * planner's moving window; indoors the actual layered search answers (11-09: Walse Castle
 * 54's world-map exits are on the upper floor, the party from map 62 is not).
 *
 * Task 73: when only untrusted "走不过去" records block the exit, canReach says yes so the walk
 * goes there; navigate then forgets those records or counts the step blocked again.
 */
async function exitReachable(
  pilot: Pilot,
  state: MoveState,
  map: number,
  cell: Cell,
): Promise<boolean> {
  if (isWorldMap(map)) return true;
  return canReach(pilot, cell, state, map);
}

interface WalkOutcome {
  readonly reached: boolean;
  readonly detail: string;
  readonly position: TravelPosition;
  /** The battle's own 全灭 line, when the walk wiped the party. */
  readonly wipe: string | null;
  /** A non-field state the walk stopped on (story, dialog); null on the field. */
  readonly story: string | null;
}

const FIELD_STATES: ReadonlySet<string> = new Set(["Player", "ChangeMap", "FieldReady"]);

/** Keep the battle/story outcomes a travel tool must report, from the walk's own lines. */
function walkOutcome(
  position: TravelPosition,
  reached: boolean,
  detail: string,
  said: readonly string[],
): WalkOutcome {
  const wipe = said.find((line) => line.trimStart().startsWith("全灭")) ?? null;
  const story = position.state !== "" && !FIELD_STATES.has(position.state) ? position.state : null;
  return { reached, detail, position, wipe, story };
}

/** Task 61: "第 k 跳" is appended while this hop walks; the caller's label stays its base. */
async function withHop<T>(state: MoveState, hop: number, run: () => Promise<T>): Promise<T> {
  const previous = state.hop;
  state.hop = hop;
  try {
    return await run();
  } finally {
    state.hop = previous;
  }
}

/** Walk to one cell, keeping the battle/story outcomes the travel tools must report. */
async function walkTo(
  pilot: Pilot,
  moveState: MoveState,
  cell: Cell,
  say: Say,
): Promise<WalkOutcome> {
  const said: string[] = [];
  const [reached, detail] = await navigate(
    pilot,
    cell,
    false,
    (line) => {
      said.push(line);
      say(line);
    },
    8,
    moveState,
  );
  return walkOutcome(await readPosition(pilot), reached, detail, said);
}

/**
 * On the wind drake, to an entrance on the world map: flyIn lands on open ground and walks in
 * (task 57 reuses task 48's move.ts path; how the drake flies is not travel.ts's business).
 */
async function flyTo(
  pilot: Pilot,
  moveState: MoveState,
  cell: Cell,
  say: Say,
): Promise<WalkOutcome> {
  const said: string[] = [];
  const [reached, detail] = await flyIn(pilot, moveState, cell, (line) => {
    said.push(line);
    say(line);
  });
  return walkOutcome(await readPosition(pilot), reached, detail, said);
}

/** How the party moves on the field, or "" when walking or the sample cannot be read. */
export async function rideState(pilot: Pilot): Promise<string> {
  try {
    const field = record(record((await pilot.query("sample")).sample).field);
    return text(field.moveState) ?? "";
  } catch {
    return "";
  }
}

interface WorldRide {
  readonly flying: boolean;
  readonly stop: string | null;
}

/**
 * Whether a world-map hop may go on: on foot, or on the drake. A ship or chocobo cannot enter
 * a town, so the map route stops and says so instead of walking into the sea/land on it.
 */
async function worldRide(pilot: Pilot): Promise<WorldRide> {
  let airborne = false;
  try {
    airborne = await flying(pilot);
  } catch {
    // A test without a sample is walking; production always has one.
  }
  if (airborne) return { flying: true, stop: null };
  const state = await rideState(pilot);
  const label = RIDES.get(state);
  if (label === undefined) return { flying: false, stop: null };
  const name = label.split("(", 1)[0] ?? label;
  return { flying: false, stop: `现在在${name}上,go 只会步行和骑飞龙` };
}

function firstLine(line: string): string {
  return line.split(/\r?\n/u, 1)[0] ?? line;
}

interface TravelEnd {
  readonly reached: boolean;
  readonly stop: string;
  readonly detail: string;
  readonly mapId: number | null;
  readonly cell: Cell | null;
  /** A refusal whose text must reach the model unchanged. */
  readonly verbatim?: string;
  /** Task 75: what a failed plan is missing, on its own lines. */
  readonly hint?: string;
}

/** Build the one multi-line result the model reads, for every way a travel can end. */
function travelText(
  atlas: Atlas,
  hops: readonly TravelHop[],
  blocked: readonly string[],
  end: TravelEnd,
): TravelResult {
  const parts: string[] = [];
  if (hops.length === 0) {
    parts.push("跳数:0");
  } else {
    parts.push(`走了 ${hops.length} 跳:`);
    for (const hop of hops) {
      if (hop.kind === "ride") {
        const press = hop.press ?? hop.cell;
        parts.push(
          `  地图 ${hop.from} →(${hop.cell[0]}, ${hop.cell[1]})面朝${hop.dir ?? "?"}` +
            `按(${press[0]}, ${press[1]})→ 地图 ${hop.actual}`,
        );
      } else {
        parts.push(`  地图 ${hop.from} →(${hop.cell[0]}, ${hop.cell[1]})→ 地图 ${hop.actual}`);
      }
      if (hop.changed) {
        parts.push(
          `    (${hop.cell[0]}, ${hop.cell[1]}) 这次去了地图 ${hop.actual}，` +
            `地图记录里写的是 ${hop.to}`,
        );
      }
    }
  }
  const where =
    end.mapId === null
      ? "地图读不到"
      : mapLabel(atlas, end.mapId) + (end.cell === null ? "" : ` (${end.cell[0]}, ${end.cell[1]})`);
  parts.push(`停在:${where}`);
  if (end.verbatim !== undefined) parts.push(end.verbatim);
  if (end.hint !== undefined) parts.push(end.hint);
  parts.push(`停:${end.stop}`);
  if (blocked.length > 0) parts.push(`没走通的出口:${blocked.join("、")}`);
  return {
    reached: end.reached,
    mapId: end.mapId,
    cell: end.cell,
    hops,
    blocked,
    stop: end.stop,
    detail: end.detail,
    text: parts.join("\n"),
  };
}

/**
 * Travel from the current map to `target`, one recorded exit at a time. Every departure goes
 * through `options.guard`; an exit that does not work is closed for this call and the route is
 * planned again. An unexpected destination (an elevator whose lever changed) is reported and
 * the route replanned from where the party actually is.
 */
export async function travelToMap(
  pilot: Pilot,
  context: TravelContext,
  target: number,
  say: Say = () => undefined,
  options: TravelOptions = {},
): Promise<TravelResult> {
  const atlas = context.atlas;
  const maxHops = Math.max(1, Math.trunc(options.maxHops ?? DEFAULT_TRAVEL_MAX_HOPS));
  const maxMinutes = options.maxMinutes ?? DEFAULT_TRAVEL_MAX_MINUTES;
  const start = await readPosition(pilot);
  let current = start.map;
  let cell = start.cell;
  // Task 75: collision regions of the maps that have been cached. The starting map is
  // refreshed from the live reply so a story change or a door cell is not read from a stale
  // cache; a map without a cache keeps the pre-task-75 whole-map node.
  const regions = RegionIndex.create(
    atlas,
    context.collisions,
    context.moveState.blockedTrustCount,
  );
  let layer: number | null = null;
  if (current !== null && !isWorldMap(current) && cell !== null && context.collisions) {
    try {
      const collision = record((await pilot.send("collision")).collision);
      await context.collisions.remember(current, collision);
      layer = regions.setLive(current, collision, cell)?.layer ?? null;
    } catch {
      layer = regions.region(current)?.layer ?? null;
    }
  }
  const startMap = current;
  const startedMs = pilot.now();
  const hops: TravelHop[] = [];
  const blocked: string[] = [];
  const unavailable = new Set<string>();
  // Task 74: landings observed for exit edges in this call, so a map entered before can be
  // judged from the region it was actually entered at.
  const landings = new Map<string, ObservedLanding>();
  const walkSay: Say = (line) => {
    context.say?.(line);
    say(line);
  };

  const finish = (end: TravelEnd): TravelResult => travelText(atlas, hops, blocked, end);

  if (current === null) {
    return finish({
      reached: false,
      stop: "读不到当前地图",
      detail: "读不到当前地图",
      mapId: null,
      cell,
    });
  }
  if (current === target) {
    return finish({
      reached: true,
      stop: `到了地图 ${target}`,
      detail: `到了地图 ${target}`,
      mapId: current,
      cell,
    });
  }

  for (let attempt = 0; attempt < maxHops * 4 + 8; attempt++) {
    if (hops.length >= maxHops) {
      return finish({
        reached: false,
        stop: `到 ${maxHops} 跳上限了`,
        detail: `到 ${maxHops} 跳上限了`,
        mapId: current,
        cell,
      });
    }
    if (Number.isFinite(maxMinutes) && pilot.now() - startedMs >= maxMinutes * 60_000) {
      return finish({
        reached: false,
        stop: `到 ${maxMinutes} 分钟上限了`,
        detail: `到 ${maxMinutes} 分钟上限了`,
        mapId: current,
        cell,
      });
    }
    const path = mapPath(atlas, current, target, unavailable, true, {
      start: cell,
      startLayer: layer,
      landings,
      regions,
    });
    if (path === null) {
      const hint = explainNoPath(atlas, regions, current, cell, target);
      const stop = `地图记录里找不到从 ${current} 到 ${target} 的路`;
      return finish({ reached: false, stop, detail: stop, mapId: current, cell, hint });
    }
    const first = path[0];
    if (first === undefined) {
      return finish({
        reached: true,
        stop: `到了地图 ${target}`,
        detail: `到了地图 ${target}`,
        mapId: current,
        cell,
      });
    }
    if (first.kind === "ride") {
      if (!(await exitReachable(pilot, context.moveState, current, first.cell))) {
        unavailable.add(hopKey(current, cell, first.cell, first.to, "ride"));
        blocked.push(
          `地图 ${current} (${first.cell[0]}, ${first.cell[1]}) 坐电梯到地图 ${first.to}` +
            "(本图走不过去)",
        );
        continue;
      }
      const refusal = options.guard
        ? await options.guard(pilot, first.cell, current === startMap && hops.length === 0)
        : null;
      if (refusal !== null) {
        return finish({
          reached: false,
          stop: `停在 地图 ${current}：要离开这里，但本图没完成，等你决定`,
          detail: refusal.text,
          mapId: current,
          cell,
          verbatim: refusal.text,
        });
      }
      const taken = await withHop(context.moveState, hops.length + 1, () =>
        rideAt(pilot, context.moveState, first.cell, first.dir ?? "Up", walkSay),
      );
      if (!taken.changed || taken.map === null || taken.cell === null) {
        unavailable.add(hopKey(current, cell, first.cell, first.to, "ride"));
        blocked.push(
          `地图 ${current} (${first.cell[0]}, ${first.cell[1]}) 坐电梯到地图 ${first.to}` +
            (taken.changed ? "(没读到落点)" : "(按了没换图)"),
        );
        continue;
      }
      const actual = taken.map;
      if (actual !== first.to) unavailable.add(hopKey(current, cell, first.cell, first.to, "ride"));
      const landedLayer = await readLandingLayer(
        pilot,
        regions,
        context.collisions,
        actual,
        taken.cell,
      );
      // Riding is itself an observation: keep the edge and the landing the game actually used,
      // so a lift that stopped on another floor is planable next time (task 71).
      await atlas.ride(
        current,
        first.cell,
        first.press ?? first.cell,
        first.dir ?? "Up",
        actual,
        taken.cell,
        "坐一趟",
        landedLayer,
      );
      hops.push({
        from: current,
        to: first.to,
        actual,
        cell: first.cell,
        kind: "ride",
        dir: first.dir,
        press: first.press,
        changed: actual !== first.to,
      });
      current = actual;
      cell = taken.cell;
      layer = landedLayer;
      if (current === target) {
        return finish({
          reached: true,
          stop: `到了地图 ${target}`,
          detail: `到了地图 ${target}`,
          mapId: current,
          cell,
        });
      }
      continue;
    }
    const ride: WorldRide | null = isWorldMap(current) ? await worldRide(pilot) : null;
    if (ride !== null && ride.stop !== null) {
      return finish({
        reached: false,
        stop: ride.stop,
        detail: ride.stop,
        mapId: current,
        cell,
      });
    }
    if (!(await exitReachable(pilot, context.moveState, current, first.cell))) {
      // The exit exists in the atlas but is in another region of this map. Close it for this
      // call instead of walking into the wall; the next route may leave by another exit.
      unavailable.add(hopKey(current, cell, first.cell, first.to));
      blocked.push(
        `地图 ${current} (${first.cell[0]}, ${first.cell[1]}) 到地图 ${first.to}(本图走不过去)`,
      );
      continue;
    }
    const refusal = options.guard
      ? await options.guard(pilot, first.cell, current === startMap && hops.length === 0)
      : null;
    if (refusal !== null) {
      return finish({
        reached: false,
        stop: `停在 地图 ${current}：要离开这里，但本图没完成，等你决定`,
        detail: refusal.text,
        mapId: current,
        cell,
        verbatim: refusal.text,
      });
    }
    const walked: WalkOutcome = await withHop(context.moveState, hops.length + 1, () =>
      ride?.flying === true
        ? flyTo(pilot, context.moveState, first.cell, walkSay)
        : walkTo(pilot, context.moveState, first.cell, walkSay),
    );
    if (walked.wipe !== null) {
      return finish({
        reached: false,
        stop: `全灭:${firstLine(walked.wipe)}`,
        detail: walked.wipe,
        mapId: walked.position.map,
        cell: walked.position.cell,
      });
    }
    if (walked.story !== null) {
      return finish({
        reached: false,
        stop: `停在状态 ${walked.story}，先停下`,
        detail: walked.detail,
        mapId: walked.position.map,
        cell: walked.position.cell,
      });
    }
    const now: TravelPosition = walked.position;
    if (now.map === null) {
      return finish({
        reached: false,
        stop: "到了入口却没读到新地图",
        detail: "到了入口却没读到新地图",
        mapId: null,
        cell: now.cell,
      });
    }
    if (!walked.reached) {
      if (now.map !== current) {
        // A failed walk that still changed the map is a hop; replan from where it landed.
        let landedLayer: number | null = null;
        if (now.map !== first.to) unavailable.add(hopKey(current, cell, first.cell, first.to));
        if (now.cell !== null) {
          landedLayer = await readLandingLayer(
            pilot,
            regions,
            context.collisions,
            now.map,
            now.cell,
          );
        }
        if (now.map === first.to && now.cell !== null) {
          landings.set(edgeKey(current, first.cell, first.to), {
            cell: now.cell,
            layer: landedLayer,
          });
          await atlas.landExit(current, first.cell, first.to, now.cell, landedLayer);
        }
        hops.push({
          from: current,
          to: first.to,
          actual: now.map,
          cell: first.cell,
          kind: "exit",
          changed: now.map !== first.to,
        });
        current = now.map;
        cell = now.cell;
        layer = landedLayer;
        if (current === target) {
          return finish({
            reached: true,
            stop: `到了地图 ${target}`,
            detail: `到了地图 ${target}`,
            mapId: current,
            cell,
          });
        }
        continue;
      }
      unavailable.add(hopKey(current, cell, first.cell, first.to));
      blocked.push(`地图 ${current} (${first.cell[0]}, ${first.cell[1]}) 到地图 ${first.to}`);
      continue;
    }
    if (now.map === current) {
      unavailable.add(hopKey(current, cell, first.cell, first.to));
      blocked.push(
        `地图 ${current} (${first.cell[0]}, ${first.cell[1]}) 到地图 ${first.to}` +
          "(走到入口却没进图)",
      );
      continue;
    }
    const landedLayer =
      now.cell === null
        ? null
        : await readLandingLayer(pilot, regions, context.collisions, now.map, now.cell);
    if (now.map !== first.to) unavailable.add(hopKey(current, cell, first.cell, first.to));
    else if (now.cell !== null) {
      landings.set(edgeKey(current, first.cell, first.to), {
        cell: now.cell,
        layer: landedLayer,
      });
      await atlas.landExit(current, first.cell, first.to, now.cell, landedLayer);
    }
    hops.push({
      from: current,
      to: first.to,
      actual: now.map,
      cell: first.cell,
      kind: "exit",
      changed: now.map !== first.to,
    });
    current = now.map;
    cell = now.cell;
    layer = landedLayer;
    if (current === target) {
      return finish({
        reached: true,
        stop: `到了地图 ${target}`,
        detail: `到了地图 ${target}`,
        mapId: current,
        cell,
      });
    }
  }
  return finish({
    reached: false,
    stop: "换了几次地图还没到",
    detail: "换了几次地图还没到",
    mapId: current,
    cell,
  });
}

interface DetourSource {
  readonly id: number;
  readonly hops: number;
  /** Exits back into the target whose recorded landing is in the goal's block. */
  readonly inBlock: readonly MapExit[];
  /** Exits back into the target whose landing was never recorded; listed, never walked. */
  readonly unrecorded: readonly MapExit[];
}

/**
 * Where an exit back into the target lands, relative to the goal's block (task 76). Only
 * "other-block" removes the entrance: a known landing somewhere else would just repeat the
 * round trip that left the party in the wrong block.
 */
function landingMatch(
  regions: RegionIndex,
  target: number,
  targetBlocks: readonly RegionBlock[] | null,
  exit: MapExit,
): "in-block" | "unrecorded" | "other-block" {
  if (exit.land === undefined) return "unrecorded";
  // A map without a cached region cannot be compared; keep the old optimism and let the walk
  // after re-entry decide. A landing the cached grid does not cover is treated as unrecorded.
  if (targetBlocks === null) return "in-block";
  const blocks = landingBlocks(regions, target, exit.land, exit.landLayer ?? null);
  if (blocks === null) return "unrecorded";
  return blocks.some((block) => targetBlocks.some((other) => other.id === block.id))
    ? "in-block"
    : "other-block";
}

/** Maps with an exit back into `target`, reachable from the current map by its own layers. */
async function detourSources(
  pilot: Pilot,
  context: TravelContext,
  target: number,
  targetBlocks: readonly RegionBlock[] | null,
  startCell: Cell | null,
  regions: RegionIndex,
): Promise<DetourSource[]> {
  const found: DetourSource[] = [];
  for (const [key] of context.atlas.maps) {
    const id = Number(key);
    if (!Number.isFinite(id) || id === target) continue;
    const inBlock: MapExit[] = [];
    const unrecorded: MapExit[] = [];
    for (const exit of mapExits(context.atlas, id)) {
      if (exit.to !== target) continue;
      const match = landingMatch(regions, target, targetBlocks, exit);
      if (match === "in-block") inBlock.push(exit);
      else if (match === "unrecorded") unrecorded.push(exit);
    }
    if (inBlock.length === 0 && unrecorded.length === 0) continue;
    // The atlas's shortest way may start at an exit this region cannot reach; close that
    // hop and ask again, so 54→55 can become 54→62→55 (11-09, Walse Castle 54).
    const unavailable = new Set<string>();
    for (let attempt = 0; attempt < 6; attempt++) {
      const path = mapPath(context.atlas, target, id, unavailable, true, {
        start: startCell,
        regions,
      });
      const first = path?.[0];
      if (path === null || first === undefined) break;
      if (await exitReachable(pilot, context.moveState, target, first.cell)) {
        found.push({ id, hops: path.length, inBlock, unrecorded });
        break;
      }
      unavailable.add(hopKey(target, startCell, first.cell, first.to));
    }
  }
  return found.sort((left, right) => left.hops - right.hops || left.id - right.id);
}

/**
 * When a cell is in another region of the current map, walk out and come back through an
 * entrance that does reach it (11-09, Walse Castle 54: (36,33) cannot reach the world-map
 * exit, but entering again from map 55 at (28,33) can). Returns null when the goal is already
 * reachable, so the caller walks normally; otherwise the text is the whole result, either the
 * finished detour or the entrances that would work.
 *
 * Task 76: only an entrance whose recorded landing is in the goal's block is walked. An
 * entrance whose landing was never recorded is listed as "落点没记过，可以试" and left alone;
 * a recorded landing in another block is dropped, because that is the round trip that kept the
 * party in the wrong block on the Fire-Powered Ship (11-09, map 261).
 */
export async function detourToCell(
  pilot: Pilot,
  context: TravelContext,
  goal: Cell,
  say: Say = () => undefined,
  options: TravelOptions = {},
): Promise<string | null> {
  const start = await readPosition(pilot);
  if (start.map === null || isWorldMap(start.map)) return null;
  // Use the cell the party actually stands on: the collision reply's playerCell may lag a
  // map change, and a door/landing cell can read as a wall in the grid (11-09, map 252).
  const from = start.cell === null ? undefined : { cell: start.cell };
  if (await canReach(pilot, goal, context.moveState, start.map, from)) return null;

  const landings = (await landingCells(pilot)).filter(
    (landing) => !sameCell(landing.cell, start.cell),
  );
  const reachable: Landing[] = [];
  for (const landing of landings) {
    if (
      await canReach(pilot, goal, context.moveState, start.map, {
        cell: landing.cell,
        layer: landing.layer,
      })
    ) {
      reachable.push(landing);
    }
  }
  const regions = RegionIndex.create(
    context.atlas,
    context.collisions,
    context.moveState.blockedTrustCount,
  );
  const targetBlocks = landingBlocks(regions, start.map, goal, null);
  const sources =
    reachable.length === 0
      ? []
      : await detourSources(pilot, context, start.map, targetBlocks, start.cell, regions);
  const observed = new Map<number, Cell>();
  const parts: string[] = [];
  const automatic = sources.filter((source) => source.inBlock.length > 0);
  for (const source of automatic.slice(0, 4)) {
    const out = await travelToMap(pilot, context, source.id, say, options);
    if (!out.reached) continue;
    const back = await travelToMap(pilot, context, start.map, say, options);
    if (!back.reached) continue;
    const now = await readPosition(pilot);
    if (now.map !== start.map || now.cell === null) continue;
    observed.set(source.id, now.cell);
    if (!(await canReach(pilot, goal, context.moveState, start.map, { cell: now.cell }))) continue;
    const [, walked] = await navigate(pilot, goal, false, say, 8, context.moveState);
    parts.push(`目标 ${cellText(goal)} 和原来所在的区域不连通,先出去绕一圈再进来。`);
    parts.push(out.text, back.text);
    parts.push(`从地图 ${source.id} 回来落在 ${cellText(now.cell)}。`);
    parts.push(walked);
    return parts.join("\n");
  }

  const lines: string[] = [];
  if (parts.length > 0) lines.push(...parts);
  lines.push(`目标 ${cellText(goal)} 和你现在所在的区域不连通。`);
  if (reachable.length > 0) {
    const hints = reachable.map((landing) => {
      const source = [...observed].find(([, cell]) => sameCell(cell, landing.cell));
      return source === undefined
        ? `${cellText(landing.cell)}(第 ${landing.layer ?? "?"} 层)`
        : `从地图 ${source[0]} 进来的 ${cellText(landing.cell)}`;
    });
    lines.push(`能走到目标的落点有:${hints.join("、")}。`);
  }
  if (automatic.length > 0) {
    const names = automatic
      .slice(0, 6)
      .map((source) => entranceText(source.id, source.inBlock))
      .join("、");
    lines.push(`可以从 ${names} 出去再进来;先去能走到目标的落点,再走到目标。`);
  }
  const unrecorded = sources.filter((source) => source.unrecorded.length > 0);
  if (unrecorded.length > 0) {
    const names = unrecorded
      .slice(0, 6)
      .map((source) => entranceText(source.id, source.unrecorded))
      .join("、");
    lines.push(`落点没记过，可以试的入口:${names}。这些入口不会自动走,想试就自己 go 过去。`);
  }
  if (automatic.length === 0 && unrecorded.length === 0) {
    lines.push("按地图记录，没有能到这一块的入口;这一块可能要从还没走过的出口或机关进来。");
  }
  return lines.join("\n");
}

/** One source map's entrances for the result text, with the cells on the source map. */
function entranceText(mapId: number, exits: readonly MapExit[]): string {
  const cells = exits
    .slice(0, 3)
    .map((exit) => `(${exit.cell[0]}, ${exit.cell[1]})`)
    .join("、");
  return `地图 ${mapId} ${cells}`;
}

/** A map name or id the model asked for, or the list of candidates when several match. */
export type MapChoice =
  { readonly ok: true; readonly mapId: number } | { readonly ok: false; readonly error: string };

export function findMap(atlas: Atlas, want: unknown): MapChoice {
  if (typeof want === "number") {
    if (!Number.isFinite(want)) return { ok: false, error: `不是地图号:${String(want)}` };
    // Task 58: a map the current one has an exit to may not be recorded yet; the route's
    // last hop can still enter it, so a numeric id is accepted even when unknown.
    return { ok: true, mapId: Math.trunc(want) };
  }
  const query = typeof want === "string" ? want.trim() : "";
  if (query === "") return { ok: false, error: "要给出地图号或地图名的一部分。" };
  const numbered = /^(?:地图\s*)?(\d+)$/u.exec(query);
  if (numbered !== null) {
    const id = Number(numbered[1]);
    if (!Number.isFinite(id)) return { ok: false, error: `不是地图号:${query}` };
    return { ok: true, mapId: Math.trunc(id) };
  }
  const wanted = query.toLowerCase();
  // Map names, plus the names written on the world map's exits (e.g. "4:トゥールの村"),
  // because the model names a town as the world map labels it (task 58).
  const labels = new Map<number, Set<string>>();
  const add = (id: number, label: string): void => {
    const name = label.trim();
    if (name === "") return;
    const set = labels.get(id) ?? new Set<string>();
    set.add(name);
    labels.set(id, set);
  };
  for (const [key, entry] of atlas.maps) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    add(id, text(entry.name) ?? "");
  }
  for (const exit of records(atlas.maps.get(String(WORLD_MAP))?.exits)) {
    const to = num(exit.to);
    if (to === undefined) continue;
    const name = text(exit.name) ?? "";
    add(Math.trunc(to), name);
    const suffix = name.replace(/^\d+:/u, "");
    if (suffix !== name) add(Math.trunc(to), suffix);
  }
  // An exact name wins over containing it: "图尔村" is map 30, not also 图尔村 旅店/武器店/…
  // (11-05 review: the prompt's own example matched seven maps in the real atlas).
  const named = (exact: boolean): number[] =>
    [...labels]
      .filter(([, names]) =>
        [...names].some((name) =>
          exact ? name.toLowerCase() === wanted : name.toLowerCase().includes(wanted),
        ),
      )
      .map(([id]) => id)
      .sort((left, right) => left - right);
  const exact = named(true);
  const matches = exact.length > 0 ? exact : named(false);
  if (matches.length === 1) {
    const id = matches[0];
    if (id === undefined) return { ok: false, error: `地图记录里没有名字包含「${query}」的地图` };
    return { ok: true, mapId: id };
  }
  if (matches.length === 0) {
    return { ok: false, error: `地图记录里没有名字包含「${query}」的地图` };
  }
  const list = matches
    .map((id) => (atlas.maps.has(String(id)) ? mapLabel(atlas, id) : `地图 ${id}`))
    .join("、");
  return {
    ok: false,
    error: `名字包含「${query}」的地图有 ${matches.length} 张:${list}。请用地图号再调用一次。`,
  };
}

/** A named exit at `cell` on `mapId`, used to tell the model it could name the place instead. */
export interface NamedExit {
  readonly to: number;
  readonly name: string;
}

export function namedExitAt(atlas: Atlas, mapId: number, cell: Cell): NamedExit | null {
  const exit = rawExits(atlas, mapId).find(
    (candidate) => candidate.to !== null && sameCell(candidate.cell, cell),
  );
  if (exit === undefined || exit.to === null) return null;
  const recorded = text(atlas.maps.get(String(exit.to))?.name) ?? "";
  const written = exit.name.replace(/^\d+:/u, "").trim();
  const name =
    recorded.trim() !== "" ? recorded.trim() : written !== "" ? written : `地图 ${exit.to}`;
  return { to: exit.to, name };
}

export interface ExploreContext {
  readonly atlas: Atlas;
  readonly moveState: MoveState;
  readonly limits?: Partial<TravelLimits>;
  /** Task 75: cached collision regions, from the Game's collision store. */
  readonly collisions?: CollisionStore;
  readonly guard?: (pilot: Pilot, goal: Cell, origin: boolean) => Promise<LeaveRefusal | null>;
  /** The game's look_around summary, appended once a new map is entered. */
  readonly lookAround?: (pilot: Pilot) => Promise<string>;
  readonly say?: Say;
}

export interface ExploreResult {
  readonly found: boolean;
  readonly mapId: number | null;
  readonly text: string;
}

interface ExitChoice {
  readonly exit: RawMapExit;
  readonly distance: number;
}

/** The nearest unknown exit reachable on foot in this map; unreachable ones do not count. */
async function nearestUnknownExit(
  pilot: Pilot,
  context: ExploreContext,
  mapId: number,
): Promise<ExitChoice | null> {
  let best: ExitChoice | null = null;
  for (const exit of unknownExits(context.atlas, mapId)) {
    const [here, path] = await plan(
      pilot,
      exit.cell,
      false,
      new Set<string>(),
      context.moveState,
      mapId,
    );
    if (here === null || path.length === 0) continue;
    const last = path[path.length - 1] ?? null;
    if (!sameCell(last, exit.cell)) continue;
    const distance = path.length - 1;
    if (best === null || distance < best.distance) best = { exit, distance };
  }
  return best;
}

/** The atlas map nearest by map hops that still has an unknown exit. */
function nearestMapWithUnknownExits(atlas: Atlas, from: number): number | null {
  let best: { id: number; hops: number } | null = null;
  for (const [key] of atlas.maps) {
    const id = Number(key);
    if (!Number.isFinite(id) || id === from || isWorldMap(id)) continue;
    if (unknownExits(atlas, id).length === 0) continue;
    const path = mapPath(atlas, from, id, new Set(), true);
    if (path === null) continue;
    if (best === null || path.length < best.hops || (path.length === best.hops && id < best.id)) {
      best = { id, hops: path.length };
    }
  }
  return best?.id ?? null;
}

function noUnknownExitText(): string {
  return "地图记录里，从这里能走到的出口都去过了。";
}

/**
 * Find and enter the nearest exit the atlas has no destination for. When the current map has
 * none (or none on foot), travel to the nearest map that does, then look again. Every map left
 * goes through `guard`, and the new map's look_around summary is part of the result.
 */
export async function explore(
  pilot: Pilot,
  context: ExploreContext,
  options: { readonly origin?: boolean } = {},
): Promise<ExploreResult> {
  const atlas = context.atlas;
  const limits = context.limits ?? {};
  const start = await readPosition(pilot);
  const startMap = start.map;
  if (startMap === null) {
    return { found: false, mapId: null, text: "读不到当前地图，没法找新出口。" };
  }
  let current = startMap;
  let cell = start.cell;
  let origin = options.origin ?? true;
  const before: string[] = [];

  let target = await nearestUnknownExit(pilot, context, current);
  if (target === null) {
    if (isWorldMap(current)) {
      return { found: false, mapId: current, text: noUnknownExitText() };
    }
    const next = nearestMapWithUnknownExits(atlas, current);
    if (next === null) return { found: false, mapId: current, text: noUnknownExitText() };
    const travelled = await travelToMap(pilot, context, next, context.say ?? (() => undefined), {
      guard: context.guard,
      maxHops: limits.maxHops,
      maxMinutes: limits.maxMinutes,
    });
    before.push(travelled.text);
    if (!travelled.reached) {
      return { found: false, mapId: travelled.mapId, text: travelled.text };
    }
    const at = await readPosition(pilot);
    current = at.map ?? next;
    cell = at.cell;
    origin = false;
    target = await nearestUnknownExit(pilot, context, current);
    if (target === null) {
      before.push(`到了地图 ${current}，但这里没有能走到的未记录出口。`);
      return { found: false, mapId: current, text: before.join("\n") };
    }
  }

  const refusal = context.guard ? await context.guard(pilot, target.exit.cell, origin) : null;
  if (refusal !== null) {
    before.push(`停在:地图 ${current} (${cell?.[0] ?? "?"}, ${cell?.[1] ?? "?"})`);
    before.push(refusal.text);
    before.push(`停:要离开这里，但本图没完成，等你决定`);
    return { found: false, mapId: current, text: before.join("\n") };
  }

  const said: string[] = [];
  const [reached, detail] = await navigate(
    pilot,
    target.exit.cell,
    false,
    (line) => {
      said.push(line);
      context.say?.(line);
    },
    8,
    context.moveState,
  );
  const now = await readPosition(pilot);
  const wipe = said.find((line) => line.trimStart().startsWith("全灭"));
  if (wipe !== undefined) {
    before.push(`停在:地图 ${now.map ?? current}`);
    before.push(`停:全灭:${firstLine(wipe)}`);
    return { found: false, mapId: now.map ?? current, text: before.join("\n") };
  }
  if (now.state !== "" && !FIELD_STATES.has(now.state)) {
    before.push(`停在:地图 ${now.map ?? current}`);
    before.push(`停:停在状态 ${now.state}，先停下`);
    return { found: false, mapId: now.map ?? current, text: before.join("\n") };
  }
  const where = `(${target.exit.cell[0]}, ${target.exit.cell[1]})`;
  if (now.map === null || now.map === current) {
    if (!reached) {
      before.push(`走不到 ${where}:${detail}`);
    } else {
      before.push(`走到 ${where} 却没有进新地图`);
    }
    before.push(`停:地图 ${current} 的出口没走通`);
    return { found: false, mapId: current, text: before.join("\n") };
  }

  before.push(`走了 ${target.distance} 格到 ${where}，进了${mapLabel(atlas, now.map)}`);
  const look = context.lookAround ? await context.lookAround(pilot) : "";
  if (look !== "") before.push(`这张图:\n${look}`);
  return { found: true, mapId: now.map, text: before.join("\n") };
}

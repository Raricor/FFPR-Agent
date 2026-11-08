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

import type { Atlas } from "../atlas.ts";
import type { Cell } from "../nav.ts";
import type { Pilot } from "../pilot.ts";
import { num, record, records, text } from "../values.ts";
import { RIDES } from "../view.ts";
import { flyIn, flying, navigate, plan, type MoveState } from "./move.ts";

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
  /** Where the atlas said this exit leads. */
  readonly to: number;
  /** Where the game actually put the party (an elevator may have changed). */
  readonly actual: number;
  readonly cell: Cell;
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
  return rawExits(atlas, mapId).flatMap((exit) =>
    exit.to === null ? [] : [{ cell: exit.cell, to: exit.to, name: exit.name }],
  );
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
}

function hopKey(from: number, cell: Cell, to: number): string {
  return `${from}:${cell[0]},${cell[1]}:${to}`;
}

/**
 * A route over the atlas's exits, or null. `unavailable` closes exits that failed in this
 * call. `viaWorld` lets the route treat the world map as an ordinary hop (task 57); without
 * it the world map is not used, which keeps the pure map-to-map query available.
 */
export function mapPath(
  atlas: Atlas,
  from: number,
  to: number,
  unavailable: ReadonlySet<string> = new Set(),
  viaWorld = false,
): MapHop[] | null {
  if (from === to) return [];
  if (!viaWorld && (isWorldMap(from) || isWorldMap(to))) return null;
  const queue: { readonly id: number; readonly path: MapHop[] }[] = [{ id: from, path: [] }];
  const seen = new Set<number>([from]);
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    for (const exit of mapExits(atlas, item.id)) {
      if (!viaWorld && isWorldMap(exit.to)) continue;
      // Task 58: the last hop may enter a map this save has never recorded.
      if (!atlas.maps.has(String(exit.to)) && exit.to !== to) continue;
      if (unavailable.has(hopKey(item.id, exit.cell, exit.to))) continue;
      const hop: MapHop = { from: item.id, to: exit.to, cell: exit.cell };
      if (exit.to === to) return [...item.path, hop];
      if (seen.has(exit.to)) continue;
      seen.add(exit.to);
      queue.push({ id: exit.to, path: [...item.path, hop] });
    }
  }
  return null;
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
      parts.push(`  地图 ${hop.from} →(${hop.cell[0]}, ${hop.cell[1]})→ 地图 ${hop.actual}`);
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
  const startMap = current;
  const startedMs = pilot.now();
  const hops: TravelHop[] = [];
  const blocked: string[] = [];
  const unavailable = new Set<string>();
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
    const path = mapPath(atlas, current, target, unavailable, true);
    if (path === null) {
      const stop = `地图记录里找不到从 ${current} 到 ${target} 的路`;
      return finish({ reached: false, stop, detail: stop, mapId: current, cell });
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
        if (now.map !== first.to) unavailable.add(hopKey(current, first.cell, first.to));
        hops.push({
          from: current,
          to: first.to,
          actual: now.map,
          cell: first.cell,
          changed: now.map !== first.to,
        });
        current = now.map;
        cell = now.cell;
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
      unavailable.add(hopKey(current, first.cell, first.to));
      blocked.push(`地图 ${current} (${first.cell[0]}, ${first.cell[1]}) 到地图 ${first.to}`);
      continue;
    }
    if (now.map === current) {
      unavailable.add(hopKey(current, first.cell, first.to));
      blocked.push(
        `地图 ${current} (${first.cell[0]}, ${first.cell[1]}) 到地图 ${first.to}` +
          "(走到入口却没进图)",
      );
      continue;
    }
    if (now.map !== first.to) unavailable.add(hopKey(current, first.cell, first.to));
    hops.push({
      from: current,
      to: first.to,
      actual: now.map,
      cell: first.cell,
      changed: now.map !== first.to,
    });
    current = now.map;
    cell = now.cell;
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

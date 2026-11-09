/**
 * Pair estimates for the route analyzer (task 79): directed map-to-map distances from
 * task 75's `mapPath`, plus a walking estimate inside a map from the cached collision.
 *
 * The graph is directed: a fall, a conveyor or a one-way lift makes A→B different from B→A,
 * so nothing here symmetrises the matrix. A pair that `mapPath` cannot route is reported with
 * a Chinese reason instead of being given a made-up distance; the caller puts the waypoint in
 * `unreachable` and lets the AI explore it later.
 */

import { LAYER_Z, layeredGrid, layeredRoute } from "../nav.ts";
import type { Cell } from "../nav.ts";
import type { CollisionSnapshot } from "../regions.ts";
import { mapExits, mapPath } from "../skills/travel.ts";
import type { Atlas } from "../atlas.ts";
import type { PairEstimate, RoutePoint, RouteWorld } from "./types.ts";

/**
 * 11-10: a new-game route walked about 0.22 s per cell. The map-change (8 s) and no-cache
 * (12 cells) constants are placeholders from this task, not measurements; the task did not
 * put them in Config, so they stay here and the stage layer should replace them once it
 * times real legs.
 */
export const ROUTE_SECONDS_PER_CELL = 0.22;
/** Fade, load and the first step on the new map. */
export const ROUTE_SECONDS_PER_MAP_CHANGE = 8;
/** Walking estimate for one map that has no cached collision. */
export const ROUTE_CELLS_PER_MAP_HOP = 12;

type WalkResult = { readonly ok: true; readonly cells: number } | { readonly ok: false } | null;

export type PairResult =
  | { readonly ok: true; readonly estimate: PairEstimate }
  | { readonly ok: false; readonly reason: string };

/** A hop of mapPath, copied locally because MapHop is private to travel.ts. */
interface HopLike {
  readonly from: number;
  readonly to: number;
  readonly cell: Cell;
  readonly kind: "exit" | "ride";
  readonly dir?: string;
}

function sameCell(left: Cell | null, right: Cell | null): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
}

function cellText(cell: Cell | null): string {
  return cell === null ? "任意格" : `(${cell[0]},${cell[1]})`;
}

function estimate(maps: readonly number[], hops: number, cells: number): PairEstimate {
  const seconds = cells * ROUTE_SECONDS_PER_CELL + hops * ROUTE_SECONDS_PER_MAP_CHANGE;
  return { maps, hops, cells, minutes: seconds / 60 };
}

/** The heights a collision snapshot has, in the same order layeredGrid numbers them. */
function layerHeights(snapshot: CollisionSnapshot): number[] {
  const seen = new Set<number>();
  const heights: number[] = [];
  snapshot.layers.forEach((layer, index) => {
    const height = LAYER_Z.get(layer.name) ?? index;
    if (!seen.has(height)) {
      seen.add(height);
      heights.push(height);
    }
  });
  return heights.length > 0 ? heights : [snapshot.searchLayer ?? 0];
}

/**
 * Steps from `from` to `to` inside one map, or null when the map has no collision cache.
 * Every cached height is tried as the starting floor: a waypoint cell does not carry the
 * floor the party will arrive on, and the same (x, y) can be a corridor on one floor and a
 * wall on another.
 */
function walkCells(world: RouteWorld, mapId: number, from: Cell, to: Cell): WalkResult {
  const snapshot = world.collisions?.get(mapId);
  if (snapshot === undefined) return null;
  let best: number | null = null;
  for (const height of layerHeights(snapshot)) {
    const grid = layeredGrid(
      { ...snapshot, searchLayer: height, playerCell: [from[0], from[1]] },
      [],
      [],
      world.atlas.moves(mapId),
      [],
    );
    if (grid === null) continue;
    const path = layeredRoute(grid, to);
    const end = path.at(-1);
    if (end?.[0] !== to[0] || end[1] !== to[1]) continue;
    const cells = path.length - 1;
    if (best === null || cells < best) best = cells;
  }
  return best === null ? { ok: false } : { ok: true, cells: best };
}

/** Where a hop put the party on the destination map, when the atlas recorded it. */
function landingOf(
  atlas: Atlas,
  hop: HopLike,
): { readonly cell: Cell | null; readonly layer: number | null } {
  if (hop.kind === "ride") {
    const ride = atlas
      .rides(hop.from)
      .find(
        (candidate) =>
          sameCell(candidate.cell, hop.cell) &&
          candidate.to === hop.to &&
          candidate.dir === hop.dir,
      );
    return ride === undefined
      ? { cell: null, layer: null }
      : { cell: ride.land, layer: ride.landLayer ?? null };
  }
  const exit = mapExits(atlas, hop.from).find(
    (candidate) => sameCell(candidate.cell, hop.cell) && candidate.to === hop.to,
  );
  return exit === undefined
    ? { cell: null, layer: null }
    : { cell: exit.land ?? null, layer: exit.landLayer ?? null };
}

/** Why mapPath found nothing; separates a missing map record from a block/landing gap. */
function noPathReason(world: RouteWorld, from: RoutePoint, to: RoutePoint): string {
  if (!world.atlas.maps.has(String(from.map))) return `地图记录里没有地图 ${from.map}`;
  if (!world.atlas.maps.has(String(to.map))) return `地图记录里没有地图 ${to.map}`;
  const plain = mapPath(world.atlas, from.map, to.map, new Set(), true, { start: from.cell });
  if (plain === null) {
    return `地图记录里没有从地图 ${from.map} 到地图 ${to.map} 的出口路线`;
  }
  return `按（地图，连通块）走不到地图 ${to.map}:` + "这一块没有记过能进来的入口或落点（碰撞缓存）";
}

function sameMapResult(world: RouteWorld, from: RoutePoint, to: RoutePoint): PairResult {
  const map = from.map;
  if (sameCell(from.cell, to.cell)) return { ok: true, estimate: estimate([map], 0, 0) };
  const fromCell = from.cell;
  const toCell = to.cell;
  if (fromCell === null || toCell === null) {
    return { ok: true, estimate: estimate([map], 0, 0) };
  }
  const walk = walkCells(world, map, fromCell, toCell);
  if (walk === null) {
    return { ok: true, estimate: estimate([map], 0, ROUTE_CELLS_PER_MAP_HOP) };
  }
  if (!walk.ok) {
    return {
      ok: false,
      reason:
        `地图 ${map} 里从 ${cellText(fromCell)} 走不到 ${cellText(toCell)}` + "（按碰撞缓存）",
    };
  }
  return { ok: true, estimate: estimate([map], 0, walk.cells) };
}

function crossMapResult(world: RouteWorld, from: RoutePoint, to: RoutePoint): PairResult {
  if (!world.atlas.maps.has(String(from.map))) {
    return { ok: false, reason: `地图记录里没有地图 ${from.map}` };
  }
  // An unrecorded destination cannot be planned to; task 58's "walk into it and see" is for
  // the last step of an execution, not for saying a waypoint is reachable.
  if (!world.atlas.maps.has(String(to.map))) {
    return { ok: false, reason: `地图记录里没有地图 ${to.map}` };
  }
  const path = mapPath(world.atlas, from.map, to.map, new Set(), true, {
    regions: world.regions,
    start: from.cell,
  });
  if (path === null) return { ok: false, reason: noPathReason(world, from, to) };

  let cells = 0;
  let currentMap = from.map;
  let currentCell: Cell | null = from.cell;
  for (const hop of path) {
    if (currentCell === null) {
      cells += ROUTE_CELLS_PER_MAP_HOP;
    } else {
      const walk = walkCells(world, currentMap, currentCell, hop.cell);
      // mapPath already checked the block; a BFS disagreement is a cache gap, not proof of a
      // wall, so fall back to the per-map constant instead of making the waypoint unreachable.
      cells += !walk?.ok ? ROUTE_CELLS_PER_MAP_HOP : walk.cells;
    }
    const landing = landingOf(world.atlas, hop);
    currentMap = hop.to;
    currentCell = landing.cell;
  }

  if (to.cell !== null) {
    if (currentCell === null) {
      cells += ROUTE_CELLS_PER_MAP_HOP;
    } else {
      const walk = walkCells(world, to.map, currentCell, to.cell);
      if (walk === null) {
        cells += ROUTE_CELLS_PER_MAP_HOP;
      } else if (!walk.ok) {
        return {
          ok: false,
          reason:
            `地图 ${to.map} 里从落点 ${cellText(currentCell)} 走不到 ` +
            `${cellText(to.cell)}（按碰撞缓存）`,
        };
      } else {
        cells += walk.cells;
      }
    }
  }
  const maps = [from.map, ...path.map((hop) => hop.to)];
  return { ok: true, estimate: estimate(maps, path.length, cells) };
}

/**
 * One directed estimate from `from` to `to`. A caller-supplied distance function replaces
 * the atlas walk completely; returning null from it means unreachable.
 */
export function estimatePair(world: RouteWorld, from: RoutePoint, to: RoutePoint): PairResult {
  if (world.distance !== undefined) {
    const custom = world.distance(from, to);
    if (custom === null) return { ok: false, reason: "距离函数说这里走不到" };
    const maps = custom.maps.length > 0 ? custom.maps : [to.map];
    return { ok: true, estimate: { ...custom, maps } };
  }
  if (from.map === to.map) return sameMapResult(world, from, to);
  return crossMapResult(world, from, to);
}

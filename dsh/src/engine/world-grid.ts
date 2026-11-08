/**
 * The world map's terrain assembled from several `cells` windows (bridge 0.14.0's `at`), kept
 * in MoveState by map id for the rest of the run (task 56). It is memory only: the atlas is the
 * place for what should survive a restart.
 *
 * `plan` used to see only the r=24 window around the player, so a goal farther away was reached
 * 24 cells at a time and a mountain range or sea could send the party into a dead end. The merged
 * grid lets one plan search the whole known map.
 */

import { cellKey } from "./nav.ts";
import type { Cell, CellGrid, CellValue } from "./nav.ts";
import { isRecord } from "./values.ts";

/** The bridge's window radius; 24 is its documented cap. */
export const WORLD_RADIUS = 24;
/** A plan reads at most this many windows, the player's own included. */
export const MAX_WORLD_WINDOWS = 40;
/** How far past the player-to-goal box to read, for a way around a mountain or a bay. */
const MARGIN = WORLD_RADIUS * 2;

/** Known terrain: every cell of every window read, keyed with cellKey, and its bounds. */
export interface WorldTerrain {
  readonly cells: Map<string, CellValue>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** One per MoveState (one game), keyed by map id. `at`: undefined untried, false old bridge. */
export interface WorldCache {
  readonly maps: Map<string, WorldTerrain>;
  at: boolean | undefined;
}

export function createWorldCache(): WorldCache {
  return { maps: new Map(), at: undefined };
}

/** The bridge's reply carries `at` only from 0.14.0 on; an old plugin ignores the request. */
export function hasAt(raw: unknown): boolean {
  return isRecord(raw) && "at" in raw;
}

function mapKey(mapId: unknown): string {
  return typeof mapId === "string" ? mapId : JSON.stringify(mapId);
}

/** Add one window to the cache, overwriting the cells it covers (the story can change them). */
export function mergeWindow(cache: WorldCache, mapId: unknown, grid: CellGrid): WorldTerrain {
  const key = mapKey(mapId);
  let terrain = cache.maps.get(key);
  if (terrain === undefined) {
    terrain = {
      cells: new Map<string, CellValue>(),
      minX: grid.origin[0],
      maxX: grid.origin[0] - 1,
      minY: grid.origin[1],
      maxY: grid.origin[1] - 1,
    };
    cache.maps.set(key, terrain);
  }
  const [x0, y0] = grid.origin;
  for (let j = 0; j < grid.attr.length; j++) {
    const row = grid.attr[j] ?? [];
    for (let i = 0; i < row.length; i++) {
      const x = x0 + i;
      const y = y0 + j;
      terrain.cells.set(cellKey(x, y), row[i] ?? null);
      if (x < terrain.minX) terrain.minX = x;
      if (x > terrain.maxX) terrain.maxX = x;
      if (y < terrain.minY) terrain.minY = y;
      if (y > terrain.maxY) terrain.maxY = y;
    }
  }
  return terrain;
}

/** The merged terrain as a CellGrid the path searcher reads; unknown cells are impassable. */
export function worldGrid(terrain: WorldTerrain, center: Cell): CellGrid {
  const width = Math.max(0, terrain.maxX - terrain.minX + 1);
  const height = Math.max(0, terrain.maxY - terrain.minY + 1);
  const attr: (number | null)[][] = Array.from({ length: height }, () =>
    Array<number | null>(width).fill(null),
  );
  for (const [key, value] of terrain.cells) {
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma)) - terrain.minX;
    const y = Number(key.slice(comma + 1)) - terrain.minY;
    const row = attr[y];
    if (row !== undefined && x >= 0 && x < width) row[x] = value;
  }
  return { origin: [terrain.minX, terrain.minY], center, attr };
}

/** Whether a window centered here is already fully inside the known terrain. */
function windowKnown(terrain: WorldTerrain, center: Cell): boolean {
  return (
    center[0] - WORLD_RADIUS >= terrain.minX &&
    center[0] + WORLD_RADIUS <= terrain.maxX &&
    center[1] - WORLD_RADIUS >= terrain.minY &&
    center[1] + WORLD_RADIUS <= terrain.maxY
  );
}

/** Distance from a point to the segment from `from` to `to`, for corridor-first reading. */
function segmentDistance(point: Cell, from: Cell, to: Cell): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.abs(point[0] - from[0]) + Math.abs(point[1] - from[1]);
  }
  const t = Math.max(
    0,
    Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared),
  );
  const x = from[0] + t * dx;
  const y = from[1] + t * dy;
  return Math.abs(point[0] - x) + Math.abs(point[1] - y);
}

/**
 * Window centers that would extend the known map toward goal, corridor first and then to the
 * sides, so a plan can find a way around a range or a bay. Skips windows already known and
 * returns at most `limit`.
 */
export function windowCenters(
  terrain: WorldTerrain,
  from: Cell,
  goal: Cell,
  limit: number,
): Cell[] {
  if (limit <= 0) return [];
  const minX = Math.min(terrain.minX, goal[0]) - MARGIN;
  const maxX = Math.max(terrain.maxX, goal[0]) + MARGIN;
  const minY = Math.min(terrain.minY, goal[1]) - MARGIN;
  const maxY = Math.max(terrain.maxY, goal[1]) + MARGIN;
  const candidates: { center: Cell; distance: number; toGoal: number }[] = [];
  for (let x = minX; x <= maxX; x += WORLD_RADIUS) {
    for (let y = minY; y <= maxY; y += WORLD_RADIUS) {
      const center: Cell = [x, y];
      if (windowKnown(terrain, center)) continue;
      candidates.push({
        center,
        distance: segmentDistance(center, from, goal),
        toGoal: Math.abs(center[0] - goal[0]) + Math.abs(center[1] - goal[1]),
      });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance || left.toGoal - right.toGoal);
  return candidates.slice(0, limit).map((candidate) => candidate.center);
}

/**
 * Regions of an indoor map (task 75): the connected blocks of its collision data, with each
 * exit, landing and lift cell labelled by the block it belongs to. A map split in two by its
 * collision data (the Fire-Powered Ship's 255/256) is planned as two nodes, so the route does
 * not walk into a wall to learn that this half cannot use that door.
 *
 * The collision reply itself is cached per game and map, overwritten on every entry because
 * the story changes maps: `<dir>/<map>.json` holds the layers' rows and names and the bridge's
 * `searchLayer`. The cached file is only a hint; a live collision reply replaces it for the
 * map the party is on. The component search is nav.ts's layeredComponents, so stairs,
 * half-walls, recorded moves and task 73's trusted "走不过去" records are the same rules the
 * walk uses; task 70's hazard cells are passable but merged into the risky blocks only.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Atlas } from "./atlas.ts";
import {
  cellKey,
  layeredComponents,
  layeredGrid,
  type Cell,
  type DangerCell,
  type LayeredGrid,
  type ObservedMove,
} from "./nav.ts";
import { isMissingFile } from "./errors.ts";
import { BLOCKED_TRUST_COUNT } from "./skills/move.ts";
import { isRecord, type Json } from "./values.ts";

/** One collision reply reduced to what a region needs: layer names, rows and the start floor. */
export interface CollisionSnapshot {
  readonly name?: string;
  readonly searchLayer?: number;
  readonly layers: readonly { readonly name: string; readonly rows: readonly string[] }[];
}

/** Keep a bridge collision reply, or null when it has no usable layer. */
export function collisionSnapshot(value: unknown): CollisionSnapshot | null {
  if (!isRecord(value)) return null;
  const layers: { name: string; rows: string[] }[] = [];
  for (const layer of Array.isArray(value.layers) ? value.layers : []) {
    if (!isRecord(layer) || typeof layer.name !== "string" || !Array.isArray(layer.rows)) continue;
    if (!layer.rows.every((row) => typeof row === "string")) continue;
    layers.push({ name: layer.name, rows: [...layer.rows] });
  }
  if (layers.length === 0) return null;
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.searchLayer === "number"
      ? { searchLayer: Math.trunc(value.searchLayer) }
      : {}),
    layers,
  };
}

/**
 * The collision files of one game: `collision-<game>/<map>.json` beside the atlas. Reads all
 * files once (they are small) and overwrites one on each indoors entry. A malformed file is
 * discarded: the cache only saves bridge calls, a bad one must not stop the player.
 */
export class CollisionStore {
  readonly dir: string | undefined;
  private readonly snapshots = new Map<number, CollisionSnapshot>();

  private constructor(dir?: string) {
    this.dir = dir;
  }

  static async load(dir?: string, signal?: AbortSignal): Promise<CollisionStore> {
    const store = new CollisionStore(dir);
    if (dir === undefined) return store;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return store;
      throw new Error(`读不了碰撞缓存目录 ${dir}:${describe(error)}`, { cause: error });
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = Number(entry.name.slice(0, -".json".length));
      if (!Number.isInteger(id)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(dir, entry.name), { encoding: "utf8", signal }));
      } catch {
        signal?.throwIfAborted();
        continue; // a broken cache file is disposable; the next entry rewrites it
      }
      const snapshot = collisionSnapshot(parsed);
      if (snapshot !== null) store.snapshots.set(id, snapshot);
    }
    return store;
  }

  has(mapId: number): boolean {
    return this.snapshots.has(mapId);
  }

  get(mapId: number): CollisionSnapshot | undefined {
    return this.snapshots.get(mapId);
  }

  ids(): number[] {
    return [...this.snapshots.keys()];
  }

  /** Overwrite a map's collision; false when the reply had no usable layer or there is no dir. */
  async remember(mapId: number, collision: unknown): Promise<boolean> {
    const snapshot = collisionSnapshot(collision);
    if (snapshot === null || this.dir === undefined) return false;
    const changing = JSON.stringify(snapshot) !== JSON.stringify(this.snapshots.get(mapId));
    this.snapshots.set(mapId, snapshot);
    if (!changing) return true;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${mapId}.json`), JSON.stringify(snapshot, null, 1), "utf8");
    } catch (error) {
      throw new Error(`写不了碰撞缓存 ${join(this.dir, `${mapId}.json`)}:${describe(error)}`, {
        cause: error,
      });
    }
    return true;
  }
}

/** One block on a cell: the risky component (hazards allowed) and the safe one, if any. */
export interface RegionBlock {
  readonly id: string;
  readonly risky: number;
  readonly safe: number | null;
}

/** The blocks of one map, with cells labelled and reachability answered. */
export interface MapRegion {
  readonly mapId: number;
  /** The floor the collision reply named, when it did. */
  readonly layer: number | null;
  /** Every block on this cell; on a two-floor cell one per floor. Empty when off the grid. */
  blocksAt(cell: Cell, layer: number | null): RegionBlock[];
  /** Whether any of `from` reaches the cell, safely or only through a hazard (task 70). */
  reachable(
    from: readonly RegionBlock[],
    cell: Cell,
    layer: number | null,
  ): { readonly ok: boolean; readonly risky: boolean };
}

/** Cells that can carry the party away, from the moves the atlas recorded (task 70). */
function hazardCells(moves: readonly ObservedMove[]): DangerCell[] {
  const found = new Map<string, DangerCell>();
  for (const move of moves) {
    const kind = move.kind ?? "";
    const carries =
      kind === "conveyor" ||
      kind === "fall" ||
      move.how.includes("传送带") ||
      move.how.includes("掉下去");
    if (!carries) continue;
    found.set(cellKey(move.from[0], move.from[1]), {
      cell: move.from,
      layer: move.layer ?? null,
    });
  }
  return [...found.values()];
}

/**
 * Task 73: only a "走不过去" record hit `trust` times is a wall. The untrusted ones are still
 * walked through, so they must not split a map into two blocks.
 */
function trustedCuts(
  moves: readonly ObservedMove[],
  grid: LayeredGrid,
  trust: number,
): Map<number, Set<string>> {
  const cuts = new Map<number, Set<string>>();
  let base: number | null = null;
  for (const layer of grid.heights.keys()) {
    base = layer;
    break;
  }
  if (base === null) return cuts;
  for (const move of moves) {
    if (move.how !== "走不过去" || (move.count ?? 1) < trust) continue;
    const layer = move.layer ?? base;
    if (!grid.heights.has(layer)) continue;
    const set = cuts.get(layer) ?? new Set<string>();
    set.add(`${move.from[0]},${move.from[1]}>${move.to[0]},${move.to[1]}`);
    cuts.set(layer, set);
  }
  return cuts;
}

function nodeKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

class Region implements MapRegion {
  readonly mapId: number;
  readonly layer: number | null;
  private readonly grid: LayeredGrid;
  private readonly safe: ReadonlyMap<string, number>;
  private readonly risky: ReadonlyMap<string, number>;

  constructor(
    mapId: number,
    grid: LayeredGrid,
    safe: ReadonlyMap<string, number>,
    risky: ReadonlyMap<string, number>,
  ) {
    this.mapId = mapId;
    this.grid = grid;
    this.layer = grid.z;
    this.safe = safe;
    this.risky = risky;
  }

  blocksAt(cell: Cell, layer: number | null): RegionBlock[] {
    const layers =
      layer === null ? [...this.grid.heights.keys()] : this.grid.heights.has(layer) ? [layer] : [];
    const found = new Map<string, RegionBlock>();
    for (const z of layers) {
      const key = nodeKey(cell[0], cell[1], z);
      const risky = this.risky.get(key);
      if (risky === undefined) continue;
      const safe = this.safe.get(key) ?? null;
      const id = `${risky}:${safe ?? "-"}`;
      found.set(id, { id, risky, safe });
    }
    return [...found.values()];
  }

  reachable(
    from: readonly RegionBlock[],
    cell: Cell,
    layer: number | null,
  ): { readonly ok: boolean; readonly risky: boolean } {
    const target = this.blocksAt(cell, layer);
    // A cell the cached grid does not cover (an off-grid door, an older cache) is not evidence
    // of a wall; keep the optimistic "try it and see" of the old planner.
    if (target.length === 0 || from.length === 0) return { ok: true, risky: false };
    if (
      from.some((block) => block.safe !== null && target.some((other) => other.safe === block.safe))
    ) {
      return { ok: true, risky: false };
    }
    if (from.some((block) => target.some((other) => other.risky === block.risky))) {
      return { ok: true, risky: true };
    }
    return { ok: false, risky: false };
  }
}

function buildRegion(
  mapId: number,
  collision: CollisionSnapshot,
  center: Cell,
  moves: readonly ObservedMove[],
  trust: number,
): Region | null {
  const reply: Json = {
    ...collision,
    playerCell: [center[0], center[1]],
    layers: collision.layers.map((layer) => ({ name: layer.name, rows: [...layer.rows] })),
  };
  const grid = layeredGrid(reply, [], [], moves, hazardCells(moves));
  if (grid === null) return null;
  const cuts = trustedCuts(moves, grid, trust);
  const safe = layeredComponents(grid, new Set(), cuts, false);
  const risky = layeredComponents(grid, new Set(), cuts, true);
  return new Region(mapId, grid, safe, risky);
}

/**
 * The regions of the maps that have a cached collision. MapPath gets one of these so it can
 * stay synchronous; the cache is read once per travel call. A map without an entry falls back
 * to the pre-task-75 "whole map is one node" behaviour.
 */
export class RegionIndex {
  private readonly atlas: Atlas;
  private readonly trust: number;
  private readonly regions = new Map<number, Region>();

  private constructor(atlas: Atlas, trust: number) {
    this.atlas = atlas;
    this.trust = trust;
  }

  static create(atlas: Atlas, store?: CollisionStore, trust = BLOCKED_TRUST_COUNT): RegionIndex {
    const index = new RegionIndex(atlas, Math.max(1, Math.trunc(trust)));
    if (store === undefined) return index;
    const ids = new Set<number>(store.ids());
    for (const key of atlas.maps.keys()) {
      const id = Number(key);
      if (Number.isInteger(id)) ids.add(id);
    }
    for (const mapId of ids) {
      const snapshot = store.get(mapId);
      if (snapshot === undefined) continue;
      const region = buildRegion(mapId, snapshot, [-1, -1], atlas.moves(mapId), index.trust);
      if (region !== null) index.regions.set(mapId, region);
    }
    return index;
  }

  has(mapId: number): boolean {
    return this.regions.has(mapId);
  }

  region(mapId: number): MapRegion | undefined {
    return this.regions.get(mapId);
  }

  /** Replace a cached map with the live collision of the map the party is on (task 75). */
  setLive(mapId: number, collision: unknown, center: Cell): MapRegion | null {
    const snapshot = collisionSnapshot(collision);
    if (snapshot === null) return this.regions.get(mapId) ?? null;
    const region = buildRegion(mapId, snapshot, center, this.atlas.moves(mapId), this.trust);
    if (region === null) return this.regions.get(mapId) ?? null;
    this.regions.set(mapId, region);
    return region;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

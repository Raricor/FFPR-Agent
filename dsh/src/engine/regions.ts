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
 *
 * Task 123: a map the save has never entered has no cached collision, so the game files'
 * export (`.deps/knowledge/<game>/files/maps/<map>.json`, task 120) is the fallback source.
 * A live reply and then the cache stay authoritative because the story changes maps. The same
 * export supplies exits, damage floors and hidden passages; the damage cells become task 70
 * dangers and a hidden passage cell is opened in the fallback grid.
 *
 * Task 129: hidden passages from the game files are also attached to live and cached grids,
 * not only the fallback. They stay marked as passages so a plan uses ordinary floor first.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Atlas } from "./atlas.ts";
import {
  LAYER_Z,
  OPEN,
  cellKey,
  layeredComponents,
  layeredGrid,
  type Cell,
  type DangerCell,
  type LayeredGrid,
  type ObservedMove,
  type PassageCell,
} from "./nav.ts";
import { isMissingFile } from "./errors.ts";
import { BLOCKED_TRUST_COUNT } from "./skills/move.ts";
import { isRecord, records, text, type Json } from "./values.ts";
import {
  JUMP_DELTAS,
  isJumpMove,
  jumpMoves,
  type MapJump,
  type PassageFeatures,
} from "./knowledge/jumps.ts";

/** One collision reply reduced to what a region needs: layer names, rows and the start floor. */
export interface CollisionSnapshot {
  readonly name?: string;
  readonly searchLayer?: number;
  readonly layers: readonly { readonly name: string; readonly rows: readonly string[] }[];
  /** Task 129: hidden-passage cells from the game files, attached to every source. */
  readonly passages?: readonly PassageCell[];
}

const EMPTY_EVENT_CELLS: ReadonlySet<string> = new Set();

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

/** A world-map vehicle family; the task 120 export gives one passability grid each. */
export type WorldMode =
  "walk" | "chocobo" | "blackChocobo" | "ship" | "drake" | "airship" | "submarine";

/** Walking plus the ship is the default surface network; the story cannot always use a ship. */
export const SURFACE_WORLD_MODES: readonly WorldMode[] = ["walk", "ship"];

export const WORLD_MODES: readonly WorldMode[] = [
  "walk",
  "chocobo",
  "blackChocobo",
  "ship",
  "drake",
  "airship",
  "submarine",
];

/** One world-map arrival marker: a `ChangeMap` script's point number and the cell it names. */
interface GameWorldPoint {
  readonly point: number;
  readonly cell: Cell;
}

interface GameWorldMap {
  readonly width: number;
  readonly height: number;
  readonly modes: ReadonlyMap<WorldMode, readonly string[]>;
  readonly points: ReadonlyMap<number, GameWorldPoint>;
}

interface GameWorldExit {
  readonly to: number;
  readonly point: number;
}

/** One exit the game files give a map (task 120): target map and the target's point id. */
export interface GameMapExit {
  readonly cell: Cell;
  readonly to: number;
  /** The target map's point (PointIn) id; null when the object had none. */
  readonly toPoint: number | null;
  readonly name: string;
}

interface GameMapPoint {
  readonly cell: Cell;
  readonly id: number | null;
  readonly point: number | null;
  readonly name: string;
}

interface GameMapLayer {
  readonly name: string;
  readonly rows: readonly string[];
}

interface GameMapValueCell {
  readonly cell: Cell;
  readonly value: number;
}

interface GameMapValueLayer {
  readonly name: string;
  readonly cells: readonly GameMapValueCell[];
}

/** One story/event trigger from the game file export (task 143). */
interface GameMapEvent {
  readonly cell: Cell;
  readonly name: string;
  readonly file: string;
}

/**
 * The task 120 export of one map. Only the fields the route needs are kept: collision rows
 * (raw values 0-7), exits with their target point, damage and hidden-passage cells.
 */
interface GameMapFile {
  readonly id: number;
  readonly collision: readonly GameMapLayer[];
  readonly damage: readonly GameMapValueLayer[];
  readonly hiddenPassages: readonly GameMapValueLayer[];
  readonly exits: readonly GameMapExit[];
  readonly points: readonly GameMapPoint[];
  readonly events: readonly GameMapEvent[];
  /** Task 149: script-moved jumps from the map export. */
  readonly jumps: readonly MapJump[];
  readonly world?: GameWorldMap;
  readonly worldExits: readonly GameWorldExit[];
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readCell(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = integer(value[0]);
  const y = integer(value[1]);
  return x === null || y === null ? null : [x, y];
}

function gameLayers(value: unknown): GameMapLayer[] {
  const layers: GameMapLayer[] = [];
  for (const layer of records(value)) {
    const name = text(layer.name) ?? "";
    if (!Array.isArray(layer.rows)) continue;
    const rows = layer.rows.filter((row): row is string => typeof row === "string");
    if (rows.length === 0) continue;
    layers.push({ name, rows: [...rows] });
  }
  return layers;
}

function gameValueLayers(value: unknown): GameMapValueLayer[] {
  const layers: GameMapValueLayer[] = [];
  for (const layer of records(value)) {
    const name = text(layer.name) ?? "";
    const cells: GameMapValueCell[] = [];
    for (const entry of Array.isArray(layer.cells) ? layer.cells : []) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const x = integer(entry[0]);
      const y = integer(entry[1]);
      const cellValue = integer(entry[2]);
      if (x === null || y === null || cellValue === null || cellValue === 0) continue;
      cells.push({ cell: [x, y], value: cellValue });
    }
    layers.push({ name, cells });
  }
  return layers;
}

function gameExits(value: unknown): GameMapExit[] {
  const exits: GameMapExit[] = [];
  for (const exit of records(value)) {
    const cell = readCell(exit.cell);
    const to = integer(exit.toMap);
    if (cell === null || to === null || to <= 0) continue;
    exits.push({ cell, to, toPoint: integer(exit.toPoint), name: text(exit.name) ?? "" });
  }
  return exits;
}

/** PointIn objects, when an export carries them; the current task 120 files do not. */
function gamePoints(value: unknown): GameMapPoint[] {
  const points: GameMapPoint[] = [];
  if (!isRecord(value)) return points;
  for (const key of ["pointIns", "points", "point_ins"]) {
    const entries = value[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const cell = readCell(entry.cell);
      if (cell === null) continue;
      points.push({
        cell,
        id: integer(entry.id),
        point: integer(entry.point) ?? integer(entry.pointId) ?? integer(entry.point_id),
        name: text(entry.name) ?? "",
      });
    }
    if (points.length > 0) break;
  }
  return points;
}

/** Story/event trigger cells; any of them may be walked over, so they must not be walls. */
function gameEvents(value: unknown): GameMapEvent[] {
  const events: GameMapEvent[] = [];
  for (const entry of records(value)) {
    const cell = readCell(entry.cell);
    if (cell === null) continue;
    events.push({
      cell,
      name: text(entry.name) ?? "",
      file: text(entry.file) ?? "",
    });
  }
  return events;
}

function gameWorld(value: unknown): GameWorldMap | undefined {
  if (!isRecord(value)) return undefined;
  const width = integer(value.width);
  const height = integer(value.height);
  if (width === null || height === null || width <= 0 || height <= 0) return undefined;
  const modes = new Map<WorldMode, readonly string[]>();
  if (isRecord(value.modes)) {
    for (const mode of WORLD_MODES) {
      const rows = value.modes[mode];
      if (!Array.isArray(rows)) continue;
      const strings = rows.filter((row): row is string => typeof row === "string");
      if (strings.length !== height || strings.some((row) => row.length !== width)) continue;
      modes.set(mode, [...strings]);
    }
  }
  if (modes.size === 0) return undefined;
  const points = new Map<number, GameWorldPoint>();
  for (const entry of records(value.points)) {
    const point = integer(entry.point);
    const cell = readCell(entry.cell);
    if (point === null || point <= 0 || cell === null) continue;
    points.set(point, { point, cell });
  }
  return { width, height, modes, points };
}

function gameWorldExits(value: unknown): GameWorldExit[] {
  const exits: GameWorldExit[] = [];
  for (const entry of records(value)) {
    const to = integer(entry.to);
    const point = integer(entry.point);
    if (to === null || to <= 0 || point === null || point <= 0) continue;
    exits.push({ to, point });
  }
  return exits;
}

function gameJumps(value: unknown): MapJump[] {
  const jumps: MapJump[] = [];
  for (const entry of records(value)) {
    const cell = readCell(entry.cell);
    const land = readCell(entry.land);
    const kind = text(entry.kind);
    const facing = text(entry.facing) ?? "";
    const script = text(entry.script) ?? "";
    if (
      cell === null ||
      land === null ||
      (kind !== "step" && kind !== "touch") ||
      facing === "" ||
      !(facing in JUMP_DELTAS)
    ) {
      continue;
    }
    jumps.push({ cell, land, kind, facing: facing as keyof typeof JUMP_DELTAS, script });
  }
  return jumps;
}

function gameMapFile(value: unknown, fallbackId: number): GameMapFile | null {
  if (!isRecord(value)) return null;
  const id = integer(value.id) ?? fallbackId;
  if (id <= 0) return null;
  const world = gameWorld(value.world);
  return {
    id,
    collision: gameLayers(value.collision),
    damage: gameValueLayers(value.damage),
    hiddenPassages: gameValueLayers(value.hiddenPassages),
    exits: gameExits(value.exits),
    points: gamePoints(value),
    events: gameEvents(value.events),
    jumps: gameJumps(value.jumps),
    ...(world === undefined ? {} : { world }),
    worldExits: gameWorldExits(value.worldExits),
  };
}

/** `GroundHiddenPassage` opens cells in `GroundCollision`; `GroundDamage` is on that floor. */
function collisionNameFor(valueName: string): string {
  if (valueName.endsWith("HiddenPassage")) {
    return `${valueName.slice(0, -"HiddenPassage".length)}Collision`;
  }
  if (valueName.endsWith("Damage")) {
    return `${valueName.slice(0, -"Damage".length)}Collision`;
  }
  return "Collision";
}

function layerHeight(name: string): number | null {
  return LAYER_Z.get(collisionNameFor(name)) ?? null;
}

/** The starting floor of a map only the game files know. */
function defaultSearchLayer(layers: readonly GameMapLayer[]): number {
  const names = new Set(layers.map((layer) => layer.name));
  if (names.has("GroundCollision")) return LAYER_Z.get("GroundCollision") ?? 1;
  if (names.has("BottomCollision")) return LAYER_Z.get("BottomCollision") ?? 0;
  if (names.has("UpperCollision")) return LAYER_Z.get("UpperCollision") ?? 2;
  if (names.has("TopCollision")) return LAYER_Z.get("TopCollision") ?? 2;
  const first = layers[0];
  return first === undefined ? 0 : (LAYER_Z.get(first.name) ?? 0);
}

function setRowCell(rows: string[], x: number, y: number, value: string): void {
  const row = rows[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  rows[y] = `${row.slice(0, x)}${value}${row.slice(x + 1)}`;
}

/** Hidden-passage cells are walkable: open them in the fallback collision rows. */
function openHiddenPassages(layers: GameMapLayer[], hidden: readonly GameMapValueLayer[]): void {
  for (const passage of hidden) {
    if (passage.cells.length === 0) continue;
    const wanted = collisionNameFor(passage.name);
    let index = layers.findIndex((layer) => layer.name === wanted);
    if (index < 0 && layers.length === 1) index = 0;
    const layer = layers[index];
    if (layer === undefined) continue;
    const rows = [...layer.rows];
    for (const entry of passage.cells) {
      setRowCell(rows, entry.cell[0], entry.cell[1], "0");
    }
    layers[index] = { name: layer.name, rows };
  }
}

/** Task 129: hidden-passage cells with the height their layer names. */
function passageCells(file: GameMapFile): PassageCell[] {
  const found = new Map<string, PassageCell>();
  for (const layer of file.hiddenPassages) {
    const height = layerHeight(layer.name);
    for (const entry of layer.cells) {
      const key = `${entry.cell[0]},${entry.cell[1]}:${height ?? "*"}`;
      found.set(key, { cell: entry.cell, layer: height });
    }
  }
  return [...found.values()];
}

function snapshotFromFile(file: GameMapFile): CollisionSnapshot | null {
  if (file.collision.length === 0) return null;
  const layers = file.collision.map((layer) => ({ name: layer.name, rows: [...layer.rows] }));
  openHiddenPassages(layers, file.hiddenPassages);
  const passages = passageCells(file);
  return {
    searchLayer: defaultSearchLayer(layers),
    layers,
    ...(passages.length === 0 ? {} : { passages }),
  };
}

/** The floor a landing cell is open on, for a map only the game files know. */
function fileLayerAt(file: GameMapFile, cell: Cell): number | null {
  for (const name of ["GroundCollision", "BottomCollision", "UpperCollision", "TopCollision"]) {
    const layer = file.collision.find((candidate) => candidate.name === name);
    const row = layer?.rows[cell[1]];
    if (row !== undefined && OPEN.has(row[cell[0]] ?? "")) {
      return LAYER_Z.get(name) ?? null;
    }
  }
  for (const layer of file.collision) {
    const row = layer.rows[cell[1]];
    if (row !== undefined && OPEN.has(row[cell[0]] ?? "")) {
      return LAYER_Z.get(layer.name) ?? null;
    }
  }
  return null;
}

function damageCells(file: GameMapFile): DangerCell[] {
  const found = new Map<string, DangerCell>();
  for (const layer of file.damage) {
    const height = layerHeight(layer.name);
    for (const entry of layer.cells) {
      const key = `${entry.cell[0]},${entry.cell[1]}:${height ?? "*"}`;
      found.set(key, { cell: entry.cell, layer: height });
    }
  }
  return [...found.values()];
}

interface WorldZoneData {
  readonly width: number;
  readonly height: number;
  /** One component-labelled grid per vehicle mode; -1 where that vehicle cannot stand. */
  readonly labels: readonly Int32Array[];
  /** Union-find over component labels, joining modes that can transfer at a shared/adjacent cell. */
  readonly parent: Int32Array;
}

/** Connected components of one vehicle's passability rows. */
function worldLabels(rows: readonly string[], width: number, height: number): Int32Array {
  const labels = new Int32Array(width * height).fill(-1);
  let next = 0;
  for (const start of labels.keys()) {
    if ((labels[start] ?? -1) >= 0 || rows[Math.floor(start / width)]?.[start % width] !== "1")
      continue;
    const queue: number[] = [start];
    labels[start] = next;
    // Appending to the queue during its iteration is the BFS frontier.
    for (const index of queue) {
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbours = [
        x + 1 < width ? index + 1 : -1,
        x > 0 ? index - 1 : -1,
        y + 1 < height ? index + width : -1,
        y > 0 ? index - width : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || (labels[neighbour] ?? -1) >= 0) continue;
        if (rows[Math.floor(neighbour / width)]?.[neighbour % width] !== "1") continue;
        labels[neighbour] = next;
        queue.push(neighbour);
      }
    }
    next += 1;
  }
  return labels;
}

function worldRoot(parent: Int32Array, value: number): number {
  let root = value;
  while (parent[root] !== root) root = parent[root] ?? root;
  let current = value;
  while (parent[current] !== root) {
    const next = parent[current] ?? root;
    parent[current] = root;
    current = next;
  }
  return root;
}

function worldUnion(parent: Int32Array, left: number, right: number): void {
  const a = worldRoot(parent, left);
  const b = worldRoot(parent, right);
  if (a !== b) parent[b] = a;
}

/**
 * The world-map graph for a set of vehicles: each mode's connected blocks, then a union across
 * modes wherever the party can transfer. A shared cell is a transfer; so is an adjacent cell,
 * which is how a ship at sea reaches the coast it docks on.
 */
function worldZones(world: GameWorldMap, modes: readonly WorldMode[]): WorldZoneData | null {
  const labels: Int32Array[] = [];
  let count = 0;
  for (const mode of modes) {
    const rows = world.modes.get(mode);
    if (rows === undefined) continue;
    const grid = worldLabels(rows, world.width, world.height);
    // 11-11: every mode numbers its components from 0. Shifting each grid by the components
    // seen so far keeps two vehicles' unrelated blocks from sharing a union-find root (a walk
    // island and a ship lane both called 0), which made the same world cell change zone with
    // the selected vehicle set and hid the route from the chocobo to the cave.
    let own = 0;
    for (const label of grid) if (label >= own) own = label + 1;
    for (let index = 0; index < grid.length; index += 1) {
      const label = grid[index];
      if (label !== undefined && label >= 0) grid[index] = label + count;
    }
    labels.push(grid);
    count += own;
  }
  if (labels.length === 0) return null;
  const parent = new Int32Array(count);
  for (let index = 0; index < count; index += 1) parent[index] = index;
  // A cell that two vehicles can stand on, or the four-neighbour edge between their cells,
  // is a transfer point.
  for (let left = 0; left < labels.length; left += 1) {
    const first = labels[left];
    if (first === undefined) continue;
    for (let right = left + 1; right < labels.length; right += 1) {
      const second = labels[right];
      if (second === undefined) continue;
      for (let index = 0; index < first.length; index += 1) {
        const a = first[index] ?? -1;
        if (a < 0) continue;
        const x = index % world.width;
        const y = Math.floor(index / world.width);
        const neighbours = [
          index,
          x + 1 < world.width ? index + 1 : -1,
          x > 0 ? index - 1 : -1,
          y + 1 < world.height ? index + world.width : -1,
          y > 0 ? index - world.width : -1,
        ];
        for (const neighbour of neighbours) {
          if (neighbour < 0) continue;
          const b = second[neighbour] ?? -1;
          if (b >= 0) worldUnion(parent, a, b);
        }
      }
    }
  }
  return { width: world.width, height: world.height, labels, parent };
}

/**
 * Task 129: attach the game files' hidden passages to a live or cached snapshot. The rows stay
 * as the bridge read them; nav.ts opens only the marked cells when a plan needs them.
 */
function mergePassages(
  snapshot: CollisionSnapshot,
  passages: readonly PassageCell[],
): CollisionSnapshot {
  if (passages.length === 0 || snapshot.passages !== undefined) return snapshot;
  return { ...snapshot, passages: [...passages] };
}

/**
 * The collision files of one game: `collision-<game>/<map>.json` beside the atlas. Reads all
 * files once (they are small) and overwrites one on each indoors entry. A malformed file is
 * discarded: the cache only saves bridge calls, a bad one must not stop the player.
 *
 * Task 123: a third directory, the task 120 map export, is read once too and used only for
 * maps the cache does not have. Live replies and cached files therefore keep winning.
 */
export class CollisionStore {
  readonly dir: string | undefined;
  readonly gameDir: string | undefined;
  private readonly snapshots = new Map<number, CollisionSnapshot>();
  private readonly files = new Map<number, GameMapFile>();
  private readonly fileSnapshots = new Map<number, CollisionSnapshot | null>();
  private readonly zones = new Map<string, WorldZoneData | null>();
  private readonly passageCache = new Map<number, PassageFeatures>();

  private constructor(dir?: string, gameDir?: string) {
    this.dir = dir;
    this.gameDir = gameDir;
  }

  static async load(dir?: string, signal?: AbortSignal, gameDir?: string): Promise<CollisionStore> {
    const store = new CollisionStore(dir, gameDir);
    await store.loadCache(signal);
    await store.loadGameFiles(signal);
    return store;
  }

  private async loadCache(signal?: AbortSignal): Promise<void> {
    if (this.dir === undefined) return;
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new Error(`读不了碰撞缓存目录 ${this.dir}:${describe(error)}`, { cause: error });
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = Number(entry.name.slice(0, -".json".length));
      if (!Number.isInteger(id)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(join(this.dir, entry.name), { encoding: "utf8", signal }),
        );
      } catch {
        signal?.throwIfAborted();
        continue; // a broken cache file is disposable; the next entry rewrites it
      }
      const snapshot = collisionSnapshot(parsed);
      if (snapshot !== null) this.snapshots.set(id, snapshot);
    }
  }

  private async loadGameFiles(signal?: AbortSignal): Promise<void> {
    if (this.gameDir === undefined) return;
    let entries;
    try {
      entries = await readdir(this.gameDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return; // other games and tests have no export
      throw new Error(`读不了游戏文件目录 ${this.gameDir}:${describe(error)}`, { cause: error });
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = Number(entry.name.slice(0, -".json".length));
      if (!Number.isInteger(id) || id <= 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(join(this.gameDir, entry.name), { encoding: "utf8", signal }),
        );
      } catch {
        signal?.throwIfAborted();
        continue;
      }
      const file = gameMapFile(parsed, id);
      if (file !== null) this.files.set(file.id, file);
    }
  }

  has(mapId: number): boolean {
    return this.snapshots.has(mapId) || this.files.has(mapId);
  }

  /** The live/cached collision, else the game files' conversion; undefined without either. */
  get(mapId: number): CollisionSnapshot | undefined {
    const cached = this.snapshots.get(mapId);
    if (cached !== undefined) return mergePassages(cached, this.passages(mapId));
    if (this.fileSnapshots.has(mapId)) {
      const snapshot = this.fileSnapshots.get(mapId);
      return snapshot === null || snapshot === undefined
        ? undefined
        : mergePassages(snapshot, this.passages(mapId));
    }
    const file = this.files.get(mapId);
    if (file === undefined) return undefined;
    const snapshot = snapshotFromFile(file);
    this.fileSnapshots.set(mapId, snapshot);
    return snapshot === null ? undefined : mergePassages(snapshot, this.passages(mapId));
  }

  /** Cache ids only: the game files have hundreds and regions are built when asked. */
  ids(): number[] {
    return [...this.snapshots.keys()];
  }

  /** Maps the game file export knows; a route may pass through these before visiting them. */
  fileIds(): number[] {
    return [...this.files.keys()];
  }

  hasFile(mapId: number): boolean {
    return this.files.has(mapId);
  }

  /** Whether the export has a world-map terrain grid for this map (task 123). */
  hasWorld(mapId: number): boolean {
    return this.files.get(mapId)?.world !== undefined;
  }

  /** The vehicle modes a world map export carries. */
  worldModes(mapId: number): readonly WorldMode[] {
    const world = this.files.get(mapId)?.world;
    return world === undefined ? [] : [...world.modes.keys()];
  }

  /** The world-map arrival cell a `ChangeMap` point names. */
  worldPoint(mapId: number, point: number): Cell | null {
    return this.files.get(mapId)?.world?.points.get(point)?.cell ?? null;
  }

  /**
   * The world-map component a cell belongs to under `modes`, or null when none of those
   * vehicles can stand there. Components are unioned where the modes can transfer.
   */
  worldZone(mapId: number, modes: readonly WorldMode[], cell: Cell): number | null {
    const data = this.zoneData(mapId, modes);
    if (data === null) return null;
    const index = cell[1] * data.width + cell[0];
    if (cell[0] < 0 || cell[1] < 0 || cell[0] >= data.width || cell[1] >= data.height) return null;
    let root = -1;
    for (const labels of data.labels) {
      const label = labels[index];
      if (label === undefined || label < 0) continue;
      const found = worldRoot(data.parent, label);
      if (root < 0 || found < root) root = found;
    }
    return root < 0 ? null : root;
  }

  private zoneData(mapId: number, modes: readonly WorldMode[]): WorldZoneData | null {
    const world = this.files.get(mapId)?.world;
    if (world === undefined) return null;
    const selected = [...new Set(modes)].filter((mode) => world.modes.has(mode));
    if (selected.length === 0) return null;
    const key = `${mapId}|${selected.join(",")}`;
    if (this.zones.has(key)) return this.zones.get(key) ?? null;
    const data = worldZones(world, selected);
    this.zones.set(key, data);
    return data;
  }

  /** The game files' exits for a map (empty when the map has no export). */
  exits(mapId: number): readonly GameMapExit[] {
    return this.files.get(mapId)?.exits ?? [];
  }

  /** Task 149: script-moved jumps from the map export (empty without one). */
  jumps(mapId: number): readonly MapJump[] {
    return this.files.get(mapId)?.jumps ?? [];
  }

  /** Story/event trigger cells from the game files (task 143), as cellKey strings. */
  eventCells(mapId: number): ReadonlySet<string> {
    const events = this.files.get(mapId)?.events;
    if (events === undefined || events.length === 0) return EMPTY_EVENT_CELLS;
    return new Set(events.map((event) => cellKey(event.cell[0], event.cell[1])));
  }

  /**
   * Task 129: hidden-passage cells with their floor, from the game files. These are merged
   * into every collision source: live replies and cache rows still have the wall there.
   */
  passages(mapId: number): PassageFeatures {
    const found = this.passageCache.get(mapId);
    if (found !== undefined) return found;
    const file = this.files.get(mapId);
    const cells = file === undefined ? [] : passageCells(file);
    // Task 149: the walk receives the map's jumps through this same callback. It is the one
    // game-file hook game.ts already wires into MoveState, so no new hook is needed.
    const features = Object.assign(cells, { jumps: this.jumps(mapId) }) as PassageFeatures;
    this.passageCache.set(mapId, features);
    return features;
  }

  /** Hidden-passage cells the game files mark on a map, for callers that want to show them. */
  hiddenPassages(mapId: number): Cell[] {
    return this.passages(mapId).map((passage) => passage.cell);
  }

  /** Task 70: damage floors from the game files, on the floor their layer names. */
  dangers(mapId: number): DangerCell[] {
    const file = this.files.get(mapId);
    return file === undefined ? [] : damageCells(file);
  }

  /**
   * Where a game-file exit lands (`point_id`). The export's PointIn list, when present, is
   * exact; otherwise the target map's own exit back to this map names the same point and its
   * GotoMap cell is used (the PointIn is usually the adjacent landing cell).
   */
  exitLanding(sourceMap: number, exit: GameMapExit): { cell: Cell; layer: number | null } | null {
    const targetWorldFile = this.files.get(exit.to);
    const world = targetWorldFile?.world;
    if (world !== undefined && targetWorldFile !== undefined) {
      const source = this.files.get(sourceMap);
      const fromScript = source?.worldExits.find((candidate) => candidate.to === exit.to);
      const point = fromScript?.point ?? exit.toPoint;
      const cell = point === null ? null : (world.points.get(point)?.cell ?? null);
      if (cell !== null) return { cell, layer: fileLayerAt(targetWorldFile, cell) };
    }
    if (exit.toPoint === null) return null;
    const target = this.files.get(exit.to);
    if (target === undefined) return null;
    const point = pointFor(target.points, exit.toPoint);
    if (point !== null) {
      return { cell: point.cell, layer: fileLayerAt(target, point.cell) };
    }
    const back = target.exits.filter((candidate) => candidate.to === sourceMap);
    const exact = back.find((candidate) => candidate.toPoint === exit.toPoint);
    const samePoint = target.exits.filter((candidate) => candidate.toPoint === exit.toPoint);
    const landing =
      exact ?? (back.length === 1 ? back[0] : samePoint.length === 1 ? samePoint[0] : undefined);
    if (landing === undefined) return null;
    return { cell: landing.cell, layer: fileLayerAt(target, landing.cell) };
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

/**
 * `point_id` numbers a map's PointIn objects, not their cells directly. An export that carries
 * PointIn objects may name the number; the task 120 export does not, so a one-based index over
 * the non-fall points is the fallback.
 */
function pointFor(points: readonly GameMapPoint[], toPoint: number): GameMapPoint | null {
  const named = points.find((point) => point.point === toPoint);
  if (named !== undefined) return named;
  const regular = points.filter((point) => !point.name.includes("落下点"));
  const indexed = regular[toPoint - 1];
  if (indexed !== undefined) return indexed;
  return points.find((point) => point.id === toPoint) ?? null;
}

/** One block on a cell: the risky component (hazards allowed) and the safe one, if any. */
export interface RegionBlock {
  readonly id: string;
  readonly risky: number;
  readonly safe: number | null;
  /** Task 129: the component when hidden passages are allowed; null when the cell is off-grid. */
  readonly passage: number | null;
}

/** The blocks of one map, with cells labelled and reachability answered. */
export interface MapRegion {
  readonly mapId: number;
  /** The floor the collision reply named, when it did. */
  readonly layer: number | null;
  /** Every block on this cell; on a two-floor cell one per floor. Empty when off the grid. */
  blocksAt(cell: Cell, layer: number | null): RegionBlock[];
  /**
   * Whether any of `from` reaches the cell: safely, only through a hidden passage (task 129),
   * or only through a hazard (task 70).
   */
  reachable(
    from: readonly RegionBlock[],
    cell: Cell,
    layer: number | null,
  ): { readonly ok: boolean; readonly risky: boolean; readonly passage?: boolean };
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
 *
 * Task 143: a refusal while standing on a story event is the event starting, not a wall.
 * The game's event cells (`ev_e_` / `sc_e_`, or any Event with a script) may always be walked
 * over; only recorded refusals elsewhere split the map.
 */
function trustedCuts(
  moves: readonly ObservedMove[],
  grid: LayeredGrid,
  trust: number,
  eventCells: ReadonlySet<string> = EMPTY_EVENT_CELLS,
): Map<number, Set<string>> {
  const cuts = new Map<number, Set<string>>();
  let base: number | null = null;
  for (const layer of grid.heights.keys()) {
    base = layer;
    break;
  }
  if (base === null) return cuts;
  const center = cellKey(grid.center[0], grid.center[1]);
  for (const move of moves) {
    if (move.how !== "走不过去" || (move.count ?? 1) < trust) continue;
    const from = cellKey(move.from[0], move.from[1]);
    const to = cellKey(move.to[0], move.to[1]);
    // The cell the party stands on is always part of its block, and an event trigger under
    // its feet is a story start, not a wall.
    if (from === center || to === center) continue;
    if (eventCells.has(from) || eventCells.has(to)) continue;
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

/** A directed "调查后跳" edge between two components, for the region reachability test. */
function jumpEdges(
  moves: readonly ObservedMove[],
  grid: LayeredGrid,
  blocks: ReadonlyMap<string, number>,
): Map<number, number[]> {
  const edges = new Map<number, number[]>();
  for (const move of moves) {
    if (!move.how.includes("调查后跳")) continue;
    const fromLayers = move.layer === undefined ? [...grid.heights.keys()] : [move.layer];
    for (const fromLayer of fromLayers) {
      const from = blocks.get(nodeKey(move.from[0], move.from[1], fromLayer));
      if (from === undefined) continue;
      // Without a recorded layer the jump stays on the floor it started from, as layeredRoute
      // does; only an explicit toLayer changes it.
      const toLayer = move.toLayer ?? fromLayer;
      const to = blocks.get(nodeKey(move.to[0], move.to[1], toLayer));
      if (to === undefined) continue;
      const list = edges.get(from) ?? [];
      if (!list.includes(to)) list.push(to);
      edges.set(from, list);
    }
  }
  return edges;
}

/** Whether a directed jump path from any of `from` reaches any of `target`. */
function jumpReaches(
  edges: ReadonlyMap<number, readonly number[]>,
  from: readonly number[],
  target: readonly number[],
): boolean {
  if (from.length === 0 || target.length === 0) return false;
  const seen = new Set<number>(from);
  const queue = [...from];
  // The array iterator sees items appended during the loop, so this is a growing BFS.
  for (const id of queue) {
    for (const next of edges.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return target.some((id) => seen.has(id));
}

class Region implements MapRegion {
  readonly mapId: number;
  readonly layer: number | null;
  private readonly grid: LayeredGrid;
  private readonly safe: ReadonlyMap<string, number>;
  private readonly passage: ReadonlyMap<string, number>;
  private readonly risky: ReadonlyMap<string, number>;
  private readonly safeJumps: ReadonlyMap<number, readonly number[]>;
  private readonly passageJumps: ReadonlyMap<number, readonly number[]>;
  private readonly riskyJumps: ReadonlyMap<number, readonly number[]>;

  constructor(
    mapId: number,
    grid: LayeredGrid,
    safe: ReadonlyMap<string, number>,
    passage: ReadonlyMap<string, number>,
    risky: ReadonlyMap<string, number>,
    jumps: readonly ObservedMove[],
  ) {
    this.mapId = mapId;
    this.grid = grid;
    this.layer = grid.z;
    this.safe = safe;
    this.passage = passage;
    this.risky = risky;
    this.safeJumps = jumpEdges(jumps, grid, safe);
    this.passageJumps = jumpEdges(jumps, grid, passage);
    this.riskyJumps = jumpEdges(jumps, grid, risky);
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
      const passage = this.passage.get(key) ?? null;
      const id = `${risky}:${safe ?? "-"}`;
      found.set(id, { id, risky, safe, passage });
    }
    return [...found.values()];
  }

  reachable(
    from: readonly RegionBlock[],
    cell: Cell,
    layer: number | null,
  ): { readonly ok: boolean; readonly risky: boolean; readonly passage?: boolean } {
    const target = this.blocksAt(cell, layer);
    // A cell the cached grid does not cover (an off-grid door, an older cache) is not evidence
    // of a wall; keep the optimistic "try it and see" of the old planner.
    if (target.length === 0 || from.length === 0) return { ok: true, risky: false };
    const fromSafe = from.flatMap((block) => (block.safe === null ? [] : [block.safe]));
    const targetSafe = target.flatMap((block) => (block.safe === null ? [] : [block.safe]));
    if (
      fromSafe.some((id) => targetSafe.includes(id)) ||
      jumpReaches(this.safeJumps, fromSafe, targetSafe)
    ) {
      return { ok: true, risky: false };
    }
    // Task 129: an ordinary way failed, but a hidden passage may still connect the two.
    const fromPassage = from.flatMap((block) => (block.passage === null ? [] : [block.passage]));
    const targetPassage = target.flatMap((block) =>
      block.passage === null ? [] : [block.passage],
    );
    if (
      fromPassage.some((id) => targetPassage.includes(id)) ||
      jumpReaches(this.passageJumps, fromPassage, targetPassage)
    ) {
      return { ok: true, risky: false, passage: true };
    }
    const fromRisky = from.map((block) => block.risky);
    const targetRisky = target.map((block) => block.risky);
    if (
      fromRisky.some((id) => targetRisky.includes(id)) ||
      jumpReaches(this.riskyJumps, fromRisky, targetRisky)
    ) {
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
  dangers: readonly DangerCell[] = [],
  eventCells: ReadonlySet<string> = EMPTY_EVENT_CELLS,
  jumps: readonly MapJump[] = [],
): Region | null {
  const reply: Json = {
    ...collision,
    playerCell: [center[0], center[1]],
    layers: collision.layers.map((layer) => ({ name: layer.name, rows: [...layer.rows] })),
  };
  // Task 123: damage floors from the game files join the walked hazards (task 70). A
  // "调查后跳" link is directed, so it must not merge two components; it is added as a
  // directed component edge instead, or the jump would look walkable both ways.
  const hazards = [...hazardCells(moves), ...dangers];
  const allMoves = [...moves, ...jumpMoves(jumps)];
  const jumpLinks = allMoves.filter(isJumpMove);
  const walkMoves = allMoves.filter((move) => !isJumpMove(move));
  const grid = layeredGrid(reply, [], [], walkMoves, hazards, eventCells);
  if (grid === null) return null;
  const cuts = trustedCuts(moves, grid, trust, eventCells);
  const safe = layeredComponents(grid, new Set(), cuts, false, false);
  const passage = layeredComponents(grid, new Set(), cuts, false, true);
  const risky = layeredComponents(grid, new Set(), cuts, true, true);
  return new Region(mapId, grid, safe, passage, risky, jumpLinks);
}

/**
 * The regions of the maps that have a cached collision. MapPath gets one of these so it can
 * stay synchronous; the cache is read once per travel call. A map without an entry falls back
 * to the game files, or to the pre-task-75 "whole map is one node" behaviour; a map the files
 * know is built when the route asks for it, not up front for all 600+ maps.
 */
export class RegionIndex {
  readonly source: CollisionStore | undefined;
  private readonly atlas: Atlas;
  private readonly trust: number;
  private readonly regions = new Map<number, Region>();

  private constructor(atlas: Atlas, trust: number, source?: CollisionStore) {
    this.atlas = atlas;
    this.trust = trust;
    this.source = source;
  }

  static create(atlas: Atlas, store?: CollisionStore, trust = BLOCKED_TRUST_COUNT): RegionIndex {
    // 11-11: build a map's region on first use. Prebuilding every cached map cost about 25 ms
    // per analyzeRoute call when the route executor asks for one pair at a time; `region`
    // already memoises, so a lazy index is the same object graph with fewer wasted grids.
    return new RegionIndex(atlas, Math.max(1, Math.trunc(trust)), store);
  }

  has(mapId: number): boolean {
    return this.region(mapId) !== undefined;
  }

  region(mapId: number): MapRegion | undefined {
    const known = this.regions.get(mapId);
    if (known !== undefined) return known;
    const snapshot = this.source?.get(mapId);
    if (snapshot === undefined) return undefined;
    const region = buildRegion(
      mapId,
      snapshot,
      [-1, -1],
      this.atlas.moves(mapId),
      this.trust,
      this.source?.dangers(mapId) ?? [],
      this.source?.eventCells(mapId) ?? EMPTY_EVENT_CELLS,
      this.source?.jumps(mapId) ?? [],
    );
    if (region !== null) this.regions.set(mapId, region);
    return region ?? undefined;
  }

  /** Replace a cached map with the live collision of the map the party is on (task 75). */
  setLive(mapId: number, collision: unknown, center: Cell): MapRegion | null {
    const parsed = collisionSnapshot(collision);
    if (parsed === null) return this.regions.get(mapId) ?? null;
    const snapshot = mergePassages(parsed, this.source?.passages(mapId) ?? []);
    const region = buildRegion(
      mapId,
      snapshot,
      center,
      this.atlas.moves(mapId),
      this.trust,
      this.source?.dangers(mapId) ?? [],
      this.source?.eventCells(mapId) ?? EMPTY_EVENT_CELLS,
      this.source?.jumps(mapId) ?? [],
    );
    if (region === null) return this.regions.get(mapId) ?? null;
    this.regions.set(mapId, region);
    return region;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

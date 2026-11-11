/**
 * Per-map completion (task 45): every chest, hidden item and monster in the current map (world
 * map: current encounter region) before the player leaves, plus the backlog of deliberate
 * incomplete departures and the incidents of one-time places that were truly missed.
 *
 * The data comes from the bridge: `entities` gives this map's chests' names/cells/opened flags
 * (bridge 0.13.6), and `encounters` gives this map's or region's monster table. The save's area
 * totals (`achievements.save.treasure`) are only used for the "other maps in this area" note:
 * 11-05, Wind Shrine floors 1–4 share one area, so each floor must be judged by its own entities.
 * This module is pure formatting and file storage; Game decides when to ask.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AchievementTreasure } from "./achievements.ts";
import type { EncounterMonster, EncounterRegion, EncounterTable } from "./encounters.ts";
import { expectedBattles, monsterChance } from "./encounters.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { isRecord, list, num, record, text, type Json } from "./values.ts";

export type TreasureKind = "chest" | "hidden";

export interface TreasureSpot {
  readonly cell: readonly [number, number] | null;
  readonly label: string;
  readonly kind: TreasureKind;
  readonly opened: boolean;
}

export interface CompletionMonster {
  readonly number: number | null;
  readonly name: string;
  /** Task 68: chance that one battle here contains this monster (0-1), null when unreadable. */
  readonly chance: number | null;
  /** 1/chance rounded up; null when the chance is unknown. */
  readonly expectedBattles: number | null;
  /** The deadline text when this monster is missable, else null. */
  readonly missable: string | null;
  /** Already gone for good in this save (bestiary status 不可再获得); never worth grinding. */
  readonly lost: boolean;
}

export interface CompletionSection {
  readonly total: number;
  readonly open: number;
  readonly missing: readonly TreasureSpot[];
  /** Unopened items in the same area but on other maps; information only, never a debt. */
  readonly elsewhere: number;
}

/** Why this map has no monster list: fine, encounters disabled, or unreadable. */
export type EncounterStatus = "ok" | "none" | "unknown";

export interface CompletionState {
  readonly mapId: number | null;
  readonly areaId: number | null;
  readonly mapName: string;
  readonly world: boolean;
  readonly region: {
    readonly grid: number | null;
    readonly label: string;
    readonly start: readonly [number, number] | null;
    readonly end: readonly [number, number] | null;
  } | null;
  readonly chests: CompletionSection;
  readonly hidden: CompletionSection;
  readonly monsters: {
    readonly total: number;
    readonly missing: readonly CompletionMonster[];
  };
  readonly encounter: EncounterStatus;
  /** The area's name from the save rows, for the "other maps" note. */
  readonly areaName: string | null;
  readonly timedUntil: string | null;
  /** A one-time place: story/boss event cells are guarded too. */
  readonly oneTime: boolean;
  /** Cells that take the party to another map (GotoMap and the world-map exit event). */
  readonly exits: readonly (readonly [number, number])[];
  /** Named story/boss event cells, excluding doors and conveyors. */
  readonly storyEvents: readonly {
    readonly cell: readonly [number, number];
    readonly label: string;
  }[];
}

export interface CompletionInput {
  readonly mapId: number | null;
  readonly areaId: number | null;
  readonly mapName: string;
  readonly world: boolean;
  readonly region?: EncounterRegion | null;
  /** Task 69: the world-map encounter grid at the player; wins over the region's rectangle. */
  readonly grid?: number | null;
  readonly regionLabel?: string | null;
  readonly treasure: readonly AchievementTreasure[];
  readonly entities: readonly Json[];
  readonly monsters: readonly EncounterMonster[];
  /** Defaults to ok when there are monsters, unknown when the list is empty. */
  readonly encounter?: EncounterStatus;
  /** Bestiary numbers this save has registered. */
  readonly known: ReadonlySet<number>;
  /** Task 68: the encounter table the chances come from; null/unset leaves them unknown. */
  readonly encounterTable?: EncounterTable | null;
  /** Task 68: bestiary status per number (`限时:…`, `不可再获得` or null). */
  readonly monsterStatuses?: ReadonlyMap<number, string | null>;
  readonly timedUntil?: string | null;
  readonly oneTime?: boolean;
}

function cellOf(value: unknown): readonly [number, number] | null {
  const pair = list(value);
  return typeof pair[0] === "number" && typeof pair[1] === "number" ? [pair[0], pair[1]] : null;
}

/** Treasure entities of the current map from a bridge entities reply (kind All or TresureBox). */
export function parseTreasureEntities(entities: readonly Json[]): TreasureSpot[] {
  const out: TreasureSpot[] = [];
  for (const raw of entities) {
    const entity = record(raw);
    if (text(entity.kind) !== "TresureBox") continue;
    const hidden = entity.hidden === true || num(entity.treasureType) === 2;
    const label =
      text(entity.contentName) ??
      text(entity.name) ??
      (num(entity.content) === undefined ? "宝箱" : `内容 ${num(entity.content)}`);
    out.push({
      cell: cellOf(entity.cell),
      label: label === "" ? "宝箱" : label,
      kind: hidden ? "hidden" : "chest",
      opened: entity.opened === true,
    });
  }
  return out;
}

function areaRows(
  treasure: readonly AchievementTreasure[],
  area: number | null,
  world: boolean,
): readonly AchievementTreasure[] {
  if (area === null) return [];
  const target = world ? 0 : area;
  return treasure.filter((row) => row.area === target);
}

/**
 * This map's own entities are the requirement; the area's remaining count is only a note about
 * other maps (11-05: Wind Shrine 1–4 share one area and each floor showed 0/4).
 */
function section(
  rows: readonly AchievementTreasure[],
  spots: readonly TreasureSpot[],
  kind: TreasureKind,
): CompletionSection {
  const chosen = spots.filter((spot) => spot.kind === kind);
  const missing = chosen
    .filter((spot) => !spot.opened)
    .sort((left, right) => order(left) - order(right));
  const own = rows.filter((row) => row.type === (kind === "chest" ? 1 : 2));
  const areaTotal = own.reduce((sum, row) => sum + (row.total ?? 0), 0);
  const areaOpen = own.reduce((sum, row) => sum + (row.open ?? 0), 0);
  const elsewhere = Math.max(0, areaTotal - areaOpen - missing.length);
  return {
    total: chosen.length,
    open: chosen.length - missing.length,
    missing,
    elsewhere,
  };
}

function order(spot: TreasureSpot): number {
  return spot.cell === null ? Number.MAX_SAFE_INTEGER : spot.cell[1] * 10_000 + spot.cell[0];
}

function monsterList(
  monsters: readonly EncounterMonster[],
): { number: number | null; name: string }[] {
  const seen = new Set<string>();
  const out: { number: number | null; name: string }[] = [];
  for (const monster of monsters) {
    const key = monster.book === null ? `name:${monster.name}` : `no:${monster.book}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ number: monster.book, name: monster.name });
  }
  return out;
}

/** One missing monster with its task 68 chance and missable category. */
function missingMonster(
  monster: { readonly number: number; readonly name: string },
  input: CompletionInput,
): CompletionMonster {
  const status = input.monsterStatuses?.get(monster.number) ?? null;
  const chance = monsterChance(input.encounterTable ?? null, {
    name: monster.name,
    book: monster.number,
  });
  return {
    number: monster.number,
    name: monster.name,
    chance,
    expectedBattles: expectedBattles(chance),
    missable: status?.startsWith("限时:") ? status.slice("限时:".length) : null,
    lost: status === "不可再获得",
  };
}

const WORLD_EXIT = "ワールドマップ";
const NON_STORY = [
  "扉",
  "ドア",
  "流され",
  "吹き出し",
  "【汎用】",
  "SavePoint",
  "落下点",
  WORLD_EXIT,
];

/** A named `Event` that is not a door, conveyor, save point or the world-map exit. */
export function isStoryEventName(name: string): boolean {
  if (name === "") return false;
  return !NON_STORY.some((word) => name.includes(word));
}

function exitCells(entities: readonly Json[]): readonly (readonly [number, number])[] {
  const cells: (readonly [number, number])[] = [];
  for (const raw of entities) {
    const entity = record(raw);
    if (entity.active === false) continue;
    const kind = text(entity.kind) ?? "";
    const name = text(entity.name) ?? "";
    const cell = cellOf(entity.cell);
    if (cell === null) continue;
    if (kind === "GotoMap" || (kind === "Event" && name.includes(WORLD_EXIT))) cells.push(cell);
  }
  return cells;
}

function storyEvents(entities: readonly Json[]): readonly {
  readonly cell: readonly [number, number];
  readonly label: string;
}[] {
  const out: { cell: readonly [number, number]; label: string }[] = [];
  for (const raw of entities) {
    const entity = record(raw);
    if (entity.active === false || text(entity.kind) !== "Event") continue;
    const name = text(entity.name) ?? "";
    if (!isStoryEventName(name)) continue;
    const cell = cellOf(entity.cell);
    if (cell !== null) out.push({ cell, label: name });
  }
  return out;
}

/** Build the current map's completion from the bridge's save, entities and encounter data. */
export function completionState(input: CompletionInput): CompletionState {
  const rows = areaRows(input.treasure, input.areaId, input.world);
  const spots = parseTreasureEntities(input.entities);
  const monsters = monsterList(input.monsters);
  const missingMonsters = monsters
    .filter(
      (monster): monster is { number: number; name: string } =>
        monster.number !== null && !input.known.has(monster.number),
    )
    .map((monster) => missingMonster(monster, input));
  // Task 69: the encounter grid number is the world-map "region"; the old rectangle is only a
  // secondary hint (the live world map reports every bound as 0, so it has none). The bridge's
  // own region grid is the fallback for an old reply without map.grids or encountgrid.
  const grid = input.world ? (input.grid ?? input.region?.grid ?? null) : null;
  const region =
    input.world && ((input.region !== null && input.region !== undefined) || grid !== null)
      ? {
          grid,
          label:
            input.regionLabel ??
            (grid !== null
              ? gridLabel(grid)
              : input.region !== null && input.region !== undefined
                ? regionLabel(input.region)
                : "世界地图"),
          start: input.region?.start ?? null,
          end: input.region?.end ?? null,
        }
      : null;
  return {
    mapId: input.mapId,
    areaId: input.areaId,
    mapName: input.mapName,
    world: input.world,
    region,
    chests: section(rows, spots, "chest"),
    hidden: section(rows, spots, "hidden"),
    monsters: { total: monsters.length, missing: missingMonsters },
    encounter: input.encounter ?? (monsters.length > 0 ? "ok" : "unknown"),
    areaName: rows[0]?.name ?? null,
    timedUntil: input.timedUntil ?? null,
    oneTime: input.oneTime === true,
    exits: exitCells(input.entities),
    storyEvents: storyEvents(input.entities),
  };
}

function spotText(spot: TreasureSpot): string {
  return spot.cell === null ? spot.label : `(${spot.cell[0]},${spot.cell[1]}) ${spot.label}`;
}

function missingText(section: CompletionSection, limit = 12): string {
  const shown = section.missing.slice(0, limit).map(spotText);
  const rest = section.missing.length - shown.length;
  return shown.join("、") + (rest > 0 ? `、另 ${rest} 个` : "");
}

/** Task 68: 「风形魔(7%,以后还会出现)」 or 「XX(2%,限时：打倒…前)」. */
export function monsterText(monster: CompletionMonster): string {
  const tags: string[] = [];
  tags.push(monster.chance === null ? "概率未知" : `${Math.round(monster.chance * 100)}%`);
  if (monster.lost) tags.push("已错过，不用刷");
  else if (monster.missable !== null) tags.push(`限时：${monster.missable}`);
  else tags.push("以后还会出现");
  return `${monster.name}(${tags.join(",")})`;
}

export function isComplete(state: CompletionState): boolean {
  return (
    state.chests.open >= state.chests.total &&
    state.hidden.open >= state.hidden.total &&
    state.monsters.missing.length === 0
  );
}

/** The area's unopened items on other maps, as a note that never blocks leaving. */
function elsewhereNote(part: CompletionSection, areaName: string | null): string {
  if (part.elsewhere <= 0) return "";
  const place = areaName === null || areaName === "" ? "这个地点" : areaName;
  return `(${place}别的图里还有 ${part.elsewhere} 个没开)`;
}

/**
 * 11-09 (task 78): the title screen reports map 0, and a null map means none is known yet.
 * Neither is the world map (map 1), so say plainly that the party is not on a map.
 */
export function completionWhere(state: CompletionState): string {
  if (state.mapId === null || state.mapId <= 0) {
    return "不在地图上(可能在标题画面或切图中)";
  }
  // Task 128: the Game now decides `world` from the game files (11-11: Tycoon's meteor 189
  // reported areaType 0), so this formatter can trust the flag and name the actual region.
  return state.world
    ? (state.region?.label ?? "世界地图")
    : state.mapName === ""
      ? `地图 ${state.mapId}`
      : state.mapName;
}

/** One line for every map tool result: what is left here, with cells and monster names. */
export function completionLine(state: CompletionState): string {
  const where = completionWhere(state);
  const chests =
    state.chests.total === 0
      ? "宝箱 0" + elsewhereNote(state.chests, state.areaName)
      : `宝箱 ${state.chests.open}/${state.chests.total}` +
        (state.chests.missing.length > 0 ? `(没拿：${missingText(state.chests)})` : " ✓") +
        elsewhereNote(state.chests, state.areaName);
  const hidden =
    state.hidden.total === 0 && state.hidden.elsewhere === 0
      ? ""
      : ` · 隐藏道具 ${state.hidden.open}/${state.hidden.total}` +
        (state.hidden.missing.length > 0 ? `(没拿：${missingText(state.hidden)})` : " ✓") +
        elsewhereNote(state.hidden, state.areaName);
  const monster =
    state.encounter === "none"
      ? " · 本图现在不遇敌"
      : state.encounter === "unknown" || state.monsters.total === 0
        ? " · 本图的怪：读不到遇敌表"
        : state.monsters.missing.length === 0
          ? ` · 本图的怪 ${state.monsters.total} 种，本档图鉴已齐`
          : ` · 本图的怪 ${state.monsters.total} 种，本档图鉴还缺 ${state.monsters.missing.length} 种：` +
            state.monsters.missing.slice(0, 12).map(monsterText).join("、") +
            (state.monsters.missing.length > 12 ? ` 等 ${state.monsters.missing.length} 种` : "");
  return `本图完成度(${where})：${chests}${hidden}${monster}`;
}

/** What a leave check would lose, one Chinese phrase per missing kind. */
export function missingLines(
  state: CompletionState,
  skipMonsters: ReadonlySet<number> = new Set<number>(),
): string[] {
  const out: string[] = [];
  if (state.chests.missing.length > 0) {
    out.push(`宝箱 ${state.chests.open}/${state.chests.total}(没拿：${missingText(state.chests)})`);
  }
  if (state.hidden.missing.length > 0) {
    out.push(
      `隐藏道具 ${state.hidden.open}/${state.hidden.total}(没拿：${missingText(state.hidden)})`,
    );
  }
  const monsters = state.monsters.missing.filter(
    (item) => item.number === null || !skipMonsters.has(item.number),
  );
  if (monsters.length > 0) {
    out.push(`本图鉴还缺 ${monsters.length} 种：` + monsters.map(monsterText).join("、"));
  }
  return out;
}

/** The current region's remaining chests, shown on every result while a timer is running. */
export function timedLine(state: CompletionState): string {
  if (state.timedUntil === null) return "";
  const left = state.chests.total - state.chests.open;
  if (left <= 0) {
    return `限时地点(${state.timedUntil})：宝箱已全部拿到`;
  }
  return (
    `限时地点(${state.timedUntil})：还剩 ${left} 个宝箱：` +
    state.chests.missing.map(spotText).join("、")
  );
}

/** One line per region with its monsters, for the world map's look_around/entrances. */
export function regionLines(
  regions: readonly EncounterRegion[],
  known: Readonly<Record<number, string>> = {},
): string[] {
  return regions.map((region) => {
    const name = regionLabel(region, known);
    const names = [
      ...new Set(region.parties.flatMap((party) => party.monsters.map((monster) => monster.name))),
    ];
    const shown = names.slice(0, 10);
    return `${region.current ? "当前" : ""}${name}：${shown.join("、")}${names.length > shown.length ? ` 等 ${names.length} 种` : ""}`;
  });
}

/** Task 69: the world-map name for an encounter grid number; no rectangle is implied. */
export function gridLabel(grid: number | null): string {
  return grid === null ? "世界地图" : `世界地图 · 遇敌区 ${grid}`;
}

/** Fallback name; callers can pass the map's area text so "世界地图" is not repeated. */
export function regionLabel(
  region: EncounterRegion,
  known: Readonly<Record<number, string>> = {},
): string {
  const grid = region.grid;
  const named = grid === null ? undefined : known[grid];
  if (named !== undefined && named !== "") return named;
  const label = grid === null ? "?" : String(grid);
  const bounds =
    region.start !== null && region.end !== null
      ? `(${region.start[0]},${region.start[1]})-(${region.end[0]},${region.end[1]})`
      : "范围未知";
  return `世界地图 · 区域 ${label}(${bounds})`;
}

// ---------------------------------------------------------------------------------------------
// Backlog: a deliberate leave with leave_incomplete, resolved when the place is completed.

export interface BacklogEntry {
  readonly id: string;
  readonly at: string;
  readonly mapId: number | null;
  readonly areaId: number | null;
  /** World-map region grid; null indoors. */
  readonly region: number | null;
  readonly mapName: string;
  readonly missing: readonly string[];
  /** Task 68: bestiary numbers deferred by a low-probability grind; these no longer block. */
  readonly bestiary: readonly number[];
  readonly reason: string;
  readonly resolvedAt: string | null;
}

export interface BacklogInput {
  readonly mapId: number | null;
  readonly areaId: number | null;
  readonly region: number | null;
  readonly mapName: string;
  readonly missing: readonly string[];
  readonly bestiary?: readonly number[];
  readonly reason: string;
  readonly at?: string;
}

function backlogKey(mapId: number | null, areaId: number | null, region: number | null): string {
  return `${mapId ?? "?"}:${areaId ?? "?"}:${region ?? "-"}`;
}

function entryKey(entry: BacklogEntry): string {
  return backlogKey(entry.mapId, entry.areaId, entry.region);
}

function parseBacklog(value: unknown): BacklogEntry | null {
  if (!isRecord(value)) return null;
  const at = text(value.at);
  const reason = text(value.reason);
  const id = text(value.id);
  if (at === undefined || reason === undefined || id === undefined) return null;
  return {
    id,
    at,
    mapId: num(value.mapId) ?? null,
    areaId: num(value.areaId) ?? null,
    region: num(value.region) ?? null,
    mapName: text(value.mapName) ?? "",
    missing: list(value.missing).filter((item): item is string => typeof item === "string"),
    bestiary: list(value.bestiary).filter((item): item is number => typeof item === "number"),
    reason,
    resolvedAt: text(value.resolvedAt) ?? null,
  };
}

export class Backlog {
  readonly path: string | undefined;
  readonly entries = new Map<string, BacklogEntry>();
  private next = 1;

  constructor(path?: string) {
    this.path = path;
  }

  static async load(path?: string, signal?: AbortSignal): Promise<Backlog> {
    const store = new Backlog(path);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了欠账 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    for (const line of body.split(/\r\n|\r|\n/u)) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = parseBacklog(parsed);
      if (entry === null) continue;
      store.entries.set(entry.id, entry);
      store.next = Math.max(store.next, Number.parseInt(entry.id.replace(/\D/gu, ""), 10) + 1 || 1);
    }
    return store;
  }

  /** Re-read the append-only file after a scout restored it (task 105). */
  async reload(signal?: AbortSignal): Promise<void> {
    const fresh = await Backlog.load(this.path, signal);
    this.entries.clear();
    for (const [id, entry] of fresh.entries) this.entries.set(id, entry);
    this.next = fresh.next;
  }

  pending(): BacklogEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.resolvedAt === null)
      .sort((left, right) => left.at.localeCompare(right.at));
  }

  /** Add or refresh the unresolved entry for this place; returns it. */
  async add(input: BacklogInput): Promise<BacklogEntry> {
    const existing = this.pending().find(
      (entry) => entryKey(entry) === backlogKey(input.mapId, input.areaId, input.region),
    );
    // A manual leave note and a later automatic bestiary deferral share one entry; keep the
    // deferred monster numbers from both so neither call loses the other's excused monsters.
    const bestiary = [...new Set([...(existing?.bestiary ?? []), ...(input.bestiary ?? [])])].sort(
      (left, right) => left - right,
    );
    const entry: BacklogEntry = {
      id: existing?.id ?? `b${this.next++}`,
      at: input.at ?? new Date().toISOString(),
      mapId: input.mapId,
      areaId: input.areaId,
      region: input.region,
      mapName: input.mapName,
      missing: [...input.missing],
      bestiary,
      reason: input.reason,
      resolvedAt: null,
    };
    this.entries.set(entry.id, entry);
    await this.append(entry);
    return entry;
  }

  /** Resolve every pending entry for this map/area/region; returns how many were closed. */
  async resolve(
    mapId: number | null,
    areaId: number | null,
    region: number | null,
  ): Promise<number> {
    const at = new Date().toISOString();
    let closed = 0;
    for (const entry of this.pending()) {
      if (entryKey(entry) !== backlogKey(mapId, areaId, region)) continue;
      const resolved: BacklogEntry = { ...entry, resolvedAt: at };
      this.entries.set(entry.id, resolved);
      await this.append(resolved);
      closed += 1;
    }
    return closed;
  }

  /** Resolve the current place when its completion has no gaps left. */
  async resolveComplete(state: CompletionState): Promise<number> {
    if (!isComplete(state)) return 0;
    return await this.resolve(
      state.mapId,
      state.areaId,
      state.world ? (state.region?.grid ?? null) : null,
    );
  }

  private async append(entry: BacklogEntry): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await appendFile(this.path, JSON.stringify(entry) + "\n", "utf8");
    } catch (error) {
      throw new Error(`写不了欠账 ${this.path}:${describeError(error)}`, {
        cause: error,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Incidents: a one-time place's missed count grew. The state remembers the previous counts so
// the same missed chest is not recorded twice; the first run adds Walse Tower's 2 as 补记.

export interface IncidentEntry {
  readonly id: string;
  readonly at: string;
  readonly area: number;
  readonly place: string;
  /** How many boxes this incident newly lost. */
  readonly lost: number;
  /** The place's total missed count after it. */
  readonly total: number;
  readonly supplement?: boolean;
}

export interface MissedPlace {
  readonly area: number;
  readonly place: string;
  readonly missed: number;
}

interface IncidentState {
  readonly areas: Record<string, number>;
}

function parseIncident(value: unknown): IncidentEntry | null {
  if (!isRecord(value)) return null;
  const at = text(value.at);
  const place = text(value.place);
  const id = text(value.id);
  if (at === undefined || place === undefined || id === undefined) return null;
  return {
    id,
    at,
    area: num(value.area) ?? 0,
    place,
    lost: num(value.lost) ?? 0,
    total: num(value.total) ?? 0,
    ...(value.supplement === true ? { supplement: true } : {}),
  };
}

export class Incidents {
  readonly path: string | undefined;
  readonly statePath: string | undefined;
  readonly entries: IncidentEntry[] = [];
  private areas: Record<string, number> = {};
  private initialized = false;
  private next = 1;

  constructor(path?: string, statePath?: string) {
    this.path = path;
    this.statePath = statePath;
  }

  static async load(path?: string, statePath?: string, signal?: AbortSignal): Promise<Incidents> {
    const store = new Incidents(path, statePath);
    if (path !== undefined) {
      let body: string;
      try {
        body = await readFile(path, { encoding: "utf8", signal });
      } catch (error) {
        if (!isMissingFile(error)) {
          signal?.throwIfAborted();
          throw new Error(`读不了事故 ${path}:${describeError(error)}`, {
            cause: error,
          });
        }
        body = "";
      }
      for (const line of body.split(/\r\n|\r|\n/u)) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = parseIncident(parsed);
        if (entry === null) continue;
        store.entries.push(entry);
        store.next = Math.max(
          store.next,
          Number.parseInt(entry.id.replace(/\D/gu, ""), 10) + 1 || 1,
        );
      }
    }
    if (statePath !== undefined) {
      let body: string;
      try {
        body = await readFile(statePath, { encoding: "utf8", signal });
      } catch (error) {
        if (!isMissingFile(error)) {
          signal?.throwIfAborted();
          throw new Error(`读不了事故状态 ${statePath}:${describeError(error)}`, { cause: error });
        }
        body = "";
      }
      if (body !== "") {
        try {
          const parsed: unknown = JSON.parse(body);
          if (isRecord(parsed) && isRecord(parsed.areas)) {
            for (const [key, value] of Object.entries(parsed.areas)) {
              const count = num(value) ?? null;
              if (count !== null) store.areas[key] = count;
            }
            store.initialized = true;
          }
        } catch {
          // A broken state file is treated like the first run.
        }
      }
    }
    return store;
  }

  /** Re-read the incident log and state after a scout restored them (task 105). */
  async reload(signal?: AbortSignal): Promise<void> {
    const fresh = await Incidents.load(this.path, this.statePath, signal);
    this.entries.length = 0;
    this.entries.push(...fresh.entries);
    this.areas = fresh.areas;
    this.initialized = fresh.initialized;
    this.next = fresh.next;
  }

  /** Record any place whose missed count grew; the first run adds Walse Tower as 补记. */
  async observe(
    places: readonly MissedPlace[],
    at = new Date().toISOString(),
  ): Promise<IncidentEntry[]> {
    const created: IncidentEntry[] = [];
    const first = !this.initialized;
    for (const place of places) {
      const key = String(place.area);
      const previous = this.areas[key] ?? 0;
      if (first) {
        // 11-04: this save already lost Walse Tower's two chests before the feature existed.
        if (place.area === 71 && place.missed > 0) {
          created.push(await this.record(place, place.missed, at, true));
        }
      } else if (place.missed > previous) {
        created.push(await this.record(place, place.missed - previous, at, false));
      }
      this.areas[key] = place.missed;
    }
    this.initialized = true;
    await this.saveState();
    return created;
  }

  private async record(
    place: MissedPlace,
    lost: number,
    at: string,
    supplement: boolean,
  ): Promise<IncidentEntry> {
    const entry: IncidentEntry = {
      id: `i${this.next++}`,
      at,
      area: place.area,
      place: place.place,
      lost,
      total: place.missed,
      ...(supplement ? { supplement: true } : {}),
    };
    this.entries.push(entry);
    if (this.path !== undefined) {
      await mkdir(dirname(this.path), { recursive: true });
      try {
        await appendFile(this.path, JSON.stringify(entry) + "\n", "utf8");
      } catch (error) {
        throw new Error(`写不了事故 ${this.path}:${describeError(error)}`, {
          cause: error,
        });
      }
    }
    return entry;
  }

  private async saveState(): Promise<void> {
    if (this.statePath === undefined) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const state: IncidentState = { areas: this.areas };
    try {
      await appendFile(this.statePath + ".tmp", JSON.stringify(state, null, 1), "utf8");
      const { rename } = await import("node:fs/promises");
      await rename(this.statePath + ".tmp", this.statePath);
    } catch (error) {
      throw new Error(`写不了事故状态 ${this.statePath}:${describeError(error)}`, { cause: error });
    }
  }
}

/** The opening message's backlog lines: at most five, with the total when there are more. */
export function backlogLines(entries: readonly BacklogEntry[], limit = 5): string[] {
  if (entries.length === 0) return [];
  const lines = entries
    .slice(0, limit)
    .map(
      (entry) =>
        `- ${entry.mapName === "" ? `地图 ${entry.mapId ?? "?"}` : entry.mapName}：` +
        `${entry.missing.join("、")}；理由：${entry.reason}`,
    );
  if (entries.length > limit) lines.push(`- 另有 ${entries.length - limit} 条欠账`);
  return ["还没销的欠账:", ...lines];
}

/** The opening message's incident lines; `supplement` marks the one written after the fact. */
export function incidentLines(entries: readonly IncidentEntry[], limit = 5): string[] {
  if (entries.length === 0) return [];
  const lines = entries
    .slice(-limit)
    .map(
      (entry) =>
        `- ${entry.place} 错过 ${entry.lost} 个宝箱(累计 ${entry.total} 个)` +
        (entry.supplement === true ? "，补记" : ""),
    );
  return ["事故(一次性地点的宝箱已错过，无法挽回):", ...lines];
}

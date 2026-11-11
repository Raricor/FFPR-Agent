/**
 * Reading the three layers of knowledge (task 93):
 * - `master`: every `*.json` under `.deps/knowledge/<game>/static/`, written by the bridge
 *   plugin in the format documented in `index.ts`. A missing directory or table is empty, not
 *   an error, so the module works before the plugin has ever exported anything.
 * - `guide`: the cached walkthroughs, read through the existing `guide/kb.ts` `Guide`. That
 *   class is not modified; the module only asks it questions.
 * - `save` / `observed`: the existing read-only stores (`BestiarySave`, `AtlasSave`, `Atlas`,
 *   `CollisionStore`) plus an explicit `SaveProgress` for the chests and blue magic the game
 *   reads live. Nothing here writes a file.
 *
 * `loadKnowledge` hands the collected inputs to `merge.ts` and returns a plain
 * `Knowledge` object; the queries in `query.ts` are pure functions over that object.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Atlas } from "../atlas.ts";
import { AtlasSave } from "../atlas-save.ts";
import { BestiarySave } from "../bestiary-save.ts";
import { describeError, isMissingFile } from "../errors.ts";
import { Guide } from "../guide/kb.ts";
import { DEPS } from "../paths.ts";
import { profileFor } from "../profiles/index.ts";
import type { GameProfile } from "../profiles/types.ts";
import { CollisionStore } from "../regions.ts";
import { isRecord, list, num, records, text } from "../values.ts";
import {
  parseEncounterAreaGrids,
  parseEncounterAreas,
  parseGameMapFile,
  parseMapCsv,
  parseMessageTable,
  parseMonsterParties,
  parseMonsterResources,
  parseMonsterSets,
  type EncounterAreaGridResource,
  type EncounterAreaResource,
  type GameItem,
  type GameMapFile,
  type MapResource,
  type MonsterPartyResource,
  type MonsterSetResource,
  type TrilingualNames,
} from "./game-files.ts";
import { buildKnowledge } from "./merge.ts";
import type {
  EncountersRow,
  ItemsRow,
  ItemRestores,
  Knowledge,
  MagicRow,
  MapsRow,
  MonsterDropRow,
  MonsterMoveRow,
  MonstersRow,
  SaveProgress,
  SaveProgressInput,
  ShopProductRow,
  ShopsRow,
  SourceRef,
  TreasuresRow,
} from "./types.ts";

export const TABLES = [
  "maps",
  "monsters",
  "encounters",
  "treasures",
  "shops",
  "items",
  "magic",
] as const;

export type TableName = (typeof TABLES)[number];

/** The static export of one game: every table, absent ones as empty lists. */
export interface StaticData {
  readonly game: string;
  readonly build: string | null;
  readonly bridge: string | null;
  readonly dir: string;
  readonly tables: readonly TableName[];
  readonly maps: readonly MapsRow[];
  readonly monsters: readonly MonstersRow[];
  readonly encounters: readonly EncountersRow[];
  readonly treasures: readonly TreasuresRow[];
  readonly shops: readonly ShopsRow[];
  readonly items: readonly ItemsRow[];
  readonly magic: readonly MagicRow[];
  readonly sources: readonly SourceRef[];
}

/** The extracted game files (task 121): every map's chests and points, plus the CSVs. */
export interface FilesData {
  readonly dir: string;
  readonly maps: readonly GameMapFile[];
  readonly resources: readonly MapResource[];
  readonly items: readonly GameItem[];
  readonly monsterSets: readonly MonsterSetResource[];
  readonly monsterParties: readonly MonsterPartyResource[];
  /** English monster name by `monster.csv` id, for ids the bridge export does not know. */
  readonly monsterNames: ReadonlyMap<number, string>;
  readonly encounterAreas: readonly EncounterAreaResource[];
  readonly encounterGrids: readonly EncounterAreaGridResource[];
  readonly sources: readonly SourceRef[];
}

/** The inputs `merge.ts` joins; `loadKnowledge` returns the merged `Knowledge` instead. */
export interface LoadedKnowledge {
  readonly static: StaticData;
  /** Present only when `.deps/knowledge/<game>/files/` exists; null means use `static`. */
  readonly files?: FilesData | null;
  readonly guide: Guide | null;
  readonly atlas: Atlas | null;
  readonly collisions: CollisionStore | null;
  readonly profile: GameProfile | null;
  readonly progress: SaveProgress;
}

export interface KnowledgeOptions {
  readonly game?: string;
  /** `.deps/knowledge/<game>`; the static files are `<home>/static/*.json`. */
  readonly home?: string;
  readonly staticDir?: string;
  /** Extracted game files; default `<home>/files`, a missing directory falls back to static. */
  readonly filesDir?: string | null;
  /** Reuse an already loaded guide; null means no guide, undefined loads from `guidePath`. */
  readonly guide?: Guide | null;
  readonly guidePath?: string | null;
  readonly atlas?: Atlas | null;
  readonly atlasFile?: string | null;
  readonly collisions?: CollisionStore | null;
  readonly collisionDir?: string | null;
  readonly bestiarySave?: BestiarySave | null;
  readonly bestiaryFile?: string | null;
  readonly atlasSave?: AtlasSave | null;
  readonly atlasSaveFile?: string | null;
  /** The current save count, so the save-local stores pick this save's snapshot. */
  readonly saves?: number | null;
  readonly progress?: SaveProgressInput;
  readonly signal?: AbortSignal;
}

/** Where the plugin keeps its own read-only stores, matching `plugin/config.ts` defaults. */
export function defaultFiles(game = "ff5"): {
  readonly home: string;
  readonly guide: string;
  readonly staticDir: string;
  readonly filesDir: string;
  readonly atlas: string;
  readonly collisions: string;
  readonly bestiary: string;
  readonly atlasSave: string;
} {
  const home = join(DEPS, "knowledge", game);
  return {
    home,
    guide: join(home, "guide.json"),
    staticDir: join(home, "static"),
    filesDir: join(home, "files"),
    atlas: join(DEPS, "ds", `atlas-${game}.json`),
    collisions: join(DEPS, "ds", `collision-${game}`),
    bestiary: join(DEPS, "ds", `bestiary-save-${game}.json`),
    atlasSave: join(DEPS, "ds", `atlas-save-${game}.json`),
  };
}

function numberOrNull(value: unknown): number | null {
  return num(value) ?? null;
}

function textOrNull(value: unknown): string | null {
  return text(value) ?? null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringList(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string");
}

function numberList(value: unknown): number[] {
  return list(value).filter((item): item is number => typeof item === "number");
}

function tableSource(table: TableName): SourceRef {
  return { kind: "master", ref: `master:${table}.json` };
}

function parseCell(value: unknown): readonly [number, number] | null {
  const pair = list(value);
  const x = pair[0];
  const y = pair[1];
  return typeof x === "number" && typeof y === "number" ? [x, y] : null;
}

function parseDrops(value: unknown): MonsterDropRow[] {
  return records(value).map((raw) => ({
    itemId: numberOrNull(raw.itemId),
    name: textOrNull(raw.name),
    rate: numberOrNull(raw.rate),
  }));
}

function parseMove(value: unknown): MonsterMoveRow {
  const raw = isRecord(value) ? value : {};
  return {
    abilityId: numberOrNull(raw.abilityId),
    name: textOrNull(raw.name),
    blueMagic: boolOrNull(raw.blueMagic),
    conditions: stringList(raw.conditions),
    rate: numberOrNull(raw.rate),
  };
}

function parseMoves(value: unknown): MonsterMoveRow[] | null {
  return Array.isArray(value) ? value.map(parseMove) : null;
}

function parseMapsRow(value: unknown): MapsRow {
  const raw = isRecord(value) ? value : {};
  return {
    id: numberOrNull(raw.id),
    name: textOrNull(raw.name),
    areaId: numberOrNull(raw.areaId),
    areaName: textOrNull(raw.areaName),
    areaType: textOrNull(raw.areaType),
  };
}

function parseMonstersRow(value: unknown): MonstersRow {
  const raw = isRecord(value) ? value : {};
  return {
    id: numberOrNull(raw.id),
    name: textOrNull(raw.name),
    bookId: numberOrNull(raw.bookId),
    level: numberOrNull(raw.level),
    hp: numberOrNull(raw.hp),
    mp: numberOrNull(raw.mp),
    weak: stringList(raw.weak),
    absorb: stringList(raw.absorb),
    nullify: stringList(raw.nullify),
    statusImmune: stringList(raw.statusImmune),
    drops: parseDrops(raw.drops),
    steal: parseDrops(raw.steal),
    boss: boolOrNull(raw.boss),
    scriptId: textOrNull(raw.scriptId),
    moves: parseMoves(raw.moves),
  };
}

function parseEncountersRow(value: unknown): EncountersRow {
  const raw = isRecord(value) ? value : {};
  const scope = raw.scope === "map" || raw.scope === "area" ? raw.scope : null;
  return {
    scope,
    mapId: numberOrNull(raw.mapId),
    areaId: numberOrNull(raw.areaId),
    groupId: numberOrNull(raw.groupId),
    weight: numberOrNull(raw.weight),
    monsterIds: numberList(raw.monsterIds),
  };
}

function parseTreasuresRow(value: unknown): TreasuresRow {
  const raw = isRecord(value) ? value : {};
  return {
    id: numberOrNull(raw.id),
    areaId: numberOrNull(raw.areaId),
    mapId: numberOrNull(raw.mapId),
    cell: parseCell(raw.cell),
    hidden: boolOrNull(raw.hidden),
    contentId: numberOrNull(raw.contentId),
    contentName: textOrNull(raw.contentName),
    count: numberOrNull(raw.count),
    flag: textOrNull(raw.flag),
  };
}

function parseProduct(value: unknown): ShopProductRow {
  const raw = isRecord(value) ? value : {};
  return {
    itemId: numberOrNull(raw.itemId),
    name: textOrNull(raw.name),
    price: numberOrNull(raw.price),
  };
}

function parseShopsRow(value: unknown): ShopsRow {
  const raw = isRecord(value) ? value : {};
  return {
    id: numberOrNull(raw.id),
    mapId: numberOrNull(raw.mapId),
    areaName: textOrNull(raw.areaName),
    kind: textOrNull(raw.kind),
    products: records(raw.products).map(parseProduct),
  };
}

function parseRestores(value: unknown): ItemRestores | null {
  if (!isRecord(value)) return null;
  const hp = numberOrNull(value.hp);
  const mp = numberOrNull(value.mp);
  if (hp === null && mp === null) return null;
  return { ...(hp === null ? {} : { hp }), ...(mp === null ? {} : { mp }) };
}

function parseItemsRow(value: unknown): ItemsRow {
  const raw = isRecord(value) ? value : {};
  return {
    id: numberOrNull(raw.id),
    name: textOrNull(raw.name),
    kind: textOrNull(raw.kind),
    price: numberOrNull(raw.price),
    cures: stringList(raw.cures),
    restores: parseRestores(raw.restores),
  };
}

function parseMagicRow(value: unknown): MagicRow {
  const raw = isRecord(value) ? value : {};
  return {
    id: numberOrNull(raw.id),
    name: textOrNull(raw.name),
    school: textOrNull(raw.school),
    mp: numberOrNull(raw.mp),
    cures: stringList(raw.cures),
  };
}

function isTableName(value: string): value is TableName {
  return (TABLES as readonly string[]).includes(value);
}

function emptyStatic(game: string, dir: string): StaticData {
  return {
    game,
    build: null,
    bridge: null,
    dir,
    tables: [],
    maps: [],
    monsters: [],
    encounters: [],
    treasures: [],
    shops: [],
    items: [],
    magic: [],
    sources: [],
  };
}

function fileSource(ref: string): SourceRef {
  return { kind: "files", ref };
}

async function readOptionalText(path: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return null;
    signal?.throwIfAborted();
    throw new Error(`读不了游戏文件 ${path}:${describeError(error)}`, {
      cause: error,
    });
  }
}

async function firstText(
  directories: readonly string[],
  name: string,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const directory of directories) {
    const body = await readOptionalText(join(directory, name), signal);
    if (body !== null) return body;
  }
  return null;
}

function parseItemNames(value: unknown): TrilingualNames {
  const raw = isRecord(value) ? value : {};
  return {
    ja: textOrNull(raw.ja),
    en: textOrNull(raw.en),
    zhc: textOrNull(raw.zhc),
  };
}

function parseFileItem(value: unknown, fallbackId: number): GameItem | null {
  if (!isRecord(value)) return null;
  const id = numberOrNull(value.id) ?? fallbackId;
  if (id <= 0) return null;
  return {
    id,
    kind: (text(value.kind) ?? "other") as GameItem["kind"],
    typeId: numberOrNull(value.typeId),
    typeValue: numberOrNull(value.typeValue),
    nameKey: textOrNull(value.nameKey),
    names: parseItemNames(value.names),
  };
}

async function readFileItems(dir: string, signal?: AbortSignal): Promise<GameItem[]> {
  const body = await readOptionalText(join(dir, "items.json"), signal);
  if (body === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`读不懂物品文件 ${join(dir, "items.json")}:${describeError(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) throw new Error(`物品文件 ${join(dir, "items.json")} 不是 JSON 对象`);
  const items: GameItem[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const item = parseFileItem(value, numberOrNull(key) ?? 0);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * Task 156 follow-up: task 150's export adds boss objects (the event object whose script has
 * EncountBoss) to each map. Keep the new field without changing game-files.ts (150 owns it);
 * the plan executor reads it and matches monster ids itself.
 */
interface MapFileWithBossObjects extends GameMapFile {
  readonly bossObjects?: readonly unknown[];
}

async function readFileMaps(dir: string, signal?: AbortSignal): Promise<GameMapFile[]> {
  const mapsDir = join(dir, "maps");
  let names: string[];
  try {
    names = await readdir(mapsDir);
  } catch (error) {
    if (isMissingFile(error)) return [];
    signal?.throwIfAborted();
    throw new Error(`读不了地图文件目录 ${mapsDir}:${describeError(error)}`, {
      cause: error,
    });
  }
  const maps: GameMapFile[] = [];
  const files = names
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => {
      const a = Number(left.slice(0, -".json".length));
      const b = Number(right.slice(0, -".json".length));
      return Number.isFinite(a) && Number.isFinite(b) ? a - b : left.localeCompare(right);
    });
  for (const name of files) {
    const path = join(mapsDir, name);
    const body = await readOptionalText(path, signal);
    if (body === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂地图文件 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    const map = parseGameMapFile(parsed);
    if (map === null) continue;
    // 11-11: task 150 exports boss objects inside `events` (objectType 10, encounterGroupId);
    // expose them as `bossObjects` too when the file has no separate list.
    const fromEvents: Record<string, unknown>[] =
      isRecord(parsed) && Array.isArray(parsed.events)
        ? (parsed.events as unknown[])
            .filter(isRecord)
            .filter((event) => event.objectType === 10)
            .map((event) => ({ ...event, encounterParty: event.encounterGroupId ?? null }))
        : [];
    const bossObjects =
      isRecord(parsed) && Array.isArray(parsed.bossObjects)
        ? parsed.bossObjects
        : fromEvents.length > 0
          ? fromEvents
          : undefined;
    const withBossObjects: MapFileWithBossObjects =
      bossObjects === undefined ? map : { ...map, bossObjects };
    maps.push(withBossObjects);
  }
  return maps;
}

/**
 * Read `.deps/knowledge/<game>/files/`. The map JSON and `items.json` come from task 120's
 * export; the encounter CSVs and message tables are read from a `master/` and `message/`
 * directory beside them (tests) or from the raw extracted game files (the dev box). A missing
 * `maps/` directory means the game files are not available, so the caller keeps using `static`.
 */
export async function readGameFiles(
  dir: string,
  game = "ff5",
  signal?: AbortSignal,
): Promise<FilesData | null> {
  const maps = await readFileMaps(dir, signal);
  if (maps.length === 0) return null;
  const masterDirs = [join(dir, "master"), join(DEPS, game, "files", "Data", "Master")];
  const messageDirs = [join(dir, "message"), join(DEPS, game, "files", "Data", "Message")];
  const readMaster = (name: string): Promise<string | null> => firstText(masterDirs, name, signal);
  const mapText = await readMaster("map.csv");
  const setText = await readMaster("monster_set.csv");
  const partyText = await readMaster("monster_party.csv");
  const monsterText = await readMaster("monster.csv");
  const areaText = await readMaster("encount_area.csv");
  const gridText = await readMaster("encount_area_grid.csv");
  const english = await firstText(messageDirs, "system_en.txt", signal);
  const messages = english === null ? new Map<string, string>() : parseMessageTable(english);
  const monsterNames = new Map<number, string>();
  const resources = mapText === null ? [] : parseMapCsv(mapText);
  const monsters = monsterText === null ? [] : parseMonsterResources(monsterText);
  for (const monster of monsters) {
    const name = monster.nameKey === null ? undefined : messages.get(monster.nameKey);
    if (name !== undefined && name !== "") monsterNames.set(monster.id, name);
  }
  const items = await readFileItems(dir, signal);
  const sources: SourceRef[] = [
    fileSource("files:maps"),
    fileSource("files:items.json"),
    ...(mapText === null ? [] : [fileSource("files:map.csv")]),
    ...(setText === null ? [] : [fileSource("files:monster_set.csv")]),
    ...(partyText === null ? [] : [fileSource("files:monster_party.csv")]),
    ...(monsterText === null ? [] : [fileSource("files:monster.csv")]),
    ...(areaText === null ? [] : [fileSource("files:encount_area.csv")]),
    ...(gridText === null ? [] : [fileSource("files:encount_area_grid.csv")]),
  ];
  return {
    dir,
    maps,
    resources,
    items,
    monsterSets: setText === null ? [] : parseMonsterSets(setText),
    monsterParties: partyText === null ? [] : parseMonsterParties(partyText),
    monsterNames,
    encounterAreas: areaText === null ? [] : parseEncounterAreas(areaText),
    encounterGrids: gridText === null ? [] : parseEncounterAreaGrids(gridText),
    sources,
  };
}

/**
 * Every table file under `dir`, merged into one `StaticData`. A missing directory gives the
 * empty export; a malformed file is an error (the caller cannot tell a bad export from no
 * export otherwise).
 */
export async function readStatic(
  dir: string,
  game = "ff5",
  signal?: AbortSignal,
): Promise<StaticData> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return emptyStatic(game, dir);
    signal?.throwIfAborted();
    throw new Error(`读不了知识导出目录 ${dir}:${describeError(error)}`, {
      cause: error,
    });
  }
  const rowsByTable: Record<TableName, unknown[]> = {
    maps: [],
    monsters: [],
    encounters: [],
    treasures: [],
    shops: [],
    items: [],
    magic: [],
  };
  const tables: TableName[] = [];
  const sources: SourceRef[] = [];
  let build: string | null = null;
  let bridge: string | null = null;
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const path = join(dir, name);
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`读不了知识导出 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂知识导出 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) throw new Error(`知识导出 ${path} 不是 JSON 对象`);
    const table = text(parsed.table) ?? name.slice(0, -".json".length);
    if (!isTableName(table)) continue;
    if (!Array.isArray(parsed.rows)) throw new Error(`知识导出 ${path} 没有 rows 数组`);
    const fileGame = text(parsed.game);
    if (fileGame !== undefined && fileGame !== game) {
      throw new Error(`知识导出 ${path} 属于 ${fileGame},不是 ${game}`);
    }
    rowsByTable[table] = parsed.rows;
    if (!tables.includes(table)) tables.push(table);
    build ??= text(parsed.build) ?? null;
    bridge ??= text(parsed.bridge) ?? null;
    sources.push(tableSource(table));
  }
  return {
    game,
    build,
    bridge,
    dir,
    tables: TABLES.filter((table) => tables.includes(table)),
    maps: rowsByTable.maps.map(parseMapsRow),
    monsters: rowsByTable.monsters.map(parseMonstersRow),
    encounters: rowsByTable.encounters.map(parseEncountersRow),
    treasures: rowsByTable.treasures.map(parseTreasuresRow),
    shops: rowsByTable.shops.map(parseShopsRow),
    items: rowsByTable.items.map(parseItemsRow),
    magic: rowsByTable.magic.map(parseMagicRow),
    sources,
  };
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)))];
}

function uniqueKeys(values: readonly (number | string)[]): (number | string)[] {
  return [...new Set(values)];
}

function progressOf(input: SaveProgressInput | undefined): SaveProgress {
  return {
    openedChestsKnown: input?.openedChests !== undefined,
    openedChests: uniqueKeys(input?.openedChests ?? []),
    bestiary: uniqueNumbers(input?.bestiary ?? []),
    blueMagic: uniqueKeys(input?.blueMagic ?? []),
    visitedMapsKnown: input?.visitedMaps !== undefined,
    visitedMaps: uniqueNumbers(input?.visitedMaps ?? []),
  };
}

async function loadBestiary(options: KnowledgeOptions, game: string): Promise<BestiarySave | null> {
  if (options.bestiarySave !== undefined) return options.bestiarySave;
  const file =
    options.bestiaryFile === null ? null : (options.bestiaryFile ?? defaultFiles(game).bestiary);
  if (file === null) return null;
  return BestiarySave.load(game, file, options.signal);
}

async function loadAtlasSave(
  options: KnowledgeOptions,
  game: string,
  atlas: Atlas | null,
): Promise<AtlasSave | null> {
  if (options.atlasSave !== undefined) return options.atlasSave;
  if (atlas === null) return null;
  const file =
    options.atlasSaveFile === null ? null : (options.atlasSaveFile ?? defaultFiles(game).atlasSave);
  if (file === null) return null;
  // AtlasSave.load installs its own onNewVisit callback; this module only reads, so keep the
  // caller's callback (a real game may share this atlas) instead of replacing it with ours.
  const previous = atlas.onNewVisit;
  const store = await AtlasSave.load(game, file, atlas, options.signal);
  atlas.onNewVisit = previous;
  return store;
}

function savedMaps(store: AtlasSave, saves: number | null | undefined): readonly number[] {
  if (saves !== null && saves !== undefined)
    return store.snapshotFor(saves)?.maps ?? store.live.maps;
  return store.live.maps;
}

function savedBestiary(store: BestiarySave, saves: number | null | undefined): readonly number[] {
  if (saves !== null && saves !== undefined) {
    return store.snapshotFor(saves)?.numbers ?? [...store.numbers];
  }
  const numbers: number[] = [];
  for (const snapshot of store.snapshots.values()) numbers.push(...snapshot.numbers);
  return uniqueNumbers(numbers);
}

function profileOf(game: string): GameProfile | null {
  try {
    return profileFor(game);
  } catch (error) {
    if (error instanceof Error && error.name === "UnknownGame") return null;
    throw error;
  }
}

/** Read the static export, the guide and the read-only stores; no merging yet. */
export async function loadInputs(options: KnowledgeOptions = {}): Promise<LoadedKnowledge> {
  const game = options.game ?? "ff5";
  const defaults = defaultFiles(game);
  const home = options.home ?? defaults.home;
  const staticDir = options.staticDir ?? join(home, "static");
  const staticData = await readStatic(staticDir, game, options.signal);
  // A caller overriding `staticDir` (the tests) must not accidentally fall back to the dev
  // box's real game files: the sibling `files` directory is used instead.
  const filesDir =
    options.filesDir === null ? null : (options.filesDir ?? join(dirname(staticDir), "files"));
  const files = filesDir === null ? null : await readGameFiles(filesDir, game, options.signal);

  let guide: Guide | null;
  if (options.guide !== undefined) {
    guide = options.guide;
  } else {
    const guidePath =
      options.guidePath === null ? null : (options.guidePath ?? join(home, "guide.json"));
    guide = guidePath === null ? null : await Guide.load(guidePath, options.signal);
  }

  let atlas: Atlas | null;
  if (options.atlas !== undefined) {
    atlas = options.atlas;
  } else {
    const atlasFile = options.atlasFile === null ? null : (options.atlasFile ?? defaults.atlas);
    atlas = atlasFile === null ? null : await Atlas.load(atlasFile, options.signal);
  }

  let collisions: CollisionStore | null;
  if (options.collisions !== undefined) {
    collisions = options.collisions;
  } else {
    const collisionDir =
      options.collisionDir === null ? null : (options.collisionDir ?? defaults.collisions);
    collisions =
      collisionDir === null ? null : await CollisionStore.load(collisionDir, options.signal);
  }

  const bestiaryStore = await loadBestiary(options, game);
  const atlasSave = await loadAtlasSave(options, game, atlas);
  const progress = progressOf(options.progress);
  const merged: SaveProgress = {
    openedChestsKnown: progress.openedChestsKnown,
    openedChests: progress.openedChests,
    bestiary: uniqueNumbers([
      ...progress.bestiary,
      ...(bestiaryStore === null ? [] : savedBestiary(bestiaryStore, options.saves)),
    ]),
    blueMagic: progress.blueMagic,
    visitedMapsKnown: progress.visitedMapsKnown,
    visitedMaps: uniqueNumbers([
      ...progress.visitedMaps,
      ...(atlasSave === null ? [] : savedMaps(atlasSave, options.saves)),
    ]),
  };
  return {
    static: staticData,
    files,
    guide,
    atlas,
    collisions,
    profile: profileOf(game),
    progress: merged,
  };
}

/** Load a game's knowledge; a missing export or guide only narrows the answers. */
export async function loadKnowledge(options: KnowledgeOptions = {}): Promise<Knowledge> {
  return buildKnowledge(await loadInputs(options));
}

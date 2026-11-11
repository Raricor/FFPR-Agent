/**
 * Read the FF5 Pixel Remaster files extracted from the game packages (task 120).
 *
 * The bridge export and the atlas only know maps the save has visited; the game's own Tiled
 * maps know every chest, exit and event trigger. This module is the pure part: it takes text
 * already read from disk (CSV, message tables, Tiled JSON) and returns plain data. The command
 * line wrapper in `scripts/game-files.mts` does the I/O.
 *
 * Coordinates. Tiled stores a tile object's `x`/`y` at its bottom-left when the object has a
 * `gid`; the map records and the collision cache count cells from the top-left. For a gid object
 * the cell is `(x / 16, y / 16 - 1)`. A rectangle without a gid stores its top-left instead, so
 * its origin cell is `(x / 16, y / 16)` and its inclusive span ends at `((x + w - 1) / 16,
 * (y + h - 1) / 16)`. 11-11: the atlas' 150 visited maps match the gid rule exactly; using the
 * top-left rule for gid objects is off by one row (checked over all 69 recorded chests).
 *
 * Treasure vs hidden item. In `entity_default.json` a treasure is `object_type == 7` with a
 * `content_id`. `treasure_box.csv`'s `treasure_type` 1 means a chest and 2 a hidden item; the
 * guide's "225 chests / 44 hidden items" and Tule's five hidden finds (150 Gil, Tent, Potion,
 * Phoenix Down, Leather Shoes) all agree with that mapping. A hidden object is also often
 * `pick_up: true` or `interactive_icon_type: 6` (Bone Mail, Great Sword), but those are only a
 * fallback when the master table is not supplied: the table is authoritative. The event-only
 * chest in `ev_e_0434.json` is not in `entity_default.json`; the task's count of 278 is the
 * entity set, so it is left to the event parser.
 */

import { cleanName } from "../icons.ts";
import { isRecord, list, num, records, text } from "../values.ts";
import {
  JUMP_DELTAS,
  JUMP_FACINGS,
  type JumpFacing,
  type JumpKind,
  type MapJump,
} from "./jumps.ts";

const TILE_SIZE = 16;
const WORLD_MAP_ID = 1;

export type CsvRow = Record<string, string>;

/** RFC-4180-ish CSV: quoted commas, doubled quotes, CRLF and a leading BOM. */
export function parseCsv(csvText: string): string[][] {
  const body = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      if (body[index + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsvTable(csvText: string): CsvRow[] {
  const rows = parseCsv(csvText);
  const header = rows[0];
  if (header === undefined) return [];
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell !== ""))
    .map((row) => {
      const result: Record<string, string> = {};
      header.forEach((column, index) => {
        result[column] = row[index] ?? "";
      });
      return result;
    });
}

export interface MapResource {
  readonly id: number;
  readonly name: string;
  readonly assetName: string;
  readonly packageName: string;
  readonly titleKey: string | null;
  readonly areaId: number | null;
  readonly saveAvailable: boolean | null;
  /** Dungeon random battles: `monster_set_id`; 0 means the map uses an encounter area. */
  readonly monsterSetId: number | null;
  /** World maps: `encount_area_grid_id`; 0 means the map is not a world map. */
  readonly encountAreaGridId: number | null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function noneAsNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" || trimmed === "None" ? null : trimmed;
}

/** `asset_name` is the lower-case package name (`map_20071`), the directory is `Map_20071`. */
export function packageNameOf(mapName: string, assetName: string): string {
  if (assetName !== "") return assetName.charAt(0).toUpperCase() + assetName.slice(1);
  return mapName.replace(/_\d+$/u, "");
}

export function parseMapCsv(csvText: string): MapResource[] {
  return parseCsvTable(csvText).flatMap((row) => {
    const id = integer(row.id);
    const name = (row.map_name ?? "").trim();
    if (id === null || id <= 0 || name === "") return [];
    const assetName = (row.asset_name ?? "").trim();
    const save = (row.save_availability ?? "").trim();
    return [
      {
        id,
        name,
        assetName,
        packageName: packageNameOf(name, assetName),
        titleKey: noneAsNull(row.map_title),
        areaId: integer(row.area_id),
        saveAvailable: save === "" ? null : save === "1",
        monsterSetId: integer(row.monster_set_id),
        encountAreaGridId: integer(row.encount_area_grid_id),
      },
    ];
  });
}

/** `script.csv`: the script id a map object's `script_id` names. */
export function parseScriptNames(csvText: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const row of parseCsvTable(csvText)) {
    const id = integer(row.id);
    const name = (row.script_name ?? "").trim();
    if (id !== null && name !== "") names.set(id, name);
  }
  return names;
}

export interface MonsterSetSlot {
  readonly partyId: number;
  readonly rate: number | null;
}

/** One `monster_set.csv` row: up to 16 parties and their step weights. */
export interface MonsterSetResource {
  readonly id: number;
  readonly slots: readonly MonsterSetSlot[];
}

export function parseMonsterSets(csvText: string): MonsterSetResource[] {
  return parseCsvTable(csvText).flatMap((row) => {
    const id = integer(row.id);
    if (id === null || id <= 0) return [];
    const slots: MonsterSetSlot[] = [];
    for (let index = 1; index <= 16; index += 1) {
      const partyId = integer(row[`monster_set${index}`]);
      if (partyId === null || partyId <= 0) continue;
      slots.push({ partyId, rate: integer(row[`monster_set${index}_rate`]) });
    }
    return [{ id, slots }];
  });
}

/** One `monster_party.csv` row: the monsters that fight together (duplicates removed). */
export interface MonsterPartyResource {
  readonly id: number;
  readonly monsterIds: readonly number[];
}

export function parseMonsterParties(csvText: string): MonsterPartyResource[] {
  return parseCsvTable(csvText).flatMap((row) => {
    const id = integer(row.id);
    if (id === null || id <= 0) return [];
    const monsterIds: number[] = [];
    for (let index = 1; index <= 9; index += 1) {
      const monsterId = integer(row[`monster${index}`]);
      if (monsterId !== null && monsterId > 0 && !monsterIds.includes(monsterId)) {
        monsterIds.push(monsterId);
      }
    }
    return [{ id, monsterIds }];
  });
}

/** `monster.csv` only contributes the message key and the boss bit; stats stay in the export. */
export interface MonsterResource {
  readonly id: number;
  readonly nameKey: string | null;
  readonly boss: boolean;
}

export function parseMonsterResources(csvText: string): MonsterResource[] {
  return parseCsvTable(csvText).flatMap((row) => {
    const id = integer(row.id);
    if (id === null || id <= 0) return [];
    return [
      {
        id,
        nameKey: noneAsNull(row.mes_id_name),
        boss: (row.boss ?? "").trim() === "1",
      },
    ];
  });
}

/** One `encount_area.csv` row: the encounter region and its per-foot monster sets. */
export interface EncounterAreaResource {
  readonly id: number;
  readonly gridNumber: number;
  readonly footSetIds: readonly number[];
}

export function parseEncounterAreas(csvText: string): EncounterAreaResource[] {
  return parseCsvTable(csvText).flatMap((row) => {
    const id = integer(row.id);
    const gridNumber = integer(row.encount_area_grid_number);
    if (id === null || id <= 0 || gridNumber === null) return [];
    const footSetIds: number[] = [];
    for (let index = 1; index <= 32; index += 1) {
      const setId = integer(row[`foot${String(index).padStart(2, "0")}_monster_set`]);
      // One entry per foot type, duplicates kept: the world-map weight uses how many terrain
      // types use a set, without claiming to know which terrain is underfoot.
      if (setId !== null && setId > 0) footSetIds.push(setId);
    }
    return [{ id, gridNumber, footSetIds }];
  });
}

/** `encount_area_grid.csv`: a world map's area numbering starts at `base_number`. */
export interface EncounterAreaGridResource {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly baseNumber: number;
  readonly xStartPoint: number;
  readonly yStartPoint: number;
}

export function parseEncounterAreaGrids(csvText: string): EncounterAreaGridResource[] {
  return parseCsvTable(csvText).flatMap((row) => {
    const id = integer(row.id);
    const baseNumber = integer(row.base_number);
    if (id === null || id <= 0 || baseNumber === null) return [];
    return [
      {
        id,
        width: integer(row.grid_width) ?? 0,
        height: integer(row.grid_height) ?? 0,
        baseNumber,
        xStartPoint: integer(row.x_start_point) ?? 0,
        yStartPoint: integer(row.y_start_point) ?? 0,
      },
    ];
  });
}

export interface GameMapChest {
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly contentId: number;
  readonly contentNum: number | null;
  readonly flagId: number | null;
  readonly hidden: boolean;
}

export interface GameMapPoint {
  readonly cell: readonly [number, number];
  readonly name: string;
}

/** The fields `scripts/game-files.mts` writes to `.deps/knowledge/<game>/files/maps/`. */
export interface GameMapFile {
  readonly id: number;
  readonly name: string;
  readonly areaId: number | null;
  readonly saveAvailable: boolean | null;
  readonly chests: readonly GameMapChest[];
  readonly savePoints: readonly GameMapPoint[];
  readonly restorePoints: readonly GameMapPoint[];
}

function jsonCell(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value)) return null;
  const x = integer(value[0]);
  const y = integer(value[1]);
  return x === null || y === null ? null : [x, y];
}

function jsonChest(value: unknown): GameMapChest | null {
  if (!isRecord(value)) return null;
  const cell = jsonCell(value.cell);
  const contentId = integer(value.contentId);
  const name = text(value.name) ?? "";
  if (cell === null || contentId === null) return null;
  return {
    cell,
    name,
    contentId,
    contentNum: integer(value.contentNum),
    flagId: integer(value.flagId),
    hidden: value.hidden === true,
  };
}

function jsonPoints(value: unknown): GameMapPoint[] {
  return records(value).flatMap((entry) => {
    const cell = jsonCell(entry.cell);
    if (cell === null) return [];
    return [{ cell, name: text(entry.name) ?? "" }];
  });
}

export function parseGameMapFile(value: unknown): GameMapFile | null {
  if (!isRecord(value)) return null;
  const id = integer(value.id);
  if (id === null || id <= 0) return null;
  return {
    id,
    name: text(value.name) ?? "",
    areaId: integer(value.areaId),
    saveAvailable: typeof value.saveAvailable === "boolean" ? value.saveAvailable : null,
    chests: records(value.chests).flatMap((chest) => {
      const parsed = jsonChest(chest);
      return parsed === null ? [] : [parsed];
    }),
    savePoints: jsonPoints(value.savePoints),
    restorePoints: jsonPoints(value.restorePoints),
  };
}

export type ItemKind = "item" | "weapon" | "armor" | "magic" | "command" | "gil" | "other";

const CONTENT_KINDS: Readonly<Record<number, ItemKind>> = {
  1: "item",
  2: "weapon",
  3: "armor",
  4: "magic",
  5: "gil",
  7: "command",
};

export interface ContentEntry {
  readonly id: number;
  readonly nameKey: string | null;
  readonly typeId: number | null;
  readonly typeValue: number | null;
  readonly kind: ItemKind;
}

export function parseContentCsv(csvText: string): ContentEntry[] {
  return parseCsvTable(csvText).flatMap((row) => {
    const id = integer(row.id);
    if (id === null || id <= 0) return [];
    const typeId = integer(row.type_id);
    return [
      {
        id,
        nameKey: noneAsNull(row.mes_id_name),
        typeId,
        typeValue: integer(row.type_value),
        kind: typeId === null ? "other" : (CONTENT_KINDS[typeId] ?? "other"),
      },
    ];
  });
}

/** `treasure_type` 1 = chest, 2 = hidden item; the map objects point at it by `flag_id`. */
export function parseTreasureBoxCsv(csvText: string): Map<number, number> {
  const types = new Map<number, number>();
  for (const row of parseCsvTable(csvText)) {
    const flag = integer(row.flag);
    const treasureType = integer(row.treasure_type);
    if (flag !== null && treasureType !== null) types.set(flag, treasureType);
  }
  return types;
}

export interface TrilingualNames {
  readonly ja: string | null;
  readonly en: string | null;
  readonly zhc: string | null;
}

export interface MessageTables {
  readonly ja: ReadonlyMap<string, string>;
  readonly en: ReadonlyMap<string, string>;
  readonly zhc: ReadonlyMap<string, string>;
}

/** The message files are `key<TAB>text`; the text may contain `<IC_...>` menu icon tags. */
export function parseMessageTable(messageText: string): Map<string, string> {
  const body = messageText.charCodeAt(0) === 0xfeff ? messageText.slice(1) : messageText;
  const messages = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab).trim();
    if (key === "") continue;
    messages.set(key, cleanName(line.slice(tab + 1)));
  }
  return messages;
}

export interface GameItem {
  readonly id: number;
  readonly kind: ItemKind;
  readonly typeId: number | null;
  readonly typeValue: number | null;
  readonly nameKey: string | null;
  readonly names: TrilingualNames;
}

export function buildItems(contents: readonly ContentEntry[], messages: MessageTables): GameItem[] {
  return contents.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    typeId: entry.typeId,
    typeValue: entry.typeValue,
    nameKey: entry.nameKey,
    names: {
      ja: entry.nameKey === null ? null : (messages.ja.get(entry.nameKey) ?? null),
      en: entry.nameKey === null ? null : (messages.en.get(entry.nameKey) ?? null),
      zhc: entry.nameKey === null ? null : (messages.zhc.get(entry.nameKey) ?? null),
    },
  }));
}

/**
 * Task 133: the map's three-language title (`map.csv`'s `map_title` through the message tables).
 * The English title is the direct evidence for a guide sub-location such as "Tule - Pub";
 * without a title key every language stays null instead of guessing from the map name.
 */
export function mapTitleNames(map: MapResource, messages: MessageTables): TrilingualNames {
  const key = map.titleKey;
  return {
    ja: key === null ? null : (messages.ja.get(key) ?? null),
    en: key === null ? null : (messages.en.get(key) ?? null),
    zhc: key === null ? null : (messages.zhc.get(key) ?? null),
  };
}

function propertyValue(object: unknown, name: string): unknown {
  if (!isRecord(object)) return undefined;
  for (const property of records(object.properties)) {
    if (text(property.name) === name) return property.value;
  }
  return undefined;
}

function objectNumber(object: unknown, key: string): number | null {
  if (!isRecord(object)) return null;
  return num(object[key]) ?? null;
}

function objectName(object: unknown): string {
  return isRecord(object) ? (text(object.name) ?? "") : "";
}

function objectType(object: unknown): number | null {
  return integer(propertyValue(object, "object_type"));
}

export function objectCell(object: unknown): [number, number] | null {
  const x = objectNumber(object, "x");
  const y = objectNumber(object, "y");
  if (x === null || y === null) return null;
  const gid = objectNumber(object, "gid");
  return [Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE) - (gid === null ? 0 : 1)];
}

export interface CellRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Inclusive cell span; a gid object occupies one cell at its bottom-left. */
export function objectRect(object: unknown): CellRect | null {
  const x = objectNumber(object, "x");
  const y = objectNumber(object, "y");
  if (x === null || y === null) return null;
  const width = objectNumber(object, "width") ?? 0;
  const height = objectNumber(object, "height") ?? 0;
  const gid = objectNumber(object, "gid");
  const x1 = Math.floor(x / TILE_SIZE);
  const y1 = Math.floor(y / TILE_SIZE) - (gid === null ? 0 : 1);
  const x2 = width > 0 ? Math.floor((x + width - 1) / TILE_SIZE) : x1;
  const y2 = gid !== null ? y1 : height > 0 ? Math.floor((y + height - 1) / TILE_SIZE) : y1;
  return { x1, y1, x2, y2 };
}

export interface CollisionLayer {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** One string per row, one character per cell; values are kept as the file has them. */
  readonly rows: readonly string[];
}

export interface ValueLayer {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly (readonly [number, number, number])[];
}

function tileLayers(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    for (const layer of records(node.layers)) {
      found.push(layer);
      walk(layer);
    }
  };
  walk(value);
  return found;
}

function tileLayerSize(layer: Record<string, unknown>): [number, number] | null {
  const width = integer(layer.width);
  const height = integer(layer.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return [width, height];
}

export function parseCollisionLayers(value: unknown): CollisionLayer[] {
  const layers: CollisionLayer[] = [];
  for (const layer of tileLayers(value)) {
    if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
    const size = tileLayerSize(layer);
    if (size === null) continue;
    const [width, height] = size;
    const data = layer.data;
    const rows: string[] = [];
    for (let y = 0; y < height; y += 1) {
      let row = "";
      for (let x = 0; x < width; x += 1) {
        row += String(integer(data[y * width + x]) ?? 0);
      }
      rows.push(row);
    }
    layers.push({ name: text(layer.name) ?? "", width, height, rows });
  }
  return layers;
}

/** Damage and hidden-passage layers: only the non-zero cells matter, so drop the zero grid. */
export function parseValueLayers(value: unknown): ValueLayer[] {
  const layers: ValueLayer[] = [];
  for (const layer of tileLayers(value)) {
    if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
    const size = tileLayerSize(layer);
    if (size === null) continue;
    const [width, height] = size;
    const data = layer.data;
    const cells: (readonly [number, number, number])[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cell = integer(data[y * width + x]);
        if (cell !== null && cell !== 0) cells.push([x, y, cell]);
      }
    }
    layers.push({ name: text(layer.name) ?? "", width, height, cells });
  }
  return layers;
}

/** The world-map terrain codes `attribute.json` keeps, one value per cell. */
export interface WorldAttribute {
  readonly width: number;
  readonly height: number;
  readonly values: readonly number[];
}

/** The first tile layer of `attribute.json`; the world map has one. */
export function parseAttributeLayer(value: unknown): WorldAttribute | null {
  for (const layer of tileLayers(value)) {
    if (layer.type !== "tilelayer" || !Array.isArray(layer.data)) continue;
    const size = tileLayerSize(layer);
    if (size === null) continue;
    const [width, height] = size;
    const values: number[] = [];
    for (let index = 0; index < width * height; index += 1) {
      values.push(integer(layer.data[index]) ?? 0);
    }
    return { width, height, values };
  }
  return null;
}

/** One vehicle family: group 1 walks, 2 sails, 3 rides a chocobo, 6 flies an airship. */
export type WorldMode =
  "walk" | "chocobo" | "blackChocobo" | "ship" | "drake" | "airship" | "submarine";

/** The `transportation_group.csv` row a mode uses; the flags are indexed by attribute value. */
export const WORLD_GROUP_MODES: ReadonlyMap<number, WorldMode> = new Map([
  [1, "walk"],
  [2, "ship"],
  [3, "chocobo"],
  [4, "drake"],
  [5, "blackChocobo"],
  [6, "airship"],
  [7, "submarine"],
]);

function groupColumn(row: CsvRow, index: number): string {
  return row[`type${index}`] ?? row[`type_${index}`] ?? "0";
}

/**
 * `transportation_group.csv`: each row's 32 flags say which attribute values that vehicle may
 * enter. The header is `type1..type3,type_4..type_32`, so columns are read by number.
 */
export function parseTransportationGroups(csvText: string): Map<number, ReadonlySet<number>> {
  const groups = new Map<number, ReadonlySet<number>>();
  for (const row of parseCsvTable(csvText)) {
    const id = integer(row.id);
    if (id === null) continue;
    const allowed = new Set<number>();
    for (let index = 1; index <= 32; index += 1) {
      if (groupColumn(row, index).trim() === "1") allowed.add(index);
    }
    groups.set(id, allowed);
  }
  return groups;
}

/** One world-map arrival marker: `object_id` is what a `ChangeMap` script's point names. */
export interface WorldArrival {
  readonly point: number;
  readonly cell: readonly [number, number];
  readonly name: string;
}

export function parseWorldArrivals(value: unknown): WorldArrival[] {
  const found: WorldArrival[] = [];
  for (const layer of tileLayers(value)) {
    for (const object of records(layer.objects)) {
      if (objectType(object) !== 0) continue;
      const point = integer(propertyValue(object, "object_id"));
      const cell = objectCell(object);
      const name = objectName(object);
      if (point === null || point <= 0 || cell === null) continue;
      found.push({ point, cell, name });
    }
  }
  return found;
}

/** A `ChangeMap` from an interior map to a world map and its arrival point. */
export interface WorldExit {
  readonly to: number;
  readonly point: number;
}

/** `ChangeMap(worldMap, point, ...)` entries in a map's `*_to_world` scripts. */
export function parseWorldExitScripts(
  scripts: readonly { readonly file: string; readonly value: unknown }[],
  worldIds: ReadonlySet<number>,
): WorldExit[] {
  const found: WorldExit[] = [];
  const seen = new Set<string>();
  for (const script of scripts) {
    if (!isRecord(script.value)) continue;
    for (const mnemonic of records(script.value.Mnemonics)) {
      if (text(mnemonic.mnemonic) !== "ChangeMap") continue;
      const operands = mnemonic.operands;
      if (!isRecord(operands)) continue;
      const values = list(operands.iValues);
      const to = integer(values[0]);
      const point = integer(values[1]);
      if (to === null || point === null || point <= 0 || !worldIds.has(to)) continue;
      const key = `${to}:${point}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ to, point });
    }
  }
  return found;
}

export interface WorldMapData {
  readonly width: number;
  readonly height: number;
  readonly modes: Readonly<Partial<Record<WorldMode, readonly string[]>>>;
  readonly points: readonly WorldArrival[];
}

/** Per-mode passability rows, one "0"/"1" per cell, from the attribute values and group flags. */
export function buildWorldMap(
  attribute: WorldAttribute,
  groups: ReadonlyMap<number, ReadonlySet<number>>,
  points: readonly WorldArrival[],
): WorldMapData {
  const modes: Partial<Record<WorldMode, readonly string[]>> = {};
  for (const [groupId, mode] of WORLD_GROUP_MODES) {
    const allowed = groups.get(groupId);
    if (allowed === undefined) continue;
    const rows: string[] = [];
    for (let y = 0; y < attribute.height; y += 1) {
      let row = "";
      for (let x = 0; x < attribute.width; x += 1) {
        row += allowed.has(attribute.values[y * attribute.width + x] ?? 0) ? "1" : "0";
      }
      rows.push(row);
    }
    modes[mode] = rows;
  }
  return { width: attribute.width, height: attribute.height, modes, points };
}

/** World maps are the `Map_100xx` resources; their id is also what `ChangeMap` names. */
export function isWorldMapResource(map: MapResource): boolean {
  return map.name.startsWith("Map_100");
}

export interface Treasure {
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly contentId: number;
  readonly contentNum: number | null;
  readonly flagId: number | null;
  readonly hidden: boolean;
}

export interface Exit {
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly toMap: number;
  readonly toPoint: number | null;
  readonly kind: "goto" | "world" | "event";
}

export interface EventTrigger {
  readonly file: string;
  readonly name: string;
  readonly cell: readonly [number, number] | null;
  readonly rect: CellRect | null;
  readonly scriptId: number | null;
  readonly objectType: number | null;
}

export interface Npc {
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly objectType: number;
  readonly file: string;
  readonly entityId: number | null;
  readonly messageKey: string | null;
  readonly scriptId: number | null;
  readonly shopId: number | null;
}

export interface Marker {
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly objectType: number | null;
}

export interface MoveArea {
  readonly cell: readonly [number, number];
  readonly rect: CellRect;
  readonly name: string;
}

export interface UnresolvedObject {
  readonly file: string;
  readonly objectType: number | null;
  readonly name: string;
  readonly reason: string;
}

export interface EntityParse {
  readonly chests: readonly Treasure[];
  readonly exits: readonly Exit[];
  readonly npcs: readonly Npc[];
  readonly savePoints: readonly Marker[];
  readonly restorePoints: readonly Marker[];
  readonly moveAreas: readonly MoveArea[];
  readonly unresolved: readonly UnresolvedObject[];
}

const KNOWN_OBJECT_TYPES = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 22, 23, 25, 26, 28,
]);

function entityObjects(value: unknown): {
  objects: unknown[];
  unresolved: UnresolvedObject[];
} {
  const objects: unknown[] = [];
  const unresolved: UnresolvedObject[] = [];
  for (const layer of tileLayers(value)) {
    for (const object of records(layer.objects)) {
      objects.push(object);
      const type = objectType(object);
      if (type === null) {
        unresolved.push({
          file: "entity_default.json",
          objectType: null,
          name: objectName(object),
          reason: "缺少 object_type",
        });
      } else if (!KNOWN_OBJECT_TYPES.has(type)) {
        unresolved.push({
          file: "entity_default.json",
          objectType: type,
          name: objectName(object),
          reason: `未知 object_type ${type}`,
        });
      }
    }
  }
  return { objects, unresolved };
}

function isWorldMapName(name: string): boolean {
  return /ワールドマップ|第[一二三]世界/u.test(name);
}

function dedupeMarkers(markers: readonly Marker[]): Marker[] {
  const seen = new Set<string>();
  return markers.filter((marker) => {
    const key = `${marker.cell[0]},${marker.cell[1]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function npcObject(object: unknown, file: string): Npc | null {
  const type = objectType(object);
  const cell = objectCell(object);
  const name = objectName(object);
  if ((type !== 6 && type !== 17) || cell === null || name === "") return null;
  return {
    cell,
    name,
    objectType: type,
    file,
    entityId: integer(propertyValue(object, "entity_id")),
    messageKey: noneAsNull(text(propertyValue(object, "message_key"))),
    scriptId: integer(propertyValue(object, "script_id")),
    shopId: type === 17 ? integer(propertyValue(object, "product_group_id")) : null,
  };
}

function dedupeNpcs(npcs: readonly Npc[]): Npc[] {
  const seen = new Set<string>();
  return npcs.filter((npc) => {
    const key =
      npc.entityId === null
        ? `${npc.cell[0]},${npc.cell[1]},${npc.name}`
        : `entity:${npc.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseEntity(
  value: unknown,
  treasureTypes?: ReadonlyMap<number, number>,
): EntityParse {
  const { objects, unresolved } = entityObjects(value);
  const chests: Treasure[] = [];
  const exits: Exit[] = [];
  const npcs: Npc[] = [];
  const savePoints: Marker[] = [];
  const restorePoints: Marker[] = [];
  const moveAreas: MoveArea[] = [];

  for (const object of objects) {
    const type = objectType(object);
    const cell = objectCell(object);
    const name = objectName(object);
    if (type === 7 && cell !== null) {
      const contentId = integer(propertyValue(object, "content_id"));
      if (contentId !== null) {
        const icon = integer(propertyValue(object, "interactive_icon_type"));
        const flagId = integer(propertyValue(object, "flag_id"));
        const treasureType = flagId === null ? undefined : treasureTypes?.get(flagId);
        chests.push({
          cell,
          name,
          contentId,
          contentNum: integer(propertyValue(object, "content_num")),
          flagId,
          hidden:
            treasureType !== undefined
              ? treasureType === 2
              : propertyValue(object, "pick_up") === true || icon === 6,
        });
      }
    } else if (type === 3 && cell !== null) {
      const toMap = integer(propertyValue(object, "map_id"));
      if (toMap !== null && toMap > 0) {
        exits.push({
          cell,
          name,
          toMap,
          toPoint: integer(propertyValue(object, "point_id")),
          kind: "goto",
        });
      }
    } else if (type === 2 && cell !== null && isWorldMapName(name)) {
      exits.push({
        cell,
        name,
        toMap: WORLD_MAP_ID,
        toPoint: null,
        kind: "world",
      });
    } else if (type === 6 || type === 17) {
      const npc = npcObject(object, "entity_default.json");
      if (npc !== null) npcs.push(npc);
    } else if (cell !== null && /セーブポイント|SavePoint/u.test(name)) {
      savePoints.push({ cell, name, objectType: type });
    } else if (
      cell !== null &&
      /回復|休憩|少し眠る|HP\/MP完全回復|ベッド頭/u.test(name) &&
      !name.includes("制御用")
    ) {
      restorePoints.push({ cell, name, objectType: type });
    } else if (type === 13) {
      const rect = objectRect(object);
      if (rect !== null && cell !== null) moveAreas.push({ cell, rect, name });
    }
  }

  return {
    chests,
    exits,
    npcs,
    savePoints: dedupeMarkers(savePoints),
    restorePoints: dedupeMarkers(restorePoints),
    moveAreas,
    unresolved,
  };
}

/** One inline script the package's `map[].script[]` carries (already base64-decoded). */
export interface InlineScript {
  readonly name: string;
  readonly value: unknown;
}

/**
 * Task 128: a world-map event object (object_type 2) whose script runs ChangeMap is an entrance
 * that GotoMap objects do not expose. 11-11 live: the pirate hideout at (165,115) is such an
 * event; without it the route analyser fell back to the whole world map.
 */
export function parseEventExits(
  entities: unknown,
  scriptNames: ReadonlyMap<number, string>,
  scripts: readonly InlineScript[],
): Exit[] {
  const found: Exit[] = [];
  const seen = new Set<string>();
  for (const object of entityObjects(entities).objects) {
    if (objectType(object) !== 2) continue;
    const scriptId = integer(propertyValue(object, "script_id"));
    const cell = objectCell(object);
    if (scriptId === null || cell === null) continue;
    const scriptName = scriptNames.get(scriptId);
    if (scriptName === undefined) continue;
    const script = scripts.find((entry) => entry.name === scriptName);
    if (script === undefined || !isRecord(script.value)) continue;
    const name = objectName(object);
    for (const mnemonic of records(script.value.Mnemonics)) {
      if (text(mnemonic.mnemonic) !== "ChangeMap") continue;
      const operands = mnemonic.operands;
      if (!isRecord(operands)) continue;
      const values = list(operands.iValues);
      const toMap = integer(values[0]);
      if (toMap === null || toMap <= 0 || toMap === WORLD_MAP_ID) continue;
      const point = integer(values[1]);
      const toPoint = point !== null && point > 0 ? point : null;
      const key = `${cell[0]},${cell[1]}:${toMap}:${toPoint ?? "-"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ cell, name, toMap, toPoint, kind: "event" });
    }
  }
  return found;
}

export function parseEventFile(file: string, value: unknown): EventTrigger[] {
  const triggers: EventTrigger[] = [];
  for (const layer of tileLayers(value)) {
    for (const object of records(layer.objects)) {
      const name = objectName(object);
      const type = objectType(object);
      const scriptId = integer(propertyValue(object, "script_id"));
      const named = /^(?:sc_|ev_e_)/u.test(name);
      if (!named && !(type === 2 && scriptId !== null && scriptId > 0)) continue;
      if (name === "") continue;
      triggers.push({
        file,
        name,
        cell: objectCell(object),
        rect: objectRect(object),
        scriptId,
        objectType: type,
      });
    }
  }
  return triggers;
}

export function parseEventNpcs(file: string, value: unknown): Npc[] {
  const npcs: Npc[] = [];
  for (const layer of tileLayers(value)) {
    for (const object of records(layer.objects)) {
      const npc = npcObject(object, file);
      if (npc !== null) npcs.push(npc);
    }
  }
  return npcs;
}


/** One mnemonic reduced to what the jump reader needs: name, integer operands, label. */
interface ScriptInstruction {
  readonly mnemonic: string;
  readonly values: readonly number[];
  readonly label: string;
}

function scriptProgram(value: unknown): readonly ScriptInstruction[] | null {
  if (!isRecord(value) || !Array.isArray(value.Mnemonics)) return null;
  const instructions: ScriptInstruction[] = [];
  for (const entry of records(value.Mnemonics)) {
    const mnemonic = text(entry.mnemonic) ?? "";
    if (mnemonic === "") continue;
    const operands = isRecord(entry.operands) ? entry.operands : {};
    instructions.push({
      mnemonic,
      values: list(operands.iValues).map((item) => integer(item) ?? 0),
      label: text(entry.label) ?? "",
    });
  }
  return instructions.length === 0 ? null : instructions;
}

type PlayerSteps = readonly (readonly [direction: number, cells: number])[];

/**
 * The player's `Move` sequence. `SetPuppet` slot 0 with entity -1001 is the player (other
 * slots carry NPCs); its third operand is the script entry to run. `Call` follows the same
 * entry numbering the labels use. A script without a direction branch runs one sequence for
 * every facing, so all four facings share it.
 */
function playerPaths(instructions: readonly ScriptInstruction[]): Map<JumpFacing, PlayerSteps> {
  const run = (entry: number): PlayerSteps | null => {
    const steps: (readonly [number, number])[] = [];
    const returns: number[] = [];
    const seen = new Set<number>();
    let index = entry;
    for (let guard = 0; guard < 1024; guard += 1) {
      const instruction = instructions[index];
      if (instruction === undefined) break;
      if (seen.has(index)) return null;
      seen.add(index);
      if (instruction.mnemonic === "Move") {
        const direction = instruction.values[0] ?? -1;
        const cells = instruction.values[1] ?? 0;
        if (direction < 0 || direction > 3 || cells <= 0 || cells > 64) return null;
        steps.push([direction, cells]);
        index += 1;
        continue;
      }
      if (instruction.mnemonic === "SetPuppet" && instruction.values[1] === -1001) {
        const target = instruction.values[2] ?? -1;
        if (target < 0 || target >= instructions.length) return null;
        returns.push(index + 1);
        index = target;
        continue;
      }
      if (instruction.mnemonic === "Call") {
        const target = instruction.values[0] ?? -1;
        if (target < 0 || target >= instructions.length) return null;
        returns.push(index + 1);
        index = target;
        continue;
      }
      if (instruction.mnemonic === "Exit" || instruction.mnemonic === "ChangeScript") break;
      if (instruction.mnemonic === "Return") {
        const next = returns.pop();
        if (next === undefined) break;
        index = next;
        continue;
      }
      index += 1;
    }
    return steps.length === 0 ? null : steps;
  };

  const paths = new Map<JumpFacing, PlayerSteps>();
  const branch = instructions.find((item) => item.mnemonic === "BranchByPlayerDirection");
  if (branch !== undefined) {
    JUMP_FACINGS.forEach((facing, direction) => {
      const target = branch.values[direction] ?? 0;
      if (target <= 0 || target >= instructions.length) return;
      const steps = run(target);
      if (steps !== null) paths.set(facing, steps);
    });
    return paths;
  }
  const puppet = instructions.find(
    (item) => item.mnemonic === "SetPuppet" && item.values[1] === -1001,
  );
  if (puppet === undefined) return paths;
  const steps = run(puppet.values[2] ?? -1);
  if (steps !== null) for (const facing of JUMP_FACINGS) paths.set(facing, steps);
  return paths;
}

interface JumpLayer {
  readonly width: number;
  readonly height: number;
  readonly walkable: readonly boolean[];
  readonly components: Int32Array;
}

const JUMP_WALKABLE = new Set(["0", "2", "3", "4", "5"]);

function jumpLayerRows(rows: readonly string[]): JumpLayer | null {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (width === 0 || height === 0) return null;
  const walkable = new Array<boolean>(width * height).fill(false);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y] ?? "";
    for (let x = 0; x < width; x += 1) {
      walkable[y * width + x] = JUMP_WALKABLE.has(row[x] ?? "");
    }
  }
  const components = new Int32Array(width * height).fill(-1);
  let next = 0;
  const queue: number[] = [];
  for (let start = 0; start < walkable.length; start += 1) {
    if (walkable[start] !== true || components[start] !== -1) continue;
    components[start] = next;
    queue.length = 0;
    queue.push(start);
    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head] ?? 0;
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx;
        if (walkable[neighbour] !== true || components[neighbour] !== -1) continue;
        components[neighbour] = next;
        queue.push(neighbour);
      }
    }
    next += 1;
  }
  return { width, height, walkable, components };
}

function jumpCell(layer: JumpLayer, cell: readonly [number, number]): number | null {
  if (cell[0] < 0 || cell[1] < 0 || cell[0] >= layer.width || cell[1] >= layer.height) return null;
  return cell[1] * layer.width + cell[0];
}

function jumpLanding(start: readonly [number, number], steps: PlayerSteps): [number, number] {
  let x = start[0];
  let y = start[1];
  for (const [direction, cells] of steps) {
    const delta = JUMP_DELTAS[JUMP_FACINGS[direction] ?? "Up"];
    x += delta[0] * cells;
    y += delta[1] * cells;
  }
  return [x, y];
}

export interface JumpSkip {
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly scriptId: number | null;
  readonly reason: string;
}

export interface JumpParse {
  readonly jumps: readonly MapJump[];
  readonly skipped: readonly JumpSkip[];
}

/**
 * Task 149: read the jump objects of one map. A candidate is an `object_type` 2 (step on) or
 * 5 (touch/confirm) object with a `script_id`. The script must name the player puppet
 * (`SetPuppet` entity -1001), the `Move` sequence must be readable, and the computed landing
 * must be walkable on the same collision layer but in a different connected block. Anything
 * else is recorded in `skipped` for the export summary instead of guessed at.
 *
 * Facing: `BranchByPlayerDirection`'s first four operands are the branch labels for
 * Up, Right, Down, Left (jump_10's [5,0,2,0] points at its 上向き/下向き labels; jump_11's
 * [0,5,0,2] at 右向き/左向き). A touch object is used from the cell in front of it, so the
 * party stands at `cell - facing` and looks at the object. A step object is entered from the
 * same cell and the entry direction is the facing. The walk itself runs from that stand cell.
 */
export function parseJumps(
  entity: unknown,
  scripts: readonly { readonly file: string; readonly value: unknown }[],
  scriptNames: ReadonlyMap<number, string> | undefined,
  layers: readonly CollisionLayer[],
): JumpParse {
  const jumps: MapJump[] = [];
  const skipped: JumpSkip[] = [];
  const seen = new Set<string>();
  const layersReady = layers.map((layer) => jumpLayerRows(layer.rows)).filter((layer) => layer !== null);
  if (layersReady.length === 0) return { jumps, skipped };
  for (const layer of tileLayers(entity)) {
    for (const object of records(layer.objects)) {
      const type = objectType(object);
      if (type !== 2 && type !== 5) continue;
      const scriptId = integer(propertyValue(object, "script_id"));
      if (scriptId === null || scriptId <= 0) continue;
      const cell = objectCell(object);
      if (cell === null) continue;
      const name = objectName(object);
      const skip = (reason: string): void => {
        skipped.push({ cell, name, scriptId, reason });
      };
      const scriptName = scriptNames?.get(scriptId);
      if (scriptName === undefined) {
        skip(`script.csv 里没有脚本 ${scriptId}`);
        continue;
      }
      const script = scripts.find(
        (item) => item.file === `${scriptName}.json` || item.file === scriptName,
      );
      if (script === undefined) {
        skip(`没有脚本文件 ${scriptName}`);
        continue;
      }
      const instructions = scriptProgram(script.value);
      if (instructions === null) {
        skip(`脚本 ${scriptName} 读不懂`);
        continue;
      }
      const paths = playerPaths(instructions);
      if (paths.size === 0) {
        skip(`脚本 ${scriptName} 没有玩家的 Move`);
        continue;
      }
      const kind: JumpKind = type === 2 ? "step" : "touch";
      let found = false;
      for (const feature of layersReady) {
        const startIndex = jumpCell(feature, cell);
        if (startIndex === null) continue;
        if (kind === "step" && feature.walkable[startIndex] !== true) continue;
        for (const facing of JUMP_FACINGS) {
          const steps = paths.get(facing);
          if (steps === undefined) continue;
          const delta = JUMP_DELTAS[facing];
          const stand: [number, number] = [cell[0] - delta[0], cell[1] - delta[1]];
          const standIndex = jumpCell(feature, stand);
          if (standIndex === null || feature.walkable[standIndex] !== true) continue;
          const start = kind === "step" ? cell : stand;
          const startBlock = feature.components[kind === "step" ? startIndex : standIndex] ?? -1;
          const land = jumpLanding(start, steps);
          const landIndex = jumpCell(feature, land);
          if (landIndex === null || feature.walkable[landIndex] !== true) continue;
          const landBlock = feature.components[landIndex] ?? -1;
          if (startBlock < 0 || landBlock < 0 || startBlock === landBlock) continue;
          const key = `${cell[0]},${cell[1]}:${kind}:${facing}:${land[0]},${land[1]}`;
          if (seen.has(key)) {
            found = true;
            continue;
          }
          seen.add(key);
          jumps.push({ cell, kind, facing, land, script: scriptName });
          found = true;
        }
      }
      if (!found) skip(`脚本 ${scriptName} 的落点不可走或和起点同一块`);
    }
  }
  return { jumps, skipped };
}

export interface MapFileSet {
  readonly map: MapResource;
  readonly entity: unknown;
  readonly treasureTypes?: ReadonlyMap<number, number>;
  readonly collision: unknown;
  readonly damage: unknown;
  readonly hiddenPassage: unknown;
  readonly events: readonly {
    readonly file: string;
    readonly value: unknown;
  }[];
  /** Task 123: the world map's `attribute.json`; only the `Map_100xx` resources have one. */
  readonly attribute?: unknown;
  /** Task 123: scripts read for `ChangeMap(worldMap, point, ...)` world exits. */
  readonly scripts?: readonly {
    readonly file: string;
    readonly value: unknown;
  }[];
  /** Task 149: every `sc_*.json` of the map, for the jump-object reader. */
  readonly jumpScripts?: readonly {
    readonly file: string;
    readonly value: unknown;
  }[];
  /** Task 128: object `script_id` → `script.csv` name, for world-map event entrances. */
  readonly scriptNames?: ReadonlyMap<number, string>;
  /** Task 128: world-map package scripts (inline base64 already decoded by the caller). */
  readonly packageScripts?: readonly InlineScript[];
  readonly transportationGroups?: ReadonlyMap<number, ReadonlySet<number>>;
  readonly worldIds?: ReadonlySet<number>;
}

export interface ParsedMap extends EntityParse {
  readonly map: MapResource;
  readonly events: readonly EventTrigger[];
  /** Task 149: script-moved jumps, each already checked against the collision blocks. */
  readonly jumps: readonly MapJump[];
  /** Task 149: candidate objects whose script or landing could not be read. */
  readonly jumpSkipped: readonly JumpSkip[];
  readonly collision: readonly CollisionLayer[];
  readonly damage: readonly ValueLayer[];
  readonly hiddenPassages: readonly ValueLayer[];
  /** Task 123: per-vehicle world-map passability and arrival points. */
  readonly world?: WorldMapData;
  /** Task 123: world-map arrival points this interior map's exit scripts name. */
  readonly worldExits?: readonly WorldExit[];
}

export function parseSubmap(files: MapFileSet): ParsedMap {
  const entity = parseEntity(files.entity, files.treasureTypes);
  const collision = parseCollisionLayers(files.collision);
  const jumpParse = parseJumps(files.entity, files.jumpScripts ?? [], files.scriptNames, collision);
  const events = files.events.flatMap((event) => parseEventFile(event.file, event.value));
  const eventNpcs = files.events.flatMap((event) => parseEventNpcs(event.file, event.value));
  const attribute = files.attribute;
  const groups = files.transportationGroups;
  const world =
    isWorldMapResource(files.map) && attribute !== undefined && groups !== undefined
      ? (() => {
          const parsed = parseAttributeLayer(attribute);
          return parsed === null
            ? undefined
            : buildWorldMap(parsed, groups, parseWorldArrivals(files.entity));
        })()
      : undefined;
  const worldExits =
    files.scripts !== undefined && files.worldIds !== undefined
      ? parseWorldExitScripts(files.scripts, files.worldIds)
      : [];
  const eventExits =
    isWorldMapResource(files.map) &&
    files.scriptNames !== undefined &&
    files.packageScripts !== undefined
      ? parseEventExits(files.entity, files.scriptNames, files.packageScripts)
      : [];
  const exits = [...entity.exits];
  for (const exit of eventExits) {
    if (
      exits.some(
        (known) =>
          known.cell[0] === exit.cell[0] &&
          known.cell[1] === exit.cell[1] &&
          known.toMap === exit.toMap &&
          known.toPoint === exit.toPoint,
      )
    ) {
      continue;
    }
    exits.push(exit);
  }
  return {
    map: files.map,
    ...entity,
    exits,
    npcs: dedupeNpcs([...entity.npcs, ...eventNpcs]),
    events,
    jumps: jumpParse.jumps,
    jumpSkipped: jumpParse.skipped,
    collision,
    damage: parseValueLayers(files.damage),
    hiddenPassages: parseValueLayers(files.hiddenPassage),
    ...(world === undefined ? {} : { world }),
    ...(worldExits.length === 0 ? {} : { worldExits }),
  };
}

function readCell(value: unknown): [number, number] | null {
  if (isRecord(value)) {
    const x = integer(value.x);
    const y = integer(value.y);
    return x === null || y === null ? null : [x, y];
  }
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = integer(value[0]);
  const y = integer(value[1]);
  return x === null || y === null ? null : [x, y];
}

function cellText(cell: readonly [number, number]): string {
  return `${cell[0]},${cell[1]}`;
}

export interface AtlasMismatch {
  readonly mapId: number;
  readonly mapName: string;
  readonly kind: "map" | "chest" | "exit";
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

export interface AtlasComparison {
  readonly mapsCompared: number;
  readonly missingMaps: number;
  readonly chestsCompared: number;
  readonly chestsMatched: number;
  readonly exitsCompared: number;
  readonly exitsMatched: number;
  readonly mismatches: readonly AtlasMismatch[];
}

function atlasChests(record: Record<string, unknown>): Set<string> {
  const chests = new Set<string>();
  for (const entry of records(record.chests)) {
    const cell = readCell(entry.cell);
    if (cell !== null) chests.add(cellText(cell));
  }
  return chests;
}

function atlasExits(record: Record<string, unknown>): Set<string> {
  const exits = new Set<string>();
  for (const entry of records(record.exits)) {
    const cell = readCell(entry.cell);
    const to = integer(entry.to);
    if (cell !== null && to !== null) exits.add(`${cellText(cell)}->${to}`);
  }
  return exits;
}

/** Compare the atlas (visited maps only) by map id; every recorded chest and exit counts. */
export function compareAtlas(maps: readonly ParsedMap[], atlas: unknown): AtlasComparison {
  const byId = new Map(maps.map((map) => [map.map.id, map]));
  let mapsCompared = 0;
  let missingMaps = 0;
  let chestsCompared = 0;
  let chestsMatched = 0;
  let exitsCompared = 0;
  let exitsMatched = 0;
  const mismatches: AtlasMismatch[] = [];
  if (!isRecord(atlas)) {
    return {
      mapsCompared,
      missingMaps,
      chestsCompared,
      chestsMatched,
      exitsCompared,
      exitsMatched,
      mismatches,
    };
  }
  for (const [key, record] of Object.entries(atlas)) {
    if (!isRecord(record)) continue;
    const mapId = integer(key);
    if (mapId === null || mapId <= 0) continue;
    mapsCompared += 1;
    const map = byId.get(mapId);
    const mapName = text(record.name) ?? map?.map.name ?? "";
    if (map === undefined) {
      missingMaps += 1;
      mismatches.push({
        mapId,
        mapName,
        kind: "map",
        missing: ["整张地图"],
        extra: [],
      });
      continue;
    }
    const expectedChests = atlasChests(record);
    const actualChests = new Set(map.chests.map((chest) => cellText(chest.cell)));
    chestsCompared += expectedChests.size;
    for (const cell of expectedChests) {
      if (actualChests.has(cell)) chestsMatched += 1;
    }
    const missingChests = [...expectedChests].filter((cell) => !actualChests.has(cell));
    const extraChests = [...actualChests].filter((cell) => !expectedChests.has(cell));
    if (missingChests.length > 0 || extraChests.length > 0) {
      mismatches.push({
        mapId,
        mapName,
        kind: "chest",
        missing: missingChests,
        extra: extraChests,
      });
    }
    const expectedExits = atlasExits(record);
    const actualExits = new Set(map.exits.map((exit) => `${cellText(exit.cell)}->${exit.toMap}`));
    exitsCompared += expectedExits.size;
    for (const exit of expectedExits) {
      if (actualExits.has(exit)) exitsMatched += 1;
    }
    const missingExits = [...expectedExits].filter((exit) => !actualExits.has(exit));
    const extraExits = [...actualExits].filter((exit) => !expectedExits.has(exit));
    if (missingExits.length > 0 || extraExits.length > 0) {
      mismatches.push({
        mapId,
        mapName,
        kind: "exit",
        missing: missingExits,
        extra: extraExits,
      });
    }
  }
  return {
    mapsCompared,
    missingMaps,
    chestsCompared,
    chestsMatched,
    exitsCompared,
    exitsMatched,
    mismatches,
  };
}

export interface CollisionMismatch {
  readonly mapId: number;
  readonly mapName: string;
  readonly layer: string;
  readonly reason: string;
  readonly cells: number;
  readonly examples: readonly (readonly [number, number, string, string])[];
}

export interface CollisionComparison {
  readonly mapsCompared: number;
  readonly missingMaps: number;
  readonly layersCompared: number;
  readonly cellsCompared: number;
  readonly cellsMatched: number;
  readonly mismatches: readonly CollisionMismatch[];
}

function cacheLayers(value: unknown): { name: string; rows: string[] }[] {
  if (!isRecord(value)) return [];
  const layers: { name: string; rows: string[] }[] = [];
  for (const layer of records(value.layers)) {
    const name = text(layer.name) ?? "";
    const rows = list(layer.rows).filter((row): row is string => typeof row === "string");
    layers.push({ name, rows });
  }
  return layers;
}

/** Compare every cached collision cell exactly; the cache keeps values 2-7, not just 0/1. */
export function compareCollisions(
  maps: readonly ParsedMap[],
  caches: unknown,
): CollisionComparison {
  const byId = new Map(maps.map((map) => [map.map.id, map]));
  let mapsCompared = 0;
  let missingMaps = 0;
  let layersCompared = 0;
  let cellsCompared = 0;
  let cellsMatched = 0;
  const mismatches: CollisionMismatch[] = [];
  if (!isRecord(caches)) {
    return {
      mapsCompared,
      missingMaps,
      layersCompared,
      cellsCompared,
      cellsMatched,
      mismatches,
    };
  }
  for (const [key, cache] of Object.entries(caches)) {
    const mapId = integer(key);
    if (mapId === null || !isRecord(cache)) continue;
    mapsCompared += 1;
    const map = byId.get(mapId);
    const mapName = map?.map.name ?? "";
    if (map === undefined) {
      missingMaps += 1;
      mismatches.push({
        mapId,
        mapName,
        layer: "",
        reason: "数据里没有这张地图",
        cells: 0,
        examples: [],
      });
      continue;
    }
    for (const cacheLayer of cacheLayers(cache)) {
      layersCompared += 1;
      const parsed = map.collision.find((layer) => layer.name === cacheLayer.name);
      if (parsed === undefined) {
        mismatches.push({
          mapId,
          mapName,
          layer: cacheLayer.name,
          reason: "数据里没有这一层",
          cells: 0,
          examples: [],
        });
        continue;
      }
      const cacheWidth = cacheLayer.rows[0]?.length ?? 0;
      const cacheHeight = cacheLayer.rows.length;
      const width = Math.max(parsed.width, cacheWidth);
      const height = Math.max(parsed.height, cacheHeight);
      let bad = 0;
      const examples: (readonly [number, number, string, string])[] = [];
      for (let y = 0; y < height; y += 1) {
        const row = cacheLayer.rows[y] ?? "";
        const parsedRow = parsed.rows[y] ?? "";
        for (let x = 0; x < width; x += 1) {
          const actual = parsedRow.charAt(x);
          const expected = row.charAt(x);
          cellsCompared += 1;
          if (actual === expected) {
            cellsMatched += 1;
          } else {
            bad += 1;
            if (examples.length < 3) examples.push([x, y, actual, expected]);
          }
        }
      }
      if (bad > 0) {
        mismatches.push({
          mapId,
          mapName,
          layer: cacheLayer.name,
          reason: `数据 ${parsed.width}x${parsed.height}，缓存 ${cacheWidth}x${cacheHeight}`,
          cells: bad,
          examples,
        });
      }
    }
  }
  return {
    mapsCompared,
    missingMaps,
    layersCompared,
    cellsCompared,
    cellsMatched,
    mismatches,
  };
}

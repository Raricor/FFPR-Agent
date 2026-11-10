/**
 * Where a stage is, and whether a move leaves for another region (task 97, 11-10). The game
 * data names each map's area and area type; the atlas only knows what walking saw. This module
 * combines both and treats a missing type as a guess from the map name, so the auto trigger
 * still works before the knowledge export exists.
 *
 * "Another region's dungeon" is inference, not a rule the game states: the current map is a
 * town or the world map, the destination is not a town, and the two areas differ.
 */

import type { Atlas } from "../atlas.ts";
import type { Knowledge, MapKnowledge } from "../knowledge/index.ts";
import { findMap, mapName } from "../skills/travel.ts";
import { isRecord, text } from "../values.ts";
import type { StageTarget } from "./types.ts";

const TOWN_NAME = /(?:镇|村|町|の町|の村)$/u;
const TOWN_TYPE = /town|village|city|町|村|镇|城下町/iu;
const WORLD_NAME = /ワールドマップ|世界地図|世界地图|world\s*map/iu;
const WORLD_TYPE = /world|overworld|field|worldmap/iu;

/** One map's place, from the knowledge export when it has the map and the atlas otherwise. */
export interface MapPlace {
  readonly mapId: number;
  readonly name: string;
  readonly areaId: number | null;
  readonly areaName: string;
  readonly areaType: string | null;
  readonly town: boolean;
  readonly world: boolean;
}

function areaOf(mapName: string): string {
  return mapName.trim().split(/\s+/u)[0] ?? "";
}

function knowledgeMap(knowledge: Knowledge | null, mapId: number): MapKnowledge | undefined {
  if (knowledge === null) return undefined;
  return knowledge.maps.find((row) => row.id === mapId);
}

function atlasName(atlas: Atlas, mapId: number): string {
  const entry = atlas.maps.get(String(mapId));
  return isRecord(entry) ? (text(entry.name) ?? "") : "";
}

/** The map's display name: the knowledge export first, then the atlas. */
export function placeName(knowledge: Knowledge | null, atlas: Atlas, mapId: number): string {
  const row = knowledgeMap(knowledge, mapId);
  return row?.name?.trim() || atlasName(atlas, mapId) || mapName(atlas, mapId) || `地图 ${mapId}`;
}

/** The map's place, with town/world guessed from the name when the type is missing. */
export function mapPlace(knowledge: Knowledge | null, atlas: Atlas, mapId: number): MapPlace {
  const row = knowledgeMap(knowledge, mapId);
  const name = placeName(knowledge, atlas, mapId);
  const areaName = row?.areaName?.trim() || areaOf(name);
  const areaType = row?.areaType?.trim() || null;
  const town = TOWN_TYPE.test(areaType ?? "") || TOWN_NAME.test(name) || TOWN_NAME.test(areaName);
  const world =
    WORLD_TYPE.test(areaType ?? "") || WORLD_NAME.test(name) || WORLD_NAME.test(areaName);
  return {
    mapId,
    name,
    areaId: row?.areaId ?? null,
    areaName,
    areaType,
    town,
    world,
  };
}

/** Same region: the exported area id wins; names are the fallback. */
export function sameRegion(left: MapPlace, right: MapPlace): boolean {
  if (left.mapId === right.mapId) return true;
  if (left.areaId !== null && right.areaId !== null) return left.areaId === right.areaId;
  if (left.areaName === "" || right.areaName === "") return false;
  return left.areaName === right.areaName;
}

/** The auto trigger's inference: from a town/world map to a non-town map in another region. */
export function isOtherRegionDungeon(current: MapPlace, destination: MapPlace): boolean {
  if (!(current.town || current.world)) return false;
  if (destination.town) return false;
  if (destination.mapId === current.mapId) return false;
  return !sameRegion(current, destination);
}

/** The stage target for a map id. */
export function targetForMap(
  knowledge: Knowledge | null,
  atlas: Atlas,
  mapId: number,
  label?: string,
): StageTarget {
  const place = mapPlace(knowledge, atlas, mapId);
  return {
    mapId,
    areaName: place.areaName === "" ? null : place.areaName,
    label: label?.trim() || place.name,
  };
}

function nameMatches(candidate: string | null | undefined, wanted: string): boolean {
  const name = candidate?.trim() ?? "";
  if (name === "") return false;
  const left = name.toLowerCase();
  const right = wanted.toLowerCase();
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * Resolve `plan_stage`'s `to`: a map id, a map name the atlas knows, or an area name from the
 * guide/knowledge. An area name without a single map keeps `mapId` null; the fact sheet can
 * still answer by area.
 */
export function resolveStageTarget(
  input: unknown,
  atlas: Atlas,
  knowledge: Knowledge | null,
): StageTarget {
  if (typeof input === "number" && Number.isFinite(input)) {
    return targetForMap(knowledge, atlas, Math.trunc(input));
  }
  const raw = text(input)?.trim() ?? "";
  if (raw === "") throw new Error("plan_stage 的 to 是空的：要写地图号、地图名或攻略里的区域名");
  if (/^[[(]?\s*-?\d+\s*[,，]\s*-?\d+\s*[\])]?$/u.test(raw)) {
    throw new Error("plan_stage 的 to 要写目的地（地图号、地图名或区域名），不能是当前地图的坐标");
  }
  if (/^\s*(?:地图\s*)?\d+\s*:/u.test(raw)) {
    throw new Error("plan_stage 的 to 要写目的地地图，不能写「地图号:x,y」");
  }
  const found = findMap(atlas, raw);
  if (found.ok) return targetForMap(knowledge, atlas, found.mapId);

  const rows = knowledge?.maps ?? [];
  const exact = rows.find((row) => nameMatches(row.name, raw) || nameMatches(row.areaName, raw));
  if (exact !== undefined && exact.id !== null) {
    return targetForMap(knowledge, atlas, exact.id, exact.name ?? raw);
  }
  const area = rows.find((row) => nameMatches(row.areaName, raw));
  if (area !== undefined && area.id !== null) {
    return targetForMap(knowledge, atlas, area.id, area.name ?? raw);
  }
  return { mapId: null, areaName: raw, label: raw };
}

/** Same destination for "an unfinished plan for this destination already exists". */
export function sameStageTarget(left: StageTarget, right: StageTarget): boolean {
  if (left.mapId !== null && right.mapId !== null) return left.mapId === right.mapId;
  if (left.areaName !== null && right.areaName !== null) {
    return left.areaName.toLowerCase() === right.areaName.toLowerCase();
  }
  return left.label.toLowerCase() === right.label.toLowerCase();
}

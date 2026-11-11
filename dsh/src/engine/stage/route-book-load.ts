/**
 * Load the route book at runtime (task 117, 11-11). The offline script `scripts/routebook.mts`
 * builds the whole walkthrough for review; this module does the same read with the live data of
 * the running save (bestiary, blue magic, jobs, opened chests) and picks the section the party
 * is in. The guide, knowledge and atlas are still the same inputs.
 *
 * The result is cached by Game; this module itself is pure apart from reading the guide cache,
 * the activity log and the learned-coordinate file.
 */

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Atlas } from "../atlas.ts";
import {
  areaKeys,
  normalizeName,
  type Knowledge,
  type MapKnowledge,
  type TrilingualNames,
} from "../knowledge/index.ts";
import type { Cell } from "../nav.ts";
import { DEPS } from "../paths.ts";
import { describeError, isMissingFile } from "../errors.ts";
import { isRecord, list, num, records, text } from "../values.ts";
import { parseWalkthrough } from "./guide-steps.ts";
import { bookSectionDigest } from "./book-version.ts";
import type { GuideSection } from "./guide-types.ts";
import {
  buildRouteBookAsync,
  openedChest,
  type RouteBook,
  type RouteBookFiles,
  type RouteBookSave,
  type RouteChest,
  type RouteNpc,
  type RouteSection,
  type RouteStation,
  type RouteStoryEvent,
} from "./route-book.ts";

/** One cell the model actually acted on, learned at a handoff station. */
export interface LearnedPoint {
  /** The guide section title + station index + map, task 117's key. */
  readonly section: string;
  readonly station: number;
  readonly mapId: number;
  readonly cell: Cell;
  readonly at: string;
}

interface LearnedFile {
  readonly game: string;
  readonly points: readonly LearnedPoint[];
}

export interface RouteBookRuntime {
  readonly book: RouteBook;
  readonly sectionIndex: number;
  readonly section: RouteSection;
  /** Task 131: save-independent digest of the section the plan is built from. */
  readonly digest: string;
}

export interface RouteBookLoadOptions {
  readonly game: string;
  readonly knowledge: Knowledge;
  readonly atlas: Atlas;
  readonly visitOrder: readonly string[];
  readonly save: RouteBookSave;
  /** Tests and previews can inject parsed sections instead of the guide cache. */
  readonly sections?: readonly GuideSection[];
  readonly guideFile?: string;
  readonly fromSection?: string;
  readonly toSection?: string;
  readonly learned?: readonly LearnedPoint[];
  /** Game-file maps directory; null disables event/NPC alignment, undefined uses the knowledge. */
  readonly filesDir?: string | null;
  /** The current map, or null when it cannot be read. */
  readonly mapId: number | null;
  /** The section a running plan belongs to; preferred when the map is the world map. */
  readonly preferredSection?: string;
  /** A plan's target map, when it is not the current map (plan_stage before departure). */
  readonly preferredMapId?: number | null;
  /** The section in the progress file, and whether it already finished. */
  readonly previous?: { readonly title: string; readonly finished: boolean } | null;
  /** Task 124: build this many sections from the current one (Config, default 4). */
  readonly aheadSections?: number;
  /** Task 124: stop building after this long and keep the finished sections (Config). */
  readonly timeBudgetMs?: number;
  /** Task 124: one activity-log line when the time budget stopped the build. */
  readonly onWarning?: (message: string) => void;
}

export interface GuideFile {
  readonly walkthrough: unknown;
}

/** Read `.deps/knowledge/<game>/guide.json`; a missing file means no route book. */
export async function readGuideSections(
  game: string,
  file?: string,
  signal?: AbortSignal,
): Promise<GuideSection[] | null> {
  const path = file ?? join(DEPS, "knowledge", game, "guide.json");
  let body: string;
  try {
    body = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return null;
    signal?.throwIfAborted();
    throw new Error(`读不了攻略 ${path}:${describeError(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`读不懂攻略 ${path}:${describeError(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`攻略 ${path} 不是 JSON 对象`);
  return parseWalkthrough(parsed.walkthrough);
}

/**
 * Task 122: read the extracted maps' events and NPCs. They are already in
 * `.deps/knowledge/<game>/files/maps/<id>.json`; a missing directory means the game files are
 * not available and every story station stays a handoff.
 */
export async function readRouteBookFiles(
  game: string,
  filesDir?: string | null,
  signal?: AbortSignal,
): Promise<RouteBookFiles | null> {
  if (filesDir === null) return null;
  const mapsDir = join(filesDir ?? join(DEPS, "knowledge", game, "files"), "maps");
  let names: string[];
  try {
    names = await readdir(mapsDir);
  } catch (error) {
    if (isMissingFile(error)) return null;
    signal?.throwIfAborted();
    throw new Error(`读不了游戏文件地图目录 ${mapsDir}:${describeError(error)}`, { cause: error });
  }
  names = names
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => {
      const a = Number(left.slice(0, -".json".length));
      const b = Number(right.slice(0, -".json".length));
      return Number.isFinite(a) && Number.isFinite(b) ? a - b : left.localeCompare(right);
    });
  const events: RouteStoryEvent[] = [];
  const npcs: RouteNpc[] = [];
  const titles = new Map<number, TrilingualNames>();
  for (const name of names) {
    const path = join(mapsDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`读不懂游戏文件地图 ${path}:${describeError(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) continue;
    const mapId = num(parsed.id);
    if (mapId === undefined || mapId <= 0) continue;
    events.push(...eventsOf(Math.trunc(mapId), parsed.events));
    npcs.push(...npcsOf(Math.trunc(mapId), parsed.npcs));
    const title = mapTitleOf(parsed.title);
    if (title !== null) titles.set(Math.trunc(mapId), title);
  }
  if (events.length === 0 && npcs.length === 0 && titles.size === 0) return null;
  return { events, npcs, ...(titles.size === 0 ? {} : { titles }) };
}

function mapTitleOf(value: unknown): TrilingualNames | null {
  if (!isRecord(value)) return null;
  const ja = text(value.ja);
  const en = text(value.en);
  const zhc = text(value.zhc);
  if (ja === undefined && en === undefined && zhc === undefined) return null;
  return {
    ja: ja ?? null,
    en: en ?? null,
    zhc: zhc ?? null,
  };
}

function eventCell(value: unknown): Cell | null {
  const pair = list(value);
  const x = num(pair[0]);
  const y = num(pair[1]);
  return x === undefined || y === undefined ? null : [Math.trunc(x), Math.trunc(y)];
}

function eventRect(
  value: unknown,
): { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | null {
  if (!isRecord(value)) return null;
  const x1 = num(value.x1);
  const y1 = num(value.y1);
  const x2 = num(value.x2);
  const y2 = num(value.y2);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
  return {
    x1: Math.trunc(x1),
    y1: Math.trunc(y1),
    x2: Math.trunc(x2),
    y2: Math.trunc(y2),
  };
}

function eventsOf(mapId: number, value: unknown): RouteStoryEvent[] {
  return records(value).flatMap((raw) => {
    const name = text(raw.name);
    if (name === undefined || name === "") return [];
    const cell = eventCell(raw.cell);
    const rect = eventRect(raw.rect);
    if (cell === null && rect === null) return [];
    const scriptId = num(raw.scriptId);
    return [
      {
        mapId,
        file: text(raw.file) ?? "",
        name,
        cell,
        rect,
        scriptId: scriptId === undefined ? null : Math.trunc(scriptId),
      },
    ];
  });
}

function npcNames(
  value: unknown,
): { readonly ja?: string; readonly en?: string; readonly zhc?: string } | null {
  if (!isRecord(value)) return null;
  const ja = text(value.ja);
  const en = text(value.en);
  const zhc = text(value.zhc);
  if (ja === undefined && en === undefined && zhc === undefined) return null;
  return {
    ...(ja === undefined ? {} : { ja }),
    ...(en === undefined ? {} : { en }),
    ...(zhc === undefined ? {} : { zhc }),
  };
}

function npcsOf(mapId: number, value: unknown): RouteNpc[] {
  return records(value).flatMap((raw) => {
    const name = text(raw.name);
    const cell = eventCell(raw.cell);
    if (name === undefined || name === "" || cell === null) return [];
    const names = npcNames(raw.names);
    return [{ mapId, name, cell, ...(names === null ? {} : { names }) }];
  });
}

/** Previous saves' first-arrival order, read from the same activity log the script uses. */
export async function readVisitOrder(
  game: string,
  file?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const path = file ?? join(DEPS, "ds", `activity-${game}.jsonl`);
  try {
    await access(path);
  } catch {
    return [];
  }
  const body = await readFile(path, { encoding: "utf8", signal });
  const order: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.kind !== "event" || typeof parsed.text !== "string") {
      continue;
    }
    const match = /^地点 首次到达「(.+)」$/u.exec(parsed.text.trim());
    if (match?.[1] !== undefined) order.push(match[1]);
  }
  return order;
}

function learnedPointOf(value: unknown): LearnedPoint | null {
  if (!isRecord(value)) return null;
  const section = text(value.section);
  const station = num(value.station);
  const mapId = num(value.mapId);
  const cell = Array.isArray(value.cell) ? value.cell : [];
  const x = num(cell[0]);
  const y = num(cell[1]);
  if (
    section === undefined ||
    station === undefined ||
    mapId === undefined ||
    x === undefined ||
    y === undefined
  ) {
    return null;
  }
  return {
    section,
    station: Math.trunc(station),
    mapId: Math.trunc(mapId),
    cell: [Math.trunc(x), Math.trunc(y)],
    at: text(value.at) ?? new Date(0).toISOString(),
  };
}

/** Read the learned-coordinate file; a missing or malformed entry only loses that cell. */
export async function readLearnedPoints(
  game: string,
  file?: string,
  signal?: AbortSignal,
): Promise<LearnedPoint[]> {
  const path = file ?? join(DEPS, "ds", `routebook-learned-${game}.json`);
  let body: string;
  try {
    body = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return [];
    signal?.throwIfAborted();
    throw new Error(`读不了路线书学会坐标 ${path}:${describeError(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  return list(parsed.points).flatMap((point) => {
    const learned = learnedPointOf(point);
    return learned === null ? [] : [learned];
  });
}

/** Remember one acted cell; the next book build fills the station's cell from this. */
export async function writeLearnedPoint(
  game: string,
  point: LearnedPoint,
  file?: string,
): Promise<void> {
  const path = file ?? join(DEPS, "ds", `routebook-learned-${game}.json`);
  const points = await readLearnedPoints(game, path);
  const kept = points.filter(
    (existing) =>
      !(
        existing.section === point.section &&
        existing.station === point.station &&
        existing.mapId === point.mapId
      ),
  );
  const body: LearnedFile = { game, points: [...kept, point] };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * Fill stations the model already handled with the cell it acted on. The key is the guide
 * section + station index + map, so two sections naming the same cell stay separate.
 */
export function applyLearnedPoints(book: RouteBook, points: readonly LearnedPoint[]): RouteBook {
  if (points.length === 0) return book;
  const byKey = new Map<string, LearnedPoint>();
  for (const point of points) {
    byKey.set(`${point.section}|${point.station}|${point.mapId}`, point);
  }
  const find = (
    section: string,
    station: number,
    mapId: number | null,
  ): LearnedPoint | undefined =>
    mapId === null
      ? [...byKey.values()].find((point) => point.section === section && point.station === station)
      : byKey.get(`${section}|${station}|${mapId}`);
  const sections = book.sections.map((section) => {
    const stations = section.stations.map((station) => {
      if (station.cell !== null) return station;
      const point = find(section.title, station.index, station.mapId);
      if (point === undefined) return station;
      return {
        ...station,
        mapId: point.mapId,
        cell: point.cell,
        basis: `${station.basis};学会坐标`,
      } satisfies RouteStation;
    });
    const chests = section.chests.map((chest) => {
      const station = stations.find((candidate) => candidate.index === chest.stepIndex);
      if (station === undefined || station.cell === null || chest.cell !== null) return chest;
      return {
        ...chest,
        mapId: station.mapId,
        mapName:
          station.mapId === null
            ? chest.mapName
            : (mapNameOf(section, station.mapId) ?? chest.mapName),
        cell: station.cell,
        match: chest.match === "none" ? "order" : chest.match,
        note: `${chest.note};学会坐标`,
      } satisfies RouteChest;
    });
    return { ...section, stations, chests };
  });
  return { ...book, sections };
}

function mapNameOf(section: RouteSection, mapId: number): string | null {
  return section.maps.find((map) => map.mapId === mapId)?.name ?? null;
}

export interface RouteStartOptions {
  /** Where the party is now; wins when the section contains it. */
  readonly currentMapId: number | null;
  /** The running plan's target map (plan_stage before departure). */
  readonly targetMapId: number | null;
}

/**
 * Task 126, 11-11: start the runtime route at "now", not at the section's first line. The
 * walkthrough chapter still contains the meteorite and the whole cave, but a plan made at the
 * world map for the cave must not send the party back to 189. The target's area decides which
 * maps count; the current map, when it is in this section, is even more precise. Stations
 * before that point stay out by default. A chest/hidden item this save explicitly has not
 * opened is kept when its map is still on this route (with the reason in its basis), because
 * turning back for it is still useful; an unknown opened flag skips it. Grind stops before the
 * start follow the same map rule; a return trip belongs in the book's "回头学" block.
 */
export function trimSectionStart(section: RouteSection, options: RouteStartOptions): RouteSection {
  const maps = new Map(section.maps.map((map) => [map.mapId, map]));
  const current =
    options.currentMapId !== null && maps.has(options.currentMapId) ? options.currentMapId : null;
  const target =
    options.targetMapId !== null && maps.has(options.targetMapId) ? options.targetMapId : null;
  const anchor = current ?? target;
  if (anchor === null) return section;
  let startMaps: Set<number>;
  if (current !== null) {
    startMaps = new Set([current]);
  } else {
    const anchorMap = maps.get(anchor);
    const area = normalizeName(anchorMap?.areaName ?? anchorMap?.name ?? "");
    startMaps = new Set(
      section.maps
        .filter((map) => area !== "" && normalizeName(map.areaName ?? map.name) === area)
        .map((map) => map.mapId),
    );
    if (startMaps.size === 0) startMaps.add(anchor);
  }
  const firstIndex = section.stations.findIndex(
    (station) => station.mapId !== null && startMaps.has(station.mapId),
  );
  if (firstIndex <= 0) return section;
  const pathMaps = new Set(startMaps);
  for (const station of section.stations.slice(firstIndex)) {
    if (station.mapId !== null) pathMaps.add(station.mapId);
  }
  const prefix = section.stations.slice(0, firstIndex);
  const kept = prefix
    .filter(
      (station) =>
        (station.kind === "chest" || station.kind === "hidden") &&
        station.chest?.opened === false &&
        station.mapId !== null &&
        pathMaps.has(station.mapId),
    )
    .map((station) => ({
      ...station,
      basis: `${station.basis};计划从 ${anchor} 出发,这一站在之前但本档没开,保留`,
    }));
  const stations = [...kept, ...section.stations.slice(firstIndex)];
  const grind = section.grind.filter((row) => pathMaps.has(row.mapId));
  const mismatches = [...section.mismatches];
  for (const row of section.grind) {
    if (pathMaps.has(row.mapId)) continue;
    mismatches.push(`刷怪站 ${row.mapId} ${row.what}:在计划起点之前,本次不刷`);
  }
  return { ...section, stations, grind, mismatches };
}

function recountBook(book: RouteBook, sections: readonly RouteSection[]): RouteBook {
  return {
    ...book,
    sections,
    totals: {
      ...book.totals,
      sections: sections.length,
      stations: sections.reduce((sum, section) => sum + section.stations.length, 0),
      mismatches: sections.reduce((sum, section) => sum + section.mismatches.length, 0),
    },
  };
}

/**
 * The section covering `mapId`; on the world map (or a map the book cannot name) the current
 * progress section, or the next one, is used. `preferred` wins when it exists because a running
 * plan may have started in a town before its dungeon.
 */
export function sectionFinished(section: RouteSection, save: RouteBookSave): boolean {
  // A section with neither collection nor a boss has no readable completion signal; never skip
  // it just because there is nothing to check.
  if (section.chests.length === 0 && section.bosses.length === 0) return false;
  // Task 135: the chest's game-file flag decides; the old cell set is only the fallback.
  const chestsDone = section.chests.every(
    (chest) =>
      chest.opened === true || openedChest(save, chest.mapId, chest.cell, chest.flag) === true,
  );
  if (!chestsDone) return false;
  return section.bosses.every((boss) => boss.registered === true);
}

export function selectSectionIndex(
  book: RouteBook,
  mapId: number | null,
  options: {
    readonly preferredSection?: string;
    readonly preferredMapId?: number | null;
    readonly previous?: { readonly title: string; readonly finished: boolean } | null;
    /** Task 133: sections this save has already completed, by title. */
    readonly finished?: (section: RouteSection) => boolean;
  } = {},
): number | null {
  const sections = book.sections;
  if (sections.length === 0) return null;
  const indexOf = (title: string | undefined): number =>
    title === undefined ? -1 : sections.findIndex((section) => section.title === title);
  const preferred = indexOf(options.preferredSection);
  if (preferred >= 0) return preferred;
  if (options.preferredMapId !== undefined && options.preferredMapId !== null) {
    const target = sections.findIndex((section) =>
      section.maps.some((map) => map.mapId === options.preferredMapId),
    );
    if (target >= 0) return target;
  }
  if (mapId !== null) {
    const containing = sections.flatMap((section, index) =>
      section.maps.some((map) => map.mapId === mapId) ? [index] : [],
    );
    if (containing.length > 0) {
      // Task 133: overlapping maps (Tule belongs to the town and the canal section) must not
      // flip the plan back and forth. Take the earliest section still unfinished; a section
      // whose chests are all open and whose bosses are registered never starts again.
      if (options.finished === undefined) {
        const exact = containing[0];
        const previous = indexOf(options.previous?.title);
        // A finished section moves on even when the party is still on one of its maps.
        if (
          exact !== undefined &&
          options.previous?.finished === true &&
          previous >= 0 &&
          exact <= previous
        ) {
          return Math.min(previous + 1, sections.length - 1);
        }
        if (exact !== undefined) return exact;
      } else {
        const unfinished = containing.find((index) => {
          const section = sections[index];
          return section !== undefined && !options.finished?.(section);
        });
        if (unfinished !== undefined) return unfinished;
        return null;
      }
    }
  }
  const previous = indexOf(options.previous?.title);
  if (previous >= 0) {
    if (options.previous?.finished === true) {
      return Math.min(previous + 1, sections.length - 1);
    }
    return previous;
  }
  return 0;
}

function candidateMatches(candidate: string, key: string): boolean {
  if (candidate === key) return true;
  const candidateLength = Array.from(candidate).length;
  const keyLength = Array.from(key).length;
  if (candidateLength < 2 || keyLength < 2) return false;
  return candidate.includes(key) || key.includes(candidate);
}

function sectionNamesMap(section: GuideSection, map: MapKnowledge, knowledge: Knowledge): boolean {
  const keys = new Set([
    ...areaKeys(knowledge.guide, map.areaName ?? ""),
    ...areaKeys(knowledge.guide, map.name ?? ""),
  ]);
  if (keys.size === 0) return false;
  const values = [
    section.title,
    ...section.places,
    ...section.steps.flatMap((step) => (step.where === null ? [] : [step.where])),
    ...section.monsters.flatMap((monster) => (monster.where === null ? [] : [monster.where])),
  ];
  return values.some((value) => {
    const candidates = [normalizeName(value), ...areaKeys(knowledge.guide, value)];
    return candidates.some((candidate) =>
      [...keys].some((key) => candidateMatches(candidate, key)),
    );
  });
}

/**
 * The section to start the window at. The old loader built the whole book and then asked
 * `selectSectionIndex`; task 124 cannot afford that alignment, so the same precedence is
 * applied to the guide's own names first (plan section, target map, current map, progress).
 */
function startingSectionIndex(
  sections: readonly GuideSection[],
  options: RouteBookLoadOptions,
): number {
  const indexOf = (title: string | undefined): number =>
    title === undefined ? -1 : sections.findIndex((section) => section.title === title);
  const preferred = indexOf(options.preferredSection);
  if (preferred >= 0) return preferred;
  const previous = indexOf(options.previous?.title);
  const mapId = options.preferredMapId ?? options.mapId;
  if (mapId !== null) {
    const map = options.knowledge.maps.find((item) => item.id === mapId);
    if (map !== undefined) {
      const found = sections.findIndex((section) =>
        sectionNamesMap(section, map, options.knowledge),
      );
      if (found >= 0) {
        // A finished section moves on even when the party is still on one of its maps.
        if (options.previous?.finished === true && previous >= 0 && found <= previous) {
          return Math.min(previous + 1, sections.length - 1);
        }
        return found;
      }
    }
  }
  if (previous >= 0) {
    if (options.previous?.finished === true) {
      return Math.min(previous + 1, sections.length - 1);
    }
    return previous;
  }
  return 0;
}

/** Build the book and select the section; null when the guide cache is absent or empty. */
export async function loadRouteBook(
  options: RouteBookLoadOptions,
  signal?: AbortSignal,
): Promise<RouteBookRuntime | null> {
  signal?.throwIfAborted();
  const sections =
    options.sections ??
    (await readGuideSections(options.game, options.guideFile, signal)) ??
    undefined;
  if (sections === undefined || sections.length === 0) return null;
  const filesDir =
    options.filesDir === undefined ? (options.knowledge.filesDir ?? null) : options.filesDir;
  const files = await readRouteBookFiles(options.game, filesDir, signal);
  const fromSection =
    options.fromSection ??
    (options.toSection === undefined
      ? sections[startingSectionIndex(sections, options)]?.title
      : sections[0]?.title);
  const fromIndex = sections.findIndex((section) => section.title === fromSection);
  const ahead = Math.max(1, Math.floor(options.aheadSections ?? 4));
  const toSection =
    options.toSection ??
    (fromIndex < 0
      ? sections[sections.length - 1]?.title
      : sections[fromIndex + ahead - 1]?.title) ??
    sections[sections.length - 1]?.title;
  if (fromSection === undefined || toSection === undefined) return null;
  let book: RouteBook;
  try {
    const budget = Math.max(0, options.timeBudgetMs ?? 5_000);
    const outcome = await buildRouteBookAsync(
      {
        sections,
        fromSection,
        toSection,
        knowledge: options.knowledge,
        atlas: options.atlas,
        visitOrder: options.visitOrder,
        save: options.save,
        ...(files === null ? {} : { files }),
      },
      budget,
      signal,
    );
    book = outcome.book;
    if (outcome.timedOut) {
      options.onWarning?.(`路线书构建超过 ${budget}ms,只用已经建好的 ${book.sections.length} 节`);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`路线书没有生成:${describeError(error)}`, { cause: error });
  }
  // Task 131: digest before learned points and the position trim change the station list, so a
  // running plan is not made stale by walking or by learning a handoff cell.
  const digests = new Map(book.sections.map((item) => [item.title, bookSectionDigest(item)]));
  book = applyLearnedPoints(book, options.learned ?? []);
  book = recountBook(
    book,
    book.sections.map((section) =>
      trimSectionStart(section, {
        currentMapId: options.mapId,
        targetMapId: options.preferredMapId ?? null,
      }),
    ),
  );
  const sectionIndex = selectSectionIndex(book, options.mapId, {
    ...(options.preferredSection === undefined
      ? {}
      : { preferredSection: options.preferredSection }),
    ...(options.preferredMapId === undefined ? {} : { preferredMapId: options.preferredMapId }),
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    finished: (section) => sectionFinished(section, options.save),
  });
  if (sectionIndex === null) return null;
  const section = book.sections[sectionIndex];
  if (section === undefined) return null;
  return {
    book,
    sectionIndex,
    section,
    digest: digests.get(section.title) ?? bookSectionDigest(section),
  };
}

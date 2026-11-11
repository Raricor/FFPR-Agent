/**
 * The chapter route view (task 157): which chest comes in which order, how the party walks
 * between two stations, and the route drawn on each map. It reads the accepted chapter plan,
 * its live progress, the atlas, the collision cache and the knowledge export — the same
 * sources the chapter dry run and executor use — and never talks to the bridge.
 *
 * The estimates come from `plan/dry-run.ts`'s rules: `route/distance.ts`'s `estimatePair`, the
 * same "stop beside the target" neighbour choice, and `mapPath` for cross-map legs. The map
 * view only adds the actual BFS polylines (`nav.ts`'s layered search) so the page can draw
 * them; it does not estimate distance a second way.
 *
 * Everything the browser shows is text computed here, in Chinese. Missing or damaged files
 * become view text, never an exception, so the chapter panel keeps working.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { Atlas } from "../engine/atlas.ts";
import { describeError, isMissingFile } from "../engine/errors.ts";
import { byKey, type Game } from "../engine/games.ts";
import { jumpMoves } from "../engine/knowledge/jumps.ts";
import {
  defaultFiles,
  loadKnowledge,
  type ChestKnowledge,
  type Knowledge,
} from "../engine/knowledge/index.ts";
import {
  LAYER_Z,
  OPEN,
  STAIRS,
  layeredGrid,
  layeredRouteAvoiding,
  type Cell,
  type LayeredGrid,
} from "../engine/nav.ts";
import { ChapterPlanStore } from "../engine/plan/chapter-store.ts";
import type { ChapterPlan, ChapterProgress } from "../engine/plan/chapter-types.ts";
import type { PlanStation, PlanStationAction } from "../engine/plan/types.ts";
import { parseTarget } from "../engine/plan/validate.ts";
import { CollisionStore, RegionIndex, type CollisionSnapshot } from "../engine/regions.ts";
import {
  estimatePair,
  ROUTE_SECONDS_PER_CELL,
  ROUTE_SECONDS_PER_MAP_CHANGE,
  type PairResult,
} from "../engine/route/distance.ts";
import type { RoutePoint, RouteWorld } from "../engine/route/types.ts";
import { mapExits, mapName, mapPath } from "../engine/skills/travel.ts";
import { isRecord, num, text } from "../engine/values.ts";
import { readCurrent, type CurrentSource } from "./current.ts";
import { defaultChapterFiles, type ChapterFiles } from "./chapter-panel.ts";

export const CHAPTER_ROUTE_DATA = "/api/ffpr/chapter/route";
export const CHAPTER_ROUTE_MAP = "/api/ffpr/chapter/route/map";

/** The executor's rule: open/talk/switch/boss stop beside a target that cannot be stood on. */
const BESIDE_ACTIONS: ReadonlySet<PlanStationAction> = new Set(["open", "talk", "switch", "boss"]);

/** Below, above, right, left: the boss-side order from `plan/execute.ts`. */
const BESIDE_SIDES: readonly { readonly dx: number; readonly dy: number }[] = [
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
];

const ACTION_LABELS: Readonly<Record<PlanStationAction, string>> = {
  move: "移动",
  open: "开宝箱",
  save: "存档",
  heal: "回复",
  talk: "对话",
  switch: "机关",
  story: "剧情",
  choose: "选项",
  grind: "刷怪",
  boss: "首领",
  buy: "买东西",
};

const STATUS_LABELS: Readonly<Record<RouteStationStatus, string>> = {
  pending: "待做",
  current: "正在做",
  done: "做完",
  failed: "失败",
  skipped: "跳过",
};

export type RouteStationStatus = "pending" | "current" | "done" | "failed" | "skipped";
export type RouteStationKind =
  "chest" | "hidden" | "boss" | "story" | "heal" | "save" | "shop" | "grind" | "move";

/** One circle number; past 20 the plain number stays readable in the narrow sidebar. */
export function circledNumber(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value);
  if (value <= 20) return String.fromCodePoint(0x2460 + value - 1);
  return String(value);
}

function cellText(cell: Cell | null): string {
  return cell === null ? "—" : `(${cell[0]},${cell[1]})`;
}

function secondsText(seconds: number): string {
  const rounded = Math.max(0, Math.ceil(seconds));
  if (rounded < 60) return `约 ${rounded} 秒`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `约 ${minutes} 分` : `约 ${minutes} 分 ${rest} 秒`;
}

const RESOURCE_MAP_NAME = /^Map_?\d+(?:_\d+)?$/iu;

/** Atlas names are the live Chinese ones; the static export may still hold a resource name. */
function isResourceMapName(name: string): boolean {
  return RESOURCE_MAP_NAME.test(name.trim());
}

function pointText(knowledge: RouteKnowledge | null, atlas: Atlas, point: RoutePoint): string {
  return `地图 ${point.map}「${mapNameOf(knowledge, atlas, point.map)}」${cellText(point.cell)}`;
}

/** One story/event/NPC cell from a map export, used when a station names only its map. */
export interface RouteEventCandidate {
  readonly cell: Cell;
  readonly name: string;
}

/** The three-language item names from `files/items.json`. */
export interface RouteItemNames {
  readonly ja: string | null;
  readonly en: string | null;
  readonly zhc: string | null;
}

export interface RouteCandidateView {
  readonly cell: Cell;
  readonly cellText: string;
  readonly name: string;
  readonly text: string;
}

/** The knowledge fields the route view reads; production passes the whole `Knowledge`. */
export interface RouteKnowledge {
  readonly chests: readonly Pick<
    ChestKnowledge,
    "mapId" | "cell" | "hidden" | "contentId" | "contentName" | "contentNames" | "opened"
  >[];
  readonly maps: readonly {
    readonly id: number | null;
    readonly name: string | null;
    readonly areaName?: string | null;
  }[];
}

export interface ChapterRouteOptions {
  /** A fresh position from the browser; undefined means "use the progress file". */
  readonly start?: RoutePoint | null;
  readonly atlas?: Atlas;
  readonly collisions?: CollisionStore;
  readonly knowledge?: RouteKnowledge | null;
  /** Tests inject story/NPC candidates; production reads the map exports. */
  readonly events?: ReadonlyMap<number, readonly RouteEventCandidate[]>;
  /** Tests inject item names; production reads `files/items.json`. */
  readonly items?: ReadonlyMap<number, RouteItemNames>;
}

export interface RouteMapRefView {
  readonly id: number;
  readonly name: string;
  readonly text: string;
  readonly stationCount: number;
  readonly current: boolean;
}

export interface ChapterRouteStationView {
  readonly number: number;
  readonly segmentNumber: number;
  readonly label: string;
  readonly mapId: number | null;
  readonly mapText: string;
  readonly cell: Cell | null;
  readonly cellText: string;
  readonly unknownCell: boolean;
  readonly candidates: readonly RouteCandidateView[];
  readonly candidateText: string;
  readonly action: string;
  readonly why: string;
  readonly kind: RouteStationKind;
  readonly itemName: string | null;
  readonly itemText: string;
  readonly status: RouteStationStatus;
  readonly statusText: string;
  readonly note: string;
  readonly current: boolean;
}

export interface ChapterRouteLegView {
  readonly number: number;
  readonly fromNumber: number | null;
  readonly fromLabel: string;
  readonly toNumber: number;
  readonly toLabel: string;
  readonly text: string;
  readonly mapsText: string;
  readonly mapIds: readonly number[];
  readonly hops: number;
  readonly cells: number;
  readonly seconds: number;
  readonly durationText: string;
  readonly ok: boolean;
  readonly reason: string | null;
  readonly from: RoutePoint | null;
  readonly to: RoutePoint | null;
}

export interface ChapterRouteSegmentView {
  readonly number: number;
  readonly section: string;
  readonly stateText: string;
  readonly current: boolean;
  readonly stations: readonly ChapterRouteStationView[];
  readonly legs: readonly ChapterRouteLegView[];
  readonly chestsText: string;
  readonly distanceText: string;
  readonly unreachableText: string | null;
}

export interface ChapterRouteView {
  readonly title: "章路线";
  readonly status: string;
  readonly message: string | null;
  readonly chapter: number | null;
  readonly goalText: string;
  readonly startText: string;
  readonly currentMapId: number | null;
  readonly currentCell: Cell | null;
  readonly currentCellText: string;
  readonly maps: readonly RouteMapRefView[];
  readonly segments: readonly ChapterRouteSegmentView[];
  readonly totalsText: string;
  readonly emptyText: string;
  readonly warnings: readonly string[];
}

export interface RouteMapStationView {
  readonly number: number;
  readonly segmentNumber: number;
  readonly label: string;
  readonly cell: Cell;
  readonly cellText: string;
  readonly unknownCell: boolean;
  readonly candidateText: string;
  readonly action: string;
  readonly kind: RouteStationKind;
  readonly itemName: string | null;
  readonly status: RouteStationStatus;
  readonly statusText: string;
  readonly current: boolean;
}

export interface RouteMapPathView {
  readonly legNumber: number;
  readonly fromNumber: number | null;
  readonly fromLabel: string;
  readonly toNumber: number;
  readonly toLabel: string;
  readonly text: string;
  readonly points: readonly Cell[];
  readonly entryText: string;
  readonly exitText: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

export interface RouteMapExitView {
  readonly cell: Cell;
  readonly cellText: string;
  readonly to: number | null;
  readonly toName: string;
  readonly text: string;
}

export interface ChapterRouteMapView {
  readonly title: "路线地图";
  readonly status: string;
  readonly message: string | null;
  readonly mapId: number | null;
  readonly mapName: string;
  readonly width: number;
  readonly height: number;
  readonly origin: Cell;
  readonly layer: number;
  readonly rows: readonly string[];
  readonly legendText: string;
  readonly maps: readonly RouteMapRefView[];
  readonly stations: readonly RouteMapStationView[];
  readonly paths: readonly RouteMapPathView[];
  readonly exits: readonly RouteMapExitView[];
  readonly party: {
    readonly cell: Cell;
    readonly cellText: string;
    readonly text: string;
  } | null;
  readonly emptyText: string;
  readonly warnings: readonly string[];
}

interface ProgressStation {
  readonly index: number;
  readonly status: RouteStationStatus;
  readonly note: string;
  readonly to: string | null;
}

interface ProgressSegment {
  readonly section: string;
  readonly stations: ReadonlyMap<number, ProgressStation>;
}

interface RouteProgress {
  readonly chapter: number;
  readonly goal: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly status: ChapterProgress["status"];
  readonly segment: number;
  readonly segments: readonly ProgressSegment[];
  readonly position: RoutePoint | null;
}

interface ModelStop {
  readonly number: number;
  readonly segmentIndex: number;
  readonly stationIndex: number;
  readonly station: PlanStation;
  readonly target: RoutePoint | null;
  readonly status: RouteStationStatus;
  readonly note: string;
  readonly item: RouteKnowledge["chests"][number] | null;
  readonly kind: RouteStationKind;
  readonly candidates: readonly RouteEventCandidate[];
}

interface ModelLeg {
  readonly number: number;
  readonly fromStop: ModelStop | null;
  readonly toStop: ModelStop;
  readonly from: RoutePoint | null;
  readonly toPoint: RoutePoint | null;
  readonly atEntry: boolean;
  readonly pair: PairResult;
  readonly reached: RoutePoint | null;
}

interface ModelSegment {
  readonly index: number;
  readonly section: string;
  readonly stateText: string;
  readonly current: boolean;
  readonly progressSegment: ProgressSegment | undefined;
  readonly stops: readonly ModelStop[];
  readonly legs: readonly ModelLeg[];
}

interface RouteModel {
  readonly plan: ChapterPlan;
  readonly progress: RouteProgress | null;
  readonly world: RouteWorld;
  readonly atlas: Atlas;
  readonly collisions: CollisionStore | undefined;
  readonly knowledge: RouteKnowledge | null;
  readonly events: ReadonlyMap<number, readonly RouteEventCandidate[]>;
  readonly items: ReadonlyMap<number, RouteItemNames>;
  readonly start: RoutePoint | null;
  readonly segments: readonly ModelSegment[];
  readonly warnings: readonly string[];
}

interface LoadedWorld {
  readonly atlas: Atlas;
  readonly collisions: CollisionStore;
  readonly knowledge: RouteKnowledge | null;
  readonly items: ReadonlyMap<number, RouteItemNames>;
  readonly world: RouteWorld;
  readonly warnings: readonly string[];
}

const ROUTE_CACHE_LIMIT = 8;
const modelCache = new Map<string, RouteModel>();
const routeViewCache = new Map<string, ChapterRouteView>();
const mapViewCache = new Map<string, ChapterRouteMapView>();
const worldCache = new Map<string, LoadedWorld>();

/** Tests and a Config change can start from a clean cache; production never needs this. */
export function clearChapterRouteCache(): void {
  modelCache.clear();
  routeViewCache.clear();
  mapViewCache.clear();
  worldCache.clear();
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  while (map.size > ROUTE_CACHE_LIMIT) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
  return value;
}

async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

function progressStatus(value: unknown): RouteStationStatus {
  return value === "current" || value === "done" || value === "failed" || value === "skipped"
    ? value
    : "pending";
}

function positionOf(value: unknown): RoutePoint | null {
  if (!isRecord(value)) return null;
  const map = num(value.map) ?? num(value.mapId);
  if (map === undefined) return null;
  const rawCell = Array.isArray(value.cell) ? value.cell : null;
  const x = rawCell === null ? num(value.x) : num(rawCell[0]);
  const y = rawCell === null ? num(value.y) : num(rawCell[1]);
  return {
    map: Math.trunc(map),
    cell: x === undefined || y === undefined ? null : [Math.trunc(x), Math.trunc(y)],
  };
}

function pointFromTo(to: string | null): RoutePoint | null {
  if (to === null) return null;
  const parsed = parseTarget(to);
  return typeof parsed === "string" ? null : { map: parsed.mapId, cell: parsed.cell };
}

/** The progress file writes more than `ChapterProgress` (the executor adds `to`/`do`). */
function readRouteProgress(value: unknown): RouteProgress {
  if (!isRecord(value)) throw new Error("章进度不是 JSON 对象");
  const chapter = num(value.chapter);
  if (chapter === undefined || !Number.isInteger(chapter) || chapter <= 0) {
    throw new Error("章进度里没有章号");
  }
  const status = value.status;
  if (
    status !== "running" &&
    status !== "done" &&
    status !== "exception" &&
    status !== "blocked" &&
    status !== "aborted"
  ) {
    throw new Error("章进度里的状态看不懂");
  }
  if (!Array.isArray(value.segments)) throw new Error("章进度里没有段状态");
  const segments: ProgressSegment[] = [];
  for (const raw of value.segments) {
    if (!isRecord(raw)) continue;
    const section = text(raw.section)?.trim() ?? "";
    const stations = new Map<number, ProgressStation>();
    for (const entry of Array.isArray(raw.stations) ? raw.stations : []) {
      if (!isRecord(entry)) continue;
      const index = num(entry.index);
      if (index === undefined) continue;
      stations.set(Math.trunc(index), {
        index: Math.trunc(index),
        status: progressStatus(entry.status),
        note: text(entry.note) ?? "",
        to: text(entry.to) ?? null,
      });
    }
    segments.push({ section, stations });
  }
  const direct =
    positionOf(value.lastPosition) ?? positionOf(value.position) ?? positionOf(value.current);
  return {
    chapter: Math.trunc(chapter),
    goal: text(value.goal) ?? "",
    revision: Math.max(1, Math.trunc(num(value.revision) ?? 1)),
    updatedAt: text(value.updatedAt) ?? "",
    status,
    segment: Math.max(0, Math.trunc(num(value.segment) ?? 0)),
    segments,
    position: direct,
  };
}

function progressMatches(plan: ChapterPlan, progress: RouteProgress | null): boolean {
  if (progress === null) return false;
  if (progress.chapter !== plan.chapter || progress.goal !== plan.goal) return false;
  if (progress.segments.length !== plan.segments.length) return false;
  return plan.segments.every(
    (segment, index) => progress.segments[index]?.section === segment.section,
  );
}

function stationStatus(
  progress: RouteProgress | null,
  segmentIndex: number,
  stationIndex: number,
): { readonly status: RouteStationStatus; readonly note: string } {
  const station = progress?.segments[segmentIndex]?.stations.get(stationIndex);
  return { status: station?.status ?? "pending", note: station?.note ?? "" };
}

function stopKind(
  station: PlanStation,
  chest: RouteKnowledge["chests"][number] | null,
): RouteStationKind {
  switch (station.do) {
    case "open":
      return chest?.hidden === true ? "hidden" : "chest";
    case "boss":
      return "boss";
    case "save":
      return "save";
    case "heal":
      return "heal";
    case "buy":
      return "shop";
    case "grind":
      return "grind";
    case "story":
    case "talk":
    case "switch":
    case "choose":
      return "story";
    default:
      return "move";
  }
}

function isChineseName(value: string): boolean {
  return /\p{Script=Han}/u.test(value) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

/** The plan's `why` sometimes carries the Chinese item name when the export did not. */
function itemNameFromWhy(why: string): string | null {
  const quoted = /[「『]([^」』]+)[」』]/u.exec(why);
  if (quoted?.[1] !== undefined) {
    const name = quoted[1].trim();
    if (name !== "" && isChineseName(name) && !/宝箱|隐藏道具/u.test(name)) return name;
  }
  const colon = Math.max(why.lastIndexOf(":"), why.lastIndexOf("："));
  if (colon >= 0) {
    const name = why.slice(colon + 1).trim();
    if (name !== "" && name.length <= 20 && isChineseName(name) && !/[，。；]/u.test(name)) {
      return name;
    }
  }
  const taken = /(?:拿|取|获得|拾取|得到)\s*([^\s，。；、,;]+)/u.exec(why);
  if (taken?.[1] !== undefined) {
    const name = taken[1].trim();
    if (name !== "" && isChineseName(name) && !/宝箱|隐藏道具/u.test(name)) return name;
  }
  return null;
}

function itemNameOf(
  chest: RouteKnowledge["chests"][number] | null,
  why: string,
  items: ReadonlyMap<number, RouteItemNames>,
): string | null {
  if (chest === null) return null;
  const names = chest.contentNames;
  const fromItems = chest.contentId === null ? undefined : items.get(chest.contentId);
  const candidates = [
    names?.zhc,
    fromItems?.zhc,
    itemNameFromWhy(why),
    chest.contentName !== null && isChineseName(chest.contentName) ? chest.contentName : null,
    fromItems?.en,
    fromItems?.ja,
    chest.contentName,
  ];
  for (const candidate of candidates) {
    const name = candidate?.trim() ?? "";
    if (name !== "") return name;
  }
  return null;
}

function chestAt(
  knowledge: RouteKnowledge | null,
  target: RoutePoint | null,
): RouteKnowledge["chests"][number] | null {
  const cell = target?.cell ?? null;
  if (knowledge === null || target === null || cell === null) return null;
  return (
    knowledge.chests.find(
      (chest) =>
        chest.mapId === target.map &&
        chest.cell !== null &&
        chest.cell[0] === cell[0] &&
        chest.cell[1] === cell[1],
    ) ?? null
  );
}

function mapNameOf(knowledge: RouteKnowledge | null, atlas: Atlas, mapId: number): string {
  const atlasName = text(atlas.maps.get(String(mapId))?.name)?.trim() ?? "";
  const known = knowledge?.maps.find((map) => map.id === mapId);
  const names = [atlasName, known?.areaName?.trim() ?? "", known?.name?.trim() ?? ""].filter(
    (name) => name !== "",
  );
  const human = names.find((name) => !isResourceMapName(name));
  if (human !== undefined) return human;
  return names[0] ?? mapName(atlas, mapId);
}

function besidePoints(map: number, cell: Cell): RoutePoint[] {
  return BESIDE_SIDES.map(({ dx, dy }) => ({ map, cell: [cell[0] + dx, cell[1] + dy] }));
}

/** Same rule as `dry-run.ts`: try the target, then the cheapest reachable side. */
function estimateStop(
  world: RouteWorld,
  from: RoutePoint,
  target: RoutePoint,
  action: PlanStationAction,
): { readonly pair: PairResult; readonly reached: RoutePoint } {
  const exact = estimatePair(world, from, target);
  if (exact.ok) return { pair: exact, reached: target };
  if (!BESIDE_ACTIONS.has(action) || target.cell === null) {
    return { pair: exact, reached: target };
  }
  let best: { readonly pair: PairResult; readonly reached: RoutePoint } | null = null;
  for (const side of besidePoints(target.map, target.cell)) {
    const pair = estimatePair(world, from, side);
    if (!pair.ok) continue;
    if (best === null || !best.pair.ok || pair.estimate.minutes < best.pair.estimate.minutes) {
      best = { pair, reached: side };
    }
  }
  if (best === null) {
    return {
      pair: {
        ok: false,
        reason: `目标格和旁边四格都走不到（${exact.reason}）`,
      },
      reached: target,
    };
  }
  return best;
}

function lastProgressPoint(progress: RouteProgress, plan: ChapterPlan): RoutePoint | null {
  if (progress.position !== null) return progress.position;
  for (let segmentIndex = progress.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const segment = plan.segments[segmentIndex];
    const statuses = progress.segments[segmentIndex];
    if (segment === undefined || statuses === undefined) continue;
    for (let stationIndex = segment.stations.length - 1; stationIndex >= 0; stationIndex -= 1) {
      const status = statuses.stations.get(stationIndex);
      if (status === undefined || (status.status !== "done" && status.status !== "current")) {
        continue;
      }
      const fromProgress = pointFromTo(status.to);
      if (fromProgress !== null) return fromProgress;
      const station = segment.stations[stationIndex];
      if (station === undefined) continue;
      const parsed = parseTarget(station.to);
      if (typeof parsed === "string") continue;
      return { map: parsed.mapId, cell: parsed.cell };
    }
  }
  return null;
}

function segmentState(
  progress: RouteProgress | null,
  index: number,
  stationCount: number,
  doneCount: number,
): string {
  if (progress === null) return "未开始";
  if (index < progress.segment) return "完成";
  if (index > progress.segment) return "未开始";
  if (doneCount === stationCount) return "完成";
  if (progress.status === "running") return "进行中";
  if (progress.status === "blocked") return "等待修复";
  if (progress.status === "exception") return "停在例外";
  if (progress.status === "done") return "完成";
  return "中途停止";
}

function entryPointFor(
  world: RouteWorld,
  previous: RoutePoint | null,
  targetMap: number,
  candidates: readonly RouteEventCandidate[],
): RoutePoint | null {
  // Crossing maps: the previous map's exit landing is the real entrance, not a guess.
  if (previous !== null && previous.map !== targetMap) {
    const exit = mapExits(world.atlas, previous.map, world.collisions).find(
      (candidate) => candidate.to === targetMap && candidate.land !== undefined,
    );
    if (exit?.land !== undefined) return { map: targetMap, cell: exit.land };
  }
  // A map-only station is estimated from an entrance of its map: a stair/door cell when the
  // map export records one, then the first story candidate that is not the previous cell.
  const entrances = mapExits(world.atlas, targetMap, world.collisions)
    .map((exit) => exit.cell)
    .filter((cell) => previous === null || !sameCell(previous.cell, cell));
  if (entrances[0] !== undefined) return { map: targetMap, cell: entrances[0] };
  const usable =
    previous === null
      ? candidates
      : candidates.filter(
          (candidate) => previous.map !== targetMap || !sameCell(previous.cell, candidate.cell),
        );
  const chosen = usable[0] ?? candidates[0];
  return chosen === undefined ? null : { map: targetMap, cell: chosen.cell };
}

function buildModel(
  plan: ChapterPlan,
  progress: RouteProgress | null,
  world: RouteWorld,
  atlas: Atlas,
  collisions: CollisionStore | undefined,
  knowledge: RouteKnowledge | null,
  events: ReadonlyMap<number, readonly RouteEventCandidate[]>,
  items: ReadonlyMap<number, RouteItemNames>,
  start: RoutePoint | null,
  warnings: readonly string[],
): RouteModel {
  const stops: ModelStop[] = [];
  let number = 0;
  for (const [segmentIndex, segment] of plan.segments.entries()) {
    for (const [stationIndex, station] of segment.stations.entries()) {
      number += 1;
      const parsed = parseTarget(station.to);
      const target = typeof parsed === "string" ? null : { map: parsed.mapId, cell: parsed.cell };
      const seen = stationStatus(progress, segmentIndex, stationIndex);
      const chest = chestAt(knowledge, target);
      stops.push({
        number,
        segmentIndex,
        stationIndex,
        station,
        target,
        status: seen.status,
        note: seen.note,
        item: chest,
        kind: stopKind(station, chest),
        candidates: target === null ? [] : (events.get(target.map) ?? []),
      });
    }
  }

  const legs: ModelLeg[] = [];
  let previousStop: ModelStop | null = null;
  let previousPoint = start;
  let legNumber = 0;
  for (const stop of stops) {
    if (stop.target === null) continue;
    let toPoint: RoutePoint | null = stop.target;
    const atEntry = stop.target.cell === null;
    if (atEntry) {
      toPoint = entryPointFor(world, previousPoint, stop.target.map, stop.candidates);
    }
    legNumber += 1;
    if (toPoint === null) {
      legs.push({
        number: legNumber,
        fromStop: previousStop,
        toStop: stop,
        from: previousPoint,
        toPoint: null,
        atEntry,
        pair: { ok: false, reason: "格子未定，地图导出里没有候选点" },
        reached: null,
      });
      continue;
    }
    if (previousPoint === null) {
      legs.push({
        number: legNumber,
        fromStop: previousStop,
        toStop: stop,
        from: null,
        toPoint,
        atEntry,
        pair: { ok: false, reason: "不知道出发点（进度里没有最后位置）" },
        reached: null,
      });
      // With no recorded start the first station is the only sensible place to measure the
      // rest from; the first leg itself stays "unknown start" on the page.
      previousPoint = toPoint;
      previousStop = stop;
      continue;
    }
    const estimated = atEntry
      ? { pair: estimatePair(world, previousPoint, toPoint), reached: toPoint }
      : estimateStop(world, previousPoint, toPoint, stop.station.do);
    legs.push({
      number: legNumber,
      fromStop: previousStop,
      toStop: stop,
      from: previousPoint,
      toPoint,
      atEntry,
      pair: estimated.pair,
      reached: estimated.pair.ok ? estimated.reached : null,
    });
    // A failed leg keeps the last reached point: the executor cannot stand on the target, so
    // the next leg is asked from where the party really is, exactly like dry-run.ts.
    if (estimated.pair.ok) {
      previousPoint = estimated.reached;
      previousStop = stop;
    }
  }

  const segments: ModelSegment[] = plan.segments.map((segment, index) => {
    const segmentStops = stops.filter((stop) => stop.segmentIndex === index);
    const segmentLegs = legs.filter((leg) => leg.toStop.segmentIndex === index);
    const done = segmentStops.filter((stop) => stop.status === "done").length;
    return {
      index,
      section: segment.section,
      stateText: segmentState(progress, index, segmentStops.length, done),
      current:
        progress !== null &&
        index === progress.segment &&
        progress.status !== "done" &&
        done < segmentStops.length,
      progressSegment: progress?.segments[index],
      stops: segmentStops,
      legs: segmentLegs,
    };
  });

  return {
    plan,
    progress,
    world,
    atlas,
    collisions,
    knowledge,
    events,
    items,
    start,
    segments,
    warnings,
  };
}

function mapRefs(model: RouteModel): RouteMapRefView[] {
  const seen = new Map<number, RouteMapRefView>();
  const add = (mapId: number): void => {
    const existing = seen.get(mapId);
    const stationCount = (existing?.stationCount ?? 0) + 1;
    seen.set(mapId, {
      id: mapId,
      name: mapNameOf(model.knowledge, model.atlas, mapId),
      text: `${mapId} ${mapNameOf(model.knowledge, model.atlas, mapId)}`,
      stationCount,
      current: mapId === model.start?.map,
    });
  };
  for (const segment of model.segments)
    for (const stop of segment.stops) {
      if (stop.target !== null) add(stop.target.map);
    }
  for (const segment of model.segments)
    for (const leg of segment.legs) {
      if (!leg.pair.ok) continue;
      for (const mapId of leg.pair.estimate.maps) {
        if (!seen.has(mapId)) {
          seen.set(mapId, {
            id: mapId,
            name: mapNameOf(model.knowledge, model.atlas, mapId),
            text: `${mapId} ${mapNameOf(model.knowledge, model.atlas, mapId)}`,
            stationCount: 0,
            current: mapId === model.start?.map,
          });
        }
      }
    }
  // The current map is useful even when no station is on it (a corridor/start map).
  if (model.start !== null && !seen.has(model.start.map)) {
    seen.set(model.start.map, {
      id: model.start.map,
      name: mapNameOf(model.knowledge, model.atlas, model.start.map),
      text: `${model.start.map} ${mapNameOf(model.knowledge, model.atlas, model.start.map)}`,
      stationCount: 0,
      current: true,
    });
  }
  return [...seen.values()].sort((left, right) => left.id - right.id);
}

function candidateViews(candidates: readonly RouteEventCandidate[]): RouteCandidateView[] {
  return candidates.map((candidate) => ({
    cell: candidate.cell,
    cellText: cellText(candidate.cell),
    name: candidate.name,
    text: `${cellText(candidate.cell)} ${candidate.name}`,
  }));
}

function stationView(model: RouteModel, stop: ModelStop): ChapterRouteStationView {
  const mapText =
    stop.target === null
      ? "—"
      : `${stop.target.map} ${mapNameOf(model.knowledge, model.atlas, stop.target.map)}`;
  const why = stop.station.why?.trim() || "—";
  const itemName = itemNameOf(stop.item, stop.station.why ?? "", model.items);
  const label = circledNumber(stop.number);
  const unknownCell = stop.target !== null && stop.target.cell === null;
  const candidates = unknownCell ? candidateViews(stop.candidates) : [];
  const candidateText =
    unknownCell && candidates.length === 0
      ? "没有候选点"
      : candidates.map((candidate) => candidate.text).join("、");
  return {
    number: stop.number,
    segmentNumber: stop.segmentIndex + 1,
    label,
    mapId: stop.target?.map ?? null,
    mapText,
    cell: stop.target?.cell ?? null,
    cellText: stop.target === null ? "—" : unknownCell ? "格子未定" : cellText(stop.target.cell),
    unknownCell,
    candidates,
    candidateText,
    action: ACTION_LABELS[stop.station.do],
    why,
    kind: stop.kind,
    itemName,
    itemText: itemName ?? "",
    status: stop.status,
    statusText: STATUS_LABELS[stop.status],
    note: stop.note,
    current: stop.status === "current",
  };
}

function legView(model: RouteModel, leg: ModelLeg): ChapterRouteLegView {
  const fromLabel = leg.fromStop === null ? "起点" : circledNumber(leg.fromStop.number);
  const toLabel = circledNumber(leg.toStop.number);
  const from = leg.from;
  const to = leg.toPoint ?? leg.toStop.target;
  const entrySuffix = leg.atEntry ? "（按入口估算）" : "";
  if (!leg.pair.ok) {
    const mapIds = [from?.map, to?.map].filter((id): id is number => id !== undefined);
    const mapsText = mapIds.map((id) => mapNameOf(model.knowledge, model.atlas, id)).join(" → ");
    const reason = leg.pair.reason;
    return {
      number: leg.number,
      fromNumber: leg.fromStop?.number ?? null,
      fromLabel,
      toNumber: leg.toStop.number,
      toLabel,
      text: `${fromLabel}→${toLabel}：${mapsText === "" ? "—" : mapsText}，走不到：${reason}${entrySuffix}`,
      mapsText,
      mapIds,
      hops: 0,
      cells: 0,
      seconds: 0,
      durationText: "",
      ok: false,
      reason,
      from,
      to,
    };
  }
  const estimate = leg.pair.estimate;
  const mapsText = estimate.maps
    .map((id) => mapNameOf(model.knowledge, model.atlas, id))
    .join(" → ");
  const seconds =
    estimate.cells * ROUTE_SECONDS_PER_CELL + estimate.hops * ROUTE_SECONDS_PER_MAP_CHANGE;
  const durationText = secondsText(seconds);
  return {
    number: leg.number,
    fromNumber: leg.fromStop?.number ?? null,
    fromLabel,
    toNumber: leg.toStop.number,
    toLabel,
    text: `${fromLabel}→${toLabel}：${mapsText}，${estimate.hops} 跳，${estimate.cells} 格，${durationText}${entrySuffix}`,
    mapsText,
    mapIds: estimate.maps,
    hops: estimate.hops,
    cells: estimate.cells,
    seconds,
    durationText,
    ok: true,
    reason: null,
    from,
    to,
  };
}

function chestStats(segment: ModelSegment): string {
  const opens = segment.stops.filter((stop) => stop.station.do === "open");
  const planned = opens.length;
  const opened = opens.filter((stop) => stop.status === "done").length;
  const skipped = opens.filter((stop) => stop.status === "skipped").length;
  const failed = opens.filter((stop) => stop.status === "failed").length;
  const hidden = opens.filter((stop) => stop.kind === "hidden").length;
  const chests = planned - hidden;
  return (
    `宝箱/隐藏道具 ${planned} 个：计划 ${planned}、已开 ${opened}、跳过 ${skipped}` +
    (failed === 0 ? "" : `、失败 ${failed}`) +
    `（宝箱 ${chests}、隐藏 ${hidden}）`
  );
}

function segmentDistance(segment: ModelSegment): string {
  let hops = 0;
  let cells = 0;
  let seconds = 0;
  let unreachable = 0;
  for (const leg of segment.legs) {
    if (!leg.pair.ok) {
      unreachable += 1;
      continue;
    }
    hops += leg.pair.estimate.hops;
    cells += leg.pair.estimate.cells;
    seconds +=
      leg.pair.estimate.cells * ROUTE_SECONDS_PER_CELL +
      leg.pair.estimate.hops * ROUTE_SECONDS_PER_MAP_CHANGE;
  }
  const total = `总路程：${hops} 跳、${cells} 格、${secondsText(seconds)}`;
  return unreachable === 0 ? total : `${total}；走不到 ${unreachable} 段`;
}

function buildRouteView(model: RouteModel): ChapterRouteView {
  const segments = model.segments.map((segment): ChapterRouteSegmentView => {
    const legs = segment.legs.map((leg) => legView(model, leg));
    const unreachable = legs.filter((leg) => !leg.ok).length;
    return {
      number: segment.index + 1,
      section: segment.section,
      stateText: segment.stateText,
      current: segment.current,
      stations: segment.stops.map((stop) => stationView(model, stop)),
      legs,
      chestsText: chestStats(segment),
      distanceText: segmentDistance(segment),
      unreachableText: unreachable === 0 ? null : `${unreachable} 段走不到`,
    };
  });
  const successful = segments.flatMap((segment) => segment.legs).filter((leg) => leg.ok);
  const hops = successful.reduce((sum, leg) => sum + leg.hops, 0);
  const cells = successful.reduce((sum, leg) => sum + leg.cells, 0);
  const seconds = successful.reduce((sum, leg) => sum + leg.seconds, 0);
  const unreachable = segments.reduce(
    (sum, segment) => sum + (segment.unreachableText === null ? 0 : 1),
    0,
  );
  const startText =
    model.start === null
      ? "出发点未知（进度里没有最后位置）"
      : `从 ${pointText(model.knowledge, model.atlas, model.start)} 出发`;
  const state =
    model.progress === null
      ? "没在执行"
      : segmentState(model.progress, model.progress.segment, 1, 0);
  const status = model.progress === null ? "还没开始执行" : state;
  return {
    title: "章路线",
    status,
    message: null,
    chapter: model.plan.chapter,
    goalText: `目标：${model.plan.goal}`,
    startText,
    currentMapId: model.start?.map ?? null,
    currentCell: model.start?.cell ?? null,
    currentCellText: model.start === null ? "—" : cellText(model.start.cell),
    maps: mapRefs(model),
    segments,
    totalsText:
      `全程：${hops} 跳、${cells} 格、${secondsText(seconds)}` +
      (unreachable === 0 ? "" : "；有走不到的路段"),
    emptyText: "这份章计划没有站点",
    warnings: model.warnings,
  };
}

function emptyRouteView(status: string, message: string | null): ChapterRouteView {
  return {
    title: "章路线",
    status,
    message,
    chapter: null,
    goalText: "",
    startText: "",
    currentMapId: null,
    currentCell: null,
    currentCellText: "—",
    maps: [],
    segments: [],
    totalsText: "",
    emptyText: "还没有章计划",
    warnings: [],
  };
}

interface LayerHeights {
  readonly heights: readonly number[];
}

function layerHeights(snapshot: CollisionSnapshot): LayerHeights {
  const seen = new Set<number>();
  const heights: number[] = [];
  snapshot.layers.forEach((layer, index) => {
    const height = LAYER_Z.get(layer.name) ?? index;
    if (!seen.has(height)) {
      seen.add(height);
      heights.push(height);
    }
  });
  return { heights: heights.length > 0 ? heights : [snapshot.searchLayer ?? 0] };
}

interface WalkPath {
  readonly ok: boolean;
  readonly path: readonly Cell[];
}

/** The BFS path inside one map; same grid rules as `route/distance.ts`'s walk estimate. */
function walkPathCells(world: RouteWorld, mapId: number, from: Cell, to: Cell): WalkPath | null {
  const snapshot = world.collisions?.get(mapId);
  if (snapshot === undefined) return null;
  let best: readonly Cell[] | null = null;
  const jumps = jumpMoves(world.collisions?.jumps(mapId) ?? []);
  for (const height of layerHeights(snapshot).heights) {
    const grid = layeredGrid(
      { ...snapshot, searchLayer: height, playerCell: [from[0], from[1]] },
      [],
      [],
      [...world.atlas.moves(mapId), ...jumps],
      [],
    );
    if (grid === null) continue;
    const route = layeredRouteAvoiding(grid, to);
    const end = route.path.at(-1);
    if (end?.[0] !== to[0] || end[1] !== to[1]) continue;
    const path = route.path.map(([x, y]) => [x, y] as const);
    if (best === null || path.length < best.length) best = path;
  }
  return best === null ? { ok: false, path: [] } : { ok: true, path: best };
}

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

function landingOf(
  world: RouteWorld,
  hop: HopLike,
): { readonly cell: Cell | null; readonly layer: number | null } {
  if (hop.kind === "ride") {
    const ride = world.atlas
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
  const exit = mapExits(world.atlas, hop.from, world.collisions).find(
    (candidate) => sameCell(candidate.cell, hop.cell) && candidate.to === hop.to,
  );
  return exit === undefined
    ? { cell: null, layer: null }
    : { cell: exit.land ?? null, layer: exit.landLayer ?? null };
}

interface LegPiece {
  readonly map: number;
  readonly points: readonly Cell[];
  readonly entryText: string;
  readonly exitText: string;
  readonly exitCell: Cell | null;
  readonly toMap: number | null;
}

function appendPath(points: Cell[], path: readonly Cell[]): Cell[] {
  let out = points;
  for (const cell of path) {
    const last = out.at(-1);
    if (last !== undefined && sameCell(last, cell)) continue;
    out = [...out, cell];
  }
  return out;
}

function mapPathLegs(world: RouteWorld, from: RoutePoint, to: RoutePoint): HopLike[] | null {
  if (from.map === to.map) {
    if (from.cell === null || to.cell === null) return null;
    const walk = walkPathCells(world, from.map, from.cell, to.cell);
    if (walk?.ok === true) return null;
  }
  return mapPath(world.atlas, from.map, to.map, new Set(), true, {
    regions: world.regions,
    collisions: world.collisions,
    start: from.cell,
    toCell: to.cell,
    worldModes: world.worldModes,
  });
}

/** Split one leg into per-map polylines; a cross-map leg contributes one piece per map. */
function legPieces(
  world: RouteWorld,
  from: RoutePoint,
  to: RoutePoint,
  nameFor: (mapId: number) => string,
): LegPiece[] {
  if (
    !sameCell(from.cell, to.cell) &&
    from.map === to.map &&
    from.cell !== null &&
    to.cell !== null
  ) {
    const walk = walkPathCells(world, from.map, from.cell, to.cell);
    if (walk?.ok === true) {
      return [
        {
          map: from.map,
          points: walk.path,
          entryText: `起点 ${cellText(from.cell)}`,
          exitText: `到目标 ${cellText(to.cell)}`,
          exitCell: to.cell,
          toMap: null,
        },
      ];
    }
  }
  const hops = mapPathLegs(world, from, to);
  if (hops === null) return [];
  const pieces: LegPiece[] = [];
  let map = from.map;
  let cell = from.cell;
  let points: Cell[] = cell === null ? [] : [cell];
  let entryText = `起点 ${cellText(cell)}`;
  for (const hop of hops) {
    if (cell !== null) {
      const walk = walkPathCells(world, map, cell, hop.cell);
      if (walk?.ok === true) points = appendPath(points, walk.path);
      else if (points.length === 0) points = [hop.cell];
    } else if (points.length === 0) {
      points = [hop.cell];
    }
    const exitText =
      hop.kind === "ride"
        ? `在 ${cellText(hop.cell)} 坐机关去地图 ${hop.to}「${nameFor(hop.to)}」`
        : `从 ${cellText(hop.cell)} 出口去地图 ${hop.to}「${nameFor(hop.to)}」`;
    pieces.push({
      map,
      points,
      entryText,
      exitText,
      exitCell: hop.cell,
      toMap: hop.to,
    });
    const landing = landingOf(world, hop);
    map = hop.to;
    cell = landing.cell;
    points = cell === null ? [] : [cell];
    entryText =
      landing.cell === null
        ? `从地图 ${hop.from} 的 ${cellText(hop.cell)} 进来（落点未知）`
        : `从地图 ${hop.from} 的 ${cellText(hop.cell)} 进来，落在 ${cellText(landing.cell)}`;
  }
  if (to.cell !== null) {
    if (cell !== null) {
      const walk = walkPathCells(world, map, cell, to.cell);
      if (walk?.ok === true) points = appendPath(points, walk.path);
      else if (points.length === 0) points = [to.cell];
    } else if (points.length === 0) {
      points = [to.cell];
    }
  }
  pieces.push({
    map,
    points,
    entryText,
    exitText: to.cell === null ? "到目标（这张图任意格）" : `到目标 ${cellText(to.cell)}`,
    exitCell: to.cell,
    toMap: null,
  });
  return pieces;
}

interface MapGrid {
  readonly width: number;
  readonly height: number;
  readonly layer: number;
  readonly rows: readonly string[];
}

function cellChar(
  grid: LayeredGrid,
  x: number,
  y: number,
  own: readonly string[] | undefined,
): string {
  const key = `${x},${y}`;
  const otherHeights = [...grid.heights.entries()].filter(([height]) => height !== grid.z);
  const ownValue = own?.[y]?.[x] ?? "1";
  const ownOpen =
    OPEN.has(ownValue) ||
    grid.events?.has(key) === true ||
    (grid.blocked.has(key) && x === grid.center[0] && y === grid.center[1]);
  const passage = grid.passages?.get(key);
  const passageHere = passage !== undefined && (passage === null || passage === grid.z);
  if (passageHere) return "+";
  if (grid.transitions?.has(key) === true) return "=";
  if (ownOpen) return STAIRS.has(ownValue) ? "S" : ".";
  const otherOpen = otherHeights.some(([, rows]) => OPEN.has(rows[y]?.[x] ?? "1"));
  return otherOpen ? ":" : "#";
}

function mapGrid(world: RouteWorld, mapId: number, partyCell: Cell | null): MapGrid | null {
  const snapshot = world.collisions?.get(mapId);
  if (snapshot === undefined) return null;
  const heights = layerHeights(snapshot).heights;
  let layer = snapshot.searchLayer ?? heights[0] ?? 0;
  if (!heights.includes(layer)) layer = heights[0] ?? 0;
  const center: Cell = partyCell ?? [-1, -1];
  const grid = layeredGrid(
    { ...snapshot, searchLayer: layer, playerCell: [center[0], center[1]] },
    [],
    world.collisions?.toLayers(mapId).map((item) => ({ cell: item.cell, to: item.layer })) ?? [],
    world.atlas.moves(mapId),
    world.collisions?.dangers(mapId) ?? [],
    world.collisions?.eventCells(mapId) ?? new Set(),
  );
  if (grid === null) return null;
  let width = 0;
  let height = 0;
  for (const rows of grid.heights.values()) {
    height = Math.max(height, rows.length);
    for (const row of rows) width = Math.max(width, row.length);
  }
  const own = grid.heights.get(grid.z);
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const line: string[] = [];
    for (let x = 0; x < width; x += 1) line.push(cellChar(grid, x, y, own));
    rows.push(line.join(""));
  }
  return { width, height, layer: grid.z, rows };
}

function mapPathView(model: RouteModel, leg: ModelLeg, mapId: number): RouteMapPathView[] {
  if (leg.from === null || leg.toPoint === null) return [];
  const pieces = legPieces(model.world, leg.from, leg.toPoint, (id) =>
    mapNameOf(model.knowledge, model.atlas, id),
  );
  const fromLabel = leg.fromStop === null ? "起点" : circledNumber(leg.fromStop.number);
  const toLabel = circledNumber(leg.toStop.number);
  return pieces
    .filter((piece) => piece.map === mapId)
    .map((piece) => ({
      legNumber: leg.number,
      fromNumber: leg.fromStop?.number ?? null,
      fromLabel,
      toNumber: leg.toStop.number,
      toLabel,
      text: `${fromLabel}→${toLabel} 的这张图`,
      points: piece.points,
      entryText: piece.entryText,
      exitText: piece.exitText,
      ok: leg.pair.ok,
      reason: leg.pair.ok ? null : leg.pair.reason,
    }));
}

function buildMapView(model: RouteModel, requested: number | null): ChapterRouteMapView {
  const refs = mapRefs(model);
  const current = model.start?.map ?? refs[0]?.id ?? null;
  const mapId = requested ?? current;
  if (mapId !== null && !refs.some((ref) => ref.id === mapId)) {
    refs.push({
      id: mapId,
      name: mapNameOf(model.knowledge, model.atlas, mapId),
      text: `${mapId} ${mapNameOf(model.knowledge, model.atlas, mapId)}`,
      stationCount: 0,
      current: mapId === current,
    });
  }
  const maps = refs.map((ref) => ({ ...ref, current: ref.id === current }));
  const base: ChapterRouteMapView = {
    title: "路线地图",
    status: "还没有章计划",
    message: null,
    mapId: null,
    mapName: "",
    width: 0,
    height: 0,
    origin: [0, 0],
    layer: 0,
    rows: [],
    legendText: "",
    maps,
    stations: [],
    paths: [],
    exits: [],
    party: null,
    emptyText: "这张图没有站点",
    warnings: model.warnings,
  };
  if (mapId === null) {
    return { ...base, status: "不知道当前所在图", message: "进度里没有位置，计划里也没有地图" };
  }
  const name = mapNameOf(model.knowledge, model.atlas, mapId);
  const party =
    model.start !== null && model.start.map === mapId && model.start.cell !== null
      ? {
          cell: model.start.cell,
          cellText: cellText(model.start.cell),
          text: `队伍在 ${name} ${cellText(model.start.cell)}`,
        }
      : null;
  const grid = mapGrid(model.world, mapId, party?.cell ?? null);
  const stations = model.segments.flatMap((segment) =>
    segment.stops.flatMap((stop) => {
      const target = stop.target;
      if (target === null) return [];
      if (target.map !== mapId) return [];
      const markerCell = target.cell ?? stop.candidates[0]?.cell;
      if (markerCell === undefined) return [];
      const view = stationView(model, stop);
      return [
        {
          number: stop.number,
          segmentNumber: segment.index + 1,
          label: view.label,
          cell: markerCell,
          cellText: view.cellText,
          unknownCell: view.unknownCell,
          candidateText: view.candidateText,
          action: view.action,
          kind: view.kind,
          itemName: view.itemName,
          status: view.status,
          statusText: view.statusText,
          current: view.current,
        },
      ];
    }),
  );
  const paths = model.segments.flatMap((segment) =>
    segment.legs.flatMap((leg) => mapPathView(model, leg, mapId)),
  );
  const exits = mapExits(model.atlas, mapId, model.collisions).map((exit) => {
    const toName = mapNameOf(model.knowledge, model.atlas, exit.to);
    return {
      cell: exit.cell,
      cellText: cellText(exit.cell),
      to: exit.to,
      toName,
      text: `${cellText(exit.cell)} → ${exit.to} ${toName}${exit.name === "" ? "" : `（${exit.name}）`}`,
    };
  });
  const warnings = [...model.warnings];
  if (grid === null) warnings.push(`地图 ${mapId} 没有碰撞缓存，画不出网格`);
  return {
    ...base,
    status: `第 ${model.plan.chapter} 章 · ${mapId} ${name}`,
    message: null,
    mapId,
    mapName: name,
    width: grid?.width ?? 0,
    height: grid?.height ?? 0,
    layer: grid?.layer ?? 0,
    rows: grid?.rows ?? [],
    legendText: "# 墙 · . 可走 · + 隐藏通道 · : 另一层 · S 楼梯 · = 换层",
    maps,
    stations,
    paths,
    exits,
    party,
    emptyText: stations.length === 0 ? "这张图没有站点" : "",
    warnings,
  };
}

async function readJson(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<
  | { readonly state: "missing" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ok"; readonly value: unknown }
> {
  let body: string;
  try {
    body = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingFile(error)) return { state: "missing" };
    return { state: "error", message: `读不了${label}:${describeError(error)}` };
  }
  try {
    return { state: "ok", value: JSON.parse(body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { state: "error", message: `读不懂${label}:${describeError(error)}` };
  }
}

function knowledgePaths(game: string): {
  readonly staticDir: string;
  readonly filesDir: string;
  readonly collisionDir: string;
  readonly gameMapsDir: string;
  readonly itemsFile: string;
} {
  const defaults = defaultFiles(game);
  return {
    staticDir: defaults.staticDir,
    filesDir: defaults.filesDir,
    collisionDir: defaults.collisions,
    gameMapsDir: join(defaults.home, "files", "maps"),
    itemsFile: join(defaults.home, "files", "items.json"),
  };
}

/** `files/items.json`'s three-language names; a missing export leaves the map empty. */
async function readItemNames(
  game: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, RouteItemNames>> {
  const names = new Map<number, RouteItemNames>();
  const read = await readJson(knowledgePaths(game).itemsFile, "物品表", signal);
  if (read.state !== "ok" || !isRecord(read.value)) return names;
  for (const [key, raw] of Object.entries(read.value)) {
    if (!isRecord(raw)) continue;
    const id = num(raw.id) ?? Number(key);
    if (!Number.isInteger(id) || id <= 0) continue;
    const rawNames = isRecord(raw.names) ? raw.names : {};
    names.set(Math.trunc(id), {
      ja: text(rawNames.ja)?.trim() || null,
      en: text(rawNames.en)?.trim() || null,
      zhc: text(rawNames.zhc)?.trim() || null,
    });
  }
  return names;
}

function candidateName(value: string): string {
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  const after = colon >= 0 ? trimmed.slice(colon + 1).trim() : trimmed;
  return after === "" ? trimmed : after;
}

function mapFileCandidates(value: unknown): RouteEventCandidate[] {
  if (!isRecord(value)) return [];
  const found = new Map<string, RouteEventCandidate>();
  for (const raw of Array.isArray(value.events) ? value.events : []) {
    if (!isRecord(raw) || !Array.isArray(raw.cell)) continue;
    const x = num(raw.cell[0]);
    const y = num(raw.cell[1]);
    const name = text(raw.name)?.trim() ?? "";
    if (x === undefined || y === undefined || name === "") continue;
    const cell: Cell = [Math.trunc(x), Math.trunc(y)];
    // Off-map entity copies use negative coordinates; placeholders and generic entities are
    // not story triggers, and collision markers are not places the model can walk onto.
    if (
      cell[0] < 0 ||
      cell[1] < 0 ||
      name.includes("吹き出し") ||
      name.includes("【汎用】") ||
      name.startsWith("コリジョン")
    ) {
      continue;
    }
    const cellKey = `${cell[0]},${cell[1]}`;
    if (found.has(cellKey)) continue;
    found.set(cellKey, { cell, name: candidateName(name) });
    if (found.size >= 8) break;
  }
  return [...found.values()];
}

/** Story/event cells for the maps the plan names; read straight from the map export. */
async function readMapCandidates(
  game: string,
  mapIds: readonly number[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, readonly RouteEventCandidate[]>> {
  const dir = knowledgePaths(game).gameMapsDir;
  const result = new Map<number, readonly RouteEventCandidate[]>();
  for (const mapId of [...new Set(mapIds)].sort((left, right) => left - right)) {
    const read = await readJson(join(dir, `${mapId}.json`), `地图 ${mapId} 导出`, signal);
    if (read.state === "ok") result.set(mapId, mapFileCandidates(read.value));
  }
  return result;
}

async function loadWorld(
  game: string,
  files: ChapterFiles,
  signal?: AbortSignal,
): Promise<LoadedWorld> {
  const paths = knowledgePaths(game);
  const key = [
    game,
    await fileStamp(files.atlas),
    await fileStamp(paths.staticDir),
    await fileStamp(paths.filesDir),
    await fileStamp(paths.collisionDir),
    await fileStamp(paths.gameMapsDir),
    await fileStamp(paths.itemsFile),
  ].join("|");
  const cached = worldCache.get(key);
  if (cached !== undefined) return cached;

  const warnings: string[] = [];
  let atlas: Atlas;
  try {
    atlas = await Atlas.load(files.atlas, signal);
  } catch (error) {
    signal?.throwIfAborted();
    atlas = new Atlas();
    warnings.push(`地图记录读不了：${describeError(error)}`);
  }
  let collisions: CollisionStore;
  try {
    collisions = await CollisionStore.load(paths.collisionDir, signal, paths.gameMapsDir);
  } catch (error) {
    signal?.throwIfAborted();
    collisions = await CollisionStore.load(undefined);
    warnings.push(`碰撞缓存读不了：${describeError(error)}`);
  }
  let knowledge: Knowledge | null = null;
  try {
    knowledge = await loadKnowledge({
      game,
      atlas,
      collisions,
      guide: null,
      bestiaryFile: null,
      atlasSaveFile: null,
      staticDir: paths.staticDir,
      // Only the small static export: the extracted file tree has hundreds of maps and is
      // unrelated to station order. Hidden passages still come from the collision store.
      filesDir: null,
      signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    warnings.push(`知识库读不了：${describeError(error)}`);
  }
  const items = await readItemNames(game, signal);
  const world: RouteWorld = {
    atlas,
    collisions,
    regions: RegionIndex.create(atlas, collisions),
  };
  const loaded: LoadedWorld = { atlas, collisions, knowledge, items, world, warnings };
  return remember(worldCache, key, loaded);
}

function loadRouteOptions(
  game: string,
  files: ChapterFiles,
  options: ChapterRouteOptions,
  signal?: AbortSignal,
): Promise<LoadedWorld> {
  if (options.atlas !== undefined && options.collisions !== undefined) {
    const knowledge = options.knowledge === undefined ? null : options.knowledge;
    return Promise.resolve({
      atlas: options.atlas,
      collisions: options.collisions,
      knowledge,
      items: options.items ?? new Map(),
      world: {
        atlas: options.atlas,
        collisions: options.collisions,
        regions: RegionIndex.create(options.atlas, options.collisions),
      },
      warnings: [],
    });
  }
  return loadWorld(game, files, signal);
}

function cacheable(options: ChapterRouteOptions): boolean {
  return (
    options.atlas === undefined &&
    options.collisions === undefined &&
    options.knowledge === undefined &&
    options.events === undefined &&
    options.items === undefined
  );
}

async function modelKey(
  game: string,
  files: ChapterFiles,
  options: ChapterRouteOptions,
): Promise<string> {
  const paths = knowledgePaths(game);
  return [
    game,
    await fileStamp(files.plan),
    await fileStamp(files.progress),
    await fileStamp(files.atlas),
    await fileStamp(paths.staticDir),
    await fileStamp(paths.filesDir),
    await fileStamp(paths.collisionDir),
    await fileStamp(paths.gameMapsDir),
    await fileStamp(paths.itemsFile),
    options.start === undefined
      ? "auto"
      : options.start === null
        ? "none"
        : `${options.start.map}:${options.start.cell?.[0] ?? "-"},${options.start.cell?.[1] ?? "-"}`,
  ].join("|");
}

interface LoadedModel {
  readonly model: RouteModel | null;
  readonly status: string;
  readonly message: string | null;
}

async function loadModel(
  game: string,
  files: ChapterFiles,
  options: ChapterRouteOptions,
  signal?: AbortSignal,
): Promise<LoadedModel> {
  const cacheableNow = cacheable(options);
  const key = cacheableNow ? await modelKey(game, files, options) : null;
  if (key !== null) {
    const hit = modelCache.get(key);
    if (hit !== undefined) return { model: hit, status: "", message: null };
  }
  let store: ChapterPlanStore;
  try {
    store = await ChapterPlanStore.load("", files.plan, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return { model: null, status: "章计划读不了", message: describeError(error) };
  }
  const plan = store.current;
  if (plan === null) {
    return store.problems.length === 0
      ? { model: null, status: "还没有章计划", message: "还没有章计划" }
      : { model: null, status: "章计划读不了", message: store.problems.join("；") };
  }
  const loadedWorld = await loadRouteOptions(game, files, options, signal);
  const warnings = [...store.problems, ...loadedWorld.warnings];
  let progress: RouteProgress | null = null;
  const progressRead = await readJson(files.progress, "章进度", signal);
  if (progressRead.state === "error") warnings.push(progressRead.message);
  else if (progressRead.state === "ok") {
    try {
      progress = readRouteProgress(progressRead.value);
    } catch (error) {
      warnings.push(`章进度读不了：${describeError(error)}`);
    }
  }
  if (progress !== null && !progressMatches(plan, progress)) {
    warnings.push("章进度是上一份计划的");
    progress = null;
  }
  let start: RoutePoint | null;
  if (options.start === undefined) {
    start = progress === null ? null : lastProgressPoint(progress, plan);
  } else {
    start = options.start;
  }
  const mapIds = new Set<number>();
  if (start !== null) mapIds.add(start.map);
  for (const segment of plan.segments) {
    for (const station of segment.stations) {
      const parsed = parseTarget(station.to);
      if (typeof parsed !== "string") mapIds.add(parsed.mapId);
    }
  }
  const events =
    options.events ??
    (cacheableNow ? await readMapCandidates(game, [...mapIds], signal) : new Map());
  const model = buildModel(
    plan,
    progress,
    loadedWorld.world,
    loadedWorld.atlas,
    loadedWorld.collisions,
    loadedWorld.knowledge,
    events,
    loadedWorld.items,
    start,
    warnings,
  );
  if (key !== null) remember(modelCache, key, model);
  return { model, status: "", message: null };
}

/**
 * GET /api/ffpr/chapter/route?game=ffN: every station in execution order, its chest item and
 * state, and the estimate between adjacent stations. `position=10:3,4` is the browser's live
 * position; without it the progress file's last reached station is used.
 */
export async function readChapterRoute(
  files: ChapterFiles,
  game: string,
  options: ChapterRouteOptions = {},
  signal?: AbortSignal,
): Promise<ChapterRouteView> {
  const cacheableNow = cacheable(options);
  const key = cacheableNow ? await modelKey(game, files, options) : null;
  if (key !== null) {
    const hit = routeViewCache.get(key);
    if (hit !== undefined) return hit;
  }
  const loaded = await loadModel(game, files, options, signal);
  if (loaded.model === null) return emptyRouteView(loaded.status, loaded.message);
  const view = buildRouteView(loaded.model);
  return key === null ? view : remember(routeViewCache, key, view);
}

/**
 * GET /api/ffpr/chapter/route/map?game=ffN&map=10: the collision grid, stations, exits and
 * per-leg polylines on one map. Without `map` it answers for the party's current map.
 */
export async function readChapterRouteMap(
  files: ChapterFiles,
  game: string,
  mapId?: number | null,
  options: ChapterRouteOptions = {},
  signal?: AbortSignal,
): Promise<ChapterRouteMapView> {
  const cacheableNow = cacheable(options);
  const key = cacheableNow ? await modelKey(game, files, options) : null;
  const mapKey = key === null ? null : `${key}|map:${mapId ?? "auto"}`;
  if (mapKey !== null) {
    const hit = mapViewCache.get(mapKey);
    if (hit !== undefined) return hit;
  }
  const loaded = await loadModel(game, files, options, signal);
  if (loaded.model === null) {
    return {
      title: "路线地图",
      status: loaded.status,
      message: loaded.message,
      mapId: null,
      mapName: "",
      width: 0,
      height: 0,
      origin: [0, 0],
      layer: 0,
      rows: [],
      legendText: "",
      maps: [],
      stations: [],
      paths: [],
      exits: [],
      party: null,
      emptyText: "还没有章计划",
      warnings: [],
    };
  }
  const view = buildMapView(loaded.model, mapId ?? null);
  return mapKey === null ? view : remember(mapViewCache, mapKey, view);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

type GameChoice =
  { readonly ok: true; readonly game: Game } | { readonly ok: false; readonly error: string };

async function requestedGame(request: Request, current?: CurrentSource): Promise<GameChoice> {
  const raw = new URL(request.url).searchParams.get("game");
  const key =
    raw === null || raw.trim() === ""
      ? current === undefined
        ? "ff5"
        : (await readCurrent(current)).game
      : raw.trim();
  try {
    return { ok: true, game: byKey(key) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function positionFromQuery(request: Request, allowMapFields = true): RoutePoint | null | undefined {
  const params = new URL(request.url).searchParams;
  const raw = params.get("position")?.trim() ?? "";
  if (raw !== "") {
    const match = /^(\d+)(?:\s*:\s*(-?\d+)\s*,\s*(-?\d+))?$/u.exec(raw);
    if (match !== null) {
      return {
        map: Number(match[1]),
        cell:
          match[2] === undefined || match[3] === undefined
            ? null
            : [Number(match[2]), Number(match[3])],
      };
    }
    return undefined;
  }
  if (!allowMapFields) return undefined;
  const map = Number(params.get("map") ?? "");
  if (!Number.isInteger(map) || map <= 0) return undefined;
  const x = Number(params.get("x") ?? "");
  const y = Number(params.get("y") ?? "");
  return {
    map,
    cell: Number.isInteger(x) && Number.isInteger(y) ? [x, y] : null,
  };
}

function mapFromQuery(request: Request): number | null | undefined {
  const raw = new URL(request.url).searchParams.get("map")?.trim() ?? "";
  if (raw === "") return null;
  const map = Number(raw);
  if (!Number.isInteger(map) || map <= 0) return undefined;
  return map;
}

/** GET /api/ffpr/chapter/route: the route view; always 200 with a rendered view. */
export function chapterRouteDataRoute(
  current?: CurrentSource,
  filesFor: (game: string) => ChapterFiles = defaultChapterFiles,
): ConnectionFetchRoute {
  return {
    path: CHAPTER_ROUTE_DATA,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      try {
        const choice = await requestedGame(request, current);
        if (!choice.ok) return json({ ok: false, error: choice.error, at });
        const start = positionFromQuery(request);
        return json({
          ok: true,
          at,
          view: await readChapterRoute(
            filesFor(choice.game.key),
            choice.game.key,
            start === undefined ? {} : { start },
            request.signal,
          ),
        });
      } catch (error) {
        request.signal.throwIfAborted();
        return json({ ok: false, error: `读不了章路线：${describeError(error)}`, at });
      }
    },
  };
}

/** GET /api/ffpr/chapter/route/map: one map's grid and polylines. */
export function chapterRouteMapRoute(
  current?: CurrentSource,
  filesFor: (game: string) => ChapterFiles = defaultChapterFiles,
): ConnectionFetchRoute {
  return {
    path: CHAPTER_ROUTE_MAP,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      try {
        const choice = await requestedGame(request, current);
        if (!choice.ok) return json({ ok: false, error: choice.error, at });
        const map = mapFromQuery(request);
        if (map === undefined) {
          return json({ ok: false, error: "map 要是正整数地图号", at });
        }
        const start = positionFromQuery(request, false);
        return json({
          ok: true,
          at,
          view: await readChapterRouteMap(
            filesFor(choice.game.key),
            choice.game.key,
            map,
            start === undefined ? {} : { start },
            request.signal,
          ),
        });
      } catch (error) {
        request.signal.throwIfAborted();
        return json({ ok: false, error: `读不了章路线地图：${describeError(error)}`, at });
      }
    },
  };
}

/** The chapter panel's file set, repeated here so panel.ts can register without importing it. */

/**
 * Route book → stage plan and live progress (task 117, 11-11). The book says what to do in one
 * guide section; this module turns its stations into the stage layer's executable route and
 * keeps the book's own progress file, so `route {}` can walk a whole section without asking the
 * model at every chest.
 *
 * Pure conversion is deliberately separate from the file store: the conversion is tested with a
 * hand-written `RouteBook`, and the store is tested without a bridge.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "../errors.ts";
import { isRecord, list, num, text } from "../values.ts";
import type {
  BookProgress,
  BookSectionStats,
  BookStationProgress,
  BookStationStatus,
} from "./book-progress-types.ts";
import type { RouteBook, RouteSection, RouteStation } from "./route-book.ts";
import type { StageBookPoint, StagePlan } from "./types.ts";

const ACTION_NAMES: Readonly<Record<string, string>> = {
  chest: "开宝箱",
  hidden: "找隐藏道具",
  talk: "对话",
  switch: "机关",
  save: "存档",
  heal: "回复",
  boss: "打首领",
  cutscene: "剧情",
  shop: "购物",
  piano: "钢琴",
  move: "移动",
  note: "笔记",
};

export interface BookPlanOptions {
  /** Config's cap for one grind stop (default 8 minutes). */
  readonly grindMinutes: number;
}

/** The stage-plan route one book section asks for. */
export function routeFromBookSection(
  section: RouteSection,
  options: BookPlanOptions,
): StagePlan["route"] {
  const route: StagePlan["route"][number][] = [];
  for (const station of section.stations) {
    const added = stationRoute(section, station);
    route.push(...added);
  }
  const grinds = grindStops(section, options.grindMinutes);
  if (grinds.length > 0) {
    // A missable monster is best fought on its own map before the section ends. Insert the
    // stop after the last station on that map (or before a boss on it); the analyzer may
    // reorder it later, but the input keeps the book's intent.
    for (const grind of grinds) {
      const mapId = typeof grind.to === "number" ? grind.to : Number(grind.to.split(":")[0]);
      let at = route.length;
      for (const [index, stop] of route.entries()) {
        if (
          stop.book?.kind === "boss" &&
          (stop.to === String(mapId) || stop.to.startsWith(`${mapId}:`))
        ) {
          at = index;
          break;
        }
      }
      route.splice(at, 0, grind);
    }
  }
  // Task 122: a "回头学" block is a normal tail of the section. Stops the save or the party
  // rules out stay in the book (and progress) with their reason, but never walk anywhere.
  route.push(...revisitStops(section, options.grindMinutes));
  return route;
}

/** Task 122: "回头学青魔法"/"回头补图鉴" stations as grind stops with an explicit `until`. */
function revisitStops(section: RouteSection, minutes: number): StagePlan["route"][number][] {
  const out: StagePlan["route"][number][] = [];
  for (const station of section.revisit?.stations ?? []) {
    const grind = station.grind;
    if (grind === undefined || grind === null) continue;
    if (grind.skipReason !== null) continue;
    if (station.mapId === null) continue;
    out.push({
      to: String(station.mapId),
      do: "grind",
      optional: false,
      until: {
        ...(grind.blueMagic === null ? {} : { blueMagic: [grind.blueMagic] }),
        ...(grind.bestiary === null ? {} : { bestiary: [grind.bestiary] }),
        minutes,
      },
      book: bookPoint(section, station),
    });
  }
  return out;
}

/** One station, or several stops for a multi-cell chest ("open this map's chests"). */
function stationRoute(section: RouteSection, station: RouteStation): StagePlan["route"][number][] {
  const mapFallback = station.mapId ?? section.maps[0]?.mapId ?? null;
  const book = bookPoint(section, station);
  switch (station.kind) {
    case "move":
    case "note":
      return [];
    case "chest":
    case "hidden":
      return chestStops(station, book, mapFallback);
    case "save": {
      if (station.cell === null || station.mapId === null)
        return [handoffStop(station, book, mapFallback)];
      return [
        {
          to: `${station.mapId}:${station.cell[0]},${station.cell[1]}`,
          do: "save",
          optional: false,
          book,
        },
      ];
    }
    case "boss": {
      const mapId = station.mapId ?? mapFallback;
      if (mapId === null) return [];
      return [
        {
          to:
            station.cell === null
              ? String(mapId)
              : `${mapId}:${station.cell[0]},${station.cell[1]}`,
          do: "boss",
          optional: false,
          book,
        },
      ];
    }
    default: {
      if (station.cell !== null && station.mapId !== null) {
        return [
          {
            to: `${station.mapId}:${station.cell[0]},${station.cell[1]}`,
            do: "talk",
            optional: false,
            book,
          },
        ];
      }
      return [handoffStop(station, book, mapFallback)];
    }
  }
}

/**
 * Chest cells: the station's own cell, its paired chest, and the unpaired candidates (a guide
 * line saying "open the chests on this floor" leaves several). An opened chest is skipped; a
 * multi-cell station becomes one `open` per cell, all carrying the same station index.
 */
function chestStops(
  station: RouteStation,
  book: StageBookPoint,
  mapFallback: number | null,
): StagePlan["route"][number][] {
  const candidates: { readonly mapId: number; readonly cell: readonly [number, number] }[] = [];
  const seen = new Set<string>();
  const add = (mapId: number | null, cell: readonly [number, number] | null): void => {
    if (mapId === null || cell === null) return;
    const key = `${mapId}:${cell[0]},${cell[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ mapId, cell });
  };
  if (station.chest?.opened !== true) {
    add(station.mapId ?? station.chest?.mapId ?? mapFallback, station.cell);
    add(station.mapId ?? station.chest?.mapId ?? mapFallback, station.chest?.cell ?? null);
    for (const candidate of station.chest?.candidates ?? []) {
      if (candidate.opened === true) continue;
      add(candidate.mapId, candidate.cell);
    }
  }
  if (candidates.length === 0) {
    return station.chest?.opened === true ? [] : [handoffStop(station, book, mapFallback)];
  }
  return candidates.map((candidate, index) => ({
    to: `${candidate.mapId}:${candidate.cell[0]},${candidate.cell[1]}`,
    do: "open" as const,
    optional: false,
    book: {
      ...book,
      ...(candidates.length > 1 ? { part: index + 1, parts: candidates.length } : {}),
    },
  }));
}

function handoffStop(
  station: RouteStation,
  book: StageBookPoint,
  mapFallback: number | null,
): StagePlan["route"][number] {
  const mapId = station.mapId ?? mapFallback;
  return {
    to: mapId === null ? "1" : String(mapId),
    do: "handoff",
    optional: false,
    book,
  };
}

function bookPoint(section: RouteSection, station: RouteStation): StageBookPoint {
  return {
    section: section.title,
    index: station.index,
    kind: station.kind,
    text: station.text,
    where: station.where,
  };
}

/**
 * Grind stops the book's own "刷怪建议" asks for: a missable monster this save has not
 * registered, and a blue spell a Blue Mage in the party has not learned. One stop per map,
 * stopping at the first condition the grind loop meets.
 */
function grindStops(section: RouteSection, minutes: number): StagePlan["route"][number][] {
  const sectionMaps = new Set(section.maps.map((map) => map.mapId));
  const byMap = new Map<number, { bestiary: (string | number)[]; blueMagic: string[] }>();
  const target = (mapId: number) => {
    let entry = byMap.get(mapId);
    if (entry === undefined) {
      entry = { bestiary: [], blueMagic: [] };
      byMap.set(mapId, entry);
    }
    return entry;
  };
  for (const grind of section.grind) {
    if (!sectionMaps.has(grind.mapId)) continue;
    const monster = section.monsters.find(
      (candidate) =>
        candidate.name === grind.monster ||
        String(candidate.bookId ?? "") === grind.monster ||
        candidate.guideName === grind.monster,
    );
    if (monster === undefined || !monster.missable || monster.registered === true) continue;
    // Task 126: the monster's own encounter maps must include this stop; a table that names a
    // monster from elsewhere must not become a grind here.
    if (!monster.maps.includes(grind.mapId)) continue;
    const value = monster.bookId ?? monster.name;
    const targets = target(grind.mapId);
    if (!targets.bestiary.some((existing) => String(existing) === String(value))) {
      targets.bestiary.push(value);
    }
  }
  for (const spell of section.blueMagic) {
    if (spell.learned === true || spell.hasBlueMage !== true) continue;
    const maps =
      spell.maps.length > 0 ? spell.maps : spell.teachers.flatMap((teacher) => teacher.maps);
    for (const mapId of new Set(maps)) {
      if (!sectionMaps.has(mapId)) continue;
      const targets = target(mapId);
      if (!targets.blueMagic.includes(spell.name)) targets.blueMagic.push(spell.name);
    }
  }
  const order = new Map(section.maps.map((map, index) => [map.mapId, index]));
  return [...byMap.entries()]
    .sort((left, right) => (order.get(left[0]) ?? 99) - (order.get(right[0]) ?? 99))
    .map(([mapId, targets]) => ({
      to: String(mapId),
      do: "grind" as const,
      optional: false,
      until: {
        ...(targets.bestiary.length === 0 ? {} : { bestiary: targets.bestiary }),
        ...(targets.blueMagic.length === 0 ? {} : { blueMagic: targets.blueMagic }),
        minutes,
      },
    }));
}

/** Chinese one-line description of a handoff station, for the model's tool result. */
export function handoffText(
  section: string,
  station: {
    readonly index: number;
    readonly kind: string;
    readonly text: string;
    readonly where?: string | null;
  },
  mapLabel: string,
): string {
  const action = ACTION_NAMES[station.kind] ?? "处理";
  return (
    `路线书「${section}」第 ${station.index + 1} 站交给你:${action}，` +
    `攻略原文:${station.text}；在地图 ${mapLabel}。处理完再 route {} 接着走。`
  );
}

// ---------------------------------------------------------------------------------------------
// Progress file

const STATUSES: ReadonlySet<string> = new Set(["pending", "current", "done", "handoff", "skipped"]);

function statusOf(value: unknown): BookStationStatus {
  return typeof value === "string" && STATUSES.has(value)
    ? (value as BookStationStatus)
    : "pending";
}

function progressOf(value: unknown, game: string): BookProgress {
  if (!isRecord(value)) throw new Error("路线书进度不是 JSON 对象");
  const stats = isRecord(value.stats) ? value.stats : {};
  const count = (raw: unknown): number => Math.max(0, Math.trunc(num(raw) ?? 0));
  const missing = (raw: unknown): number | null => {
    const parsed = num(raw);
    return parsed === undefined ? null : Math.max(0, Math.trunc(parsed));
  };
  const section = text(value.section);
  if (section === undefined) throw new Error("路线书进度没有 section");
  return {
    game: text(value.game) ?? game,
    section,
    startedAt: text(value.startedAt) ?? new Date(0).toISOString(),
    updatedAt: text(value.updatedAt) ?? new Date(0).toISOString(),
    finishedAt: text(value.finishedAt) ?? null,
    stations: list(value.stations).flatMap((entry, index) => {
      if (!isRecord(entry)) return [];
      return [
        {
          index: Math.trunc(num(entry.index) ?? index),
          status: statusOf(entry.status),
          note: text(entry.note) ?? "",
        },
      ];
    }),
    stats: {
      tools: count(stats.tools),
      go: count(stats.go),
      route: count(stats.route),
      handoffs: count(stats.handoffs),
      chestsOpened: count(stats.chestsOpened),
      chestsTotal: count(stats.chestsTotal),
      bestiaryMissing: missing(stats.bestiaryMissing),
      blueMagicMissing: missing(stats.blueMagicMissing),
      minutes: count(stats.minutes),
    },
  };
}

/** The section's stations, all pending, with the acceptance numbers the book already knows. */
export function newBookProgress(
  game: string,
  section: RouteSection,
  at: Date,
  initialTool: string | null,
): BookProgress {
  const stations: BookStationProgress[] = [
    ...section.stations,
    ...(section.revisit?.stations ?? []),
  ].map((station) => {
    const reason = skipReasonOf(station);
    return {
      index: station.index,
      status: reason === null ? ("pending" as const) : ("skipped" as const),
      note: reason ?? "",
    };
  });
  const tool = initialTool === "go" || initialTool === "route" ? initialTool : null;
  const stats: BookSectionStats = {
    tools: initialTool === null ? 0 : 1,
    go: tool === "go" ? 1 : 0,
    route: tool === "route" ? 1 : 0,
    handoffs: 0,
    chestsOpened: 0,
    chestsTotal: section.chestsTotal,
    bestiaryMissing: section.bestiaryMissing,
    blueMagicMissing: section.blueMagicMissing,
    minutes: 0,
  };
  return {
    game,
    section: section.title,
    startedAt: at.toISOString(),
    updatedAt: at.toISOString(),
    finishedAt: null,
    stations,
    stats,
  };
}

/** One section's live progress; a missing file is a fresh store. */
export class BookProgressStore {
  readonly path: string | undefined;
  readonly game: string;
  current: BookProgress | null = null;

  constructor(game: string, path?: string) {
    this.game = game;
    this.path = path;
  }

  static async load(game: string, path?: string, signal?: AbortSignal): Promise<BookProgressStore> {
    const store = new BookProgressStore(game, path);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了路线书进度 ${path}:${describeError(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂路线书进度 ${path}:${describeError(error)}`, { cause: error });
    }
    store.current = progressOf(parsed, game);
    return store;
  }

  async save(): Promise<void> {
    if (this.current === null || this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(this.path, `${JSON.stringify(this.current, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new Error(`写不了路线书进度 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }

  /** Start a section, replacing any previous section's progress. */
  async start(section: RouteSection, at = new Date(), tool: string | null = null): Promise<void> {
    this.current = newBookProgress(this.game, section, at, tool);
    await this.save();
  }

  /** Count one game tool call by the model, using task 113's name buckets. */
  async countTool(name: string): Promise<void> {
    const progress = this.current;
    if (progress === null) return;
    if (progress.finishedAt !== null) return;
    const stats = progress.stats;
    this.current = {
      ...progress,
      updatedAt: new Date().toISOString(),
      stats: {
        ...stats,
        tools: stats.tools + 1,
        go: stats.go + (name === "go" ? 1 : 0),
        route: stats.route + (name === "route" ? 1 : 0),
      },
    };
    await this.save();
  }

  /** Record one station; kind tells a chest/handoff from a boss handing back. */
  async mark(
    index: number,
    status: BookStationStatus,
    note: string,
    kind: string | null = null,
  ): Promise<void> {
    const progress = this.current;
    if (progress === null) return;
    const stations = progress.stations.map((station) =>
      station.index === index ? { ...station, status, note } : station,
    );
    const before = progress.stations.find((station) => station.index === index);
    const stats = progress.stats;
    const chest =
      status === "done" && before?.status !== "done" && (kind === "chest" || kind === "hidden");
    const handoff =
      status === "handoff" && before?.status !== "handoff" && kind !== null && kind !== "boss";
    this.current = {
      ...progress,
      stations,
      updatedAt: new Date().toISOString(),
      stats: {
        ...stats,
        chestsOpened: stats.chestsOpened + (chest ? 1 : 0),
        handoffs: stats.handoffs + (handoff ? 1 : 0),
      },
    };
    await this.save();
  }

  /** Missing counts can change while a section runs (a grind registers a monster). */
  async setMissing(bestiaryMissing: number | null, blueMagicMissing: number | null): Promise<void> {
    if (this.current === null) return;
    this.current = {
      ...this.current,
      updatedAt: new Date().toISOString(),
      stats: { ...this.current.stats, bestiaryMissing, blueMagicMissing },
    };
    await this.save();
  }

  /** Close the section; minutes is wall time from its first tool call. */
  async finish(at = new Date()): Promise<void> {
    const progress = this.current;
    if (progress === null) return;
    if (progress.finishedAt !== null) return;
    this.current = {
      ...progress,
      finishedAt: at.toISOString(),
      updatedAt: at.toISOString(),
      stats: { ...progress.stats, minutes: minutesOf(progress, at) },
    };
    await this.save();
  }
}

function minutesOf(progress: BookProgress, end: Date): number {
  const started = Date.parse(progress.startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((end.getTime() - started) / 60_000));
}

/** The acceptance line task 117 puts in the activity log and at the end of `route`. */
export function bookStatsLine(progress: BookProgress): string {
  const stats = progress.stats;
  const bestiary = stats.bestiaryMissing === null ? "未知" : String(stats.bestiaryMissing);
  const blue = stats.blueMagicMissing === null ? "未知" : String(stats.blueMagicMissing);
  const minutes =
    progress.finishedAt === null
      ? minutesOf(progress, new Date())
      : Math.max(stats.minutes, minutesOf(progress, new Date(Date.parse(progress.finishedAt))));
  return (
    `路线书统计「${progress.section}」:工具 ${stats.tools} 次` +
    `(go ${stats.go}、route ${stats.route}),交回 ${stats.handoffs} 次,` +
    `宝箱 ${stats.chestsOpened}/${stats.chestsTotal},图鉴还缺 ${bestiary},` +
    `青魔法还缺 ${blue},用时 ${minutes} 分`
  );
}

/** Task 122: why a "回头学" station will not run, or null when it will. */
function skipReasonOf(station: RouteStation): string | null {
  return station.grind?.skipReason ?? null;
}

/** One station by index in a section, for the handoff wording and learned coordinates. */
export function stationOf(section: RouteSection, index: number): RouteStation | null {
  return section.stations.find((station) => station.index === index) ?? null;
}

/** The route book's section by title, or null. */
export function sectionOf(book: RouteBook, title: string): RouteSection | null {
  return book.sections.find((section) => section.title === title) ?? null;
}

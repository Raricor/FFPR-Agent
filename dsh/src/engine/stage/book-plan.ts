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
import type { StageBookCandidate, StageBookPoint, StagePlan } from "./types.ts";

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
  const main: StagePlan["route"][number][] = [];
  for (const planned of plannedStations(section)) {
    const added = stationRoute(section, planned.station);
    for (const stop of added) {
      main.push(withIndexes(stop, planned.indexes));
    }
  }
  // Task 133: every collection stop comes first, handoffs keep the guide's order, and a boss
  // stays last. Grinds join the collection group, so a chest is never skipped just because
  // the guide's piano line came before it.
  //
  // Task 136: heal and save stops are conditional, not collection. They are inserted just
  // before the boss they guard (or stay in the guide's own order when the section has no
  // boss). The executor decides at runtime whether the party actually needs them.
  const collection = main.filter((stop) => isCollectionStop(stop) && !isConditionalStop(stop));
  const handoffs = main.filter(
    (stop) => !isCollectionStop(stop) && !isBossStop(stop) && !isConditionalStop(stop),
  );
  const conditional = main.filter(isConditionalStop);
  const bosses = main.filter(isBossStop);
  const grinds = grindStops(section, options.grindMinutes);
  const revisits = revisitStops(section, options.grindMinutes);
  if (bosses.length === 0) {
    return [...collection, ...grinds, ...byGuideOrder([...handoffs, ...conditional]), ...revisits];
  }
  const before: StagePlan["route"][number][][] = bosses.map(() => []);
  const tail: StagePlan["route"][number][] = [];
  for (const stop of conditional) {
    const at = bossAfter(stop, bosses);
    if (at === null) tail.push(stop);
    else (before[at] ?? []).push(stop);
  }
  const guarded: StagePlan["route"][number][] = [];
  for (const [index, boss] of bosses.entries()) {
    guarded.push(...(before[index] ?? []), boss);
  }
  return [...collection, ...grinds, ...handoffs, ...revisits, ...guarded, ...tail];
}

/** The first boss whose guide step comes after this conditional stop; null means none. */
function bossAfter(
  stop: StagePlan["route"][number],
  bosses: readonly StagePlan["route"][number][],
): number | null {
  const index = stop.book?.index ?? -1;
  for (const [position, boss] of bosses.entries()) {
    if ((boss.book?.index ?? Number.POSITIVE_INFINITY) > index) return position;
  }
  return null;
}

/** Task 136: guide order, used when a section has no boss to guard. */
function byGuideOrder(stops: readonly StagePlan["route"][number][]): StagePlan["route"][number][] {
  return [...stops].sort((left, right) => (left.book?.index ?? 0) - (right.book?.index ?? 0));
}

interface PlannedStation {
  readonly station: RouteStation;
  /** Guide step indexes this one stop stands for (adjacent piano steps are merged). */
  readonly indexes: readonly number[];
  readonly group: string | null;
}

function plannedStations(section: RouteSection): PlannedStation[] {
  const firstPending =
    section.stations.find(
      (station) =>
        (station.kind === "chest" || station.kind === "hidden") && station.chest?.opened !== true,
    )?.index ?? null;
  const out: PlannedStation[] = [];
  for (const station of section.stations) {
    if (station.kind === "note" || isNoteLine(station.text)) continue;
    if (isPassedStory(station, firstPending, section)) continue;
    const group = handoffGroup(station);
    const previous = out.at(-1);
    if (group !== null && previous?.group === group && previous.station.where === station.where) {
      out[out.length - 1] = {
        station: combineHandoffs(previous.station, station),
        indexes: [...previous.indexes, station.index],
        group,
      };
      continue;
    }
    out.push({ station, indexes: [station.index], group });
  }
  return out;
}

function isNoteLine(text: string): boolean {
  return /^\s*(?:note|optional|trivia)\s*[:：]/iu.test(text);
}

const HANDOFF_GROUPS: ReadonlySet<string> = new Set([
  "talk",
  "switch",
  "cutscene",
  "shop",
  "piano",
]);

function handoffGroup(station: RouteStation): string | null {
  if (station.kind === "boss" || !HANDOFF_GROUPS.has(station.kind)) return null;
  if (station.kind === "piano" || /\b(?:piano|stool|bench)\b/iu.test(station.text)) {
    return "piano";
  }
  return station.kind;
}

function combineHandoffs(left: RouteStation, right: RouteStation): RouteStation {
  const candidates = [...(left.candidates ?? []), ...(right.candidates ?? [])].filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) =>
          other.kind === candidate.kind &&
          other.mapId === candidate.mapId &&
          other.name === candidate.name &&
          other.cell[0] === candidate.cell[0] &&
          other.cell[1] === candidate.cell[1],
      ) === index,
  );
  return {
    ...left,
    text: `${left.text} ${right.text}`.trim(),
    ...(candidates.length === 0 ? {} : { candidates }),
  };
}

function isPassedStory(
  station: RouteStation,
  firstPending: number | null,
  section: RouteSection,
): boolean {
  if (firstPending === null || station.index >= firstPending) return false;
  if (station.kind === "boss" || !HANDOFF_GROUPS.has(station.kind)) return false;
  if (station.mapId === null) {
    return (station.where ?? "").trim().toLowerCase() === "overworld";
  }
  return section.maps.find((map) => map.mapId === station.mapId)?.visited === true;
}

function withIndexes(
  stop: StagePlan["route"][number],
  indexes: readonly number[],
): StagePlan["route"][number] {
  if (indexes.length <= 1 || stop.book === undefined) return stop;
  return { ...stop, book: { ...stop.book, indexes: [...indexes] } };
}

function isCollectionStop(stop: StagePlan["route"][number]): boolean {
  const kind = stop.book?.kind;
  return stop.do === "open" || stop.do === "grind" || kind === "chest" || kind === "hidden";
}

/** Task 136: a heal or save the party only needs when a condition holds. */
function isConditionalStop(stop: StagePlan["route"][number]): boolean {
  const kind = stop.book?.kind;
  return stop.do === "save" || kind === "save" || kind === "heal";
}

function isBossStop(stop: StagePlan["route"][number]): boolean {
  return stop.do === "boss" || stop.book?.kind === "boss";
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
        return [{ ...handoffStop(station, book, mapFallback), optional: true }];
      return [
        {
          to: `${station.mapId}:${station.cell[0]},${station.cell[1]}`,
          do: "save",
          optional: true,
          book,
        },
      ];
    }
    case "heal": {
      if (station.cell !== null && station.mapId !== null) {
        return [
          {
            to: `${station.mapId}:${station.cell[0]},${station.cell[1]}`,
            do: "talk",
            optional: true,
            book,
          },
        ];
      }
      return [{ ...handoffStop(station, book, mapFallback), optional: true }];
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
  const candidates: {
    readonly mapId: number;
    readonly cell: readonly [number, number];
  }[] = [];
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
    ...(station.chest === null ? {} : { item: station.chest.item }),
    ...(station.candidates === undefined || station.candidates.length === 0
      ? {}
      : {
          candidates: station.candidates.map((candidate) => ({
            kind: candidate.kind,
            mapId: candidate.mapId,
            name: candidate.name,
            names: candidate.names ?? null,
            cell: candidate.cell,
          })),
        }),
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
    readonly candidates?: readonly StageBookCandidate[];
  },
  mapLabel: string,
): string {
  const action = ACTION_NAMES[station.kind] ?? "处理";
  const candidates = candidateText(station.candidates);
  return (
    `路线书「${section}」第 ${station.index + 1} 站交给你:${action}，` +
    `攻略原文:${station.text}；在地图 ${mapLabel}。` +
    (candidates === "" ? "" : `候选:${candidates}。`) +
    "处理完再 route {} 接着走。"
  );
}

function candidateText(candidates: readonly StageBookCandidate[] | undefined): string {
  if (candidates === undefined || candidates.length === 0) return "";
  return candidates
    .map((candidate) => {
      const names = [candidate.names?.ja, candidate.names?.en, candidate.names?.zhc]
        .filter((name): name is string => name !== null && name !== undefined && name !== "")
        .join("/");
      const label =
        candidate.kind === "event"
          ? `事件 ${candidate.name}`
          : `NPC ${candidate.name}${names === "" ? "" : `(${names})`}`;
      return `${label} 地图 ${candidate.mapId} (${candidate.cell[0]},${candidate.cell[1]})`;
    })
    .join("；");
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
      ...(stats.activeMs === undefined ? {} : { activeMs: count(stats.activeMs) }),
      ...(text(stats.lastToolAt) === undefined ? {} : { lastToolAt: text(stats.lastToolAt) }),
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
    chestsOpened: section.chests.filter((chest) => chest.opened === true).length,
    chestsTotal: section.chestsTotal,
    bestiaryMissing: section.bestiaryMissing,
    blueMagicMissing: section.blueMagicMissing,
    minutes: 0,
    activeMs: 0,
    lastToolAt: at.toISOString(),
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
      throw new Error(`读不了路线书进度 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂路线书进度 ${path}:${describeError(error)}`, {
        cause: error,
      });
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
      throw new Error(`写不了路线书进度 ${this.path}:${describeError(error)}`, {
        cause: error,
      });
    }
  }

  /** Start a section, replacing any previous section's progress. */
  async start(section: RouteSection, at = new Date(), tool: string | null = null): Promise<void> {
    this.current = newBookProgress(this.game, section, at, tool);
    await this.save();
  }

  /** Count one game tool call by the model, using task 113's name buckets. */
  async countTool(name: string, at = new Date()): Promise<void> {
    const progress = this.current;
    if (progress === null) return;
    if (progress.finishedAt !== null) return;
    const stats = advanceTiming(progress.stats, progress.startedAt, at);
    this.current = {
      ...progress,
      updatedAt: at.toISOString(),
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
    const stats = advanceTiming(progress.stats, progress.startedAt, at);
    this.current = {
      ...progress,
      finishedAt: at.toISOString(),
      updatedAt: at.toISOString(),
      stats: { ...stats, minutes: minutesOf(stats) },
    };
    await this.save();
  }
}

/** Task 133: one long gap (the model stopped overnight) must not become working time. */
const IDLE_GAP_MS = 10 * 60_000;

function advanceTiming(stats: BookSectionStats, startedAt: string, at: Date): BookSectionStats {
  const last = Date.parse(stats.lastToolAt ?? startedAt);
  const gap = Number.isFinite(last) ? Math.max(0, at.getTime() - last) : 0;
  const activeMs = (stats.activeMs ?? 0) + Math.min(gap, IDLE_GAP_MS);
  return {
    ...stats,
    activeMs,
    lastToolAt: at.toISOString(),
    minutes: minutesOf({ activeMs }),
  };
}

function minutesOf(stats: { readonly activeMs?: number }): number {
  return Math.max(0, Math.round((stats.activeMs ?? 0) / 60_000));
}

/** Minutes so far: finished sections use the stored number, a running one adds the current gap. */
function currentMinutes(progress: BookProgress, at: Date): number {
  if (progress.finishedAt !== null) return progress.stats.minutes;
  const last = Date.parse(progress.stats.lastToolAt ?? progress.startedAt);
  const gap = Number.isFinite(last) ? Math.max(0, at.getTime() - last) : 0;
  return minutesOf({
    activeMs: (progress.stats.activeMs ?? 0) + Math.min(gap, IDLE_GAP_MS),
  });
}

/** The acceptance line task 117 puts in the activity log and at the end of `route`. */
export function bookStatsLine(progress: BookProgress): string {
  const stats = progress.stats;
  const bestiary = stats.bestiaryMissing === null ? "未知" : String(stats.bestiaryMissing);
  const blue = stats.blueMagicMissing === null ? "未知" : String(stats.blueMagicMissing);
  const minutes = currentMinutes(progress, new Date());
  return (
    `路线书统计「${progress.section}」:工具 ${stats.tools} 次` +
    `(go ${stats.go}、route ${stats.route}),交回 ${stats.handoffs} 次,` +
    `宝箱 ${stats.chestsOpened}/${stats.chestsTotal},图鉴还缺 ${bestiary},` +
    `青魔法还缺 ${blue},用时 ${minutes} 分(实际)`
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

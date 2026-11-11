/**
 * Chapter executor (task 152, 11-11): run one whole `ChapterPlan` — growth targets and every
 * section's `SegmentPlan` — with code only. It reads `plan.fallback` and handles what the plan
 * itself did not answer: retry a failed station on a fresh route, skip an optional station,
 * grind and retry a lost boss, and walk back to an inn when the party is too hurt to go on.
 * The model is called only after all of that fails, and then only by the wiring layer (task
 * 153) reading the returned `ChapterReport`. `modelCalls` must stay 0 here.
 *
 * Progress (`ChapterProgress`) is written at the start, after every station, on every fallback
 * and at the end; the section progress files are still written by `executeSegmentPlan`. Both
 * paths are supplied by the caller. A failed progress write is a warning in the activity log,
 * never a reason to stop the chapter (a plan that can still play must not die for a JSON file).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cleanName } from "../icons.ts";
import { normalizeName } from "../knowledge/index.ts";
import type { Cell } from "../nav.ts";
import { executeRoute } from "../route/execute.ts";
import type { Waypoint } from "../route/types.ts";
import type { RunEventInput, RunLogSink } from "../run-log.ts";
import type {
  ChapterFactsData,
  ChapterGrowthTarget,
  ChapterPlan,
  ChapterProgress,
  ChapterReport,
} from "./chapter-types.ts";
import {
  executeSegmentPlan,
  type ExecutePlanOptions,
  type ExecutePorts,
  type ExecuteProgressEvent,
  type PlanActionResult,
  type PlanObservation,
  type PlanProgressStatus,
  type PlanRestorePoint,
} from "./execute.ts";
import type { SegmentFactsBoss } from "./facts.ts";
import type {
  PlanBoss,
  PlanExceptionKind,
  PlanStation,
  PlanTurnBack,
  SegmentPlan,
  SegmentReport,
} from "./types.ts";

/** A fallback walk must not become a hidden, unbounded part of the chapter. */
const GROWTH_WALK_BUDGET_MS = 15 * 60 * 1000;
const RESTORE_WALK_BUDGET_MS = 15 * 60 * 1000;
/** `bossLost` has no minutes field; a bad fallback must still not grind forever. */
const BOSS_GRIND_MINUTES = 30;

/** Task 156 follow-up: a failed pre-station recovery blocks the chapter, not a station. */
const RESTORE_BLOCKED = "等待修复：";

/** Task 156: stand below/above/right/left of a restore-point object, below first. */
const RESTORE_SIDES: readonly { readonly dx: number; readonly dy: number }[] = [
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
];

/** One segment's station-level resume point: skip old finished stations, run the rest. */
export interface ChapterStationResume {
  /** First station this run must actually execute (0-based in the new plan). */
  readonly startAt: number;
  /** Finished new stations after `startAt`; the segment executor skips them. */
  readonly skip: readonly number[];
  /** New station index → old station index, for matched done/skipped stations (0-based). */
  readonly done?: Readonly<Record<number, number>>;
}

export interface ExecuteChapterOptions {
  /** The game key used in the progress/report files (`ff5`, `ff6`, …). */
  readonly game?: string;
  /**
   * The `chapter-progress-<game>.json` path; the caller decides the directory. Undefined means
   * "do not record", which the CLI uses when it only wants the report.
   */
  readonly progressPath?: string;
  /** The `chapter-report-<game>.json` path; undefined means "do not record". */
  readonly reportPath?: string;
  readonly revision?: number;
  readonly previousException?: ChapterProgress["previousException"];
  readonly signal?: AbortSignal;
  /** One line per notable decision; the CLI prints it, tests may collect it. */
  readonly log?: (line: string) => void;
  /** Segment time budgets; the chapter itself has no separate wall-clock cap. */
  readonly segmentBudgetMs?: number;
  readonly stationBudgetMs?: number;
  /** Resume at this segment; earlier segments were completed by the previous run. */
  readonly startAt?: number;
  /** Per segment index, where to resume after the stations the previous run finished. */
  readonly skipStations?: Readonly<Record<number, ChapterStationResume>>;
  /** Task 156: the chapter facts, so a boss station without a cell can use its triggers. */
  readonly facts?: ChapterFactsData;
  /** Task 156: fill a boss pre-fight heal to this HP%; the game passes Config's value. */
  readonly healFullPercent?: number;
  /** Task 162: how long a story station may explore for its trigger; Config's value. */
  readonly storyExploreBudgetMs?: number;
  /**
   * The progress file this resume came from. It supplies each station's original note/status,
   * so a segment that was never run stays pending instead of being labelled done by `startAt`.
   */
  readonly priorProgress?: ChapterProgress;
  /** Task 158: structured run log; the chapter owns run.start/run.end. */
  readonly runLog?: RunLogSink;
}

export interface ChapterResume {
  readonly startAt: number;
  readonly skipStations: Readonly<Record<number, ChapterStationResume>>;
}

type ProgressStationStatus = ChapterProgress["segments"][number]["stations"][number]["status"];

/** The station record this module writes; `to`/`do` let a later plan be compared with it. */
interface ProgressStationRecord {
  readonly index: number;
  readonly status: ProgressStationStatus;
  readonly note: string;
  readonly to?: string;
  readonly do?: string;
}

interface ProgressSegmentRecord {
  readonly section: string;
  readonly stations: readonly ProgressStationRecord[];
}

interface ChapterProgressFile extends Omit<ChapterProgress, "segments"> {
  readonly segments: readonly ProgressSegmentRecord[];
}

/**
 * The chapter start used to mark every station done without running it. Existing progress files
 * written before task 153's follow-up still carry this note; a resume must not trust it.
 */
const BLANKET_DONE_NOTE = "之前的运行已完成";

function trustedNote(note: string): boolean {
  const value = note.trim();
  return value !== "" && value !== BLANKET_DONE_NOTE;
}

function stationKeyMatches(state: ProgressStationRecord, station: PlanStation): boolean {
  return state.to !== undefined && state.do !== undefined
    ? state.to === station.to && state.do === station.do
    : false;
}

function trustedFinished(state: ProgressStationRecord): boolean {
  return (state.status === "done" || state.status === "skipped") && trustedNote(state.note);
}

interface SegmentStationMatch {
  /** New station index → old station index; only trusted done/skipped stations are paired. */
  readonly matched: ReadonlyMap<number, number>;
  /** First new station not paired; equals the new station count when every station matched. */
  readonly first: number;
}

/**
 * Pair new stations with old finished stations in order. A station matches only when both
 * `to` and `do` are equal, and one old station can be used once. Old progress written before
 * `to`/`do` were recorded still pairs by index when the station count is unchanged.
 */
function matchSegmentStations(
  segment: SegmentPlan,
  seen: ProgressSegmentRecord | undefined,
): SegmentStationMatch {
  const matched = new Map<number, number>();
  if (seen?.section !== segment.section) {
    return { matched, first: 0 };
  }
  const old = seen.stations;
  const legacy =
    old.length === segment.stations.length &&
    old.every((state) => state.to === undefined && state.do === undefined);
  if (legacy) {
    for (let index = 0; index < old.length; index += 1) {
      const state = old[index];
      if (state?.index === index && trustedFinished(state)) matched.set(index, index);
    }
  } else {
    let cursor = 0;
    for (let index = 0; index < segment.stations.length; index += 1) {
      const station = segment.stations[index];
      if (station === undefined) continue;
      for (let oldIndex = cursor; oldIndex < old.length; oldIndex += 1) {
        const state = old[oldIndex];
        if (state?.index !== oldIndex || !trustedFinished(state)) continue;
        if (!stationKeyMatches(state, station)) continue;
        matched.set(index, oldIndex);
        cursor = oldIndex + 1;
        break;
      }
    }
  }
  const first = segment.stations.findIndex((_station, index) => !matched.has(index));
  return { matched, first: first < 0 ? segment.stations.length : first };
}

/** New station ranges with their old numbers, e.g. `第 1–3 站(旧 1–3)`. */
function matchedStationsText(done: Readonly<Record<number, number>>): string {
  const pairs = Object.entries(done)
    .map(([station, old]) => [Number(station) + 1, old + 1] as const)
    .sort((left, right) => left[0] - right[0]);
  if (pairs.length === 0) return "";
  const groups: {
    readonly newFrom: number;
    readonly newTo: number;
    readonly oldFrom: number;
    readonly oldTo: number;
  }[] = [];
  for (const [newIndex, oldIndex] of pairs) {
    const last = groups[groups.length - 1];
    if (last !== undefined && newIndex === last.newTo + 1 && oldIndex === last.oldTo + 1) {
      groups[groups.length - 1] = { ...last, newTo: newIndex, oldTo: oldIndex };
    } else {
      groups.push({
        newFrom: newIndex,
        newTo: newIndex,
        oldFrom: oldIndex,
        oldTo: oldIndex,
      });
    }
  }
  return groups
    .map((group) => {
      const station =
        group.newFrom === group.newTo
          ? `第 ${group.newFrom} 站`
          : `第 ${group.newFrom}–${group.newTo} 站`;
      const old =
        group.oldFrom === group.oldTo
          ? `旧 ${group.oldFrom}`
          : `旧 ${group.oldFrom}–${group.oldTo}`;
      return `${station}(${old})`;
    })
    .join("、");
}

/** The Chinese resume line: where it starts and which matched stations (with old numbers) it skips. */
export function describeChapterResume(plan: ChapterPlan, resume: ChapterResume): string {
  const segment = plan.segments[resume.startAt];
  if (segment === undefined) return "续跑:所有段都已完成";
  const current = resume.skipStations[resume.startAt];
  const start = current?.startAt ?? 0;
  const skipped: string[] = [];
  for (let index = 0; index < resume.startAt; index += 1) {
    const done = plan.segments[index];
    if (done !== undefined)
      skipped.push(`第 ${index + 1} 节「${done.section}」全部 ${done.stations.length} 站`);
  }
  const matched = matchedStationsText(current?.done ?? {});
  if (matched !== "") skipped.push(matched);
  else if (start > 0) {
    skipped.push(
      start === 1
        ? `第 ${resume.startAt + 1} 节第 1 站`
        : `第 ${resume.startAt + 1} 节第 1–${start} 站`,
    );
  }
  for (const station of current?.skip ?? []) {
    if (current?.done?.[station] !== undefined) continue;
    skipped.push(`第 ${resume.startAt + 1} 节第 ${station + 1} 站`);
  }
  const tail = skipped.length === 0 ? "" : `;跳过:${skipped.join("、")}`;
  return `续跑从第 ${resume.startAt + 1} 节「${segment.section}」第 ${start + 1} 站开始${tail}`;
}

/**
 * Where a previous `ChapterProgress` says to continue: the first segment with a station that
 * does not match an old trusted done/skipped station by `to`+`do`. Station counts may differ; a
 * different section name still means the whole segment reruns. Null only when the plan has a
 * different chapter or segment count, because old segment indexes would point at other sections.
 */
export function chapterResumeFrom(
  plan: ChapterPlan,
  progress: ChapterProgress,
): ChapterResume | null {
  if (progress.chapter !== plan.chapter) return null;
  if (progress.segments.length !== plan.segments.length) return null;
  const recorded: ChapterProgressFile = progress;
  let startAt = plan.segments.length;
  const skipStations: Record<number, ChapterStationResume> = {};
  // Only a different section name forces the whole segment to rerun. A changed station count is
  // matched station by station: a new station with the same to+do as an old trusted done/skipped
  // station (used once, in order) counts as finished.
  let changed = false;
  for (let index = 0; index < plan.segments.length; index += 1) {
    const segment = plan.segments[index];
    const seen = recorded.segments[index];
    if (segment === undefined || seen === undefined) return null;
    if (changed || seen.section !== segment.section) {
      changed = true;
      if (index < startAt) startAt = index;
      continue;
    }
    const { matched, first } = matchSegmentStations(segment, seen);
    if (first < segment.stations.length) {
      if (index < startAt) startAt = index;
      const skip = [...matched.keys()].filter((station) => station > first).sort((a, b) => a - b);
      if (first > 0 || skip.length > 0) {
        skipStations[index] = {
          startAt: first,
          skip,
          done: Object.fromEntries(matched),
        };
      }
    }
  }
  return { startAt, skipStations };
}

interface StationState {
  index: number;
  status: "pending" | "current" | "done" | "failed" | "skipped";
  note: string;
  to: string;
  do: string;
  /** Old station index when this station matched a trusted finished one. */
  matchedOld: number | null;
  matchedStatus?: "done" | "skipped";
  matchedNote?: string;
}

interface SegmentState {
  section: string;
  stations: StationState[];
}

class ChapterStop extends Error {
  readonly kind: PlanExceptionKind;

  constructor(kind: PlanExceptionKind, message: string) {
    super(message);
    this.name = "ChapterStop";
    this.kind = kind;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "未知错误";
  if (typeof error === "string") return error;
  return String(error);
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function parseTarget(to: string): { readonly map: number; readonly cell: Cell | null } | null {
  const match = /^(?:地图\s*)?(\d+)(?:\s*:\s*(.+))?$/u.exec(to.trim());
  if (match === null) return null;
  const map = Number(match[1]);
  if (!Number.isInteger(map) || map <= 0) return null;
  const raw = match[2]?.trim();
  if (raw === undefined || raw === "") return { map, cell: null };
  const cell = /^(\d+)\s*,\s*(\d+)$/u.exec(raw);
  if (cell === null) return null;
  return { map, cell: [Number(cell[1]), Number(cell[2])] };
}

function sameCell(left: Cell | null, right: Cell | null): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
}

function cellText(cell: Cell | null): string {
  return cell === null ? "位置不明" : `(${cell[0]},${cell[1]})`;
}

function lowestHpPct(observation: PlanObservation | null): number | null {
  if (observation === null || observation.members.length === 0) return null;
  let lowest = 100;
  for (const member of observation.members) {
    const share = member.maxHp > 0 ? (100 * member.hp) / member.maxHp : 100;
    if (share < lowest) lowest = share;
  }
  return lowest;
}

function lowestLevel(observation: PlanObservation | null): number | null {
  if (observation === null) return null;
  const levels = observation.members
    .map((member) => member.lv)
    .filter((level): level is number => level !== null);
  return levels.length === 0 ? null : Math.min(...levels);
}

function deadCount(observation: PlanObservation | null): number {
  if (observation === null) return 0;
  return observation.members.filter((member) => member.hp <= 0).length;
}

/** Task 158: levels gained during a chapter-side grind, for the run report. */
function levelsGained(
  before: PlanObservation | null,
  after: PlanObservation | null,
): { readonly member: string; readonly fromLevel: number; readonly toLevel: number }[] {
  if (before === null || after === null) return [];
  const old = new Map<string, number>();
  for (const member of before.members) {
    if (member.lv !== null) old.set(member.name, member.lv);
  }
  const out: { member: string; fromLevel: number; toLevel: number }[] = [];
  for (const member of after.members) {
    const from = old.get(member.name);
    if (from !== undefined && member.lv !== null && member.lv > from) {
      out.push({ member: member.name, fromLevel: from, toLevel: member.lv });
    }
  }
  return out;
}

function statusCount(observation: PlanObservation | null): number {
  if (observation === null) return 0;
  return observation.members.filter((member) => member.status.length > 0).length;
}

/**
 * Task 156: restore points revive by default. FF5's springs and pots do ("从无法战斗状态中
 * 复活了！" at Wind Shrine 1F), and only a real-device test that proved otherwise may mark one
 * false in the map record. Older/plain entries with no flag therefore revive too.
 */
/** Task 162: a story station whose only evidence was a script move. */
function weakStoryEvidence(note: string): boolean {
  const match = /证据:(.+)$/u.exec(note);
  if (match === null) return false;
  const tokens = (match[1] ?? "")
    .split(/[、；,;]/u)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  return tokens.length === 1 && tokens[0] === "脚本移动";
}

function canRevive(point: PlanRestorePoint): boolean {
  return point.revive !== false;
}

function bossNameMatches(left: string, right: string): boolean {
  const a = normalizeName(cleanName(left));
  const b = normalizeName(cleanName(right));
  if (a === "" || b === "") return false;
  return a === b || a.includes(b) || b.includes(a);
}

function bossAliases(boss: SegmentFactsBoss): string[] {
  return [
    boss.name,
    boss.knowledgeName ?? "",
    boss.guideName ?? "",
    boss.bookId === null ? "" : String(boss.bookId),
  ].filter((name) => name.trim() !== "");
}

/**
 * Task 156: the chapter facts' trigger cells for a plan boss on one map. The plan may name the
 * boss in another language, so match every alias; a single boss on the map is enough when no
 * name matches (the same fallback `bossForStation` uses).
 */
function factBossTriggers(
  facts: ChapterFactsData | undefined,
  boss: PlanBoss,
  map: number,
): readonly Cell[] {
  if (facts === undefined) return [];
  const bosses = facts.sections.flatMap((section) => section.facts.bosses);
  const onMap = bosses.filter((entry) => entry.maps.length === 0 || entry.maps.includes(map));
  const named = onMap.filter((entry) =>
    bossAliases(entry).some((alias) => bossNameMatches(boss.name, alias)),
  );
  const pool = named.length > 0 ? named : onMap.length === 1 ? onMap : [];
  return pool.flatMap((entry) =>
    entry.triggers
      .filter((trigger) => trigger.map === map)
      .map((trigger) => [trigger.cell[0], trigger.cell[1]] as Cell),
  );
}

/** A failed station whose reason is in the plan itself: a fresh route cannot change it. */
function planProblemDetail(kind: PlanExceptionKind, detail: string): string | null {
  if (kind === "invalid") return detail;
  // The executor's own fatal/plan-problem marker wins over the wording below.
  if (/\bfatal\b|计划问题|致命/u.test(detail)) return detail;
  const patterns: readonly RegExp[] = [
    /剧情没有触发/u,
    /什么也没发生/u,
    /没有动作生效的证据/u,
    /没有格子/u,
    /没有坐标/u,
    /没法调查/u,
    /交互对象/u,
    /对象不存在/u,
    /这一站不存在/u,
    /不存在/u,
    /读不懂/u,
    /地图\s*\d+\s*在地图记录里/u,
    /地图记录里根本没有/u,
    /没有对应的首领表/u,
  ];
  return patterns.some((pattern) => pattern.test(detail)) ? detail : null;
}

/** True when the failure is about reaching the whole map, not one cell on a reached map. */
function wholeMapUnreachable(detail: string): boolean {
  const patterns: readonly RegExp[] = [
    /地图记录里没有地图\s*\d+/u,
    /地图记录里没有从地图\s*\d+\s*到地图\s*\d+/u,
    /按（地图，连通块）走不到地图\s*\d+/u,
    /地图\s*\d+\s*在地图记录里没有路/u,
    /交通工具[^；]*(?:不能用|还没读出来)/u,
    /整张图(?:地图)?\s*\d*\s*(?:现在)?(?:去不了|走不到|到不了)/u,
    /地图\s*\d+\s*(?:现在)?(?:去不了|到不了)/u,
    /去不了地图\s*\d+/u,
  ];
  return patterns.some((pattern) => pattern.test(detail));
}

function statusOf(status: PlanProgressStatus): StationState["status"] {
  if (status === "handoff") return "failed";
  return status;
}

/**
 * Sum two reports of the same section when the second resumed after the first failed. The
 * resumed report counts the earlier stations itself (see `startAt`), so only the fields it
 * cannot know (chests/battles/bestiary from the failed run) are added here.
 */
function mergeReports(base: SegmentReport, next: SegmentReport): SegmentReport {
  return {
    section: next.section,
    status: next.status,
    ...(next.exception === undefined ? {} : { exception: next.exception }),
    done: {
      // The resumed report already counts the earlier stations (executeSegmentPlan marks them
      // done when `startAt` > 0), so the larger count is the section's total.
      stations: Math.max(base.done.stations, next.done.stations),
      chestsOpened: base.done.chestsOpened + next.done.chestsOpened,
      battles: base.done.battles + next.done.battles,
      bestiaryNew: [...new Set([...base.done.bestiaryNew, ...next.done.bestiaryNew])],
      blueMagicNew: [...new Set([...base.done.blueMagicNew, ...next.done.blueMagicNew])],
      bossesWon: [...new Set([...base.done.bossesWon, ...next.done.bossesWon])],
    },
    remaining: next.remaining,
    party: next.party === "" ? base.party : next.party,
    minutes: base.minutes + next.minutes,
    modelCalls: base.modelCalls + next.modelCalls,
  };
}

/**
 * Run the chapter. Growth targets run before the segment named by `before`; each segment then
 * runs through `executeSegmentPlan`. A `ChapterReport` is returned after the last segment or
 * after the fallbacks are used up, never while the chapter can still make progress.
 */
export async function executeChapterPlan(
  plan: ChapterPlan,
  ports: ExecutePorts,
  options: ExecuteChapterOptions = {},
): Promise<ChapterReport> {
  const started = Date.now();
  const game = options.game ?? "ff5";
  const log = options.log ?? ((): void => undefined);
  const signal = options.signal;
  const startedAt = new Date(started).toISOString();
  let updatedAt = startedAt;
  let finishedAt: string | null = null;
  let status: ChapterProgress["status"] = "running";
  const startAt = Math.max(0, Math.min(options.startAt ?? 0, plan.segments.length));
  const resumed = options.startAt !== undefined || options.skipStations !== undefined;
  const resumeLine = resumed
    ? describeChapterResume(plan, {
        startAt,
        skipStations: options.skipStations ?? {},
      })
    : "";
  let segmentIndex = startAt;
  /** Stations skipped in the current segment run; a retry prefix must not turn them done. */
  let activeSkipped = new Map<number, string>();
  const fallbacks: string[] = [];
  const emitRun = (event: RunEventInput): void => {
    options.runLog?.record({
      chapter: plan.chapter,
      segment: segmentIndex,
      section:
        plan.segments[Math.max(0, Math.min(segmentIndex, plan.segments.length - 1))]?.section ??
        null,
      station: null,
      ...event,
    });
  };
  const reportBySegment: (SegmentReport | undefined)[] = plan.segments.map(() => undefined);
  /** Task 162: last story station finished on script-move evidence only. */
  let lastWeakStory: {
    readonly segment: number;
    readonly station: number;
    readonly map: number;
  } | null = null;
  /** Task 162: set by runSegment when two unreachable stations ask to replay the weak story. */
  let restartFrom: { readonly segment: number; readonly station: number } | null = null;
  const rewoundWeak = new Set<string>();
  /** Task 161: growth that could not run yet; retried at later segment boundaries. */
  const pendingGrowth: {
    readonly target: ChapterGrowthTarget;
    readonly index: number;
    reason: string;
  }[] = [];
  let reports: readonly SegmentReport[] = [];
  const wonBosses = new Set<string>();
  const visitedMaps = new Set<number>();
  const plannedMaps = new Set<number>();
  const notePlanMap = (where: string | null | undefined): void => {
    if (where === null || where === undefined) return;
    const target = parseTarget(where);
    if (target !== null) plannedMaps.add(target.map);
  };
  for (const segment of plan.segments) {
    for (const station of segment.stations) notePlanMap(station.to);
  }
  for (const growth of plan.growth) notePlanMap(growth.where);
  notePlanMap(plan.fallback.bossLost.where);
  const prior = options.priorProgress;
  const priorRecord: ChapterProgressFile | undefined = prior;
  const priorChapter = prior?.chapter === plan.chapter;
  const segments: SegmentState[] = plan.segments.map((segment, index) => {
    const seen = priorChapter ? priorRecord?.segments[index] : undefined;
    const { matched } = matchSegmentStations(segment, seen);
    return {
      section: segment.section,
      stations: segment.stations.map((station, stationIndex) => {
        const oldIndex = matched.get(stationIndex);
        const state = oldIndex === undefined ? undefined : seen?.stations[oldIndex];
        const usable =
          state === undefined
            ? undefined
            : {
                status: state.status === "skipped" ? ("skipped" as const) : ("done" as const),
                note: state.note,
              };
        return {
          index: stationIndex,
          status: usable?.status ?? ("pending" as const),
          note: usable?.note ?? "",
          to: station.to,
          do: station.do,
          matchedOld: oldIndex ?? null,
          ...(usable === undefined
            ? {}
            : { matchedStatus: usable.status, matchedNote: usable.note }),
        };
      }),
    };
  });
  let exceptionDetail = "";
  let exception: ChapterReport["exception"] | undefined;

  const progress = (): ChapterProgressFile => ({
    game,
    chapter: plan.chapter,
    goal: plan.goal,
    revision: options.revision ?? 1,
    startedAt,
    updatedAt,
    finishedAt,
    status,
    segment: Math.max(0, Math.min(segmentIndex, Math.max(0, plan.segments.length - 1))),
    segments: segments.map((segment) => ({
      section: segment.section,
      stations: segment.stations.map((station) => ({
        index: station.index,
        status: station.status,
        note: station.note,
        to: station.to,
        do: station.do,
      })),
    })),
    fallbacks: [...fallbacks],
    previousException: options.previousException ?? null,
  });

  const writeProgress = async (): Promise<void> => {
    if (options.progressPath === undefined) return;
    updatedAt = new Date().toISOString();
    try {
      await mkdir(dirname(options.progressPath), { recursive: true });
      await writeFile(options.progressPath, `${JSON.stringify(progress(), null, 2)}\n`, "utf8");
    } catch (error) {
      log(`章节进度没写成:${errorText(error)}`);
      emitRun({ type: "warn", reason: `章节进度没写成:${errorText(error)}` });
    }
  };

  const addFallback = async (
    line: string,
    kind = "retry",
    station: number | null = null,
  ): Promise<void> => {
    fallbacks.push(line);
    emitRun({ type: "fallback", kind, reason: line, station });
    log(`兜底:${line}`);
    await writeProgress();
  };

  const updateStation = async (event: ExecuteProgressEvent): Promise<void> => {
    const segment = segments[segmentIndex];
    const station = segment?.stations[event.index];
    if (station === undefined) return;
    if (station.matchedOld !== null && station.matchedStatus !== undefined) {
      // A matched old station counts as finished; keep its old status/note instead of the
      // executor's generic "retry prefix" or "skipped" wording.
      station.status = station.matchedStatus;
      station.note = station.matchedNote ?? station.note;
    } else if (event.status === "skipped") {
      activeSkipped.set(event.index, event.note);
      station.status = "skipped";
      station.note = event.note;
    } else if (event.status === "done" && activeSkipped.has(event.index)) {
      // The executor marks every station before `startAt` done. A station this run skipped
      // must stay skipped, with its own reason, never "重试前已完成".
      station.status = "skipped";
      station.note = activeSkipped.get(event.index) ?? "按兜底跳过";
    } else {
      station.status = statusOf(event.status);
      station.note = event.note;
    }
    if (station.status === "done" && station.do === "story" && weakStoryEvidence(station.note)) {
      const map = parseTarget(station.to)?.map ?? null;
      if (map !== null) {
        lastWeakStory = { segment: segmentIndex, station: event.index, map };
      }
    }
    await writeProgress();
  };

  const checkAbort = (): boolean => signal?.aborted === true;

  /** Walk to a `"map"` / `"map:x,y"` growth or boss spot; null on arrival, otherwise why not. */
  const walkTo = async (where: string, tag: string): Promise<string | null> => {
    const target = parseTarget(where);
    if (target === null) return `地点「${where}」读不懂`;
    const here = await ports.position();
    if (here === null) return "读不到当前位置";
    if (here.map === target.map && (target.cell === null || sameCell(here.cell, target.cell))) {
      return null;
    }
    const waypoint: Waypoint = {
      id: `chapter-${tag}`,
      kind: "move",
      map: target.map,
      cell: target.cell,
      label: tag,
      reach: target.cell === null ? "map" : "cell",
    };
    let route;
    try {
      route = await ports.planRoute(here, [waypoint], null);
    } catch (error) {
      return `规划去「${where}」的路线出错:${errorText(error)}`;
    }
    if (!route.legs.some((leg) => leg.waypoint === waypoint.id)) {
      return `走不到「${where}」`;
    }
    const walked = await executeRoute(route, ports.routePorts(), {
      signal,
      timeBudgetMs: GROWTH_WALK_BUDGET_MS,
      maxWaypointFailures: 2,
      waypoints: [waypoint],
    });
    if (walked.reason !== "completed") return `去「${where}」没走到:${walked.message}`;
    return null;
  };

  /** One `growth` entry: walk there, grind until level or gil; failure is deferred, not fatal. */
  const runGrowth = async (
    target: ChapterGrowthTarget,
    index: number,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    if (target.level === undefined && target.gil === undefined) {
      log(`growth ${index + 1} 没有写等级或金钱目标，跳过`);
      return { ok: true };
    }
    if (checkAbort()) throw new ChapterStop("other", "已取消");
    const growthStarted = Date.now();
    const walked = await walkTo(target.where, `growth-${index + 1}`);
    if (walked !== null) return { ok: false, reason: walked };
    const now = await ports.observe();
    const where = parseTarget(target.where) ?? {
      map: now.map ?? 0,
      cell: now.cell,
    };
    const elapsed = (Date.now() - growthStarted) / 60_000;
    const left = Math.max(0, target.maxMinutes - elapsed);
    if (left <= 0) {
      return { ok: false, reason: `成长目标在 ${target.maxMinutes} 分内没走到「${target.where}」` };
    }
    const waypoint: Waypoint = {
      id: `chapter-growth-${index + 1}`,
      kind: "grind",
      map: where.map,
      cell: where.cell,
      label: `成长目标 ${index + 1}`,
      reach: where.cell === null ? "map" : "cell",
      until: {
        ...(target.level === undefined ? {} : { level: target.level }),
        ...(target.gil === undefined ? {} : { gil: target.gil }),
        minutes: Math.round(left * 10) / 10,
      },
    };
    const result = await ports.grind(waypoint);
    log(
      `成长目标 ${index + 1} 刷怪:${result.text}` +
        `（目标 ${target.level === undefined ? "" : `等级 ${target.level}`}` +
        (target.level !== undefined && target.gil !== undefined ? "、" : "") +
        `${target.gil === undefined ? "" : `金钱 ${target.gil}`}，上限 ${target.maxMinutes} 分）`,
    );
    const after = await ports.observe();
    for (const level of levelsGained(now, after)) {
      emitRun({
        type: "level",
        member: level.member,
        fromLevel: level.fromLevel,
        toLevel: level.toLevel,
      });
    }
    const levelOk =
      target.level === undefined ||
      (lowestLevel(after) !== null && (lowestLevel(after) ?? 0) >= target.level);
    const readGil = after.gil ?? null;
    const gilOk =
      target.gil === undefined ||
      readGil === null || // an old bridge cannot read gil; the grind's own stop is all we have
      readGil >= target.gil;
    if (result.ok && levelOk && gilOk) return { ok: true };
    return {
      ok: false,
      reason:
        `成长目标没达到（` +
        [
          target.level === undefined ? "" : `等级 ${lowestLevel(after) ?? "?"}/${target.level}`,
          target.gil === undefined ? "" : `金钱 ${readGil ?? "?"}/${target.gil}`,
        ]
          .filter((line) => line !== "")
          .join("、") +
        `；${result.text}）`,
    };
  };

  /** Grind `bossLost.levels` more levels at `bossLost.where` (or the failed station's map). */
  const grindForBoss = async (failure: SegmentReport, segment: SegmentPlan): Promise<void> => {
    const config = plan.fallback.bossLost;
    const before = await ports.observe();
    const current = lowestLevel(before);
    const target = {
      level: current === null ? config.levels : current + Math.max(1, config.levels),
      where:
        config.where ??
        (failure.exception?.station === null || failure.exception?.station === undefined
          ? null
          : segment.stations[failure.exception.station]?.to) ??
        null,
      maxMinutes: BOSS_GRIND_MINUTES,
    };
    if (target.where !== null) {
      const walked = await walkTo(target.where, "boss-grind");
      if (walked !== null) log(`首领兜底刷级没走到:${walked}；就在原地刷`);
    }
    const here = await ports.position();
    const waypoint: Waypoint = {
      id: "chapter-boss-grind",
      kind: "grind",
      map: here?.map ?? before.map ?? 0,
      cell: here?.cell ?? before.cell ?? null,
      label: `首领失败后刷到 Lv${target.level}`,
      reach: "cell",
      until: { level: target.level, minutes: target.maxMinutes },
    };
    const result = await ports.grind(waypoint);
    const after = await ports.observe().catch(() => null);
    for (const level of levelsGained(before, after)) {
      emitRun({
        type: "level",
        member: level.member,
        fromLevel: level.fromLevel,
        toLevel: level.toLevel,
      });
    }
    log(`首领兜底刷级:${result.text}（目标最低等级 ${target.level}）`);
  };

  /** Walk to a restore point, heal fully, and walk back to where the station stopped. */
  const goRestore = async (
    observation: PlanObservation | null,
    next: number,
  ): Promise<string | null> => {
    const pct = lowestHpPct(observation);
    const deadBefore = deadCount(observation);
    const statusBefore = statusCount(observation);
    if (pct === null) return null;
    if (pct >= plan.fallback.healBelowPct && deadBefore === 0 && statusBefore === 0) return null;
    const tag = `第 ${segmentIndex + 1} 节第 ${next + 1} 站前`;
    /** 10-29 live: a failed restore must not become this station's failure and be skipped. */
    const blocked = async (reason: string): Promise<string> => {
      const plain = reason.startsWith(tag) ? reason.slice(tag.length).trim() : reason;
      const line = `${RESTORE_BLOCKED}${tag}回复失败：${plain}`;
      emitRun({ type: "blocked", reason: line, station: next });
      await addFallback(line, "heal", next);
      return line;
    };
    // Field recovery first: Phoenix Down / revival magic, healing magic/items, a tent on a
    // save circle, and ailment cures. Only what is still wrong after this decides where to go.
    let fieldHealText = "";
    try {
      const healed = await ports.heal(plan.fallback.healBelowPct);
      fieldHealText = healed.text;
      if (healed.text.trim() !== "") log(`${tag} 野外回复:${healed.text}`);
    } catch (error) {
      log(`${tag} 野外回复出错:${errorText(error)}`);
    }
    const afterField = await ports.observe().catch(() => null);
    emitRun({
      type: "heal",
      station: next,
      beforeHp: lowestHpPct(observation),
      afterHp: lowestHpPct(afterField),
      used: fieldHealText,
      note: tag,
    });
    const fieldPct = lowestHpPct(afterField);
    const fieldDead = deadCount(afterField);
    const fieldStatus = statusCount(afterField);
    if (
      fieldPct !== null &&
      fieldPct >= plan.fallback.healBelowPct &&
      fieldDead === 0 &&
      fieldStatus === 0
    ) {
      log(`${tag} HP/状态不好，野外回复后继续`);
      return null;
    }
    const needsRevive = fieldDead > 0;
    let points: readonly PlanRestorePoint[] = [];
    try {
      points = (await ports.restorePoints?.()) ?? [];
    } catch (error) {
      log(`${tag} 读回复点出错:${errorText(error)}`);
    }
    const here = await ports.position();
    if (here === null) {
      return await blocked(`${tag} HP/倒下情况需要回复，但读不到当前位置，没法回旅店`);
    }
    visitedMaps.add(here.map);
    // Only places this chapter already passed or plans to pass: never a detour to a map that
    // merely happens to sit next to the current one (11-12, North Mountain's 休憩所).
    let candidates = points.filter(
      (point) =>
        (!needsRevive || canRevive(point)) &&
        (plannedMaps.has(point.map) || visitedMaps.has(point.map)),
    );
    if (candidates.length === 0) {
      candidates = points.filter(
        (point) => (!needsRevive || canRevive(point)) && point.map === here.map,
      );
    }
    if (candidates.length === 0) {
      return await blocked(
        needsRevive
          ? `${tag} 有人倒下(${fieldDead} 人)，本章路线上的旅店都不能复活，野外也没有复活手段`
          : `${tag} HP ${Math.round(fieldPct ?? pct)}% 低，本章路线上的旅店/回复点都去不了`,
      );
    }
    // "Nearest" is the route estimate, not the order of the map table or straight-line distance.
    interface Ranked {
      readonly point: PlanRestorePoint;
      readonly route: Awaited<ReturnType<ExecutePorts["planRoute"]>>;
      readonly minutes: number;
      readonly stand: Cell;
    }
    const ranked: Ranked[] = [];
    for (const point of candidates) {
      // Task 156: a restore point is often an object (a pot, a spring marker) that cannot be
      // stepped on. Plan to its standable side and press it from there; 10-29 live, the Wind
      // Shrine 1F pot at 202 was rejected because the route targeted the pot's own cell.
      let object = false;
      try {
        const at = ports.pointAt === undefined ? null : await ports.pointAt(point.map, point.cell);
        object = at !== null;
      } catch (error) {
        log(`${tag} 判断「${point.name}」是不是物件出错:${errorText(error)}`);
      }
      const stands: Cell[] = object
        ? RESTORE_SIDES.map((side) => [point.cell[0] + side.dx, point.cell[1] + side.dy] as Cell)
        : [point.cell];
      if (!object) {
        for (const side of RESTORE_SIDES) {
          stands.push([point.cell[0] + side.dx, point.cell[1] + side.dy]);
        }
      }
      let best: Ranked | null = null;
      for (const stand of stands) {
        const waypoint: Waypoint = {
          id: `chapter-restore-${point.map}-${stand[0]}-${stand[1]}`,
          kind: "inn",
          map: point.map,
          cell: stand,
          label: point.name,
          reach: "cell",
        };
        try {
          const route = await ports.planRoute(here, [waypoint], null);
          if (!route.legs.some((leg) => leg.waypoint === waypoint.id)) continue;
          if (best === null || route.total.minutes < best.minutes) {
            best = { point, route, minutes: route.total.minutes, stand };
          }
          if (!object && sameCell(stand, point.cell)) break;
        } catch (error) {
          log(`${tag} 估算去「${point.name}」的路程出错:${errorText(error)}`);
        }
      }
      if (best === null) continue;
      if (!sameCell(best.stand, point.cell)) {
        log(
          `${tag}「${point.name}」${point.map}:${point.cell[0]},${point.cell[1]} 是物件，` +
            `目标改站旁边 ${point.map}:${best.stand[0]},${best.stand[1]}`,
        );
      }
      ranked.push(best);
    }
    ranked.sort((left, right) => left.minutes - right.minutes);
    if (ranked.length === 0) {
      return await blocked(`${tag} 本章路线上的旅店/回复点都走不到`);
    }
    for (const entry of ranked) {
      const { point, stand } = entry;
      const walked = await executeRoute(entry.route, ports.routePorts(), {
        signal,
        timeBudgetMs: RESTORE_WALK_BUDGET_MS,
        maxWaypointFailures: 2,
        waypoints: [
          {
            id: `chapter-restore-${point.map}-${stand[0]}-${stand[1]}`,
            kind: "inn",
            map: point.map,
            cell: stand,
            label: point.name,
            reach: "cell",
          },
        ],
      });
      if (walked.reason !== "completed") {
        log(`${tag} 去「${point.name}」没走到:${walked.message}`);
        continue;
      }
      const atInn = await ports.position();
      if (atInn === null) continue;
      // An inn is slept in (revives the fallen); a rest spot is interacted with. `heal` stays
      // the fallback for older ports that do not implement `restAt`.
      let rested: PlanActionResult | null = null;
      let pointHealText = "";
      try {
        rested = ports.restAt !== undefined ? await ports.restAt(point) : null;
        if (rested !== null) pointHealText = rested.text;
        if (rested !== null && rested.text.trim() !== "") log(`${tag} 回复:${rested.text}`);
      } catch (error) {
        log(`${tag} 在「${point.name}」回复出错:${errorText(error)}`);
      }
      if (rested === null) {
        try {
          const healed = await ports.heal(needsRevive ? 100 : plan.fallback.healBelowPct);
          pointHealText = healed.text;
          log(`${tag} 野外回复:${healed.text}`);
        } catch (error) {
          log(`${tag} 在「${point.name}」回复出错:${errorText(error)}`);
        }
      }
      const after = await ports.observe().catch(() => null);
      emitRun({
        type: "heal",
        station: next,
        beforeHp: lowestHpPct(afterField),
        afterHp: lowestHpPct(after),
        used: pointHealText,
        note: `${tag}「${point.name}」`,
      });
      const afterPct = lowestHpPct(after);
      const afterDead = deadCount(after);
      if (afterDead > 0) {
        return await blocked(`${tag} 在「${point.name}」回复后仍有 ${afterDead} 人倒下`);
      }
      if (afterPct !== null && afterPct < plan.fallback.healBelowPct) {
        return await blocked(`${tag} 在「${point.name}」回复后 HP 仍只有 ${Math.round(afterPct)}%`);
      }
      const back: Waypoint = {
        id: "chapter-restore-back",
        kind: "move",
        map: here.map,
        cell: here.cell,
        label: "回到停下的地方",
        reach: "cell",
      };
      const backRoute = await ports.planRoute(atInn, [back], null);
      if (!backRoute.legs.some((leg) => leg.waypoint === back.id)) {
        return await blocked(`${tag} 在「${point.name}」回复后回不到 ${cellText(here.cell)}`);
      }
      const returned = await executeRoute(backRoute, ports.routePorts(), {
        signal,
        timeBudgetMs: RESTORE_WALK_BUDGET_MS,
        maxWaypointFailures: 2,
        waypoints: [back],
      });
      if (returned.reason !== "completed") {
        return await blocked(`${tag} 回复后没回到 ${cellText(here.cell)}:${returned.message}`);
      }
      const target = sameCell(stand, point.cell)
        ? `${point.map}:${point.cell[0]},${point.cell[1]}`
        : `${point.map}:${point.cell[0]},${point.cell[1]}，站 ${point.map}:${stand[0]},${stand[1]}`;
      await addFallback(
        `${tag} HP ${Math.round(pct)}%${deadBefore > 0 ? `、倒下 ${deadBefore} 人` : ""}` +
          `，走回「${point.name}」(${target})` +
          `${canRevive(point) ? "复活/回满" : "回复"}后回来`,
        "heal",
        next,
      );
      return null;
    }
    return await blocked(`${tag} 本章路线上的旅店/回复点都走不到`);
  };

  const checkpoint = async (
    observation: PlanObservation | null,
    next: number,
  ): Promise<string | null> => await goRestore(observation, next);

  /**
   * Task 152 follow-up: the chapter must not return with a battle still running, including
   * when growth or the last fallback failed. Fights are left to the ordinary plan tables (or
   * the game's default table), so no model call is made; a cutscene is paged.
   */
  const stabilizeChapter = async (): Promise<string | null> => {
    if (ports.scene === undefined) return null;
    const limit = Date.now() + 5 * 60_000;
    for (let guard = 0; guard < 12; guard += 1) {
      if (Date.now() >= limit) return "章末场面 5 分钟内没有稳定";
      let scene;
      try {
        scene = await ports.scene();
      } catch (error) {
        log(`章末读不到场面:${errorText(error)}`);
        return null;
      }
      if (scene.battle) {
        log(`章末还在战斗(${scene.enemies.join("、") || "敌人读不到"})，先打完再返回`);
        const fightStarted = Date.now();
        const result =
          ports.fightNormal !== undefined
            ? await ports.fightNormal([])
            : await ports.fightBoss({
                name: "章末战斗",
                map: null,
                healFirst: false,
                saveFirst: false,
                tables: [],
              } satisfies PlanBoss);
        emitRun({
          type: "battle",
          kind: "normal",
          enemies: scene.enemies,
          won: result.won,
          ms: Math.max(0, Date.now() - fightStarted),
          note: result.summary || result.text,
        });
        if (!result.won) {
          const recovered = await ports.recoverGameover();
          if (!recovered.ok) {
            return `章末战斗没打完:${result.summary}；${recovered.text}`;
          }
          log(`章末战斗失败，${recovered.text}`);
        }
        continue;
      }
      if (
        scene.dialog ||
        scene.state === "Event" ||
        scene.state === "Dialog" ||
        scene.state === "FieldHelp"
      ) {
        const advanced = await ports.story();
        if (advanced.decision !== undefined && advanced.decision.trim() !== "") {
          return `章末还有计划没回答的选项:${advanced.decision}`;
        }
        continue;
      }
      return null;
    }
    return "章末场面一直没有稳定";
  };

  const runSegment = async (
    segment: SegmentPlan,
    resume: ChapterStationResume | undefined,
  ): Promise<{
    report: SegmentReport;
    aborted: boolean;
    failure?: {
      readonly kind: PlanExceptionKind;
      readonly station: number | null;
      readonly detail: string;
    };
  }> => {
    // Seed the per-run skip record from progress written by an earlier run, then keep it up
    // to date from the executor's own `markProgress` calls. A retry prefix later marks every
    // earlier station done; the wrapper turns a recorded skip back into `skipped` with its reason.
    const skippedNotes = new Map<number, string>();
    for (const station of segments[segmentIndex]?.stations ?? []) {
      if (station.status === "skipped") skippedNotes.set(station.index, station.note);
    }
    activeSkipped = skippedNotes;
    // The section executor auto-skips `optional` stations before the chapter can tell a
    // whole-map failure from a cell that is merely hard to reach. Let every failure surface
    // here; the chapter still applies `station.optional` / chest / grind to skip a cell.
    // Task 155: after a chapter plan is submitted the model is gone. A `replan` turn-back
    // must therefore become a field heal; the same `when` is handled once per segment, and
    // when the condition survives (an item is still short) execution simply walks on.
    const seenTurnBack = new Set<string>();
    const turnBack: PlanTurnBack[] = [];
    for (const condition of segment.turnBack) {
      if (seenTurnBack.has(condition.when)) continue;
      seenTurnBack.add(condition.when);
      if (condition.then === "replan") {
        log(`规则里的 replan 在执行期间不交回模型，按回复后继续处理(${condition.when})`);
        turnBack.push({ ...condition, then: "heal-and-continue" });
      } else {
        turnBack.push(condition);
      }
    }
    const runnable: SegmentPlan = {
      ...segment,
      stations: segment.stations.map((station) => ({
        ...station,
        optional: false,
      })),
      turnBack,
    };
    const forced =
      restartFrom !== null && restartFrom.segment === segmentIndex
        ? { startAt: restartFrom.station, skip: [] as number[], done: {} }
        : null;
    if (forced !== null) restartFrom = null;
    const effectiveResume = forced ?? resume;
    let resumeFrom = effectiveResume?.startAt;
    const skipped = new Set<number>(effectiveResume?.skip ?? []);
    let merged: SegmentReport | null = null;
    let retries = 0;
    let bossTries = 0;
    let unreachableStreak: {
      readonly map: number;
      readonly station: number;
      count: number;
    } | null = null;
    for (;;) {
      if (checkAbort()) {
        if (merged !== null) return { report: merged, aborted: true };
        return {
          report: abortedReport(segment),
          aborted: true,
        };
      }
      const segmentOptions: ExecutePlanOptions = {
        signal,
        log,
        manageLayers: false,
        ...(resumeFrom === undefined ? {} : { startAt: resumeFrom }),
        ...(skipped.size === 0 ? {} : { skipStations: [...skipped] }),
        ...(wonBosses.size === 0 ? {} : { alreadyWonBosses: [...wonBosses] }),
        ...(options.segmentBudgetMs === undefined ? {} : { timeBudgetMs: options.segmentBudgetMs }),
        ...(options.stationBudgetMs === undefined
          ? {}
          : { stationBudgetMs: options.stationBudgetMs }),
        ...(options.healFullPercent === undefined
          ? {}
          : { healFullPercent: options.healFullPercent }),
        ...(options.storyExploreBudgetMs === undefined
          ? {}
          : { storyExploreBudgetMs: options.storyExploreBudgetMs }),
        bossTriggers: (boss, map) => factBossTriggers(options.facts, boss, map),
        stationProgress: (stationIndex) => {
          const state = segments[segmentIndex]?.stations[stationIndex];
          return state === undefined
            ? undefined
            : { status: state.status, note: state.note };
        },
        checkpoint,
        onProgress: updateStation,
        ...(options.runLog === undefined
          ? {}
          : {
              runLog: options.runLog,
              runLifecycle: false,
              chapter: plan.chapter,
              segmentIndex,
            }),
      };
      // `markProgress` is the one call a retry prefix uses to claim earlier stations done.
      // Wrap it for this attempt so a station already skipped keeps `skipped` + reason.
      const originalMark = ports.markProgress.bind(ports);
      ports.markProgress = async (
        index: number,
        stationStatus: PlanProgressStatus,
        note: string,
      ): Promise<void> => {
        if (stationStatus === "skipped") {
          skippedNotes.set(index, note);
          await originalMark(index, stationStatus, note);
          return;
        }
        if (stationStatus === "done" && skippedNotes.has(index)) {
          const reason = skippedNotes.get(index) ?? "按兜底跳过";
          await originalMark(index, "skipped", reason);
          return;
        }
        await originalMark(index, stationStatus, note);
      };
      let report: SegmentReport;
      try {
        report = await executeSegmentPlan(runnable, ports, segmentOptions);
      } finally {
        ports.markProgress = originalMark;
      }
      for (const name of report.done.bossesWon) wonBosses.add(name);
      merged = resumeFrom === undefined || merged === null ? report : mergeReports(merged, report);
      if (report.status !== "exception") {
        return { report: merged, aborted: report.status === "aborted" };
      }
      const failure = report.exception;
      if (failure === undefined) return { report: merged, aborted: false };
      // Task 156 follow-up (10:44 live): a failed pre-station recovery must not become the
      // station's failure. Retrying or skipping its chest would send a half-dead party on.
      if (
        failure.detail.startsWith(`${RESTORE_BLOCKED}第`) &&
        failure.detail.includes("站前回复失败")
      ) {
        exceptionDetail = failure.detail;
        // The segment executor had to fail at the station before its checkpoint. Undo that
        // station status and the report's station index: the checkpoint, not the station failed.
        if (failure.station !== null) {
          const station = segments[segmentIndex]?.stations[failure.station];
          if (station !== undefined) {
            station.status = "pending";
            station.note = "站前回复失败，整章等待修复";
            await writeProgress();
          }
        }
        const blockedReport: SegmentReport =
          merged.exception === undefined
            ? merged
            : {
                ...merged,
                exception: {
                  ...merged.exception,
                  station: null,
                  detail: exceptionDetail,
                },
              };
        return {
          report: blockedReport,
          aborted: false,
          failure: { kind: "stuck", station: null, detail: exceptionDetail },
        };
      }
      const failed = failure.station;
      const failedStation = failed === null ? undefined : segment.stations[failed];
      if (failure.kind === "unreachable" && failedStation !== undefined) {
        const map = parseTarget(failedStation.to)?.map ?? null;
        if (map !== null) {
          if (
            unreachableStreak !== null &&
            unreachableStreak.map === map &&
            unreachableStreak.station === failed
          ) {
            // The same station retried with a fresh route is not a second station.
          } else if (unreachableStreak !== null && unreachableStreak.map === map) {
            unreachableStreak = {
              map,
              station: failed,
              count: unreachableStreak.count + 1,
            };
          } else {
            unreachableStreak = { map, station: failed, count: 1 };
          }
          if (unreachableStreak.count >= 2 && lastWeakStory !== null) {
            const weak = lastWeakStory as {
              readonly segment: number;
              readonly station: number;
              readonly map: number;
            };
            const key = `${weak.segment}:${weak.station}`;
            if (!rewoundWeak.has(key)) {
              rewoundWeak.add(key);
              restartFrom = { segment: weak.segment, station: weak.station };
              const detail =
                `回头补剧情：连续两站走不到地图 ${map}，` +
                `回到第 ${weak.segment + 1} 节第 ${weak.station + 1} 站重新找触发点`;
              await addFallback(detail, "rewind-story");
              return {
                report: merged,
                aborted: false,
                failure: { kind: "stuck", station: null, detail },
              };
            }
            const detail =
              `等待修复：连续两站走不到地图 ${map}，` +
              `回到第 ${weak.segment + 1} 节第 ${weak.station + 1} 站重找后仍不行，` +
              "前面的剧情可能没走完";
            await addFallback(detail, "blocked");
            return {
              report: merged,
              aborted: false,
              failure: { kind: "unreachable", station: null, detail },
            };
          }
        }
      } else {
        unreachableStreak = null;
      }
      // A boss that loses lets the game-over recovery run first, so the segment reports
      // `gameover`, not `boss-lost`; either way the boss station gets the boss fallback.
      const bossFailure =
        failed !== null &&
        (failure.kind === "boss-lost" ||
          (failedStation?.do === "boss" && failure.kind === "gameover"));
      if (bossFailure) {
        const config = plan.fallback.bossLost;
        if (bossTries >= config.tries) {
          exceptionDetail = `首领兜底 ${bossTries} 次都没打赢:${failure.detail}`;
          return {
            report: merged,
            aborted: false,
            failure: {
              kind: failure.kind,
              station: failed,
              detail: exceptionDetail,
            },
          };
        }
        bossTries += 1;
        await addFallback(
          `第 ${segmentIndex + 1} 节第 ${failed + 1} 站首领没打赢，` +
            `按兜底刷 ${config.levels} 级再打（第 ${bossTries}/${config.tries} 次）`,
          "boss-retry",
          failed,
        );
        await grindForBoss(report, segment);
        try {
          const beforeHeal = lowestHpPct(await ports.observe().catch(() => null));
          const healed = await ports.heal(options.healFullPercent ?? 95);
          const afterHeal = lowestHpPct(await ports.observe().catch(() => null));
          emitRun({
            type: "heal",
            station: failed,
            beforeHp: beforeHeal,
            afterHp: afterHeal,
            used: healed.text,
            note: `首领兜底回复:${segment.section}`,
          });
          log(`首领兜底回复:${healed.text}`);
        } catch (error) {
          log(`首领兜底回复出错:${errorText(error)}`);
          emitRun({
            type: "warn",
            reason: `首领兜底回复出错:${errorText(error)}`,
            station: failed,
          });
        }
        resumeFrom = failed;
        continue;
      }
      const planProblem = planProblemDetail(failure.kind, failure.detail);
      const routeFailure =
        (failure.kind === "unreachable" || failure.kind === "stuck") && planProblem === null;
      if (planProblem !== null) {
        log(`不重试：计划本身的问题(${planProblem})`);
      }
      // Reaching a whole map is not an optional side trip: a skipped chest on a map the party
      // never got to would hide a wrong order. Hand it back for the model to reorder instead.
      if (wholeMapUnreachable(failure.detail)) {
        const targetMap = parseTarget(failedStation?.to ?? "")?.map ?? "?";
        const detail = `整张图 ${String(targetMap)} 现在去不了，可能顺序要调整（${failure.detail}）`;
        exceptionDetail = detail;
        log(`章例外:${detail}`);
        return {
          report: merged,
          aborted: false,
          failure: { kind: "unreachable", station: failed, detail },
        };
      }
      if (failed !== null && routeFailure && retries < plan.fallback.retries) {
        retries += 1;
        await addFallback(
          `第 ${segmentIndex + 1} 节第 ${failed + 1} 站失败（${failure.kind}），` +
            `换新路线重试 ${retries}/${plan.fallback.retries}`,
          "retry",
          failed,
        );
        resumeFrom = failed;
        continue;
      }
      const station = failedStation;
      const optional =
        station !== undefined &&
        (station.optional === true || station.do === "open" || station.do === "grind");
      if (failed !== null && optional && plan.fallback.skipOptional) {
        await addFallback(
          `第 ${segmentIndex + 1} 节第 ${failed + 1} 站（${station.do}）` +
            `始终到不了，按兜底跳过:${failure.detail}`,
          "skip",
          failed,
        );
        skipped.add(failed);
        resumeFrom = failed;
        retries = 0;
        continue;
      }
      exceptionDetail = failure.detail;
      return {
        report: merged,
        aborted: false,
        failure: {
          kind: failure.kind,
          station: failed,
          detail: failure.detail,
        },
      };
    }
  };

  emitRun({
    type: "run.start",
    segment: startAt,
    section: plan.segments[startAt]?.section ?? null,
    note: plan.goal,
    count: plan.segments.length,
    modelCalls: 0,
  });
  if (resumeLine !== "") {
    const current = options.skipStations?.[startAt];
    emitRun({
      type: "resume",
      segment: startAt,
      section: plan.segments[startAt]?.section ?? null,
      from: current?.startAt ?? 0,
      skipped: [...(current?.skip ?? [])],
      note: resumeLine,
    });
  }
  if (ports.begin !== undefined) await ports.begin();
  try {
    await writeProgress();
    log(`章 ${plan.chapter}「${plan.goal}」开始:${plan.segments.length} 节`);
    if (resumeLine !== "") log(resumeLine);
    // Task 156: a segment whose first station cannot reach its whole map is deferred, not
    // fatal. Later segments run first (the story may enable the boat or open the road), then
    // the deferred ones are tried again in their original order.
    const queue: number[] = [];
    for (let index = startAt; index < plan.segments.length; index += 1) queue.push(index);
    const deferred: number[] = [];
    let pass = 0;
    for (;;) {
      while (queue.length > 0) {
        const index = queue.shift();
        if (index === undefined) break;
        segmentIndex = index;
        const segment = plan.segments[index];
        if (segment === undefined) continue;
        await writeProgress();
        if (checkAbort()) {
          status = "aborted";
          break;
        }
        if (pass === 0) {
          // Retry what earlier segments could not grind (11-11 live: the opening chocobo ride
          // blocked growth, then a resumed run never tried it again because of `<= startAt`).
          const retry = [...pendingGrowth];
          try {
            for (const entry of retry) {
              const outcome = await runGrowth(entry.target, entry.index);
              if (outcome.ok) {
                const at = pendingGrowth.indexOf(entry);
                if (at >= 0) pendingGrowth.splice(at, 1);
                log(`成长目标 ${entry.index + 1} 后面能刷了，已完成`);
                continue;
              }
              entry.reason = outcome.reason;
              await addFallback(
                `成长目标 ${entry.index + 1} 在「${entry.target.where}」再试还是不成：` +
                  `${outcome.reason}；继续往后挪`,
                "defer-growth",
              );
            }
            for (let growth = 0; growth < plan.growth.length; growth += 1) {
              const target = plan.growth[growth];
              if (target?.before !== index) continue;
              // A resumed run already grew before completed segments; a growth before the
              // resumed segment itself was never done, so only strict `<` may skip it.
              if (resumed && target.before < startAt) continue;
              const outcome = await runGrowth(target, growth);
              if (outcome.ok) continue;
              pendingGrowth.push({ target, index: growth, reason: outcome.reason });
              await addFallback(
                `成长目标 ${growth + 1} 在「${target.where}」${outcome.reason}；` +
                  `往后挪到下一段再试`,
                "defer-growth",
              );
            }
          } catch (error) {
            if (error instanceof ChapterStop) {
              if (checkAbort()) {
                status = "aborted";
              } else {
                status = "exception";
                exceptionDetail = error.message;
                exception = {
                  kind: error.kind,
                  segment: index,
                  station: null,
                  detail: error.message,
                };
                log(`章例外:${error.message}`);
              }
              break;
            }
            if (checkAbort() || isAbort(error)) {
              status = "aborted";
              break;
            }
            status = "exception";
            exceptionDetail = `执行器出错:${errorText(error)}`;
            exception = {
              kind: "other",
              segment: index,
              station: null,
              detail: exceptionDetail,
            };
            log(`章例外:${exceptionDetail}`);
            break;
          }
        }
        // The section boundary is a checkpoint too: a previous section may have ended with the
        // party below the threshold, and the next section must not start like that.
        const beforeSegment = await ports.observe().catch(() => null);
        const healProblem = await checkpoint(beforeSegment, 0);
        if (healProblem !== null) {
          status = "exception";
          exceptionDetail = healProblem;
          exception = {
            kind: "stuck",
            segment: index,
            station: null,
            detail: healProblem,
          };
          log(`章例外:${healProblem}`);
          break;
        }
        const segmentStarted = Date.now();
        emitRun({
          type: "segment.start",
          segment: index,
          section: segment.section,
          station: null,
        });
        const result = await runSegment(segment, options.skipStations?.[index]);
        const failureAtSegment = result.failure ?? result.report.exception;
        emitRun({
          type: "segment.end",
          segment: index,
          section: segment.section,
          station: failureAtSegment?.station ?? null,
          status: result.report.status,
          ms: Math.max(0, Date.now() - segmentStarted),
          note: failureAtSegment?.detail,
          reason: failureAtSegment?.detail,
        });
        if (restartFrom !== null && result.report.status === "exception") {
          const reset = restartFrom as { readonly segment: number; readonly station: number };
          for (let at = reset.segment; at < segments.length; at += 1) {
            for (const state of segments[at]?.stations ?? []) {
              if (at === reset.segment && state.index < reset.station) continue;
              state.status = "pending";
              state.note = "";
              state.matchedOld = null;
              delete state.matchedStatus;
              delete state.matchedNote;
            }
            reportBySegment[at] = undefined;
          }
          activeSkipped = new Map();
          deferred.length = 0;
          queue.length = 0;
          for (let at = reset.segment; at < plan.segments.length; at += 1) queue.push(at);
          pass = 0;
          await writeProgress();
          log(
            `回头补剧情:从第 ${reset.segment + 1} 节第 ${reset.station + 1} 站重跑`,
          );
          continue;
        }
        const state = segments[index];
        const doneCount =
          state === undefined
            ? result.report.done.stations
            : state.stations.filter((station) => station.status === "done").length;
        const skippedCount =
          state === undefined
            ? 0
            : state.stations.filter((station) => station.status === "skipped").length;
        const failure = result.failure ?? result.report.exception;
        // Only a whole-map failure at the segment's first station is an ordering problem.
        // A cell failure or a later station is not helped by running another section first.
        if (
          pass === 0 &&
          queue.length > 0 &&
          failure?.station === 0 &&
          wholeMapUnreachable(failure.detail)
        ) {
          deferred.push(index);
          const line =
            `第 ${index + 1} 节「${segment.section}」第一站整张图现在去不了，` +
            `先跑后面的段，最后再回头（${failure.detail}）`;
          await addFallback(line, "defer-segment", 0);
          log(line);
          continue;
        }
        // `done` and `skipped` are different outcomes in progress; the report's done count must
        // not include a station that was skipped (and possibly marked done by a retry prefix).
        const adjusted: SegmentReport = {
          ...result.report,
          done: { ...result.report.done, stations: doneCount },
        };
        reportBySegment[index] = adjusted;
        log(
          `第 ${index + 1} 节「${segment.section}」结束:` +
            `${adjusted.status}；完成 ${doneCount}/${segment.stations.length} 站，跳过 ${skippedCount} 站`,
        );
        if (result.aborted || checkAbort()) {
          status = "aborted";
          break;
        }
        if (result.report.status === "exception") {
          status = "exception";
          if (exceptionDetail === "") exceptionDetail = result.report.exception?.detail ?? "";
          exception = {
            kind: failure?.kind ?? "other",
            segment: index,
            station: failure?.station ?? null,
            detail: exceptionDetail,
          };
          break;
        }
      }
      if (status !== "running" || checkAbort()) break;
      if (pass === 0 && deferred.length > 0) {
        pass = 1;
        const names = deferred.map((index) => `第 ${index + 1} 节`).join("、");
        queue.push(...deferred);
        deferred.length = 0;
        const line = `后面能跑的段跑完了，回头再试 ${names}（之前整张图去不了）`;
        await addFallback(line, "defer-segment");
        log(line);
        continue;
      }
      break;
    }
    if (status === "running") {
      for (const entry of pendingGrowth) {
        const line = `成长目标 ${entry.index + 1} 到章末还没刷成，跳过：${entry.reason}`;
        await addFallback(line, "skip-growth");
        emitRun({ type: "warn", reason: line });
        log(line);
      }
      pendingGrowth.length = 0;
    }
    reports = reportBySegment.filter((entry): entry is SegmentReport => entry !== undefined);
    if (status !== "aborted") {
      const sceneProblem = await stabilizeChapter();
      if (sceneProblem !== null) {
        status = "exception";
        exceptionDetail =
          exceptionDetail === "" ? sceneProblem : `${exceptionDetail}；${sceneProblem}`;
        exception = {
          kind: "stuck",
          segment: segmentIndex,
          station: null,
          detail: exceptionDetail,
        };
        log(`章末场面例外:${sceneProblem}`);
      }
    }
    if (status === "running") status = "done";
  } catch (error) {
    if (checkAbort() || isAbort(error)) {
      status = "aborted";
    } else {
      status = "exception";
      exceptionDetail = `执行器出错:${errorText(error)}`;
      exception = {
        kind: "other",
        segment: segmentIndex,
        station: null,
        detail: exceptionDetail,
      };
      log(`章例外:${exceptionDetail}`);
    }
  } finally {
    if (ports.end !== undefined) {
      try {
        await ports.end();
      } catch (error) {
        log(`恢复模型层时出错:${errorText(error)}`);
      }
    }
    finishedAt = new Date().toISOString();
    await writeProgress();
  }

  if (status === "exception" && exceptionDetail !== "") {
    log(`章 ${plan.chapter} 例外:${exceptionDetail}`);
    if (!fallbacks.some((line) => line.includes(exceptionDetail))) {
      fallbacks.push(exceptionDetail);
      emitRun({
        type: "fallback",
        kind: "stop",
        reason: exceptionDetail,
        segment: exception?.segment ?? segmentIndex,
        station: exception?.station ?? null,
      });
      await writeProgress();
    }
  }
  let reportException: ChapterReport["exception"];
  if (status === "exception") {
    const base = exception?.detail ?? exceptionDetail;
    // The report's `fallbacks` already lists each attempt; the exception detail repeats the
    // tried ones as one line so the model sees them without opening the JSON.
    const tried = fallbacks.filter((line) => line !== base).join("；");
    const detail = tried === "" ? base : `${base}；兜底记录:${tried}`;
    reportException = {
      kind: exception?.kind ?? "other",
      segment: exception?.segment ?? segmentIndex,
      station: exception?.station ?? null,
      detail,
    };
  }
  const report: ChapterReport = {
    chapter: plan.chapter,
    status,
    segments: reports,
    fallbacks: [...fallbacks],
    ...(reportException === undefined ? {} : { exception: reportException }),
    minutes: Math.round(((Date.now() - started) / 60_000) * 10) / 10,
    modelCalls: reports.reduce((total, entry) => total + entry.modelCalls, 0),
  };
  if (options.reportPath !== undefined) {
    try {
      await mkdir(dirname(options.reportPath), { recursive: true });
      const saved = resumeLine === "" ? report : { ...report, resume: resumeLine };
      await writeFile(options.reportPath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
    } catch (error) {
      log(`章节报告没写成:${errorText(error)}`);
      emitRun({ type: "warn", reason: `章节报告没写成:${errorText(error)}` });
    }
  }
  if (status === "exception" && reportException !== undefined) {
    emitRun({
      type: "blocked",
      segment: reportException.segment,
      station: reportException.station,
      reason: reportException.detail,
    });
  }
  emitRun({
    type: "run.end",
    segment: exception?.segment ?? segmentIndex,
    station: exception?.station ?? null,
    status,
    ms: Math.max(0, Date.now() - started),
    fallbacks: report.fallbacks.length,
    modelCalls: report.modelCalls,
    battles: reports.reduce((total, entry) => total + entry.done.battles, 0),
    note: reportException?.detail ?? (status === "aborted" ? "执行被打断" : undefined),
  });
  log(
    `章 ${plan.chapter} 结束:${report.status}；${plan.segments.length} 节，` +
      `兜底 ${report.fallbacks.length} 次，用时 ${report.minutes} 分`,
  );
  return report;
}

function abortedReport(segment: SegmentPlan): SegmentReport {
  return {
    section: segment.section,
    status: "aborted",
    done: {
      stations: 0,
      chestsOpened: 0,
      battles: 0,
      bestiaryNew: [],
      blueMagicNew: [],
      bossesWon: [],
    },
    remaining: segment.stations.map((_station, index) => index),
    party: "",
    minutes: 0,
    modelCalls: 0,
  };
}

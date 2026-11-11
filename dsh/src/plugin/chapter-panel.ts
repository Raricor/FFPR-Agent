/**
 * The sidebar's chapter panel (task 153, 11-11): the whole chapter rule file the model wrote and
 * how far code has executed it. It reads the same three files the chapter tools maintain
 * (`chapter-plan`, `chapter-progress`, `chapter-report`), plus the atlas for map names and the
 * guide for the chapter title.
 *
 * This module is read-only. Missing or damaged files become Chinese view text, never an
 * exception; the route still answers so the rest of the sidebar keeps working. The station table
 * reuses the segment panel's row shape, so both panels render through the same client code.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { describeError, isMissingFile } from "../engine/errors.ts";
import { byKey, type Game } from "../engine/games.ts";
import { Guide } from "../engine/guide/kb.ts";
import { DEPS } from "../engine/paths.ts";
import { ChapterPlanStore, chapterPlanPath } from "../engine/plan/chapter-store.ts";
import type {
  ChapterFallback,
  ChapterPlan,
  ChapterProgress,
  ChapterSkipped,
} from "../engine/plan/chapter-types.ts";
import { chapterByNumber, chapterTitle } from "../engine/plan/chapters.ts";
import type { PlanExceptionKind, PlanStationAction } from "../engine/plan/types.ts";
import { isRecord, num, text } from "../engine/values.ts";
import type { PlanReportView, PlanStationRowView } from "./plan-panel.ts";
import { readCurrent, type CurrentSource } from "./current.ts";

export const CHAPTER_ROUTE = "/api/ffpr/chapter";

/** Where one game's chapter plan, progress, last report, atlas and guide live. */
export interface ChapterFiles {
  readonly plan: string;
  readonly progress: string;
  readonly report: string;
  readonly atlas: string;
  readonly guide: string;
}

export function defaultChapterFiles(game: string): ChapterFiles {
  return {
    plan: chapterPlanPath(game),
    progress: join(DEPS, "ds", `chapter-progress-${game}.json`),
    report: join(DEPS, "ds", `chapter-report-${game}.json`),
    atlas: join(DEPS, "ds", `atlas-${game}.json`),
    guide: join(DEPS, "knowledge", "ff5", "guide.json"),
  };
}

export type ChapterFilesOf = (game: string) => ChapterFiles;

export interface ChapterSegmentRowView {
  readonly number: number;
  readonly section: string;
  readonly stationCount: number;
  readonly doneCount: number;
  readonly stateText: string;
  readonly current: boolean;
}

export interface ChapterSkippedRowView {
  readonly kind: string;
  readonly name: string;
  readonly whereText: string;
  readonly why: string;
}

export interface ChapterView {
  readonly heading: string;
  readonly goalText: string;
  readonly revisionText: string;
  readonly statusText: string;
  readonly startedText: string;
  readonly updatedText: string;
  readonly segmentHeaders: readonly string[];
  readonly segments: readonly ChapterSegmentRowView[];
  readonly segmentEmptyText: string;
  readonly stationSectionText: string;
  readonly stationHeaders: readonly string[];
  readonly stations: readonly PlanStationRowView[];
  readonly stationEmptyText: string;
  readonly growth: readonly string[];
  readonly growthEmptyText: string;
  readonly fallback: readonly string[];
  readonly fallbackRecords: readonly string[];
  readonly fallbackEmptyText: string;
  readonly skipped: readonly ChapterSkippedRowView[];
  readonly skippedHeaders: readonly string[];
  readonly skippedEmptyText: string;
  readonly report: PlanReportView | null;
  readonly reportEmptyText: string;
  readonly warnings: readonly string[];
}

export interface ChapterPanelView {
  readonly title: "章计划";
  readonly status: string;
  readonly message: string | null;
  readonly chapter: ChapterView | null;
  /** Which sidebar card the panel's Config selects; the client uses it to pick one card. */
  readonly mode: "chapter" | "plan";
}

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

const EXCEPTION_KINDS: readonly PlanExceptionKind[] = [
  "unreachable",
  "boss-lost",
  "gameover",
  "story-choice",
  "stuck",
  "turn-back",
  "invalid",
  "other",
];

function exceptionKindOf(value: unknown): PlanExceptionKind {
  return typeof value === "string" && (EXCEPTION_KINDS as readonly string[]).includes(value)
    ? (value as PlanExceptionKind)
    : "other";
}

const SKIPPED_LABELS: Readonly<Record<ChapterSkipped["kind"], string>> = {
  bestiary: "图鉴",
  blueMagic: "青魔法",
  hidden: "隐藏道具",
  chest: "宝箱",
  shop: "商店",
  boss: "首领",
};

const STATION_STATUS: Readonly<
  Record<
    ChapterProgress["segments"][number]["stations"][number]["status"],
    { readonly symbol: string; readonly label: string }
  >
> = {
  pending: { symbol: "·", label: "待做" },
  current: { symbol: "▶", label: "正在做" },
  done: { symbol: "✓", label: "做完" },
  failed: { symbol: "✗", label: "失败" },
  skipped: { symbol: "↷", label: "跳过" },
};

type ProgressStatus = ChapterProgress["segments"][number]["stations"][number]["status"];

interface ProgressSummary {
  readonly chapter: number;
  readonly goal: string;
  readonly revision: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: ChapterProgress["status"];
  readonly blockedText: string;
  readonly segment: number;
  readonly segments: readonly {
    readonly section: string;
    readonly stations: ReadonlyMap<
      number,
      { readonly status: ProgressStatus; readonly note: string }
    >;
  }[];
  readonly stationCount: number;
  readonly fallbacks: readonly string[];
  readonly previousException: ChapterProgress["previousException"];
}

interface ReportSummary {
  readonly chapter: number;
  readonly status: "done" | "exception" | "blocked" | "aborted";
  readonly blockedText: string;
  readonly segmentCount: number;
  readonly fallbackCount: number;
  readonly exception:
    | {
        readonly kind: string;
        readonly segment: number;
        readonly station: number | null;
        readonly detail: string;
      }
    | undefined;
  readonly minutes: number;
  readonly modelCalls: number;
}

type JsonRead =
  | { readonly state: "missing" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ok"; readonly value: unknown };

async function readJson(path: string, label: string, signal?: AbortSignal): Promise<JsonRead> {
  let body: string;
  try {
    body = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingFile(error)) return { state: "missing" };
    return {
      state: "error",
      message: `读不了${label}:${describeError(error)}`,
    };
  }
  try {
    return { state: "ok", value: JSON.parse(body) };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      state: "error",
      message: `读不懂${label}:${describeError(error)}`,
    };
  }
}

function countOf(value: unknown): number {
  const number = num(value);
  return number === undefined ? 0 : Math.max(0, Math.trunc(number));
}

function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function clockText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function progressStatusOf(value: unknown): ProgressStatus {
  return value === "current" || value === "done" || value === "failed" || value === "skipped"
    ? value
    : "pending";
}

/** The chapter executor's live progress (task 152); a damaged shape becomes a Chinese error. */
function readProgress(value: unknown): ProgressSummary {
  if (!isRecord(value)) throw new Error("章进度不是 JSON 对象");
  const chapter = num(value.chapter);
  if (chapter === undefined || !Number.isInteger(chapter) || chapter <= 0) {
    throw new Error("章进度里没有章号");
  }
  const goal = text(value.goal)?.trim() ?? "";
  if (goal === "") throw new Error("章进度里没有目标");
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
  const segments: ProgressSummary["segments"][number][] = [];
  let stationCount = 0;
  for (const raw of value.segments) {
    if (!isRecord(raw)) throw new Error("章进度里的段不是对象");
    const section = text(raw.section)?.trim() ?? "";
    if (section === "") throw new Error("章进度里有段没有节名");
    if (!Array.isArray(raw.stations)) throw new Error(`章进度里「${section}」没有站点状态`);
    const stations = new Map<number, { readonly status: ProgressStatus; readonly note: string }>();
    for (const station of raw.stations) {
      if (!isRecord(station)) continue;
      const index = num(station.index);
      if (index === undefined) continue;
      stations.set(Math.trunc(index), {
        status: progressStatusOf(station.status),
        note: text(station.note) ?? "",
      });
    }
    stationCount += raw.stations.length;
    segments.push({ section, stations });
  }
  const previous = isRecord(value.previousException) ? value.previousException : null;
  return {
    chapter: Math.trunc(chapter),
    goal,
    revision: Math.max(1, Math.trunc(num(value.revision) ?? 1)),
    startedAt: text(value.startedAt) ?? "",
    updatedAt: text(value.updatedAt) ?? "",
    status,
    blockedText: text(value.blockedText) ?? "",
    segment: Math.max(0, Math.trunc(num(value.segment) ?? 0)),
    segments,
    stationCount,
    fallbacks: stringListOf(value.fallbacks),
    previousException:
      previous === null
        ? null
        : {
            kind: exceptionKindOf(previous.kind),
            detail: text(previous.detail) ?? "",
          },
  };
}

/** The chapter report (task 152); a readable JSON of the wrong shape is an error. */
function readReport(value: unknown): ReportSummary {
  if (!isRecord(value)) throw new Error("章报告不是 JSON 对象");
  const chapter = num(value.chapter);
  if (chapter === undefined || !Number.isInteger(chapter) || chapter <= 0) {
    throw new Error("章报告里没有章号");
  }
  const status = value.status;
  if (status !== "done" && status !== "exception" && status !== "blocked" && status !== "aborted") {
    throw new Error("章报告里的状态看不懂");
  }
  const rawException = value.exception;
  let exception: ReportSummary["exception"];
  if (rawException !== undefined && rawException !== null) {
    if (!isRecord(rawException)) throw new Error("章报告里的例外不是对象");
    const segment = num(rawException.segment);
    const station = num(rawException.station);
    exception = {
      kind: text(rawException.kind) ?? "other",
      segment: Math.max(0, Math.trunc(segment ?? 0)),
      station: station === undefined ? null : Math.trunc(station),
      detail: text(rawException.detail) ?? "",
    };
  }
  return {
    chapter: Math.trunc(chapter),
    status,
    blockedText: text(value.blockedText) ?? "",
    segmentCount: Array.isArray(value.segments) ? value.segments.length : 0,
    fallbackCount: stringListOf(value.fallbacks).length,
    exception,
    minutes: countOf(value.minutes),
    modelCalls: countOf(value.modelCalls),
  };
}

function readAtlasNames(value: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!isRecord(value)) return names;
  for (const [mapId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name)?.trim() ?? "";
    if (name !== "") names.set(mapId, name);
  }
  return names;
}

function mapTextOf(mapId: number | null, names: ReadonlyMap<string, string>): string {
  if (mapId === null) return "—";
  const name = names.get(String(mapId)) ?? "";
  return name === "" ? String(mapId) : `${mapId} ${name}`;
}

interface TargetSummary {
  readonly mapId: number | null;
  readonly cell: readonly [number, number] | null;
}

function targetOf(to: string): TargetSummary {
  const match = /^(?:地图\s*)?(\d+)(?:\s*:\s*(-?\d+)\s*,\s*(-?\d+))?$/u.exec(to.trim());
  if (match === null) return { mapId: null, cell: null };
  return {
    mapId: Number(match[1]),
    cell:
      match[2] === undefined || match[3] === undefined
        ? null
        : [Number(match[2]), Number(match[3])],
  };
}

function stationMapText(to: string, names: ReadonlyMap<string, string>): string {
  const target = targetOf(to);
  return target.mapId === null ? to : mapTextOf(target.mapId, names);
}

function stationCellText(to: string): string {
  const target = targetOf(to);
  return target.cell === null ? "—" : `(${target.cell[0]},${target.cell[1]})`;
}

function untilTextOf(value: unknown): string {
  if (!isRecord(value)) return "—";
  const parts: string[] = [];
  if (Array.isArray(value.bestiary)) {
    const bestiary = value.bestiary
      .filter(
        (item): item is string | number => typeof item === "string" || typeof item === "number",
      )
      .map((item) => String(item));
    if (bestiary.length > 0) parts.push(`图鉴：${bestiary.join("、")}`);
  }
  const blueMagic = stringListOf(value.blueMagic);
  if (blueMagic.length > 0) parts.push(`青魔法：${blueMagic.join("、")}`);
  const battles = num(value.battles);
  if (battles !== undefined) parts.push(`战斗 ${Math.max(0, Math.trunc(battles))} 场`);
  const minutes = num(value.minutes);
  if (minutes !== undefined) parts.push(`${Math.max(0, Math.trunc(minutes))} 分钟`);
  return parts.length === 0 ? "—" : parts.join("；");
}

function actionText(value: unknown): string {
  if (typeof value === "string" && Object.hasOwn(ACTION_LABELS, value)) {
    return ACTION_LABELS[value as PlanStationAction];
  }
  return typeof value === "string" && value !== "" ? value : "—";
}

function stateOfProgress(progress: ProgressSummary | null): string {
  if (progress === null) return "没在执行";
  if (progress.status === "running") return "执行中";
  if (progress.status === "done") return "完成";
  if (progress.status === "blocked") return progress.blockedText || "等待修复";
  if (progress.status === "exception") return "出例外";
  return "中止";
}

function progressMatches(plan: ChapterPlan, progress: ProgressSummary | null): boolean {
  if (progress === null) return false;
  if (progress.chapter !== plan.chapter || progress.goal !== plan.goal) return false;
  if (progress.segments.length !== plan.segments.length) return false;
  return plan.segments.every(
    (segment, index) => progress.segments[index]?.section === segment.section,
  );
}

function segmentRows(plan: ChapterPlan, progress: ProgressSummary | null): ChapterSegmentRowView[] {
  return plan.segments.map((segment, index) => {
    const seen = progress?.segments[index];
    const done =
      seen === undefined
        ? 0
        : [...seen.stations.values()].filter((station) => station.status === "done").length;
    let stateText = "未开始";
    let current = false;
    if (progress !== null && seen !== undefined) {
      if (index < progress.segment) stateText = "完成";
      else if (index === progress.segment) {
        if (done === segment.stations.length) stateText = "完成";
        else if (progress.status === "running") {
          stateText = "进行中";
          current = true;
        } else if (progress.status === "blocked") {
          stateText = "等待修复";
          current = true;
        } else if (progress.status === "exception") {
          stateText = "停在例外";
          current = true;
        } else if (progress.status === "done") stateText = "完成";
        else stateText = "中途停止";
      }
    }
    return {
      number: index + 1,
      section: segment.section,
      stationCount: segment.stations.length,
      doneCount: done,
      stateText,
      current,
    };
  });
}

function stationRows(
  plan: ChapterPlan,
  progress: ProgressSummary | null,
  names: ReadonlyMap<string, string>,
): { readonly section: string; readonly rows: PlanStationRowView[] } | null {
  if (progress === null) return null;
  const segment = plan.segments[progress.segment];
  const seen = progress.segments[progress.segment];
  if (segment === undefined || seen === undefined) return null;
  const rows = segment.stations.map((station, index) => {
    const state = seen.stations.get(index);
    const fixed = state === undefined ? null : STATION_STATUS[state.status];
    return {
      number: index + 1,
      mapText: stationMapText(station.to, names),
      cellText: stationCellText(station.to),
      action: actionText(station.do),
      why: station.why?.trim() || "—",
      untilText: untilTextOf(station.until),
      statusSymbol: fixed?.symbol ?? "·",
      statusText:
        fixed?.label ??
        (progress.status === "running"
          ? "待做"
          : progress.status === "blocked"
            ? "等待修复"
            : "未开始"),
      note: state?.note ?? "",
      current: state?.status === "current",
    };
  });
  return { section: segment.section, rows };
}

function growthLines(plan: ChapterPlan): string[] {
  return plan.growth.map((target) => {
    const wants = [
      target.level === undefined ? "" : `最低等级 Lv${target.level}`,
      target.gil === undefined ? "" : `金钱 ${target.gil}`,
    ].filter((line) => line !== "");
    return `第 ${target.before + 1} 段前:${wants.join("、") || "没有数值目标"};在 ${target.where} 刷,最多 ${target.maxMinutes} 分钟${target.why === "" ? "" : `(${target.why})`}`;
  });
}

function fallbackLines(fallback: ChapterFallback): string[] {
  return [
    `重试:每站失败后换路线重试 ${fallback.retries} 次`,
    `首领失败:再练 ${fallback.bossLost.levels} 级` +
      `${fallback.bossLost.where === null ? "(原地)" : `(在 ${fallback.bossLost.where})`},` +
      `重打 ${fallback.bossLost.tries} 次`,
    `可选站:${fallback.skipOptional ? "到不了就跳过并记录" : "不跳过"}`,
    `补血:最低 HP 低于 ${fallback.healBelowPct}% 时回旅店`,
  ];
}

function skippedRows(plan: ChapterPlan): ChapterSkippedRowView[] {
  return (plan.skipped ?? []).map((entry) => ({
    kind: SKIPPED_LABELS[entry.kind],
    name: entry.name,
    whereText: entry.where === undefined || entry.where.trim() === "" ? "—" : entry.where,
    why: entry.why,
  }));
}

function reportViewOf(report: ReportSummary): PlanReportView {
  const status =
    report.status === "done"
      ? "完成"
      : report.status === "blocked"
        ? "等待修复"
        : report.status === "exception"
          ? "出例外"
          : "中止";
  const lines = [
    `状态：${status}`,
    `跑了 ${report.segmentCount} 节，兜底 ${report.fallbackCount} 次`,
    `用时 ${report.minutes} 分钟，模型调用 ${report.modelCalls} 次`,
  ];
  let exceptionText: string | null = report.blockedText === "" ? null : report.blockedText;
  if (exceptionText === null && report.exception !== undefined) {
    const station =
      report.exception.station === null ? "" : ` 第 ${report.exception.station + 1} 站`;
    exceptionText =
      `例外（${report.exception.kind}）第 ${report.exception.segment + 1} 节${station}：` +
      report.exception.detail;
  }
  return { heading: "最近一份章报告", lines, exceptionText };
}

function chapterViewOf(
  plan: ChapterPlan,
  historyLength: number,
  progress: ProgressSummary | null,
  report: ReportSummary | null,
  names: ReadonlyMap<string, string>,
  title: string,
  warnings: readonly string[],
): ChapterView {
  const usable = progressMatches(plan, progress) ? progress : null;
  const stations = stationRows(plan, usable, names);
  const started = usable?.startedAt ?? "";
  const updated = usable?.updatedAt ?? "";
  const prefix = `第 ${plan.chapter} 章`;
  return {
    heading: title.startsWith(prefix) ? title : `${prefix} ${title}`,
    goalText: `目标：${plan.goal}`,
    revisionText: `第 ${Math.max(1, historyLength)} 份规则文件`,
    statusText: stateOfProgress(usable),
    startedText: started === "" ? "开始时间未知" : `开始 ${clockText(started) || "时间未知"}`,
    updatedText: updated === "" ? "更新时间未知" : `更新 ${clockText(updated) || "时间未知"}`,
    segmentHeaders: ["序号", "节", "站数", "完成", "状态"],
    segments: segmentRows(plan, usable),
    segmentEmptyText: "这份章计划没有段",
    stationSectionText:
      stations === null
        ? "还没开始执行，没有当前段"
        : `当前段：第 ${(usable?.segment ?? 0) + 1} 段「${stations.section}」`,
    stationHeaders: ["序号", "图", "坐标", "做什么", "为什么", "停止条件", "状态"],
    stations: stations?.rows ?? [],
    stationEmptyText: stations === null ? "还没开始执行" : "当前段没有站点",
    growth: growthLines(plan),
    growthEmptyText: "没有长线成长目标",
    fallback: fallbackLines(plan.fallback),
    fallbackRecords: usable?.fallbacks ?? [],
    fallbackEmptyText: "还没有兜底记录",
    skipped: skippedRows(plan),
    skippedHeaders: ["类别", "名字", "地点", "为什么"],
    skippedEmptyText: "没有写 skipped",
    report: report === null ? null : reportViewOf(report),
    reportEmptyText: "还没有章报告",
    warnings: [
      ...warnings,
      ...(progress !== null && usable === null ? ["章进度是上一份计划的"] : []),
    ],
  };
}

/**
 * Read one game's chapter plan, progress, report, atlas and guide. Missing files and damaged
 * JSON become view text; the only rejection is an aborted request.
 */
export async function readChapterPanel(
  files: ChapterFiles,
  signal?: AbortSignal,
  mode: "chapter" | "plan" = "chapter",
): Promise<ChapterPanelView> {
  const empty: ChapterPanelView = {
    title: "章计划",
    status: "还没有章计划",
    message: "还没有章计划",
    chapter: null,
    mode,
  };
  let store: ChapterPlanStore;
  try {
    store = await ChapterPlanStore.load("", files.plan, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return { ...empty, status: "章计划读不了", message: describeError(error) };
  }
  const plan = store.current;
  if (plan === null) {
    return store.problems.length === 0
      ? empty
      : {
          ...empty,
          status: "章计划读不了",
          message: store.problems.join("；"),
        };
  }

  const guideRead = Guide.load(files.guide, signal).then(
    (loaded) => loaded,
    () => {
      // A missing or damaged guide only loses the chapter title.
      signal?.throwIfAborted();
      return null;
    },
  );
  const [progressRead, reportRead, atlasRead, guide] = await Promise.all([
    readJson(files.progress, "章进度", signal),
    readJson(files.report, "章报告", signal),
    readJson(files.atlas, "地图记录", signal),
    guideRead,
  ]);
  const warnings: string[] = [...store.problems];
  let progress: ProgressSummary | null = null;
  if (progressRead.state === "error") warnings.push(progressRead.message);
  else if (progressRead.state === "ok") {
    try {
      progress = readProgress(progressRead.value);
    } catch (error) {
      warnings.push(`章进度读不了：${describeError(error)}`);
    }
  }
  let report: ReportSummary | null = null;
  if (reportRead.state === "error") warnings.push(reportRead.message);
  else if (reportRead.state === "ok") {
    try {
      report = readReport(reportRead.value);
    } catch (error) {
      warnings.push(`章报告读不了：${describeError(error)}`);
    }
  }
  const names = atlasRead.state === "ok" ? readAtlasNames(atlasRead.value) : new Map();
  const range = chapterByNumber(plan.chapter);
  const title = range === null ? "" : chapterTitle(range, guide);
  const history = store.historyFor(plan.chapter).length;
  const view = chapterViewOf(plan, history, progress, report, names, title, warnings);
  return {
    title: "章计划",
    status: view.statusText,
    message: null,
    chapter: view,
    mode,
  };
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** GET /api/ffpr/chapter?game=ffN: the accepted chapter plan and its live execution state. */
export function chapterRoute(
  current?: CurrentSource,
  filesFor: ChapterFilesOf = defaultChapterFiles,
  mode: "chapter" | "plan" = "chapter",
): ConnectionFetchRoute {
  return {
    path: CHAPTER_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      let choice: GameChoice;
      try {
        choice = await requestedGame(request, current);
      } catch (error) {
        request.signal.throwIfAborted();
        return json({ ok: false, error: describeError(error), at });
      }
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      try {
        return json({
          ok: true,
          at,
          view: await readChapterPanel(filesFor(choice.game.key), request.signal, mode),
        });
      } catch (error) {
        request.signal.throwIfAborted();
        return json({
          ok: false,
          error: `读不了章计划：${describeError(error)}`,
          at,
        });
      }
    },
  };
}

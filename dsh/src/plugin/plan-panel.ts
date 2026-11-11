/**
 * The sidebar's segment-plan panel (task 147, 11-11): the whole plan the player model wrote
 * (`src/engine/plan/types.ts`) and how far code has executed it, read from the three files task
 * 137/145/146 maintain. Everything Chinese is computed here so the browser only lays it out.
 *
 * This module is read-only. A missing or damaged file becomes Chinese view text, never an
 * exception; the route still answers so the rest of the sidebar keeps working.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { describeError, isMissingFile } from "../engine/errors.ts";
import { byKey, type Game } from "../engine/games.ts";
import { DEPS } from "../engine/paths.ts";
import { SegmentPlanStore, segmentPlanPath, segmentProgressPath } from "../engine/plan/store.ts";
import type {
  PlanStationAction,
  SegmentPlan,
  SegmentProgress,
  SegmentReport,
} from "../engine/plan/types.ts";
import {
  describeReaction,
  describeRule,
  fromLegacy,
  parseStrategy,
  type Strategy,
  type StrategyRule,
} from "../engine/strategy/index.ts";
import { isRecord, num, records, text } from "../engine/values.ts";
import { readCurrent, type CurrentSource } from "./current.ts";

export const PLAN_ROUTE = "/api/ffpr/plan";

/** Where one game's plan, progress, last report and map names live. */
export interface PlanFiles {
  readonly plan: string;
  readonly progress: string;
  readonly report: string;
  /** Only used for Chinese map names; a missing atlas falls back to the bare map number. */
  readonly atlas: string;
}

export function defaultPlanFiles(game: string): PlanFiles {
  return {
    plan: segmentPlanPath(game),
    progress: segmentProgressPath(game),
    report: join(DEPS, "ds", `segment-report-${game}.json`),
    atlas: join(DEPS, "ds", `atlas-${game}.json`),
  };
}

export type PlanFilesOf = (game: string) => PlanFiles;

export interface PlanStationRowView {
  readonly number: number;
  readonly mapText: string;
  readonly cellText: string;
  readonly action: string;
  readonly why: string;
  readonly untilText: string;
  readonly statusSymbol: string;
  readonly statusText: string;
  readonly note: string;
  readonly current: boolean;
}

export interface PlanDroppedRowView {
  readonly number: number;
  readonly mapText: string;
  readonly cellText: string;
  readonly action: string;
  readonly why: string;
}

export interface PlanRuleTableView {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface PlanBattleGroupView {
  readonly title: string;
  readonly tables: readonly PlanRuleTableView[];
}

export interface PlanBossView {
  readonly name: string;
  readonly mapText: string;
  readonly prepText: string;
  readonly tables: readonly PlanRuleTableView[];
  readonly notes: string;
}

export interface PlanReportView {
  readonly heading: string;
  readonly lines: readonly string[];
  readonly exceptionText: string | null;
}

export interface PlanView {
  readonly section: string;
  readonly goalText: string;
  readonly revisionText: string;
  readonly statusText: string;
  readonly startedText: string;
  readonly updatedText: string;
  readonly whyText: string | null;
  readonly prep: readonly string[];
  readonly prepEmptyText: string;
  readonly stationHeaders: readonly string[];
  readonly stations: readonly PlanStationRowView[];
  readonly stationEmptyText: string;
  readonly dropped: readonly PlanDroppedRowView[];
  readonly droppedHeaders: readonly string[];
  readonly battle: readonly PlanBattleGroupView[];
  readonly boss: readonly PlanBossView[];
  readonly turnBack: readonly string[];
  readonly turnBackEmptyText: string;
  readonly report: PlanReportView | null;
  readonly reportEmptyText: string;
  readonly notes: string | null;
  readonly warnings: readonly string[];
}

export interface PlanPanelView {
  readonly title: "段计划";
  readonly status: string;
  readonly message: string | null;
  readonly plan: PlanView | null;
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
};

const STATION_STATUS: Readonly<
  Record<
    SegmentProgress["stations"][number]["status"],
    { readonly symbol: string; readonly label: string }
  >
> = {
  pending: { symbol: "·", label: "待做" },
  current: { symbol: "▶", label: "正在做" },
  done: { symbol: "✓", label: "做完" },
  failed: { symbol: "✗", label: "失败" },
  skipped: { symbol: "↷", label: "跳过" },
};

type ProgressStatus = SegmentProgress["stations"][number]["status"];

interface ProgressSummary {
  readonly section: string;
  readonly goal: string;
  readonly stationCount: number;
  readonly revision: number | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: SegmentProgress["status"];
  readonly stations: ReadonlyMap<
    number,
    { readonly status: ProgressStatus; readonly note: string }
  >;
  readonly previousException: { readonly kind: string; readonly detail: string } | null;
}

interface ReportSummary {
  readonly section: string;
  readonly status: SegmentReport["status"];
  readonly exception:
    | {
        readonly kind: string;
        readonly map: number | null;
        readonly cell: readonly [number, number] | null;
        readonly station: number | null;
        readonly detail: string;
      }
    | undefined;
  readonly done: {
    readonly stations: number;
    readonly chestsOpened: number;
    readonly battles: number;
    readonly bestiaryNew: readonly string[];
    readonly blueMagicNew: readonly string[];
    readonly bossesWon: readonly string[];
  };
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
    return { state: "error", message: `读不了${label}:${describeError(error)}` };
  }
  try {
    return { state: "ok", value: JSON.parse(body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { state: "error", message: `读不懂${label}:${describeError(error)}` };
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

/** The executor's live progress (task 145); a damaged shape becomes a Chinese read error. */
function readProgress(value: unknown): ProgressSummary {
  if (!isRecord(value)) throw new Error("执行进度不是 JSON 对象");
  const section = text(value.section)?.trim() ?? "";
  if (section === "") throw new Error("执行进度里没有节名");
  const status = value.status;
  if (status !== "running" && status !== "done" && status !== "exception" && status !== "aborted") {
    throw new Error("执行进度里的状态看不懂");
  }
  if (!Array.isArray(value.stations)) throw new Error("执行进度里没有站点状态");
  const stations = new Map<number, { readonly status: ProgressStatus; readonly note: string }>();
  for (const raw of value.stations) {
    if (!isRecord(raw)) continue;
    const index = num(raw.index);
    if (index === undefined) continue;
    stations.set(Math.trunc(index), {
      status: progressStatusOf(raw.status),
      note: text(raw.note) ?? "",
    });
  }
  const previous = isRecord(value.previousException) ? value.previousException : null;
  const previousException =
    previous === null
      ? null
      : {
          kind: text(previous.kind) ?? "other",
          detail: text(previous.detail) ?? "",
        };
  const revision = num(value.revision);
  return {
    section,
    goal: text(value.goal)?.trim() ?? "",
    stationCount: value.stations.length,
    revision: revision === undefined ? null : Math.max(1, Math.trunc(revision)),
    startedAt: text(value.startedAt) ?? "",
    updatedAt: text(value.updatedAt) ?? "",
    status,
    stations,
    previousException,
  };
}

function cellOf(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = num(value[0]);
  const y = num(value[1]);
  return x === undefined || y === undefined ? null : [Math.trunc(x), Math.trunc(y)];
}

/** The last `SegmentReport` (task 138); a readable JSON of the wrong shape is an error. */
function readReport(value: unknown): ReportSummary {
  if (!isRecord(value)) throw new Error("执行报告不是 JSON 对象");
  const section = text(value.section)?.trim() ?? "";
  if (section === "") throw new Error("执行报告里没有节名");
  const status = value.status;
  if (status !== "done" && status !== "exception" && status !== "aborted") {
    throw new Error("执行报告里的状态看不懂");
  }
  const done = isRecord(value.done) ? value.done : {};
  const rawException = value.exception;
  let exception: ReportSummary["exception"];
  if (rawException !== undefined && rawException !== null) {
    if (!isRecord(rawException)) throw new Error("执行报告里的例外不是对象");
    const mapId = num(rawException.map);
    const station = num(rawException.station);
    exception = {
      kind: text(rawException.kind) ?? "other",
      map: mapId === undefined ? null : Math.trunc(mapId),
      cell: cellOf(rawException.cell),
      station: station === undefined ? null : Math.trunc(station),
      detail: text(rawException.detail) ?? "",
    };
  }
  return {
    section,
    status,
    exception,
    done: {
      stations: countOf(done.stations),
      chestsOpened: countOf(done.chestsOpened),
      battles: countOf(done.battles),
      bestiaryNew: stringListOf(done.bestiaryNew),
      blueMagicNew: stringListOf(done.blueMagicNew),
      bossesWon: stringListOf(done.bossesWon),
    },
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

/** Parse the route tool's `"map:x,y"` spelling; anything else keeps the raw text in the row. */
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

function statusView(
  status: ProgressStatus | null,
  started: boolean,
): { readonly symbol: string; readonly text: string; readonly current: boolean } {
  if (status === null) {
    return { symbol: "·", text: started ? "待做" : "未开始", current: false };
  }
  const fixed = STATION_STATUS[status];
  return { symbol: fixed.symbol, text: fixed.label, current: status === "current" };
}

function stationView(
  raw: unknown,
  position: number,
  progress: ProgressSummary | null,
  names: ReadonlyMap<string, string>,
): PlanStationRowView {
  const station = isRecord(raw) ? raw : {};
  const to = text(station.to)?.trim() ?? "";
  const entry = progress?.stations.get(position);
  const status = entry?.status ?? null;
  const state = statusView(status, progress !== null);
  return {
    number: position + 1,
    mapText: to === "" ? "—" : stationMapText(to, names),
    cellText: to === "" ? "—" : stationCellText(to),
    action: actionText(station.do),
    why: text(station.why)?.trim() ?? "—",
    untilText: untilTextOf(station.until),
    statusSymbol: state.symbol,
    statusText: state.text,
    note: entry?.note ?? "",
    current: state.current,
  };
}

function droppedView(
  raw: unknown,
  position: number,
  names: ReadonlyMap<string, string>,
): PlanDroppedRowView {
  const dropped = isRecord(raw) ? raw : {};
  const to = text(dropped.to)?.trim() ?? "";
  return {
    number: position + 1,
    mapText: to === "" ? "—" : stationMapText(to, names),
    cellText: to === "" ? "—" : stationCellText(to),
    action: actionText(dropped.do),
    why: text(dropped.why)?.trim() ?? "—",
  };
}

function briefRule(rule: StrategyRule | (StrategyRule & { readonly on: string })): string {
  try {
    return "on" in rule ? describeReaction(rule) : describeRule(rule);
  } catch {
    return `${rule.who}:${rule.do}`;
  }
}

/**
 * First two rules per actor, as the sidebar's one-line summaries. Old `{角色: [规则]}` tables
 * and strategy 2.0 tables both pass through the strategy parser, so the wording matches the
 * battle log's own Chinese.
 */
function ruleSummaries(table: unknown): string[] {
  let strategy: Strategy;
  try {
    const parsed =
      isRecord(table) && table.version === 2 ? parseStrategy(table) : fromLegacy(table);
    if (Array.isArray(parsed)) return [`规则表读不懂：${parsed.join("；")}`];
    strategy = parsed;
  } catch (error) {
    return [`规则表读不懂：${describeError(error)}`];
  }
  const lines: string[] = [];
  const seen = new Map<string, number>();
  const add = (rule: StrategyRule | (StrategyRule & { readonly on: string })): void => {
    const who = rule.who.trim() === "" ? "全员" : rule.who;
    const count = seen.get(who) ?? 0;
    if (count >= 2) return;
    seen.set(who, count + 1);
    lines.push(briefRule(rule));
  };
  for (const reaction of strategy.reactions) add(reaction);
  for (const phase of strategy.phases) {
    for (const rule of phase.rules) add(rule);
  }
  for (const rule of strategy.rules) add(rule);
  return lines.length === 0 ? ["没有规则"] : lines;
}

function ruleTablesOf(value: unknown): PlanRuleTableView[] {
  const tables = Array.isArray(value) ? value : [];
  if (tables.length === 0) return [{ title: "规则", lines: ["没有规则表"] }];
  return tables.map((table, index) => ({
    title: `第 ${index + 1} 套`,
    lines: ruleSummaries(table),
  }));
}

function battleGroupsOf(
  plan: SegmentPlan,
  names: ReadonlyMap<string, string>,
): PlanBattleGroupView[] {
  return records(plan.battle).map((group, index) => {
    const maps = Array.isArray(group.maps)
      ? group.maps
          .map((mapId) => num(mapId))
          .filter((mapId): mapId is number => mapId !== undefined)
          .map((mapId) => mapTextOf(mapId, names))
      : [];
    const where = maps.length === 0 ? "本节所有地图" : maps.join("、");
    return {
      title: `普通战斗表 ${index + 1}（${where}）`,
      tables: ruleTablesOf(group.tables),
    };
  });
}

function bossViewsOf(plan: SegmentPlan, names: ReadonlyMap<string, string>): PlanBossView[] {
  return records(plan.bosses).map((boss) => {
    const mapId = num(boss.map);
    return {
      name: text(boss.name)?.trim() ?? "未命名首领",
      mapText: mapId === undefined ? "—" : mapTextOf(Math.trunc(mapId), names),
      prepText: `先回复：${boss.healFirst === true ? "是" : "否"}；先存档：${boss.saveFirst === true ? "是" : "否"}`,
      tables: ruleTablesOf(boss.tables),
      notes: text(boss.notes)?.trim() ?? "",
    };
  });
}

function prepLinesOf(plan: SegmentPlan): string[] {
  const prep: Readonly<Record<string, unknown>> = isRecord(plan.prep) ? plan.prep : {};
  const lines: string[] = [];
  for (const job of Array.isArray(prep.jobs) ? prep.jobs : []) {
    if (!isRecord(job)) continue;
    const member = text(job.member)?.trim() ?? "?";
    const name = text(job.job)?.trim() ?? "?";
    const abilities = stringListOf(job.abilities);
    lines.push(
      `换职业：${member} → ${name}${abilities.length === 0 ? "" : `（技能：${abilities.join("、")}）`}`,
    );
  }
  if (prep.equip === "optimize") lines.push("装备：自动挑最强");
  else if (prep.equip === "keep") lines.push("装备：保持现状");
  else if (text(prep.equip) !== undefined) lines.push(`装备：${text(prep.equip)}`);
  for (const item of Array.isArray(prep.buy) ? prep.buy : []) {
    if (!isRecord(item)) continue;
    const name = text(item.item)?.trim() ?? "?";
    lines.push(`购买：${name} ×${countOf(item.count)}`);
  }
  for (const row of Array.isArray(prep.rows) ? prep.rows : []) {
    if (!isRecord(row)) continue;
    const member = text(row.member)?.trim() ?? "?";
    const place = row.row === "front" ? "前排" : row.row === "back" ? "后排" : "未知";
    lines.push(`站位：${member} ${place}`);
  }
  return lines;
}

function turnBackLinesOf(plan: SegmentPlan): string[] {
  return records(plan.turnBack).map((item) => {
    const when = text(item.when)?.trim() ?? "条件未写";
    const then =
      item.then === "heal-and-continue"
        ? "回复后继续"
        : item.then === "replan"
          ? "重新规划"
          : (text(item.then) ?? "?");
    return `${when} → ${then}`;
  });
}

function stateOfProgress(progress: ProgressSummary | null): string {
  if (progress === null) return "没在执行";
  if (progress.status === "running") return "执行中";
  if (progress.status === "done") return "完成";
  if (progress.status === "exception") return "出例外";
  return "没在执行";
}

function reportViewOf(report: ReportSummary, names: ReadonlyMap<string, string>): PlanReportView {
  const status =
    report.status === "done" ? "完成" : report.status === "exception" ? "出例外" : "中止";
  const list = (items: readonly string[]): string => (items.length === 0 ? "无" : items.join("、"));
  const lines = [
    `状态：${status}`,
    `完成 ${report.done.stations} 站，开箱 ${report.done.chestsOpened} 个，战斗 ${report.done.battles} 场`,
    `新图鉴：${list(report.done.bestiaryNew)}；新青魔法：${list(report.done.blueMagicNew)}；击败首领：${list(report.done.bossesWon)}`,
    `用时 ${report.minutes} 分钟，模型调用 ${report.modelCalls} 次`,
  ];
  let exceptionText: string | null = null;
  if (report.exception !== undefined) {
    const where =
      report.exception.map === null
        ? "位置不明"
        : mapTextOf(report.exception.map, names) +
          (report.exception.cell === null
            ? ""
            : ` (${report.exception.cell[0]},${report.exception.cell[1]})`);
    const station =
      report.exception.station === null ? "" : `；第 ${report.exception.station + 1} 站`;
    exceptionText = `例外（${report.exception.kind}）${where}${station}：${report.exception.detail}`;
  }
  return {
    heading: `最近一份报告（${report.section}）`,
    lines,
    exceptionText,
  };
}

function whyTextOf(progress: ProgressSummary | null, report: ReportSummary | null): string | null {
  if (progress?.previousException === null || progress?.previousException === undefined)
    return null;
  const exception = progress.previousException;
  const station =
    report !== null && report.section === progress.section && report.exception !== undefined
      ? report.exception.station
      : null;
  const at = station === null ? "" : `在第 ${station + 1} 站`;
  return `上一份${at}出例外（${exception.kind}）：${exception.detail}`;
}

function planViewOf(
  plan: SegmentPlan,
  progress: ProgressSummary | null,
  report: ReportSummary | null,
  names: ReadonlyMap<string, string>,
  warnings: readonly string[],
): PlanView {
  const planGoal = text(plan.goal)?.trim() ?? "";
  const planStations = Array.isArray(plan.stations) ? plan.stations : [];
  const progressMatches =
    progress !== null &&
    progress.section === plan.section &&
    progress.goal === planGoal &&
    progress.stationCount === planStations.length;
  const usableProgress = progressMatches ? progress : null;
  const progressWarning = progress !== null && !progressMatches ? "执行进度是上一份计划的" : null;
  const started = usableProgress?.startedAt ?? "";
  const updated = usableProgress?.updatedAt ?? "";
  const stationRows = planStations.map((station, index) =>
    stationView(station, index, usableProgress, names),
  );
  const revisionText =
    usableProgress !== null
      ? usableProgress.revision === null
        ? "本节计划"
        : `本节第 ${usableProgress.revision} 份计划`
      : progress !== null
        ? progress.revision === null
          ? "本节计划(未开始)"
          : `本节第 ${progress.revision + 1} 份计划(未开始)`
        : "本节计划";
  return {
    section: plan.section,
    goalText: `目标：${planGoal}`,
    revisionText,
    statusText: stateOfProgress(usableProgress),
    startedText: started === "" ? "开始时间未知" : `开始 ${clockText(started) || "时间未知"}`,
    updatedText: updated === "" ? "更新时间未知" : `更新 ${clockText(updated) || "时间未知"}`,
    whyText: whyTextOf(usableProgress, report),
    prep: prepLinesOf(plan),
    prepEmptyText: "没有准备事项",
    stationHeaders: ["序号", "图", "坐标", "做什么", "为什么", "停止条件", "状态"],
    stations: stationRows,
    stationEmptyText: "这份计划没有站点",
    dropped: records(plan.dropped).map((dropped, index) => droppedView(dropped, index, names)),
    droppedHeaders: ["序号", "图", "坐标", "做什么", "为什么"],
    battle: battleGroupsOf(plan, names),
    boss: bossViewsOf(plan, names),
    turnBack: turnBackLinesOf(plan),
    turnBackEmptyText: "没有回头条件",
    report: report === null ? null : reportViewOf(report, names),
    reportEmptyText: "还没有执行报告",
    notes: text(plan.notes)?.trim() || null,
    warnings: progressWarning === null ? warnings : [...warnings, progressWarning],
  };
}

/**
 * Read one game's plan, progress, report and atlas. Missing files and damaged JSON become view
 * text; the only rejection is an aborted request.
 */
export async function readPlanPanel(
  files: PlanFiles,
  signal?: AbortSignal,
): Promise<PlanPanelView> {
  const empty: PlanPanelView = {
    title: "段计划",
    status: "还没有段计划",
    message: "还没有段计划",
    plan: null,
  };
  let store: SegmentPlanStore;
  try {
    store = await SegmentPlanStore.load("", files.plan, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...empty,
      status: "段计划读不了",
      message: describeError(error),
    };
  }
  const plan = store.current;
  if (plan === null) {
    return store.problems.length === 0
      ? empty
      : {
          ...empty,
          status: "段计划读不了",
          message: store.problems.join("；"),
        };
  }

  const [progressRead, reportRead, atlasRead] = await Promise.all([
    readJson(files.progress, "执行进度", signal),
    readJson(files.report, "执行报告", signal),
    readJson(files.atlas, "地图记录", signal),
  ]);
  const warnings: string[] = [...store.problems];
  let progress: ProgressSummary | null = null;
  if (progressRead.state === "error") {
    warnings.push(progressRead.message);
  } else if (progressRead.state === "ok") {
    try {
      progress = readProgress(progressRead.value);
    } catch (error) {
      warnings.push(`执行进度读不了：${describeError(error)}`);
    }
  }
  let report: ReportSummary | null = null;
  if (reportRead.state === "error") {
    warnings.push(reportRead.message);
  } else if (reportRead.state === "ok") {
    try {
      report = readReport(reportRead.value);
    } catch (error) {
      warnings.push(`执行报告读不了：${describeError(error)}`);
    }
  }
  const names = atlasRead.state === "ok" ? readAtlasNames(atlasRead.value) : new Map();
  const view = planViewOf(plan, progress, report, names, warnings);
  return {
    title: "段计划",
    status: view.statusText,
    message: null,
    plan: view,
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

/** GET /api/ffpr/plan?game=ffN: the current segment plan and its live execution state. */
export function planRoute(
  current?: CurrentSource,
  filesFor: PlanFilesOf = defaultPlanFiles,
): ConnectionFetchRoute {
  return {
    path: PLAN_ROUTE,
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
          view: await readPlanPanel(filesFor(choice.game.key), request.signal),
        });
      } catch (error) {
        request.signal.throwIfAborted();
        return json({ ok: false, error: `读不了段计划：${describeError(error)}`, at });
      }
    },
  };
}

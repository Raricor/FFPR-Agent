/**
 * Chapter run report (task 158, 11-12): turn one `run-<game>.jsonl` back into the one screen the
 * user asked for — every station's result/time/attempts/reason, chests and hidden items,
 * fallbacks by kind, the blocked spot, battles, levels, heals and the run's model calls.
 *
 * `scripts/chapter-report.mts` reads the files and prints this; the JSON form is the same data.
 * The event log is the source of truth; the chapter plan supplies the planned stations and the
 * chapter progress supplies anything a previous run recorded before the structured log existed.
 */

import type { ChapterPlan, ChapterProgress } from "./chapter-types.ts";
import type { RunEvent, RunStationResult } from "../run-log.ts";

export type RunReportStationResult = RunStationResult | "pending" | "current";

export interface RunReportStation {
  readonly segment: number;
  readonly section: string;
  readonly station: number;
  readonly do: string | null;
  readonly to: string | null;
  readonly map: number | null;
  readonly cell: readonly [number, number] | null;
  readonly result: RunReportStationResult;
  readonly attempts: number;
  readonly ms: number | null;
  readonly evidence: readonly string[];
  readonly note: string;
  /** `skipped`/`failed` always carry one; "（没有记录原因）" when the log lost it. */
  readonly reason: string | null;
}

export interface RunReportSegment {
  readonly index: number;
  readonly section: string;
  readonly status: string;
  readonly stations: readonly RunReportStation[];
  readonly ms: number | null;
}

export interface RunReportFallback {
  readonly kind: string;
  readonly reason: string;
  readonly segment: number | null;
  readonly station: number | null;
}

export interface RunReportChest {
  readonly segment: number | null;
  readonly station: number | null;
  readonly map: number | null;
  readonly cell: readonly [number, number] | null;
  readonly item: string;
  readonly reason: string | null;
}

export interface RunReportBattle {
  readonly kind: "normal" | "boss";
  readonly enemies: readonly string[];
  readonly won: boolean;
  readonly ms: number | null;
}

export interface RunReportLevel {
  readonly member: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly segment: number | null;
}

export interface RunReportHeal {
  readonly beforeHp: number | null;
  readonly afterHp: number | null;
  readonly used: string;
  readonly segment: number | null;
  readonly station: number | null;
}

export interface RunReportBuy {
  readonly item: string;
  readonly count: number | null;
  readonly bought: number | null;
  readonly note: string;
}

export interface RunReportBlocked {
  readonly segment: number | null;
  readonly station: number | null;
  readonly where: string;
  readonly reason: string;
}

export interface ChapterRunReport {
  readonly game: string;
  readonly run: string;
  readonly chapter: number | null;
  readonly goal: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly minutes: number | null;
  readonly modelCalls: number | null;
  readonly segments: readonly RunReportSegment[];
  readonly fallbacks: {
    readonly total: number;
    readonly byKind: Readonly<Record<string, number>>;
    readonly items: readonly RunReportFallback[];
  };
  readonly chests: {
    readonly planned: number;
    readonly opened: number;
    readonly skipped: number;
    readonly skippedItems: readonly RunReportChest[];
  };
  readonly blocked: RunReportBlocked | null;
  readonly battles: {
    readonly total: number;
    readonly normal: {
      readonly total: number;
      readonly won: number;
      readonly lost: number;
    };
    readonly boss: {
      readonly total: number;
      readonly won: number;
      readonly lost: number;
    };
    readonly items: readonly RunReportBattle[];
  };
  readonly levels: readonly RunReportLevel[];
  readonly heals: readonly RunReportHeal[];
  readonly buys: readonly RunReportBuy[];
  readonly resume: {
    readonly from: number | null;
    readonly skipped: readonly number[];
    readonly note: string;
  } | null;
  readonly warnings: readonly string[];
}

interface StationAccumulator {
  readonly key: string;
  segment: number;
  section: string;
  station: number;
  do: string | null;
  to: string | null;
  map: number | null;
  cell: readonly [number, number] | null;
  result: RunReportStationResult;
  attempts: number;
  ms: number | null;
  evidence: string[];
  note: string;
  reason: string | null;
}

interface SegmentAccumulator {
  readonly index: number;
  section: string;
  status: string;
  startAt: string | null;
  ms: number | null;
}

const PENDING = "pending";

function keyOf(segment: number | null, station: number | null): string {
  return `${segment ?? "?"}:${station ?? "?"}`;
}

function isStationResult(value: string | undefined): value is RunStationResult {
  return value === "done" || value === "failed" || value === "skipped" || value === "blocked";
}

function reasonOf(event: RunEvent): string {
  return (event.reason ?? event.note ?? "").trim();
}

/** The segment executor marks a retried prefix done with this note, not a real completion. */
function isRetryPrefixNote(note: string | null | undefined): boolean {
  return (note ?? "").includes("重试前已完成");
}

function cellFrom(event: RunEvent): readonly [number, number] | null {
  return event.cell ?? null;
}

function timeOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function roundMinutes(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10;
}

function sectionOfSegment(plan: ChapterPlan | null, index: number, fallback = ""): string {
  return plan?.segments[index]?.section ?? fallback;
}

function segmentStatus(stations: readonly RunReportStation[], fallback: string): string {
  if (stations.some((station) => station.result === "failed")) return "exception";
  if (stations.some((station) => station.result === "blocked")) return "exception";
  if (stations.some((station) => station.result === "skipped")) return "done-with-skips";
  if (stations.some((station) => station.result === "pending" || station.result === "current")) {
    return "running";
  }
  return fallback;
}

function statusText(status: string): string {
  if (status === "done-with-skips") return "done(有跳过)";
  return status;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${roundMinutes(ms).toFixed(1)}分`;
}

function whereText(segment: number | null, station: number | null): string {
  if (segment === null) return "位置不明";
  const section = `第 ${segment + 1} 节`;
  return station === null ? section : `${section}第 ${station + 1} 站`;
}

function mapOfWhere(where: string | undefined): number | null {
  if (where === undefined) return null;
  const match = /^(?:地图\s*)?(\d+)/u.exec(where);
  return match === null ? null : Number(match[1]);
}

function formatStation(station: RunReportStation): string {
  const head =
    `  ${station.segment + 1}-${station.station + 1} [${station.result}] ` +
    `${station.do ?? "?"} ${station.to ?? ""}`;
  const bits = [formatMs(station.ms), `尝试 ${station.attempts}`];
  if (station.evidence.length > 0) bits.push(`证据 ${station.evidence.join("、")}`);
  const reason = station.reason ?? (station.note.trim() === "" ? null : station.note.trim());
  if (
    (station.result === "skipped" || station.result === "failed" || station.result === "blocked") &&
    reason !== null
  ) {
    bits.push(`原因: ${reason}`);
  } else if (station.result === "done" && station.note.trim() !== "") {
    bits.push(station.note.trim());
  }
  return `${head} · ${bits.join(" · ")}`;
}

/** Build the report from one run's events, the chapter plan and (optional) progress file. */
export function buildChapterRunReport(input: {
  readonly game: string;
  readonly run: string;
  readonly events: readonly RunEvent[];
  readonly plan: ChapterPlan | null;
  readonly progress: ChapterProgress | null;
  readonly chapter?: number | null;
}): ChapterRunReport {
  const { game, run, plan, progress } = input;
  const events = input.events;
  const chapter =
    input.chapter ??
    plan?.chapter ??
    events.find((event) => event.chapter !== null)?.chapter ??
    progress?.chapter ??
    null;
  const stationMap = new Map<string, StationAccumulator>();
  const segmentMap = new Map<number, SegmentAccumulator>();
  const fallbacks: RunReportFallback[] = [];
  const battles: RunReportBattle[] = [];
  const levels: RunReportLevel[] = [];
  const heals: RunReportHeal[] = [];
  const buys: RunReportBuy[] = [];
  const warnings: string[] = [];
  const chestEvents = new Map<string, RunEvent>();
  let status = progress?.status ?? "unknown";
  let startedAt: string | null = progress?.startedAt ?? null;
  let endedAt: string | null = progress?.finishedAt ?? null;
  let runMs: number | null = null;
  let modelCalls: number | null = null;
  let reportBattles: number | null = null;
  let blocked: RunReportBlocked | null = null;
  let resume: ChapterRunReport["resume"] = null;
  let goal = plan?.goal ?? progress?.goal ?? "";

  const segmentAt = (index: number, section = ""): SegmentAccumulator => {
    let segment = segmentMap.get(index);
    if (segment === undefined) {
      segment = {
        index,
        section: sectionOfSegment(plan, index, section),
        status: PENDING,
        startAt: null,
        ms: null,
      };
      segmentMap.set(index, segment);
    } else if (segment.section === "" && section !== "") {
      segment.section = section;
    }
    return segment;
  };

  const stationAt = (event: RunEvent): StationAccumulator => {
    const segment = event.segment ?? 0;
    const station = event.station ?? 0;
    const key = keyOf(segment, station);
    let record = stationMap.get(key);
    if (record === undefined) {
      record = {
        key,
        segment,
        section: event.section ?? sectionOfSegment(plan, segment),
        station,
        do: event.do ?? null,
        to: event.to ?? null,
        map: event.map ?? null,
        cell: cellFrom(event),
        result: PENDING,
        attempts: 0,
        ms: null,
        evidence: [],
        note: "",
        reason: null,
      };
      stationMap.set(key, record);
    }
    if (event.section !== null && record.section === "") {
      record.section = event.section;
    }
    if (event.do !== undefined) record.do = event.do;
    if (event.to !== undefined) record.to = event.to;
    if (event.map !== undefined) record.map = event.map;
    if (event.cell !== undefined) record.cell = cellFrom(event);
    return record;
  };

  for (const event of events) {
    if (event.segment !== null) segmentAt(event.segment, event.section ?? "");
    switch (event.type) {
      case "run.start": {
        status = "running";
        startedAt = event.at;
        if (typeof event.note === "string" && event.note !== "") goal = event.note;
        break;
      }
      case "run.end": {
        status = event.status ?? status;
        endedAt = event.at;
        runMs = event.ms ?? null;
        if (event.modelCalls !== undefined) modelCalls = event.modelCalls;
        if (event.battles !== undefined) reportBattles = event.battles;
        break;
      }
      case "segment.start": {
        if (event.segment === null) break;
        const segment = segmentAt(event.segment, event.section ?? "");
        segment.startAt = event.at;
        segment.status = "running";
        break;
      }
      case "segment.end": {
        if (event.segment === null) break;
        const segment = segmentAt(event.segment, event.section ?? "");
        segment.status = event.status ?? segment.status;
        segment.ms = event.ms ?? segment.ms;
        break;
      }
      case "station.start": {
        const record = stationAt(event);
        record.attempts += 1;
        record.result = "current";
        break;
      }
      case "station.end": {
        const record = stationAt(event);
        // A retried segment marks already-finished stations done again. Keep the first real
        // completion's evidence and time; the dummy event only says "already done".
        if (record.result === "done" && !isRetryPrefixNote(record.note)) {
          record.attempts = Math.max(record.attempts, event.attempt ?? 0);
          break;
        }
        record.result = isStationResult(event.result) ? event.result : "failed";
        record.ms = event.ms ?? record.ms;
        record.note = event.note ?? "";
        record.reason = reasonOf(event) === "" ? null : reasonOf(event);
        record.evidence = [...(event.evidence ?? [])];
        record.attempts = Math.max(record.attempts, event.attempt ?? 0);
        break;
      }
      case "fallback": {
        fallbacks.push({
          kind: event.kind ?? "other",
          reason: reasonOf(event) === "" ? "（没有记录原因）" : reasonOf(event),
          segment: event.segment,
          station: event.station,
        });
        break;
      }
      case "blocked": {
        const where = whereText(event.segment, event.station);
        let reason = reasonOf(event).replace(/^等待修复[:：]\s*/u, "");
        if (reason.startsWith(`${where}：`)) reason = reason.slice(where.length + 1);
        else if (reason.startsWith(`${where}: `)) reason = reason.slice(where.length + 2);
        blocked = {
          segment: event.segment,
          station: event.station,
          where,
          reason: reason === "" ? "（没有记录原因）" : reason,
        };
        break;
      }
      case "battle": {
        battles.push({
          kind: event.kind === "boss" ? "boss" : "normal",
          enemies: [...(event.enemies ?? [])],
          won: event.won === true,
          ms: event.ms ?? null,
        });
        break;
      }
      case "chest": {
        const key = keyOf(event.segment, event.station);
        const prior = chestEvents.get(key);
        if (prior?.opened === true && event.opened === true && isRetryPrefixNote(event.note)) {
          break;
        }
        chestEvents.set(key, event);
        break;
      }
      case "level": {
        levels.push({
          member: event.member ?? "?",
          from: event.fromLevel ?? null,
          to: event.toLevel ?? null,
          segment: event.segment,
        });
        break;
      }
      case "heal": {
        heals.push({
          beforeHp: event.beforeHp ?? null,
          afterHp: event.afterHp ?? null,
          used: event.used ?? event.note ?? "",
          segment: event.segment,
          station: event.station,
        });
        break;
      }
      case "buy": {
        buys.push({
          item: event.item ?? "?",
          count: event.count ?? null,
          bought: event.bought ?? null,
          note: reasonOf(event),
        });
        break;
      }
      case "resume": {
        resume = {
          from: event.from ?? event.station ?? null,
          skipped: [...(event.skipped ?? [])],
          note: event.note ?? "",
        };
        break;
      }
      case "warn": {
        const line = reasonOf(event);
        if (line !== "") warnings.push(line);
        break;
      }
      default:
        break;
    }
  }

  // The plan is authoritative for what should have run; progress covers runs whose structured
  // log predates this task. Events fill in whatever actually ran.
  const stations: RunReportStation[] = [];
  const seen = new Set<string>();
  const addStation = (record: StationAccumulator): void => {
    seen.add(record.key);
    stations.push({
      segment: record.segment,
      section: record.section || sectionOfSegment(plan, record.segment),
      station: record.station,
      do: record.do,
      to: record.to,
      map: record.map,
      cell: record.cell,
      result: record.result,
      attempts: record.attempts,
      ms: record.ms,
      evidence: [...record.evidence],
      note: record.note,
      reason: record.reason,
    });
  };
  if (plan !== null) {
    for (let segment = 0; segment < plan.segments.length; segment += 1) {
      const segmentPlan = plan.segments[segment];
      if (segmentPlan === undefined) continue;
      for (let station = 0; station < segmentPlan.stations.length; station += 1) {
        const planned = segmentPlan.stations[station];
        if (planned === undefined) continue;
        const key = keyOf(segment, station);
        const record = stationMap.get(key);
        if (record !== undefined) {
          addStation(record);
          continue;
        }
        const old = progress?.segments[segment]?.stations[station];
        addStation({
          key,
          segment,
          section: segmentPlan.section,
          station,
          do: planned.do,
          to: planned.to,
          map: null,
          cell: null,
          result:
            old?.status === "done" || old?.status === "skipped" || old?.status === "failed"
              ? old.status
              : old?.status === "current"
                ? "current"
                : "pending",
          attempts: 0,
          ms: null,
          evidence: [],
          note: old?.note ?? "",
          reason: old === undefined || old.note.trim() === "" ? null : old.note,
        });
      }
    }
  }
  for (const record of stationMap.values()) {
    if (seen.has(record.key)) continue;
    // A station the current plan no longer has: keep it so an old run still explains itself.
    if (plan !== null) {
      const planned = plan.segments[record.segment]?.stations[record.station];
      if (planned !== undefined) continue;
    }
    addStation(record);
  }
  stations.sort((left, right) =>
    left.segment === right.segment ? left.station - right.station : left.segment - right.segment,
  );

  const segments: RunReportSegment[] = [];
  const indexes = new Set<number>([
    ...(plan?.segments.map((_entry, index) => index) ?? []),
    ...segmentMap.keys(),
    ...stations.map((station) => station.segment),
    ...(progress?.segments.map((_entry, index) => index) ?? []),
  ]);
  for (const index of [...indexes].sort((left, right) => left - right)) {
    const segment = segmentMap.get(index);
    const segmentStations = stations.filter((station) => station.segment === index);
    const prior = progress?.segments[index];
    const fallbackStatus =
      prior === undefined
        ? PENDING
        : prior.stations.some((station) => station.status === "failed")
          ? "exception"
          : "done";
    const inferred = segmentStatus(segmentStations, fallbackStatus);
    const started =
      segment?.startAt !== undefined && segment.startAt !== null ? segment : undefined;
    const status =
      started === undefined
        ? PENDING
        : started.status !== PENDING && started.status !== "running"
          ? started.status
          : inferred;
    const ms =
      started === undefined
        ? null
        : (started.ms ??
          (segmentStations.every((station) => station.ms === null)
            ? null
            : segmentStations.reduce((total, station) => total + (station.ms ?? 0), 0)));
    segments.push({
      index,
      section: segment?.section || sectionOfSegment(plan, index) || prior?.section || "",
      status,
      stations: segmentStations,
      ms,
    });
  }

  for (const event of events) {
    if (event.type === "chest" && event.opened !== true) {
      chestEvents.set(keyOf(event.segment, event.station), event);
    }
  }

  const plannedChests = stations.filter((station) => station.do === "open");
  const openedKeys = new Set<string>();
  const skippedItems: RunReportChest[] = [];
  const skippedKeys = new Set<string>();
  const chestLines = new Map<string, RunReportChest>();
  for (const station of plannedChests) {
    const key = keyOf(station.segment, station.station);
    if (station.result === "done" && station.note.trim() !== "已开过") {
      openedKeys.add(key);
    }
    if (station.result === "skipped" || station.result === "failed") {
      if (station.result === "skipped") {
        skippedKeys.add(key);
        skippedItems.push({
          segment: station.segment,
          station: station.station,
          map: station.map,
          cell: station.cell,
          item: station.do === "open" ? (station.to ?? "宝箱") : (station.to ?? ""),
          reason: station.reason ?? (station.note === "" ? "（没有记录原因）" : station.note),
        });
      }
    }
  }
  for (const [key, event] of chestEvents) {
    const line: RunReportChest = {
      segment: event.segment,
      station: event.station,
      map: event.map ?? null,
      cell: cellFrom(event),
      item: event.item ?? "宝箱",
      reason: reasonOf(event) === "" ? null : reasonOf(event),
    };
    chestLines.set(key, line);
    if (event.opened === true) openedKeys.add(key);
    else openedKeys.delete(key);
    if (event.opened !== true && event.result === "skipped" && !skippedKeys.has(key)) {
      skippedKeys.add(key);
      skippedItems.push({
        ...line,
        reason: line.reason ?? "（没有记录原因）",
      });
    }
  }
  for (const [key, line] of chestLines) {
    if (!skippedKeys.has(key)) continue;
    const found = skippedItems.find((entry) => keyOf(entry.segment, entry.station) === key);
    if (found === undefined) continue;
    // The chest event carries the item name and cell even when the station line was generic.
    skippedItems[skippedItems.indexOf(found)] = {
      ...line,
      reason: line.reason ?? found.reason,
    };
  }
  // Plan entries the model deliberately gave up are skipped collection targets too.
  for (const skipped of plan?.skipped ?? []) {
    if (skipped.kind !== "chest" && skipped.kind !== "hidden") continue;
    const already = plannedChests.some(
      (station) =>
        station.to === skipped.where ||
        (station.to ?? "").includes(skipped.name) ||
        station.note.includes(skipped.name),
    );
    if (already) continue;
    skippedItems.push({
      segment: null,
      station: null,
      map: mapOfWhere(skipped.where),
      cell: null,
      item: skipped.name,
      reason: skipped.why,
    });
  }
  skippedItems.sort((left, right) => {
    if (left.segment === right.segment) return (left.station ?? 0) - (right.station ?? 0);
    return (left.segment ?? -1) - (right.segment ?? -1);
  });
  const planned =
    plannedChests.length +
    (plan?.skipped ?? []).filter(
      (entry) =>
        (entry.kind === "chest" || entry.kind === "hidden") &&
        !plannedChests.some(
          (station) =>
            station.to === entry.where ||
            (station.to ?? "").includes(entry.name) ||
            station.note.includes(entry.name),
        ),
    ).length;

  const byKind: Record<string, number> = {};
  for (const fallback of fallbacks) byKind[fallback.kind] = (byKind[fallback.kind] ?? 0) + 1;

  const normal = battles.filter((battle) => battle.kind === "normal");
  const boss = battles.filter((battle) => battle.kind === "boss");
  const battleTotal = reportBattles ?? battles.length;

  if (progress?.status === "blocked") status = "blocked";
  if (blocked === null && progress?.blockedText !== undefined) {
    blocked = {
      segment: progress.segment,
      station: null,
      where: whereText(progress.segment, null),
      reason: progress.blockedText,
    };
  }
  if (blocked === null && (status === "exception" || status === "blocked")) {
    const last = [...events].reverse().find((event) => event.type === "run.end");
    const reason = last?.note ?? progress?.previousException?.detail ?? "（没有记录原因）";
    blocked = {
      segment: last?.segment ?? progress?.segment ?? null,
      station: last?.station ?? null,
      where: whereText(last?.segment ?? progress?.segment ?? null, last?.station ?? null),
      reason,
    };
  }

  const startMs = timeOf(startedAt);
  const endMs = timeOf(endedAt);
  const minutes =
    runMs !== null
      ? roundMinutes(runMs)
      : startMs !== null && endMs !== null
        ? roundMinutes(Math.max(0, endMs - startMs))
        : progress !== null
          ? Math.round(
              ((Date.parse(progress.updatedAt) - Date.parse(progress.startedAt)) / 60_000) * 10,
            ) / 10
          : null;

  return {
    game,
    run,
    chapter,
    goal,
    status,
    startedAt,
    endedAt,
    minutes,
    modelCalls,
    segments,
    fallbacks: { total: fallbacks.length, byKind, items: fallbacks },
    chests: {
      planned,
      opened: openedKeys.size,
      skipped: skippedItems.length,
      skippedItems,
    },
    blocked,
    battles: {
      total: battleTotal,
      normal: {
        total: normal.length,
        won: normal.filter((battle) => battle.won).length,
        lost: normal.filter((battle) => !battle.won).length,
      },
      boss: {
        total: boss.length,
        won: boss.filter((battle) => battle.won).length,
        lost: boss.filter((battle) => !battle.won).length,
      },
      items: battles,
    },
    levels,
    heals,
    buys,
    resume,
    warnings,
  };
}

/** The same content as one plain-text screen. */
export function formatChapterRunReport(report: ChapterRunReport): string {
  const lines: string[] = [];
  const title =
    report.chapter === null
      ? "未知章"
      : `章 ${report.chapter}${report.goal === "" ? "" : `「${report.goal}」`}`;
  const calls = report.modelCalls === null ? "?" : String(report.modelCalls);
  lines.push(
    `${title} ${report.game} · run ${report.run} · ${statusText(report.status)} · ` +
      `${report.minutes === null ? "? 分" : `${report.minutes} 分`} · 模型调用 ${calls} 次`,
  );
  if (report.resume !== null) {
    const skipped =
      report.resume.skipped.length === 0
        ? ""
        : `；跳过第 ${report.resume.skipped.map((index) => index + 1).join("、")} 站`;
    lines.push(
      `续跑: 从第 ${report.resume.from === null ? "?" : report.resume.from + 1} 站开始${skipped}` +
        (report.resume.note === "" ? "" : `（${report.resume.note}）`),
    );
  }
  for (const segment of report.segments) {
    lines.push(
      `段 ${segment.index + 1}「${segment.section}」${statusText(segment.status)} · ` +
        `${segment.stations.length} 站 · ${formatMs(segment.ms)}`,
    );
    for (const station of segment.stations) lines.push(formatStation(station));
  }
  if (report.segments.length === 0) lines.push("（没有段记录）");

  lines.push(
    `宝箱/隐藏道具: 计划 ${report.chests.planned}，开 ${report.chests.opened}，跳过 ${report.chests.skipped}`,
  );
  for (const item of report.chests.skippedItems) {
    const where =
      item.segment === null
        ? item.map === null
          ? "计划放弃"
          : `地图 ${item.map}`
        : `${whereText(item.segment, item.station)}${item.map === null ? "" : ` 地图 ${item.map}`}${item.cell === null ? "" : ` (${item.cell[0]},${item.cell[1]})`}`;
    lines.push(`  - ${where} ${item.item}: ${item.reason ?? "（没有记录原因）"}`);
  }

  const kinds = Object.entries(report.fallbacks.byKind)
    .map(([kind, count]) => `${kind} ${count}`)
    .join("、");
  lines.push(`兜底: ${report.fallbacks.total} 次${kinds === "" ? "" : ` (${kinds})`}`);
  for (const fallback of report.fallbacks.items) {
    lines.push(
      `  - ${fallback.kind} ${whereText(fallback.segment, fallback.station)}: ${fallback.reason}`,
    );
  }

  if (report.blocked !== null) {
    lines.push(`等待修复: ${report.blocked.where}：${report.blocked.reason}`);
  }

  const normal = report.battles.normal;
  const boss = report.battles.boss;
  lines.push(
    `战斗: ${report.battles.total} 场 (普通 ${normal.total}: 胜 ${normal.won} 负 ${normal.lost}；` +
      `首领 ${boss.total}: 胜 ${boss.won} 负 ${boss.lost})`,
  );
  for (const battle of report.battles.items) {
    lines.push(
      `  - ${battle.kind === "boss" ? "首领" : "普通"} ` +
        `${battle.enemies.length === 0 ? "敌人读不到" : battle.enemies.join("、")}: ` +
        `${battle.won ? "胜" : "负"} · ${formatMs(battle.ms)}`,
    );
  }
  if (report.battles.items.length === 0 && report.battles.total > 0) {
    lines.push(`  - （旧日志只有总数，没有逐场明细）`);
  }

  if (report.levels.length === 0) {
    lines.push("升级: 0 次");
  } else {
    lines.push(
      `升级: ${report.levels.length} 次 (` +
        report.levels
          .map((level) => `${level.member} ${level.from ?? "?"}→${level.to ?? "?"}`)
          .join("、") +
        ")",
    );
  }

  if (report.heals.length === 0) {
    lines.push("回复: 0 次");
  } else {
    lines.push(
      `回复: ${report.heals.length} 次 (` +
        report.heals
          .map(
            (heal) =>
              `${heal.beforeHp === null ? "?" : `${Math.round(heal.beforeHp)}%`}→` +
              (heal.afterHp === null ? "?" : `${Math.round(heal.afterHp)}%`) +
              (heal.used === "" ? "" : ` ${heal.used}`),
          )
          .join("；") +
        ")",
    );
  }

  if (report.buys.length > 0) {
    lines.push(
      `购买: ${report.buys.length} 次 (` +
        report.buys
          .map((buy) => `${buy.item}×${buy.count ?? "?"}(买到 ${buy.bought ?? "?"})`)
          .join("、") +
        ")",
    );
  }
  if (report.warnings.length > 0) {
    lines.push(`警告: ${report.warnings.join("；")}`);
  }
  return lines.join("\n");
}

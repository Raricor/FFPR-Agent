/**
 * Task 158: the chapter run summary is built from a hand-written structured log, so the counts
 * and Chinese reasons are checked without a bridge, game or model.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ChapterPlan, ChapterProgress } from "../src/engine/plan/chapter-types.ts";
import type { PlanStation } from "../src/engine/plan/types.ts";
import { buildChapterRunReport, formatChapterRunReport } from "../src/engine/plan/run-report.ts";
import type { RunEvent, RunEventInput } from "../src/engine/run-log.ts";

const execFileAsync = promisify(execFile);

function station(doIt: PlanStation["do"], to: string, why: string) {
  return { to, do: doIt, why };
}

function plan(): ChapterPlan {
  return {
    version: 1,
    chapter: 2,
    goal: "跑完第二章",
    segments: [
      {
        version: 1,
        section: "第一节",
        goal: "第一节目标",
        prep: { jobs: [], equip: "keep", buy: [], rows: [] },
        stations: [
          station("open", "10:2,2", "宝箱 帐篷"),
          station("move", "10:3,3", "走到"),
          station("boss", "10:9,9", "首领 风之水晶"),
        ],
        battle: [],
        bosses: [],
        turnBack: [],
      },
      {
        version: 1,
        section: "第二节",
        goal: "第二节目标",
        prep: { jobs: [], equip: "keep", buy: [], rows: [] },
        stations: [station("open", "11:4,4", "宝箱 眼药"), station("move", "11:5,5", "走到")],
        battle: [],
        bosses: [],
        turnBack: [],
      },
    ],
    growth: [],
    fallback: {
      retries: 1,
      bossLost: { levels: 2, where: null, tries: 2 },
      skipOptional: true,
      healBelowPct: 30,
    },
  };
}

function event(input: RunEventInput & { segment: number; station?: number }): RunEvent {
  const { segment, station, ...rest } = input;
  return {
    at: "2026-11-12T10:00:00.000Z",
    run: "r1",
    chapter: 2,
    segment,
    section: segment === 0 ? "第一节" : "第二节",
    station: station ?? null,
    ...rest,
  };
}

function sampleEvents(): RunEvent[] {
  return [
    event({ type: "run.start", segment: 0, note: "跑完第二章" }),
    event({ type: "segment.start", segment: 0 }),
    event({
      type: "station.start",
      segment: 0,
      station: 0,
      do: "open",
      to: "10:2,2",
      attempt: 1,
    }),
    event({
      type: "station.end",
      segment: 0,
      station: 0,
      do: "open",
      to: "10:2,2",
      result: "done",
      note: "开了帐篷",
      evidence: ["对话/剧情"],
      ms: 1200,
      attempt: 1,
    }),
    event({
      type: "chest",
      segment: 0,
      station: 0,
      map: 10,
      cell: [2, 2],
      item: "帐篷",
      opened: true,
      result: "done",
    }),
    event({
      type: "station.start",
      segment: 0,
      station: 1,
      do: "move",
      to: "10:3,3",
      attempt: 1,
    }),
    event({
      type: "station.end",
      segment: 0,
      station: 1,
      do: "move",
      to: "10:3,3",
      result: "done",
      note: "走到了",
      ms: 900,
      attempt: 1,
    }),
    event({
      type: "battle",
      segment: 0,
      station: 2,
      kind: "boss",
      enemies: ["风之水晶"],
      won: true,
      ms: 5000,
    }),
    event({
      type: "level",
      segment: 0,
      member: "巴兹",
      fromLevel: 10,
      toLevel: 11,
    }),
    event({
      type: "heal",
      segment: 0,
      station: 1,
      beforeHp: 20,
      afterHp: 100,
      used: "恢复药",
    }),
    event({ type: "segment.end", segment: 0, status: "done", ms: 8000 }),
    event({ type: "segment.start", segment: 1 }),
    event({ type: "resume", segment: 1, from: 0, skipped: [2], note: "续跑" }),
    event({
      type: "station.start",
      segment: 1,
      station: 0,
      do: "open",
      to: "11:4,4",
      attempt: 1,
    }),
    event({
      type: "station.end",
      segment: 1,
      station: 0,
      do: "open",
      to: "11:4,4",
      result: "skipped",
      note: "走不到 (4,4)",
      reason: "走不到 (4,4)",
      ms: 800,
      attempt: 1,
    }),
    event({
      type: "chest",
      segment: 1,
      station: 0,
      map: 11,
      cell: [4, 4],
      item: "眼药",
      opened: false,
      result: "skipped",
      reason: "走不到 (4,4)",
    }),
    event({
      type: "fallback",
      segment: 1,
      station: 0,
      kind: "skip",
      reason: "始终到不了，按兜底跳过:走不到 (4,4)",
    }),
    event({
      type: "station.start",
      segment: 1,
      station: 1,
      do: "move",
      to: "11:5,5",
      attempt: 1,
    }),
    event({
      type: "station.end",
      segment: 1,
      station: 1,
      do: "move",
      to: "11:5,5",
      result: "failed",
      note: "走不到地图 11",
      reason: "走不到地图 11",
      ms: 1500,
      attempt: 1,
    }),
    event({
      type: "fallback",
      segment: 1,
      station: 1,
      kind: "retry",
      reason: "换新路线重试 1/1",
    }),
    event({
      type: "blocked",
      segment: 1,
      station: 1,
      reason: "等待修复：第 2 节第 2 站：走不到地图 11",
    }),
    event({
      type: "run.end",
      segment: 1,
      station: 1,
      status: "exception",
      ms: 180_000,
      fallbacks: 2,
      modelCalls: 0,
      battles: 1,
      note: "走不到地图 11",
    }),
  ];
}

void test("a retried prefix keeps the first real evidence and time, and unstarted segments stay pending", () => {
  const progress: ChapterProgress = {
    game: "ff5",
    chapter: 2,
    goal: "跑完第二章",
    revision: 1,
    startedAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:03:00.000Z",
    finishedAt: null,
    status: "exception",
    segment: 0,
    segments: [
      {
        section: "第一节",
        stations: [
          { index: 0, status: "done", note: "开了帐篷" },
          { index: 1, status: "done", note: "走到了" },
          { index: 2, status: "pending", note: "" },
        ],
      },
      {
        section: "第二节",
        stations: [
          { index: 0, status: "pending", note: "" },
          { index: 1, status: "pending", note: "" },
        ],
      },
    ],
    fallbacks: [],
    previousException: null,
  };
  const events: RunEvent[] = [
    event({ type: "run.start", segment: 0, note: "跑完第二章" }),
    event({ type: "segment.start", segment: 0 }),
    event({ type: "station.start", segment: 0, station: 0, do: "open", to: "10:2,2", attempt: 1 }),
    event({
      type: "station.end",
      segment: 0,
      station: 0,
      do: "open",
      to: "10:2,2",
      result: "done",
      evidence: ["宝箱打开了", "对话/剧情"],
      note: "第 1 站 完成:开了帐篷",
      ms: 1200,
      attempt: 1,
    }),
    event({
      type: "chest",
      segment: 0,
      station: 0,
      map: 10,
      cell: [2, 2],
      item: "帐篷",
      opened: true,
      result: "done",
    }),
    event({ type: "station.start", segment: 0, station: 1, do: "move", to: "10:3,3", attempt: 1 }),
    event({
      type: "station.end",
      segment: 0,
      station: 1,
      do: "move",
      to: "10:3,3",
      result: "done",
      evidence: ["脚本移动", "开战"],
      note: "第 2 站 完成:剧情移动",
      ms: 53_269,
      attempt: 1,
    }),
    // The chapter's retry re-marks the finished prefix done before retrying station 3.
    event({
      type: "station.end",
      segment: 0,
      station: 0,
      do: "open",
      to: "10:2,2",
      result: "done",
      evidence: [],
      note: "重试前已完成，从这里接着走",
      ms: null,
      attempt: 0,
    }),
    event({
      type: "chest",
      segment: 0,
      station: 0,
      map: 10,
      cell: [2, 2],
      item: "帐篷",
      opened: true,
      result: "done",
      note: "重试前已完成，从这里接着走",
    }),
    event({
      type: "station.end",
      segment: 0,
      station: 1,
      do: "move",
      to: "10:3,3",
      result: "done",
      evidence: [],
      note: "重试前已完成，从这里接着走",
      ms: null,
      attempt: 0,
    }),
    event({ type: "segment.end", segment: 0, status: "done", ms: 8000 }),
    event({ type: "run.end", segment: 0, status: "done", ms: 180_000, modelCalls: 0 }),
  ];
  const report = buildChapterRunReport({
    game: "ff5",
    run: "r1",
    events,
    plan: plan(),
    progress,
  });
  const first = report.segments[0]?.stations[0];
  assert.ok(first !== undefined);
  assert.equal(first.result, "done");
  assert.deepEqual(first.evidence, ["宝箱打开了", "对话/剧情"]);
  assert.equal(first.ms, 1200);
  assert.match(first.note, /开了帐篷/u);
  assert.equal(first.attempts, 1);
  const second = report.segments[0]?.stations[1];
  assert.ok(second !== undefined);
  assert.deepEqual(second.evidence, ["脚本移动", "开战"]);
  assert.equal(second.ms, 53_269);
  assert.match(second.note, /剧情移动/u);
  const secondSegment = report.segments[1];
  assert.ok(secondSegment !== undefined);
  assert.equal(secondSegment.status, "pending");
  assert.ok(secondSegment.stations.every((station) => station.result === "pending"));
  assert.match(formatChapterRunReport(report), /段 2「第二节」pending/u);
});

void test("the report counts stations, chests, fallbacks, battles, levels and heals", () => {
  const report = buildChapterRunReport({
    game: "ff5",
    run: "r1",
    events: sampleEvents(),
    plan: plan(),
    progress: null,
  });
  assert.equal(report.chapter, 2);
  assert.equal(report.status, "exception");
  assert.equal(report.minutes, 3);
  assert.equal(report.modelCalls, 0);
  assert.deepEqual(report.fallbacks.byKind, { skip: 1, retry: 1 });
  assert.equal(report.fallbacks.total, 2);
  assert.equal(report.chests.planned, 2);
  assert.equal(report.chests.opened, 1);
  assert.equal(report.chests.skipped, 1);
  assert.match(report.chests.skippedItems[0]?.reason ?? "", /走不到 \(4,4\)/u);
  assert.equal(report.battles.total, 1);
  assert.equal(report.battles.boss.won, 1);
  assert.equal(report.levels.length, 1);
  assert.equal(report.heals.length, 1);
  assert.match(report.blocked?.reason ?? "", /走不到地图 11/u);
  const failed = report.segments[1]?.stations[1];
  assert.ok(failed !== undefined);
  assert.equal(failed.result, "failed");
  assert.equal(failed.attempts, 1);
  assert.match(failed.reason ?? "", /走不到地图 11/u);
  const skipped = report.segments[1]?.stations[0];
  assert.ok(skipped !== undefined);
  assert.equal(skipped.result, "skipped");
  assert.match(skipped.reason ?? "", /走不到 \(4,4\)/u);
  const text = formatChapterRunReport(report);
  assert.match(text, /宝箱\/隐藏道具: 计划 2，开 1，跳过 1/u);
  assert.match(text, /兜底: 2 次 \(skip 1、retry 1\)/u);
  assert.match(text, /等待修复: 第 2 节第 2 站：走不到地图 11/u);
  assert.match(text, /升级: 1 次/u);
  assert.match(text, /回复: 1 次/u);
});

void test("the report command prints the same counts as JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-report-"));
  try {
    const ds = join(directory, "ds");
    await mkdir(ds, { recursive: true });
    const events = sampleEvents();
    await writeFile(
      join(ds, "run-ff5.jsonl"),
      `${events.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(ds, "chapter-plan-ff5.json"),
      `${JSON.stringify({ game: "ff5", current: plan(), history: {} }, null, 2)}\n`,
      "utf8",
    );
    const script = fileURLToPath(new URL("../scripts/chapter-report.mts", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [
      script,
      "--deps",
      directory,
      "--game",
      "ff5",
      "--run",
      "r1",
      "--json",
    ]);
    const parsed: unknown = JSON.parse(stdout);
    assert.equal(typeof parsed, "object");
    const report = parsed as {
      chests: { opened: number };
      fallbacks: { total: number };
    };
    assert.equal(report.chests.opened, 1);
    assert.equal(report.fallbacks.total, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { comparisonRows } from "../scripts/metrics.ts";
import { collectSessionMetrics, metricsForLog } from "../src/engine/metrics.ts";

const START = Date.parse("2026-11-08T10:00:00.000Z");
const MINUTE = 60_000;

function at(minutes: number): number {
  return START + minutes * MINUTE;
}

function jsonl(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-metrics-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** dsh appends one zstd frame per event; the first frame is the session header line. */
function sessionBytes(id: string, lines: readonly string[]): Buffer {
  const header = JSON.stringify({
    type: "session",
    version: 4,
    id,
    createdAt: START,
    isSeeded: false,
  });
  return Buffer.concat(
    [header, ...lines].map((line) => zstdCompressSync(Buffer.from(`${line}\n`))),
  );
}

async function writeSession(dir: string, id: string, lines: readonly string[]): Promise<string> {
  const file = join(dir, "session.v4.jsonl.zstd");
  await writeFile(file, sessionBytes(id, lines));
  return file;
}

function event(type: string, seq: number, time: number, data: Record<string, unknown>): string {
  return JSON.stringify({ type, seq, time, data });
}

function user(seq: number, time: number, body: string, source = "user"): string {
  return event("user/message", seq, time, {
    content: [{ type: "text", text: body }],
    source: { kind: source },
  });
}

function call(seq: number, time: number, callId: string, name: string, args: unknown): string {
  return event("tool/call", seq, time, {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  });
}

function result(seq: number, time: number, callId: string, body: string, isError = false): string {
  return event("tool/result", seq, time, {
    turn: 1,
    step: 1,
    message: {
      role: "tool",
      toolCallId: callId,
      content: [{ type: "text", text: body }],
      isError,
    },
  });
}

function activity(time: number, body: string): Record<string, unknown> {
  return { at: new Date(time).toISOString(), game: "ff5", kind: "event", text: body };
}

function battle(
  id: number,
  started: number,
  ended: number,
  kind: string,
  resultText: string,
  mapId = 189,
  detail = "",
): Record<string, unknown> {
  return {
    id,
    game: "ff5",
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    mapId,
    mapName: "测试地图",
    kind,
    result: resultText,
    detail,
    seconds: Math.round((ended - started) / 1000),
  };
}

void test("direct user messages after the opening goal count as interventions", async (t) => {
  const dir = await tempDir(t);
  const lines = [
    user(1, at(0), "目标:去风之神殿", "user"),
    event("turn/start", 2, at(0), { turn: 1 }),
    event("step/start", 3, at(0), { turn: 1, step: 1 }),
    event("assistant/message", 4, at(1), {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "好" }] },
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
    user(5, at(10), "继续", "user"),
    user(6, at(15), "开始。当前状态:…", "ffpr-opening"),
    user(7, at(20), "先回城买药,然后再去风之神殿看看", "user"),
    event("step/end", 9, at(5), { turn: 1, step: 1 }),
    event("step/end", 10, at(25), { turn: 1, step: 1 }),
    event("turn/end", 8, at(30), { turn: 1, reason: { kind: "done" } }),
  ];
  const log = await writeSession(dir, "session-aaaa1111", lines);
  const metrics = await metricsForLog({ id: "session-aaaa1111", log });

  assert.equal(metrics.error, null);
  const totals = metrics.totals;
  assert.ok(totals);
  assert.equal(totals.activeHours, 0.5);
  assert.equal(totals.steps, 1);
  assert.equal(totals.turns, 1);
  assert.equal(totals.inputTokens, 100);
  assert.equal(totals.outputTokens, 20);
  const interventions = metrics.interventions;
  assert.ok(interventions);
  assert.equal(interventions.length, 2);
  assert.equal(interventions[0]?.kind, "继续");
  assert.equal(interventions[1]?.kind, "其他");
  const second = interventions[1];
  assert.ok(second);
  assert.ok(Array.from(second.text).length <= 40);
});

void test("activity, battles and tactician are cut by the session time window", async (t) => {
  const dir = await tempDir(t);
  const heartbeats = Array.from({ length: 23 }, (_, index) =>
    event("step/end", 100 + index, at((index + 1) * 5), { turn: 1, step: 1 }),
  );
  const log = await writeSession(dir, "session-bbbb2222", [
    user(1, at(0), "目标", "user"),
    ...heartbeats,
    event("turn/end", 2, at(120), { turn: 1, reason: { kind: "done" } }),
  ]);
  const activityFile = join(dir, "activity.jsonl");
  await writeFile(
    activityFile,
    jsonl([
      activity(at(-30), "地点 首次到达「太早」"),
      activity(at(30), "地点 首次到达「海盗船」"),
      activity(at(40), "首领 击败「哥布林」"),
      activity(at(50), "宝箱 地图 189:不死鸟之尾"),
      activity(at(60), "升级 巴兹 3→4"),
      activity(at(130), "宝箱 地图 189:太晚"),
    ]),
  );
  const battlesFile = join(dir, "battles.jsonl");
  await writeFile(
    battlesFile,
    jsonl([
      battle(1, at(20), at(21), "boss", "ok"),
      battle(2, at(70), at(72), "regular", "wipe", 577, "全员倒下"),
      battle(3, at(-40), at(-39), "regular", "ok"),
    ]),
  );
  const tacticianFile = join(dir, "tactician.jsonl");
  await writeFile(
    tacticianFile,
    jsonl([
      {
        at: new Date(at(10)).toISOString(),
        mapId: 189,
        kind: "new-map",
        detail: "",
        tables: 1,
        problems: [],
        walkerFirst: "",
      },
      {
        at: new Date(at(80)).toISOString(),
        mapId: 577,
        kind: "boss",
        detail: "",
        tables: 1,
        problems: [],
        walkerFirst: "",
      },
      {
        at: new Date(at(-10)).toISOString(),
        mapId: 189,
        kind: "new-map",
        detail: "",
        tables: 1,
        problems: [],
        walkerFirst: "",
      },
    ]),
  );

  const metrics = await metricsForLog({
    id: "session-bbbb2222",
    log,
    activityFile,
    battlesFiles: [battlesFile],
    tacticianFile,
  });
  const progress = metrics.progress;
  assert.ok(progress);
  assert.equal(progress.locations, 1);
  assert.equal(progress.bosses, 1);
  assert.equal(progress.chests, 1);
  assert.equal(progress.maxLevel, 4);
  assert.equal(progress.perHour.locations, 0.5);
  const battles = metrics.battles;
  assert.ok(battles);
  assert.equal(battles.total, 2);
  assert.equal(battles.wins, 1);
  assert.equal(battles.wipes, 1);
  assert.equal(battles.storyWipes, 1);
  assert.equal(battles.bossTotal, 1);
  assert.equal(battles.bossLosses, 0);
  assert.equal(battles.winRate, 0.5);
  const tactician = metrics.tactician;
  assert.ok(tactician);
  assert.equal(tactician.total, 2);
  assert.deepEqual(tactician.byKind, { boss: 1, "new-map": 1 });
});

void test("active duration skips a three-day idle gap but the event range stays wide", async (t) => {
  const dir = await tempDir(t);
  const day = 24 * 60;
  const log = await writeSession(dir, "session-7777cccc", [
    user(1, at(0), "目标", "user"),
    event("step/end", 2, at(1), { turn: 1, step: 1 }),
    event("step/end", 3, at(day * 3), { turn: 1, step: 1 }),
    event("turn/end", 4, at(day * 3 + 1), { turn: 1, reason: { kind: "done" } }),
  ]);
  const activityFile = join(dir, "activity.jsonl");
  await writeFile(activityFile, jsonl([activity(at(day * 3), "地点 首次到达「三天后」")]));
  const metrics = await metricsForLog({ id: "session-7777cccc", log, activityFile });
  const totals = metrics.totals;
  assert.ok(totals);
  assert.ok(Math.abs((totals.activeHours ?? 0) - 2 / 60) < 1e-9);
  const start = Date.parse(totals.start ?? "");
  const end = Date.parse(totals.end ?? "");
  assert.equal(end - start, (day * 3 + 1) * MINUTE);
  const progress = metrics.progress;
  assert.ok(progress);
  assert.equal(progress.perHour.locations, 30);
});

void test("tool rows align by tool name across sessions with different tools", async (t) => {
  const dir = await tempDir(t);
  const dirA = join(dir, "a");
  const dirB = join(dir, "b");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  const logA = await writeSession(dirA, "session-1111dddd", [
    user(1, at(0), "目标", "user"),
    call(2, at(1), "c1", "go", { to: [1, 2] }),
    result(3, at(2), "c1", "(0, 0) → (1, 2):3 格"),
    event("turn/end", 4, at(3), { turn: 1, reason: { kind: "done" } }),
  ]);
  const logB = await writeSession(dirB, "session-2222eeee", [
    user(1, at(0), "目标", "user"),
    call(2, at(1), "c1", "walk_to", { x: 1, y: 2 }),
    result(3, at(2), "c1", "(0, 0) → (1, 2):3 格"),
    event("turn/end", 4, at(3), { turn: 1, reason: { kind: "done" } }),
  ]);
  const first = await metricsForLog({ id: "session-1111dddd", log: logA });
  const second = await metricsForLog({ id: "session-2222eeee", log: logB });
  const table = comparisonRows([first, second]);
  const rowsA = table[0];
  const rowsB = table[1];
  assert.ok(rowsA);
  assert.ok(rowsB);
  assert.equal(rowsA.length, rowsB.length);
  for (let index = 0; index < rowsA.length; index += 1) {
    assert.equal(rowsA[index]?.[0], rowsB[index]?.[0]);
  }
  const valueOf = (rows: [string, string][], label: string): string => {
    const found = rows.find(([name]) => name === label);
    assert.ok(found);
    return found[1];
  };
  assert.equal(valueOf(rowsA, "工具 go(坐标)"), "1 次 / 失败 0");
  assert.equal(valueOf(rowsB, "工具 go(坐标)"), "无");
  assert.equal(valueOf(rowsA, "工具 walk_to"), "无");
  assert.equal(valueOf(rowsB, "工具 walk_to"), "1 次 / 失败 0");
});

void test("repeated guide queries and same-argument failures are counted", async (t) => {
  const dir = await tempDir(t);
  const lines = [
    user(1, at(0), "目标", "user"),
    call(2, at(1), "c1", "guide", { query: "风之神殿" }),
    result(3, at(1), "c1", '{"ok":true}'),
    call(4, at(2), "c2", "guide", { query: "风之神殿" }),
    result(5, at(2), "c2", '{"ok":true}'),
    call(6, at(3), "c3", "guide", { query: "海盗据点", kind: "treasure" }),
    result(7, at(3), "c3", '{"ok":true}'),
    call(8, at(4), "c4", "terrain", { radius: 8 }),
    result(9, at(4), "c4", '{"ok":false,"error":"读不到"}'),
    call(10, at(5), "c5", "terrain", { radius: 8 }),
    result(11, at(5), "c5", "工具出错:还是读不到", true),
    call(12, at(6), "c6", "terrain", { radius: 8 }),
    result(13, at(6), "c6", '{"ok":true}'),
    event("turn/end", 14, at(10), { turn: 1, reason: { kind: "done" } }),
  ];
  const log = await writeSession(dir, "session-cccc3333", lines);
  const metrics = await metricsForLog({ id: "session-cccc3333", log });

  const repetition = metrics.repetition;
  assert.ok(repetition);
  assert.equal(repetition.guideCalls, 3);
  assert.equal(repetition.guideDistinct, 2);
  assert.equal(repetition.guideRepeats.length, 1);
  assert.equal(repetition.guideRepeats[0]?.count, 2);
  assert.equal(repetition.failureRetries, 1);
  assert.equal(repetition.longestFailureStreak, 2);
  assert.equal(repetition.failureRepeats.length, 1);
  const failure = repetition.failureRepeats[0];
  assert.ok(failure);
  assert.equal(failure.name, "terrain");
  assert.equal(failure.retries, 1);
  const tools = metrics.tools;
  assert.ok(tools);
  const terrain = tools.find((tool) => tool.name === "terrain");
  assert.deepEqual(terrain, { name: "terrain", calls: 3, failures: 2 });
});

void test("walkpath seconds per cell come from result cell lines and the timing log", async (t) => {
  const dir = await tempDir(t);
  const log = await writeSession(dir, "session-dddd4444", [
    user(1, at(0), "目标", "user"),
    call(2, at(1), "c1", "go", { to: [10, 10] }),
    result(3, at(2), "c1", "  (1, 2) → (10, 10):14 格\n到达 (10, 10)"),
    call(4, at(2), "c2", "go", { to: "风之神殿" }),
    result(5, at(3), "c2", "走了 1 跳:\n停在:地图 189 (1, 2)"),
    event("turn/end", 6, at(10), { turn: 1, reason: { kind: "done" } }),
  ]);
  const timingFile = join(dir, "timing.jsonl");
  await writeFile(
    timingFile,
    jsonl([
      { t: new Date(at(1)).toISOString(), op: "walkpath", via: "lan", ms: 3000 },
      { t: new Date(at(2)).toISOString(), op: "walkpath", via: "lan", ms: 2000 },
      { t: new Date(at(-5)).toISOString(), op: "walkpath", via: "lan", ms: 100000 },
      { t: new Date(at(2)).toISOString(), op: "pos", via: "lan", ms: 1 },
    ]),
  );
  const metrics = await metricsForLog({ id: "session-dddd4444", log, timingFile });
  const walking = metrics.walking;
  assert.ok(walking);
  assert.equal(walking.tool, "go");
  assert.equal(walking.calls, 2);
  assert.equal(walking.mapCalls, 1);
  assert.equal(walking.cellCalls, 1);
  assert.equal(walking.cells, 14);
  assert.equal(walking.walkOp, "walkpath");
  assert.equal(walking.walkCount, 2);
  assert.equal(walking.walkSeconds, 5);
  assert.equal(walking.secondsPerCell, 0.357);
});

void test("old walk timing and walk_to results use the same cell accounting", async (t) => {
  const dir = await tempDir(t);
  const log = await writeSession(dir, "session-eeee5555", [
    user(1, at(0), "目标", "user"),
    call(2, at(1), "c1", "walk_to", { x: 20, y: 20 }),
    result(3, at(2), "c1", "(0, 0) → (20, 20):20 格"),
    event("turn/end", 4, at(5), { turn: 1, reason: { kind: "done" } }),
  ]);
  const timingFile = join(dir, "timing.jsonl");
  await writeFile(
    timingFile,
    jsonl([{ t: new Date(at(1)).toISOString(), op: "walk", via: "ssh", ms: 4000 }]),
  );
  const metrics = await metricsForLog({ id: "session-eeee5555", log, timingFile });
  const walking = metrics.walking;
  assert.ok(walking);
  assert.equal(walking.tool, "walk_to");
  assert.equal(walking.walkOp, "walk");
  assert.equal(walking.secondsPerCell, 0.2);
});

void test("wipes are counted and the story wipe is listed separately", async (t) => {
  const dir = await tempDir(t);
  const log = await writeSession(dir, "session-ffff6666", [
    user(1, at(0), "目标", "user"),
    event("turn/end", 2, at(60), { turn: 1, reason: { kind: "done" } }),
  ]);
  const battlesFile = join(dir, "battles.jsonl");
  await writeFile(
    battlesFile,
    jsonl([
      battle(1, at(10), at(11), "regular", "ok"),
      battle(2, at(20), at(21), "regular", "hard"),
      battle(3, at(30), at(31), "regular", "wipe", 577, "全员倒下"),
      battle(4, at(40), at(41), "boss", "wipe", 205, "首领战全灭"),
    ]),
  );
  const metrics = await metricsForLog({ id: "session-ffff6666", log, battlesFiles: [battlesFile] });
  const battles = metrics.battles;
  assert.ok(battles);
  assert.equal(battles.total, 4);
  assert.equal(battles.wins, 2);
  assert.equal(battles.winRate, 0.5);
  assert.equal(battles.wipes, 2);
  assert.equal(battles.storyWipes, 1);
  assert.equal(battles.bossTotal, 1);
  assert.equal(battles.bossLosses, 1);
});

void test("rotated battle files dedupe only the same battle, not a reused id", async (t) => {
  const dir = await tempDir(t);
  const log = await writeSession(dir, "session-8888bbbb", [
    user(1, at(0), "目标", "user"),
    event("turn/end", 2, at(60), { turn: 1, reason: { kind: "done" } }),
  ]);
  const current = join(dir, "battles.jsonl");
  await writeFile(
    current,
    jsonl([battle(1, at(10), at(11), "regular", "ok"), battle(2, at(20), at(21), "boss", "ok")]),
  );
  const backup = join(dir, "battles.jsonl.bak-20261105");
  await writeFile(
    backup,
    jsonl([battle(1, at(10), at(11), "regular", "ok"), battle(1, at(30), at(31), "regular", "ok")]),
  );
  const metrics = await metricsForLog({
    id: "session-8888bbbb",
    log,
    battlesFiles: [current, backup],
  });
  assert.equal(metrics.battles?.total, 3);
});

void test("missing source files leave null metrics instead of failing", async (t) => {
  const dir = await tempDir(t);
  const log = await writeSession(dir, "session-9999aaaa", [user(1, at(0), "目标", "user")]);
  const metrics = await metricsForLog({
    id: "session-9999aaaa",
    log,
    activityFile: join(dir, "missing-activity.jsonl"),
    battlesFiles: [join(dir, "missing-battles.jsonl")],
    tacticianFile: join(dir, "missing-tactician.jsonl"),
    timingFile: join(dir, "missing-timing.jsonl"),
  });
  assert.equal(metrics.error, null);
  assert.equal(metrics.progress, null);
  assert.equal(metrics.battles, null);
  assert.equal(metrics.tactician, null);
  const walking = metrics.walking;
  assert.ok(walking);
  assert.equal(walking.walkCount, null);
  assert.equal(walking.secondsPerCell, null);

  const broken = await metricsForLog({ id: "broken", log: join(dir, "nope.zstd") });
  assert.notEqual(broken.error, null);
  assert.equal(broken.totals, null);
  assert.equal(broken.tools, null);
});

void test("an eight-character prefix resolves a session directory", async (t) => {
  const dir = await tempDir(t);
  const id = "session-1234abcd-5678";
  const sessionDir = join(dir, "sessions", "--root-data-FFPR-Agent--", id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "session.v4.jsonl.zstd"),
    sessionBytes(id, [user(1, at(0), "目标", "user")]),
  );
  const metrics = await collectSessionMetrics("1234abcd", {
    sessionsRoot: join(dir, "sessions"),
    depsDir: join(dir, ".deps"),
  });
  assert.equal(metrics.id, id);
  assert.equal(metrics.error, null);
  const totals = metrics.totals;
  assert.ok(totals);
  assert.equal(totals.turns, 0);
});

void test("coordinate/map go, route and the stage plan gate are counted separately", async (t) => {
  const dir = await tempDir(t);
  const log = await writeSession(dir, "session-1010aaaa", [
    user(1, at(0), "目标", "user"),
    call(2, at(1), "c1", "go", { to: [1, 2] }),
    result(3, at(2), "c1", "阶段计划拦下：这一段还在进行"),
    call(4, at(3), "c2", "go", { to: [3, 4], leave_incomplete: "要先踩触发格" }),
    result(5, at(4), "c2", "到了 (3, 4)\n阶段计划放行：带理由走坐标"),
    call(6, at(5), "c3", "go", { to: "风之神殿" }),
    result(7, at(6), "c3", "走了 1 跳"),
    call(8, at(7), "c4", "route", { stops: [{ to: [5, 6] }] }),
    result(9, at(8), "c4", "route 完成"),
    call(10, at(9), "c5", "go", { to: "62:7,8" }),
    result(11, at(10), "c5", "阶段计划拦下：坐标"),
    event("turn/end", 12, at(20), { turn: 1, reason: { kind: "done" } }),
  ]);
  const metrics = await metricsForLog({ id: "session-1010aaaa", log });
  assert.deepEqual(metrics.planGo, { blocked: 2, allowed: 1 });
  const tools = metrics.tools;
  assert.ok(tools);
  const byName = (name: string): number => tools.find((tool) => tool.name === name)?.calls ?? 0;
  assert.equal(byName("go(坐标)"), 3);
  assert.equal(byName("go(地图)"), 1);
  assert.equal(byName("route"), 1);
  const rows = comparisonRows([metrics])[0];
  assert.ok(rows);
  assert.equal(rows.find(([name]) => name === "计划拦 go")?.[1], "2");
  assert.equal(rows.find(([name]) => name === "计划放行 go")?.[1], "1");
});

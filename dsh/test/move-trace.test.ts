import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendMoveTrace,
  compactMoveTrace,
  MOVE_TRACE_HEAD,
  MOVE_TRACE_REPLANS,
  moveTracePath,
  tracePathFor,
  type MoveTraceEntry,
  type MoveTraceReplan,
} from "../src/engine/skills/move-trace.ts";

function replan(index: number): MoveTraceReplan {
  return {
    at: `2026-11-10T14:${String(index % 60).padStart(2, "0")}:00.000Z`,
    cell: [index, 0],
    map: 260,
    length: index + 1,
    reason: `第 ${index} 次`,
    cuts: index % 2 === 0 ? [`${index},0>${index + 1},0`] : [],
  };
}

function entry(count: number): MoveTraceEntry {
  return {
    at: "2026-11-10T14:00:00.000Z",
    game: "ff5",
    start: { map: 260, cell: [0, 0] },
    goal: [10, 10],
    byShip: false,
    legs: 8,
    replans: Array.from({ length: count }, (_, index) => replan(index)),
    end: {
      at: "2026-11-10T14:10:00.000Z",
      reason: "stalled",
      reached: false,
      elapsedMs: 600_000,
      best: { cell: [5, 5], distance: 7 },
      cuts: ["1,0>2,0"],
    },
  };
}

void test("the default trace path uses the game key under .deps/ds", () => {
  assert.match(moveTracePath("ff5"), /\.deps\/ds\/move-trace-ff5\.jsonl$/);
  assert.equal(tracePathFor("ff5", undefined), moveTracePath("ff5"));
  assert.equal(tracePathFor("ff5", null), null);
  assert.equal(tracePathFor(undefined, undefined), null, "a bare plan writes nothing");
});

void test("a long trace keeps the first and last replans and counts the dropped", () => {
  const compact = compactMoveTrace(entry(100));
  assert.equal(compact.replans.length, MOVE_TRACE_REPLANS);
  assert.equal(compact.omitted, 100 - MOVE_TRACE_REPLANS);
  assert.equal(compact.replans[0]?.cell?.[0], 0);
  assert.equal(compact.replans[MOVE_TRACE_HEAD - 1]?.cell?.[0], MOVE_TRACE_HEAD - 1);
  assert.equal(compact.replans[compact.replans.length - 1]?.cell?.[0], 99);
});

void test("one append writes one parseable JSON line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-trace-"));
  const file = join(directory, "move-trace.jsonl");
  try {
    assert.equal(await appendMoveTrace(entry(2), file), true);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? "") as MoveTraceEntry;
    assert.equal(parsed.game, "ff5");
    assert.equal(parsed.replans.length, 2);
    assert.deepEqual(parsed.end.best, { cell: [5, 5], distance: 7 });
    assert.deepEqual(parsed.end.cuts, ["1,0>2,0"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a failed trace write reports one warning and returns false", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-trace-fail-"));
  const blocker = join(directory, "file");
  try {
    await writeFile(blocker, "not a directory", "utf8");
    const warnings: string[] = [];
    const wrote = await appendMoveTrace(entry(1), join(blocker, "trace.jsonl"), (line) => {
      warnings.push(line);
    });
    assert.equal(wrote, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /写不了移动轨迹/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

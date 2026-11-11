import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SEGMENT_PLAN_HISTORY_LIMIT,
  SegmentPlanStore,
  readSegmentPlan,
  readSegmentProgress,
  segmentPlanPath,
  segmentProgressPath,
  writeSegmentProgress,
} from "../src/engine/plan/store.ts";
import type { SegmentPlan, SegmentProgress } from "../src/engine/plan/types.ts";

function plan(section: string, goal: string): SegmentPlan {
  return {
    version: 1,
    section,
    goal,
    prep: { jobs: [], equip: "keep", buy: [], rows: [] },
    stations: [{ to: "10", do: "move" }],
    battle: [],
    bosses: [],
    turnBack: [],
  };
}

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ffpr-plan-"));
}

void test("missing file is an empty store and the path helper points at .deps/ds", async () => {
  const dir = await temporary();
  try {
    const store = await SegmentPlanStore.load("ff5", join(dir, "none.json"));
    assert.equal(store.current, null);
    assert.deepEqual(store.historyFor("Wind Shrine"), []);
    assert.equal(segmentPlanPath("ff5", dir), join(dir, "ds", "segment-plan-ff5.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("save keeps the current plan and five versions per section", async () => {
  const dir = await temporary();
  const path = join(dir, "segment-plan-ff5.json");
  try {
    const store = await SegmentPlanStore.load("ff5", path);
    for (let index = 0; index < 7; index += 1) {
      await store.save(plan("Wind Shrine", `第 ${index} 版`));
    }
    await store.save(plan("Tule", "另一节"));
    assert.equal(store.historyFor("Wind Shrine").length, SEGMENT_PLAN_HISTORY_LIMIT);
    assert.equal(store.historyFor("Wind Shrine")[0]?.goal, "第 2 版");
    assert.equal(store.current?.section, "Tule");

    const loaded = await SegmentPlanStore.load("ff5", path);
    const current = loaded.current;
    assert.ok(current !== null);
    assert.equal(current.section, "Tule");
    assert.equal(current.goal, "另一节");
    assert.deepEqual(
      loaded.historyFor("Wind Shrine").map((entry) => entry.goal),
      ["第 2 版", "第 3 版", "第 4 版", "第 5 版", "第 6 版"],
    );
    assert.equal((await readSegmentPlan("ff5", path))?.section, "Tule");

    const body: unknown = JSON.parse(await readFile(path, "utf8"));
    assert.equal(typeof body, "object");
    assert.match(await readFile(path, "utf8"), /"game": "ff5"/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a malformed file gives a Chinese error instead of crashing", async () => {
  const dir = await temporary();
  try {
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json", "utf8");
    await assert.rejects(() => SegmentPlanStore.load("ff5", path), /读不懂段计划/u);
    await writeFile(path, "[]", "utf8");
    await assert.rejects(() => SegmentPlanStore.load("ff5", path), /不是 JSON 对象/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("one bad plan version is skipped; the rest still loads", async () => {
  const dir = await temporary();
  const path = join(dir, "segment-plan-ff5.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        game: "ff5",
        current: plan("Wind Shrine", "当前"),
        history: {
          "Wind Shrine": [plan("Wind Shrine", "好的一版"), { version: 1, section: "Wind Shrine" }],
        },
      }),
      "utf8",
    );
    const store = await SegmentPlanStore.load("ff5", path);
    assert.equal(store.current?.goal, "当前");
    assert.deepEqual(
      store.historyFor("Wind Shrine").map((entry) => entry.goal),
      ["好的一版"],
    );
    assert.match(store.problems.join("\n"), /格式不对/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function progress(section: string, revision: number): SegmentProgress {
  const at = "2026-11-11T00:00:00.000Z";
  return {
    game: "ff5",
    section,
    goal: `走完${section}`,
    revision,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    status: "running",
    stations: [{ index: 0, status: "pending", note: "第 1 站" }],
    previousException: null,
  };
}

void test("segment progress round-trips and the path helper names the file", async () => {
  const dir = await temporary();
  try {
    const path = segmentProgressPath("ff5", dir);
    assert.equal(path, join(dir, "ds", "segment-progress-ff5.json"));
    await writeSegmentProgress(path, progress("风之神殿", 2));
    const loaded = await readSegmentProgress(path);
    assert.ok(loaded !== null);
    assert.equal(loaded.section, "风之神殿");
    assert.equal(loaded.revision, 2);
    assert.equal(loaded.stations[0]?.note, "第 1 站");
    assert.equal(await readSegmentProgress(join(dir, "missing.json")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a malformed progress file gives a Chinese error", async () => {
  const dir = await temporary();
  try {
    const path = join(dir, "progress.json");
    await writeFile(path, "{not json", "utf8");
    await assert.rejects(() => readSegmentProgress(path), /读不懂段进度/u);
    await writeFile(path, JSON.stringify({ section: "风之神殿" }), "utf8");
    await assert.rejects(() => readSegmentProgress(path), /缺少 section 或 revision/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

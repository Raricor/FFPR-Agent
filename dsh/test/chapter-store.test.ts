import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHAPTER_PLAN_HISTORY_LIMIT,
  ChapterDraftStore,
  ChapterPlanStore,
  chapterDraftPath,
  chapterPlanPath,
  readChapterPlan,
} from "../src/engine/plan/chapter-store.ts";
import type { ChapterDraftMeta } from "../src/engine/plan/chapter-store.ts";
import type { ChapterPlan } from "../src/engine/plan/chapter-types.ts";
import { testChapterPlan, testSegmentPlan } from "./chapter-fixture.ts";

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ffpr-chapter-"));
}

function meta(): ChapterDraftMeta {
  return {
    chapter: 1,
    goal: "走完第一章",
    growth: [{ before: 0, level: 10, where: "10:3,3", why: "先练级", maxMinutes: 10 }],
    fallback: {
      retries: 2,
      bossLost: { levels: 1, where: "10:3,3", tries: 1 },
      skipOptional: true,
      healBelowPct: 30,
    },
    skipped: [{ kind: "chest", name: "恢复药", where: "10:1,1", why: "拿过了" }],
    notes: "测试草稿",
  };
}

void test("the path helpers point at .deps/ds chapter files", () => {
  assert.equal(chapterDraftPath("ff5", "/deps"), join("/deps", "ds", "chapter-draft-ff5.json"));
  assert.equal(chapterPlanPath("ff5", "/deps"), join("/deps", "ds", "chapter-plan-ff5.json"));
});

void test("a missing draft and a missing plan are empty stores", async () => {
  const dir = await temporary();
  try {
    const draft = await ChapterDraftStore.load("ff5", join(dir, "none.json"));
    assert.equal(draft.chapter, null);
    assert.deepEqual(draft.segmentEntries(), []);
    const plan = await ChapterPlanStore.load("ff5", join(dir, "none.json"));
    assert.equal(plan.current, null);
    assert.equal(await readChapterPlan("ff5", join(dir, "none.json")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("draft segments overwrite the same index and assemble with meta", async () => {
  const dir = await temporary();
  const path = join(dir, "chapter-draft-ff5.json");
  try {
    const draft = await ChapterDraftStore.load("ff5", path);
    await draft.setSegment(0, testSegmentPlan("第一迷宫", []));
    await draft.setSegment(1, testSegmentPlan("第二迷宫", []));
    await draft.setSegment(0, testSegmentPlan("第一迷宫", [], { goal: "改过的第一段" }));
    await draft.setMeta(meta());
    assert.equal(draft.segmentEntries().length, 2);
    assert.equal(draft.segmentAt(0)?.goal, "改过的第一段");

    const loaded = await ChapterDraftStore.load("ff5", path);
    assert.equal(loaded.chapter, 1);
    assert.equal(loaded.goal, "走完第一章");
    assert.equal(loaded.growth.length, 1);
    assert.equal(loaded.fallback?.retries, 2);
    assert.equal(loaded.skipped[0]?.name, "恢复药");
    assert.equal(loaded.notes, "测试草稿");
    const assembled = loaded.toPlan();
    assert.deepEqual(assembled.problems, []);
    assert.ok(assembled.plan !== null);
    assert.equal(assembled.plan.segments.length, 2);
    assert.equal(assembled.plan.skipped?.[0]?.why, "拿过了");

    await loaded.clear();
    const empty = await ChapterDraftStore.load("ff5", path);
    assert.equal(empty.chapter, null);
    assert.deepEqual(empty.segmentEntries(), []);
    assert.equal(empty.fallback, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a draft with a hole lists the missing segment index", async () => {
  const dir = await temporary();
  try {
    const draft = await ChapterDraftStore.load("ff5", join(dir, "draft.json"));
    await draft.setSegment(0, testSegmentPlan("第一迷宫", []));
    await draft.setSegment(2, testSegmentPlan("第三迷宫", []));
    await draft.setMeta(meta());
    const assembly = draft.toPlan();
    assert.equal(assembly.plan, null);
    assert.match(assembly.problems.join("\n"), /第 2 段/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("plan store keeps the current plan and five versions per chapter", async () => {
  const dir = await temporary();
  const path = join(dir, "chapter-plan-ff5.json");
  try {
    const store = await ChapterPlanStore.load("ff5", path);
    for (let index = 0; index < 7; index += 1) {
      const plan: ChapterPlan = {
        ...testChapterPlan(),
        goal: `第 ${index} 版`,
      };
      await store.save(plan);
    }
    assert.equal(store.historyFor(1).length, CHAPTER_PLAN_HISTORY_LIMIT);
    assert.equal(store.historyFor(1)[0]?.goal, "第 2 版");
    assert.equal(store.current?.goal, "第 6 版");

    const loaded = await ChapterPlanStore.load("ff5", path);
    assert.ok(loaded.current !== null);
    assert.equal(loaded.current.chapter, 1);
    assert.equal(loaded.current.goal, "第 6 版");
    assert.deepEqual(
      loaded.historyFor(1).map((plan) => plan.goal),
      ["第 2 版", "第 3 版", "第 4 版", "第 5 版", "第 6 版"],
    );
    assert.equal((await readChapterPlan("ff5", path))?.goal, "第 6 版");
    assert.match(await readFile(path, "utf8"), /"game": "ff5"/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a malformed draft file gives a Chinese error", async () => {
  const dir = await temporary();
  try {
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json", "utf8");
    await assert.rejects(() => ChapterDraftStore.load("ff5", path), /读不懂章草稿/u);
    await writeFile(path, "[]", "utf8");
    await assert.rejects(() => ChapterDraftStore.load("ff5", path), /不是 JSON 对象/u);
    await writeFile(path, JSON.stringify({ chapter: "一" }), "utf8");
    await assert.rejects(() => ChapterDraftStore.load("ff5", path), /chapter 不是正整数/u);
    await writeFile(path, JSON.stringify({ segments: [] }), "utf8");
    await assert.rejects(() => ChapterDraftStore.load("ff5", path), /segments 不是对象/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a malformed plan file gives a Chinese error and one bad version is skipped", async () => {
  const dir = await temporary();
  const path = join(dir, "chapter-plan-ff5.json");
  try {
    await writeFile(path, "{not json", "utf8");
    await assert.rejects(() => ChapterPlanStore.load("ff5", path), /读不懂章计划/u);
    await writeFile(path, "[]", "utf8");
    await assert.rejects(() => ChapterPlanStore.load("ff5", path), /不是 JSON 对象/u);
    await writeFile(
      path,
      JSON.stringify({
        game: "ff5",
        current: testChapterPlan(),
        history: { "1": [testChapterPlan(), { version: 1, chapter: 1 }] },
      }),
      "utf8",
    );
    const store = await ChapterPlanStore.load("ff5", path);
    assert.equal(store.current?.chapter, 1);
    assert.equal(store.historyFor(1).length, 1);
    assert.match(store.problems.join("\n"), /格式不对/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

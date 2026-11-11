import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import test from "node:test";
import {
  ChapterDraftStore,
  ChapterPlanStore,
  chapterDraftPath,
  chapterPlanPath,
} from "../src/engine/plan/chapter-store.ts";
import type { ChapterPlan } from "../src/engine/plan/chapter-types.ts";
import {
  CHAPTER_DRAFT_META_TOOL,
  CHAPTER_DRAFT_SEGMENT_TOOL,
  CHAPTER_FACTS_TOOL,
  CHAPTER_SEGMENT_PARAMETERS,
  CHAPTER_STATUS_TOOL,
  CHAPTER_TOOL_DEFINITIONS,
  READ_GUIDE_TOOL,
  SUBMIT_CHAPTER_PLAN_TOOL,
  handleChapterDraftMeta,
  handleChapterDraftSegment,
  handleChapterFacts,
  handleChapterStatus,
  handleReadGuide,
  handleSubmitChapterPlan,
  type ChapterToolPorts,
} from "../src/engine/plan/chapter-tools.ts";
import { testChapterFacts, testChapterPlan } from "./chapter-fixture.ts";
import type { DryRunResult } from "../src/engine/plan/dry-run.ts";

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ffpr-chapter-tools-"));
}

function ports(dir: string, dryRun?: DryRunResult): ChapterToolPorts {
  const draftPath = chapterDraftPath("ff5", dir);
  const planPath = chapterPlanPath("ff5", dir);
  return {
    facts: (chapter) =>
      Promise.resolve({
        data: testChapterFacts(),
        text: `章事实:${String(chapter)}`,
      }),
    guide: (section) => Promise.resolve(`攻略原文:${section}`),
    draft: () => ChapterDraftStore.load("ff5", draftPath),
    savePlan: async (plan) => {
      const store = await ChapterPlanStore.load("ff5", planPath);
      await store.save(plan);
    },
    currentPlan: async () => (await ChapterPlanStore.load("ff5", planPath)).current,
    ...(dryRun === undefined ? {} : { dryRun: () => Promise.resolve(dryRun) }),
  };
}

function metaArgs(plan: ChapterPlan): Record<string, unknown> {
  return {
    chapter: plan.chapter,
    goal: plan.goal,
    growth: plan.growth,
    fallback: plan.fallback,
    ...(plan.skipped === undefined ? {} : { skipped: plan.skipped }),
  };
}

async function draftFull(
  portsValue: ChapterToolPorts,
  plan: ChapterPlan,
  allowProblems = false,
): Promise<void> {
  const meta = await handleChapterDraftMeta(portsValue, metaArgs(plan));
  assert.notEqual(meta.text, undefined);
  for (const [index, segment] of plan.segments.entries()) {
    const answer = await handleChapterDraftSegment(portsValue, {
      index,
      plan: segment,
    });
    if (!allowProblems) assert.equal(answer.problems?.length ?? 0, 0);
  }
}

void test("all six chapter tool schemas use the subset dsh accepts", () => {
  for (const tool of CHAPTER_TOOL_DEFINITIONS) {
    assertSupportedJsonSchema(tool.parameters);
  }
  assertSupportedJsonSchema(CHAPTER_SEGMENT_PARAMETERS);
  assert.deepEqual(
    CHAPTER_TOOL_DEFINITIONS.map((tool) => tool.name),
    [
      "chapter_facts",
      "read_guide",
      "chapter_draft_segment",
      "chapter_draft_meta",
      "submit_chapter_plan",
      "chapter_status",
    ],
  );
  assert.deepEqual(CHAPTER_DRAFT_META_TOOL.parameters.required, [
    "chapter",
    "goal",
    "growth",
    "fallback",
  ]);
  const stations = CHAPTER_DRAFT_SEGMENT_TOOL.parameters;
  assert.equal(typeof stations, "object");
  assert.equal(READ_GUIDE_TOOL.name, "read_guide");
  assert.equal(CHAPTER_FACTS_TOOL.name, "chapter_facts");
  assert.equal(SUBMIT_CHAPTER_PLAN_TOOL.name, "submit_chapter_plan");
  assert.equal(CHAPTER_STATUS_TOOL.name, "chapter_status");
});

void test("the segment schema accepts buy stations with items", () => {
  const schema = JSON.stringify(CHAPTER_SEGMENT_PARAMETERS);
  assert.match(schema, /"buy"/u);
  assert.match(schema, /"items"/u);
});

void test("chapter_facts and read_guide return port text", async () => {
  const dir = await temporary();
  try {
    const value = ports(dir);
    const facts = await handleChapterFacts(value, { chapter: 1 });
    assert.equal(facts.text, "章事实:1");
    assert.equal(facts.facts?.chapter, 1);
    const guide = await handleReadGuide(value, { section: "第一迷宫" });
    assert.equal(guide.text, "攻略原文:第一迷宫");
    assert.match((await handleReadGuide(value, { section: "" })).text, /section/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a drafted segment is saved and checked on the spot; a bad one keeps its problems", async () => {
  const dir = await temporary();
  try {
    const value = ports(dir);
    const plan = testChapterPlan();
    const first = plan.segments[0];
    assert.ok(first !== undefined);
    const withoutChest = {
      ...first,
      stations: first.stations.filter((station) => station.to !== "10:1,1"),
    };
    // 11-11: without a chapter number the segment is stored but not guessed against a chapter.
    const unnumbered = await handleChapterDraftSegment(value, {
      index: 0,
      plan: first,
    });
    assert.match(unnumbered.text, /章号/u);
    await handleChapterDraftMeta(value, metaArgs(plan));
    const bad = await handleChapterDraftSegment(value, {
      index: 0,
      plan: withoutChest,
    });
    assert.ok((bad.problems?.length ?? 0) > 0);
    assert.match(bad.text, /宝箱/u);
    const stored = await ChapterDraftStore.load("ff5", chapterDraftPath("ff5", dir));
    assert.equal(stored.segmentAt(0)?.section, "第一迷宫");

    const fixed = await handleChapterDraftSegment(value, {
      index: 0,
      plan: first,
    });
    assert.deepEqual(fixed.problems, undefined);
    assert.match(fixed.text, /通过/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("draft meta saves every field and status summarizes it", async () => {
  const dir = await temporary();
  try {
    const value = ports(dir);
    const plan = testChapterPlan();
    const answer = await handleChapterDraftMeta(value, metaArgs(plan));
    assert.match(answer.text, /第 1 章/u);
    assert.ok(answer.draft !== undefined);
    assert.equal(answer.draft.chapter, 1);
    assert.equal(answer.draft.growth.length, 1);
    const status = await handleChapterStatus(value, {});
    assert.match(status.text, /章草稿/u);
    assert.match(status.text, /第 1 章/u);
    assert.match(status.text, /当前章计划:没有/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("submitting a complete draft accepts, saves the plan and clears the draft", async () => {
  const dir = await temporary();
  try {
    const value = ports(dir);
    const plan = testChapterPlan();
    await draftFull(value, plan);
    const answer = await handleSubmitChapterPlan(value, {});
    assert.equal(answer.accepted, true);
    assert.match(answer.text, /通过检查/u);
    assert.ok(answer.plan !== undefined);
    assert.equal(answer.plan.segments.length, 2);
    const saved = await ChapterPlanStore.load("ff5", chapterPlanPath("ff5", dir));
    assert.ok(saved.current !== null);
    assert.equal(saved.current.chapter, 1);
    assert.equal(saved.current.goal, plan.goal);
    const draft = await ChapterDraftStore.load("ff5", chapterDraftPath("ff5", dir));
    assert.equal(draft.chapter, null);
    assert.deepEqual(draft.segmentEntries(), []);
    const status = await handleChapterStatus(value, {});
    assert.match(status.text, /当前章计划:第 1 章/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("submit is refused while the chapter is running or blocked, and accepted after abandon", async () => {
  const dir = await temporary();
  try {
    const plan = testChapterPlan();
    const base = ports(dir);
    await draftFull(base, plan);
    let owner: { chapter: number; status: "running" | "blocked" } | null = {
      chapter: 1,
      status: "running",
    };
    const owned: ChapterToolPorts = { ...base, owner: () => owner };
    const running = await handleSubmitChapterPlan(owned, {});
    assert.equal(running.accepted, false);
    assert.match(running.text, /第 1 章正由执行器在后台跑/u);
    assert.match(running.text, /不要再调用工具/u);
    assert.equal((await ChapterPlanStore.load("ff5", chapterPlanPath("ff5", dir))).current, null);

    owner = { chapter: 1, status: "blocked" };
    const blocked = await handleSubmitChapterPlan(owned, {});
    assert.equal(blocked.accepted, false);
    assert.match(blocked.text, /等待开发修复/u);

    // --abandon clears the executor's ownership; the draft is still there and can be submitted.
    owner = null;
    const accepted = await handleSubmitChapterPlan(owned, {});
    assert.equal(accepted.accepted, true);
    assert.ok((await ChapterPlanStore.load("ff5", chapterPlanPath("ff5", dir))).current !== null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a dry-run problem rejects an otherwise valid chapter and does not save it", async () => {
  const dir = await temporary();
  try {
    const plan = testChapterPlan();
    const value = ports(dir, {
      problems: ["第 1 段第 3 站 (图 10:5,1) 从上一站 (图 10:1,1) 走不到：墙"],
      warnings: [],
      timedOut: false,
    });
    await draftFull(value, plan);
    const answer = await handleSubmitChapterPlan(value, {});
    assert.equal(answer.accepted, false);
    assert.match(answer.text, /图 10:5,1/u);
    const saved = await ChapterPlanStore.load("ff5", chapterPlanPath("ff5", dir));
    assert.equal(saved.current, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a dry-run warning is appended to the accepted text and kept in warnings", async () => {
  const dir = await temporary();
  try {
    const plan = testChapterPlan();
    const value = ports(dir, {
      problems: [],
      warnings: ["第 1 段第 2 站走不到（上一站是剧情，只提醒）"],
      timedOut: false,
    });
    await draftFull(value, plan);
    const answer = await handleSubmitChapterPlan(value, {});
    assert.equal(answer.accepted, true);
    assert.match(answer.text, /提醒\(不影响接受\)/u);
    assert.match(answer.text, /只提醒/u);
    assert.deepEqual(answer.warnings, ["第 1 段第 2 站走不到（上一站是剧情，只提醒）"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a failed submission lists problems and keeps the draft; skipped then passes", async () => {
  const dir = await temporary();
  try {
    const value = ports(dir);
    const plan = testChapterPlan();
    const first = plan.segments[0];
    assert.ok(first !== undefined);
    const missingChest = {
      ...plan,
      segments: [
        {
          ...first,
          stations: first.stations.filter((station) => station.to !== "10:1,1"),
        },
        plan.segments[1],
      ].filter((segment) => segment !== undefined),
    } as ChapterPlan;
    await draftFull(value, missingChest, true);
    const rejected = await handleSubmitChapterPlan(value, {});
    assert.equal(rejected.accepted, false);
    assert.ok((rejected.problems?.length ?? 0) > 0);
    const draft = await ChapterDraftStore.load("ff5", chapterDraftPath("ff5", dir));
    assert.equal(draft.segmentEntries().length, 2);

    const skipped = {
      ...missingChest,
      skipped: [
        {
          kind: "chest" as const,
          name: "恢复药",
          where: "10:1,1",
          why: "拿过了",
        },
      ],
    };
    const retried = await handleChapterDraftMeta(value, metaArgs(skipped));
    assert.match(retried.text, /元信息/u);
    const accepted = await handleSubmitChapterPlan(value, {});
    assert.equal(accepted.accepted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("submitting an incomplete draft lists what is missing", async () => {
  const dir = await temporary();
  try {
    const value = ports(dir);
    const answer = await handleSubmitChapterPlan(value, {});
    assert.equal(answer.accepted, false);
    assert.match(answer.text, /chapter/u);
    assert.match(answer.text, /fallback/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a broken draft file becomes a Chinese tool error", async () => {
  const dir = await temporary();
  try {
    const value = ports(dir);
    const draftPath = chapterDraftPath("ff5", dir);
    await mkdir(join(draftPath, ".."), { recursive: true });
    await writeFile(draftPath, "{not json", "utf8");
    const answer = await handleChapterDraftSegment(value, {
      index: 0,
      plan: testChapterPlan().segments[0],
    });
    assert.match(answer.text, /读章草稿失败/u);
    assert.match(answer.text, /读不懂章草稿/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

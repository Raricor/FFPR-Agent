/**
 * Task 153: `execute_chapter` reads the accepted chapter plan and the chapter progress, then
 * hands the executor the resume point. The substitute executor records the options; no bridge,
 * laptop or real game is involved.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game, INTERNAL_CHAPTER_RUN, type ChapterExecutor } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type {
  ChapterPlan,
  ChapterProgress,
  ChapterReport,
} from "../src/engine/plan/chapter-types.ts";
import { ChapterDraftStore } from "../src/engine/plan/chapter-store.ts";
import type { ExecuteChapterOptions } from "../src/engine/plan/chapter-execute.ts";
import type { ExecutePorts } from "../src/engine/plan/execute.ts";
import { FakePilot } from "./fake-pilot.ts";
import {
  testChapterFacts,
  testChapterPlan,
  testSegmentPlan,
  testStation,
} from "./chapter-fixture.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

function chapterPlan() {
  return testChapterPlan({
    segments: [
      testSegmentPlan("第一迷宫", [testStation({ to: "10:1,1", do: "move" })]),
      testSegmentPlan("第二迷宫", [
        testStation({ to: "10:2,2", do: "move" }),
        testStation({ to: "10:3,3", do: "move" }),
      ]),
    ],
  });
}

void test("execute_chapter resumes at the first unfinished station and reports it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-game-"));
  try {
    const plan = chapterPlan();
    const progressFile = join(directory, "chapter-progress-ff5.json");
    const reportFile = join(directory, "chapter-report-ff5.json");
    const progress: ChapterProgress = {
      game: "ff5",
      chapter: 1,
      goal: plan.goal,
      revision: 2,
      startedAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:05:00.000Z",
      finishedAt: null,
      status: "running",
      segment: 1,
      segments: [
        {
          section: "第一迷宫",
          stations: [{ index: 0, status: "done", note: "做完了" }],
        },
        {
          section: "第二迷宫",
          stations: [
            { index: 0, status: "done", note: "做完了" },
            { index: 1, status: "pending", note: "" },
          ],
        },
      ],
      fallbacks: [],
      previousException: null,
    };
    await writeFile(progressFile, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
    await writeFile(
      reportFile,
      `${JSON.stringify({
        chapter: 1,
        status: "exception",
        segments: [],
        fallbacks: ["上一轮卡住"],
        exception: {
          kind: "stuck",
          segment: 1,
          station: 1,
          detail: "上一轮卡在第二站",
        },
        minutes: 1,
        modelCalls: 0,
      })}\n`,
      "utf8",
    );
    const seenOptions: ExecuteChapterOptions[] = [];
    const executor: ChapterExecutor = (
      _given,
      _ports: ExecutePorts,
      options,
    ): Promise<ChapterReport> => {
      seenOptions.push(options);
      return Promise.resolve({
        chapter: 1,
        status: "exception",
        segments: [],
        fallbacks: ["换新路线重试 1/3"],
        exception: {
          kind: "stuck",
          segment: 1,
          station: 1,
          detail: "这一轮还是卡住",
        },
        minutes: 0.3,
        modelCalls: 0,
      });
    };
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
      segmentPlanFile: join(directory, "segment-plan-ff5.json"),
      chapterPlanFile: join(directory, "chapter-plan-ff5.json"),
      chapterDraftFile: join(directory, "chapter-draft-ff5.json"),
      chapterProgressFile: progressFile,
      chapterReportFile: reportFile,
      chapterExecutor: executor,
    });
    await game.chapterPlans.save(plan);
    const text = await game.run("execute_chapter", {}, new FakePilot());
    const seen = seenOptions[0];
    assert.ok(seen, "执行器应该被调用");
    assert.equal(seen.startAt, 1);
    assert.deepEqual(seen.skipStations, {
      1: { startAt: 1, skip: [], done: { 0: 0 } },
    });
    assert.equal(seen.revision, 3);
    assert.deepEqual(seen.previousException, {
      kind: "stuck",
      detail: "上一轮卡在第二站",
    });
    assert.equal(seen.progressPath, progressFile);
    assert.equal(seen.reportPath, reportFile);
    assert.match(text, /续跑从第 2 节「第二迷宫」第 2 站开始/u);
    assert.match(text, /例外\(stuck\)第 2 节第 2 站/u);
    assert.match(text, /兜底记录|换新路线重试/u);
    assert.match(text, /结构化报告\(JSON\)/u);
    assert.match(text, /"status": "exception"/u);

    const status = await game.run("chapter_status", {}, new FakePilot());
    assert.match(status, /当前章计划:第 1 章 走完第一章/u);
    assert.match(status, /2 段/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("execute_chapter without a saved plan explains the drafting order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-game-empty-"));
  try {
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
      segmentPlanFile: join(directory, "segment-plan-ff5.json"),
    });
    const text = await game.run("execute_chapter", {}, new FakePilot());
    assert.match(text, /还没有存盘的章计划/u);
    assert.match(text, /chapter_facts/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the background run writes the blocked state to progress, report and activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-blocked-"));
  try {
    const plan = chapterPlan();
    const progressFile = join(directory, "chapter-progress-ff5.json");
    const reportFile = join(directory, "chapter-report-ff5.json");
    const executor: ChapterExecutor = (): Promise<ChapterReport> =>
      Promise.resolve({
        chapter: 1,
        status: "exception",
        segments: [],
        fallbacks: ["兜底都失败了"],
        exception: {
          kind: "stuck",
          segment: 1,
          station: 1,
          detail: "走不过去",
        },
        minutes: 0.3,
        modelCalls: 0,
      });
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
      segmentPlanFile: join(directory, "segment-plan-ff5.json"),
      chapterPlanFile: join(directory, "chapter-plan-ff5.json"),
      chapterDraftFile: join(directory, "chapter-draft-ff5.json"),
      chapterProgressFile: progressFile,
      chapterReportFile: reportFile,
      chapterExecutor: executor,
    });
    await game.chapterPlans.save(plan);
    const activity: string[] = [];
    game.onActivity = (message) => activity.push(message);
    const text = await game.run(INTERNAL_CHAPTER_RUN, {}, new FakePilot());
    assert.match(text, /等待修复：第 2 节第 2 站：走不过去/u);
    const progress: unknown = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal((progress as { status?: string }).status, "blocked");
    assert.match((progress as { blockedText?: string }).blockedText ?? "", /等待修复/u);
    const report: unknown = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal((report as { status?: string }).status, "blocked");
    assert.match((report as { blockedText?: string }).blockedText ?? "", /走不过去/u);
    assert.ok(
      activity.some((line) => line.includes("等待修复：第 2 节第 2 站")),
      "活动日志也要写等待修复",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a passed submit hands the chapter to code and ends the model round", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-submit-"));
  try {
    const plan = testChapterPlan();
    const draftPath = join(directory, "chapter-draft-ff5.json");
    const draft = await ChapterDraftStore.load("ff5", draftPath);
    await draft.setMeta({
      chapter: plan.chapter,
      goal: plan.goal,
      growth: plan.growth,
      fallback: plan.fallback,
      skipped: plan.skipped ?? [],
    });
    for (const [index, segment] of plan.segments.entries()) {
      await draft.setSegment(index, segment);
    }
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
      segmentPlanFile: join(directory, "segment-plan-ff5.json"),
      chapterPlanFile: join(directory, "chapter-plan-ff5.json"),
      chapterDraftFile: draftPath,
      chapterProgressFile: join(directory, "chapter-progress-ff5.json"),
      chapterReportFile: join(directory, "chapter-report-ff5.json"),
    });
    const stub = game as unknown as {
      chapterFactsFor: () => Promise<{ data: unknown; text: string }>;
      chapterDryRun: () => Promise<{
        problems: string[];
        warnings: string[];
        timedOut: boolean;
      }>;
    };
    stub.chapterFactsFor = () => Promise.resolve({ data: testChapterFacts(), text: "章事实" });
    stub.chapterDryRun = () => Promise.resolve({ problems: [], warnings: [], timedOut: false });
    let accepted: ChapterPlan | null = null;
    game.onChapterAccepted = (given) => {
      accepted = given;
    };
    const text = await game.run("submit_chapter_plan", {}, new FakePilot());
    assert.ok(accepted, text);
    assert.equal((accepted as ChapterPlan | null)?.chapter, plan.chapter);
    assert.match(text, /规则文件已定稿,执行器接管第 1 章,本轮结束/u);
    assert.match(text, /本章跑完会再叫你规划下一章/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

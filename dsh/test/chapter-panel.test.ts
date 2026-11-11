/**
 * Task 153: the chapter panel is read-only. A complete set of chapter files renders the
 * chapter, its segments and current station table; missing or damaged files become Chinese
 * view text instead of an exception.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChapterPlanStore } from "../src/engine/plan/chapter-store.ts";
import type { ChapterPlan, ChapterProgress } from "../src/engine/plan/chapter-types.ts";
import {
  CHAPTER_ROUTE,
  chapterRoute,
  defaultChapterFiles,
  readChapterPanel,
  type ChapterFiles,
  type ChapterPanelView,
} from "../src/plugin/chapter-panel.ts";
import { testChapterPlan } from "./chapter-fixture.ts";

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ffpr-chapter-panel-"));
}

function paths(dir: string): ChapterFiles {
  return {
    plan: join(dir, "chapter-plan-ff5.json"),
    progress: join(dir, "chapter-progress-ff5.json"),
    report: join(dir, "chapter-report-ff5.json"),
    atlas: join(dir, "atlas-ff5.json"),
    guide: join(dir, "guide.json"),
  };
}

function progress(plan: ChapterPlan): ChapterProgress {
  return {
    game: "ff5",
    chapter: plan.chapter,
    goal: plan.goal,
    revision: 2,
    startedAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:10:00.000Z",
    finishedAt: null,
    status: "running",
    segment: 0,
    segments: [
      {
        section: "第一迷宫",
        stations: [
          { index: 0, status: "done", note: "开了一个宝箱" },
          { index: 1, status: "current", note: "正在开第二个" },
          { index: 2, status: "pending", note: "" },
          { index: 3, status: "pending", note: "" },
          { index: 4, status: "pending", note: "" },
        ],
      },
      {
        section: "第二迷宫",
        stations: [],
      },
    ],
    fallbacks: ["第 1 节第 2 站换新路线重试 1/3"],
    previousException: null,
  };
}

function report() {
  return {
    chapter: 1,
    status: "exception",
    segments: [],
    fallbacks: ["换新路线重试 1/3"],
    exception: {
      kind: "unreachable",
      segment: 0,
      station: 1,
      detail: "第 1 节第 2 站走不到",
    },
    minutes: 12,
    modelCalls: 0,
  };
}

async function writeAll(dir: string): Promise<ChapterFiles> {
  const files = paths(dir);
  const plan = testChapterPlan();
  const store = await ChapterPlanStore.load("ff5", files.plan);
  await store.save(plan);
  await writeFile(files.progress, `${JSON.stringify(progress(plan), null, 2)}\n`, "utf8");
  await writeFile(files.report, `${JSON.stringify(report(), null, 2)}\n`, "utf8");
  await writeFile(
    files.atlas,
    `${JSON.stringify({ "10": { name: "测试洞窟" } }, null, 2)}\n`,
    "utf8",
  );
  return files;
}

function chapterOf(view: ChapterPanelView) {
  assert.ok(view.chapter !== null, "章面板应该有 chapter");
  return view.chapter;
}

void test("a complete chapter renders segments, the current station table and the report", async () => {
  const dir = await temporary();
  try {
    const view = await readChapterPanel(await writeAll(dir));
    assert.equal(view.title, "章计划");
    assert.equal(view.status, "执行中");
    const chapter = chapterOf(view);
    assert.match(chapter.heading, /^第 1 章/u);
    assert.equal(chapter.goalText, "目标：走完第一章");
    assert.equal(chapter.revisionText, "第 1 份规则文件");
    assert.equal(chapter.segments.length, 2);
    assert.deepEqual(
      chapter.segments.map((row) => [row.section, row.stationCount, row.doneCount, row.stateText]),
      [
        ["第一迷宫", 5, 1, "进行中"],
        ["第二迷宫", 0, 0, "未开始"],
      ],
    );
    assert.equal(chapter.segments[0]?.current, true);
    assert.match(chapter.stationSectionText, /第一迷宫/u);
    assert.equal(chapter.stations.length, 5);
    const firstStation = chapter.stations[0];
    assert.ok(firstStation);
    assert.equal(firstStation.statusSymbol, "✓");
    assert.equal(chapter.stations[1]?.statusSymbol, "▶");
    assert.equal(firstStation.mapText, "10 测试洞窟");
    assert.equal(chapter.growth.length, 1);
    assert.match(chapter.growth[0] ?? "", /最低等级 Lv10/u);
    assert.equal(chapter.fallback.length, 4);
    assert.deepEqual(chapter.fallbackRecords, ["第 1 节第 2 站换新路线重试 1/3"]);
    assert.equal(chapter.skipped.length, 0);
    assert.match(chapter.report?.exceptionText ?? "", /第 1 节 第 2 站/u);
    assert.match(chapter.report?.exceptionText ?? "", /走不到/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a blocked chapter shows the operator line in the panel and the report", async () => {
  const dir = await temporary();
  try {
    const files = await writeAll(dir);
    const plan = testChapterPlan();
    const blockedText = "等待修复：第 1 节第 2 站：走不过去";
    await writeFile(
      files.progress,
      `${JSON.stringify(
        {
          ...progress(plan),
          status: "blocked",
          blockedText,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      files.report,
      `${JSON.stringify({ ...report(), status: "blocked", blockedText }, null, 2)}\n`,
      "utf8",
    );
    const view = await readChapterPanel(files);
    assert.equal(view.status, blockedText);
    const chapter = chapterOf(view);
    assert.equal(chapter.statusText, blockedText);
    assert.equal(chapter.segments[0]?.stateText, "等待修复");
    assert.equal(chapter.report?.lines[0], "状态：等待修复");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a missing chapter plan is an empty chapter panel", async () => {
  const dir = await temporary();
  try {
    const view = await readChapterPanel(paths(dir));
    assert.equal(view.status, "还没有章计划");
    assert.equal(view.chapter, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("bad JSON in any chapter file becomes a warning, never a throw", async () => {
  const dir = await temporary();
  try {
    const files = await writeAll(dir);
    await writeFile(files.progress, "{ broken", "utf8");
    const view = await readChapterPanel(files);
    const chapter = chapterOf(view);
    assert.match(chapter.warnings.join("\n"), /读不懂章进度/u);
    assert.equal(chapter.statusText, "没在执行");

    await writeFile(files.plan, "{ broken", "utf8");
    const broken = await readChapterPanel(files);
    assert.equal(broken.status, "章计划读不了");
    assert.match(broken.message ?? "", /读不懂章计划/u);
    assert.equal(broken.chapter, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the chapter route returns the rendered view over HTTP", async () => {
  const dir = await temporary();
  try {
    const files = await writeAll(dir);
    const route = chapterRoute(undefined, () => files);
    assert.equal(route.path, CHAPTER_ROUTE);
    const body = (await (
      await route.fetch(new Request("http://localhost/api/ffpr/chapter?game=ff5"))
    ).json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    const view = body.view as ChapterPanelView;
    assert.equal(view.status, "执行中");
    assert.equal(view.chapter?.segments[0]?.section, "第一迷宫");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("default chapter files are the names the chapter store and executor use", () => {
  const files = defaultChapterFiles("ff5");
  assert.match(files.plan, /\.deps[/\\]ds[/\\]chapter-plan-ff5\.json$/u);
  assert.match(files.progress, /\.deps[/\\]ds[/\\]chapter-progress-ff5\.json$/u);
  assert.match(files.report, /\.deps[/\\]ds[/\\]chapter-report-ff5\.json$/u);
  assert.match(files.atlas, /\.deps[/\\]ds[/\\]atlas-ff5\.json$/u);
});

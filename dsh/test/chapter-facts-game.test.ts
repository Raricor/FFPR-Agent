/**
 * Task 153 follow-up: chapter facts must not depend on `ensureBook`. A chapter is a fixed guide
 * range, and a story map is not covered by any section, which used to make both
 * `chapter_facts({chapter:2})` and `chapter_facts({})` fail after a boss.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import { loadKnowledge } from "../src/engine/knowledge/index.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { ChapterPlan } from "../src/engine/plan/chapter-types.ts";
import type { RouteBook } from "../src/engine/stage/route-book.ts";
import { FakePilot } from "./fake-pilot.ts";
import { testChapterPlan, testSegmentPlan, testStation } from "./chapter-fixture.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

function guideJson(sections: number): string {
  return JSON.stringify({
    walkthrough: Array.from({ length: sections }, (_value, index) => ({
      title: `S${index}`,
      text: "",
    })),
  });
}

function chapterTwoPlan(): ChapterPlan {
  return testChapterPlan({
    chapter: 2,
    goal: "走完第二章",
    segments: [
      testSegmentPlan("S4", [testStation({ to: "10:1,1", do: "move" })]),
      testSegmentPlan("S5", [testStation({ to: "10:2,2", do: "move" })]),
    ],
  });
}

interface ChapterInternals {
  ensureBook: () => Promise<null>;
  liveBookSave: () => Promise<Record<string, null>>;
  stageTravelState: () => Promise<{
    party: never[];
    bag: never[];
    gil: number;
  }>;
  stagePosition: () => Promise<{ map: number; cell: [number, number] }>;
}

async function makeGame(directory: string, book?: RouteBook): Promise<Game> {
  const guideFile = join(directory, "guide.json");
  await writeFile(guideFile, guideJson(8), "utf8");
  const knowledge = await loadKnowledge({
    game: "ff5",
    home: join(directory, "knowledge"),
    atlas: null,
    collisions: null,
    bestiarySave: null,
    atlasSave: null,
  });
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    ...(book === undefined ? {} : { routeBook: book }),
    routeBookEnabled: true,
    routeBookGuideFile: guideFile,
    routeBookProgressFile: join(directory, "routebook-progress-ff5.json"),
    routeBookLearnedFile: join(directory, "routebook-learned-ff5.json"),
    chapterPlanFile: join(directory, "chapter-plan-ff5.json"),
    chapterDraftFile: join(directory, "chapter-draft-ff5.json"),
    chapterProgressFile: join(directory, "chapter-progress-ff5.json"),
    chapterReportFile: join(directory, "chapter-report-ff5.json"),
    knowledge,
  });
  const internals = game as unknown as ChapterInternals;
  // The real incident: ensureBook returns null because the current story map is not covered.
  internals.ensureBook = () => Promise.resolve(null);
  internals.liveBookSave = () =>
    Promise.resolve({
      bestiary: null,
      blueMagic: null,
      jobs: null,
      openedChests: null,
    });
  internals.stageTravelState = () => Promise.resolve({ party: [], bag: [], gil: 0 });
  internals.stagePosition = () => Promise.resolve({ map: 999, cell: [1, 1] });
  return game;
}

void test("chapter_facts ignores ensureBook and builds the chapter's own range", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-facts-"));
  try {
    // No injected book: chapterBookFor must build the range through loadRouteBook itself.
    const game = await makeGame(directory);
    await game.chapterPlans.save(chapterTwoPlan());
    const explicit = await game.run("chapter_facts", { chapter: 2 }, new FakePilot());
    assert.match(explicit, /章节事实:第 2 章/u);
    assert.match(explicit, /S4/u);
    assert.equal(explicit.includes("路线书没有加载出来"), false);

    // No chapter: map 999 is in no guide section, so the saved chapter plan names the chapter.
    const current = await game.run("chapter_facts", {}, new FakePilot());
    assert.match(current, /章节事实:第 2 章/u);
    assert.match(current, /S6/u);
    assert.equal(current.includes("找不到当前这一章"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a missing chapter and no plan or progress asks for chapter explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-facts-empty-"));
  try {
    const game = await makeGame(directory);
    const text = await game.run("chapter_facts", {}, new FakePilot());
    assert.match(text, /取章事实失败/u);
    assert.match(text, /chapter/u);
    assert.match(text, /1–23/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

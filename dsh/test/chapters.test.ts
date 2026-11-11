import assert from "node:assert/strict";
import test from "node:test";
import { Guide } from "../src/engine/guide/kb.ts";
import {
  CHAPTER_RANGES,
  chapterForSection,
  chapterGuideText,
  chapterTitle,
  currentChapter,
} from "../src/engine/plan/chapters.ts";
import type { RouteBookSave, RouteChest, RouteSection } from "../src/engine/stage/route-book.ts";

function fakeGuide(): Guide {
  const walkthrough = Array.from({ length: 77 }, (_, index) => ({
    title: `第 ${index} 节`,
    text: `正文 ${index}`,
  }));
  return new Guide(walkthrough, new Map());
}

function chest(opened: boolean, mapId: number): RouteChest {
  return {
    stepIndex: 0,
    where: "试验地",
    kind: "chest",
    n: 1,
    item: "Tent",
    text: "A chest.",
    mapId,
    mapName: null,
    cell: [1, 1],
    opened,
    match: "name",
    note: "",
    candidates: [],
  };
}

function section(order: number, mapId: number, opened: boolean): RouteSection {
  return {
    title: `第 ${order} 节`,
    order,
    areaName: "试验地",
    maps: [{ mapId, name: `地图 ${mapId}`, areaName: "试验地", reasons: [] }],
    places: [],
    stations: [],
    notes: [],
    chests: [chest(opened, mapId)],
    guideChestItems: [],
    chestsMatched: 0,
    chestsTotal: 1,
    monsters: [],
    bosses: [],
    blueMagic: [],
    grind: [],
    revisit: null,
    bestiaryMissing: 0,
    blueMagicMissing: 0,
    mismatches: [],
  };
}

const SAVE: RouteBookSave = {
  bestiary: null,
  blueMagic: null,
  jobs: null,
  openedChests: null,
};

void test("the 23 chapter ranges cover sections 1-75 once each", () => {
  assert.equal(CHAPTER_RANGES.length, 23);
  assert.deepEqual(
    CHAPTER_RANGES.map((range) => [range.chapter, range.from, range.to]),
    [
      [1, 1, 3],
      [2, 4, 7],
      [3, 8, 10],
      [4, 11, 14],
      [5, 15, 16],
      [6, 17, 20],
      [7, 21, 23],
      [8, 24, 25],
      [9, 26, 27],
      [10, 28, 31],
      [11, 32, 33],
      [12, 34, 36],
      [13, 37, 40],
      [14, 41, 44],
      [15, 45, 47],
      [16, 48, 51],
      [17, 52, 53],
      [18, 54, 58],
      [19, 59, 61],
      [20, 62, 64],
      [21, 65, 67],
      [22, 68, 71],
      [23, 72, 75],
    ],
  );
  const seen = new Map<number, number>();
  for (const range of CHAPTER_RANGES) {
    for (let index = range.from; index <= range.to; index += 1) {
      seen.set(index, (seen.get(index) ?? 0) + 1);
    }
  }
  assert.deepEqual(
    [...seen.keys()].sort((left, right) => left - right),
    Array.from({ length: 75 }, (_, index) => index + 1),
  );
  assert.equal(
    [...seen.values()].every((count) => count === 1),
    true,
  );
});

void test("a section index finds its chapter; 0 and 76 are outside every chapter", () => {
  assert.deepEqual(chapterForSection(4), { chapter: 2, from: 4, to: 7 });
  assert.deepEqual(chapterForSection(75), { chapter: 23, from: 72, to: 75 });
  assert.equal(chapterForSection(0), null);
  assert.equal(chapterForSection(76), null);
});

void test("the chapter title is the first section title → the last section title", () => {
  const guide = fakeGuide();
  assert.equal(chapterTitle({ chapter: 2, from: 4, to: 7 }, guide), "第 4 节 → 第 7 节");
  assert.equal(chapterTitle({ chapter: 9, from: 26, to: 27 }, null), "第 9 章(攻略第 26–27 节)");
});

void test("the current chapter follows the unfinished section on the current map", () => {
  const finished = section(4, 10, true);
  const next = section(8, 30, false);
  assert.deepEqual(currentChapter([finished, next], 10, SAVE), {
    chapter: 3,
    from: 8,
    to: 10,
  });
  assert.deepEqual(currentChapter([finished, next], 30, SAVE), {
    chapter: 3,
    from: 8,
    to: 10,
  });
});

void test("chapterGuideText returns only the chapter's full guide text", () => {
  const text = chapterGuideText({ chapter: 2, from: 4, to: 7 }, fakeGuide());
  for (const index of [4, 5, 6, 7]) assert.ok(text.includes(`正文 ${index}`));
  assert.equal(text.includes("正文 3"), false);
  assert.equal(text.includes("正文 8"), false);
  assert.ok(text.startsWith("### 第 4 节 第 4 节"));
});

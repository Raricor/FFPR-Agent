/**
 * Task 150: the whole-chapter fact sheet. The route book sections and the knowledge module are
 * hand-written here, so the test checks the builder and its Chinese text without `.deps` or a
 * bridge. Task 153's `ensureBook`-independent lookup lives in `chapter-facts-game.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Knowledge } from "../src/engine/knowledge/index.ts";
import { buildChapterFacts, chapterFactsText } from "../src/engine/plan/chapter-facts.ts";
import type { ChapterRange } from "../src/engine/plan/chapter-types.ts";
import type { RouteSection } from "../src/engine/stage/route-book.ts";

function emptyKnowledge(): Knowledge {
  return {
    game: "ff5",
    filesDir: null,
    guide: null,
    atlas: null,
    maps: [],
    encounters: [],
    monsters: [],
    chests: [],
    shops: [],
    items: [],
    magic: [],
    contentItems: [],
    savePoints: [],
    restorePoints: [],
    sources: [],
    conflicts: [],
  } as unknown as Knowledge;
}

function section(title: string, order: number): RouteSection {
  return {
    title,
    order,
    areaName: "测试地区",
    maps: [],
    places: [],
    stations: [],
    notes: [],
    chests: [],
    guideChestItems: [],
    chestsMatched: 0,
    chestsTotal: 0,
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

const CHAPTER: ChapterRange = { chapter: 2, from: 4, to: 5 };

void test("a chapter lists its guide sections in index order with the three tables", () => {
  const data = buildChapterFacts({
    chapter: CHAPTER,
    sections: [section("S5", 5), section("S4", 4)],
    knowledge: emptyKnowledge(),
    save: null,
    party: [],
    bag: [],
    gil: 0,
    guide: null,
  });
  assert.equal(data.game, "ff5");
  assert.equal(data.chapter, 2);
  assert.equal(data.from, 4);
  assert.equal(data.to, 5);
  assert.deepEqual(
    data.sections.map((entry) => [entry.index, entry.title, entry.done]),
    [
      [4, "S4", false],
      [5, "S5", false],
    ],
  );
  assert.deepEqual(data.hiddenItems, []);
  assert.deepEqual(data.shops, []);
  assert.deepEqual(data.encounters, []);
  const text = chapterFactsText(data);
  assert.match(text, /章节事实:第 2 章/u);
  assert.match(text, /### 隐藏道具\(0 个\)/u);
  assert.match(text, /### 商店\(0 家\)/u);
  assert.match(text, /### 遇敌\(0 张图,0 种\)/u);
  assert.match(text, /第 4 节 S4/u);
  assert.match(text, /第 5 节 S5/u);
});

void test("a chapter range with a missing route-book section is a Chinese error", () => {
  assert.throws(
    () =>
      buildChapterFacts({
        chapter: CHAPTER,
        sections: [section("S4", 4)],
        knowledge: emptyKnowledge(),
        save: null,
        party: [],
        bag: [],
        gil: 0,
        guide: null,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /第 2 章/u);
      assert.match(error.message, /第 5 节/u);
      return true;
    },
  );
});

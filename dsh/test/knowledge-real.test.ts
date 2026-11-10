import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { chestsIn, loadKnowledge } from "../src/engine/knowledge/index.ts";

// The dev box keeps the fetched guides here (never committed); test runs elsewhere skip.
const REAL_HOME = join(import.meta.dirname, "..", "..", ".deps", "knowledge", "ff5");

async function hasRealGuide(): Promise<boolean> {
  try {
    await access(join(REAL_HOME, "guide.json"));
    return true;
  } catch {
    return false;
  }
}

void test("real local FF5 guide cache: bestiary has 250+ monsters and 火力船 has chests", async (t) => {
  if (!(await hasRealGuide())) {
    t.skip("没有本机 .deps/knowledge/ff5/guide.json");
    return;
  }
  const knowledge = await loadKnowledge({
    game: "ff5",
    home: REAL_HOME,
    atlas: null,
    collisions: null,
    bestiarySave: null,
    atlasSave: null,
  });
  assert.ok(
    knowledge.monsters.length >= 250,
    `真实攻略应有 250+ 怪物,实际 ${knowledge.monsters.length}`,
  );
  const chests = chestsIn(knowledge, { areaName: "火力船" });
  assert.ok(chests.length >= 1, `火力船应至少有 1 个宝箱,实际 ${chests.length}`);
  assert.equal(
    chests.every((chest) => chest.sources.some((source) => source.kind === "guide")),
    true,
  );
  // A walkthrough step must never be mistaken for the item: content names are nouns, not
  // "Go through the nearby door".
  const WALKTHROUGH =
    /^(?:go|head|walk|search|inspect|open|follow|take|enter|exit|return|climb|talk|speak|use|check|look|move|push|pull|press|step|travel|board|leave|continue|make|get|find|once|from)\b/i;
  assert.deepEqual(
    chests
      .flatMap((chest) => (chest.contentName === null ? [] : [chest.contentName]))
      .filter((name) => WALKTHROUGH.test(name)),
    [],
  );
});

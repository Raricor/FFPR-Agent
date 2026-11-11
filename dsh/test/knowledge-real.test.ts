import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { chestsIn, contentName, loadKnowledge, monstersIn } from "../src/engine/knowledge/index.ts";

// The dev box keeps the fetched guides and the extracted game files here (never committed).
const REAL_HOME = join(import.meta.dirname, "..", "..", ".deps", "knowledge", "ff5");

async function hasRealData(): Promise<boolean> {
  for (const path of [
    join(REAL_HOME, "guide.json"),
    join(REAL_HOME, "files", "maps"),
    join(REAL_HOME, "files", "items.json"),
  ]) {
    try {
      await access(path);
    } catch {
      return false;
    }
  }
  return true;
}

void test("real FF5 files: cave, world regions, Tule chests and the fire ship", async (t) => {
  if (!(await hasRealData())) {
    t.skip("没有本机 .deps/knowledge/ff5 的 guide.json 和 files/");
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
  assert.ok(knowledge.filesDir !== null);
  assert.equal(knowledge.contentItems.length > 1000, true);
  assert.deepEqual(contentName(knowledge, 4), {
    ja: "フェニックスの尾",
    en: "Phoenix Down",
    zhc: "不死鸟之尾",
  });

  // The cave maps 192-194 use monster sets 91/92, not the old export's area rows.
  assert.deepEqual(
    monstersIn(knowledge, { mapIds: [192] }).map((monster) => monster.name),
    ["钢蝠", "恶魔蟹"],
  );
  for (const mapId of [193, 194]) {
    assert.deepEqual(
      monstersIn(knowledge, { mapIds: [mapId] }).map((monster) => monster.name),
      ["套索妖", "钢蝠"],
    );
  }
  assert.equal(
    monstersIn(knowledge, { areaIds: [81] }).some((monster) => monster.name === "黑火"),
    false,
  );

  // Black Flame is a world map encounter region (10 and 65), not a map in the Pyramid area 65.
  const world = monstersIn(knowledge, { encounterAreaIds: [65] });
  assert.equal(
    world.some((monster) => monster.name === "黑火"),
    true,
  );
  assert.equal(
    monstersIn(knowledge, { areaIds: [65] }).some((monster) => monster.name === "黑火"),
    false,
  );

  const tule = chestsIn(knowledge, { mapIds: [30] });
  assert.deepEqual(
    tule.map((chest) => chest.contentNames?.en),
    ["Phoenix Down", "Leather Shoes", "Tent", "Potion", "Gil"],
  );
  assert.deepEqual(
    tule.map((chest) => chest.guide?.n),
    [4, 5, 2, 3, 1],
  );

  // Every file chest carries the `files` source; 208 of the 278 match a guide chest (74.8%).
  const fileChests = knowledge.chests.filter((chest) => chest.mapId !== null);
  assert.equal(fileChests.length, 278);
  assert.equal(
    fileChests.every((chest) => chest.sources.some((source) => source.kind === "files")),
    true,
  );
  const matched = fileChests.filter((chest) => chest.guide !== null).length;
  assert.ok(matched / fileChests.length > 0.7, `攻略只对上 ${matched}/${fileChests.length} 个宝箱`);

  const fireShip = chestsIn(knowledge, { areaName: "火力船" }).filter(
    (chest) => chest.mapId !== null,
  );
  assert.equal(fireShip.length, 9);
  assert.equal(
    fireShip.every((chest) => chest.sources.some((source) => source.kind === "files")),
    true,
  );
  assert.equal(fireShip.filter((chest) => chest.guide !== null).length, 9);
});

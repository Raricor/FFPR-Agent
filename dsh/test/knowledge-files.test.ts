import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  chestsIn,
  contentByName,
  contentName,
  loadKnowledge,
  monstersIn,
  restorePointsIn,
  savePointsIn,
} from "../src/engine/knowledge/index.ts";

const HOME = join(import.meta.dirname, "fixtures", "knowledge-files");
const GUIDE = join(import.meta.dirname, "fixtures", "knowledge-files", "guide.json");

async function loaded() {
  return loadKnowledge({
    game: "ff5",
    home: HOME,
    guidePath: GUIDE,
    atlas: null,
    collisions: null,
    bestiarySave: null,
    atlasSave: null,
    progress: { openedChests: [], visitedMaps: [] },
  });
}

void test("game files take over encounters and chests; the old export only fills gaps", async () => {
  const knowledge = await loaded();
  assert.equal(knowledge.filesDir, join(HOME, "files"));
  // The old encounters export puts Test Flame on map 192; the files' monster set does not.
  assert.deepEqual(
    monstersIn(knowledge, { mapIds: [192] }).map((monster) => monster.name),
    ["测试蝙蝠", "测试蟹"],
  );
  assert.deepEqual(
    monstersIn(knowledge, { mapIds: [193] }).map((monster) => monster.name),
    ["测试妖", "测试蝙蝠"],
  );
  assert.equal(
    monstersIn(knowledge, { mapIds: [192] }).some((monster) => monster.name === "测试火"),
    false,
  );
  assert.equal(
    monstersIn(knowledge, { mapIds: [192] }).every((monster) =>
      monster.encounters.every((encounter) =>
        encounter.sources.some((source) => source.kind === "files"),
      ),
    ),
    true,
  );
  // The old static treasure map 30 content is not used; the five file chests are.
  assert.equal(chestsIn(knowledge, { mapIds: [30] }).length, 5);
});

void test("a world encounter region is not a map area", async () => {
  const knowledge = await loaded();
  const region = monstersIn(knowledge, { encounterAreaIds: [65] });
  assert.deepEqual(region.map((monster) => monster.name).sort(), ["测试巨像", "测试火"]);
  assert.equal(
    region.every((monster) =>
      monster.encounters.some(
        (encounter) => encounter.scope === "world" && encounter.encounterAreaId === 65,
      ),
    ),
    true,
  );
  // Map area 65 is the Test Ruin: its dungeon set has Test Beast, not the world region's monsters.
  const pyramid = monstersIn(knowledge, { areaIds: [65] });
  assert.deepEqual(
    pyramid.map((monster) => monster.name),
    ["测试兽"],
  );
  assert.equal(
    pyramid.some((monster) => monster.name === "测试火"),
    false,
  );
  // A world region covers both halves of its world map (1 and 2).
  assert.equal(
    monstersIn(knowledge, { mapIds: [1] }).some((monster) => monster.name === "测试火"),
    true,
  );
  assert.equal(
    region.every((monster) =>
      monster.encounters.some((encounter) => encounter.terrainSubdivided === false),
    ),
    true,
  );
});

void test("guide English item names match the file chests, with the third name as a tie-break", async () => {
  const knowledge = await loaded();
  const chests = chestsIn(knowledge, { mapIds: [30] });
  assert.deepEqual(
    chests.map((chest) => chest.contentNames?.en),
    ["Test Feather", "Test Shoes", "Test Tent", "Test Potion", "Test Gil"],
  );
  assert.deepEqual(
    chests.map((chest) => chest.guide?.n),
    [4, 5, 2, 3, 1],
  );
  assert.equal(
    chests.every((chest) => chest.sources.some((source) => source.kind === "files")),
    true,
  );
  assert.equal(
    chests.every((chest) => chest.sources.some((source) => source.kind === "guide")),
    true,
  );
  const gil = chests.find((chest) => chest.contentId === 1);
  assert.ok(gil !== undefined);
  assert.equal(gil.count, 150);
  assert.equal(gil.hidden, true);
  assert.deepEqual(gil.cell, [45, 36]);
});

void test("content ids answer in all three languages and any name resolves back", async () => {
  const knowledge = await loaded();
  assert.deepEqual(contentName(knowledge, 4), {
    ja: "测试羽毛",
    en: "Test Feather",
    zhc: "测试羽毛",
  });
  assert.equal(contentByName(knowledge, "测试羽毛")?.id, 4);
  assert.equal(contentByName(knowledge, "Test Feather")?.id, 4);
  assert.equal(contentByName(knowledge, "测试羽毛")?.id, 4);
  assert.equal(contentByName(knowledge, "没有这个物品"), null);
  assert.equal(contentName(knowledge, 9999), null);
});

void test("save and restore points come from the map files", async () => {
  const knowledge = await loaded();
  const saves = savePointsIn(knowledge, { mapIds: [30] });
  assert.deepEqual(
    saves.map((point) => [point.mapId, point.mapName, point.areaName, point.cell]),
    [[30, "Map_92010", "测试村", [5, 6]]],
  );
  assert.equal(
    saves[0]?.sources.some((source) => source.kind === "files"),
    true,
  );
  const restores = restorePointsIn(knowledge, { areaName: "测试村" });
  assert.deepEqual(
    restores.map((point) => point.cell),
    [[6, 7]],
  );
  assert.deepEqual(savePointsIn(knowledge, { mapIds: [192] }), []);
});

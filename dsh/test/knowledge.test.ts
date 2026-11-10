import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  blueMagicSources,
  bossMapIds,
  chestsIn,
  itemsThatCure,
  loadKnowledge,
  missablesAfter,
  monstersIn,
  readStatic,
  shopsNear,
  statusThreats,
} from "../src/engine/knowledge/index.ts";
import { guideContent } from "../src/engine/knowledge/merge.ts";

const HOME = join(import.meta.dirname, "fixtures", "knowledge");

async function loaded() {
  return loadKnowledge({
    game: "ff5",
    home: HOME,
    atlas: null,
    collisions: null,
    bestiarySave: null,
    atlasSave: null,
    progress: { openedChests: [1], visitedMaps: [] },
  });
}

void test("load reads every synthetic export table and the guide", async () => {
  const knowledge = await loaded();
  assert.deepEqual(knowledge.tables, [
    "maps",
    "monsters",
    "encounters",
    "treasures",
    "shops",
    "items",
    "magic",
  ]);
  assert.equal(knowledge.game, "ff5");
  assert.equal(knowledge.build, "1.0.0");
  assert.equal(knowledge.bridge, "0.14.5");
  const firstMap = knowledge.maps[0];
  assert.ok(firstMap !== undefined);
  assert.equal(firstMap.visited, false);
  assert.equal(
    firstMap.sources.some((source) => source.kind === "save"),
    true,
  );
  assert.equal(knowledge.guide !== null, true);
  assert.equal(knowledge.profile?.key, "ff5");
});

void test("a missing export directory is empty, not an error", async () => {
  const data = await readStatic(join(HOME, "nothing-here"), "ff5");
  assert.deepEqual(data.tables, []);
  assert.deepEqual(data.monsters, []);
});

void test("monster merge matches by bestiary number: master numbers win, disagreements are kept", async () => {
  const knowledge = await loaded();
  const monsters = monstersIn(knowledge, { areaIds: [10] });
  assert.deepEqual(
    monsters.map((monster) => monster.name),
    ["哥布林", "水精灵"],
  );
  const goblin = monsters[0];
  assert.ok(goblin !== undefined);
  assert.equal(goblin.bookId, 7);
  assert.equal(goblin.hp, 100);
  assert.deepEqual(goblin.weak, ["冰"]);
  assert.deepEqual(goblin.nullify, ["毒"]);
  assert.equal(goblin.encounterWeight, 60);
  assert.equal(goblin.encounterChance, 0.6);
  assert.match(goblin.guideNote ?? "", /Poison Needle/);
  assert.deepEqual(
    goblin.conflicts.find((conflict) => conflict.field === "hp"),
    { field: "hp", master: 100, guide: 90 },
  );
  assert.deepEqual(
    goblin.conflicts.find((conflict) => conflict.field === "weak"),
    { field: "weak", master: ["冰"], guide: ["火"] },
  );
  assert.equal(
    goblin.sources.some((source) => source.kind === "master") &&
      goblin.sources.some((source) => source.kind === "guide"),
    true,
  );
  assert.deepEqual(
    monstersIn(knowledge, { areaName: "图尔村" }).map((monster) => monster.name),
    ["哥布林", "水精灵"],
  );
});

void test("statusThreats sums encounter chance × move rate and marks unknown rates", async () => {
  const knowledge = await loaded();
  const threats = statusThreats(monstersIn(knowledge, { areaIds: [10] }));
  const poison = threats.find((threat) => threat.status === "中毒");
  assert.ok(poison !== undefined);
  assert.equal(poison.unknown, false);
  assert.ok(poison.score !== null && Math.abs(poison.score - 0.15) < 1e-9);
  const move = poison.moves[0];
  assert.ok(move !== undefined);
  assert.equal(move.monster, "哥布林");
  assert.equal(move.rate, 0.25);
  const silence = threats.find((threat) => threat.status === "沉默");
  assert.ok(silence !== undefined);
  assert.equal(silence.score, null);
  assert.equal(silence.unknown, true);
});

void test("blueMagicSources lists monsters only for spells this save has not learned", async () => {
  const knowledge = await loaded();
  assert.deepEqual(
    blueMagicSources(knowledge).map((source) => source.name),
    ["毒针", "水波"],
  );
  const left = blueMagicSources(knowledge, { learned: [2] });
  assert.deepEqual(
    left.map((source) => source.name),
    ["水波"],
  );
  assert.equal(left[0]?.from[0]?.monster, "水精灵");
});

void test("chestsIn matches the guide's running number and keeps the opened flag", async () => {
  const knowledge = await loaded();
  const all = chestsIn(knowledge);
  assert.equal(all.length, 3);
  const first = all.find((chest) => chest.id === 1);
  assert.ok(first !== undefined);
  assert.equal(first.opened, true);
  assert.equal(first.guide?.n, 1);
  assert.equal(
    first.sources.some((source) => source.kind === "guide"),
    true,
  );
  assert.deepEqual(
    chestsIn(knowledge, { opened: false }).map((chest) => chest.id),
    [2, 3],
  );
  assert.deepEqual(
    chestsIn(knowledge, { opened: true }).map((chest) => chest.id),
    [1],
  );
  assert.deepEqual(
    chestsIn(knowledge, { areaIds: [20] }).map((chest) => chest.id),
    [2, 3],
  );
  assert.deepEqual(
    chestsIn(knowledge, { areaName: "图尔村" }).map((chest) => chest.id),
    [1],
  );
  assert.deepEqual(
    chestsIn(knowledge, { areaName: "Wind Shrine" }).map((chest) => chest.id),
    [2, 3],
  );
});

void test("shopsNear merges guide goods and records a price conflict", async () => {
  const knowledge = await loaded();
  const shops = shopsNear(knowledge, "图尔村");
  assert.equal(shops.length, 1);
  const shop = shops[0];
  assert.ok(shop !== undefined);
  assert.equal(shop.guideWhere, "Tule Item Shop");
  assert.deepEqual(
    shop.products.map((product) => product.name),
    ["Potion", "Antidote"],
  );
  assert.deepEqual(shop.conflicts, [{ field: "product:Potion:price", master: 100, guide: 120 }]);
});

void test("itemsThatCure returns items and magic from the master", async () => {
  const knowledge = await loaded();
  assert.deepEqual(
    itemsThatCure(knowledge, "中毒").map((cure) => cure.name),
    ["Antidote", "Cure"],
  );
  assert.deepEqual(itemsThatCure(knowledge, "石化"), []);
});

void test("missablesAfter marks deadlines at or before the story point", async () => {
  const knowledge = await loaded();
  const rules = missablesAfter(knowledge, "scenario_5");
  assert.equal(rules.length > 0, true);
  assert.equal(
    rules.some((rule) => rule.past === "scenario_3" && rule.lostAfter),
    true,
  );
  assert.equal(
    rules.some((rule) => rule.past === "scenario_7" && !rule.lostAfter),
    true,
  );
  assert.equal(
    rules.some((rule) => rule.kind === "treasure" && rule.areaIds.includes(71)),
    true,
  );
  assert.equal(
    rules.every((rule) => rule.sources.some((source) => source.kind === "guide")),
    true,
  );
});

void test("chest content comes from the last find/containing/for phrase, never the walkthrough", () => {
  const sentences: readonly (readonly [string, string | null])[] = [
    [
      "Once you regain control, head southeast to find a secret path. Follow it and open the chest to find a Phoenix Down.",
      "Phoenix Down",
    ],
    ["Follow it and open the treasure chest containing a Leather Shield.", "Leather Shield"],
    ["Search the barrel for 150 Gil.", "150 Gil"],
    ["Search the top left box for a Tent.", "Tent"],
    ["Inspect the bush at the top of the house for a Phoenix Down.", "Phoenix Down"],
    ["Go through the nearby door.", null],
  ];
  for (const [sentence, expected] of sentences) {
    assert.equal(guideContent(sentence), expected);
  }
  assert.equal(
    guideContent("Open the chest to find a strange trinket.", ["Strange Trinket"]),
    "Strange Trinket",
  );
  assert.equal(
    guideContent("Open it for Mythril Gloves (with a red arrow).", ["Mythril Gloves"]),
    "Mythril Gloves",
  );
});

void test("a boss's maps come from its encounter rows and the areas those rows name", async () => {
  const knowledge = await loaded();
  // Water Spirit has one area-scoped row (area 10 = 图尔村) and one map-scoped row (map 2).
  assert.deepEqual(bossMapIds(knowledge, { name: "水精灵" }), [1, 2]);
  assert.deepEqual(bossMapIds(knowledge, { bookId: 8 }), [1, 2]);
  assert.deepEqual(bossMapIds(knowledge, { name: "没有这个首领" }), []);
});

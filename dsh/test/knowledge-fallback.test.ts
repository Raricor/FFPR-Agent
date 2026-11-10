import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { Guide } from "../src/engine/guide/kb.ts";
import {
  chestsIn,
  itemsThatCure,
  loadKnowledge,
  missablesAfter,
  monstersIn,
  shopsNear,
  statusThreats,
} from "../src/engine/knowledge/index.ts";

const HOME = join(import.meta.dirname, "fixtures", "knowledge");
const NO_STATIC = join(HOME, "missing-static");

async function observedAtlas(): Promise<Atlas> {
  const atlas = new Atlas();
  await atlas.visit(1, "图尔村", [], [{ cell: [9, 9], name: "Hidden Potion" }]);
  return atlas;
}

void test("with no export, the guide still answers monsters, chests and shops", async () => {
  const guide = await Guide.load(join(HOME, "guide.json"));
  assert.ok(guide !== null);
  const knowledge = await loadKnowledge({
    game: "ff5",
    guide,
    staticDir: NO_STATIC,
    atlas: await observedAtlas(),
    atlasSave: null,
    bestiarySave: null,
    collisions: null,
  });
  assert.deepEqual(knowledge.tables, []);

  const monsters = monstersIn(knowledge);
  assert.deepEqual(
    monsters.map((monster) => monster.name),
    ["Goblin", "Water Spirit", "Moldwynd"],
  );
  assert.deepEqual(
    monstersIn(knowledge, { areaName: "Wind Shrine" }).map((monster) => monster.name),
    ["Water Spirit", "Moldwynd"],
  );
  assert.deepEqual(
    monstersIn(knowledge, { areaName: "Tule" }).map((monster) => monster.name),
    ["Goblin"],
  );
  assert.equal(
    monsters.every((monster) => monster.sources.every((source) => source.kind === "guide")),
    true,
  );
  assert.deepEqual(statusThreats(monsters), []);

  const chests = chestsIn(knowledge);
  assert.equal(
    chests.some((chest) => chest.contentName === "Potion"),
    true,
  );
  assert.equal(
    chests.some((chest) => chest.contentName === "Hidden Potion" && chest.observed),
    true,
  );
  assert.equal(
    chests.every((chest) =>
      chest.sources.every((source) => source.kind === "guide" || source.kind === "observed"),
    ),
    true,
  );
  assert.deepEqual(
    chestsIn(knowledge, { areaName: "Wind Shrine" }).map((chest) => chest.guide?.n),
    [2, 3],
  );

  const shops = shopsNear(knowledge, "Tule");
  assert.equal(shops.length, 1);
  const shop = shops[0];
  assert.ok(shop !== undefined);
  assert.equal(shop.guideWhere, "Tule Item Shop");
  assert.equal(
    shop.sources.every((source) => source.kind === "guide"),
    true,
  );
  assert.deepEqual(itemsThatCure(knowledge, "中毒"), []);

  const rules = missablesAfter(knowledge, "scenario_5");
  assert.equal(rules.length > 0, true);
  assert.equal(
    rules.every((rule) => rule.sources.every((source) => source.kind === "guide")),
    true,
  );
});

void test("with neither export nor guide, the atlas alone still answers chests and maps", async () => {
  const knowledge = await loadKnowledge({
    game: "ff5",
    guide: null,
    staticDir: NO_STATIC,
    atlas: await observedAtlas(),
    atlasSave: null,
    bestiarySave: null,
    collisions: null,
  });
  assert.deepEqual(
    knowledge.maps.map((map) => map.name),
    ["图尔村"],
  );
  const chests = chestsIn(knowledge);
  assert.equal(chests.length, 1);
  const chest = chests[0];
  assert.ok(chest !== undefined);
  assert.equal(chest.contentName, "Hidden Potion");
  assert.equal(chest.opened, null);
  assert.deepEqual(
    chest.sources.map((source) => source.kind),
    ["observed"],
  );
  assert.deepEqual(monstersIn(knowledge), []);
});

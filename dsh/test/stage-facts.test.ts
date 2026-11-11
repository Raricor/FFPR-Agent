import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { loadKnowledge } from "../src/engine/knowledge/index.ts";
import {
  buildStageFacts,
  describeStageFacts,
  STAGE_FACTS_LIMIT,
} from "../src/engine/stage/facts.ts";
import type { StageFacts } from "../src/engine/stage/types.ts";

const KNOWLEDGE_HOME = join(import.meta.dirname, "fixtures", "knowledge");
const REAL_HOME = join(import.meta.dirname, "..", "..", ".deps", "knowledge", "ff5");

const PARTY: StageFacts["party"] = [
  {
    name: "巴兹",
    job: "战士",
    level: 5,
    hp: 100,
    maxHp: 100,
    mp: 10,
    maxMp: 20,
    status: [],
    spells: [],
  },
];

const BAG: StageFacts["bag"] = [{ name: "Potion", count: 2 }];

async function syntheticKnowledge(home = KNOWLEDGE_HOME, staticDir?: string) {
  return loadKnowledge({
    game: "ff5",
    home,
    ...(staticDir === undefined ? {} : { staticDir }),
    guidePath: join(KNOWLEDGE_HOME, "guide.json"),
    atlas: null,
    collisions: null,
    bestiarySave: null,
    atlasSave: null,
    progress: { openedChests: [1], visitedMaps: [] },
  });
}

function atlasWithPoints(): Atlas {
  const atlas = new Atlas();
  atlas.maps.set("2", {
    name: "风之神殿",
    exits: [],
    chests: [{ cell: [9, 9], name: "SavePoint" }],
    savePoints: [[1, 2]],
    recoveryPoints: [{ cell: [3, 4], label: "回复装置" }],
  });
  return atlas;
}

void test("synthetic export: monsters, threats, missing blue magic, chests and shops reach the sheet", async () => {
  const knowledge = await syntheticKnowledge();
  const input = {
    target: { mapId: 2, areaName: "风之神殿", label: "风之神殿" },
    knowledge,
    atlas: atlasWithPoints(),
    party: PARTY,
    bag: BAG,
    gil: 100,
  };
  const facts = buildStageFacts(input);

  assert.deepEqual(
    facts.monsters.map((monster) => monster.name),
    ["哥布林", "水精灵"],
  );
  const goblin = facts.monsters[0];
  const waterSpirit = facts.monsters[1];
  assert.ok(goblin !== undefined);
  assert.ok(waterSpirit !== undefined);
  assert.deepEqual(goblin.weak, ["冰"]);
  assert.deepEqual(goblin.statusMoves, [{ name: "毒针", conditions: ["中毒"] }]);
  assert.deepEqual(waterSpirit.blueMagic, ["水波"]);
  assert.equal(waterSpirit.boss, true);
  assert.equal(
    facts.monsters.every((monster) => monster.sources.includes("游戏数据")),
    true,
  );

  const poison = facts.statusThreats.find((threat) => threat.status === "中毒");
  assert.ok(poison !== undefined);
  assert.equal(poison.likelihood, "medium");
  assert.deepEqual(poison.monsters, ["哥布林"]);
  const silence = facts.statusThreats.find((threat) => threat.status === "沉默");
  assert.ok(silence !== undefined);
  assert.equal(silence.likelihood, "unknown");

  assert.deepEqual(
    facts.blueMagicMissing.map((spell) => spell.name),
    ["毒针", "水波"],
  );
  assert.equal(
    facts.blueMagicMissing.every((spell) => spell.missable === false),
    true,
  );
  const learned = buildStageFacts({ ...input, learnedBlueMagic: ["毒针"] });
  assert.deepEqual(
    learned.blueMagicMissing.map((spell) => spell.name),
    ["水波"],
  );

  assert.deepEqual(
    facts.chests.map((chest) => chest.content),
    ["Ether", "Elixir"],
  );
  assert.equal(
    facts.chests.every((chest) => chest.opened === false),
    true,
  );
  const elixir = facts.chests[1];
  assert.ok(elixir !== undefined);
  assert.equal(elixir.cell?.[0], 7);

  assert.deepEqual(facts.savePoints, [
    { mapId: 2, cell: [1, 2] },
    { mapId: 2, cell: [9, 9] },
  ]);
  assert.deepEqual(facts.recoveryPoints, [{ mapId: 2, cell: [3, 4], label: "回复装置" }]);

  assert.deepEqual(
    facts.shops.map((shop) => shop.area),
    ["图尔村"],
  );
  assert.deepEqual(
    facts.shops[0]?.products.map((product) => product.name),
    ["Potion", "Antidote"],
  );

  const text = describeStageFacts(facts);
  for (const expected of [
    "哥布林",
    "水精灵",
    "中毒(中)",
    "背包没有能治的,队伍也不会",
    "毒针",
    "水波",
    "Ether",
    "Elixir",
    "存档点 地图 2 (1,2)",
    "回复点 地图 2 (3,4)",
    "图尔村",
    "Antidote",
    "金钱 100",
  ]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
  assert.ok(Array.from(text).length <= STAGE_FACTS_LIMIT);
});

void test("guide only: the sheet still answers, and every monster source is the guide", async () => {
  const knowledge = await syntheticKnowledge(KNOWLEDGE_HOME, join(KNOWLEDGE_HOME, "no-static"));
  assert.deepEqual(knowledge.tables, []);
  const facts = buildStageFacts({
    target: { mapId: null, areaName: "Tule", label: "Tule" },
    knowledge,
    party: PARTY,
    bag: BAG,
    gil: 0,
  });
  assert.ok(facts.monsters.length > 0);
  assert.equal(
    facts.monsters.every(
      (monster) => monster.sources.length === 1 && monster.sources[0] === "攻略",
    ),
    true,
  );
  assert.ok(facts.chests.length > 0);
  const text = describeStageFacts(facts);
  assert.match(text, /攻略/u);
  assert.ok(Array.from(text).length <= STAGE_FACTS_LIMIT);
});

void test("describeStageFacts cuts a sheet longer than the limit", async () => {
  const knowledge = await syntheticKnowledge();
  const facts = buildStageFacts({
    target: { mapId: 2, areaName: "风之神殿", label: "风之神殿" },
    knowledge,
    party: PARTY,
    bag: BAG,
    gil: 0,
  });
  const text = describeStageFacts({
    ...facts,
    guideText: "攻略".repeat(STAGE_FACTS_LIMIT),
  });
  assert.ok(Array.from(text).length <= STAGE_FACTS_LIMIT);
  assert.match(text, /事实单太长/u);
});

async function hasRealGuide(): Promise<boolean> {
  try {
    await access(join(REAL_HOME, "guide.json"));
    return true;
  } catch {
    return false;
  }
}

void test("real local FF5 guide cache: 火力船 has 3+ monsters and 1+ chest", async (t) => {
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
  const facts = buildStageFacts({
    target: { mapId: null, areaName: "火力船", label: "火力船" },
    knowledge,
    party: PARTY,
    bag: BAG,
    gil: 1000,
  });
  assert.ok(facts.monsters.length >= 3, `火力船应至少有 3 种怪,实际 ${facts.monsters.length}`);
  assert.ok(facts.chests.length >= 1, `火力船应至少有 1 个宝箱,实际 ${facts.chests.length}`);
  const text = describeStageFacts(facts);
  assert.ok(Array.from(text).length <= STAGE_FACTS_LIMIT);
});

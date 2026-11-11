import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import {
  buildKnowledge,
  loadKnowledge,
  type EncountersRow,
  type ItemsRow,
  type Knowledge,
  type MapsRow,
  type MonstersRow,
  type ShopsRow,
  type StaticData,
  type TreasuresRow,
} from "../src/engine/knowledge/index.ts";
import {
  SEGMENT_FACTS_LIMIT,
  chooseDefaultSection,
  segmentFacts,
  withBossTriggers,
} from "../src/engine/plan/facts.ts";
import { validatePlan } from "../src/engine/plan/validate.ts";
import type { RouteBookSave, RouteChest, RouteSection } from "../src/engine/stage/route-book.ts";
import { parseWalkthrough } from "../src/engine/stage/guide-steps.ts";
import { buildRouteBook } from "../src/engine/stage/route-book.ts";
import { isRecord } from "../src/engine/values.ts";

function mapRow(id: number, name: string, areaName = "试验迷宫"): MapsRow {
  return { id, name, areaId: 7, areaName, areaType: "1" };
}

function monsterRow(
  id: number,
  bookId: number,
  name: string,
  options: {
    weak?: readonly string[];
    absorb?: readonly string[];
    boss?: boolean;
    hp?: number;
    moves?: MonstersRow["moves"];
  } = {},
): MonstersRow {
  return {
    id,
    name,
    bookId,
    level: 3,
    hp: options.hp ?? 30,
    mp: 10,
    weak: options.weak ?? [],
    absorb: options.absorb ?? [],
    nullify: [],
    statusImmune: [],
    drops: [],
    steal: [],
    boss: options.boss ?? false,
    scriptId: null,
    moves: options.moves ?? [],
  };
}

function encounter(mapId: number, monsterId: number, weight = 50): EncountersRow {
  return {
    scope: "map",
    mapId,
    areaId: null,
    groupId: 1,
    weight,
    monsterIds: [monsterId],
  };
}

function treasure(id: number, mapId: number, cell: [number, number], name: string): TreasuresRow {
  return {
    id,
    areaId: null,
    mapId,
    cell,
    hidden: false,
    contentId: null,
    contentName: name,
    count: 1,
    flag: String(id),
  };
}

function shopRow(products: readonly [string, number, number?][]): ShopsRow {
  return {
    id: 3,
    mapId: 10,
    areaName: "试验镇",
    kind: "魔法店",
    products: products.map(([name, price, itemId]) => ({
      itemId: itemId ?? null,
      name,
      price,
    })),
  };
}

function itemRow(id: number, name: string): ItemsRow {
  return { id, name, kind: "item", price: 10, cures: [], restores: null };
}

function makeKnowledge(atlas: Atlas | null = null): Knowledge {
  const data: StaticData = {
    game: "ff5",
    build: null,
    bridge: null,
    dir: "test",
    tables: ["maps", "monsters", "encounters", "treasures", "shops", "items", "magic"],
    maps: [mapRow(10, "试验迷宫 １层"), mapRow(11, "试验迷宫 ２层"), mapRow(12, "试验迷宫 ３层")],
    monsters: [
      monsterRow(8, 8, "黑哥布林", {
        weak: ["冰"],
        absorb: ["火"],
        moves: [
          {
            abilityId: null,
            name: "毒针",
            blueMagic: false,
            conditions: ["中毒"],
            rate: 0.5,
          },
          {
            abilityId: null,
            name: "Goblin Punch",
            blueMagic: true,
            conditions: [],
            rate: null,
          },
        ],
      }),
      monsterRow(10, 10, "风形魔", {
        moves: [
          {
            abilityId: null,
            name: "Aero",
            blueMagic: true,
            conditions: [],
            rate: null,
          },
        ],
      }),
      monsterRow(20, 20, "巨翼猛禽", { boss: true, hp: 250, absorb: ["冰"] }),
    ],
    encounters: [encounter(10, 8), encounter(11, 8), encounter(11, 10), encounter(12, 20)],
    treasures: [treasure(1, 10, [1, 2], "Tent"), treasure(2, 11, [3, 4], "Ether")],
    shops: [
      shopRow([
        ["恢复药", 10, 1],
        ["解毒药", 20],
        ["<IC_BMGC>解毒药", 20],
        ["Fire", 150, 392],
        ["<IC_ITEM>Potion", 40, 1],
      ]),
    ],
    items: [itemRow(1, "恢复药"), itemRow(2, "解毒药")],
    magic: [],
    sources: [],
  };
  return buildKnowledge({
    static: data,
    files: {
      dir: "test",
      maps: [],
      resources: [],
      items: [
        {
          id: 1,
          kind: "item",
          typeId: 1,
          typeValue: 1,
          nameKey: null,
          names: { ja: "ポーション", en: "Potion", zhc: "恢复药" },
        },
        {
          id: 2,
          kind: "item",
          typeId: 1,
          typeValue: 2,
          nameKey: null,
          names: { ja: "毒消し", en: "Antidote", zhc: "解毒药" },
        },
        {
          id: 392,
          kind: "magic",
          typeId: 4,
          typeValue: 126,
          nameKey: null,
          names: { ja: "ファイア", en: "Fire", zhc: "火炎" },
        },
      ],
      monsterSets: [],
      monsterParties: [],
      monsterNames: new Map(),
      encounterAreas: [],
      encounterGrids: [],
      sources: [],
    },
    guide: null,
    atlas,
    collisions: null,
    profile: null,
    progress: {
      openedChestsKnown: false,
      openedChests: [],
      bestiary: [],
      blueMagic: [],
      visitedMapsKnown: false,
      visitedMaps: [],
    },
  });
}

function makeAtlas(): Atlas {
  const atlas = new Atlas();
  atlas.maps.set("10", {
    name: "试验迷宫 １层",
    exits: [{ cell: [9, 9], to: 11, name: "楼梯" }],
  });
  atlas.maps.set("11", {
    name: "试验迷宫 ２层",
    exits: [{ cell: [1, 1], to: 10, name: "楼梯" }],
  });
  atlas.maps.set("12", { name: "试验迷宫 ３层", exits: [] });
  return atlas;
}

function chestOf(): RouteChest {
  return {
    stepIndex: 0,
    where: "试验迷宫 - 1F",
    kind: "chest",
    n: 1,
    item: "Tent",
    text: "Open for a Tent.",
    mapId: 10,
    mapName: "试验迷宫 １层",
    cell: [1, 2],
    opened: false,
    match: "name",
    note: "按名字对上",
    candidates: [],
  };
}

function makeSection(): RouteSection {
  const chest = chestOf();
  return {
    title: "试验迷宫",
    order: 0,
    areaName: "试验迷宫",
    maps: [
      {
        mapId: 10,
        name: "试验迷宫 １层",
        areaName: "试验迷宫",
        reasons: ["楼层 1F"],
      },
      {
        mapId: 11,
        name: "试验迷宫 ２层",
        areaName: "试验迷宫",
        reasons: ["楼层 2F"],
      },
      {
        mapId: 12,
        name: "试验迷宫 ３层",
        areaName: "试验迷宫",
        reasons: ["首领"],
      },
    ],
    places: [],
    stations: [
      {
        index: 0,
        where: "试验迷宫 - 1F",
        kind: "chest",
        mapId: 10,
        cell: [1, 2],
        action: "开宝箱(Tent)",
        text: "Open for a Tent.",
        basis: "按名字对上",
        chest,
        pointCandidate: null,
      },
      {
        index: 1,
        where: "试验迷宫 - 1F",
        kind: "heal",
        mapId: 10,
        cell: [5, 5],
        action: "回复",
        text: "The pot heals.",
        basis: "游戏文件",
        chest: null,
        pointCandidate: null,
      },
      {
        index: 2,
        where: "试验迷宫 - 2F",
        kind: "save",
        mapId: 11,
        cell: [6, 6],
        action: "存档",
        text: "Save here.",
        basis: "游戏文件",
        chest: null,
        pointCandidate: null,
      },
      {
        index: 3,
        where: "试验迷宫 - 3F",
        kind: "boss",
        mapId: 12,
        cell: null,
        action: "打首领",
        text: "Wing Raptor",
        basis: "首领",
        chest: null,
        pointCandidate: null,
      },
    ],
    notes: [],
    chests: [chest],
    guideChestItems: ["Tent"],
    chestsMatched: 1,
    chestsTotal: 1,
    monsters: [
      {
        bookId: 8,
        name: "黑哥布林",
        guideName: "Black Goblin",
        boss: false,
        registered: false,
        missable: true,
        missableUntil: "只在这一段出现",
        maps: [10, 11],
        note: "只在这一段出现,错过就没了",
      },
      {
        bookId: 10,
        name: "风形魔",
        guideName: "Moldwynd",
        boss: false,
        registered: false,
        missable: false,
        missableUntil: null,
        maps: [11],
        note: "",
      },
    ],
    bosses: [
      {
        bookId: 20,
        name: "Wing Raptor",
        guideName: null,
        boss: true,
        registered: null,
        missable: false,
        missableUntil: null,
        maps: [12],
        note: "",
      },
    ],
    blueMagic: [
      {
        name: "Aero",
        teachers: [{ monster: "风形魔", bookId: 10, maps: [11], allMaps: [11] }],
        learned: false,
        hasBlueMage: true,
        maps: [11],
        otherPlaces: [],
        note: "",
        timing: "now",
        when: "现在",
        window: "试验迷宫",
      },
    ],
    grind: [
      {
        what: "黑哥布林",
        monster: "黑哥布林",
        mapId: 11,
        weight: 50,
        chance: 0.5,
        reason: "只在这一段出现",
        until: { blueMagic: null },
      },
    ],
    revisit: null,
    bestiaryMissing: 2,
    blueMagicMissing: 1,
    mismatches: [],
  };
}

const SAVE: RouteBookSave = {
  bestiary: null,
  blueMagic: null,
  jobs: ["青魔导士"],
  openedChests: null,
};
const PARTY = [
  {
    name: "巴兹",
    job: "青魔导士",
    level: 5,
    hp: 100,
    maxHp: 100,
    mp: 20,
    maxMp: 20,
    status: [],
    spells: [],
  },
];
const BAG = [{ name: "恢复药", count: 2 }];

void test("opened chests do not finish a section before its last story flag", () => {
  const base = makeSection();
  const cutscene = {
    index: 9,
    where: null,
    kind: "cutscene" as const,
    mapId: 10,
    cell: [3, 4] as const,
    action: "剧情",
    text: "Farris joins the party.",
    basis: "游戏文件：事件 sc_e_0001(法利斯入队)",
    chest: null,
    pointCandidate: null,
  };
  const section: RouteSection = {
    ...base,
    bosses: [],
    chests: base.chests.map((chest) => ({ ...chest, opened: true })),
    stations: [...base.stations, cutscene],
  };
  const notYet = segmentFacts({
    section,
    knowledge: makeKnowledge(makeAtlas()),
    save: { ...SAVE, storyFlags: new Set() },
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.equal(notYet.data.storyDone, false);
  const played = segmentFacts({
    section,
    knowledge: makeKnowledge(makeAtlas()),
    save: { ...SAVE, storyFlags: new Set(["sc_e_0001"]) },
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.equal(played.data.storyDone, true);
});

void test("a registered bestiary boss is defeated even when its route row has no number", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const base = makeSection();
  const boss = base.bosses[0];
  assert.ok(boss !== undefined);
  const section: RouteSection = {
    ...base,
    bosses: [{ ...boss, bookId: null, name: "巨翼猛禽" }],
  };
  const save: RouteBookSave = { ...SAVE, bestiary: new Set([20]) };
  const facts = segmentFacts({
    section,
    knowledge,
    save,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  const bossFacts = facts.data.bosses[0];
  assert.ok(bossFacts !== undefined);
  assert.equal(bossFacts.defeated, true);
  assert.equal(bossFacts.bookId, 20);
});

void test("segment shops use the map clerk and carry the guide's magic names", () => {
  const base = makeKnowledge(makeAtlas());
  const knowledge = {
    ...base,
    mapFiles: [
      {
        id: 10,
        name: "试验迷宫 １层",
        title: { ja: "魔法店", en: "Magic Shop", zhc: "魔法店" },
        npcs: [{ cell: [4, 4], name: "店员", shopId: 38 }],
      },
    ],
    shops: [
      {
        id: 38,
        mapId: 11,
        areaName: "图尔村",
        kind: "武器",
        products: [
          { itemId: 392, name: "火炎", price: 150, aliases: ["Fire"] },
          { itemId: 393, name: "治疗", price: 180, aliases: ["Cure"] },
        ],
      },
    ],
  } as unknown as Knowledge;
  const facts = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.equal(facts.data.shops.length, 1);
  const shop = facts.data.shops[0];
  assert.ok(shop !== undefined);
  assert.equal(shop.kind, "魔法");
  assert.deepEqual(
    shop.products.map((product) => product.name),
    ["火炎", "治疗"],
  );
  assert.deepEqual(shop.products[0]?.aliases, ["Fire"]);
  const fire = {
    ...facts.draftPlan,
    prep: { ...facts.draftPlan.prep, buy: [{ item: "Fire", count: 1 }] },
  };
  assert.deepEqual(validatePlan(fire, facts.data).problems, []);
});

void test("synthetic section: facts carry maps, stations, monsters, boss and shop", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const facts = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.equal(facts.data.section, "试验迷宫");
  assert.deepEqual(
    facts.data.maps.map((map) => map.mapId),
    [10, 11, 12],
  );
  assert.deepEqual(
    facts.data.passThrough.map((map) => map.mapId),
    [],
  );
  assert.equal(
    facts.data.stations.some((station) => station.do === "open"),
    true,
  );
  assert.equal(facts.data.stations.find((station) => station.do === "heal")?.optional, true);
  assert.equal(facts.data.stations.find((station) => station.do === "save")?.optional, true);
  assert.equal(
    facts.data.stations.find((station) => station.do === "grind")?.until?.bestiary?.[0],
    8,
  );
  assert.equal(facts.data.chests[0]?.item, "Tent");
  assert.equal(facts.data.monsters.find((monster) => monster.name === "黑哥布林")?.weak[0], "冰");
  const boss = facts.data.bosses[0];
  assert.ok(boss !== undefined);
  assert.equal(boss.name, "Wing Raptor");
  assert.equal(boss.knowledgeName, "巨翼猛禽");
  assert.equal(boss.hp, 250);
  assert.equal(facts.data.shops[0]?.area, "试验镇");
  assert.equal(facts.data.bag[0]?.count, 2);
  assert.equal(facts.data.blueMagic[0]?.canLearn, true);

  const text = facts.text;
  for (const expected of [
    "试验迷宫",
    "开宝箱",
    "黑哥布林",
    "弱:冰",
    "可能错过",
    "Wing Raptor(巨翼猛禽)",
    "HP 250",
    "试验镇",
    "恢复药",
    "Aero",
    "青魔导士",
  ]) {
    assert.ok(text.includes(expected), `事实文本缺少「${expected}」`);
  }
  assert.ok(Array.from(text).length <= SEGMENT_FACTS_LIMIT);
});

void test("the conservative draft keeps the route-book stations and passes validation", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const facts = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.deepEqual(facts.draftPlan.stations, facts.data.stations);
  assert.deepEqual(facts.draftPlan.battle, []);
  assert.deepEqual(facts.draftPlan.bosses, []);
  assert.equal(facts.draftPlan.version, 1);
  const validation = validatePlan(facts.draftPlan, facts.data);
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
});

void test("a long fact sheet is cut with a pointer to the full data", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const section = makeSection();
  const long = {
    ...section,
    mismatches: Array.from({ length: 300 }, (_, index) => `说明 ${index} ${"长".repeat(40)}`),
  };
  const facts = segmentFacts({
    section: long,
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.ok(Array.from(facts.text).length <= SEGMENT_FACTS_LIMIT);
  assert.match(facts.text, /完整见/u);
});

void test("shop names match through icon tags and the three languages", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const facts = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  const plan = {
    ...facts.draftPlan,
    prep: {
      jobs: [],
      equip: "keep",
      buy: [
        { item: "火炎", count: 1 },
        { item: "Potion", count: 2 },
        { item: "解毒药", count: 1 },
      ],
      rows: [],
    },
  };
  assert.deepEqual(validatePlan(plan, facts.data).problems, []);
  assert.equal(facts.text.includes("<IC_"), false);
  const missing = validatePlan(
    { ...plan, prep: { ...plan.prep, buy: [{ item: "圣灵药", count: 1 }] } },
    facts.data,
  );
  assert.match(missing.problems.join("\n"), /这些店有卖：/u);
  assert.match(missing.problems.join("\n"), /恢复药/u);
});

void test("stations may stand on the current map and cross the maps on the way", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const facts = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
    currentMapId: 204,
    routeMaps: [204, 30, 11],
  });
  assert.deepEqual(
    facts.data.passThrough.map((map) => map.mapId),
    [204, 30],
  );
  const plan = {
    ...facts.draftPlan,
    stations: [
      { to: "204", do: "save", optional: true },
      { to: "30", do: "move" },
      { to: "10:1,2", do: "open" },
      { to: "12", do: "boss" },
    ],
  };
  assert.deepEqual(validatePlan(plan, facts.data).problems, []);
  const unrelated = validatePlan({ ...plan, stations: [{ to: "99", do: "move" }] }, facts.data);
  assert.match(unrelated.problems.join("\n"), /地图 99 不属于这一节/u);
});

void test("default section: the unfinished section here, else the next unfinished one", () => {
  const base = makeSection();
  const sectionAt = (title: string, order: number, mapIds: readonly number[]) => ({
    ...base,
    title,
    order,
    areaName: title,
    maps: mapIds.map((mapId) => ({
      mapId,
      name: `地图 ${mapId}`,
      areaName: title,
      reasons: [],
    })),
  });
  const first = sectionAt("第一段", 0, [10]);
  const second = sectionAt("第二段", 1, [20]);
  const here = chooseDefaultSection([first, second], 10, () => false);
  assert.ok(here !== null);
  assert.equal(here.section.title, "第一段");
  assert.match(here.reason, /当前地图 10/u);
  const next = chooseDefaultSection([first, second], 10, (section) => section.title === "第一段");
  assert.ok(next !== null);
  assert.equal(next.section.title, "第二段");
  assert.match(next.reason, /下一个没完成/u);
  const unrelated = chooseDefaultSection([first, second], 99, () => false);
  assert.ok(unrelated !== null);
  assert.equal(unrelated.section.title, "第一段");
  assert.match(unrelated.reason, /不属于/u);
  const facts = segmentFacts({
    section: first,
    knowledge: makeKnowledge(makeAtlas()),
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
    sectionReason: next.reason,
  });
  assert.match(facts.text, /取这一节:当前地图 10/u);
});

const REAL_DEPS = join(import.meta.dirname, "..", "..", ".deps");
const REAL_HOME = join(REAL_DEPS, "knowledge", "ff5");

async function hasRealData(): Promise<boolean> {
  try {
    await access(join(REAL_DEPS, "ds", "atlas-ff5.json"));
    await access(join(REAL_HOME, "guide.json"));
    await access(join(REAL_HOME, "static", "maps.json"));
    return true;
  } catch {
    return false;
  }
}

void test("real FF5 data: Wind Shrine facts list the boss and four unopened chests", async (t) => {
  if (!(await hasRealData())) {
    t.skip("没有本机 .deps 的 FF5 地图记录或知识导出");
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
  const atlas = await Atlas.load(join(REAL_DEPS, "ds", "atlas-ff5.json"));
  const raw: unknown = JSON.parse(await readFile(join(REAL_HOME, "guide.json"), "utf8"));
  if (!isRecord(raw)) assert.fail("真实 guide.json 不是对象");
  const sections = parseWalkthrough(raw.walkthrough);
  const book = buildRouteBook({
    sections,
    fromSection: "Prologue",
    fromPlace: "Cave - Entrance",
    toSection: "Wind Shrine",
    knowledge,
    atlas,
    visitOrder: [],
    save: {
      bestiary: new Set(knowledge.progress.bestiary),
      blueMagic: null,
      jobs: null,
      openedChests: null,
    },
  });
  const wind = book.sections.find((section) => section.title === "Wind Shrine");
  assert.ok(wind !== undefined);
  const save: RouteBookSave = {
    bestiary: new Set(knowledge.progress.bestiary),
    blueMagic: null,
    jobs: null,
    openedChests: null,
  };
  const facts = segmentFacts({
    section: wind,
    knowledge,
    save,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.equal(facts.data.chests.length, 4);
  assert.match(facts.text, /Wing Raptor|巨翼猛禽/u);
  for (const item of ["Tent", "Leather Cap", "Broadsword", "Staff"]) {
    assert.ok(facts.text.includes(item), `事实文本缺少宝箱「${item}」`);
  }
  assert.match(facts.text, /4 个没开/u);
  assert.equal(validatePlan(facts.draftPlan, facts.data).ok, true);
  assert.ok(Array.from(facts.text).length <= SEGMENT_FACTS_LIMIT);
  t.diagnostic(`Wind Shrine 事实长度 ${Array.from(facts.text).length} 字`);
});

void test("boss triggers come from event names in the supplied map files", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const facts = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
    files: {
      events: [
        {
          mapId: 12,
          file: "ev_e_0001.json",
          name: "巨翼猛禽と戦闘",
          cell: [7, 8],
          rect: null,
          scriptId: null,
        },
        {
          mapId: 12,
          file: "ev_e_0002.json",
          name: "別のイベント",
          cell: [1, 1],
          rect: null,
          scriptId: null,
        },
      ],
      npcs: [],
    },
  });
  assert.deepEqual(facts.data.bosses[0]?.triggers, [{ map: 12, cell: [7, 8] }]);
  assert.match(facts.text, /触发点 12:7,8/u);
  assert.equal(facts.draftPlan.stations.find((station) => station.do === "boss")?.to, "12:7,8");

  const chest = { to: "10:1,2", do: "open" as const };
  const mapOnly = validatePlan(
    { ...facts.draftPlan, stations: [chest, { to: "12", do: "boss" }] },
    facts.data,
  );
  assert.match(mapOnly.problems.join("\n"), /要写坐标/u);
  assert.match(mapOnly.problems.join("\n"), /巨翼猛禽的触发点是 12:7,8/u);
  const withCell = validatePlan(
    { ...facts.draftPlan, stations: [chest, { to: "12:7,8", do: "boss" }] },
    facts.data,
  );
  assert.deepEqual(withCell.problems, []);
});

void test("a set boss story flag marks it defeated when the bestiary has no entry", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const save: RouteBookSave = {
    ...SAVE,
    bestiary: new Set(),
    storyFlags: new Set(["ev_e_0001.json"]),
  };
  const facts = segmentFacts({
    section: makeSection(),
    knowledge,
    save,
    party: PARTY,
    bag: BAG,
    gil: 100,
    files: {
      events: [
        {
          mapId: 12,
          file: "ev_e_0001.json",
          name: "巨翼猛禽と戦闘",
          cell: [7, 8],
          rect: null,
          scriptId: null,
        },
      ],
      npcs: [],
    },
  });
  assert.equal(facts.data.bosses[0]?.defeated, true);
});

void test("the healing line is facts only: spells, healing items and revive items", () => {
  const knowledge = makeKnowledge(makeAtlas());
  const someone = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: [
      {
        name: "蕾娜",
        job: "白魔法师",
        level: 5,
        hp: 90,
        maxHp: 100,
        mp: 30,
        maxMp: 30,
        status: [],
        spells: ["治疗", "救疗"],
      },
    ],
    bag: [
      { name: "恢复药", count: 3 },
      { name: "高级恢复药", count: 1 },
      { name: "不死鸟之尾", count: 2 },
    ],
    gil: 100,
  });
  assert.ok(someone.data.healing !== undefined);
  assert.deepEqual(someone.data.healing.spells, [
    { member: "蕾娜", spell: "治疗" },
    { member: "蕾娜", spell: "救疗" },
  ]);
  assert.deepEqual(someone.data.healing.items, [
    { name: "恢复药", count: 3 },
    { name: "高级恢复药", count: 1 },
  ]);
  assert.deepEqual(someone.data.healing.reviveItems, [{ name: "不死鸟之尾", count: 2 }]);
  assert.match(someone.text, /回复手段:治疗\(蕾娜\)、救疗\(蕾娜\)/u);
  assert.match(someone.text, /不死鸟之尾×2\(复活\)/u);
  assert.equal(someone.text.includes("建议"), false);

  const itemsOnly = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: [{ name: "恢复药", count: 2 }],
    gil: 100,
  });
  assert.ok(itemsOnly.data.healing !== undefined);
  assert.deepEqual(itemsOnly.data.healing.spells, []);
  assert.deepEqual(itemsOnly.data.healing.items, [{ name: "恢复药", count: 2 }]);
  assert.deepEqual(itemsOnly.data.healing.reviveItems, []);
  assert.match(itemsOnly.text, /回复手段:恢复药×2\(回复\)/u);

  const none = segmentFacts({
    section: makeSection(),
    knowledge,
    save: SAVE,
    party: PARTY,
    bag: [],
    gil: 100,
  });
  assert.deepEqual(none.data.healing, {
    spells: [],
    items: [],
    reviveItems: [],
  });
  assert.match(none.text, /回复手段:没人会回复魔法，没有回复道具/u);
});

void test("withBossTriggers adds trigger cells to a sheet built without files", () => {
  const base = segmentFacts({
    section: makeSection(),
    knowledge: makeKnowledge(makeAtlas()),
    save: SAVE,
    party: PARTY,
    bag: BAG,
    gil: 100,
  });
  assert.deepEqual(base.data.bosses[0]?.triggers, []);
  const enriched = withBossTriggers(base, {
    events: [
      {
        mapId: 12,
        file: "ev_e_0001.json",
        name: "巨翼猛禽と戦闘",
        cell: [7, 8],
        rect: null,
        scriptId: null,
      },
    ],
    npcs: [],
  });
  assert.deepEqual(enriched.data.bosses[0]?.triggers, [{ map: 12, cell: [7, 8] }]);
  assert.match(enriched.text, /触发点 12:7,8/u);
  assert.equal(enriched.draftPlan.stations.find((station) => station.do === "boss")?.to, "12:7,8");
  assert.equal(enriched.data.stations.find((station) => station.do === "boss")?.to, "12:7,8");
});

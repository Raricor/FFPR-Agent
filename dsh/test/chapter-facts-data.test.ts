import assert from "node:assert/strict";
import test from "node:test";
import { Guide } from "../src/engine/guide/kb.ts";
import type { GameMapFile } from "../src/engine/knowledge/game-files.ts";
import {
  buildKnowledge,
  type EncountersRow,
  type Knowledge,
  type MapKnowledge,
  type MapsRow,
  type MonstersRow,
  type StaticData,
} from "../src/engine/knowledge/index.ts";
import { buildChapterFacts, chapterFactsText } from "../src/engine/plan/chapter-facts.ts";
import {
  describeChapterSectionFacts,
  segmentFacts,
  type SegmentFactsData,
} from "../src/engine/plan/facts.ts";
import type { RouteSection } from "../src/engine/stage/route-book.ts";

function map(id: number, name: string): MapKnowledge {
  return {
    id,
    name,
    areaId: 9,
    areaName: "试验地区",
    areaType: "1",
    visited: false,
    sources: [],
    conflicts: [],
  };
}

function knowledge(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    game: "ff5",
    filesDir: null,
    guide: null,
    atlas: null,
    maps: [map(10, "试验镇"), map(11, "试验迷宫")],
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
    ...overrides,
  } as unknown as Knowledge;
}

function section(order: number, maps: RouteSection["maps"]): RouteSection {
  return {
    title: `S${order}`,
    order,
    areaName: "试验地区",
    maps,
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

function factsData(): SegmentFactsData {
  return {
    game: "ff5",
    section: "Ship Graveyard",
    areaName: null,
    goal: "走完沉船",
    maps: Array.from({ length: 41 }, (_value, index) => ({
      mapId: 100 + index,
      name: `地图 ${100 + index}`,
      areaName: null,
      reasons: [],
      exits: [],
    })),
    passThrough: [],
    revisitMaps: [],
    stations: [{ to: "10:1,1", do: "move", why: "去沉船" }],
    chests: [
      {
        item: "帐篷",
        where: null,
        mapId: 10,
        mapName: "试验镇",
        cell: [1, 1],
        opened: false,
        note: "",
      },
    ],
    monsters: [],
    bosses: [],
    shops: [],
    party: [
      {
        name: "巴兹",
        job: "战士",
        level: 5,
        hp: 100,
        maxHp: 100,
        mp: 10,
        maxMp: 10,
        status: [],
        spells: [],
      },
    ],
    bag: [{ name: "恢复药", count: 2 }],
    gil: 50,
    bestiaryMissing: [],
    blueMagic: [],
    blueMagicMissing: [],
    notes: [],
  };
}

void test("section text keeps stations/chests/bosses/monsters before the map list", () => {
  const facts = factsData();
  const text = describeChapterSectionFacts(facts, 900);
  const order = ["站点草稿", "宝箱", "首领", "怪物", "地图与连通"].map((heading) =>
    text.indexOf(heading),
  );
  assert.equal(
    order.every((index) => index >= 0),
    true,
  );
  assert.deepEqual(
    [...order].sort((left, right) => left - right),
    order,
  );
  assert.match(text, /另 \d+ 张图略/u);
  assert.equal(text.includes("队伍"), false);
  assert.equal(text.includes("背包"), false);
});

void test("a map held only by an area-name match is not part of the section", () => {
  const route = section(5, [
    { mapId: 10, name: "试验镇", areaName: "试验地区", reasons: ["楼层 1F"] },
    {
      mapId: 11,
      name: "火力船 １层",
      areaName: "火力船",
      reasons: ["小节「Ship Graveyard - Sunken Shipwreck」对上了这个地区"],
    },
  ]);
  const facts = segmentFacts({
    section: route,
    knowledge: knowledge(),
    save: null,
    party: [],
    bag: [],
    gil: 0,
  });
  assert.deepEqual(
    facts.data.maps.map((entry) => entry.mapId),
    [10],
  );
});

void test("shops infer the kind from goods, use Chinese names and a separate inn price", () => {
  const custom = knowledge({
    maps: [{ ...map(10, "图尔村"), areaName: "图尔村" }, map(11, "试验迷宫")],
    shops: [
      {
        id: 43,
        mapId: 10,
        areaName: "图尔村",
        kind: "道具",
        products: [
          {
            itemId: 3,
            name: "Leather Shield",
            price: 300,
            sources: [],
            conflicts: [],
          },
        ],
        guideWhere: "测试店",
        sources: [],
        conflicts: [],
      },
      {
        id: 35,
        mapId: 10,
        areaName: "图尔村",
        kind: "旅店",
        products: [{ itemId: null, name: "Rest", price: 20, sources: [], conflicts: [] }],
        guideWhere: "测试店",
        sources: [],
        conflicts: [],
      },
    ],
    contentItems: [
      {
        id: 3,
        kind: "armor",
        names: { ja: "レザーシールド", en: "Leather Shield", zhc: "皮盾" },
        sources: [],
      },
    ],
  });
  const data = buildChapterFacts({
    chapter: { chapter: 2, from: 4, to: 4 },
    sections: [section(4, [{ mapId: 10, name: "试验镇", areaName: "图尔村", reasons: [] }])],
    knowledge: custom,
    save: null,
    party: [],
    bag: [],
    gil: 0,
  });
  const text = chapterFactsText(data);
  assert.match(text, /图尔村 防具/u);
  assert.match(text, /皮盾 300/u);
  assert.match(text, /图尔村 旅店/u);
  assert.match(text, /住宿 20/u);
  assert.equal(text.includes("Rest 20"), false);
  assert.equal(text.includes("Leather Shield"), false);
});

function row(id: number, name: string, areaName: string): MapsRow {
  return { id, name, areaId: 9, areaName, areaType: "1" };
}

function monsterRow(id: number, bookId: number, name: string): MonstersRow {
  return {
    id,
    name,
    bookId,
    level: 3,
    hp: 30,
    mp: 10,
    weak: [],
    absorb: [],
    nullify: [],
    statusImmune: [],
    drops: [],
    steal: [],
    boss: false,
    scriptId: null,
    moves: [],
  };
}

function encounter(mapId: number, monsterIds: readonly number[]): EncountersRow {
  return {
    scope: "map",
    mapId,
    areaId: null,
    groupId: 1,
    weight: 50,
    monsterIds,
  };
}

void test("a world map lists only the monsters the chapter's guide section names", () => {
  const data: StaticData = {
    game: "ff5",
    build: null,
    bridge: null,
    dir: "test",
    tables: ["maps", "monsters", "encounters"],
    maps: [row(1, "Map_10010", "世界地图"), row(10, "Map_10", "图尔村")],
    monsters: [monsterRow(1, 1, "哥布林"), monsterRow(2, 2, "秘银龙")],
    encounters: [encounter(1, [1, 2])],
    treasures: [],
    shops: [],
    items: [],
    magic: [],
    sources: [],
  };
  const built = buildKnowledge({
    static: data,
    files: null,
    guide: null,
    atlas: null,
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
  const route: RouteSection = {
    ...section(4, [{ mapId: 1, name: "世界地图", areaName: "世界地图", reasons: [] }]),
    monsters: [
      {
        bookId: 1,
        name: "哥布林",
        guideName: null,
        boss: false,
        registered: false,
        missable: false,
        missableUntil: null,
        maps: [1],
        note: "",
      },
    ],
  };
  const facts = buildChapterFacts({
    chapter: { chapter: 1, from: 4, to: 4 },
    sections: [route],
    knowledge: built,
    save: null,
    party: [],
    bag: [],
    gil: 0,
  });
  assert.deepEqual(
    facts.encounters.flatMap((entry) => entry.monsters.map((monster) => monster.name)),
    ["哥布林"],
  );
});

void test("the shop table's kind wins over a reused product group's wrong export label", () => {
  const data: StaticData = {
    game: "ff5",
    build: null,
    bridge: null,
    dir: "test",
    tables: ["maps", "shops"],
    maps: [row(10, "Map_10", "图尔村")],
    monsters: [],
    encounters: [],
    treasures: [],
    shops: [
      {
        id: 43,
        mapId: 10,
        areaName: "图尔村",
        kind: "WhiteMagic",
        products: [{ itemId: null, name: "Potion", price: 10 }],
      },
      {
        id: 35,
        mapId: 10,
        areaName: "图尔村",
        kind: "Weapon",
        products: [{ itemId: null, name: "Rest", price: 20 }],
      },
    ],
    items: [],
    magic: [],
    sources: [],
  };
  const guide = new Guide(
    [
      {
        title: "图尔村",
        text: "",
        shops: [
          {
            where: "图尔村道具店",
            kind: "Items",
            goods: [{ name: "Potion", cost: 10, note: "" }],
          },
        ],
      },
      {
        title: "图尔村",
        text: "",
        shops: [
          {
            where: "图尔村旅店",
            kind: "Inn",
            goods: [{ name: "Rest", cost: 20, note: "" }],
          },
        ],
      },
    ],
    new Map(),
  );
  const built = buildKnowledge({
    static: data,
    files: null,
    guide,
    atlas: null,
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
  assert.deepEqual(
    built.shops.map((shop) => shop.kind),
    ["Items", "Inn"],
  );
  const facts = buildChapterFacts({
    chapter: { chapter: 2, from: 4, to: 4 },
    sections: [section(4, [{ mapId: 10, name: "图尔村", areaName: "图尔村", reasons: [] }])],
    knowledge: built,
    save: null,
    party: [],
    bag: [],
    gil: 0,
  });
  const text = chapterFactsText(facts);
  assert.match(text, /图尔村 道具/u);
  assert.match(text, /图尔村 旅店/u);
  assert.match(text, /住宿 20/u);
});

void test("hidden treasure and script event rewards are separate text tables", () => {
  const custom = knowledge({
    contentItems: [
      {
        id: 1,
        kind: "item",
        names: { ja: "ポーション", en: "Potion", zhc: "恢复药" },
        sources: [],
      },
      {
        id: 2,
        kind: "item",
        names: { ja: "エリクサー", en: "Elixir", zhc: "万能药" },
        sources: [],
      },
    ],
  });
  const files: GameMapFile[] = [
    {
      id: 10,
      name: "Map_10",
      areaId: 9,
      saveAvailable: true,
      chests: [],
      hiddenItems: [
        { cell: [1, 1], contentId: 1, contentNum: 1, flagId: 1, script: null },
        {
          cell: [2, 2],
          contentId: 2,
          contentNum: 1,
          flagId: null,
          script: "sc_e_0198",
        },
      ],
      npcs: [],
      savePoints: [],
      restorePoints: [],
    },
  ];
  const data = buildChapterFacts({
    chapter: { chapter: 2, from: 4, to: 4 },
    sections: [section(4, [{ mapId: 10, name: "图尔村", areaName: "图尔村", reasons: [] }])],
    knowledge: custom,
    save: null,
    party: [],
    bag: [],
    gil: 0,
    files,
  });
  assert.deepEqual(
    data.hiddenItems.map((item) => [item.kind, item.item]),
    [
      ["hidden", "恢复药"],
      ["event", "万能药"],
    ],
  );
  const text = chapterFactsText(data);
  assert.match(text, /### 隐藏道具\(1 个\)/u);
  assert.match(text, /### 事件奖励\(1 个\)/u);
  assert.match(text, /事件奖励，触发条件看攻略\(脚本 sc_e_0198\)/u);
});

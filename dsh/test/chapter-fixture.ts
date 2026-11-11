/**
 * Shared chapter-plan fixture for the task 151 tests. It is a synthetic two-section chapter:
 * one section with a chest, a hidden item, a boss, a missing bestiary entry, a missing blue
 * spell and a shop; one section with nothing to collect. No game files or bridge are involved.
 */

import type {
  ChapterEncounterMap,
  ChapterFactsData,
  ChapterHiddenItem,
  ChapterPlan,
  ChapterShop,
} from "../src/engine/plan/chapter-types.ts";
import type {
  SegmentFactsBlueMagic,
  SegmentFactsBoss,
  SegmentFactsChest,
  SegmentFactsData,
  SegmentFactsMap,
  SegmentFactsMonster,
} from "../src/engine/plan/facts.ts";
import type { PlanStation, SegmentPlan } from "../src/engine/plan/types.ts";

export function testMap(mapId: number, name = `测试地图 ${mapId}`): SegmentFactsMap {
  return { mapId, name, areaName: "测试地区", reasons: [], exits: [] };
}

export function testChest(options: {
  readonly item: string;
  readonly mapId: number;
  readonly cell: readonly [number, number];
  readonly opened?: boolean | null;
}): SegmentFactsChest {
  return {
    item: options.item,
    where: null,
    mapId: options.mapId,
    mapName: `测试地图 ${options.mapId}`,
    cell: options.cell,
    opened: options.opened ?? false,
    note: "",
  };
}

export function testBoss(options: {
  readonly name: string;
  readonly maps: readonly number[];
  readonly defeated?: boolean | null;
}): SegmentFactsBoss {
  return {
    name: options.name,
    knowledgeName: null,
    guideName: null,
    bookId: 100,
    maps: options.maps,
    triggers: [],
    defeated: options.defeated ?? false,
    hp: 100,
    mp: 10,
    level: 5,
    weak: [],
    absorb: [],
    nullify: [],
    statusImmune: [],
    guideNote: "",
    note: "",
  };
}

export function testMonster(options: {
  readonly name: string;
  readonly bookId: number;
  readonly maps: readonly number[];
  readonly registered?: boolean | null;
  readonly blueMagic?: readonly string[];
}): SegmentFactsMonster {
  return {
    name: options.name,
    guideName: null,
    bookId: options.bookId,
    level: 3,
    hp: 30,
    mp: 0,
    weak: [],
    absorb: [],
    nullify: [],
    statusImmune: [],
    statusMoves: [],
    blueMagic: options.blueMagic ?? [],
    maps: options.maps,
    chance: 0.5,
    missable: false,
    missableUntil: null,
    registered: options.registered ?? false,
    boss: false,
    note: "",
  };
}

export function testBlueMagic(options: {
  readonly name: string;
  readonly maps?: readonly number[];
  readonly canLearn?: boolean;
  readonly learned?: boolean;
}): SegmentFactsBlueMagic {
  return {
    name: options.name,
    learned: options.learned ?? false,
    canLearn: options.canLearn ?? true,
    maps: options.maps ?? [10],
    teachers: [{ monster: "哥布林", bookId: 8, maps: options.maps ?? [10] }],
    timing: "now",
    when: "现在",
    window: "第一迷宫",
    note: "",
  };
}

export function testSegmentFacts(
  section: string,
  maps: readonly number[],
  overrides: Partial<SegmentFactsData> = {},
): SegmentFactsData {
  return {
    game: "ff5",
    section,
    areaName: section,
    goal: `走完${section}`,
    maps: maps.map((mapId) => testMap(mapId)),
    passThrough: [],
    revisitMaps: [],
    stations: [],
    chests: [],
    monsters: [],
    bosses: [],
    shops: [],
    party: [
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
    ],
    bag: [],
    gil: 100,
    bestiaryMissing: [],
    blueMagic: [],
    blueMagicMissing: [],
    notes: [],
    storyDone: true,
    ...overrides,
  };
}

function testShop(products: readonly { readonly name: string; readonly price: number }[]): {
  area: string;
  kind: string;
  products: readonly { name: string; price: number }[];
} {
  return { area: "试验镇", kind: "道具店", products };
}

function chapterShop(
  products: readonly { readonly name: string; readonly price: number }[],
): ChapterShop {
  return {
    mapId: 10,
    town: "试验镇",
    kind: "道具店",
    counter: [4, 4],
    products,
  };
}

function hiddenItem(): ChapterHiddenItem {
  return {
    kind: "hidden",
    mapId: 10,
    cell: [2, 2],
    item: "隐形草",
    opened: false,
    source: "测试",
  };
}

function encounter(mapId: number, monsters: ChapterEncounterMap["monsters"]): ChapterEncounterMap {
  return { mapId, mapName: `测试地图 ${mapId}`, monsters };
}

export function testChapterFacts(overrides: Partial<ChapterFactsData> = {}): ChapterFactsData {
  const products = [
    { name: "恢复药", price: 10 },
    { name: "高级药", price: 100 },
  ];
  const first = testSegmentFacts("第一迷宫", [10], {
    chests: [testChest({ item: "恢复药", mapId: 10, cell: [1, 1] })],
    monsters: [testMonster({ name: "哥布林", bookId: 8, maps: [10] })],
    bosses: [testBoss({ name: "哥布林王", maps: [10] })],
    blueMagic: [testBlueMagic({ name: "水泡" })],
    blueMagicMissing: [testBlueMagic({ name: "水泡" })],
    shops: [testShop(products)],
  });
  const second = testSegmentFacts("第二迷宫", [11]);
  return {
    game: "ff5",
    chapter: 1,
    from: 0,
    to: 1,
    sections: [
      { index: 0, title: "第一迷宫", done: false, facts: first },
      { index: 1, title: "第二迷宫", done: false, facts: second },
    ],
    hiddenItems: [hiddenItem()],
    shops: [chapterShop(products)],
    encounters: [
      encounter(10, [
        {
          name: "哥布林",
          bookId: 8,
          registered: false,
          blueMagic: ["水泡"],
          exp: 10,
          gil: 5,
          abp: 1,
        },
      ]),
    ],
    ...overrides,
  };
}

export function testStation(
  overrides: Partial<PlanStation> & Pick<PlanStation, "to" | "do">,
): PlanStation {
  return { ...overrides };
}

export function testSegmentPlan(
  section: string,
  stations: readonly PlanStation[] = [],
  overrides: Partial<SegmentPlan> = {},
): SegmentPlan {
  return {
    version: 1,
    section,
    goal: `走完${section}`,
    prep: { jobs: [], equip: "keep", buy: [], rows: [] },
    stations,
    battle: [],
    bosses: [],
    turnBack: [],
    ...overrides,
  };
}

/** The two-section plan that passes `validateChapterPlan` unchanged. */
export function testChapterPlan(overrides: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    version: 1,
    chapter: 1,
    goal: "走完第一章",
    segments: [
      testSegmentPlan("第一迷宫", [
        testStation({ to: "10:1,1", do: "open" }),
        testStation({ to: "10:2,2", do: "open" }),
        testStation({ to: "10:5,5", do: "boss" }),
        testStation({
          to: "10:3,3",
          do: "grind",
          until: { bestiary: [8], blueMagic: ["水泡"], minutes: 5 },
        }),
        testStation({
          to: "10:4,4",
          do: "buy",
          items: [{ item: "恢复药", count: 2 }],
        }),
      ]),
      testSegmentPlan("第二迷宫"),
    ],
    growth: [{ before: 0, level: 10, where: "10:3,3", why: "先练级", maxMinutes: 10 }],
    fallback: {
      retries: 3,
      bossLost: { levels: 1, where: "10:3,3", tries: 1 },
      skipOptional: true,
      healBelowPct: 30,
    },
    ...overrides,
  };
}

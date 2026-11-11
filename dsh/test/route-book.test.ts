import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import {
  buildKnowledge,
  loadKnowledge,
  type EncountersRow,
  type Knowledge,
  type MagicRow,
  type MonstersRow,
  type MapsRow,
  type StaticData,
  type TreasuresRow,
} from "../src/engine/knowledge/index.ts";
import { Guide } from "../src/engine/guide/kb.ts";
import { parseWalkthrough } from "../src/engine/stage/guide-steps.ts";
import type { GuideSection, GuideStep, GuideStepKind } from "../src/engine/stage/guide-types.ts";
import {
  buildRouteBook,
  buildRouteBookAsync,
  type RouteBook,
  type RouteBookFiles,
  type RouteBookInput,
} from "../src/engine/stage/route-book.ts";
import {
  loadRouteBook,
  readRouteBookFiles,
  readVisitOrder,
} from "../src/engine/stage/route-book-load.ts";
import { handoffText, routeFromBookSection } from "../src/engine/stage/book-plan.ts";
import { renderRouteBook } from "../src/engine/stage/route-book-render.ts";
import { isRecord } from "../src/engine/values.ts";

const REAL_DEPS = join(import.meta.dirname, "..", "..", ".deps");

function mapRow(id: number, name: string, areaName: string, areaId = 1): MapsRow {
  return { id, name, areaId, areaName, areaType: "1" };
}

function monsterRow(
  id: number,
  bookId: number,
  name: string,
  options: { boss?: boolean; blue?: string | null } = {},
): MonstersRow {
  const blue = options.blue ?? null;
  return {
    id,
    name,
    bookId,
    level: 1,
    hp: 10,
    mp: 0,
    weak: [],
    absorb: [],
    nullify: [],
    statusImmune: [],
    drops: [],
    steal: [],
    boss: options.boss ?? false,
    scriptId: null,
    moves:
      blue === null
        ? []
        : [
            {
              abilityId: null,
              name: blue,
              blueMagic: true,
              conditions: [],
              rate: null,
            },
          ],
  };
}

function encounter(mapId: number, monsterId: number, weight = 100): EncountersRow {
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

function magicRow(id: number, name: string): MagicRow {
  return { id, name, school: "青魔法", mp: 0, cures: [] };
}

interface KnowledgeSpec {
  readonly maps: readonly MapsRow[];
  readonly monsters?: readonly MonstersRow[];
  readonly encounters?: readonly EncountersRow[];
  readonly treasures?: readonly TreasuresRow[];
  readonly magic?: readonly MagicRow[];
}

function makeKnowledge(spec: KnowledgeSpec, guide: Guide | null = null): Knowledge {
  const data: StaticData = {
    game: "ff5",
    build: null,
    bridge: null,
    dir: "test",
    tables: ["maps", "monsters", "encounters", "treasures", "shops", "items", "magic"],
    maps: spec.maps,
    monsters: spec.monsters ?? [],
    encounters: spec.encounters ?? [],
    treasures: spec.treasures ?? [],
    shops: [],
    items: [],
    magic: spec.magic ?? [],
    sources: [],
  };
  return buildKnowledge({
    static: data,
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
}

interface AtlasEntrySpec {
  readonly name: string;
  readonly exits?: readonly {
    cell: [number, number];
    to: number;
    name: string;
  }[];
  readonly chests?: readonly { cell: [number, number]; name: string }[];
  readonly savePoints?: readonly (readonly [number, number])[];
  readonly recoveryPoints?: readonly {
    cell: [number, number];
    label: string;
  }[];
}

function makeAtlas(spec: Readonly<Record<number, AtlasEntrySpec>>): Atlas {
  const atlas = new Atlas();
  for (const [key, entry] of Object.entries(spec)) {
    atlas.maps.set(key, {
      name: entry.name,
      exits: entry.exits ?? [],
      chests: entry.chests ?? [],
      ...(entry.savePoints === undefined ? {} : { savePoints: entry.savePoints }),
      ...(entry.recoveryPoints === undefined ? {} : { recoveryPoints: entry.recoveryPoints }),
    });
  }
  return atlas;
}

function step(
  index: number,
  kind: GuideStepKind,
  where: string | null,
  text: string,
  extra: Partial<GuideStep> = {},
): GuideStep {
  return {
    index,
    where,
    kind,
    text,
    ref: null,
    item: null,
    boss: null,
    ...extra,
  };
}

function section(
  title: string,
  places: readonly string[],
  steps: readonly GuideStep[],
  monsters: GuideSection["monsters"] = [],
): GuideSection {
  return { title, order: 0, places, steps, monsters };
}

function input(
  sections: readonly GuideSection[],
  knowledge: Knowledge,
  atlas: Atlas,
  options: {
    from?: string;
    fromPlace?: string;
    to?: string;
    visitOrder?: readonly string[];
    bestiary?: ReadonlySet<number> | null;
    blueMagic?: readonly string[] | null;
    jobs?: readonly string[] | null;
    openedChests?: ReadonlySet<string> | null;
    treasureFlags?: ReadonlyMap<number, boolean | null> | null;
    files?: RouteBookFiles | null;
  } = {},
): RouteBookInput {
  return {
    sections,
    fromSection: options.from ?? sections[0]?.title ?? "",
    ...(options.fromPlace === undefined ? {} : { fromPlace: options.fromPlace }),
    toSection: options.to ?? sections.at(-1)?.title ?? "",
    knowledge,
    atlas,
    visitOrder: options.visitOrder ?? [],
    save: {
      bestiary: options.bestiary ?? null,
      blueMagic: options.blueMagic ?? null,
      jobs: options.jobs ?? null,
      openedChests: options.openedChests ?? null,
      ...(options.treasureFlags === undefined ? {} : { treasureFlags: options.treasureFlags }),
    },
    ...(options.files === undefined ? {} : { files: options.files }),
  };
}

function first(book: RouteBook): RouteBook["sections"][number] {
  const found = book.sections[0];
  assert.ok(found !== undefined);
  return found;
}

void test("alignment by bestiary number: the monster's encounter map is claimed with the number", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫", "试验迷宫")],
    monsters: [monsterRow(8, 8, "黑哥布林")],
    encounters: [encounter(10, 8)],
  });
  const atlas = makeAtlas({ 10: { name: "试验迷宫 １层" } });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          [],
          [step(0, "move", null, "Go north.")],
          [{ id: 8, name: "Black Goblin", blueMagic: null, where: null }],
        ),
      ],
      knowledge,
      atlas,
    ),
  );
  const result = first(book);
  assert.deepEqual(
    result.maps.map((map) => map.mapId),
    [10],
  );
  assert.match(result.maps[0]?.reasons.join(";") ?? "", /怪物 008 在这张图遇得到/u);
});

void test("alignment by floor: 2F and B2 match the full-width map names", () => {
  const knowledge = makeKnowledge({
    maps: [
      mapRow(10, "试验迷宫 ２层", "试验迷宫"),
      mapRow(11, "试验迷宫 ３层", "试验迷宫"),
      mapRow(12, "试验迷宫 地下２层", "试验迷宫"),
    ],
  });
  const atlas = makeAtlas({
    10: { name: "试验迷宫 ２层" },
    11: { name: "试验迷宫 ３层" },
    12: { name: "试验迷宫 地下２层" },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          ["试验迷宫 - 2F", "试验迷宫 - B2"],
          [
            step(0, "move", "试验迷宫 - 2F", "Go up."),
            step(1, "move", "试验迷宫 - B2", "Go down."),
          ],
        ),
      ],
      knowledge,
      atlas,
    ),
  );
  const result = first(book);
  assert.deepEqual(
    result.maps.map((map) => map.mapId),
    [10, 12],
  );
  assert.match(result.maps[0]?.reasons.join(";") ?? "", /楼层 2F ↔ ２层/u);
  assert.match(result.maps[1]?.reasons.join(";") ?? "", /楼层 B2 ↔ 地下２层/u);
});

void test("alignment by exits: a floorless side room joins its same-area neighbour", () => {
  const knowledge = makeKnowledge({
    maps: [
      mapRow(10, "试验迷宫 ２层", "试验迷宫"),
      mapRow(11, "试验迷宫 小房间", "试验迷宫"),
      mapRow(20, "试验迷宫 ４层", "试验迷宫"),
    ],
  });
  const atlas = makeAtlas({
    10: {
      name: "试验迷宫 ２层",
      exits: [
        { cell: [1, 1], to: 11, name: "小房间" },
        { cell: [2, 2], to: 20, name: "４层" },
      ],
    },
    11: {
      name: "试验迷宫 小房间",
      exits: [{ cell: [1, 1], to: 10, name: "２层" }],
    },
    20: {
      name: "试验迷宫 ４层",
      exits: [{ cell: [2, 2], to: 10, name: "２层" }],
    },
  });
  const book = buildRouteBook(
    input(
      [section("试验迷宫", ["试验迷宫 - 2F"], [step(0, "move", "试验迷宫 - 2F", "Go in.")])],
      knowledge,
      atlas,
    ),
  );
  const result = first(book);
  assert.deepEqual(
    result.maps.map((map) => map.mapId),
    [10, 11],
  );
  assert.match(result.maps[1]?.reasons.join(";") ?? "", /和 10 同属试验迷宫，出口相连/u);
});

void test("alignment by first arrivals: a town between two known regions takes the middle area", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(1, "甲地", "甲地"), mapRow(2, "测试镇", "测试镇"), mapRow(3, "乙地", "乙地")],
    monsters: [monsterRow(1, 1, "甲怪"), monsterRow(3, 3, "乙怪")],
    encounters: [encounter(1, 1), encounter(3, 3)],
  });
  const atlas = makeAtlas({
    1: { name: "甲地" },
    2: { name: "测试镇" },
    3: { name: "乙地" },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "甲地",
          [],
          [step(0, "move", null, "Start.")],
          [{ id: 1, name: "A Monster", blueMagic: null, where: null }],
        ),
        section("测试镇", [], [step(0, "shop", null, "Buy things.")]),
        section(
          "乙地",
          [],
          [step(0, "move", null, "Finish.")],
          [{ id: 3, name: "B Monster", blueMagic: null, where: null }],
        ),
      ],
      knowledge,
      atlas,
      { visitOrder: ["甲地", "测试镇", "乙地"] },
    ),
  );
  const town = book.sections[1];
  assert.ok(town !== undefined);
  assert.deepEqual(
    town.maps.map((map) => map.mapId),
    [2],
  );
  assert.match(town.maps[0]?.reasons.join(";") ?? "", /按以前几档的到达先后/u);
  assert.match(town.maps[0]?.reasons.join(";") ?? "", /在甲地之后、乙地之前/u);
});

void test("fromPlace drops an earlier sub-location and its monsters", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫 １层", "试验迷宫"), mapRow(11, "试验迷宫 ２层", "试验迷宫")],
    monsters: [monsterRow(1, 1, "旧怪"), monsterRow(2, 2, "新怪")],
    encounters: [encounter(10, 1), encounter(11, 2)],
  });
  const atlas = makeAtlas({
    10: { name: "试验迷宫 １层" },
    11: { name: "试验迷宫 ２层" },
  });
  const full = section(
    "试验迷宫",
    ["试验迷宫 - 1F", "试验迷宫 - 2F"],
    [
      step(0, "move", "试验迷宫 - 1F", "Start."),
      step(1, "chest", "试验迷宫 - 1F", "Open the old chest.", {
        ref: { kind: "chest", n: 1 },
        item: "Old",
      }),
      step(2, "move", "试验迷宫 - 2F", "Go up."),
    ],
    [
      { id: 1, name: "Old", blueMagic: null, where: "试验迷宫 - 1F" },
      { id: 2, name: "New", blueMagic: null, where: "试验迷宫 - 2F" },
    ],
  );
  const book = buildRouteBook(input([full], knowledge, atlas, { fromPlace: "试验迷宫 - 2F" }));
  const result = first(book);
  assert.equal(book.fromPlace, "试验迷宫 - 2F");
  assert.deepEqual(
    result.places.map((place) => place.title),
    ["试验迷宫 - 2F"],
  );
  assert.deepEqual(
    result.stations.map((station) => station.where),
    ["试验迷宫 - 2F"],
  );
  assert.deepEqual(
    result.maps.map((map) => map.mapId),
    [11],
  );
  assert.deepEqual(
    result.monsters.map((monster) => monster.bookId),
    [2],
  );
  assert.equal(result.chests.length, 0);
  assert.throws(
    () => buildRouteBook(input([full], knowledge, atlas, { fromPlace: "不存在" })),
    /找不到小节/u,
  );
});

void test("a section with no evidence is listed as unmatched, not guessed", () => {
  const knowledge = makeKnowledge({ maps: [mapRow(1, "甲地", "甲地")] });
  const atlas = makeAtlas({ 1: { name: "甲地" } });
  const book = buildRouteBook(
    input([section("无名地", [], [step(0, "move", null, "Walk.")])], knowledge, atlas),
  );
  const result = first(book);
  assert.deepEqual(result.maps, []);
  assert.match(result.mismatches.join(";"), /整节没对上地图/u);
  assert.match(renderRouteBook(book), /无名地\(没对上地图\)/u);
});

void test("chests match by merged name first, then by order; count gaps and opened flags show", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫 １层", "试验迷宫")],
    treasures: [treasure(1, 10, [1, 2], "Tent"), treasure(2, 10, [3, 4], "Knife")],
  });
  const atlas = makeAtlas({
    10: {
      name: "试验迷宫 １层",
      chests: [
        { cell: [1, 2], name: "テント" },
        { cell: [3, 4], name: "ナイフ" },
      ],
    },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          ["试验迷宫 - 1F"],
          [
            step(0, "chest", "试验迷宫 - 1F", "Open for a Tent.", {
              ref: { kind: "chest", n: 6 },
              item: "Tent",
            }),
            step(1, "chest", "试验迷宫 - 1F", "Open for a mystery.", {
              ref: { kind: "chest", n: 7 },
              item: "Mystery",
            }),
            step(2, "chest", "试验迷宫 - 1F", "Open for another.", {
              ref: { kind: "chest", n: 8 },
              item: "Other",
            }),
          ],
        ),
      ],
      knowledge,
      atlas,
      { openedChests: new Set(["10:1,2"]) },
    ),
  );
  const result = first(book);
  const [tent, knife, missing] = result.chests;
  assert.ok(tent !== undefined && knife !== undefined && missing !== undefined);
  assert.equal(tent.match, "name");
  assert.deepEqual(tent.cell, [1, 2]);
  assert.equal(tent.opened, true);
  assert.equal(knife.match, "none");
  assert.equal(knife.candidates.length, 1);
  assert.deepEqual(knife.candidates[0]?.cell, [3, 4]);
  assert.equal(knife.opened, null);
  assert.equal(missing.match, "none");
  assert.equal(result.chestsMatched, 1);
  const mismatch = result.mismatches.find((item) => item.includes("地图记录"));
  assert.ok(mismatch !== undefined);
  assert.match(mismatch, /攻略 3 个，地图记录 2 个/u);
  assert.match(mismatch, /名字对不上,不配对/u);
  const text = renderRouteBook(book);
  assert.match(text, /已开/u);
  assert.match(text, /未配对/u);
});

void test("a game-file flag marks a chest opened on a map that was never loaded", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫 １层", "试验迷宫")],
    treasures: [treasure(41, 10, [1, 2], "Tent")],
  });
  const atlas = makeAtlas({
    10: { name: "试验迷宫 １层", chests: [{ cell: [1, 2], name: "テント" }] },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          ["试验迷宫 - 1F"],
          [
            step(0, "chest", "试验迷宫 - 1F", "Open for a Tent.", {
              ref: { kind: "chest", n: 1 },
              item: "Tent",
            }),
          ],
        ),
      ],
      knowledge,
      atlas,
      { openedChests: new Set(), treasureFlags: new Map([[41, true]]) },
    ),
  );
  const chest = first(book).chests[0];
  assert.ok(chest !== undefined);
  assert.equal(chest.flag, "41");
  assert.equal(chest.opened, true);
  assert.match(renderRouteBook(book), /已开/u);
});

void test("one chest per map still pairs in map order", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫 １层", "试验迷宫"), mapRow(11, "试验迷宫 ２层", "试验迷宫")],
  });
  const atlas = makeAtlas({
    10: { name: "试验迷宫 １层", chests: [{ cell: [1, 2], name: "テント" }] },
    11: { name: "试验迷宫 ２层", chests: [{ cell: [3, 4], name: "ナイフ" }] },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          ["试验迷宫 - 1F", "试验迷宫 - 2F"],
          [
            step(0, "chest", "试验迷宫 - 1F", "Open the first chest.", {
              ref: { kind: "chest", n: 1 },
              item: "First",
            }),
            step(1, "chest", "试验迷宫 - 2F", "Open the second chest.", {
              ref: { kind: "chest", n: 2 },
              item: "Second",
            }),
          ],
        ),
      ],
      knowledge,
      atlas,
    ),
  );
  const result = first(book);
  const [firstChest, secondChest] = result.chests;
  assert.ok(firstChest !== undefined && secondChest !== undefined);
  assert.equal(firstChest.match, "order");
  assert.deepEqual(firstChest.cell, [1, 2]);
  assert.equal(secondChest.match, "order");
  assert.deepEqual(secondChest.cell, [3, 4]);
  assert.equal(result.chestsMatched, 2);
});

void test("a map with several unnamed chests leaves every cell unpaired", () => {
  const knowledge = makeKnowledge({ maps: [mapRow(30, "图尔村", "图尔村")] });
  const atlas = makeAtlas({
    30: {
      name: "图尔村",
      chests: [
        { cell: [30, 13], name: "フェニックスのお" },
        { cell: [40, 13], name: "かわのくつ" },
        { cell: [29, 28], name: "テント" },
        { cell: [30, 28], name: "ポーション" },
        { cell: [45, 36], name: "150ギル" },
      ],
    },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "图尔村",
          ["图尔村"],
          [
            step(0, "hidden", "图尔村", "Search the barrel for Leather Shoes.", {
              ref: { kind: "hidden", n: 1 },
              item: "Leather Shoes",
            }),
            step(1, "hidden", "图尔村", "Search the bush for a Potion.", {
              ref: { kind: "hidden", n: 2 },
              item: "Potion",
            }),
            step(2, "hidden", "图尔村", "Search the box for a Tent.", {
              ref: { kind: "hidden", n: 3 },
              item: "Tent",
            }),
            step(3, "hidden", "图尔村", "Search the pot for a Phoenix Down.", {
              ref: { kind: "hidden", n: 4 },
              item: "Phoenix Down",
            }),
            step(4, "hidden", "图尔村", "Search the cabinet for an Ether.", {
              ref: { kind: "hidden", n: 5 },
              item: "Ether",
            }),
          ],
        ),
      ],
      knowledge,
      atlas,
    ),
  );
  const result = first(book);
  const firstChest = result.chests[0];
  assert.ok(firstChest !== undefined);
  assert.equal(result.chestsMatched, 0);
  assert.equal(firstChest.match, "none");
  assert.equal(firstChest.candidates.length, 5);
  const stations = result.stations.filter((station) => station.action === "开这张图的宝箱");
  assert.equal(stations.length, 1);
  const station = stations[0];
  assert.ok(station !== undefined);
  assert.equal(station.mapId, 30);
  assert.match(station.text, /\(30,13\) フェニックスのお/u);
  assert.deepEqual(result.guideChestItems, [
    "Leather Shoes",
    "Potion",
    "Tent",
    "Phoenix Down",
    "Ether",
  ]);
  assert.match(result.mismatches.join(";"), /名字对不上,不配对/u);
  const text = renderRouteBook(book);
  assert.match(text, /攻略说这里有：Leather Shoes、Potion、Tent、Phoenix Down、Ether/u);
  assert.match(text, /开这张图的宝箱/u);
});

void test("amount names match by number: 150 Gil equals 150ギル", () => {
  const knowledge = makeKnowledge({ maps: [mapRow(30, "图尔村", "图尔村")] });
  const atlas = makeAtlas({
    30: { name: "图尔村", chests: [{ cell: [45, 36], name: "150ギル" }] },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "图尔村",
          ["图尔村"],
          [
            step(0, "hidden", "图尔村", "Search the box for 150 Gil.", {
              ref: { kind: "hidden", n: 1 },
              item: "150 Gil",
            }),
          ],
        ),
      ],
      knowledge,
      atlas,
    ),
  );
  const chest = first(book).chests[0];
  assert.ok(chest !== undefined);
  assert.equal(chest.match, "name");
  assert.equal(chest.mapId, 30);
  assert.deepEqual(chest.cell, [45, 36]);
});

void test("save/heal lines need a real point; potions and quick-save stay guide notes", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫 １层", "试验迷宫")],
  });
  const atlas = makeAtlas({
    10: {
      name: "试验迷宫 １层",
      savePoints: [[4, 5]],
      recoveryPoints: [{ cell: [6, 7], label: "回复装置" }],
    },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          ["试验迷宫 - 1F"],
          [
            step(0, "save", "试验迷宫 - 1F", "Use the save point."),
            step(
              1,
              "save",
              "试验迷宫 - 1F",
              "Heal up and quick-save, then interact with the boss.",
            ),
            step(2, "heal", "试验迷宫 - 1F", "Extremely easy fight; heal up with potions."),
            step(3, "heal", "试验迷宫 - 1F", "Use the recovery device."),
          ],
        ),
      ],
      knowledge,
      atlas,
    ),
  );
  const result = first(book);
  const [save, recovery] = result.stations;
  const [quickSave, potions] = result.notes;
  assert.ok(save !== undefined && recovery !== undefined);
  assert.ok(quickSave !== undefined && potions !== undefined);
  assert.equal(save.kind, "save");
  assert.equal(save.action, "存档");
  assert.deepEqual(save.cell, [4, 5]);
  assert.equal(quickSave.pointCandidate, "save");
  assert.match(quickSave.basis, /没对上真实的点/u);
  assert.equal(potions.pointCandidate, "heal");
  assert.equal(recovery.kind, "heal");
  assert.equal(recovery.action, "回复");
  assert.deepEqual(recovery.cell, [6, 7]);
  assert.match(result.mismatches.join(";"), /攻略提到存档,但没对上真实的点/u);
  assert.match(result.mismatches.join(";"), /攻略提到回复,但没对上真实的点/u);
  assert.match(renderRouteBook(book), /另有 2 条攻略说明/u);
});

void test("a monster only in this section is marked missable and gets a grind spot", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫", "试验迷宫")],
    monsters: [monsterRow(8, 8, "黑哥布林")],
    encounters: [encounter(10, 8, 100)],
  });
  const atlas = makeAtlas({ 10: { name: "试验迷宫 １层" } });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          [],
          [step(0, "move", null, "Walk.")],
          [{ id: 8, name: "Black Goblin", blueMagic: null, where: null }],
        ),
      ],
      knowledge,
      atlas,
      { bestiary: new Set<number>() },
    ),
  );
  const result = first(book);
  const monster = result.monsters[0];
  const grind = result.grind[0];
  assert.ok(monster !== undefined && grind !== undefined);
  assert.equal(monster.missable, true);
  assert.match(monster.note, /错过就没了/u);
  assert.equal(grind.mapId, 10);
  assert.equal(grind.weight, 100);
});

void test("a bestiary row from another area never pulls its map or grind stop into this section", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫", "试验迷宫"), mapRow(99, "别处高塔", "别处高塔")],
    monsters: [monsterRow(8, 8, "黑哥布林"), monsterRow(9, 9, "别处怪")],
    encounters: [encounter(10, 8, 100), encounter(99, 9, 100)],
  });
  const atlas = makeAtlas({
    10: { name: "试验迷宫 １层" },
    99: { name: "别处高塔 １层" },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          ["试验迷宫"],
          [step(0, "move", null, "Walk.")],
          [
            { id: 8, name: "Black Goblin", blueMagic: null, where: "试验迷宫" },
            { id: 9, name: "Elsewhere", blueMagic: null, where: "试验迷宫" },
          ],
        ),
      ],
      knowledge,
      atlas,
      { bestiary: new Set<number>() },
    ),
  );
  const result = first(book);
  assert.deepEqual(
    result.maps.map((map) => map.mapId),
    [10],
  );
  assert.equal(
    result.grind.some((grind) => grind.mapId === 99),
    false,
  );
});

void test("without a Blue Mage the spell says nobody can learn it and where else it appears", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验迷宫", "试验迷宫")],
    monsters: [monsterRow(8, 8, "黑哥布林", { blue: "Goblin Punch" })],
    encounters: [encounter(10, 8, 100)],
    magic: [magicRow(1, "Goblin Punch")],
  });
  const atlas = makeAtlas({ 10: { name: "试验迷宫 １层" } });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验迷宫",
          [],
          [step(0, "move", null, "Walk.")],
          [
            {
              id: 8,
              name: "Black Goblin",
              blueMagic: "Goblin Punch",
              where: null,
            },
          ],
        ),
      ],
      knowledge,
      atlas,
      { blueMagic: [], jobs: ["战士"] },
    ),
  );
  const spell = first(book).blueMagic[0];
  assert.ok(spell !== undefined);
  assert.equal(spell.name, "Goblin Punch");
  assert.equal(spell.learned, false);
  assert.equal(spell.hasBlueMage, false);
  assert.match(spell.note, /现在没人能学/u);
  assert.match(spell.note, /只在这里/u);
  assert.equal(spell.timing, "unknown");
  assert.match(spell.when, /青魔导士什么时候有不确定/u);
});

void test("blue magic before the Blue Mage is marked missed and gets a return trip", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "洞窟 １层", "洞窟")],
    monsters: [monsterRow(2, 2, "钢蝠", { blue: "Vampire" })],
    encounters: [encounter(10, 2, 100)],
    magic: [magicRow(1, "Vampire")],
  });
  const atlas = makeAtlas({
    10: {
      name: "洞窟 １层",
      exits: [{ cell: [1, 1], to: 1, name: "世界地图" }],
    },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "洞窟",
          [],
          [step(0, "move", null, "Walk.")],
          [{ id: 2, name: "Steel Bat", blueMagic: "Vampire", where: null }],
        ),
        section("中途镇", [], [step(0, "shop", null, "Buy things.")]),
        section(
          "风之神殿",
          ["Crystal Room"],
          [
            step(0, "note", "Crystal Room", "Jobs unlocked:"),
            step(1, "note", "Crystal Room", "Knight"),
            step(2, "note", "Crystal Room", "Blue Mage"),
          ],
        ),
      ],
      knowledge,
      atlas,
      { blueMagic: [] },
    ),
  );
  const spell = first(book).blueMagic[0];
  assert.ok(spell !== undefined);
  assert.equal(spell.timing, "missed");
  assert.match(spell.when, /青魔导士来之前就过去了/u);
  assert.match(spell.when, /拿到职业后回洞窟刷/u);
  assert.match(spell.window, /第1节 洞窟\(10\)/u);
  const unlock = book.sections[2];
  assert.ok(unlock !== undefined);
  assert.ok(unlock.revisit !== null);
  assert.match(unlock.revisit.title, /回头学青魔法/u);
  assert.match(unlock.revisit.note, /风之神殿/u);
  assert.equal(unlock.revisit.grind[0]?.until.blueMagic, "Vampire");
  assert.match(unlock.revisit.stations[0]?.text ?? "", /钢蝠/u);
  assert.equal(book.totals.revisit, unlock.revisit.stations.length);
  const text = renderRouteBook(book);
  assert.match(text, /\| 回头学 \|/u);
  assert.match(text, /### 回头学青魔法/u);
  assert.match(text, /直到学会 Vampire/u);
});

void test("blue magic before the Blue Mage with no way back is marked unreachable", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "闭锁洞窟 １层", "闭锁洞窟")],
    monsters: [monsterRow(2, 2, "钢蝠", { blue: "Vampire" })],
    encounters: [encounter(10, 2, 100)],
    magic: [magicRow(1, "Vampire")],
  });
  const atlas = makeAtlas({ 10: { name: "闭锁洞窟 １层" } });
  const book = buildRouteBook(
    input(
      [
        section(
          "闭锁洞窟",
          [],
          [step(0, "move", null, "Walk.")],
          [{ id: 2, name: "Steel Bat", blueMagic: "Vampire", where: null }],
        ),
        section("中途镇", [], [step(0, "shop", null, "Buy things.")]),
        section(
          "风之神殿",
          ["Crystal Room"],
          [
            step(0, "note", "Crystal Room", "Jobs unlocked:"),
            step(1, "note", "Crystal Room", "Knight"),
            step(2, "note", "Crystal Room", "Blue Mage"),
          ],
        ),
      ],
      knowledge,
      atlas,
      { blueMagic: [] },
    ),
  );
  const spell = first(book).blueMagic[0];
  assert.ok(spell !== undefined);
  assert.equal(spell.timing, "unreachable");
  assert.match(spell.when, /这一档学不到/u);
  assert.equal(book.sections[2]?.revisit, null);
  assert.equal(book.totals.revisit, 0);
});

void test("with a Blue Mage in this save the spell can be learned now", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "洞窟 １层", "洞窟")],
    monsters: [monsterRow(2, 2, "钢蝠", { blue: "Vampire" })],
    encounters: [encounter(10, 2, 100)],
    magic: [magicRow(1, "Vampire")],
  });
  const atlas = makeAtlas({ 10: { name: "洞窟 １层" } });
  const book = buildRouteBook(
    input(
      [
        section(
          "洞窟",
          [],
          [step(0, "move", null, "Walk.")],
          [{ id: 2, name: "Steel Bat", blueMagic: "Vampire", where: null }],
        ),
        section(
          "风之神殿",
          ["Crystal Room"],
          [
            step(0, "note", "Crystal Room", "Jobs unlocked:"),
            step(1, "note", "Crystal Room", "Knight"),
            step(2, "note", "Crystal Room", "Blue Mage"),
          ],
        ),
      ],
      knowledge,
      atlas,
      { blueMagic: [], jobs: ["Blue Mage"] },
    ),
  );
  const spell = first(book).blueMagic[0];
  assert.ok(spell !== undefined);
  assert.equal(spell.hasBlueMage, true);
  assert.equal(spell.timing, "now");
  assert.equal(spell.when, "现在就有");
  assert.equal(book.sections[1]?.revisit, null);
});

void test("a missed missable monster gets a bestiary return trip even without blue magic", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "洞窟 １层", "洞窟"), mapRow(20, "下一站", "下一站")],
    monsters: [monsterRow(9, 9, "恶魔蟹")],
    encounters: [encounter(10, 9, 100)],
  });
  const atlas = makeAtlas({
    10: {
      name: "洞窟 １层",
      exits: [{ cell: [1, 1], to: 1, name: "世界地图" }],
    },
    20: { name: "下一站" },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "洞窟",
          [],
          [step(0, "move", null, "Walk.")],
          [{ id: 9, name: "Devil Crab", blueMagic: null, where: null }],
        ),
        section("下一站", [], [step(0, "move", null, "Next.")]),
      ],
      knowledge,
      atlas,
      { bestiary: new Set<number>(), jobs: ["Blue Mage"] },
    ),
  );
  const revisit = book.sections[1]?.revisit;
  assert.ok(revisit !== null && revisit !== undefined);
  assert.equal(revisit.title, "回头补图鉴");
  assert.match(revisit.stations[0]?.action ?? "", /回头补图鉴 恶魔蟹/u);
  assert.equal(revisit.grind[0]?.until.blueMagic, null);
});

void test("story stations pair by event/NPC names and dialog stations take an NPC", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验洞窟", "试验洞窟")],
  });
  const atlas = makeAtlas({ 10: { name: "试验洞窟" } });
  const files: RouteBookFiles = {
    events: [
      {
        mapId: 10,
        file: "ev_e_0030.json",
        name: "sc_e_0030:后来发生的",
        cell: [9, 9],
        rect: { x1: 9, y1: 9, x2: 9, y2: 9 },
        scriptId: 30,
      },
      {
        mapId: 10,
        file: "ev_e_0021.json",
        name: "sc_e_0021:测试之家前",
        cell: [5, 5],
        rect: { x1: 5, y1: 5, x2: 5, y2: 5 },
        scriptId: 21,
      },
    ],
    npcs: [
      {
        mapId: 10,
        name: "受付",
        cell: [7, 8],
        names: { en: "Receptionist", zhc: "接待员" },
      },
    ],
  };
  const book = buildRouteBook(
    input(
      [
        section(
          "试验洞窟",
          [],
          [
            step(0, "cutscene", null, "Watch 测试之家前."),
            step(1, "cutscene", null, "Watch 后来发生的."),
            step(2, "talk", null, "Speak to the receptionist and answer yes."),
            step(3, "switch", null, "Pull the lever."),
          ],
        ),
      ],
      knowledge,
      atlas,
      { files },
    ),
  );
  const result = first(book);
  const [firstScene, secondScene, receptionist, lever] = result.stations;
  assert.ok(
    firstScene !== undefined &&
      secondScene !== undefined &&
      receptionist !== undefined &&
      lever !== undefined,
  );
  assert.deepEqual(firstScene.cell, [5, 5]);
  assert.match(firstScene.basis, /游戏文件：事件 sc_e_0021\(测试之家前\)/u);
  assert.deepEqual(secondScene.cell, [9, 9]);
  assert.match(secondScene.basis, /游戏文件：事件 sc_e_0030/u);
  assert.deepEqual(receptionist.cell, [7, 8]);
  assert.match(receptionist.basis, /游戏文件：NPC 受付/u);
  assert.equal(lever.cell, null);
  assert.doesNotMatch(lever.basis, /游戏文件/u);
  const text = renderRouteBook(book);
  assert.match(text, /\| 剧情站有坐标 \|/u);
  assert.match(text, /\| 3\/4 \|/u);
});

void test("an exported map title wins over the area's neighbouring rooms", () => {
  const title = (en: string) => ({ ja: null, en, zhc: null });
  const knowledge = makeKnowledge({
    maps: [
      mapRow(10, "图尔村", "Tule"),
      mapRow(11, "图尔村 酒馆", "Tule"),
      mapRow(12, "图尔村 佐克家", "Tule"),
    ],
  });
  const atlas = makeAtlas({
    10: { name: "图尔村", exits: [{ cell: [1, 1], to: 11, name: "Door" }] },
    11: {
      name: "图尔村 酒馆",
      exits: [{ cell: [2, 1], to: 12, name: "Door" }],
    },
    12: { name: "图尔村 佐克家", exits: [] },
  });
  const book = buildRouteBook(
    input(
      [section("Tule", ["Tule - Pub"], [step(0, "move", "Tule - Pub", "Go into the pub.")])],
      knowledge,
      atlas,
      {
        files: {
          events: [],
          npcs: [],
          titles: new Map([
            [10, title("1F")],
            [11, title("Pub")],
            [12, title("Zok's House")],
          ]),
        },
      },
    ),
  );
  const result = first(book);
  const pub = result.places.find((place) => place.title === "Tule - Pub");
  assert.ok(pub);
  assert.deepEqual(pub.mapIds, [11]);
  assert.ok(result.maps.find((map) => map.mapId === 11)?.reasons.includes("图标题 Pub"));
});

void test("exit/entrance events are never story coordinates", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验洞窟", "试验洞窟")],
  });
  const atlas = makeAtlas({ 10: { name: "试验洞窟" } });
  const files: RouteBookFiles = {
    events: [
      {
        mapId: 10,
        file: "ev_e_0021.json",
        name: "出口:ワールドマップ",
        cell: [3, 3],
        rect: { x1: 3, y1: 3, x2: 3, y2: 3 },
        scriptId: 21,
      },
    ],
    npcs: [],
  };
  const book = buildRouteBook(
    input(
      [section("试验洞窟", [], [step(0, "cutscene", null, "Go to the exit.")])],
      knowledge,
      atlas,
      { files },
    ),
  );
  const station = first(book).stations[0];
  assert.ok(station);
  assert.equal(station.cell, null);
  assert.doesNotMatch(station.basis, /游戏文件/u);
  assert.deepEqual(station.candidates ?? [], []);
});

void test("an unmatched story handoff lists the map's events and NPCs with three-language names", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(10, "试验洞窟", "试验洞窟")],
  });
  const atlas = makeAtlas({ 10: { name: "试验洞窟" } });
  const files: RouteBookFiles = {
    events: [
      {
        mapId: 10,
        file: "ev_e_0021.json",
        name: "sc_e_0021:谜之剧情",
        cell: [5, 5],
        rect: { x1: 5, y1: 5, x2: 5, y2: 5 },
        scriptId: 21,
      },
    ],
    npcs: [
      {
        mapId: 10,
        name: "受付",
        cell: [7, 8],
        names: { ja: "受付", en: "Receptionist", zhc: "接待员" },
      },
    ],
  };
  const book = buildRouteBook(
    input(
      [section("试验洞窟", [], [step(0, "cutscene", null, "Watch the scene.")])],
      knowledge,
      atlas,
      { files },
    ),
  );
  const station = first(book).stations[0];
  assert.ok(station);
  assert.equal(station.cell, null);
  assert.deepEqual(
    station.candidates?.map((candidate) => [candidate.kind, candidate.name, candidate.cell]),
    [
      ["event", "谜之剧情", [5, 5]],
      ["npc", "受付", [7, 8]],
    ],
  );
  const text = handoffText("试验洞窟", station, "地图 10");
  assert.match(text, /候选:/u);
  assert.match(text, /事件 谜之剧情 地图 10 \(5,5\)/u);
  assert.match(text, /NPC 受付\(受付\/Receptionist\/接待员\) 地图 10 \(7,8\)/u);
});

void test("a save point and a spring use the knowledge module's real cells", () => {
  const base = makeKnowledge({
    maps: [mapRow(10, "试验洞窟 １层", "试验洞窟")],
  });
  const point = (
    cell: readonly [number, number],
    name: string,
  ): Knowledge["savePoints"][number] => ({
    mapId: 10,
    mapName: "试验洞窟 １层",
    areaId: 1,
    areaName: "试验洞窟",
    cell,
    name,
    sources: [],
  });
  const knowledge: Knowledge = {
    ...base,
    savePoints: [point([6, 7], "セーブポイント")],
    restorePoints: [point([10, 22], "回復の壺"), point([12, 12], "泉")],
  };
  const atlas = makeAtlas({ 10: { name: "试验洞窟 １层" } });
  const book = buildRouteBook(
    input(
      [
        section(
          "试验洞窟",
          [],
          [
            step(0, "save", null, "Use the consecrated circle to save."),
            step(1, "heal", null, "Heal at the spring."),
            step(2, "heal", null, "Drink from the healing pot."),
          ],
        ),
      ],
      knowledge,
      atlas,
    ),
  );
  const result = first(book);
  const [savePoint, spring, pot] = result.stations;
  assert.ok(savePoint !== undefined && spring !== undefined && pot !== undefined);
  assert.deepEqual(savePoint.cell, [6, 7]);
  assert.match(savePoint.basis, /游戏文件：存档点/u);
  assert.deepEqual(spring.cell, [10, 22]);
  assert.match(spring.basis, /游戏文件：回复点/u);
  assert.deepEqual(pot.cell, [12, 12]);
  assert.deepEqual(
    result.notes.filter((note) => note.pointCandidate !== null),
    [],
  );
});

void test("render has a total table and every section's tables", () => {
  const knowledge = makeKnowledge({
    maps: [mapRow(1, "甲地", "甲地"), mapRow(2, "测试镇", "测试镇"), mapRow(3, "乙地", "乙地")],
    monsters: [monsterRow(1, 1, "甲怪"), monsterRow(3, 3, "乙怪")],
    encounters: [encounter(1, 1), encounter(3, 3)],
  });
  const atlas = makeAtlas({
    1: { name: "甲地" },
    2: { name: "测试镇" },
    3: { name: "乙地" },
  });
  const book = buildRouteBook(
    input(
      [
        section(
          "甲地",
          [],
          [step(0, "move", null, "Start.")],
          [{ id: 1, name: "A Monster", blueMagic: null, where: null }],
        ),
        section("测试镇", [], [step(0, "shop", null, "Buy things.")]),
        section(
          "乙地",
          [],
          [step(0, "move", null, "Finish.")],
          [{ id: 3, name: "B Monster", blueMagic: null, where: null }],
        ),
      ],
      knowledge,
      atlas,
      { visitOrder: ["甲地", "测试镇", "乙地"] },
    ),
  );
  const text = renderRouteBook(book);
  assert.match(text, /## 总表/u);
  assert.match(text, /## 1\. 甲地/u);
  assert.match(text, /### 地图和依据/u);
  assert.match(text, /### 站点/u);
  assert.match(text, /### 收集清单/u);
  assert.match(text, /### 对不上的地方/u);
});

const REAL_ATLAS = join(REAL_DEPS, "ds", "atlas-ff5.json");
const REAL_HOME = join(REAL_DEPS, "knowledge", "ff5");

async function hasRealData(): Promise<boolean> {
  try {
    await access(REAL_ATLAS);
    await access(join(REAL_HOME, "guide.json"));
    await access(join(REAL_HOME, "static", "maps.json"));
    return true;
  } catch {
    return false;
  }
}

void test("real FF5 data: the hand-written Wind Shrine section aligns 202-207 and reports 4 vs 3 chests", async (t) => {
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
  const atlas = await Atlas.load(REAL_ATLAS);
  const windShrine = section(
    "Wind Shrine",
    ["Wind Shrine - 1F", "Wind Shrine - 2F", "Wind Shrine - 3F"],
    [
      step(0, "move", "Wind Shrine - 1F", "Head inside."),
      step(1, "heal", "Wind Shrine - 1F", "The pot is a healing point."),
      step(2, "chest", "Wind Shrine - 2F", "Open the chest for a Tent.", {
        ref: { kind: "chest", n: 6 },
        item: "Tent",
      }),
      step(3, "save", "Wind Shrine - 2F", "Use the consecrated circle."),
      step(4, "chest", "Wind Shrine - 3F", "Open the lone chest for Leather Cap.", {
        ref: { kind: "chest", n: 7 },
        item: "Leather Cap",
      }),
      step(5, "chest", "Wind Shrine - 3F", "Go through the left door for a Broadsword.", {
        ref: { kind: "chest", n: 8 },
        item: "Broadsword",
      }),
      step(6, "boss", "Wind Shrine - 3F", "Fight the Wing Raptor by the stairs.", {
        boss: {
          name: "Wing Raptor",
          hp: 250,
          weak: [],
          resist: [],
          absorb: [],
        },
      }),
      step(7, "chest", "Wind Shrine - 4F", "Open the chest at the end for a Staff.", {
        ref: { kind: "chest", n: 9 },
        item: "Staff",
      }),
    ],
    [
      {
        id: 8,
        name: "Black Goblin",
        blueMagic: "Goblin Punch",
        where: "Wind Shrine - 2F",
      },
      {
        id: 9,
        name: "White Serpent",
        blueMagic: null,
        where: "Wind Shrine - 2F",
      },
      {
        id: 10,
        name: "Moldwynd",
        blueMagic: "Aero",
        where: "Wind Shrine - 2F",
      },
      {
        id: 11,
        name: "Mani Wizard",
        blueMagic: null,
        where: "Wind Shrine - 2F",
      },
    ],
  );
  const book = buildRouteBook(input([windShrine], knowledge, atlas));
  const result = first(book);
  assert.deepEqual(
    result.maps.map((map) => map.mapId),
    [202, 203, 204, 205, 206, 207],
  );
  assert.equal(result.chestsTotal, 4);
  assert.equal(result.chestsMatched, 3);
  const mismatch = result.mismatches.find((item) => item.includes("地图记录"));
  assert.ok(mismatch !== undefined);
  assert.match(mismatch, /攻略 4 个，地图记录 3 个/u);
  assert.match(mismatch, /4F/u);
});

void test("real FF5 data: sub-place names split Cave Entrance, Pirate Ship and Crystal Room", async (t) => {
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
  const atlas = await Atlas.load(REAL_ATLAS);
  const raw: unknown = JSON.parse(await readFile(join(REAL_HOME, "guide.json"), "utf8"));
  if (!isRecord(raw)) assert.fail("真实 guide.json 不是对象");
  const sections = parseWalkthrough(raw.walkthrough);
  const book = buildRouteBook(
    input(sections, knowledge, atlas, {
      from: "Prologue",
      fromPlace: "Cave - Entrance",
      to: "Wind Shrine",
    }),
  );
  const prologue = book.sections.find((item) => item.title === "Prologue");
  const wind = book.sections.find((item) => item.title === "Wind Shrine");
  assert.ok(prologue !== undefined && wind !== undefined);
  const mapsOf = (sectionTitle: "Prologue" | "Wind Shrine", place: string): readonly number[] => {
    const found = book.sections
      .find((item) => item.title === sectionTitle)
      ?.places.find((item) => item.title === place);
    assert.ok(found !== undefined, `${sectionTitle} 缺少 ${place}`);
    return found.mapIds;
  };
  assert.deepEqual(mapsOf("Prologue", "Cave - Entrance"), [191]);
  assert.deepEqual(mapsOf("Prologue", "Pirate's Hideout"), [195, 196, 197]);
  assert.deepEqual(mapsOf("Prologue", "Pirate Ship"), [198, 199, 200, 201]);
  assert.deepEqual(mapsOf("Wind Shrine", "Crystal Room"), [209]);
  const vampire = prologue.blueMagic.find((spell) => /vampire/iu.test(spell.name));
  assert.ok(vampire !== undefined);
  assert.equal(vampire.timing, "missed");
  assert.match(vampire.when, /青魔导士来之前就过去了/u);
  assert.match(vampire.when, /拿到职业后回洞窟刷/u);
  assert.match(vampire.window, /Prologue/u);
  assert.ok(wind.revisit !== null);
  assert.match(wind.revisit.title, /回头学青魔法/u);
  assert.equal(
    wind.revisit.grind.find((grind) => /vampire/iu.test(grind.what))?.until.blueMagic,
    "Vampire",
  );
  assert.match(renderRouteBook(book), /钢蝠/u);
});

void test("real FF5 data: a Prologue plan for cave 194 starts at the cave, not 189/453/454", async (t) => {
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
  const atlas = await Atlas.load(REAL_ATLAS);
  const raw: unknown = JSON.parse(await readFile(join(REAL_HOME, "guide.json"), "utf8"));
  if (!isRecord(raw)) assert.fail("真实 guide.json 不是对象");
  const runtime = await loadRouteBook({
    game: "ff5",
    sections: parseWalkthrough(raw.walkthrough),
    knowledge,
    atlas,
    visitOrder: await readVisitOrder("ff5"),
    save: {
      bestiary: new Set(knowledge.progress.bestiary),
      blueMagic: null,
      jobs: null,
      openedChests: new Set<string>(),
    },
    fromSection: "Prologue",
    preferredSection: "Prologue",
    preferredMapId: 194,
    mapId: 1,
    aheadSections: 1,
    timeBudgetMs: 120_000,
  });
  assert.ok(runtime !== null);
  const route = routeFromBookSection(runtime.section, { grindMinutes: 8 });
  assert.ok(route.length > 0);
  assert.match(route[0]?.to ?? "", /^19[1-4](?::|$)/u);
  assert.equal(
    route.some((stop) => /^(189|453|454)(?::|$)/u.test(stop.to)),
    false,
  );
  const bestiary = route.flatMap((stop) => stop.until?.bestiary ?? []);
  assert.equal(new Set(bestiary.map(String)).size, bestiary.length);
});

void test("real FF5 data: the Tule plan puts the piano on 33 and hands story back", async (t) => {
  if (!(await hasRealData())) {
    t.skip("没有本机 .deps 的 FF5 地图记录或知识导出");
    return;
  }
  const map33 = JSON.parse(
    await readFile(join(REAL_HOME, "files", "maps", "33.json"), "utf8"),
  ) as unknown;
  if (!isRecord(map33) || !isRecord(map33.title) || typeof map33.title.en !== "string") {
    t.skip("地图标题还没导出（任务 133 的 game-files 脚本要在外面重跑）");
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
  const atlas = await Atlas.load(REAL_ATLAS);
  const files = await readRouteBookFiles("ff5", join(REAL_HOME, "files"));
  assert.ok(files);
  const raw: unknown = JSON.parse(await readFile(join(REAL_HOME, "guide.json"), "utf8"));
  if (!isRecord(raw)) assert.fail("真实 guide.json 不是对象");
  const book = buildRouteBook(
    input(parseWalkthrough(raw.walkthrough), knowledge, atlas, {
      from: "Tule",
      to: "Tule",
      files,
    }),
  );
  const tule = book.sections.find((item) => item.title === "Tule");
  assert.ok(tule);
  const piano = tule.stations.find((station) => station.kind === "piano");
  assert.ok(piano, "Tule 应该有钢琴站");
  assert.equal(piano.mapId, 33);
  assert.equal(
    tule.stations.some(
      (station) =>
        station.mapId === 32 &&
        station.cell !== null &&
        ((station.cell[0] === 32 && station.cell[1] === 49) ||
          (station.cell[0] === 49 && station.cell[1] === 32)),
    ),
    false,
  );
  const route = routeFromBookSection(tule, { grindMinutes: 8 });
  assert.ok(route.filter((stop) => stop.do === "handoff").length <= 3);
});

void test("the async build yields between sections and keeps the part built before the budget", async () => {
  const maps = Array.from({ length: 12 }, (_, index) =>
    mapRow(500 + index, `测试 ${index}`, `测试 ${index}`),
  );
  const sections = maps.map((map) =>
    section(String(map.name), [], [step(0, "move", null, `Walk around ${map.name}.`)]),
  );
  const knowledge = makeKnowledge({ maps });
  const atlas = makeAtlas({});
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 0);
  try {
    const outcome = await buildRouteBookAsync(input(sections, knowledge, atlas), 5_000);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.book.sections.length, sections.length);
    assert.ok(ticks > 0, "构建期间事件循环没有让出");
  } finally {
    clearInterval(timer);
  }
  const stopped = await buildRouteBookAsync(input(sections, knowledge, atlas), 0);
  assert.equal(stopped.timedOut, true);
  assert.equal(stopped.book.sections.length, 0);
});

void test("synthetic 80 sections × 30 steps × 20 monsters build in under a second", () => {
  const maps = [];
  const monsters = [];
  const encounters = [];
  const sections: GuideSection[] = [];
  const atlas = new Atlas();
  for (let s = 0; s < 80; s += 1) {
    const mapId = 1000 + s;
    const area = `合成区域 ${s}`;
    maps.push(mapRow(mapId, `${area} １层`, area, mapId));
    atlas.maps.set(String(mapId), {
      name: `${area} １层`,
      exits: s + 1 < 80 ? [{ cell: [1, 1], to: 1001 + s, name: "GotoMap" }] : [],
      chests: [],
    });
    for (let m = 0; m < 20; m += 1) {
      const id = 10_000 + s * 20 + m;
      monsters.push(
        monsterRow(id, 1 + s * 20 + m, `合成怪物 ${1 + s * 20 + m}`, {
          blue: m === 0 ? "合成青魔法" : null,
        }),
      );
      encounters.push(encounter(mapId, id));
    }
    const places = [`${area} - 1F`, `${area} - 2F`, `${area} - 3F`];
    const steps = Array.from({ length: 30 }, (_, index) =>
      step(
        index,
        index % 6 === 0 ? "chest" : "move",
        places[index % 3] ?? null,
        `走 ${index} 步。`,
      ),
    );
    sections.push({
      title: area,
      order: s,
      places,
      steps,
      monsters: Array.from({ length: 20 }, (_, m) => ({
        id: 1 + s * 20 + m,
        name: `合成怪物 ${1 + s * 20 + m}`,
        blueMagic: m === 0 ? "合成青魔法" : null,
        where: places[m % 3] ?? null,
      })),
    });
  }
  const knowledge = makeKnowledge({ maps, monsters, encounters }, new Guide([], new Map()));
  const started = performance.now();
  const book = buildRouteBook(input(sections, knowledge, atlas));
  const elapsed = performance.now() - started;
  assert.equal(book.sections.length, 80);
  assert.ok(elapsed < 1_000, `80 节用了 ${elapsed.toFixed(0)}ms`);
});

void test("real FF5 data: building all 77 sections stays under three seconds", async (t) => {
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
  const atlas = await Atlas.load(REAL_ATLAS);
  const raw: unknown = JSON.parse(await readFile(join(REAL_HOME, "guide.json"), "utf8"));
  if (!isRecord(raw)) assert.fail("真实 guide.json 不是对象");
  const sections = parseWalkthrough(raw.walkthrough);
  const first = sections[0]?.title;
  const last = sections.at(-1)?.title;
  assert.ok(first !== undefined && last !== undefined);
  const started = performance.now();
  const book = buildRouteBook(input(sections, knowledge, atlas, { from: first, to: last }));
  const elapsed = performance.now() - started;
  t.diagnostic(`真实攻略 ${book.sections.length} 节构建用了 ${elapsed.toFixed(0)}ms`);
  assert.equal(book.sections.length, sections.length);
  assert.ok(elapsed < 3_000, `整本 ${sections.length} 节用了 ${elapsed.toFixed(0)}ms`);
});

void test("real FF5 data: a three-section book matches the baseline under .deps/tests", async (t) => {
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
  const atlas = await Atlas.load(REAL_ATLAS);
  const raw: unknown = JSON.parse(await readFile(join(REAL_HOME, "guide.json"), "utf8"));
  if (!isRecord(raw)) assert.fail("真实 guide.json 不是对象");
  const sections = parseWalkthrough(raw.walkthrough);
  const from = sections[0]?.title;
  const to = sections[2]?.title;
  if (from === undefined || to === undefined) {
    t.skip("真实攻略不足 3 节");
    return;
  }
  const book = buildRouteBook(input(sections, knowledge, atlas, { from, to }));
  assert.equal(book.sections.length, 3);
  const baselineDir = join(REAL_DEPS, "tests");
  const baseline = join(baselineDir, "route-book-3-sections.json");
  try {
    await access(baseline);
  } catch {
    await mkdir(baselineDir, { recursive: true });
    await writeFile(baseline, `${JSON.stringify(book, null, 2)}\n`, "utf8");
    t.diagnostic(`第一次运行，已把 3 节路线书写进 ${baseline}`);
    return;
  }
  const expected: unknown = JSON.parse(await readFile(baseline, "utf8"));
  assert.deepEqual(book, expected);
});

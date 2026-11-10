import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
import { parseWalkthrough } from "../src/engine/stage/guide-steps.ts";
import type { GuideSection, GuideStep, GuideStepKind } from "../src/engine/stage/guide-types.ts";
import {
  buildRouteBook,
  type RouteBook,
  type RouteBookInput,
} from "../src/engine/stage/route-book.ts";
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
        : [{ abilityId: null, name: blue, blueMagic: true, conditions: [], rate: null }],
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

function makeKnowledge(spec: KnowledgeSpec): Knowledge {
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
}

interface AtlasEntrySpec {
  readonly name: string;
  readonly exits?: readonly { cell: [number, number]; to: number; name: string }[];
  readonly chests?: readonly { cell: [number, number]; name: string }[];
  readonly savePoints?: readonly (readonly [number, number])[];
  readonly recoveryPoints?: readonly { cell: [number, number]; label: string }[];
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
  return { index, where, kind, text, ref: null, item: null, boss: null, ...extra };
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
    },
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
    20: { name: "试验迷宫 ４层", exits: [{ cell: [2, 2], to: 10, name: "２层" }] },
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
  const knowledge = makeKnowledge({ maps: [mapRow(10, "试验迷宫 １层", "试验迷宫")] });
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
          [{ id: 8, name: "Black Goblin", blueMagic: "Goblin Punch", where: null }],
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
        section("风之神殿", ["Crystal Room"], [
          step(0, "note", "Crystal Room", "Jobs unlocked:"),
          step(1, "note", "Crystal Room", "Knight"),
          step(2, "note", "Crystal Room", "Blue Mage"),
        ]),
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
        section("风之神殿", ["Crystal Room"], [
          step(0, "note", "Crystal Room", "Jobs unlocked:"),
          step(1, "note", "Crystal Room", "Knight"),
          step(2, "note", "Crystal Room", "Blue Mage"),
        ]),
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
        section("风之神殿", ["Crystal Room"], [
          step(0, "note", "Crystal Room", "Jobs unlocked:"),
          step(1, "note", "Crystal Room", "Knight"),
          step(2, "note", "Crystal Room", "Blue Mage"),
        ]),
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
        boss: { name: "Wing Raptor", hp: 250, weak: [], resist: [], absorb: [] },
      }),
      step(7, "chest", "Wind Shrine - 4F", "Open the chest at the end for a Staff.", {
        ref: { kind: "chest", n: 9 },
        item: "Staff",
      }),
    ],
    [
      { id: 8, name: "Black Goblin", blueMagic: "Goblin Punch", where: "Wind Shrine - 2F" },
      { id: 9, name: "White Serpent", blueMagic: null, where: "Wind Shrine - 2F" },
      { id: 10, name: "Moldwynd", blueMagic: "Aero", where: "Wind Shrine - 2F" },
      { id: 11, name: "Mani Wizard", blueMagic: null, where: "Wind Shrine - 2F" },
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

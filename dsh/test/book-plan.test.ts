/**
 * Task 117: route book → stage plan conversion. A hand-written book keeps the test independent
 * of the guide parser and the bridge; the executor test covers the live run.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newBookProgress, routeFromBookSection } from "../src/engine/stage/book-plan.ts";
import type {
  RouteBlueMagic,
  RouteBook,
  RouteChest,
  RouteMonster,
  RouteSection,
  RouteStation,
} from "../src/engine/stage/route-book.ts";

function chest(
  stepIndex: number,
  cell: [number, number] | null,
  opened: boolean,
  candidates: { mapId: number; cell: [number, number]; opened: boolean }[] = [],
): RouteChest {
  return {
    stepIndex,
    where: null,
    kind: "chest",
    n: stepIndex + 1,
    item: "帐篷",
    text: "Open the chest",
    mapId: cell === null ? null : 71,
    mapName: cell === null ? null : "测试洞窟",
    cell,
    opened,
    match: cell === null && candidates.length > 0 ? "none" : "name",
    note: "",
    candidates: candidates.map((candidate) => ({
      mapId: candidate.mapId,
      mapName: "测试洞窟",
      cell: candidate.cell,
      name: "帐篷",
      opened: candidate.opened,
    })),
  };
}

function station(
  index: number,
  kind: RouteStation["kind"],
  cell: [number, number] | null,
  chestValue: RouteChest | null = null,
): RouteStation {
  return {
    index,
    where: null,
    kind,
    mapId: 71,
    cell,
    action: kind,
    text: `guide ${kind}`,
    basis: "test",
    chest: chestValue,
    pointCandidate: null,
  };
}

function monster(
  name: string,
  bookId: number,
  missable: boolean,
  registered: boolean,
): RouteMonster {
  return {
    bookId,
    name,
    guideName: null,
    boss: false,
    registered,
    missable,
    missableUntil: null,
    maps: [71],
    note: "",
  };
}

function spell(name: string, learned: boolean, hasBlueMage: boolean): RouteBlueMagic {
  return {
    name,
    teachers: [{ monster: "青魔导士", bookId: 10, maps: [71], allMaps: [71] }],
    learned,
    hasBlueMage,
    maps: [71],
    otherPlaces: [],
    note: "",
    timing: hasBlueMage ? "now" : "unknown",
    when: hasBlueMage ? "现在能学" : "未知",
    window: "测试洞窟",
  };
}

function section(overrides: Partial<RouteSection> = {}): RouteSection {
  return {
    title: "测试洞窟",
    order: 0,
    areaName: "测试洞窟",
    maps: [{ mapId: 71, name: "测试洞窟", areaName: "测试洞窟", reasons: ["test"] }],
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
    ...overrides,
  };
}

function book(sectionValue: RouteSection): RouteBook {
  return {
    fromSection: sectionValue.title,
    fromPlace: null,
    toSection: sectionValue.title,
    sections: [sectionValue],
    totals: {
      sections: 1,
      stations: sectionValue.stations.length,
      chestsMatched: sectionValue.chestsMatched,
      chestsTotal: sectionValue.chestsTotal,
      bestiaryMissing: sectionValue.bestiaryMissing,
      bestiaryUnknown: false,
      blueMagicMissing: sectionValue.blueMagicMissing,
      revisit: 0,
      mismatches: 0,
    },
  };
}

function revisit(stations: RouteStation[]): NonNullable<RouteSection["revisit"]> {
  return {
    title: "回头学青魔法",
    note: "拿到职业后回头补",
    maps: [{ mapId: 71, name: "测试洞窟", areaName: "测试洞窟", reasons: ["test"] }],
    stations,
    grind: [],
  };
}

function routeOf(sectionValue: RouteSection, grindMinutes = 8) {
  const built = book(sectionValue);
  const first = built.sections[0];
  assert.ok(first);
  return routeFromBookSection(first, { grindMinutes });
}

void test("chests with cells become guaranteed opens and opened chests are skipped", () => {
  const first = chest(0, [2, 5], false);
  const second = chest(1, [4, 5], true);
  const bookValue = section({
    stations: [station(0, "chest", [2, 5], first), station(1, "chest", [4, 5], second)],
    chests: [first, second],
    chestsTotal: 2,
  });
  const route = routeOf(bookValue);
  assert.deepEqual(
    route.map((stop) => [stop.to, stop.do, stop.optional]),
    [["71:2,5", "open", false]],
  );
});

void test("a multi-cell chest station opens every unopened candidate", () => {
  const multi = chest(0, null, false, [
    { mapId: 71, cell: [3, 5], opened: false },
    { mapId: 71, cell: [6, 5], opened: false },
    { mapId: 71, cell: [7, 5], opened: true },
  ]);
  const route = routeOf(
    section({
      stations: [station(0, "chest", null, multi)],
      chests: [multi],
      chestsTotal: 1,
    }),
  );
  assert.deepEqual(
    route.map((stop) => [stop.to, stop.do, stop.book?.part, stop.book?.parts]),
    [
      ["71:3,5", "open", 1, 2],
      ["71:6,5", "open", 2, 2],
    ],
  );
});

void test("a real save is a save, a boss is a boss, and a cell-less switch hands back", () => {
  const save = station(0, "save", [5, 5]);
  const boss = station(1, "boss", [8, 5]);
  const handoff = station(2, "switch", null);
  const route = routeOf(section({ stations: [save, boss, handoff] }));
  const first = route[0];
  const second = route[1];
  const third = route[2];
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.equal(first.do, "save");
  assert.equal(first.optional, false);
  assert.equal(second.do, "boss");
  assert.equal(third.do, "handoff");
  assert.equal(third.to, "71");
  assert.match(third.book?.text ?? "", /guide switch/);
});

void test("a missable unregistered monster becomes a grind stop with the Config minute cap", () => {
  const route = routeOf(
    section({
      monsters: [
        monster("水母", 21, true, false),
        monster("哥布林", 1, true, true),
        monster("石像", 30, false, false),
      ],
      grind: [
        {
          what: "图鉴",
          monster: "水母",
          mapId: 71,
          weight: 2,
          chance: 0.1,
          reason: "错过就没了",
          until: { blueMagic: null },
        },
        {
          what: "图鉴",
          monster: "哥布林",
          mapId: 71,
          weight: 2,
          chance: 0.1,
          reason: "错过就没了",
          until: { blueMagic: null },
        },
        {
          what: "图鉴",
          monster: "石像",
          mapId: 71,
          weight: 2,
          chance: 0.1,
          reason: "普通",
          until: { blueMagic: null },
        },
      ],
    }),
  );
  const grind = route.find((stop) => stop.do === "grind");
  assert.ok(grind);
  assert.ok(grind.until);
  assert.deepEqual(grind.until.bestiary, [21]);
  assert.equal(grind.until.minutes, 8);
  assert.equal(route.filter((stop) => stop.do === "grind").length, 1);
});

void test("a grind stop drops a monster from elsewhere and a map outside the section", () => {
  const row = {
    what: "图鉴",
    monster: "水母",
    mapId: 99,
    weight: 2,
    chance: 0.1,
    reason: "错过就没了",
    until: { blueMagic: null },
  } as const;
  const outsideMap = section({
    monsters: [monster("水母", 21, true, false)],
    grind: [row],
  });
  assert.equal(
    routeOf(outsideMap).some((stop) => stop.do === "grind"),
    false,
  );
  const wrongEncounterMap = section({
    monsters: [{ ...monster("水母", 21, true, false), maps: [99] }],
    grind: [{ ...row, mapId: 71 }],
  });
  assert.equal(
    routeOf(wrongEncounterMap).some((stop) => stop.do === "grind"),
    false,
  );
});

void test("duplicate bestiary numbers in one grind stop are removed", () => {
  const row = {
    what: "图鉴",
    monster: "水母",
    mapId: 71,
    weight: 2,
    chance: 0.1,
    reason: "错过就没了",
    until: { blueMagic: null },
  } as const;
  const route = routeOf(
    section({
      monsters: [monster("水母", 21, true, false)],
      grind: [row, row],
    }),
  );
  const grind = route.find((stop) => stop.do === "grind");
  assert.ok(grind?.until);
  assert.deepEqual(grind.until.bestiary, [21]);
});

void test("blue magic is ground only for a Blue Mage and only while unlearned", () => {
  const route = routeOf(
    section({
      blueMagic: [
        spell("白风", false, true),
        spell("魔法锤", true, true),
        spell("火焰放射", false, false),
      ],
    }),
    5,
  );
  const grind = route.find((stop) => stop.do === "grind");
  assert.ok(grind);
  assert.ok(grind.until);
  assert.deepEqual(grind.until.blueMagic, ["白风"]);
  assert.equal(grind.until.minutes, 5);
});

void test("a runnable 回头学 stop becomes a grind with the station's until and minute cap", () => {
  const spellStop: RouteStation = {
    ...station(-1, "note", null),
    action: "回头学 Vampire",
    text: "刷钢蝠直到学会 Vampire",
    grind: { blueMagic: "Vampire", bestiary: null, skipReason: null },
  };
  const bestiaryStop: RouteStation = {
    ...station(-2, "note", null),
    action: "回头补图鉴 恶魔蟹",
    grind: { blueMagic: null, bestiary: 9, skipReason: null },
  };
  const value = section({ revisit: revisit([spellStop, bestiaryStop]) });
  const route = routeOf(value, 5);
  assert.deepEqual(
    route.map((stop) => [stop.to, stop.do, stop.until]),
    [
      ["71", "grind", { blueMagic: ["Vampire"], minutes: 5 }],
      ["71", "grind", { bestiary: [9], minutes: 5 }],
    ],
  );
  const progress = newBookProgress("ff5", value, new Date("2026-11-11T00:00:00Z"), null);
  assert.deepEqual(
    progress.stations.map((item) => [item.index, item.status, item.note]),
    [
      [-1, "pending", ""],
      [-2, "pending", ""],
    ],
  );
});

void test("a 回头学 stop without a Blue Mage is skipped with its reason and never walked", () => {
  const stop: RouteStation = {
    ...station(-1, "note", null),
    action: "回头学 Vampire",
    grind: {
      blueMagic: "Vampire",
      bestiary: null,
      skipReason: "队里没有青魔导士",
    },
  };
  const value = section({ revisit: revisit([stop]) });
  assert.deepEqual(routeOf(value), []);
  const progress = newBookProgress("ff5", value, new Date("2026-11-11T00:00:00Z"), null);
  assert.deepEqual(
    progress.stations.map((item) => [item.index, item.status, item.note]),
    [[-1, "skipped", "队里没有青魔导士"]],
  );
});

void test("move and note stations do not become execution stops", () => {
  const route = routeOf(
    section({
      stations: [station(0, "move", null), station(1, "note", null), station(2, "cutscene", null)],
    }),
  );
  assert.equal(route.length, 1);
  const first = route[0];
  assert.ok(first);
  assert.equal(first.do, "handoff");
  assert.equal(first.book?.kind, "cutscene");
});

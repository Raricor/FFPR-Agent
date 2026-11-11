/**
 * Task 117: learned coordinates and section selection. The full guide build is task 115's test;
 * here the book is hand-written so the loader's fill-in and selection rules stay visible.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { buildKnowledge, type MapsRow, type StaticData } from "../src/engine/knowledge/index.ts";
import {
  applyLearnedPoints,
  loadRouteBook,
  readLearnedPoints,
  readRouteBookFiles,
  sectionFinished,
  selectSectionIndex,
  trimSectionStart,
  writeLearnedPoint,
} from "../src/engine/stage/route-book-load.ts";
import type { GuideSection } from "../src/engine/stage/guide-types.ts";
import type { RouteBook, RouteSection, RouteStation } from "../src/engine/stage/route-book.ts";

function station(index: number, mapId: number | null, cell: [number, number] | null): RouteStation {
  return {
    index,
    where: null,
    kind: "switch",
    mapId,
    cell,
    action: "机关",
    text: "pull the lever",
    basis: "guide",
    chest: null,
    pointCandidate: null,
  };
}

function section(
  title: string,
  order: number,
  mapId: number,
  stations: RouteStation[],
): RouteSection {
  return {
    title,
    order,
    areaName: title,
    maps: [{ mapId, name: title, areaName: title, reasons: [] }],
    places: [],
    stations,
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

function chestStation(
  index: number,
  mapId: number,
  cell: [number, number],
  opened: boolean | null,
  flag: string | null = null,
): RouteStation {
  return {
    ...station(index, mapId, cell),
    kind: "chest",
    action: "开宝箱",
    chest: {
      stepIndex: index,
      where: null,
      kind: "chest",
      n: index + 1,
      item: "药",
      text: "Open the chest",
      mapId,
      mapName: "",
      cell,
      opened,
      flag,
      match: "name",
      note: "",
      candidates: [],
    },
  };
}

function book(sections: RouteSection[]): RouteBook {
  return {
    fromSection: sections[0]?.title ?? "",
    fromPlace: null,
    toSection: sections.at(-1)?.title ?? "",
    sections,
    totals: {
      sections: sections.length,
      stations: sections.reduce((sum, item) => sum + item.stations.length, 0),
      chestsMatched: 0,
      chestsTotal: 0,
      bestiaryMissing: 0,
      bestiaryUnknown: false,
      blueMagicMissing: 0,
      revisit: 0,
      mismatches: 0,
    },
  };
}

void test("a plan for the cave starts at the cave, not at the earlier meteorite", () => {
  const base = section("Prologue", 0, 10, []);
  const value: RouteSection = {
    ...base,
    maps: [
      { mapId: 10, name: "泰空陨石地", areaName: "泰空陨石地", reasons: [] },
      { mapId: 11, name: "洞窟 1F", areaName: "洞窟", reasons: [] },
    ],
    stations: [station(0, 10, [1, 1]), station(1, 10, [2, 2]), station(2, 11, [3, 3])],
  };
  const trimmed = trimSectionStart(value, { currentMapId: null, targetMapId: 11 });
  assert.deepEqual(
    trimmed.stations.map((item) => item.index),
    [2],
  );
});

void test("an unopened chest on a map the plan still visits is kept; an opened one is dropped", () => {
  const base = section("洞窟", 0, 11, []);
  const value: RouteSection = {
    ...base,
    maps: [
      { mapId: 11, name: "洞窟 1F", areaName: "洞窟", reasons: [] },
      { mapId: 12, name: "洞窟 2F", areaName: "洞窟", reasons: [] },
    ],
    stations: [
      chestStation(0, 11, [1, 1], false),
      chestStation(1, 11, [2, 2], true),
      station(2, 12, [3, 3]),
      station(3, 11, [4, 4]),
    ],
  };
  const trimmed = trimSectionStart(value, { currentMapId: 12, targetMapId: 12 });
  assert.deepEqual(
    trimmed.stations.map((item) => item.index),
    [0, 2, 3],
  );
  assert.match(trimmed.stations[0]?.basis ?? "", /本档没开,保留/u);
});

void test("the current map is the start even when the plan's target is later", () => {
  const base = section("洞窟", 0, 10, []);
  const value: RouteSection = {
    ...base,
    maps: [
      { mapId: 10, name: "洞窟 1F", areaName: "洞窟", reasons: [] },
      { mapId: 11, name: "洞窟 2F", areaName: "洞窟", reasons: [] },
      { mapId: 12, name: "洞窟 3F", areaName: "洞窟", reasons: [] },
    ],
    stations: [station(0, 10, [1, 1]), station(1, 11, [2, 2]), station(2, 12, [3, 3])],
  };
  const trimmed = trimSectionStart(value, { currentMapId: 11, targetMapId: 12 });
  assert.deepEqual(
    trimmed.stations.map((item) => item.index),
    [1, 2],
  );
});

void test("a learned cell fills the matching station only", () => {
  const value = book([
    section("洞窟", 0, 71, [station(0, 71, null), station(1, 71, [2, 2]), station(2, 72, null)]),
    section("另一段", 1, 72, [station(0, 72, null)]),
  ]);
  const filled = applyLearnedPoints(value, [
    { section: "洞窟", station: 0, mapId: 71, cell: [9, 8], at: "2026-11-11T00:00:00.000Z" },
    { section: "另一段", station: 0, mapId: 72, cell: [4, 4], at: "2026-11-11T00:00:00.000Z" },
  ]);
  const firstSection = filled.sections[0];
  const secondSection = filled.sections[1];
  assert.ok(firstSection);
  assert.ok(secondSection);
  assert.deepEqual(firstSection.stations[0]?.cell, [9, 8]);
  const second = firstSection.stations[1];
  assert.ok(second);
  assert.equal(second.cell?.[0], 2);
  assert.equal(firstSection.stations[2]?.cell, null);
  const revisit = secondSection.stations[0];
  assert.ok(revisit);
  assert.deepEqual(revisit.cell, [4, 4]);
  assert.match(revisit.basis, /学会坐标/);
});

void test("section selection follows the map, the running plan, and the next section", () => {
  const value = book([section("第一段", 0, 71, []), section("第二段", 1, 72, [])]);
  assert.equal(selectSectionIndex(value, 72), 1);
  assert.equal(selectSectionIndex(value, 71, { preferredSection: "第二段" }), 1);
  assert.equal(
    selectSectionIndex(value, 1, {
      previous: { title: "第一段", finished: false },
    }),
    0,
  );
  assert.equal(
    selectSectionIndex(value, 1, {
      previous: { title: "第一段", finished: true },
    }),
    1,
  );
  assert.equal(
    selectSectionIndex(value, 71, {
      previous: { title: "第一段", finished: true },
    }),
    1,
  );
  assert.equal(selectSectionIndex(value, 999), 0);
});

void test("learned points are written and read back with their key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-book-learned-"));
  const file = join(directory, "learned.json");
  try {
    await writeLearnedPoint(
      "ff5",
      { section: "洞窟", station: 2, mapId: 71, cell: [3, 4], at: "2026-11-11T00:00:00.000Z" },
      file,
    );
    await writeLearnedPoint(
      "ff5",
      { section: "洞窟", station: 2, mapId: 71, cell: [5, 6], at: "2026-11-11T01:00:00.000Z" },
      file,
    );
    const points = await readLearnedPoints("ff5", file);
    assert.equal(points.length, 1);
    assert.deepEqual(points[0]?.cell, [5, 6]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("game-file events and NPCs are read with their map id and cell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-book-files-"));
  try {
    const maps = join(directory, "files", "maps");
    await mkdir(maps, { recursive: true });
    await writeFile(
      join(maps, "10.json"),
      JSON.stringify({
        id: 10,
        title: { ja: "酒場", en: "Pub", zhc: "酒馆" },
        events: [
          {
            file: "ev_e_0021.json",
            name: "sc_e_0021:测试之家前",
            cell: [5, 5],
            rect: { x1: 5, y1: 5, x2: 7, y2: 5 },
            scriptId: 21,
          },
        ],
        npcs: [{ name: "受付", cell: [7, 8] }],
      }),
      "utf8",
    );
    const files = await readRouteBookFiles("ff5", join(directory, "files"));
    assert.ok(files);
    const event = files.events[0];
    const npc = files.npcs[0];
    assert.ok(event !== undefined && npc !== undefined);
    assert.equal(event.mapId, 10);
    assert.equal(event.name, "sc_e_0021:测试之家前");
    assert.deepEqual(event.rect, { x1: 5, y1: 5, x2: 7, y2: 5 });
    assert.deepEqual(npc.cell, [7, 8]);
    assert.deepEqual(files.titles?.get(10), { ja: "酒場", en: "Pub", zhc: "酒馆" });
    assert.equal(await readRouteBookFiles("ff5", join(directory, "missing")), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function syntheticSections(count: number): {
  readonly sections: GuideSection[];
  readonly knowledge: ReturnType<typeof buildKnowledge>;
  readonly atlas: Atlas;
} {
  const maps: MapsRow[] = [];
  const sections: GuideSection[] = [];
  const atlas = new Atlas();
  for (let index = 0; index < count; index += 1) {
    const mapId = 700 + index;
    const title = `合成区域 ${index}`;
    maps.push({ id: mapId, name: `${title} １层`, areaId: mapId, areaName: title, areaType: "1" });
    atlas.maps.set(String(mapId), {
      name: `${title} １层`,
      exits: index + 1 < count ? [{ cell: [1, 1], to: 701 + index, name: "GotoMap" }] : [],
      chests: [],
    });
    sections.push({
      title,
      order: index,
      places: [],
      steps: [
        {
          index: 0,
          where: null,
          kind: "move",
          text: `在${title}走一圈。`,
          ref: null,
          item: null,
          boss: null,
        },
      ],
      monsters: [],
    });
  }
  const data: StaticData = {
    game: "ff5",
    build: null,
    bridge: null,
    dir: "test",
    tables: ["maps"],
    maps,
    monsters: [],
    encounters: [],
    treasures: [],
    shops: [],
    items: [],
    magic: [],
    sources: [],
  };
  const knowledge = buildKnowledge({
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
  return { sections, knowledge, atlas };
}

void test("the runtime book builds the current section and the next N sections only", async () => {
  const { sections, knowledge, atlas } = syntheticSections(10);
  const runtime = await loadRouteBook({
    game: "ff5",
    sections,
    knowledge,
    atlas,
    visitOrder: [],
    save: { bestiary: null, blueMagic: null, jobs: null, openedChests: null },
    mapId: 705,
    aheadSections: 2,
    filesDir: null,
  });
  assert.ok(runtime !== null);
  assert.deepEqual(
    runtime.book.sections.map((item) => item.title),
    ["合成区域 5", "合成区域 6"],
  );
  assert.equal(runtime.section.title, "合成区域 5");
  assert.equal(runtime.sectionIndex, 0);
});

void test("a zero budget stops the build and warns; the plan falls back to no book", async () => {
  const { sections, knowledge, atlas } = syntheticSections(10);
  const warnings: string[] = [];
  const runtime = await loadRouteBook({
    game: "ff5",
    sections,
    knowledge,
    atlas,
    visitOrder: [],
    save: { bestiary: null, blueMagic: null, jobs: null, openedChests: null },
    mapId: 700,
    aheadSections: 10,
    timeBudgetMs: 0,
    onWarning: (message) => warnings.push(message),
    filesDir: null,
  });
  assert.equal(runtime, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /路线书构建超过 0ms/u);
  assert.match(warnings[0] ?? "", /已经建好的 0 节/u);
});

void test("sectionFinished and section selection read the game-file treasure flag", () => {
  const chestStationValue = chestStation(0, 10, [1, 2], false, "77");
  const done: RouteSection = {
    ...section("图尔村", 0, 10, [chestStationValue]),
    chests: chestStationValue.chest === null ? [] : [chestStationValue.chest],
    bosses: [
      {
        bookId: 3,
        name: "首领",
        guideName: null,
        boss: true,
        registered: true,
        missable: false,
        missableUntil: null,
        maps: [10],
        note: "",
      },
    ],
  };
  const save = { bestiary: null, blueMagic: null, jobs: null, openedChests: null };
  assert.equal(sectionFinished(done, { ...save, treasureFlags: new Map([[77, true]]) }), true);
  assert.equal(sectionFinished(done, { ...save, treasureFlags: new Map([[77, false]]) }), false);
  assert.equal(sectionFinished(done, { ...save, treasureFlags: new Map([[77, null]]) }), false);
  // The old fallback still works when the bridge has no flag table.
  assert.equal(sectionFinished(done, { ...save, openedChests: new Set(["10:1,2"]) }), true);
  assert.equal(
    selectSectionIndex(book([done]), 10, {
      finished: (item) => sectionFinished(item, { ...save, treasureFlags: new Map([[77, true]]) }),
    }),
    null,
  );
});

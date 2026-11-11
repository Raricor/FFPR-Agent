/**
 * Task 157: the chapter route view. A synthetic chapter walks through a hidden passage and
 * then over one map exit; the tests check the station order, item names, pair estimates, the
 * per-map BFS polylines and the Chinese reason for an unreachable leg.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { ChapterFiles } from "../src/plugin/chapter-panel.ts";
import { CollisionStore } from "../src/engine/regions.ts";
import type { ChapterPlan } from "../src/engine/plan/chapter-types.ts";
import { ChapterPlanStore } from "../src/engine/plan/chapter-store.ts";
import {
  clearChapterRouteCache,
  readChapterRoute,
  readChapterRouteMap,
  type ChapterRouteOptions,
  type RouteKnowledge,
} from "../src/plugin/route-view.ts";

const ROWS = ["00100", "00100", "00100", "00100", "00100"];

function station(to: string, do_: "open" | "boss" | "move" | "story" = "move") {
  return { to, do: do_, why: `去 ${to}` };
}

function plan(): ChapterPlan {
  return {
    version: 1,
    chapter: 1,
    goal: "走完测试章",
    segments: [
      {
        version: 1,
        section: "第一迷宫",
        goal: "开出第一迷宫",
        prep: { jobs: [], equip: "keep", buy: [], rows: [] },
        stations: [station("203:3,2", "open"), station("203:4,2", "boss")],
        battle: [],
        bosses: [],
        turnBack: [],
      },
      {
        version: 1,
        section: "第二迷宫",
        goal: "走完第二迷宫",
        prep: { jobs: [], equip: "keep", buy: [], rows: [] },
        stations: [station("205:2,2", "open"), station("205:4,2", "move")],
        battle: [],
        bosses: [],
        turnBack: [],
      },
    ],
    growth: [],
    fallback: {
      retries: 1,
      bossLost: { levels: 1, where: null, tries: 1 },
      skipOptional: true,
      healBelowPct: 30,
    },
  };
}

function progress(): Record<string, unknown> {
  return {
    game: "ff5",
    chapter: 1,
    goal: "走完测试章",
    revision: 1,
    startedAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:10:00.000Z",
    finishedAt: null,
    status: "running",
    segment: 1,
    segments: [
      {
        section: "第一迷宫",
        stations: [
          { index: 0, status: "done", note: "开了恢复药" },
          { index: 1, status: "done", note: "打倒了首领" },
        ],
      },
      {
        section: "第二迷宫",
        stations: [
          { index: 0, status: "current", note: "正在找隐藏道具" },
          { index: 1, status: "pending", note: "" },
        ],
      },
    ],
    fallbacks: [],
    previousException: null,
  };
}

async function temporary(): Promise<{
  readonly dir: string;
  readonly files: ChapterFiles;
  readonly atlas: Atlas;
  readonly collisions: CollisionStore;
  readonly knowledge: RouteKnowledge;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-chapter-route-"));
  const files: ChapterFiles = {
    plan: join(dir, "chapter-plan-ff5.json"),
    progress: join(dir, "chapter-progress-ff5.json"),
    report: join(dir, "chapter-report-ff5.json"),
    atlas: join(dir, "atlas-ff5.json"),
    guide: join(dir, "guide.json"),
  };
  const planValue = plan();
  const store = await ChapterPlanStore.load("ff5", files.plan);
  await store.save(planValue);
  await writeFile(files.progress, `${JSON.stringify(progress(), null, 2)}\n`, "utf8");
  const mapsDir = join(dir, "maps");
  await mkdir(mapsDir, { recursive: true });
  await writeFile(
    join(mapsDir, "203.json"),
    JSON.stringify({
      id: 203,
      collision: [{ name: "GroundCollision", rows: ROWS }],
      hiddenPassages: [{ name: "GroundHiddenPassage", cells: [[2, 2, 1]] }],
    }),
    "utf8",
  );
  await writeFile(
    join(mapsDir, "205.json"),
    JSON.stringify({
      id: 205,
      collision: [{ name: "GroundCollision", rows: ["00000", "00000", "00000", "00000", "00000"] }],
    }),
    "utf8",
  );
  const atlas = new Atlas();
  atlas.maps.set("203", {
    name: "测试洞窟",
    exits: [{ cell: [4, 2], to: 205, name: "东门", land: [1, 1] }],
  });
  atlas.maps.set("205", { name: "洞窟深处", exits: [] });
  const collisions = await CollisionStore.load(undefined, undefined, mapsDir);
  const knowledge: RouteKnowledge = {
    chests: [
      {
        mapId: 203,
        cell: [3, 2],
        hidden: false,
        contentId: 4,
        contentName: "恢复药",
        contentNames: { ja: null, en: "Potion", zhc: "恢复药" },
        opened: true,
      },
      {
        mapId: 205,
        cell: [2, 2],
        hidden: true,
        contentId: 5,
        contentName: "隐形草",
        contentNames: null,
        opened: false,
      },
    ],
    maps: [
      { id: 203, name: "测试洞窟" },
      { id: 205, name: "洞窟深处" },
    ],
  };
  return { dir, files, atlas, collisions, knowledge };
}

function options(
  temp: Awaited<ReturnType<typeof temporary>>,
  overrides: Partial<ChapterRouteOptions> = {},
): ChapterRouteOptions {
  return {
    atlas: temp.atlas,
    collisions: temp.collisions,
    knowledge: temp.knowledge,
    start: { map: 203, cell: [1, 2] },
    ...overrides,
  };
}

void test("stations are numbered in order, chest items and states are carried, and legs use pair estimates", async () => {
  clearChapterRouteCache();
  const temp = await temporary();
  try {
    const view = await readChapterRoute(temp.files, "ff5", options(temp));
    assert.equal(view.chapter, 1);
    assert.match(view.startText, /测试洞窟/u);
    assert.equal(view.segments.length, 2);
    const first = view.segments[0];
    const second = view.segments[1];
    assert.ok(first);
    assert.ok(second);
    assert.deepEqual(
      first.stations.map((row) => [row.number, row.label, row.statusText, row.itemName]),
      [
        [1, "①", "做完", "恢复药"],
        [2, "②", "做完", null],
      ],
    );
    assert.deepEqual(
      second.stations.map((row) => [row.number, row.label, row.statusText, row.itemName]),
      [
        [3, "③", "正在做", "隐形草"],
        [4, "④", "待做", null],
      ],
    );
    assert.equal(second.stations[0]?.kind, "hidden");
    assert.match(first.chestsText, /计划 1、已开 1、跳过 0/u);
    assert.equal(first.legs.length, 2);
    const firstLeg = first.legs[0];
    assert.ok(firstLeg);
    assert.equal(firstLeg.ok, true);
    assert.equal(firstLeg.cells, 2);
    assert.match(firstLeg.text, /起点→①：测试洞窟，0 跳，2 格/u);
    const secondLeg = first.legs[1];
    assert.ok(secondLeg);
    assert.match(secondLeg.text, /①→②：测试洞窟，0 跳，1 格/u);
    const cross = second.legs[0];
    assert.ok(cross);
    assert.equal(cross.ok, true);
    assert.equal(cross.hops, 1);
    assert.equal(cross.cells, 2);
    assert.deepEqual(cross.mapIds, [203, 205]);
    assert.match(cross.text, /测试洞窟 → 洞窟深处/u);
    assert.match(first.distanceText, /总路程/u);
  } finally {
    await rm(temp.dir, { recursive: true, force: true });
  }
});

void test("an unreachable leg says why and its segment is marked", async () => {
  const temp = await temporary();
  try {
    const base = plan();
    const withBad: ChapterPlan = {
      ...base,
      segments: base.segments.map((segment, index) =>
        index === 1
          ? { ...segment, stations: [...segment.stations, station("999:1,1", "move")] }
          : segment,
      ),
    };
    const store = await ChapterPlanStore.load("ff5", temp.files.plan);
    await store.save(withBad);
    const view = await readChapterRoute(temp.files, "ff5", options(temp));
    const leg = view.segments[1]?.legs.at(-1);
    assert.ok(leg);
    assert.equal(leg.ok, false);
    assert.match(leg.reason ?? "", /地图记录里没有地图 999/u);
    assert.match(leg.text, /走不到/u);
    assert.match(view.segments[1]?.distanceText ?? "", /走不到 1 段/u);
  } finally {
    await rm(temp.dir, { recursive: true, force: true });
  }
});

void test("the map view draws the hidden passage, the party, stations and only this map's leg slices", async () => {
  const temp = await temporary();
  try {
    const view = await readChapterRouteMap(temp.files, "ff5", 203, options(temp));
    assert.equal(view.mapId, 203);
    assert.equal(view.width, 5);
    assert.equal(view.height, 5);
    assert.equal(view.rows[2], "..+..");
    assert.equal(view.party?.cellText, "(1,2)");
    assert.deepEqual(
      view.stations.map((row) => [row.label, row.cellText, row.kind, row.statusText]),
      [
        ["①", "(3,2)", "chest", "做完"],
        ["②", "(4,2)", "boss", "做完"],
      ],
    );
    const hidden = view.paths.find((path) => path.legNumber === 1);
    assert.ok(hidden);
    assert.deepEqual(hidden.points, [
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    const cross = view.paths.find((path) => path.legNumber === 3);
    assert.ok(cross);
    assert.match(cross.exitText, /地图 205/u);
    assert.deepEqual(cross.points, [[4, 2]]);
    assert.ok(view.exits.some((exit) => exit.to === 205 && exit.cellText === "(4,2)"));

    const other = await readChapterRouteMap(temp.files, "ff5", 205, options(temp));
    assert.equal(other.mapId, 205);
    const entered = other.paths.find((path) => path.legNumber === 3);
    assert.ok(entered);
    assert.match(entered.entryText, /从地图 203 的 \(4,2\) 进来，落在 \(1,1\)/u);
    assert.deepEqual(entered.points, [
      [1, 1],
      [2, 1],
      [2, 2],
    ]);
    assert.equal(other.party, null);
  } finally {
    await rm(temp.dir, { recursive: true, force: true });
  }
});

void test("map names use the atlas Chinese name, and items use the game files' Chinese name", async () => {
  const temp = await temporary();
  try {
    temp.atlas.maps.set("205", { name: "泰空陨石地", exits: [] });
    const knowledge = {
      ...temp.knowledge,
      chests: temp.knowledge.chests.map((chest) =>
        chest.mapId === 203
          ? {
              ...chest,
              contentName: "フェニックスのお",
              contentNames: null,
            }
          : chest,
      ),
      maps: [
        { id: 203, name: "Map_30010" },
        { id: 205, name: "Map_20010" },
      ],
    };
    const view = await readChapterRoute(
      temp.files,
      "ff5",
      options(temp, {
        knowledge,
        items: new Map([[4, { ja: "フェニックスのお", en: "Phoenix Down", zhc: "凤凰尾" }]]),
      }),
    );
    assert.match(view.startText, /测试洞窟/u);
    const firstSegment = view.segments[0];
    const secondSegment = view.segments[1];
    assert.ok(firstSegment);
    assert.ok(secondSegment);
    const firstStation = firstSegment.stations[0];
    const secondFirstStation = secondSegment.stations[0];
    assert.ok(firstStation);
    assert.ok(secondFirstStation);
    assert.equal(firstStation.mapText, "203 测试洞窟");
    assert.match(secondFirstStation.mapText, /泰空陨石地/u);
    assert.equal(firstStation.itemName, "凤凰尾");
    assert.match(secondSegment.legs[0]?.text ?? "", /泰空陨石地|洞窟深处/u);
    assert.doesNotMatch(firstStation.itemName, /フェニックス/u);
  } finally {
    await rm(temp.dir, { recursive: true, force: true });
  }
});

void test("an item name falls back to the plan's Chinese why when the export has none", async () => {
  const temp = await temporary();
  try {
    const knowledge = {
      ...temp.knowledge,
      chests: temp.knowledge.chests.map((chest) => ({
        ...chest,
        contentName: "フェニックスのお",
        contentNames: null,
      })),
    };
    const base = plan();
    const withWhy: ChapterPlan = {
      ...base,
      segments: base.segments.map((segment, index) =>
        index === 0
          ? {
              ...segment,
              stations: segment.stations.map((entry, stationIndex) =>
                stationIndex === 0 ? { ...entry, why: "开宝箱:凤凰尾" } : entry,
              ),
            }
          : segment,
      ),
    };
    const store = await ChapterPlanStore.load("ff5", temp.files.plan);
    await store.save(withWhy);
    const view = await readChapterRoute(temp.files, "ff5", options(temp, { knowledge }));
    assert.equal(view.segments[0]?.stations[0]?.itemName, "凤凰尾");
  } finally {
    await rm(temp.dir, { recursive: true, force: true });
  }
});

void test("a station with only a map id gets candidates and an entry-estimated leg, not zero", async () => {
  const temp = await temporary();
  try {
    const base = plan();
    const withUnknown: ChapterPlan = {
      ...base,
      segments: base.segments.map((segment, index) =>
        index === 0
          ? {
              ...segment,
              stations: [
                station("203:1,2", "move"),
                station("205", "story"),
                station("205:4,2", "move"),
              ],
            }
          : { ...segment, stations: [] },
      ),
    };
    const store = await ChapterPlanStore.load("ff5", temp.files.plan);
    await store.save(withUnknown);
    const events = new Map([
      [
        205,
        [
          { cell: [3, 3] as const, name: "ガラフ" },
          { cell: [4, 4] as const, name: "ボコ" },
        ],
      ],
    ]);
    const view = await readChapterRoute(temp.files, "ff5", options(temp, { events }));
    const unknown = view.segments[0]?.stations[1];
    assert.ok(unknown);
    assert.equal(unknown.cellText, "格子未定");
    assert.equal(unknown.unknownCell, true);
    assert.match(unknown.candidateText, /\(3,3\) ガラフ、\(4,4\) ボコ/u);
    const entryLeg = view.segments[0]?.legs[1];
    assert.ok(entryLeg);
    assert.equal(entryLeg.ok, true);
    assert.match(entryLeg.text, /按入口估算/u);
    assert.doesNotMatch(entryLeg.text, /，0 格，/u);
    assert.ok(entryLeg.cells > 0);
    const nextLeg = view.segments[0]?.legs[2];
    assert.ok(nextLeg);
    assert.equal(nextLeg.ok, true);
    assert.ok(nextLeg.cells > 0);

    const map = await readChapterRouteMap(temp.files, "ff5", 205, options(temp, { events }));
    const marker = map.stations.find((row) => row.number === unknown.number);
    assert.ok(marker);
    assert.equal(marker.unknownCell, true);
    assert.deepEqual(marker.cell, [3, 3]);
  } finally {
    await rm(temp.dir, { recursive: true, force: true });
  }
});

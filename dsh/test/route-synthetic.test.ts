/**
 * Task 79 route analyzer, synthetic maps: directed edges, `after`, the exact order versus
 * nearest neighbour, unreachable waypoints, and a save before the boss.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import { analyzeRoute, describe, estimatePair, orderStops } from "../src/engine/route/index.ts";
import {
  nearestNeighborOrder,
  type EdgeMinutes,
  type OrderStop,
} from "../src/engine/route/order.ts";
import type { RouteWorld, Waypoint } from "../src/engine/route/types.ts";

/** 10 → 11 direct; 11 → 12 → 10 makes the return trip two hops. 13 is isolated. */
function atlasWithMaps(): Atlas {
  const atlas = new Atlas();
  const exits = (to: number, cell: Cell): { cell: Cell; to: number; name: string }[] => [
    { cell, to, name: "GotoMap" },
  ];
  atlas.maps.set("10", { name: "起点", exits: exits(11, [1, 1]), chests: [] });
  atlas.maps.set("11", { name: "中间", exits: exits(12, [5, 5]), chests: [] });
  atlas.maps.set("12", { name: "远处", exits: exits(10, [3, 3]), chests: [] });
  atlas.maps.set("13", { name: "孤岛", exits: [], chests: [] });
  return atlas;
}

function world(atlas: Atlas): RouteWorld {
  return { atlas };
}

function waypoint(
  id: string,
  kind: Waypoint["kind"],
  map: number,
  cell: Cell | null,
  after: readonly string[] = [],
): Waypoint {
  return {
    id,
    kind,
    map,
    cell,
    label: id,
    ...(after.length === 0 ? {} : { after }),
  };
}

void test("a directed edge makes 10 → 11 shorter than 11 → 10", () => {
  const atlas = atlasWithMaps();
  const forward = estimatePair(world(atlas), { map: 10, cell: [1, 1] }, { map: 11, cell: [5, 5] });
  const backward = estimatePair(world(atlas), { map: 11, cell: [5, 5] }, { map: 10, cell: [1, 1] });
  const ahead = forward.ok ? forward.estimate : assert.fail(forward.reason);
  const back = backward.ok ? backward.estimate : assert.fail(backward.reason);
  assert.equal(ahead.hops, 1);
  assert.equal(back.hops, 2);
  assert.deepEqual(ahead.maps, [10, 11]);
  assert.deepEqual(back.maps, [11, 12, 10]);
  assert.ok(ahead.minutes < back.minutes);
});

void test("after is respected even when the free order would be shorter", () => {
  const atlas = atlasWithMaps();
  const plan = analyzeRoute(
    {
      start: { map: 10, cell: [1, 1] },
      waypoints: [waypoint("b", "chest", 11, [5, 5], ["a"]), waypoint("a", "chest", 12, [3, 3])],
    },
    world(atlas),
  );
  assert.deepEqual(
    plan.legs.map((leg) => leg.waypoint),
    ["a", "b"],
  );
});

void test("the exact order is never worse than nearest neighbour", () => {
  // Nearest neighbour from the start takes A→B→C for 12; the exact order A→C→B is 3.
  const costs = new Map<string, number>([
    ["0,1", 1],
    ["1,2", 1],
    ["2,3", 10],
    ["0,2", 2],
    ["2,1", 1],
    ["1,3", 1],
    ["0,3", 20],
    ["3,1", 1],
    ["3,2", 1],
  ]);
  const edge: EdgeMinutes = (from, to) => costs.get(`${from},${to}`) ?? null;
  const stops: OrderStop[] = [
    { id: "A", after: [] },
    { id: "B", after: [] },
    { id: "C", after: [] },
  ];
  const prereq = [0, 0, 0];
  const exact = orderStops(stops, edge, null);
  const nearest = nearestNeighborOrder(stops.length, null, edge, prereq, new Map());
  assert.equal(exact.order.length, 3);
  assert.ok(exact.cost <= nearest.cost);
  assert.equal(exact.cost, 3);
});

void test("an isolated map puts its waypoint in unreachable with a reason", () => {
  const atlas = atlasWithMaps();
  const plan = analyzeRoute(
    {
      start: { map: 10, cell: [1, 1] },
      waypoints: [waypoint("chest", "chest", 11, [5, 5]), waypoint("lost", "story", 13, [2, 2])],
    },
    world(atlas),
  );
  assert.deepEqual(
    plan.legs.map((leg) => leg.waypoint),
    ["chest"],
  );
  assert.equal(plan.unreachable.length, 1);
  const lost = plan.unreachable[0];
  assert.ok(lost);
  assert.equal(lost.id, "lost");
  assert.match(lost.reason, /地图记录里没有从地图 10 到地图 13/);
  assert.ok(Number.isFinite(plan.total.minutes));
});

void test("a save is ordered before the boss even when the boss is cheaper first", () => {
  const atlas = atlasWithMaps();
  const plan = analyzeRoute(
    {
      start: { map: 10, cell: [1, 1] },
      waypoints: [waypoint("boss", "boss", 11, [5, 5]), waypoint("save", "save", 12, [3, 3])],
    },
    world(atlas),
  );
  assert.deepEqual(
    plan.legs.map((leg) => leg.waypoint),
    ["save", "boss"],
  );
  assert.ok(!plan.warnings.some((warning) => warning.includes("没有存档")));
});

void test("a boss without a save warns instead of inventing one", () => {
  const atlas = atlasWithMaps();
  const plan = analyzeRoute(
    {
      start: { map: 10, cell: [1, 1] },
      waypoints: [waypoint("boss", "boss", 11, [5, 5])],
    },
    world(atlas),
  );
  assert.ok(plan.warnings.some((warning) => warning.includes("首领前没有存档")));
  assert.equal(plan.legs.length, 1);
});

void test("a grind waypoint's estimate adds budget battles at Config seconds each", () => {
  const atlas = atlasWithMaps();
  const plain = waypoint("g", "grind", 11, [5, 5]);
  const grind: Waypoint = { ...plain, until: { battles: 4 } };
  const base = analyzeRoute({ start: { map: 10, cell: [1, 1] }, waypoints: [plain] }, world(atlas));
  const withGrind = analyzeRoute(
    { start: { map: 10, cell: [1, 1] }, waypoints: [grind] },
    { ...world(atlas), battleSeconds: 30 },
  );
  assert.ok(Math.abs(withGrind.total.minutes - base.total.minutes - 2) < 1e-9);
  assert.equal(withGrind.legs[0]?.kind, "grind");
});

void test("a grind on the way is ordered before a farther chest", () => {
  const atlas = atlasWithMaps();
  const grind: Waypoint = {
    ...waypoint("g", "grind", 11, [5, 5]),
    until: { battles: 2 },
  };
  const plan = analyzeRoute(
    {
      start: { map: 10, cell: [1, 1] },
      waypoints: [waypoint("far", "chest", 12, [3, 3]), grind],
    },
    { ...world(atlas), battleSeconds: 30 },
  );
  assert.deepEqual(
    plan.legs.map((leg) => leg.waypoint),
    ["g", "far"],
  );
});

void test("describe keeps a long plan within 30 lines", () => {
  const atlas = atlasWithMaps();
  const waypoints = Array.from({ length: 30 }, (_, index) =>
    waypoint(`chest-${index}`, "chest", 11, [index + 1, 1]),
  );
  const plan = analyzeRoute({ start: { map: 10, cell: [1, 1] }, waypoints }, world(atlas));
  const lines = describe(plan).split("\n");
  assert.ok(lines.length <= 30);
  assert.match(lines[0] ?? "", /^路线：/);
});

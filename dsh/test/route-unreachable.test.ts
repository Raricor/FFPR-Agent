/**
 * Task 127: an unreachable stop (the 453/454 grinds) must not throw away the rest of the
 * route, and a world-map start on a vehicle must plan like the executor will. Synthetic maps
 * only: the real FF5 files stay under `.deps/`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { CollisionStore } from "../src/engine/regions.ts";
import { analyzeRoute } from "../src/engine/route/analyze.ts";
import { estimatePair } from "../src/engine/route/distance.ts";
import type { Waypoint } from "../src/engine/route/types.ts";
import type { Cell } from "../src/engine/nav.ts";

const WALK_ROWS = ["1000", "0000", "0001", "0011"];
/** Label 0 on the ship grid is not the walk grid's label 0; it touches walk block 1 only. */
const SHIP_ROWS = ["0000", "0000", "0010", "0000"];

function worldFile(): Record<string, unknown> {
  return {
    id: 1,
    name: "世界地图",
    collision: [],
    damage: [],
    hiddenPassages: [],
    exits: [{ cell: [3, 3], toMap: 2, toPoint: 1, name: "洞窟" }],
    points: [],
    world: {
      width: 4,
      height: 4,
      modes: { walk: WALK_ROWS, chocobo: WALK_ROWS, ship: SHIP_ROWS },
      points: [],
    },
    worldExits: [],
  };
}

async function worldStart(): Promise<{
  readonly atlas: Atlas;
  readonly collisions: CollisionStore;
  readonly dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-route-world-"));
  await writeFile(join(dir, "1.json"), `${JSON.stringify(worldFile())}\n`, "utf8");
  const atlas = new Atlas();
  atlas.maps.set("1", { name: "世界地图", exits: [], chests: [] });
  atlas.maps.set("2", {
    name: "洞窟",
    exits: [{ cell: [1, 1], to: 3, name: "GotoMap" }],
    chests: [],
  });
  atlas.maps.set("3", { name: "深处", exits: [], chests: [] });
  atlas.maps.set("9", { name: "孤岛", exits: [], chests: [] });
  const collisions = await CollisionStore.load(undefined, undefined, dir);
  return { atlas, collisions, dir };
}

function waypoint(id: string, kind: Waypoint["kind"], map: number, cell: Cell): Waypoint {
  return { id, kind, map, cell, label: id };
}

void test("a chocobo on the world map plans the stops and drops only the unreachable one", async () => {
  const { atlas, collisions, dir } = await worldStart();
  try {
    const plan = analyzeRoute(
      {
        start: { map: 1, cell: [0, 0] },
        end: { map: 2, cell: [1, 1] },
        waypoints: [waypoint("cave", "chest", 2, [1, 1]), waypoint("lost", "story", 9, [1, 1])],
      },
      { atlas, collisions, worldModes: ["walk", "chocobo"] },
    );
    assert.deepEqual(
      plan.legs.map((leg) => leg.waypoint),
      ["cave", "end"],
    );
    assert.deepEqual(
      plan.unreachable.map((lost) => lost.id),
      ["lost"],
    );
    const lost = plan.unreachable[0];
    assert.ok(lost);
    assert.match(lost.reason, /地图记录里没有从地图 1 到地图 9/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("an unreachable end keeps every reachable stop and finishes at the last one", async () => {
  const { atlas, collisions, dir } = await worldStart();
  try {
    const plan = analyzeRoute(
      {
        start: { map: 1, cell: [0, 0] },
        end: { map: 9, cell: [1, 1] },
        waypoints: [waypoint("cave", "chest", 2, [1, 1]), waypoint("deep", "story", 3, [1, 1])],
      },
      { atlas, collisions, worldModes: ["walk", "chocobo"] },
    );
    assert.deepEqual(
      plan.legs.map((leg) => leg.waypoint),
      ["cave", "deep", "end"],
    );
    assert.equal(plan.legs.at(-1)?.map, 3);
    assert.equal(plan.unreachable.length, 0);
    assert.ok(plan.warnings.some((warning) => warning.includes("终点走不到")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("two vehicles' component numbers do not merge unrelated world blocks", async () => {
  const { collisions, dir } = await worldStart();
  try {
    const walkStart = collisions.worldZone(1, ["walk", "ship"], [0, 0]);
    const walkFar = collisions.worldZone(1, ["walk", "ship"], [2, 3]);
    assert.notEqual(walkStart, null);
    assert.notEqual(walkFar, null);
    assert.notEqual(walkStart, walkFar);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the world map falls back to one node when the start block cannot reach the exit", async () => {
  const { atlas, collisions, dir } = await worldStart();
  try {
    const pair = estimatePair(
      { atlas, collisions, worldModes: ["walk", "chocobo"] },
      { map: 1, cell: [0, 0] },
      { map: 2, cell: [1, 1] },
    );
    if (!pair.ok) assert.fail(pair.reason);
    assert.deepEqual(pair.estimate.maps, [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("route distance crosses a hidden passage when ordinary floor cannot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-route-passage-"));
  try {
    const rows = ["000", "111", "000"];
    await writeFile(
      join(dir, "70.json"),
      JSON.stringify({
        id: 70,
        name: "暗道",
        collision: [{ name: "GroundCollision", rows }],
        hiddenPassages: [{ name: "GroundHiddenPassage", cells: [[1, 1, 1]] }],
        damage: [],
        exits: [],
      }),
      "utf8",
    );
    const collisions = await CollisionStore.load(undefined, undefined, dir);
    const pair = estimatePair(
      { atlas: new Atlas(), collisions },
      { map: 70, cell: [0, 0] },
      { map: 70, cell: [2, 2] },
    );
    if (!pair.ok) assert.fail(pair.reason);
    assert.equal(pair.estimate.cells, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("fifteen synthetic stops analyse in under two seconds", () => {
  const atlas = new Atlas();
  for (let id = 100; id <= 115; id += 1) {
    atlas.maps.set(String(id), {
      name: `地图 ${id}`,
      exits: [{ cell: [1, 1], to: id + 1, name: "GotoMap" }],
      chests: [],
    });
  }
  const waypoints = Array.from({ length: 15 }, (_, index) =>
    waypoint(`s${index + 1}`, "chest", 101 + index, [1, 1]),
  );
  const started = performance.now();
  const plan = analyzeRoute({ start: { map: 100, cell: [1, 1] }, waypoints }, { atlas });
  const elapsed = performance.now() - started;
  assert.equal(plan.legs.length, 15);
  assert.ok(elapsed < 2000, `十五站用了 ${elapsed.toFixed(0)} ms`);
  assert.ok(Number.isFinite(plan.total.minutes));
});

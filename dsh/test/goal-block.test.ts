/**
 * Task 140: a cross-map plan to a cell must pick the entrance whose landing is in the goal
 * cell's block. The real case is 205: the 203 right stair lands east, the left stair lands
 * west, and the boss at (14,11) is west. Synthetic maps first, then the saved FF5 atlas when
 * this machine has it.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import { DEPS } from "../src/engine/paths.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import { estimatePair } from "../src/engine/route/distance.ts";
import { goalEntranceHint, mapPath } from "../src/engine/skills/travel.ts";

function openRows(): string[] {
  return Array.from({ length: 5 }, () => "00000");
}

/** 12 is split by a solid row 2: rows 0-1 are block A, rows 3-4 block B. */
function collisionFor(map: number): {
  readonly searchLayer: number;
  readonly layers: readonly {
    readonly name: string;
    readonly rows: readonly string[];
  }[];
} {
  const rows = openRows();
  if (map === 12) rows[2] = "11111";
  return { searchLayer: 1, layers: [{ name: "GroundCollision", rows }] };
}

function atlasWithTwoEntrances(): Atlas {
  const atlas = new Atlas();
  atlas.maps.set("10", {
    name: "起点",
    exits: [{ cell: [1, 1], to: 11, name: "GotoMap", land: [1, 1], landLayer: 1 }],
    chests: [],
  });
  atlas.maps.set("11", {
    name: "两块图",
    exits: [
      { cell: [2, 1], to: 12, name: "GotoMap", land: [2, 1], landLayer: 1 },
      { cell: [2, 4], to: 12, name: "GotoMap", land: [2, 4], landLayer: 1 },
    ],
    chests: [],
  });
  atlas.maps.set("12", { name: "目标图", exits: [], chests: [] });
  return atlas;
}

async function setUp(dir: string): Promise<{
  readonly atlas: Atlas;
  readonly collisions: CollisionStore;
  readonly regions: RegionIndex;
}> {
  const atlas = atlasWithTwoEntrances();
  const store = await CollisionStore.load(dir);
  for (const map of [10, 11, 12]) await store.remember(map, collisionFor(map));
  return { atlas, collisions: store, regions: RegionIndex.create(atlas, store) };
}

void test("a goal in block B picks the entrance that lands in B, not the first entrance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-goal-block-"));
  try {
    const { atlas, collisions, regions } = await setUp(dir);
    const goal: Cell = [3, 4];
    const withGoal = mapPath(atlas, 10, 12, new Set(), true, {
      start: [1, 1],
      startLayer: 1,
      regions,
      toCell: goal,
    });
    assert.ok(withGoal !== null);
    const chosen = withGoal.at(-1);
    assert.ok(chosen !== undefined);
    assert.deepEqual([chosen.from, chosen.cell], [11, [2, 4]]);

    // The route estimator asks the same question and must use the same entrance.
    const pair = estimatePair(
      { atlas, collisions, regions },
      { map: 10, cell: [1, 1] },
      { map: 12, cell: goal },
    );
    if (!pair.ok) assert.fail(pair.reason);
    assert.deepEqual(pair.estimate.maps, [10, 11, 12]);

    // Without the goal cell the old planner still takes the first entrance into 12.
    const mapOnly = mapPath(atlas, 10, 12, new Set(), true, {
      start: [1, 1],
      startLayer: 1,
      regions,
    });
    assert.ok(mapOnly !== null);
    assert.deepEqual(mapOnly.at(-1)?.cell, [2, 1]);

    const hint = goalEntranceHint(atlas, regions, 12, goal);
    assert.match(hint ?? "", /地图 12 的另一个块/u);
    assert.match(hint ?? "", /地图 11 \(2, 4\)→落点 \(2, 4\)/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("real FF5 data: from 202 (26,14) the 205 (14,11) goal uses the west stair", async (t) => {
  const real = join(DEPS, "ds");
  const atlasFile = join(real, "atlas-ff5.json");
  try {
    await access(atlasFile);
    await access(join(real, "collision-ff5", "205.json"));
  } catch {
    t.skip("没有本机 .deps/ds 的 FF5 地图记录和碰撞缓存");
    return;
  }
  const atlas = await Atlas.load(atlasFile);
  const store = await CollisionStore.load(
    join(real, "collision-ff5"),
    undefined,
    join(DEPS, "knowledge", "ff5", "files", "maps"),
  );
  const regions = RegionIndex.create(atlas, store);
  const path = mapPath(atlas, 202, 205, new Set(), true, {
    start: [26, 14],
    startLayer: 1,
    regions,
    toCell: [14, 11],
  });
  if (path === null) {
    assert.fail("202 (26,14) should reach 205 (14,11) through the west stair");
    return;
  }
  const last = path.at(-1);
  assert.ok(last !== undefined);
  assert.equal(last.to, 205);
  assert.equal(last.from, 203);
  assert.deepEqual(last.cell, [9, 15]);
  assert.match(goalEntranceHint(atlas, regions, 205, [14, 11]) ?? "", /地图 203 \(9, 15\)/u);
});

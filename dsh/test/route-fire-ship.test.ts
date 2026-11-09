/**
 * Task 79 route analyzer on the real Fire-Powered Ship fixture (maps 250–265, 634–638).
 * The order is not asserted: what matters is that every leg's map sequence is exactly what
 * mapPath returns on its own, that an unreachable leg has a reason, and that the estimate is
 * finite.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import { mapPath } from "../src/engine/skills/travel.ts";
import { analyzeRoute, describe } from "../src/engine/route/index.ts";
import type { Waypoint } from "../src/engine/route/types.ts";

const DIR = join(import.meta.dirname, "fixtures", "route", "fire-ship");

void test("the Fire-Powered Ship fixture plans finite legs that match mapPath", async () => {
  const atlas = await Atlas.load(join(DIR, "atlas.json"));
  const collisions = await CollisionStore.load(join(DIR, "collision"));
  const regions = RegionIndex.create(atlas, collisions);
  const waypoints: Waypoint[] = [
    { id: "chest-a", kind: "chest", map: 261, cell: [13, 27], label: "261 的宝箱 A" },
    { id: "chest-b", kind: "chest", map: 261, cell: [7, 8], label: "261 的宝箱 B" },
    { id: "move-265", kind: "move", map: 265, cell: [10, 11], label: "265 的落脚点" },
  ];
  const plan = analyzeRoute(
    {
      start: { map: 253, cell: [5, 16] },
      waypoints,
    },
    { atlas, collisions, regions },
  );

  assert.ok(plan.legs.length > 0);
  for (const leg of plan.legs) {
    const path = mapPath(atlas, leg.from.map, leg.map, new Set(), true, {
      regions,
      start: leg.from.cell,
    });
    assert.notEqual(path, null, `leg to ${leg.waypoint} should be routeable`);
    assert.deepEqual(leg.maps, [leg.from.map, ...(path ?? []).map((hop) => hop.to)]);
  }
  for (const waypoint of plan.unreachable) {
    assert.notEqual(waypoint.reason.trim(), "", `${waypoint.id} should have a reason`);
  }
  assert.ok(Number.isFinite(plan.total.minutes));
  assert.ok(Number.isFinite(plan.total.cells));
  assert.ok(describe(plan).split("\n").length <= 30);
});

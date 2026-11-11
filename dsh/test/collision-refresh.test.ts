/**
 * Task 149 follow-up: a switch can open a wall the cached collision still has. The refresh
 * helper re-reads the bridge's live grid, counts the changed cells, rewrites the cache with
 * source 实时 and rebuilds the region so mapPath can plan again.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import { CollisionStore, RegionIndex, refreshLiveCollision } from "../src/engine/regions.ts";
import { mapPath } from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

const BLOCKED = ["111111", "111111", "001100", "111111", "111111", "111111"];
const OPEN = ["000000", "000000", "000000", "000000", "000000", "000000"];

function collision(rows: readonly string[]): unknown {
  return { searchLayer: 1, layers: [{ name: "GroundCollision", rows }] };
}

function sameMapPath(
  atlas: Atlas,
  store: CollisionStore,
  regions: RegionIndex,
): ReturnType<typeof mapPath> {
  return mapPath(atlas, 90, 90, new Set(), true, {
    start: [0, 2] as Cell,
    startLayer: 1,
    regions,
    collisions: store,
    toCell: [4, 2] as Cell,
    toLayer: 1,
  });
}

void test("a live collision refresh opens the block and reports changed cells", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-live-collision-"));
  try {
    const atlas = new Atlas();
    atlas.maps.set("90", { name: "机关洞窟", exits: [], chests: [] });
    const store = await CollisionStore.load(dir);
    await store.remember(90, collision(BLOCKED));
    const regions = RegionIndex.create(atlas, store);
    assert.equal(sameMapPath(atlas, store, regions), null, "the cached wall splits the map");

    const pilot = new FakePilot();
    pilot.on("collision", { collision: collision(OPEN) });
    const refreshed = await refreshLiveCollision(pilot, store, regions, 90, [0, 2], new Set());
    assert.ok(refreshed !== null);
    assert.equal(refreshed.changed, 32);
    assert.match(refreshed.text, /重读了地图 90 的实时碰撞：变了 32 格/u);
    assert.deepEqual(sameMapPath(atlas, store, regions), [], "the region was rebuilt");

    const cached = JSON.parse(await readFile(join(dir, "90.json"), "utf8")) as {
      source?: string;
      at?: string;
    };
    assert.equal(cached.source, "实时");
    assert.equal(typeof cached.at, "string");

    const tried = new Set([90]);
    assert.equal(
      await refreshLiveCollision(pilot, store, regions, 90, [0, 2], tried),
      null,
      "a map is refreshed at most once per execution",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

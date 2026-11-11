/**
 * Task 143: a story event trigger on the only corridor out of Tule was recorded as a
 * "走不过去" step, so the (map, block) planner cut the start cell off from the exit while the
 * old whole-map planner still worked. Event trigger cells are walked onto; they must stay in
 * their block, and a refusal there is the event starting, not a wall.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import type { Cell } from "../src/engine/nav.ts";
import { mapPath } from "../src/engine/skills/travel.ts";
import { records, type Json } from "../src/engine/values.ts";

const DEPS = join(import.meta.dirname, "..", "..", ".deps");

/** A one-cell-wide corridor: start (3,1), event trigger (3,2) marked as a wall, exit (3,3). */
const CORRIDOR = {
  id: 30,
  collision: [
    {
      name: "GroundCollision",
      rows: ["1111111", "1110111", "1111111", "1110111", "1111111"],
    },
  ],
  events: [{ cell: [3, 2], name: "sc_e_0030:海賊達の会話", file: "sc_e_0030.json" }],
  exits: [{ cell: [3, 3], toMap: 1, toPoint: 1, name: "ワールドマップ" }],
};

async function withCorridor<T>(run: (store: CollisionStore) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "travel-event-cells-"));
  try {
    await writeFile(join(dir, "30.json"), JSON.stringify(CORRIDOR));
    return await run(await CollisionStore.load(undefined, undefined, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function atlasOf(): Atlas {
  const atlas = new Atlas();
  atlas.maps.set("30", {
    name: "图尔村",
    exits: [{ cell: [3, 3], to: 1, name: "ワールドマップ" }],
    chests: [],
    // The bad record the old run wrote: the event started as the party tried to leave.
    links: [{ from: [3, 1], to: [3, 2], how: "走不过去", count: 3, layer: 1 }],
  });
  atlas.maps.set("1", { name: "世界地图", exits: [], chests: [] });
  return atlas;
}

void test("an event cell on the only corridor stays walkable and does not split its block", async () => {
  await withCorridor((store) => {
    assert.ok(store.eventCells(30).has("3,2"));
    const atlas = atlasOf();
    const regions = RegionIndex.create(atlas, store);
    const path = mapPath(atlas, 30, 1, new Set(), true, {
      start: [3, 1],
      startLayer: 1,
      regions,
      collisions: store,
    });
    assert.ok(path !== null);
    assert.deepEqual(
      path.map((hop) => [hop.kind, hop.cell]),
      [["exit", [3, 3]]],
    );
  });
});

async function hasRealData(): Promise<boolean> {
  try {
    await access(join(DEPS, "ds", "atlas-ff5.json"));
    await access(join(DEPS, "ds", "collision-ff5", "30.json"));
    await access(join(DEPS, "knowledge", "ff5", "files", "maps", "30.json"));
    return true;
  } catch {
    return false;
  }
}

void test("real FF5 data: from 30 (32,49) the world-map exit is planned", async (t) => {
  if (!(await hasRealData())) {
    t.skip("没有本机 .deps 的 FF5 地图记录或碰撞缓存");
    return;
  }
  const store = await CollisionStore.load(
    join(DEPS, "ds", "collision-ff5"),
    undefined,
    join(DEPS, "knowledge", "ff5", "files", "maps"),
  );
  assert.ok(store.eventCells(30).has("32,49"));
  const atlas = await Atlas.load(join(DEPS, "ds", "atlas-ff5.json"));
  const entry = atlas.maps.get("30");
  const exit = records(entry?.exits).find((item) => {
    const cell = Array.isArray(item.cell) ? (item.cell as Json[]) : [];
    return (
      typeof cell[0] === "number" && cell[0] === 32 && typeof cell[1] === "number" && cell[1] === 51
    );
  });
  if (entry === undefined || exit === undefined) {
    t.skip("地图记录里没有 30 (32,51) 的出口");
    return;
  }
  // Re-create the failure: the event started when the party tried to leave, and the old
  // recorder wrote that step as a trusted wall.
  const links = records(entry.links);
  entry.links = [...links, { from: [32, 49], to: [32, 50], how: "走不过去", count: 3, layer: 1 }];
  const regions = RegionIndex.create(atlas, store);
  const path = mapPath(atlas, 30, 1, new Set(), true, {
    start: [32, 49],
    startLayer: 1,
    regions,
    collisions: store,
  });
  assert.ok(path !== null);
  assert.deepEqual(
    path.map((hop) => [hop.kind, hop.cell] as [string, Cell]),
    [["exit", [32, 51]]],
  );
});

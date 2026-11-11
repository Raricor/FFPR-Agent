/**
 * Task 148: a map can be split into blocks that only connect through another map. The
 * route estimator used a grid BFS inside the map and called every goal in the other block
 * unreachable, while `mapPath` answered "same map, already there". These synthetic maps put
 * a wall down map 40: its left block leaves to 41, 41's door drops back into the right block.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import { estimatePair } from "../src/engine/route/distance.ts";
import { mapPath } from "../src/engine/skills/travel.ts";

interface ExitDef {
  readonly cell: Cell;
  readonly to: number;
  readonly land?: Cell;
  readonly landLayer?: number;
}

/** A solid column 3 splits map 40 into x=0..2 and x=4..7; every other map is open. */
function rowsFor(map: number): string[] {
  const wall = map === 40 ? "00010000" : "00000000";
  return Array.from({ length: 8 }, () => wall);
}

function collisionFor(map: number): {
  readonly searchLayer: number;
  readonly layers: readonly {
    readonly name: string;
    readonly rows: readonly string[];
  }[];
} {
  return { searchLayer: 1, layers: [{ name: "GroundCollision", rows: rowsFor(map) }] };
}

function atlasWith(returnLanding: Cell | null): Atlas {
  const atlas = new Atlas();
  const leftDoor: ExitDef = { cell: [2, 3], to: 41, land: [2, 3], landLayer: 1 };
  atlas.maps.set("40", {
    name: "被墙分开的图",
    exits: [leftDoor],
    chests: [],
  });
  const back: ExitDef[] =
    returnLanding === null ? [] : [{ cell: [2, 3], to: 40, land: returnLanding, landLayer: 1 }];
  atlas.maps.set("41", { name: "绕路的图", exits: back, chests: [] });
  return atlas;
}

async function setUp(returnLanding: Cell | null): Promise<{
  readonly dir: string;
  readonly atlas: Atlas;
  readonly collisions: CollisionStore;
  readonly regions: RegionIndex;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-same-map-detour-"));
  const atlas = atlasWith(returnLanding);
  const store = await CollisionStore.load(dir);
  for (const map of [40, 41]) await store.remember(map, collisionFor(map));
  return {
    dir,
    atlas,
    collisions: store,
    regions: RegionIndex.create(atlas, store),
  };
}

void test("mapPath leaves and re-enters the same map through another map", async () => {
  const { dir, atlas, collisions, regions } = await setUp([4, 3]);
  try {
    const path = mapPath(atlas, 40, 40, new Set(), true, {
      start: [0, 3],
      startLayer: 1,
      regions,
      collisions,
      toCell: [6, 3],
      toLayer: 1,
    });
    assert.deepEqual(
      path?.map((hop) => [hop.from, hop.to]),
      [
        [40, 41],
        [41, 40],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the route estimate accepts the same-map detour and names the map it passes", async () => {
  const { dir, atlas, collisions, regions } = await setUp([4, 3]);
  try {
    const pair = estimatePair(
      { atlas, collisions, regions },
      { map: 40, cell: [0, 3] },
      { map: 40, cell: [6, 3] },
    );
    if (!pair.ok) assert.fail(pair.reason);
    assert.equal(pair.estimate.hops, 2);
    assert.deepEqual(pair.estimate.maps, [40, 41, 40]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a goal inside the start block still needs no detour", async () => {
  const { dir, atlas, collisions, regions } = await setUp([4, 3]);
  try {
    const path = mapPath(atlas, 40, 40, new Set(), true, {
      start: [0, 3],
      startLayer: 1,
      regions,
      collisions,
      toCell: [1, 3],
      toLayer: 1,
    });
    assert.deepEqual(path, []);
    const pair = estimatePair(
      { atlas, collisions, regions },
      { map: 40, cell: [0, 3] },
      { map: 40, cell: [1, 3] },
    );
    if (!pair.ok) assert.fail(pair.reason);
    assert.deepEqual(pair.estimate.maps, [40]);
    assert.equal(pair.estimate.hops, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("without a door back into the right block the detour is unreachable", async () => {
  const { dir, atlas, collisions, regions } = await setUp(null);
  try {
    const path = mapPath(atlas, 40, 40, new Set(), true, {
      start: [0, 3],
      startLayer: 1,
      regions,
      collisions,
      toCell: [6, 3],
      toLayer: 1,
    });
    assert.equal(path, null);
    const pair = estimatePair(
      { atlas, collisions, regions },
      { map: 40, cell: [0, 3] },
      { map: 40, cell: [6, 3] },
    );
    assert.equal(pair.ok, false);
    assert.match(pair.reason, /同图另一块，经别的图也绕不过去/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a door that lands back in the start block is not a detour", async () => {
  const { dir, atlas, collisions, regions } = await setUp([0, 3]);
  try {
    const path = mapPath(atlas, 40, 40, new Set(), true, {
      start: [0, 3],
      startLayer: 1,
      regions,
      collisions,
      toCell: [6, 3],
      toLayer: 1,
    });
    assert.equal(path, null);
    const pair = estimatePair(
      { atlas, collisions, regions },
      { map: 40, cell: [0, 3] },
      { map: 40, cell: [6, 3] },
    );
    assert.equal(pair.ok, false);
    assert.match(pair.reason, /同图另一块，经别的图也绕不过去/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

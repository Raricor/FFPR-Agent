/**
 * Task 75: a map is planned by (map, block). 256's south half has one exit to 253; the north
 * exit (8,11) to 261 is in the other block. Starting at the south (6,20), the planner must
 * leave through 253, ride 257 → 634, cross 255's north half and ride 635 → 260, instead of
 * trying the north exit and learning by walking into the wall.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { CollisionStore } from "../src/engine/regions.ts";
import { mapPath, travelToMap } from "../src/engine/skills/travel.ts";
import { isRecord, num, records, type Json } from "../src/engine/values.ts";
import { FakePilot } from "./fake-pilot.ts";

interface ExitDef {
  readonly cell: Cell;
  readonly to: number;
  readonly land?: Cell;
  readonly landLayer?: number;
}

interface MapDef {
  readonly name: string;
  readonly exits: readonly ExitDef[];
}

const MAPS: Record<number, MapDef> = {
  253: {
    name: "火力船 机房",
    exits: [
      { cell: [16, 15], to: 256, land: [6, 19], landLayer: 1 },
      { cell: [14, 6], to: 257, land: [5, 10], landLayer: 1 },
    ],
  },
  255: {
    name: "火力船 机房",
    exits: [
      { cell: [6, 6], to: 635, land: [5, 8], landLayer: 1 },
      { cell: [10, 16], to: 634, land: [5, 8], landLayer: 1 },
      { cell: [6, 26], to: 253, land: [6, 25], landLayer: 1 },
      { cell: [19, 20], to: 258 },
    ],
  },
  256: {
    name: "火力船 机房",
    exits: [
      { cell: [8, 11], to: 261 },
      { cell: [8, 8], to: 259 },
      { cell: [6, 20], to: 253, land: [6, 25], landLayer: 1 },
    ],
  },
  257: {
    name: "火力船 升降机",
    exits: [{ cell: [5, 9], to: 253, land: [5, 10], landLayer: 1 }],
  },
  259: { name: "火力船 机房", exits: [] },
  260: {
    name: "火力船 升降机",
    exits: [{ cell: [4, 9], to: 261, land: [4, 9], landLayer: 1 }],
  },
  261: { name: "火力船 甲板", exits: [] },
  634: {
    name: "火力船 升降机",
    exits: [{ cell: [5, 9], to: 255, land: [6, 7], landLayer: 2 }],
  },
  635: {
    name: "火力船 升降机",
    exits: [{ cell: [5, 9], to: 255, land: [6, 7], landLayer: 2 }],
  },
};

const LIFTS: Record<number, { readonly from: Cell; readonly to: number; readonly land: Cell }> = {
  257: { from: [4, 6], to: 634, land: [4, 6] },
  634: { from: [4, 6], to: 257, land: [4, 6] },
  635: { from: [4, 6], to: 260, land: [3, 6] },
  260: { from: [3, 6], to: 635, land: [4, 6] },
};

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

const fixture = JSON.parse(
  await readFile(
    join(import.meta.dirname, "fixtures", "nav", "map255-firepowered-ship.json"),
    "utf8",
  ),
) as { readonly collision: Json };

interface World {
  map: number;
  cell: Cell;
  state: string;
}

function sameCell(left: Cell | null, right: Cell | null): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
}

function roundTrip(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function openRows(size: number): string[] {
  return Array.from({ length: size }, () => "0".repeat(size));
}

/** 256's row 15 is a solid wall, splitting it north/south like the real engine room. */
function collisionFor(map: number): Json {
  if (map === 255) return roundTrip(fixture.collision);
  const rows = openRows(40);
  if (map === 256) rows[15] = "1".repeat(40);
  return { searchLayer: 1, layers: [{ name: "GroundCollision", rows }] };
}

function atlasWithMaps(): Atlas {
  const atlas = new Atlas();
  for (const [key, map] of Object.entries(MAPS)) {
    atlas.maps.set(key, {
      name: map.name,
      exits: map.exits.map((exit) => ({
        cell: exit.cell,
        to: exit.to,
        name: "GotoMap",
        ...(exit.land === undefined ? {} : { land: exit.land }),
        ...(exit.landLayer === undefined ? {} : { landLayer: exit.landLayer }),
      })),
      chests: [],
    });
  }
  return atlas;
}

async function atlasWithRides(): Promise<Atlas> {
  const atlas = atlasWithMaps();
  for (const [key, lift] of Object.entries(LIFTS)) {
    const mapId = Number(key);
    await atlas.ride(mapId, lift.from, lift.from, "Left", lift.to, lift.land, "坐一趟", 1);
  }
  return atlas;
}

async function cacheFor(): Promise<{ dir: string; store: CollisionStore }> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-regions-"));
  const store = await CollisionStore.load(dir);
  for (const key of Object.keys(MAPS)) {
    await store.remember(Number(key), collisionFor(Number(key)));
  }
  return { dir, store };
}

function position(world: World): Reply {
  return { pos: { state: world.state, map: world.map, cell: world.cell } };
}

function pilotFor(world: World): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => position(world));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [world.cell[0], world.cell[1]],
      attr: Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: { ...collisionFor(world.map), playerCell: [world.cell[0], world.cell[1]] },
  }));
  pilot.on("entities", () => ({ entities: { total: 0, entities: [] } }));
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target" };
    }
    world.cell = [to[0], to[1]];
    const exit = (MAPS[world.map]?.exits ?? []).find((candidate) =>
      sameCell(candidate.cell, world.cell),
    );
    if (exit !== undefined) {
      world.map = exit.to;
      world.cell = exit.land ?? [5, 5];
    }
    return { ok: true, ...position(world) };
  });
  pilot.on("keys", (fields) => {
    const keys = Array.isArray(fields.keys) ? fields.keys : [];
    if (!keys.some((key) => typeof key === "string" && key.startsWith("Enter"))) {
      return { ok: true, ...position(world) };
    }
    const lift = LIFTS[world.map];
    if (lift !== undefined && sameCell(world.cell, lift.from)) {
      world.map = lift.to;
      world.cell = lift.land;
    }
    return { ok: true, ...position(world) };
  });
  pilot.on("wait", { ok: true });
  pilot.onQuery("sample", { sample: { field: { moveState: "Walk" } } });
  return pilot;
}

void test("256 south reaches 261 through 253 → 257 → 634 → 255 north → 635 → 260", async () => {
  const { dir, store } = await cacheFor();
  try {
    const atlas = await atlasWithRides();
    const world: World = { map: 256, cell: [6, 21], state: "Player" };
    const result = await travelToMap(
      pilotFor(world),
      { atlas, moveState: { drake: null }, collisions: store },
      261,
    );
    assert.equal(result.reached, true);
    assert.equal(world.map, 261);
    assert.deepEqual(
      result.hops.map((hop) => [hop.from, hop.actual, hop.kind]),
      [
        [256, 253, "exit"],
        [253, 257, "exit"],
        [257, 634, "ride"],
        [634, 255, "exit"],
        [255, 635, "exit"],
        [635, 260, "ride"],
        [260, 261, "exit"],
      ],
    );
    assert.doesNotMatch(result.text, /没走通的出口/);
    const fromSouth = records(atlas.maps.get("256")?.exits).find(
      (exit) => isRecord(exit) && num(exit.to) === 253,
    );
    assert.ok(fromSouth !== undefined && isRecord(fromSouth));
    assert.deepEqual(fromSouth.land, [6, 25]);
    assert.equal(atlas.rides(257)[0]?.landLayer, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("without cached collision the same map is one node, as before task 75", async () => {
  const atlas = await atlasWithRides();
  const old = mapPath(atlas, 255, 635);
  assert.ok(old !== null);
  assert.deepEqual(old[0]?.cell, [6, 6]);
  const { dir, store } = await cacheFor();
  try {
    const regions = (await import("../src/engine/regions.ts")).RegionIndex.create(atlas, store);
    const planned = mapPath(atlas, 255, 635, new Set(), true, {
      start: [6, 25],
      startLayer: 2,
      regions,
    });
    assert.ok(planned !== null);
    assert.deepEqual(
      planned.map((hop) => [hop.from, hop.to, hop.kind]),
      [
        [255, 253, "exit"],
        [253, 257, "exit"],
        [257, 634, "ride"],
        [634, 255, "exit"],
        [255, 635, "exit"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the real 252 recording's door landing reaches its other exit in the cached block", async () => {
  const recording = JSON.parse(
    await readFile(
      join(import.meta.dirname, "fixtures", "nav", "map252-firepowered-ship.json"),
      "utf8",
    ),
  ) as { readonly collision: Json };
  const dir = await mkdtemp(join(tmpdir(), "ffpr-regions-"));
  try {
    const store = await CollisionStore.load(dir);
    await store.remember(252, recording.collision);
    const atlas = new Atlas();
    atlas.maps.set("252", {
      name: "火力船 机房",
      exits: [{ cell: [9, 3], to: 253, name: "GotoMap" }],
      chests: [],
    });
    atlas.maps.set("253", { name: "火力船 升降机", exits: [], chests: [] });
    const { RegionIndex } = await import("../src/engine/regions.ts");
    const regions = RegionIndex.create(atlas, store);
    const region = regions.region(252);
    assert.ok(region);
    const from = region.blocksAt([9, 12], 1);
    assert.ok(from.length > 0);
    assert.equal(region.reachable(from, [9, 3], null).ok, true);
    const path = mapPath(atlas, 252, 253, new Set(), true, {
      start: [9, 12],
      startLayer: 1,
      regions,
    });
    assert.ok(path !== null);
    assert.deepEqual(path[0]?.cell, [9, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a collision cache is overwritten by the newest entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-regions-"));
  try {
    const store = await CollisionStore.load(dir);
    const first = {
      searchLayer: 1,
      layers: [{ name: "GroundCollision", rows: ["000", "000"] }],
    };
    assert.equal(await store.remember(253, first), true);
    const path = join(dir, "253.json");
    assert.match(await readFile(path, "utf8"), /GroundCollision/);
    const second = {
      searchLayer: 2,
      layers: [{ name: "UpperCollision", rows: ["111", "111"] }],
    };
    assert.equal(await store.remember(253, second), true);
    const text = await readFile(path, "utf8");
    assert.match(text, /UpperCollision/);
    assert.doesNotMatch(text, /GroundCollision/);
    const reloaded = await CollisionStore.load(dir);
    assert.deepEqual(reloaded.get(253), second);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("atlas keeps an exit's landing when the next look rewrites the exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-regions-atlas-"));
  const path = join(directory, "atlas.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        255: {
          name: "火力船 机房",
          exits: [{ cell: [6, 26], to: 253, name: "GotoMap" }],
          chests: [],
        },
      }),
      "utf8",
    );
    const atlas = await Atlas.load(path);
    await atlas.landExit(255, [6, 26], 253, [6, 25], 1);
    await atlas.visit(255, "火力船 机房", [{ cell: [6, 26], to: 253, name: "GotoMap" }], []);
    const reloaded = await Atlas.load(path);
    const exit = records(reloaded.maps.get("255")?.exits)[0];
    assert.ok(exit !== undefined && isRecord(exit));
    assert.deepEqual(exit.land, [6, 25]);
    assert.equal(exit.landLayer, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a plan blocked by a region says which map lacks collision and that the record is connected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-regions-"));
  try {
    const store = await CollisionStore.load(dir);
    // Map 11's landing (1,1) is on the left of a solid column; its exit (3,1) is on the right.
    await store.remember(11, {
      searchLayer: 1,
      layers: [{ name: "GroundCollision", rows: ["00100", "00100", "00100", "00100", "00100"] }],
    });
    const atlas = new Atlas();
    atlas.maps.set("10", {
      name: "A",
      exits: [{ cell: [0, 0], to: 11, name: "GotoMap", land: [1, 1], landLayer: 1 }],
      chests: [],
    });
    atlas.maps.set("11", {
      name: "B",
      exits: [{ cell: [3, 1], to: 12, name: "GotoMap", land: [0, 0], landLayer: 1 }],
      chests: [],
    });
    atlas.maps.set("12", { name: "C", exits: [], chests: [] });
    const pilot = new FakePilot();
    pilot.on("pos", { pos: { state: "Player", map: 10, cell: [0, 0] } });
    const result = await travelToMap(
      pilot,
      { atlas, moveState: { drake: null }, collisions: store },
      12,
    );
    assert.equal(result.reached, false);
    assert.match(result.text, /规划失败的原因/);
    assert.match(result.text, /没有碰撞缓存的图:地图 10/);
    assert.match(result.text, /地图记录本身是通的/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("charting an indoor map writes its collision beside the atlas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-regions-game-"));
  try {
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile: join(dir, "atlas.json"),
      tacticsFile: join(dir, "tactics.json"),
      elementsFile: join(dir, "elements.json"),
    });
    const pilot = new FakePilot();
    pilot.on("pos", { pos: { map: 255, state: "Player", cell: [6, 7] } });
    pilot.on("entities", { entities: { total: 0, entities: [] } });
    pilot.onQuery("sample", { sample: { user: { areaText: "火力船", locationText: "" } } });
    pilot.on("collision", { collision: collisionFor(255) });
    assert.equal(await game.chart(pilot), 255);
    const store = await CollisionStore.load(join(dir, "collision-ff5"));
    const saved = store.get(255);
    assert.ok(saved !== undefined);
    assert.deepEqual(
      saved.layers.map((layer) => layer.name),
      ["UpperCollision"],
    );
    assert.equal(saved.searchLayer, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

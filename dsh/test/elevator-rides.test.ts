/**
 * Task 71: a lift changes the map by pressing, not by walking onto an exit. The 255 fixture is
 * the real Fire-Powered Ship engine room, split in two by the collision data; the route from
 * its north half to the south half has to ride 634 → 257 and come back through 253.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { num, record, records, type Json } from "../src/engine/values.ts";
import { detourToCell, mapPath, travelToMap } from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

interface MapDef {
  readonly name: string;
  readonly exits: readonly {
    readonly cell: Cell;
    readonly to: number;
    readonly land?: Cell;
    readonly landLayer?: number;
  }[];
}

const MAPS: Record<number, MapDef> = {
  253: {
    name: "火力船 机房",
    // Task 76: the recorded landing is what lets the detour walk this entrance automatically.
    exits: [{ cell: [5, 16], to: 255, land: [6, 25], landLayer: 2 }],
  },
  255: {
    name: "火力船 机房",
    exits: [
      { cell: [19, 20], to: 258 },
      { cell: [10, 16], to: 634 },
      { cell: [6, 6], to: 635 },
      { cell: [6, 26], to: 253 },
    ],
  },
  257: { name: "火力船 升降机", exits: [{ cell: [5, 9], to: 253 }] },
  258: { name: "火力船 机房", exits: [{ cell: [4, 8], to: 255 }] },
  634: { name: "火力船 升降机", exits: [{ cell: [5, 9], to: 255 }] },
  635: { name: "火力船 升降机", exits: [{ cell: [5, 9], to: 255 }] },
  260: { name: "火力船 升降机", exits: [] },
};

/** Where an exit drops the party, keyed by "from:to" (the same map has several landings). */
const ENTRIES: Record<string, Cell> = {
  "253:255": [6, 25],
  "255:634": [5, 8],
  "255:635": [5, 8],
  "257:253": [5, 10],
  "258:255": [19, 21],
  "634:255": [6, 7],
  "635:255": [6, 7],
};

/** The lift levers: standing cell on the source map → the map and cell it puts the party on. */
const LIFTS: Record<number, { readonly from: Cell; readonly to: number; readonly land: Cell }> = {
  257: { from: [4, 6], to: 634, land: [4, 6] },
  634: { from: [4, 6], to: 257, land: [4, 6] },
  635: { from: [4, 6], to: 260, land: [3, 6] },
  260: { from: [3, 6], to: 635, land: [4, 6] },
};

const fixture = JSON.parse(
  await readFile(
    join(import.meta.dirname, "fixtures", "nav", "map255-firepowered-ship.json"),
    "utf8",
  ),
) as { readonly collision: Json; readonly entities: Json };

async function atlasWithRides(withRides: boolean): Promise<Atlas> {
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
  if (withRides) {
    await atlas.ride(257, [4, 6], [3, 6], "Left", 634, [4, 6]);
    await atlas.ride(634, [4, 6], [3, 6], "Left", 257, [4, 6]);
    await atlas.ride(635, [4, 6], [3, 6], "Left", 260, [3, 6]);
    await atlas.ride(260, [3, 6], [2, 6], "Left", 635, [4, 6]);
  }
  return atlas;
}

interface World {
  map: number;
  cell: Cell;
  state: string;
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function sameCell(left: Cell | null, right: Cell | null): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
}

function position(world: World): Reply {
  return { pos: { state: world.state, map: world.map, cell: world.cell } };
}

function map255Collision(world: World): Json {
  const collision = JSON.parse(JSON.stringify(fixture.collision)) as Json;
  collision.playerCell = [world.cell[0], world.cell[1]];
  return collision;
}

function simpleCollision(world: World): Json {
  return {
    searchLayer: 1,
    playerCell: [world.cell[0], world.cell[1]],
    layers: [
      {
        name: "GroundCollision",
        rows: Array.from({ length: 20 }, () => "0".repeat(20)),
      },
    ],
  };
}

function entitiesOn(map: number, kind: unknown): Json[] {
  if (map !== 255) return [];
  const all = records(record(fixture.entities).entities);
  return all.filter((entity) => entity.kind === kind);
}

function pilotFor(world: World): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => position(world));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [world.cell[0], world.cell[1]],
      attr: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: world.map === 255 ? map255Collision(world) : simpleCollision(world),
  }));
  pilot.on("entities", (fields) => ({
    entities: { total: 0, entities: entitiesOn(world.map, fields.kind) },
  }));
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
      const from = world.map;
      world.map = exit.to;
      world.cell = ENTRIES[`${from}:${exit.to}`] ?? [5, 5];
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

function exitAt(atlas: Atlas, map: number, cell: Cell): number | null {
  for (const exit of records(atlas.maps.get(String(map))?.exits)) {
    const at = cellOf(exit.cell);
    const to = num(exit.to);
    if (at !== null && to !== undefined && sameCell(at, cell)) return Math.trunc(to);
  }
  return null;
}

void test("a lift is a map edge, not a same-map move", async () => {
  const atlas = await atlasWithRides(true);
  const path = mapPath(atlas, 634, 257);
  assert.ok(path !== null);
  const first = path[0];
  assert.ok(first !== undefined);
  assert.equal(first.kind, "ride");
  assert.deepEqual(first.cell, [4, 6]);
  assert.equal(first.dir, "Left");
  assert.equal(exitAt(atlas, 634, [4, 6]), null);
  assert.deepEqual(atlas.moves(634), []);
});

void test("255 north reaches 255 south through 634 → 257 → 253 with recorded rides", async () => {
  const atlas = await atlasWithRides(true);
  const world: World = { map: 255, cell: [6, 7], state: "Player" };
  const text = await detourToCell(pilotFor(world), { atlas, moveState: { drake: null } }, [6, 26]);
  assert.ok(text !== null);
  assert.match(text, /地图 255 →\(10, 16\)→ 地图 634/);
  assert.match(text, /地图 634 →\(4, 6\)面朝Left按\(3, 6\)→ 地图 257/);
  assert.match(text, /地图 257 →\(5, 9\)→ 地图 253/);
  assert.match(text, /地图 253 →\(5, 16\)→ 地图 255/);
  assert.match(text, /从地图 253 回来落在 \(6, 25\)/);
  // (6, 26) is itself the exit to 253, so the last step enters it; the detour text above is
  // what proves the party got through the southern half to the exit.
  assert.equal(world.map, 253);
});

void test("without a ride edge 255 north falls back to task 70's disconnected-region text", async () => {
  const atlas = await atlasWithRides(false);
  const world: World = { map: 255, cell: [6, 7], state: "Player" };
  const text = await detourToCell(pilotFor(world), { atlas, moveState: { drake: null } }, [6, 26]);
  assert.ok(text !== null);
  assert.match(text, /目标 \(6, 26\) 和你现在所在的区域不连通/);
  assert.match(text, /能走到目标的落点有/);
  assert.match(text, /地图 634/);
  assert.deepEqual(world.cell, [6, 7]);
});

void test("travelToMap rides a lift and replans from the actual floor", async () => {
  const atlas = await atlasWithRides(true);
  const world: World = { map: 255, cell: [6, 7], state: "Player" };
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 257);
  assert.equal(result.reached, true);
  assert.equal(world.map, 257);
  assert.deepEqual(
    result.hops.map((hop) => [hop.kind, hop.from, hop.actual]),
    [
      ["exit", 255, 634],
      ["ride", 634, 257],
    ],
  );
  assert.match(result.text, /地图 634 →\(4, 6\)面朝Left按\(3, 6\)→ 地图 257/);
});

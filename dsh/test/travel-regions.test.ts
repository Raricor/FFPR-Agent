/**
 * Task 74: "this exit does not work" is only true from the region the party tried it in.
 * 255 is the real Fire-Powered Ship engine room, split in two by its collision data. Starting
 * at (6,25) in the south, the first plan walks into (6,6) in the north and fails; after a later
 * 634 → 255 landing at (6,7) the same exit must be usable, or the route to 261 is lost.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { record, records, type Json } from "../src/engine/values.ts";
import { travelToMap } from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

interface MapDef {
  readonly name: string;
  readonly exits: readonly { readonly cell: Cell; readonly to: number }[];
}

const MAPS: Record<number, MapDef> = {
  253: {
    name: "火力船 机房",
    exits: [
      { cell: [16, 15], to: 256 },
      { cell: [14, 6], to: 257 },
    ],
  },
  255: {
    name: "火力船 机房",
    exits: [
      { cell: [6, 6], to: 635 },
      { cell: [10, 16], to: 634 },
      { cell: [6, 26], to: 253 },
      { cell: [19, 20], to: 258 },
    ],
  },
  256: {
    name: "火力船 机房",
    exits: [
      { cell: [8, 11], to: 261 },
      { cell: [8, 8], to: 259 },
      { cell: [6, 20], to: 253 },
    ],
  },
  257: { name: "火力船 升降机", exits: [{ cell: [5, 9], to: 253 }] },
  258: { name: "火力船 机房", exits: [{ cell: [4, 8], to: 255 }] },
  259: { name: "火力船 机房", exits: [] },
  260: { name: "火力船 升降机", exits: [{ cell: [4, 9], to: 261 }] },
  261: { name: "火力船 甲板", exits: [] },
  634: { name: "火力船 升降机", exits: [{ cell: [5, 9], to: 255 }] },
  635: { name: "火力船 升降机", exits: [{ cell: [5, 9], to: 255 }] },
};

/** Where an exit drops the party, keyed by "from:to". */
const ENTRIES: Record<string, Cell> = {
  "255:253": [6, 25],
  "253:256": [6, 19],
  "253:257": [5, 10],
  "256:253": [6, 25],
  "634:255": [6, 7],
  "255:635": [5, 8],
  "260:261": [4, 9],
  "258:255": [6, 7],
};

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

async function atlasWithRides(): Promise<Atlas> {
  const atlas = new Atlas();
  for (const [key, map] of Object.entries(MAPS)) {
    atlas.maps.set(key, {
      name: map.name,
      exits: map.exits.map((exit) => ({
        cell: exit.cell,
        to: exit.to,
        name: "GotoMap",
      })),
      chests: [],
    });
  }
  await atlas.ride(257, [4, 6], [3, 6], "Left", 634, [4, 6]);
  await atlas.ride(634, [4, 6], [3, 6], "Left", 257, [4, 6]);
  await atlas.ride(635, [4, 6], [3, 6], "Left", 260, [3, 6]);
  await atlas.ride(260, [3, 6], [2, 6], "Left", 635, [4, 6]);
  return atlas;
}

interface World {
  map: number;
  cell: Cell;
  state: string;
}

function roundTrip(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function sameCell(left: Cell | null, right: Cell | null): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
}

function position(world: World): Reply {
  return { pos: { state: world.state, map: world.map, cell: world.cell } };
}

/** 256 is split north/south by one solid row, like the real engine room's two halves. */
function collisionFor(world: World): Json {
  if (world.map === 255) {
    const collision = roundTrip(fixture.collision);
    collision.playerCell = [world.cell[0], world.cell[1]];
    return collision;
  }
  const rows = Array.from({ length: 40 }, () => "0".repeat(40));
  if (world.map === 256) rows[15] = "1".repeat(40);
  return {
    searchLayer: 1,
    playerCell: [world.cell[0], world.cell[1]],
    layers: [{ name: "GroundCollision", rows }],
  };
}

function entitiesOn(map: number, kind: unknown): Json[] {
  if (map !== 255) return [];
  return records(record(fixture.entities).entities).filter((entity) => entity.kind === kind);
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
  pilot.on("collision", () => ({ collision: collisionFor(world) }));
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

void test("from 255 south the north (6,6) exit is retried after 634 lands the party north", async () => {
  const atlas = await atlasWithRides();
  const world: World = { map: 255, cell: [6, 25], state: "Player" };
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 261);

  assert.equal(result.reached, true);
  assert.equal(world.map, 261);
  const hops = result.hops.map((hop) => ({
    kind: hop.kind,
    from: hop.from,
    actual: hop.actual,
    cell: hop.cell,
  }));
  // Both failures are still reported, and the same (6,6) exit works from the northern half.
  assert.ok(result.blocked.some((line) => line.includes("地图 255 (6, 6) 到地图 635")));
  assert.ok(result.blocked.some((line) => line.includes("地图 256 (8, 11) 到地图 261")));
  assert.ok(hops.some((hop) => hop.from === 255 && hop.actual === 253));
  assert.ok(hops.some((hop) => hop.from === 253 && hop.actual === 256));
  assert.ok(hops.some((hop) => hop.from === 253 && hop.actual === 257 && hop.cell[0] === 14));
  assert.ok(hops.some((hop) => hop.kind === "ride" && hop.from === 257 && hop.actual === 634));
  const back = hops.find((hop) => hop.from === 634 && hop.actual === 255);
  assert.ok(back !== undefined);
  assert.deepEqual(back.cell, [5, 9]);
  const north = hops.find((hop) => hop.from === 255 && hop.actual === 635);
  assert.ok(north !== undefined);
  assert.deepEqual(north.cell, [6, 6]);
  assert.ok(hops.some((hop) => hop.kind === "ride" && hop.from === 635 && hop.actual === 260));
  assert.ok(hops.some((hop) => hop.from === 260 && hop.actual === 261));
  assert.match(result.text, /地图 255 →\(6, 6\)→ 地图 635/);
  assert.match(result.text, /地图 634 →\(5, 9\)→ 地图 255/);
  assert.match(result.text, /地图 260 →\(4, 9\)→ 地图 261/);
});

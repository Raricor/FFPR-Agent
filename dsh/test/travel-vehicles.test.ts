/**
 * Task 143: the world map's ship is parked on the sea beside the party's shore. Walking to
 * Tule used to plan a sea route and then try to walk it; the route must first walk onto the
 * saved ship cell (the game boards it), sail to the dock, and only then walk into town.
 * The same world without a `vehicles` query keeps the old behaviour.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { CollisionStore } from "../src/engine/regions.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { travelToMap } from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

const WIDTH = 10;
const HEIGHT = 3;
const SHIP: Cell = [4, 1];
const DOCK: Cell = [7, 1];
const TOWN_EXIT: Cell = [8, 1];

/** Left shore columns 0-3, sea 4-7, right shore 8-9, with the ship on the sea. */
const WORLD_FILE = {
  id: 1,
  world: {
    width: WIDTH,
    height: HEIGHT,
    modes: {
      walk: Array.from({ length: HEIGHT }, () => "1111000011"),
      ship: Array.from({ length: HEIGHT }, () => "0000111100"),
    },
    points: [],
  },
  exits: [{ cell: TOWN_EXIT, toMap: 39, toPoint: 1, name: "图尔村" }],
};

interface World {
  map: number;
  cell: Cell;
  state: string;
}

function position(world: World): Reply {
  return { pos: { state: "Player", map: world.map, cell: world.cell } };
}

function terrain(world: World): Reply {
  return {
    cells: {
      origin: [0, 0],
      center: [world.cell[0], world.cell[1]],
      attr: Array.from({ length: HEIGHT }, () =>
        Array.from({ length: WIDTH }, (_, x) => {
          if (world.map !== 1) return 0;
          return x >= 4 && x <= 7 ? 16 : 4;
        }),
      ),
    },
  };
}

function pilotFor(world: World, vehicles: boolean): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => position(world));
  pilot.on("cells", () => terrain(world));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [world.cell[0], world.cell[1]],
      layers: [{ name: "GroundCollision", rows: Array.from({ length: 20 }, () => "0".repeat(20)) }],
    },
  }));
  pilot.on("entities", () => ({ entities: { total: 0, entities: [] } }));
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target" };
    }
    const target: Cell = [to[0], to[1]];
    if (world.map !== 1) return { ok: true, ...position(world) };
    world.cell = target;
    if (world.state === "Player" && target[0] === SHIP[0] && target[1] === SHIP[1]) {
      // The game boards the ship when the party steps onto its cell.
      world.state = "Ship";
    } else if (world.state === "Ship" && target[0] === TOWN_EXIT[0] && target[1] === TOWN_EXIT[1]) {
      world.map = 39;
      world.cell = [1, 1];
      world.state = "Player";
    }
    return { ok: true, ...position(world) };
  });
  pilot.on("wait", { ok: true });
  pilot.onQuery("sample", () => ({ sample: { field: { moveState: world.state } } }));
  if (vehicles) {
    pilot.onQuery("vehicles", () => ({
      vehicles: {
        ready: true,
        list: [
          {
            id: 4,
            type: 2,
            typeName: "Ship",
            map: 1,
            cell: SHIP,
            enabled: true,
            riding: false,
          },
        ],
      },
    }));
  }
  return pilot;
}

function atlasOf(): Atlas {
  const atlas = new Atlas();
  atlas.maps.set("1", {
    name: "世界地图",
    exits: [{ cell: TOWN_EXIT, to: 39, name: "图尔村" }],
    chests: [],
  });
  atlas.maps.set("39", { name: "图尔村", exits: [], chests: [] });
  return atlas;
}

async function withWorldStore<T>(run: (store: CollisionStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "travel-vehicles-"));
  try {
    await writeFile(join(dir, "1.json"), JSON.stringify(WORLD_FILE));
    return await run(await CollisionStore.load(undefined, undefined, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("on foot walks to the parked ship, sails to the dock and enters the town", async () => {
  await withWorldStore(async (store) => {
    const world: World = { map: 1, cell: [1, 1], state: "Player" };
    const pilot = pilotFor(world, true);
    const said: string[] = [];
    const result = await travelToMap(
      pilot,
      { atlas: atlasOf(), moveState: { drake: null }, collisions: store },
      39,
      (line) => said.push(line),
    );
    assert.equal(result.reached, true);
    assert.equal(world.map, 39);
    const walked = pilot.calls
      .filter((call) => call.kind === "send" && call.op === "walk")
      .map((call) => (call.kind === "send" ? call.fields.to : null));
    assert.ok(
      walked.some((cell) => Array.isArray(cell) && cell[0] === SHIP[0] && cell[1] === SHIP[1]),
    );
    assert.ok(
      walked.some((cell) => Array.isArray(cell) && cell[0] === DOCK[0] && cell[1] === DOCK[1]),
    );
    assert.ok(said.some((line) => line.includes("走到(4, 1)上船")));
    assert.match(result.text, /地图 1 →\(8, 1\)→ 地图 39/);
  });
});

void test("without a vehicles query the old walking behaviour remains", async () => {
  await withWorldStore(async (store) => {
    const world: World = { map: 1, cell: [1, 1], state: "Player" };
    const pilot = pilotFor(world, false);
    const result = await travelToMap(
      pilot,
      { atlas: atlasOf(), moveState: { drake: null }, collisions: store },
      39,
    );
    assert.equal(result.reached, false);
    assert.equal(world.map, 1);
    assert.match(result.text, /^到不了地图 39/m);
  });
});

void test("an old bridge that answers vehicles with an error keeps the old walking behaviour", async () => {
  await withWorldStore(async (store) => {
    const world: World = { map: 1, cell: [1, 1], state: "Player" };
    const pilot = pilotFor(world, false);
    pilot.onQuery("vehicles", { ok: false, error: "unknown op" });
    const result = await travelToMap(
      pilot,
      { atlas: atlasOf(), moveState: { drake: null }, collisions: store },
      39,
    );
    assert.equal(result.reached, false);
    assert.equal(world.map, 1);
    assert.match(result.text, /^到不了地图 39/m);
  });
});

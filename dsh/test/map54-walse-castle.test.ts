/**
 * Task 70: Walse Castle (map 54) from the 11-09 recording. The upper floor reaches the
 * world-map exits, the lower one does not; the water currents (流される) must be avoided;
 * two layerless "走不过去" records were made on the ground floor and must not close the
 * upper corridor.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import { entityLayer, layeredGrid, layeredRouteAvoiding } from "../src/engine/nav.ts";
import type { MoveState } from "../src/engine/skills/move.ts";
import { isConveyorEvent, plan } from "../src/engine/skills/move.ts";
import { detourToCell } from "../src/engine/skills/travel.ts";
import type { Json } from "../src/engine/values.ts";
import { FakePilot } from "./fake-pilot.ts";

interface RecordedEntity {
  readonly kind: string;
  readonly name?: string;
  readonly myLayer?: number;
  readonly cell: [number, number];
  readonly active?: boolean;
  readonly toMap?: number;
  readonly point?: number;
}

interface Fixture {
  readonly pos: { readonly map: number; readonly cell: Cell };
  readonly cells: {
    readonly center: Cell;
    readonly origin: Cell;
    readonly attr: number[][];
  };
  readonly entities: { readonly entities: RecordedEntity[] };
  readonly collision: {
    readonly searchLayer: number;
    readonly playerCell: Cell;
    readonly layers: readonly {
      readonly name: string;
      readonly rows: string[];
    }[];
  };
}

const map54 = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "nav", "map54-walse-castle.json"), "utf8"),
) as Fixture;

const FLOW_CELLS: ReadonlySet<string> = new Set(
  map54.entities.entities
    .filter((entity) => entity.kind === "Event" && (entity.name ?? "").includes("流される"))
    .map((entity) => `${entity.cell[0]},${entity.cell[1]}`),
);

const MAP_RECORD: Readonly<Record<number, Json>> = {
  54: {
    name: "沃尔斯城",
    exits: [
      { cell: [28, 31], to: 55, name: "GotoMap" },
      { cell: [36, 32], to: 62, name: "GotoMap" },
      { cell: [27, 54], to: 1, name: "ワールドマップに移動" },
      { cell: [28, 54], to: 1, name: "ワールドマップに移動" },
      { cell: [29, 54], to: 1, name: "ワールドマップに移動" },
      { cell: [36, 15], to: 66, name: "GotoMap" },
      { cell: [16, 31], to: 65, name: "GotoMap" },
    ],
    links: [
      { from: [28, 52], to: [28, 53], how: "走不过去" },
      { from: [29, 52], to: [29, 53], how: "走不过去" },
    ],
  },
  55: {
    name: "沃尔斯城 ２层",
    exits: [
      // Task 76: the detour only walks an entrance whose recorded landing is in the goal block.
      { cell: [11, 13], to: 54, name: "GotoMap", land: [28, 33], landLayer: 2 },
      { cell: [16, 6], to: 58, name: "GotoMap" },
      { cell: [16, 9], to: 62, name: "GotoMap" },
    ],
  },
  62: {
    name: "沃尔斯城 １层",
    exits: [
      { cell: [9, 17], to: 55, name: "GotoMap" },
      { cell: [14, 21], to: 54, name: "GotoMap" },
      { cell: [8, 13], to: 65, name: "GotoMap" },
    ],
  },
  65: {
    name: "沃尔斯城 通道",
    exits: [
      { cell: [4, 9], to: 54, name: "GotoMap" },
      { cell: [8, 7], to: 62, name: "GotoMap" },
    ],
  },
};

function atlasOf(ids: readonly number[]): Atlas {
  const atlas = new Atlas();
  for (const id of ids) {
    const record = MAP_RECORD[id];
    if (record === undefined) continue;
    atlas.maps.set(String(id), structuredClone(record));
  }
  return atlas;
}

/** The recording at a given cell and floor, with the game's own route left empty. */
function castlePilot(here: () => Cell, layer: () => number): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 54, cell: [here()[0], here()[1]] } }));
  pilot.on("cells", () => {
    const cell = here();
    return {
      cells: {
        ...map54.cells,
        center: [cell[0], cell[1]],
        at: [cell[0], cell[1]],
      },
    };
  });
  pilot.on("collision", () => ({
    collision: {
      ...map54.collision,
      playerCell: [here()[0], here()[1]],
      searchLayer: layer(),
    },
  }));
  pilot.on("entities", (fields) => {
    const found = map54.entities.entities.filter(
      (entity) => entity.kind === fields.kind && entity.active !== false,
    );
    return { entities: { total: found.length, entities: found } };
  });
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", () => ({
    ok: true,
    pos: { map: 54, cell: [here()[0], here()[1]] },
  }));
  return pilot;
}

function stateOf(atlas: Atlas): MoveState {
  return { drake: null, moves: (mapId) => atlas.moves(mapId) };
}

void test("map 54's plan keeps off the water currents when another way exists", () => {
  assert.equal(isConveyorEvent("１マス流される"), true);
  assert.equal(isConveyorEvent("３マス流される"), true);
  // (36,9) to (36,43) has a shortest way through the upper water at (37,16) and another way
  // around it; the recording's water cells at myLayer 11 are on Upper (height 2).
  const dangers = map54.entities.entities
    .filter((entity) => entity.kind === "Event" && (entity.name ?? "").includes("流される"))
    .map((entity) => ({
      cell: entity.cell,
      layer: entityLayer(entity.myLayer),
    }));
  const grid = layeredGrid(map54.collision, [], [], [], dangers);
  assert.ok(grid);
  const route = layeredRouteAvoiding({ ...grid, center: [36, 9], z: 2 }, [36, 43]);
  assert.deepEqual(route.danger, []);
  assert.deepEqual(route.path.at(-1)?.slice(0, 2), [36, 43]);
  assert.ok(
    route.path.every(([x, y]) => !FLOW_CELLS.has(`${x},${y}`)),
    `planned through a water current: ${JSON.stringify(route.path)}`,
  );
  assert.ok(route.path.length > 2, "the way around is longer than a straight step");
});

void test("a current in the only corridor is used, and reported as a risk", () => {
  const collision = {
    searchLayer: 1,
    playerCell: [0, 0],
    layers: [{ name: "GroundCollision", rows: ["000"] }],
  };
  const only = layeredGrid(collision, [], [], [], [{ cell: [1, 0], layer: 1 }]);
  assert.ok(only);
  const route = layeredRouteAvoiding(only, [2, 0]);
  assert.deepEqual(
    route.path.map(([x, y]) => [x, y]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  );
  assert.deepEqual(route.danger, [[1, 0, 1]]);

  const around = layeredGrid(
    {
      searchLayer: 1,
      playerCell: [0, 0],
      layers: [
        { name: "GroundCollision", rows: ["000", "000"] },
        { name: "UpperCollision", rows: ["000", "000"] },
      ],
    },
    [],
    [],
    [],
    [{ cell: [1, 0], layer: 1 }],
  );
  assert.ok(around);
  const safe = layeredRouteAvoiding(around, [2, 0]);
  assert.deepEqual(safe.danger, []);
  assert.ok(!safe.path.some(([x, y]) => x === 1 && y === 0), "walked onto the current");
});

void test("old layerless blocked steps do not close map 54's upper corridor", async () => {
  const atlas = atlasOf([54]);
  const pilot = castlePilot(
    () => [28, 33],
    () => 2,
  );
  const [, path] = await plan(pilot, [28, 54], false, new Set(), stateOf(atlas), 54);
  assert.deepEqual(path.at(-1), [28, 54], "the upper corridor reaches the world-map exit");

  // The same record with a layer is a real wall on that floor only.
  const upper: MoveState = {
    drake: null,
    moves: () => [
      { from: [27, 52], to: [27, 53], how: "走不过去", layer: 2 },
      { from: [28, 52], to: [28, 53], how: "走不过去", layer: 2 },
      { from: [29, 52], to: [29, 53], how: "走不过去", layer: 2 },
    ],
  };
  const [, blocked] = await plan(pilot, [28, 54], false, new Set(), upper, 54);
  assert.notDeepEqual(blocked.at(-1), [28, 54], "an upper-floor cut still closes the step");
});

void test("a new blocked step is stored with the floor it was found on", async () => {
  const atlas = new Atlas();
  await atlas.link(54, [28, 52], [28, 53], "走不过去", { layer: 1 });
  const move = atlas.moves(54)[0];
  assert.ok(move);
  assert.equal(move.layer, 1);
  assert.equal(move.how, "走不过去");
});

void test("map 54 from (36,33) cannot reach (28,54) on foot and lists the landings", async () => {
  const atlas = atlasOf([54]);
  const pilot = castlePilot(
    () => [36, 33],
    () => 2,
  );
  const text = await detourToCell(pilot, { atlas, moveState: stateOf(atlas) }, [28, 54]);
  assert.ok(text !== null);
  assert.match(text, /区域不连通/);
  assert.match(text, /能走到目标的落点有/);
  assert.match(text, /\(28, 33\)/);
});

void test("map 54 gets out through 62 and 55 when its own exit is in another region", async () => {
  const atlas = atlasOf([54, 55, 62, 65]);
  const world = new CastleWorld();
  const text = await detourToCell(
    pilotForWorld(world),
    { atlas, moveState: stateOf(atlas) },
    [28, 54],
  );
  assert.ok(text !== null);
  assert.match(text, /从地图 55 回来落在 \(28, 33\)/);
  assert.equal(world.map, 1, "walked the world-map exit at (28,54) after the detour");
});

interface Step {
  readonly to: number;
  readonly entry: Cell;
  readonly layer: number;
}

const EXITS: Readonly<Record<number, Readonly<Record<string, Step>>>> = {
  54: {
    "28,31": { to: 55, entry: [5, 5], layer: 1 },
    "36,32": { to: 62, entry: [5, 5], layer: 1 },
    "27,54": { to: 1, entry: [20, 20], layer: 1 },
    "28,54": { to: 1, entry: [20, 20], layer: 1 },
    "29,54": { to: 1, entry: [20, 20], layer: 1 },
    "36,15": { to: 66, entry: [5, 5], layer: 1 },
    "16,31": { to: 65, entry: [5, 5], layer: 1 },
  },
  62: {
    "9,17": { to: 55, entry: [5, 5], layer: 1 },
    "14,21": { to: 54, entry: [36, 33], layer: 2 },
    "8,13": { to: 65, entry: [5, 5], layer: 1 },
  },
  55: {
    "11,13": { to: 54, entry: [28, 33], layer: 2 },
    "16,9": { to: 62, entry: [5, 5], layer: 1 },
  },
  65: {
    "4,9": { to: 54, entry: [16, 32], layer: 1 },
    "8,7": { to: 62, entry: [5, 5], layer: 1 },
  },
};

/** A scripted walk over 54, 55, 62 and 65: an exit cell swaps the map and landing. */
class CastleWorld {
  map = 54;
  cell: Cell = [36, 33];
  layer = 2;
}

function openRows(size: number): string[] {
  return Array.from({ length: size }, () => "0".repeat(size));
}

function pilotForWorld(world: CastleWorld): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => ({
    pos: { map: world.map, cell: [world.cell[0], world.cell[1]] },
  }));
  pilot.on("cells", () => {
    if (world.map === 54) {
      return {
        cells: {
          ...map54.cells,
          center: [world.cell[0], world.cell[1]],
          at: [world.cell[0], world.cell[1]],
        },
      };
    }
    return {
      cells: {
        origin: [0, 0],
        center: [world.cell[0], world.cell[1]],
        attr: Array.from({ length: 30 }, () => Array.from({ length: 30 }, () => 0)),
      },
    };
  });
  pilot.on("collision", () => {
    if (world.map === 54) {
      return {
        collision: {
          ...map54.collision,
          playerCell: [world.cell[0], world.cell[1]],
          searchLayer: world.layer,
        },
      };
    }
    return {
      collision: {
        searchLayer: 1,
        playerCell: [world.cell[0], world.cell[1]],
        layers: [{ name: "GroundCollision", rows: openRows(30) }],
      },
    };
  });
  pilot.on("entities", (fields) => {
    if (world.map !== 54) return { entities: { total: 0, entities: [] } };
    const found = map54.entities.entities.filter(
      (entity) => entity.kind === fields.kind && entity.active !== false,
    );
    return { entities: { total: found.length, entities: found } };
  });
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target" };
    }
    world.cell = [to[0], to[1]];
    const exit = EXITS[world.map]?.[`${to[0]},${to[1]}`];
    if (exit !== undefined) {
      world.map = exit.to;
      world.cell = exit.entry;
      world.layer = exit.layer;
    }
    return {
      ok: true,
      pos: { map: world.map, cell: [world.cell[0], world.cell[1]] },
    };
  });
  pilot.on("wait", { ok: true });
  return pilot;
}

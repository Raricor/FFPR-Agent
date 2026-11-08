import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FakePilot } from "./fake-pilot.ts";
import { cellKey, layeredGrid, layeredRoute } from "../src/engine/nav.ts";
import type { Cell, LayerChange, LayeredGrid, LayerNode } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { plan, routeCells } from "../src/engine/skills/move.ts";

interface RecordedEntity {
  readonly kind: string;
  readonly active?: boolean;
  readonly cell: [number, number];
  readonly layer?: number;
}

interface Map216 {
  readonly pos: { readonly map: number; readonly cell: [number, number] };
  readonly cells: { readonly center: [number, number]; readonly attr: number[][] };
  readonly collision: unknown;
  readonly entities: { readonly entities: RecordedEntity[] };
  readonly routes: Record<string, { readonly route: Reply }>;
}

const map216 = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "nav", "map216-sunken-ship.json"), "utf8"),
) as Map216;

const START: Cell = [6, 12];
const EXIT: Cell = [7, 14];

const TO_LAYER: LayerChange[] = map216.entities.entities
  .filter((entity) => entity.kind === "ToLayer" && entity.active !== false)
  .map((entity) => ({ cell: entity.cell, to: entity.layer ?? null }));

/** The game's own walk to (3,14), the ToLayer that leads up to the exit. */
const GAME_TO_TO_LAYER: Cell[] = routeCells(map216.routes["[3, 14]"]?.route ?? {});

function grid(): LayeredGrid {
  const found = layeredGrid(map216.collision, [], TO_LAYER);
  assert.ok(found, "map 216 collision");
  return found;
}

function cellsOf(route: readonly LayerNode[]): Cell[] {
  return route.map(([x, y]) => [x, y] as const);
}

void test("map 216 starts on the bottom floor with its two ToLayer cells", () => {
  const layered = grid();
  assert.deepEqual(layered.center, START);
  assert.equal(layered.z, 0);
  assert.deepEqual([...layered.heights.keys()], [0, 1]);
  assert.deepEqual(
    [...(layered.transitions ?? new Map()).entries()],
    [
      ["3,14", 1],
      ["3,15", 0],
    ],
  );
});

void test("the walk to the (3,14) ToLayer matches the game's recorded route", () => {
  const route = layeredRoute(grid(), [3, 14]);
  assert.deepEqual(cellsOf(route), GAME_TO_TO_LAYER);
  assert.deepEqual(route.at(-1), [3, 14, 1], "the ToLayer puts the party on floor 1");
});

void test("the exit is planned up the (3,14) ToLayer, not through a 3/5 shortcut", () => {
  const layered = grid();
  const route = layeredRoute(layered, EXIT);
  assert.deepEqual(route.at(-1), [7, 14, 1], "the exit is open on floor 1");
  for (let i = 1; i < route.length; i++) {
    const before = route[i - 1];
    const after = route[i];
    if (!before || !after || before[2] === after[2]) continue;
    assert.equal(
      layered.transitions?.get(cellKey(after[0], after[1])),
      after[2],
      `${after.join(",")} changes floor without a ToLayer`,
    );
  }
  const up = route.findIndex((node) => node[2] === 1);
  assert.ok(up >= 0, "the route reaches floor 1");
  assert.deepEqual(cellsOf(route.slice(0, up + 1)), GAME_TO_TO_LAYER);
});

/** A FakePilot replaying the map 216 recording; `route` is empty like the game's on floor 1. */
function recordedPilot(): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: map216.pos });
  pilot.on("cells", { cells: map216.cells });
  pilot.on("collision", { collision: map216.collision });
  pilot.on("entities", (fields) => {
    const found = map216.entities.entities.filter(
      (entity) => fields.kind === "All" || (entity.kind === fields.kind && entity.active !== false),
    );
    return { entities: { total: found.length, entities: found } };
  });
  pilot.on("route", { route: {} });
  return pilot;
}

void test("plan walks to the exit along the game's route to the ToLayer", async () => {
  const [here, path] = await plan(recordedPilot(), EXIT, false);
  assert.deepEqual(here, START);
  assert.deepEqual(path.at(-1), EXIT);
  assert.deepEqual(path.slice(0, GAME_TO_TO_LAYER.length), GAME_TO_TO_LAYER);
});

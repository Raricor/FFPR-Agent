import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  cellKey,
  corners,
  edgeKey,
  findPath,
  floorRule,
  hasTerrain,
  indoorGrid,
  layeredGrid,
  layeredPath,
  layeredView,
  pathToward,
  renderCells,
  terrainRule,
} from "../src/engine/nav.ts";
import type { Cell, CellGrid, CellValue, LayeredGrid } from "../src/engine/nav.ts";

interface RawCells {
  readonly origin: [number, number];
  readonly center: [number, number];
  readonly attr: (number | null)[][];
  readonly stairs?: string[];
}

interface WorldFixture {
  readonly cells: Record<string, RawCells>;
  readonly findPath: readonly {
    readonly cells: string;
    readonly goal: [number, number];
    readonly byShip: boolean;
    readonly path: [number, number][] | null;
    readonly corners: [number, number][] | null;
  }[];
  readonly pathToward: readonly {
    readonly cells: string;
    readonly goal: [number, number];
    readonly rule: "ship" | "foot" | "flying";
    readonly path: [number, number][];
    readonly corners: [number, number][];
  }[];
  readonly hasTerrain: Record<string, boolean>;
}

interface IndoorCase {
  readonly name: string;
  readonly collision: unknown;
  readonly blocked: [number, number][];
  readonly grid: RawCells;
  readonly paths: readonly { readonly goal: [number, number]; readonly path: [number, number][] }[];
}

interface IndoorFixture {
  readonly cases: readonly IndoorCase[];
  readonly carwen: {
    readonly collision: unknown;
    readonly grid: RawCells;
    readonly path: [number, number][];
  };
  readonly stairs: {
    readonly grid: RawCells;
    readonly around: [number, number][];
    readonly up: [number, number][];
  };
  readonly cut: {
    readonly grid: RawCells;
    readonly first: [number, number][];
    readonly cut: [string, string][];
  };
}

interface LayeredCase {
  readonly name: string;
  readonly collision: unknown;
  readonly blocked: [number, number][];
  readonly grid: {
    heights: [number, string[]][];
    center: [number, number];
    z: number;
    blocked: string[];
  };
  readonly paths: readonly { readonly goal: [number, number]; readonly path: [number, number][] }[];
  readonly view: { center: [number, number]; rows: string[] } | null;
}

interface LayeredFixture {
  readonly cases: readonly LayeredCase[];
  readonly cut: {
    readonly collision: unknown;
    readonly path: [number, number][];
    readonly cut: [string, string][];
    readonly withCut: [number, number][];
  };
  readonly gridKeys: number[];
}

const world = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "nav", "world.json"), "utf8"),
) as WorldFixture;
const indoor = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "nav", "indoor.json"), "utf8"),
) as IndoorFixture;
const layered = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "nav", "layered.json"), "utf8"),
) as LayeredFixture;
const cellsFixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "nav", "cells.json"), "utf8"),
) as { cases: readonly { cells: RawCells; text: string }[] };

function decodeCells(raw: RawCells): CellGrid {
  return {
    origin: raw.origin,
    center: raw.center,
    attr: raw.attr,
    stairs: raw.stairs ? new Set(raw.stairs) : undefined,
  };
}

function canonicalCells(grid: CellGrid): unknown {
  return {
    origin: grid.origin,
    center: grid.center,
    attr: grid.attr,
    stairs: grid.stairs ? [...grid.stairs].sort() : [],
  };
}

function canonicalLayered(grid: LayeredGrid): unknown {
  return {
    heights: [...grid.heights.entries()],
    center: grid.center,
    z: grid.z,
    blocked: [...grid.blocked].sort(),
  };
}

const RULES = {
  ship: terrainRule(true),
  foot: terrainRule(false),
  flying: terrainRule(false, true),
} as const;

void test("world-map paths and corners match Python for ship and on foot", () => {
  for (const item of world.findPath) {
    const cells = decodeCells(world.cells[item.cells] ?? assert.fail("missing cells"));
    const path = findPath(cells, item.goal, item.byShip);
    assert.deepEqual(
      path,
      item.path,
      `${item.cells} to ${item.goal.join(",")} byShip=${String(item.byShip)}`,
    );
    assert.deepEqual(path === null ? null : corners(path), item.corners);
  }
});

void test("pathToward and the flying rule match Python", () => {
  for (const item of world.pathToward) {
    const cells = decodeCells(world.cells[item.cells] ?? assert.fail("missing cells"));
    const path = pathToward(cells, item.goal, RULES[item.rule]);
    assert.deepEqual(path, item.path, `${item.cells} to ${item.goal.join(",")} ${item.rule}`);
    assert.deepEqual(corners(path), item.corners);
  }
});

void test("hasTerrain tells world maps from indoor grids", () => {
  for (const [name, expected] of Object.entries(world.hasTerrain)) {
    const cells = decodeCells(world.cells[name] ?? assert.fail("missing cells"));
    assert.equal(hasTerrain(cells), expected, name);
  }
});

void test("a ship path crosses the sea and walking cannot", () => {
  const cells: CellGrid = {
    origin: [0, 0],
    center: [1, 1],
    attr: [
      [19, 19, 19, 19, 19],
      [19, 16, 16, 16, 19],
      [19, 19, 19, 16, 19],
      [3, 3, 3, 16, 3],
    ],
  };
  const path = findPath(cells, [3, 3], true);
  assert.deepEqual(path, [
    [1, 1],
    [2, 1],
    [3, 1],
    [3, 2],
    [3, 3],
  ]);
  assert.deepEqual(corners(path), [
    [3, 1],
    [3, 3],
  ]);
  // The goal may be a shore cell the ship cannot enter; on foot the sea blocks.
  assert.equal(findPath(cells, [4, 3], true)?.at(-1)?.[0], 4);
  assert.equal(findPath(cells, [0, 3], false), null);
});

void test("pathToward stops at the nearest reachable cell", () => {
  const cells: CellGrid = { origin: [0, 0], center: [0, 0], attr: [[16, 16, 16, 19, 3]] };
  assert.deepEqual(pathToward(cells, [4, 0], terrainRule(true)), [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
  assert.equal(pathToward(cells, [2, 0], terrainRule(true)).at(-1)?.join(","), "2,0");
});

void test("indoor grids merge heights and mark stairs", () => {
  const collision = {
    playerCell: [0, 2],
    layers: [
      { name: "BottomCollision", rows: ["111", "111", "000"] },
      { name: "GroundCollision", rows: ["110", "113", "111"] },
    ],
  };
  const grid = indoorGrid(collision, []);
  assert.ok(grid);
  assert.deepEqual(grid.attr, [
    [1, 1, 0],
    [1, 1, 0],
    [0, 0, 0],
  ]);
  assert.deepEqual([...(grid.stairs ?? [])].sort(), ["2,1"]);
  assert.deepEqual(pathToward(grid, [2, 0], floorRule), [
    [0, 2],
    [1, 2],
    [2, 2],
    [2, 1],
    [2, 0],
  ]);
});

void test("stairs are climbed up or down only", () => {
  const cells: CellGrid = {
    origin: [0, 0],
    center: [0, 1],
    attr: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    stairs: new Set([cellKey(1, 1)]),
  };
  const around = pathToward(cells, [2, 1], floorRule);
  assert.ok(!around.some((cell) => cell[0] === 1 && cell[1] === 1));
  assert.deepEqual(around.at(-1), [2, 1]);
  assert.deepEqual(pathToward({ ...cells, center: [1, 2] }, [1, 0], floorRule), [
    [1, 2],
    [1, 1],
    [1, 0],
  ]);
});

void test("a blocked step closes that step, not the cell", () => {
  const cells: CellGrid = {
    origin: [0, 0],
    center: [0, 1],
    attr: [
      [1, 1, 1],
      [0, 0, 0],
      [0, 0, 1],
    ],
  };
  assert.deepEqual(pathToward(cells, [2, 1], floorRule), [
    [0, 1],
    [1, 1],
    [2, 1],
  ]);
  const cut = new Set([edgeKey([1, 1], [2, 1])]);
  const openCells: CellGrid = {
    ...cells,
    attr: [
      [1, 1, 1],
      [0, 0, 0],
      [0, 0, 0],
    ],
  };
  assert.deepEqual(pathToward(openCells, [2, 1], floorRule, cut), [
    [0, 1],
    [1, 1],
    [1, 2],
    [2, 2],
    [2, 1],
  ]);
});

void test("indoor fixture cases match Python paths", () => {
  for (const item of indoor.cases) {
    const grid = indoorGrid(item.collision, item.blocked);
    assert.ok(grid, item.name);
    assert.deepEqual(canonicalCells(grid), item.grid, item.name);
    for (const path of item.paths) {
      assert.deepEqual(pathToward(grid, path.goal, floorRule), path.path, item.name);
    }
  }
  const carwen = indoorGrid(indoor.carwen.collision, []);
  assert.ok(carwen);
  assert.deepEqual(canonicalCells(carwen), indoor.carwen.grid);
  assert.deepEqual(pathToward(carwen, [2, 0], floorRule), indoor.carwen.path);
});

void test("layered paths change height only by stairs", () => {
  const collision = {
    playerCell: [0, 2],
    searchLayer: 0,
    layers: [
      { name: "BottomCollision", rows: ["111", "111", "000"] },
      { name: "GroundCollision", rows: ["000", "013", "111"] },
    ],
  };
  const grid = layeredGrid(collision, []);
  assert.ok(grid);
  assert.equal(grid.z, 0);
  assert.deepEqual([...grid.heights.keys()], [0, 1]);
  const path = layeredPath(grid, [0, 0]);
  assert.deepEqual(path, [
    [0, 2],
    [1, 2],
    [2, 2],
    [2, 1],
    [2, 0],
    [1, 0],
    [0, 0],
  ]);
  assert.ok(!path.some((cell) => cell[0] === 0 && cell[1] === 1));
  const noStairs = {
    ...collision,
    layers: [
      { name: "BottomCollision", rows: ["111", "111", "000"] },
      { name: "GroundCollision", rows: ["000", "011", "111"] },
    ],
  };
  assert.deepEqual(
    layeredPath(layeredGrid(noStairs, []) ?? assert.fail("grid"), [0, 0]).at(-1),
    [0, 2],
  );
});

void test("layered fixture grids, paths and views match Python", () => {
  for (const item of layered.cases) {
    const grid = layeredGrid(item.collision, item.blocked);
    assert.ok(grid, item.name);
    assert.deepEqual(canonicalLayered(grid), item.grid, item.name);
    for (const path of item.paths) {
      assert.deepEqual(layeredPath(grid, path.goal), path.path, item.name);
    }
    if (item.view) assert.deepEqual(layeredView(grid), item.view, item.name);
  }
  const cutGrid = layeredGrid(layered.cut.collision, []);
  assert.ok(cutGrid);
  assert.deepEqual(layeredPath(cutGrid, [0, 0]), layered.cut.path);
  const cut = new Set([edgeKey([1, 2], [2, 2])]);
  assert.deepEqual(layeredPath(cutGrid, [0, 0], cut), layered.cut.withCut);
  assert.deepEqual([...cutGrid.heights.keys()].sort(), layered.gridKeys);
});

void test("renderCells labels the columns and rows", () => {
  for (const item of cellsFixture.cases) {
    assert.equal(renderCells(decodeCells(item.cells)), item.text);
  }
  const grid = renderCells({
    origin: [9, 4],
    center: [10, 5],
    attr: [
      [0, 1, 0],
      [3, 7, null],
    ],
  });
  assert.deepEqual(grid.split("\n"), ["      9 10 11", "   4  0  1  0", "   5  3  @  ?"]);
});

void test("terrainRule lets the drake cross everything but mountains", () => {
  const fly = terrainRule(false, true);
  const values: CellValue[] = [16, 19, 27, 3, null];
  assert.deepEqual(
    values.map((value) => fly(value)),
    [true, false, false, true, false],
  );
  assert.equal(cellKey(1, 2), "1,2");
  const path: Cell[] = [
    [1, 1],
    [2, 1],
    [3, 1],
  ];
  assert.deepEqual(corners(path), [[3, 1]]);
});

void test("a stair column joining one height is crossed sideways only when asked", () => {
  // 10-27, Fire-Powered Ship 261: 「=」 columns walled in above and below joined two parts of
  // one floor, and the strict rule cut off four of the room's nine exits.
  const collision = {
    playerCell: [0, 1],
    searchLayer: 0,
    layers: [{ name: "GroundCollision", rows: ["11111", "00300", "11111"] }],
  };
  const grid = layeredGrid(collision, []);
  assert.ok(grid);
  assert.deepEqual(layeredPath(grid, [4, 1]).at(-1), [1, 1], "strict: stops before the stairs");
  assert.deepEqual(layeredPath(grid, [4, 1], new Set(), true), [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 1],
  ]);
});

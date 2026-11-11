/**
 * Task 72: the Fire-Powered Ship's map 252 recording (11-09). The party enters at (9,12), a
 * GotoMap/PointIn door cell; `go` must plan from there to the other exit at (9,3) instead of
 * calling the two regions disconnected. Unreadable map data must not refuse the walk either.
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
import type { Json } from "../src/engine/values.ts";
import { canReach, plan } from "../src/engine/skills/move.ts";
import type { MoveState } from "../src/engine/skills/move.ts";
import { detourToCell } from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

interface Fixture {
  readonly pos: { readonly map: number; readonly cell: Cell };
  readonly cells: Json;
  readonly entities: { readonly entities: readonly Json[] };
  readonly collision: {
    readonly searchLayer: number;
    readonly playerCell: Cell;
    readonly layers: readonly {
      readonly name: string;
      readonly rows: string[];
    }[];
  };
}

const map252 = JSON.parse(
  await readFile(
    join(import.meta.dirname, "fixtures", "nav", "map252-firepowered-ship.json"),
    "utf8",
  ),
) as Fixture;

const MAP = map252.pos.map;
const START = map252.pos.cell;
const GOAL: Cell = [9, 3];
const NO_MOVES: MoveState = { drake: null };

function collisionAt(cell: Cell, rows?: readonly string[]): Json {
  const layers = map252.collision.layers.map((layer, index) => ({
    ...layer,
    rows: index === 0 && rows !== undefined ? rows : layer.rows,
  }));
  return {
    ...map252.collision,
    playerCell: [cell[0], cell[1]],
    layers,
  };
}

/** The recording with the party at `here`; `rows` replaces the ground floor when given. */
function shipPilot(here: () => Cell, rows?: readonly string[]): FakePilot {
  const pilot = new FakePilot();
  const position = (): Reply => ({
    pos: {
      map: MAP,
      area: 26,
      areaType: 1,
      areaText: "火力船",
      state: "Player",
      cell: [here()[0], here()[1]],
      dir: "Down",
      moving: false,
      dialog: false,
      battle: false,
      saves: 11,
    },
  });
  pilot.on("pos", position);
  pilot.on("cells", (fields) => ({
    cells: {
      ...map252.cells,
      center: [here()[0], here()[1]],
      at: fields.at ?? here(),
    },
  }));
  pilot.on("collision", () => ({ collision: collisionAt(here(), rows) }));
  pilot.on("entities", (fields) => {
    const found = map252.entities.entities.filter(
      (entity) => (entity as { kind?: string }).kind === fields.kind,
    );
    return { entities: { total: found.length, entities: found } };
  });
  pilot.on("route", { route: {} });
  pilot.onQuery("sample", { sample: { field: { moveState: "Walk" } } });
  return pilot;
}

/** The same recording, but the door cell the party stands on is a wall in the collision data. */
function wallAtStart(): string[] {
  return (
    map252.collision.layers[0]?.rows.map((row, y) => {
      if (y !== START[1]) return row;
      return row.slice(0, START[0]) + "1" + row.slice(START[0] + 1);
    }) ?? []
  );
}

void test("map 252's door cell reaches the other exit at (9,3)", async () => {
  const pilot = shipPilot(() => START);
  const [, path] = await plan(pilot, GOAL, false, new Set(), NO_MOVES, MAP);
  assert.deepEqual(path[0], START);
  assert.deepEqual(path.at(-1), GOAL);
  assert.equal(await canReach(pilot, GOAL, NO_MOVES, MAP), true);
});

void test("a start cell the collision data calls a wall is still walkable", async () => {
  const rows = wallAtStart();
  assert.equal(rows[START[1]]?.[START[0]], "1");
  const pilot = shipPilot(() => START, rows);
  assert.equal(await canReach(pilot, GOAL, NO_MOVES, MAP), true);
  const [, path] = await plan(pilot, GOAL, false, new Set(), NO_MOVES, MAP);
  assert.deepEqual(path.at(-1), GOAL);
});

void test("detour uses the party's cell over a stale collision playerCell", async () => {
  const pilot = shipPilot(() => START);
  // The collision reply still names the cell from before the map change; pos is current.
  pilot.on("collision", () => ({ collision: collisionAt([0, 0]) }));
  const text = await detourToCell(pilot, { atlas: new Atlas(), moveState: NO_MOVES }, GOAL);
  assert.equal(text, null);
});

void test("go from map 252's (9,12) plans and walks to (9,3)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-map252-"));
  try {
    const game = calmGame(
      await Game.create({
        laptop: LAPTOP,
        game: "ff5",
        saveSlot: 20,
        atlasFile: join(directory, "atlas.json"),
        tacticsFile: join(directory, "tactics.json"),
        elementsFile: join(directory, "elements.json"),
        backlogFile: join(directory, "backlog-ff5.jsonl"),
        incidentsFile: join(directory, "incidents-ff5.jsonl"),
        incidentsStateFile: join(directory, "incidents-state-ff5.json"),
        bestiarySaveFile: join(directory, "bestiary-save-ff5.json"),
      }),
    );
    const world = { map: MAP, cell: START };
    const pilot = playablePilot(world);
    pilot.on("collision", () => ({ collision: collisionAt(world.cell) }));
    pilot.on("entities", (fields) => {
      const found = map252.entities.entities.filter(
        (entity) => (entity as { kind?: string }).kind === fields.kind,
      );
      return { entities: { total: found.length, entities: found } };
    });
    pilot.on("walkpath", (fields) => {
      const path = fields.path as Cell[];
      const last = path[path.length - 1];
      assert.ok(last);
      world.cell = [last[0], last[1]];
      return {
        ok: true,
        reason: "arrived",
        pos: { map: MAP, cell: world.cell },
      };
    });
    const result = await game.run("go", { to: [GOAL[0], GOAL[1]] }, pilot);
    assert.deepEqual(world.cell, GOAL);
    assert.match(result, /到达 \(9, 3\)/);
    assert.doesNotMatch(result, /不连通/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an old blocked (9,13)→(9,14) record is re-walked and forgotten when it goes through", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-map252-"));
  try {
    const atlasFile = join(directory, "atlas.json");
    await writeFile(
      atlasFile,
      JSON.stringify({
        [MAP]: {
          name: "火力船",
          exits: [],
          chests: [],
          links: [{ from: [9, 13], to: [9, 14], how: "走不过去" }],
        },
      }),
      "utf8",
    );
    const game = await gameWithAtlas(directory, atlasFile);
    const world = { map: MAP, cell: START };
    const pilot = fieldPilot(world);
    const paths: Cell[][] = [];
    pilot.on("walkpath", (fields) => {
      const path = fields.path as Cell[];
      paths.push(path);
      const last = path[path.length - 1];
      assert.ok(last);
      world.cell = [last[0], last[1]];
      return {
        ok: true,
        reason: "arrived",
        pos: { map: MAP, cell: world.cell },
      };
    });
    const result = await game.run("go", { to: [GOAL[0], GOAL[1]] }, pilot);
    assert.match(result, /到达 \(9, 3\)/);
    const firstPath = paths[0];
    assert.ok(firstPath);
    assert.ok(
      firstPath.some(
        (cell, index) =>
          cell[0] === 9 &&
          cell[1] === 13 &&
          firstPath[index + 1]?.[0] === 9 &&
          firstPath[index + 1]?.[1] === 14,
      ),
      "the untrusted record's step was walked",
    );
    assert.deepEqual((await savedAtlas(atlasFile))[String(MAP)]?.links ?? [], []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a blocked old record is counted and this walk still stops", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-map252-"));
  try {
    const atlasFile = join(directory, "atlas.json");
    await writeFile(
      atlasFile,
      JSON.stringify({
        [MAP]: {
          name: "火力船",
          exits: [],
          chests: [],
          links: [{ from: [9, 13], to: [9, 14], how: "走不过去" }],
        },
      }),
      "utf8",
    );
    const game = await gameWithAtlas(directory, atlasFile);
    const world = { map: MAP, cell: START };
    const pilot = fieldPilot(world);
    pilot.on("walkpath", (fields) => {
      const path = fields.path as Cell[];
      const index = path.findIndex((cell) => cell[0] === 9 && cell[1] === 13);
      assert.ok(index >= 0);
      world.cell = [9, 13];
      return {
        ok: false,
        reason: "blocked",
        index,
        pos: { map: MAP, cell: world.cell },
        next: [9, 14],
      };
    });
    const result = await game.run("go", { to: [GOAL[0], GOAL[1]] }, pilot);
    assert.match(result, /走不过去/);
    assert.doesNotMatch(result, /到达 \(9, 3\)/);
    const link = (await savedAtlas(atlasFile))[String(MAP)]?.links?.[0];
    assert.ok(link);
    assert.equal(link.count, 2);
    assert.equal(typeof link.at, "string");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a blocked record counted 3 times is a wall and is not re-walked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-map252-"));
  try {
    const atlasFile = join(directory, "atlas.json");
    await writeFile(
      atlasFile,
      JSON.stringify({
        [MAP]: {
          name: "火力船",
          exits: [],
          chests: [],
          links: [
            {
              from: [9, 13],
              to: [9, 14],
              how: "走不过去",
              at: "2026-11-09T00:00:00Z",
              count: 3,
            },
          ],
        },
      }),
      "utf8",
    );
    const game = await gameWithAtlas(directory, atlasFile);
    const world = { map: MAP, cell: START };
    const pilot = fieldPilot(world);
    let walks = 0;
    pilot.on("walkpath", () => {
      walks += 1;
      return { ok: true, reason: "arrived", pos: { map: MAP, cell: GOAL } };
    });
    const result = await game.run("go", { to: [GOAL[0], GOAL[1]] }, pilot);
    assert.doesNotMatch(result, /到达 \(9, 3\)/);
    assert.equal(walks, 0, "a trusted wall was not walked into again");
    assert.equal((await savedAtlas(atlasFile))[String(MAP)]?.links?.[0]?.count, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("canReach says maybe when the collision reply cannot be read", async () => {
  const pilot = shipPilot(() => START);
  pilot.on("collision", () => {
    throw new Error("读不到碰撞");
  });
  assert.equal(await canReach(pilot, GOAL, NO_MOVES, MAP), true);
});

void test("canReach says maybe when the layered grid cannot be built", async () => {
  const pilot = shipPilot(() => START);
  pilot.on("collision", () => ({ collision: { layers: [] } }));
  assert.equal(await canReach(pilot, GOAL, NO_MOVES, MAP), true);
});

void test("canReach says maybe when the start is outside the collision grid", async () => {
  const outside: Cell = [40, 40];
  const pilot = shipPilot(() => outside);
  assert.equal(await canReach(pilot, GOAL, NO_MOVES, MAP), true);
});

void test("canReach still says no when the grid really separates the goal", async () => {
  const rows = ["11001", "11001", "11001", "11001", "11001"];
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { map: MAP, state: "Player", cell: [0, 0] } });
  pilot.on("cells", {
    cells: {
      center: [0, 0],
      at: [0, 0],
      origin: [0, 0],
      attr: [[0, 0, 0, 0, 0]],
    },
  });
  pilot.on("collision", {
    collision: {
      searchLayer: 1,
      playerCell: [0, 0],
      layers: [{ name: "GroundCollision", rows }],
    },
  });
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  assert.equal(await canReach(pilot, [4, 0], NO_MOVES, MAP), false);
});

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

/** A Game whose atlas is the file the test wrote, with the post-tool reads kept quiet. */
async function gameWithAtlas(directory: string, atlasFile: string): Promise<Game> {
  return calmGame(
    await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile,
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
      backlogFile: join(directory, "backlog-ff5.jsonl"),
      incidentsFile: join(directory, "incidents-ff5.jsonl"),
      incidentsStateFile: join(directory, "incidents-state-ff5.json"),
      bestiarySaveFile: join(directory, "bestiary-save-ff5.json"),
    }),
  );
}

/** The map 252 recording with collision and entities, for a `go` from `world.cell`. */
function fieldPilot(world: World): FakePilot {
  const pilot = playablePilot(world);
  pilot.on("collision", () => ({ collision: collisionAt(world.cell) }));
  pilot.on("entities", (fields) => {
    const found = map252.entities.entities.filter(
      (entity) => (entity as { kind?: string }).kind === fields.kind,
    );
    return { entities: { total: found.length, entities: found } };
  });
  return pilot;
}

type AtlasFile = Record<string, { readonly links?: readonly Json[] }>;

async function savedAtlas(path: string): Promise<AtlasFile> {
  return JSON.parse(await readFile(path, "utf8")) as AtlasFile;
}

interface World {
  map: number;
  cell: Cell;
}

/** The post-tool reads of Game.run are not under test; keep them cheap and deterministic. */
function calmGame(game: Game): Game {
  game.settle = () => Promise.resolve("");
  game.observe = () => Promise.resolve("状态好");
  return game;
}

/** A field pilot whose post-tool reads (chart, completion, bag) can all answer. */
function playablePilot(world: World): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => ({
    pos: {
      map: world.map,
      area: 26,
      areaType: 1,
      areaText: "火力船",
      state: "Player",
      cell: world.cell,
      saves: 11,
    },
  }));
  pilot.on("cells", (fields) => ({
    cells: { ...map252.cells, center: world.cell, at: fields.at ?? world.cell },
  }));
  pilot.on("route", { route: {} });
  pilot.onQuery("items", { items: { normal: [], important: [] } });
  pilot.onQuery("sample", { sample: { field: { moveState: "Walk" } } });
  pilot.onQuery("achievements", {
    achievements: {
      defs: [],
      save: {
        playTime: 1,
        saveCount: 1,
        chests: 0,
        hiddenItems: 0,
        treasure: [],
        members: [],
        flags: {},
      },
      bestiary: null,
    },
  });
  pilot.onQuery("encounters", {
    encounters: {
      monsterSet: null,
      parties: [],
      region: null,
      regions: [],
      enabled: false,
    },
  });
  return pilot;
}

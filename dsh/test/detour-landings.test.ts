/**
 * Task 76: a detour entrance is judged by where it lands. The 255 fixture is split north/south
 * by its collision data; the hand-built maps around it have exits back into 255 with a landing
 * in the other block (must not be suggested) or with no landing yet (listed, but not walked).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import { detourToCell } from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

interface Entity {
  readonly kind: string;
  readonly cell: Cell;
  readonly active?: boolean;
  readonly myLayer?: number;
}

interface Collision {
  readonly searchLayer: number;
  readonly playerCell: Cell;
  readonly layers: readonly {
    readonly name: string;
    readonly rows: readonly string[];
  }[];
}

interface Fixture {
  readonly collision: Collision;
  readonly entities: { readonly entities: readonly Entity[] };
}

interface ExitDef {
  readonly cell: Cell;
  readonly to: number;
  readonly land?: Cell;
  readonly landLayer?: number;
}

interface SourceDef {
  readonly id: number;
  readonly exits: readonly ExitDef[];
}

interface World {
  map: number;
  cell: Cell;
}

const fixture = JSON.parse(
  await readFile(
    join(import.meta.dirname, "fixtures", "nav", "map255-firepowered-ship.json"),
    "utf8",
  ),
) as Fixture;

/** The exits from 255's north half that reach each hand-built map. */
const SOURCE_ENTRIES: Readonly<Record<number, Cell>> = {
  300: [6, 8],
  301: [7, 8],
};

function openRows(size: number): string[] {
  return Array.from({ length: size }, () => "0".repeat(size));
}

function atlasFor(sources: readonly SourceDef[]): Atlas {
  const atlas = new Atlas();
  atlas.maps.set("255", {
    name: "火力船 甲板",
    exits: sources.map((source) => ({
      cell: SOURCE_ENTRIES[source.id] ?? [1, 1],
      to: source.id,
      name: "GotoMap",
    })),
    chests: [],
  });
  for (const source of sources) {
    atlas.maps.set(String(source.id), {
      name: `小图 ${source.id}`,
      exits: source.exits.map((exit) => ({
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

async function cacheFor(): Promise<{ dir: string; store: CollisionStore }> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-detour-landings-"));
  const store = await CollisionStore.load(dir);
  await store.remember(255, fixture.collision);
  return { dir, store };
}

function position(world: World): Reply {
  return {
    pos: {
      state: "Player",
      map: world.map,
      cell: [world.cell[0], world.cell[1]],
    },
  };
}

function collisionFor(world: World): Collision {
  if (world.map === 255) {
    return { ...fixture.collision, playerCell: [world.cell[0], world.cell[1]] };
  }
  return {
    searchLayer: 1,
    playerCell: [world.cell[0], world.cell[1]],
    layers: [{ name: "GroundCollision", rows: openRows(40) }],
  };
}

function entitiesFor(world: World, kind: unknown): readonly Entity[] {
  if (world.map !== 255 || kind !== "PointIn") return [];
  return fixture.entities.entities.filter(
    (entity) => entity.kind === "PointIn" && entity.active !== false,
  );
}

function harness(): { pilot: FakePilot; world: World; walks: () => number } {
  const world: World = { map: 255, cell: [6, 7] };
  let walks = 0;
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
    entities: { total: 0, entities: entitiesFor(world, fields.kind) },
  }));
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    walks += 1;
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target" };
    }
    world.cell = [to[0], to[1]];
    if (world.map === 255) {
      const target = Object.entries(SOURCE_ENTRIES).find(
        ([, cell]) => cell[0] === world.cell[0] && cell[1] === world.cell[1],
      );
      if (target !== undefined) {
        world.map = Number(target[0]);
        world.cell = [1, 1];
      }
    }
    return { ok: true, ...position(world) };
  });
  pilot.on("wait", { ok: true });
  pilot.onQuery("sample", { sample: { field: { moveState: "Walk" } } });
  return { pilot, world, walks: () => walks };
}

void test("an entrance landing in another block is not suggested or walked", async () => {
  const { dir, store } = await cacheFor();
  try {
    // Map 300's exit back into 255 lands at (6,7), the north block the party is already in.
    const atlas = atlasFor([
      {
        id: 300,
        exits: [{ cell: [1, 1], to: 255, land: [6, 7], landLayer: 2 }],
      },
    ]);
    const { pilot, world, walks } = harness();
    const text = await detourToCell(
      pilot,
      { atlas, moveState: { drake: null }, collisions: store },
      [6, 26],
    );
    assert.ok(text !== null);
    assert.match(text, /能走到目标的落点有/, "the south landings should still be listed");
    assert.doesNotMatch(text, /地图 300/, "its landing is in the wrong block");
    assert.match(text, /按地图记录，没有能到这一块的入口/);
    assert.equal(walks(), 0, "a wrong-block landing must not be walked");
    assert.deepEqual(world.cell, [6, 7]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("an entrance with no recorded landing is listed but not walked", async () => {
  const { dir, store } = await cacheFor();
  try {
    const atlas = atlasFor([
      {
        id: 300,
        exits: [{ cell: [1, 1], to: 255, land: [6, 7], landLayer: 2 }],
      },
      { id: 301, exits: [{ cell: [1, 1], to: 255 }] },
    ]);
    const { pilot, world, walks } = harness();
    const text = await detourToCell(
      pilot,
      { atlas, moveState: { drake: null }, collisions: store },
      [6, 26],
    );
    assert.ok(text !== null);
    assert.doesNotMatch(text, /地图 300/);
    assert.match(text, /地图 301/);
    assert.match(text, /落点没记过，可以试/);
    assert.doesNotMatch(text, /可以从/, "no entrance is walked automatically");
    assert.equal(walks(), 0, "an unrecorded landing must not be walked");
    assert.deepEqual(world.cell, [6, 7]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the fixture's collision really splits 255 north from south", async () => {
  const { dir, store } = await cacheFor();
  try {
    const atlas = atlasFor([]);
    const regions = RegionIndex.create(atlas, store);
    const region = regions.region(255);
    assert.ok(region !== undefined);
    const north = region.blocksAt([6, 7], 2);
    const south = region.blocksAt([6, 26], 2);
    assert.ok(north.length > 0 && south.length > 0);
    assert.notDeepEqual(
      north.map((block) => block.id),
      south.map((block) => block.id),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

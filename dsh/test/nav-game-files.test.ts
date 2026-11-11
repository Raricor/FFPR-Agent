/**
 * Task 123: unvisited maps get their collision and exits from the game files' export. The
 * small fixtures imitate `../.deps/knowledge/<game>/files/maps/<id>.json`; the two real
 * routes only run when the export is present on this machine.
 */

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { DEPS } from "../src/engine/paths.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import { mapExits, mapPath } from "../src/engine/skills/travel.ts";

const REAL_MAPS = join(DEPS, "knowledge", "ff5", "files", "maps");
const REAL_ATLAS = join(DEPS, "ds", "atlas-ff5.json");
const HAS_REAL_MAPS = await exists(REAL_MAPS);

async function realAtlas(): Promise<Atlas> {
  return (await exists(REAL_ATLAS)) ? await Atlas.load(REAL_ATLAS) : new Atlas();
}

/** The world fields need the task 123 export; an older maps/1.json must not fail the suite. */
async function hasWorldExport(): Promise<boolean> {
  if (!HAS_REAL_MAPS) return false;
  try {
    const parsed = JSON.parse(await readFile(join(REAL_MAPS, "1.json"), "utf8")) as {
      world?: unknown;
    };
    return parsed.world !== undefined;
  } catch {
    return false;
  }
}

const HAS_REAL_WORLD = await hasWorldExport();

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface FileLayer {
  readonly name: string;
  readonly rows: readonly string[];
}

interface FileValueLayer {
  readonly name: string;
  readonly cells: readonly (readonly [number, number, number])[];
}

interface FileExit {
  readonly cell: readonly [number, number];
  readonly toMap: number;
  readonly toPoint?: number;
}

interface FileWorld {
  readonly width: number;
  readonly height: number;
  readonly modes: Readonly<Record<string, readonly string[]>>;
  readonly points: readonly {
    readonly point: number;
    readonly cell: readonly [number, number];
    readonly name?: string;
  }[];
}

async function writeMap(
  dir: string,
  id: number,
  body: {
    readonly collision?: readonly FileLayer[];
    readonly damage?: readonly FileValueLayer[];
    readonly hiddenPassages?: readonly FileValueLayer[];
    readonly exits?: readonly FileExit[];
    readonly world?: FileWorld;
    readonly worldExits?: readonly { readonly to: number; readonly point: number }[];
  },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: `map ${id}`,
      collision: body.collision ?? [],
      damage: body.damage ?? [],
      hiddenPassages: body.hiddenPassages ?? [],
      exits: body.exits ?? [],
      ...(body.world === undefined ? {} : { world: body.world }),
      ...(body.worldExits === undefined ? {} : { worldExits: body.worldExits }),
    }),
    "utf8",
  );
}

function openRows(size: number): string[] {
  return Array.from({ length: size }, () => "0".repeat(size));
}

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

void test("a map without a cache gets collision, hidden passages and damage from the files", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  const cache = await tempDir("ffpr-cache-");
  try {
    await writeMap(game, 50, {
      collision: [{ name: "GroundCollision", rows: ["10000", "00000", "00000"] }],
      hiddenPassages: [{ name: "GroundHiddenPassage", cells: [[0, 0, 1]] }],
      damage: [{ name: "GroundDamage", cells: [[1, 2, 2]] }],
    });
    const store = await CollisionStore.load(cache, undefined, game);
    assert.equal(store.ids().length, 0, "nothing was cached");
    assert.equal(store.has(50), true);
    const snapshot = store.get(50);
    assert.ok(snapshot !== undefined);
    assert.equal(snapshot.searchLayer, 1);
    assert.deepEqual(snapshot.layers[0]?.rows, ["00000", "00000", "00000"]);
    assert.deepEqual(store.hiddenPassages(50), [[0, 0]]);
    assert.deepEqual(store.dangers(50), [{ cell: [1, 2], layer: 1 }]);

    // A live reply is the newest truth and replaces the file fallback.
    await store.remember(50, {
      searchLayer: 2,
      layers: [{ name: "UpperCollision", rows: ["111", "111", "111"] }],
    });
    assert.equal(store.get(50)?.layers[0]?.name, "UpperCollision");
  } finally {
    await rm(game, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

void test("mapPath crosses maps that exist only in the game files and uses their landings", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  try {
    await writeMap(game, 40, {
      collision: [{ name: "GroundCollision", rows: openRows(6) }],
      exits: [
        { cell: [4, 4], toMap: 41, toPoint: 1 },
        { cell: [5, 5], toMap: 41, toPoint: 1 },
      ],
    });
    await writeMap(game, 41, {
      collision: [{ name: "GroundCollision", rows: openRows(6) }],
      exits: [
        { cell: [0, 0], toMap: 40, toPoint: 1 },
        { cell: [4, 4], toMap: 42, toPoint: 1 },
      ],
    });
    await writeMap(game, 42, { collision: [{ name: "GroundCollision", rows: openRows(6) }] });
    const store = await CollisionStore.load(undefined, undefined, game);
    const atlas = new Atlas();
    atlas.maps.set("30", {
      name: "入口",
      exits: [{ cell: [2, 2], to: 40, name: "GotoMap" }],
      chests: [],
    });

    const exits = mapExits(atlas, 40, store);
    assert.deepEqual(
      exits.map((exit) => [exit.cell, exit.to]),
      [
        [[4, 4], 41],
        [[5, 5], 41],
      ],
    );
    assert.deepEqual(exits[0]?.land, [0, 0], "point_id 1 finds the return point on 41");

    const path = mapPath(atlas, 30, 42, new Set(), true, { collisions: store });
    assert.ok(path !== null);
    assert.deepEqual(
      path.map((hop) => [hop.from, hop.to]),
      [
        [30, 40],
        [40, 41],
        [41, 42],
      ],
    );
    // Without the game files the same three maps are not in the atlas and cannot be planned.
    assert.equal(mapPath(atlas, 30, 42, new Set(), true), null);
  } finally {
    await rm(game, { recursive: true, force: true });
  }
});

void test("a world map splits into vehicle blocks, so a mountain wall blocks walking", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  try {
    const open = "1111111111";
    const split = "1110000111";
    await writeMap(game, 100, {
      collision: [{ name: "GroundCollision", rows: ["000", "000", "000"] }],
      exits: [{ cell: [0, 0], toMap: 1 }],
      worldExits: [{ to: 1, point: 1 }],
    });
    await writeMap(game, 1, {
      world: {
        width: 10,
        height: 5,
        modes: {
          walk: [split, split, split, split, split],
          ship: [open, open, open, open, open],
        },
        points: [{ point: 1, cell: [1, 1] }],
      },
      exits: [{ cell: [8, 1], toMap: 101 }],
    });
    const store = await CollisionStore.load(undefined, undefined, game);
    assert.equal(store.hasWorld(1), true);
    assert.deepEqual(store.worldPoint(1, 1), [1, 1]);
    assert.equal(
      mapPath(new Atlas(), 100, 101, new Set(), true, {
        collisions: store,
        worldModes: ["walk"],
      }),
      null,
      "walking cannot cross the mountain gap",
    );
    const byShip = mapPath(new Atlas(), 100, 101, new Set(), true, {
      collisions: store,
      worldModes: ["ship"],
    });
    assert.ok(byShip !== null, "the ship grid crosses the same map");
    const transfer = mapPath(new Atlas(), 100, 101, new Set(), true, {
      collisions: store,
      worldModes: ["walk", "ship"],
    });
    assert.ok(transfer !== null, "the ship can be boarded from the walking block");
  } finally {
    await rm(game, { recursive: true, force: true });
  }
});

void test("an observed exit at a cell wins over the game file's exit there", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  try {
    await writeMap(game, 40, {
      collision: [{ name: "GroundCollision", rows: openRows(6) }],
      exits: [
        { cell: [4, 4], toMap: 41, toPoint: 1 },
        { cell: [5, 5], toMap: 41, toPoint: 1 },
      ],
    });
    await writeMap(game, 41, { collision: [{ name: "GroundCollision", rows: openRows(6) }] });
    const store = await CollisionStore.load(undefined, undefined, game);
    const atlas = new Atlas();
    atlas.maps.set("40", {
      name: "走过的图",
      exits: [{ cell: [4, 4], to: 99, name: "走出来的" }],
      chests: [],
    });
    assert.deepEqual(
      mapExits(atlas, 40, store).map((exit) => [exit.cell, exit.to]),
      [
        [[4, 4], 99],
        [[5, 5], 41],
      ],
    );
  } finally {
    await rm(game, { recursive: true, force: true });
  }
});

void test("a damage floor splits the safe block but joins the risky one", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  try {
    await writeMap(game, 60, {
      collision: [{ name: "GroundCollision", rows: ["111", "000", "111"] }],
      damage: [{ name: "GroundDamage", cells: [[1, 1, 2]] }],
    });
    const store = await CollisionStore.load(undefined, undefined, game);
    const regions = RegionIndex.create(new Atlas(), store);
    const region = regions.region(60);
    assert.ok(region !== undefined);
    const from = region.blocksAt([0, 1], 1);
    assert.ok(from.length > 0);
    assert.deepEqual(region.reachable(from, [2, 1], 1), { ok: true, risky: true });
  } finally {
    await rm(game, { recursive: true, force: true });
  }
});

void test("a live collision wall is opened by the game files' hidden passage", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  const cache = await tempDir("ffpr-cache-");
  try {
    const walls = ["000", "111", "000"];
    await writeMap(game, 70, {
      collision: [{ name: "GroundCollision", rows: walls }],
      hiddenPassages: [{ name: "GroundHiddenPassage", cells: [[1, 1, 1]] }],
    });
    const store = await CollisionStore.load(cache, undefined, game);
    // The live reply is authoritative and still says wall at (1,1).
    await store.remember(70, {
      searchLayer: 1,
      layers: [{ name: "GroundCollision", rows: walls }],
    });
    assert.deepEqual(store.get(70)?.layers[0]?.rows, walls, "the live rows stay as read");
    assert.deepEqual(store.hiddenPassages(70), [[1, 1]]);
    const regions = RegionIndex.create(new Atlas(), store);
    const region = regions.region(70);
    assert.ok(region !== undefined);
    const from = region.blocksAt([0, 0], 1);
    assert.ok(from.length > 0);
    assert.deepEqual(region.reachable(from, [2, 2], 1), {
      ok: true,
      risky: false,
      passage: true,
    });
  } finally {
    await rm(game, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

void test("a live collision still takes its damage floors from the game files", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  const cache = await tempDir("ffpr-cache-");
  try {
    const rows = ["111", "000", "111"];
    await writeMap(game, 71, {
      collision: [{ name: "GroundCollision", rows }],
      damage: [{ name: "GroundDamage", cells: [[1, 1, 2]] }],
    });
    const store = await CollisionStore.load(cache, undefined, game);
    await store.remember(71, {
      searchLayer: 1,
      layers: [{ name: "GroundCollision", rows }],
    });
    const regions = RegionIndex.create(new Atlas(), store);
    const region = regions.region(71);
    assert.ok(region !== undefined);
    const from = region.blocksAt([0, 1], 1);
    assert.ok(from.length > 0);
    assert.deepEqual(region.reachable(from, [2, 1], 1), { ok: true, risky: true });
  } finally {
    await rm(game, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

void test(
  "the real export reaches Tule's east chest (40,13) from (45,40)",
  {
    skip: HAS_REAL_MAPS ? false : "没有游戏文件导出，跳过",
  },
  async () => {
    const store = await CollisionStore.load(undefined, undefined, REAL_MAPS);
    const regions = RegionIndex.create(await realAtlas(), store);
    const region = regions.region(30);
    assert.ok(region !== undefined, "map 30 has no region");
    const from = region.blocksAt([45, 40], 1);
    assert.ok(from.length > 0, "(45,40) is not on the ground floor");
    assert.equal(region.reachable(from, [40, 13], 1).ok, true);
  },
);

void test("an 调查后跳 link joins map 189 north to south one way only", async () => {
  const game = await tempDir("ffpr-gamefiles-");
  try {
    await writeMap(game, 189, {
      collision: [{ name: "GroundCollision", rows: ["00000", "11111", "00000", "11111", "00000"] }],
      exits: [{ cell: [2, 2], toMap: 190 }],
    });
    const store = await CollisionStore.load(undefined, undefined, game);
    const atlas = new Atlas();
    await atlas.link(189, [2, 0], [2, 2], "调查后跳");
    const regions = RegionIndex.create(atlas, store);
    const region = regions.region(189);
    assert.ok(region !== undefined);
    const north = region.blocksAt([2, 0], 1);
    const south = region.blocksAt([2, 2], 1);
    assert.ok(north.length > 0);
    assert.ok(south.length > 0);
    assert.equal(region.reachable(north, [2, 2], 1).ok, true);
    assert.equal(region.reachable(south, [2, 0], 1).ok, false);
    const path = mapPath(atlas, 189, 190, new Set(), true, {
      start: [2, 0],
      startLayer: 1,
      regions,
    });
    assert.ok(path !== null, "the south exit is reached only through the jump");
    assert.deepEqual(path[0]?.cell, [2, 2]);
  } finally {
    await rm(game, { recursive: true, force: true });
  }
});

void test(
  "the real export plans Tule (30) to Wind Shrine (202) by ship",
  {
    skip: HAS_REAL_WORLD ? false : "没有世界地图导出字段，跳过",
  },
  async () => {
    const store = await CollisionStore.load(undefined, undefined, REAL_MAPS);
    const path = mapPath(await realAtlas(), 30, 202, new Set(), true, { collisions: store });
    assert.ok(path !== null, "no route 30 → 202");
    assert.ok(
      path.some((hop) => hop.to === 1),
      `route does not use the world map: ${path.map((hop) => hop.to).join(" → ")}`,
    );
  },
);

void test(
  "the real export no longer sends Cave Entrance (191) through world 1 → 194",
  {
    skip: HAS_REAL_WORLD ? false : "没有世界地图导出字段，跳过",
  },
  async () => {
    const store = await CollisionStore.load(undefined, undefined, REAL_MAPS);
    const path = mapPath(await realAtlas(), 191, 198, new Set(), true, { collisions: store });
    assert.ok(path !== null, "no route 191 → 198");
    assert.equal(path[0]?.from, 191);
    assert.equal(path.at(-1)?.to, 198);
    assert.equal(
      path.some((hop) => hop.from === 1 && hop.to === 194),
      false,
      `the isolated world pocket is still used: ${path.map((hop) => `${hop.from}→${hop.to}`).join(" | ")}`,
    );
  },
);

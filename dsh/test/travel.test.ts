/**
 * Task 48: travel_to and explore plan over the atlas's map exits. These tests use a scripted
 * world whose `walk` changes the map on an exit cell, including a wrong destination.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { CollisionStore } from "../src/engine/regions.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { num, records } from "../src/engine/values.ts";
import {
  explore,
  findMap,
  isWorldMap,
  mapPath,
  travelToMap,
  unknownExits,
} from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

interface MapRecord {
  readonly name: string;
  readonly exits: readonly { readonly cell: Cell; readonly to: number; readonly name?: string }[];
}

function atlasOf(records: Record<number, MapRecord>): Atlas {
  const atlas = new Atlas();
  for (const [key, record] of Object.entries(records)) {
    atlas.maps.set(key, {
      name: record.name,
      exits: record.exits.map((exit) => ({ cell: exit.cell, to: exit.to, name: exit.name ?? "" })),
      chests: [],
    });
  }
  return atlas;
}

interface World {
  map: number;
  cell: Cell;
  state: string;
  /** map id → exit cell key → expected destination. */
  readonly exits: Map<number, Map<string, number>>;
  /** map id + exit cell → where the game actually takes the party. */
  readonly redirects: Map<string, number>;
  /** map id + exit cell → walk failure. */
  readonly failures: Set<string>;
  /** Arrival cell on each map. */
  readonly entries: Map<number, Cell>;
  walks: number;
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function worldFor(atlas: Atlas): World {
  const exits = new Map<number, Map<string, number>>();
  const entries = new Map<number, Cell>();
  for (const [key, entry] of atlas.maps) {
    const mapId = Number(key);
    entries.set(mapId, [5, 5]);
    const cells = new Map<string, number>();
    for (const exit of records(entry.exits)) {
      const cell = cellOf(exit.cell);
      const to = num(exit.to);
      if (cell === null || to === undefined) continue;
      cells.set(`${cell[0]},${cell[1]}`, Math.trunc(to));
    }
    exits.set(mapId, cells);
  }
  return {
    map: Number([...atlas.maps.keys()][0] ?? 30),
    cell: [5, 5],
    state: "Player",
    exits,
    redirects: new Map(),
    failures: new Set(),
    entries,
    walks: 0,
  };
}

function position(world: World): Reply {
  return { pos: { state: world.state, map: world.map, cell: world.cell } };
}

function pilotFor(world: World, onWalk?: (from: Cell, to: Cell) => void): FakePilot {
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
    collision: {
      searchLayer: 1,
      playerCell: [world.cell[0], world.cell[1]],
      layers: [{ name: "GroundCollision", rows: Array.from({ length: 20 }, () => "0".repeat(20)) }],
    },
  }));
  pilot.on("entities", () => ({ entities: { total: 0, entities: [] } }));
  pilot.on("route", { route: {} });
  // Task 56's new bridge op: these tests walk corner by corner like an older bridge.
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target" };
    }
    onWalk?.(world.cell, [to[0], to[1]]);
    const key = `${to[0]},${to[1]}`;
    if (world.failures.has(`${world.map}:${key}`)) {
      return { ok: false, error: "failed", ...position(world) };
    }
    world.cell = [to[0], to[1]];
    world.walks += 1;
    const exit = world.exits.get(world.map)?.get(key);
    if (exit !== undefined) {
      const actual = world.redirects.get(`${world.map}:${key}`) ?? exit;
      world.map = actual;
      world.cell = world.entries.get(actual) ?? [5, 5];
    }
    return { ok: true, ...position(world) };
  });
  pilot.on("wait", { ok: true });
  return pilot;
}

/** World-map terrain: every cell is grass, so the world-map planner sees a real terrain grid. */
function terrainPilot(
  world: World,
  ride: { state: string },
  onWalk?: (from: Cell, to: Cell) => void,
): FakePilot {
  const pilot = pilotFor(world, onWalk);
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [world.cell[0], world.cell[1]],
      attr: Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => 4)),
    },
  }));
  pilot.onQuery("sample", () => ({ sample: { field: { moveState: ride.state } } }));
  return pilot;
}

const SIMPLE: Record<number, MapRecord> = {
  30: {
    name: "图尔村",
    exits: [
      { cell: [1, 5], to: 31 },
      { cell: [2, 5], to: 31 },
    ],
  },
  31: { name: "运河", exits: [{ cell: [1, 5], to: 32 }] },
  32: { name: "城堡", exits: [] },
};

void test("travel_to walks A→B→C and lists both hops", async () => {
  const atlas = atlasOf(SIMPLE);
  const world = worldFor(atlas);
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 32);
  assert.equal(result.reached, true);
  assert.equal(world.map, 32);
  assert.deepEqual(
    result.hops.map((hop) => [hop.from, hop.actual]),
    [
      [30, 31],
      [31, 32],
    ],
  );
  assert.match(result.text, /走了 2 跳/);
  assert.match(result.text, /地图 30 →\(1, 5\)→ 地图 31/);
  assert.match(result.text, /地图 31 →\(1, 5\)→ 地图 32/);
  assert.match(result.text, /停:到了地图 32/);
});

void test("an elevator that changes destination is reported and replanned from there", async () => {
  const atlas = atlasOf({
    30: { name: "船", exits: [{ cell: [1, 5], to: 31 }] },
    31: { name: "电梯", exits: [{ cell: [1, 5], to: 32 }] },
    32: { name: "终点", exits: [] },
    40: { name: "别处", exits: [{ cell: [1, 5], to: 32 }] },
  });
  const world = worldFor(atlas);
  world.redirects.set("31:1,5", 40);
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 32);
  assert.equal(result.reached, true);
  assert.equal(world.map, 32);
  assert.deepEqual(
    result.hops.map((hop) => [hop.from, hop.actual]),
    [
      [30, 31],
      [31, 40],
      [40, 32],
    ],
  );
  assert.match(result.text, /这次去了地图 40，地图记录里写的是 32/);
});

void test("a failed exit is closed for this call and the next route succeeds", async () => {
  const atlas = atlasOf(SIMPLE);
  const world = worldFor(atlas);
  world.failures.add("30:1,5");
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 32);
  assert.equal(result.reached, true);
  assert.equal(result.hops[0]?.cell[0], 2);
  assert.match(result.text, /没走通的出口:地图 30 \(1, 5\) 到地图 31/);
});

void test("a transit map without completion stops the route with guardLeave's text", async () => {
  const atlas = atlasOf(SIMPLE);
  const world = worldFor(atlas);
  const result = await travelToMap(
    pilotFor(world),
    { atlas, moveState: { drake: null } },
    32,
    () => undefined,
    {
      guard: (_pilot, _goal, origin) =>
        Promise.resolve(
          origin ? null : { text: "「运河」还没完成：宝箱 1/2。要离开就带 leave_incomplete。" },
        ),
    },
  );
  assert.equal(result.reached, false);
  assert.equal(result.mapId, 31);
  assert.equal(world.map, 31);
  assert.match(result.text, /还没完成：宝箱 1\/2/);
  assert.match(result.text, /停:停在 地图 31/);
});

void test("a transit map with a backlog is let through without a second entry", async () => {
  const atlas = atlasOf(SIMPLE);
  const world = worldFor(atlas);
  let newEntries = 0;
  const result = await travelToMap(
    pilotFor(world),
    { atlas, moveState: { drake: null } },
    32,
    () => undefined,
    {
      guard: (_pilot, _goal, origin) => {
        if (origin || world.map === 31) return Promise.resolve(null);
        newEntries += 1;
        return Promise.resolve({ text: "没完成" });
      },
    },
  );
  assert.equal(result.reached, true);
  assert.equal(newEntries, 0);
});

void test("go goes through the world map and walks from where it landed", async () => {
  const atlas = atlasOf({
    30: { name: "起点", exits: [{ cell: [1, 5], to: 1 }] },
    1: { name: "世界地图", exits: [{ cell: [7, 7], to: 32 }] },
    32: { name: "终点", exits: [] },
  });
  const world = worldFor(atlas);
  world.map = 30;
  world.cell = [5, 5];
  world.entries.set(1, [20, 20]);
  let worldStart: Cell | null = null;
  const pilot = terrainPilot(world, { state: "Walk" }, (from) => {
    if (world.map === 1) worldStart ??= from;
  });
  const result = await travelToMap(pilot, { atlas, moveState: { drake: null } }, 32);
  assert.equal(result.reached, true);
  assert.equal(world.map, 32);
  assert.deepEqual(
    result.hops.map((hop) => [hop.from, hop.actual]),
    [
      [30, 1],
      [1, 32],
    ],
  );
  assert.match(result.text, /走了 2 跳/);
  assert.match(result.text, /地图 1 →\(7, 7\)→ 地图 32/);
  // The world-map leg started on the cell the game put the party on, not on a guessed one.
  assert.deepEqual(worldStart, [20, 20]);
});

void test("go from the world map walks straight to the entrance", async () => {
  const atlas = atlasOf({
    1: { name: "世界地图", exits: [{ cell: [7, 7], to: 32 }] },
    32: { name: "终点", exits: [] },
  });
  const world = worldFor(atlas);
  world.map = 1;
  world.cell = [20, 20];
  let worldStart: Cell | null = null;
  const result = await travelToMap(
    terrainPilot(world, { state: "Walk" }, (from) => {
      worldStart ??= from;
    }),
    { atlas, moveState: { drake: null } },
    32,
  );
  assert.equal(result.reached, true);
  assert.deepEqual(
    result.hops.map((hop) => [hop.from, hop.actual]),
    [[1, 32]],
  );
  assert.deepEqual(worldStart, [20, 20]);
});

void test("a world-map entrance that cannot be reached falls back to another entrance", async () => {
  const atlas = atlasOf({
    1: {
      name: "世界地图",
      exits: [
        { cell: [7, 7], to: 32 },
        { cell: [8, 7], to: 32 },
      ],
    },
    32: { name: "终点", exits: [] },
  });
  const world = worldFor(atlas);
  world.map = 1;
  world.cell = [20, 20];
  world.failures.add("1:7,7");
  const result = await travelToMap(
    terrainPilot(world, { state: "Walk" }),
    { atlas, moveState: { drake: null } },
    32,
  );
  assert.equal(result.reached, true);
  assert.equal(result.hops[0]?.cell[0], 8);
  assert.match(result.text, /没走通的出口:地图 1 \(7, 7\) 到地图 32/);
});

void test("when every world-map entrance fails, travel_to reports them", async () => {
  const atlas = atlasOf({
    1: {
      name: "世界地图",
      exits: [
        { cell: [7, 7], to: 32 },
        { cell: [8, 7], to: 32 },
      ],
    },
    32: { name: "终点", exits: [] },
  });
  const world = worldFor(atlas);
  world.map = 1;
  world.cell = [20, 20];
  world.failures.add("1:7,7");
  world.failures.add("1:8,7");
  const result = await travelToMap(
    terrainPilot(world, { state: "Walk" }),
    { atlas, moveState: { drake: null } },
    32,
  );
  assert.equal(result.reached, false);
  assert.equal(world.map, 1);
  assert.match(result.text, /没走通的出口:地图 1 \(7, 7\) 到地图 32、地图 1 \(8, 7\) 到地图 32/);
  assert.match(result.text, /找不到从 1 到 32 的路/);
});

void test("on the wind drake the world-map hop flies in and lands", async () => {
  const atlas = atlasOf({
    1: { name: "世界地图", exits: [{ cell: [7, 7], to: 32 }] },
    32: { name: "终点", exits: [] },
  });
  const world = worldFor(atlas);
  world.map = 1;
  world.cell = [20, 20];
  const ride = { state: "LowFlying" };
  const pilot = terrainPilot(world, ride);
  pilot.on("keys", () => {
    ride.state = "Walk";
    return { ok: true };
  });
  const result = await travelToMap(pilot, { atlas, moveState: { drake: null } }, 32);
  assert.equal(result.reached, true);
  assert.equal(world.map, 32);
  assert.ok(pilot.keys().some((keys) => keys.includes("Enter")));
});

void test("a ship without a world export falls back to walking and says why", async () => {
  const atlas = atlasOf({
    1: { name: "世界地图", exits: [{ cell: [7, 7], to: 32 }] },
    32: { name: "终点", exits: [] },
  });
  const world = worldFor(atlas);
  world.map = 1;
  world.cell = [20, 20];
  const pilot = terrainPilot(world, { state: "Ship" });
  // Open sea everywhere: without the world export there is no dock to aim at, so the
  // walking fallback cannot leave the ship's cell.
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [world.cell[0], world.cell[1]],
      attr: Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => 16)),
    },
  }));
  const result = await travelToMap(pilot, { atlas, moveState: { drake: null } }, 32);
  assert.equal(result.reached, false);
  assert.equal(world.map, 1);
  assert.match(result.text, /^到不了地图 32/m);
  assert.doesNotMatch(result.text, /现在在坐船上/);
  assert.doesNotMatch(result.text, /跳数:0/);
});

void test("go to a map no exit reaches says 到不了 and why, never 跳数:0", async () => {
  const atlas = atlasOf(SIMPLE);
  const world = worldFor(atlas);
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 99);
  assert.equal(result.reached, false);
  assert.equal(world.map, 30);
  assert.match(result.text, /^到不了地图 99/m);
  assert.match(result.text, /地图记录本身就没有从 30 到 99 的出口路线/);
  assert.doesNotMatch(result.text, /跳数:0/);
});

void test("go to the map the party is already on is 0 hops and says 已经在地图", async () => {
  const atlas = atlasOf(SIMPLE);
  const world = worldFor(atlas);
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 30);
  assert.equal(result.reached, true);
  assert.equal(result.hops.length, 0);
  assert.match(result.text, /跳数:0\(已经在地图 30「图尔村」\)/);
});

void test("on a chocobo go says 到不了 and why instead of only 跳数:0", async () => {
  const atlas = atlasOf({
    1: { name: "世界地图", exits: [{ cell: [7, 7], to: 32 }] },
    32: { name: "终点", exits: [] },
  });
  const world = worldFor(atlas);
  world.map = 1;
  world.cell = [20, 20];
  const result = await travelToMap(
    terrainPilot(world, { state: "Chocobo" }),
    { atlas, moveState: { drake: null } },
    32,
  );
  assert.equal(result.reached, false);
  assert.equal(world.map, 1);
  assert.match(result.text, /^到不了地图 32/m);
  assert.match(result.text, /现在在骑陆行鸟上,go 只会步行和骑飞龙/);
  assert.doesNotMatch(result.text, /跳数:0/);
});

void test("a map name shared by two maps is listed and nothing moves", () => {
  const atlas = atlasOf({
    30: { name: "图尔村 东", exits: [] },
    31: { name: "图尔村 西", exits: [] },
  });
  const choice = findMap(atlas, "图尔村");
  assert.ok(!choice.ok);
  assert.match(choice.error, /有 2 张/);
  assert.match(choice.error, /地图 30「图尔村 东」/);
  assert.match(choice.error, /地图 31「图尔村 西」/);
});

void test("an exact map name wins over the maps whose names contain it", () => {
  const atlas = atlasOf({
    30: { name: "图尔村", exits: [] },
    35: { name: "图尔村 旅店", exits: [] },
    37: { name: "图尔村 武器店", exits: [] },
  });
  assert.deepEqual(findMap(atlas, "图尔村"), { ok: true, mapId: 30 });
  const shops = findMap(atlas, "图尔村 ");
  assert.deepEqual(shops, { ok: true, mapId: 30 });
  const partial = findMap(atlas, "店");
  assert.ok(!partial.ok);
  assert.match(partial.error, /有 2 张/);
});

void test("explore picks the nearer of two unknown exits by walking distance", async () => {
  const atlas = atlasOf({
    30: {
      name: "迷宫",
      exits: [
        { cell: [0, 5], to: 41 },
        { cell: [4, 5], to: 42 },
      ],
    },
  });
  const world = worldFor(atlas);
  const result = await explore(pilotFor(world), {
    atlas,
    moveState: { drake: null },
    lookAround: () => Promise.resolve("近房间里有宝箱"),
  });
  assert.equal(result.found, true);
  assert.equal(world.map, 42);
  assert.match(result.text, /走了 1 格到 \(4, 5\)，进了地图 42/);
  assert.match(result.text, /近房间里有宝箱/);
});

void test("explore travels to the nearest map with an unknown exit when this one has none", async () => {
  const atlas = atlasOf({
    30: { name: "走廊", exits: [{ cell: [1, 5], to: 31 }] },
    31: { name: "岔路", exits: [{ cell: [2, 5], to: 45 }] },
  });
  atlas.visitedNow.add("30");
  atlas.visitedNow.add("31");
  const world = worldFor(atlas);
  const result = await explore(pilotFor(world), {
    atlas,
    moveState: { drake: null },
    lookAround: () => Promise.resolve("新房间是空的"),
  });
  assert.equal(result.found, true);
  assert.equal(world.map, 45);
  assert.match(result.text, /地图 30 →\(1, 5\)→ 地图 31/);
  assert.match(result.text, /进了地图 45/);
  assert.match(result.text, /新房间是空的/);
});

void test("explore treats a map recorded by an older save as not visited", async () => {
  const atlas = atlasOf({
    30: { name: "走廊", exits: [{ cell: [1, 5], to: 31 }] },
    31: { name: "旧房间", exits: [] },
  });
  atlas.visitedNow.add("30");
  const world = worldFor(atlas);
  const result = await explore(pilotFor(world), { atlas, moveState: { drake: null } });
  assert.equal(result.found, true);
  assert.equal(world.map, 31);
  assert.match(result.text, /进了地图 31/);
});

void test("explore says every exit this save visited is done", async () => {
  const atlas = atlasOf({
    30: { name: "走廊", exits: [{ cell: [1, 5], to: 31 }] },
    31: { name: "尽头", exits: [] },
  });
  atlas.visitedNow.add("30");
  atlas.visitedNow.add("31");
  const world = worldFor(atlas);
  const result = await explore(pilotFor(world), { atlas, moveState: { drake: null } });
  assert.equal(result.found, false);
  assert.equal(world.map, 30);
  assert.match(result.text, /都去过了/);
  assert.equal(result.text.includes("以前周目留下的记录"), false);
});

void test("unknown exits follow this save, not the recorded structure", () => {
  const atlas = atlasOf({
    30: { name: "走廊", exits: [{ cell: [1, 5], to: 31 }] },
    31: { name: "旧房间", exits: [] },
  });
  assert.equal(unknownExits(atlas, 30).length, 1);
  atlas.visitedNow.add("31");
  assert.equal(unknownExits(atlas, 30).length, 0);
});

void test("the world map is map 1 and is never a route hop", () => {
  assert.equal(isWorldMap(1), true);
  assert.equal(isWorldMap("1"), true);
  assert.equal(isWorldMap(2), false);
  const atlas = atlasOf({
    30: { name: "起点", exits: [{ cell: [1, 5], to: 31 }] },
    31: { name: "港口", exits: [{ cell: [1, 5], to: 1 }] },
    1: { name: "世界地图", exits: [{ cell: [7, 7], to: 32 }] },
    32: { name: "终点", exits: [] },
  });
  assert.equal(mapPath(atlas, 30, 32), null);
  assert.notEqual(mapPath(atlas, 30, 32, new Set(), true), null);
});

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

/** Task 45's completion replies for map 71, so go's origin guard can be exercised. */
function completionWorld(): { world: World; pilot: FakePilot } {
  const atlas = atlasOf({
    71: { name: "沃尔斯塔", exits: [{ cell: [1, 5], to: 72 }] },
    72: { name: "沃尔斯塔 地下", exits: [] },
  });
  const world = worldFor(atlas);
  world.cell = [2, 2];
  const pilot = pilotFor(world);
  pilot.on("pos", () => ({
    pos: {
      map: world.map,
      area: world.map,
      areaType: 1,
      areaText: world.map === 71 ? "沃尔斯塔" : "沃尔斯塔 地下",
      state: "Player",
      cell: world.cell,
      saves: 1,
    },
  }));
  pilot.onQuery("achievements", {
    achievements: {
      defs: [],
      save: {
        playTime: 1,
        saveCount: 1,
        chests: 1,
        hiddenItems: 1,
        treasure: [
          { area: 71, name: "沃尔斯塔", type: 1, total: 2, open: 1 },
          { area: 71, name: "沃尔斯塔", type: 2, total: 1, open: 1 },
        ],
        members: [],
        flags: {},
      },
      bestiary: null,
    },
  });
  const entities: Reply[] = [
    { kind: "TresureBox", cell: [4, 7], contentName: "以太", opened: false },
    { kind: "TresureBox", cell: [5, 7], contentName: "金针", opened: true },
    { kind: "TresureBox", cell: [6, 7], contentName: "精灵披风", hidden: true, opened: true },
    { kind: "GotoMap", cell: [1, 5], toMap: 72 },
  ];
  pilot.on("entities", (fields) => ({
    entities: {
      total: entities.length,
      entities: entities.filter((entity) => fields.kind === "All" || entity.kind === fields.kind),
    },
  }));
  pilot.onQuery("encounters", {
    encounters: {
      monsterSet: 5,
      parties: [{ id: 1, rate: 100, monsters: [{ name: "船员尘埃", book: 41 }] }],
      region: null,
      regions: [],
    },
  });
  pilot.onQuery("items", { items: { normal: [], important: [] } });
  pilot.onQuery("sample", () => ({
    sample: {
      user: { mapId: world.map, areaText: world.map === 71 ? "沃尔斯塔" : "沃尔斯塔 地下" },
      party: [],
      field: { moveState: "Walk" },
    },
  }));
  return { world, pilot };
}

async function originGame(directory: string): Promise<Game> {
  const game = await Game.create({
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
  });
  game.atlas.maps.set("71", {
    name: "沃尔斯塔",
    exits: [{ cell: [1, 5], to: 72, name: "" }],
    chests: [],
  });
  game.atlas.maps.set("72", { name: "沃尔斯塔 地下", exits: [], chests: [] });
  return game;
}

void test("go's map origin is refused incomplete, then allowed with leave_incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-travel-guard-"));
  try {
    const game = calmGame(await originGame(directory));
    const { world, pilot } = completionWorld();
    const refused = await game.run("go", { to: 72 }, pilot);
    assert.match(refused, /还没完成/);
    assert.match(refused, /leave_incomplete/);
    assert.equal(world.map, 71);
    assert.equal(game.backlog.pending().length, 0);

    const allowed = await game.run("go", { to: 72, leave_incomplete: "需要钥匙" }, pilot);
    assert.match(allowed, /停:到了地图 72/);
    assert.equal(world.map, 72);
    assert.equal(game.backlog.pending()[0]?.reason, "需要钥匙");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A Game whose atlas is exactly these maps; the origin game's own maps are cleared. */
async function gameWithMaps(directory: string, maps: Record<number, MapRecord>): Promise<Game> {
  const game = await originGame(directory);
  game.atlas.maps.clear();
  for (const [key, map] of Object.entries(maps)) {
    game.atlas.maps.set(key, {
      name: map.name,
      exits: map.exits.map((exit) => ({
        cell: exit.cell,
        to: exit.to,
        name: exit.name ?? "",
      })),
      chests: [],
    });
  }
  return game;
}

/** A field pilot whose post-tool reads (chart, completion, bag) can all answer. */
function playablePilot(world: World, ride = "Walk"): FakePilot {
  const pilot = pilotFor(world);
  pilot.on("pos", () => ({
    pos: {
      map: world.map,
      area: world.map,
      areaType: world.map === 1 ? 0 : 1,
      areaText: world.map === 1 ? "世界地图" : `地图 ${world.map}`,
      state: "Player",
      cell: world.cell,
      saves: 1,
    },
  }));
  pilot.onQuery("items", { items: { normal: [], important: [] } });
  pilot.onQuery("sample", () => ({
    sample: {
      user: { mapId: world.map, areaText: world.map === 1 ? "世界地图" : `地图 ${world.map}` },
      party: [],
      field: { moveState: ride },
    },
  }));
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
    encounters: { monsterSet: null, parties: [], region: null, regions: [], enabled: false },
  });
  return pilot;
}

/** The Game's after-tool reads are not under test; keep them cheap and deterministic. */
function calmGame(game: Game): Game {
  game.settle = () => Promise.resolve("");
  game.observe = () => Promise.resolve("状态好");
  return game;
}

void test("go walks two hops to a map named 图尔村", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-name-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        62: { name: "起点", exits: [{ cell: [1, 5], to: 31 }] },
        31: { name: "运河", exits: [{ cell: [2, 5], to: 30 }] },
        30: { name: "图尔村", exits: [] },
      }),
    );
    const world = worldFor(game.atlas);
    world.map = 62;
    const result = await game.run("go", { to: "图尔村" }, playablePilot(world));
    assert.equal(world.map, 30);
    assert.match(result, /走了 2 跳/);
    assert.match(result, /地图 62 →\(1, 5\)→ 地图 31/);
    assert.match(result, /地图 31 →\(2, 5\)→ 地图 30/);
    assert.match(result, /停在:地图 30「图尔村」/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go by map id that no route reaches says 到不了 instead of only 跳数:0", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-unreachable-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        30: { name: "起点", exits: [{ cell: [1, 5], to: 31 }] },
        31: { name: "运河", exits: [] },
      }),
    );
    const world = worldFor(game.atlas);
    const result = await game.run("go", { to: 99 }, playablePilot(world));
    assert.equal(world.map, 30);
    assert.match(result, /到不了地图 99/);
    assert.doesNotMatch(result, /跳数:0/);

    const already = await game.run("go", { to: 30 }, playablePilot(world));
    assert.match(already, /跳数:0\(已经在地图 30/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go's two walkpath hops carry the map label and each hop's goal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-walk-label-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        62: { name: "起点", exits: [{ cell: [1, 5], to: 31 }] },
        31: { name: "运河", exits: [{ cell: [2, 5], to: 30 }] },
        30: { name: "图尔村", exits: [] },
      }),
    );
    const world = worldFor(game.atlas);
    world.map = 62;
    const pilot = playablePilot(world);
    const sent: Record<string, unknown>[] = [];
    pilot.on("walkpath", (fields) => {
      sent.push(fields);
      const path = fields.path as Cell[];
      const last = path[path.length - 1];
      assert.ok(last);
      world.cell = [last[0], last[1]];
      const key = `${last[0]},${last[1]}`;
      const exit = world.exits.get(world.map)?.get(key);
      if (exit !== undefined) {
        const actual = world.redirects.get(`${world.map}:${key}`) ?? exit;
        world.map = actual;
        world.cell = world.entries.get(actual) ?? [5, 5];
      }
      return {
        ok: true,
        reason: "arrived",
        index: path.length - 1,
        steps: path.length - 1,
        pos: { map: world.map, cell: world.cell },
        next: null,
      };
    });
    await game.run("go", { to: "图尔村" }, pilot);
    assert.equal(world.map, 30);
    assert.equal(sent.length, 2);
    const first = sent[0];
    const second = sent[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.label, "go → 地图 30「图尔村」 第 1 跳");
    assert.equal(second.label, "go → 地图 30「图尔村」 第 2 跳");
    assert.deepEqual(first.goal, [1, 5]);
    assert.deepEqual(second.goal, [2, 5]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go lists two maps with the same name and does not move", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-ambiguous-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        60: { name: "起点", exits: [] },
        61: { name: "图尔村 东", exits: [] },
        62: { name: "图尔村 西", exits: [] },
      }),
    );
    const world = worldFor(game.atlas);
    world.map = 60;
    const result = await game.run("go", { to: "图尔村" }, playablePilot(world));
    assert.match(result, /有 2 张/);
    assert.match(result, /地图 61「图尔村 东」/);
    assert.match(result, /地图 62「图尔村 西」/);
    assert.match(result, /请用地图号/);
    assert.equal(world.map, 60);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go(to=62) and go(to=地图 62) are the same", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-number-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        30: { name: "起点", exits: [{ cell: [1, 5], to: 62 }] },
        62: { name: "沃尔斯城", exits: [] },
      }),
    );
    for (const to of [62, "地图 62"] as const) {
      const world = worldFor(game.atlas);
      world.map = 30;
      const result = await game.run("go", { to }, playablePilot(world));
      assert.equal(world.map, 62, String(to));
      assert.match(result, /停在:地图 62/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go enters an exit whose map the atlas has never recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-unrecorded-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        30: { name: "起点", exits: [{ cell: [1, 5], to: 40 }] },
      }),
    );
    const world = worldFor(game.atlas);
    world.map = 30;
    const result = await game.run("go", { to: 40 }, playablePilot(world));
    assert.equal(world.map, 40);
    assert.match(result, /到了地图 40/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a world-map exit name finds the map it leads to", () => {
  const atlas = atlasOf({
    1: {
      name: "世界地图",
      exits: [{ cell: [130, 89], to: 30, name: "4:トゥールの村" }],
    },
  });
  const choice = findMap(atlas, "トゥールの村");
  assert.deepEqual(choice, { ok: true, mapId: 30 });
});

void test("a route's last hop may enter a map the atlas never recorded", async () => {
  const atlas = atlasOf({ 30: { name: "起点", exits: [{ cell: [1, 5], to: 40 }] } });
  const world = worldFor(atlas);
  world.map = 30;
  const result = await travelToMap(pilotFor(world), { atlas, moveState: { drake: null } }, 40);
  assert.equal(result.reached, true);
  assert.equal(world.map, 40);
  assert.match(result.text, /到了地图 40/);
});

void test("go takes a coordinate array and bracketed or spaced coordinate strings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-cell-"));
  try {
    const game = calmGame(await gameWithMaps(directory, { 30: { name: "洞窟", exits: [] } }));
    for (const to of [
      [12, 8],
      "12,8",
      "[12, 8]",
      "(12, 8)",
      "12, 8",
      "12 8",
      " [12, 8] ",
    ] as const) {
      const world = worldFor(game.atlas);
      world.cell = [5, 5];
      const result = await game.run("go", { to }, playablePilot(world));
      assert.deepEqual(world.cell, [12, 8], String(to));
      assert.match(result, /到达 \(12, 8\)/);
      assert.match(result, /当前状态:\n状态好/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go still treats 地图 30 and 图尔村 as map names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-name-cell-"));
  try {
    for (const to of ["地图 30", "图尔村"] as const) {
      const game = calmGame(
        await gameWithMaps(directory, {
          29: { name: "起点", exits: [{ cell: [1, 5], to: 30 }] },
          30: { name: "图尔村", exits: [] },
        }),
      );
      const world = worldFor(game.atlas);
      const result = await game.run("go", { to }, playablePilot(world));
      assert.equal(world.map, 30, `${to}: ${result}`);
      assert.match(result, /停在:地图 30/, to);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a coordinate on an exit names the map instead and suggests go(to=N)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-exit-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        30: { name: "图尔村", exits: [{ cell: [1, 5], to: 31 }] },
        31: { name: "运河", exits: [] },
      }),
    );
    const world = worldFor(game.atlas);
    world.cell = [5, 5];
    const result = await game.run("go", { to: [1, 5] }, playablePilot(world));
    assert.equal(world.map, 31);
    assert.match(result, /\(这一格是去地图 31「运河」的出口，下次可以写 go\(to=31\)\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("on a ship a coordinate goes by sea and names the world-map entrance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-ship-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        1: { name: "世界地图", exits: [{ cell: [7, 7], to: 32 }] },
        32: { name: "终点", exits: [] },
      }),
    );
    const world = worldFor(game.atlas);
    world.map = 1;
    world.cell = [20, 20];
    const pilot = playablePilot(world, "Ship");
    pilot.on("cells", () => ({
      cells: {
        origin: [0, 0],
        center: [world.cell[0], world.cell[1]],
        attr: Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => 16)),
      },
    }));
    const result = await game.run("go", { to: [7, 7] }, pilot);
    assert.equal(world.map, 32);
    assert.match(result, /\(这一格是去地图 32「终点」的出口，下次可以写 go\(to=32\)\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a same-map go carried onto another map walks back over the recorded route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-back-"));
  try {
    const game = calmGame(
      await gameWithMaps(directory, {
        260: { name: "火力船", exits: [{ cell: [2, 2], to: 261 }] },
        261: { name: "出口", exits: [{ cell: [1, 1], to: 260 }] },
      }),
    );
    const world = worldFor(game.atlas);
    world.map = 260;
    world.cell = [0, 0];
    world.entries.set(260, [3, 0]);
    world.entries.set(261, [5, 5]);
    const pilot = playablePilot(world);
    let first = true;
    pilot.on("walkpath", (fields) => {
      const path = fields.path as Cell[];
      const last = path[path.length - 1] ?? [world.cell[0], world.cell[1]];
      if (first && world.map === 260) {
        first = false;
        world.map = 261;
        world.cell = [5, 5];
        return {
          ok: false,
          reason: "map_changed",
          index: 2,
          steps: 2,
          pos: { map: 260, cell: [2, 0] },
          next: null,
          turns: [],
        };
      }
      world.cell = [last[0], last[1]];
      const exit = world.exits.get(world.map)?.get(`${last[0]},${last[1]}`);
      if (exit !== undefined) {
        world.map = exit;
        world.cell = world.entries.get(exit) ?? [3, 0];
      }
      return {
        ok: true,
        reason: "arrived",
        index: path.length - 1,
        steps: path.length - 1,
        pos: { map: world.map, cell: [world.cell[0], world.cell[1]] },
        next: null,
        turns: [],
      };
    });
    const result = await game.run("go", { to: [4, 0] }, pilot);
    assert.equal(world.map, 260, result);
    assert.deepEqual(world.cell, [4, 0], result);
    assert.match(result, /地图记录里有回去的路/);
    assert.match(result, /到达 \(4, 0\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go refuses an incomplete coordinate leave, then allows it with a reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-cell-guard-"));
  try {
    const game = await originGame(directory);
    const { world, pilot } = completionWorld();
    const refused = await game.run("go", { to: [1, 5] }, pilot);
    assert.match(refused, /还没完成/);
    assert.match(refused, /leave_incomplete/);
    assert.equal(world.map, 71);
    assert.equal(game.backlog.pending().length, 0);

    calmGame(game);
    const allowed = await game.run("go", { to: [1, 5], leave_incomplete: "需要钥匙" }, pilot);
    assert.equal(world.map, 72);
    assert.match(allowed, /进入了地图 72/);
    assert.match(allowed, /这一格是去地图 72/);
    assert.equal(game.backlog.pending()[0]?.reason, "需要钥匙");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the configured walkpath turn lead, timeout and blocked wait reach the bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-go-walkpath-"));
  try {
    const game = calmGame(
      await Game.create({
        laptop: LAPTOP,
        game: "ff5",
        saveSlot: 20,
        atlasFile: join(directory, "atlas.json"),
        tacticsFile: join(directory, "tactics.json"),
        elementsFile: join(directory, "elements.json"),
        walkpathTimeoutMs: 12_000,
        walkpathBlockedMs: 250,
        walkpathTurnLead: 0.9,
      }),
    );
    game.atlas.maps.set("30", { name: "洞窟", exits: [], chests: [] });
    const world = worldFor(game.atlas);
    world.cell = [5, 5];
    const pilot = playablePilot(world);
    const sentFields: Record<string, unknown>[] = [];
    pilot.on("walkpath", (sent) => {
      sentFields.push(sent);
      const path = sent.path as Cell[];
      const last = path[path.length - 1] ?? [world.cell[0], world.cell[1]];
      world.cell = [last[0], last[1]];
      return {
        ok: true,
        reason: "arrived",
        pos: { map: 30, cell: [world.cell[0], world.cell[1]] },
        next: null,
      };
    });
    await game.run("go", { to: [12, 8] }, pilot);
    const fields = sentFields[0];
    assert.ok(fields !== undefined);
    assert.equal(fields.turnLead, 0.9);
    assert.equal(fields.blockedMs, 250);
    assert.equal(fields.timeoutMs, 12_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("explore can leave an incomplete map with leave_incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-explore-guard-"));
  try {
    const game = await originGame(directory);
    const { world, pilot } = completionWorld();
    const refused = await game.run("explore", {}, pilot);
    assert.match(refused, /还没完成/);
    assert.equal(world.map, 71);
    assert.equal(game.backlog.pending().length, 0);

    const allowed = await game.run("explore", { leave_incomplete: "需要钥匙" }, pilot);
    assert.equal(world.map, 72);
    assert.match(allowed, /进了地图 72/);
    assert.equal(game.backlog.pending()[0]?.reason, "需要钥匙");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a ship sails to the coast and walks into the town", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-ship-"));
  try {
    const maps = join(dir, "maps");
    await mkdir(maps, { recursive: true });
    const walk = [
      "0000000000",
      "0000000000",
      "0000000000",
      "0000000111",
      "0000000111",
      "0000000111",
      "0000000111",
    ];
    const ship = [
      "1111111000",
      "1111111000",
      "1111111000",
      "1111111000",
      "1111111000",
      "1111111000",
      "1111111000",
    ];
    await writeFile(
      join(maps, "1.json"),
      JSON.stringify({
        id: 1,
        collision: [],
        exits: [{ cell: [8, 3], toMap: 30, toPoint: 1 }],
        world: { width: 10, height: 7, modes: { walk, ship }, points: [] },
      }),
      "utf8",
    );
    await writeFile(
      join(maps, "30.json"),
      JSON.stringify({
        id: 30,
        collision: [
          { name: "GroundCollision", rows: Array.from({ length: 8 }, () => "0".repeat(8)) },
        ],
        exits: [],
      }),
      "utf8",
    );
    const store = await CollisionStore.load(undefined, undefined, maps);
    const atlas = atlasOf({
      1: { name: "世界地图", exits: [{ cell: [8, 3], to: 30 }] },
      30: { name: "图尔村", exits: [] },
    });
    const world = worldFor(atlas);
    world.map = 1;
    world.cell = [1, 3];
    const sailed: string[] = [];
    const pilot = pilotFor(world, (from, to) => {
      sailed.push(`${from[0]},${from[1]}>${to[0]},${to[1]}`);
    });
    pilot.on("cells", () => ({
      cells: {
        origin: [0, 0],
        center: [world.cell[0], world.cell[1]],
        attr: walk.map((row) => Array.from(row, (value) => (value === "1" ? 4 : 16))),
      },
    }));
    pilot.onQuery("sample", () => ({ sample: { field: { moveState: "Ship" } } }));
    const result = await travelToMap(
      pilot,
      { atlas, moveState: { drake: null }, collisions: store },
      30,
    );
    assert.equal(result.reached, true);
    assert.equal(world.map, 30);
    assert.deepEqual(
      result.hops.map((hop) => [hop.from, hop.actual]),
      [[1, 30]],
    );
    assert.equal(sailed[0], "1,3>6,3", "the ship sailed to the approach cell");
    assert.ok(sailed.includes("6,3>8,3"), "the party walked ashore to the town entrance");
    assert.match(result.text, /走了 1 跳/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

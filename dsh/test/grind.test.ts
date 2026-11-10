/**
 * Task 47: the code-driven grind loop. These tests use a scripted world (map, party, gold,
 * encounters) and a stand-in fighter; the real battle handler is covered by battle.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { CompletionState } from "../src/engine/completion.ts";
import { Game } from "../src/engine/game.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { grind, parseGrindOptions, type GrindContext } from "../src/engine/skills/grind.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

interface World {
  map: number;
  cell: Cell;
  mapName: string;
  world: boolean;
  gold: number;
  lv: number;
  hp: number;
  mp: number;
  maxHp: number;
  maxMp: number;
  state: string;
  choiceOpen: boolean;
  npc: Cell | null;
  known: Set<number>;
  targets: Cell[];
  walks: number;
  battleEvery: number;
  fighter: () => string;
}

function makeWorld(patch: Partial<World> = {}): World {
  return {
    map: 30,
    cell: [5, 5],
    mapName: "图尔村",
    world: false,
    gold: 100,
    lv: 10,
    hp: 100,
    mp: 20,
    maxHp: 100,
    maxMp: 20,
    state: "Player",
    choiceOpen: false,
    npc: null,
    known: new Set(),
    targets: [],
    walks: 0,
    battleEvery: 0,
    fighter: () => "按这张地图的策略打完 1 秒",
    ...patch,
  };
}

/** A fighter that ends the battle and registers nothing, for budget tests. */
function idleFighter(world: World): () => string {
  return () => {
    world.state = "Player";
    return "按这张地图的策略打完 1 秒";
  };
}

interface TestMonster {
  number: number;
  name: string;
  chance?: number | null;
  missable?: string | null;
  lost?: boolean;
}

function completionOf(world: World, monsters: readonly TestMonster[]): CompletionState {
  return {
    mapId: world.map,
    areaId: 0,
    mapName: world.mapName,
    world: world.world,
    region: null,
    chests: { total: 0, open: 0, missing: [], elsewhere: 0 },
    hidden: { total: 0, open: 0, missing: [], elsewhere: 0 },
    monsters: {
      total: monsters.length,
      missing: monsters
        .filter((monster) => !world.known.has(monster.number))
        .map((monster) => {
          const chance = monster.chance ?? null;
          return {
            number: monster.number,
            name: monster.name,
            chance,
            expectedBattles: chance === null || chance <= 0 ? null : Math.ceil(1 / chance),
            missable: monster.missable ?? null,
            lost: monster.lost === true,
          };
        }),
    },
    encounter: monsters.length > 0 ? "ok" : "unknown",
    areaName: world.mapName,
    timedUntil: null,
    oneTime: false,
    exits: [],
    storyEvents: [],
  };
}

function cellsReply(world: World): Reply {
  const attr = Array.from({ length: 20 }, () =>
    Array.from({ length: 20 }, () => (world.world ? 3 : 0)),
  );
  return { cells: { origin: [0, 0], center: [world.cell[0], world.cell[1]], attr } };
}

function pilotFor(world: World, monsters: readonly TestMonster[] = []): FakePilot {
  const pilot = new FakePilot();
  const party = (): Reply[] => [
    {
      name: "巴兹",
      lv: world.lv,
      hp: world.hp,
      maxHp: world.maxHp,
      mp: world.mp,
      maxMp: world.maxMp,
    },
  ];
  pilot.on("pos", {
    get pos() {
      return { state: world.state, map: world.map, cell: world.cell };
    },
  });
  pilot.onQuery("sample", () => ({
    sample: {
      user: { gil: world.gold, mapId: world.map, areaText: world.mapName },
      party: party(),
      choice: world.choiceOpen ? { c: { open: true, options: ["是", "否"], cursor: 0 } } : {},
    },
  }));
  pilot.on("cells", () => cellsReply(world));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [world.cell[0], world.cell[1]],
      layers: [{ name: "GroundCollision", rows: Array.from({ length: 20 }, () => "0".repeat(20)) }],
    },
  }));
  pilot.on("entities", (fields) => {
    const entities: Reply[] =
      fields.kind === "Npc" && world.npc !== null
        ? [{ kind: "Npc", cell: [world.npc[0], world.npc[1]], name: "宿屋の主人", active: true }]
        : [];
    return { entities: { total: entities.length, entities } };
  });
  pilot.on("route", { route: {} });
  // Task 56: the old walk is the default; a test that wants walkpath overrides this.
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target" };
    }
    world.targets.push([to[0], to[1]]);
    world.cell = [to[0], to[1]];
    world.walks += 1;
    pilot.advance(45_000);
    if (world.battleEvery > 0 && world.walks % world.battleEvery === 0) {
      world.state = "Battle";
      return {
        ok: false,
        error: "interrupted:battle",
        pos: { state: "Battle", map: world.map, cell: [world.cell[0], world.cell[1]] },
      };
    }
    return {
      ok: true,
      pos: { state: world.state, map: world.map, cell: [world.cell[0], world.cell[1]] },
    };
  });
  pilot.on("keys", () => {
    if (world.choiceOpen) {
      world.choiceOpen = false;
      world.hp = world.maxHp;
      world.mp = world.maxMp;
      world.gold -= 20;
      world.state = "Player";
    } else if (world.npc !== null) {
      world.choiceOpen = true;
    }
    return { ok: true };
  });
  pilot.on("story", () => ({ pages: 1, stop: world.choiceOpen ? "choice" : "free" }));
  pilot.on("wait", { ok: true });
  pilot.onQuery("items", { items: { normal: [], important: [] } });
  pilot.onQuery("encounters", {
    encounters: {
      monsterSet: world.world ? 3 : 1,
      parties: monsters.map((monster, index) => ({
        id: index + 1,
        rate: 100,
        monsters: [{ name: monster.name, book: monster.number }],
      })),
      region: world.world
        ? {
            grid: 7,
            start: [4, 4],
            end: [6, 6],
            current: true,
            parties: monsters.map((monster, index) => ({
              id: index + 1,
              rate: 100,
              monsters: [{ name: monster.name, book: monster.number }],
            })),
          }
        : null,
      regions: [],
    },
  });
  // Task 69: the world map's per-cell encounter grid. Tests that need boundaries override it.
  pilot.onQuery("encountgrid", (fields) => ({
    encountgrid: (Array.isArray(fields.cells) ? fields.cells : []).map(() =>
      world.world ? 169 : null,
    ),
  }));
  return pilot;
}

function contextFor(
  world: World,
  monsters: readonly TestMonster[],
  atlas = new Atlas(),
  defer?: GrindContext["defer"],
): GrindContext {
  const names = new Map(monsters.map((monster) => [monster.number, monster.name]));
  return {
    atlas,
    moveState: { drake: null },
    fighter: () => Promise.resolve(world.fighter()),
    refresh: () =>
      Promise.resolve({
        completion: completionOf(world, monsters),
        known: new Set(world.known),
        names,
      }),
    ...(defer === undefined ? {} : { defer }),
  };
}

void test("grind stops at until_gold and reports the fights and money", async () => {
  const world = makeWorld({ battleEvery: 1 });
  const pilot = pilotFor(world);
  world.fighter = () => {
    world.gold += 1000;
    world.state = "Player";
    return "按这张地图的策略打完 1 秒(敌人:哥布林)";
  };
  const report = await grind(pilot, parseOptions({ until_gold: 2000 }), contextFor(world, []));
  assert.equal(report.battles, 2);
  assert.equal(report.gold, 2100);
  assert.equal(report.goldGained, 2000);
  assert.equal(report.stop, "钱够了(2100/2000)");
  assert.match(report.text, /打了 2 场/);
  assert.match(report.text, /钱 100→2100\(\+2000\)/);
  assert.match(report.text, /停:钱够了/);
});

void test("grind stops when every monster of this map is registered", async () => {
  const monsters = [
    { number: 10, name: "祖" },
    { number: 11, name: "艾吉尔" },
  ];
  const world = makeWorld({ battleEvery: 1 });
  const pilot = pilotFor(world, monsters);
  world.fighter = () => {
    const next = monsters.find((monster) => !world.known.has(monster.number));
    if (next !== undefined) world.known.add(next.number);
    world.state = "Player";
    return "按这张地图的策略打完 1 秒";
  };
  const report = await grind(
    pilot,
    parseOptions({ until_bestiary: true }),
    contextFor(world, monsters),
  );
  assert.equal(report.battles, 2);
  assert.deepEqual(report.bestiary, ["祖", "艾吉尔"]);
  assert.equal(report.stop, "本图的怪都登记进本档图鉴了");
  assert.match(report.text, /本档图鉴新登记 2 种:祖、艾吉尔/);
});

void test("until_bestiary defers a 7% monster after 15 battles and records one debt", async () => {
  const monsters: TestMonster[] = [{ number: 99, name: "风形魔", chance: 0.07 }];
  const world = makeWorld({ battleEvery: 1 });
  const pilot = pilotFor(world, monsters);
  world.fighter = idleFighter(world);
  const deferred: { names: readonly string[]; reason: string }[] = [];
  const report = await grind(
    pilot,
    { ...parseOptions({ until_bestiary: true }), bestiaryDeferBattles: 15 },
    contextFor(world, monsters, new Atlas(), (list, reason) => {
      deferred.push({ names: list.map((monster) => monster.name), reason });
    }),
  );
  assert.equal(report.battles, 15);
  assert.match(report.stop, /低概率\(7%\)/);
  assert.match(report.stop, /刷了 15 场没遇到/);
  assert.match(report.stop, /可以直接离开/);
  assert.equal(deferred.length, 1);
  const entry = deferred[0];
  assert.ok(entry);
  assert.deepEqual(entry.names, ["风形魔"]);
  assert.match(entry.reason, /低概率\(7%\),刷了 15 场没遇到;以后还会出现/);
});

void test("a missable monster is not deferred at 15 battles and stops at its own cap", async () => {
  const monsters: TestMonster[] = [
    {
      number: 99,
      name: "风形魔",
      chance: 0.07,
      missable: "打倒隆卡遗迹首领前",
    },
  ];
  const world = makeWorld({ battleEvery: 1 });
  const pilot = pilotFor(world, monsters);
  world.fighter = idleFighter(world);
  const deferred: string[] = [];
  const report = await grind(
    pilot,
    {
      ...parseOptions({ until_bestiary: true, max_minutes: 120 }),
      bestiaryDeferBattles: 15,
      bestiaryMissableMinutes: 120,
    },
    contextFor(world, monsters, new Atlas(), (list) => {
      deferred.push(...list.map((monster) => monster.name));
    }),
  );
  // 7% is 1/14.3, rounded up to 15; the cap is 5 × 15 = 75, not the 15-battle deferral.
  assert.equal(report.battles, 75);
  assert.match(report.stop, /会错过/);
  assert.match(report.stop, /期限：打倒隆卡遗迹首领前/);
  assert.match(report.stop, /平均 15 场一次/);
  assert.match(report.stop, /要接着刷就再调 grind/);
  assert.deepEqual(deferred, []);
});

void test("a 35% monster gets the minimum three-battle budget", async () => {
  const monsters: TestMonster[] = [{ number: 98, name: "常见怪", chance: 0.35 }];
  const world = makeWorld({ battleEvery: 1 });
  const pilot = pilotFor(world, monsters);
  world.fighter = idleFighter(world);
  const deferred: string[] = [];
  const report = await grind(
    pilot,
    { ...parseOptions({ until_bestiary: true }), bestiaryDeferBattles: 15 },
    contextFor(world, monsters, new Atlas(), (list) => {
      deferred.push(...list.map((monster) => monster.name));
    }),
  );
  assert.equal(report.battles, 3);
  assert.match(report.stop, /低概率\(35%\),刷了 3 场没遇到/);
  assert.deepEqual(deferred, ["常见怪"]);
});

void test("an unknown chance keeps the old max_minutes behaviour and records no debt", async () => {
  const monsters: TestMonster[] = [{ number: 97, name: "看不清的怪", chance: null }];
  const world = makeWorld({ battleEvery: 1 });
  const pilot = pilotFor(world, monsters);
  world.fighter = idleFighter(world);
  const deferred: string[] = [];
  const report = await grind(
    pilot,
    parseOptions({ until_bestiary: true, max_minutes: 1 }),
    contextFor(world, monsters, new Atlas(), (list) => {
      deferred.push(...list.map((monster) => monster.name));
    }),
  );
  assert.match(report.stop, /到 1 分钟/);
  assert.deepEqual(deferred, []);
});

void test("grind sleeps at the inn when HP is low, then farms again", async () => {
  const world = makeWorld({
    map: 31,
    mapName: "图尔村 宿屋",
    hp: 20,
    mp: 10,
    gold: 500,
    npc: [5, 6],
    battleEvery: 1,
  });
  const atlas = new Atlas();
  atlas.maps.set("31", {
    name: "图尔村 宿屋",
    exits: [{ cell: [1, 2], to: 30, name: "出口" }],
    chests: [],
  });
  const pilot = pilotFor(world);
  world.fighter = () => {
    world.gold += 800;
    world.state = "Player";
    return "按这张地图的策略打完 1 秒";
  };
  const report = await grind(
    pilot,
    parseOptions({ until_gold: 1200, rest_hp_pct: 40, rest_mp_pct: 25 }),
    contextFor(world, [], atlas),
  );
  assert.equal(report.rests, 1, report.text);
  assert.ok(report.battles >= 1, "fought after the rest");
  assert.match(report.text, /自动住了 1 次店/);
  assert.match(report.text, /住店:在「图尔村 宿屋」住了一晚/);
  assert.equal(world.gold, 1280);
});

void test("a wipe stops the loop and reports it honestly", async () => {
  const world = makeWorld({ battleEvery: 1 });
  const pilot = pilotFor(world);
  world.fighter = () => {
    world.hp = 0;
    return "全灭(敌人:哥布林),游戏把队伍放回了地图 30 的 (5,5)";
  };
  const report = await grind(pilot, parseOptions({ until_gold: 9999 }), contextFor(world, []));
  assert.equal(report.battles, 1);
  assert.match(report.stop, /^全灭/);
  assert.match(report.text, /停:全灭/);
});

void test("grind stops at max_minutes", async () => {
  const world = makeWorld();
  const pilot = pilotFor(world);
  pilot.on("walk", (fields) => {
    pilot.advance(30_000);
    const to = fields.to;
    if (Array.isArray(to) && typeof to[0] === "number" && typeof to[1] === "number") {
      world.cell = [to[0], to[1]];
    }
    return { ok: true, pos: { state: "Player", map: 30, cell: [world.cell[0], world.cell[1]] } };
  });
  const report = await grind(
    pilot,
    parseOptions({ until_gold: 9999, max_minutes: 1 }),
    contextFor(world, []),
  );
  assert.equal(report.battles, 0);
  assert.equal(report.stop, "到 1 分钟了");
  assert.ok(report.minutes >= 1);
});

void test("on the world map every step stays on the starting encounter grid", async () => {
  const world = makeWorld({ map: 1, world: true, battleEvery: 1, gold: 100 });
  const startGrid = 169;
  const region = { start: [4, 4] as const, end: [6, 6] as const };
  const gridAt = ([x, y]: Cell): number => (x >= 5 && y >= 5 ? startGrid : 114);
  const pilot = pilotFor(world);
  pilot.onQuery("encountgrid", (fields) => ({
    encountgrid: (Array.isArray(fields.cells) ? fields.cells : []).map((raw) =>
      Array.isArray(raw) && typeof raw[0] === "number" && typeof raw[1] === "number"
        ? gridAt([raw[0], raw[1]])
        : null,
    ),
  }));
  world.fighter = () => {
    world.gold += 1000;
    world.state = "Player";
    return "按这张地图的策略打完 1 秒";
  };
  const report = await grind(pilot, parseOptions({ until_gold: 1000 }), contextFor(world, []));
  assert.ok(world.targets.length > 0);
  for (const [x, y] of world.targets) {
    assert.equal(gridAt([x, y]), startGrid, `walked into another grid: (${x}, ${y})`);
    assert.ok(
      x >= region.start[0] && x <= region.end[0] && y >= region.start[1] && y <= region.end[1],
      `walked outside the old region: (${x}, ${y})`,
    );
  }
  assert.equal(report.stop, "钱够了(1100/1000)");
});

void test("an old bridge without encountgrid makes grind stop and say why", async () => {
  const world = makeWorld({ map: 1, world: true });
  const pilot = pilotFor(world);
  pilot.onQuery("encountgrid", { ok: false, error: "bridge_error:未知的 op:encountgrid" });
  const report = await grind(pilot, parseOptions({ until_gold: 1000 }), contextFor(world, []));
  assert.equal(report.battles, 0);
  assert.deepEqual(world.targets, []);
  assert.equal(report.stop, "读不到当前所在的世界地图区域，不能保证留在本区域，先停下");
});

void test("grind refuses a call with no stopping condition", async () => {
  const parsed = parseGrindOptions({});
  if (parsed.ok) assert.fail("a call with no stopping condition should be refused");
  assert.match(parsed.error, /至少给一个停止条件/);

  const directory = await mkdtemp(join(tmpdir(), "ffpr-grind-"));
  try {
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
    });
    const pilot = new FakePilot();
    const text = await game.run("grind", {}, pilot);
    assert.match(text, /^grind 没有执行:至少给一个停止条件/);
    // Task 91 adds one sample read after every tool (the game-over check), but no game op.
    assert.equal(pilot.calls.filter((call) => call.kind === "send").length, 0);
    assert.ok(game.handledTools().includes("grind"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** parseGrindOptions with the defaults the tests do not spell out. */
function parseOptions(args: Record<string, unknown>): {
  untilGold?: number;
  untilLevel?: number;
  untilBestiary?: boolean;
  maxMinutes: number;
  restHpPct: number;
  restMpPct: number;
} {
  const parsed = parseGrindOptions(args);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.options;
}

void test("the grind's single step uses walkpath when the bridge has it", async () => {
  const world = makeWorld();
  const pilot = pilotFor(world);
  pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    const last = path[path.length - 1];
    assert.ok(last);
    world.cell = [last[0], last[1]];
    world.walks += 1;
    pilot.advance(45_000);
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { state: "Player", map: world.map, cell: [world.cell[0], world.cell[1]] },
      next: null,
      turns: [],
    };
  });
  const report = await grind(
    pilot,
    parseOptions({ until_gold: 9999, max_minutes: 1 }),
    contextFor(world, []),
  );
  assert.match(report.stop, /到 1 分钟/);
  const paths = pilot.calls.flatMap((call) => {
    if (call.kind !== "send" || call.op !== "walkpath") return [];
    const path = call.fields.path;
    return Array.isArray(path) ? [path as Cell[]] : [];
  });
  assert.ok(paths.length > 0);
  const path = paths[0];
  assert.ok(path);
  assert.deepEqual(path, [
    [5, 5],
    [6, 5],
  ]);
  assert.ok(!pilot.calls.some((call) => call.kind === "send" && call.op === "walk"));
});

void test("the grind's single step falls back to walk without walkpath", async () => {
  const world = makeWorld();
  const pilot = pilotFor(world);
  const report = await grind(
    pilot,
    parseOptions({ until_gold: 9999, max_minutes: 1 }),
    contextFor(world, []),
  );
  assert.match(report.stop, /到 1 分钟/);
  const ops = pilot.calls.flatMap((call) => (call.kind === "send" ? [call.op] : []));
  assert.ok(ops.includes("walkpath"), "tried walkpath first");
  assert.ok(ops.includes("walk"), "used the old walk after the unsupported answer");
});

void test("a state event in a grind step becomes a battle, not a blocked step", async () => {
  const world = makeWorld();
  const pilot = pilotFor(world);
  let event = false;
  let polls = 0;
  pilot.on("pos", () => {
    if (event) {
      polls += 1;
      if (polls === 1) {
        return { pos: { state: "Event", map: world.map, cell: world.cell } };
      }
      if (polls === 2) {
        return { pos: { state: "Battle", battle: true, map: world.map, cell: world.cell } };
      }
    }
    return { pos: { state: world.state, map: world.map, cell: world.cell } };
  });
  let sent = 0;
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    if (sent === 1) {
      event = true;
      world.walks += 1;
      pilot.advance(45_000);
      return {
        ok: false,
        reason: "state:Event",
        index: 0,
        steps: 1,
        pos: { state: "Event", map: world.map, cell: world.cell },
        next: null,
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    world.cell = [last[0], last[1]];
    pilot.advance(45_000);
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { state: "Player", map: world.map, cell: world.cell },
      next: null,
      turns: [],
    };
  });
  world.fighter = () => {
    event = false;
    world.state = "Player";
    return "按这张地图的策略打完 1 秒";
  };
  const report = await grind(
    pilot,
    parseOptions({ until_gold: 9999, max_minutes: 1 }),
    contextFor(world, []),
  );
  assert.equal(report.battles, 1);
  assert.match(report.stop, /到 1 分钟/);
  assert.doesNotMatch(report.stop, /走不过去/);
});

void test("a brief state event in a grind step replans instead of stopping", async () => {
  const world = makeWorld();
  const pilot = pilotFor(world);
  let sent = 0;
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    if (sent === 1) {
      world.state = "Event";
      pilot.advance(45_000);
      return {
        ok: false,
        reason: "state:Event",
        index: 0,
        steps: 1,
        pos: { state: "Event", map: world.map, cell: world.cell },
        next: null,
        turns: [],
      };
    }
    world.state = "Player";
    const last = path[path.length - 1];
    assert.ok(last);
    world.cell = [last[0], last[1]];
    pilot.advance(45_000);
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { state: "Player", map: world.map, cell: world.cell },
      next: null,
      turns: [],
    };
  });
  pilot.on("pos", () => {
    if (world.state === "Event") world.state = "Player";
    return { pos: { state: world.state, map: world.map, cell: world.cell } };
  });
  const report = await grind(
    pilot,
    parseOptions({ until_gold: 9999, max_minutes: 1 }),
    contextFor(world, []),
  );
  assert.equal(report.battles, 0);
  assert.match(report.stop, /到 1 分钟/);
  assert.doesNotMatch(report.stop, /走不过去/);
  assert.ok(sent >= 2, "walked on after the event");
});

void test("a dialog in a grind step stops with the dialog reason, not 走不过去", async () => {
  const world = makeWorld();
  const pilot = pilotFor(world);
  pilot.on("walkpath", () => ({
    ok: false,
    reason: "dialog",
    index: 0,
    steps: 1,
    pos: { state: "Event", dialog: true, map: world.map, cell: world.cell },
    next: null,
    turns: [],
  }));
  pilot.on("pos", () => ({
    pos: { state: "Event", dialog: true, map: world.map, cell: world.cell },
  }));
  const report = await grind(
    pilot,
    parseOptions({ until_gold: 9999, max_minutes: 1 }),
    contextFor(world, []),
  );
  assert.match(report.stop, /被剧情或对话打断/);
  assert.match(report.stop, /interrupted:dialog/);
  assert.match(report.stop, /翻完剧情再接着刷/);
  assert.doesNotMatch(report.stop, /走不过去/);
});

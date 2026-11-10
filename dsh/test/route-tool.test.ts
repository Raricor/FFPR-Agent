/**
 * Task 89: the `route` tool with a stand-in bridge. The route must finish a stretch in one
 * tool call, page ordinary dialog itself, stop for a choice/countdown/game over, and resume
 * from its progress file after a new engine starts.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import { loadKnowledge } from "../src/engine/knowledge/index.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { readProgress } from "../src/engine/route/state.ts";
import type { StagePlanRecord } from "../src/engine/stage/store.ts";
import type { StagePlan } from "../src/engine/stage/types.ts";
import { record, truthy } from "../src/engine/values.ts";
import { FakeBattle } from "./fake-battle.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

const MAPS = {
  71: { name: "卡纳克城", exits: [{ cell: [5, 5] as Cell, to: 72 }] },
  72: { name: "出口", exits: [] },
} as const;

interface Chest {
  readonly cell: Cell;
  readonly label: string;
}

interface World {
  map: number;
  cell: Cell;
  readonly chests: readonly Chest[];
  readonly opened: Set<string>;
  readonly openedOrder: string[];
  readonly exits: Map<string, number>;
  readonly entries: Map<number, Cell>;
  readonly timer?: { readonly active: boolean; readonly seconds: number | null };
  readonly gameover?: {
    readonly open: boolean;
    readonly prompt?: string;
    readonly cursor?: number;
  };
  choiceOpen: boolean;
  failKeys: number;
  failChest: Cell | null;
  battle?: FakeBattle;
  battleActive: boolean;
  battleSeen: boolean;
  battleCell: Cell | null;
}

function routeWorld(): World {
  const world: World = {
    map: 71,
    cell: [1, 5],
    chests: [
      { cell: [2, 5], label: "宝箱 卡纳克城 (2,5)" },
      { cell: [4, 5], label: "宝箱 卡纳克城 (4,5)" },
    ],
    opened: new Set(),
    openedOrder: [],
    exits: new Map([["71:5,5", 72]]),
    entries: new Map([
      [71, [1, 5]],
      [72, [1, 1]],
    ]),
    choiceOpen: false,
    failKeys: 0,
    failChest: null,
    battleActive: false,
    battleSeen: false,
    battleCell: null,
  };
  return world;
}

function keyOf(cell: Cell): string {
  return `${cell[0]},${cell[1]}`;
}

function position(world: World): Reply {
  const pos: Record<string, unknown> = {
    map: world.map,
    area: world.map,
    areaType: 1,
    areaText: MAPS[world.map as 71 | 72].name,
    state: world.battleActive ? "Battle" : "Player",
    cell: world.cell,
    saves: 1,
    battle: world.battleActive,
  };
  if (world.timer !== undefined) pos.timer = world.timer;
  if (world.gameover !== undefined) pos.gameover = world.gameover;
  return { pos };
}

function entities(world: World, kind: string): Reply[] {
  const out: Reply[] = world.chests.map((chest) => ({
    kind: "TresureBox",
    cell: chest.cell,
    contentName: chest.label,
    opened: world.opened.has(keyOf(chest.cell)),
  }));
  for (const [key, to] of world.exits) {
    const [map, cell] = key.split(":");
    const [x, y] = (cell ?? "0,0").split(",");
    if (Number(map) === world.map)
      out.push({ kind: "GotoMap", cell: [Number(x), Number(y)], toMap: to });
  }
  return out.filter((entity) => kind === "All" || entity.kind === kind);
}

function pilotFor(world: World): FakePilot {
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
  pilot.on("entities", (fields) => ({
    entities: {
      total: entities(world, String(fields.kind)).length,
      entities: entities(world, String(fields.kind)),
    },
  }));
  pilot.on("route", { route: {} });
  // The fake bridge 0.13.x fallback: one closed-loop walk per cell.
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target", ...position(world) };
    }
    if (world.battleActive) {
      return { ok: false, ...position(world) };
    }
    world.cell = [to[0], to[1]];
    if (
      world.battle !== undefined &&
      world.battleCell !== null &&
      keyOf(world.cell) === keyOf(world.battleCell) &&
      !world.battleSeen
    ) {
      world.battleSeen = true;
      world.battleActive = true;
      return { ok: false, ...position(world) };
    }
    const exit = world.exits.get(`${world.map}:${keyOf(world.cell)}`);
    if (exit !== undefined) {
      world.map = exit;
      world.cell = world.entries.get(exit) ?? [1, 1];
    }
    return { ok: true, ...position(world) };
  });
  pilot.on("keys", (fields) => {
    if (world.battleActive && world.battle !== undefined) {
      return world.battle.pilot.send("keys", fields);
    }
    const keys = Array.isArray(fields.keys) ? fields.keys : [];
    if (keys.some((key) => key === "Enter")) {
      const target = world.chests.find(
        (chest) =>
          !world.opened.has(keyOf(chest.cell)) &&
          Math.abs(chest.cell[0] - world.cell[0]) + Math.abs(chest.cell[1] - world.cell[1]) === 1,
      );
      if (
        target !== undefined &&
        world.failChest !== null &&
        world.failKeys > 0 &&
        keyOf(target.cell) === keyOf(world.failChest)
      ) {
        world.failKeys -= 1;
        return { ok: false, error: "input blocked" };
      }
      if (target !== undefined) {
        world.opened.add(keyOf(target.cell));
        world.openedOrder.push(keyOf(target.cell));
      }
    }
    return { ok: true };
  });
  pilot.on("story", { pages: 2, stop: "free" });
  if (world.battle !== undefined) {
    const battle = world.battle;
    pilot.onQuery("battlemenu", async () => {
      const reply = await battle.pilot.query("battlemenu");
      if (!truthy(record(reply.battlemenu).battle)) world.battleActive = false;
      return reply;
    });
    pilot.onQuery("items", async () => await battle.pilot.query("items"));
  }
  pilot.on("wait", { ok: true });
  pilot.onQuery("textinput", { textinput: { open: false } });
  pilot.onQuery("items", { items: { normal: [], important: [] } });
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
  pilot.onQuery("sample", () => {
    const sample: Record<string, unknown> = {
      user: { mapId: world.map, areaText: MAPS[world.map as 71 | 72].name },
      party: [],
      field: { moveState: "Walk" },
    };
    if (world.battleActive && world.battle !== undefined) {
      sample.battle = {
        active: true,
        boss: false,
        notEscape: false,
        enemies: world.battle.enemies,
        party: world.battle.party,
      };
    }
    if (world.choiceOpen)
      sample.choice = { main: { open: true, options: ["是", "否"], cursor: 0 } };
    if (world.timer !== undefined) sample.timer = world.timer;
    if (world.gameover !== undefined) sample.gameover = world.gameover;
    return { sample };
  });
  return pilot;
}

async function makeGame(
  directory: string,
  options: {
    readonly stageGoFollowPlan?: boolean;
    readonly stageContinueAfterTravel?: boolean;
  } = {},
): Promise<Game> {
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
    routeFile: join(directory, "route-ff5.json"),
    // An empty knowledge home in the temp dir: without it the stage layer loads the dev box's
    // real .deps/knowledge, where maps 71/72 are real places and the plan checks change.
    knowledge: await loadKnowledge({
      game: "ff5",
      home: join(directory, "knowledge"),
      atlas: null,
      collisions: null,
      bestiarySave: null,
      atlasSave: null,
    }),
    stageGoFollowPlan: options.stageGoFollowPlan ?? true,
    stageContinueAfterTravel: options.stageContinueAfterTravel ?? true,
  });
  game.atlas.maps.clear();
  for (const [key, map] of Object.entries(MAPS)) {
    game.atlas.maps.set(key, {
      name: map.name,
      exits: map.exits.map((exit) => ({ cell: exit.cell, to: exit.to, name: "" })),
      chests: [],
    });
  }
  // The analyzer uses cached collision for same-map walks; seed a plain 20x20 room.
  const collision = {
    searchLayer: 1,
    playerCell: [1, 5] as Cell,
    layers: [{ name: "GroundCollision", rows: Array.from({ length: 20 }, () => "0".repeat(20)) }],
  };
  await game.collisions.remember(71, collision);
  await game.collisions.remember(72, collision);
  // The after-tool reads are not under test; keep them deterministic.
  game.settle = () => Promise.resolve("");
  game.observe = () => Promise.resolve("状态好");
  return game;
}

async function inTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-route-tool-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("three stops walk in order, open both chests, reach the exit and never ask the AI", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const game = await makeGame(dir);
    const result = await game.run(
      "route",
      {
        stops: [
          { to: "2,5", do: "open" },
          { to: "71:4,5", do: "open" },
        ],
        end: 72,
      },
      pilotFor(world),
    );
    assert.match(result, /完成/);
    assert.match(result, /宝箱/);
    assert.match(result, /终点/);
    assert.deepEqual(world.openedOrder, ["2,5", "4,5"]);
    assert.equal(world.map, 72);
    assert.equal(result.includes("交给 AI"), false);
  });
});

void test("ordinary dialog pages itself and the route walks on to the exit", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const pilot = pilotFor(world);
    const game = await makeGame(dir);
    const result = await game.run(
      "route",
      { stops: [{ to: "8,8", do: "talk" }], end: [9, 8] },
      pilot,
    );
    assert.match(result, /完成/);
    assert.deepEqual(world.cell, [9, 8]);
    assert.equal(world.map, 71);
    assert.ok(pilot.calls.some((call) => call.kind === "send" && call.op === "story"));
  });
});

void test("a road battle is fought by the route and the walk continues to the end", async () => {
  await inTemp(async (dir) => {
    const base = routeWorld();
    const battle = new FakeBattle({
      party: [
        { name: "巴兹", hp: 100, maxHp: 100, mp: 0, status: [] },
        { name: "蕾娜", hp: 80, maxHp: 80, mp: 10, status: [] },
      ],
      enemies: [{ name: "哥布林", id: 1, hp: 10, maxHp: 10 }],
      maxTurns: 2,
    });
    const world: World = {
      ...base,
      chests: [],
      battle,
      battleCell: [4, 5],
      opened: new Set(),
      openedOrder: [],
    };
    const game = await makeGame(dir);
    const battlePilot = pilotFor(world);
    const result = await game.run("route", { end: [4, 4] }, battlePilot);
    assert.match(result, /完成/);
    assert.ok(battle.actions.length > 0);
    assert.deepEqual(world.cell, [4, 4]);
    assert.equal(world.battleActive, false);
  });
});

void test("a story choice stops the route and hands it back without choosing", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    world.choiceOpen = true;
    const pilot = pilotFor(world);
    const game = await makeGame(dir);
    const result = await game.run(
      "route",
      { stops: [{ to: "8,8", do: "talk" }], end: [9, 8] },
      pilot,
    );
    assert.match(result, /剧情选项/);
    assert.match(result, /停下/);
    assert.equal(world.map, 71);
    assert.equal(world.opened.size, 0);
    // The interact's own Enter is fine; no choose follows it, and the end is not walked.
    assert.notDeepEqual(world.cell, [9, 8]);
  });
});

void test("a short countdown skips the optional chest, goes to the exit and records the debt", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const timed: World = { ...world, timer: { active: true, seconds: 5 } };
    const game = await makeGame(dir);
    const result = await game.run(
      "route",
      { stops: [{ to: "2,5", do: "open" }], end: 72 },
      pilotFor(timed),
    );
    assert.match(result, /跳过/);
    assert.match(result, /倒计时剩 5 秒/);
    assert.match(result, /完成/);
    assert.equal(timed.map, 72);
    assert.equal(timed.opened.size, 0);
    const debt = game.backlog.pending()[0];
    assert.ok(debt !== undefined);
    assert.match(debt.missing.join("、"), /宝箱/);
  });
});

void test("leaving an incomplete map during the countdown is not blocked by completion", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const timed: World = { ...world, timer: { active: true, seconds: 5 } };
    const game = await makeGame(dir);
    const result = await game.run(
      "route",
      { stops: [{ to: "4,5", do: "open" }], end: 72 },
      pilotFor(timed),
    );
    assert.match(result, /跳过/);
    assert.equal(timed.map, 72);
    assert.equal(result.includes("还没完成"), false);
  });
});

void test("a game-over popup stops the route and hands off to the recovery flow", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const over: World = {
      ...world,
      // No chest next to the start: task 91's recovery presses Enter on the checked popup.
      chests: [{ cell: [4, 5], label: "宝箱 卡纳克城 (4,5)" }],
      gameover: { open: true, prompt: "to-title", cursor: 0 },
    };
    const pilot = pilotFor(over);
    const game = await makeGame(dir);
    const result = await game.run("route", { stops: [{ to: "2,5", do: "open" }], end: 72 }, pilot);
    assert.match(result, /游戏结束了/);
    assert.match(result, /回到标题/);
    // Task 91: the popup is now handled, not left to the model; this stand-in has no title or
    // save list, so the recovery reports what it could not read after its first checked key.
    assert.match(result, /游戏结束处理停下/);
    assert.ok(pilot.keys().length > 0);
    assert.equal(over.map, 71);
    assert.equal(over.opened.size, 0);
  });
});

void test("an old bridge without timer or gameover fields still runs the route", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const pilot = pilotFor(world);
    const game = await makeGame(dir);
    const result = await game.run(
      "route",
      {
        stops: [
          { to: "2,5", do: "open" },
          { to: "4,5", do: "open" },
        ],
        end: 72,
      },
      pilot,
    );
    assert.match(result, /完成/);
    assert.equal(world.map, 72);
    assert.equal(world.opened.size, 2);
  });
});

void test("the progress file resumes the rest of the route in a new engine", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    world.failKeys = 2;
    world.failChest = [4, 5];
    const first = await makeGame(dir);
    const failed = await first.run(
      "route",
      {
        stops: [
          { to: "2,5", do: "open" },
          { to: "4,5", do: "open" },
        ],
        end: 72,
      },
      pilotFor(world),
    );
    assert.match(failed, /停下/);
    assert.equal(world.map, 71);
    assert.deepEqual([...world.opened], ["2,5"]);
    const saved = await readProgress(join(dir, "route-ff5.json"));
    assert.equal(saved.next, 1);
    assert.deepEqual(saved.completed, ["s1"]);

    world.failKeys = 0;
    const second = await makeGame(dir);
    const resumed = await second.run("route", {}, pilotFor(world));
    assert.match(resumed, /完成/);
    assert.deepEqual([...world.opened].sort(), ["2,5", "4,5"]);
    assert.equal(world.map, 72);
  });
});

function stageRecord(route: StagePlan["route"]): StagePlanRecord {
  return {
    target: { mapId: 71, areaName: "卡纳克", label: "卡纳克城" },
    plan: {
      threats: [],
      supplies: [],
      spells: [],
      gear: [],
      jobs: [],
      minLevel: null,
      route,
      turnBack: [],
      notes: "",
    },
    createdAt: "2026-11-10T00:00:00.000Z",
    status: "departed",
    startMapId: 71,
    startLabel: "卡纳克城",
  };
}

void test("route() without progress starts from the active stage plan's route", async () => {
  await inTemp(async (dir) => {
    const base = routeWorld();
    const world: World = {
      ...base,
      chests: base.chests.filter((chest) => keyOf(chest.cell) === "4,5"),
    };
    const game = await makeGame(dir);
    await game.stagePlans.save(stageRecord([{ to: "4,5", do: "open" }, { to: "72" }]));
    const result = await game.run("route", {}, pilotFor(world));
    assert.match(result, /完成/);
    assert.deepEqual(world.openedOrder, ["4,5"]);
    assert.equal(world.map, 72);
    const progress = await readProgress(join(dir, "route-ff5.json"));
    assert.ok(progress.completed.includes("s1"));
  });
});

void test("a cross-map map:cell go is allowed only at an exact plan waypoint", async () => {
  await inTemp(async (dir) => {
    const game = await makeGame(dir);
    await game.stagePlans.save(stageRecord([{ to: "72:2,2" }]));
    const world: World = { ...routeWorld(), chests: [] };
    const result = await game.run("go", { to: "72:2,2" }, pilotFor(world));
    assert.doesNotMatch(result, /阶段计划拦下/);
    assert.equal(world.map, 72);
    assert.deepEqual(world.cell, [2, 2]);
  });
  await inTemp(async (dir) => {
    const game = await makeGame(dir, { stageGoFollowPlan: false });
    await game.stagePlans.save(stageRecord([{ to: "72:2,2" }]));
    const world: World = { ...routeWorld(), chests: [] };
    const result = await game.run("go", { to: "72:9,9" }, pilotFor(world));
    assert.match(result, /阶段计划拦下/);
    assert.equal(world.map, 71);
  });
});

void test("a refused coordinate go follows the stage plan and records its stats", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const game = await makeGame(dir);
    await game.stagePlans.save(stageRecord([{ to: "71:2,5", do: "open" }]));
    const lines: string[] = [];
    game.onActivity = (message) => lines.push(message);
    const result = await game.run("go", { to: [9, 9] }, pilotFor(world));
    assert.match(result, /^这个坐标不在阶段计划里，代码按计划接着走了/);
    assert.match(result, /leave_incomplete/);
    assert.deepEqual(world.openedOrder, ["2,5"]);
    assert.equal(game.stagePlan()?.status, "completed");
    assert.equal(game.stagePlan()?.stats?.go, 1);
    assert.equal(game.stagePlan()?.stats?.stops, 1);
    assert.ok(
      lines.some((line) =>
        line.includes("阶段统计「卡纳克城」:工具 1 次(go 1、route 0),按计划走了 1 站，用时 0 分"),
      ),
      lines.join("\n"),
    );
  });
});

void test("the coordinate gate keeps its old refusal when following the plan is off", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const game = await makeGame(dir, { stageGoFollowPlan: false });
    await game.stagePlans.save(stageRecord([{ to: "71:2,5", do: "open" }]));
    const result = await game.run("go", { to: [9, 9] }, pilotFor(world));
    assert.match(result, /阶段计划拦下/);
    assert.equal(world.openedOrder.length, 0);
    assert.deepEqual(world.cell, [1, 5]);
  });
});

void test("leave_incomplete still walks the coordinate instead of the plan", async () => {
  await inTemp(async (dir) => {
    const world = routeWorld();
    const game = await makeGame(dir);
    await game.stagePlans.save(stageRecord([{ to: "71:2,5", do: "open" }]));
    const result = await game.run(
      "go",
      { to: [9, 9], leave_incomplete: "要先踩这个触发格" },
      pilotFor(world),
    );
    assert.doesNotMatch(result, /代码按计划接着走了/);
    assert.deepEqual(world.cell, [9, 9]);
    assert.equal(world.openedOrder.length, 0);
  });
});

void test("a named go that reaches the plan's map keeps walking the plan in the same call", async () => {
  await inTemp(async (dir) => {
    const world: World = { ...routeWorld(), chests: [], opened: new Set(), openedOrder: [] };
    const game = await makeGame(dir);
    await game.stagePlans.save({
      ...stageRecord([{ to: "72:2,2" }, { to: "72:3,3" }]),
      target: { mapId: 72, areaName: "出口", label: "出口" },
    });
    const result = await game.run("go", { to: 72 }, pilotFor(world));
    assert.match(result, /代码接着按计划走/);
    assert.deepEqual(world.cell, [3, 3]);
    assert.equal(world.map, 72);
    assert.equal(game.stagePlan()?.stats?.stops, 1);
  });
});

void test("arriving with the continue switch off returns at the destination", async () => {
  await inTemp(async (dir) => {
    const world: World = { ...routeWorld(), chests: [], opened: new Set(), openedOrder: [] };
    const game = await makeGame(dir, { stageContinueAfterTravel: false });
    await game.stagePlans.save({
      ...stageRecord([{ to: "72:2,2" }, { to: "72:3,3" }]),
      target: { mapId: 72, areaName: "出口", label: "出口" },
    });
    const result = await game.run("go", { to: 72 }, pilotFor(world));
    assert.doesNotMatch(result, /代码接着按计划走/);
    assert.equal(world.map, 72);
    assert.deepEqual(world.cell, [1, 1]);
  });
});

void test("a story choice after the arrival makes the plan walk return early", async () => {
  await inTemp(async (dir) => {
    const world: World = { ...routeWorld(), chests: [], choiceOpen: true };
    const game = await makeGame(dir);
    await game.stagePlans.save({
      ...stageRecord([{ to: "72:8,8", do: "talk" }]),
      target: { mapId: 72, areaName: "出口", label: "出口" },
    });
    const result = await game.run("go", { to: 72 }, pilotFor(world));
    assert.match(result, /剧情选项/);
    assert.match(result, /停下/);
    assert.equal(world.map, 72);
    assert.notDeepEqual(world.cell, [8, 8]);
  });
});

void test("a coordinate go on an entrance arrives there and keeps walking the plan", async () => {
  await inTemp(async (dir) => {
    const world: World = { ...routeWorld(), chests: [], opened: new Set(), openedOrder: [] };
    const game = await makeGame(dir);
    await game.stagePlans.save({
      ...stageRecord([{ to: "72:2,2" }, { to: "72:3,3" }]),
      target: { mapId: 72, areaName: "出口", label: "出口" },
    });
    const internal = game as unknown as {
      goCell: (args: unknown, pilot: unknown, cell: Cell) => Promise<{ text: string }>;
    };
    const original = internal.goCell.bind(game);
    let stepped: Cell | null = null;
    internal.goCell = async (args, pilot, cell) => {
      if (world.map === 71 && cell[0] === 5 && cell[1] === 5) {
        stepped = cell;
        world.map = 72;
        world.cell = [1, 1];
        return { text: "踩进入口" };
      }
      return await original(args, pilot, cell);
    };
    const result = await game.run("go", { to: [5, 5] }, pilotFor(world));
    assert.deepEqual(stepped, [5, 5]);
    assert.equal(world.map, 72);
    assert.deepEqual(world.cell, [3, 3]);
    assert.match(result, /踩进入口/);
    assert.match(result, /代码接着按计划走/);
  });
});

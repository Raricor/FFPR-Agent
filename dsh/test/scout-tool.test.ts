/**
 * Task 105: the scout tool end to end with a stand-in bridge/pilot. It saves slot 20, snapshots
 * this save's progress, scouts the map records, loads slot 20 back and restores the files.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BattleLog } from "../src/engine/battle-record.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import { ScoutWindows, scoutWindowsFile } from "../src/engine/scout/snapshot.ts";
import { record, truthy } from "../src/engine/values.ts";
import { FakeBattle } from "./fake-battle.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

const MAPS = {
  70: {
    name: "别处",
    exits: [{ cell: [0, 0] as Cell, to: 72, land: [1, 1] as Cell }],
  },
  71: { name: "瓦尔斯塔 入口", exits: [{ cell: [5, 5] as Cell, to: 72 }] },
  72: { name: "瓦尔斯塔 内层", exits: [] },
} as const;

const COMMANDS = ["Item", "Magic", "Save", "Load"];
const SLOTS = Array.from({ length: 20 }, (_, index) => index + 1);

interface World {
  map: number;
  cell: Cell;
  saves: number;
  stage: "idle" | "menu" | "savelist" | "loadlist" | "confirm-load" | "loading";
  menuCursor: number;
  listCursor: number;
  saveOk: boolean;
  loadOk: boolean;
  loadSlots: number[];
  loadingAt: number;
  saved: { map: number; cell: Cell; saves: number } | null;
  timer?: { active: boolean; seconds: number | null };
  gameover?: { open: boolean; prompt?: string; cursor?: number };
  battle?: FakeBattle;
  battleActive: boolean;
  battleSeen: boolean;
  battleCell: Cell | null;
}

function worldOf(): World {
  return {
    map: 71,
    cell: [1, 1],
    saves: 1,
    stage: "idle",
    menuCursor: 0,
    listCursor: 0,
    saveOk: true,
    loadOk: true,
    loadSlots: [...SLOTS],
    loadingAt: 0,
    saved: null,
    battleActive: false,
    battleSeen: false,
    battleCell: [3, 1],
  };
}

function keyOf(cell: Cell): string {
  return `${cell[0]},${cell[1]}`;
}

function expandKeys(fields: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(fields.keys) ? fields.keys : []) {
    if (typeof raw !== "string") continue;
    const match = /^([A-Za-z0-9]+)\*(\d+)$/u.exec(raw);
    const key = match?.[1];
    const count = match?.[2];
    if (key !== undefined && count !== undefined) {
      for (let i = 0; i < Number(count); i++) out.push(key);
    } else {
      out.push(raw);
    }
  }
  return out;
}

function position(world: World): Reply {
  const state = world.battleActive
    ? "Battle"
    : world.stage === "idle"
      ? "Player"
      : world.stage === "menu"
        ? "Menu"
        : "Event";
  const pos: Record<string, unknown> = {
    map: world.map,
    area: world.map,
    areaType: 1,
    areaText: MAPS[world.map as 70 | 71 | 72].name,
    state,
    cell: world.cell,
    saves: world.saves,
    battle: world.battleActive,
  };
  if (world.timer !== undefined) pos.timer = world.timer;
  if (world.gameover !== undefined) pos.gameover = world.gameover;
  return { pos };
}

function pilotFor(world: World): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => {
    if (world.stage === "loading" && pilot.now() >= world.loadingAt && world.saved !== null) {
      world.map = world.saved.map;
      world.cell = world.saved.cell;
      world.saves = world.saved.saves;
      world.stage = "idle";
    }
    return position(world);
  });
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
      layers: [
        {
          name: "GroundCollision",
          rows: Array.from({ length: 20 }, () => "0".repeat(20)),
        },
      ],
    },
  }));
  pilot.on("entities", (fields) => {
    const all: Reply[] =
      world.map === 71
        ? [
            { kind: "GotoMap", cell: [5, 5], toMap: 72, name: "出口" },
            {
              kind: "TresureBox",
              cell: [9, 9],
              opened: false,
              contentName: "宝箱",
            },
          ]
        : [];
    return {
      entities: {
        total: all.length,
        entities: all.filter((entity) => fields.kind === "All" || entity.kind === fields.kind),
      },
    };
  });
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target", ...position(world) };
    }
    if (world.battleActive) return { ok: false, ...position(world) };
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
    if (world.map === 71 && keyOf(world.cell) === "5,5") {
      world.map = 72;
      world.cell = [1, 1];
    }
    return { ok: true, ...position(world) };
  });
  pilot.on("hold", async (fields) =>
    world.battle === undefined ? { ok: true } : await world.battle.pilot.send("hold", fields),
  );
  pilot.on("stop", async (fields) =>
    world.battle === undefined ? { ok: true } : await world.battle.pilot.send("stop", fields),
  );
  pilot.on("leave", () => {
    world.stage = "idle";
    return { ok: true, presses: 1 };
  });
  pilot.on("keys", (fields) => {
    if (world.battleActive && world.battle !== undefined) {
      return world.battle.pilot.send("keys", fields);
    }
    for (const key of expandKeys(fields)) {
      if (key === "Tab" && world.stage === "idle") {
        world.stage = "menu";
        world.menuCursor = 0;
      } else if (key === "Down" || key === "Up") {
        const delta = key === "Down" ? 1 : -1;
        if (world.stage === "menu") {
          world.menuCursor = Math.max(0, Math.min(COMMANDS.length - 1, world.menuCursor + delta));
        } else if (world.stage === "savelist" || world.stage === "loadlist") {
          const slots = world.stage === "savelist" ? SLOTS : world.loadSlots;
          world.listCursor = Math.max(0, Math.min(slots.length - 1, world.listCursor + delta));
        }
      } else if (key === "Enter") {
        if (world.stage === "menu") {
          const command = COMMANDS[world.menuCursor];
          if (command === "Save" && world.saveOk) {
            world.stage = "savelist";
            world.listCursor = 0;
          } else if (command === "Load" && world.loadOk) {
            world.stage = "loadlist";
            world.listCursor = 0;
          }
        } else if (world.stage === "savelist") {
          if (world.listCursor === 19) {
            world.saves += 1;
            world.saved = {
              map: world.map,
              cell: world.cell,
              saves: world.saves,
            };
            world.stage = "menu";
          }
        } else if (world.stage === "loadlist") {
          if (world.loadSlots[world.listCursor] === 20) world.stage = "confirm-load";
        } else if (world.stage === "confirm-load") {
          world.stage = "loading";
          world.loadingAt = pilot.now() + 500;
        }
      }
    }
    return { ok: true };
  });
  pilot.onQuery("menu", () => ({
    menu:
      world.stage === "menu"
        ? {
            open: true,
            commands: COMMANDS.map((id) => ({
              id,
              enabled: id === "Save" ? world.saveOk : id === "Load" ? world.loadOk : true,
            })),
            cursor: world.menuCursor,
          }
        : { open: false },
  }));
  pilot.onQuery("saveui", () => {
    const open =
      world.stage === "savelist" || world.stage === "loadlist" || world.stage === "confirm-load";
    const slots =
      world.stage === "savelist" || world.stage === "confirm-load" ? SLOTS : world.loadSlots;
    return {
      saveui: {
        open,
        cursor: open ? world.listCursor : null,
        current: open ? slots[world.listCursor] : null,
        slots: open ? slots : [],
      },
    };
  });
  pilot.on("story", { pages: 2, stop: "free" });
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
    encounters: {
      monsterSet: null,
      parties: [],
      region: null,
      regions: [],
      enabled: false,
    },
  });
  pilot.onQuery("sample", () => {
    const sample: Record<string, unknown> = {
      user: {
        mapId: world.map,
        areaText: MAPS[world.map as 70 | 71 | 72].name,
      },
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
    if (world.timer !== undefined) sample.timer = world.timer;
    if (world.gameover !== undefined) sample.gameover = world.gameover;
    return { sample };
  });
  if (world.battle !== undefined) {
    const battle = world.battle;
    pilot.onQuery("battlemenu", async () => {
      const reply = await battle.pilot.query("battlemenu");
      if (!truthy(record(reply.battlemenu).battle)) world.battleActive = false;
      return reply;
    });
    pilot.onQuery("items", async () => await battle.pilot.query("items"));
  }
  return pilot;
}

async function makeGame(directory: string): Promise<Game> {
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    notesFile: join(directory, "notes-ff5.json"),
    atlasFile: join(directory, "atlas-ff5.json"),
    atlasSaveFile: join(directory, "atlas-save-ff5.json"),
    tacticsFile: join(directory, "tactics-ff5.json"),
    elementsFile: join(directory, "elements-ff5.json"),
    battlesFile: join(directory, "battles-ff5.jsonl"),
    backlogFile: join(directory, "backlog-ff5.jsonl"),
    incidentsFile: join(directory, "incidents-ff5.jsonl"),
    incidentsStateFile: join(directory, "incidents-state-ff5.json"),
    bestiarySaveFile: join(directory, "bestiary-save-ff5.json"),
    routeFile: join(directory, "route-ff5.json"),
    stagePlanFile: join(directory, "stage-ff5.json"),
    scoutDir: directory,
    scoutMinutes: 20,
  });
  game.atlas.maps.clear();
  for (const [key, map] of Object.entries(MAPS)) {
    game.atlas.maps.set(key, {
      name: map.name,
      exits: map.exits.map((exit) => ({
        cell: exit.cell,
        to: exit.to,
        name: "",
        ...("land" in exit ? { land: exit.land } : {}),
      })),
      chests: [],
    });
  }
  const collision = {
    searchLayer: 1,
    playerCell: [1, 1] as Cell,
    layers: [
      {
        name: "GroundCollision",
        rows: Array.from({ length: 20 }, () => "0".repeat(20)),
      },
    ],
  };
  await game.collisions.remember(70, collision);
  await game.collisions.remember(71, collision);
  await game.collisions.remember(72, collision);
  // A one-off blocked step on the second map, the second scout target.
  await game.atlas.link(72, [2, 1], [2, 2], "走不过去");
  game.settle = () => Promise.resolve("");
  game.observe = () => Promise.resolve("状态好");
  return game;
}

async function inTemp(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-scout-tool-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("a full scout saves, scouts two targets (one battle flees), loads slot 20 and restores progress", async () => {
  await inTemp(async (directory) => {
    const world = worldOf();
    world.battle = new FakeBattle({
      party: [
        { name: "巴兹", hp: 100, maxHp: 100, mp: 0, status: [] },
        { name: "蕾娜", hp: 80, maxHp: 80, mp: 10, status: [] },
      ],
      enemies: [{ name: "哥布林", id: 1, hp: 10, maxHp: 10 }],
      maxTurns: 2,
      fleeAfterMs: 100,
    });
    const game = await makeGame(directory);
    const pilot = pilotFor(world);
    const result = await game.run("scout", { area: "瓦尔斯塔", minutes: 20 }, pilot);
    assert.match(result, /侦察结束/u);
    assert.match(result, /落点/u);
    assert.match(result, /验证掉 1 条/u);
    assert.match(result, /已还原/u);
    assert.equal(world.saves, 2);
    assert.equal(world.map, 71);
    assert.deepEqual(world.cell, [1, 1]);
    // Map structure kept: the exit now has its landing and the one-off block was forgotten.
    const exit = (game.atlas.maps.get("71")?.exits as { land?: Cell }[] | undefined)?.[0];
    assert.deepEqual(exit?.land, [1, 1]);
    assert.equal(
      game.atlas.moves(72).some((move) => move.how === "走不过去"),
      false,
    );
    assert.ok(pilot.keys().some((keys) => keys.includes("Left") && keys.includes("Enter")));
    assert.equal(world.battleSeen, true);
    assert.equal(world.battleActive, false);
    assert.ok(pilot.calls.some((call) => call.kind === "send" && call.op === "hold"));
    assert.ok(game.handledTools().includes("scout"));
    // The save-local files are byte-for-byte the snapshot's copies.
    const scoutDirs = await readdir(join(directory, "scout"));
    assert.equal(scoutDirs.length, 1);
    const snapshotDir = join(directory, "scout", scoutDirs[0] ?? "");
    const manifest = JSON.parse(await readFile(join(snapshotDir, "manifest.json"), "utf8")) as {
      files: { path: string; backup: string | null; exists: boolean }[];
    };
    for (const entry of manifest.files) {
      if (!entry.exists || entry.backup === null) continue;
      const target = entry.path.startsWith("/") ? entry.path : join(directory, entry.path);
      assert.deepEqual(
        await readFile(target),
        await readFile(join(snapshotDir, entry.backup)),
        `${entry.path} 没有还原`,
      );
    }
    const windows = JSON.parse(await readFile(scoutWindowsFile("ff5", directory), "utf8")) as {
      windows: { start: string; end?: string }[];
    };
    assert.equal(windows.windows.length, 1);
    assert.ok(windows.windows[0]?.end !== undefined);
  });
});

void test("save_game is refused while a scout is running", async () => {
  await inTemp(async (directory) => {
    const world = worldOf();
    const game = await makeGame(directory);
    (game as unknown as { scouting: boolean }).scouting = true;
    const pilot = pilotFor(world);
    const result = await game.run("save_game", {}, pilot);
    assert.match(result, /侦察进行中不能存档/u);
    assert.equal(world.saves, 1);
    assert.deepEqual(pilot.keys(), []);
  });
});

void test("an active countdown refuses the scout before any key", async () => {
  await inTemp(async (directory) => {
    const world = worldOf();
    world.timer = { active: true, seconds: 120 };
    const game = await makeGame(directory);
    const pilot = pilotFor(world);
    const result = await game.run("scout", {}, pilot);
    assert.match(result, /倒计时进行中/u);
    assert.match(result, /不能开始侦察/u);
    assert.deepEqual(pilot.keys(), []);
    await assert.rejects(readdir(join(directory, "scout")));
  });
});

void test("a place that cannot save refuses the scout and writes no snapshot", async () => {
  await inTemp(async (directory) => {
    const world = worldOf();
    world.saveOk = false;
    const game = await makeGame(directory);
    const result = await game.run("scout", {}, pilotFor(world));
    assert.match(result, /侦察没有开始/u);
    assert.match(result, /不能存档/u);
    assert.equal(world.saves, 1);
    await assert.rejects(readdir(join(directory, "scout")));
  });
});

void test("a game over mid-scout goes back to slot 20, restores and reports", async () => {
  await inTemp(async (directory) => {
    const world = worldOf();
    const game = await makeGame(directory);
    let recovered = 0;
    (
      game as unknown as {
        recoverScoutGameover: (pilot: FakePilot) => Promise<{ ok: boolean; text: string } | null>;
      }
    ).recoverScoutGameover = () => {
      recovered += 1;
      world.map = 71;
      world.cell = [1, 1];
      world.gameover = undefined;
      return Promise.resolve({
        ok: true,
        text: "游戏结束了(测试),已回标题读 20 号位第 2 次存档",
      });
    };
    // The route watcher sees the popup before the first target.
    world.gameover = { open: true, prompt: "to-title", cursor: 0 };
    const result = await game.run("scout", { area: "瓦尔斯塔" }, pilotFor(world));
    assert.equal(recovered, 1);
    assert.match(result, /侦察中游戏结束/u);
    assert.match(result, /已还原/u);
    assert.equal(world.map, 71);
  });
});

void test("a failed load does not restore the snapshot and says the state is now mismatched", async () => {
  await inTemp(async (directory) => {
    const world = worldOf();
    world.loadSlots = Array.from({ length: 19 }, (_, index) => index + 1);
    const game = await makeGame(directory);
    const result = await game.run("scout", { area: "瓦尔斯塔" }, pilotFor(world));
    assert.match(result, /读档失败/u);
    assert.match(result, /快照没有还原/u);
    const saved = JSON.parse(await readFile(join(directory, "atlas-save-ff5.json"), "utf8")) as {
      live: { maps: number[] };
    };
    assert.ok(saved.live.maps.includes(72), "侦察期间的本档进度应该还在文件里");
  });
});

void test("battles inside a scout window are not counted back into the save's bestiary", async () => {
  await inTemp(async (directory) => {
    const windows = await ScoutWindows.load("ff5", scoutWindowsFile("ff5", directory));
    await windows.begin("2026-11-10T01:00:00.000Z");
    await windows.end("2026-11-10T02:00:00.000Z");
    const battlesFile = join(directory, "battles-ff5.jsonl");
    const log = await BattleLog.load("ff5", battlesFile);
    for (const [at, book] of [
      ["2026-11-10T01:10:00.000Z", 2],
      ["2026-11-10T03:00:00.000Z", 3],
    ] as const) {
      const session = log.start({
        mapId: 72,
        mapName: "瓦尔斯塔 内层",
        boss: false,
        enemies: [
          {
            name: `怪${book}`,
            id: book,
            book,
            maxHp: 10,
            hp: 0,
            mp: null,
            status: [],
            boss: false,
          },
        ],
        party: [
          {
            name: "巴兹",
            id: null,
            maxHp: 100,
            hp: 90,
            mp: 10,
            status: [],
            boss: false,
          },
        ],
        table: { kind: "map", mapId: 72, table: 1 },
        startedAt: at,
        startedMs: 0,
      });
      await session.finish(1000, "ok", "");
    }
    await writeFile(
      join(directory, "bestiary-save-ff5.json"),
      JSON.stringify({
        game: "ff5",
        snapshots: { "5": { at: "2026-11-10T00:00:00.000Z", numbers: [1] } },
      }) + "\n",
      "utf8",
    );
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      battlesFile,
      bestiarySaveFile: join(directory, "bestiary-save-ff5.json"),
      atlasFile: join(directory, "atlas-ff5.json"),
      atlasSaveFile: join(directory, "atlas-save-ff5.json"),
      elementsFile: join(directory, "elements-ff5.json"),
      tacticsFile: join(directory, "tactics-ff5.json"),
      scoutDir: directory,
    });
    const pilot = new FakePilot();
    pilot.on("pos", {
      pos: { state: "Player", map: 71, cell: [1, 1], saves: 5 },
    });
    pilot.onQuery("achievements", {
      achievements: {
        defs: [],
        save: {
          playTime: 1,
          saveCount: 5,
          chests: 0,
          hiddenItems: 0,
          treasure: [],
          members: [],
          flags: {},
        },
        bestiary: null,
      },
    });
    await game.captureBestiary(pilot);
    assert.equal(game.bestiary.has(1), true);
    assert.equal(game.bestiary.has(3), true);
    assert.equal(game.bestiary.has(2), false);
  });
});

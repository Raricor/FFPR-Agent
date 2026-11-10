import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import {
  parseGameoverInfo,
  readGameover,
  recoverFromGameover,
} from "../src/engine/skills/gameover.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

type Stage = "continue" | "to-title" | "title" | "saveui" | "confirm" | "loaded";

interface World {
  stage: Stage;
  gameoverCursor: number | null;
  titleCursor: number;
  saveCursor: number;
  /** Let the Down key move the continue cursor; false simulates a wrong reading. */
  cursorMoves: boolean;
}

const SLOTS = [1, 2, 20];

/** The two real-machine popups, the title menu and the load list, as one small state machine. */
function install(pilot: FakePilot, world: World): void {
  pilot.on("wait", { ok: true });
  pilot.on("leave", { ok: true, presses: 1 });
  pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
  pilot.onQuery("sample", () => ({
    sample: {
      gameover:
        world.stage === "continue"
          ? {
              open: true,
              prompt: "continue",
              cursor: world.gameoverCursor,
              autosave: { map: "卡纳克城" },
            }
          : world.stage === "to-title"
            ? { open: true, prompt: "to-title", cursor: world.gameoverCursor, autosave: null }
            : { open: false, prompt: null, cursor: null, autosave: null },
    },
  }));
  pilot.onQuery("title", () => ({
    title:
      world.stage === "title" ||
      world.stage === "saveui" ||
      world.stage === "confirm" ||
      world.stage === "loaded"
        ? {
            open: true,
            cursor: world.titleCursor,
            commands: [
              { id: "NewGame", name: "新游戏", defaultColor: true },
              { id: "LoadGame", name: "读取", defaultColor: true },
            ],
          }
        : { open: false },
  }));
  pilot.onQuery("saveui", () => ({
    saveui:
      world.stage === "saveui" || world.stage === "confirm"
        ? { open: true, cursor: world.saveCursor, slots: SLOTS }
        : { open: false },
  }));
  pilot.on("pos", () =>
    world.stage === "loaded"
      ? { pos: { state: "Player", map: 30, cell: [4, 5], saves: 7 } }
      : { pos: { state: "Event", map: 71, cell: [1, 1], saves: 6 } },
  );
  pilot.on("keys", (fields) => {
    const keys = Array.isArray(fields.keys) ? fields.keys : [];
    for (const raw of keys) {
      if (typeof raw !== "string") continue;
      const [key = "", count] = raw.split("*");
      for (let i = 0; i < (count === undefined ? 1 : Number(count)); i++) {
        press(world, key);
      }
    }
    return { ok: true };
  });
}

function press(world: World, key: string): void {
  if (world.stage === "continue") {
    // 11-10 real device: 是/否 sit side by side, so Right/Left move the cursor.
    if (key === "Right" && world.cursorMoves) world.gameoverCursor = 1;
    else if (key === "Left" && world.cursorMoves) world.gameoverCursor = 0;
    else if (key === "Enter") {
      world.stage = "to-title";
      world.gameoverCursor = 1; // the return-to-title box starts on 否
    }
    return;
  }
  if (world.stage === "to-title") {
    if (key === "Left") world.gameoverCursor = 0;
    else if (key === "Right") world.gameoverCursor = 1;
    else if (key === "Enter") {
      world.stage = "title";
      world.titleCursor = 0;
    }
    return;
  }
  if (world.stage === "title") {
    if (key === "Down") world.titleCursor = Math.min(1, world.titleCursor + 1);
    else if (key === "Up") world.titleCursor = Math.max(0, world.titleCursor - 1);
    else if (key === "Enter" && world.titleCursor === 1) {
      world.stage = "saveui";
      world.saveCursor = 0;
    }
    return;
  }
  if (world.stage === "saveui") {
    if (key === "Down") world.saveCursor = Math.min(SLOTS.length - 1, world.saveCursor + 1);
    else if (key === "Up") world.saveCursor = Math.max(0, world.saveCursor - 1);
    else if (key === "Enter") world.stage = "confirm";
    return;
  }
  if (world.stage === "confirm" && key === "Enter") world.stage = "loaded";
}

function world(overrides: Partial<World> = {}): World {
  return {
    stage: "continue",
    gameoverCursor: 0,
    titleCursor: 0,
    saveCursor: 0,
    cursorMoves: true,
    ...overrides,
  };
}

void test("the game-over flow picks 否, then 是, then LoadGame and slot 20", async () => {
  const pilot = new FakePilot();
  const state = world();
  install(pilot, state);
  assert.deepEqual(await recoverFromGameover(pilot, 20), {
    ok: true,
    text: "游戏结束了(倒计时到点/全灭),已回标题读 20 号位第 7 次存档，现在在地图 30 (4,5)",
  });
  assert.equal(state.stage, "loaded");
  assert.deepEqual(pilot.keys(), [
    ["Right"],
    ["Enter"],
    ["Left"],
    ["Enter"],
    ["Down"],
    ["Enter"],
    ["Down*2"],
    ["Enter"],
    ["Left"],
    ["Enter"],
  ]);
});

void test("a wrong cursor reading stops before any Enter", async () => {
  const pilot = new FakePilot();
  const state = world({ gameoverCursor: 0, cursorMoves: false });
  install(pilot, state);
  const result = await recoverFromGameover(pilot, 20);
  assert.ok(result !== null);
  assert.equal(result.ok, false);
  assert.match(result.text, /光标没能到第 1 项/);
  assert.deepEqual(pilot.keys(), [
    ["Right"],
    ["Right"],
    ["Right"],
    ["Right"],
    ["Right"],
    ["Right"],
  ]);
  assert.equal(state.stage, "continue");
});

void test("a null cursor stops without pressing anything", async () => {
  const pilot = new FakePilot();
  const state = world({ gameoverCursor: null });
  install(pilot, state);
  const result = await recoverFromGameover(pilot, 20);
  assert.ok(result !== null);
  assert.equal(result.ok, false);
  assert.match(result.text, /读不到光标/);
  assert.deepEqual(pilot.keys(), []);
});

void test("an old bridge without a gameover field does nothing", async () => {
  const pilot = new FakePilot();
  pilot.onQuery("sample", { sample: { party: [] } });
  assert.equal(await readGameover(pilot), null);
  assert.equal(await recoverFromGameover(pilot, 20), null);
  assert.deepEqual(pilot.keys(), []);
});

void test("gameover parsing keeps prompt and cursor and rejects unknown prompts", () => {
  assert.deepEqual(parseGameoverInfo({ open: true, prompt: "continue", cursor: 0 }), {
    open: true,
    prompt: "continue",
    cursor: 0,
    autosave: undefined,
  });
  assert.deepEqual(parseGameoverInfo({ open: true, prompt: "something", cursor: null }), {
    open: true,
    prompt: null,
    cursor: null,
    autosave: undefined,
  });
  assert.equal(parseGameoverInfo(undefined), null);
});

void test("advance_story stops its wait on the popup and Game.run follows the recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-gameover-wait-"));
  try {
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff6",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
    });
    const pilot = new FakePilot();
    const state = world();
    install(pilot, state);
    const text = await game.run("advance_story", {}, pilot);
    assert.match(text, /游戏结束弹窗出现，停止等待/);
    assert.match(text, /已回标题读 20 号位第 7 次存档/);
    assert.equal(state.stage, "loaded");
    assert.deepEqual(pilot.keys(), [
      ["Right"],
      ["Enter"],
      ["Left"],
      ["Enter"],
      ["Down"],
      ["Enter"],
      ["Down*2"],
      ["Enter"],
      ["Left"],
      ["Enter"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("Game.run recovers the popup before returning an ordinary tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-gameover-"));
  try {
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff6",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
    });
    const pilot = new FakePilot();
    const state = world();
    install(pilot, state);
    pilot.onQuery("items", { items: { normal: [], important: [] } });
    const text = await game.run("inventory", {}, pilot);
    assert.match(text, /游戏结束了\(倒计时到点\/全灭\),已回标题读 20 号位第 7 次存档/);
    assert.equal(state.stage, "loaded");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

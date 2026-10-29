import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import { advanceStory, pressKeys } from "../src/engine/skills/screens.ts";
import { gameToolSchemas } from "../src/plugin/tools.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

function firstKey(fields: Record<string, unknown>): string {
  const keys = fields.keys;
  return Array.isArray(keys) && typeof keys[0] === "string" ? keys[0] : "";
}

void test("advance_story closes FieldHelp and pages the dialog it was hiding", async () => {
  const pilot = new FakePilot();
  let state = "FieldHelp";
  let dialogOpen = true;
  pilot.on("pos", () => ({ pos: { state, map: 3 } }));
  pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
  pilot.onQuery("sample", () => ({
    sample: { dialog: { open: dialogOpen, lines: ["……"] }, choice: {}, battle: { active: false } },
  }));
  pilot.on("keys", (fields) => {
    const key = firstKey(fields);
    if (key === "PadStart") state = "Player";
    if (key === "Enter") dialogOpen = false;
    return { ok: true };
  });

  const outcome = await advanceStory(pilot);
  assert.equal(outcome.stop, "free");
  assert.equal(outcome.pages, 1);
  assert.deepEqual(outcome.notes, ["关掉了操作提示"]);
  assert.deepEqual(pilot.keys(), [["PadStart"], ["Enter"]]);
});

void test("advance_story stops after three PadStart presses that leave FieldHelp open", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "FieldHelp", map: 3 } });
  pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
  pilot.onQuery("sample", { sample: { dialog: { open: false }, choice: {} } });
  pilot.on("keys", { ok: true });

  const outcome = await advanceStory(pilot);
  assert.equal(outcome.stop, "fieldhelp");
  assert.match(outcome.detail, /FieldHelp/);
  assert.deepEqual(pilot.keys(), [["PadStart"], ["PadStart"], ["PadStart"]]);
});

void test("advance_story keeps the default name in a focused naming box", async () => {
  const pilot = new FakePilot();
  let open = true;
  pilot.on("pos", { pos: { state: "Player", map: 3 } });
  pilot.onQuery("textinput", () => ({
    textinput: {
      open,
      fields: [{ name: "InputField", text: "泰拉", focused: open }],
    },
  }));
  pilot.onQuery("sample", { sample: { dialog: { open: false }, choice: {} } });
  pilot.on("keys", (fields) => {
    if (firstKey(fields) === "TextEnter") open = false;
    return { ok: true };
  });

  const outcome = await advanceStory(pilot);
  assert.equal(outcome.stop, "free");
  assert.deepEqual(outcome.notes, ["给 泰拉 起名(默认名)"]);
  assert.deepEqual(pilot.keys(), [["TextEnter"], ["Enter"]]);
});

void test("an old bridge without textinput is skipped without an error", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Player", map: 3 } });
  pilot.onQuery("textinput", { ok: false, error: "bridge_error:unknown_op:textinput" });
  pilot.onQuery("sample", { sample: { dialog: { open: false }, choice: {} } });

  const outcome = await advanceStory(pilot);
  assert.equal(outcome.stop, "free");
  assert.equal(pilot.keys().length, 0);
});

void test("advance_story stops when eight Enter presses leave the screen alone", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Field", map: 3 } });
  pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
  pilot.onQuery("sample", {
    sample: { dialog: { open: true, lines: ["???", "???", "???"] }, choice: {} },
  });
  pilot.on("keys", { ok: true });

  const outcome = await advanceStory(pilot);
  assert.equal(outcome.stop, "stuck");
  assert.equal(outcome.pages, 8);
  assert.match(outcome.detail, /主状态 Field/);
  assert.deepEqual(
    pilot.keys(),
    Array.from({ length: 8 }, () => ["Enter"]),
  );
});

void test("advance_story waits out a cutscene instead of pressing Enter", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Event", map: 3 } });
  pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
  pilot.onQuery("sample", { sample: { dialog: { open: false }, choice: {} } });

  const outcome = await advanceStory(pilot);
  assert.equal(outcome.stop, "stuck");
  assert.match(outcome.detail, /主状态 Event/);
  assert.equal(pilot.keys().length, 0);
  assert.ok(pilot.now() >= 60_000);
});

void test("a cutscene with a dialog still pages after the normal eight presses", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Event", map: 3 } });
  pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
  pilot.onQuery("sample", {
    sample: { dialog: { open: true, lines: ["……"] }, choice: {} },
  });
  pilot.on("keys", { ok: true });

  const outcome = await advanceStory(pilot);
  assert.equal(outcome.stop, "stuck");
  assert.equal(outcome.pages, 8);
  assert.equal(pilot.keys().length, 8);
});

void test("press accepts one to six keys from the gamepad list", () => {
  assert.deepEqual(pressKeys(["Down", "Enter"]), ["Down", "Enter"]);
  assert.deepEqual(pressKeys(["PadStart"]), ["PadStart"]);
  for (const bad of [["Select"], ["Enter", "a", "b", "c", "d", "e", "f"], []]) {
    assert.throws(() => pressKeys(bad));
  }
});

void test("only the five newly started games get the press tool", () => {
  const names = (game: string): string[] =>
    gameToolSchemas(game, 20).map((tool) => tool.function.name);
  assert.equal(names("ff5").includes("press"), false);
  for (const game of ["ff1", "ff2", "ff3", "ff4", "ff6"]) {
    assert.ok(names(game).includes("press"), `${game} 应该有 press`);
  }
});

async function temporaryGame(game = "ff6"): Promise<{ game: Game; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-screens-"));
  const created = await Game.create({
    laptop: LAPTOP,
    game,
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
  });
  created.settle = () => Promise.resolve("");
  created.chart = () => Promise.resolve(null);
  created.observe = () => Promise.resolve("地图 3 的当前画面");
  created.checkGear = () => Promise.resolve("");
  created.townHint = () => Promise.resolve("");
  created.ailmentHint = () => Promise.resolve("");
  return { game: created, directory };
}

void test("the press tool sends the keys and returns the current state", async () => {
  const { game, directory } = await temporaryGame();
  try {
    const pilot = new FakePilot().on("keys", { ok: true });
    const text = await game.run("press", { keys: ["Down", "Enter"] }, pilot);
    assert.match(text, /已按 Down、Enter/);
    assert.match(text, /当前状态:\n地图 3 的当前画面/);
    assert.deepEqual(pilot.keys(), [["Down", "Enter"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("advance_story reports the FieldHelp it closed and the pages it turned", async () => {
  const { game, directory } = await temporaryGame();
  try {
    const pilot = new FakePilot();
    let state = "FieldHelp";
    let dialogOpen = true;
    pilot.on("pos", () => ({ pos: { state, map: 3 } }));
    pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
    pilot.onQuery("sample", () => ({
      sample: {
        dialog: { open: dialogOpen, lines: ["……"] },
        choice: {},
        battle: { active: false },
      },
    }));
    pilot.on("keys", (fields) => {
      const key = firstKey(fields);
      if (key === "PadStart") state = "Player";
      if (key === "Enter") dialogOpen = false;
      return { ok: true };
    });

    const text = await game.run("advance_story", {}, pilot);
    assert.match(text, /关掉了操作提示/);
    assert.match(text, /翻了 1 页,停下原因:free/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("advance_story says so when the screen does not change", async () => {
  const { game, directory } = await temporaryGame();
  try {
    const pilot = new FakePilot();
    pilot.on("pos", { pos: { state: "Field", map: 3 } });
    pilot.onQuery("textinput", { textinput: { open: false, fields: [] } });
    pilot.onQuery("sample", {
      sample: { dialog: { open: true, lines: ["???"] }, choice: {} },
    });
    pilot.on("keys", { ok: true });

    const text = await game.run("advance_story", {}, pilot);
    assert.match(text, /画面没有变化，可能是工具认不出的界面/);
    assert.match(text, /当前状态:主状态 Field · 地图 3/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the press tool rejects a key outside the list", async () => {
  const { game, directory } = await temporaryGame();
  try {
    const pilot = new FakePilot().on("keys", { ok: true });
    await assert.rejects(game.run("press", { keys: ["Select"] }, pilot), /不接受这些键/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

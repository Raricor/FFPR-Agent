import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KeyEvents } from "../src/engine/events.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Json } from "../src/engine/values.ts";
import { Tactics } from "../src/engine/tactics.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };
const TABLE: Json = { 巴兹: [{ do: "攻击" }] };

function record(seq: number, type: string, body: Json = {}): Json {
  return { seq, t: `2026-11-03T12:00:${String(seq).padStart(2, "0")}Z`, type, ...body };
}

function live(): Json {
  return record(3, "sample", {
    user: { mapId: 30, areaText: "图尔村" },
    party: [
      { name: "巴兹", jobName: "骑士", lv: 10, hp: 100, maxHp: 100, mp: 20, maxMp: 20 },
      { name: "蕾娜", jobName: "白魔法师", lv: 10, hp: 100, maxHp: 100, mp: 30, maxMp: 30 },
    ],
    battle: { active: false },
  });
}

function pilot(): FakePilot {
  const fake = new FakePilot();
  fake.on("pos", { pos: { state: "Player", map: 30, cell: [1, 2], battle: false } });
  fake.on("entities", { entities: { total: 0, entities: [] } });
  fake.on("cells", {
    cells: {
      origin: [0, 0],
      center: [1, 2],
      attr: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    },
  });
  fake.on("collision", {
    collision: {
      playerCell: [1, 2],
      layers: [{ name: "GroundCollision", rows: ["000", "000", "000"] }],
    },
  });
  fake.on("route", { route: { from: [1, 2], cells: [] } });
  fake.on("walk", { ok: true, pos: { state: "Player", map: 30, cell: [2, 2] } });
  fake.on("wait", { ok: true });
  fake.onQuery("items", {
    items: {
      normal: [
        { name: "恢复药", count: 2 },
        { name: "不死鸟之尾", count: 2 },
      ],
      important: [],
    },
  });
  fake.onQuery("sample", { sample: live() });
  fake.onQuery("battlemenu", { battlemenu: { battle: false } });
  return fake;
}

void test("a tactician call is written with its map, reason, tables and walker first sentence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactician-log-"));
  try {
    const tacticsFile = join(directory, "tactics-ff5.json");
    const tacticianFile = join(directory, "tactician-ff5.jsonl");
    const events = new KeyEvents(
      () => new Date("2026-11-03T20:00:00+08:00"),
      () => 1000,
    );
    events.feed(record(1, "hello", { product: "FF5", plugin: "0.13.0" }), false);
    events.feed(live(), true);
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      events,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile,
      elementsFile: join(directory, "elements.json"),
      tacticianFile,
      tactician: () =>
        Promise.resolve({
          tables: [TABLE],
          walkerNotes: "先开左边的开关。然后往北走。",
          askUp: "缺眼药",
        }),
    });
    await game.run("inventory", {}, pilot());
    await game.whenTacticianIdle();
    const lines = (await readFile(tacticianFile, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const call = JSON.parse(lines[0] ?? "") as Json;
    assert.equal(call.mapId, 30);
    assert.equal(call.kind, "new-map");
    assert.equal(call.tables, 1);
    assert.deepEqual(call.problems, []);
    assert.equal(call.walkerFirst, "先开左边的开关");
    const reloaded = await Tactics.load(tacticsFile);
    assert.equal(reloaded.note(30)?.walkerNotes, "先开左边的开关。然后往北走。");
    assert.equal(reloaded.note(30)?.askUp, "缺眼药");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

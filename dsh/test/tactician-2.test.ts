import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KeyEvents } from "../src/engine/events.ts";
import type { TacticianPlan } from "../src/engine/facts.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Json } from "../src/engine/values.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

function record(seq: number, type: string, body: Json = {}): Json {
  return { seq, t: `2026-11-03T12:00:${String(seq).padStart(2, "0")}Z`, type, ...body };
}

function live(party: readonly Json[] = []): Json {
  return record(3, "sample", {
    user: { mapId: 30, areaText: "风之神殿" },
    party:
      party.length > 0
        ? party
        : [
            { name: "巴兹", jobName: "骑士", lv: 10, hp: 100, maxHp: 100, mp: 20, maxMp: 20 },
            {
              name: "蕾娜",
              jobName: "白魔法师",
              lv: 10,
              hp: 100,
              maxHp: 100,
              mp: 30,
              maxMp: 30,
            },
          ],
    battle: { active: false },
  });
}

const GOOD_TABLE: Json = {
  version: 2,
  summary: "风之神殿",
  roles: { 蕾娜: "治疗" },
  reactions: [
    {
      who: "all",
      on: "ally.any(not alive) and item(不死鸟之尾) > 0",
      do: "道具:不死鸟之尾",
      to: "ally.first(not alive)",
    },
  ],
  phases: [],
  rules: [
    {
      who: "蕾娜",
      if: "ally.any(hp_pct < 60)",
      do: "白魔法:治疗",
      to: "ally.lowest(hp_pct)",
    },
    { who: "巴兹", do: "攻击", to: "enemy.boss" },
  ],
};

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
        { name: "恢复药", count: 3 },
        { name: "不死鸟之尾", count: 2 },
      ],
      important: [],
    },
  });
  fake.onQuery("battlemenu", { battlemenu: { battle: false } });
  return fake;
}

async function harness(
  plan: (facts: string) => TacticianPlan,
  party?: readonly Json[],
): Promise<{
  readonly game: Game;
  readonly pilot: FakePilot;
  readonly facts: string[];
  readonly calls: () => number;
  readonly close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactician2-"));
  const facts: string[] = [];
  let called = 0;
  const events = new KeyEvents(
    () => new Date("2026-11-03T20:00:00+08:00"),
    () => 1000,
  );
  events.feed(record(1, "hello", { product: "FF5", plugin: "0.13.0" }), false);
  events.feed(live(party), true);
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    events,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    tactician: (fact) => {
      called += 1;
      facts.push(fact);
      return Promise.resolve(plan(fact));
    },
  });
  const p = pilot();
  p.onQuery("sample", { sample: live(party) });
  return {
    game,
    pilot: p,
    facts,
    calls: () => called,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("a job change triggers party-changed and the fact sheet names the lost rule", async () => {
  const party = [
    { name: "巴兹", jobName: "骑士", lv: 10, hp: 100, maxHp: 100, mp: 20, maxMp: 20 },
    {
      name: "法利斯",
      jobName: "武僧",
      lv: 10,
      hp: 100,
      maxHp: 100,
      mp: 20,
      maxMp: 20,
    },
    { name: "蕾娜", jobName: "白魔法师", lv: 10, hp: 100, maxHp: 100, mp: 30, maxMp: 30 },
  ];
  const h = await harness(
    () => ({
      tables: [GOOD_TABLE],
      walkerNotes: "换职业后重写",
      askUp: "",
    }),
    party,
  );
  try {
    const old = {
      version: 2,
      roles: {},
      reactions: [],
      phases: [],
      rules: [{ who: "法利斯", do: "黑魔法:火炎", to: "enemy.boss" }],
    };
    await h.game.tactics.set(30, [old], ["哥布林"], undefined, [
      { name: "巴兹", job: "骑士", commands: ["攻击", "防御", "道具"] },
      { name: "法利斯", job: "黑魔法师", commands: ["攻击", "防御", "道具", "黑魔法"] },
      { name: "蕾娜", job: "白魔法师", commands: ["攻击", "防御", "道具", "白魔法"] },
    ]);
    const result = await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(h.facts[0] ?? "", /队伍变了,旧规则表用不了/);
    assert.match(h.facts[0] ?? "", /从黑魔法师换成了武僧/);
    assert.match(h.facts[0] ?? "", /黑魔法:火炎/);
    assert.match(result, /换职业后重写/);
    assert.equal(h.game.tactics.current(30)?.version, 2);
  } finally {
    await h.close();
  }
});

void test("entering a boss map calls boss-prep once and stores the table for the fight", async () => {
  const h = await harness(() => ({
    tables: [GOOD_TABLE],
    walkerNotes: "首领战先回复",
    askUp: "带够不死鸟之尾",
  }));
  h.pilot.on("entities", {
    entities: {
      entities: [{ kind: "Event", cell: [3, 2], name: "首领 巨翼猛禽", active: true }],
    },
  });
  try {
    await h.game.tactics.set(30, [GOOD_TABLE], ["哥布林"]);
    const result = await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(h.facts[0] ?? "", /快到首领了/);
    assert.match(h.facts[0] ?? "", /### 首领/);
    assert.match(h.facts[0] ?? "", /巨翼猛禽/);
    assert.match(result, /首领表已经按地图 30 存好/);
    const boss = h.game.tactics.boss(30);
    assert.ok(boss);
    assert.equal(boss.prepared, true);
    assert.deepEqual(boss.table, GOOD_TABLE);
    assert.equal(boss.askUp, "带够不死鸟之尾");
    await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    // The fight itself starts by using the stored table: no second tactician call.
    h.pilot.on("pos", { pos: { state: "Battle", map: 30, cell: [1, 2], battle: true } });
    h.pilot.onQuery("sample", {
      sample: {
        ...live(),
        battle: {
          active: true,
          boss: true,
          enemies: [{ name: "巨翼猛禽", book: 229, id: 281, hp: 500, maxHp: 500, boss: true }],
          players: [],
        },
      },
    });
    const fought = await h.game.settle(h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(fought, /用首领战前写好的表/);
  } finally {
    await h.close();
  }
});

void test("a hard battle's debrief fact sheet carries the battle record summary", async () => {
  const h = await harness(() => ({
    tables: [GOOD_TABLE],
    walkerNotes: "改表",
    askUp: "",
  }));
  try {
    await h.game.tactics.set(30, [GOOD_TABLE], ["哥布林"]);
    const session = h.game.battles.start({
      mapId: 30,
      mapName: "风之神殿",
      boss: false,
      enemies: [{ name: "哥布林", id: 1, hp: 20, maxHp: 20, mp: null, status: [], boss: false }],
      party: [],
      table: { kind: "map", mapId: 30, table: 0 },
    });
    await session.finish(1000, "hard", "巴兹倒下");
    h.game.settle = async () => {
      await h.game.hooks.report?.(30, "hard", "巴兹倒下");
      return "";
    };
    await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(h.facts[0] ?? "", /### 这一场的战斗记录/);
    assert.match(h.facts[0] ?? "", /普通战:吃力\(巴兹倒下\)/);
    assert.match(h.facts[0] ?? "", /敌人用过:/);
  } finally {
    await h.close();
  }
});

void test("a bridge battle.ai push is kept in the monster AI cache", async () => {
  const h = await harness(() => ({
    tables: [GOOD_TABLE],
    walkerNotes: "不叫",
    askUp: "",
  }));
  try {
    h.game.events?.feed(
      record(4, "battle.ai", { monster: 555, scriptId: 9, scriptName: "sc_ai_555", length: 120 }),
      true,
    );
    const entry = h.game.monsterAi.entry(555);
    assert.ok(entry);
    assert.equal(entry.scriptId, 9);
    assert.equal(entry.scriptName, "sc_ai_555");
    assert.equal(entry.event, true);
  } finally {
    await h.close();
  }
});

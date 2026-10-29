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
const TABLE: Json = { 巴兹: [{ do: "攻击" }] };

function record(seq: number, type: string, body: Json = {}): Json {
  return { seq, t: `2026-10-20T12:00:${String(seq).padStart(2, "0")}Z`, type, ...body };
}

function sample(battle: Json = { active: false }): Json {
  return record(3, "sample", {
    user: { mapId: 30, areaText: "图尔村" },
    party: [
      { name: "巴兹", jobName: "骑士", lv: 10, hp: 100, maxHp: 100, mp: 20, maxMp: 20 },
      { name: "蕾娜", jobName: "白魔法师", lv: 10, hp: 100, maxHp: 100, mp: 30, maxMp: 30 },
    ],
    battle,
  });
}

function eventsWith(live: Json): KeyEvents {
  const events = new KeyEvents(
    () => new Date("2026-10-20T20:30:00+08:00"),
    () => 1000,
  );
  events.feed(record(1, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.7.2" }), false);
  events.feed(live, true);
  return events;
}

function pilotFor(live: Json, options: { conveyor?: boolean; blocked?: boolean } = {}): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Player", map: 30, cell: [1, 2], battle: false } });
  pilot.on("entities", (fields) => {
    if (fields.kind === "Event" && options.conveyor === true) {
      return {
        entities: {
          entities: [{ kind: "Event", cell: [2, 2], name: "流される①", active: true }],
        },
      };
    }
    return { entities: { total: 0, entities: [] } };
  });
  pilot.on("cells", {
    cells: {
      origin: [0, 0],
      center: [1, 2],
      attr: [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
      ],
    },
  });
  pilot.on("collision", {
    collision: {
      playerCell: [1, 2],
      layers: [{ name: "GroundCollision", rows: ["000000", "000000", "000000"] }],
    },
  });
  pilot.on("route", { route: { from: [1, 2], cells: [] } });
  pilot.on(
    "walk",
    options.blocked === true
      ? { ok: false, error: "blocked", pos: { state: "Player", map: 30, cell: [1, 2] } }
      : { ok: true, pos: { state: "Player", map: 30, cell: [9, 30] } },
  );
  pilot.on("wait", { ok: true });
  pilot.onQuery("items", {
    items: { normal: [{ name: "恢复药", count: 2 }], important: [] },
  });
  pilot.onQuery("sample", { sample: live });
  pilot.onQuery("battlemenu", { battlemenu: { battle: false } });
  return pilot;
}

interface Harness {
  readonly game: Game;
  readonly pilot: FakePilot;
  readonly facts: string[];
  readonly calls: () => number;
  readonly close: () => Promise<void>;
}

async function harness(
  live: Json,
  plan: () => TacticianPlan,
  options: {
    boss?: boolean;
    blocked?: boolean;
    conveyor?: boolean;
    tables?: Json[];
    monsters?: string[];
  } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactician-"));
  const facts: string[] = [];
  let called = 0;
  const events = eventsWith(live);
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 3,
    events,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    tacticianBoss: options.boss ?? true,
    tactician: (fact) => {
      called += 1;
      facts.push(fact);
      return Promise.resolve(plan());
    },
  });
  if (options.tables !== undefined) {
    await game.tactics.set(30, options.tables, options.monsters ?? ["哥布林"]);
  }
  if (options.monsters !== undefined) {
    events.enemies.set(30, new Set(options.monsters));
  }
  const pilot = pilotFor(live, { conveyor: options.conveyor, blocked: options.blocked });
  return {
    game,
    pilot,
    facts,
    calls: () => called,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("a map with no tactics calls the tactician once and installs its tables", async () => {
  const h = await harness(sample(), () => ({
    tables: [TABLE],
    walkerNotes: "先开左边的开关",
    askUp: "缺眼药",
  }));
  try {
    const result = await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(result, /战术官\(地图 30\):先开左边的开关/);
    assert.match(result, /战术官建议:缺眼药/);
    assert.ok(h.game.tactics.has(30));
    assert.equal(h.game.mapNameOf(30), "图尔村");
    assert.deepEqual(h.game.tacticianInfoFor(30), {
      mapId: 30,
      walkerNotes: "先开左边的开关",
      askUp: "缺眼药",
    });
    assert.match(h.facts[0] ?? "", /### 地图[\s\S]*地图 30/);
  } finally {
    await h.close();
  }
});

void test("a monster unseen when the tables were written calls the tactician again", async () => {
  const h = await harness(
    sample(),
    () => ({ tables: [TABLE], walkerNotes: "新怪要小心", askUp: "" }),
    { tables: [TABLE], monsters: ["哥布林"] },
  );
  h.game.events?.enemies.set(30, new Set(["哥布林", "新怪"]));
  try {
    await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(h.facts[0] ?? "", /写战术时没见过的怪:新怪/);
    assert.deepEqual(h.game.tactics.monstersSeen(30), ["哥布林", "新怪"]);
  } finally {
    await h.close();
  }
});

void test("a hard battle calls the tactician with the result", async () => {
  const h = await harness(sample(), () => ({ tables: [TABLE], walkerNotes: "改表", askUp: "" }), {
    tables: [TABLE],
    monsters: ["哥布林"],
  });
  h.game.settle = async () => {
    await h.game.hooks.report?.(30, "hard", "巴兹倒下");
    return "";
  };
  try {
    await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(h.facts[0] ?? "", /hard 或 lost\(hard:巴兹倒下\)/);
  } finally {
    await h.close();
  }
});

void test("three blocked steps call the tactician once", async () => {
  const h = await harness(
    sample(),
    () => ({ tables: [TABLE], walkerNotes: "绕开挡住的地方", askUp: "" }),
    { tables: [TABLE], monsters: ["哥布林"], blocked: true },
  );
  try {
    const result = await h.game.run("walk_to", { x: 5, y: 2 }, h.pilot);
    assert.match(result, /战术官\(地图 30\):绕开挡住的地方/);
    assert.equal(h.calls(), 1);
    assert.match(h.facts[0] ?? "", /被挡住/);
  } finally {
    await h.close();
  }
});

void test("a conveyor ride calls the tactician once", async () => {
  const h = await harness(
    sample(),
    () => ({ tables: [TABLE], walkerNotes: "传送带往东", askUp: "" }),
    { tables: [TABLE], monsters: ["哥布林"], conveyor: true },
  );
  try {
    const result = await h.game.run("walk_to", { x: 5, y: 2 }, h.pilot);
    assert.match(result, /战术官\(地图 30\):传送带往东/);
    assert.equal(h.calls(), 1);
    assert.match(h.facts[0] ?? "", /踩到传送带/);
  } finally {
    await h.close();
  }
});

void test("a boss battle is written and fought by the code when tacticianBoss is on", async () => {
  const battle = {
    active: true,
    boss: true,
    enemies: [{ name: "首领", book: 39, hp: 100, maxHp: 100 }],
    players: [],
  };
  const live = sample(battle);
  const h = await harness(live, () => ({
    tables: [TABLE],
    walkerNotes: "首领战先回复",
    askUp: "",
  }));
  h.pilot.on("pos", { pos: { state: "Battle", map: 30, cell: [1, 2], battle: true } });
  h.pilot.on("items", { items: { normal: [] } });
  try {
    const result = await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 1);
    assert.match(result, /首领战由战术官写表,代码照表打/);
    assert.equal(h.game.tactics.has(30), false);
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    assert.equal(plan.mapId, 30);
    assert.deepEqual(plan.table, TABLE);
    assert.match(plan.result, /首领战由战术官写表,代码照表打/);
    assert.equal(Number.isNaN(Date.parse(plan.at)), false);
  } finally {
    await h.close();
  }
});

void test("a boss battle without tacticianBoss keeps the old stop and asks no one", async () => {
  const battle = {
    active: true,
    boss: true,
    enemies: [{ name: "首领", book: 39, hp: 100, maxHp: 100 }],
    players: [],
  };
  const live = sample(battle);
  const h = await harness(live, () => ({ tables: [TABLE], walkerNotes: "不该叫", askUp: "" }), {
    boss: false,
  });
  h.pilot.on("pos", { pos: { state: "Battle", map: 30, cell: [1, 2], battle: true } });
  try {
    const result = await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 0);
    assert.match(result, /首领战开始了!战斗暂停等你决定/);
  } finally {
    await h.close();
  }
});

void test("bad tables are retried at most twice, then the passing ones are installed", async () => {
  const h = await harness(sample(), () => ({
    tables: [{ 巴兹: [{ if: "ally.hp_pct < 50" }] }],
    walkerNotes: "坏表",
    askUp: "",
  }));
  try {
    const result = await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 3);
    assert.match(h.facts[1] ?? "", /上次交回的规则表有问题/);
    assert.match(result, /这次没有可用的规则表/);
    assert.equal(h.game.tactics.has(30), false);
  } finally {
    await h.close();
  }
});

void test("after the last retry the passing tables are installed and reported", async () => {
  const h = await harness(sample(), () => ({
    tables: [{ 巴兹: [{ if: "ally.hp_pct < 50" }] }, TABLE],
    walkerNotes: "一套能用的",
    askUp: "",
  }));
  try {
    const result = await h.game.run("inventory", {}, h.pilot);
    assert.equal(h.calls(), 3);
    assert.match(result, /先装上能通过的 1 套/);
    assert.ok(h.game.tactics.has(30));
    assert.deepEqual(h.game.tactics.current(30), TABLE);
  } finally {
    await h.close();
  }
});

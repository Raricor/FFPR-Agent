import assert from "node:assert/strict";
import test from "node:test";
import { Tactics, type TacticsEntry } from "../src/engine/tactics.ts";
import {
  describeCondition,
  describeRule,
  tacticsView,
  type TacticsViewInput,
} from "../src/engine/tactics-view.ts";
import type { MonsterInfo } from "../src/engine/bestiary.ts";
import { profileFor } from "../src/engine/profiles/index.ts";
import type { Json } from "../src/engine/values.ts";

const FF5 = profileFor("ff5");

const TABLE_A: Json = {
  巴兹: [
    { if: "ally.dead >= 1 and item.不死鸟之尾 >= 1", do: "道具:不死鸟之尾", target: "倒下的同伴" },
  ],
  蕾娜: [{ do: "攻击" }],
};
const TABLE_B: Json = { 巴兹: [{ if: "enemy.boss", do: "防御" }], 蕾娜: [{ do: "攻击" }] };

function tacticsWith(entries: Record<string, TacticsEntry>): Tactics {
  const tactics = new Tactics();
  for (const [mapId, entry] of Object.entries(entries)) tactics.maps.set(mapId, entry);
  return tactics;
}

function input(overrides: Partial<TacticsViewInput> = {}): TacticsViewInput {
  return {
    profile: FF5,
    strategy: true,
    mapId: 64,
    areaId: null,
    encounters: null,
    party: [{ name: "巴兹", jobName: "骑士" }],
    inBattle: false,
    tactics: tacticsWith({
      "64": {
        tables: [TABLE_A, TABLE_B],
        current: 1,
        results: [],
      },
      "70": {
        tables: [TABLE_A],
        current: 0,
        results: [],
      },
    }),
    mapNameOf: (mapId) => (mapId === 64 ? "火力船 机房" : `地图名 ${mapId}`),
    tacticianInfoFor: () => null,
    lastBossPlan: () => null,
    encountered: () => [],
    monsters: null,
    bestiaryEntries: null,
    items: {},
    elements: null,
    ...overrides,
  };
}

void test("conditions read as Chinese, with and joining clauses", () => {
  assert.equal(
    describeCondition("ally.dead >= 1 and item.不死鸟之尾 >= 1"),
    "倒下的同伴 ≥ 1 且 不死鸟之尾 ≥ 1",
  );
  assert.equal(describeCondition("enemy.boss"), "首领战");
  assert.equal(describeCondition("enemy.weak.冰"), "弱冰的敌人");
  assert.equal(describeCondition("self.status.毒"), "自己毒状态");
  assert.equal(describeCondition("ally.status.毒 >= 2"), "毒状态的同伴 ≥ 2");
  assert.equal(describeCondition("not a condition"), "not a condition");
});

void test("rules show the condition, action and optional target", () => {
  assert.equal(
    describeRule({
      if: "ally.dead >= 1 and item.不死鸟之尾 >= 1",
      do: "道具:不死鸟之尾",
      target: "倒下的同伴",
    }),
    "倒下的同伴 ≥ 1 且 不死鸟之尾 ≥ 1 → 道具:不死鸟之尾(倒下的同伴)",
  );
  assert.equal(
    describeRule({ if: "self.mp >= 4", do: "黑魔法:闪雷" }),
    "自己 MP ≥ 4 → 黑魔法:闪雷",
  );
  assert.equal(describeRule({ do: "攻击" }), "其他情况 → 攻击");
});

void test("the current map shows its table in use and the rest collapsed", () => {
  const view = tacticsView(
    input({
      tacticianInfoFor: () => ({ mapId: 64, walkerNotes: "先开开关", askUp: "缺眼药" }),
    }),
  );
  assert.equal(view.status, "当前地图：火力船 机房");
  assert.ok(view.current);
  assert.equal(view.current.summary, "2 套策略，正在用第 2 套");
  assert.deepEqual(
    view.current.tables.map((table) => [table.title, table.inUse]),
    [
      ["策略 1", false],
      ["策略 2(正在用)", true],
    ],
  );
  assert.deepEqual(view.current.notes, ["走法:先开开关", "建议:缺眼药"]);
  assert.equal(view.current.results.length, 0);
});

void test("results are newest first and capped at eight", () => {
  const results = Array.from({ length: 10 }, (_, index) => ({
    table: index % 2,
    verdict: index === 8 ? "hard" : index === 9 ? "lost" : "ok",
    detail: `第 ${index + 1} 场`,
  }));
  const view = tacticsView(
    input({ tactics: tacticsWith({ "64": { tables: [TABLE_A], current: 0, results } }) }),
  );
  assert.ok(view.current);
  assert.equal(view.current.results.length, 8);
  assert.equal(view.current.results[0], "策略 2 · 全灭:第 10 场");
  assert.equal(view.current.results[1], "策略 1 · 吃力:第 9 场");
  assert.equal(view.current.results.at(-1), "策略 1 · 顺利:第 3 场");
});

void test("a map without its own tables gets the party's default rules", () => {
  const view = tacticsView(
    input({
      mapId: 30,
      tactics: tacticsWith({}),
      party: [
        { name: "巴兹", jobName: "骑士" },
        { name: "蕾娜", jobName: "白魔法师" },
      ],
      mapNameOf: () => "",
    }),
  );
  assert.ok(view.current);
  assert.equal(view.current.name, "地图 30");
  assert.equal(view.current.summary, "没有专属策略，普通战斗用默认规则(按职业)");
  assert.equal(view.current.tables.length, 1);
  const table = view.current.tables[0];
  assert.ok(table);
  assert.equal(table.title, "默认规则(按职业)");
  assert.equal(table.inUse, true);
  assert.deepEqual(
    table.members.map((member) => member.name),
    ["巴兹", "蕾娜"],
  );
});

void test("other maps exclude the current one and the boss plan is separate", () => {
  const view = tacticsView(
    input({
      inBattle: true,
      lastBossPlan: () => ({
        mapId: 64,
        table: TABLE_B,
        result: "首领战由战术官写表,代码照表打:战斗结束",
        at: "2026-10-27T12:00:00.000Z",
      }),
    }),
  );
  assert.equal(view.status, "当前地图：火力船 机房 · 战斗中");
  assert.deepEqual(
    view.others.map((map) => [map.mapId, map.name]),
    [[70, "地图名 70"]],
  );
  assert.ok(view.boss);
  assert.equal(view.boss.title, "最近一场首领战(火力船 机房)");
  assert.equal(view.boss.result, "首领战由战术官写表,代码照表打:战斗结束");
  assert.equal(view.boss.table.title, "首领战规则");
});

void test("a null map id has no current map but still lists other maps", () => {
  const view = tacticsView(input({ mapId: null, inBattle: false }));
  assert.equal(view.status, "读不到当前地图");
  assert.equal(view.current, null);
  assert.deepEqual(
    view.others.map((map) => map.mapId),
    [64, 70],
  );
});

const MONSTERS: readonly MonsterInfo[] = [
  {
    number: 38,
    monster: 38,
    name: "甲怪",
    lv: 1,
    hp: 240,
    mp: 0,
    exp: 0,
    gil: 0,
    boss: false,
    species: 1,
    resistanceAttribute: 0,
    resistanceCondition: 0,
    attributes: [
      { id: 1, name: null, type: 1 },
      { id: 2, name: null, type: 4 },
    ],
    conditions: [],
    drops: [],
    steals: [],
  },
  {
    number: 39,
    monster: 39,
    name: "乙怪",
    lv: 1,
    hp: 100,
    mp: 0,
    exp: 0,
    gil: 0,
    boss: false,
    species: 1,
    resistanceAttribute: 0,
    resistanceCondition: 0,
    attributes: [],
    conditions: [],
    drops: [],
    steals: [],
  },
  {
    number: 40,
    monster: 40,
    name: "丙怪",
    lv: 1,
    hp: 100,
    mp: 0,
    exp: 0,
    gil: 0,
    boss: false,
    species: 1,
    resistanceAttribute: 0,
    resistanceCondition: 0,
    attributes: [],
    conditions: [],
    drops: [],
    steals: [],
  },
  {
    number: 41,
    monster: 41,
    name: "丁怪",
    lv: 1,
    hp: 100,
    mp: 0,
    exp: 0,
    gil: 0,
    boss: false,
    species: 1,
    resistanceAttribute: 0,
    resistanceCondition: 0,
    attributes: [],
    conditions: [],
    drops: [],
    steals: [],
  },
];

function enemyInput(overrides: Partial<TacticsViewInput> = {}): TacticsViewInput {
  return input({
    areaId: 12,
    encountered: (mapId) => (mapId === 64 ? ["甲怪", "乙怪"] : []),
    monsters: MONSTERS,
    bestiaryEntries: [
      { number: 38, name: "甲怪", areas: [12] },
      { number: 41, name: "丁怪", areas: [12] },
    ],
    party: [
      {
        name: "法利斯",
        jobName: "黑魔法师",
        hp: 10,
        maxHp: 100,
        mp: 20,
        abilities: [{ name: "火炎" }],
      },
    ],
    tactics: tacticsWith({
      "64": {
        tables: [{ 法利斯: [{ do: "黑魔法:最强" }] }],
        current: 0,
        results: [],
        monsters: ["乙怪", "丙怪"],
      },
    }),
    elements: null,
    ...overrides,
  });
}

void test("enemy sources keep encountered, remembered, then area order without duplicates", () => {
  const view = tacticsView(enemyInput());
  assert.ok(view.current);
  assert.deepEqual(
    view.current.enemies.map((enemy) => enemy.label),
    ["No.038 甲怪", "No.039 乙怪", "No.040 丙怪", "No.041 丁怪"],
  );
  assert.equal(view.current.enemyNote, "按全员满 HP、第一回合、只有这一只敌人推演");
});

void test("the world map does not use the area list", () => {
  const view = tacticsView(
    enemyInput({
      mapId: 1,
      areaId: 0,
      encountered: () => [],
      tactics: tacticsWith({
        "1": { tables: [{ 法利斯: [{ do: "攻击" }] }], current: 0, results: [] },
      }),
      bestiaryEntries: [{ number: 41, name: "丁怪", areas: [0] }],
    }),
  );
  assert.ok(view.current);
  assert.deepEqual(view.current.enemies, []);
});

void test("facts and the first action show weakness and absorption", () => {
  const view = tacticsView(enemyInput());
  assert.ok(view.current);
  const enemy = view.current.enemies[0];
  assert.ok(enemy);
  assert.equal(enemy.facts, "HP 240 · 弱：火 · 吸收：冰");
  assert.deepEqual(enemy.plan, ["法利斯：黑魔法:最强→火炎(打弱点)"]);

  const absorb = tacticsView(
    enemyInput({
      tactics: tacticsWith({
        "64": {
          tables: [{ 法利斯: [{ do: "黑魔法:冰结" }] }],
          current: 0,
          results: [],
          monsters: ["甲怪"],
        },
      }),
    }),
  );
  assert.deepEqual(absorb.current?.enemies[0]?.plan, ["法利斯：黑魔法:冰结(它吸收冰!)"]);
});

void test("a monster without static data keeps only its label", () => {
  const view = tacticsView(
    enemyInput({
      encountered: () => ["无名怪"],
      monsters: [],
      bestiaryEntries: [{ number: 99, name: "无名怪", areas: [12] }],
      tactics: tacticsWith({
        "64": { tables: [{ 法利斯: [{ do: "攻击" }] }], current: 0, results: [] },
      }),
    }),
  );
  assert.ok(view.current);
  assert.deepEqual(view.current.enemies, [
    { label: "No.099 无名怪", facts: "", plan: ["法利斯：攻击"] },
  ]);
});

void test("a strongest spell with nothing that can hit the enemy says so", () => {
  // Like the Poltergeist: fire is void and ice is absorbed, and Faris knows only 火炎.
  const [first, ...rest] = MONSTERS;
  assert.ok(first);
  const sealed: MonsterInfo = {
    ...first,
    attributes: [
      { id: 1, name: null, type: 3 },
      { id: 2, name: null, type: 4 },
    ],
  };
  const view = tacticsView(enemyInput({ monsters: [sealed, ...rest] }));
  const enemy = view.current?.enemies[0];
  assert.deepEqual(enemy?.plan, ["法利斯：黑魔法:最强(没有能打它的法术)"]);
});

void test("a game without an AI player shows only the encounter table and the facts", () => {
  // FF5's encounter memory and atlas say 乙怪 and 火力船 for map 64; FF6's map 64 is elsewhere.
  const view = tacticsView(
    enemyInput({
      profile: profileFor("ff6"),
      strategy: false,
      placeName: "纳尔什",
      bestiaryEntries: [],
      tactics: tacticsWith({ "64": { tables: [], current: 0, results: [], monsters: ["丙怪"] } }),
      tacticianInfoFor: () => ({ mapId: 64, walkerNotes: "先开开关", askUp: "缺眼药" }),
      lastBossPlan: () => ({
        mapId: 64,
        table: TABLE_B,
        result: "首领战由战术官写表,代码照表打:战斗结束",
        at: "2026-10-27T12:00:00.000Z",
      }),
      encounters: {
        monsterSet: 3,
        parties: [{ id: 67, rate: 1000, notEscape: false, monsters: [{ name: "甲怪", book: 38 }] }],
      },
    }),
  );
  assert.equal(view.title, "FF6 策略");
  assert.equal(view.message, "这一作还没有 AI 玩家，没有战斗策略");
  assert.equal(view.status, "当前地图：纳尔什");
  assert.equal(view.boss, null);
  assert.deepEqual(view.others, []);
  assert.ok(view.current);
  assert.deepEqual(view.current.tables, []);
  assert.deepEqual(view.current.results, []);
  assert.deepEqual(view.current.notes, []);
  assert.deepEqual(view.current.formations, ["甲怪 · 100%"]);
  assert.equal(view.current.enemyNote, "");
  assert.deepEqual(view.current.enemies, [
    // FF6 names its elements in its own data; this fixture has no sentence, so no FF5 names.
    { label: "No.038 甲怪", facts: "HP 240 · 弱：属性 1 · 吸收：属性 2", plan: [] },
  ]);
});

void test("the game's encounter table leads the enemy list, on the world map too", () => {
  // 10-27 live: set 3 by Karnak, with one party listed in two slots.
  const view = tacticsView(
    enemyInput({
      mapId: 1,
      areaId: 0,
      encountered: () => [],
      tactics: tacticsWith({
        "1": { tables: [{ 法利斯: [{ do: "攻击" }] }], current: 0, results: [] },
      }),
      encounters: {
        monsterSet: 3,
        parties: [
          { id: 67, rate: 350, notEscape: false, monsters: [{ name: "乙怪", book: 39 }] },
          {
            id: 66,
            rate: 230,
            notEscape: true,
            monsters: [
              { name: "甲怪", book: 38 },
              { name: "甲怪", book: 38 },
              { name: "乙怪", book: 39 },
            ],
          },
          { id: 67, rate: 350, notEscape: false, monsters: [{ name: "乙怪", book: 39 }] },
        ],
      },
    }),
  );
  assert.ok(view.current);
  assert.deepEqual(view.current.formations, ["乙怪 · 70%", "甲怪 ×2、乙怪 · 23% · 不能逃"]);
  assert.deepEqual(
    view.current.enemies.map((enemy) => enemy.label),
    ["No.039 乙怪", "No.038 甲怪"],
  );
  assert.ok(view.others.every((other) => other.formations.length === 0));
});

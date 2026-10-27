import assert from "node:assert/strict";
import test from "node:test";
import {
  MonsterCache,
  formatMonsterDetails,
  parseMonsters,
  monsterStatus,
  type MonsterInfo,
} from "../src/engine/bestiary.ts";
import { FakePilot } from "./fake-pilot.ts";

const MONSTER: MonsterInfo = {
  number: 38,
  monster: 121,
  name: "喧嚣鬼",
  lv: 17,
  hp: 240,
  mp: 0,
  exp: 300,
  gil: 120,
  boss: true,
  species: 3,
  resistanceAttribute: 12,
  resistanceCondition: 5,
  attributes: [
    { id: 2, type: 1 },
    { id: 3, type: 1 },
    { id: 1, type: 2 },
    { id: 5, type: 3 },
    { id: 4, type: 4 },
    { id: 8, type: 401 },
    { id: 6, type: 402 },
    { id: 7, type: 403 },
  ],
  conditions: ["石化", "即死", "中毒", "睡眠", "沉默", "混乱", "麻痹", "黑暗", "诅咒"],
  drops: ["药草", "药草", "凤凰之尾"],
  steals: ["凤凰之尾"],
};

void test("a monster introduction has the stats, resistances, immunities and loot", () => {
  const lines = formatMonsterDetails(
    MONSTER,
    ["火力船", "沃尔斯塔"],
    "Beware its roar.",
    "不可再获得",
  );
  assert.equal(lines.length, 7);
  assert.equal(lines[0], "Lv 17 · HP 240 · MP 0 · 经验 300 · 金钱 120 · 首领");
  for (const part of [
    "弱点：冰、雷",
    "双倍弱点：风",
    "减半：火",
    "大幅减半：毒",
    "无效：水",
    "吸收：土",
    "吸收(物理为弱点)：圣",
  ]) {
    assert.ok(lines[1]?.includes(part), part);
  }
  assert.equal(lines[2], "状态免疫：石化、即死、中毒、睡眠、沉默、混乱、麻痹、黑暗等 9 种");
  assert.equal(lines[3], "掉落：药草、凤凰之尾 · 偷窃：凤凰之尾");
  assert.equal(lines[4], "出没：火力船、沃尔斯塔");
  assert.equal(lines[5], "攻略：Beware its roar.");
  assert.equal(lines[6], "不可再获得");
});

void test("a monster with nothing to say contributes no empty lines", () => {
  const empty: MonsterInfo = {
    ...MONSTER,
    lv: null,
    hp: null,
    mp: null,
    exp: null,
    gil: null,
    boss: false,
    attributes: [],
    conditions: [],
    drops: [],
    steals: [],
  };
  assert.deepEqual(formatMonsterDetails(empty, [], null, null), []);
});

void test("a passed flag and only the guide's area means the monster is gone", () => {
  assert.equal(
    monsterStatus(28, [71], () => true),
    "不可再获得",
  );
  assert.equal(
    monsterStatus(28, [71], () => false),
    "限时:打倒沃尔斯塔顶的首领前",
  );
  assert.equal(
    monsterStatus(28, [71, 72], () => true),
    null,
  );
  assert.equal(
    monsterStatus(64, [34, 74], () => false),
    "限时:打倒隆卡遗迹首领前(游戏记录别处也出现)",
  );
});

void test("a rule without a past flag only warns, and an unknown number is unmarked", () => {
  assert.equal(
    monsterStatus(27, [66, 71], () => true),
    "限时:打倒两歧塔首领前(沃尔斯塔之后还有一次机会)",
  );
  assert.equal(
    monsterStatus(999, [1], () => true),
    null,
  );
});

void test("the monster cache retries a failed read and queries once after success", async () => {
  let calls = 0;
  const pilot = new FakePilot().onQuery("monsters", [
    () => {
      calls += 1;
      throw new Error("暂时读不到");
    },
    () => {
      calls += 1;
      return { monsters: [{ number: 1, name: "哥布林" }] };
    },
  ]);
  const cache = new MonsterCache();
  const signal = AbortSignal.timeout(1000);
  assert.equal(await cache.load(pilot, signal), null);
  assert.equal(calls, 1);
  const first = await cache.load(pilot, signal);
  assert.equal(first?.[0]?.name, "哥布林");
  assert.equal(calls, 2);
  const second = await cache.load(pilot, signal);
  assert.equal(second, first);
  assert.equal(calls, 2);
});

void test("element names come from the id, not the bridge's sentence", () => {
  // 10-27 dump: only weak rows carried a name, and it was a sentence.
  const [monster] = parseMonsters({
    monsters: [
      {
        number: 38,
        name: "喧嚣鬼",
        attributes: [
          { id: 5, name: "对水属性抵抗力低", type: 1 },
          { id: 2, name: null, type: 4 },
        ],
      },
    ],
  });
  assert.ok(monster);
  assert.deepEqual(formatMonsterDetails(monster, [], null, null), ["弱点：水 · 吸收：冰"]);
});

void test("a zero level is left out of the stats line", () => {
  const [line] = formatMonsterDetails({ ...MONSTER, lv: 0, boss: false }, [], null, null);
  assert.equal(line, "HP 240 · MP 0 · 经验 300 · 金钱 120");
});

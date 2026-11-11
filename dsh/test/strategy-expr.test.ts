import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluate,
  ExpressionError,
  parseExpression,
  resolveTarget,
  type BattleSnapshot,
  type Evaluation,
  type SnapshotUnit,
} from "../src/engine/strategy/index.ts";

const SNAPSHOT: BattleSnapshot = {
  actor: "蕾娜",
  turn: 3,
  seconds: 100,
  boss: true,
  allies: [
    {
      name: "蕾娜",
      hp: 40,
      maxHp: 100,
      mp: 10,
      maxMp: 30,
      status: ["毒", "魔法护盾"],
      buffs: ["再生"],
      weak: ["火"],
      absorbs: ["冰"],
      immune: ["雷"],
    },
    { name: "加拉夫", hp: 0, maxHp: 80, mp: 0, maxMp: 20 },
    { name: "法利斯", hp: 80, maxHp: 80, mp: 5, maxMp: 20 },
  ],
  enemies: [
    {
      name: "玛基莎",
      id: 282,
      hp: 200,
      maxHp: 200,
      mp: 50,
      maxMp: 50,
      weak: ["冰"],
      absorbs: ["火"],
      immune: ["雷"],
      boss: true,
    },
    {
      name: "弗扎",
      id: 283,
      hp: 100,
      maxHp: 100,
      status: ["反射"],
      weak: ["圣"],
    },
    { name: "小怪", id: 1, hp: 0, maxHp: 10 },
  ],
  items: { 不死鸟之尾: 2, 回音草: 1 },
  events: [
    { at: 90, actor: "玛基莎", target: "蕾娜", ability: "火炎", magic: true },
    { at: 95, actor: "蕾娜", target: "加拉夫", ability: "治疗" },
    { at: 96, actor: "弗扎", target: "蕾娜", ability: "攻击", countered: true },
  ],
};

function unitValue(value: Evaluation): SnapshotUnit | null {
  assert.equal(typeof value, "object");
  if (typeof value !== "object" || value.kind !== "unit")
    assert.fail(`not a unit: ${JSON.stringify(value)}`);
  return value.unit;
}

function unitName(expression: string): string | null {
  return unitValue(evaluate(expression, SNAPSHOT))?.name ?? null;
}

function targetName(to: string): string | null {
  const target = resolveTarget(to, SNAPSHOT);
  if (target?.kind !== "unit") return null;
  return target.unit.name;
}

void test("not binds tighter than and, and and tighter than or", () => {
  assert.equal(evaluate("not false and false or false", SNAPSHOT), false);
  assert.equal(evaluate("true or false and false", SNAPSHOT), true);
  assert.equal(evaluate("not false and false", SNAPSHOT), false);
  assert.equal(evaluate("(true or false) and false", SNAPSHOT), false);
  assert.equal(evaluate("not (false and false)", SNAPSHOT), true);
  assert.equal(evaluate("not self.hp == 40", SNAPSHOT), false);
  assert.equal(evaluate("not self.hp == 30", SNAPSHOT), true);
});

void test("every numeric unit property reads the snapshot", () => {
  assert.equal(evaluate("self.hp", SNAPSHOT), 40);
  assert.equal(evaluate("self.max_hp", SNAPSHOT), 100);
  assert.equal(evaluate("self.hp_pct", SNAPSHOT), 40);
  assert.equal(evaluate("self.mp", SNAPSHOT), 10);
  assert.equal(evaluate("self.max_mp", SNAPSHOT), 30);
  assert.equal(Math.round(Number(evaluate("self.mp_pct", SNAPSHOT))), 33);
  assert.equal(evaluate("self.id", SNAPSHOT), 0);
  assert.equal(evaluate("enemy(282).id", SNAPSHOT), 282);
  assert.equal(evaluate("enemy(282).name", SNAPSHOT), "玛基莎");
});

void test("alive is true only while HP is above zero", () => {
  assert.equal(evaluate("self.alive", SNAPSHOT), true);
  assert.equal(evaluate("ally(加拉夫).alive", SNAPSHOT), false);
  assert.equal(evaluate("enemy(小怪).alive", SNAPSHOT), false);
});

void test("a missing name reads as zero HP, not alive, empty name", () => {
  assert.equal(evaluate("ally(不存在).hp", SNAPSHOT), 0);
  assert.equal(evaluate("ally(不存在).mp", SNAPSHOT), 0);
  assert.equal(evaluate("enemy(不存在).max_hp", SNAPSHOT), 0);
  assert.equal(evaluate("ally(不存在).alive", SNAPSHOT), false);
  assert.equal(evaluate("ally(不存在).name", SNAPSHOT), "");
});

void test("any, all, count and first include fallen units; alive counts only living", () => {
  assert.equal(evaluate("ally.alive", SNAPSHOT), 2);
  assert.equal(evaluate("enemy.alive", SNAPSHOT), 2);
  assert.equal(evaluate("ally.count(not alive)", SNAPSHOT), 1);
  assert.equal(evaluate("ally.any(not alive)", SNAPSHOT), true);
  assert.equal(evaluate("enemy.any(not alive)", SNAPSHOT), true);
  assert.equal(evaluate("enemy.count(not alive)", SNAPSHOT), 1);
  assert.equal(evaluate("ally.all(alive)", SNAPSHOT), false);
  assert.equal(evaluate("enemy.all(alive)", SNAPSHOT), false);
  assert.equal(evaluate("ally.any(hp_pct < 50)", SNAPSHOT), true);
  assert.equal(evaluate("ally.count(alive and hp_pct < 50)", SNAPSHOT), 1);
  assert.equal(unitName("ally.first(not alive)"), "加拉夫");
});

void test("lowest and highest only consider living units and keep the first tie", () => {
  assert.equal(unitName("ally.lowest(hp_pct)"), "蕾娜");
  assert.equal(unitName("ally.highest(hp)"), "法利斯");
  assert.equal(unitName("enemy.lowest(hp)"), "弗扎");
  assert.equal(unitName("enemy.highest(max_hp)"), "玛基莎");
  assert.equal(unitName("enemy.first(weak(冰))"), "玛基莎");
  assert.equal(unitName("enemy.boss"), "玛基莎");
});

void test("comparing a unit, set, all or battle with a number is a parse error", () => {
  assert.throws(
    () => parseExpression("ally.lowest(hp_pct) < 30"),
    (error: unknown) => {
      assert.ok(error instanceof ExpressionError);
      assert.match(error.message, /不是数/u);
      assert.match(error.message, /ally\.lowest\(hp_pct\)\.hp_pct < 30/u);
      assert.match(error.message, /ally\.any\(hp_pct < 30\)/u);
      return true;
    },
  );
  assert.throws(() => parseExpression("30 > enemy.highest(hp)"), /不是数/u);
  assert.throws(() => parseExpression("ally < 2"), /不是数/u);
  assert.throws(() => parseExpression("ally.all < 2"), /不是数/u);
  assert.throws(() => parseExpression("battle < 2"), /不是数/u);
});

void test("a ranked unit's numeric property reads and compares", () => {
  assert.doesNotThrow(() => parseExpression("ally.lowest(hp_pct).hp_pct < 30"));
  assert.equal(evaluate("ally.lowest(hp_pct).hp_pct < 30", SNAPSHOT), false);
  assert.equal(evaluate("ally.lowest(hp_pct).hp_pct < 50", SNAPSHOT), true);
});

void test("set methods count the units that match a predicate", () => {
  assert.equal(evaluate("enemy.count(weak(冰))", SNAPSHOT), 1);
  assert.equal(evaluate('enemy.count(name == "弗扎")', SNAPSHOT), 1);
  assert.equal(evaluate("enemy.any(has(反射))", SNAPSHOT), true);
  assert.equal(evaluate("enemy.count(alive and has(反射))", SNAPSHOT), 1);
});

void test("has reads statuses and buffs; weakness, absorb and immunity read resistances", () => {
  assert.equal(evaluate("self.has(毒)", SNAPSHOT), true);
  assert.equal(evaluate("self.has(魔法护盾)", SNAPSHOT), true);
  assert.equal(evaluate("self.has(再生)", SNAPSHOT), true);
  assert.equal(evaluate("self.has(沉默)", SNAPSHOT), false);
  assert.equal(evaluate("self.weak(火)", SNAPSHOT), true);
  assert.equal(evaluate("self.absorbs(冰)", SNAPSHOT), true);
  assert.equal(evaluate("self.immune(雷)", SNAPSHOT), true);
  assert.equal(evaluate("enemy(玛基莎).weak(冰)", SNAPSHOT), true);
  assert.equal(evaluate("enemy(玛基莎).absorbs(火)", SNAPSHOT), true);
  assert.equal(evaluate("enemy(玛基莎).immune(雷)", SNAPSHOT), true);
});

void test("used reads the latest action, or a seconds window when given", () => {
  assert.equal(evaluate("self.used(治疗)", SNAPSHOT), true);
  assert.equal(evaluate("self.used(治疗, 10)", SNAPSHOT), true);
  assert.equal(evaluate("self.used(治疗, 2)", SNAPSHOT), false);
  assert.equal(evaluate("self.used(any_magic)", SNAPSHOT), false);
  assert.equal(evaluate("enemy(玛基莎).used(any_magic)", SNAPSHOT), true);
  assert.equal(evaluate("enemy(玛基莎).used(any_magic, 5)", SNAPSHOT), false);
  assert.equal(evaluate("enemy(玛基莎).used(any_magic, 20)", SNAPSHOT), true);
});

void test("countered reads whether the latest action was a counter", () => {
  assert.equal(evaluate("self.countered", SNAPSHOT), false);
  assert.equal(evaluate("enemy(弗扎).countered", SNAPSHOT), true);
});

void test("items, turn and battle fields read the rest of the snapshot", () => {
  assert.equal(evaluate("item(不死鸟之尾)", SNAPSHOT), 2);
  assert.equal(evaluate("item(回音草)", SNAPSHOT), 1);
  assert.equal(evaluate("item(不存在)", SNAPSHOT), 0);
  assert.equal(evaluate("turn", SNAPSHOT), 3);
  assert.equal(evaluate("battle.seconds", SNAPSHOT), 100);
  assert.equal(evaluate("battle.boss", SNAPSHOT), true);
  assert.equal(evaluate("battle.boss", { ...SNAPSHOT, boss: false }), false);
  assert.equal(evaluate("ally.first(not alive).hp", SNAPSHOT), 0);
});

void test("bad expressions name the character position and suggest a close method", () => {
  assert.throws(
    () => parseExpression("self.hass(毒)"),
    (error: unknown) =>
      error instanceof ExpressionError &&
      error.position === 6 &&
      error.message === "不认识的方法 hass,是不是 has?",
  );
  assert.throws(() => parseExpression("hpp < 1"), /不认识的开头 hpp/u);
  assert.throws(() => parseExpression("(self.hp < 40"), /这里要写「\)」/u);
  assert.throws(() => parseExpression("self.hp + 1"), /不认识的符号「\+」/u);
  assert.throws(() => parseExpression("self.weak(木)"), /属性「木」不认识/u);
});

void test("resolveTarget handles every target spelling", () => {
  assert.equal(targetName("self"), "蕾娜");
  assert.equal(targetName("ally.lowest(hp_pct)"), "蕾娜");
  assert.equal(targetName("ally(法利斯)"), "法利斯");
  assert.equal(targetName("ally.first(has(毒))"), "蕾娜");
  assert.equal(targetName("ally.first(not alive)"), "加拉夫");
  assert.equal(targetName("enemy(弗扎)"), "弗扎");
  assert.equal(targetName("enemy.lowest(hp)"), "弗扎");
  assert.equal(targetName("enemy.first(weak(冰))"), "玛基莎");
  assert.equal(targetName("enemy.boss"), "玛基莎");
  assert.equal(targetName("ally(加拉夫)"), "加拉夫");
  assert.equal(targetName("ally(不存在)"), null);
  assert.equal(targetName("battle.seconds"), null);
  assert.equal(resolveTarget(undefined, SNAPSHOT), null);
});

void test("enemy.all and ally.all resolve to the whole side", () => {
  assert.deepEqual(resolveTarget("enemy.all", SNAPSHOT), {
    kind: "all",
    side: "enemy",
  });
  assert.deepEqual(resolveTarget("ally.all", SNAPSHOT), {
    kind: "all",
    side: "ally",
  });
  assert.deepEqual(resolveTarget("enemy", SNAPSHOT), {
    kind: "all",
    side: "enemy",
  });
});

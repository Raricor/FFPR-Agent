import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  describe,
  describeAction,
  describeStrategy,
  parseStrategy,
  type Strategy,
} from "../src/engine/strategy/index.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "strategy");

function parsed(value: unknown): Strategy {
  const result = parseStrategy(value);
  if (Array.isArray(result)) assert.fail(result.join("\n"));
  return result;
}

async function checkSnapshot(name: string): Promise<void> {
  const raw = await readFile(join(FIXTURES, `${name}.json`), "utf8");
  const expected = (await readFile(join(FIXTURES, `${name}.txt`), "utf8")).trimEnd();
  assert.equal(describeStrategy(parsed(JSON.parse(raw) as unknown)), expected);
}

void test("the two examples translate to the same Chinese every run", async () => {
  await checkSnapshot("giant-bird");
  await checkSnapshot("magissa-fuza");
});

void test("condition examples translate as the task describes", () => {
  assert.equal(describe("ally.any(hp_pct < 50)"), "有同伴 HP 低于 50%");
  assert.equal(describe("enemy(282).alive"), "编号 282 的敌人还在");
  assert.equal(describe("not enemy(282).alive"), "编号 282 的敌人不在了");
  assert.equal(describe("ally.any(not alive)"), "有同伴倒下");
  assert.equal(describe("ally.count(not alive)"), "倒下的同伴人数");
  assert.equal(describe("ally.first(not alive)"), "倒下的同伴");
  assert.equal(describe("ally.first(has(毒))"), "中毒的同伴");
  assert.equal(describe("enemy.first(weak(冰))"), "弱冰的敌人");
  assert.equal(
    describe("ally.first(alive and not has(魔法护盾))"),
    "第一个活着 并且 没有魔法护盾状态的同伴",
  );
});

void test("unit, item, battle and action phrases are Chinese", () => {
  assert.equal(describe("self.hp"), "自己 HP");
  assert.equal(describe("self.hp_pct < 60"), "自己 HP 低于 60%");
  assert.equal(describe("self.has(毒)"), "自己有中毒状态");
  assert.equal(describe("enemy(玛基莎).used(any_magic)"), "玛基莎用过魔法");
  assert.equal(describe("enemy.alive > 0"), "活着的敌人数大于 0");
  assert.equal(describe("item(不死鸟之尾) > 0"), "不死鸟之尾的数量大于 0");
  assert.equal(describe("turn >= 3"), "行动次数不低于 3");
  assert.equal(describe("battle.boss"), "首领战");
  assert.equal(describe("battle.seconds"), "战斗时间");
  assert.equal(describe("enemy(弗扎).alive and enemy(玛基莎).alive"), "弗扎还在 并且 玛基莎还在");
});

void test("and/or keep their grouping visible in the Chinese", () => {
  assert.equal(describe("true or false and false"), "总是 或者 从不 并且 从不");
  assert.equal(describe("(true or false) and false"), "(总是 或者 从不) 并且 从不");
});

void test("actions translate into commands, items and abilities", () => {
  assert.equal(describeAction("攻击"), "攻击");
  assert.equal(describeAction("防御"), "防御");
  assert.equal(describeAction("换列"), "换列");
  assert.equal(describeAction("道具:不死鸟之尾"), "用道具「不死鸟之尾」");
  assert.equal(describeAction("白魔法:治疗"), "用白魔法「治疗」");
  assert.equal(describeAction("叫唤:最强"), "用叫唤「最强」");
  assert.equal(describeAction("召唤"), "用召唤");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  checkStrategy,
  fromLegacy,
  parseStrategy,
  StrategyError,
  type Strategy,
  type StrategyRule,
} from "../src/engine/strategy/index.ts";
import { describeError } from "../src/engine/errors.ts";
import { isRecord } from "../src/engine/values.ts";

const LEGACY = {
  蕾娜: [
    { if: "ally.hp_pct < 50", do: "白魔法:治疗", target: "hp最低的同伴" },
    {
      if: "ally.dead >= 1 and item.不死鸟之尾 > 0",
      do: "道具:不死鸟之尾",
      target: "倒下的同伴",
    },
    { if: "enemy.name.喧嚣鬼 >= 2", do: "攻击", target: "敌人:喧嚣鬼" },
    { if: "enemy.id.282 >= 1", do: "防御" },
    { if: "ally.status.毒 >= 1", do: "白魔法:解毒", target: "状态:毒" },
    { if: "party.alive > 0 and enemy.count > 0 and self.hp < 30", do: "攻击" },
    { if: "enemy.weak.冰 > 0", do: "黑魔法:冰结", target: "敌人:弱冰" },
    {
      if: "enemy.absorbs.火 > 0 and self.status.沉默 >= 1 and turn >= 2",
      do: "攻击",
    },
    {
      if: "enemy.hp_pct < 20 and enemy.boss",
      do: "攻击",
      target: "敌人:hp最低",
    },
    { do: "攻击", target: "自己" },
  ],
};

function parsed(strategy: Strategy): Strategy {
  const result = parseStrategy(strategy);
  if (Array.isArray(result)) assert.fail(result.join("\n"));
  return result;
}

function ruleAt(strategy: Strategy, index: number): StrategyRule {
  const rule = strategy.rules[index];
  assert.ok(rule, `missing rule ${index}`);
  return rule;
}

void test("every old vocabulary word and target converts", () => {
  const strategy = fromLegacy(LEGACY);
  assert.equal(strategy.version, 2);
  assert.deepEqual(strategy.roles, {});
  assert.deepEqual(strategy.reactions, []);
  assert.deepEqual(strategy.phases, []);
  assert.equal(strategy.rules.length, 10);
  assert.equal(ruleAt(strategy, 0).who, "蕾娜");
  assert.equal(ruleAt(strategy, 0).if, "ally.lowest(hp_pct).hp_pct < 50");
  assert.equal(ruleAt(strategy, 0).to, "ally.lowest(hp_pct)");
  assert.equal(ruleAt(strategy, 1).if, "ally.count(not alive) >= 1 and item(不死鸟之尾) > 0");
  assert.equal(ruleAt(strategy, 1).to, "ally.first(not alive)");
  assert.equal(ruleAt(strategy, 2).if, 'enemy.count(name == "喧嚣鬼") >= 2');
  assert.equal(ruleAt(strategy, 2).to, "enemy(喧嚣鬼)");
  assert.equal(ruleAt(strategy, 3).if, "enemy(282).alive");
  assert.equal(ruleAt(strategy, 3).to, undefined);
  assert.equal(ruleAt(strategy, 4).if, "ally.count(has(毒)) >= 1");
  assert.equal(ruleAt(strategy, 4).to, "ally.first(has(毒))");
  assert.equal(ruleAt(strategy, 5).if, "ally.alive > 0 and enemy.alive > 0 and self.hp < 30");
  assert.equal(ruleAt(strategy, 6).if, "enemy.count(weak(冰)) > 0");
  assert.equal(ruleAt(strategy, 6).to, "enemy.first(weak(冰))");
  assert.equal(
    ruleAt(strategy, 7).if,
    "enemy.count(absorbs(火)) > 0 and self.has(沉默) and turn >= 2",
  );
  assert.equal(ruleAt(strategy, 8).if, "enemy.lowest(hp_pct).hp_pct < 20 and battle.boss");
  assert.equal(ruleAt(strategy, 8).to, "enemy.lowest(hp_pct)");
  assert.equal(ruleAt(strategy, 9).to, "self");
  assert.deepEqual(parsed(strategy), strategy);
  assert.deepEqual(checkStrategy(strategy), []);
});

void test("the old {battle: …} wrapper and one-command plans still convert", () => {
  const wrapped = fromLegacy({
    battle: { 蕾娜: [{ if: "self.mp >= 4", do: "黑魔法:闪雷" }] },
  });
  assert.equal(wrapped.rules.length, 1);
  const plan = fromLegacy({ 蕾娜: "攻击" });
  assert.equal(plan.rules.length, 1);
  assert.equal(plan.rules[0]?.do, "攻击");
});

void test("a malformed old table fails with a Chinese message", () => {
  assert.throws(() => fromLegacy({}), StrategyError);
  assert.throws(() => fromLegacy({ 蕾娜: [] }), StrategyError);
  assert.throws(() => fromLegacy({ 蕾娜: [{ if: "self.hp", target: "不存在" }] }), StrategyError);
});

void test("every real tactics table converts; pre-existing type errors are reported", async (t) => {
  const candidates = [
    join(import.meta.dirname, "..", ".deps", "ds", "tactics-ff5.json"),
    join(import.meta.dirname, "..", "..", ".deps", "ds", "tactics-ff5.json"),
  ];
  let body: string | null = null;
  let reason = "";
  for (const path of candidates) {
    try {
      body = await readFile(path, "utf8");
      break;
    } catch (error) {
      reason = describeError(error);
    }
  }
  if (body === null) {
    t.skip(`读不到 .deps/ds/tactics-ff5.json(${reason}),跳过真实旧表转换`);
    return;
  }
  const raw = JSON.parse(body) as unknown;
  assert.ok(isRecord(raw));
  let tables = 0;
  const failed: string[] = [];
  for (const [mapId, entry] of Object.entries(raw)) {
    assert.ok(isRecord(entry));
    const list = Array.isArray(entry.tables) ? entry.tables : undefined;
    assert.ok(Array.isArray(list), `地图 ${mapId} 没有 tables`);
    for (const table of list) {
      tables++;
      // 11-05: the live file now also holds 2.0 tables the tactician wrote (task 42).
      const strategy = isRecord(table) && table.version === 2 ? table : fromLegacy(table);
      const result = parseStrategy(strategy);
      if (Array.isArray(result)) {
        // Task 53: the live file still has tables from before the unit/number check. They
        // must be reported, not rewritten; any other parse failure is still a real failure.
        assert.ok(
          result.every((problem) => problem.includes("不是数")),
          `地图 ${mapId} 第 ${tables} 套转换后解析失败:${result.join(";")}`,
        );
        failed.push(`地图 ${mapId} 第 ${tables} 套`);
      }
    }
  }
  assert.ok(tables > 0, "战术文件里一套表都没有");
  t.diagnostic(`真实旧表转换:${tables} 套,${failed.length} 套不过类型检查:${failed.join("、")}`);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  checkStrategy,
  parseAction,
  parseStrategy,
  type Strategy,
} from "../src/engine/strategy/index.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "strategy");

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as unknown;
}

function parsed(value: unknown): Strategy {
  const result = parseStrategy(value);
  if (Array.isArray(result)) assert.fail(result.join("\n"));
  return result;
}

function errorsOf(value: unknown): string[] {
  const result = parseStrategy(value);
  assert.ok(Array.isArray(result), "expected a Chinese error list");
  return result;
}

void test("a strategy with only flat rules parses", () => {
  const strategy = parsed({
    version: 2,
    summary: "测试",
    roles: { 蕾娜: "治疗" },
    rules: [
      {
        who: "蕾娜",
        if: "ally.any(hp_pct < 50)",
        do: "白魔法:治疗",
        to: "self",
      },
    ],
  });
  assert.equal(strategy.version, 2);
  assert.equal(strategy.summary, "测试");
  assert.deepEqual(strategy.roles, { 蕾娜: "治疗" });
  assert.equal(strategy.rules.length, 1);
  assert.equal(strategy.rules[0]?.to, "self");
  assert.deepEqual(strategy.phases, []);
});

void test("the two example strategies parse with reactions and phases", async () => {
  const giant = parsed(await fixture("giant-bird.json"));
  assert.equal(giant.phases.length, 2);
  assert.equal(giant.phases[0]?.name, "合翅膀");
  const magissa = parsed(await fixture("magissa-fuza.json"));
  assert.equal(magissa.reactions.length, 2);
  assert.equal(magissa.reactions[1]?.on, "enemy(玛基莎).used(any_magic)");
  assert.equal(magissa.phases[1]?.name, "收尾");
});

void test("expression errors carry the phase, rule and character position", () => {
  const errors = errorsOf({
    version: 2,
    phases: [
      {
        name: "合翅膀",
        when: "true",
        rules: [
          { who: "all", do: "攻击" },
          { who: "all", if: "self.hass(毒)", do: "攻击" },
        ],
      },
    ],
  });
  assert.deepEqual(errors, [
    "阶段「合翅膀」第 2 条规则的 if 第 6 个字:不认识的方法 hass,是不是 has?",
  ]);
});

void test("parse collects several errors instead of stopping at the first", () => {
  const errors = errorsOf({
    version: 1,
    roles: { 蕾娜: 3 },
    rules: [
      { who: "", do: "攻击", once: "yes" },
      { who: "all", if: "self.hp <", do: "不知道:什么", to: "battle.seconds" },
    ],
  });
  assert.ok(errors.some((error) => error.includes("version 要写成 2")));
  assert.ok(errors.some((error) => error.includes("roles 里的「蕾娜」")));
  assert.ok(errors.some((error) => error.includes("缺少 who")));
  assert.ok(errors.some((error) => error.includes("once:只能是 true 或 false")));
  assert.ok(errors.some((error) => error.includes("的 to:要选一个单位")));
});

void test("phases and rules are exclusive", () => {
  const errors = errorsOf({
    version: 2,
    phases: [{ name: "一", rules: [{ who: "all", do: "攻击" }] }],
    rules: [{ who: "all", do: "防御" }],
  });
  assert.ok(errors.some((error) => error.includes("phases 和 rules 只能二选一")));
});

void test("a reaction needs on, and a phase needs a name and rules", () => {
  const errors = errorsOf({
    version: 2,
    reactions: [{ who: "all", do: "攻击" }],
    phases: [{ when: "true" }],
  });
  assert.ok(errors.some((error) => error.includes("缺少 on")));
  assert.ok(errors.some((error) => error.includes("缺少 name")));
  assert.ok(errors.some((error) => error.includes("缺少 rules")));
});

void test("a JSON string is accepted; broken JSON is reported", () => {
  const strategy = parsed('{"version":2,"rules":[{"who":"all","do":"攻击"}]}');
  assert.equal(strategy.rules.length, 1);
  const errors = errorsOf("{not json");
  assert.ok(errors[0]?.includes("不是合法的 JSON"));
});

void test("do accepts the commands, items and abilities with or without an ability name", () => {
  assert.deepEqual(parseAction("攻击"), { command: "攻击", ability: "" });
  assert.deepEqual(parseAction("防御"), { command: "防御", ability: "" });
  assert.deepEqual(parseAction("换列"), { command: "换列", ability: "" });
  assert.deepEqual(parseAction("逃跑"), { command: "逃跑", ability: "" });
  assert.deepEqual(parseAction("道具:不死鸟之尾"), {
    command: "道具",
    ability: "不死鸟之尾",
  });
  assert.deepEqual(parseAction("白魔法:治疗+"), {
    command: "白魔法",
    ability: "治疗+",
  });
  assert.deepEqual(parseAction("召唤"), { command: "召唤", ability: "" });
  assert.deepEqual(parseAction("黑魔法:最强"), {
    command: "黑魔法",
    ability: "最强",
  });
  assert.equal(parseAction("道具"), null);
  assert.equal(parseAction("道具:"), null);
  assert.equal(parseAction(":"), null);
  assert.equal(parseAction("白魔法:治:疗"), null);
});

void test("checkStrategy accepts 逃跑 as a rule action", () => {
  const strategy = parsed({
    version: 2,
    rules: [
      { who: "all", if: "enemy.boss", do: "逃跑" },
      { who: "all", do: "攻击" },
    ],
  });
  assert.deepEqual(checkStrategy(strategy, ["蕾娜", "巴兹"]), []);
});

void test("checkStrategy accepts a party that matches the names and roles", async () => {
  const giant = parsed(await fixture("giant-bird.json"));
  assert.deepEqual(checkStrategy(giant, ["蕾娜", "加拉夫", "法利斯"]), []);
  const magissa = parsed(await fixture("magissa-fuza.json"));
  assert.deepEqual(checkStrategy(magissa, ["蕾娜", "加拉夫", "法利斯"]), []);
  assert.deepEqual(checkStrategy(magissa, [{ name: "蕾娜" }, { name: "加拉夫" }]), []);
});

void test("checkStrategy rejects a fallen target when the action is not a revive", () => {
  const good = parsed({
    version: 2,
    rules: [
      {
        who: "all",
        if: "ally.count(not alive) > 0",
        do: "白魔法:复活",
        to: "ally.first(not alive)",
      },
      { who: "all", do: "攻击" },
    ],
  });
  assert.deepEqual(checkStrategy(good, ["蕾娜", "巴兹"]), []);

  const bad = parsed({
    version: 2,
    rules: [
      {
        who: "all",
        if: "ally.count(not alive) > 0",
        do: "白魔法:治疗",
        to: "ally.first(not alive)",
      },
      { who: "all", do: "攻击" },
    ],
  });
  const problems = checkStrategy(bad, ["蕾娜", "巴兹"]);
  assert.ok(
    problems.some(
      (problem) =>
        problem.includes("第 1 条规则") &&
        problem.includes("目标是倒下的同伴") &&
        problem.includes("不是复活类"),
    ),
  );
});

void test("checkStrategy reports names that are neither in the party nor a role", async () => {
  const magissa = parsed(await fixture("magissa-fuza.json"));
  const problems = checkStrategy(magissa, ["蕾娜", "法利斯"]);
  assert.deepEqual(problems, ["阶段「两只都在」第 2 条规则:队伍里没有「加拉夫」"]);
});

void test("checkStrategy rejects duplicate phase names and an empty strategy", () => {
  const duplicate = parsed({
    version: 2,
    phases: [
      { name: "第一阶段", rules: [{ who: "all", do: "攻击" }] },
      { name: "第一阶段", rules: [{ who: "all", do: "防御" }] },
    ],
  });
  assert.ok(
    checkStrategy(duplicate).some((problem) => problem.includes("阶段名「第一阶段」重复了")),
  );
  assert.deepEqual(checkStrategy({ version: 2 }), ["策略里没有规则"]);
});

void test("the map 64 table that compared a unit with a number fails checkStrategy", () => {
  const table = {
    version: 2,
    summary: "地下1层",
    roles: { 蕾娜: "治疗" },
    reactions: [],
    phases: [
      {
        name: "保命",
        when: "ally.count(not alive) >= 2 or ally.lowest(hp_pct) < 30",
        rules: [{ who: "all", do: "防御" }],
      },
    ],
    rules: [],
  };
  const problems = checkStrategy(table);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /阶段「保命」的 when 第 \d+ 个字/u);
  assert.match(problems[0] ?? "", /不是数/u);
  assert.match(problems[0] ?? "", /ally\.lowest\(hp_pct\)\.hp_pct < 30/u);
});

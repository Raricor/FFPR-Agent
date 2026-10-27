import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ElementKnowledge, EnemyResistances } from "../src/engine/elements.ts";
import {
  abilityCandidates,
  ailmentOf,
  CURES,
  check,
  choose,
  defaultTable,
  FAMILIES,
  holds,
  normalize,
  parse,
  RuleError,
  Situation,
  statuses,
  STATUS_ZH,
  TARGETS,
  targetOf,
  VOCABULARY,
} from "../src/engine/skills/gambit.ts";
import type { Json } from "../src/engine/skills/gambit.ts";

interface SituationData {
  readonly actor: string;
  readonly players: Json[];
  readonly enemies: Json[];
  readonly turn: number;
  readonly boss: boolean;
  readonly items: Record<string, number>;
}

interface ActionData {
  readonly command: string;
  readonly ability: string;
  readonly target: string;
  readonly whom: string | null;
  readonly enemy?: number | null;
  readonly rule: number;
}

interface GambitFixture {
  readonly vocabulary: [string, string][];
  readonly targets: [string, string][];
  readonly statusZh: [string, string][];
  readonly values: readonly { situation: SituationData; values: Record<string, number> }[];
  readonly statuses: readonly { unit: unknown; out: string[] }[];
  readonly holds: readonly { condition: string | null; situation: SituationData; out: boolean }[];
  readonly choose: readonly {
    rules: Json[];
    situation: SituationData;
    skip: number[];
    action: ActionData;
  }[];
  readonly check: readonly { table: unknown; problems: string[] }[];
  readonly normalize: readonly { plan: unknown; out: Record<string, unknown[]> }[];
  readonly defaultTable: readonly { party: unknown[]; out: Record<string, Json[]> }[];
  readonly abilityCandidates: readonly { wanted: string; out: string[] }[];
  readonly cures: Record<string, [string | null, string]>;
  readonly families: Record<string, string[]>;
  readonly parse: readonly {
    condition: string;
    clauses?: [string, string | null, number | null][];
    error?: string;
  }[];
  readonly situations: SituationData[];
  readonly rules: Json[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "gambit", "gambit.json"), "utf8"),
) as GambitFixture;

function situation(data: SituationData): Situation {
  return new Situation(data.actor, data.players, data.enemies, data.turn, data.boss, data.items);
}

void test("the vocabulary and status tables match Python's order and text", () => {
  assert.deepEqual(
    [...VOCABULARY].filter(([name]) => name !== "enemy.name.<怪名>"),
    fixture.vocabulary,
  );
  assert.deepEqual(
    VOCABULARY.get("enemy.name.<怪名>"),
    "有几只活着的敌人叫这个名字,如 enemy.name.喧嚣鬼",
  );
  assert.deepEqual([...TARGETS], fixture.targets);
  assert.deepEqual([...STATUS_ZH], fixture.statusZh);
  assert.deepEqual(Object.fromEntries(Object.entries(CURES)), fixture.cures);
  assert.deepEqual(Object.fromEntries(Object.entries(FAMILIES)), fixture.families);
});

void test("the vocabulary reads the situation", () => {
  for (const item of fixture.values) {
    const s = situation(item.situation);
    for (const [name, expected] of Object.entries(item.values)) {
      assert.equal(s.value(name), expected, name);
    }
  }
  const s = situation(fixture.situations[0] ?? assert.fail("missing situation"));
  assert.equal(Math.round(s.value("ally.hp_pct") * 10) / 10, 4.1);
  assert.equal(s.value("ally.dead"), 1);
  assert.equal(s.value("party.alive"), 3);
  assert.equal(s.value("self.mp"), 16);
  assert.equal(s.value("enemy.boss"), 1);
  assert.ok(holds("ally.hp_pct < 50 and self.mp >= 4", s));
  assert.ok(!holds("ally.dead == 0", s));
  assert.ok(holds("enemy.boss", s));
  assert.ok(holds(null, s));
});

void test("condition parsing reports unknown words and malformed clauses", () => {
  for (const item of fixture.parse) {
    if (item.error) {
      assert.throws(
        () => parse(item.condition),
        (error: unknown) =>
          error instanceof RuleError &&
          `${error.name}: ${error.message}`.replace("enemy.name.<怪名>、", "") === item.error,
        item.condition,
      );
    } else {
      assert.deepEqual(parse(item.condition), item.clauses, item.condition);
    }
  }
});

void test("status types read in Chinese", () => {
  for (const item of fixture.statuses) {
    assert.deepEqual(statuses(item.unit), item.out);
  }
  const s = new Situation("蕾娜", [{ name: "蕾娜", hp: 10, maxHp: 10, status: ["Poison"] }], []);
  assert.ok(holds("ally.status.毒 >= 1 and self.status.毒", s));
});

void test("the first rule that holds and has a target wins", () => {
  for (const item of fixture.choose) {
    const action = choose(item.rules, situation(item.situation), new Set(item.skip));
    assert.deepEqual(action, { ...item.action, enemy: item.action.enemy ?? null });
  }
  const first = choose(fixture.rules, situation(fixture.situations[0] ?? assert.fail("missing")));
  assert.deepEqual(first, {
    command: "白魔法",
    ability: "复活",
    target: "倒下的同伴",
    whom: "加拉夫",
    enemy: null,
    rule: 1,
  });
  const second = choose(
    fixture.rules,
    situation(fixture.situations[0] ?? assert.fail("missing")),
    new Set([1]),
  );
  assert.deepEqual([second.ability, second.target, second.whom], ["治疗", "hp最低的同伴", "巴兹"]);
});

void test("no rule left means attack", () => {
  const action = choose(
    [{ if: "turn > 3", do: "黑魔法:闪雷" }],
    situation(fixture.situations[0] ?? assert.fail("missing")),
  );
  assert.deepEqual([action.command, action.rule], ["攻击", 0]);
});

void test("the check sends bad tables back with reasons", () => {
  for (const item of fixture.check) {
    assert.deepEqual(
      check(item.table).map((problem) => problem.replace("enemy.name.<怪名>、", "")),
      item.problems,
    );
  }
  const problems = check({
    蕾娜: [{ if: "ally.hp < 50", do: "白魔法:治疗" }],
    法利斯: [{ do: "黑魔法:闪雷", target: "最强的敌人" }],
    巴兹: "攻击",
  });
  assert.ok(
    problems.some((problem) => problem.includes("蕾娜 第 1 条") && problem.includes("ally.hp")),
  );
  assert.ok(problems.some((problem) => problem.startsWith("蕾娜:最后一条")));
  assert.ok(problems.some((problem) => problem.includes("最强的敌人")));
  assert.ok(problems.some((problem) => problem.startsWith("巴兹:")));
});

void test("old plans and default rules", () => {
  for (const item of fixture.normalize) {
    assert.deepEqual(normalize(item.plan), item.out);
  }
  assert.deepEqual(normalize({ 巴兹: "攻击" }), { 巴兹: [{ do: "攻击" }] });
  const table = defaultTable(fixture.defaultTable[0]?.party ?? assert.fail("missing party"));
  const rena = table["蕾娜"];
  assert.ok(rena);
  assert.deepEqual(
    rena.slice(0, 4).map((rule) => rule.do),
    ["白魔法:复活", "道具:不死鸟之尾", "白魔法:治疗+", "白魔法:治疗"],
  );
  assert.deepEqual(table["巴兹"]?.at(-1), { do: "攻击" });
  assert.equal(table["法利斯"]?.at(-2)?.do, "黑魔法:最强");
  assert.deepEqual(check(table), []);
});

void test("items in conditions", () => {
  const s = new Situation(
    "蕾娜",
    [
      { name: "巴兹", hp: 8, maxHp: 197, mp: 19 },
      { name: "蕾娜", hp: 60, maxHp: 142, mp: 16 },
      { name: "加拉夫", hp: 0, maxHp: 215, mp: 19 },
      { name: "法利斯", hp: 140, maxHp: 140, mp: 2 },
    ],
    [{ name: "龙虾", hp: 500, maxHp: 650, boss: 1 }],
    1,
    true,
    { 不死鸟之尾: 1, 恢复药: 3 },
  );
  assert.ok(holds("ally.dead >= 1 and item.不死鸟之尾 > 0", s));
  assert.ok(!holds("item.以太 > 0", s));
  const revive = choose(tableOf("蕾娜"), s, new Set([1]));
  assert.deepEqual([revive.command, revive.ability, revive.whom], ["道具", "不死鸟之尾", "加拉夫"]);
  assert.deepEqual(
    check({ 蕾娜: [{ if: "item.恢复药 > 0", do: "道具:恢复药" }, { do: "攻击" }] }),
    [],
  );
});

function tableOf(actor: string): readonly Json[] {
  const table = defaultTable(fixture.defaultTable[0]?.party ?? []);
  return table[actor] ?? [];
}

void test("a status target picks the ailing ally", () => {
  const players: Json[] = [
    { name: "巴兹", hp: 197, maxHp: 197, mp: 19, status: ["毒"] },
    { name: "蕾娜", hp: 142, maxHp: 142, mp: 16 },
    { name: "加拉夫", hp: 0, maxHp: 215, mp: 19 },
    { name: "法利斯", hp: 140, maxHp: 140, mp: 2 },
  ];
  const s = new Situation(
    "蕾娜",
    players,
    [{ name: "龙虾", hp: 500, maxHp: 650, boss: 1 }],
    1,
    true,
  );
  const action = choose(tableOf("蕾娜"), s, new Set([1, 2]));
  assert.deepEqual([action.ability, action.target, action.whom], ["解毒", "状态", "巴兹"]);
  assert.deepEqual(check({ 蕾娜: [{ do: "白魔法:解毒", target: "状态:毒" }, { do: "攻击" }] }), []);
  assert.ok(check({ 蕾娜: [{ do: "白魔法:解毒", target: "状态:" }, { do: "攻击" }] }).length > 0);
});

void test("best spell candidates", () => {
  for (const item of fixture.abilityCandidates) {
    assert.deepEqual(abilityCandidates(item.wanted), item.out, item.wanted);
  }
  assert.deepEqual(abilityCandidates("治疗+"), ["救疗", "治疗"]);
  assert.deepEqual(abilityCandidates("冰冻+"), ["冰冻", "冰结"]);
  assert.deepEqual(abilityCandidates("最强").slice(0, 3), ["烈炎", "冰冻", "震雷"]);
  assert.deepEqual(abilityCandidates("解毒"), ["解毒"]);
});

void test("blindness is cured with eye drops by anyone", () => {
  const players: Json[] = [
    { name: "巴兹", hp: 197, maxHp: 197, mp: 19, jobName: "骑士" },
    { name: "蕾娜", hp: 142, maxHp: 142, mp: 16, jobName: "白魔法师", status: ["Blind"] },
    { name: "加拉夫", hp: 215, maxHp: 215, mp: 19, jobName: "武僧" },
    { name: "法利斯", hp: 140, maxHp: 140, mp: 2, jobName: "黑魔法师" },
  ];
  const s = new Situation("巴兹", players, [], 1, false, { 眼药水: 2 });
  const action = choose(tableOf("巴兹"), s);
  assert.deepEqual([action.command, action.ability, action.whom], ["道具", "眼药", "蕾娜"]);
  s.items = {};
  assert.equal(choose(tableOf("巴兹"), s).command, "攻击");
});

void test("targets and ailments strip spaces", () => {
  assert.equal(targetOf({ target: "hp 最低的同伴" }), "hp最低的同伴");
  assert.equal(targetOf({}), "敌人");
  assert.equal(targetOf({ target: "状态: 毒" }), "状态");
  assert.equal(ailmentOf({ target: "状态: 毒" }), "毒");
});

void test("element vocabulary counts weaknesses and absorbs", () => {
  const elements = {
    lookup: (enemy: unknown): EnemyResistances | null => {
      const book =
        typeof enemy === "object" && enemy !== null ? (enemy as { book?: number }).book : undefined;
      if (book === 39) return { weak: ["冰"], absorb: ["火"], immune: [] };
      if (book === 40) return { weak: ["雷"], absorb: [], immune: ["冰"] };
      return null;
    },
  };
  const enemies: Json[] = [
    { name: "败怨魔", book: 39, hp: 100, maxHp: 100 },
    { name: "摩托陷阱", book: 40, hp: 100, maxHp: 100 },
    { name: "哥布林", hp: 10, maxHp: 10 },
  ];
  const s = new Situation("法利斯", [], enemies, 1, false, {}, elements);
  assert.equal(s.value("enemy.weak.冰"), 1);
  assert.equal(s.value("enemy.weak.雷"), 1);
  assert.equal(s.value("enemy.absorbs.火"), 1);
  assert.equal(s.value("enemy.absorbs.冰"), 0);
  assert.ok(holds("enemy.weak.冰 >= 1", s));
  assert.ok(!holds("enemy.absorbs.冰", s));
  assert.deepEqual(
    check({
      法利斯: [
        { if: "enemy.weak.冰 >= 1", do: "黑魔法:冰结" },
        { if: "enemy.absorbs.火 >= 1", do: "黑魔法:冰结" },
        { do: "攻击" },
      ],
    }),
    [],
  );
  assert.throws(() => parse("enemy.weak.岩浆"), RuleError);
});

void test("the best spell skips absorbed elements and prefers weaknesses", () => {
  assert.deepEqual(abilityCandidates("最强", { weak: [], absorb: [], immune: [] }).slice(0, 3), [
    "烈炎",
    "冰冻",
    "震雷",
  ]);
  assert.deepEqual(abilityCandidates("最强", { weak: ["雷"], absorb: ["冰"], immune: [] }), [
    "震雷",
    "闪雷",
    "烈炎",
    "火炎",
  ]);
  assert.deepEqual(abilityCandidates("最强", { weak: [], absorb: ["火"], immune: ["冰"] }), [
    "震雷",
    "闪雷",
  ]);
  assert.deepEqual(abilityCandidates("冰结", { weak: [], absorb: ["冰"], immune: [] }), []);
  assert.deepEqual(abilityCandidates("冰结", { weak: [], absorb: [], immune: ["冰"] }), []);
});

void test("actionOf resolves every kind of target", () => {
  const s = new Situation(
    "蕾娜",
    [
      { name: "巴兹", hp: 8, maxHp: 197 },
      { name: "蕾娜", hp: 60, maxHp: 142 },
      { name: "加拉夫", hp: 0, maxHp: 215 },
    ],
    [],
  );
  const self = choose([{ do: "防御", target: "自己" }], s);
  assert.deepEqual([self.command, self.whom], ["防御", "蕾娜"]);
  const fallen = choose([{ do: "道具:不死鸟之尾", target: "倒下的同伴" }], s);
  assert.equal(fallen.whom, "加拉夫");
  const none = choose(
    [{ do: "道具:不死鸟之尾", target: "倒下的同伴" }],
    new Situation("蕾娜", [], []),
  );
  assert.equal(none.rule, 0);
});

const ELEMENT_INFO: ElementKnowledge = {
  lookup: (enemy: unknown): EnemyResistances | null => {
    const name = (enemy as Json).name;
    if (name === "冰怪") return { weak: ["冰"], absorb: [], immune: [] };
    return { weak: [], absorb: [], immune: [] };
  },
};

void test("enemy.name counts only living enemies with exactly that name", () => {
  const s = new Situation(
    "巴兹",
    [{ name: "巴兹", hp: 100, maxHp: 100 }],
    [
      { name: "喧嚣鬼", hp: 240, maxHp: 240 },
      { name: "喧嚣鬼", hp: 0, maxHp: 240 },
      { name: "冰怪", hp: 100, maxHp: 100 },
    ],
    1,
    false,
    {},
    ELEMENT_INFO,
  );
  assert.equal(s.value("enemy.name.喧嚣鬼"), 1);
  assert.equal(s.value("enemy.name.冰怪"), 1);
  assert.equal(s.value("enemy.name.幽灵"), 0);
  assert.ok(holds("enemy.name.喧嚣鬼 >= 1", s));
});

void test("the new enemy targets choose the living index and fail over", () => {
  const s = new Situation(
    "巴兹",
    [{ name: "巴兹", hp: 100, maxHp: 100 }],
    [
      { name: "喧嚣鬼", hp: 240, maxHp: 240 },
      { name: "冰怪", hp: 50, maxHp: 100 },
      { name: "死怪", hp: 0, maxHp: 100 },
    ],
    1,
    false,
    {},
    ELEMENT_INFO,
  );
  assert.equal(choose([{ do: "攻击", target: "敌人:喧嚣鬼" }], s).enemy, 0);
  assert.equal(choose([{ do: "攻击", target: "敌人:hp最低" }], s).enemy, 1);
  assert.equal(choose([{ do: "攻击", target: "敌人:弱冰" }], s).enemy, 1);
  assert.equal(choose([{ do: "攻击", target: "敌人" }], s).enemy, null);
  const fallback = choose([{ do: "攻击", target: "敌人:幽灵" }, { do: "防御" }], s);
  assert.deepEqual([fallback.rule, fallback.command, fallback.enemy], [2, "防御", null]);
});

void test("check accepts the new enemy targets and rejects empty names or bad elements", () => {
  assert.deepEqual(
    check({
      巴兹: [{ if: "enemy.name.喧嚣鬼 >= 1", do: "攻击", target: "敌人:喧嚣鬼" }, { do: "攻击" }],
    }),
    [],
  );
  assert.ok(check({ 巴兹: [{ do: "攻击", target: "敌人:" }, { do: "攻击" }] }).length > 0);
  assert.ok(check({ 巴兹: [{ do: "攻击", target: "敌人:弱光" }, { do: "攻击" }] }).length > 0);
});

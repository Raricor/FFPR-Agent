import assert from "node:assert/strict";
import test from "node:test";
import type { BattleRecord } from "../src/engine/battle-record.ts";
import type { ElementKnowledge } from "../src/engine/elements.ts";
import type { PartyMember, DossierInput } from "../src/engine/dossier.ts";
import { MonsterAiCache, readBag, readParty } from "../src/engine/dossier.ts";
import { coverageProblems, partyChangedProblem } from "../src/engine/coverage.ts";
import { FakePilot } from "./fake-pilot.ts";
import type { Json } from "../src/engine/values.ts";

const ELEMENTS: ElementKnowledge = {
  lookup: () => ({ weak: [], absorb: [], immune: [] }),
};

function party(jobs: readonly (readonly [string, string])[]): PartyMember[] {
  return readParty({
    party: jobs.map(([name, jobName]) => ({
      name,
      jobName,
      lv: 10,
      hp: 100,
      maxHp: 100,
      mp: 30,
      maxMp: 30,
    })),
  });
}

function dossier(records: readonly BattleRecord[] = []): DossierInput {
  return {
    monsters: [{ name: "巨翼猛禽", book: 229, id: 281, maxHp: 500, info: null }],
    ai: null,
    elements: ELEMENTS,
    guide: null,
    records,
  };
}

function baseTable(): Json {
  return {
    version: 2,
    summary: "测试",
    roles: {},
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
      { who: "蕾娜", do: "攻击" },
    ],
  };
}

void test("a table that heals, revives and names every dossier mechanic passes", () => {
  const table = baseTable();
  const problems = coverageProblems({
    tables: [table],
    party: party([
      ["蕾娜", "白魔法师"],
      ["加拉夫", "白魔法师"],
    ]),
    bag: readBag({ 恢复药: 2, 不死鸟之尾: 2 }),
    dossier: dossier(),
  });
  assert.deepEqual(problems, []);
});

void test("missing revival and healing are reported as coverage problems", () => {
  const table = baseTable();
  const withoutRevive = {
    ...table,
    reactions: [],
    rules: [{ who: "巴兹", do: "攻击" }],
  };
  const problems = coverageProblems({
    tables: [withoutRevive],
    party: party([
      ["巴兹", "骑士"],
      ["蕾娜", "白魔法师"],
    ]),
    bag: readBag({}),
    dossier: dossier(),
  });
  assert.ok(problems.some((problem) => problem.includes("两个人能复活")));
  assert.ok(problems.some((problem) => problem.includes("没有回复手段")));
});

void test("a status the enemy can inflict needs a rule and the item", async () => {
  const cache = await MonsterAiCache.load("ff5");
  const pilot = new FakePilot();
  pilot.onQuery("monsterai", {
    monsterai: [
      {
        monster: 123,
        abilities: [{ id: 1, name: "毒液", opcode: "Act", rate: 100, table: 0 }],
      },
    ],
  });
  await cache.ensure(pilot, [123]);
  const problems = coverageProblems({
    tables: [baseTable()],
    party: party([["蕾娜", "白魔法师"]]),
    bag: readBag({ 恢复药: 2, 不死鸟之尾: 2 }),
    dossier: {
      monsters: [{ name: "巨翼猛禽", book: 123, id: 281, maxHp: 500, info: null }],
      ai: cache,
      elements: ELEMENTS,
      guide: null,
      records: [],
    },
  });
  assert.ok(problems.some((problem) => problem.includes("敌人会造成「毒」")));
});

void test("a counter and a form change must be mentioned in a phase or reaction", () => {
  const record = {
    enemies: [{ name: "巨翼猛禽", id: 282, book: 229 }],
    events: [{ kind: "battle.act", actor: "巨翼猛禽", action: "利爪", counter: true }],
    turns: [],
    summary: {},
  } as unknown as BattleRecord;
  const problems = coverageProblems({
    tables: [baseTable()],
    party: party([
      ["蕾娜", "白魔法师"],
      ["加拉夫", "白魔法师"],
    ]),
    bag: readBag({ 恢复药: 2, 不死鸟之尾: 2 }),
    dossier: dossier([record]),
  });
  assert.ok(problems.some((problem) => problem.includes("会反击")));
  assert.ok(problems.some((problem) => problem.includes("会变身")));
});

void test("an absorbed element must be mentioned too", () => {
  const problems = coverageProblems({
    tables: [baseTable()],
    party: party([
      ["蕾娜", "白魔法师"],
      ["加拉夫", "白魔法师"],
    ]),
    bag: readBag({ 恢复药: 2, 不死鸟之尾: 2 }),
    dossier: {
      ...dossier(),
      elements: { lookup: () => ({ weak: [], absorb: ["风"], immune: [] }) },
    },
  });
  assert.ok(problems.some((problem) => problem.includes("吸收")));
});

void test("a rule whose command the actor no longer has is rejected", () => {
  const table = {
    ...baseTable(),
    rules: [{ who: "法利斯", do: "黑魔法:火炎", to: "enemy.boss" }],
  };
  const problems = coverageProblems({
    tables: [table],
    party: party([
      ["蕾娜", "白魔法师"],
      ["法利斯", "武僧"],
    ]),
    bag: readBag({ 恢复药: 2, 不死鸟之尾: 2 }),
    dossier: dossier(),
  });
  assert.ok(problems.some((problem) => problem.includes("没有「黑魔法」指令")));
});

void test("a job change that makes a stored rule unusable says which rule and why", () => {
  const table = {
    version: 2,
    roles: {},
    reactions: [],
    phases: [],
    rules: [{ who: "法利斯", do: "黑魔法:火炎", to: "enemy.boss" }],
  };
  const problems = partyChangedProblem(
    table,
    party([
      ["蕾娜", "白魔法师"],
      ["法利斯", "武僧"],
    ]),
    [
      { name: "蕾娜", job: "白魔法师", commands: ["攻击", "防御", "道具", "白魔法"] },
      { name: "法利斯", job: "黑魔法师", commands: ["攻击", "防御", "道具", "黑魔法"] },
    ],
  );
  assert.ok(problems.some((problem) => problem.includes("从黑魔法师换成了武僧")));
  assert.ok(problems.some((problem) => problem.includes("黑魔法:火炎")));
});

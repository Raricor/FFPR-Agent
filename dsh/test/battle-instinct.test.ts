/**
 * Task 104: the instinct layer above the rule tables. Default job tables fight without a
 * tactician, a party with no healer drinks a potion, and a running countdown makes an ordinary
 * road battle flee before the table fights. The sample carries both the timer and the jobs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { FakeBattle } from "./fake-battle.ts";
import { fight } from "../src/engine/skills/battle.ts";
import * as gambit from "../src/engine/skills/gambit.ts";
import { fallbackSteps, StrategyRuntime } from "../src/engine/strategy/execute.ts";
import type { BattleSnapshot, Strategy } from "../src/engine/strategy/types.ts";

const ATTACK: Strategy = {
  version: 2,
  roles: {},
  reactions: [],
  phases: [],
  rules: [{ who: "all", do: "攻击" }],
};

function snapshot(overrides: Partial<BattleSnapshot> = {}): BattleSnapshot {
  return {
    allies: [{ name: "巴兹", hp: 100, maxHp: 100, mp: 20 }],
    enemies: [{ name: "哥布林", id: 1, hp: 50, maxHp: 100 }],
    items: {},
    actor: "巴兹",
    turn: 1,
    ...overrides,
  };
}

function actionFor(
  job: string,
  hp: number,
  mp: number,
  turn = 1,
  items: Record<string, number> = {},
): gambit.Action {
  const member = { name: "巴兹", jobName: job, hp, maxHp: 100, mp };
  const table = gambit.defaultTable([member]);
  const situation = new gambit.Situation(
    "巴兹",
    [member],
    [{ name: "哥布林", id: 1, hp: 50, maxHp: 100 }],
    turn,
    false,
    items,
  );
  return gambit.choose(table["巴兹"] ?? [], situation);
}

void test("the summoner's default table casts the strongest summon while MP lasts", () => {
  const withMp = actionFor("召唤师", 100, 20);
  assert.deepEqual([withMp.command, withMp.ability], ["召唤", "最强"]);
  assert.equal(actionFor("召唤士", 100, 20).command, "召唤", "the task's spelling works too");
  assert.equal(actionFor("召唤师", 100, 0).command, "攻击");
});

void test("the time mage hastes itself on its first turn and attacks after that", () => {
  const first = actionFor("时魔法师", 100, 20, 1);
  assert.deepEqual([first.command, first.ability, first.target], ["时魔法", "加速", "自己"]);
  assert.equal(actionFor("时魔法师", 100, 20, 2).command, "攻击");
  assert.equal(actionFor("时魔法师", 100, 0, 1).command, "攻击");
});

void test("the red mage heals first, then casts the best black magic, then attacks", () => {
  const healing = actionFor("红魔法师", 40, 20);
  assert.deepEqual([healing.command, healing.ability], ["白魔法", "治疗+"]);
  const attacking = actionFor("赤魔法师", 100, 20);
  assert.deepEqual([attacking.command, attacking.ability], ["黑魔法", "最强"]);
  assert.equal(actionFor("红魔法师", 100, 0).command, "攻击");
});

void test("magic knight, blue mage and other jobs drink when the party has no healer", () => {
  for (const job of ["魔法剑士", "青魔法师", "骑士", "", "风水师"]) {
    const action = actionFor(job, 100, 20, 1, { 恢复药: 1 });
    assert.equal(action.command, "攻击", `${job || "无职业"}: nothing to heal at full HP`);
    const low = actionFor(job, 25, 20, 1, { 恢复药: 1 });
    assert.deepEqual(
      [low.command, low.ability, low.target],
      ["道具", "恢复药", "hp最低的同伴"],
      `${job || "无职业"}: a low ally drinks`,
    );
  }
});

void test("a party with a white mage keeps the potion for later", () => {
  const party = [
    { name: "蕾娜", jobName: "白魔法师", hp: 100, maxHp: 100, mp: 20 },
    { name: "巴兹", jobName: "骑士", hp: 25, maxHp: 100, mp: 0 },
  ];
  const table = gambit.defaultTable(party);
  const knight = table["巴兹"] ?? [];
  assert.equal(
    knight.some((rule) => typeof rule.do === "string" && rule.do.startsWith("道具:恢复药")),
    false,
  );
  const situation = new gambit.Situation(
    "巴兹",
    party,
    [{ name: "哥布林", id: 1, hp: 50, maxHp: 100 }],
    1,
    false,
    { 恢复药: 1 },
  );
  assert.equal(gambit.choose(knight, situation).command, "攻击");
  const rena = gambit.choose(table["蕾娜"] ?? [], situation);
  assert.deepEqual([rena.command, rena.ability, rena.whom], ["白魔法", "治疗+", "巴兹"]);
});

void test("a healer out of MP does not stop the party from drinking", () => {
  const party = [
    {
      name: "蕾娜",
      jobName: "白魔法师",
      hp: 100,
      maxHp: 100,
      mp: 0,
      abilities: [],
    },
    { name: "巴兹", jobName: "骑士", hp: 25, maxHp: 100, mp: 0 },
  ];
  const table = gambit.defaultTable(party);
  const situation = new gambit.Situation(
    "巴兹",
    party,
    [{ name: "哥布林", id: 1, hp: 50, maxHp: 100 }],
    1,
    false,
    { 恢复药: 1 },
  );
  assert.deepEqual(
    [
      gambit.choose(table["巴兹"] ?? [], situation).command,
      gambit.choose(table["巴兹"] ?? [], situation).ability,
    ],
    ["道具", "恢复药"],
  );
});

void test("the executor drinks before the table attacks when nobody can heal", () => {
  const runtime = new StrategyRuntime();
  const choice = runtime.choices(
    ATTACK,
    snapshot({
      allies: [{ name: "巴兹", hp: 25, maxHp: 100, mp: 0 }],
      items: { 恢复药: 1 },
    }),
  );
  const first = choice.steps[0];
  assert.ok(first);
  assert.deepEqual([first.action.command, first.action.ability], ["道具", "恢复药"]);
  assert.equal(first.target?.kind === "unit" ? first.target.unit.name : "", "巴兹");
});

void test("the executor leaves the potion for a white mage who can still heal", () => {
  const runtime = new StrategyRuntime();
  const choice = runtime.choices(
    ATTACK,
    snapshot({
      allies: [
        {
          name: "蕾娜",
          hp: 25,
          maxHp: 100,
          mp: 20,
          jobName: "白魔法师",
          abilities: [{ name: "治疗", mp: 4, type: 1 }],
        },
      ],
      items: { 恢复药: 1 },
    }),
  );
  assert.equal(choice.steps[0]?.action.command, "攻击");
});

void test("the fallback also drinks when no healer is left", () => {
  const steps = fallbackSteps(
    ATTACK,
    snapshot({
      allies: [{ name: "巴兹", hp: 20, maxHp: 100, mp: 0 }],
      items: { 恢复药: 1 },
    }),
  );
  assert.deepEqual(
    steps.map((step) => `${step.action.command}:${step.action.ability}`),
    ["道具:恢复药", "攻击:"],
  );
});

void test("a running countdown makes an ordinary battle flee before the rules fight", () => {
  const runtime = new StrategyRuntime();
  const choice = runtime.choices(ATTACK, snapshot({ timerActive: true }));
  assert.deepEqual([choice.steps[0]?.action.command, choice.steps[0]?.basis], ["逃跑", "倒计时"]);
  assert.equal(
    runtime.choices(ATTACK, snapshot({ timerActive: false })).steps[0]?.action.command,
    "攻击",
  );
  assert.equal(
    runtime.choices(ATTACK, snapshot({ timerActive: true, boss: true })).steps[0]?.action.command,
    "攻击",
  );
  assert.equal(
    runtime.choices(ATTACK, snapshot({ timerActive: true }), {
      fleeOnTimer: false,
    }).steps[0]?.action.command,
    "攻击",
  );
});

void test("fight flees an ordinary battle under the timer and holds L1+R1", async () => {
  const sim = new FakeBattle({
    party: [{ name: "巴兹", hp: 100, maxHp: 100, mp: 0, status: [] }],
    enemies: [{ name: "卡纳克犬", id: 300, hp: 60, maxHp: 60 }],
    timerActive: true,
    timerSeconds: 400,
    fleeAfterMs: 3000,
    maxTurns: 10,
  });
  const result = await fight(sim.pilot, ATTACK, 300);
  assert.equal(result.fled, true);
  assert.equal(sim.actions.length, 0);
});

void test("a boss battle under the timer fights instead of fleeing", async () => {
  const sim = new FakeBattle({
    party: [{ name: "巴兹", hp: 100, maxHp: 100, mp: 0, status: [] }],
    enemies: [{ name: "巨翼猛禽", id: 282, hp: 300, maxHp: 300, boss: true }],
    timerActive: true,
    fleeAfterMs: 3000,
    maxTurns: 1,
  });
  const result = await fight(sim.pilot, ATTACK, 30);
  assert.equal(result.fled, undefined);
  assert.deepEqual(
    sim.actions.map((action) => action.command),
    ["攻击"],
  );
});

void test("an old bridge without sample.timer never flees on the countdown", async () => {
  const sim = new FakeBattle({
    party: [{ name: "巴兹", hp: 100, maxHp: 100, mp: 0, status: [] }],
    enemies: [{ name: "卡纳克犬", id: 300, hp: 60, maxHp: 60 }],
    fleeAfterMs: 3000,
    maxTurns: 1,
  });
  const result = await fight(sim.pilot, ATTACK, 30);
  assert.equal(result.fled, undefined);
  assert.deepEqual(
    sim.actions.map((action) => action.command),
    ["攻击"],
  );
});

void test("a fight with no white mage uses a potion on the ally at 25%", async () => {
  const sim = new FakeBattle({
    party: [{ name: "巴兹", jobName: "骑士", hp: 25, maxHp: 100, mp: 0, status: [] }],
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    items: [{ name: "恢复药", count: 1 }],
    maxTurns: 1,
  });
  const result = await fight(sim.pilot, gambit.defaultTable(sim.party), 30);
  assert.equal(result.ok, true);
  assert.deepEqual(
    sim.actions.map((action) => `${action.command}:${action.item}:${action.target}`),
    ["道具:恢复药:巴兹"],
  );
});

void test("a fight with a white mage still has the white mage heal at 25%", async () => {
  const sim = new FakeBattle({
    party: [
      {
        name: "蕾娜",
        jobName: "白魔法师",
        hp: 100,
        maxHp: 100,
        mp: 20,
        status: [],
        spells: ["治疗"],
        abilities: [{ name: "治疗", mp: 4, type: 1 }],
      },
      { name: "巴兹", jobName: "骑士", hp: 25, maxHp: 100, mp: 0, status: [] },
    ],
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    items: [{ name: "恢复药", count: 1 }],
    maxTurns: 1,
  });
  const result = await fight(sim.pilot, gambit.defaultTable(sim.party), 30);
  assert.equal(result.ok, true);
  assert.deepEqual(
    sim.actions.map((action) => `${action.command}:${action.ability}:${action.target}`),
    ["白魔法:治疗:巴兹"],
  );
});

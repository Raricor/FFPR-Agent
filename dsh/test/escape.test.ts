/**
 * Task 54: escaping with L1+R1. The fake battle ends after two held pairs; a boss or a
 * notEscape formation must not end, so the next rule fights instead.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Call } from "./fake-pilot.ts";
import { FakeBattle, battleRows } from "./fake-battle.ts";
import { walkLeg, type MoveState } from "../src/engine/skills/move.ts";
import { fight } from "../src/engine/skills/battle.ts";
import type { Reply } from "../src/engine/pilot.ts";
import type { Strategy } from "../src/engine/strategy/types.ts";

const PARTY = [
  { name: "蕾娜", hp: 100, maxHp: 100, mp: 20, status: [], spells: ["治疗"] },
  { name: "巴兹", hp: 100, maxHp: 100, mp: 10, status: [] },
];

function holds(pilot: FakeBattle["pilot"]): string[] {
  return pilot.calls.flatMap((call: Call) =>
    call.kind === "send" && call.op === "hold" && typeof call.fields.key === "string"
      ? [call.fields.key]
      : [],
  );
}

function sampleOf(sim: FakeBattle, notEscape = false): Reply {
  const rows = battleRows(sim);
  return {
    sample: {
      user: { mapId: 64 },
      battle: {
        enemies: rows.enemies,
        party: rows.players,
        boss: sim.enemies.some((enemy) => enemy.boss === true),
        notEscape,
      },
      party: rows.players,
    },
  };
}

const FLEE: Strategy = {
  version: 2,
  roles: {},
  reactions: [],
  phases: [],
  rules: [{ who: "all", do: "逃跑" }],
};

void test("a 逃跑 rule holds L1 and R1, renews them, and the battle result is fled", async () => {
  const sim = new FakeBattle({
    party: PARTY,
    enemies: [{ name: "小妖魔", id: 300, hp: 666, maxHp: 666 }],
    fleeAfterMs: 3000,
    maxTurns: 50,
  });
  const result = await fight(sim.pilot, FLEE, 300);
  assert.equal(result.fled, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.turns, ["蕾娜→逃跑成功(用了 3 秒)"]);
  assert.equal(sim.actions.length, 0);
  assert.deepEqual(holds(sim.pilot), ["PadL1", "PadR1", "PadL1", "PadR1"]);
  assert.ok(
    sim.pilot.calls.some((call) => call.kind === "send" && call.op === "stop"),
    "the held buttons are released after the battle",
  );
});

void test("a boss or notEscape battle skips the 逃跑 rule and fights the next one", async () => {
  for (const blocked of ["boss", "notEscape"] as const) {
    const sim = new FakeBattle({
      party: PARTY,
      enemies: [{ name: "巨翼猛禽", id: 282, hp: 300, maxHp: 300, boss: blocked === "boss" }],
      notEscape: blocked === "notEscape",
      fleeAfterMs: 3000,
      maxTurns: 1,
    });
    const seen: string[][] = [];
    const strategy: Strategy = {
      ...FLEE,
      rules: [
        { who: "all", do: "逃跑" },
        { who: "all", do: "攻击" },
      ],
    };
    const result = await fight(sim.pilot, strategy, 30, () => undefined, null, {
      onTurn: (turn) => seen.push(turn.skipped.map((skip) => skip.why)),
    });
    assert.equal(result.fled, undefined);
    assert.deepEqual(
      sim.actions.map((action) => action.command),
      ["攻击"],
    );
    assert.deepEqual(holds(sim.pilot), [], `${blocked}: no L1/R1 was held`);
    assert.ok(seen[0]?.includes("这场逃不了"), `${blocked}: the skip says why`);
  }
});

function walkReply(battle: boolean): Reply {
  return {
    ok: !battle,
    pos: { state: battle ? "Battle" : "Player", map: 64, cell: [2, 2] },
    ...(battle ? { error: "interrupted:battle" } : {}),
  };
}

function installWalk(sim: FakeBattle, notEscape = false): void {
  let walked = 0;
  sim.pilot.on("walk", () => {
    walked += 1;
    return walkReply(walked === 1);
  });
  sim.pilot.on("wait", () => ({ ok: true }));
  sim.pilot.onQuery("sample", () => sampleOf(sim, notEscape));
}

void test("go with flee:true escapes the encounter; without it the table fights", async () => {
  const fleeing = new FakeBattle({
    party: PARTY,
    enemies: [{ name: "小妖魔", id: 300, hp: 666, maxHp: 666 }],
    fleeAfterMs: 3000,
    maxTurns: 5,
  });
  installWalk(fleeing);
  const said: string[] = [];
  const state: MoveState = { drake: null, battle: { tableFor: () => FLEE }, flee: true };
  await walkLeg(fleeing.pilot, 2, 2, (line) => said.push(line), state);
  assert.equal(fleeing.actions.length, 0);
  assert.ok(holds(fleeing.pilot).length >= 2, "L1 and R1 were held on the way");
  assert.match(said.join("\n"), /逃跑成功\(用了 3 秒\)/);

  const fighting = new FakeBattle({
    party: PARTY,
    enemies: [{ name: "小妖魔", id: 300, hp: 666, maxHp: 666 }],
    fleeAfterMs: 3000,
    maxTurns: 1,
  });
  installWalk(fighting);
  const attack: Strategy = { ...FLEE, rules: [{ who: "all", do: "攻击" }] };
  const stateNoFlee: MoveState = { drake: null, battle: { tableFor: () => attack } };
  await walkLeg(fighting.pilot, 2, 2, () => undefined, stateNoFlee);
  assert.deepEqual(holds(fighting.pilot), [], "without flee no L1/R1 is held");
  assert.deepEqual(
    fighting.actions.map((action) => action.command),
    ["攻击"],
  );

  // A notEscape formation on the way: no hold, fight the table, and say why.
  const blocked = new FakeBattle({
    party: PARTY,
    enemies: [{ name: "小妖魔", id: 300, hp: 666, maxHp: 666 }],
    notEscape: true,
    fleeAfterMs: 3000,
    maxTurns: 1,
  });
  installWalk(blocked, true);
  const saidBlocked: string[] = [];
  const stateBlocked: MoveState = {
    drake: null,
    battle: { tableFor: () => attack },
    flee: true,
  };
  await walkLeg(blocked.pilot, 2, 2, (line) => saidBlocked.push(line), stateBlocked);
  assert.deepEqual(holds(blocked.pilot), [], "notEscape: no L1/R1 is held");
  assert.deepEqual(
    blocked.actions.map((action) => action.command),
    ["攻击"],
  );
  assert.match(saidBlocked.join("\n"), /这场逃不了\(遇敌组 notEscape\)/);
});

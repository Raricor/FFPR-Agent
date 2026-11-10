import assert from "node:assert/strict";
import test from "node:test";
import { BattleLog, RESULT_TEXT } from "../src/engine/battle-record.ts";

void test("battle.act and battle.hit are kept in the record and shown in the live timeline", async () => {
  const battle = await BattleLog.load("ff5", undefined);
  const session = battle.start({
    mapId: 30,
    mapName: "风之神殿",
    boss: true,
    enemies: [{ name: "巨翼猛禽", id: 281, maxHp: 500, hp: 480, mp: null, status: [], boss: true }],
    party: [{ name: "巴兹", id: 1, maxHp: 100, hp: 97, mp: 10, status: [], boss: false }],
    table: { kind: "boss", mapId: 30 },
    startedAt: "2026-11-03T10:00:00.000Z",
    startedMs: 0,
  });
  battle.noteEvent(
    {
      type: "battle.act",
      actor: { side: "enemy", name: "巨翼猛禽", id: 281 },
      command: { id: 1, name: "攻击" },
      abilities: null,
      targets: [{ side: "player", name: "巴兹", id: 1 }],
      counter: false,
    },
    12_000,
  );
  battle.noteEvent(
    {
      type: "battle.hit",
      act: {
        actor: { side: "enemy", name: "巨翼猛禽", id: 281 },
        command: { id: 1, name: "攻击" },
        abilities: null,
        counter: true,
      },
      target: { side: "player", name: "巴兹", id: 1 },
      value: 3,
      hit: "Hit",
      hitCount: 1,
      miss: false,
      heal: false,
      conditions: null,
    },
    12_500,
  );
  const live = battle.currentView();
  assert.ok(live);
  assert.equal(live.events.length, 2);
  const hit = live.events[1];
  assert.ok(hit);
  assert.match(hit.line, /00:12 巨翼猛禽 → 攻击 → 巴兹 -3/u);
  assert.equal(hit.counter, true);
  assert.match(hit.line, /反击/u);
  const record = await session.finish(20_000, "hard", "巴兹倒下");
  assert.equal(record.events.length, 2);
  assert.equal(record.events[0]?.kind, "battle.act");
  assert.equal(record.events[1]?.kind, "battle.hit");
  assert.equal(RESULT_TEXT.ok, "赢");
});

void test("unknown bridge records are ignored instead of breaking the battle", async () => {
  const battle = await BattleLog.load("ff5", undefined);
  battle.start({
    mapId: null,
    mapName: "",
    boss: false,
    enemies: [],
    party: [],
    table: { kind: "default", mapId: null },
    startedAt: "2026-11-03T10:00:00.000Z",
    startedMs: 0,
  });
  assert.equal(battle.noteEvent({ type: "battle.ai" }, 1000), null);
  assert.equal(battle.currentView()?.events.length, 0);
});

void test("battle events drop icon tags from actor, ability, target and conditions", async () => {
  const battle = await BattleLog.load("ff5", undefined);
  battle.start({
    mapId: null,
    mapName: "",
    boss: false,
    enemies: [],
    party: [],
    table: { kind: "default", mapId: null },
    startedAt: "2026-11-10T10:00:00.000Z",
    startedMs: 0,
  });
  const recorded = battle.noteEvent(
    {
      type: "battle.act",
      actor: { side: "enemy", name: "<IC_DRAG>哥布林", id: 1 },
      command: { id: 1, name: "<IC_WMGC>治疗" },
      abilities: [{ name: "<IC_WMGC>治疗" }],
      targets: [{ side: "player", name: "<IC_BAG>巴兹", id: 1 }],
      counter: false,
    },
    1000,
  );
  assert.equal(recorded?.actor, "哥布林");
  assert.equal(recorded.action, "治疗");
  assert.equal(recorded.target, "巴兹");
  const line = battle.currentView()?.events[0]?.line ?? "";
  assert.match(line, /哥布林 → 治疗 → 巴兹/);
  assert.doesNotMatch(line, /<IC_/);
});

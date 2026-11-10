import assert from "node:assert/strict";
import test from "node:test";
import {
  departureCheck,
  turnBackCheck,
  type AheadPoint,
  type StageTravelState,
} from "../src/engine/stage/gate.ts";
import type { StageFacts, StagePlan, StageTarget } from "../src/engine/stage/types.ts";

type Member = StageFacts["party"][number];

function member(overrides: Partial<Member> = {}): Member {
  return {
    name: "巴兹",
    job: "战士",
    level: 10,
    hp: 100,
    maxHp: 100,
    mp: 20,
    maxMp: 20,
    status: [],
    spells: [],
    ...overrides,
  };
}

function state(overrides: Partial<StageTravelState> = {}): StageTravelState {
  return {
    party: [member()],
    bag: [],
    gil: 1000,
    ...overrides,
  };
}

function plan(overrides: Partial<StagePlan> = {}): StagePlan {
  return {
    threats: [],
    supplies: [],
    spells: [],
    gear: [],
    jobs: [],
    minLevel: null,
    route: [],
    turnBack: [],
    notes: "",
    ...overrides,
  };
}

const RECOVERY_TARGET: StageTarget = {
  mapId: 252,
  areaName: "火力船",
  label: "首领房门口的回复装置",
};

function ahead(distance: number, kind: AheadPoint["kind"] = "recovery"): AheadPoint {
  return { kind, target: RECOVERY_TARGET, distance };
}

void test("departure passes when supplies, spells, jobs and levels are all ready", () => {
  const result = departureCheck(
    plan({
      supplies: [
        { item: "恢复药", min: 2, buyTo: 5 },
        { item: "不死鸟之尾", min: 1, buyTo: 2 },
      ],
      spells: [{ spell: "复活", for: "蕾娜" }],
      jobs: [{ member: "蕾娜", job: "白魔法师", reason: "要复活" }],
      minLevel: 10,
    }),
    state({
      party: [member(), member({ name: "蕾娜", job: "白魔法师", level: 12, spells: ["复活"] })],
      bag: [
        { name: "恢复药", count: 2 },
        { name: "不死鸟之尾", count: 1 },
      ],
    }),
  );
  assert.deepEqual(result, { ok: true, unmet: [] });
});

void test("departure reports a supply that is below its minimum", () => {
  const result = departureCheck(
    plan({ supplies: [{ item: "恢复药", min: 3, buyTo: 5 }] }),
    state({ bag: [{ name: "恢复药", count: 1 }] }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.unmet.length, 1);
  assert.match(result.unmet[0] ?? "", /恢复药/u);
  assert.match(result.unmet[0] ?? "", /3/u);
  assert.match(result.unmet[0] ?? "", /1/u);
});

void test("departure reports a spell its caster has not learned", () => {
  const result = departureCheck(
    plan({ spells: [{ spell: "复活", for: "蕾娜" }] }),
    state({ party: [member({ name: "蕾娜", job: "白魔法师" })] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.unmet[0] ?? "", /蕾娜/u);
  assert.match(result.unmet[0] ?? "", /复活/u);
});

void test("departure reports a member who is still in the wrong job", () => {
  const result = departureCheck(
    plan({ jobs: [{ member: "蕾娜", job: "白魔法师", reason: "要治疗" }] }),
    state({ party: [member({ name: "蕾娜", job: "战士" })] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.unmet[0] ?? "", /蕾娜/u);
  assert.match(result.unmet[0] ?? "", /白魔法师/u);
});

void test("departure reports every member below the plan's minimum level", () => {
  const result = departureCheck(
    plan({ minLevel: 15 }),
    state({
      party: [member({ name: "巴兹", level: 12 }), member({ name: "蕾娜", level: 14 })],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.unmet.length, 1);
  assert.match(result.unmet[0] ?? "", /巴兹\(12 级\)/u);
  assert.match(result.unmet[0] ?? "", /蕾娜\(14 级\)/u);
});

void test("turn back when the plan's item drops below its count", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "item-below", item: "恢复药", count: 3 }] }),
    state({ bag: [{ name: "恢复药", count: 1 }] }),
    [],
  );
  assert.equal(result.turnBack, true);
  assert.equal(result.continueTo, null);
  assert.match(result.reasons[0] ?? "", /恢复药/u);
  assert.match(result.reasons[0] ?? "", /少于 3 个/u);
});

void test("an uncurable status turns back when no recovery point is close", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "status-uncurable", status: "毒" }] }),
    state({ party: [member({ status: ["毒"] })] }),
    [ahead(21)],
  );
  assert.equal(result.turnBack, true);
  assert.equal(result.continueTo, null);
  assert.match(result.reasons[0] ?? "", /毒/u);
  assert.match(result.reasons[0] ?? "", /没有回复点/u);
});

void test("an uncurable status walks on to a recovery point 20 cells ahead", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "status-uncurable", status: "毒" }] }),
    state({ party: [member({ status: ["毒"] })] }),
    [ahead(20)],
  );
  assert.equal(result.turnBack, false);
  assert.deepEqual(result.continueTo, RECOVERY_TARGET);
  assert.match(result.reasons[0] ?? "", /20 格/u);
  assert.match(result.reasons[0] ?? "", /先到那里治/u);
});

void test("a save point alone does not cure a status", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "status-uncurable", status: "毒" }] }),
    state({ party: [member({ status: ["毒"] })] }),
    [ahead(5, "save")],
  );
  assert.equal(result.turnBack, true);
});

void test("a cure in the bag means the status does not turn the party back", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "status-uncurable", status: "毒" }] }),
    state({
      party: [member({ status: ["毒"] })],
      bag: [{ name: "解毒药", count: 1 }],
    }),
    [],
  );
  assert.deepEqual(result, { turnBack: false, reasons: [], continueTo: null });
});

void test("no revive item and no revive spell turns back", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "no-revive" }] }),
    state({ party: [member({ spells: ["治疗", "火炎"] })] }),
    [ahead(3)],
  );
  assert.equal(result.turnBack, true);
  assert.match(result.reasons[0] ?? "", /没有复活手段/u);
});

void test("hp below the plan's percent turns back without a nearby recovery point", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "hp-below", percent: 50 }] }),
    state({ party: [member({ hp: 40, maxHp: 100 })] }),
    [],
  );
  assert.equal(result.turnBack, true);
  assert.match(result.reasons[0] ?? "", /40%/u);
});

void test("hp below the plan's percent walks on to a nearby recovery point", () => {
  const result = turnBackCheck(
    plan({ turnBack: [{ kind: "hp-below", percent: 50 }] }),
    state({ party: [member({ hp: 40, maxHp: 100 })] }),
    [ahead(12)],
  );
  assert.equal(result.turnBack, false);
  assert.deepEqual(result.continueTo, RECOVERY_TARGET);
  assert.match(result.reasons[0] ?? "", /12 格/u);
});

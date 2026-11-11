import assert from "node:assert/strict";
import test from "node:test";
import { checkStagePlan, readStagePlan } from "../src/engine/stage/plan.ts";
import type { StageFacts, StagePlan } from "../src/engine/stage/types.ts";

function makeFacts(overrides: Partial<StageFacts> = {}): StageFacts {
  return {
    target: { mapId: 260, areaName: "火力船", label: "火力船" },
    monsters: [],
    statusThreats: [{ status: "中毒", monsters: ["哥布林"], likelihood: "high" }],
    blueMagicMissing: [],
    chests: [],
    savePoints: [],
    recoveryPoints: [],
    shops: [
      {
        area: "沃尔斯城",
        kind: "道具店",
        products: [
          { name: "恢复药", price: 50 },
          { name: "解毒药", price: 30 },
          { name: "眼药", price: 20 },
          { name: "不死鸟之尾", price: 100 },
        ],
      },
    ],
    party: [
      {
        name: "巴兹",
        job: "战士",
        level: 10,
        hp: 100,
        maxHp: 100,
        mp: 20,
        maxMp: 20,
        status: [],
        spells: [],
      },
      {
        name: "蕾娜",
        job: "白魔导士",
        level: 10,
        hp: 80,
        maxHp: 80,
        mp: 60,
        maxMp: 60,
        status: [],
        spells: ["解毒"],
      },
    ],
    bag: [],
    gil: 500,
    bossNotes: [],
    guideText: "",
    ...overrides,
  };
}

function makePlan(overrides: Partial<StagePlan> = {}): StagePlan {
  return {
    threats: ["中毒"],
    supplies: [{ item: "解毒药", min: 2, buyTo: 3 }],
    spells: [],
    gear: [],
    jobs: [],
    minLevel: 5,
    route: [
      { to: "260" },
      { to: "地图 260" },
      { to: "260:3,4" },
      { to: "3,4" },
      { to: "火力船" },
      { to: "260:5,6", do: "save" },
    ],
    turnBack: [
      { kind: "item-below", item: "解毒药", count: 1 },
      { kind: "status-uncurable", status: "石化" },
      { kind: "no-revive" },
      { kind: "hp-below", percent: 20 },
    ],
    notes: "够了就走",
    ...overrides,
  };
}

function goblin(): StageFacts["monsters"][number] {
  return {
    id: 1,
    bookId: 1,
    name: "哥布林",
    weak: [],
    absorb: [],
    statusMoves: [],
    blueMagic: ["毒针"],
    boss: false,
    sources: [],
    registered: false,
  };
}

void test("a fully prepared plan passes with the four turn-back kinds", () => {
  assert.deepEqual(checkStagePlan(makePlan(), makeFacts()), []);
});

void test("an item no shop sells and the bag does not hold is a problem", () => {
  const plan = makePlan({
    supplies: [
      { item: "解毒药", min: 2, buyTo: 3 },
      { item: "圣水", min: 1, buyTo: 1 },
    ],
  });
  const problems = checkStagePlan(plan, makeFacts());
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /圣水/);
  assert.match(problems[0] ?? "", /商店也没卖/);
});

void test("a purchase above the purse is a problem", () => {
  const plan = makePlan({ supplies: [{ item: "解毒药", min: 2, buyTo: 20 }] });
  const problems = checkStagePlan(plan, makeFacts({ gil: 10 }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /600 gil/);
  assert.match(problems[0] ?? "", /只有 10 gil/);
});

void test("a job for someone not in the party is a problem", () => {
  const plan = makePlan({
    jobs: [{ member: "法里斯", job: "盗贼", reason: "开锁" }],
  });
  const problems = checkStagePlan(plan, makeFacts());
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /法里斯/);
  assert.match(problems[0] ?? "", /队伍里没有这个人/);
});

void test("a malformed route marker is a problem before any key is pressed", () => {
  const plan = makePlan({ route: [{ to: "260:3" }] });
  const problems = checkStagePlan(plan, makeFacts());
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /路线第 1 个路标/);
  assert.match(problems[0] ?? "", /坐标/);
});

void test("a high-likelihood status without its item or spell is a problem", () => {
  const plan = makePlan({ supplies: [], spells: [] });
  const problems = checkStagePlan(plan, makeFacts());
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /高威胁状态「中毒」/);
});

void test("a spell neither sold nor known is a problem", () => {
  const plan = makePlan({ spells: [{ spell: "神圣", for: "蕾娜" }] });
  const problems = checkStagePlan(plan, makeFacts());
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /神圣/);
  assert.match(problems[0] ?? "", /商店没卖/);
});

void test("an unknown price is reported separately instead of being counted", () => {
  const facts = makeFacts({
    shops: [
      {
        area: "沃尔斯城",
        kind: "道具店",
        products: [
          { name: "解毒药", price: 30 },
          { name: "圣水", price: null },
        ],
      },
    ],
  });
  const plan = makePlan({
    supplies: [
      { item: "解毒药", min: 2, buyTo: 3 },
      { item: "圣水", min: 1, buyTo: 1 },
    ],
  });
  const problems = checkStagePlan(plan, facts);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /圣水/);
  assert.match(problems[0] ?? "", /价格未知/);
});

void test("an out-of-range turn-back value is a problem", () => {
  const plan = makePlan({ turnBack: [{ kind: "hp-below", percent: 120 }] });
  const problems = checkStagePlan(plan, makeFacts());
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /percent/);
});

void test("a grind at a place that does not have the named monster is a problem", () => {
  const facts = makeFacts({ monsters: [goblin()] });
  const plan = makePlan({
    route: [{ to: "260", do: "grind", until: { bestiary: ["史莱姆"] } }],
  });
  const problems = checkStagePlan(plan, facts);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /史莱姆/);
  assert.match(problems[0] ?? "", /不在「地图 260」出现/);
});

void test("a grind with an empty until is a problem", () => {
  const plan = makePlan({
    route: [{ to: "260", do: "grind", until: {} }],
  });
  const problems = checkStagePlan(plan, makeFacts());
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /until/);
  assert.match(problems[0] ?? "", /至少/);
});

void test("a blue spell no monster at the grind place casts is a problem", () => {
  const facts = makeFacts({ monsters: [goblin()] });
  const plan = makePlan({
    route: [{ to: "260", do: "grind", until: { blueMagic: ["水波"] } }],
  });
  const problems = checkStagePlan(plan, facts);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /水波/);
  assert.match(problems[0] ?? "", /没有怪会放/);
});

void test("readStagePlan keeps a grind action and its until", () => {
  const plan = readStagePlan({
    threats: [],
    supplies: [],
    spells: [],
    gear: [],
    jobs: [],
    minLevel: null,
    route: [
      {
        to: "260",
        do: "grind",
        until: { bestiary: ["哥布林", 12], battles: 3 },
      },
    ],
    turnBack: [],
    notes: "",
  });
  const stop = plan.route[0];
  assert.ok(stop !== undefined);
  assert.equal(stop.do, "grind");
  assert.deepEqual(stop.until, { bestiary: ["哥布林", 12], battles: 3 });
});

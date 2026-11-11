import assert from "node:assert/strict";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import test from "node:test";
import type { SegmentFactsData, SegmentFactsResult } from "../src/engine/plan/facts.ts";
import {
  PLAN_FACTS_TOOL,
  PLAN_TOOL_DEFINITIONS,
  SEGMENT_PLAN_PARAMETERS,
  SUBMIT_PLAN_TOOL,
  handlePlanFacts,
  handleSubmitPlan,
  type PlanToolPorts,
} from "../src/engine/plan/tools.ts";
import type { SegmentPlan, SegmentReport } from "../src/engine/plan/types.ts";
import type { PlanRevision } from "../src/engine/plan/validate.ts";

function data(): SegmentFactsData {
  return {
    game: "ff5",
    section: "试验迷宫",
    areaName: "试验迷宫",
    goal: "走完试验迷宫",
    maps: [
      {
        mapId: 10,
        name: "试验迷宫 １层",
        areaName: "试验迷宫",
        reasons: [],
        exits: [],
      },
    ],
    passThrough: [],
    revisitMaps: [],
    stations: [],
    chests: [],
    monsters: [],
    bosses: [],
    shops: [],
    party: [
      {
        name: "巴兹",
        job: "战士",
        level: 5,
        hp: 100,
        maxHp: 100,
        mp: 10,
        maxMp: 10,
        status: [],
        spells: [],
      },
    ],
    bag: [],
    gil: 0,
    bestiaryMissing: [],
    blueMagic: [],
    blueMagicMissing: [],
    notes: [],
  };
}

function draft(): SegmentPlan {
  return {
    version: 1,
    section: "试验迷宫",
    goal: "走完试验迷宫",
    prep: { jobs: [], equip: "keep", buy: [], rows: [] },
    stations: [{ to: "10:1,1", do: "open" }],
    battle: [],
    bosses: [],
    turnBack: [],
  };
}

function result(): SegmentFactsResult {
  return { data: data(), text: "事实文本", draftPlan: draft() };
}

interface Calls {
  readonly sections: (string | undefined)[];
  readonly saved: SegmentPlan[];
  readonly previous?: PlanRevision | null;
}

function ports(calls: Calls): PlanToolPorts {
  return {
    facts: (section) => {
      calls.sections.push(section);
      return Promise.resolve(result());
    },
    savePlan: (plan) => {
      calls.saved.push(plan);
      return Promise.resolve();
    },
    previousRun: () => Promise.resolve(calls.previous ?? null),
  };
}

void test("both tool schemas use the subset dsh's assertSupportedJsonSchema accepts", () => {
  assertSupportedJsonSchema(PLAN_FACTS_TOOL.parameters);
  assertSupportedJsonSchema(SUBMIT_PLAN_TOOL.parameters);
  assertSupportedJsonSchema(SEGMENT_PLAN_PARAMETERS);
  assert.equal(PLAN_FACTS_TOOL.name, "plan_facts");
  assert.equal(SUBMIT_PLAN_TOOL.name, "submit_plan");
  assert.deepEqual(
    PLAN_TOOL_DEFINITIONS.map((tool) => tool.name),
    ["plan_facts", "submit_plan"],
  );
  assert.deepEqual(SUBMIT_PLAN_TOOL.parameters.required, [
    "version",
    "section",
    "goal",
    "prep",
    "stations",
    "battle",
    "bosses",
    "turnBack",
  ]);
});

void test("plan_facts passes the requested section and returns the draft JSON", async () => {
  const calls: Calls = { sections: [], saved: [] };
  const answer = await handlePlanFacts(ports(calls), { section: "试验迷宫" });
  assert.deepEqual(calls.sections, ["试验迷宫"]);
  assert.match(answer.text, /事实文本/u);
  assert.match(answer.text, /草稿计划/u);
  assert.match(answer.text, /"version": 1/u);
  assert.equal(answer.draftPlan?.section, "试验迷宫");
  assert.equal(answer.facts?.section, "试验迷宫");
});

void test("submit_plan rejects a bad plan without saving it", async () => {
  const calls: Calls = { sections: [], saved: [] };
  const bad = { ...draft(), goal: "" };
  const answer = await handleSubmitPlan(ports(calls), bad);
  assert.equal(answer.accepted, false);
  assert.ok((answer.problems?.length ?? 0) > 0);
  assert.match(answer.text, /没有通过检查/u);
  assert.equal(calls.saved.length, 0);
});

void test("submit_plan saves a good plan and accepts the {plan} wrapper too", async () => {
  const calls: Calls = { sections: [], saved: [] };
  const answer = await handleSubmitPlan(ports(calls), { plan: draft() });
  assert.equal(answer.accepted, true);
  assert.match(answer.text, /可以 execute_plan/u);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0]?.section, "试验迷宫");
});

void test("submit_plan saves the automatically fixed heal/save station", async () => {
  const calls: Calls = { sections: [], saved: [] };
  const answer = await handleSubmitPlan(ports(calls), {
    ...draft(),
    stations: [{ to: "10:2,2", do: "heal" }],
  });
  assert.equal(answer.accepted, true);
  assert.match(answer.text, /自动补上/u);
  assert.equal(calls.saved[0]?.stations[0]?.optional, true);
});

function report(overrides: Partial<SegmentReport> = {}): SegmentReport {
  return {
    section: "试验迷宫",
    status: "exception",
    done: {
      stations: 0,
      chestsOpened: 0,
      battles: 0,
      bestiaryNew: [],
      blueMagicNew: [],
      bossesWon: [],
    },
    remaining: [0],
    party: "巴兹 HP 100/100",
    minutes: 3,
    modelCalls: 0,
    ...overrides,
  };
}

void test("submit_plan keeps the undone stations of an exception report or takes a reason", async () => {
  const previous: PlanRevision = { plan: draft(), report: report() };
  const missing: Calls = { sections: [], saved: [], previous };
  const rejected = await handleSubmitPlan(ports(missing), {
    ...draft(),
    stations: [],
  });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.text, /还没做的站要留着/u);
  assert.match(rejected.text, /第 1 站 open 10:1,1/u);

  const kept: Calls = { sections: [], saved: [], previous };
  const moved = await handleSubmitPlan(ports(kept), {
    ...draft(),
    stations: [{ to: "10:8,8", do: "open" }],
  });
  assert.equal(moved.accepted, true);

  const dropped: Calls = { sections: [], saved: [], previous };
  const accepted = await handleSubmitPlan(ports(dropped), {
    ...draft(),
    stations: [],
    dropped: [{ to: "10:1,1", do: "open", why: "宝箱已经开过了" }],
  });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(dropped.saved[0]?.dropped, [
    { to: "10:1,1", do: "open", why: "宝箱已经开过了" },
  ]);
});

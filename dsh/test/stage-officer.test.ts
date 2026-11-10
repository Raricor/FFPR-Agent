import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { PresetDefinition } from "@deepseek-ai/dsh-agent-preset-registry";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentActivationSpec, SubagentResult } from "@deepseek-ai/dsh-subagent";
import type { StageFacts, StagePlan } from "../src/engine/stage/types.ts";
import { Config } from "../src/plugin/config.ts";
import {
  callStageOfficer,
  describeStagePlan,
  installStageOfficer,
  STAGE_OFFICER_MAX_ATTEMPTS,
  STAGE_OFFICER_OUTPUT_SCHEMA,
  STAGE_OFFICER_PRESET,
  stageOfficerPrompt,
  type StageOfficerStarter,
} from "../src/plugin/stage-officer.ts";

function makeFacts(): StageFacts {
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
    ],
    bag: [],
    gil: 500,
    bossNotes: [],
    guideText: "",
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
    route: [{ to: "260:3,4", do: "open", optional: true }, { to: "260" }],
    turnBack: [{ kind: "hp-below", percent: 20 }],
    notes: "够了解毒药就走",
    ...overrides,
  };
}

function result(plan: unknown): SubagentResult {
  return { output: [], stopReason: "completed", structured: plan };
}

function starterFrom(
  plans: readonly unknown[],
  seen: SubagentActivationSpec[],
): StageOfficerStarter {
  let index = 0;
  return {
    startActivation(spec) {
      seen.push(spec);
      const plan = plans[Math.min(index, plans.length - 1)];
      index += 1;
      return Promise.resolve({
        childId: `child-${index}` as SessionId,
        result: Promise.resolve(result(plan)),
      });
    },
  };
}

const FACTS_TEXT = "### 火力船\n- 首领:火力船首领\n- 状态:中毒(高)";

void test("a bad first plan is sent back with the problems and the second plan passes", async () => {
  const seen: SubagentActivationSpec[] = [];
  const starter = starterFrom([makePlan({ supplies: [], spells: [] }), makePlan()], seen);
  const answer = await callStageOfficer(
    starter,
    {} as Agent,
    new AbortController().signal,
    makeFacts(),
    FACTS_TEXT,
  );

  assert.equal(seen.length, 2);
  const first = seen[0];
  assert.ok(first);
  assert.equal(first.provider, "spawn");
  assert.equal(first.delivery, "caller");
  assert.equal(first.request.agentPreset, STAGE_OFFICER_PRESET);
  assert.equal(first.request.outputSchema, STAGE_OFFICER_OUTPUT_SCHEMA);
  assert.match(JSON.stringify(first.request.prompt), /火力船/);

  const second = seen[1];
  assert.ok(second);
  const retry = JSON.stringify(second.request.prompt);
  assert.match(retry, /没通过/);
  assert.match(retry, /高威胁状态「中毒」/);

  assert.deepEqual(answer.problems, []);
  assert.equal(answer.plan.supplies[0]?.item, "解毒药");
  assert.match(answer.text, /阶段计划：火力船/);
  assert.match(answer.text, /260:3,4/);
});

void test("a plan that stays bad is returned after two rewrites with its problems", async () => {
  const seen: SubagentActivationSpec[] = [];
  const bad = makePlan({ supplies: [], spells: [] });
  const starter = starterFrom([bad, bad, bad, bad], seen);
  const answer = await callStageOfficer(
    starter,
    {} as Agent,
    new AbortController().signal,
    makeFacts(),
    FACTS_TEXT,
  );

  assert.equal(seen.length, STAGE_OFFICER_MAX_ATTEMPTS);
  assert.equal(answer.problems.length, 1);
  assert.match(answer.problems[0] ?? "", /高威胁状态「中毒」/);
  assert.match(answer.text, /还没通过检查/);
});

void test("a malformed structured result is rewritten instead of trusted", async () => {
  const seen: SubagentActivationSpec[] = [];
  const starter = starterFrom([{ threats: "不是数组" }, makePlan()], seen);
  const answer = await callStageOfficer(
    starter,
    {} as Agent,
    new AbortController().signal,
    makeFacts(),
    FACTS_TEXT,
  );

  assert.equal(seen.length, 2);
  assert.match(JSON.stringify(seen[1]?.request.prompt), /不能当计划用/);
  assert.deepEqual(answer.problems, []);
});

void test("the persona names every structured field and no walkthrough location", () => {
  const prompt = stageOfficerPrompt();
  assert.match(prompt, /阶段官/);
  assert.match(prompt, /supplies/);
  assert.match(prompt, /spells/);
  assert.match(prompt, /青魔法/);
  assert.match(prompt, /route/);
  assert.match(prompt, /item-below/);
  assert.match(prompt, /no-revive/);
  assert.match(prompt, /minLevel/);
  assert.match(prompt, /不要写“看情况”/);
  assert.equal(prompt.includes("火力船"), false);
  assert.deepEqual(STAGE_OFFICER_OUTPUT_SCHEMA.required, [
    "threats",
    "supplies",
    "spells",
    "gear",
    "jobs",
    "minLevel",
    "route",
    "turnBack",
    "notes",
  ]);
});

void test("the plan text lists supplies, jobs, route and turn-back conditions", () => {
  const text = describeStagePlan(
    makePlan({
      jobs: [{ member: "巴兹", job: "青魔法师", reason: "学青魔法" }],
      spells: [{ spell: "解毒", for: "蕾娜" }],
    }),
    "火力船",
  );
  assert.match(text, /巴兹→青魔法师/);
  assert.match(text, /解毒（蕾娜）/);
  assert.match(text, /全队平均 HP 低于 20%/);
});

void test("installing registers ffpr-stage-officer and mounts the persona on its agent", async () => {
  const registered: PresetDefinition[] = [];
  const created: ((payload: { agent: Agent }) => void)[] = [];
  const cleanups: unknown[] = [];
  const presets = {
    register(definition: PresetDefinition) {
      registered.push(definition);
      return Promise.resolve(() => Promise.resolve());
    },
    composedPreset() {
      return STAGE_OFFICER_PRESET;
    },
  };
  const ctx = {
    get: (name: string) => (name === "agentPresets" ? presets : undefined),
    on: (event: string, callback: (payload: { agent: Agent }) => void) => {
      if (event === "agent/created") created.push(callback);
    },
    effect: (callback: () => unknown) => {
      const dispose = callback();
      cleanups.push(dispose);
      return dispose;
    },
  } as unknown as Context;

  await installStageOfficer(
    ctx,
    Config({ role: "panel", game: "ff5", laptopEnv: "/does/not/exist" }),
    { warn: () => undefined },
  );
  const definition = registered[0];
  assert.ok(definition);
  assert.equal(definition.id, STAGE_OFFICER_PRESET);
  assert.deepEqual(definition.plugins, []);
  assert.equal(created.length, 1);

  let persona = "";
  let allowed: unknown;
  let suppressed = false;
  const agentCtx = {
    effect: (callback: () => unknown) => callback(),
    tools: {
      restrict: (value: unknown) => {
        allowed = value;
        return () => undefined;
      },
    },
    systemPrompt: {
      section: (value: { text: string }) => {
        persona = value.text;
        return () => undefined;
      },
      getSectionOrder: () => 0,
      suppressRuntimeContext: () => {
        suppressed = true;
        return () => undefined;
      },
    },
  };
  const notify = created[0];
  assert.ok(notify);
  notify({
    agent: { id: "stage-officer", ctx: agentCtx } as unknown as Agent,
  });
  assert.equal(persona, stageOfficerPrompt());
  assert.deepEqual(allowed, { allow: [] });
  assert.equal(suppressed, true);
  assert.ok(cleanups.length >= 2);
});

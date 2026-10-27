import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { SubagentActivationSpec } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { apply } from "../src/index.ts";
import { Atlas } from "../src/engine/atlas.ts";
import { TACTICIAN_PROMPT } from "../src/engine/prompt.ts";
import * as gambit from "../src/engine/skills/gambit.ts";
import { Config } from "../src/plugin/config.ts";
import {
  callTactician,
  TACTICIAN_OUTPUT_SCHEMA,
  TACTICIAN_PRESET,
  tacticianTools,
  type TacticianStarter,
} from "../src/plugin/tactician.ts";

void test("the tactician has a complete rule-table persona and a required schema", () => {
  assert.match(TACTICIAN_PROMPT, /你是《最终幻想5 像素重制版》的战术官/);
  assert.match(TACTICIAN_PROMPT, /walker_notes/);
  assert.match(TACTICIAN_PROMPT, /ask_up/);
  assert.match(TACTICIAN_PROMPT, /enemy\.weak\.冰/);
  assert.match(TACTICIAN_PROMPT, /最强/);
  assert.match(TACTICIAN_PROMPT, /事实单里列了会的法术时/);
  assert.match(TACTICIAN_PROMPT, /300 字以内/);
  assert.deepEqual(TACTICIAN_OUTPUT_SCHEMA.required, ["tactics", "walker_notes", "ask_up"]);
});

void test("the tactician call uses the spawn preset, the caller delivery and the schema", async () => {
  const agent = {} as Agent;
  const controller = new AbortController();
  let seen: SubagentActivationSpec | undefined;
  const starter: TacticianStarter = {
    startActivation(spec) {
      seen = spec;
      return Promise.resolve({
        result: Promise.resolve({
          output: [],
          stopReason: "completed",
          structured: {
            tactics: [{ 巴兹: [{ do: "攻击" }] }],
            walker_notes: "先开左边的开关",
            ask_up: "缺眼药",
          },
        }),
      });
    },
  };
  const plan = await callTactician(starter, agent, controller.signal, "### 地图\n地图 260 火力船");
  assert.ok(seen);
  assert.equal(seen.provider, "spawn");
  assert.equal(seen.label, "战术官 地图 260");
  assert.equal(seen.request.agentPreset, TACTICIAN_PRESET);
  assert.equal(seen.request.parent, agent);
  assert.equal(seen.request.outputSchema, TACTICIAN_OUTPUT_SCHEMA);
  assert.equal(seen.delivery, "caller");
  assert.equal(seen.request.prompt[0]?.type, "text");
  assert.match(JSON.stringify(seen.request.prompt), /地图 260 火力船/);
  assert.equal(plan.walkerNotes, "先开左边的开关");
  assert.equal(plan.askUp, "缺眼药");
  assert.deepEqual(gambit.check(plan.tables[0]), []);
});

void test("a tactician that stops with an error is a Chinese failure", async () => {
  const starter: TacticianStarter = {
    startActivation() {
      return Promise.resolve({
        result: Promise.resolve({ output: [], stopReason: "error", diagnostic: "模型坏了" }),
      });
    },
  };
  await assert.rejects(
    callTactician(starter, {} as Agent, new AbortController().signal, "地图 1"),
    /战术官没有完成\(error\):模型坏了/,
  );
});

void test("the tactician role registers only guide and atlas, with a complete persona", async () => {
  const created: ((payload: { agent: Agent }) => void)[] = [];
  const ctx = {
    logger: () => ({ info: () => undefined, warn: () => undefined }),
    on: (event: string, callback: (payload: { agent: Agent }) => void) => {
      if (event === "agent/created") created.push(callback);
    },
    effect: (callback: () => unknown) => callback(),
  } as unknown as Context;
  await apply(
    ctx,
    Config({
      role: "tactician",
      laptopEnv: "/does/not/exist",
      atlasFile: join(tmpdir(), "ffpr-tactician-no-atlas.json"),
    }),
  );
  assert.equal(created.length, 1);

  const names: string[] = [];
  let allow: unknown;
  let persona = "";
  let suppressed = false;
  const agentCtx = {
    effect: (callback: () => unknown) => callback(),
    tools: {
      register: (tool: { name: string }) => {
        names.push(tool.name);
        return () => undefined;
      },
      restrict: (value: unknown) => {
        allow = value;
        return () => undefined;
      },
    },
    systemPrompt: {
      section: (value: { text: string }) => {
        persona = value.text;
        return () => undefined;
      },
      suppressRuntimeContext: () => {
        suppressed = true;
        return () => undefined;
      },
      getSectionOrder: () => 0,
    },
  };
  created[0]?.({ agent: { id: "tactician", ctx: agentCtx } as unknown as Agent });
  assert.deepEqual(names, ["guide", "atlas"]);
  assert.deepEqual(allow, { allow: [] });
  assert.equal(persona, TACTICIAN_PROMPT);
  assert.equal(suppressed, true);
});

void test("the tactician's tools are read-only and answer without a game", async () => {
  const tools = tacticianTools(null, new Atlas());
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["guide", "atlas"],
  );
  const exec = { signal: new AbortController().signal } as unknown as ToolRunContext;
  assert.match(
    String(await tools[0]?.execute({ query: "火力船" }, exec)),
    /攻略知识库还没有准备好/,
  );
  assert.match(String(await tools[1]?.execute({}, exec)), /还没有记录任何地图/);
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentActivationSpec } from "@deepseek-ai/dsh-subagent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { apply } from "../src/index.ts";
import { Atlas } from "../src/engine/atlas.ts";
import { tacticianPrompt } from "../src/engine/prompt.ts";
import * as gambit from "../src/engine/skills/gambit.ts";
import { Config } from "../src/plugin/config.ts";
import {
  callTactician,
  TACTICIAN_OUTPUT_SCHEMA,
  TacticianArchiveQueue,
  tacticianPreset,
  tacticianTools,
  type TacticianSessionRecorder,
  type TacticianStarter,
} from "../src/plugin/tactician.ts";

const NO_SESSIONS: TacticianSessionRecorder = { finished: () => undefined };

const PLAN_RESULT = {
  output: [],
  stopReason: "completed" as const,
  structured: {
    tactics: [{ 巴兹: [{ do: "攻击" }] }],
    walker_notes: "先开左边的开关",
    ask_up: "缺眼药",
  },
};

void test("the tactician has a complete rule-table persona and a required schema", () => {
  const prompt = tacticianPrompt("ff5");
  assert.match(prompt, /你是《最终幻想5 像素重制版》的战术官/);
  assert.match(prompt, /walker_notes/);
  assert.match(prompt, /ask_up/);
  assert.match(prompt, /enemy\.first\(weak\(冰\)\)/);
  assert.match(prompt, /最强/);
  assert.match(prompt, /事实单里列了会的法术时/);
  assert.match(prompt, /300 字以内/);
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
        childId: "child-1" as SessionId,
        result: Promise.resolve(PLAN_RESULT),
      });
    },
  };
  const plan = await callTactician(
    starter,
    agent,
    controller.signal,
    "ff5",
    "### 地图\n地图 260 火力船",
    NO_SESSIONS,
  );
  assert.ok(seen);
  assert.equal(seen.provider, "spawn");
  assert.equal(seen.label, "战术官 地图 260");
  assert.equal(seen.request.agentPreset, tacticianPreset("ff5"));
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
        childId: "child-1" as SessionId,
        result: Promise.resolve({ output: [], stopReason: "error", diagnostic: "模型坏了" }),
      });
    },
  };
  await assert.rejects(
    callTactician(starter, {} as Agent, new AbortController().signal, "ff5", "地图 1", NO_SESSIONS),
    /战术官没有完成\(error\):模型坏了/,
  );
});

void test("tactician sessions past the visible limit are archived oldest first", async () => {
  const archived: { readonly sessionId: SessionId; readonly stopActivity?: boolean }[] = [];
  const sessions = new TacticianArchiveQueue({
    keepVisible: 2,
    archive: {
      archiveSession(request) {
        archived.push(request);
        return Promise.resolve({ archivedSessionIds: [request.sessionId] });
      },
    },
    warn: () => undefined,
  });
  let next = 0;
  const starter: TacticianStarter = {
    startActivation() {
      next += 1;
      return Promise.resolve({
        childId: `child-${next}` as SessionId,
        result: Promise.resolve(PLAN_RESULT),
      });
    },
  };
  for (let call = 0; call < 3; call += 1) {
    await callTactician(
      starter,
      {} as Agent,
      new AbortController().signal,
      "ff5",
      "地图 1",
      sessions,
    );
  }
  assert.deepEqual(
    archived.map((call) => call.sessionId),
    ["child-1"],
  );
  assert.equal(archived[0]?.stopActivity, true);
});

void test("an archive failure leaves the tactician's plan alone and warns once", async () => {
  const warnings: string[] = [];
  const sessions = new TacticianArchiveQueue({
    keepVisible: 0,
    archive: {
      archiveSession() {
        return Promise.reject(new Error("Host 坏了"));
      },
    },
    warn: (message) => warnings.push(message),
  });
  let next = 0;
  const starter: TacticianStarter = {
    startActivation() {
      next += 1;
      return Promise.resolve({
        childId: `child-${next}` as SessionId,
        result: Promise.resolve(PLAN_RESULT),
      });
    },
  };
  for (let call = 0; call < 2; call += 1) {
    const plan = await callTactician(
      starter,
      {} as Agent,
      new AbortController().signal,
      "ff5",
      "地图 1",
      sessions,
    );
    assert.equal(plan.walkerNotes, "先开左边的开关");
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /自动归档战术官子会话失败/);
});

void test("a tactician that failed is still recorded and archived later", async () => {
  const archived: SessionId[] = [];
  const sessions = new TacticianArchiveQueue({
    keepVisible: 1,
    archive: {
      archiveSession(request) {
        archived.push(request.sessionId);
        return Promise.resolve({ archivedSessionIds: [request.sessionId] });
      },
    },
    warn: () => undefined,
  });
  let next = 0;
  const starter: TacticianStarter = {
    startActivation() {
      next += 1;
      if (next === 1) {
        return Promise.resolve({
          childId: "child-failed" as SessionId,
          result: Promise.resolve({ output: [], stopReason: "error", diagnostic: "模型坏了" }),
        });
      }
      return Promise.resolve({
        childId: "child-ok" as SessionId,
        result: Promise.resolve(PLAN_RESULT),
      });
    },
  };
  await assert.rejects(
    callTactician(starter, {} as Agent, new AbortController().signal, "ff5", "地图 1", sessions),
    /战术官没有完成\(error\)/,
  );
  assert.deepEqual(archived, []);
  await callTactician(
    starter,
    {} as Agent,
    new AbortController().signal,
    "ff5",
    "地图 1",
    sessions,
  );
  assert.deepEqual(archived, ["child-failed"]);
});

void test("without the workspace controller the tactician works and warns once", async () => {
  const warnings: string[] = [];
  const sessions = new TacticianArchiveQueue({
    keepVisible: 0,
    archive: undefined,
    warn: (message) => warnings.push(message),
  });
  let next = 0;
  const starter: TacticianStarter = {
    startActivation() {
      next += 1;
      return Promise.resolve({
        childId: `child-${next}` as SessionId,
        result: Promise.resolve(PLAN_RESULT),
      });
    },
  };
  for (let call = 0; call < 2; call += 1) {
    const plan = await callTactician(
      starter,
      {} as Agent,
      new AbortController().signal,
      "ff5",
      "地图 1",
      sessions,
    );
    assert.equal(plan.walkerNotes, "先开左边的开关");
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /workspaceController/);
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
  assert.equal(persona, tacticianPrompt("ff5"));
  assert.equal(suppressed, true);
});

void test("a five-game tactician gets only atlas and no FF5 persona", () => {
  const tools = tacticianTools(null, new Atlas(), "ff6");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["atlas"],
  );
  assert.match(tacticianPrompt("ff6"), /你是《最终幻想VI 像素重制版》的战术官/);
  assert.equal(tacticianPrompt("ff6").includes("白魔法"), false);
  assert.equal(tacticianPreset("ff6"), "ffpr-tactician-ff6");
  assert.equal(tacticianPreset("ff5"), "ffpr-tactician");
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

/**
 * Task 160: once the rule file is submitted, the model's turn is over. The guard mounted on the
 * agent must refuse every tool except chapter_status while the executor is running or blocked,
 * including the inherited goal tools, and lift again after the chapter is done.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createScope } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ChapterOwner } from "../src/engine/plan/chapter-tools.ts";
import { chapterBusyText } from "../src/engine/plan/chapter-tools.ts";
import { Config } from "../src/plugin/config.ts";
import { chapterToolGuard, playerToolDefinitions, registerAgent } from "../src/plugin/player.ts";
import type { GameToolHost } from "../src/plugin/tools.ts";
import { FakePilot } from "./fake-pilot.ts";

function host(): GameToolHost {
  return { pilot: () => new FakePilot(), run: () => Promise.resolve("章状态") };
}

function inheritedTool(name: string, onCall: () => void): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [
        { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
      ],
    },
    execute: () => {
      onCall();
      return Promise.resolve("ok");
    },
  };
}

interface Mounted {
  readonly ctx: Context;
  readonly agent: Agent;
  readonly calls: string[];
}

async function mount(owner: () => ChapterOwner | null): Promise<Mounted> {
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(Tools);
  let mounted: Mounted | undefined;
  await root.inject(["tools", "systemPrompt"], (ctx) => {
    const calls: string[] = [];
    for (const name of ["get_goal", "create_goal", "update_goal", "bash"]) {
      ctx.tools.register(
        inheritedTool(name, () => {
          calls.push(name);
        }),
      );
    }
    const agent = { id: "chapter-guard" } as unknown as Agent & { ctx: Context };
    const scope = createScope(ctx, agent);
    (agent as { ctx: Context }).ctx = scope.ctx;
    const tools = playerToolDefinitions(host(), Config({ game: "ff5" }));
    const dispose = registerAgent(agent, tools, "persona", chapterToolGuard(owner));
    ctx.effect(() => dispose);
    mounted = { ctx: scope.ctx, agent, calls };
  });
  if (mounted === undefined) throw new Error("没有挂上玩家工具");
  return mounted;
}

/** Run one call through dsh's real ToolRuntime and return its model-facing text or error. */
async function call(mounted: Mounted, name: string): Promise<{ text: string; error: boolean }> {
  const result = await mounted.ctx.tools.execute({
    callId: `${name}-1` as never,
    name,
    arguments: {},
    agent: mounted.agent,
    signal: new AbortController().signal,
  });
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return { text, error: result.isError };
}

void test("after submit the same round cannot create a goal; no armed goal is made", async () => {
  let owner: ChapterOwner | null = { chapter: 1, status: "running" };
  const mounted = await mount(() => owner);
  const created = await call(mounted, "create_goal");
  assert.equal(created.error, true);
  assert.ok(created.text.includes(chapterBusyText({ chapter: 1, status: "running" })));
  assert.match(created.text, /这一轮到此结束，不要再调用工具/u);
  assert.deepEqual(mounted.calls, [], "create_goal 根本没有执行");
  owner = null;
});

void test("a blocked chapter blocks game, draft and submit tools; chapter_status still works", async () => {
  const owner: ChapterOwner | null = { chapter: 3, status: "blocked" };
  const mounted = await mount(() => owner);
  for (const name of ["go", "chapter_draft_segment", "submit_chapter_plan", "update_goal"]) {
    const blocked = await call(mounted, name);
    assert.equal(blocked.error, true, name);
    assert.ok(
      blocked.text.includes(chapterBusyText({ chapter: 3, status: "blocked" })),
      `${name}: ${blocked.text}`,
    );
    assert.match(blocked.text, /等待开发修复/u, name);
  }
  const status = await call(mounted, "chapter_status");
  assert.equal(status.error, false);
  assert.equal(status.text, "章状态");
  assert.deepEqual(mounted.calls, [], "被挡的工具都没有执行");
});

void test("when the chapter is done the guard is gone and the goal tool runs again", async () => {
  let owner: ChapterOwner | null = { chapter: 2, status: "running" };
  const mounted = await mount(() => owner);
  assert.equal((await call(mounted, "create_goal")).error, true);
  owner = null;
  const allowed = await call(mounted, "create_goal");
  assert.equal(allowed.error, false);
  assert.deepEqual(mounted.calls, ["create_goal"]);
});

void test("a passed submit result tells the model to stop this round, goals included", async () => {
  const submitHost: GameToolHost = {
    pilot: () => new FakePilot(),
    run: () =>
      Promise.resolve(
        "章计划已通过检查并存成当前计划,草稿已清空。\n\n" +
          "规则文件已定稿,执行器接管第 1 章,本轮结束;本章跑完会再叫你规划下一章。",
      ),
  };
  const tool = playerToolDefinitions(submitHost, Config({ game: "ff5" })).find(
    (definition) => definition.name === "submit_chapter_plan",
  );
  assert.ok(tool !== undefined);
  const result = await tool.execute({}, { signal: new AbortController().signal } as Parameters<
    typeof tool.execute
  >[1]);
  assert.match(String(result), /规则文件已定稿，执行器接管第 1 章/u);
  assert.match(String(result), /你这一轮现在就结束/u);
  assert.match(String(result), /不要再调用任何工具（包括建目标）/u);
});

/**
 * Task 153: chapter mode replaces plan mode's tools. The test mounts the player on dsh's real
 * ToolRuntime, the same way player-goal-tools.test.ts does, so inherited tools and the
 * restriction are exercised for real.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createScope } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { Config } from "../src/plugin/config.ts";
import {
  CHAPTER_MODE_PLAN_TOOLS,
  PLAN_MODE_PLAN_TOOLS,
  PLAN_MODE_READONLY_TOOLS,
  playerToolDefinitions,
  registerAgent,
} from "../src/plugin/player.ts";
import type { GameToolHost } from "../src/plugin/tools.ts";
import { FakePilot } from "./fake-pilot.ts";

function host(): GameToolHost {
  return { pilot: () => new FakePilot(), run: () => Promise.resolve("ok") };
}

function inheritedTool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "string" },
      render: () => [{ type: "text", text: "ok" }],
    },
    execute: () => Promise.resolve("ok"),
  };
}

async function visibleTools(config: Config): Promise<{
  readonly visible: readonly string[];
  readonly game: readonly string[];
  readonly timeouts: ReadonlyMap<string, number | undefined>;
}> {
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(Tools);
  let result:
    | {
        visible: string[];
        game: string[];
        timeouts: Map<string, number | undefined>;
      }
    | undefined;
  try {
    await root.inject(["tools", "systemPrompt"], async (ctx) => {
      for (const name of ["get_goal", "create_goal", "update_goal", "bash"]) {
        ctx.tools.register(inheritedTool(name));
      }
      const agent = { id: "chapter-visibility" } as unknown as Agent & {
        ctx: Context;
      };
      const scope = createScope(ctx, agent);
      (agent as { ctx: Context }).ctx = scope.ctx;
      const game = playerToolDefinitions(host(), config);
      const dispose = registerAgent(agent, game, "persona");
      result = {
        visible: scope.ctx.tools.schemas(agent).map((schema) => schema.name),
        game: game.map((tool) => tool.name),
        timeouts: new Map(game.map((tool) => [tool.name, tool.timeoutMs])),
      };
      await dispose();
    });
  } finally {
    await root.fiber.dispose();
  }
  assert.ok(result, "the injected composition should run");
  return result;
}

void test("chapter mode shows the six chapter tools, read-only queries and goal tools", async () => {
  const { visible, game } = await visibleTools(Config({ game: "ff5" }));
  const expected = [...PLAN_MODE_READONLY_TOOLS, ...CHAPTER_MODE_PLAN_TOOLS];
  assert.deepEqual([...game].sort(), [...expected].sort());
  assert.equal(CHAPTER_MODE_PLAN_TOOLS.length, 6);
  for (const name of expected) assert.ok(visible.includes(name), `整章模式应该看得见 ${name}`);
  for (const name of ["get_goal", "create_goal", "update_goal"]) {
    assert.ok(visible.includes(name), `目标工具 ${name} 照旧放行`);
  }
  for (const name of [
    "plan_facts",
    "submit_plan",
    "execute_plan",
    "plan_status",
    "go",
    "route",
    "interact",
    "advance_story",
    "fight",
    "set_tactics",
    "grind",
    "buy",
    "change_job",
    "save_game",
    "scout",
    "bash",
  ]) {
    assert.equal(visible.includes(name), false, `整章模式不该看得见 ${name}`);
  }
  assert.equal(visible.length, expected.length + 3);
  assert.equal(game.includes("execute_chapter"), false, "提交后由代码执行,模型不再有执行工具");
});

void test("chapter mode overrides plan mode when both are on", async () => {
  const { game } = await visibleTools(Config({ game: "ff5", planMode: true, chapterMode: true }));
  for (const name of CHAPTER_MODE_PLAN_TOOLS) assert.ok(game.includes(name), name);
  for (const name of PLAN_MODE_PLAN_TOOLS) assert.equal(game.includes(name), false, name);
});

void test("chapter mode off returns to the plan-mode tool set", async () => {
  const { game } = await visibleTools(Config({ game: "ff5", chapterMode: false }));
  for (const name of PLAN_MODE_PLAN_TOOLS) assert.ok(game.includes(name), name);
  for (const name of CHAPTER_MODE_PLAN_TOOLS) assert.equal(game.includes(name), false, name);
});

void test("chapter mode off and plan mode off restores the old direct-play set", async () => {
  const { game } = await visibleTools(Config({ game: "ff5", chapterMode: false, planMode: false }));
  for (const name of ["go", "route", "interact", "advance_story", "fight", "buy", "scout"]) {
    assert.ok(game.includes(name), `兼容模式应该看得见 ${name}`);
  }
  for (const name of [...PLAN_MODE_PLAN_TOOLS, ...CHAPTER_MODE_PLAN_TOOLS]) {
    assert.equal(game.includes(name), false, `兼容模式不该有 ${name}`);
  }
});

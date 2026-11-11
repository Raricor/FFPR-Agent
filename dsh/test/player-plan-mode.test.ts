import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createScope } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { DEFAULT_SEGMENT_BUDGET_MS } from "../src/engine/plan/execute.ts";
import { Config } from "../src/plugin/config.ts";
import {
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

/** Mount the player on dsh's real ToolRuntime, like player-goal-tools.test.ts does. */
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
      const agent = { id: "plan-visibility" } as unknown as Agent & {
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

void test("plan mode keeps only the plan tools, read-only queries and goal tools", async () => {
  const { visible, game, timeouts } = await visibleTools(
    Config({ game: "ff5", chapterMode: false }),
  );
  const expected = [...PLAN_MODE_READONLY_TOOLS, ...PLAN_MODE_PLAN_TOOLS];
  assert.deepEqual([...game].sort(), [...expected].sort());
  for (const name of expected) {
    assert.ok(visible.includes(name), `计划模式应该看得见 ${name}`);
  }
  for (const name of ["get_goal", "create_goal", "update_goal"]) {
    assert.ok(visible.includes(name), `目标工具 ${name} 照旧放行`);
  }
  for (const name of [
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
    assert.equal(visible.includes(name), false, `计划模式不该看得见 ${name}`);
  }
  assert.equal(visible.length, expected.length + 3);
  assert.equal(timeouts.get("execute_plan"), DEFAULT_SEGMENT_BUDGET_MS + 120_000);
});

void test("plan mode off restores the old tool set and has no plan tools", async () => {
  const { visible, game } = await visibleTools(
    Config({ game: "ff5", planMode: false, chapterMode: false }),
  );
  for (const name of ["go", "route", "interact", "advance_story", "fight", "set_tactics"]) {
    assert.ok(visible.includes(name), `兼容模式应该看得见 ${name}`);
  }
  for (const name of ["buy", "change_job", "save_game", "scout"]) {
    assert.ok(visible.includes(name), `兼容模式应该看得见 ${name}`);
  }
  for (const name of PLAN_MODE_PLAN_TOOLS) {
    assert.equal(visible.includes(name), false, `兼容模式不该有 ${name}`);
  }
  assert.equal(visible.length, game.length + 3);
});

void test("a plan-mode session for another game still keeps the shared read-only tools", async () => {
  const { visible, game } = await visibleTools(Config({ game: "ff6", chapterMode: false }));
  assert.ok(visible.includes("terrain"));
  assert.ok(visible.includes("atlas"));
  assert.ok(visible.includes("inventory"));
  assert.equal(visible.includes("guide"), false, "FF6 没有 guide");
  assert.equal(visible.includes("scout"), false, "scout 是 FF5 的");
  for (const name of PLAN_MODE_PLAN_TOOLS) assert.ok(visible.includes(name), name);
  assert.equal(visible.length, game.length + 3);
});

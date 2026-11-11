import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createScope } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { registerAgent } from "../src/plugin/player.ts";
import { gameToolDefinitions, type GameToolHost } from "../src/plugin/tools.ts";
import { FakePilot } from "./fake-pilot.ts";

function host(): GameToolHost {
  return { pilot: () => new FakePilot(), run: () => Promise.resolve("ok") };
}

/** One inherited global tool; the real ToolRuntime validates this shape at registration. */
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

/**
 * Mount the player on a real dsh ToolRuntime: `ctx.tools` comes from @deepseek-ai/dsh-tools, and
 * the agent scope is minted by @deepseek-ai/dsh-scope. `inherited` names are registered globally,
 * the way a preset's dsh-tool-goal contributes them.
 */
async function visibleTools(inherited: readonly string[]): Promise<{
  readonly visible: readonly string[];
  readonly game: readonly string[];
}> {
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(Tools);
  let result: { visible: string[]; game: string[] } | undefined;
  try {
    await root.inject(["tools", "systemPrompt"], async (ctx) => {
      for (const name of inherited) ctx.tools.register(inheritedTool(name));
      const agent = { id: "goal-visibility" } as unknown as Agent & {
        ctx: Context;
      };
      const scope = createScope(ctx, agent);
      (agent as { ctx: Context }).ctx = scope.ctx;
      const game = gameToolDefinitions(host());
      const dispose = registerAgent(agent, game, "persona");
      result = {
        visible: scope.ctx.tools.schemas(agent).map((schema) => schema.name),
        game: game.map((tool) => tool.name),
      };
      await dispose();
    });
  } finally {
    await root.fiber.dispose();
  }
  assert.ok(result, "the injected composition should run");
  return result;
}

void test("the player keeps the goal tools and hides other inherited tools", async () => {
  const { visible, game } = await visibleTools([
    "bash",
    "read_file",
    "get_goal",
    "create_goal",
    "update_goal",
  ]);
  for (const name of ["get_goal", "create_goal", "update_goal"]) {
    assert.ok(visible.includes(name), `玩家应该看得见 ${name}`);
  }
  assert.equal(visible.includes("bash"), false);
  assert.equal(visible.includes("read_file"), false);
  for (const name of game) assert.ok(visible.includes(name), `玩家应该看得见自己的 ${name}`);
  assert.ok(visible.includes("go"));
  assert.equal(visible.length, game.length + 3);
});

void test("a preset without dsh-tool-goal still mounts the game tools", async () => {
  const { visible, game } = await visibleTools(["bash", "read_file"]);
  assert.deepEqual(visible, game);
  assert.equal(visible.includes("get_goal"), false);
});

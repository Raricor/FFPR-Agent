import assert from "node:assert/strict";
import test from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { TOOLS } from "../src/engine/prompt.ts";
import { FakePilot } from "./fake-pilot.ts";
import {
  DEFAULT_TIMEOUT_MS,
  GAME_TOOL_SCHEMAS,
  gameToolDefinitions,
  timeoutFor,
  type GameToolHost,
} from "../src/plugin/tools.ts";

function host(overrides: Partial<GameToolHost> = {}): GameToolHost {
  return {
    pilot: () => new FakePilot(),
    run: () => Promise.resolve("ok"),
    ...overrides,
  };
}

function exec(signal: AbortSignal): ToolRunContext {
  return { signal } as unknown as ToolRunContext;
}

void test("the game tools are the Python tools without done, with raw JSON Schema", () => {
  const definitions = gameToolDefinitions(host());
  const expected = TOOLS.filter((tool) => tool.function.name !== "done");
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    expected.map((tool) => tool.function.name),
  );
  assert.equal(definitions.length, 26);
  assert.equal(
    definitions.some((tool) => tool.name === "done"),
    false,
  );
  for (const [index, tool] of definitions.entries()) {
    assert.deepEqual(tool.parameters, expected[index]?.function.parameters);
  }
});

void test("the five new games do not get FF5's game operations", () => {
  const ff5 = gameToolDefinitions(host());
  const ff6 = gameToolDefinitions(host(), "ff6", 20);
  const names = (definitions: readonly { name: string }[]): string[] =>
    definitions.map((tool) => tool.name);
  for (const gone of ["change_job", "board", "land", "cast", "guide"]) {
    assert.ok(names(ff5).includes(gone), `FF5 应该有 ${gone}`);
    assert.equal(names(ff6).includes(gone), false, `FF6 不该有 ${gone}`);
  }
  assert.equal(ff5.length, 26);
  assert.equal(ff6.length, 22);
  assert.match(
    String(ff6.find((tool) => tool.name === "save_game")?.description),
    /存档到 20 号存档位/,
  );
  assert.match(
    String(ff5.find((tool) => tool.name === "save_game")?.description),
    /存档到 3 号存档位/,
  );
});

void test("the waiting tools get their longer budgets", () => {
  assert.equal(timeoutFor("advance_story"), 850_000);
  assert.equal(timeoutFor("fight"), 1_100_000);
  for (const name of ["walk_to", "go_to", "interact", "land", "board"]) {
    assert.equal(timeoutFor(name), 800_000);
  }
  assert.equal(timeoutFor("remember"), DEFAULT_TIMEOUT_MS);
  assert.equal(timeoutFor("guide"), DEFAULT_TIMEOUT_MS);
});

void test("a thrown Error becomes a Chinese 工具出错 result", async () => {
  const definitions = gameToolDefinitions(
    host({
      run: () => {
        throw new Error("桥插件没回答");
      },
    }),
  );
  const remember = definitions.find((tool) => tool.name === "remember");
  assert.ok(remember);
  const result = await remember.execute({ note: "x" }, exec(new AbortController().signal));
  assert.equal(result, "工具出错:桥插件没回答");
});

void test("cancellation is not swallowed as a tool result", async () => {
  const definitions = gameToolDefinitions(
    host({
      run: () => {
        throw new DOMException("操作已取消", "AbortError");
      },
    }),
  );
  const remember = definitions.find((tool) => tool.name === "remember");
  assert.ok(remember);
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  await assert.rejects(remember.execute({ note: "x" }, exec(controller.signal)), /用户取消/);
});

void test("the tool call's signal reaches the Pilot", async () => {
  let seen: AbortSignal | undefined;
  const definitions = gameToolDefinitions(
    host({
      pilot: (signal) => {
        seen = signal;
        return new FakePilot();
      },
      run: (_name, _args, _pilot, signal) => {
        assert.equal(seen, signal);
        return Promise.resolve("看过背包");
      },
    }),
  );
  const inventory = definitions.find((tool) => tool.name === "inventory");
  assert.ok(inventory);
  const controller = new AbortController();
  assert.equal(await inventory.execute({}, exec(controller.signal)), "看过背包");
  assert.equal(seen, controller.signal);
});

void test("the prompt has the dsh goal text and no placeholders", async () => {
  const { buildSystemPrompt, openingMessage, withOpening } =
    await import("../src/plugin/player.ts");
  const prompt = buildSystemPrompt("ff5", 3);
  assert.match(prompt, /目标:用户在对话里给你的目标;用户没说就接着之前的进度玩。/);
  assert.equal(prompt.includes("{goal}"), false);
  assert.equal(prompt.includes("{hint}"), false);

  assert.equal(
    openingMessage("地图 1 · 格子 140,99", "20:25 队伍 法利斯 离队"),
    "开始。当前状态:\n地图 1 · 格子 140,99\n\n最近几小时的重要事件:\n20:25 队伍 法利斯 离队",
  );
  assert.equal(openingMessage("看图", ""), "开始。当前状态:\n看图");
  assert.deepEqual(GAME_TOOL_SCHEMAS.length, 26);

  const decision = { kind: "enter" as const, messages: [] };
  const opened = withOpening(decision, 1, "开始。");
  if (opened.kind !== "enter") assert.fail("开局简报应该进入这一步");
  assert.equal(opened.messages.length, 1);
  assert.equal(withOpening(decision, 2, "开始。"), decision); // only the first step of a turn
  assert.equal(withOpening(decision, 1, ""), decision);
  assert.deepEqual(withOpening({ kind: "reject" }, 1, "开始。"), { kind: "reject" });
});

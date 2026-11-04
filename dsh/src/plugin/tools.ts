/**
 * The game tools as dsh tool definitions (control plan §10.3 and task 21). `engine/prompt.ts`
 * keeps the Python version's OpenAI function schemas, the single source of the descriptions the
 * model reads; this module hands their raw JSON Schema to `ctx.tools.register` (the route MCP
 * tools take), so no second schema DSL can drift from the Python text.
 *
 * The five newly started games hide FF5's game operations: the drake (board/land), job changes,
 * the map magic window (cast) and the FF5-only guide. `done` is left out too: in dsh the model
 * ends its turn by answering instead of calling a tool.
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ActivityLog } from "../engine/activity.ts";
import { describeError } from "../engine/errors.ts";
import { byKey } from "../engine/games.ts";
import type { Pilot } from "../engine/pilot.ts";
import { PRESS_TOOL, toolSchemas, type GameToolSchema } from "../engine/prompt.ts";
import { isRecord } from "../engine/values.ts";

/** One tool call's engine side: a Pilot bound to its signal, and the serialized Game. */
export interface GameToolHost {
  pilot(signal: AbortSignal): Pilot;
  run(
    name: string,
    args: Record<string, unknown>,
    pilot: Pilot,
    signal: AbortSignal,
    agent?: Agent,
  ): Promise<string>;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Extra room for one tactician call; the tools that never call one do not get it. */
export const TACTICIAN_TOOL_EXTRA_MS = 200_000;

/** Dialog and battle waits; everything else is one quick menu or query. */
export const TOOL_TIMEOUTS: Readonly<Record<string, number>> = {
  advance_story: 650_000,
  fight: 900_000,
  grind: 3_600_000,
  walk_to: 600_000,
  go_to: 600_000,
  interact: 600_000,
  land: 600_000,
  board: 600_000,
};

const NO_TACTICIAN: ReadonlySet<string> = new Set(["guide", "remember", "forget"]);

/** FF5-only operations: the five new games do not get these tools (task 21). */
const FF5_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "change_job",
  "board",
  "land",
  "cast",
  "guide",
]);

/** The shape `engine/prompt.ts` keeps for each OpenAI function definition. */
export type { GameToolSchema };

export function timeoutFor(name: string): number {
  const base = TOOL_TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS;
  return NO_TACTICIAN.has(name) ? base : base + TACTICIAN_TOOL_EXTRA_MS;
}

/** The tool list one game's player sees, with save_game naming its own slot. */
export function gameToolSchemas(game: string, saveSlot = 20): GameToolSchema[] {
  const ff5 = byKey(game).key === "ff5";
  const schemas: readonly GameToolSchema[] = ff5
    ? toolSchemas(saveSlot)
    : [...toolSchemas(saveSlot), PRESS_TOOL];
  return schemas
    .filter((tool) => {
      const name = tool.function.name;
      return name !== "done" && (ff5 || !FF5_ONLY_TOOLS.has(name));
    })
    .map((tool) => (tool.function.name === "set_tactics" ? withStrategyDocs(tool) : tool));
}

/**
 * Task 41: set_tactics takes strategy 2.0 as well as the old tables. The model sees these
 * descriptions, so both forms and one short 2.0 example belong here (engine/prompt.ts keeps
 * the ported Python text unchanged).
 */
export const STRATEGY_2_HELP =
  "每套表可以写成两种格式:" +
  "旧格式 {角色名: [规则...]};" +
  "或策略 2.0 {version: 2, roles, reactions, phases, rules},who 写角色名、定位名、all 或 any。" +
  '2.0 例子:{version:2, roles:{蕾娜:"治疗"}, reactions:[{who:"any", ' +
  'on:"ally.count(not alive) > 0 and item(不死鸟之尾) > 0", do:"道具:不死鸟之尾", ' +
  'to:"ally.first(not alive)"}], rules:[{who:"all", do:"攻击"}]}';

function withStrategyDocs(tool: GameToolSchema): GameToolSchema {
  // Parameters stay the ported Python schema (test/player compares them); the two formats and
  // the example belong in the description the model reads.
  return {
    ...tool,
    function: {
      ...tool.function,
      description: `${tool.function.description}${STRATEGY_2_HELP}`,
    },
  };
}

/** FF5's 27 tools, kept for tests and callers that already know the game. */
export const GAME_TOOL_SCHEMAS: readonly GameToolSchema[] = gameToolSchemas("ff5", 20);

function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** A log owned by a lazy engine: the tool only gets it once the engine has started. */
export type ActivitySource = ActivityLog | (() => ActivityLog | undefined);

export function gameToolDefinitions(
  host: GameToolHost,
  game = "ff5",
  saveSlot = 20,
  activity?: ActivitySource,
): ToolDefinition[] {
  return gameToolSchemas(game, saveSlot).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    timeoutMs: timeoutFor(tool.function.name),
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: rendered(value) }],
    },
    async execute(args, exec) {
      const name = tool.function.name;
      const fields = isRecord(args) ? args : {};
      const started = Date.now();
      const log = typeof activity === "function" ? activity() : activity;
      try {
        const result = await host.run(
          name,
          fields,
          host.pilot(exec.signal),
          exec.signal,
          exec.agent,
        );
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const summary = (result.split(/\r\n|\r|\n/, 1)[0] ?? "").trim();
        log?.record(
          "tool",
          `${name} ${firstChars(JSON.stringify(fields), 120)} → ${summary}(${seconds} 秒)`,
        );
        return result;
      } catch (error) {
        // Cancellation is dsh's, not the model's: let it settle the call as ABORTED.
        exec.signal.throwIfAborted();
        const message = describeError(error);
        log?.record("error", `${name} 出错:${message}`);
        return `工具出错:${message}`;
      }
    },
  }));
}

/** The first `max` code points of a JSON argument dump (task 24 caps it at 120). */
function firstChars(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

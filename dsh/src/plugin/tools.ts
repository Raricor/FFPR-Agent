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
import { describeError } from "../engine/errors.ts";
import { byKey } from "../engine/games.ts";
import type { Pilot } from "../engine/pilot.ts";
import { PRESS_TOOL, TOOLS } from "../engine/prompt.ts";
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
export interface GameToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export function timeoutFor(name: string): number {
  const base = TOOL_TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS;
  return NO_TACTICIAN.has(name) ? base : base + TACTICIAN_TOOL_EXTRA_MS;
}

/** The tool list one game's player sees, with save_game naming its own slot. */
export function gameToolSchemas(
  game: string,
  saveSlot = byKey(game).key === "ff5" ? 3 : 20,
): GameToolSchema[] {
  const ff5 = byKey(game).key === "ff5";
  const schemas: readonly GameToolSchema[] = ff5 ? TOOLS : [...TOOLS, PRESS_TOOL];
  return schemas
    .filter((tool) => {
      const name = tool.function.name;
      return name !== "done" && (ff5 || !FF5_ONLY_TOOLS.has(name));
    })
    .map((tool) =>
      tool.function.name === "save_game"
        ? {
            ...tool,
            function: {
              ...tool.function,
              description:
                `存档到 ${saveSlot} 号存档位。只能在世界地图或存档点用,迷宫里不行。` +
                "首领战前先存档。",
            },
          }
        : tool,
    );
}

/** FF5's 26 tools, kept for tests and callers that already know the game. */
export const GAME_TOOL_SCHEMAS: readonly GameToolSchema[] = gameToolSchemas("ff5", 3);

function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function gameToolDefinitions(
  host: GameToolHost,
  game = "ff5",
  saveSlot = byKey(game).key === "ff5" ? 3 : 20,
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
      const fields = isRecord(args) ? args : {};
      try {
        return await host.run(
          tool.function.name,
          fields,
          host.pilot(exec.signal),
          exec.signal,
          exec.agent,
        );
      } catch (error) {
        // Cancellation is dsh's, not the model's: let it settle the call as ABORTED.
        exec.signal.throwIfAborted();
        return `工具出错:${describeError(error)}`;
      }
    },
  }));
}

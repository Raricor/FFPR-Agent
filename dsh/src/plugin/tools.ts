/**
 * The 24 game tools as dsh tool definitions (control plan §10.3). `engine/prompt.ts` keeps the
 * Python version's OpenAI function schemas, the single source of the descriptions the model
 * reads; this module hands their raw JSON Schema to `ctx.tools.register` (the route MCP tools
 * take), so no second schema DSL can drift from the Python text.
 *
 * `done` is left out: in dsh the model ends its turn by answering instead of calling a tool.
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describeError } from "../engine/errors.ts";
import type { Pilot } from "../engine/pilot.ts";
import { TOOLS } from "../engine/prompt.ts";
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

export function timeoutFor(name: string): number {
  const base = TOOL_TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS;
  return NO_TACTICIAN.has(name) ? base : base + TACTICIAN_TOOL_EXTRA_MS;
}

/** Python's `done` is the model answering; every other OpenAI tool becomes a dsh tool. */
export const GAME_TOOL_SCHEMAS = TOOLS.filter((tool) => tool.function.name !== "done");

function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function gameToolDefinitions(host: GameToolHost): ToolDefinition[] {
  return GAME_TOOL_SCHEMAS.map((tool) => ({
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
        // Cancellation is dsh's, not the model's: let the registry settle it as ABORTED.
        exec.signal.throwIfAborted();
        return `工具出错:${describeError(error)}`;
      }
    },
  }));
}

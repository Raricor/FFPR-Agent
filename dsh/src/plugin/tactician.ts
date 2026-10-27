/**
 * The dsh glue for the second layer (control plan §4.12): the tactician role's own preset and
 * two read-only tools, and the call the player makes to start one. Every dsh interface is named
 * with its package; engine/ only sees a function that takes facts and returns a plan.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentActivationSpec, SubagentResult } from "@deepseek-ai/dsh-subagent";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import type { ObjectJsonSchema, ToolDefinition } from "@deepseek-ai/dsh-tools";
import { Atlas } from "../engine/atlas.ts";
import { describeError } from "../engine/errors.ts";
import { readTacticianPlan, type TacticianPlan } from "../engine/facts.ts";
import { Guide } from "../engine/guide/kb.ts";
import { TACTICIAN_PROMPT, TOOLS } from "../engine/prompt.ts";
import { isRecord } from "../engine/values.ts";
import type { Config } from "./config.ts";

/** One tactician invocation's limit; the player's tool budgets add room for it. */
export const TACTICIAN_TIMEOUT_MS = 180_000;

/** The preset id the player starts for the second layer. */
export const TACTICIAN_PRESET = "ffpr-tactician";

/** The schema dsh-subagent validates the tactician's structured result against. */
export const TACTICIAN_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: "object",
  properties: {
    tactics: {
      type: "array",
      description: "1–3 套规则表,每套是 {角色名: [规则...]},规则是 {if?, do, target?}",
      items: {
        type: "object",
        description: "角色名 → 规则列表",
        additionalProperties: true,
      },
    },
    walker_notes: {
      type: "string",
      description: "给第一层玩家的走法说明,300 字以内",
    },
    ask_up: {
      type: "string",
      description: "给第一层玩家的建议,没有就填空串",
    },
  },
  required: ["tactics", "walker_notes", "ask_up"],
  additionalProperties: false,
};

/** The part of ctx.subagents this module uses; tests can supply a fake. */
export interface TacticianActivation {
  readonly result: Promise<SubagentResult>;
}

export interface TacticianStarter {
  startActivation(spec: SubagentActivationSpec): Promise<TacticianActivation>;
}

interface Log {
  warn(message: string): void;
}

/**
 * Start one tactician under the calling agent (dsh-subagent `startActivation`, delivery
 * `caller`), wait for its structured result, and read it as a plan.
 */
export async function callTactician(
  starter: TacticianStarter,
  agent: Agent,
  signal: AbortSignal,
  facts: string,
): Promise<TacticianPlan> {
  const map = /地图[:：]?\s*(\d+)/u.exec(facts)?.[1] ?? "?";
  const prompt: ContentBlock[] = [{ type: "text", text: facts }];
  let activation: TacticianActivation;
  try {
    activation = await starter.startActivation({
      provider: "spawn",
      label: `战术官 地图 ${map}`,
      request: {
        agentPreset: TACTICIAN_PRESET,
        prompt,
        parent: agent,
        outputSchema: TACTICIAN_OUTPUT_SCHEMA,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TACTICIAN_TIMEOUT_MS)]),
      delivery: "caller",
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`战术官没有叫起来:${describeError(error)}`, { cause: error });
  }
  let result: SubagentResult;
  try {
    result = await activation.result;
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`战术官没有回答:${describeError(error)}`, { cause: error });
  }
  if (result.stopReason !== "completed") {
    signal.throwIfAborted();
    throw new Error(
      `战术官没有完成(${result.stopReason})` +
        (result.diagnostic === undefined ? "" : `:${result.diagnostic}`),
    );
  }
  return readTacticianPlan(result.structured);
}

/** Register the tactician preset's two read-only tools, loaded once from the shared files. */
export async function installTactician(ctx: Context, config: Config, log: Log): Promise<void> {
  let guide: Guide | null = null;
  try {
    guide = await Guide.load();
  } catch (error) {
    log.warn(`战术官读不了攻略,guide 工具只会报错:${describeError(error)}`);
  }
  let atlas: Atlas;
  try {
    atlas = await Atlas.load(config.atlasFile);
  } catch (error) {
    log.warn(`战术官读不了地图记录,atlas 工具会是空的:${describeError(error)}`);
    atlas = new Atlas(config.atlasFile);
  }
  const tools = tacticianTools(guide, atlas);
  const disposers = new Map<string, () => Promise<void>>();

  ctx.on("agent/created", ({ agent }) => {
    disposers.set(agent.id, registerTacticianAgent(agent, tools));
  });
  ctx.on("agent/disposed", ({ agent }) => {
    disposers.delete(agent.id);
  });

  ctx.effect(() => async () => {
    const pending = [...disposers.values()].map((dispose) => dispose());
    disposers.clear();
    await Promise.all(pending);
  });
}

/** The two tool definitions the tactician sees; no game, no pilot, both read-only. */
export function tacticianTools(guide: Guide | null, atlas: Atlas): ToolDefinition[] {
  const sources = new Map(TOOLS.map((tool) => [tool.function.name, tool.function]));
  const guideSource = sources.get("guide");
  const atlasSource = sources.get("atlas");
  if (guideSource === undefined || atlasSource === undefined) {
    throw new Error("提示词里没有 guide 或 atlas 工具定义");
  }
  return [
    {
      name: "guide",
      description: guideSource.description,
      parameters: guideSource.parameters,
      execute(args, exec) {
        try {
          const fields = isRecord(args) ? args : {};
          const query = typeof fields.query === "string" ? fields.query : "";
          const kind = typeof fields.kind === "string" ? fields.kind : "area";
          const part = typeof fields.part === "number" ? Math.trunc(fields.part) : 1;
          if (guide === null) {
            return Promise.resolve("攻略知识库还没有准备好(要先运行 ffpr-guide fetch)");
          }
          return Promise.resolve(
            guide.lookup(query, part, kind) ||
              `攻略里没有找到「${query}」;换个说法(英文名、地区名或图鉴编号)再查`,
          );
        } catch (error) {
          exec.signal.throwIfAborted();
          return Promise.resolve(`工具出错:${describeError(error)}`);
        }
      },
      output: textOutput,
    },
    {
      name: "atlas",
      description: atlasSource.description,
      parameters: atlasSource.parameters,
      execute(_args, exec) {
        try {
          exec.signal.throwIfAborted();
          return Promise.resolve(atlas.describe());
        } catch (error) {
          exec.signal.throwIfAborted();
          return Promise.resolve(`工具出错:${describeError(error)}`);
        }
      },
      output: textOutput,
    },
  ];
}

const textOutput: ToolDefinition["output"] = {
  schema: { type: "string" },
  render: (_args, value) => [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
};

function registerTacticianAgent(
  agent: Agent,
  tools: readonly ToolDefinition[],
): () => Promise<void> {
  return agent.ctx.effect(() => {
    const owned: (() => void)[] = [];
    for (const tool of tools) owned.push(agent.ctx.tools.register(tool));
    owned.push(agent.ctx.tools.restrict({ allow: [] }));
    owned.push(
      agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
        text: TACTICIAN_PROMPT,
        complete: true,
      }),
    );
    owned.push(agent.ctx.systemPrompt.suppressRuntimeContext());
    return () => {
      for (const dispose of owned.reverse()) dispose();
    };
  });
}

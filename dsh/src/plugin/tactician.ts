/**
 * The dsh glue for the second layer (control plan §4.12): the tactician role's own preset and
 * two read-only tools, and the call the player makes to start one. Every dsh interface is named
 * with its package; engine/ only sees a function that takes facts and returns a plan.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WorkspaceController } from "@deepseek-ai/dsh-api-workspace-controller";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentActivationSpec, SubagentResult } from "@deepseek-ai/dsh-subagent";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import type { ObjectJsonSchema, ToolDefinition } from "@deepseek-ai/dsh-tools";
import { Atlas } from "../engine/atlas.ts";
import { describeError } from "../engine/errors.ts";
import { readTacticianPlan, type TacticianPlan } from "../engine/facts.ts";
import { byKey } from "../engine/games.ts";
import { Guide } from "../engine/guide/kb.ts";
import { tacticianPrompt, TOOLS } from "../engine/prompt.ts";
import { isRecord } from "../engine/values.ts";
import type { Config } from "./config.ts";

/** One tactician invocation's limit; the player's tool budgets add room for it. */
export const TACTICIAN_TIMEOUT_MS = 180_000;

/** The preset id the player starts for its own game's second layer (task 21). */
export function tacticianPreset(game: string): string {
  const key = byKey(game).key;
  return key === "ff5" ? "ffpr-tactician" : `ffpr-tactician-${key}`;
}

/** The schema dsh-subagent validates the tactician's structured result against. */
export const TACTICIAN_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: "object",
  properties: {
    tactics: {
      type: "array",
      description:
        "1–3 套规则表:2.0 {version,roles,reactions,phases,rules} 或旧 {角色名: [规则...]}",
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
  /** The durable child session (dsh-subagent `startActivation`); archived when it gets old. */
  readonly childId: SessionId;
  readonly result: Promise<SubagentResult>;
}

export interface TacticianStarter {
  startActivation(spec: SubagentActivationSpec): Promise<TacticianActivation>;
}

interface Log {
  warn(message: string): void;
}

/** The queue callTactician reports finished children to; a fake in tests. */
export interface TacticianSessionRecorder {
  finished(game: string, childId: SessionId): void;
}

/**
 * Keep only the newest `keepVisible` finished tactician sessions per game and archive older
 * ones through dsh's Host `ctx.workspaceController` (dsh-api-workspace-controller
 * `WorkspaceController.archiveSession`, fetched with the documented `ctx.get()` optional
 * service read). The list lives in memory: after a web restart it is empty, so sessions opened
 * before the restart stay visible (accepted, task 67). Archiving never deletes files and can be
 * undone from the workspace UI. A missing service or a failed archive only warns once; the
 * tactician still works.
 */
export class TacticianArchiveQueue implements TacticianSessionRecorder {
  private readonly keepVisible: number;
  private readonly archive: Pick<WorkspaceController, "archiveSession"> | undefined;
  private readonly warn: (message: string) => void;
  private readonly visible = new Map<string, SessionId[]>();
  private warned = false;

  constructor(options: {
    readonly keepVisible: number;
    readonly archive: Pick<WorkspaceController, "archiveSession"> | undefined;
    readonly warn: (message: string) => void;
  }) {
    this.keepVisible = options.keepVisible;
    this.archive = options.archive;
    this.warn = options.warn;
  }

  /** Record one finished child (success, failure or timeout) and archive the oldest overflow. */
  finished(game: string, childId: SessionId): void {
    const sessions = this.visible.get(game) ?? [];
    sessions.push(childId);
    this.visible.set(game, sessions);
    while (sessions.length > this.keepVisible) {
      const oldest = sessions.shift();
      if (oldest === undefined) return;
      this.archiveOne(oldest);
    }
  }

  private archiveOne(sessionId: SessionId): void {
    if (this.archive === undefined) {
      this.warnOnce(
        "dsh 没有提供 workspaceController 服务,战术官子会话不会自动归档;战术官照常工作",
      );
      return;
    }
    try {
      void this.archive
        .archiveSession({ sessionId, stopActivity: true })
        .catch((error: unknown) => {
          this.warnOnce(`自动归档战术官子会话失败:${describeError(error)};战术官照常工作`);
        });
    } catch (error) {
      // A service may throw before returning its promise; keep that out of the tactician call.
      this.warnOnce(`自动归档战术官子会话失败:${describeError(error)};战术官照常工作`);
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(message);
  }
}

/**
 * Start one tactician under the calling agent (dsh-subagent `startActivation`, delivery
 * `caller`), wait for its structured result, and read it as a plan.
 */
export async function callTactician(
  starter: TacticianStarter,
  agent: Agent,
  signal: AbortSignal,
  game: string,
  facts: string,
  sessions: TacticianSessionRecorder,
): Promise<TacticianPlan> {
  const map = /地图[:：]?\s*(\d+)/u.exec(facts)?.[1] ?? "?";
  const prompt: ContentBlock[] = [{ type: "text", text: facts }];
  let activation: TacticianActivation;
  try {
    activation = await starter.startActivation({
      provider: "spawn",
      label: `战术官 地图 ${map}`,
      request: {
        agentPreset: tacticianPreset(game),
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
  } finally {
    // Covers success, a non-completed stop and a result rejection (including the timeout).
    sessions.finished(game, activation.childId);
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

/** Register the tactician preset's read-only tools, loaded once from this game's files. */
export async function installTactician(ctx: Context, config: Config, log: Log): Promise<void> {
  const ff5 = byKey(config.game).key === "ff5";
  let guide: Guide | null = null;
  if (ff5) {
    try {
      guide = await Guide.load();
    } catch (error) {
      log.warn(`战术官读不了攻略,guide 工具只会报错:${describeError(error)}`);
    }
  }
  let atlas: Atlas;
  try {
    atlas = await Atlas.load(config.atlasFile);
  } catch (error) {
    log.warn(`战术官读不了地图记录,atlas 工具会是空的:${describeError(error)}`);
    atlas = new Atlas(config.atlasFile);
  }
  const tools = tacticianTools(guide, atlas, config.game);
  const prompt = tacticianPrompt(config.game);
  const disposers = new Map<string, () => Promise<void>>();

  ctx.on("agent/created", ({ agent }) => {
    disposers.set(agent.id, registerTacticianAgent(agent, tools, prompt));
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

/** The read-only tools the tactician sees; the five new games have no guide (task 21). */
export function tacticianTools(guide: Guide | null, atlas: Atlas, game = "ff5"): ToolDefinition[] {
  const sources = new Map(TOOLS.map((tool) => [tool.function.name, tool.function]));
  const guideSource = sources.get("guide");
  const atlasSource = sources.get("atlas");
  if (guideSource === undefined || atlasSource === undefined) {
    throw new Error("提示词里没有 guide 或 atlas 工具定义");
  }
  const tools: ToolDefinition[] = [];
  if (byKey(game).key === "ff5") {
    tools.push({
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
    });
  }
  tools.push({
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
  });
  return tools;
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
  prompt: string,
): () => Promise<void> {
  return agent.ctx.effect(() => {
    const owned: (() => void)[] = [];
    for (const tool of tools) owned.push(agent.ctx.tools.register(tool));
    owned.push(agent.ctx.tools.restrict({ allow: [] }));
    owned.push(
      agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
        text: prompt,
        complete: true,
      }),
    );
    owned.push(agent.ctx.systemPrompt.suppressRuntimeContext());
    return () => {
      for (const dispose of owned.reverse()) dispose();
    };
  });
}

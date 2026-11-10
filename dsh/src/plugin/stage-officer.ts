/**
 * The stage officer (task 95, 11-10): a dsh subagent that plans one stage before the code walks
 * it. This module owns the persona, the structured-output schema, the retry loop and the
 * programmatic `ffpr-stage-officer` preset; wiring the tool and the game flow is a later task.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AgentPresetRegistry, PresetDefinition } from "@deepseek-ai/dsh-agent-preset-registry";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentActivationSpec, SubagentResult } from "@deepseek-ai/dsh-subagent";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import type { JsonSchemaNode, ObjectJsonSchema } from "@deepseek-ai/dsh-tools";
import { describeError } from "../engine/errors.ts";
import { checkStagePlan, readStagePlan } from "../engine/stage/plan.ts";
import { describeStagePlan } from "../engine/stage/report.ts";
import type { StageFacts, StagePlan } from "../engine/stage/types.ts";
import type { Config } from "./config.ts";

/** The preset id the stage-officer subagent is started with. */
export const STAGE_OFFICER_PRESET = "ffpr-stage-officer";

/** One stage-officer invocation's limit. */
export const STAGE_OFFICER_TIMEOUT_MS = 180_000;

/** Initial call plus two rewrites, as the task asks ("最多重试两次"). */
export const STAGE_OFFICER_MAX_ATTEMPTS = 3;

/** The part of ctx.subagents this module uses; tests can supply a fake. */
export interface StageOfficerActivation {
  readonly childId: SessionId;
  readonly result: Promise<SubagentResult>;
}

export interface StageOfficerStarter {
  startActivation(spec: SubagentActivationSpec): Promise<StageOfficerActivation>;
}

export interface StageOfficerAnswer {
  readonly plan: StagePlan;
  readonly problems: readonly string[];
  /** Human-readable plan for the game flow; the caller may show it as a tool result. */
  readonly text: string;
}

interface Log {
  warn(message: string): void;
}

function nullable(node: JsonSchemaNode): JsonSchemaNode {
  return { oneOf: [node, { type: "null" }] };
}

/** The schema dsh-subagent validates the stage officer's structured result against. */
export const STAGE_OFFICER_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: "object",
  properties: {
    threats: {
      type: "array",
      items: { type: "string" },
      description: "这一段要防的威胁，一行一条",
    },
    supplies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string", description: "道具名" },
          min: { type: "integer", description: "出发前至少要有几个" },
          buyTo: { type: "integer", description: "买到几个" },
        },
        required: ["item", "min", "buyTo"],
        additionalProperties: false,
      },
    },
    spells: {
      type: "array",
      items: {
        type: "object",
        properties: {
          spell: { type: "string", description: "魔法名" },
          for: {
            ...nullable({ type: "string" }),
            description: "施法者的成员名；没有指定就写 null",
          },
        },
        required: ["spell", "for"],
        additionalProperties: false,
      },
    },
    gear: { type: "array", items: { type: "string" }, description: "要换或要买的装备" },
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          member: { type: "string", description: "队伍里的成员名" },
          job: { type: "string", description: "目标职业" },
          reason: { type: "string", description: "为什么换" },
        },
        required: ["member", "job", "reason"],
        additionalProperties: false,
      },
    },
    minLevel: {
      ...nullable({ type: "integer" }),
      description: "全队出发前的最低等级；没有要求就写 null",
    },
    route: {
      type: "array",
      items: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "地图号、地图名、当前地图坐标 “x,y” 或 “地图号:x,y”",
          },
          do: {
            type: "string",
            enum: ["open", "save", "talk", "grind"],
            description:
              "open 开宝箱/拿隐藏道具，save 存档，talk 调查/对话，grind 到 to 刷怪（要写 until）",
          },
          until: {
            type: "object",
            description: "do: grind 时刷到什么为止；至少写一项。到 to 后由代码刷怪，满足一项就停。",
            properties: {
              bestiary: {
                type: "array",
                items: { oneOf: [{ type: "string" }, { type: "integer" }] },
                description: "要登记进本档图鉴的怪名或图鉴号",
              },
              blueMagic: {
                type: "array",
                items: { type: "string" },
                description: "要学会的青魔法名",
              },
              battles: { type: "integer", description: "刷满多少场就停" },
              minutes: { type: "number", description: "最多刷多少分钟" },
            },
            additionalProperties: false,
          },
          optional: { type: "boolean", description: "倒计时紧时可以跳过" },
        },
        required: ["to"],
        additionalProperties: false,
      },
    },
    turnBack: {
      type: "array",
      description: "走到一半必须回头的条件",
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "item-below" },
              item: { type: "string" },
              count: { type: "integer" },
            },
            required: ["kind", "item", "count"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "status-uncurable" },
              status: { type: "string" },
            },
            required: ["kind", "status"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { type: "string", const: "no-revive" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", const: "hp-below" },
              percent: { type: "integer" },
            },
            required: ["kind", "percent"],
            additionalProperties: false,
          },
        ],
      },
    },
    notes: { type: "string", description: "给执行代码的简短说明" },
  },
  required: [
    "threats",
    "supplies",
    "spells",
    "gear",
    "jobs",
    "minLevel",
    "route",
    "turnBack",
    "notes",
  ],
  additionalProperties: false,
};

/**
 * The stage officer's persona. It deliberately contains no walkthrough: the only game-specific
 * facts are the ones the code put into the fact sheet.
 */
export const STAGE_OFFICER_PROMPT = `你是《最终幻想5 像素重制版》的阶段官。一段路开始前只做一次规划：读代码给的事实单，交回这一段路的出发清单、路线和回头条件；之后代码走路、买东西、打仗，不再问你。

事实单是唯一的信息来源：怪物、状态、青魔法、宝箱、存档点、回复点、商店、队伍、背包、钱和攻略摘录都在里面。事实单没写的不要编；攻略只从事实单来；不要写“小心敌人”“做好准备”这类空话。

只交结构化结果，字段都要填：
- threats：这一段真正要防的威胁，一行一条，写状态、怪或首领以及为什么。
- supplies：要带的道具。min 是出发前至少要有几个，buyTo 是买到几个；数量要够走完这一段，按事实单里的状态威胁和缺口准备，复活道具也算。
- spells：这一段要用的魔法。for 写施法者（队伍里的名字），没指定就写 null；按弱点、首领和回复准备；要学青魔法时，把对应的青魔法师和魔法安排进去。
- gear：要换或要买的装备，只写事实单里商店有卖或队伍已经有的。
- jobs：要换职业的成员。member 必须是队伍里的人，job 写目标职业，reason 写为什么；为学青魔法安排青魔法师也写在这里。
- minLevel：全队出发前的最低等级，或者 null。
- route：按顺序的路标。to 和 go/route 的写法一样：地图号（例如 12）、地图名（例如 港口）、当前地图的坐标（“3,4”）、或“地图号:x,y”（例如 “12:3,4”）。do 只能是 open（宝箱、隐藏道具）、save（存档点）、talk（调查、对话）、grind（到 to 刷怪），省略就是走到；optional 是可选路标（宝箱一般可以跳过）。
  路标要覆盖：可选宝箱、存档点、回复点、终点；不要漏掉事实单里这一段必经的地方。
  事实单里写着“本档图鉴:缺”的怪、还没学的青魔法，按“会不会错过”决定要不要安排刷：会错过、过了这一段就难补的，安排一个 do: grind 的路标，to 写在哪个地图或区域刷，until 至少写一项（bestiary 怪名或图鉴号、blueMagic 青魔法名、battles 场数、minutes 分钟），写清刷到什么为止；不会错过、以后顺路能补的可以不排。
- turnBack：走到一半必须回头的条件，只能用四种：
  {"kind":"item-below","item":"道具名","count":N}：道具少于 N 个；
  {"kind":"status-uncurable","status":"状态名"}：有人带着状态且治不了；
  {"kind":"no-revive"}：没有复活手段；
  {"kind":"hp-below","percent":N}：全队平均 HP 低于百分之 N，N 在 1 到 100。
  条件要能从队伍、背包和事实单直接判断，数量写实际能用的值。
- notes：给执行代码看的简短说明：钱不够时先买什么、哪些路标可以跳过、到了哪里要停。不要写攻略正文。

出发前自己核对：
- 状态威胁里 likelihood 是 high 的，每一条都要有对应的药或魔法；数量按这一段可能连续中招来备。
- 要买的东西必须在商店里买得到，或者背包里已经够；总价不能超过身上的钱。钱不够就在 notes 里写清楚先买什么。
- spells 必须是商店有卖或队友已经会的；jobs 的成员必须在队伍里。
- 路线和回头条件都要能直接交给代码执行，不要写“看情况”。

只交结构化结果，不要在结果里重复事实单。`;

/** The persona text the installer puts on a stage-officer agent. */
export function stageOfficerPrompt(): string {
  return STAGE_OFFICER_PROMPT;
}

function retryText(problems: readonly string[]): string {
  return [
    "上一次交的计划没通过这些检查：",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "请按事实单重新交一份完整的计划，只改这些地方，不要解释。",
  ].join("\n");
}

function attemptLabel(facts: StageFacts, attempt: number): string {
  const where = facts.target.label.trim() || "这一段";
  return attempt === 1 ? `阶段官 ${where}` : `阶段官 ${where}（第 ${attempt} 次）`;
}

/**
 * Call one stage officer and rewrite it when `checkStagePlan` objects. A malformed structured
 * result is retried the same way; after the last attempt the last readable plan is returned
 * with its remaining problems so the gate can show exactly why departure is blocked.
 */
export async function callStageOfficer(
  starter: StageOfficerStarter,
  agent: Agent,
  signal: AbortSignal,
  facts: StageFacts,
  factsText: string,
): Promise<StageOfficerAnswer> {
  let lastPlan: StagePlan | null = null;
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= STAGE_OFFICER_MAX_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const prompt: ContentBlock[] = [{ type: "text", text: factsText }];
    if (attempt > 1) prompt.push({ type: "text", text: retryText(lastProblems) });
    let answer: SubagentResult;
    try {
      const activation = await starter.startActivation({
        provider: "spawn",
        label: attemptLabel(facts, attempt),
        request: {
          agentPreset: STAGE_OFFICER_PRESET,
          prompt,
          parent: agent,
          outputSchema: STAGE_OFFICER_OUTPUT_SCHEMA,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(STAGE_OFFICER_TIMEOUT_MS)]),
        delivery: "caller",
      });
      answer = await activation.result;
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`阶段官没有回答:${describeError(error)}`, { cause: error });
    }
    if (answer.stopReason !== "completed") {
      signal.throwIfAborted();
      throw new Error(
        `阶段官没有完成（${answer.stopReason}）` +
          (answer.diagnostic === undefined ? "" : `：${answer.diagnostic}`),
      );
    }
    let plan: StagePlan;
    try {
      plan = readStagePlan(answer.structured);
    } catch (error) {
      const message = `阶段官交回的结果不能当计划用:${describeError(error)}`;
      lastPlan = null;
      lastProblems = [message];
      if (attempt === STAGE_OFFICER_MAX_ATTEMPTS) throw new Error(message, { cause: error });
      continue;
    }
    const problems = checkStagePlan(plan, facts);
    lastPlan = plan;
    lastProblems = problems;
    if (problems.length === 0) {
      return { plan, problems: [], text: describeStagePlan(plan, facts.target.label) };
    }
  }
  if (lastPlan === null) throw new Error("阶段官没有交出可用的计划");
  return {
    plan: lastPlan,
    problems: lastProblems,
    text: describeStagePlan(lastPlan, facts.target.label, lastProblems),
  };
}

export { describeStagePlan };

function registerStageOfficerAgent(agent: Agent): () => Promise<void> {
  return agent.ctx.effect(() => {
    const owned: (() => void)[] = [];
    owned.push(agent.ctx.tools.restrict({ allow: [] }));
    owned.push(
      agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
        text: STAGE_OFFICER_PROMPT,
        complete: true,
      }),
    );
    owned.push(agent.ctx.systemPrompt.suppressRuntimeContext());
    return () => {
      for (const dispose of owned.reverse()) dispose();
    };
  });
}

function stageOfficerDefinition(): PresetDefinition {
  return {
    id: STAGE_OFFICER_PRESET,
    name: "FF5 阶段官",
    description: "一段路出发前备齐清单、路线和回头条件",
    // The officer only reads the fact sheet. Tools and persona are mounted on agent/created
    // below, so the preset itself needs no child plugin rows.
    plugins: [],
  };
}

/**
 * Register `ffpr-stage-officer` once and mount the persona on its agents. The root panel entry
 * owns this because it is loaded once for all six games; every player preset would register a
 * duplicate. A duplicate registration (for example after a web restart before unload) only
 * warns: the existing preset can still receive the persona from this listener.
 */
export async function installStageOfficer(ctx: Context, config: Config, log: Log): Promise<void> {
  if (config.role !== "panel" || config.game !== "ff5") return;
  const presets: Pick<AgentPresetRegistry, "register" | "composedPreset"> | undefined =
    typeof ctx.get === "function" ? ctx.get("agentPresets") : ctx.agentPresets;
  if (presets === undefined) {
    log.warn("拿不到 agentPresets 服务，阶段官预设没有安装");
    return;
  }

  let disposePreset: (() => Promise<void>) | undefined;
  try {
    disposePreset = await presets.register(stageOfficerDefinition());
  } catch (error) {
    const message = describeError(error);
    if (!message.includes("Duplicate agent preset")) {
      log.warn(`安装阶段官预设失败:${message}`);
      return;
    }
    log.warn("阶段官预设已经登记过，沿用现有的定义");
  }
  ctx.effect(() => async () => {
    if (disposePreset !== undefined) await disposePreset();
  });

  const disposers = new Map<string, () => Promise<void>>();
  ctx.on("agent/created", ({ agent }) => {
    let preset: string | undefined;
    try {
      preset = presets.composedPreset(agent.ctx);
    } catch {
      preset = undefined;
    }
    if (preset !== STAGE_OFFICER_PRESET) return;
    try {
      disposers.set(agent.id, registerStageOfficerAgent(agent));
    } catch (error) {
      log.warn(`给阶段官会话 ${agent.id} 挂人设失败:${describeError(error)}`);
    }
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

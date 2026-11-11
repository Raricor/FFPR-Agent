/**
 * The two segment-plan tool shapes and their handlers (task 137, 11-11). Task 139 registers
 * them; this module deliberately does not touch dsh. `plan_facts` gives the model the fact
 * sheet plus the conservative draft; `submit_plan` validates a full `SegmentPlan`, rejects it
 * with Chinese problems, or stores it and tells the model to call `execute_plan`.
 *
 * The schemas use only the JSON Schema subset dsh accepts (`assertSupportedJsonSchema` in
 * `test/plan-tools.test.ts`), and the handlers take ports instead of Game so they can be tested
 * without a bridge.
 */

import { describeError } from "../errors.ts";
import { isRecord, text } from "../values.ts";
import type { SegmentFactsData, SegmentFactsResult } from "./facts.ts";
import type { SegmentPlan } from "./types.ts";
import { validatePlan, type PlanRevision } from "./validate.ts";

export interface PlanToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface PlanFactsRequest {
  /** The route-book section; omitted means the section the party is in. */
  readonly section?: string;
}

export interface PlanToolPorts {
  /** Build the fact sheet for one section, or for the current one when `section` is omitted. */
  facts(section?: string): Promise<SegmentFactsResult>;
  /** Persist an accepted plan (current plus history). */
  savePlan(plan: SegmentPlan): Promise<void>;
  /**
   * Task 146: the last saved plan and the report that ended it. Null when either is missing;
   * a read failure is treated as null so a revision check never blocks a plan.
   */
  previousRun(): Promise<PlanRevision | null>;
}

export interface PlanToolResult {
  readonly text: string;
  /** Set by `submit_plan`: true when the plan passed and was saved. */
  readonly accepted?: boolean;
  readonly facts?: SegmentFactsData;
  readonly draftPlan?: SegmentPlan;
  readonly problems?: readonly string[];
}

const NUMBER_OR_STRING = {
  oneOf: [{ type: "number" }, { type: "string" }],
} as const;

const UNTIL_SCHEMA = {
  type: "object",
  description: "do: grind 时刷到什么为止;至少写一项,满足一项就停",
  properties: {
    bestiary: {
      type: "array",
      description: "要登记进本档图鉴的怪名或图鉴号",
      items: { oneOf: [{ type: "string" }, { type: "integer" }] },
    },
    blueMagic: {
      type: "array",
      description: "要学会的青魔法名",
      items: { type: "string" },
    },
    battles: { type: "integer", description: "刷满多少场就停" },
    minutes: { type: "number", description: "最多刷多少分钟" },
  },
  additionalProperties: false,
} as const;

const BOOK_SCHEMA = {
  type: "object",
  description: "这一站来自路线书的哪一节、第几站",
  properties: {
    section: { type: "string", description: "路线书小节名" },
    index: { type: "integer", description: "小节里的站点序号,从 0 开始" },
  },
  required: ["section", "index"],
  additionalProperties: false,
} as const;

const STATION_SCHEMA = {
  type: "object",
  properties: {
    to: {
      type: "string",
      description: "地图号或「地图号:x,y」,与路线工具的写法一致",
    },
    do: {
      type: "string",
      enum: ["move", "open", "save", "heal", "talk", "switch", "story", "choose", "grind", "boss"],
      description: "这一站要做什么",
    },
    why: { type: "string", description: "为什么有这一站,一句中文" },
    choose: {
      ...NUMBER_OR_STRING,
      description: "do: choose 时的选项序号(0 开始)或选项文字",
    },
    until: UNTIL_SCHEMA,
    optional: { type: "boolean", description: "走不到时可以跳过(回复/存档默认可选)" },
    book: BOOK_SCHEMA,
  },
  required: ["to", "do"],
  additionalProperties: false,
} as const;

const PREP_SCHEMA = {
  type: "object",
  description: "出发前按顺序做的准备,每一项都可以是空数组",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          member: { type: "string", description: "队伍里的成员名" },
          job: { type: "string", description: "目标职业" },
          abilities: {
            type: "array",
            description: "要带的能力(可选)",
            items: { type: "string" },
          },
        },
        required: ["member", "job"],
        additionalProperties: false,
      },
    },
    equip: {
      type: "string",
      enum: ["optimize", "keep"],
      description: "optimize:代码给每个人挑最强装备;keep:不动",
    },
    buy: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string", description: "道具名" },
          count: { type: "integer", description: "买几个" },
        },
        required: ["item", "count"],
        additionalProperties: false,
      },
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          member: { type: "string", description: "队伍里的成员名" },
          row: { type: "string", enum: ["front", "back"], description: "前排或后排" },
        },
        required: ["member", "row"],
        additionalProperties: false,
      },
    },
  },
  required: ["jobs", "equip", "buy", "rows"],
  additionalProperties: false,
} as const;

const BATTLE_SCHEMA = {
  type: "array",
  description: "普通战斗的规则表;maps 为空表示这一节所有地图",
  items: {
    type: "object",
    properties: {
      maps: {
        type: "array",
        description: "这些规则表适用的地图号;空数组表示全部",
        items: { type: "integer" },
      },
      tables: {
        type: "array",
        description: "1–3 套规则表,打得不好时依次换下一套",
        items: {},
      },
    },
    required: ["maps", "tables"],
    additionalProperties: false,
  },
} as const;

const BOSS_SCHEMA = {
  type: "array",
  description: "首领战;每个首领一张或几张规则表",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "首领名" },
      map: {
        oneOf: [{ type: "integer" }, { type: "null" }],
        description: "首领所在地图号;不知道就写 null",
      },
      healFirst: { type: "boolean", description: "打之前先补满" },
      saveFirst: { type: "boolean", description: "打之前先存档" },
      tables: {
        type: "array",
        description: "首领战的规则表,按顺序尝试",
        items: {},
      },
      notes: { type: "string", description: "代码执行时要知道的中文说明" },
    },
    required: ["name", "map", "healFirst", "saveFirst", "tables"],
    additionalProperties: false,
  },
} as const;

const TURN_BACK_SCHEMA = {
  type: "array",
  description: "走到一半必须回头的条件,语法见 plan_facts 文本",
  items: {
    type: "object",
    properties: {
      when: {
        type: "string",
        description:
          "party.lowest_hp_pct < 30、party.dead >= 1、item.不死鸟之尾 < 2、party.mp_pct < 20",
      },
      then: {
        type: "string",
        enum: ["heal-and-continue", "replan"],
        description: "先补满继续,或停下来让模型改计划",
      },
    },
    required: ["when", "then"],
    additionalProperties: false,
  },
} as const;

const DROPPED_SCHEMA = {
  type: "array",
  description: "上一份计划还没做、这次决定不做的站;每一站都要写清楚原因",
  items: {
    type: "object",
    properties: {
      to: { type: "string", description: "地图号或「地图号:x,y」,和站点写法一样" },
      do: {
        type: "string",
        enum: [
          "move",
          "open",
          "save",
          "heal",
          "talk",
          "switch",
          "story",
          "choose",
          "grind",
          "boss",
        ],
        description: "原来那一站要做什么",
      },
      why: { type: "string", description: "为什么不做这一站,一句中文" },
    },
    required: ["to", "do", "why"],
    additionalProperties: false,
  },
} as const;

/** The parameters of `submit_plan`: one complete `SegmentPlan`, without a wrapper. */
export const SEGMENT_PLAN_PARAMETERS: Record<string, unknown> = {
  type: "object",
  description: "一份完整的段计划;直接在 plan_facts 返回的草稿上修改",
  properties: {
    version: { type: "integer", const: 1, description: "固定写 1" },
    section: { type: "string", description: "路线书小节名,如 Wind Shrine" },
    goal: { type: "string", description: "一句中文:走完这一段算什么" },
    prep: PREP_SCHEMA,
    stations: {
      type: "array",
      description: "按顺序执行的站点",
      items: STATION_SCHEMA,
    },
    battle: BATTLE_SCHEMA,
    bosses: BOSS_SCHEMA,
    turnBack: TURN_BACK_SCHEMA,
    dropped: DROPPED_SCHEMA,
    notes: { type: "string", description: "给代码看的中文补充" },
  },
  required: ["version", "section", "goal", "prep", "stations", "battle", "bosses", "turnBack"],
  additionalProperties: false,
};

export const PLAN_FACTS_TOOL: PlanToolDefinition = {
  name: "plan_facts",
  description:
    "取一段路线书的事实与保守草稿:地图连通、未开宝箱、怪物弱点/青魔法、首领、商店、队伍、" +
    "本档图鉴与青魔法缺口。改好草稿后用 submit_plan 交回。参数 section 可省略:当前图属于一个" +
    "未完成的节就取它,否则取路线书顺序里下一个未完成的节。",
  parameters: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description: "路线书小节名,如 Wind Shrine;省略就按当前图取未完成的节",
      },
    },
    additionalProperties: false,
  },
};

export const SUBMIT_PLAN_TOOL: PlanToolDefinition = {
  name: "submit_plan",
  description:
    "交一份完整的 SegmentPlan。代码检查站点、刷怪、准备、战斗/首领表和回头条件;不通过会返回" +
    "问题清单,通过后存盘,接下来可以 execute_plan。",
  parameters: SEGMENT_PLAN_PARAMETERS,
};

export const PLAN_TOOL_DEFINITIONS: readonly PlanToolDefinition[] = [
  PLAN_FACTS_TOOL,
  SUBMIT_PLAN_TOOL,
];

function errorText(error: unknown): string {
  return error instanceof Error ? describeError(error) : String(error);
}

/** `plan_facts`: return the Chinese fact sheet plus the draft plan as JSON the model edits. */
export async function handlePlanFacts(
  ports: PlanToolPorts,
  args: unknown,
): Promise<PlanToolResult> {
  let section: string | undefined;
  if (args !== undefined && args !== null) {
    if (!isRecord(args)) return { text: "plan_facts 的参数要是对象" };
    const raw = args.section;
    if (raw !== undefined) {
      if (typeof raw !== "string" || raw.trim() === "") {
        return { text: "section 要是小节名,或者省略" };
      }
      section = raw.trim();
    }
  }
  let facts: SegmentFactsResult;
  try {
    facts = await ports.facts(section);
  } catch (error) {
    return { text: `整理段计划事实失败:${errorText(error)}` };
  }
  const draft = JSON.stringify(facts.draftPlan, null, 2);
  return {
    text:
      `${facts.text}\n\n` +
      "### 草稿计划(JSON)\n" +
      "在下面这份草稿上补战斗表、首领表和准备,再用 submit_plan 交回。\n" +
      "```json\n" +
      draft +
      "\n```",
    facts: facts.data,
    draftPlan: facts.draftPlan,
  };
}

function planFromArgs(args: unknown): unknown {
  if (isRecord(args) && isRecord(args.plan)) return args.plan;
  return args;
}

/** `submit_plan`: validate, return the Chinese problem list, or save and accept. */
export async function handleSubmitPlan(
  ports: PlanToolPorts,
  args: unknown,
): Promise<PlanToolResult> {
  const candidate = planFromArgs(args);
  if (!isRecord(candidate)) return { text: "submit_plan 的参数要是完整的 SegmentPlan 对象" };
  const section = text(candidate.section)?.trim() || undefined;
  let facts: SegmentFactsResult;
  try {
    facts = await ports.facts(section);
  } catch (error) {
    return { text: `取段计划事实失败,没法检查:${errorText(error)}` };
  }
  let previous: PlanRevision | undefined;
  try {
    previous = (await ports.previousRun()) ?? undefined;
  } catch {
    // Task 146: reading the previous run only enables a stricter revision check; a broken
    // report file must not stop the model from submitting a plan.
    previous = undefined;
  }
  const validation = validatePlan(candidate, facts.data, previous);
  if (!validation.ok) {
    return {
      text:
        "计划没有通过检查,请改好再交:\n" +
        validation.problems.map((problem) => `- ${problem}`).join("\n"),
      accepted: false,
      problems: validation.problems,
    };
  }
  const plan = validation.fixed ?? (candidate as unknown as SegmentPlan);
  try {
    await ports.savePlan(plan);
  } catch (error) {
    return {
      text: `计划通过检查,但存盘失败:${errorText(error)}`,
      accepted: false,
      problems: [errorText(error)],
    };
  }
  const fixedNote = validation.fixed === undefined ? "" : "(自动补上了回复/存档站的 optional)";
  return {
    text: `计划已收下${fixedNote},可以 execute_plan`,
    accepted: true,
    ...(validation.fixed === undefined ? {} : { draftPlan: validation.fixed }),
  };
}

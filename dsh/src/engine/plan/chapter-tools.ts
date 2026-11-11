/**
 * The six chapter-plan tools and their handlers (task 151, 11-11). Task 153 registers them;
 * this module only defines the shapes and handles calls through ports, so it can be tested
 * without dsh or a bridge.
 *
 * The model reads the chapter facts and one guide section at a time, writes each `SegmentPlan`
 * into the draft (checked on the spot), writes the chapter meta, then submits the whole file.
 * A failed submission lists every Chinese problem; `skipped` is how the model says a target is
 * deliberately not taken.
 */

import { describeError } from "../errors.ts";
import { isRecord, text } from "../values.ts";
import type {
  ChapterFallback,
  ChapterFactsData,
  ChapterGrowthTarget,
  ChapterPlan,
  ChapterSkipped,
} from "./chapter-types.ts";
import { validateChapterPlan, validateChapterSegment } from "./chapter-validate.ts";
import type { DryRunResult } from "./dry-run.ts";
import type { ChapterDraft, ChapterDraftMeta, ChapterDraftStore } from "./chapter-store.ts";
import type { PlanToolDefinition } from "./tools.ts";
import { SEGMENT_PLAN_PARAMETERS } from "./tools.ts";
import type { SegmentPlan } from "./types.ts";

export type ChapterToolDefinition = PlanToolDefinition;

/**
 * Task 160: who owns the current chapter right now. `running` means the executor is in the
 * background; `blocked` means it stopped and waits for an operator to repair and resume. In
 * both states the model must not submit a new rule file.
 */
export interface ChapterOwner {
  readonly chapter: number;
  readonly status: "running" | "blocked";
}

/** The one Chinese answer for a model tool call while the executor owns the chapter. */
export function chapterBusyText(owner: ChapterOwner): string {
  const state =
    owner.status === "running"
      ? `第 ${owner.chapter} 章正由执行器在后台跑`
      : `第 ${owner.chapter} 章正在等待开发修复`;
  return `${state}，这一轮到此结束，不要再调用工具；整章跑完会再叫你`;
}

export interface ChapterFactsResult {
  readonly data: ChapterFactsData;
  readonly text: string;
}

export interface ChapterToolPorts {
  /** The chapter facts; omitted means the chapter the party is in. */
  facts(chapter?: number): Promise<ChapterFactsResult>;
  /** The walkthrough text of one section, by its guide title or guide index. */
  guide(section: string | number): Promise<string>;
  /** Load the draft file (missing file = an empty draft). */
  draft(): Promise<ChapterDraftStore>;
  /** Save an accepted plan as the current chapter plan (plus history). */
  savePlan(plan: ChapterPlan): Promise<void>;
  /** The current accepted plan, for `chapter_status`. */
  currentPlan(): Promise<ChapterPlan | null>;
  /** Task 160: set while the executor runs or waits for repair; a submit is then refused. */
  owner?(): ChapterOwner | null;
  /** Task 154: offline walk of the whole chapter before it is accepted. */
  dryRun?(plan: ChapterPlan): Promise<DryRunResult>;
}

export interface ChapterToolResult {
  readonly text: string;
  /** Set by `submit_chapter_plan`: true when the chapter passed and was saved. */
  readonly accepted?: boolean;
  readonly facts?: ChapterFactsData;
  readonly plan?: ChapterPlan;
  readonly draft?: ChapterDraft;
  readonly problems?: readonly string[];
  readonly warnings?: readonly string[];
}

const BUY_ITEMS_SCHEMA = {
  type: "array",
  description: "do: buy 时买什么、按顺序买几个",
  items: {
    type: "object",
    properties: {
      item: { type: "string", description: "道具名,三语名或编号都可以" },
      count: { type: "integer", description: "买几个" },
    },
    required: ["item", "count"],
    additionalProperties: false,
  },
} as const;

/**
 * Reuse `submit_plan`'s schema and add the new `buy` station fields. Keeping one station shape
 * means a segment accepted by `chapter_draft_segment` is the same object `submit_plan` takes.
 */
function addBuyChoice(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.enum)) return;
  const choices: unknown[] = value.enum as unknown[];
  if (!choices.includes("buy")) value.enum = [...choices, "buy"];
}

function withBuyStations(parameters: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = structuredClone(parameters);
  const properties = copy.properties;
  if (!isRecord(properties)) return copy;
  const stations = properties.stations;
  if (!isRecord(stations) || !isRecord(stations.items)) return copy;
  const stationProperties = stations.items.properties;
  if (!isRecord(stationProperties)) return copy;
  addBuyChoice(stationProperties.do);
  stationProperties.items = BUY_ITEMS_SCHEMA;
  const dropped = properties.dropped;
  if (isRecord(dropped) && isRecord(dropped.items) && isRecord(dropped.items.properties)) {
    addBuyChoice(dropped.items.properties.do);
  }
  return copy;
}

/** A complete `SegmentPlan` for the draft tool, including `buy` and `items`. */
export const CHAPTER_SEGMENT_PARAMETERS: Record<string, unknown> =
  withBuyStations(SEGMENT_PLAN_PARAMETERS);

const GROWTH_SCHEMA = {
  type: "array",
  description: "整章的长线成长:在第 before 段之前刷到 level / gil 目标",
  items: {
    type: "object",
    properties: {
      before: { type: "integer", description: "在第几段之前刷,从 0 开始" },
      level: { type: "integer", description: "队伍最低等级到这个数" },
      gil: { type: "integer", description: "身上的钱到这个数" },
      where: { type: "string", description: "「地图号:x,y」或「地图号」" },
      why: { type: "string", description: "为什么刷,一句中文" },
      maxMinutes: { type: "number", description: "最多刷多少分钟" },
    },
    required: ["before", "where", "why", "maxMinutes"],
    additionalProperties: false,
  },
} as const;

const FALLBACK_SCHEMA = {
  type: "object",
  description: "代码自己兜底的做法:重试、首领重打、跳过可选站、低血量回复",
  properties: {
    retries: { type: "integer", description: "一站失败后换路线重试几次,0–3" },
    bossLost: {
      type: "object",
      description: "首领打输后的做法",
      properties: {
        levels: { type: "integer", description: "再练几级" },
        where: {
          oneOf: [{ type: "string" }, { type: "null" }],
          description: "「地图号:x,y」、「地图号」或 null(原地) ",
        },
        tries: { type: "integer", description: "重打几次,0–3" },
      },
      required: ["levels", "where", "tries"],
      additionalProperties: false,
    },
    skipOptional: { type: "boolean", description: "可选站到不了就跳过并记录" },
    healBelowPct: {
      type: "number",
      description: "最低 HP% 低于这个数就回头补血,10–60",
    },
  },
  required: ["retries", "bossLost", "skipOptional", "healBelowPct"],
  additionalProperties: false,
} as const;

const SKIPPED_SCHEMA = {
  type: "array",
  description: "本章故意不拿的收集目标;每一项都要写原因",
  items: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["bestiary", "blueMagic", "hidden", "chest", "shop", "boss"],
        description: "哪一类目标",
      },
      name: { type: "string", description: "事实单里的名字" },
      where: {
        type: "string",
        description: "「地图号:x,y」或「地图号」,没有地点可省略",
      },
      why: { type: "string", description: "为什么不拿,一句中文" },
    },
    required: ["kind", "name", "why"],
    additionalProperties: false,
  },
} as const;

const CHAPTER_DRAFT_META_PARAMETERS: Record<string, unknown> = {
  type: "object",
  description: "写一章草稿的章号、目标、长线成长、兜底和 skipped",
  properties: {
    chapter: { type: "integer", description: "第几章,从 1 开始" },
    goal: { type: "string", description: "一句中文:走完这一章算什么" },
    growth: GROWTH_SCHEMA,
    fallback: FALLBACK_SCHEMA,
    skipped: SKIPPED_SCHEMA,
    notes: { type: "string", description: "给代码看的中文补充" },
  },
  required: ["chapter", "goal", "growth", "fallback"],
  additionalProperties: false,
};

export const CHAPTER_FACTS_TOOL: ChapterToolDefinition = {
  name: "chapter_facts",
  description:
    "取一章的事实:每节的段事实、本章未开的宝箱和隐藏道具、商店、每张图的怪物与图鉴缺口、" +
    "青魔法、队伍和金钱。先在事实里核对要拿什么,再分段写 chapter_draft_segment。",
  parameters: {
    type: "object",
    properties: {
      chapter: {
        type: "integer",
        description: "第几章;省略就取当前这一章",
      },
    },
    additionalProperties: false,
  },
};

export const READ_GUIDE_TOOL: ChapterToolDefinition = {
  name: "read_guide",
  description: "取路线书某一节的原文。写这一章的段计划前先读对应攻略。",
  parameters: {
    type: "object",
    properties: {
      section: {
        oneOf: [{ type: "string" }, { type: "integer" }],
        description: "路线书小节名,如 Wind Shrine;也可以写它在攻略里的序号",
      },
    },
    required: ["section"],
    additionalProperties: false,
  },
};

export const CHAPTER_DRAFT_SEGMENT_TOOL: ChapterToolDefinition = {
  name: "chapter_draft_segment",
  description:
    "把一段 SegmentPlan 放进章草稿(同一下标覆盖旧的),并当场用这一节的事实检查这一段;" +
    "问题会列出来,但草稿会保留,改好后可以重交同一段。",
  parameters: {
    type: "object",
    properties: {
      index: {
        type: "integer",
        description: "段下标,从 0 开始,和章内节的顺序一致",
      },
      plan: CHAPTER_SEGMENT_PARAMETERS,
    },
    required: ["index", "plan"],
    additionalProperties: false,
  },
};

export const CHAPTER_DRAFT_META_TOOL: ChapterToolDefinition = {
  name: "chapter_draft_meta",
  description:
    "写章草稿的元信息:章号、目标、整章 growth、fallback、skipped 和 notes。" +
    "可以随时覆盖;提交时才会整章检查。",
  parameters: CHAPTER_DRAFT_META_PARAMETERS,
};

export const SUBMIT_CHAPTER_PLAN_TOOL: ChapterToolDefinition = {
  name: "submit_chapter_plan",
  description:
    "把章草稿拼成一份 ChapterPlan 做整章检查:每段先用 validatePlan,再查宝箱/隐藏道具/首领/" +
    "图鉴/青魔法覆盖、buy 店与总价、growth、fallback、段的顺序;然后用地图记录和碰撞缓存" +
    "离线试走一遍,走不到的站会退回。通过就存成当前计划并清草稿;不通过就逐条列出问题。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const CHAPTER_STATUS_TOOL: ChapterToolDefinition = {
  name: "chapter_status",
  description: "看章草稿和当前章计划的摘要,不写盘。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const CHAPTER_TOOL_DEFINITIONS: readonly ChapterToolDefinition[] = [
  CHAPTER_FACTS_TOOL,
  READ_GUIDE_TOOL,
  CHAPTER_DRAFT_SEGMENT_TOOL,
  CHAPTER_DRAFT_META_TOOL,
  SUBMIT_CHAPTER_PLAN_TOOL,
  CHAPTER_STATUS_TOOL,
];

function errorText(error: unknown): string {
  return error instanceof Error ? describeError(error) : String(error);
}

function chapterNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function listProblems(problems: readonly string[]): string {
  return problems.map((problem) => `- ${problem}`).join("\n");
}

function draftSummary(draft: ChapterDraftStore): string {
  const parts: string[] = [];
  parts.push(
    draft.chapter === null
      ? "还没写章号"
      : `第 ${draft.chapter} 章${draft.goal === null ? "" : `:${draft.goal}`}`,
  );
  const entries = draft.segmentEntries();
  parts.push(
    entries.length === 0
      ? "还没有段"
      : `${entries.length} 段(下标 ${entries.map((entry) => entry.index).join("、")};` +
          `小节 ${entries.map((entry) => entry.plan.section).join("、")})`,
  );
  parts.push(`growth ${draft.growth.length} 条`);
  parts.push(draft.fallback === null ? "fallback 还没写" : "fallback 已写");
  parts.push(`skipped ${draft.skipped.length} 条`);
  return parts.join(";");
}

/** `chapter_facts`: return the chapter fact text for the model. */
export async function handleChapterFacts(
  ports: ChapterToolPorts,
  args: unknown,
): Promise<ChapterToolResult> {
  let chapter: number | undefined;
  if (args !== undefined && args !== null) {
    if (!isRecord(args)) return { text: "chapter_facts 的参数要是对象" };
    if (args.chapter !== undefined) {
      chapter = chapterNumber(args.chapter);
      if (chapter === undefined) return { text: "chapter 要是正整数,或者省略" };
    }
  }
  try {
    const facts = await ports.facts(chapter);
    return { text: facts.text, facts: facts.data };
  } catch (error) {
    return { text: `取章事实失败:${errorText(error)}` };
  }
}

/** `read_guide`: return one guide section's original text. */
export async function handleReadGuide(
  ports: ChapterToolPorts,
  args: unknown,
): Promise<ChapterToolResult> {
  if (!isRecord(args)) return { text: "read_guide 的参数要是对象" };
  const raw = args.section;
  const section =
    typeof raw === "number"
      ? Number.isInteger(raw) && raw >= 0
        ? raw
        : undefined
      : text(raw)?.trim() || undefined;
  if (section === undefined) {
    return { text: "read_guide 要写 section(路线书小节名或它在攻略里的序号)" };
  }
  try {
    const guide = await ports.guide(section);
    return {
      text: guide.trim() === "" ? `路线书里「${String(section)}」没有原文` : guide,
    };
  } catch (error) {
    return { text: `读「${String(section)}」的攻略失败:${errorText(error)}` };
  }
}

/** `chapter_draft_segment`: save one segment, then validate it against that section's facts. */
export async function handleChapterDraftSegment(
  ports: ChapterToolPorts,
  args: unknown,
): Promise<ChapterToolResult> {
  if (!isRecord(args)) return { text: "chapter_draft_segment 的参数要是对象" };
  const index = args.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return { text: "index 要是 0 以上的整数" };
  }
  if (!isRecord(args.plan)) return { text: "plan 要是完整的 SegmentPlan 对象" };
  const candidate = args.plan;
  let draft: ChapterDraftStore;
  try {
    draft = await ports.draft();
  } catch (error) {
    return { text: `读章草稿失败:${errorText(error)}` };
  }
  try {
    await draft.setSegment(index, candidate as unknown as SegmentPlan);
  } catch (error) {
    return { text: `第 ${index + 1} 段存进草稿失败:${errorText(error)}` };
  }
  const prefix = `第 ${index + 1} 段已放进草稿。`;
  // 11-11 (new game, opening cutscene): without a chapter in the draft the "current chapter"
  // was guessed from a cutscene map and every section looked missing; ask for the number instead.
  if (draft.chapter === null) {
    return {
      text: `${prefix}但草稿还没有章号,检查不了:先用 chapter_draft_meta 写上 chapter,再重交这一段`,
      problems: ["草稿还没有章号"],
    };
  }
  let facts: ChapterFactsResult;
  try {
    facts = await ports.facts(draft.chapter);
  } catch (error) {
    return {
      text: `${prefix}但取章事实失败,这一段还没检查:${errorText(error)}`,
    };
  }
  const sectionTitle = text(candidate.section)?.trim() ?? "";
  const section = facts.data.sections.find((entry) => entry.title === sectionTitle);
  if (section === undefined) {
    return {
      text: `${prefix}但本章没有「${sectionTitle === "" ? "没写 section" : sectionTitle}」这一节,这一段还没检查`,
      problems: [`本章没有「${sectionTitle}」这一节`],
    };
  }
  const validation = validateChapterSegment(candidate, section.facts, draft.skipped);
  if (validation.problems.length === 0) {
    return {
      text: `${prefix}这一段通过了事实检查;接着写下一段,最后 submit_chapter_plan。`,
    };
  }
  return {
    text: `${prefix}这一段还有问题,可以改好后重交同一段:\n${listProblems(validation.problems)}`,
    problems: validation.problems,
  };
}

/** `chapter_draft_meta`: save chapter/goal/growth/fallback/skipped/notes. */
export async function handleChapterDraftMeta(
  ports: ChapterToolPorts,
  args: unknown,
): Promise<ChapterToolResult> {
  if (!isRecord(args)) return { text: "chapter_draft_meta 的参数要是对象" };
  const chapter = chapterNumber(args.chapter);
  if (chapter === undefined) return { text: "chapter 要是正整数" };
  const goal = text(args.goal)?.trim() ?? "";
  if (goal === "") return { text: "goal 要写一句中文:走完这一章算什么" };
  if (!Array.isArray(args.growth)) return { text: "growth 要写成数组" };
  for (const [index, raw] of args.growth.entries()) {
    if (!isRecord(raw)) return { text: `growth 第 ${index + 1} 项不是对象` };
  }
  if (!isRecord(args.fallback)) return { text: "fallback 要写成对象" };
  if (args.skipped !== undefined && !Array.isArray(args.skipped)) {
    return { text: "skipped 要写成数组" };
  }
  const notes = args.notes;
  if (notes !== undefined && typeof notes !== "string") {
    return { text: "notes 要是字符串" };
  }
  const meta: ChapterDraftMeta = {
    chapter,
    goal,
    growth: args.growth as readonly ChapterGrowthTarget[],
    fallback: args.fallback as unknown as ChapterFallback,
    ...(args.skipped === undefined ? {} : { skipped: args.skipped as readonly ChapterSkipped[] }),
    ...(typeof notes === "string" ? { notes } : {}),
  };
  let draft: ChapterDraftStore;
  try {
    draft = await ports.draft();
    await draft.setMeta(meta);
  } catch (error) {
    return { text: `章元信息存进草稿失败:${errorText(error)}` };
  }
  return {
    text:
      `第 ${chapter} 章的元信息已写进草稿:growth ${meta.growth.length} 条,` +
      `skipped ${meta.skipped?.length ?? 0} 条。继续写段,最后 submit_chapter_plan。`,
    draft: {
      version: 1,
      game: draft.game,
      chapter: draft.chapter,
      goal: draft.goal,
      growth: draft.growth,
      fallback: draft.fallback,
      skipped: draft.skipped,
      ...(draft.notes === undefined ? {} : { notes: draft.notes }),
      segments: Object.fromEntries(
        draft.segmentEntries().map((entry) => [String(entry.index), entry.plan]),
      ),
    },
  };
}

/** `submit_chapter_plan`: assemble, validate the whole chapter, save or list problems. */
export async function handleSubmitChapterPlan(
  ports: ChapterToolPorts,
  args: unknown,
): Promise<ChapterToolResult> {
  if (args !== undefined && args !== null && !isRecord(args)) {
    return { text: "submit_chapter_plan 不需要参数" };
  }
  // Task 160: the rule file belongs to the executor while a chapter is running or blocked.
  // Check before reading the draft so a stale model turn cannot touch the files at all.
  const owner = ports.owner?.() ?? null;
  if (owner !== null) {
    return { text: chapterBusyText(owner), accepted: false };
  }
  let draft: ChapterDraftStore;
  try {
    draft = await ports.draft();
  } catch (error) {
    return { text: `读章草稿失败:${errorText(error)}` };
  }
  const assembly = draft.toPlan();
  if (assembly.plan === null) {
    return {
      text: `章草稿还不完整,先补齐再交:\n${listProblems(assembly.problems)}`,
      accepted: false,
      problems: assembly.problems,
    };
  }
  let facts: ChapterFactsResult;
  try {
    facts = await ports.facts(assembly.plan.chapter);
  } catch (error) {
    return {
      text: `取章事实失败,没法检查:${errorText(error)}`,
      accepted: false,
    };
  }
  const validation = validateChapterPlan(assembly.plan, facts.data);
  const plan = validation.fixed ?? assembly.plan;
  // Task 154: check the route offline after the chapter checks, before anything is saved. A
  // throw here (bridge/atlas trouble) is only a warning; it must not reject an otherwise good
  // plan, and a timeout reports the unfinished walk instead of a false problem.
  let dryRun: DryRunResult | null = null;
  if (ports.dryRun !== undefined) {
    try {
      dryRun = await ports.dryRun(plan);
    } catch (error) {
      dryRun = {
        problems: [],
        warnings: [`试走失败:${errorText(error)}`],
        timedOut: false,
      };
    }
  }
  const problems = [...validation.problems, ...(dryRun?.problems ?? [])];
  const warnings = [...validation.warnings, ...(dryRun?.warnings ?? [])];
  const warningText = warnings.length === 0 ? "" : `\n提醒(不影响接受):\n${listProblems(warnings)}`;
  if (problems.length > 0) {
    return {
      text: `章计划没有通过检查,请改好再交:\n${listProblems(problems)}${warningText}`,
      accepted: false,
      problems,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }
  try {
    await ports.savePlan(plan);
  } catch (error) {
    return {
      text: `章计划通过检查,但存盘失败:${errorText(error)}`,
      accepted: false,
      problems: [errorText(error)],
    };
  }
  let clearNote = "";
  try {
    await draft.clear();
  } catch (error) {
    clearNote = `\n计划已经存下,但清草稿失败:${errorText(error)}`;
  }
  return {
    text: `章计划已通过检查并存成当前计划,草稿已清空。${clearNote}${warningText}`,
    accepted: true,
    plan,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/** `chapter_status`: summarize the draft and the current plan without writing. */
export async function handleChapterStatus(
  ports: ChapterToolPorts,
  args: unknown,
): Promise<ChapterToolResult> {
  if (args !== undefined && args !== null && !isRecord(args)) {
    return { text: "chapter_status 不需要参数" };
  }
  let draft: ChapterDraftStore;
  let current: ChapterPlan | null;
  try {
    [draft, current] = await Promise.all([ports.draft(), ports.currentPlan()]);
  } catch (error) {
    return { text: `读章状态失败:${errorText(error)}` };
  }
  const draftText =
    draft.chapter === null && draft.segmentEntries().length === 0 && draft.fallback === null
      ? "章草稿:空"
      : `章草稿:${draftSummary(draft)}`;
  const draftProblems =
    draft.problems.length === 0 ? "" : `\n草稿文件里的问题:${listProblems(draft.problems)}`;
  const currentText =
    current === null
      ? "当前章计划:没有"
      : `当前章计划:第 ${current.chapter} 章 ${current.goal};${current.segments.length} 段,` +
        `growth ${current.growth.length} 条,skipped ${current.skipped?.length ?? 0} 条`;
  return {
    text: `${draftText}${draftProblems}\n${currentText}`,
    ...(current === null ? {} : { plan: current }),
  };
}

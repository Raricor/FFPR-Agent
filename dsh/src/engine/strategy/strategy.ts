/**
 * Reading and checking strategy 2.0 JSON (battle strategy plan §6). Parsing keeps the
 * expressions as text but validates every one of them, so errors carry the phase, rule and
 * character position where they were found. Static checking adds what needs a party: names,
 * role names and duplicate phase names.
 */

import { describeError } from "../errors.ts";
import { isRecord, text } from "../values.ts";
import { ExpressionError, expressionType, parseExpression } from "./expr.ts";
import type { Strategy, StrategyPhase, StrategyReaction, StrategyRule } from "./types.ts";

export interface ParsedAction {
  readonly command: string;
  readonly ability: string;
}

/**
 * Read `do`: 攻击/防御/换列, 道具:名字, or 指令:能力 (the ability may be empty). `X+` and
 * 最强 stay as written; expanding them belongs to the executor.
 */
export function parseAction(action: string): ParsedAction | null {
  const trimmed = action.trim();
  if (trimmed === "" || /[\r\n]/u.test(trimmed)) return null;
  if (trimmed === "攻击" || trimmed === "防御" || trimmed === "换列") {
    return { command: trimmed, ability: "" };
  }
  const separator = trimmed.indexOf(":");
  if (separator < 0) {
    return trimmed === "道具" ? null : { command: trimmed, ability: "" };
  }
  if (trimmed.includes(":", separator + 1)) return null;
  const command = trimmed.slice(0, separator).trim();
  const ability = trimmed.slice(separator + 1).trim();
  if (command === "") return null;
  if (command === "道具" && ability === "") return null;
  return { command, ability };
}

function readInput(json: unknown): Record<string, unknown> | string {
  if (typeof json !== "string") return isRecord(json) ? json : "策略要写成 JSON 对象";
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : "策略要写成 JSON 对象";
  } catch (error) {
    return `不是合法的 JSON:${describeError(error)}`;
  }
}

function readText(value: unknown, context: string, errors: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    errors.push(`${context}:要写成字符串`);
    return undefined;
  }
  return value;
}

function readExpression(
  value: unknown,
  context: string,
  errors: string[],
  expectsUnit = false,
): string | undefined {
  const source = readText(value, context, errors);
  if (source === undefined) return undefined;
  const trimmed = source.trim();
  if (trimmed === "") return undefined;
  let expression: ReturnType<typeof parseExpression>;
  try {
    expression = parseExpression(trimmed);
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    errors.push(`${context} 第 ${error.position} 个字:${error.message}`);
    return undefined;
  }
  if (expectsUnit) {
    const type = expressionType(expression);
    if (type !== "unit" && type !== "set" && type !== "all") {
      errors.push(`${context}:要选一个单位(比如 ally.lowest(hp_pct)),不能是${typeName(type)}`);
      return undefined;
    }
  }
  return trimmed;
}

function typeName(type: string): string {
  switch (type) {
    case "number":
      return "数字";
    case "string":
      return "文字";
    case "boolean":
      return "真假值";
    case "battle":
      return "战斗";
    default:
      return type;
  }
}

function parseRule(raw: unknown, context: string, errors: string[]): StrategyRule | null {
  if (!isRecord(raw)) {
    errors.push(`${context}:规则要写成 JSON 对象`);
    return null;
  }
  const who = readText(raw.who, `${context}的 who`, errors)?.trim();
  if (who === undefined || who === "") {
    errors.push(`${context}:缺少 who(角色名、定位名、all 或 any)`);
  }
  const doText = readText(raw.do, `${context}的 do`, errors)?.trim();
  if (doText === undefined || doText === "") {
    errors.push(`${context}:缺少 do(比如 攻击、白魔法:治疗、道具:不死鸟之尾)`);
  } else if (parseAction(doText) === null) {
    errors.push(
      `${context}的 do:「${doText}」看不懂;写成 攻击、防御、换列、道具:名字 或 指令:能力`,
    );
  }
  const condition = readExpression(raw.if, `${context}的 if`, errors);
  const target = readExpression(raw.to, `${context}的 to`, errors, true);
  let once: boolean | undefined;
  if ("once" in raw) {
    if (typeof raw.once !== "boolean") {
      errors.push(`${context}的 once:只能是 true 或 false`);
    } else {
      once = raw.once;
    }
  }
  const note = readText(raw.note, `${context}的 note`, errors);
  if (who === undefined || who === "" || doText === undefined || doText === "") return null;
  const rule: {
    who: string;
    do: string;
    if?: string;
    to?: string;
    once?: boolean;
    note?: string;
  } = { who, do: doText };
  if (condition !== undefined) rule.if = condition;
  if (target !== undefined) rule.to = target;
  if (once !== undefined) rule.once = once;
  if (note !== undefined) rule.note = note;
  return rule;
}

function parseReaction(raw: unknown, context: string, errors: string[]): StrategyReaction | null {
  if (!isRecord(raw)) {
    errors.push(`${context}:对策要写成 JSON 对象`);
    return null;
  }
  const rule = parseRule(raw, context, errors);
  const on = readExpression(raw.on, `${context}的 on`, errors);
  if (on === undefined) errors.push(`${context}:缺少 on(什么时候做,比如 ally.any(not alive))`);
  if (rule === null || on === undefined) return null;
  return { ...rule, on };
}

function parsePhase(raw: unknown, index: number, errors: string[]): StrategyPhase | null {
  if (!isRecord(raw)) {
    errors.push(`第 ${index} 个阶段:要写成 JSON 对象`);
    return null;
  }
  const name = readText(raw.name, `第 ${index} 个阶段的 name`, errors)?.trim();
  if (name === undefined || name === "") {
    errors.push(`第 ${index} 个阶段:缺少 name`);
  }
  const label = `阶段「${name ?? `第 ${index} 个`}」`;
  const when = readExpression(raw.when, `${label}的 when`, errors);
  const note = readText(raw.note, `${label}的 note`, errors);
  const rawRules = raw.rules;
  const rules: StrategyRule[] = [];
  if (!Array.isArray(rawRules)) {
    errors.push(`${label}:缺少 rules(规则列表)`);
  } else {
    for (let ruleIndex = 1; ruleIndex <= rawRules.length; ruleIndex++) {
      const rule = parseRule(rawRules[ruleIndex - 1], `${label}第 ${ruleIndex} 条规则`, errors);
      if (rule !== null) rules.push(rule);
    }
  }
  if (name === undefined || name === "") return null;
  const phase: { name: string; when?: string; note?: string; rules: StrategyRule[] } = {
    name,
    rules,
  };
  if (when !== undefined) phase.when = when;
  if (note !== undefined) phase.note = note;
  return phase;
}

/**
 * Parse strategy 2.0 JSON (an object, or a JSON string) into a typed strategy. On failure
 * returns a Chinese error list instead; every expression is reported with its rule and
 * 1-based character position, and all errors are collected rather than stopping at the first.
 */
export function parseStrategy(json: unknown): Strategy | string[] {
  const input = readInput(json);
  if (typeof input === "string") return [input];
  const errors: string[] = [];
  if (input.version !== 2) errors.push("version 要写成 2");
  const summary = readText(input.summary, "summary", errors)?.trim();
  if (summary === "") errors.push("summary 不能是空的");

  const roles: Record<string, string> = {};
  if (input.roles !== undefined) {
    if (!isRecord(input.roles)) {
      errors.push("roles 要写成 {角色名: 定位, ...}");
    } else {
      for (const [name, value] of Object.entries(input.roles)) {
        if (typeof value !== "string" || value.trim() === "") {
          errors.push(`roles 里的「${name}」要写成非空的定位文字`);
          continue;
        }
        roles[name] = value.trim();
      }
    }
  }

  const reactions: StrategyReaction[] = [];
  if (input.reactions !== undefined) {
    if (!Array.isArray(input.reactions)) {
      errors.push("reactions 要写成列表");
    } else {
      for (let index = 1; index <= input.reactions.length; index++) {
        const reaction = parseReaction(input.reactions[index - 1], `第 ${index} 条对策`, errors);
        if (reaction !== null) reactions.push(reaction);
      }
    }
  }

  const phases: StrategyPhase[] = [];
  if (input.phases !== undefined) {
    if (!Array.isArray(input.phases)) {
      errors.push("phases 要写成列表");
    } else {
      for (let index = 1; index <= input.phases.length; index++) {
        const phase = parsePhase(input.phases[index - 1], index, errors);
        if (phase !== null) phases.push(phase);
      }
    }
  }

  const rules: StrategyRule[] = [];
  if (input.rules !== undefined) {
    if (!Array.isArray(input.rules)) {
      errors.push("rules 要写成列表");
    } else {
      for (let index = 1; index <= input.rules.length; index++) {
        const rule = parseRule(input.rules[index - 1], `第 ${index} 条规则`, errors);
        if (rule !== null) rules.push(rule);
      }
    }
  }
  const hasPhases = Array.isArray(input.phases) && input.phases.length > 0;
  const hasRules = Array.isArray(input.rules) && input.rules.length > 0;
  if (hasPhases && hasRules) {
    errors.push("phases 和 rules 只能二选一:有阶段就把规则放进阶段里");
  }
  if (errors.length > 0) return errors;

  return {
    version: 2,
    ...(summary !== undefined && summary !== "" ? { summary } : {}),
    roles,
    reactions,
    phases,
    rules,
  };
}

function partyNames(party: readonly unknown[] | undefined): Set<string> | null {
  if (party === undefined) return null;
  const names = new Set<string>();
  for (const member of party) {
    if (typeof member === "string") {
      names.add(member);
      continue;
    }
    if (!isRecord(member)) continue;
    const name = text(member.name);
    if (name !== undefined && name !== "") names.add(name);
  }
  return names;
}

/**
 * Static checks beyond parsing: who names exist in the party (and in roles), phase names are
 * unique, `once` is boolean, and there is at least one rule. Coverage checks (can anyone
 * revive?) belong to a later task and are deliberately absent.
 */
export function checkStrategy(strategy: unknown, party?: readonly unknown[]): string[] {
  const parsed = parseStrategy(strategy);
  if (Array.isArray(parsed)) return parsed;
  const problems: string[] = [];
  const names = partyNames(party);
  const roles = new Set(Object.values(parsed.roles));
  const phaseNames = new Set<string>();
  for (const phase of parsed.phases) {
    if (phaseNames.has(phase.name)) {
      problems.push(`阶段名「${phase.name}」重复了`);
    }
    phaseNames.add(phase.name);
  }
  const allRules: { readonly rule: StrategyRule; readonly label: string }[] = [
    ...parsed.reactions.map((rule, index) => ({
      rule,
      label: `第 ${index + 1} 条对策`,
    })),
    ...parsed.rules.map((rule, index) => ({
      rule,
      label: `第 ${index + 1} 条规则`,
    })),
    ...parsed.phases.flatMap((phase) =>
      phase.rules.map((rule, index) => ({
        rule,
        label: `阶段「${phase.name}」第 ${index + 1} 条规则`,
      })),
    ),
  ];
  if (allRules.length === 0) problems.push("策略里没有规则");
  for (const { rule, label } of allRules) {
    if (rule.who === "all" || rule.who === "any" || roles.has(rule.who)) continue;
    if (names !== null && !names.has(rule.who)) {
      problems.push(`${label}:队伍里没有「${rule.who}」`);
    }
  }
  return problems;
}

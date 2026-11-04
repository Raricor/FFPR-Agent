/**
 * Chinese for the sidebar (battle strategy plan §6): expressions, rules, reactions and whole
 * strategies. Pure formatting; the expressions are parsed with the same parser the evaluator
 * uses, so a phrase and its meaning cannot drift apart.
 *
 *     describe("ally.any(hp_pct < 50)")   // 有同伴 HP 低于 50%
 *     describe("enemy(282).alive")        // 编号 282 的敌人还在
 */

import {
  parseExpression,
  type Expression,
  type NumericAttribute,
  type PathExpression,
  type PathHead,
  type PathMember,
} from "./expr.ts";
import { parseAction } from "./strategy.ts";
import type { Side, Strategy, StrategyPhase, StrategyReaction, StrategyRule } from "./types.ts";

const OPERATOR_TEXT: Readonly<Record<string, string>> = {
  "<": "低于",
  "<=": "不高于",
  "==": "等于",
  "!=": "不等于",
  ">": "高于",
  ">=": "不低于",
};

const PROPERTY_TEXT: Readonly<Record<string, string>> = {
  hp: "HP",
  max_hp: "最大 HP",
  hp_pct: "HP 百分比",
  mp: "MP",
  max_mp: "最大 MP",
  mp_pct: "MP 百分比",
  id: "编号",
  name: "名字",
};

const ATTRIBUTE_TEXT: Readonly<Record<NumericAttribute, string>> = {
  hp: "HP",
  max_hp: "最大 HP",
  hp_pct: "HP 百分比",
  mp: "MP",
  max_mp: "最大 MP",
  mp_pct: "MP 百分比",
  id: "编号",
};

const STATUS_TEXT: Readonly<Record<string, string>> = {
  毒: "中毒",
};

function attributeText(attribute: NumericAttribute): string {
  return ATTRIBUTE_TEXT[attribute];
}

function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

function propertyText(property: string): string {
  return PROPERTY_TEXT[property] ?? property;
}

/** Add a space only when the next word starts with a Latin letter or digit (HP, MP). */
function joinLeft(left: string, right: string): string {
  return `${left}${right === "" || /^[A-Za-z0-9]/u.test(right) ? " " : ""}${right}`;
}

function possessive(label: string, property: string): string {
  if (label === "") return property;
  if (label === "自己" || label === "首领") return `${label} ${property}`;
  return `${label}的${property}`;
}

interface Subject {
  readonly label: string;
  readonly noun: string;
  readonly side: Side;
  readonly kind: "unit" | "set" | "all";
}

function headSubject(head: PathHead): Subject | null {
  switch (head.kind) {
    case "self":
      return { label: "自己", noun: "自己", side: "ally", kind: "unit" };
    case "side":
      return head.side === "ally"
        ? { label: "同伴", noun: "同伴", side: "ally", kind: "set" }
        : { label: "敌人", noun: "敌人", side: "enemy", kind: "set" };
    case "unit": {
      const noun = head.side === "ally" ? "同伴" : "敌人";
      if (head.side === "ally" && head.selector.by === "name") {
        return { label: head.selector.name, noun, side: "ally", kind: "unit" };
      }
      if (head.side === "enemy" && head.selector.by === "name") {
        return { label: head.selector.name, noun, side: "enemy", kind: "unit" };
      }
      const id = head.selector.by === "id" ? head.selector.id : 0;
      return {
        label: `编号 ${id} 的${noun}`,
        noun,
        side: head.side,
        kind: "unit",
      };
    }
    case "predicate":
      return { label: "", noun: "", side: "ally", kind: "unit" };
    case "item":
    case "turn":
    case "battle":
      return null;
  }
}

function producesUnit(member: PathMember): boolean {
  if (member.kind === "rank") return true;
  if (member.kind === "predicate") return member.name === "first";
  if (member.kind === "property") return member.name === "boss" || member.name === "all";
  return false;
}

function firstLabel(predicate: Expression, noun: string): string {
  const suffix = noun === "" ? "单位" : noun;
  if (predicate.kind === "not") {
    const alive = bareProperty(predicate.operand, "alive");
    if (alive) return `倒下的${suffix}`;
  }
  if (predicate.kind === "path" && predicate.head.kind === "predicate") {
    const only = predicate.members.length === 1 ? predicate.members[0] : undefined;
    if (only?.kind === "unitMethod") {
      if (only.name === "has") return `${statusText(only.argument)}的${suffix}`;
      if (only.name === "weak") return `弱${only.argument}的${suffix}`;
    }
  }
  return `第一个${describeExpression(predicate)}的${suffix}`;
}

function bareProperty(expression: Expression, name: string): boolean {
  return (
    expression.kind === "path" &&
    expression.head.kind === "predicate" &&
    expression.members.length === 1 &&
    expression.members[0]?.kind === "property" &&
    expression.members[0].name === name
  );
}

function subjectOf(path: PathExpression): Subject {
  let subject = headSubject(path.head) ?? {
    label: "",
    noun: "",
    side: "ally" as Side,
    kind: "unit" as const,
  };
  for (const member of path.members) {
    if (!producesUnit(member)) break;
    if (member.kind === "rank") {
      const attribute = attributeText(member.attribute);
      const spaced = /[A-Za-z0-9]$/u.test(attribute) ? `${attribute} ` : attribute;
      subject = {
        ...subject,
        label: `${spaced}${member.name === "lowest" ? "最低" : "最高"}的${subject.noun}`,
        kind: "unit",
      };
      continue;
    }
    if (member.kind === "predicate" && member.name === "first") {
      subject = {
        ...subject,
        label: firstLabel(member.predicate, subject.noun),
        kind: "unit",
      };
      continue;
    }
    if (member.kind === "property" && member.name === "boss") {
      subject = { ...subject, label: "首领", noun: "首领", kind: "unit" };
      continue;
    }
    if (member.kind === "property" && member.name === "all") {
      subject = { ...subject, label: `所有${subject.noun}`, kind: "all" };
    }
  }
  return subject;
}

function methodText(label: string, member: PathMember): string {
  switch (member.kind) {
    case "unitMethod":
      switch (member.name) {
        case "has":
          return joinLeft(label, `有${statusText(member.argument)}状态`);
        case "weak":
          return joinLeft(label, `弱${member.argument}`);
        case "absorbs":
          return joinLeft(label, `吸收${member.argument}`);
        case "immune":
          return joinLeft(label, `对${member.argument}免疫`);
      }
      break;
    case "used": {
      const ability = member.argument === "any_magic" ? "魔法" : member.argument;
      const window = member.window === undefined ? "" : `,${member.window} 秒内`;
      return joinLeft(label, `用过${ability}${window}`);
    }
    case "property":
      if (member.name === "countered") return joinLeft(label, "反击过");
      break;
    default:
      break;
  }
  return label;
}

function unitPropertyText(label: string, property: string): string {
  if (property === "alive") return label === "" ? "活着" : `${label}还在`;
  return possessive(label, propertyText(property));
}

function describePath(path: PathExpression): string {
  if (path.type === "unit" || path.type === "all" || path.type === "set") {
    return subjectOf(path).label;
  }
  if (path.head.kind === "item") return `${path.head.name}的数量`;
  if (path.head.kind === "turn") return "行动次数";
  if (path.head.kind === "battle") {
    const last = path.members[path.members.length - 1];
    if (last?.kind === "property" && last.name === "boss") return "首领战";
    if (last?.kind === "property" && last.name === "seconds") return "战斗时间";
    return "战斗";
  }
  const last = path.members[path.members.length - 1];
  if (last === undefined) return "";
  const subject = subjectOf(path);
  if (last.kind === "property" && last.name === "alive") {
    if (subject.kind === "set") {
      const counter = subject.side === "ally" ? "人数" : "数";
      return `活着的${subject.noun}${counter}`;
    }
    return unitPropertyText(subject.label, "alive");
  }
  if (last.kind === "predicate") {
    const predicate = describeExpression(last.predicate);
    switch (last.name) {
      case "any":
        return `有${joinLeft(subject.noun, predicate)}`;
      case "all":
        return `所有${subject.noun}都${joinLeft("", predicate)}`;
      case "count": {
        const counter = subject.side === "ally" ? "人数" : "数量";
        return `${predicate}的${subject.noun}${counter}`;
      }
      case "first":
        return firstLabel(last.predicate, subject.noun);
    }
  }
  if (last.kind === "rank") {
    return subject.label;
  }
  if (last.kind === "property") return unitPropertyText(subject.label, last.name);
  return methodText(subject.label, last);
}

const COUNTING_OPERATOR_TEXT: Readonly<Record<string, string>> = {
  "<": "小于",
  "<=": "不多于",
  "==": "等于",
  "!=": "不等于",
  ">": "大于",
  ">=": "不少于",
};

function isCounting(expression: Expression): boolean {
  if (expression.kind !== "path") return false;
  if (expression.head.kind === "item") return true;
  const last = expression.members[expression.members.length - 1];
  if (last?.kind === "predicate" && last.name === "count") return true;
  return last?.kind === "property" && last.name === "alive" && subjectOf(expression).kind === "set";
}

function operatorText(op: string, left: Expression): string {
  if (isCounting(left)) return COUNTING_OPERATOR_TEXT[op] ?? op;
  return OPERATOR_TEXT[op] ?? op;
}

function describeCompare(expression: Expression & { kind: "compare" }): string {
  const operator = operatorText(expression.op, expression.left);
  const property = expression.left.kind === "path" ? lastProperty(expression.left) : undefined;
  if ((property === "hp_pct" || property === "mp_pct") && expression.right.kind === "number") {
    const subject = expression.left.kind === "path" ? subjectOf(expression.left) : null;
    const label = subject?.label ?? "";
    const base =
      label === ""
        ? property === "hp_pct"
          ? "HP"
          : "MP"
        : possessive(label, property === "hp_pct" ? "HP" : "MP");
    return `${base} ${operator} ${expression.right.value}%`;
  }
  if (
    property === "name" &&
    expression.right.kind === "string" &&
    (expression.op === "==" || expression.op === "!=")
  ) {
    const subject = expression.left.kind === "path" ? subjectOf(expression.left) : null;
    const label = subject?.label ?? "";
    const prefix = label === "" ? "名字" : `${label}的名字`;
    return `${prefix}${expression.op === "==" ? "是" : "不是"}「${expression.right.value}」`;
  }
  if (expression.right.kind === "boolean" && (expression.op === "==" || expression.op === "!=")) {
    const positive = expression.right.value === (expression.op === "==");
    if (!positive) return describeNot(expression.left);
    return describeExpression(expression.left);
  }
  const left = describeExpression(expression.left);
  const right = describeExpression(expression.right);
  const spaced = /[A-Za-z0-9]$/u.test(left) ? `${left} ` : left;
  return `${spaced}${operator} ${right}`;
}

function lastProperty(path: PathExpression): string | undefined {
  const last = path.members[path.members.length - 1];
  return last?.kind === "property" ? last.name : undefined;
}

function describeNot(operand: Expression): string {
  if (operand.kind === "boolean") return operand.value ? "从不" : "总是";
  if (operand.kind === "path") {
    const subject = subjectOf(operand);
    const last = operand.members[operand.members.length - 1];
    if (last?.kind === "property" && last.name === "alive") {
      return subject.label === "" ? "倒下" : `${subject.label}不在了`;
    }
    if (last?.kind === "unitMethod" && last.name === "has") {
      return joinLeft(subject.label, `没有${statusText(last.argument)}状态`);
    }
    if (last?.kind === "unitMethod" && last.name === "weak") {
      return joinLeft(subject.label, `不弱${last.argument}`);
    }
    if (last?.kind === "unitMethod" && last.name === "absorbs") {
      return joinLeft(subject.label, `不吸收${last.argument}`);
    }
    if (last?.kind === "unitMethod" && last.name === "immune") {
      return joinLeft(subject.label, `不对${last.argument}免疫`);
    }
    if (last?.kind === "used") {
      const ability = last.argument === "any_magic" ? "魔法" : last.argument;
      return joinLeft(subject.label, `没用过${ability}`);
    }
    if (last?.kind === "property" && last.name === "countered") {
      return joinLeft(subject.label, "没反击过");
    }
  }
  return `并非(${describeExpression(operand)})`;
}

function describeLogical(expression: Expression & { kind: "and" | "or" }): string {
  const separator = expression.kind === "and" ? " 并且 " : " 或者 ";
  const wrap = (operand: Expression): string => {
    if (expression.kind === "and" && operand.kind === "or") {
      return `(${describeExpression(operand)})`;
    }
    return describeExpression(operand);
  };
  return `${wrap(expression.left)}${separator}${wrap(expression.right)}`;
}

export function describeExpression(expression: Expression): string {
  switch (expression.kind) {
    case "number":
      return String(expression.value);
    case "string":
      return `「${expression.value}」`;
    case "boolean":
      return expression.value ? "总是" : "从不";
    case "not":
      return describeNot(expression.operand);
    case "and":
    case "or":
      return describeLogical(expression);
    case "compare":
      return describeCompare(expression);
    case "path":
      return describePath(expression);
  }
}

/**
 * Chinese for one expression, rule, reaction, phase or whole strategy. A string is parsed as
 * an expression and throws ExpressionError when it cannot.
 */
export function describe(
  value: string | Strategy | StrategyPhase | StrategyReaction | StrategyRule,
): string {
  if (typeof value === "string") return describeExpression(parseExpression(value));
  if ("version" in value) return describeStrategy(value);
  if ("on" in value) return describeReaction(value);
  if ("rules" in value) return describePhase(value);
  return describeRule(value);
}

/** Translate `do`: 攻击, 防御, 换列, 道具「…」, 指令「能力」. */
export function describeAction(action: string): string {
  const parsed = parseAction(action);
  if (parsed === null) return action;
  if (parsed.ability === "") {
    return parsed.command === "攻击" || parsed.command === "防御" || parsed.command === "换列"
      ? parsed.command
      : `用${parsed.command}`;
  }
  if (parsed.command === "道具") return `用道具「${parsed.ability}」`;
  return `用${parsed.command}「${parsed.ability}」`;
}

function whoText(who: string): string {
  if (who === "all") return "全员";
  if (who === "any") return "任意一人";
  return who;
}

function describeTarget(rule: StrategyRule, action: string): string {
  if (rule.to === undefined || rule.to.trim() === "") return action;
  return `对${joinLeft("", describe(rule.to))}${action}`;
}

export function describeRule(rule: StrategyRule): string {
  const condition = rule.if === undefined || rule.if.trim() === "" ? null : describe(rule.if);
  const prefix = condition === null || condition === "总是" ? "其他情况" : `${condition}时`;
  const once = rule.once === true ? "(只做一次)" : "";
  return `${whoText(rule.who)}:${prefix}${once},${describeTarget(rule, describeAction(rule.do))}`;
}

export function describeReaction(reaction: StrategyReaction): string {
  const on = describe(reaction.on);
  const extra =
    reaction.if === undefined || reaction.if.trim() === "" ? "" : ` 并且 ${describe(reaction.if)}`;
  const condition = on === "总是" ? "总是" : `${on}${extra}时`;
  return `${whoText(reaction.who)}:${condition},${describeTarget(
    reaction,
    describeAction(reaction.do),
  )}`;
}

export function describePhase(phase: StrategyPhase): string {
  const when = phase.when === undefined || phase.when.trim() === "" ? "总是" : describe(phase.when);
  const note = phase.note === undefined || phase.note === "" ? "" : `(${phase.note})`;
  const lines = [`阶段「${phase.name}」:${when}${note}`];
  for (const rule of phase.rules) lines.push(`  ${describeRule(rule)}`);
  return lines.join("\n");
}

/** Translate a whole strategy; the sidebar shows this text as-is. */
export function describeStrategy(strategy: Strategy): string {
  const lines: string[] = [strategy.summary ?? "战斗策略"];
  const roles = Object.entries(strategy.roles);
  if (roles.length > 0) {
    lines.push(`定位:${roles.map(([name, role]) => `${name}=${role}`).join(",")}`);
  }
  if (strategy.reactions.length > 0) {
    lines.push("对策:");
    for (const reaction of strategy.reactions) {
      lines.push(`  ${describeReaction(reaction)}`);
    }
  }
  if (strategy.phases.length > 0) {
    for (const phase of strategy.phases) lines.push(describePhase(phase));
  } else if (strategy.rules.length > 0) {
    lines.push("规则:");
    for (const rule of strategy.rules) lines.push(`  ${describeRule(rule)}`);
  }
  return lines.join("\n");
}

/**
 * The strategy expression language (battle strategy plan §6): a small functional grammar
 * parsed by hand, never eval(). Conditions and targets share it, for example
 *
 *     ally.any(hp_pct < 50)
 *     not enemy(282).alive and item(不死鸟之尾) > 0
 *     ally.first(not alive)
 *     enemy.lowest(hp)
 *
 * Collection trade-off: `any`, `all`, `count` and `first` iterate every unit of that side,
 * fallen ones included, so `ally.count(not alive)` and `ally.first(not alive)` work.
 * `lowest` and `highest` only look at living units, because a fallen unit has 0 HP and would
 * always win. `ally.alive` and `enemy.alive` count living units. `ally(name)` and
 * `enemy(name)` return the unit even when it is fallen; reading a property of a missing name
 * gives 0, `alive` false and `name` "".
 */

import { ELEMENTS, toElement } from "../elements.ts";
import type { BattleEvent, BattleSnapshot, Side, SnapshotUnit } from "./types.ts";
import { StrategyError as StrategyFailure } from "./types.ts";

/** A parse error is a kind of StrategyFailure, so a hand-built table cannot break a battle. */
export class ExpressionError extends StrategyFailure {
  /** 1-based character position in the expression. */
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "ExpressionError";
    this.position = position;
  }
}

export type CompareOp = "<" | "<=" | "==" | "!=" | ">=" | ">";

const COMPARE_OPS: ReadonlySet<string> = new Set(["<", "<=", "==", "!=", ">=", ">"]);

export type ValueKind = "number" | "string" | "boolean" | "unit" | "set" | "all" | "battle";

export type NumericAttribute = "hp" | "max_hp" | "hp_pct" | "mp" | "max_mp" | "mp_pct" | "id";

const NUMERIC_ATTRIBUTES: ReadonlySet<string> = new Set([
  "hp",
  "max_hp",
  "hp_pct",
  "mp",
  "max_mp",
  "mp_pct",
  "id",
]);

export type PathHead =
  | { readonly kind: "self" }
  | { readonly kind: "side"; readonly side: Side }
  | {
      readonly kind: "unit";
      readonly side: Side;
      readonly selector:
        { readonly by: "name"; readonly name: string } | { readonly by: "id"; readonly id: number };
    }
  | { readonly kind: "item"; readonly name: string }
  | { readonly kind: "turn" }
  | { readonly kind: "battle" }
  /** A bare unit property/method inside any/all/count/first. */
  | { readonly kind: "predicate" };

export type PathMember =
  | { readonly kind: "property"; readonly name: string }
  | {
      readonly kind: "rank";
      readonly name: "lowest" | "highest";
      readonly attribute: NumericAttribute;
    }
  | {
      readonly kind: "predicate";
      readonly name: "any" | "all" | "count" | "first";
      readonly predicate: Expression;
    }
  | {
      readonly kind: "unitMethod";
      readonly name: "has" | "weak" | "absorbs" | "immune";
      readonly argument: string;
    }
  | {
      readonly kind: "used";
      readonly argument: string;
      readonly window?: number;
    };

export interface PathExpression {
  readonly kind: "path";
  readonly type: ValueKind;
  readonly head: PathHead;
  readonly members: readonly PathMember[];
}

export type Expression =
  | PathExpression
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "not"; readonly operand: Expression }
  | {
      readonly kind: "and";
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "or";
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "compare";
      readonly op: CompareOp;
      readonly left: Expression;
      readonly right: Expression;
    };

export function expressionType(expression: Expression): ValueKind {
  if (expression.kind === "path") return expression.type;
  if (
    expression.kind === "not" ||
    expression.kind === "and" ||
    expression.kind === "or" ||
    expression.kind === "compare"
  ) {
    return "boolean";
  }
  return expression.kind;
}

// ---------------------------------------------------------------------------------------------
// Tokens and parsing

type Token =
  | { readonly kind: "word"; readonly value: string; readonly offset: number }
  | { readonly kind: "number"; readonly value: number; readonly offset: number }
  | { readonly kind: "string"; readonly value: string; readonly offset: number }
  | {
      readonly kind: "punct";
      readonly value: "." | "(" | ")" | ",";
      readonly offset: number;
    }
  | { readonly kind: "op"; readonly value: CompareOp; readonly offset: number }
  | { readonly kind: "eof"; readonly offset: number };

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WORD_START = /[\p{L}_]/u;
const NUMBER = /^-?\d+(?:\.\d+)?/u;

function charPosition(source: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, source.length));
  return Array.from(source.slice(0, end)).length + 1;
}

function tokenText(token: Token): string {
  switch (token.kind) {
    case "word":
    case "number":
    case "string":
    case "op":
      return String(token.value);
    case "punct":
      return token.value;
    case "eof":
      return "结尾";
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const fail = (offset: number, message: string): never => {
    throw new ExpressionError(message, charPosition(source, offset));
  };

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;
    if (/\s/u.test(char)) {
      index++;
      continue;
    }
    if (char === "." || char === "(" || char === ")" || char === ",") {
      tokens.push({ kind: "punct", value: char, offset: index });
      index++;
      continue;
    }
    if (char === "<" || char === ">" || char === "=" || char === "!") {
      const two = source.slice(index, index + 2);
      if (COMPARE_OPS.has(two)) {
        tokens.push({ kind: "op", value: two as CompareOp, offset: index });
        index += 2;
        continue;
      }
      if (char === "<" || char === ">") {
        tokens.push({ kind: "op", value: char, offset: index });
        index++;
        continue;
      }
      fail(index, `不认识的符号「${char}」;比较符是 < <= == != >= >`);
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const start = index;
      index++;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined) break;
        index++;
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\\") {
          const escaped = source[index];
          if (escaped === undefined) break;
          index++;
          const mapped =
            escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped;
          value += mapped;
          continue;
        }
        value += current;
      }
      if (!closed) fail(start, "字符串没有结束");
      tokens.push({ kind: "string", value, offset: start });
      continue;
    }
    if (char === "-" || /\d/u.test(char)) {
      const match = NUMBER.exec(source.slice(index));
      const raw = match?.[0] ?? "";
      if (raw === "") fail(index, `不认识的符号「${char}」`);
      tokens.push({ kind: "number", value: Number(raw), offset: index });
      index += raw.length;
      continue;
    }
    if (WORD_START.test(char)) {
      const start = index;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined || !WORD_CHAR.test(current)) break;
        index++;
      }
      tokens.push({
        kind: "word",
        value: source.slice(start, index),
        offset: start,
      });
      continue;
    }
    fail(index, `不认识的符号「${char}」`);
  }
  tokens.push({ kind: "eof", offset: source.length });
  return tokens;
}

interface MemberResult {
  readonly member: PathMember;
  readonly type: ValueKind;
}

class Parser {
  private readonly source: string;
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  parse(): Expression {
    const expression = this.parseOr(false);
    const extra = this.peek();
    if (extra.kind !== "eof") {
      throw this.error(extra.offset, `多了「${tokenText(extra)}」`);
    }
    return expression;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: "eof", offset: this.source.length };
  }

  private error(offset: number, message: string): ExpressionError {
    return new ExpressionError(message, charPosition(this.source, offset));
  }

  private matchPunct(value: "." | "(" | ")" | ","): boolean {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private expectPunct(value: "." | "(" | ")" | ","): Token {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.index++;
      return token;
    }
    throw this.error(token.offset, `这里要写「${value}」`);
  }

  private matchWord(value: string): boolean {
    const token = this.peek();
    if (token.kind === "word" && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private expectWord(message: string): Token & { kind: "word" } {
    const token = this.peek();
    if (token.kind === "word") {
      this.index++;
      return token;
    }
    throw this.error(token.offset, message);
  }

  private parseOr(inPredicate: boolean): Expression {
    let left = this.parseAnd(inPredicate);
    while (this.matchWord("or")) {
      const right = this.parseAnd(inPredicate);
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(inPredicate: boolean): Expression {
    let left = this.parseNot(inPredicate);
    while (this.matchWord("and")) {
      const right = this.parseNot(inPredicate);
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseNot(inPredicate: boolean): Expression {
    if (this.matchWord("not")) {
      return { kind: "not", operand: this.parseNot(inPredicate) };
    }
    return this.parseCompare(inPredicate);
  }

  private parseCompare(inPredicate: boolean): Expression {
    const leftStart = this.peek().offset;
    const left = this.parseValue(inPredicate);
    const token = this.peek();
    if (token.kind === "op") {
      this.index++;
      const rightStart = this.peek().offset;
      const right = this.parseValue(inPredicate);
      if (token.value !== "==" && token.value !== "!=") {
        this.ensureOrderedNumeric(left, token.value, leftStart, token.offset);
        this.ensureOrderedNumeric(right, token.value, rightStart, this.peek().offset);
      }
      return { kind: "compare", op: token.value, left, right };
    }
    return left;
  }

  /**
   * Task 53: `ally.lowest(hp_pct) < 30` compares a unit with a number. The parser knows the
   * type, so reject it here with the expression to write instead; the executor never sees it.
   */
  private ensureOrderedNumeric(
    expression: Expression,
    op: CompareOp,
    start: number,
    end: number,
  ): void {
    const type = expressionType(expression);
    if (type !== "unit" && type !== "set" && type !== "all" && type !== "battle") return;
    const text = this.source.slice(start, Math.max(start, end)).trim();
    throw this.error(start, orderedComparisonMessage(type, text, op));
  }

  private parseValue(inPredicate: boolean): Expression {
    const token = this.peek();
    if (token.kind === "number") {
      this.index++;
      return { kind: "number", value: token.value };
    }
    if (token.kind === "string") {
      this.index++;
      return { kind: "string", value: token.value };
    }
    if (token.kind === "punct" && token.value === "(") {
      this.index++;
      const expression = this.parseOr(inPredicate);
      this.expectPunct(")");
      return expression;
    }
    if (token.kind === "word") {
      this.index++;
      if (token.value === "true") return { kind: "boolean", value: true };
      if (token.value === "false") return { kind: "boolean", value: false };
      if (isHeadWord(token.value)) return this.parseHead(token);
      if (inPredicate) return this.parseBareUnit(token);
      throw this.error(
        token.offset,
        `不认识的开头 ${token.value};能用:self、ally、enemy、item(...)、turn、battle`,
      );
    }
    throw this.error(token.offset, "这里要写一个值");
  }

  private parseHead(token: Token & { kind: "word" }): Expression {
    switch (token.value) {
      case "self":
        return this.parseMembers({ kind: "self" }, "unit", "ally", token);
      case "ally":
      case "enemy": {
        const side: Side = token.value === "ally" ? "ally" : "enemy";
        const peeked = this.peek();
        if (peeked.kind === "punct" && peeked.value === "(") {
          const selector = this.parseSelector(side);
          return this.parseMembers({ kind: "unit", side, selector }, "unit", side, token);
        }
        return this.parseMembers({ kind: "side", side }, "set", side, token);
      }
      case "item":
        return this.parseItem();
      case "turn":
        return this.parseMembers({ kind: "turn" }, "number", undefined, token);
      case "battle":
        return this.parseMembers({ kind: "battle" }, "battle", undefined, token);
      default:
        throw this.error(token.offset, `不认识的开头 ${token.value}`);
    }
  }

  private parseItem(): PathExpression {
    this.expectPunct("(");
    const argument = this.peek();
    if (argument.kind !== "word" && argument.kind !== "string") {
      throw this.error(argument.offset, "item(...) 里要写道具名,比如 item(不死鸟之尾)");
    }
    if (argument.value.trim() === "") {
      throw this.error(argument.offset, "item(...) 里的道具名不能是空的");
    }
    this.index++;
    this.expectPunct(")");
    const head: PathHead = { kind: "item", name: argument.value };
    const peeked = this.peek();
    if (peeked.kind === "punct" && peeked.value === ".") {
      throw this.error(peeked.offset, "item(...) 后面不能再写属性");
    }
    return { kind: "path", type: "number", head, members: [] };
  }

  private parseSelector(
    side: Side,
  ): { readonly by: "name"; readonly name: string } | { readonly by: "id"; readonly id: number } {
    this.expectPunct("(");
    const argument = this.peek();
    if (argument.kind === "word" || argument.kind === "string") {
      if (argument.value.trim() === "") {
        throw this.error(argument.offset, "名字不能是空的");
      }
      this.index++;
      this.expectPunct(")");
      return { by: "name", name: argument.value };
    }
    if (argument.kind === "number") {
      this.index++;
      if (!Number.isInteger(argument.value) || argument.value < 0) {
        throw this.error(argument.offset, "编号要写成非负整数,比如 enemy(282)");
      }
      this.expectPunct(")");
      return { by: "id", id: argument.value };
    }
    throw this.error(
      argument.offset,
      `${side === "ally" ? "ally" : "enemy"}(...) 里要写名字或编号,比如 enemy(282)`,
    );
  }

  private parseBareUnit(token: Token & { kind: "word" }): PathExpression {
    const head: PathHead = { kind: "predicate" };
    const first = this.parseUnitMember(token);
    const members: PathMember[] = [first.member];
    let type = first.type;
    while (this.matchPunct(".")) {
      const memberToken = this.expectWord("点号后面要写属性或方法");
      const parsed = this.parseMember(memberToken, type, undefined);
      members.push(parsed.member);
      type = parsed.type;
    }
    return { kind: "path", type, head, members };
  }

  private parseMembers(
    head: PathHead,
    type: ValueKind,
    side: Side | undefined,
    headToken: Token,
  ): PathExpression {
    const members: PathMember[] = [];
    let current = type;
    if (type !== "set" && type !== "unit" && type !== "battle") {
      const token = this.peek();
      if (token.kind === "punct" && token.value === ".") {
        throw this.error(token.offset, `${headTokenText(headToken)} 后面不能再写属性`);
      }
      return { kind: "path", type, head, members };
    }
    while (this.matchPunct(".")) {
      const memberToken = this.expectWord("点号后面要写属性或方法");
      const parsed = this.parseMember(memberToken, current, side);
      members.push(parsed.member);
      current = parsed.type;
      if (current !== "set" && current !== "unit" && current !== "battle") {
        const token = this.peek();
        if (token.kind === "punct" && token.value === ".") {
          throw this.error(token.offset, `${memberToken.value} 后面不能再写属性`);
        }
        break;
      }
    }
    return { kind: "path", type: current, head, members };
  }

  private parseMember(
    token: Token & { kind: "word" },
    type: ValueKind,
    side: Side | undefined,
  ): MemberResult {
    if (type === "set") return this.parseSetMember(token, side ?? "ally");
    if (type === "unit") return this.parseUnitMember(token);
    if (type === "battle") return this.parseBattleMember(token);
    throw this.error(token.offset, `${typeLabel(type)} 后面不能再写属性`);
  }

  private parseSetMember(token: Token & { kind: "word" }, side: Side): MemberResult {
    const name = token.value;
    if (name === "alive") {
      this.ensureNoArguments(token);
      return { member: { kind: "property", name }, type: "number" };
    }
    if (name === "boss") {
      if (side !== "enemy") throw this.error(token.offset, "只有敌人集合有首领");
      this.ensureNoArguments(token);
      return { member: { kind: "property", name }, type: "unit" };
    }
    if (name === "all") {
      if (!this.peekIsPunct("(")) {
        return { member: { kind: "property", name }, type: "all" };
      }
      return {
        member: {
          kind: "predicate",
          name: "all",
          predicate: this.parsePredicate(),
        },
        type: "boolean",
      };
    }
    if (name === "any" || name === "count" || name === "first") {
      if (!this.peekIsPunct("(")) {
        throw this.error(token.offset, `${name} 要写成 ${name}(谓词),比如 ${name}(hp_pct < 50)`);
      }
      const result: ValueKind = name === "count" ? "number" : name === "first" ? "unit" : "boolean";
      return {
        member: { kind: "predicate", name, predicate: this.parsePredicate() },
        type: result,
      };
    }
    if (name === "lowest" || name === "highest") {
      this.expectPunct("(");
      const attribute = this.expectWord(`${name}(...) 里要写数值属性,比如 ${name}(hp_pct)`);
      if (!NUMERIC_ATTRIBUTES.has(attribute.value)) {
        throw this.error(
          attribute.offset,
          `不认识的属性 ${attribute.value};能用:${[...NUMERIC_ATTRIBUTES].join("、")}`,
        );
      }
      this.expectPunct(")");
      return {
        member: {
          kind: "rank",
          name,
          attribute: attribute.value as NumericAttribute,
        },
        type: "unit",
      };
    }
    throw this.error(token.offset, unknownMethodMessage(name, SET_MEMBERS));
  }

  private parseUnitMember(token: Token & { kind: "word" }): MemberResult {
    const name = token.value;
    if (name === "has" || name === "weak" || name === "absorbs" || name === "immune") {
      const raw = this.parseWordArgument(name);
      let argument = raw;
      if (name !== "has") {
        const element = toElement(raw);
        if (element === null) {
          throw this.error(token.offset, `属性「${raw}」不认识;能用:${ELEMENTS.join("、")}`);
        }
        argument = element;
      }
      return {
        member: { kind: "unitMethod", name, argument },
        type: "boolean",
      };
    }
    if (name === "used") {
      return { member: this.parseUsed(), type: "boolean" };
    }
    if (name === "countered") {
      this.ensureNoArguments(token);
      return { member: { kind: "property", name }, type: "boolean" };
    }
    const propertyType = UNIT_PROPERTIES.get(name);
    if (propertyType !== undefined) {
      this.ensureNoArguments(token);
      return { member: { kind: "property", name }, type: propertyType };
    }
    throw this.error(
      token.offset,
      unknownMethodMessage(name, [
        ...UNIT_PROPERTIES.keys(),
        "has",
        "weak",
        "absorbs",
        "immune",
        "used",
        "countered",
      ]),
    );
  }

  private parseBattleMember(token: Token & { kind: "word" }): MemberResult {
    const name = token.value;
    if (name === "seconds") {
      this.ensureNoArguments(token);
      return { member: { kind: "property", name }, type: "number" };
    }
    if (name === "boss") {
      this.ensureNoArguments(token);
      return { member: { kind: "property", name }, type: "boolean" };
    }
    throw this.error(token.offset, unknownMethodMessage(name, ["seconds", "boss"]));
  }

  private parsePredicate(): Expression {
    this.expectPunct("(");
    const predicate = this.parseOr(true);
    this.expectPunct(")");
    return predicate;
  }

  private parseWordArgument(name: string): string {
    this.expectPunct("(");
    const argument = this.peek();
    if (argument.kind !== "word" && argument.kind !== "string") {
      throw this.error(argument.offset, `${name}(...) 里要写一个名字`);
    }
    if (argument.value.trim() === "") {
      throw this.error(argument.offset, `${name}(...) 里的名字不能是空的`);
    }
    this.index++;
    this.expectPunct(")");
    return argument.value;
  }

  private parseUsed(): PathMember {
    this.expectPunct("(");
    const argument = this.peek();
    if (argument.kind !== "word" && argument.kind !== "string") {
      throw this.error(argument.offset, "used(...) 里要写能力名或 any_magic");
    }
    if (argument.value.trim() === "") {
      throw this.error(argument.offset, "used(...) 里的能力名不能是空的");
    }
    this.index++;
    if (this.matchPunct(",")) {
      const window = this.peek();
      if (window.kind !== "number" || window.value < 0) {
        throw this.error(window.offset, "used(...) 的第二个参数要是秒数,比如 used(治疗, 30)");
      }
      this.index++;
      this.expectPunct(")");
      return { kind: "used", argument: argument.value, window: window.value };
    }
    this.expectPunct(")");
    return { kind: "used", argument: argument.value };
  }

  private ensureNoArguments(token: Token & { kind: "word" }): void {
    if (this.peekIsPunct("(")) {
      throw this.error(token.offset, `${token.value} 不带参数`);
    }
  }

  private peekIsPunct(value: "(" | ")" | "." | ","): boolean {
    const token = this.peek();
    return token.kind === "punct" && token.value === value;
  }
}

const SET_MEMBERS: readonly string[] = [
  "any",
  "all",
  "count",
  "first",
  "lowest",
  "highest",
  "alive",
  "boss",
];

const UNIT_PROPERTIES: ReadonlyMap<string, ValueKind> = new Map<string, ValueKind>([
  ["hp", "number"],
  ["max_hp", "number"],
  ["hp_pct", "number"],
  ["mp", "number"],
  ["max_mp", "number"],
  ["mp_pct", "number"],
  ["id", "number"],
  ["name", "string"],
  ["alive", "boolean"],
]);

function headTokenText(token: Token): string {
  return token.kind === "word" ? token.value : tokenText(token);
}

function typeLabel(type: ValueKind): string {
  switch (type) {
    case "number":
      return "数字";
    case "string":
      return "字符串";
    case "boolean":
      return "真假值";
    case "unit":
      return "单位";
    case "set":
      return "集合";
    case "all":
      return "全体";
    case "battle":
      return "战斗";
  }
}

function orderedComparisonMessage(type: ValueKind, text: string, op: CompareOp): string {
  switch (type) {
    case "unit": {
      const side = text.startsWith("enemy") ? "enemy" : "ally";
      const who = side === "enemy" ? "一个敌人" : "一个人";
      return `「${text}」是${who},不是数;要比它的 HP 比例写「${text}.hp_pct < 30」,或者写「${side}.any(hp_pct < 30)」`;
    }
    case "set":
      return `「${text}」是一个集合,不是数;要数人数写「${text}.alive」,比如「${text}.alive ${op} 3」`;
    case "all":
      return `「${text}」是「全体」,不是数;要数人数写「ally.alive」,比如「ally.alive ${op} 3」`;
    case "battle":
      return `「${text}」是战斗,不是数;要读秒数写「battle.seconds」,比如「battle.seconds ${op} 30」`;
    default:
      return `「${text}」不是数,不能写在 ${op} 两边`;
  }
}

function isHeadWord(value: string): boolean {
  return (
    value === "self" ||
    value === "ally" ||
    value === "enemy" ||
    value === "item" ||
    value === "turn" ||
    value === "battle"
  );
}

function editDistance(a: string, b: string): number {
  const rows: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = rows[0] ?? 0;
    rows[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = rows[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[j] = Math.min((rows[j] ?? 0) + 1, (rows[j - 1] ?? 0) + 1, previous + cost);
      previous = current;
    }
  }
  return rows[b.length] ?? Math.max(a.length, b.length);
}

function unknownMethodMessage(name: string, candidates: readonly string[]): string {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best !== null && bestDistance <= 2 && name.length >= 3) {
    return `不认识的方法 ${name},是不是 ${best}?`;
  }
  return `不认识的方法 ${name};能用:${candidates.join("、")}`;
}

/** Parse one expression. Throws ExpressionError with a 1-based character position. */
export function parseExpression(source: string): Expression {
  return new Parser(source).parse();
}

// ---------------------------------------------------------------------------------------------
// Evaluation

export interface EvaluatedUnit {
  readonly kind: "unit";
  readonly side: Side;
  readonly unit: SnapshotUnit | null;
}

export interface EvaluatedSet {
  readonly kind: "set";
  readonly side: Side;
}

export interface EvaluatedAll {
  readonly kind: "all";
  readonly side: Side;
}

export interface EvaluatedBattle {
  readonly kind: "battle";
  readonly snapshot: BattleSnapshot;
}

export type Evaluation =
  number | string | boolean | EvaluatedUnit | EvaluatedSet | EvaluatedAll | EvaluatedBattle;

export type Target =
  | { readonly kind: "unit"; readonly side: Side; readonly unit: SnapshotUnit }
  | { readonly kind: "all"; readonly side: Side }
  | null;

interface EvalContext {
  readonly predicate?: EvaluatedUnit;
}

function unitsOf(snapshot: BattleSnapshot, side: Side): readonly SnapshotUnit[] {
  return side === "ally" ? snapshot.allies : snapshot.enemies;
}

function unitValue(side: Side, unit: SnapshotUnit | null): EvaluatedUnit {
  return { kind: "unit", side, unit };
}

function findUnit(
  snapshot: BattleSnapshot,
  side: Side,
  selector:
    { readonly by: "name"; readonly name: string } | { readonly by: "id"; readonly id: number },
): SnapshotUnit | null {
  const units = unitsOf(snapshot, side);
  if (selector.by === "id") {
    return units.find((unit) => unit.id === selector.id) ?? null;
  }
  return units.find((unit) => unit.name === selector.name) ?? null;
}

function selfUnit(snapshot: BattleSnapshot): EvaluatedUnit {
  const actor = snapshot.actor;
  if (actor === undefined) return unitValue("ally", null);
  const found = snapshot.allies.find((unit) => unit.name === actor);
  return unitValue("ally", found ?? null);
}

function itemCount(snapshot: BattleSnapshot, name: string): number {
  const items = snapshot.items ?? {};
  let total = 0;
  for (const [item, count] of Object.entries(items)) {
    if (item === name || item.includes(name)) total += count;
  }
  return total;
}

function percent(value: number, maximum: number | undefined): number {
  const top = maximum ?? 0;
  return top > 0 ? (100 * value) / top : 100;
}

function numericProperty(unit: SnapshotUnit, attribute: NumericAttribute): number {
  switch (attribute) {
    case "hp":
      return unit.hp;
    case "max_hp":
      return unit.maxHp ?? 0;
    case "hp_pct":
      return percent(unit.hp, unit.maxHp);
    case "mp":
      return unit.mp ?? 0;
    case "max_mp":
      return unit.maxMp ?? 0;
    case "mp_pct":
      return percent(unit.mp ?? 0, unit.maxMp);
    case "id":
      return unit.id ?? 0;
  }
}

function statusNames(unit: SnapshotUnit): readonly string[] {
  return [...(unit.status ?? []), ...(unit.buffs ?? [])];
}

function hasStatus(unit: SnapshotUnit, wanted: string): boolean {
  return statusNames(unit).some((status) => status === wanted || status.includes(wanted));
}

function actorEvents(unit: SnapshotUnit, snapshot: BattleSnapshot): readonly BattleEvent[] {
  return (snapshot.events ?? []).filter((event) => event.actor === unit.name);
}

function matchesAbility(event: BattleEvent, ability: string): boolean {
  return ability === "any_magic" ? event.magic === true : event.ability === ability;
}

function latestAction(events: readonly BattleEvent[]): readonly BattleEvent[] {
  const last = events[events.length - 1];
  if (last === undefined) return [];
  if (last.at === undefined) return [last];
  return events.filter((event) => event.at === last.at);
}

function usedAbility(
  unit: SnapshotUnit,
  ability: string,
  window: number | undefined,
  snapshot: BattleSnapshot,
): boolean {
  const events = actorEvents(unit, snapshot);
  if (window !== undefined) {
    const now = snapshot.seconds ?? 0;
    return events.some(
      (event) =>
        matchesAbility(event, ability) && (event.at === undefined || event.at >= now - window),
    );
  }
  return latestAction(events).some((event) => matchesAbility(event, ability));
}

function countered(unit: SnapshotUnit, snapshot: BattleSnapshot): boolean {
  return latestAction(actorEvents(unit, snapshot)).some((event) => event.countered === true);
}

function unitProperty(unit: EvaluatedUnit, name: string): number | string | boolean {
  const value = unit.unit;
  if (name === "alive") return value !== null && value.hp > 0;
  if (value === null) return name === "name" ? "" : 0;
  switch (name) {
    case "hp":
      return value.hp;
    case "max_hp":
      return value.maxHp ?? 0;
    case "hp_pct":
      return percent(value.hp, value.maxHp);
    case "mp":
      return value.mp ?? 0;
    case "max_mp":
      return value.maxMp ?? 0;
    case "mp_pct":
      return percent(value.mp ?? 0, value.maxMp);
    case "id":
      return value.id ?? 0;
    case "name":
      return value.name;
    default:
      throw new StrategyFailure(`单位没有属性「${name}」`);
  }
}

function applyUnitMember(
  unit: EvaluatedUnit,
  member: PathMember,
  snapshot: BattleSnapshot,
): Evaluation {
  if (member.kind === "property") {
    if (member.name === "countered") {
      return unit.unit === null ? false : countered(unit.unit, snapshot);
    }
    return unitProperty(unit, member.name);
  }
  if (member.kind === "unitMethod") {
    if (unit.unit === null) return false;
    switch (member.name) {
      case "has":
        return hasStatus(unit.unit, member.argument);
      case "weak":
        return (unit.unit.weak ?? []).includes(member.argument);
      case "absorbs":
        return (unit.unit.absorbs ?? []).includes(member.argument);
      case "immune":
        return (unit.unit.immune ?? []).includes(member.argument);
    }
  }
  if (member.kind === "used") {
    return unit.unit === null
      ? false
      : usedAbility(unit.unit, member.argument, member.window, snapshot);
  }
  throw new StrategyFailure("单位上没有这个方法");
}

function bossUnit(snapshot: BattleSnapshot, side: Side): EvaluatedUnit {
  const units = unitsOf(snapshot, side);
  const found =
    units.find((unit) => unit.boss === true && unit.hp > 0) ??
    units.find((unit) => unit.boss === true) ??
    null;
  return unitValue(side, found);
}

function applySetMember(
  set: EvaluatedSet,
  member: PathMember,
  snapshot: BattleSnapshot,
): Evaluation {
  if (member.kind === "property") {
    const units = unitsOf(snapshot, set.side);
    if (member.name === "alive") return units.filter((unit) => unit.hp > 0).length;
    if (member.name === "boss") return bossUnit(snapshot, set.side);
    if (member.name === "all") return { kind: "all", side: set.side } satisfies EvaluatedAll;
    throw new StrategyFailure(`集合没有属性「${member.name}」`);
  }
  if (member.kind === "rank") {
    const alive = unitsOf(snapshot, set.side).filter((unit) => unit.hp > 0);
    let best: SnapshotUnit | null = null;
    let bestValue = 0;
    for (const unit of alive) {
      const value = numericProperty(unit, member.attribute);
      if (best === null || (member.name === "lowest" ? value < bestValue : value > bestValue)) {
        best = unit;
        bestValue = value;
      }
    }
    return unitValue(set.side, best);
  }
  if (member.kind === "predicate") {
    const units = unitsOf(snapshot, set.side);
    const holds = (unit: SnapshotUnit): boolean =>
      truthiness(
        evalNode(member.predicate, snapshot, {
          predicate: unitValue(set.side, unit),
        }),
      );
    if (member.name === "any") return units.some(holds);
    if (member.name === "all") return units.every(holds);
    if (member.name === "count") return units.filter(holds).length;
    return unitValue(set.side, units.find(holds) ?? null);
  }
  throw new StrategyFailure("集合上没有这个方法");
}

function applyBattleMember(battle: EvaluatedBattle, member: PathMember): Evaluation {
  if (member.kind !== "property") throw new StrategyFailure("战斗上没有这个方法");
  if (member.name === "seconds") return battle.snapshot.seconds ?? 0;
  if (member.name === "boss") {
    if (battle.snapshot.boss !== undefined) return battle.snapshot.boss;
    return battle.snapshot.enemies.some((unit) => unit.boss === true);
  }
  throw new StrategyFailure(`战斗没有属性「${member.name}」`);
}

function evalPath(
  path: PathExpression,
  snapshot: BattleSnapshot,
  context: EvalContext,
): Evaluation {
  let value: Evaluation;
  switch (path.head.kind) {
    case "self":
      value = selfUnit(snapshot);
      break;
    case "side":
      value = { kind: "set", side: path.head.side } satisfies EvaluatedSet;
      break;
    case "unit":
      value = unitValue(path.head.side, findUnit(snapshot, path.head.side, path.head.selector));
      break;
    case "item":
      value = itemCount(snapshot, path.head.name);
      break;
    case "turn":
      value = snapshot.turn ?? 1;
      break;
    case "battle":
      value = { kind: "battle", snapshot } satisfies EvaluatedBattle;
      break;
    case "predicate":
      value = context.predicate ?? selfUnit(snapshot);
      break;
  }
  for (const member of path.members) {
    if (typeof value !== "object") {
      throw new StrategyFailure("这个值后面不能再取属性");
    }
    if (value.kind === "set") value = applySetMember(value, member, snapshot);
    else if (value.kind === "unit") value = applyUnitMember(value, member, snapshot);
    else if (value.kind === "battle") value = applyBattleMember(value, member);
    else throw new StrategyFailure("这个值后面不能再取属性");
  }
  return value;
}

function evalNode(
  expression: Expression,
  snapshot: BattleSnapshot,
  context: EvalContext,
): Evaluation {
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "string":
      return expression.value;
    case "boolean":
      return expression.value;
    case "path":
      return evalPath(expression, snapshot, context);
    case "not":
      return !truthiness(evalNode(expression.operand, snapshot, context));
    case "and":
      return (
        truthiness(evalNode(expression.left, snapshot, context)) &&
        truthiness(evalNode(expression.right, snapshot, context))
      );
    case "or":
      return (
        truthiness(evalNode(expression.left, snapshot, context)) ||
        truthiness(evalNode(expression.right, snapshot, context))
      );
    case "compare":
      return compareValues(
        expression.op,
        evalNode(expression.left, snapshot, context),
        evalNode(expression.right, snapshot, context),
      );
  }
}

function truthiness(value: Evaluation): boolean {
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";
  if (typeof value === "boolean") return value;
  switch (value.kind) {
    case "unit":
      return value.unit !== null;
    case "set":
    case "all":
      return true;
    case "battle":
      return true;
  }
}

function unitName(value: Evaluation): string | null {
  return typeof value === "object" && value.kind === "unit" ? (value.unit?.name ?? "") : null;
}

function asNumber(value: Evaluation): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) ? number : Number.NaN;
  }
  if (value.kind === "unit") {
    throw new StrategyFailure("不能拿单位和数字比大小");
  }
  throw new StrategyFailure("这个值不能比大小");
}

function equalValues(left: Evaluation, right: Evaluation): boolean {
  const leftUnit = unitName(left);
  const rightUnit = unitName(right);
  if (leftUnit !== null || rightUnit !== null) {
    return leftUnit !== null && rightUnit !== null && leftUnit === rightUnit;
  }
  if (typeof left === "string" || typeof right === "string") {
    return left === right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") return left === right;
  return asNumber(left) === asNumber(right);
}

function compareValues(op: CompareOp, left: Evaluation, right: Evaluation): boolean {
  if (op === "==") return equalValues(left, right);
  if (op === "!=") return !equalValues(left, right);
  if (typeof left === "string" && typeof right === "string") {
    const order = left.localeCompare(right);
    if (op === "<") return order < 0;
    if (op === "<=") return order <= 0;
    if (op === ">") return order > 0;
    return order >= 0;
  }
  const a = asNumber(left);
  const b = asNumber(right);
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

/** Evaluate an expression (text or already parsed AST) against one snapshot. */
export function evaluate(expression: string | Expression, snapshot: BattleSnapshot): Evaluation {
  const parsed = typeof expression === "string" ? parseExpression(expression) : expression;
  return evalNode(parsed, snapshot, {});
}

/**
 * The unit or whole group a rule's `to` names, or null when it names nobody (a missing name,
 * a non-unit value, or an absent `to`, where the game's default cursor decides).
 */
export function resolveTarget(
  to: string | Expression | undefined,
  snapshot: BattleSnapshot,
): Target {
  if (to === undefined || (typeof to === "string" && to.trim() === "")) return null;
  const value = evaluate(to, snapshot);
  if (typeof value !== "object") return null;
  if (value.kind === "unit") {
    if (value.unit === null) return null;
    return { kind: "unit", side: value.side, unit: value.unit };
  }
  if (value.kind === "set" || value.kind === "all") {
    return { kind: "all", side: value.side };
  }
  return null;
}

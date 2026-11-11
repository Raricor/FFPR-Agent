/**
 * Converting the old per-character rule tables (skills/gambit.ts) to strategy 2.0 (battle
 * strategy plan §6). Every old vocabulary word is mapped explicitly; unknown words or targets
 * fail loudly instead of being carried into a strategy that cannot run.
 *
 *     fromLegacy({"蕾娜": [{if: "ally.hp_pct < 50", do: "白魔法:治疗",
 *                          target: "hp最低的同伴"}]})
 *     // → rules: [{who: "蕾娜", if: "ally.lowest(hp_pct).hp_pct < 50", ...}]
 *
 * `enemy.name.X` becomes `enemy.count(name == "X")` (rather than `enemy(X).alive`) so that an
 * old comparison such as `enemy.name.喧嚣鬼 >= 2` keeps its count meaning.
 */

import {
  AILING,
  ailmentOf,
  ENEMY,
  ENEMY_LOWEST,
  ENEMY_NAMED_PREFIX,
  ENEMY_WEAK_PREFIX,
  FALLEN,
  normalize,
  parse as parseLegacy,
  SELF,
  targetOf,
  WEAKEST,
} from "../skills/gambit.ts";
import { isRecord } from "../values.ts";
import { StrategyError, type Strategy, type StrategyRule } from "./types.ts";

interface LegacyTerm {
  readonly expr: string;
  /** The old value was 0/1, so common count comparisons become a plain truth value. */
  readonly boolean: boolean;
}

function legacyTerm(name: string): LegacyTerm {
  switch (name) {
    case "self.hp":
    case "self.hp_pct":
    case "self.mp":
      return { expr: name, boolean: false };
    case "ally.hp_pct":
      return { expr: "ally.lowest(hp_pct).hp_pct", boolean: false };
    case "ally.dead":
      return { expr: "ally.count(not alive)", boolean: false };
    case "party.alive":
      return { expr: "ally.alive", boolean: false };
    case "enemy.count":
      return { expr: "enemy.alive", boolean: false };
    case "enemy.boss":
      return { expr: "battle.boss", boolean: true };
    case "enemy.hp_pct":
      return { expr: "enemy.lowest(hp_pct).hp_pct", boolean: false };
    case "turn":
      return { expr: "turn", boolean: false };
    default:
      break;
  }
  if (name.startsWith("enemy.name.")) {
    const wanted = name.slice("enemy.name.".length);
    return {
      expr: `enemy.count(name == ${JSON.stringify(wanted)})`,
      boolean: false,
    };
  }
  if (name.startsWith("enemy.id.")) {
    return {
      expr: `enemy(${name.slice("enemy.id.".length)}).alive`,
      boolean: true,
    };
  }
  if (name.startsWith("enemy.weak.")) {
    return {
      expr: `enemy.count(weak(${name.slice("enemy.weak.".length)}))`,
      boolean: false,
    };
  }
  if (name.startsWith("enemy.absorbs.")) {
    return {
      expr: `enemy.count(absorbs(${name.slice("enemy.absorbs.".length)}))`,
      boolean: false,
    };
  }
  if (name.startsWith("item.")) {
    return { expr: `item(${name.slice("item.".length)})`, boolean: false };
  }
  if (name.startsWith("ally.status.")) {
    return {
      expr: `ally.count(has(${name.slice("ally.status.".length)}))`,
      boolean: false,
    };
  }
  if (name.startsWith("self.status.")) {
    return {
      expr: `self.has(${name.slice("self.status.".length)})`,
      boolean: true,
    };
  }
  throw new StrategyError(`旧条件里没有「${name}」这个词`);
}

function simplifiesTo(term: LegacyTerm, op: string, number: number): boolean | null {
  if (!term.boolean) return null;
  if ((op === ">=" && number === 1) || (op === ">" && number === 0)) return true;
  if ((op === "==" && number === 1) || (op === "!=" && number === 0)) return true;
  if (
    (op === "==" && number === 0) ||
    (op === "<" && number === 1) ||
    (op === "<=" && number === 0) ||
    (op === "!=" && number === 1)
  ) {
    return false;
  }
  return null;
}

function convertCondition(condition: string): string {
  const clauses = parseLegacy(condition).map(([name, op, number]) => {
    const term = legacyTerm(name);
    if (op === null || number === null) return term.expr;
    const simplified = simplifiesTo(term, op, number);
    if (simplified === true) return term.expr;
    if (simplified === false) return `not (${term.expr})`;
    return `${term.expr} ${op} ${String(number)}`;
  });
  return clauses.join(" and ");
}

function convertTarget(rule: Record<string, unknown>): string | undefined {
  const target = targetOf(rule);
  if (target === undefined) {
    const raw = rule.target;
    if (raw === undefined || raw === null || raw === "") return undefined;
    const label = typeof raw === "string" ? raw : JSON.stringify(raw);
    throw new StrategyError(`旧目标「${label}」不认识`);
  }
  if (target === ENEMY) return undefined;
  if (target === SELF) return "self";
  if (target === WEAKEST) return "ally.lowest(hp_pct)";
  if (target === FALLEN) return "ally.first(not alive)";
  if (target === AILING) return `ally.first(has(${ailmentOf(rule)}))`;
  if (target === ENEMY_LOWEST) return "enemy.lowest(hp_pct)";
  if (target.startsWith(ENEMY_WEAK_PREFIX)) {
    return `enemy.first(weak(${target.slice(ENEMY_WEAK_PREFIX.length)}))`;
  }
  if (target.startsWith(ENEMY_NAMED_PREFIX)) {
    return `enemy(${target.slice(ENEMY_NAMED_PREFIX.length)})`;
  }
  throw new StrategyError(`旧目标「${target}」不认识`);
}

/**
 * Convert one old table (`{角色: [{if, do, target}]}`, or its `{battle: …}` wrapper) to a
 * strategy 2.0 object with flat rules. Throws StrategyError when the table is malformed.
 */
export function fromLegacy(v1Table: unknown): Strategy {
  const table = normalize(v1Table);
  const actors = Object.keys(table);
  if (actors.length === 0) throw new StrategyError("旧规则表是空的,要写成 {角色名: [规则, ...]}");
  const rules: StrategyRule[] = [];
  for (const actor of actors) {
    const source = table[actor] ?? [];
    if (source.length === 0) throw new StrategyError(`旧规则表里「${actor}」没有规则`);
    for (let index = 0; index < source.length; index++) {
      const raw = source[index];
      if (!isRecord(raw)) {
        throw new StrategyError(`旧规则表里「${actor}」第 ${index + 1} 条不是 JSON 对象`);
      }
      const doText = typeof raw.do === "string" && raw.do.trim() !== "" ? raw.do.trim() : "攻击";
      const condition =
        typeof raw.if === "string" && raw.if.trim() !== "" ? convertCondition(raw.if) : undefined;
      const target = convertTarget(raw);
      const note = typeof raw.note === "string" && raw.note !== "" ? raw.note : undefined;
      const rule: {
        who: string;
        do: string;
        if?: string;
        to?: string;
        note?: string;
      } = { who: actor, do: doText };
      if (condition !== undefined) rule.if = condition;
      if (target !== undefined) rule.to = target;
      if (note !== undefined) rule.note = note;
      rules.push(rule);
    }
  }
  return { version: 2, roles: {}, reactions: [], phases: [], rules };
}

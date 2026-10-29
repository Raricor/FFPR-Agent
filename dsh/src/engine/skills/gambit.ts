/**
 * Battle rule tables (control plan §4.6): each character has rules, checked top down, and the
 * first whose condition holds and that can be done right now is done (FF12's Gambits). Ported
 * from ffpr_agent/skills/gambit.py.
 *
 *     {"蕾娜": [{"if": "ally.hp_pct < 50", "do": "白魔法:治疗", "target": "hp最低的同伴"},
 *               {"do": "攻击"}],
 *      "法利斯": [{"if": "self.mp >= 4", "do": "黑魔法:闪雷"}, {"do": "攻击"}]}
 *
 * Conditions are clauses joined by "and", each `name op number` or a bare name (true when not
 * 0), over a fixed vocabulary (VOCABULARY). A rule that cannot be done (the actor has no such
 * command, the spell is not learned or MP is short, nobody to revive) is skipped like a false
 * condition, so the next rule takes over. This module decides; skills/battle.ts presses keys.
 */

import { isRecord, num, truthy } from "../values.ts";
import { byKey } from "../games.ts";
import {
  ELEMENTS,
  isElement,
  type Element,
  type ElementKnowledge,
  type EnemyResistances,
} from "../elements.ts";

export type Json = Record<string, unknown>;

export type Comparison = (left: number, right: number) => boolean;

export const OPS: ReadonlyMap<string, Comparison> = new Map([
  ["<=", (a, b) => a <= b],
  [">=", (a, b) => a >= b],
  ["==", (a, b) => a === b],
  ["!=", (a, b) => a !== b],
  ["<", (a, b) => a < b],
  [">", (a, b) => a > b],
]);

// The condition grammar: a vocabulary word, an optional comparison, an optional number. No
// eval: only these names, operators and and-separated clauses are read.
export const CLAUSE = /^\s*([a-z_.一-鿿]+)\s*(?:(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?))?\s*$/u;

/** Vocabulary in the order its help text lists it (Map keeps insertion order). */
export const VOCABULARY: ReadonlyMap<string, string> = new Map([
  ["self.hp", "自己的 HP"],
  ["self.hp_pct", "自己的 HP 百分比"],
  ["self.mp", "自己的 MP"],
  ["ally.hp_pct", "活着的同伴(含自己)里最低的 HP 百分比"],
  ["ally.dead", "倒下的同伴人数"],
  ["party.alive", "活着的人数"],
  ["enemy.count", "活着的敌人数"],
  ["enemy.boss", "是否首领战(1/0)"],
  ["enemy.hp_pct", "活着的敌人里最低的 HP 百分比"],
  ["enemy.name.<怪名>", "有几只活着的敌人叫这个名字,如 enemy.name.喧嚣鬼"],
  ["enemy.weak.<属性>", "有几只活着的敌人弱这个属性,如 enemy.weak.冰"],
  ["enemy.absorbs.<属性>", "有几只活着的敌人吸收这个属性,如 enemy.absorbs.冰"],
  ["turn", "这个角色第几次行动(从 1 数)"],
  ["item.<道具名>", "背包里这种道具的数量,如 item.不死鸟之尾"],
  ["ally.status.<状态>", "有这个状态的同伴人数,如 ally.status.麻痹(桥插件 0.6.3+)"],
  ["self.status.<状态>", "自己有这个状态时为 1"],
]);

/** Names that carry a game word after their prefix. */
export const OPEN_ENDED: readonly string[] = [
  "item.",
  "ally.status.",
  "self.status.",
  "enemy.name.",
  "enemy.weak.",
  "enemy.absorbs.",
];
const ELEMENT_PREFIXES: readonly string[] = ["enemy.weak.", "enemy.absorbs."];

export const ENEMY = "敌人";
export const ENEMY_LOWEST = "敌人:hp最低";
export const ENEMY_NAMED_PREFIX = "敌人:";
export const ENEMY_WEAK_PREFIX = "敌人:弱";
export const SELF = "自己";
export const WEAKEST = "hp最低的同伴";
export const FALLEN = "倒下的同伴";
export const AILING = "状态";

/** Actions the bridge can carry out in the five games without a readable magic list (task 21). */
export const SIMPLE_ACTIONS: readonly string[] = ["攻击", "防御", "道具"];

// Written with or without spaces ("hp 最低的同伴"); no target means the game's default.
export const TARGETS: ReadonlyMap<string, string> = new Map([
  ["敌人", ENEMY],
  ["", ENEMY],
  ["自己", SELF],
  ["hp最低的同伴", WEAKEST],
  ["倒下的同伴", FALLEN],
]);

/** Python's str() for the values rules carry, so None does not become "undefined". */
function pyString(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** ENEMY, SELF, WEAKEST, FALLEN, or AILING for 「状态:毒」 (an ally with that status). */
export function targetOf(rule: unknown): string | undefined {
  const raw = isRecord(rule) && truthy(rule.target) ? rule.target : "";
  const text = pyString(raw).replace(/ /g, "");
  if (text.startsWith("状态:") && text.length > 3) return AILING;
  if (text === ENEMY_LOWEST) return ENEMY_LOWEST;
  if (text.startsWith(ENEMY_WEAK_PREFIX)) {
    const element = text.slice(ENEMY_WEAK_PREFIX.length);
    return isElement(element) ? text : undefined;
  }
  if (text.startsWith(ENEMY_NAMED_PREFIX) && text.length > ENEMY_NAMED_PREFIX.length) {
    return text;
  }
  return TARGETS.get(text);
}

export function ailmentOf(rule: unknown): string {
  const raw = isRecord(rule) && truthy(rule.target) ? rule.target : "";
  const text = pyString(raw)
    .replace(/ /g, "")
    .replace(/^状态:/u, "");
  return text;
}

// The bridge sends a condition's type when its name reads empty (0.6.6): the game's own words
// for them, as the rules and the player write them.
export const STATUS_ZH: ReadonlyMap<string, string> = new Map([
  ["Poison", "毒"],
  ["Silence", "沉默"],
  ["Sleep", "睡眠"],
  ["Paralysis", "麻痹"],
  ["Blind", "黑暗"],
  ["Mineralization", "石化"],
  ["SlowlyMineralization", "渐渐石化"],
  ["Confusion", "混乱"],
  ["Slow", "减速"],
  ["Stop", "停止"],
  ["Zombie", "僵尸"],
  ["Frog", "青蛙"],
  ["Child", "迷你"],
  ["Pig", "猪"],
  ["Aging", "老化"],
  ["Bersak", "狂暴"],
  ["Curse", "诅咒"],
  ["UnableFight", "战斗不能"],
  ["Dying", "濒死"],
  ["Heist", "加速"],
  ["Regeneration", "再生"],
  ["Proteus", "防护"],
  ["Shell", "魔法防护"],
  ["Reflex", "反射"],
  ["Blink", "分身"],
  ["Transparent", "隐身"],
  ["Leviteto", "浮空"],
]);

/** A unit's status conditions in Chinese; empty names (older bridges) are dropped. */
export function statuses(unit: unknown): string[] {
  const values = isRecord(unit) && Array.isArray(unit.status) ? unit.status : [];
  const out: string[] = [];
  for (const status of values) {
    if (typeof status !== "string" || !status) continue;
    const translated = STATUS_ZH.get(status);
    out.push(translated ?? status);
  }
  return out;
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

function hpOf(unit: Json): number {
  return num(unit.hp) ?? 0;
}

function alivePlayers(players: readonly Json[]): Json[] {
  return players.filter((player) => hpOf(player) > 0);
}

function aliveEnemies(enemies: readonly Json[]): Json[] {
  return enemies.filter((enemy) => hpOf(enemy) > 0);
}

function pct(unit: Json): number {
  const top = num(unit.maxHp) ?? 0;
  return top ? (100.0 * hpOf(unit)) / top : 100.0;
}

/** What the conditions read at one actor's turn. */
export class Situation {
  readonly actor: string;
  readonly players: readonly Json[];
  readonly enemies: readonly Json[];
  readonly turn: number;
  readonly boss: boolean;
  readonly elements: ElementKnowledge | null;
  items: Record<string, number>;

  constructor(
    actor: string,
    players: readonly Json[],
    enemies: readonly Json[],
    turn = 1,
    boss = false,
    items: Record<string, number> = {},
    elements: ElementKnowledge | null = null,
  ) {
    this.actor = actor;
    this.players = players;
    this.enemies = enemies;
    this.turn = turn;
    this.boss = boss;
    this.items = items;
    this.elements = elements;
  }

  me(): Json {
    return this.players.find((player) => player.name === this.actor) ?? {};
  }

  value(name: string): number {
    const me = this.me();
    const alive = alivePlayers(this.players);
    const foes = aliveEnemies(this.enemies);
    switch (name) {
      case "self.hp":
        return hpOf(me);
      case "self.hp_pct":
        return pct(me);
      case "self.mp":
        return num(me.mp) ?? 0;
      case "ally.hp_pct":
        return alive.length > 0 ? Math.min(...alive.map(pct)) : 100;
      case "ally.dead":
        return this.players.length - alive.length;
      case "party.alive":
        return alive.length;
      case "enemy.count":
        return foes.length;
      case "enemy.boss":
        return this.boss ? 1 : 0;
      case "enemy.hp_pct":
        return foes.length > 0 ? Math.min(...foes.map(pct)) : 0;
      case "turn":
        return this.turn;
      default:
        break;
    }
    if (name.startsWith("enemy.name.")) {
      const wanted = name.slice("enemy.name.".length);
      return foes.filter((enemy) => pyString(enemy.name) === wanted).length;
    }
    const elementPrefix = ELEMENT_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (elementPrefix !== undefined) {
      const wanted = name.slice(elementPrefix.length);
      if (!isElement(wanted)) {
        throw new RuleError(`属性「${wanted}」不认识;能用:${ELEMENTS.join("、")}`);
      }
      return foes.filter((enemy) => {
        const info = this.elements?.lookup(enemy) ?? null;
        if (info === null) return false;
        const list = elementPrefix === "enemy.weak." ? info.weak : info.absorb;
        return list.includes(wanted);
      }).length;
    }
    if (name.startsWith("item.")) {
      const wanted = name.slice("item.".length);
      let total = 0;
      for (const [item, count] of Object.entries(this.items)) {
        if (wanted && item.includes(wanted)) total += count;
      }
      return total;
    }
    if (name.startsWith("ally.status.") || name.startsWith("self.status.")) {
      const first = name.indexOf(".");
      const second = name.indexOf(".", first + 1);
      const wanted = second >= 0 ? name.slice(second + 1) : "";
      const units = name.startsWith("self.") ? [me] : this.players;
      return units.filter((unit) => statuses(unit).some((status) => status.includes(wanted)))
        .length;
    }
    throw new RuleError(`条件里没有「${name}」这个词;能用的:${[...VOCABULARY.keys()].join("、")}`);
  }
}

export type Clause = readonly [name: string, op: string | null, number: number | null];

/**
 * Read a condition into clauses. The grammar is deliberately tiny (words, comparisons and
 * "and"/「且」); anything else is reported instead of being evaluated, so no eval is needed.
 */
export function parse(condition: string): Clause[] {
  const clauses: Clause[] = [];
  for (const part of condition.trim().split(/\s+and\s+|\s*且\s*/u)) {
    const match = CLAUSE.exec(part);
    if (!match) {
      throw new RuleError(`看不懂条件「${part}」:写成 名字 比较符 数字,如 ally.hp_pct < 50`);
    }
    const name = match[1] ?? "";
    const op = match[2] ?? null;
    const number = match[3];
    const openEnded = OPEN_ENDED.some(
      (prefix) => name.startsWith(prefix) && name.length > prefix.length,
    );
    if (!VOCABULARY.has(name) && !openEnded) {
      throw new RuleError(
        `条件里没有「${name}」这个词;能用的:${[...VOCABULARY.keys()].join("、")}`,
      );
    }
    const elementPrefix = ELEMENT_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (elementPrefix !== undefined && !isElement(name.slice(elementPrefix.length))) {
      throw new RuleError(
        `属性「${name.slice(elementPrefix.length)}」不认识;能用:${ELEMENTS.join("、")}`,
      );
    }
    clauses.push([name, op, number === undefined ? null : Number(number)]);
  }
  return clauses;
}

export function holds(condition: string | null | undefined, situation: Situation): boolean {
  if (!condition) return true;
  for (const [name, op, number] of parse(condition)) {
    const value = situation.value(name);
    if (op === null && !value) return false;
    if (op !== null && number !== null) {
      const compare = OPS.get(op);
      if (!compare) throw new RuleError(`不认识的比较符「${op}」`);
      if (!compare(value, number)) return false;
    }
  }
  return true;
}

export interface Action {
  readonly command: string; // 攻击, 白魔法, 防御 ...
  readonly ability: string; // 治疗, or "" for a plain command
  readonly target: string; // ENEMY, SELF, WEAKEST, FALLEN
  readonly whom: string | null; // the ally's name for SELF, WEAKEST and FALLEN
  /** The chosen enemy's index among living enemies, or null for the game's default cursor. */
  readonly enemy: number | null;
  readonly rule: number; // which rule (1-based) chose it; 0 for the fallback attack
}

/** The rule's action with its target resolved, or null when it has no one to act on. */
export function actionOf(rule: Json, index: number, situation: Situation): Action | null {
  const actionText = pyString(truthy(rule.do) ? rule.do : "攻击");
  const separator = actionText.indexOf(":");
  const command = separator < 0 ? actionText : actionText.slice(0, separator);
  const ability = separator < 0 ? "" : actionText.slice(separator + 1);
  const requested = targetOf(rule) ?? ENEMY;
  let target = requested;
  let enemy: number | null = null;
  if (
    requested === ENEMY_LOWEST ||
    requested.startsWith(ENEMY_WEAK_PREFIX) ||
    (requested.startsWith(ENEMY_NAMED_PREFIX) &&
      requested !== ENEMY_LOWEST &&
      !requested.startsWith(ENEMY_WEAK_PREFIX))
  ) {
    const foes = aliveEnemies(situation.enemies);
    if (requested === ENEMY_LOWEST) {
      let best = -1;
      for (let index = 0; index < foes.length; index++) {
        const foe = foes[index];
        if (foe === undefined) continue;
        if (best < 0) {
          best = index;
          continue;
        }
        const current = foes[best];
        if (current === undefined) continue;
        const lower =
          pct(foe) < pct(current) || (pct(foe) === pct(current) && hpOf(foe) < hpOf(current));
        if (lower) best = index;
      }
      enemy = best < 0 ? null : best;
    } else if (requested.startsWith(ENEMY_WEAK_PREFIX)) {
      const element = requested.slice(ENEMY_WEAK_PREFIX.length);
      if (!isElement(element)) return null;
      enemy = foes.findIndex((foe) => {
        const info = situation.elements?.lookup(foe) ?? null;
        return info?.weak.includes(element) === true;
      });
      if (enemy < 0) enemy = null;
    } else {
      const wanted = requested.slice(ENEMY_NAMED_PREFIX.length);
      enemy = foes.findIndex((foe) => pyString(foe.name) === wanted);
      if (enemy < 0) enemy = null;
    }
    if (enemy === null) return null;
    target = ENEMY;
  }
  const alive = alivePlayers(situation.players);
  let whom: string | null = null;
  if (target === SELF) {
    whom = situation.actor;
  } else if (target === WEAKEST) {
    const weakest = alive[0];
    if (!weakest) return null;
    let best = weakest;
    for (const player of alive.slice(1)) {
      if (pct(player) < pct(best)) best = player;
    }
    whom = pyString(best.name);
  } else if (target === FALLEN) {
    const fallen = situation.players.filter((player) => hpOf(player) <= 0);
    const first = fallen[0];
    if (!first) return null;
    whom = pyString(first.name);
  } else if (target === AILING) {
    const wanted = ailmentOf(rule);
    const ailing = alive.find((player) =>
      statuses(player).some((status) => status.includes(wanted)),
    );
    if (!ailing) return null;
    whom = pyString(ailing.name);
  }
  return { command: command.trim(), ability: ability.trim(), target, whom, enemy, rule: index };
}

/**
 * The first rule that holds and has someone to act on; rules in `skip` were tried and could
 * not be done. Falls back to attacking.
 */
export function choose(
  rules: readonly Json[],
  situation: Situation,
  skip: ReadonlySet<number> = new Set(),
): Action {
  for (let index = 1; index <= rules.length; index++) {
    const rule = rules[index - 1];
    if (!rule || skip.has(index)) continue;
    if (!holds(typeof rule.if === "string" ? rule.if : undefined, situation)) continue;
    const action = actionOf(rule, index, situation);
    if (action) return action;
  }
  return { command: "攻击", ability: "", target: ENEMY, whom: null, enemy: null, rule: 0 };
}

/**
 * What is wrong with a table, as the completeness check reports it (§4.6); [] when fine. It
 * checks what code can know before a battle: shape, vocabulary, targets, a last rule without a
 * condition for everyone. In the five games whose battle magic list the bridge cannot read
 * (task 21), only 攻击, 防御 and 道具 are accepted as actions.
 */
export function check(table: unknown, game = "ff5"): string[] {
  const problems: string[] = [];
  const simpleActions = byKey(game).key !== "ff5";
  let rulesByActor: Json | null = null;
  if (isRecord(table)) {
    const inner = "battle" in table ? table.battle : table;
    rulesByActor = isRecord(inner) ? inner : null;
  }
  if (!rulesByActor || Object.keys(rulesByActor).length === 0) {
    return ["规则表要写成 {角色名: [规则, ...]}"];
  }
  for (const [actor, rules] of Object.entries(rulesByActor)) {
    if (!Array.isArray(rules) || rules.length === 0) {
      problems.push(`${actor}:规则要写成列表`);
      continue;
    }
    const items: readonly unknown[] = rules;
    for (let index = 1; index <= items.length; index++) {
      const rule = items[index - 1];
      if (!isRecord(rule) || !truthy(rule.do)) {
        problems.push(`${actor} 第 ${index} 条:缺少 do`);
        continue;
      }
      if (simpleActions) {
        const action = pyString(rule.do);
        const separator = action.indexOf(":");
        const command = (separator < 0 ? action : action.slice(0, separator)).trim();
        if (!SIMPLE_ACTIONS.includes(command)) {
          problems.push(
            `${actor} 第 ${index} 条:「${action}」不能用;` +
              "这一作只能用攻击、防御、道具:道具名(桥插件读不到战斗中的魔法列表)",
          );
        }
      }
      if (truthy(rule.if)) {
        try {
          parse(pyString(rule.if));
        } catch (error) {
          if (!(error instanceof RuleError)) throw error;
          problems.push(`${actor} 第 ${index} 条:${error.message}`);
        }
      }
      if (targetOf(rule) === undefined) {
        problems.push(
          `${actor} 第 ${index} 条:目标「${pyString(rule.target)}」不认识;` +
            "能用:敌人、自己、hp最低的同伴、倒下的同伴、状态:毒(有这个状态的同伴)",
        );
      }
    }
    const last = items[items.length - 1];
    if (isRecord(last) && truthy(last.if)) {
      problems.push(`${actor}:最后一条要不带条件(兜底),比如 {"do": "攻击"}`);
    }
  }
  return problems;
}

/** Old plans ({角色: "指令"}) become one-rule tables; tables pass through. */
export function normalize(plan: unknown): Record<string, unknown[]> {
  const outer = isRecord(plan) ? plan : {};
  const inner = "battle" in outer ? outer.battle : outer;
  const source = isRecord(inner) ? inner : {};
  const out: Record<string, unknown[]> = {};
  for (const [actor, rules] of Object.entries(source)) {
    out[actor] = Array.isArray(rules) ? rules : [{ do: pyString(rules) }];
  }
  return out;
}

// Jobs by the name the bridge reads (0.6.0+); a party without them gets attack-only rules.
// Spell families, weakest first, as the Pixel Remaster names them in Chinese (shops, 10-21).
// A rule may ask for 「治疗+」: the strongest of the family the caster knows and has MP for;
// 「最强」 asks for the strongest attack spell of all (control plan §4.6).
export const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  治疗: ["治疗", "救疗"],
  火炎: ["火炎", "烈炎"],
  冰结: ["冰结", "冰冻"],
  闪雷: ["闪雷", "震雷"],
};
export const ATTACKS: readonly string[] = ["火炎", "冰结", "闪雷"];
export const BEST = "最强";

/** The element each attack family casts (task 07: 火炎=火, 冰结=冰, 闪雷=雷). */
export const FAMILY_ELEMENTS: Readonly<Record<string, Element>> = {
  火炎: "火",
  冰结: "冰",
  闪雷: "雷",
};

/** The element a spell name casts, or null for anything without one (治疗, 解毒, ...). */
export function elementOf(spell: string): Element | null {
  for (const [family, element] of Object.entries(FAMILY_ELEMENTS)) {
    if ((FAMILIES[family] ?? []).includes(spell)) return element;
  }
  return null;
}

// Ailments: what cures each, white magic first, then items (names matched by containment,
// so 「眼药」 finds 眼药水). Blindness had no answer at all (10-21: Lenna and Faris blind).
export const CURES: Readonly<Record<string, readonly [string | null, string]>> = {
  毒: ["解毒", "解毒药"],
  黑暗: [null, "眼药"],
  石化: [null, "金针"],
  青蛙: [null, "少女之吻"],
  迷你: [null, "木槌"],
  沉默: [null, "回音草"],
};

/** Rules any member can follow: an item on an ally with the ailment it cures. */
export function cureRules(): Json[] {
  return Object.entries(CURES).flatMap(([ailment, [, item]]) => {
    if (!item) return [];
    return [
      {
        if: `ally.status.${ailment} >= 1 and item.${item} > 0`,
        do: `道具:${item}`,
        target: `状态:${ailment}`,
      },
    ];
  });
}

export const REVIVE_ITEM: Json = {
  if: "ally.dead >= 1 and item.不死鸟之尾 > 0",
  do: "道具:不死鸟之尾",
  target: "倒下的同伴",
};

export const DEFAULT_RULES: Readonly<Record<string, readonly Json[]>> = {
  白魔法师: [
    { if: "ally.dead >= 1", do: "白魔法:复活", target: "倒下的同伴" },
    REVIVE_ITEM,
    { if: "ally.hp_pct < 35", do: "白魔法:治疗+", target: "hp最低的同伴" },
    { if: "ally.hp_pct < 60", do: "白魔法:治疗", target: "hp最低的同伴" },
    { if: "ally.status.毒 >= 1", do: "白魔法:解毒", target: "状态:毒" },
    ...cureRules(),
    { do: "攻击" },
  ],
  黑魔法师: [
    REVIVE_ITEM,
    ...cureRules(),
    { if: "self.mp >= 4", do: `黑魔法:${BEST}` },
    { do: "攻击" },
  ],
};

export const OTHERS: readonly Json[] = [REVIVE_ITEM, ...cureRules(), { do: "攻击" }];

/**
 * The spells a rule's ability may be, best first: 「治疗+」 the family strongest first,
 * 「最强」 every attack family's tiers strongest first, else just the name. With a target,
 * elements it absorbs or is immune to are dropped and its weaknesses come first (task 07).
 */
export function abilityCandidates(
  wanted: string,
  target: EnemyResistances | null = null,
): string[] {
  const out = candidates(wanted);
  if (target === null) return out;
  const usable = out.filter((spell) => {
    const element = elementOf(spell);
    if (element === null) return true;
    return !target.absorb.includes(element) && !target.immune.includes(element);
  });
  const weak = usable.filter((spell) => {
    const element = elementOf(spell);
    return element !== null && target.weak.includes(element);
  });
  const rest = usable.filter((spell) => !weak.includes(spell));
  return [...weak, ...rest];
}

function candidates(wanted: string): string[] {
  if (wanted === BEST) {
    const tiers = Math.max(...ATTACKS.map((family) => FAMILIES[family]?.length ?? 0));
    const out: string[] = [];
    for (let tier = tiers - 1; tier >= 0; tier--) {
      for (const family of ATTACKS) {
        const spells = FAMILIES[family] ?? [];
        if (tier < spells.length) {
          const spell = spells[tier];
          if (spell !== undefined) out.push(spell);
        }
      }
    }
    return out;
  }
  if (wanted.endsWith("+")) {
    const base = wanted.slice(0, -1);
    const family = Object.values(FAMILIES).find((tiers) => tiers.includes(base)) ?? [base];
    return [...family].reverse();
  }
  return [wanted];
}

/** The rules used when nobody wrote any (regular battles): healers heal, others attack. */
export function defaultTable(party: readonly unknown[]): Record<string, readonly Json[]> {
  const table: Record<string, readonly Json[]> = {};
  for (const member of party) {
    if (!isRecord(member) || !truthy(member.name)) continue;
    const name = pyString(member.name);
    const job = typeof member.jobName === "string" ? member.jobName : "";
    table[name] = DEFAULT_RULES[job] ?? OTHERS;
  }
  return table;
}

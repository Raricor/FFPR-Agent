/**
 * Running strategy 2.0 in battle (battle strategy plan §6, task 41): which rule to try now,
 * in what order, which rules to leave out, and what to fall back to. Pure decisions only;
 * skills/battle.ts presses the keys and reports what could not be done.
 *
 *     const runtime = new StrategyRuntime();
 *     const { steps, skipped } = runtime.choices(strategy, snapshot);
 *     // try steps in order; on success runtime.done(step, snapshot, now)
 *
 * Rules are tried reactions first, then the first phase whose `when` holds, then the flat
 * rules; a rule whose condition holds but whose target is missing is skipped, never aimed at
 * the actor (task 41: a revive item was used on the living actor). `once`, `any` and effects
 * already queued in the ATB (heal, revive, cure on the same target) are left out with a why.
 */

import { isRecord } from "../values.ts";
import * as gambit from "../skills/gambit.ts";
import { describe, describeReaction, describeRule } from "./describe.ts";
import { evaluate, resolveTarget, type Target } from "./expr.ts";
import { fromLegacy } from "./legacy.ts";
import { parseAction, parseStrategy, type ParsedAction } from "./strategy.ts";
import type { BattleEvent as RecordedEvent } from "../battle-record.ts";
import { StrategyError as StrategyFailure } from "./types.ts";
import type {
  BattleEvent,
  BattleSnapshot,
  SnapshotUnit,
  Strategy,
  StrategyPhase,
  StrategyReaction,
  StrategyRule,
} from "./types.ts";

/** What an action does to its target; only these three are queued one at a time per target. */
export type EffectKind = "heal" | "revive" | "cure";

export interface StrategyStep {
  readonly action: ParsedAction;
  readonly target: Target;
  readonly rule: StrategyRule | null;
  /** 1-based rule number inside its block; 0 for the fallback. */
  readonly ruleIndex: number;
  /** Stable key for `once` / `any` bookkeeping. */
  readonly key: string;
  /** 对策 1 / 阶段「合翅膀」第 2 条 / 规则 3 / 兜底. */
  readonly basis: string;
  /** The rule in Chinese (describeRule / describeReaction). */
  readonly text: string;
  /** The condition in Chinese, or "". */
  readonly condition: string;
  readonly source: "reaction" | "phase" | "rules" | "fallback";
  readonly once: boolean;
  /** What the action does, when it is one of the queued effects. */
  readonly effect: EffectKind | null;
}

export interface StrategySkip {
  readonly rule: number;
  readonly key: string;
  readonly basis: string;
  readonly text: string;
  readonly why: string;
}

export interface StrategyChoice {
  readonly steps: readonly StrategyStep[];
  readonly skipped: readonly StrategySkip[];
}

/** A rule skipped twice because its item is gone (task 41), or a condition that could not run. */
export interface StrategyGap {
  readonly item: string;
  /** How many the bag held when the gap was recorded (normally 0). */
  readonly held: number;
  readonly basis: string;
  readonly skips: number;
  /** The StrategyFailure message when this entry records a broken condition (task 53). */
  readonly error?: string;
}

interface PendingOrder {
  readonly kind: EffectKind;
  readonly target: string;
  readonly at: number;
  readonly hp: number;
  readonly status: readonly string[];
  /** The ailment a cure was meant for, when known. */
  readonly ailment: string;
}

const PENDING_TIMEOUT_MS = 30_000;

const HEAL_ABILITIES: ReadonlySet<string> = new Set(["治疗", "救疗", "回复"]);
const GENERIC_ACTIONS: ReadonlySet<string> = new Set(["攻击", "防御", "换列", "道具"]);

/** The item names that revive; containment, because the bag may tag icons onto names. */
const REVIVE_ITEMS = /不死鸟|凤凰/u;

function holds(expression: string | undefined, snapshot: BattleSnapshot): boolean {
  if (expression === undefined || expression.trim() === "") return true;
  const value = evaluate(expression, snapshot);
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";
  if (typeof value === "boolean") return value;
  switch (value.kind) {
    case "unit":
      return value.unit !== null;
    case "set":
    case "all":
    case "battle":
      return true;
  }
}

function unitsOf(snapshot: BattleSnapshot, side: "ally" | "enemy"): readonly SnapshotUnit[] {
  return side === "ally" ? snapshot.allies : snapshot.enemies;
}

function living(snapshot: BattleSnapshot): SnapshotUnit[] {
  return unitsOf(snapshot, "ally").filter((unit) => unit.hp > 0);
}

function hasStatus(unit: SnapshotUnit, wanted: string): boolean {
  return [...(unit.status ?? []), ...(unit.buffs ?? [])].some(
    (status) => status === wanted || status.includes(wanted),
  );
}

function actorMatches(who: string, strategy: Strategy, snapshot: BattleSnapshot): boolean {
  const actor = snapshot.actor ?? "";
  if (who === "all" || who === "any") return true;
  if (who === actor) return true;
  return strategy.roles[actor] === who;
}

/** The revive/cure/heal an action performs, from its ability's game name. */
export function effectOf(action: ParsedAction): EffectKind | null {
  const ability = action.ability;
  if (ability === "") return null;
  if (action.command === "道具") {
    if (REVIVE_ITEMS.test(ability)) return "revive";
    for (const [, item] of Object.entries(gambit.CURES).map(([, cure]) => cure)) {
      if (item !== "" && (ability.includes(item) || item.includes(ability))) return "cure";
    }
    if (HEAL_ABILITIES.has(ability.replace(/\+$/u, ""))) return "heal";
    if (/^(高级)?恢复药$|^药$/u.test(ability)) return "heal";
    return null;
  }
  if (ability.includes("复活")) return "revive";
  if (HEAL_ABILITIES.has(ability.replace(/\+$/u, ""))) return "heal";
  if (cureAilmentOf(ability) !== null) return "cure";
  return null;
}

export function cureAilmentOf(name: string): string | null {
  for (const [ailment, [spell, item]] of Object.entries(gambit.CURES)) {
    if (spell === name) return ailment;
    if (item !== "" && (name.includes(item) || item.includes(name))) return ailment;
  }
  return null;
}

function actionOf(doText: string): ParsedAction | null {
  return parseAction(doText);
}

function firstFallen(snapshot: BattleSnapshot): SnapshotUnit | null {
  return unitsOf(snapshot, "ally").find((unit) => unit.hp <= 0) ?? null;
}

function firstAiling(snapshot: BattleSnapshot, ailment: string): SnapshotUnit | null {
  const wanted = ailment === "" ? null : ailment;
  return (
    living(snapshot).find((unit) => (wanted === null ? true : hasStatus(unit, wanted))) ?? null
  );
}

function lowestAlly(snapshot: BattleSnapshot): SnapshotUnit | null {
  let best: SnapshotUnit | null = null;
  let bestPct = Number.POSITIVE_INFINITY;
  for (const unit of living(snapshot)) {
    const top = unit.maxHp ?? 0;
    const value = top > 0 ? (100 * unit.hp) / top : 100;
    if (best === null || value < bestPct) {
      best = unit;
      bestPct = value;
    }
  }
  return best;
}

function unitTarget(side: "ally" | "enemy", unit: SnapshotUnit): Target {
  return { kind: "unit", side, unit };
}

/**
 * The target a step aims at. A revive never lands on a living unit (nor on the actor): the
 * rule's `to` is honoured only when it names a fallen ally, else the first fallen ally is
 * used, and with none the rule cannot be done at all. Heal and cure without `to` pick the
 * lowest-HP ally or the first one with the ailment.
 */
function resolveStepTarget(
  to: string | undefined,
  action: ParsedAction,
  effect: EffectKind | null,
  snapshot: BattleSnapshot,
): Target {
  const wanted = resolveTarget(to, snapshot);
  if (effect === "revive") {
    if (wanted?.kind === "unit" && wanted.side === "ally" && wanted.unit.hp <= 0) return wanted;
    const fallen = firstFallen(snapshot);
    return fallen === null ? null : unitTarget("ally", fallen);
  }
  if (effect === "cure") {
    const ailment = cureAilmentOf(action.ability) ?? "";
    if (wanted?.kind === "unit" && wanted.side === "ally" && wanted.unit.hp > 0) {
      if (ailment === "" || hasStatus(wanted.unit, ailment)) return wanted;
    }
    const ailing = firstAiling(snapshot, ailment);
    return ailing === null ? null : unitTarget("ally", ailing);
  }
  if (effect === "heal" && wanted === null) {
    const weakest = lowestAlly(snapshot);
    return weakest === null ? null : unitTarget("ally", weakest);
  }
  if (wanted !== null && wanted.kind === "all" && wanted.side === "ally") return null;
  return wanted;
}

/** The name a target step points at, for pending orders and records; "" for enemies/default. */
export function targetNameOf(step: StrategyStep): string {
  return step.target?.kind === "unit" && step.target.side === "ally" ? step.target.unit.name : "";
}

export class StrategyRuntime {
  private readonly doneRules = new Set<string>();
  /** `any` rule key → the round it was done in; other actors skip it that round (task 41). */
  private readonly anyRound = new Map<string, number>();
  private readonly pending: PendingOrder[] = [];
  private readonly gapCounts = new Map<string, { gap: StrategyGap; seen: boolean }>();
  /** Broken conditions, keyed by where they are; each is recorded once per battle (task 53). */
  private readonly problems = new Map<string, StrategyGap>();
  private actions = 0;

  /** Forget queued effects whose result is now visible, or that waited too long. */
  observe(snapshot: BattleSnapshot, now: number): void {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const order = this.pending[index];
      if (order === undefined) continue;
      if (now - order.at > PENDING_TIMEOUT_MS) {
        this.pending.splice(index, 1);
        continue;
      }
      const unit = unitsOf(snapshot, "ally").find((ally) => ally.name === order.target);
      if (unit === undefined) continue;
      const landed =
        order.kind === "revive"
          ? unit.hp > 0
          : order.kind === "heal"
            ? unit.hp > order.hp
            : order.ailment === ""
              ? order.status.some((status) => !hasStatus(unit, status))
              : !hasStatus(unit, order.ailment);
      if (landed) this.pending.splice(index, 1);
    }
  }

  /** Record a rule that was skipped because its item is gone; two make a gap. */
  noteSkip(step: StrategyStep, why: string, snapshot: BattleSnapshot): void {
    if (step.action.command !== "道具" || step.action.ability === "") return;
    if (!why.includes("没有「")) return;
    const item = step.action.ability;
    const key = `${step.key}\u0000${item}`;
    let entry = this.gapCounts.get(key);
    if (entry === undefined) {
      entry = {
        gap: { item, held: itemCount(snapshot, item), basis: step.basis, skips: 0 },
        seen: false,
      };
      this.gapCounts.set(key, entry);
    }
    entry.gap = {
      item,
      held: itemCount(snapshot, item),
      basis: step.basis,
      skips: entry.gap.skips + 1,
    };
    if (entry.gap.skips >= 2) entry.seen = true;
  }

  /** The rules whose item ran out at least twice, plus conditions that failed to evaluate. */
  gaps(): StrategyGap[] {
    const itemGaps = [...this.gapCounts.values()]
      .filter((entry) => entry.seen)
      .map((entry) => entry.gap);
    return [...itemGaps, ...this.problems.values()];
  }

  /** Remember a StrategyFailure by where it happened; later repeats add nothing (task 53). */
  noteProblem(basis: string, message: string): void {
    if (this.problems.has(basis)) return;
    this.problems.set(basis, {
      item: `${basis}出错:${message}`,
      held: 0,
      basis,
      skips: 1,
      error: message,
    });
  }

  /** A table that failed the static check is not used; say why once (task 53). */
  noteTableProblem(errors: readonly string[]): void {
    const message = errors.join(";");
    if (message !== "") this.noteProblem("策略表", message);
  }

  /** Evaluate a condition, treating a StrategyFailure as false and recording it once. */
  private holdsOrFalse(
    expression: string | undefined,
    snapshot: BattleSnapshot,
    basis: string,
  ): boolean {
    try {
      return holds(expression, snapshot);
    } catch (error) {
      if (!(error instanceof StrategyFailure)) throw error;
      this.noteProblem(basis, error.message);
      return false;
    }
  }

  /** The round the party is in, from the actions done and the party size; not the ATB tick. */
  private round(snapshot: BattleSnapshot): number {
    return Math.floor(this.actions / Math.max(1, snapshot.allies.length));
  }

  /** Remember a successful action: `once`, `any` and the queued effect. */
  done(step: StrategyStep, snapshot: BattleSnapshot, now: number): void {
    if (step.once) this.doneRules.add(step.key);
    if (step.rule?.who === "any") this.anyRound.set(step.key, this.round(snapshot));
    this.actions += 1;
    if (step.effect !== null) {
      const target = step.target;
      if (target?.kind !== "unit" || target.side !== "ally") return;
      this.pending.push({
        kind: step.effect,
        target: target.unit.name,
        at: now,
        hp: target.unit.hp,
        status: [...(target.unit.status ?? []), ...(target.unit.buffs ?? [])],
        ailment:
          step.effect === "cure"
            ? (cureAilmentOf(step.action.ability) ?? "")
            : step.effect === "revive"
              ? "战斗不能"
              : "",
      });
    }
  }

  private blockedReason(step: StrategyStep, snapshot: BattleSnapshot): string | null {
    if (step.once && this.doneRules.has(step.key)) return "这一战已经做过";
    if (step.rule?.who === "any") {
      const round = this.anyRound.get(step.key);
      if (round !== undefined && round === this.round(snapshot)) {
        return "别人这一轮已经做了同一条";
      }
    }
    if (step.effect === null) return null;
    const target = targetNameOf(step);
    if (target === "") return null;
    if (this.pending.some((order) => order.kind === step.effect && order.target === target)) {
      return "同一个目标已经有人下了指令";
    }
    return null;
  }

  /** Reactions first, then the first open phase's rules, then the fallback (task 41). */
  choices(strategy: Strategy, snapshot: BattleSnapshot): StrategyChoice {
    const steps: StrategyStep[] = [];
    const skipped: StrategySkip[] = [];
    const add = (
      rule: StrategyRule,
      index: number,
      source: StrategyStep["source"],
      basis: string,
      text: string,
      condition: string,
      expression: string | undefined,
    ): void => {
      try {
        if (!actorMatches(rule.who, strategy, snapshot)) return;
        const key = `${source}:${index}`;
        const action = actionOf(rule.do);
        const effect = action === null ? null : effectOf(action);
        const target =
          action === null ? null : resolveStepTarget(rule.to, action, effect, snapshot);
        const skip = (why: string): void => {
          skipped.push({ rule: index, key, basis, text, why });
        };
        if (!this.holdsOrFalse(expression, snapshot, basis)) return;
        if (this.doneRules.has(key)) {
          skip("这一战已经做过");
          return;
        }
        if (action === null) {
          skip("看不懂这个动作");
          return;
        }
        // 11-05: bosses and notEscape encounters cannot be fled; leave this rule out so the
        // next one fights instead, and record why.
        if (action.command === "逃跑" && (snapshot.boss === true || snapshot.notEscape === true)) {
          skip("这场逃不了");
          return;
        }
        if (target === null && effect !== null) {
          skip(effect === "revive" ? "没有倒下的人" : "没有可下手的目标");
          return;
        }
        const step: StrategyStep = {
          action,
          target,
          rule,
          ruleIndex: index,
          key,
          basis,
          text,
          condition,
          source,
          once: rule.once === true,
          effect,
        };
        const blocked = this.blockedReason(step, snapshot);
        if (blocked !== null) {
          skip(blocked);
          return;
        }
        steps.push(step);
      } catch (error) {
        // Task 53: one broken rule is skipped; any other error still reaches the caller.
        if (!(error instanceof StrategyFailure)) throw error;
        this.noteProblem(basis, error.message);
      }
    };

    strategy.reactions.forEach((reaction: StrategyReaction, offset) => {
      const index = offset + 1;
      if (!this.holdsOrFalse(reaction.on, snapshot, `对策 ${index}`)) return;
      this.addReaction(add, reaction, index);
    });

    let phase: StrategyPhase | undefined;
    for (const item of strategy.phases) {
      if (this.holdsOrFalse(item.when, snapshot, `阶段「${item.name}」的 when`)) {
        phase = item;
        break;
      }
    }
    if (phase !== undefined) {
      phase.rules.forEach((rule, offset) => {
        add(
          rule,
          offset + 1,
          "phase",
          `阶段「${phase.name}」第 ${offset + 1} 条`,
          describeSafe(rule),
          rule.if === undefined ? "" : conditionText(rule.if),
          rule.if,
        );
      });
    } else {
      strategy.rules.forEach((rule, offset) => {
        add(
          rule,
          offset + 1,
          "rules",
          `规则 ${offset + 1}`,
          describeSafe(rule),
          rule.if === undefined ? "" : conditionText(rule.if),
          rule.if,
        );
      });
    }

    steps.push(...fallbackSteps(strategy, snapshot));
    return { steps, skipped };
  }

  private addReaction(
    add: (
      rule: StrategyRule,
      index: number,
      source: StrategyStep["source"],
      basis: string,
      text: string,
      condition: string,
      expression: string | undefined,
    ) => void,
    reaction: StrategyReaction,
    index: number,
  ): void {
    add(
      reaction,
      index,
      "reaction",
      `对策 ${index}`,
      describeSafe(reaction),
      conditionText(reaction.on),
      reaction.if === undefined ? reaction.on : `(${reaction.on}) and (${reaction.if})`,
    );
  }
}

export function fallbackSteps(strategy: Strategy, snapshot: BattleSnapshot): StrategyStep[] {
  const actor = snapshot.actor ?? "";
  const role = strategy.roles[actor] ?? "";
  const weakest = lowestAlly(snapshot);
  const heal: StrategyStep = {
    action: { command: "白魔法", ability: "治疗" },
    target: weakest === null ? null : unitTarget("ally", weakest),
    rule: null,
    ruleIndex: 0,
    key: "fallback:heal",
    basis: "兜底",
    text: "兜底:治疗 HP 最低的同伴",
    condition: "",
    source: "fallback",
    once: false,
    effect: "heal",
  };
  const attack: StrategyStep = {
    action: { command: "攻击", ability: "" },
    target: null,
    rule: null,
    ruleIndex: 0,
    key: "fallback:attack",
    basis: "兜底",
    text: "兜底:攻击",
    condition: "",
    source: "fallback",
    once: false,
    effect: null,
  };
  return role.includes("治疗") ? [heal, attack] : [attack];
}

function itemCount(snapshot: BattleSnapshot, wanted: string): number {
  let total = 0;
  for (const [name, count] of Object.entries(snapshot.items ?? {})) {
    if (name === wanted || name.includes(wanted) || wanted.includes(name)) total += count;
  }
  return total;
}

/** A broken expression still has to be described for the record; fall back to who/do. */
function describeSafe(rule: StrategyRule | StrategyReaction): string {
  try {
    return "on" in rule ? describeReaction(rule) : describeRule(rule);
  } catch (error) {
    if (!(error instanceof StrategyFailure)) throw error;
    return `${rule.who}:${rule.do}`;
  }
}

function conditionText(expression: string | undefined): string {
  if (expression === undefined || expression.trim() === "") return "";
  try {
    return describe(expression);
  } catch {
    return expression;
  }
}

/**
 * Read a table as strategy 2.0: a 2.0 object is parsed as is; an old `{角色: [规则…]}` table
 * is converted with fromLegacy. With an actor, only that actor's old rules are kept, so a
 * character without rules falls back to attacking instead of following someone else's.
 */
export function strategyFor(table: unknown, actor?: string): Strategy | string[] {
  if (isRecord(table) && table.version === 2) return parseStrategy(table);
  if (actor === undefined) {
    try {
      return fromLegacy(table);
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  }
  const normalized = gambit.normalize(table);
  const rules = normalized[actor];
  if (rules === undefined || rules.length === 0) {
    return { version: 2, roles: {}, reactions: [], phases: [], rules: [] };
  }
  try {
    return fromLegacy({ [actor]: rules });
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Every ability name the strategy already mentions, for the unseen-enemy-skill trigger. */
export function mentionedSkills(table: unknown): Set<string> {
  const out = new Set<string>(["攻击", "防御", "换列", "道具", "普通攻击"]);
  const read = strategyFor(table);
  if (Array.isArray(read)) return out;
  const rules: (StrategyRule | StrategyReaction)[] = [
    ...read.reactions,
    ...read.rules,
    ...read.phases.flatMap((phase) => phase.rules),
  ];
  for (const rule of rules) {
    const action = actionOf(rule.do);
    if (action !== null && action.ability !== "" && !GENERIC_ACTIONS.has(action.ability)) {
      out.add(action.ability);
    }
    const reaction = "on" in rule ? rule : null;
    for (const expression of [rule.if, rule.to, reaction?.on]) {
      if (expression === undefined) continue;
      for (const match of expression.matchAll(/used\(([^)]+)\)/gu)) {
        const name = (match[1] ?? "").trim();
        if (name !== "" && name !== "any_magic") out.add(name);
      }
      for (const match of expression.matchAll(/"([^"]+)"/gu)) {
        if ((match[1] ?? "") !== "") out.add(match[1] ?? "");
      }
    }
  }
  return out;
}

/** Map the battle record's bridge pushes to the strategy snapshot's events. */
export function snapshotEvents(events: readonly RecordedEvent[]): BattleEvent[] {
  return events.map((event) => ({
    at: event.at,
    actor: event.actor,
    target: event.target,
    ability: event.action,
    magic: event.magic === true,
    countered: event.counter,
  }));
}

/** The living enemy index among the game's target cursor list, for `aim`. */
export function enemyIndex(snapshot: BattleSnapshot, unit: SnapshotUnit): number | null {
  const foes = unitsOf(snapshot, "enemy").filter((enemy) => enemy.hp > 0);
  const index = foes.findIndex((enemy) => enemy === unit || enemy.name === unit.name);
  return index < 0 ? null : index;
}

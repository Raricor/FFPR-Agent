/**
 * The tactician's coverage check (task 42): a table that parses can still be unusable. It
 * must answer what the enemy dossier says the battle will do — revive two people or carry
 * enough Phoenix Downs, heal, cure every status the monsters inflict, mention counters, forms
 * and absorbed elements, and only order commands the actor has right now. Failures are sent
 * back to the tactician with the missing pieces, inside the same two retries as gambit check.
 */

import type { PartyMember, BagInfo, DossierInput } from "./dossier.ts";
import { absorbedElements, monsterStatuses, scriptFeatures } from "./dossier.ts";
import { parseAction } from "./strategy/strategy.ts";
import { isRecord, list, text, type Json } from "./values.ts";
import * as gambit from "./skills/gambit.ts";

export interface CoverageInput {
  readonly tables: readonly Json[];
  readonly party: readonly PartyMember[];
  readonly bag: BagInfo;
  readonly dossier: DossierInput;
}

interface ActionRule {
  readonly actor: string;
  readonly label: string;
  readonly action: string;
  readonly command: string;
  readonly ability: string;
  /** The reaction's `on`, or the rule's `if`, for the status check. */
  readonly condition: string;
  readonly target: string;
}

/** Every rule as actor + action; a 2.0 role is expanded to the characters who hold it. */
export function actionsOf(tables: readonly Json[], party: readonly PartyMember[]): ActionRule[] {
  const out: ActionRule[] = [];
  const names = new Set(party.map((member) => member.name));
  for (const [tableIndex, table] of tables.entries()) {
    if (isRecord(table) && table.version === 2) {
      const roles: Record<string, string> = {};
      if (isRecord(table.roles)) {
        for (const [name, value] of Object.entries(table.roles)) {
          if (typeof value === "string") roles[name] = value;
        }
      }
      const expand = (who: string): string[] => {
        if (who === "all" || who === "any") return party.map((member) => member.name);
        if (names.has(who)) return [who];
        const roleNames = Object.entries(roles)
          .filter(([, role]) => role === who)
          .map(([name]) => name);
        return roleNames.length > 0 ? roleNames : [who];
      };
      const add = (rule: unknown, label: string, condition: string): void => {
        if (!isRecord(rule)) return;
        const action = text(rule.do) ?? "";
        const parsed = parseAction(action);
        for (const actor of expand(text(rule.who) ?? "")) {
          out.push({
            actor,
            label,
            action,
            command: parsed?.command ?? "",
            ability: parsed?.ability ?? "",
            condition,
            target: text(rule.to) ?? "",
          });
        }
      };
      const reactions = list(table.reactions);
      for (const [index, rule] of reactions.entries()) {
        const on = isRecord(rule) ? (text(rule.on) ?? "") : "";
        add(rule, `第 ${tableIndex + 1} 套第 ${index + 1} 条对策`, on);
      }
      const phases = list(table.phases);
      for (const [phaseIndex, phase] of phases.entries()) {
        if (!isRecord(phase)) continue;
        const phaseLabel = text(phase.name) ?? String(phaseIndex + 1);
        for (const [index, rule] of list(phase.rules).entries()) {
          const condition = isRecord(rule) ? (text(rule.if) ?? "") : "";
          add(rule, `阶段「${phaseLabel}」第 ${index + 1} 条`, condition);
        }
      }
      for (const [index, rule] of list(table.rules).entries()) {
        const condition = isRecord(rule) ? (text(rule.if) ?? "") : "";
        add(rule, `第 ${tableIndex + 1} 套第 ${index + 1} 条规则`, condition);
      }
      continue;
    }
    const normalized = gambit.normalize(table);
    for (const [actor, rules] of Object.entries(normalized)) {
      for (const [index, rule] of rules.entries()) {
        if (!isRecord(rule)) continue;
        const action = text(rule.do) ?? "";
        const separator = action.indexOf(":");
        out.push({
          actor,
          label: `第 ${tableIndex + 1} 套 ${actor} 第 ${index + 1} 条`,
          action,
          command: (separator < 0 ? action : action.slice(0, separator)).trim(),
          ability: separator < 0 ? "" : action.slice(separator + 1).trim(),
          condition: text(rule.if) ?? "",
          target: text(rule.target) ?? "",
        });
      }
    }
  }
  return out;
}

function isHeal(rule: ActionRule): boolean {
  if (rule.command === "道具")
    return /恢复药|高级恢复药|Potion|Ether|帐篷|Tent/u.test(rule.ability);
  return rule.command === "白魔法" && /^(?:治疗|救疗)/u.test(rule.ability);
}

function canRevive(member: PartyMember): boolean {
  if (member.job === "白魔法师" || member.commands.includes("白魔法")) return true;
  return member.abilities.some((ability) => ability.name.includes("复活"));
}

function magicAction(rule: ActionRule): boolean {
  return (
    rule.command !== "" &&
    rule.command !== "攻击" &&
    rule.command !== "防御" &&
    rule.command !== "换列" &&
    rule.command !== "道具"
  );
}

function statusHandling(rule: ActionRule, status: string): boolean {
  const cure = gambit.CURES[status];
  if (cure === undefined) return false;
  const [, item] = cure;
  const action =
    (rule.command === "道具" &&
      (rule.ability === item || rule.ability.includes(item) || item.includes(rule.ability))) ||
    (rule.command === "白魔法" && cure[0] !== null && rule.ability.includes(cure[0]));
  if (!action) return false;
  return (
    rule.condition.includes(`ally.status.${status}`) ||
    rule.condition.includes(`self.status.${status}`) ||
    rule.condition.includes(`has(${status})`) ||
    rule.target.includes(`状态:${status}`) ||
    rule.target.includes(`has(${status})`)
  );
}

function tableText(table: Json): string {
  return JSON.stringify(table);
}

/** The coverage problems, in Chinese, one per missing piece; [] when the table can be used. */
export function coverageProblems(input: CoverageInput): string[] {
  const problems: string[] = [];
  if (input.tables.length === 0) return problems;
  const rules = actionsOf(input.tables, input.party);

  const revivers = input.party.filter(canRevive).length;
  const phoenix = input.bag.count("不死鸟之尾");
  if (revivers < 2 && phoenix < 2) {
    problems.push(
      `至少要有两个人能复活,或者背包里带够不死鸟之尾:` +
        `现在能复活 ${revivers} 人,不死鸟之尾 ${phoenix} 个(建议先买/换职业)`,
    );
  }

  const heals = rules.some(isHeal);
  const bagHeal = input.bag.heal.length > 0;
  if (!heals && !bagHeal) problems.push("规则里没有回复手段,背包里也没有恢复药之类的道具");

  const byActor = new Map<string, ActionRule[]>();
  for (const rule of rules) byActor.set(rule.actor, [...(byActor.get(rule.actor) ?? []), rule]);
  for (const [actor, actorRules] of byActor) {
    if (!actorRules.some(magicAction)) continue;
    const fallback = actorRules.some(
      (rule) =>
        !magicAction(rule) ||
        rule.condition.includes("self.mp") ||
        (rule.command === "道具" && !/不死鸟|Phoenix/u.test(rule.ability)),
    );
    if (!fallback) {
      problems.push(`${actor} 的规则全靠魔法,MP 不够时没有退路(加一条攻击或道具兜底)`);
    }
  }

  const statuses = monsterStatuses(input.dossier);
  for (const status of statuses) {
    const handled = rules.filter((rule) => statusHandling(rule, status));
    if (handled.length === 0) {
      problems.push(`敌人会造成「${status}」,规则里没有对应的处理`);
      continue;
    }
    const cure = gambit.CURES[status];
    const item = cure?.[1] ?? "";
    if (item !== "" && input.bag.count(item) <= 0) {
      problems.push(`处理「${status}」要用${item},背包里没有(写进 ask_up 建议)`);
    }
  }

  const dossier = input.dossier;
  for (const monster of dossier.monsters) {
    const entry = dossier.ai?.entry(monster.info?.monster ?? monster.book ?? null) ?? null;
    const features = scriptFeatures(entry);
    const text = input.tables.map(tableText).join("\n");
    const counterInRecords = dossier.records.some(
      (record) =>
        record.enemies.some((enemy) => enemy.name === monster.name) &&
        record.events.some((event) => event.actor === monster.name && event.counter),
    );
    if ((features.counters || counterInRecords) && !/反击|Counter/iu.test(text)) {
      problems.push(`档案里「${monster.name}」会反击,规则里没有阶段或对策提到反击`);
    }
    const forms = formsOf(monster.name, dossier);
    if (features.transforms || forms.length > 1) {
      const mentionsForm =
        /变身|形态|enemy\.id\.\d+/u.test(text) || forms.some((id) => text.includes(String(id)));
      if (!mentionsForm) {
        problems.push(
          `档案里「${monster.name}」会变身(编号 ${forms.join("、") || "不同形态"}),规则里没有阶段或对策提到它`,
        );
      }
    }
    if (
      absorbedElements([monster], dossier.elements).length > 0 &&
      !/吸收|enemy\.absorbs/u.test(text)
    ) {
      problems.push(`档案里「${monster.name}」有吸收属性,规则里没有阶段或对策提到吸收`);
    }
  }

  const commands = new Map(input.party.map((member) => [member.name, member.commands]));
  for (const rule of rules) {
    const available = commands.get(rule.actor);
    if (available === undefined) {
      problems.push(`${rule.label}:队伍里现在没有「${rule.actor}」`);
      continue;
    }
    if (rule.command === "" || available.includes(rule.command)) continue;
    const member = input.party.find((item) => item.name === rule.actor);
    problems.push(
      `${rule.label}:「${rule.actor}」现在没有「${rule.command}」指令` +
        `(职业:${member?.job ?? "?"},能做:${available.join("、")}),「${rule.action}」用不了`,
    );
  }
  return [...new Set(problems)];
}

function formsOf(name: string, dossier: DossierInput): number[] {
  const ids = new Set<number>();
  for (const monster of dossier.monsters) {
    if (monster.name !== name || monster.id === null) continue;
    ids.add(monster.id);
  }
  for (const record of dossier.records) {
    for (const enemy of record.enemies) {
      if (enemy.name === name && enemy.id !== null) ids.add(enemy.id);
    }
  }
  return [...ids].sort((left, right) => left - right);
}

/**
 * Why a stored table can no longer run with the current party (task 42 party-changed):
 * the table's commands are checked against the jobs and commands the party has now. A job
 * change that keeps the same commands (a knight becoming a monk) is not a rewrite reason.
 */
export function partyChangedProblem(
  table: Json,
  party: readonly PartyMember[],
  previous: readonly import("./dossier.ts").PartySnapshotMember[] | null,
): string[] {
  const problems: string[] = [];
  const current = new Map(party.map((member) => [member.name, member]));
  for (const rule of actionsOf([table], party)) {
    const member = current.get(rule.actor);
    if (member === undefined) {
      problems.push(`「${rule.actor}」已经不在队伍里,${rule.label}「${rule.action}」用不了`);
      continue;
    }
    if (rule.command === "" || member.commands.includes(rule.command)) continue;
    const before = previous?.find((row) => row.name === rule.actor);
    const oldJob = before?.job ?? member.job;
    const changed = oldJob !== member.job ? `从${oldJob}换成了${member.job}` : "现在没有";
    problems.push(
      `「${rule.actor}」${changed},${rule.label}「${rule.action}」用不了` +
        `(现在没有${rule.command}指令,能做:${member.commands.join("、")})`,
    );
  }
  return [...new Set(problems)];
}

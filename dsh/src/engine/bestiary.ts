/**
 * Static monster data for the bestiary page (task 16): parse the bridge's `monsters` reply,
 * cache it for the plugin's lifetime, and turn one monster into the Chinese lines the panel and
 * `/ach` share. The data never changes, so a successful read is cached once; a failed read is
 * retried on the next request.
 */

import type { Pilot } from "./pilot.ts";
import type { MissableRule } from "./profiles/types.ts";
import { isRecord, list, num, text } from "./values.ts";

export interface MonsterAttribute {
  readonly id: number | null;
  /** The bridge's sentence for weak rows ("对冰属性抵抗力低"), or null. */
  readonly name: string | null;
  readonly type: number | null;
}

export interface MonsterInfo {
  readonly number: number | null;
  readonly monster: number | null;
  readonly name: string | null;
  readonly lv: number | null;
  readonly hp: number | null;
  readonly mp: number | null;
  readonly exp: number | null;
  readonly gil: number | null;
  readonly boss: boolean | null;
  readonly species: number | null;
  readonly resistanceAttribute: number | null;
  readonly resistanceCondition: number | null;
  readonly attributes: readonly MonsterAttribute[];
  readonly conditions: readonly string[];
  readonly drops: readonly string[];
  readonly steals: readonly string[];
}

function parseAttribute(value: unknown): MonsterAttribute | null {
  if (!isRecord(value)) return null;
  return {
    id: num(value.id) ?? null,
    name: text(value.name) ?? null,
    type: num(value.type) ?? null,
  };
}

function parseMonster(value: unknown): MonsterInfo | null {
  if (!isRecord(value)) return null;
  return {
    number: num(value.number) ?? null,
    monster: num(value.monster) ?? null,
    name: text(value.name) ?? null,
    lv: num(value.lv) ?? null,
    hp: num(value.hp) ?? null,
    mp: num(value.mp) ?? null,
    exp: num(value.exp) ?? null,
    gil: num(value.gil) ?? null,
    boss: typeof value.boss === "boolean" ? value.boss : null,
    species: num(value.species) ?? null,
    resistanceAttribute: num(value.resistanceAttribute) ?? null,
    resistanceCondition: num(value.resistanceCondition) ?? null,
    attributes: list(value.attributes)
      .map(parseAttribute)
      .filter((attribute): attribute is MonsterAttribute => attribute !== null),
    conditions: list(value.conditions).filter((item): item is string => typeof item === "string"),
    drops: list(value.drops).filter((item): item is string => typeof item === "string"),
    steals: list(value.steals).filter((item): item is string => typeof item === "string"),
  };
}

/** Narrow the bridge's `monsters` reply; accepts the member or the reply itself. */
export function parseMonsters(reply: unknown): MonsterInfo[] {
  const rows =
    isRecord(reply) && Array.isArray(reply.monsters)
      ? reply.monsters
      : Array.isArray(reply)
        ? reply
        : [];
  return rows.map(parseMonster).filter((monster): monster is MonsterInfo => monster !== null);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The bridge's sentence for a weak row: FF5 says "对冰属性抵抗力低" or "对毒抵抗力低", FF6 says
 * "弱点是火属性" (10-28 dump; same ids, 1 fire to 8 wind).
 */
const WEAK_NAME = /^(?:对(.+?)(?:属性)?抵抗力低|弱点是(.+?)(?:属性)?)$/;

/**
 * AttributeGroup ids to element names, read from the sentences on the weak rows (task 20), then
 * the game's own table for ids no sentence names. On the 10-27 dump only weak rows carried a
 * name, and it was a sentence like "对冰属性抵抗力低".
 */
export function elementNames(
  monsters: readonly MonsterInfo[],
  known: Readonly<Record<number, string>>,
): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  for (const monster of monsters) {
    for (const attribute of monster.attributes) {
      if (attribute.id === null || attribute.name === null) continue;
      const match = WEAK_NAME.exec(attribute.name);
      const name = match?.[1] ?? match?.[2];
      if (name !== undefined && name !== "" && !names.has(attribute.id)) {
        names.set(attribute.id, name);
      }
    }
  }
  for (const [id, name] of Object.entries(known)) {
    if (!names.has(Number(id))) names.set(Number(id), name);
  }
  return names;
}

/** The element name from `elementNames`, else the number: never another game's name. */
export function attributeName(
  id: number | null,
  names?: ReadonlyMap<number, string>,
): string | null {
  if (id === null) return null;
  return names?.get(id) ?? `属性 ${id}`;
}

function resistanceLines(
  attributes: readonly MonsterAttribute[],
  names: ReadonlyMap<number, string> | null,
): string[] {
  const sections: readonly (readonly [number, string])[] = [
    [1, "弱点"],
    [401, "双倍弱点"],
    [2, "减半"],
    [402, "大幅减半"],
    [3, "无效"],
    [4, "吸收"],
    [403, "吸收(物理为弱点)"],
  ];
  const lines: string[] = [];
  for (const [type, label] of sections) {
    const chosen = unique(
      attributes
        .filter((attribute) => attribute.type === type)
        .map((attribute) => attributeName(attribute.id, names ?? undefined) ?? ""),
    );
    if (chosen.length > 0) lines.push(`${label}：${chosen.join("、")}`);
  }
  return lines;
}

/** The per-monster Chinese introduction; empty lines are never returned. */
export function formatMonsterDetails(
  info: MonsterInfo,
  habitats: readonly string[],
  guideNote: string | null,
  status: string | null,
  names: ReadonlyMap<number, string> | null,
): string[] {
  const lines: string[] = [];
  const stats: string[] = [];
  // 10-27: some masters (the Sergeant) store level 0; a zero level says nothing.
  if (info.lv !== null && info.lv > 0) stats.push(`Lv ${info.lv}`);
  if (info.hp !== null) stats.push(`HP ${info.hp}`);
  if (info.mp !== null) stats.push(`MP ${info.mp}`);
  if (info.exp !== null) stats.push(`经验 ${info.exp}`);
  if (info.gil !== null) stats.push(`金钱 ${info.gil}`);
  if (info.boss === true) stats.push("首领");
  if (stats.length > 0) lines.push(stats.join(" · "));
  const resistances = resistanceLines(info.attributes, names);
  if (resistances.length > 0) lines.push(resistances.join(" · "));
  const conditions = unique(info.conditions);
  if (conditions.length > 0) {
    const shown = conditions.slice(0, 8);
    const suffix = conditions.length > 8 ? `等 ${conditions.length} 种` : "";
    lines.push(`状态免疫：${shown.join("、")}${suffix}`);
  }
  const loot: string[] = [];
  const drops = unique(info.drops);
  const steals = unique(info.steals);
  if (drops.length > 0) loot.push(`掉落：${drops.join("、")}`);
  if (steals.length > 0) loot.push(`偷窃：${steals.join("、")}`);
  if (loot.length > 0) lines.push(loot.join(" · "));
  if (habitats.length > 0) lines.push(`出没：${habitats.join("、")}`);
  if (guideNote !== null && guideNote.trim() !== "") lines.push(`攻略：${guideNote}`);
  if (status !== null) lines.push(status);
  return lines;
}

/**
 * Whether this unregistered number can no longer be obtained in the current save. The three
 * rules follow task 16: a passed `past` flag plus every recorded area inside the guide's areas
 * means lost; otherwise a rule with a deadline warns; a passed flag but an area elsewhere stays
 * unmarked because the game data disagrees with the guide.
 */
export function monsterStatus(
  number: number,
  areas: readonly number[],
  storyPassed: (api: string) => boolean,
  rules: readonly MissableRule[],
): string | null {
  const rule = rules.find((item) => item.numbers.includes(number));
  if (rule === undefined) return null;
  const agrees = areas.length > 0 && areas.every((area) => rule.areas.includes(area));
  const past = rule.past !== undefined && storyPassed(rule.past);
  // 10-27: Ronka's Stone Mask is also recorded in the Rift, so its deadline may not be real.
  if (!past) return agrees ? `限时:${rule.until}` : `限时:${rule.until}(游戏记录别处也出现)`;
  return agrees ? "不可再获得" : null;
}

/** One successful static read, shared by `/ach` and the panel route. */
export class MonsterCache {
  /** One read per game: the web app can outlive a switch from FF5 to FF6 (task 20). */
  private readonly cached = new Map<string, readonly MonsterInfo[]>();

  async load(
    pilot: Pilot,
    signal?: AbortSignal,
    game = "",
  ): Promise<readonly MonsterInfo[] | null> {
    const known = this.cached.get(game);
    if (known !== undefined) return known;
    try {
      const reply = await pilot.query("monsters");
      const monsters = parseMonsters(reply);
      if (monsters.length === 0) return null;
      this.cached.set(game, monsters);
      return monsters;
    } catch (error) {
      if (signal !== undefined) signal.throwIfAborted();
      else if (error instanceof Error && error.name === "AbortError") throw error;
      // A failed read only leaves out the introductions this time; the next request retries.
      return null;
    }
  }
}

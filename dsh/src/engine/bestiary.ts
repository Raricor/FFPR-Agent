/**
 * Static monster data for the bestiary page (task 16): parse the bridge's `monsters` reply,
 * cache it for the plugin's lifetime, and turn one monster into the Chinese lines the panel and
 * `/ach` share. The data never changes, so a successful read is cached once; a failed read is
 * retried on the next request.
 */

import type { Pilot } from "./pilot.ts";
import { isRecord, list, num, text } from "./values.ts";

export interface MonsterAttribute {
  readonly id: number | null;
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

export interface MissableRule {
  readonly numbers: readonly number[];
  readonly areas: readonly number[];
  readonly until: string;
  /** The first story achievement certainly after the deadline, when one is known. */
  readonly past?: string;
}

/**
 * 10-27: area ids are reused across worlds — 71 is Walse Tower and later the sunken Walse
 * Tower — so these rules are only trusted when every recorded area is one the guide names.
 * A set `past` flag whose areas include somewhere else means the game disagrees with the
 * guide: leave the monster unmarked rather than call it lost.
 */
export const BESTIARY_MISSABLES: readonly MissableRule[] = [
  { numbers: [191, 192], areas: [11], until: "离开托纳运河前", past: "scenario_3" },
  {
    numbers: [233],
    areas: [15],
    until: "北山首领战里让玛基莎把它召唤出来",
    past: "scenario_3",
  },
  { numbers: [28, 29], areas: [71], until: "打倒沃尔斯塔顶的首领前", past: "scenario_3" },
  {
    numbers: [27],
    areas: [66, 71],
    until: "打倒两歧塔首领前(沃尔斯塔之后还有一次机会)",
  },
  {
    numbers: [41, 42, 43, 44, 238],
    areas: [24],
    until: "火力船首领后的 10 分钟逃脱里",
    past: "scenario_5",
  },
  {
    numbers: [62, 64, 65, 66, 67, 68, 69],
    areas: [34],
    until: "打倒隆卡遗迹首领前",
    past: "scenario_7",
  },
  { numbers: [76, 77, 78, 79], areas: [54], until: "大桥的战斗结束前", past: "scenario_10" },
  {
    numbers: [263],
    areas: [0],
    until: "泽扎的船队上，等吉尔伽美什召唤它再打倒吉尔伽美什",
    past: "scenario_10",
  },
  {
    numbers: [106, 107, 108, 109, 110, 111, 112],
    areas: [57],
    until: "打倒屏障之塔首领前",
    past: "scenario_10",
  },
  { numbers: [122], areas: [79, 86], until: "慕亚大森林变化前", past: "scenario_11" },
  {
    numbers: [71, 72],
    areas: [40],
    until: "艾克斯迪司城地下室，解除幻术前",
    past: "scenario_11",
  },
  {
    numbers: [
      30, 82, 121, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 158, 255, 271, 272,
      273,
    ],
    areas: [40],
    until: "打倒十三层的艾克斯迪司前",
    past: "scenario_11",
  },
  {
    numbers: [162, 163, 164, 165, 166, 167],
    areas: [66, 67, 68],
    until: "打倒两歧塔首领前",
  },
];

function parseAttribute(value: unknown): MonsterAttribute | null {
  if (!isRecord(value)) return null;
  return {
    id: num(value.id) ?? null,
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
 * AttributeGroup ids to element names. The bridge's `name` is no use: 10-27 only the weak rows
 * carried one, and it was a sentence ("对冰属性抵抗力低"); every id's name was read off those.
 */
export function attributeName(id: number | null): string | null {
  if (id === null) return null;
  return ELEMENTS.get(id) ?? `属性 ${id}`;
}

const ELEMENTS: ReadonlyMap<number, string> = new Map([
  [1, "火"],
  [2, "冰"],
  [3, "雷"],
  [4, "土"],
  [5, "水"],
  [6, "毒"],
  [7, "圣"],
  [8, "风"],
]);

function resistanceLines(attributes: readonly MonsterAttribute[]): string[] {
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
    const names = unique(
      attributes
        .filter((attribute) => attribute.type === type)
        .map((attribute) => attributeName(attribute.id) ?? ""),
    );
    if (names.length > 0) lines.push(`${label}：${names.join("、")}`);
  }
  return lines;
}

/** The per-monster Chinese introduction; empty lines are never returned. */
export function formatMonsterDetails(
  info: MonsterInfo,
  habitats: readonly string[],
  guideNote: string | null,
  status: string | null,
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
  const resistances = resistanceLines(info.attributes);
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
): string | null {
  const rule = BESTIARY_MISSABLES.find((item) => item.numbers.includes(number));
  if (rule === undefined) return null;
  const agrees = areas.length > 0 && areas.every((area) => rule.areas.includes(area));
  const past = rule.past !== undefined && storyPassed(rule.past);
  // 10-27: Ronka's Stone Mask is also recorded in the Rift, so its deadline may not be real.
  if (!past) return agrees ? `限时:${rule.until}` : `限时:${rule.until}(游戏记录别处也出现)`;
  return agrees ? "不可再获得" : null;
}

/** One successful static read, shared by `/ach` and the panel route. */
export class MonsterCache {
  private cached: readonly MonsterInfo[] | null = null;

  async load(pilot: Pilot, signal?: AbortSignal): Promise<readonly MonsterInfo[] | null> {
    if (this.cached !== null) return this.cached;
    try {
      const reply = await pilot.query("monsters");
      const monsters = parseMonsters(reply);
      if (monsters.length === 0) return null;
      this.cached = monsters;
      return monsters;
    } catch (error) {
      if (signal !== undefined) signal.throwIfAborted();
      else if (error instanceof Error && error.name === "AbortError") throw error;
      // A failed read only leaves out the introductions this time; the next request retries.
      return null;
    }
  }
}

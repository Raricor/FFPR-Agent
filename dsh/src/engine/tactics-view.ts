/**
 * The battle strategy page (task 17): pure formatting of Tactics and the Game's in-memory
 * tactician notes into the data the sidebar renders. No laptop, no pilot, no I/O.
 */

import type { BossPlanRecord } from "./game.ts";
import { isElement, type ElementKnowledge } from "./elements.ts";
import { attributeName, elementNames, type MonsterInfo } from "./bestiary.ts";
import { describeError } from "./errors.ts";
import { byKey } from "./games.ts";
import type { GameProfile } from "./profiles/types.ts";
import { isRecord, num, records, text } from "./values.ts";
import type { Tactics, TacticsEntry } from "./tactics.ts";
import * as gambit from "./skills/gambit.ts";
import { encounterMonsters, formationLines, type EncounterTable } from "./encounters.ts";

export interface RuleTableView {
  readonly title: string;
  readonly inUse: boolean;
  readonly members: readonly { readonly name: string; readonly rules: readonly string[] }[];
}

export interface EnemyView {
  readonly label: string;
  readonly facts: string;
  readonly plan: readonly string[];
}

export interface MapTacticsView {
  readonly mapId: number;
  readonly name: string;
  readonly summary: string;
  readonly tables: readonly RuleTableView[];
  readonly results: readonly string[];
  readonly notes: readonly string[];
  readonly enemies: readonly EnemyView[];
  readonly enemyNote: string;
  /** The encounter table where the player stands: the current map only, [] elsewhere. */
  readonly formations: readonly string[];
}

export interface TacticsPanelView {
  readonly title: string;
  readonly status: string;
  readonly current: MapTacticsView | null;
  /** Set when this game has no AI player (only the configured game does). */
  readonly message: string | null;
  readonly boss: {
    readonly title: string;
    readonly table: RuleTableView;
    readonly result: string;
  } | null;
  readonly others: readonly MapTacticsView[];
}

export interface BestiaryEntryView {
  readonly number: number | null;
  readonly name: string | null;
  readonly areas: readonly number[];
}

export interface TacticsViewInput {
  readonly profile: GameProfile;
  /** Whether the running game is the configured one: only it has tables and an AI player. */
  readonly strategy: boolean;
  readonly mapId: number | null;
  /** The game's own name for where the player is (sample `user.locationText`), if any. */
  readonly placeName?: string;
  readonly areaId: number | null;
  readonly party: readonly unknown[];
  readonly inBattle: boolean;
  readonly tactics: Tactics;
  readonly mapNameOf: (mapId: number) => string;
  readonly tacticianInfoFor: (
    mapId: number,
  ) => { readonly mapId: number; readonly walkerNotes: string; readonly askUp: string } | null;
  readonly lastBossPlan: () => BossPlanRecord | null;
  readonly encountered: (mapId: number) => readonly string[];
  readonly monsters: readonly MonsterInfo[] | null;
  readonly bestiaryEntries: readonly BestiaryEntryView[] | null;
  readonly items: Readonly<Record<string, number>>;
  readonly elements: ElementKnowledge | null;
  /** The game's encounter table at the player's position; null when unknown. */
  readonly encounters: EncounterTable | null;
}

const CONDITION_NAMES: Readonly<Record<string, string>> = {
  "self.hp": "自己 HP",
  "self.hp_pct": "自己 HP%",
  "self.mp": "自己 MP",
  "ally.hp_pct": "同伴最低 HP%",
  "ally.dead": "倒下的同伴",
  "party.alive": "活着的人",
  "enemy.count": "敌人数",
  "enemy.boss": "首领战",
  "enemy.hp_pct": "敌人最低 HP%",
  turn: "第几次行动",
};

const OPERATORS: Readonly<Record<string, string>> = {
  ">=": "≥",
  "<=": "≤",
  "==": "=",
  "!=": "≠",
  "<": "<",
  ">": ">",
};

function conditionName(name: string): string {
  const fixed = CONDITION_NAMES[name];
  if (fixed !== undefined) return fixed;
  if (name.startsWith("enemy.weak.")) return `弱${name.slice("enemy.weak.".length)}的敌人`;
  if (name.startsWith("enemy.absorbs.")) {
    return `吸收${name.slice("enemy.absorbs.".length)}的敌人`;
  }
  if (name.startsWith("item.")) return name.slice("item.".length);
  if (name.startsWith("ally.status.")) {
    return `${name.slice("ally.status.".length)}状态的同伴`;
  }
  if (name.startsWith("self.status.")) return `自己${name.slice("self.status.".length)}状态`;
  return name;
}

/** A condition as Chinese, or the original text when gambit cannot parse it. */
export function describeCondition(condition: string): string {
  let clauses: readonly gambit.Clause[];
  try {
    clauses = gambit.parse(condition);
  } catch {
    return condition;
  }
  return clauses
    .map(([name, op, number]) => {
      const label = conditionName(name);
      if (op === null || number === null) return label;
      return `${label} ${OPERATORS[op] ?? op} ${number}`;
    })
    .join(" 且 ");
}

/** 「条件 → 行动(目标)」, with the fallback rule written as 「其他情况」. */
export function describeRule(rule: unknown): string {
  const record = isRecord(rule) ? rule : {};
  const condition =
    typeof record.if === "string" && record.if.trim() !== ""
      ? describeCondition(record.if)
      : "其他情况";
  const action = typeof record.do === "string" && record.do !== "" ? record.do : "攻击";
  const target = typeof record.target === "string" && record.target !== "" ? record.target : null;
  return `${condition} → ${action}${target === null ? "" : `(${target})`}`;
}

function ruleTable(table: unknown, title: string, inUse: boolean): RuleTableView {
  const normalized = gambit.normalize(table);
  return {
    title,
    inUse,
    members: Object.entries(normalized).map(([name, rules]) => ({
      name,
      rules: rules.map(describeRule),
    })),
  };
}

function mapName(input: TacticsViewInput, mapId: number): string {
  // The atlas is FF5's; another game names its place itself (the sample's location).
  const name = input.strategy ? input.mapNameOf(mapId) : (input.placeName ?? "");
  return name !== "" ? name : `地图 ${mapId}`;
}

function resultsOf(entry: TacticsEntry): string[] {
  const invalid: string[] = [];
  if (!Array.isArray(entry.results)) return invalid;
  return entry.results
    .slice(-8)
    .reverse()
    .map((raw) => {
      const table = num(raw.table);
      const verdict = text(raw.verdict) ?? "";
      const label =
        verdict === "ok"
          ? "顺利"
          : verdict === "hard"
            ? "吃力"
            : verdict === "lost"
              ? "全灭"
              : verdict;
      const detail = text(raw.detail) ?? "";
      return `策略 ${table === undefined ? 1 : table + 1} · ${label}:${detail}`;
    });
}

function notesOf(info: { readonly walkerNotes: string; readonly askUp: string } | null): string[] {
  if (info === null) return [];
  const notes: string[] = [];
  if (info.walkerNotes !== "") notes.push(`走法:${info.walkerNotes}`);
  if (info.askUp !== "") notes.push(`建议:${info.askUp}`);
  return notes;
}

export function enemyFacts(
  info: MonsterInfo | undefined,
  names: ReadonlyMap<number, string>,
): string {
  if (info === undefined) return "";
  const parts: string[] = [];
  if (info.hp !== null) parts.push(`HP ${info.hp}`);
  const ofTypes = (types: readonly number[]): string[] => {
    const out: string[] = [];
    for (const attribute of info.attributes) {
      const name = attributeName(attribute.id, names);
      if (attribute.type !== null && types.includes(attribute.type) && name !== null) {
        if (name !== "" && !out.includes(name)) out.push(name);
      }
    }
    return out;
  };
  const weak = ofTypes([1, 401]);
  const absorbs = ofTypes([4, 403]);
  const immune = ofTypes([3]);
  if (weak.length > 0) parts.push(`弱：${weak.join("、")}`);
  if (absorbs.length > 0) parts.push(`吸收：${absorbs.join("、")}`);
  if (immune.length > 0) parts.push(`无效：${immune.join("、")}`);
  return parts.join(" · ");
}

function enemyNumbers(
  input: TacticsViewInput,
  mapId: number,
  current: boolean,
  includeArea: boolean,
  infoByNumber: ReadonlyMap<number, MonsterInfo>,
  entryByNumber: ReadonlyMap<number, BestiaryEntryView>,
  entryByName: ReadonlyMap<string, BestiaryEntryView>,
  infoByName: ReadonlyMap<string, MonsterInfo>,
): { number: number | null; name: string }[] {
  const found: { number: number | null; name: string }[] = [];
  const seen = new Set<string>();
  const add = (number: number | null, rawName: string): void => {
    const key = number === null ? `name:${rawName}` : `no:${number}`;
    if (rawName === "" && number === null) return;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = number === null ? undefined : entryByNumber.get(number);
    const info = number === null ? undefined : infoByNumber.get(number);
    found.push({ number, name: info?.name ?? entry?.name ?? rawName });
  };
  const addName = (rawName: string): void => {
    const info = infoByName.get(rawName);
    const entry = entryByName.get(rawName);
    const candidates = [info?.number, entry?.number].filter(
      (value): value is number => value !== undefined && value !== null,
    );
    const number = candidates.length > 0 ? Math.min(...candidates) : null;
    add(number, rawName);
  };
  // The game's own table comes first: it is exact, the world map included (10-27).
  if (current) {
    for (const monster of encounterMonsters(input.encounters)) {
      if (monster.book === null) addName(monster.name);
      else add(monster.book, monster.name);
    }
  }
  // Encounter memory, tables and the atlas are the AI player's game's (FF5): map ids repeat
  // across games, so another game would get FF5's monsters for its own map 1.
  if (input.strategy) {
    for (const name of input.encountered(mapId)) addName(name);
    for (const name of input.tactics.monstersSeen(mapId)) addName(name);
  }
  if (includeArea && input.areaId !== null) {
    for (const entry of input.bestiaryEntries ?? []) {
      if (entry.number !== null && entry.areas.includes(input.areaId)) {
        add(entry.number, entry.name ?? "");
      }
    }
  }
  return found;
}

function enemyLabel(number: number | null, name: string): string {
  return number !== null ? `No.${String(number).padStart(3, "0")} ${name}`.trim() : name;
}

function enemyPlans(
  input: TacticsViewInput,
  enemies: readonly { number: number | null; name: string }[],
  table: unknown,
  names: ReadonlyMap<number, string>,
): EnemyView[] {
  const normalized = gambit.normalize(table);
  const playerRows: gambit.Json[] = records(input.party).map((member) => ({
    ...member,
    hp: num(member.maxHp) ?? num(member.hp) ?? 0,
  }));
  const infoByNumber = new Map<number, MonsterInfo>();
  for (const info of input.monsters ?? []) {
    if (info.number !== null) infoByNumber.set(info.number, info);
  }
  const infoByName = new Map<string, MonsterInfo>();
  for (const info of input.monsters ?? []) {
    if (info.name === null) continue;
    const previous = infoByName.get(info.name);
    if (previous === undefined || (info.number ?? Infinity) < (previous.number ?? Infinity)) {
      infoByName.set(info.name, info);
    }
  }
  // Without strategy tables (another game) only the facts matter; no first action is simulated.
  if (table === null) {
    return enemies.map(({ number, name }) => {
      const info = infoByNumber.get(number ?? -1) ?? infoByName.get(name);
      return { label: enemyLabel(number, name), facts: enemyFacts(info, names), plan: [] };
    });
  }
  return enemies.map(({ number, name }) => {
    const info = infoByNumber.get(number ?? -1) ?? infoByName.get(name);
    // Without monster data the enemy still has to be alive, or the rules see an empty field.
    const enemy = {
      name,
      hp: info?.hp ?? 1,
      maxHp: info?.hp ?? 1,
      boss: info?.boss === true,
      book: number,
    };
    const boss = info?.boss === true;
    const enemyAttributes = info?.attributes ?? [];
    const weak = new Set(
      enemyAttributes
        .filter((attribute) => attribute.type === 1 || attribute.type === 401)
        .map((attribute) => attributeName(attribute.id, names) ?? ""),
    );
    const absorbs = new Set(
      enemyAttributes
        .filter((attribute) => attribute.type === 4 || attribute.type === 403)
        .map((attribute) => attributeName(attribute.id, names) ?? ""),
    );
    const immune = new Set(
      enemyAttributes
        .filter((attribute) => attribute.type === 3)
        .map((attribute) => attributeName(attribute.id, names) ?? ""),
    );
    const resistances = {
      weak: [...weak].filter(isElement),
      absorb: [...absorbs].filter(isElement),
      immune: [...immune].filter(isElement),
    };
    const plans: string[] = [];
    for (const member of playerRows) {
      const actor = text(member.name);
      if (actor === undefined || actor === "") continue;
      const rules = (normalized[actor] ?? []) as gambit.Json[];
      let action: gambit.Action;
      try {
        action = gambit.choose(
          rules,
          new gambit.Situation(actor, playerRows, [enemy], 1, boss, input.items, input.elements),
        );
      } catch (error) {
        plans.push(`${actor}：推演不了(${describeError(error)})`);
        continue;
      }
      let ability = action.ability;
      let shown = ability;
      if (ability === "最强" || ability.endsWith("+")) {
        const abilities = records(member.abilities)
          .map((spell) => text(spell.name) ?? "")
          .filter((spell) => spell !== "");
        const known = gambit
          .abilityCandidates(ability, resistances)
          .find((spell) => abilities.includes(spell));
        if (known !== undefined) {
          shown = `${ability}→${known}`;
          ability = known;
        } else if (abilities.length > 0) {
          // 10-27: against the Poltergeist (fire and thunder immune, absorbs ice) Faris's 最强
          // had nothing to pick from; say so rather than leave the rule's word standing.
          shown = `${ability}(没有能打它的法术)`;
        }
      }
      const label =
        action.command === "攻击" && ability === ""
          ? "攻击"
          : ability === ""
            ? action.command
            : `${action.command}:${shown}`;
      let suffix = "";
      const element = gambit.elementOf(ability);
      if (element !== null) {
        if (absorbs.has(element)) suffix = `(它吸收${element}!)`;
        else if (weak.has(element)) suffix = "(打弱点)";
      }
      plans.push(`${actor}：${label}${suffix}`);
    }
    return {
      label: enemyLabel(number, name),
      facts: enemyFacts(info, names),
      plan: plans,
    };
  });
}

function mapView(input: TacticsViewInput, mapId: number, includeArea: boolean): MapTacticsView {
  const entry = input.strategy ? input.tactics.maps.get(String(mapId)) : undefined;
  const tables = entry?.tables ?? [];
  const current =
    tables.length === 0
      ? 0
      : (((entry?.current ?? 0) % tables.length) + tables.length) % tables.length;
  const hasTables = tables.length > 0;
  const summary = !input.strategy
    ? ""
    : hasTables
      ? `${tables.length} 套策略，正在用第 ${current + 1} 套`
      : "没有专属策略，普通战斗用默认规则(按职业)";
  const views = !input.strategy
    ? []
    : hasTables
      ? tables.map((table, index) =>
          ruleTable(
            table,
            `策略 ${index + 1}${index === current ? "(正在用)" : ""}`,
            index === current,
          ),
        )
      : [ruleTable(gambit.defaultTable(input.party), "默认规则(按职业)", true)];
  const infoByNumber = new Map<number, MonsterInfo>();
  for (const info of input.monsters ?? []) {
    if (info.number !== null) infoByNumber.set(info.number, info);
  }
  const infoByName = new Map<string, MonsterInfo>();
  for (const info of input.monsters ?? []) {
    if (info.name === null) continue;
    const previous = infoByName.get(info.name);
    if (previous === undefined || (info.number ?? Infinity) < (previous.number ?? Infinity)) {
      infoByName.set(info.name, info);
    }
  }
  const entryByNumber = new Map<number, BestiaryEntryView>();
  const entryByName = new Map<string, BestiaryEntryView>();
  for (const entryView of input.bestiaryEntries ?? []) {
    if (entryView.number !== null && !entryByNumber.has(entryView.number)) {
      entryByNumber.set(entryView.number, entryView);
    }
    if (entryView.name !== null) {
      const previous = entryByName.get(entryView.name);
      if (
        previous === undefined ||
        (entryView.number ?? Infinity) < (previous.number ?? Infinity)
      ) {
        entryByName.set(entryView.name, entryView);
      }
    }
  }
  const activeTable = !input.strategy
    ? null
    : hasTables
      ? (tables[current] ?? {})
      : gambit.defaultTable(input.party);
  const useArea = includeArea && mapId !== 1 && input.areaId !== 0;
  const names = elementNames(input.monsters ?? [], input.profile.elements);
  const enemies = enemyPlans(
    input,
    enemyNumbers(
      input,
      mapId,
      includeArea,
      useArea,
      infoByNumber,
      entryByNumber,
      entryByName,
      infoByName,
    ),
    activeTable,
    names,
  );
  const formations = includeArea ? formationLines(input.encounters) : [];
  return {
    mapId,
    name: mapName(input, mapId),
    summary,
    tables: views,
    results: entry === undefined ? [] : resultsOf(entry),
    notes: input.strategy ? notesOf(input.tacticianInfoFor(mapId)) : [],
    enemies,
    enemyNote: input.strategy ? "按全员满 HP、第一回合、只有这一只敌人推演" : "",
    formations,
  };
}

/** All data the sidebar's 策略 page needs, already sorted and worded. */
export function tacticsView(input: TacticsViewInput): TacticsPanelView {
  const title = `${byKey(input.profile.key).label} 策略`;
  const current = input.mapId === null ? null : mapView(input, input.mapId, true);
  const status =
    input.mapId === null
      ? "读不到当前地图"
      : `当前地图：${mapName(input, input.mapId)}${input.inBattle ? " · 战斗中" : ""}`;
  const ids = [...input.tactics.maps.keys()]
    .map((key) => Number(key))
    .filter((mapId) => Number.isFinite(mapId))
    .sort((left, right) => left - right);
  const others = input.strategy
    ? ids
        .filter(
          (mapId) =>
            mapId !== input.mapId &&
            (input.tactics.maps.get(String(mapId))?.tables.length ?? 0) > 0,
        )
        .map((mapId) => mapView(input, mapId, false))
    : [];
  const plan = input.strategy ? input.lastBossPlan() : null;
  const boss =
    plan === null
      ? null
      : {
          title: `最近一场首领战(${mapName(input, plan.mapId)})`,
          table: ruleTable(plan.table, "首领战规则", true),
          result: plan.result,
        };
  return {
    title,
    status,
    current,
    boss,
    others,
    message: input.strategy ? null : "这一作还没有 AI 玩家，没有战斗策略",
  };
}

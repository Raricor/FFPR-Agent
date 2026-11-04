/**
 * The tactician's dossier (task 42): one monster's stats, resistances, AI script, observed
 * actions, counters, forms, guide sentences and last battle, plus what the party can actually
 * do and what the bag holds. Facts.ts writes these into the fact sheet; the coverage check
 * reads the same party and bag data.
 *
 *     const ai = await MonsterAiCache.load("ff5");
 *     await ai.ensure(pilot, [123]);
 *     enemyDossier({ monsters, ai, elements, guide, records });
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BattleRecord, BattleUnit } from "./battle-record.ts";
import { RESULT_TEXT } from "./battle-record.ts";
import { describeElements, type ElementKnowledge, type EnemyResistances } from "./elements.ts";
import { DEPS } from "./paths.ts";
import type { Guide } from "./guide/kb.ts";
import type { MonsterInfo } from "./bestiary.ts";
import type { Pilot } from "./pilot.ts";
import * as gambit from "./skills/gambit.ts";
import { isMissingFile } from "./errors.ts";
import { isRecord, list, num, records, text, type Json } from "./values.ts";

/** FF5's bridge only has monster AI scripts (0.13.0); every other game skips the cache. */
export const MONSTER_AI_GAME = "ff5";

export function monsterAiPath(game: string): string {
  return join(DEPS, "ds", `monsterai-${game}.json`);
}

export interface MonsterAiAbility {
  readonly id: number | null;
  readonly name: string | null;
  readonly opcode: string;
  readonly rate: number | null;
  /** The StartTable group; null when the ability is outside a random table. */
  readonly table: number | null;
}

/** One monster's cached AI script (`monsterai` reply, bridge 0.13+). */
export interface MonsterAiEntry {
  readonly monster: number;
  readonly name: string | null;
  readonly scriptId: number | null;
  readonly scriptName: string | null;
  readonly source: string | null;
  readonly script: string | null;
  readonly scriptFormat: string | null;
  readonly scriptLength: number | null;
  readonly truncated: boolean;
  readonly abilities: readonly MonsterAiAbility[];
  /** Set by a `battle.ai` push before the script itself is queried. */
  readonly event: boolean;
  /** True once this process asked for the script (a failed read is not retried every call). */
  readonly queried: boolean;
  readonly error?: string;
  readonly at: string;
}

function parseAiAbility(value: unknown): MonsterAiAbility | null {
  if (!isRecord(value)) return null;
  const opcode = text(value.opcode) ?? "";
  if (opcode === "" && num(value.id) === undefined && text(value.name) === undefined) return null;
  return {
    id: num(value.id) ?? null,
    name: text(value.name) ?? text(value.nameKey) ?? null,
    opcode,
    rate: num(value.rate) ?? null,
    table: num(value.table) ?? null,
  };
}

function nowText(): string {
  return new Date().toISOString();
}

/** Narrow a `monsterai` reply; a bridge without the op or an error yields no rows. */
export function parseMonsterAi(reply: unknown): MonsterAiEntry[] {
  const rows = isRecord(reply) && Array.isArray(reply.monsterai) ? reply.monsterai : [];
  const out: MonsterAiEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const monster = num(row.monster);
    if (monster === undefined) continue;
    const error = text(row.error);
    out.push({
      monster,
      name: text(row.name) ?? null,
      scriptId: num(row.scriptId) ?? null,
      scriptName: text(row.scriptName) ?? null,
      source: text(row.source) ?? null,
      script: text(row.script) ?? null,
      scriptFormat: text(row.scriptFormat) ?? null,
      scriptLength: num(row.scriptLength) ?? null,
      truncated: row.truncated === true,
      abilities: list(row.abilities)
        .map(parseAiAbility)
        .filter((ability): ability is MonsterAiAbility => ability !== null),
      event: false,
      queried: true,
      ...(error === undefined ? {} : { error }),
      at: nowText(),
    });
  }
  return out;
}

/**
 * The monster AI scripts, remembered per game in `.deps/ds/monsterai-<game>.json` (task 42:
 * the Wind Shrine's Wing Raptor counters after folding its wings, and the tactician cannot
 * ask during a battle). A bridge older than 0.13 answers no `monsterai`; the cache then stays
 * empty and the fact sheet simply omits the script section.
 */
export class MonsterAiCache {
  readonly game: string;
  readonly path: string | undefined;
  private readonly entries = new Map<number, MonsterAiEntry>();
  private readonly asked = new Set<number>();

  constructor(game: string, path?: string) {
    this.game = game;
    this.path = path;
  }

  static async load(game: string, path?: string, signal?: AbortSignal): Promise<MonsterAiCache> {
    const cache = new MonsterAiCache(game, path);
    if (path === undefined) return cache;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return cache;
      signal?.throwIfAborted();
      throw new Error(`读不了怪物 AI 缓存 ${path}:${String(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return cache; // a half-written cache is not worth stopping the player for
    }
    const source = isRecord(parsed) && isRecord(parsed.monsters) ? parsed.monsters : parsed;
    if (!isRecord(source)) return cache;
    for (const [key, raw] of Object.entries(source)) {
      if (!isRecord(raw)) continue;
      const monster = num(raw.monster) ?? num(key);
      if (monster === undefined) continue;
      cache.entries.set(monster, {
        monster,
        name: text(raw.name) ?? null,
        scriptId: num(raw.scriptId) ?? null,
        scriptName: text(raw.scriptName) ?? null,
        source: text(raw.source) ?? null,
        script: text(raw.script) ?? null,
        scriptFormat: text(raw.scriptFormat) ?? null,
        scriptLength: num(raw.scriptLength) ?? null,
        truncated: raw.truncated === true,
        abilities: list(raw.abilities)
          .map(parseAiAbility)
          .filter((ability): ability is MonsterAiAbility => ability !== null),
        event: raw.event === true,
        queried: raw.queried === true,
        ...(text(raw.error) === undefined ? {} : { error: text(raw.error) }),
        at: text(raw.at) ?? "",
      });
    }
    return cache;
  }

  entry(monster: number | null): MonsterAiEntry | null {
    return monster === null ? null : (this.entries.get(monster) ?? null);
  }

  all(): readonly MonsterAiEntry[] {
    return [...this.entries.values()];
  }

  /** Fold a `battle.ai` push: it says a script exists before the body is queried. */
  recordEvent(raw: Json): void {
    const monster = num(raw.monster);
    if (monster === undefined) return;
    const old = this.entries.get(monster);
    this.entries.set(monster, {
      monster,
      name: old?.name ?? null,
      scriptId: old?.scriptId ?? num(raw.scriptId) ?? null,
      scriptName: old?.scriptName ?? text(raw.scriptName) ?? null,
      source: old?.source ?? "event",
      script: old?.script ?? null,
      scriptFormat: old?.scriptFormat ?? null,
      scriptLength: old?.scriptLength ?? num(raw.length) ?? null,
      truncated: old?.truncated ?? false,
      abilities: old?.abilities ?? [],
      event: true,
      queried: old?.queried ?? false,
      at: old?.at ?? nowText(),
    });
  }

  /**
   * Ask for the scripts of monsters not read yet. A query failure (bridge < 0.13, no battle,
   * a script not loaded) leaves the cache unchanged; the next call may still get it.
   */
  async ensure(pilot: Pilot, monsters: readonly number[], signal?: AbortSignal): Promise<void> {
    if (this.game !== MONSTER_AI_GAME || monsters.length === 0) return;
    const wanted = [...new Set(monsters)].filter(
      (monster) => !this.asked.has(monster) && this.entries.get(monster)?.queried !== true,
    );
    if (wanted.length === 0) return;
    for (const monster of wanted) this.asked.add(monster);
    let reply: unknown;
    try {
      reply = await pilot.query("monsterai", { ids: wanted });
    } catch {
      signal?.throwIfAborted();
      return;
    }
    signal?.throwIfAborted();
    const rows = parseMonsterAi(reply);
    if (rows.length === 0) return;
    for (const row of rows) {
      const old = this.entries.get(row.monster);
      this.entries.set(row.monster, {
        ...row,
        name: row.name ?? old?.name ?? null,
        scriptId: row.scriptId ?? old?.scriptId ?? null,
        scriptName: row.scriptName ?? old?.scriptName ?? null,
        event: old?.event ?? false,
      });
    }
    await this.save();
  }

  async save(): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    const monsters: Record<string, MonsterAiEntry> = {};
    for (const [monster, entry] of this.entries) monsters[String(monster)] = entry;
    try {
      await writeFile(this.path, JSON.stringify({ game: this.game, monsters }, null, 1), "utf8");
    } catch (error) {
      throw new Error(`写不了怪物 AI 缓存 ${this.path}:${String(error)}`, { cause: error });
    }
  }
}

/** What a monster's cached script says it can do, for the "counter / form" coverage check. */
export interface ScriptFeatures {
  readonly counters: boolean;
  readonly transforms: boolean;
  readonly groups: readonly { readonly table: number; readonly abilities: readonly string[] }[];
  readonly attacks: readonly string[];
}

export function scriptFeatures(entry: MonsterAiEntry | null): ScriptFeatures {
  if (entry === null) return { counters: false, transforms: false, groups: [], attacks: [] };
  const script = entry.script ?? "";
  const groups = new Map<number, string[]>();
  const attacks: string[] = [];
  for (const ability of entry.abilities) {
    const name = ability.name ?? (ability.id === null ? "" : `能力 ${ability.id}`);
    if (name !== "" && !attacks.includes(name)) attacks.push(name);
    if (ability.table !== null) {
      groups.set(ability.table, [...(groups.get(ability.table) ?? []), name]);
    }
  }
  return {
    counters:
      /CounterAct|FinalAttackAct|Counter/iu.test(script) ||
      entry.abilities.some((ability) => /Counter/iu.test(ability.opcode)),
    transforms:
      /ChangeMonster|ChangeEnemy|Transform|変身|变身/iu.test(script) ||
      entry.abilities.some((ability) => /Change|Transform/iu.test(ability.opcode)),
    groups: [...groups].map(([table, abilities]) => ({ table, abilities })),
    attacks,
  };
}

/** One monster as the fact sheet names it. */
export interface DossierMonster {
  readonly name: string;
  readonly book: number | null;
  /** The battle form's number (281/282 are the same Wing Raptor, 11-03). */
  readonly id: number | null;
  readonly maxHp: number | null;
  readonly info?: MonsterInfo | null;
  /** Boss names from the guide, before a battle row exists (boss-prep). */
  readonly boss?: boolean;
}

export interface DossierInput {
  readonly monsters: readonly DossierMonster[];
  readonly ai: MonsterAiCache | null;
  readonly elements: ElementKnowledge;
  readonly guide: Guide | null;
  readonly records: readonly BattleRecord[];
  /** The guide's own sentences when the bestiary number is unknown (boss-prep). */
  readonly nameNotes?: ReadonlyMap<string, string>;
}

function statText(monster: DossierMonster): string {
  const info = monster.info;
  const stats: string[] = [];
  if (info?.lv != null && info.lv > 0) stats.push(`Lv ${info.lv}`);
  const hp = info?.hp ?? monster.maxHp;
  if (hp !== null) stats.push(`HP ${hp}`);
  if (info?.mp != null) stats.push(`MP ${info.mp}`);
  if (info?.exp != null) stats.push(`经验 ${info.exp}`);
  if (info?.gil != null) stats.push(`金钱 ${info.gil}`);
  if (info?.boss === true || monster.boss === true) stats.push("首领");
  return stats.length > 0 ? stats.join(" · ") : "能力值没读到";
}

function resistText(monster: DossierMonster, elements: ElementKnowledge): string {
  const known = elements.lookup({
    ...(monster.book === null ? {} : { book: monster.book }),
    name: monster.name,
  });
  const parts: string[] = [];
  if (known !== null) parts.push(describeElements(known));
  const immune = monster.info?.conditions ?? [];
  if (immune.length > 0) parts.push(`状态免疫:${immune.slice(0, 8).join("、")}`);
  return parts.length > 0 ? parts.join(";") : "属性未知";
}

function abilityLine(entry: MonsterAiEntry): string[] {
  const lines: string[] = [];
  const groups = scriptFeatures(entry).groups;
  const inGroups = new Set(groups.flatMap((group) => group.abilities));
  for (const group of groups) {
    const named = group.abilities.map((name) => {
      const ability = entry.abilities.find((item) => (item.name ?? "") === name);
      return ability?.rate == null ? name : `${name}(${ability.rate}%)`;
    });
    lines.push(`第 ${group.table} 组:${named.join("、")}`);
  }
  const loose = entry.abilities
    .filter((ability) => ability.name !== null && !inGroups.has(ability.name))
    .map((ability) => (ability.rate == null ? ability.name : `${ability.name}(${ability.rate}%)`));
  if (loose.length > 0) lines.push(loose.join("、"));
  if (lines.length === 0 && entry.error !== undefined) lines.push(`查不到:${entry.error}`);
  if (lines.length === 0) lines.push("脚本里没有认出的招");
  return lines;
}

function unitMatches(unit: BattleUnit, monster: DossierMonster): boolean {
  if (monster.book !== null && unit.book === monster.book) return true;
  return unit.name === monster.name;
}

function lastRecordFor(
  recordsList: readonly BattleRecord[],
  monster: DossierMonster,
): BattleRecord | null {
  for (let index = recordsList.length - 1; index >= 0; index--) {
    const record = recordsList[index];
    if (record?.enemies.some((enemy) => unitMatches(enemy, monster)) === true) {
      return record;
    }
  }
  return null;
}

function enemyActions(record: BattleRecord, monster: DossierMonster): string[] {
  const names = new Set<string>();
  for (const event of record.events) {
    if (event.kind !== "battle.act" || event.actor !== monster.name || event.action === "")
      continue;
    names.add(event.action + (event.counter ? "(反击)" : ""));
  }
  return [...names];
}

function firstFallen(record: BattleRecord): string {
  for (const turn of record.turns) {
    for (const change of turn.changes) {
      if (
        change.side === "party" &&
        change.hp !== undefined &&
        change.hp.to <= 0 &&
        change.hp.from > 0
      ) {
        return change.name;
      }
    }
  }
  return "";
}

function ruleCounts(record: BattleRecord): string {
  const hits = new Map<number, number>();
  const skips = new Map<string, number>();
  for (const turn of record.turns) {
    if (turn.rule > 0) hits.set(turn.rule, (hits.get(turn.rule) ?? 0) + 1);
    for (const skip of turn.skipped) {
      const why = `${skip.rule}:${skip.why}`;
      skips.set(why, (skips.get(why) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  if (hits.size > 0) {
    parts.push("触发 " + [...hits].map(([rule, count]) => `规则${rule} ${count} 次`).join("、"));
  }
  if (skips.size > 0) {
    parts.push("跳过 " + [...skips].map(([why, count]) => `${why} ${count} 次`).join("、"));
  }
  return parts.length > 0 ? parts.join(";") : "没有规则记录";
}

function recordSummary(record: BattleRecord, monster: DossierMonster): string {
  const parts = [
    `${record.kind === "boss" ? "首领战" : "普通战"}:${RESULT_TEXT[record.result]}(${record.detail})`,
    ruleCounts(record),
  ];
  const gaps = record.summary.gaps ?? [];
  if (gaps.length > 0) {
    parts.push("缺口:" + gaps.map((gap) => `${gap.item} ${gap.held} 个`).join("、"));
  }
  const actions = enemyActions(record, monster);
  if (actions.length > 0) parts.push(`它用过:${actions.join("、")}`);
  else parts.push("它用过:记录里没有它的出招");
  const fallen = firstFallen(record);
  if (fallen !== "") parts.push(`先倒:${fallen}`);
  else if (record.result === "wipe") parts.push("先倒:记录里没有倒下顺序");
  return parts.join(";");
}

function formsOf(monster: DossierMonster, recordsList: readonly BattleRecord[]): number[] {
  const ids = new Set<number>();
  if (monster.id !== null) ids.add(monster.id);
  for (const record of recordsList) {
    for (const enemy of record.enemies) {
      if (enemy.name !== monster.name || enemy.id === null) continue;
      ids.add(enemy.id);
    }
  }
  return [...ids].sort((left, right) => left - right);
}

function counterFromRecords(
  monster: DossierMonster,
  recordsList: readonly BattleRecord[],
): boolean {
  return recordsList.some(
    (record) =>
      record.enemies.some((enemy) => unitMatches(enemy, monster)) &&
      record.events.some((event) => event.actor === monster.name && event.counter),
  );
}

/** The short battle record the debrief fact sheet carries (task 42). */
export function battleRecordSummary(record: BattleRecord): string {
  const enemyActions = [
    ...new Set(
      record.events
        .filter((event) => event.kind === "battle.act" && event.action !== "")
        .map((event) => `${event.actor}→${event.action}${event.counter ? "(反击)" : ""}`),
    ),
  ];
  const parts = [
    `${record.kind === "boss" ? "首领战" : "普通战"}:${RESULT_TEXT[record.result]}(${record.detail})`,
    `共 ${record.turns.length} 回合`,
    ruleCounts(record),
  ];
  const gaps = record.summary.gaps ?? [];
  if (gaps.length > 0) {
    parts.push("缺口:" + gaps.map((gap) => `${gap.item} ${gap.held} 个`).join("、"));
  }
  parts.push(`敌人用过:${enemyActions.length > 0 ? enemyActions.join("、") : "记录里没有"}`);
  const fallen = firstFallen(record);
  if (fallen !== "") parts.push(`谁先倒:${fallen}`);
  return parts.join(";");
}

/** One monster's dossier entry; the guide note and the last battle are the parts code cannot infer. */
export function monsterDossierLines(input: DossierInput): string[] {
  const lines: string[] = [];
  for (const monster of input.monsters) {
    const id = monster.id === null ? "" : `(编号 ${monster.id})`;
    const book =
      monster.book === null ? "图鉴号 ?" : `图鉴 #${String(monster.book).padStart(3, "0")}`;
    const known = input.elements.lookup({
      ...(monster.book === null ? {} : { book: monster.book }),
      name: monster.name,
    });
    const hp = monster.info?.hp ?? monster.maxHp;
    const first =
      `- ${monster.name}${id} ${book}` +
      ` HP ${hp ?? "?"} ${known === null ? "属性未知" : describeElements(known)}`;
    lines.push(first);
    lines.push(`  能力值:${statText(monster)}`);
    lines.push(`  属性:${resistText(monster, input.elements)}`);
    const aiMonster = monster.info?.monster ?? monster.book;
    const entry = input.ai?.entry(aiMonster ?? null) ?? null;
    const features = scriptFeatures(entry);
    if (entry !== null) {
      lines.push("  会用的招(AI 脚本):" + abilityLine(entry).join(";"));
    } else {
      lines.push("  会用的招(AI 脚本):没有缓存(桥插件早于 0.13 或还没查到)");
    }
    const actions = input.records.flatMap((record) =>
      enemyActions(record, monster).filter((action) => !action.endsWith("(反击)")),
    );
    const observed = [...new Set(actions)];
    if (observed.length > 0) lines.push(`  实战见过:${observed.join("、")}`);
    const counters = features.counters || counterFromRecords(monster, input.records);
    if (counters) lines.push("  反击:有(合翅膀/受击后用反击,别在它反击的形态平砍)");
    const forms = formsOf(monster, input.records);
    if (forms.length > 1) {
      lines.push(`  变身:编号 ${forms.join(" → ")}(同一只怪的不同形态)`);
    } else if (features.transforms) {
      lines.push("  变身:AI 脚本里有变身");
    }
    const absorbed = input.elements.lookup({
      ...(monster.book === null ? {} : { book: monster.book }),
      name: monster.name,
    });
    if (absorbed !== null && absorbed.absorb.length > 0) {
      lines.push(`  吸收:${absorbed.absorb.join("、")}(这些属性不要用)`);
    }
    const note =
      monster.book === null || input.guide === null
        ? (input.nameNotes?.get(monster.name) ?? "")
        : input.guide.monsterNote(monster.book, 1500);
    if (note !== "") lines.push(`  攻略:${note}`);
    const record = lastRecordFor(input.records, monster);
    if (record !== null) lines.push(`  上次和它打:${recordSummary(record, monster)}`);
    else lines.push("  上次和它打:还没有战斗记录");
  }
  return lines;
}

/** A status a monster's script, guide sentence or observed actions can inflict. */
export function monsterStatuses(input: DossierInput): string[] {
  const found = new Set<string>();
  const knownStatuses = Object.keys(gambit.CURES);
  const addText = (value: string): void => {
    for (const status of knownStatuses) if (value.includes(status)) found.add(status);
  };
  for (const monster of input.monsters) {
    const entry = input.ai?.entry(monster.info?.monster ?? monster.book ?? null) ?? null;
    for (const ability of entry?.abilities ?? []) {
      addText(ability.name ?? "");
      addText(ability.opcode);
    }
    if (entry?.script != null) addText(entry.script);
    if (monster.book !== null && input.guide !== null) {
      addText(input.guide.monsterNote(monster.book, 1500));
    }
    addText(input.nameNotes?.get(monster.name) ?? "");
    for (const record of input.records) {
      for (const event of record.events) {
        if (event.actor !== monster.name) continue;
        addText(event.action);
        addText(event.detail ?? "");
      }
    }
  }
  return [...found];
}

/** Element an enemy absorbs, for the coverage check's absorb mention. */
export function absorbedElements(
  monsters: readonly DossierMonster[],
  elements: ElementKnowledge,
): string[] {
  const out: string[] = [];
  for (const monster of monsters) {
    const known: EnemyResistances | null = elements.lookup({
      ...(monster.book === null ? {} : { book: monster.book }),
      name: monster.name,
    });
    for (const element of known?.absorb ?? []) if (!out.includes(element)) out.push(element);
  }
  return out;
}

/* ------------------------------------------------------------------ party and bag */

export interface PartyAbility {
  readonly name: string;
  readonly type: number | null;
  readonly mp: number | null;
}

export interface PartyMember {
  readonly name: string;
  readonly job: string;
  readonly lv: number | null;
  readonly hp: number;
  readonly maxHp: number;
  readonly mp: number;
  readonly maxMp: number;
  readonly status: readonly string[];
  /** Commands the character can pick now: 攻击/防御/道具 plus the job's magic. */
  readonly commands: readonly string[];
  readonly abilities: readonly PartyAbility[];
  readonly equipment: readonly string[];
}

export const JOB_MAGIC: Readonly<Record<string, readonly string[]>> = {
  白魔法师: ["白魔法"],
  黑魔法师: ["黑魔法"],
  时魔法师: ["时魔法"],
  魔法剑士: ["魔法剑"],
  红魔法师: ["白魔法", "黑魔法"],
};

const MAGIC_TYPES: Readonly<Record<number, string>> = {
  1: "白魔法",
  2: "黑魔法",
  501: "时魔法",
  502: "魔法剑",
};
const MAGIC_ORDER: readonly string[] = ["白魔法", "黑魔法", "时魔法", "魔法剑"];

function cleanAbilityName(value: string | undefined): string {
  return (value ?? "").replace(/<[^>]*>/g, "").trim();
}

function readAbilities(member: Json): PartyAbility[] {
  const out: PartyAbility[] = [];
  for (const row of records(member.abilities)) {
    const name = cleanAbilityName(text(row.name));
    if (name === "") continue;
    out.push({ name, type: num(row.type) ?? null, mp: num(row.mp) ?? null });
  }
  return out;
}

function readCommands(member: Json, job: string, abilities: readonly PartyAbility[]): string[] {
  const out: string[] = ["攻击", "防御", "道具"];
  const fromBridge = list(member.commands)
    .map((value) => (isRecord(value) ? (text(value.name) ?? text(value.id)) : text(value)))
    .filter((value): value is string => value !== undefined && value !== "");
  for (const command of fromBridge) if (!out.includes(command)) out.push(command);
  for (const kind of JOB_MAGIC[job] ?? []) if (!out.includes(kind)) out.push(kind);
  for (const ability of abilities) {
    const kind = ability.type === null ? null : (MAGIC_TYPES[ability.type] ?? null);
    if (kind !== null && !out.includes(kind)) out.push(kind);
  }
  return out;
}

function readEquipment(member: Json): string[] {
  const source = isRecord(member.equipment)
    ? member.equipment
    : isRecord(member.equip)
      ? member.equip
      : null;
  const rows = source === null ? [] : records(source.slots);
  const slots = rows.length > 0 ? rows : records(source);
  return slots
    .map((slot) => text(slot.item) ?? text(slot.name) ?? "")
    .filter((name) => name !== "");
}

/** The party as the fact sheet and the coverage check read it. */
export function readParty(sample: Json): PartyMember[] {
  const party = records(sample.party);
  return party.map((member) => {
    const job =
      text(member.jobName) ?? (num(member.job) === undefined ? "?" : `职业${num(member.job)}`);
    const abilities = readAbilities(member);
    return {
      name: text(member.name) ?? "",
      job,
      lv: num(member.lv) ?? null,
      hp: num(member.hp) ?? 0,
      maxHp: num(member.maxHp) ?? 0,
      mp: num(member.mp) ?? 0,
      maxMp: num(member.maxMp) ?? 0,
      status: gambit.statuses(member),
      commands: readCommands(member, job, abilities),
      abilities,
      equipment: readEquipment(member),
    };
  });
}

export function magicKind(ability: PartyAbility): string | null {
  if (ability.type === null || ability.mp === null || ability.mp <= 0) return null;
  return MAGIC_TYPES[ability.type] ?? null;
}

export function magicByKind(
  party: readonly (readonly PartyAbility[])[],
): Map<string, PartyAbility[]> {
  const out = new Map<string, PartyAbility[]>();
  const seen = new Set<string>();
  for (const known of party) {
    for (const ability of known) {
      const kind = magicKind(ability);
      if (kind === null) continue;
      const key = `${kind}\u0000${ability.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spells = out.get(kind) ?? [];
      spells.push(ability);
      out.set(kind, spells);
    }
  }
  return out;
}

export { MAGIC_ORDER };

export function abilityText(ability: PartyAbility): string {
  return ability.mp === null ? ability.name : `${ability.name}(${ability.mp}MP)`;
}

/** What the bag holds for the fight: healing, revival, status cures. */
export interface BagInfo {
  readonly held: Readonly<Record<string, number>>;
  readonly revive: readonly (readonly [string, number])[];
  readonly heal: readonly (readonly [string, number])[];
  readonly cures: readonly (readonly [string, number])[];
  count(item: string): number;
}

export function readBag(held: Readonly<Record<string, number>>): BagInfo {
  const entries = Object.entries(held).filter(([, count]) => count > 0);
  const cureNames = new Set(Object.values(gambit.CURES).map(([, item]) => item));
  const revive = entries.filter(([name]) => /不死鸟|Phoenix/i.test(name));
  const cure = entries.filter(([name]) =>
    [...cureNames].some((item) => item === name || name.includes(item) || item.includes(name)),
  );
  const heal = entries.filter(([name]) =>
    /恢复药|高级恢复药|以太|帐篷|Potion|Ether|Tent/i.test(name),
  );
  return {
    held,
    revive,
    heal,
    cures: cure,
    count(item: string): number {
      let total = 0;
      for (const [name, count] of entries) {
        if (name === item || name.includes(item) || item.includes(name)) total += count;
      }
      return total;
    },
  };
}

/** The Chinese bag lines; the wording is the first layer's fact sheet, unchanged (task 42). */
export function bagText(bag: BagInfo): string {
  const lines: string[] = [];
  if (bag.heal.length > 0) lines.push(`回复:${amounts(bag.heal)}`);
  if (bag.revive.length > 0) lines.push(`复活:${amounts(bag.revive)}`);
  if (bag.cures.length > 0) lines.push(`治状态:${amounts(bag.cures)}`);
  return lines.length > 0 ? lines.join(";") : "回复、复活、治状态的道具都没有。";
}

function amounts(entries: readonly (readonly [string, number])[]): string {
  return entries.map(([name, count]) => `${name}×${count}`).join("、");
}

export function equipmentText(member: PartyMember): string {
  return member.equipment.length > 0 ? `装备:${member.equipment.join("、")}` : "装备:没读到";
}

/** Commands for one character in a table, for the party-changed trigger. */
export interface PartySnapshotMember {
  readonly name: string;
  readonly job: string;
  readonly commands: readonly string[];
}

export function partySnapshot(members: readonly PartyMember[]): PartySnapshotMember[] {
  return members.map((member) => ({
    name: member.name,
    job: member.job,
    commands: [...member.commands],
  }));
}

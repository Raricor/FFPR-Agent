/**
 * The tactician's fact sheet (control plan §4.12): everything the second layer needs to write
 * battle rules for one map, gathered by code and written in Chinese. The engine does not know
 * that the other side is a dsh subagent; it only hands this text to the caller.
 *
 *     const facts = await buildFacts(game, { kind: "new-map", mapId, pilot, detail: "" });
 *     const plan = await tactician(facts); // 1–3 rule tables, walker notes, advice upwards
 */

import type { Atlas } from "./atlas.ts";
import { describeElements, type ElementKnowledge } from "./elements.ts";
import type { KeyEvents } from "./events.ts";
import type { Guide } from "./guide/kb.ts";
import type { Pilot } from "./pilot.ts";
import { FF5_PROFILE } from "./profiles/ff5.ts";
import type { Tactics } from "./tactics.ts";
import { formationLines, encounterMonsters, parseEncounters } from "./encounters.ts";
import { enemyFacts } from "./tactics-view.ts";
import { elementNames, type MonsterCache, type MonsterInfo } from "./bestiary.ts";
import * as gambit from "./skills/gambit.ts";
import * as battle from "./skills/battle.ts";
import { isRecord, num, records, record, text, type Json } from "./values.ts";
import { describeEvents } from "./view.ts";

export const GUIDE_FACTS_LIMIT = 6000;

/** Which magic a job may cast; the bridge's ability types say which spells exist (10-27). */
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

/** Why the tactician was called; the wording is what the fact sheet's 起因 says. */
export type TriggerKind =
  "new-map" | "new-monster" | "bad-battle" | "blocked" | "conveyor" | "boss";

export interface TriggerReason {
  readonly kind: TriggerKind;
  readonly mapId: number;
  readonly detail: string;
  /** The monsters that appeared after the tables were written (new-monster only). */
  readonly monsters?: readonly string[];
}

/** A reason plus the call's pilot and, for a boss, the battle it is being called for. */
export interface FactsTrigger extends TriggerReason {
  readonly pilot: Pilot;
  readonly battle?: Json;
}

/** What the second layer returns: tables already normalized, notes, and advice upwards. */
export interface TacticianPlan {
  readonly tables: Json[];
  readonly walkerNotes: string;
  readonly askUp: string;
}

/** The game data buildFacts reads; Game satisfies it, tests can build it directly. */
export interface FactsGame {
  readonly events: KeyEvents | undefined;
  readonly atlas: Atlas;
  readonly tactics: Tactics;
  readonly elements: ElementKnowledge;
  readonly guide: Guide | null;
  readonly mapId: number | null;
  readonly monsterCache?: MonsterCache;
}

export interface TriggerState {
  readonly mapId: number | null;
  readonly tactics: Tactics;
  /** Monsters this map has shown, from the event stream. */
  readonly met: readonly string[];
  readonly lastBattle?: {
    readonly mapId: number | null;
    readonly verdict: string;
    readonly detail: string;
  } | null;
  readonly blocked?: { readonly count: number; readonly detail: string } | null;
  readonly ride?: string | null;
  /** The map's name in the atlas ("卡纳克镇 旅店"); the area is the part before the space. */
  readonly mapName?: string;
  /** Town areas the tactician already covered on one of their maps. */
  readonly townsCovered?: ReadonlySet<string>;
}

/** "卡纳克镇 旅店" -> "卡纳克镇": the inn, the shops and the pub belong to the town. */
export function areaOf(mapName: string): string {
  return mapName.trim().split(/\s+/u)[0] ?? "";
}

/**
 * Towns and villages have no random battles, so one tactician call covers all their maps
 * (10-27: Karnak's town, inn and two shop floors took four calls of 14-22 s each for tables
 * no battle would use). Castles are not towns: Karnak Castle had guards and monsters.
 */
export function isTown(area: string): boolean {
  return /[镇村]$/u.test(area);
}

const BAD = new Set(["hard", "lost"]);

/**
 * Which of the code-enforced moments calls the tactician next, or null. Boss battles are not
 * here: settle() handles them before the rest of the tool result is assembled.
 */
export function chooseTrigger(state: TriggerState): TriggerReason | null {
  const mapId = state.mapId;
  if (mapId === null || mapId === 1) return null;
  if (!state.tactics.has(mapId)) {
    const area = areaOf(state.mapName ?? "");
    if (isTown(area) && state.townsCovered?.has(area)) return null;
    return { kind: "new-map", mapId, detail: "这张地图还没有战斗策略" };
  }
  const stored = state.tactics.monstersSeen(mapId);
  const fresh = [...new Set(state.met)].filter((monster) => !stored.includes(monster)).sort();
  if (fresh.length > 0) {
    return {
      kind: "new-monster",
      mapId,
      detail: `写战术时还没见过:${fresh.join("、")}`,
      monsters: fresh,
    };
  }
  const last = state.lastBattle;
  if (last?.mapId === mapId && BAD.has(last.verdict)) {
    return { kind: "bad-battle", mapId, detail: `${last.verdict}:${last.detail}` };
  }
  if (state.blocked && state.blocked.count >= 3) {
    return { kind: "blocked", mapId, detail: state.blocked.detail };
  }
  if (state.ride) {
    return { kind: "conveyor", mapId, detail: state.ride };
  }
  return null;
}

/** One `limit`-sized prefix of the guide, saying what was left out. */
export function shortenGuide(text: string, limit = GUIDE_FACTS_LIMIT): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return characters.slice(0, limit).join("") + "\n…(攻略太长,后面省略)";
}

/** The fact sheet: 起因, 地图, 攻略, 怪物, 队伍, 背包, 上次战斗. */
export async function buildFacts(game: FactsGame, trigger: FactsTrigger): Promise<string> {
  const sample = await sampleOf(game, trigger.pilot);
  const user = record(sample.user);
  const area = text(user.areaText) ?? text(user.locationText) ?? "";
  const mapId = trigger.mapId;
  const map = game.atlas.maps.get(String(mapId));
  const mapName = text(map?.name) ?? area;
  const battleRows = records(trigger.battle?.enemies);
  const met = monstersMet(game, mapId, battleRows);
  const encounter = await encounterText(game, trigger);
  const sections: string[] = [
    "你是战术官。下面是代码整理的事实单,只为这张地图写战术。",
    "### 起因\n" + causeText(trigger),
    "### 地图\n" + (await mapText(game, trigger.pilot, mapId, mapName)),
    "### 攻略\n" + guideText(game.guide, area, mapName),
    "### 怪物\n" + monsterText(game, met, battleRows),
  ];
  if (encounter !== "") sections.push(encounter);
  sections.push(
    "### 队伍\n" + partyText(sample),
    "### 背包\n" + (await bagText(trigger.pilot)),
    "### 上次战斗\n" + resultsText(game.tactics, mapId),
  );
  const uncast = uncastMagicText(sample);
  return sections.join("\n\n") + (uncast !== "" ? `\n\n${uncast}` : "");
}

/** Read a schema-validated structured reply as a plan; throws a Chinese error when malformed. */
export function readTacticianPlan(value: unknown): TacticianPlan {
  if (!isRecord(value)) throw new Error("战术官没有交回结构化结果");
  if (!Array.isArray(value.tactics)) throw new Error("战术官的结果里 tactics 不是数组");
  const tables: Json[] = [];
  for (const [index, table] of value.tactics.entries()) {
    if (!isRecord(table)) throw new Error(`战术官的第 ${index + 1} 套规则表不是对象`);
    tables.push(gambit.normalize(table));
  }
  if (typeof value.walker_notes !== "string") throw new Error("战术官的结果里没有 walker_notes");
  if (typeof value.ask_up !== "string") throw new Error("战术官的结果里没有 ask_up");
  return { tables, walkerNotes: value.walker_notes.trim(), askUp: value.ask_up.trim() };
}

/** The current map's encounter table, when the bridge has one; older bridges have no op. */
async function encounterText(game: FactsGame, trigger: FactsTrigger): Promise<string> {
  if (trigger.mapId !== game.mapId) return "";
  let table;
  try {
    table = parseEncounters(await trigger.pilot.query("encounters"));
  } catch {
    return "";
  }
  const lines = formationLines(table);
  if (lines.length === 0) return "";
  const monsters =
    game.monsterCache === undefined ? null : await game.monsterCache.load(trigger.pilot);
  const byBook = new Map<number, MonsterInfo>();
  const byName = new Map<string, MonsterInfo>();
  for (const info of monsters ?? []) {
    if (info.number !== null) byBook.set(info.number, info);
    if (info.name !== null && !byName.has(info.name)) byName.set(info.name, info);
  }
  // The tactician only plays FF5.
  const names = elementNames(monsters ?? [], FF5_PROFILE.elements);
  const rows = encounterMonsters(table).map((monster) => {
    const info = monster.book === null ? byName.get(monster.name) : byBook.get(monster.book);
    return info === undefined
      ? `- ${monster.name}`
      : `- ${monster.name}: ${enemyFacts(info, names)}`;
  });
  return ["### 这里的遇敌表", ...lines, ...rows].join("\n");
}

async function sampleOf(game: FactsGame, pilot: Pilot): Promise<Json> {
  const live = game.events?.liveSample() ?? null;
  if (live !== null) return live;
  return record((await pilot.query("sample")).sample);
}

function causeText(trigger: TriggerReason): string {
  switch (trigger.kind) {
    case "new-map":
      return `进入地图 ${trigger.mapId}:${trigger.detail || "还没有战斗策略"}。`;
    case "new-monster":
      return `这张地图出现了写战术时没见过的怪:${trigger.monsters?.join("、") ?? trigger.detail}。`;
    case "bad-battle":
      return `上一场战斗评为 hard 或 lost(${trigger.detail}),需要改表。`;
    case "blocked":
      return `在同一处被挡住 3 次:${trigger.detail}。`;
    case "conveyor":
      return `被传送带带走:${trigger.detail}。`;
    case "boss":
      return `首领战开始:${trigger.detail}。写一张首领战的规则表。`;
  }
}

async function mapText(
  game: FactsGame,
  pilot: Pilot,
  mapId: number,
  mapName: string,
): Promise<string> {
  const map = game.atlas.maps.get(String(mapId));
  const exits = records(map?.exits).map(
    (exit) =>
      `${tupleText(exit.cell)}→地图 ${pyText(exit.to)} ${text(exit.name) ?? ""}` +
      game.atlas.mark(exit.to),
  );
  const chests = records(map?.chests).map(
    (chest) => `${tupleText(chest.cell)} ${text(chest.name) ?? ""}`,
  );
  const entities = record((await pilot.send("entities", { kind: "Event", max: 200 })).entities);
  const events = describeEvents(entities);
  const links = game.atlas.links(mapId);
  const lines = [`地图 ${mapId} ${mapName}`];
  lines.push(`出口:${exits.length > 0 ? exits.join("、") : "没有记录"}`);
  lines.push(`宝箱:${chests.length > 0 ? chests.join("、") : "没有记录"}`);
  lines.push(`带名字的事件格:${events !== "" ? "\n" + events : "没有"}`);
  if (links !== "") lines.push(`地图记录里的走法:${links}`);
  return lines.join("\n");
}

function guideText(guide: Guide | null, area: string, mapName: string): string {
  if (guide === null) return "攻略没有加载。";
  const query = area !== "" ? area : mapName;
  if (query === "") return "不知道这是哪里,查不到攻略。";
  const sections = guide.sectionsFor(query);
  const keys = guide.areasFor(query);
  const exact = sections.filter((section) => keys.includes(section.title));
  const loose = sections.filter((section) => !exact.includes(section));
  // The whole area's chapter: "Fire-Powered Ship: Part I/II" share the prefix; "Tower of
  // Walse" is a separate place and does not start with "Walse".
  const sameArea = loose.filter((section) =>
    keys.some((key) => section.title.toLowerCase().startsWith(key.toLowerCase())),
  );
  const chosen = exact.length > 0 ? exact : sameArea.length > 0 ? sameArea : loose.slice(0, 1);
  if (chosen.length === 0) return `攻略里没有找到「${query}」。`;
  const body = chosen.map((section) => `【${section.title}】\n${section.text}`).join("\n\n");
  return shortenGuide(body);
}

function monstersMet(
  game: FactsGame,
  mapId: number,
  battleRows: readonly Json[],
): { name: string; book: number | null; maxHp: number | null }[] {
  const seen = new Map<string, { name: string; book: number | null; maxHp: number | null }>();
  const fromEvents = game.events?.enemies.get(mapId) ?? new Set<string>();
  for (const name of fromEvents) {
    seen.set(name, { name, book: game.events?.books.get(name) ?? null, maxHp: null });
  }
  for (const enemy of battleRows) {
    const name = text(enemy.name);
    if (name === undefined || name === "") continue;
    const book = num(enemy.book) ?? null;
    const maxHp = num(enemy.maxHp) ?? num(enemy.hp) ?? null;
    const old = seen.get(name);
    seen.set(name, {
      name,
      book: old?.book ?? book,
      maxHp: old?.maxHp ?? maxHp,
    });
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function monsterText(
  game: FactsGame,
  met: readonly { name: string; book: number | null; maxHp: number | null }[],
  battleRows: readonly Json[],
): string {
  if (met.length === 0) return "还没有在这张地图见过怪。";
  const battleByName = new Map(
    battleRows.flatMap((enemy) => {
      const name = text(enemy.name);
      return name === undefined ? [] : [[name, enemy] as const];
    }),
  );
  return met
    .map((enemy) => {
      const book = enemy.book;
      const known = game.elements.lookup({
        ...(book === null ? {} : { book }),
        name: enemy.name,
      });
      const hp = enemy.maxHp ?? guideHp(game.guide, book, enemy.name);
      const row = battleByName.get(enemy.name);
      const rowHp = row === undefined ? null : (num(row.maxHp) ?? num(row.hp) ?? null);
      const label = book === null ? "图鉴号 ?" : `图鉴 #${String(book).padStart(3, "0")}`;
      const parts = [
        `- ${enemy.name} ${label}`,
        `HP ${hp ?? rowHp ?? "?"}`,
        known === null ? "属性未知" : describeElements(known),
      ];
      const note = book === null || game.guide === null ? "" : game.guide.monsterNote(book);
      return parts.join(" ") + (note !== "" ? `\n  攻略:${note}` : "");
    })
    .join("\n");
}

function guideHp(guide: Guide | null, book: number | null, name: string): number | null {
  if (guide === null) return null;
  for (const chapter of guide.ludo) {
    for (const monster of chapter.monsters) {
      const byBook = book !== null && monster.book === book;
      const byName = monster.name.toLowerCase() === name.toLowerCase();
      if (byBook || byName) return monster.hp;
    }
  }
  return null;
}

function partyText(sample: Json): string {
  const party = records(sample.party);
  if (party.length === 0) return "读不到队伍。";
  const abilities = party.map(memberAbilities);
  const magic = magicByKind(abilities);
  const hasAbilities = abilities.some((known) => known.length > 0);
  const lines: string[] = [];
  if (magic.size > 0) {
    lines.push("全队的魔法:");
    for (const kind of MAGIC_ORDER) {
      const spells = magic.get(kind);
      if (spells === undefined || spells.length === 0) continue;
      lines.push(`- ${kind}:` + spells.map(spellText).join("、"));
    }
  }
  party.forEach((member, index) => {
    const name = pyText(member.name);
    const job =
      text(member.jobName) ?? (num(member.job) === undefined ? "?" : `职业${num(member.job)}`);
    const status = gambit.statuses(member);
    const known = abilities[index] ?? [];
    const castable = (JOB_MAGIC[job] ?? []).filter((kind) => (magic.get(kind)?.length ?? 0) > 0);
    const own = known.filter((ability) => magicKind(ability) === null);
    lines.push(
      `- ${name} ${job} Lv${pyText(member.lv)} ` +
        `HP ${pyText(member.hp)}/${pyText(member.maxHp)} MP ${pyText(member.mp)}/${pyText(member.maxMp)}` +
        (status.length > 0 ? ` 状态:${status.join("、")}` : "") +
        (castable.length > 0 ? ` 能放:${castable.join("、")}` : "") +
        (own.length > 0
          ? ` 能力:${[...new Set(own.map((ability) => ability.name))].join("、")}`
          : ""),
    );
  });
  const joined = lines.join("\n");
  return hasAbilities
    ? joined
    : joined + "\n(桥插件这次没有给已学法术;写表用「最强」「X+」和职业指令。)";
}

interface Ability {
  readonly name: string;
  readonly type: number | null;
  readonly mp: number | null;
}

function memberAbilities(member: Json): Ability[] {
  const out: Ability[] = [];
  for (const row of records(member.abilities)) {
    const name = cleanAbilityName(text(row.name));
    if (name === "") continue;
    out.push({ name, type: num(row.type) ?? null, mp: num(row.mp) ?? null });
  }
  return out;
}

function cleanAbilityName(value: string | undefined): string {
  return (value ?? "").replace(/<[^>]*>/g, "").trim();
}

function magicKind(ability: Ability): string | null {
  if (ability.type === null || ability.mp === null || ability.mp <= 0) return null;
  return MAGIC_TYPES[ability.type] ?? null;
}

function magicByKind(party: readonly Ability[][]): Map<string, Ability[]> {
  const out = new Map<string, Ability[]>();
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

function spellText(ability: Ability): string {
  return ability.mp === null ? ability.name : `${ability.name}(${ability.mp}MP)`;
}

/** Team spells nobody's current job can cast: switching jobs would make them usable. */
function uncastMagicText(sample: Json): string {
  const party = records(sample.party);
  if (party.length === 0) return "";
  const magic = magicByKind(party.map(memberAbilities));
  const castable = new Set(party.flatMap((member) => JOB_MAGIC[text(member.jobName) ?? ""] ?? []));
  const lines: string[] = [];
  for (const kind of MAGIC_ORDER) {
    const spells = magic.get(kind);
    if (spells === undefined || spells.length === 0 || castable.has(kind)) continue;
    lines.push(`${kind} ` + spells.map((spell) => spell.name).join("、"));
  }
  return lines.length > 0
    ? "队伍有但现在没人能放的魔法：" + lines.join(";") + "(换职业才能用)"
    : "";
}

async function bagText(pilot: Pilot): Promise<string> {
  const held = await battle.heldItems(pilot);
  const entries = Object.entries(held).filter(([, count]) => count > 0);
  const cures = new Set(Object.values(gambit.CURES).map(([, item]) => item));
  const revive = entries.filter(([name]) => /不死鸟|Phoenix/i.test(name));
  const cure = entries.filter(([name]) => [...cures].some((item) => holds(name, item)));
  const heal = entries.filter(([name]) =>
    /恢复药|高级恢复药|以太|帐篷|Potion|Ether|Tent/i.test(name),
  );
  const lines: string[] = [];
  if (heal.length > 0) lines.push(`回复:${amounts(heal)}`);
  if (revive.length > 0) lines.push(`复活:${amounts(revive)}`);
  if (cure.length > 0) lines.push(`治状态:${amounts(cure)}`);
  return lines.length > 0 ? lines.join(";") : "回复、复活、治状态的道具都没有。";
}

function holds(name: string, item: string): boolean {
  return name.includes(item) || item.includes(name);
}

function amounts(entries: readonly (readonly [string, number])[]): string {
  return entries.map(([name, count]) => `${name}×${count}`).join("、");
}

function resultsText(tactics: Tactics, mapId: number): string {
  const results = tactics.resultsFor(mapId).slice(-5);
  if (results.length === 0) return "这张地图还没有战斗记录。";
  return results
    .map(
      (result) =>
        `- 第 ${pyText(Number(result.table) + 1)} 套:${pyText(result.verdict)}(${pyText(result.detail)})`,
    )
    .join("\n");
}

function tupleText(value: unknown): string {
  if (!Array.isArray(value)) return pyText(value);
  return `(${value.map((item) => pyText(item)).join(", ")})`;
}

function pyText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) || "";
}

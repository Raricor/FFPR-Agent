/**
 * Checks for one segment plan (task 137, 11-11). The model writes the plan once; code has to
 * reject a plan that cannot be executed before the party walks into it. This module checks the
 * shape, the station targets, grind stops, preparation, battle/boss tables and turn-back
 * conditions, and returns Chinese problems plus a `fixed` copy for small automatic fixes.
 *
 * Pure: no bridge, no file, no clock. The rule tables go through the same gambit / strategy 2.0
 * checks the game uses, and `turnBack.when` uses the syntax task 138 executes.
 */

import { cleanIconTags } from "../icons.ts";
import { normalizeName, type Knowledge } from "../knowledge/index.ts";
import { check as checkGambit } from "../skills/gambit.ts";
import { checkStrategy } from "../strategy/strategy.ts";
import { isRecord, num, text } from "../values.ts";
import { segmentFactsKnowledge, type SegmentFactsData, type SegmentFactsMonster } from "./facts.ts";
import type { PlanStation, PlanStationAction, SegmentPlan, SegmentReport } from "./types.ts";

export interface PlanValidation {
  readonly ok: boolean;
  /** Chinese, one line per problem; an empty list means the plan can be used. */
  readonly problems: readonly string[];
  /** Set when a small problem was corrected automatically (for example a missing optional). */
  readonly fixed?: SegmentPlan;
  /** Chinese, one line per thing code will do without being asked (task 144: which shop). */
  readonly notes?: readonly string[];
  /** Task 159: non-blocking concerns (save-point data missing, so the check is only a hint). */
  readonly warnings?: readonly string[];
}

/** Task 146: the previous plan of the game plus the report that ended it. */
export interface PlanRevision {
  readonly plan: SegmentPlan;
  readonly report: SegmentReport;
}

const ACTIONS: ReadonlySet<string> = new Set([
  "move",
  "open",
  "save",
  "heal",
  "talk",
  "switch",
  "story",
  "choose",
  "grind",
  "boss",
  "buy",
]);
const TURN_BACK_THEN: ReadonlySet<string> = new Set(["heal-and-continue", "replan"]);
/** 11-11 live: these need a real cell; a map-only target cannot be investigated. */
const CELL_REQUIRED: ReadonlySet<string> = new Set(["open", "talk", "switch", "choose"]);

/** FF5's job names in the game's Chinese spelling plus the English spellings the guide uses. */
const KNOWN_JOBS: readonly string[] = [
  "自由人",
  "骑士",
  "武僧",
  "盗贼",
  "龙骑士",
  "猎人",
  "吟游诗人",
  "青魔导士",
  "黑魔法师",
  "白魔法师",
  "时魔法师",
  "召唤士",
  "召唤师",
  "红魔法师",
  "赤魔法师",
  "忍者",
  "风水师",
  "魔剑士",
  "魔法剑士",
  "药剂师",
  "铳士",
  "预言士",
  "剑斗士",
  "暗黑骑士",
  "模仿师",
  "亡灵法师",
  "导师",
  "Freelancer",
  "Knight",
  "Monk",
  "Thief",
  "Dragoon",
  "Ranger",
  "Bard",
  "Blue Mage",
  "Black Mage",
  "White Mage",
  "Time Mage",
  "Summoner",
  "Red Mage",
  "Ninja",
  "Geomancer",
  "Mystic Knight",
  "Chemist",
  "Cannoneer",
  "Oracle",
  "Gladiator",
  "Dark Knight",
  "Mime",
  "Necromancer",
  "Oracle",
];

const KNOWN_JOB_KEYS: ReadonlySet<string> = new Set(KNOWN_JOBS.map(normalizeName));

export type TurnBackOperator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export type TurnBackCondition =
  | {
      readonly kind: "party.lowest_hp_pct" | "party.mp_pct";
      readonly operator: TurnBackOperator;
      readonly value: number;
    }
  | {
      readonly kind: "party.dead";
      readonly operator: TurnBackOperator;
      readonly value: number;
    }
  | {
      readonly kind: "item";
      readonly item: string;
      readonly operator: TurnBackOperator;
      readonly value: number;
    };

export type TurnBackParse =
  | { readonly ok: true; readonly condition: TurnBackCondition }
  | { readonly ok: false; readonly problem: string };

const TURN_BACK =
  /^\s*(party\.lowest_hp_pct|party\.mp_pct|party\.dead|item\.(.+?))\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/u;

/**
 * Read `turnBack.when`. Task 138 executes the same four forms; anything else is reported here
 * rather than silently ignored at execution time.
 */
export function parseTurnBackCondition(value: string): TurnBackParse {
  const match = TURN_BACK.exec(value);
  if (match === null) {
    return {
      ok: false,
      problem:
        `条件「${value}」看不懂;能写 party.lowest_hp_pct < 30、party.dead >= 1、` +
        "item.不死鸟之尾 < 2、party.mp_pct < 20",
    };
  }
  const kind = match[1] ?? "";
  const operator = (match[3] ?? "") as TurnBackOperator;
  const number = Number(match[4] ?? "");
  if (!Number.isFinite(number)) {
    return { ok: false, problem: `条件「${value}」里的数字看不懂` };
  }
  if (kind === "party.lowest_hp_pct" || kind === "party.mp_pct") {
    if (number < 0 || number > 100) {
      return {
        ok: false,
        problem: `条件「${value}」的百分比要在 0 到 100 之间`,
      };
    }
    return { ok: true, condition: { kind, operator, value: number } };
  }
  if (kind === "party.dead") {
    if (!Number.isInteger(number) || number < 0) {
      return {
        ok: false,
        problem: `条件「${value}」的倒下人数要是 0 以上的整数`,
      };
    }
    return {
      ok: true,
      condition: { kind: "party.dead", operator, value: number },
    };
  }
  const item = (match[2] ?? "").trim();
  if (item === "") return { ok: false, problem: `条件「${value}」没有写道具名` };
  if (number < 0) return { ok: false, problem: `条件「${value}」的道具数量不能是负数` };
  return {
    ok: true,
    condition: { kind: "item", item, operator, value: number },
  };
}

// ---------------------------------------------------------------------------------------------
// Name lookups

export function nameKey(value: string): string {
  return normalizeName(cleanIconTags(value));
}

export interface ItemCatalog {
  /** Every name the model may use for an item or spell, already cleaned and normalized. */
  readonly keys: Set<string>;
  readonly idsByKey: Map<string, Set<number>>;
  readonly keysById: Map<number, Set<string>>;
  /** Names known to be magic (shop purchase needs a magic shop). */
  readonly magicKeys: Set<string>;
}

function catalogAdd(catalog: ItemCatalog, id: number | null, raw: string): void {
  const key = nameKey(raw);
  if (key !== "") {
    catalog.keys.add(key);
    if (id !== null) {
      const ids = catalog.idsByKey.get(key) ?? new Set<number>();
      ids.add(id);
      catalog.idsByKey.set(key, ids);
      const keys = catalog.keysById.get(id) ?? new Set<string>();
      keys.add(key);
      catalog.keysById.set(id, keys);
    }
  }
  // 11-11: a plan may name an item by its content id ("123") instead of a trilingual name.
  if (id !== null) {
    const idKey = String(id);
    catalog.keys.add(idKey);
    const ids = catalog.idsByKey.get(idKey) ?? new Set<number>();
    ids.add(id);
    catalog.idsByKey.set(idKey, ids);
    const keys = catalog.keysById.get(id) ?? new Set<string>();
    keys.add(idKey);
    catalog.keysById.set(id, keys);
  }
}

/**
 * 11-11: shop rows can carry `<IC_...>` tags, and the guide names a spell "Fire" while the
 * model buys "火炎". Build one index of every language's name plus the content id, so a buy
 * item and a shop product meet on either the id or the cleaned name.
 */
export function itemCatalog(
  knowledge: Knowledge | undefined,
  facts?: SegmentFactsData,
): ItemCatalog {
  const catalog: ItemCatalog = {
    keys: new Set<string>(),
    idsByKey: new Map<string, Set<number>>(),
    keysById: new Map<number, Set<string>>(),
    magicKeys: new Set<string>(),
  };
  for (const item of knowledge?.items ?? []) catalogAdd(catalog, item.id, item.name);
  for (const spell of knowledge?.magic ?? []) {
    if (spell.name.trim() === "") continue;
    catalogAdd(catalog, null, spell.name);
    catalog.magicKeys.add(nameKey(spell.name));
  }
  for (const item of knowledge?.contentItems ?? []) {
    for (const name of [item.names.ja, item.names.en, item.names.zhc]) {
      if (name !== null && name.trim() !== "") {
        catalogAdd(catalog, item.id, name);
        if (item.kind === "magic") {
          catalog.magicKeys.add(nameKey(name));
          catalog.magicKeys.add(String(item.id));
        }
      }
    }
  }
  for (const shop of knowledge?.shops ?? []) {
    for (const product of shop.products) {
      catalogAdd(catalog, product.itemId, product.name);
      for (const alias of product.aliases ?? []) catalogAdd(catalog, product.itemId, alias);
    }
  }
  for (const shop of facts?.shops ?? []) {
    for (const product of shop.products) {
      catalogAdd(catalog, product.itemId ?? null, product.name);
      for (const alias of product.aliases ?? []) {
        catalogAdd(catalog, product.itemId ?? null, alias);
      }
    }
  }
  for (const item of facts?.bag ?? []) catalogAdd(catalog, null, item.name);
  // A magic shop's goods are spells even when the guide only gives the English name; carry
  // the aliases so Fire and 火炎 both need a magic shop.
  for (const shop of [...(knowledge?.shops ?? []), ...(facts?.shops ?? [])]) {
    const magicShop = /魔法|magic/iu.test(shop.kind ?? "");
    for (const product of shop.products) {
      const names = [product.name, ...(product.aliases ?? [])].filter((name) => name.trim() !== "");
      if (!magicShop && !names.some((name) => catalog.magicKeys.has(nameKey(name)))) continue;
      for (const name of names) catalog.magicKeys.add(nameKey(name));
    }
  }
  return catalog;
}

export function catalogIds(catalog: ItemCatalog, raw: string): Set<number> {
  return new Set(catalog.idsByKey.get(nameKey(raw)) ?? []);
}

export function catalogKeysFor(catalog: ItemCatalog, raw: string): Set<string> {
  const wanted = nameKey(raw);
  const keys = new Set<string>();
  if (wanted !== "") keys.add(wanted);
  for (const id of catalog.idsByKey.get(wanted) ?? []) {
    for (const key of catalog.keysById.get(id) ?? []) keys.add(key);
  }
  return keys;
}

function shares<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

export function productIsWanted(
  catalog: ItemCatalog,
  product: { readonly name: string; readonly itemId?: number | null },
  wanted: string,
): boolean {
  const wantedIds = catalogIds(catalog, wanted);
  if (wantedIds.size > 0 && product.itemId !== undefined && product.itemId !== null) {
    return wantedIds.has(product.itemId);
  }
  const productIds =
    product.itemId === undefined || product.itemId === null
      ? catalogIds(catalog, product.name)
      : new Set<number>([product.itemId]);
  if (wantedIds.size > 0 && productIds.size > 0) return shares(wantedIds, productIds);
  return shares(catalogKeysFor(catalog, wanted), catalogKeysFor(catalog, product.name));
}

function shopStock(facts: SegmentFactsData): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const shop of facts.shops) {
    for (const product of shop.products) {
      const name = cleanIconTags(product.name).trim();
      const key = normalizeName(name);
      if (name === "" || key === "" || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function jobKeys(facts: SegmentFactsData): Set<string> {
  const keys = new Set(KNOWN_JOB_KEYS);
  for (const member of facts.party) keys.add(normalizeName(member.job));
  return keys;
}

function partyNames(facts: SegmentFactsData): Set<string> {
  return new Set(facts.party.map((member) => normalizeName(member.name)));
}

function monsterNameMatches(monster: SegmentFactsMonster, target: string | number): boolean {
  if (typeof target === "number") return monster.bookId === target;
  const wanted = normalizeName(target);
  if (wanted === "") return false;
  const names = [monster.name, monster.guideName ?? ""].map(normalizeName);
  return names.some(
    (name) => name !== "" && (name === wanted || name.includes(wanted) || wanted.includes(name)),
  );
}

function monsterAt(
  facts: SegmentFactsData,
  target: string | number,
): SegmentFactsMonster | undefined {
  return facts.monsters.find((monster) => monsterNameMatches(monster, target));
}

function blueMagicAt(facts: SegmentFactsData, name: string) {
  const wanted = normalizeName(name);
  return facts.blueMagic.find((spell) => {
    const own = normalizeName(spell.name);
    return own !== "" && (own === wanted || own.includes(wanted) || wanted.includes(own));
  });
}

// ---------------------------------------------------------------------------------------------
// Shape checks

export interface PlanTarget {
  readonly mapId: number;
  readonly cell: readonly [number, number] | null;
}

export function parseTarget(value: unknown): PlanTarget | string {
  if (typeof value !== "string") return "to 要写成「地图号:x,y」或「地图号」";
  const raw = value.trim();
  if (raw === "") return "to 是空的";
  const match = /^(?:地图\s*)?(\d+)(?:\s*:\s*(-?\d+)\s*,\s*(-?\d+))?$/u.exec(raw);
  if (match === null) return "to 要写成「地图号:x,y」或「地图号」,不能写地图名或单独的坐标";
  const mapId = Number(match[1] ?? "");
  if (!Number.isInteger(mapId) || mapId <= 0) return `地图号「${match[1] ?? ""}」不合理`;
  if (match[2] === undefined || match[3] === undefined) return { mapId, cell: null };
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return "坐标要写成整数 x,y";
  return { mapId, cell: [x, y] };
}

function whereStation(index: number): string {
  return `站点第 ${index + 1} 个`;
}

/**
 * Task 146: a boss station that names only a map is ambiguous when this boss has exactly one
 * trigger cell on it. Multiple bosses or multiple cells stay allowed, because the plan did not
 * say which one it means and code must not guess.
 */
export function bossTriggerProblem(facts: SegmentFactsData, mapId: number): string | null {
  const bosses = facts.bosses.filter((boss) => boss.maps.includes(mapId));
  if (bosses.length !== 1) return null;
  const boss = bosses[0];
  if (boss === undefined) return null;
  const cells = boss.triggers.filter((trigger) => trigger.map === mapId);
  if (cells.length !== 1) return null;
  const cell = cells[0];
  if (cell === undefined) return null;
  const name = boss.knowledgeName ?? boss.name;
  return `首领站「${mapId}」要写坐标：${name}的触发点是 ${mapId}:${cell.cell[0]},${cell.cell[1]}`;
}

/**
 * Task 159: a save station must be at a save point or on a world map. If the plan names only a
 * dungeon map and the knowledge files know no save point there, the save will fail and the
 * station would otherwise be recorded done. `knowledge` missing means "no save-point data";
 * the plan is rejected rather than trusted.
 */
export function saveStationProblem(
  station: PlanStation,
  knowledge: Knowledge | undefined,
): string | null {
  if (station.do !== "save") return null;
  const target = parseTarget(station.to);
  if (typeof target === "string") return null;
  const mapName = knowledge?.maps.find((map) => map.id === target.mapId)?.name ?? "";
  const world = target.mapId === 1 || /^Map_100|world.?map/iu.test(mapName);
  if (world) return null;
  const cells: (readonly [number, number])[] = [];
  for (const point of knowledge?.savePoints ?? []) {
    if (point.mapId === target.mapId) cells.push(point.cell);
  }
  const mapFile = knowledge?.mapFiles?.find((file) => file.id === target.mapId);
  if (mapFile !== undefined) {
    for (const point of mapFile.savePoints) cells.push(point.cell);
  }
  // A map with no exported file has no save-point data, not a proven absence of save points.
  const dataKnown = knowledge === undefined || mapFile !== undefined || cells.length > 0;
  if (!dataKnown) return null;
  const cell = target.cell;
  if (cell !== null && cells.some((point) => point[0] === cell[0] && point[1] === cell[1])) {
    return null;
  }
  if (cells.length > 0) return null;
  const where = mapName === "" ? `图 ${target.mapId}` : `图 ${target.mapId} ${mapName}`;
  return `${where} 不是世界地图，也查不到存档点，这里存不了档;改到世界地图或存档点的格子`;
}

interface DroppedTarget {
  readonly mapId: number;
  readonly cell: readonly [number, number] | null;
  readonly do: PlanStationAction;
}

/** Task 146: shape-check `plan.dropped` and return the entries that can match a station. */
function checkDropped(value: unknown, problems: string[]): DroppedTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("dropped 要写成数组");
    return [];
  }
  const out: DroppedTarget[] = [];
  for (const [index, raw] of value.entries()) {
    const where = `dropped 第 ${index + 1} 项`;
    if (!isRecord(raw)) {
      problems.push(`${where}不是对象`);
      continue;
    }
    const target = parseTarget(raw.to);
    if (typeof target === "string") problems.push(`${where}:${target}`);
    const action = text(raw.do);
    if (action === undefined || !ACTIONS.has(action)) {
      problems.push(`${where}的 do 不认识;能用:${[...ACTIONS].join("、")}`);
    }
    if (typeof raw.why !== "string" || raw.why.trim() === "") {
      problems.push(`${where}的 why 要写清楚为什么不做这一站`);
    }
    if (typeof target !== "string" && action !== undefined && ACTIONS.has(action)) {
      out.push({
        mapId: target.mapId,
        cell: target.cell,
        do: action as PlanStationAction,
      });
    }
  }
  return out;
}

/**
 * Task 146: a revision must keep every station the previous exception report left undone, or
 * explicitly drop it with a reason. Only an exception report of the same section is checked.
 */
function checkRevision(
  previous: PlanRevision | undefined,
  section: string,
  kept: readonly DroppedTarget[],
  dropped: readonly DroppedTarget[],
  problems: string[],
): void {
  if (previous === undefined) return;
  if (previous.report.status !== "exception") return;
  if (previous.report.section !== section || previous.plan.section !== section) return;
  const missing: string[] = [];
  for (const index of previous.report.remaining) {
    const station = previous.plan.stations[index];
    if (station === undefined) continue;
    const target = parseTarget(station.to);
    if (typeof target === "string") continue;
    const same = (entry: DroppedTarget): boolean =>
      entry.mapId === target.mapId && entry.do === station.do;
    if (kept.some(same) || dropped.some(same)) continue;
    missing.push(`第 ${index + 1} 站 ${station.do} ${station.to}`);
  }
  if (missing.length > 0) {
    problems.push(
      `上一份计划还没做的站要留着，不做的写进 dropped 并说明原因：${missing.join("、")}`,
    );
  }
}

/**
 * Task 146 follow-up (11-11): every plan must cover this section's unopened chests and
 * undefeated bosses, not only a revision. A station or a `dropped` row with a reason counts;
 * rows without a usable map/cell are not checked, and an unknown boss is treated as unbeaten.
 */
function checkCoverage(
  facts: SegmentFactsData,
  kept: readonly DroppedTarget[],
  dropped: readonly DroppedTarget[],
  problems: string[],
): void {
  const missingChests: string[] = [];
  for (const chest of facts.chests) {
    if (chest.opened === true) continue;
    const mapId = chest.mapId;
    const cell = chest.cell;
    if (mapId === null || cell === null) continue;
    const same = (entry: DroppedTarget): boolean =>
      entry.do === "open" &&
      entry.mapId === mapId &&
      entry.cell !== null &&
      entry.cell[0] === cell[0] &&
      entry.cell[1] === cell[1];
    if (kept.some(same) || dropped.some(same)) continue;
    missingChests.push(`${mapId}:${cell[0]},${cell[1]} ${chest.item}`);
  }
  if (missingChests.length > 0) {
    problems.push(
      `这一节还有 ${missingChests.length} 个宝箱没写进计划，也没写进 dropped：` +
        missingChests.join("、"),
    );
  }
  const missingBosses: string[] = [];
  for (const boss of facts.bosses) {
    if (boss.defeated === true || boss.maps.length === 0) continue;
    const same = (entry: DroppedTarget): boolean =>
      entry.do === "boss" && boss.maps.includes(entry.mapId);
    if (kept.some(same) || dropped.some(same)) continue;
    missingBosses.push(`${boss.name}(${boss.maps.join("、")})`);
  }
  if (missingBosses.length > 0) {
    problems.push(
      `这一节还有 ${missingBosses.length} 个首领没写进计划，也没写进 dropped：` +
        missingBosses.join("、"),
    );
  }
}

function checkUntil(
  value: unknown,
  where: string,
  facts: SegmentFactsData,
  problems: string[],
): void {
  if (!isRecord(value)) {
    problems.push(`${where}:do 是 grind 就要写 until`);
    return;
  }
  let count = 0;
  const grindMaps = new Set([
    ...facts.maps.map((map) => map.mapId),
    ...facts.revisitMaps.map((map) => map.mapId),
  ]);
  const bestiary = value.bestiary;
  if (bestiary !== undefined) {
    if (!Array.isArray(bestiary) || bestiary.length === 0) {
      problems.push(`${where}:until.bestiary 要写成非空数组`);
    } else {
      for (const [index, target] of bestiary.entries()) {
        if (
          typeof target !== "string" &&
          !(typeof target === "number" && Number.isFinite(target))
        ) {
          problems.push(`${where}:until.bestiary[${index}] 不是怪名或图鉴号`);
          continue;
        }
        count += 1;
        const monster = monsterAt(facts, target);
        if (monster === undefined) {
          problems.push(`${where}:图鉴「${String(target)}」在这一节没有记录`);
          continue;
        }
        if (!monster.maps.some((mapId) => grindMaps.has(mapId))) {
          problems.push(`${where}:图鉴「${String(target)}」不在这节地图出现`);
        }
      }
    }
  }
  const blueMagic = value.blueMagic;
  if (blueMagic !== undefined) {
    if (!Array.isArray(blueMagic) || blueMagic.length === 0) {
      problems.push(`${where}:until.blueMagic 要写成非空数组`);
    } else {
      for (const [index, target] of blueMagic.entries()) {
        if (typeof target !== "string" || target.trim() === "") {
          problems.push(`${where}:until.blueMagic[${index}] 不是青魔法名`);
          continue;
        }
        count += 1;
        const spell = blueMagicAt(facts, target);
        if (spell === undefined) {
          problems.push(`${where}:这一节没有青魔法「${target}」的记录`);
          continue;
        }
        if (!spell.canLearn) {
          problems.push(`${where}:队伍里没有青魔导士,学不了「${target}」`);
        }
        const teachersHere = spell.teachers.some((teacher) =>
          teacher.maps.some((mapId) => grindMaps.has(mapId)),
        );
        if (!teachersHere) {
          problems.push(`${where}:这一节没有会教「${target}」的怪`);
        }
      }
    }
  }
  if (value.battles !== undefined) {
    if (
      typeof value.battles !== "number" ||
      !Number.isInteger(value.battles) ||
      value.battles <= 0
    ) {
      problems.push(`${where}:until.battles 要是正整数`);
    } else count += 1;
  }
  if (value.minutes !== undefined) {
    if (
      typeof value.minutes !== "number" ||
      !Number.isFinite(value.minutes) ||
      value.minutes <= 0
    ) {
      problems.push(`${where}:until.minutes 要是正数`);
    } else count += 1;
  }
  if (count === 0) {
    problems.push(`${where}:until 至少要写 bestiary、blueMagic、battles、minutes 中的一项`);
  }
}

/**
 * Task 151: `buy` carries `items`. Shape-check them here and, when the section's shops are
 * known, warn about a product no nearby shop sells. The chapter check additionally proves the
 * shop is on the station's own map and adds up the whole chapter's purchases.
 */
function checkBuyItems(
  value: unknown,
  where: string,
  facts: SegmentFactsData,
  catalog: ItemCatalog,
  problems: string[],
): void {
  if (!Array.isArray(value)) {
    problems.push(`${where}:do 是 buy 就要写 items(买什么,买几个)`);
    return;
  }
  if (value.length === 0) {
    problems.push(`${where}:items 不能是空的`);
    return;
  }
  const stock = facts.shops.length === 0 ? null : shopStock(facts);
  for (const [index, raw] of value.entries()) {
    const label = `${where}:items[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${label} 不是对象`);
      continue;
    }
    const item = text(raw.item)?.trim() ?? "";
    if (item === "") {
      problems.push(`${label} 没有写道具名`);
    } else if (stock !== null) {
      const sellers = facts.shops.filter((shop) =>
        shop.products.some((product) => productIsWanted(catalog, product, item)),
      );
      const magic = catalog.magicKeys.has(nameKey(item));
      const usable = magic ? sellers.filter((shop) => /魔法|magic/iu.test(shop.kind)) : sellers;
      if (usable.length === 0) {
        problems.push(
          `${label}:这节附近${magic ? "的魔法店" : "的商店"}没有卖「${item}」;这些店有卖：${stock.length === 0 ? "没有记录" : stock.join("、")}`,
        );
      }
    }
    const count = raw.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      problems.push(`${label}:「${item}」的 count 要是正整数`);
    }
  }
}

function checkStation(
  value: unknown,
  index: number,
  facts: SegmentFactsData,
  allowed: ReadonlySet<number>,
  catalog: ItemCatalog,
  problems: string[],
  warnings: string[],
): PlanStation | null {
  const where = whereStation(index);
  if (!isRecord(value)) {
    problems.push(`${where}不是对象`);
    return null;
  }
  const target = parseTarget(value.to);
  if (typeof target === "string") {
    problems.push(`${where}:${target}`);
  } else if (!allowed.has(target.mapId)) {
    problems.push(`${where}:地图 ${target.mapId} 不属于这一节,也不在通往它的路上`);
  }
  const action = text(value.do);
  if (action === undefined || !ACTIONS.has(action)) {
    problems.push(`${where}的 do 不认识;能用:${[...ACTIONS].join("、")}`);
  }
  if (
    action !== undefined &&
    CELL_REQUIRED.has(action) &&
    typeof target !== "string" &&
    target.cell === null
  ) {
    problems.push(
      `第 ${index + 1} 站 do=${action} 要写格子(图:x,y);事实表/look_around 里能查到坐标`,
    );
  }
  if (value.choose !== undefined && action !== "choose") {
    problems.push(`${where}:只有 do 是 choose 才能写 choose`);
  }
  if (action === "choose") {
    const choose = value.choose;
    if (
      !(typeof choose === "number" && Number.isInteger(choose) && choose >= 0) &&
      !(typeof choose === "string" && choose.trim() !== "")
    ) {
      problems.push(`${where}:do 是 choose 就要写选项序号(0 开始)或选项文字`);
    }
  }
  if (value.until !== undefined && action !== "grind") {
    problems.push(`${where}:只有 do 是 grind 才能写 until`);
  }
  if (action === "buy") {
    checkBuyItems(value.items, where, facts, catalog, problems);
  } else if (value.items !== undefined) {
    problems.push(`${where}:只有 do 是 buy 才能写 items`);
  }
  if (action === "grind" && typeof target !== "string") {
    checkUntil(value.until, where, facts, problems);
  } else if (action === "grind") {
    checkUntil(value.until, where, facts, problems);
  }
  if (value.optional !== undefined && typeof value.optional !== "boolean") {
    problems.push(`${where}的 optional 要是布尔值`);
  }
  if (value.why !== undefined && typeof value.why !== "string") {
    problems.push(`${where}的 why 要是字符串`);
  }
  if (value.book !== undefined) {
    if (!isRecord(value.book) || typeof value.book.section !== "string") {
      problems.push(`${where}的 book 要写 {section, index}`);
    }
  }
  if (typeof target === "string" || action === undefined || !ACTIONS.has(action)) return null;
  const station: PlanStation = {
    to: value.to as string,
    do: action as PlanStationAction,
    ...(typeof value.why === "string" ? { why: value.why } : {}),
    ...(value.choose === undefined ? {} : { choose: value.choose as number | string }),
    ...(value.until === undefined ? {} : { until: value.until as PlanStation["until"] }),
    ...(action === "buy" && Array.isArray(value.items)
      ? { items: value.items as NonNullable<PlanStation["items"]> }
      : {}),
    ...(typeof value.optional === "boolean" ? { optional: value.optional } : {}),
    ...(isRecord(value.book) && typeof value.book.section === "string"
      ? {
          book: {
            section: value.book.section,
            index: num(value.book.index) ?? 0,
          },
        }
      : {}),
  };
  if (station.do === "boss" && target.cell === null) {
    const problem = bossTriggerProblem(facts, target.mapId);
    if (problem !== null) problems.push(`${where}:${problem}`);
  }
  if (station.do === "save") {
    const knowledge = segmentFactsKnowledge(facts);
    const problem = saveStationProblem(station, knowledge);
    if (problem !== null) {
      const line = `${where}:${problem}`;
      // Task 159: old/synthetic facts carry no save-point data. Do not reject the whole plan
      // for a missing export; the executor still tries a known point and skips if there is none.
      if (knowledge === undefined) warnings.push(`${line}（没有存档点数据，降为提醒）`);
      else problems.push(line);
    }
  }
  return station;
}

function tableProblems(
  table: unknown,
  facts: SegmentFactsData,
  label: string,
  problems: string[],
): void {
  if (!isRecord(table)) {
    problems.push(`${label}:规则表要写成 JSON 对象`);
    return;
  }
  const bad =
    table.version === 2 ? checkStrategy(table, facts.party) : checkGambit(table, facts.game);
  for (const problem of bad) problems.push(`${label}:${problem}`);
}

function checkTables(
  tables: unknown,
  label: string,
  facts: SegmentFactsData,
  problems: string[],
): void {
  if (!Array.isArray(tables)) {
    problems.push(`${label}:规则表要写成数组`);
    return;
  }
  if (tables.length === 0) problems.push(`${label}:至少要有一套规则表`);
  if (tables.length > 3) problems.push(`${label}:最多 3 套,这次写了 ${tables.length} 套`);
  for (const [index, table] of tables.entries()) {
    tableProblems(table, facts, `${label} 第 ${index + 1} 套`, problems);
  }
}

function checkMaps(
  value: unknown,
  label: string,
  allowed: ReadonlySet<number>,
  problems: string[],
): void {
  if (!Array.isArray(value)) {
    problems.push(`${label}的 maps 要写成数组`);
    return;
  }
  for (const [index, mapId] of value.entries()) {
    if (typeof mapId !== "number" || !Number.isInteger(mapId) || mapId <= 0) {
      problems.push(`${label}.maps[${index}] 不是地图号`);
      continue;
    }
    if (!allowed.has(mapId)) problems.push(`${label}:地图 ${mapId} 不属于这一节`);
  }
}

function checkPrep(
  value: unknown,
  facts: SegmentFactsData,
  knowledge: Knowledge | undefined,
  problems: string[],
  notes: string[],
): void {
  if (!isRecord(value)) {
    problems.push("prep 要是对象");
    return;
  }
  const members = partyNames(facts);
  const jobs = jobKeys(facts);
  const catalog = itemCatalog(knowledge, facts);
  const stock = shopStock(facts);
  if (!Array.isArray(value.jobs)) {
    problems.push("prep.jobs 要写成数组");
  } else {
    for (const [index, raw] of value.jobs.entries()) {
      const where = `prep.jobs[${index}]`;
      if (!isRecord(raw)) {
        problems.push(`${where} 不是对象`);
        continue;
      }
      const member = text(raw.member)?.trim() ?? "";
      if (member === "") problems.push(`${where} 没有写成员名`);
      else if (!members.has(normalizeName(member))) {
        problems.push(`${where}:队伍里没有「${member}」`);
      }
      const job = text(raw.job)?.trim() ?? "";
      if (job === "") problems.push(`${where} 没有写职业名`);
      else if (!jobs.has(normalizeName(job))) {
        problems.push(`${where}:不知道职业「${job}」`);
      }
      if (raw.abilities !== undefined) {
        if (
          !Array.isArray(raw.abilities) ||
          raw.abilities.some((ability) => typeof ability !== "string" || ability.trim() === "")
        ) {
          problems.push(`${where}.abilities 要是非空字符串的数组`);
        }
      }
    }
  }
  if (value.equip !== "optimize" && value.equip !== "keep") {
    problems.push("prep.equip 只能是 optimize 或 keep");
  }
  if (!Array.isArray(value.buy)) {
    problems.push("prep.buy 要写成数组");
  } else {
    for (const [index, raw] of value.buy.entries()) {
      const where = `prep.buy[${index}]`;
      if (!isRecord(raw)) {
        problems.push(`${where} 不是对象`);
        continue;
      }
      const item = text(raw.item)?.trim() ?? "";
      if (item === "") {
        problems.push(`${where} 没有写道具名`);
        continue;
      }
      if (!catalog.keys.has(nameKey(item))) {
        problems.push(`${where}:知识库里没有道具或魔法「${item}」`);
      }
      const sellers = facts.shops.filter((shop) =>
        shop.products.some((product) => productIsWanted(catalog, product, item)),
      );
      const magic = catalog.magicKeys.has(nameKey(item));
      const usable = magic ? sellers.filter((shop) => /魔法|magic/iu.test(shop.kind)) : sellers;
      if (usable.length === 0) {
        problems.push(
          `${where}:这节附近${magic ? "的魔法店" : "的商店"}没有卖「${item}」;这些店有卖：${stock.length === 0 ? "没有记录" : stock.join("、")}`,
        );
      } else {
        const shopWhere = usable
          .slice(0, 3)
          .map((shop) => `${shop.area}${shop.kind}`)
          .join("、");
        notes.push(`${where}:代码会去「${shopWhere}」买「${item}」×${String(raw.count)}`);
      }
      const count = raw.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
        problems.push(`${where}:「${item}」的 count 要是正整数`);
      }
    }
  }
  if (!Array.isArray(value.rows)) {
    problems.push("prep.rows 要写成数组");
  } else {
    for (const [index, raw] of value.rows.entries()) {
      const where = `prep.rows[${index}]`;
      if (!isRecord(raw)) {
        problems.push(`${where} 不是对象`);
        continue;
      }
      const member = text(raw.member)?.trim() ?? "";
      if (member === "") problems.push(`${where} 没有写成员名`);
      else if (!members.has(normalizeName(member))) {
        problems.push(`${where}:队伍里没有「${member}」`);
      }
      if (raw.row !== "front" && raw.row !== "back") {
        problems.push(`${where}.row 只能是 front 或 back`);
      }
    }
  }
}

function checkBosses(
  value: unknown,
  facts: SegmentFactsData,
  allowed: ReadonlySet<number>,
  problems: string[],
): void {
  if (!Array.isArray(value)) {
    problems.push("bosses 要写成数组");
    return;
  }
  for (const [index, raw] of value.entries()) {
    const where = `首领第 ${index + 1} 个`;
    if (!isRecord(raw)) {
      problems.push(`${where}不是对象`);
      continue;
    }
    const name = text(raw.name)?.trim() ?? "";
    if (name === "") problems.push(`${where}没有写名字`);
    if (raw.map !== null) {
      const mapId = raw.map;
      if (typeof mapId !== "number" || !Number.isInteger(mapId) || mapId <= 0) {
        problems.push(`${where}的 map 要是地图号或 null`);
      } else if (!allowed.has(mapId)) {
        problems.push(`${where}:地图 ${mapId} 不属于这一节`);
      }
    }
    if (typeof raw.healFirst !== "boolean") problems.push(`${where}的 healFirst 要是布尔值`);
    if (typeof raw.saveFirst !== "boolean") problems.push(`${where}的 saveFirst 要是布尔值`);
    checkTables(raw.tables, `${where}的规则表`, facts, problems);
    if (raw.notes !== undefined && typeof raw.notes !== "string") {
      problems.push(`${where}的 notes 要是字符串`);
    }
  }
}

function checkBattles(
  value: unknown,
  facts: SegmentFactsData,
  allowed: ReadonlySet<number>,
  problems: string[],
): void {
  if (!Array.isArray(value)) {
    problems.push("battle 要写成数组");
    return;
  }
  for (const [index, raw] of value.entries()) {
    const where = `战斗表第 ${index + 1} 份`;
    if (!isRecord(raw)) {
      problems.push(`${where}不是对象`);
      continue;
    }
    checkMaps(raw.maps, where, allowed, problems);
    checkTables(raw.tables, `${where}的规则表`, facts, problems);
  }
}

/**
 * Validate one plan against the fact sheet. An empty `problems` means code may execute the
 * returned (or original) plan; `fixed` is the same plan with optional heal/save fixes applied.
 */
export function validatePlan(
  plan: unknown,
  facts: SegmentFactsData,
  previous?: PlanRevision,
): PlanValidation {
  const problems: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(plan)) return { ok: false, problems: ["计划要是 JSON 对象"] };
  if (plan.version !== 1) problems.push("version 要是 1");
  const section = text(plan.section)?.trim() ?? "";
  if (section === "") problems.push("没有写 section");
  else if (section !== facts.section) {
    problems.push(`section 是「${section}」,事实单这一节是「${facts.section}」`);
  }
  const goal = text(plan.goal)?.trim() ?? "";
  if (goal === "") problems.push("没有写 goal");
  checkPrep(plan.prep, facts, segmentFactsKnowledge(facts), problems, notes);
  const allowed = new Set([
    ...facts.maps.map((map) => map.mapId),
    ...facts.passThrough.map((map) => map.mapId),
    ...facts.revisitMaps.map((map) => map.mapId),
    ...(facts.currentMapId === undefined || facts.currentMapId === null
      ? []
      : [facts.currentMapId]),
  ]);
  const fixedStations: unknown[] = [];
  const catalog = itemCatalog(segmentFactsKnowledge(facts), facts);
  const kept: DroppedTarget[] = [];
  let stationsFixed = false;
  if (!Array.isArray(plan.stations)) {
    problems.push("stations 要写成数组");
  } else {
    for (const [index, raw] of plan.stations.entries()) {
      const station = checkStation(raw, index, facts, allowed, catalog, problems, warnings);
      if (station !== null) {
        const target = parseTarget(station.to);
        if (typeof target !== "string") {
          kept.push({ mapId: target.mapId, cell: target.cell, do: station.do });
        }
      }
      if (isRecord(raw) && station !== null) {
        const fixOptional =
          (station.do === "heal" || station.do === "save") && station.optional === undefined;
        if (fixOptional) {
          fixedStations.push({ ...raw, optional: true });
          stationsFixed = true;
        } else {
          fixedStations.push(raw);
        }
      } else {
        fixedStations.push(raw);
      }
    }
  }
  const dropped = checkDropped(plan.dropped, problems);
  checkRevision(previous, facts.section, kept, dropped, problems);
  checkCoverage(facts, kept, dropped, problems);
  checkBattles(plan.battle, facts, allowed, problems);
  checkBosses(plan.bosses, facts, allowed, problems);
  if (!Array.isArray(plan.turnBack)) {
    problems.push("turnBack 要写成数组");
  } else {
    for (const [index, raw] of plan.turnBack.entries()) {
      const where = `回头条件第 ${index + 1} 项`;
      if (!isRecord(raw)) {
        problems.push(`${where}不是对象`);
        continue;
      }
      const when = text(raw.when);
      if (when === undefined || when.trim() === "") {
        problems.push(`${where}没有写 when`);
      } else {
        const parsed = parseTurnBackCondition(when);
        if (!parsed.ok) problems.push(`${where}:${parsed.problem}`);
      }
      if (typeof raw.then !== "string" || !TURN_BACK_THEN.has(raw.then)) {
        problems.push(`${where}的 then 只能是 heal-and-continue 或 replan`);
      }
    }
  }
  if (plan.notes !== undefined && typeof plan.notes !== "string") {
    problems.push("notes 要是字符串");
  }
  const fixed =
    stationsFixed && Array.isArray(plan.stations)
      ? ({ ...plan, stations: fixedStations } as unknown as SegmentPlan)
      : undefined;
  return {
    ok: problems.length === 0,
    problems,
    ...(fixed === undefined ? {} : { fixed }),
    ...(notes.length === 0 ? {} : { notes }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

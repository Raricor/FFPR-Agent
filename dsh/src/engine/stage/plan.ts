/**
 * Checks for one stage plan (task 95, 11-10): what the stage officer promised has to be
 * affordable and usable before the code spends gil or walks into the dungeon. The stage facts
 * carry no status-to-cure table, so the small FF5 name table below is the one code-side link
 * between a status threat and the item/spell that handles it; it is not game guide text and
 * never reaches the prompt.
 */

import {
  monstersIn,
  normalizeName,
  type Knowledge,
  type MonsterKnowledge,
} from "../knowledge/index.ts";
import { isRecord, text } from "../values.ts";
import { stageFactsKnowledge } from "./facts.ts";
import type { StageFacts, StageGrindUntil, StageMonster, StagePlan } from "./types.ts";

const ROUTE_ACTIONS: ReadonlySet<string> = new Set([
  "open",
  "save",
  "talk",
  "grind",
  "boss",
  "handoff",
]);

/** Item and spell names that cure one status; "毒" and "中毒" both occur in the exports. */
const STATUS_CURES: Readonly<
  Record<string, { readonly items: readonly string[]; readonly spells: readonly string[] }>
> = {
  毒: { items: ["解毒药"], spells: ["解毒"] },
  中毒: { items: ["解毒药"], spells: ["解毒"] },
  黑暗: { items: ["眼药"], spells: [] },
  暗闇: { items: ["眼药"], spells: [] },
  盲目: { items: ["眼药"], spells: [] },
  石化: { items: ["金针"], spells: [] },
  青蛙: { items: ["少女之吻"], spells: [] },
  蛙: { items: ["少女之吻"], spells: [] },
  迷你: { items: ["木槌"], spells: [] },
  小人: { items: ["木槌"], spells: [] },
  沉默: { items: ["回音草"], spells: [] },
  沈黙: { items: ["回音草"], spells: [] },
  睡眠: { items: ["万能药"], spells: [] },
  眠り: { items: ["万能药"], spells: [] },
  麻痹: { items: ["万能药"], spells: [] },
  麻痺: { items: ["万能药"], spells: [] },
  混乱: { items: ["万能药"], spells: [] },
  僵尸: { items: ["圣水"], spells: [] },
  ゾンビ: { items: ["圣水"], spells: [] },
  死亡: { items: ["不死鸟之尾", "凤凰尾"], spells: ["复活"] },
  战斗不能: { items: ["不死鸟之尾", "凤凰尾"], spells: ["复活"] },
  戦闘不能: { items: ["不死鸟之尾", "凤凰尾"], spells: ["复活"] },
};

/** FF5's all-purpose cures, usable for any status the table above does not name. */
const GENERIC_CURES: readonly string[] = ["万能药", "万灵药", "Remedy", "Esuna", "エスナ"];

function bagCount(bag: StageFacts["bag"], item: string): number {
  const wanted = normalizeName(item);
  if (wanted === "") return 0;
  let total = 0;
  for (const row of bag) {
    if (normalizeName(row.name) === wanted) total += Math.max(0, Math.trunc(row.count));
  }
  return total;
}

interface Product {
  readonly name: string;
  readonly price: number | null;
}

/** Every product any nearby shop sells, with the cheapest known price for each name. */
function productIndex(facts: StageFacts): Map<string, Product> {
  const index = new Map<string, Product>();
  for (const shop of facts.shops) {
    for (const product of shop.products) {
      const key = normalizeName(product.name);
      if (key === "") continue;
      const existing = index.get(key);
      if (existing === undefined) {
        index.set(key, { name: product.name, price: product.price });
        continue;
      }
      // Two shops may disagree or leave the price null; the cheapest known price is the one
      // the purchase list can actually use.
      if (product.price !== null && (existing.price === null || product.price < existing.price)) {
        index.set(key, { name: existing.name, price: product.price });
      }
    }
  }
  return index;
}

function knownSpells(facts: StageFacts): Set<string> {
  const known = new Set<string>();
  for (const member of facts.party) {
    for (const spell of member.spells) {
      const key = normalizeName(spell);
      if (key !== "") known.add(key);
    }
  }
  return known;
}

/** Supplies: buyable or already in the bag, and the planned purchase fits the purse. */
function checkSupplies(plan: StagePlan, facts: StageFacts, problems: string[]): void {
  const products = productIndex(facts);
  let cost = 0;
  const unknownPrice: string[] = [];
  for (const [index, supply] of plan.supplies.entries()) {
    const where = `补给第 ${index + 1} 项`;
    const item = supply.item.trim();
    if (item === "") {
      problems.push(`${where}没有写道具名`);
      continue;
    }
    if (!Number.isInteger(supply.min) || supply.min < 0) {
      problems.push(`${where}「${item}」的 min 要是 0 以上的整数`);
      continue;
    }
    if (!Number.isInteger(supply.buyTo) || supply.buyTo < 0) {
      problems.push(`${where}「${item}」的 buyTo 要是 0 以上的整数`);
      continue;
    }
    if (supply.min > supply.buyTo) {
      problems.push(`${where}「${item}」的 min ${supply.min} 比 buyTo ${supply.buyTo} 还大`);
      continue;
    }
    const owned = bagCount(facts.bag, item);
    const need = Math.max(0, supply.buyTo - owned);
    if (need === 0) continue;
    const product = products.get(normalizeName(item));
    if (product === undefined) {
      // The bag covers the departure minimum even if it cannot reach buyTo; only a shortfall
      // in the hard gate matters.
      if (owned < supply.min) {
        problems.push(
          `${where}「${item}」背包只有 ${owned} 个，少于 min ${supply.min}，商店也没卖`,
        );
      }
      continue;
    }
    if (product.price === null) {
      unknownPrice.push(item);
      continue;
    }
    cost += need * product.price;
  }
  for (const item of unknownPrice) {
    problems.push(`「${item}」的价格未知，没法核对总价`);
  }
  if (cost > facts.gil) {
    problems.push(`计划采购要 ${cost} gil，身上只有 ${facts.gil} gil`);
  }
}

/** Spells: sold somewhere nearby or already known by someone in the party. */
function checkSpells(plan: StagePlan, facts: StageFacts, problems: string[]): void {
  const known = knownSpells(facts);
  const sold = productIndex(facts);
  for (const [index, entry] of plan.spells.entries()) {
    const spell = entry.spell.trim();
    const where = `法术第 ${index + 1} 项`;
    if (spell === "") {
      problems.push(`${where}没有写法术名`);
      continue;
    }
    const key = normalizeName(spell);
    if (!known.has(key) && !sold.has(key)) {
      problems.push(`${where}「${spell}」商店没卖，队伍里也没有人会`);
    }
  }
}

/** Jobs: only people already in the party can be told to change. */
function checkJobs(plan: StagePlan, facts: StageFacts, problems: string[]): void {
  const members = new Set(facts.party.map((member) => normalizeName(member.name)));
  for (const [index, job] of plan.jobs.entries()) {
    const where = `职业第 ${index + 1} 项`;
    const member = job.member.trim();
    if (member === "") {
      problems.push(`${where}没有写成员名`);
      continue;
    }
    if (!members.has(normalizeName(member))) {
      problems.push(`${where}让「${member}」转「${job.job}」，但队伍里没有这个人`);
      continue;
    }
    if (job.job.trim() === "") problems.push(`${where}「${member}」要转的职业是空的`);
  }
}

function cellText(value: string): boolean {
  const trimmed = value
    .trim()
    .replace(/^[[(]\s*/u, "")
    .replace(/\s*[\])]$/u, "");
  return /^(-?\d+)\s*(?:,|\s)\s*(-?\d+)$/u.test(trimmed);
}

/**
 * `route.to` accepts exactly the spellings `go` and `route` accept: a map id, a map name, a
 * cell on the current map, or `map:x,y`. Names cannot be checked without the atlas, so only
 * coordinate-shaped strings that fail to parse are rejected.
 */
function routeTargetProblem(value: unknown): string | null {
  const raw = typeof value === "number" ? String(value) : text(value);
  if (raw === undefined) return "to 要写地图号、地图名或坐标";
  const trimmed = raw.trim();
  if (trimmed === "") return "to 是空的";

  const mapCell = /^(?:地图\s*)?(\d+)\s*:\s*(.+)$/u.exec(trimmed);
  if (mapCell !== null) {
    const map = Number(mapCell[1]);
    if (!Number.isInteger(map) || map <= 0) return `地图号「${mapCell[1]}」不合理`;
    if (!cellText(mapCell[2] ?? "")) return "「地图号:x,y」后面的坐标要写成 x,y";
    return null;
  }

  const stripped = trimmed.replace(/^[[(]\s*/u, "").replace(/\s*[\])]$/u, "");
  if (/[，,]/u.test(stripped) || /^[[(]/u.test(trimmed)) {
    return cellText(stripped) ? null : "坐标要写成 x,y，也可以写「地图号:x,y」";
  }

  const numbered = /^(?:地图\s*)?(\d+)$/u.exec(trimmed);
  if (numbered !== null) {
    const map = Number(numbered[1]);
    return Number.isInteger(map) && map > 0 ? null : `地图号「${numbered[1]}」不合理`;
  }
  if (/^地图\s*/u.test(trimmed) || /^[+-]?\d+$/u.test(trimmed)) {
    return "要写地图号、地图名或坐标，不能是负数或半截地图号";
  }
  if (/^(?:地图\s*)?\d+\s*:/u.test(trimmed)) return "「地图号:x,y」的后半截不是坐标";
  return null;
}

/** The `to` spelling a grind stop uses: a map id, a coordinate, or an area name. */
function routeMapId(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : (text(value) ?? "");
  const match = /^(?:地图\s*)?(\d+)(?:\s*:.*)?$/u.exec(raw.trim());
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function routeIsCoordinate(value: unknown): boolean {
  const raw = typeof value === "number" ? String(value) : (text(value) ?? "");
  if (/^(?:地图\s*)?\d+\s*:/u.test(raw.trim())) return false;
  return cellText(raw);
}

interface GrindPlace {
  readonly mapId: number | null;
  readonly areaName: string | null;
  readonly label: string;
}

/** Resolve a grind stop's location as far as the fact sheet allows; null means unreadable. */
function grindPlace(to: unknown, facts: StageFacts): GrindPlace | null {
  const mapId = routeMapId(to);
  if (mapId !== null) return { mapId, areaName: null, label: `地图 ${mapId}` };
  if (routeIsCoordinate(to)) {
    if (facts.target.mapId === null) return null;
    return {
      mapId: facts.target.mapId,
      areaName: facts.target.areaName,
      label: facts.target.label || `地图 ${facts.target.mapId}`,
    };
  }
  const name = (typeof to === "number" ? String(to) : (text(to) ?? "")).trim();
  if (name === "") return null;
  const wanted = normalizeName(name);
  const targetNames = [facts.target.areaName, facts.target.label]
    .filter((entry): entry is string => entry !== null && entry !== "")
    .map((entry) => normalizeName(entry));
  if (targetNames.some((entry) => entry !== "" && (entry === wanted || entry.includes(wanted)))) {
    return { mapId: facts.target.mapId, areaName: name, label: name };
  }
  return { mapId: null, areaName: name, label: name };
}

function monsterName(monster: StageMonster | MonsterKnowledge): string {
  return monster.name;
}

function monsterBook(monster: StageMonster | MonsterKnowledge): number | null {
  return monster.bookId;
}

function monsterBlueMagic(monster: StageMonster | MonsterKnowledge): readonly string[] {
  if ("blueMagic" in monster) return monster.blueMagic;
  return [
    ...monster.moves.filter((move) => move.blueMagic === true).map((move) => move.name),
    ...monster.guideBlueMagic,
  ];
}

function nameMatches(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return a !== "" && b !== "" && (a === b || a.includes(b) || b.includes(a));
}

function monsterMatchesTarget(
  monster: StageMonster | MonsterKnowledge,
  target: string | number,
): boolean {
  if (typeof target === "number") return monsterBook(monster) === target;
  const numeric = /^\d+$/u.test(target.trim()) ? Number(target) : null;
  if (numeric !== null) return monsterBook(monster) === numeric;
  return nameMatches(monsterName(monster), target);
}

function monstersAt(
  place: GrindPlace,
  facts: StageFacts,
  knowledge: Knowledge | undefined,
): {
  readonly monsters: readonly (StageMonster | MonsterKnowledge)[];
  readonly known: boolean;
} {
  if (knowledge !== undefined) {
    const filter =
      place.mapId === null
        ? place.areaName === null
          ? {}
          : { areaName: place.areaName }
        : {
            mapIds: [place.mapId],
            ...(place.areaName === null ? {} : { areaName: place.areaName }),
          };
    return { monsters: monstersIn(knowledge, filter), known: true };
  }
  if (place.mapId !== null && facts.target.mapId === place.mapId) {
    return { monsters: facts.monsters, known: true };
  }
  const targetName = normalizeName(facts.target.areaName ?? facts.target.label);
  if (
    place.areaName !== null &&
    targetName !== "" &&
    normalizeName(place.areaName) === targetName
  ) {
    return { monsters: facts.monsters, known: true };
  }
  return { monsters: [], known: false };
}

/** Task 100: at least one condition, well-formed, before a grind is allowed into the plan. */
function checkGrindUntil(value: unknown, where: string, problems: string[]): boolean {
  if (!isRecord(value)) {
    problems.push(`${where}:do 是 grind 就要写 until`);
    return false;
  }
  let count = 0;
  const bestiary = value.bestiary;
  if (bestiary !== undefined) {
    if (!Array.isArray(bestiary) || bestiary.length === 0) {
      problems.push(`${where}:until.bestiary 要写成非空数组`);
    } else {
      for (const [index, entry] of bestiary.entries()) {
        if (typeof entry === "string" && entry.trim() !== "") count += 1;
        else if (typeof entry === "number" && Number.isFinite(entry)) count += 1;
        else problems.push(`${where}:until.bestiary[${index}] 不是怪名或图鉴号`);
      }
    }
  }
  const blueMagic = value.blueMagic;
  if (blueMagic !== undefined) {
    if (!Array.isArray(blueMagic) || blueMagic.length === 0) {
      problems.push(`${where}:until.blueMagic 要写成非空数组`);
    } else {
      for (const [index, entry] of blueMagic.entries()) {
        if (typeof entry === "string" && entry.trim() !== "") count += 1;
        else problems.push(`${where}:until.blueMagic[${index}] 不是青魔法名`);
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
  return count > 0;
}

function checkRoute(
  plan: StagePlan,
  facts: StageFacts,
  problems: string[],
  givenKnowledge?: Knowledge,
): void {
  const knowledge = givenKnowledge ?? stageFactsKnowledge(facts);
  for (const [index, stop] of plan.route.entries()) {
    const where = `路线第 ${index + 1} 个路标`;
    const bad = routeTargetProblem(stop.to);
    if (bad !== null) problems.push(`${where}:${bad}`);
    if (stop.do !== undefined && !ROUTE_ACTIONS.has(stop.do)) {
      problems.push(`${where}的 do 只能是 open、save、talk、grind、boss 或 handoff`);
    }
    if (stop.do !== "grind") {
      if (stop.until !== undefined) problems.push(`${where}:只有 do 是 grind 才能写 until`);
      continue;
    }
    const place = grindPlace(stop.to, facts);
    if (place === null) {
      problems.push(`${where}:刷怪地点解析不了`);
      continue;
    }
    if (!checkGrindUntil(stop.until, where, problems)) continue;
    const until = stop.until;
    if (until === undefined) continue;
    const hasMonsterTarget =
      (until.bestiary?.length ?? 0) > 0 || (until.blueMagic?.length ?? 0) > 0;
    if (!hasMonsterTarget) continue;
    const at = monstersAt(place, facts, knowledge);
    if (!at.known || at.monsters.length === 0) {
      problems.push(`${where}:按知识库查不到「${place.label}」有哪些怪，不能确认刷怪地点`);
      continue;
    }
    for (const target of until.bestiary ?? []) {
      if (!at.monsters.some((monster) => monsterMatchesTarget(monster, target))) {
        const name = typeof target === "number" ? `#${target}` : target;
        problems.push(`${where}:图鉴「${name}」不在「${place.label}」出现`);
      }
    }
    for (const spell of until.blueMagic ?? []) {
      if (
        !at.monsters.some((monster) =>
          monsterBlueMagic(monster).some((move) => nameMatches(move, spell)),
        )
      ) {
        problems.push(`${where}:「${place.label}」没有怪会放青魔法「${spell}」`);
      }
    }
  }
}

function checkTurnBack(value: unknown, index: number, problems: string[]): void {
  const where = `回头条件第 ${index + 1} 项`;
  if (!isRecord(value)) {
    problems.push(`${where}不是对象`);
    return;
  }
  const kind = text(value.kind) ?? "";
  switch (kind) {
    case "item-below": {
      const item = text(value.item)?.trim() ?? "";
      if (item === "") problems.push(`${where}没有写道具名`);
      if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count <= 0) {
        problems.push(`${where}「${item || "道具"}」的 count 要是 1 以上的整数`);
      }
      break;
    }
    case "status-uncurable": {
      const status = text(value.status)?.trim() ?? "";
      if (status === "") problems.push(`${where}没有写状态名`);
      break;
    }
    case "no-revive":
      break;
    case "hp-below": {
      const percent = value.percent;
      if (
        typeof percent !== "number" ||
        !Number.isFinite(percent) ||
        percent <= 0 ||
        percent > 100
      ) {
        problems.push(`${where}的 percent 要在 1 到 100 之间`);
      }
      break;
    }
    default:
      problems.push(`${where}的类型「${kind || "空"}」不认识，只能用四种 kind`);
  }
}

function statusMatches(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

/** The names that count as handling one status; the generic cures cover the unknown ones. */
function cureNamesFor(status: string): Set<string> {
  const names = new Set<string>(GENERIC_CURES);
  let matched = false;
  for (const [key, cures] of Object.entries(STATUS_CURES)) {
    if (!statusMatches(status, key)) continue;
    matched = true;
    for (const name of [...cures.items, ...cures.spells]) names.add(name);
  }
  if (!matched) names.add(status);
  return names;
}

function planCovers(status: string, plan: StagePlan): boolean {
  const wanted = new Set([...cureNamesFor(status)].map((name) => normalizeName(name)));
  const names = [
    ...plan.supplies.filter((supply) => supply.buyTo > 0).map((supply) => supply.item),
    ...plan.spells.map((entry) => entry.spell),
  ];
  return names.some((name) => {
    const normalized = normalizeName(name);
    if (normalized === "") return false;
    return [...wanted].some(
      (cure) => cure !== "" && (normalized === cure || normalized.includes(cure)),
    );
  });
}

/**
 * Return one Chinese line per problem; an empty list means the plan can be used. Pure: no
 * game, no files. The code repeats the subset checks the prompt asks for, because a trusted
 * schema says nothing about whether a shop actually sells the potion.
 */
export function checkStagePlan(
  plan: StagePlan,
  facts: StageFacts,
  knowledge?: Knowledge,
): string[] {
  const problems: string[] = [];
  checkSupplies(plan, facts, problems);
  checkSpells(plan, facts, problems);
  checkJobs(plan, facts, problems);
  checkRoute(plan, facts, problems, knowledge);
  for (const [index, condition] of plan.turnBack.entries()) {
    checkTurnBack(condition, index, problems);
  }
  if (plan.minLevel !== null && (!Number.isInteger(plan.minLevel) || plan.minLevel < 1)) {
    problems.push("minLevel 要是 1 以上的整数，或者 null");
  }
  for (const threat of facts.statusThreats) {
    if (threat.likelihood !== "high") continue;
    if (!planCovers(threat.status, plan)) {
      problems.push(`高威胁状态「${threat.status}」没有对应的药或魔法`);
    }
  }
  return problems;
}

function bad(field: string): never {
  throw new Error(`阶段官的结果里 ${field} 不对`);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") bad(field);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) bad(field);
  return value.map((item, index) => stringField(item, `${field}[${index}]`));
}

function recordList(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) bad(field);
  return value.map((item, index) => {
    if (!isRecord(item)) bad(`${field}[${index}]`);
    return item;
  });
}

function integerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) bad(`${field} 不是整数`);
  return value;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") bad(`${field} 不是布尔值`);
  return value;
}

function optionalNames(
  value: unknown,
  field: string,
  allowNumbers: boolean,
): readonly (string | number)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) bad(field);
  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.trim() !== "") return entry.trim();
    if (allowNumbers && typeof entry === "number" && Number.isFinite(entry)) {
      return Math.trunc(entry);
    }
    return bad(`${field}[${index}]`);
  });
}

function readStageGrindUntil(value: unknown, field: string): StageGrindUntil {
  if (!isRecord(value)) bad(field);
  const bestiary = optionalNames(value.bestiary, `${field}.bestiary`, true);
  const blueMagic = optionalNames(value.blueMagic, `${field}.blueMagic`, false)?.map((name) =>
    String(name),
  );
  const battles =
    value.battles === undefined ? undefined : integerField(value.battles, `${field}.battles`);
  const minutes = value.minutes === undefined ? undefined : value.minutes;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes))) {
    bad(`${field}.minutes`);
  }
  return {
    ...(bestiary === undefined ? {} : { bestiary }),
    ...(blueMagic === undefined ? {} : { blueMagic }),
    ...(battles === undefined ? {} : { battles }),
    ...(minutes === undefined ? {} : { minutes }),
  };
}

/** Task 117: the route book's station metadata on one stop; absent for officer-written stops. */
function readBookPoint(value: unknown, field: string): StagePlan["route"][number]["book"] {
  if (!isRecord(value)) bad(field);
  const part = value.part === undefined ? undefined : integerField(value.part, `${field}.part`);
  const parts = value.parts === undefined ? undefined : integerField(value.parts, `${field}.parts`);
  return {
    section: stringField(value.section, `${field}.section`),
    index: integerField(value.index, `${field}.index`),
    kind: stringField(value.kind, `${field}.kind`),
    text: stringField(value.text, `${field}.text`),
    where: value.where === null ? null : stringField(value.where, `${field}.where`),
    ...(part === undefined ? {} : { part }),
    ...(parts === undefined ? {} : { parts }),
    ...(value.autoStory === true ? { autoStory: true } : {}),
  };
}

/** Read the schema-validated structured reply; throws a Chinese error when it is malformed. */
export function readStagePlan(value: unknown): StagePlan {
  if (!isRecord(value)) bad("structured（不是对象）");
  const supplies = recordList(value.supplies, "supplies").map((entry, index) => ({
    item: stringField(entry.item, `supplies[${index}].item`),
    min: integerField(entry.min, `supplies[${index}].min`),
    buyTo: integerField(entry.buyTo, `supplies[${index}].buyTo`),
  }));
  const spells = recordList(value.spells, "spells").map((entry, index) => {
    const forValue = entry.for;
    return {
      spell: stringField(entry.spell, `spells[${index}].spell`),
      for: forValue === null ? null : stringField(forValue, `spells[${index}].for`),
    };
  });
  const jobs = recordList(value.jobs, "jobs").map((entry, index) => ({
    member: stringField(entry.member, `jobs[${index}].member`),
    job: stringField(entry.job, `jobs[${index}].job`),
    reason: stringField(entry.reason, `jobs[${index}].reason`),
  }));
  const route = recordList(value.route, "route").map((entry, index) => {
    const doValue = entry.do;
    if (doValue !== undefined && !ROUTE_ACTIONS.has(stringField(doValue, `route[${index}].do`))) {
      bad(`route[${index}].do`);
    }
    const until =
      entry.until === undefined
        ? undefined
        : readStageGrindUntil(entry.until, `route[${index}].until`);
    if (doValue !== "grind" && until !== undefined) bad(`route[${index}].until`);
    const optional = entry.optional;
    const book =
      entry.book === undefined ? undefined : readBookPoint(entry.book, `route[${index}].book`);
    return {
      to: stringField(entry.to, `route[${index}].to`),
      ...(doValue === undefined
        ? {}
        : {
            do: doValue as "open" | "save" | "talk" | "grind" | "boss" | "handoff",
          }),
      ...(until === undefined ? {} : { until }),
      ...(optional === undefined
        ? {}
        : { optional: booleanField(optional, `route[${index}].optional`) }),
      ...(book === undefined ? {} : { book }),
    };
  });
  const turnBack = recordList(value.turnBack, "turnBack").map((entry, index) => {
    const kind = stringField(entry.kind, `turnBack[${index}].kind`);
    switch (kind) {
      case "item-below":
        return {
          kind,
          item: stringField(entry.item, `turnBack[${index}].item`),
          count: integerField(entry.count, `turnBack[${index}].count`),
        } as const;
      case "status-uncurable":
        return {
          kind,
          status: stringField(entry.status, `turnBack[${index}].status`),
        } as const;
      case "no-revive":
        return { kind } as const;
      case "hp-below":
        return {
          kind,
          percent: integerField(entry.percent, `turnBack[${index}].percent`),
        } as const;
      default:
        return bad(`turnBack[${index}].kind（${kind}）`);
    }
  });
  const minLevel = value.minLevel;
  if (minLevel !== null && typeof minLevel !== "number") bad("minLevel");
  return {
    threats: stringList(value.threats, "threats"),
    supplies,
    spells,
    gear: stringList(value.gear, "gear"),
    jobs,
    minLevel: minLevel === null ? null : integerField(minLevel, "minLevel"),
    route,
    turnBack,
    notes: stringField(value.notes, "notes"),
  };
}

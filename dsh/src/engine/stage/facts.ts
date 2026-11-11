/**
 * The stage fact sheet (task 94, stage layer §1). A stage is one destination plus the town it
 * starts from and the world map in between. Before the stage officer plans it, the code puts
 * everything the plan may depend on into one `StageFacts` object: the monsters and the statuses
 * they inflict, the blue spells this save has not learned, chests and whether they are opened,
 * save and recovery points, shops, the party and the bag, and the guide's chapter.
 *
 *     const facts = buildStageFacts({ target, knowledge, atlas, party, bag, gil });
 *     const text = describeStageFacts(facts);
 *
 * `buildStageFacts` is pure: the caller reads the party and the bag (the game does that) and
 * hands them in. Nothing here talks to the bridge, files or the clock. It also works before the
 * bridge has exported anything: with only a guide, the guide's monster and chest rows answer,
 * and every source is `攻略`.
 *
 * 11-10: the user wants the blue spells planned like a bestiary (which are still missing, and
 * which will be gone for good), and wants the Fire-Powered Ship's boss-room recovery point in
 * front of the officer. A point without a known cell is left out rather than guessed.
 */

import type { Atlas } from "../atlas.ts";
import type { Guide } from "../guide/kb.ts";
import {
  blueMagicSources,
  chestsIn,
  itemsThatCure,
  monstersIn,
  normalizeName,
  shopsNear,
  statusThreats,
  type BlueMagicSource,
  type ChestKnowledge,
  type Knowledge,
  type MonsterKnowledge,
  type ShopKnowledge,
  type SourceRef,
  type StatusThreat,
} from "../knowledge/index.ts";
import { isRecord, list, records, text, type Json } from "../values.ts";
import type { Cell, StageFacts, StageMonster, StageTarget } from "./types.ts";

/** The whole sheet is one prompt; the guide gets the largest share of it. */
export const STAGE_FACTS_LIMIT = 6000;
/** The guide chapter is cut to this many characters; the rest of the sheet stays readable. */
export const STAGE_GUIDE_LIMIT = 3200;

const MAX_MONSTERS = 40;
const MAX_CHESTS = 30;
const MAX_SHOPS = 12;
const MAX_SHOP_PRODUCTS = 12;
const MAX_BOSS_NOTES = 8;
const BOSS_NOTE_LIMIT = 700;
/** Encounter chance × move rate at or above this: a threat the plan must answer. */
const HIGH_THREAT = 0.3;
/** The middle band; below it a known risk is low and an unquantified one stays unknown. */
const MEDIUM_THREAT = 0.1;

const SAVE_POINT = /save\s*point|savepoint|存档点|セーブポイント/iu;
const RECOVERY_POINT =
  /recovery\s*(?:point|device)|restore\s*(?:point|device)|回复装置|回復装置|回复点|回復点|全回复|全回復/iu;
const POINT_COORDINATES = /[[(（]\s*(\d{1,3})\s*[,，]\s*(\d{1,3})\s*[\])）]/gu;

const SOURCE_LABELS: Readonly<Record<SourceRef["kind"], string>> = {
  master: "游戏数据",
  files: "游戏文件",
  guide: "攻略",
  save: "存档",
  observed: "记录",
};

export type StagePartyMember = StageFacts["party"][number];
export type StageBagItem = StageFacts["bag"][number];

/** Everything the caller must read before planning; the rest is derived from knowledge. */
export interface StageFactsInput {
  readonly target: StageTarget;
  readonly knowledge: Knowledge;
  /** Optional: save/recovery points recorded by walking, when the caller has the atlas. */
  readonly atlas?: Atlas | null;
  readonly party: readonly StagePartyMember[];
  readonly bag: readonly StageBagItem[];
  readonly gil: number;
  /** Overrides `knowledge.progress.blueMagic` when the caller has a fresher list. */
  readonly learnedBlueMagic?: readonly (number | string)[];
}

/** Details the shared `StageFacts` shape has no field for, kept beside the object. */
interface StageDetails {
  readonly knowledge: Knowledge;
  readonly threatCures: ReadonlyMap<string, CureReport>;
  readonly threatSources: ReadonlyMap<string, readonly string[]>;
  readonly blueMagicSources: ReadonlyMap<string, readonly string[]>;
  readonly chestSources: ReadonlyMap<string, readonly string[]>;
  readonly shopSources: ReadonlyMap<string, readonly string[]>;
  readonly pointSources: ReadonlyMap<string, readonly string[]>;
}

interface CureReport {
  /** Whether the item/magic tables know a cure for this status at all. */
  readonly known: boolean;
  readonly items: readonly { readonly name: string; readonly count: number }[];
  readonly spells: readonly string[];
}

interface PointCollection {
  readonly savePoints: readonly { readonly mapId: number; readonly cell: Cell }[];
  readonly recoveryPoints: readonly {
    readonly mapId: number;
    readonly cell: Cell;
    readonly label: string;
  }[];
  readonly sources: ReadonlyMap<string, readonly string[]>;
}

const DETAILS = new WeakMap<StageFacts, StageDetails>();

/** Task 100: the knowledge behind a fact sheet, for checkStagePlan's location checks. */
export function stageFactsKnowledge(facts: StageFacts): Knowledge | undefined {
  return DETAILS.get(facts)?.knowledge;
}

/** The target's display name: the guide's area name, else the label, plus the map id. */
export function stageTitle(target: StageTarget): string {
  const place = target.areaName ?? target.label;
  const map = target.mapId === null ? "" : `地图 ${target.mapId}`;
  if (place === "" || place === map) return map || "这一段";
  if (target.label !== "" && target.label !== place) {
    return map === "" ? `${place}(${target.label})` : `${place}(${target.label}) · ${map}`;
  }
  return map === "" ? place : `${place} · ${map}`;
}

/**
 * Build the fact sheet. No file, bridge or clock is touched: the same input always gives the
 * same facts. The result keeps the shared shape; the cure details `describeStageFacts` prints
 * are stored beside it in a WeakMap, so callers can still serialise the object as it is.
 */
export function buildStageFacts(input: StageFactsInput): StageFacts {
  const target = input.target;
  const filter = stageFilter(target);
  const stageMonsters = monstersIn(input.knowledge, filter);
  const known = new Set(input.knowledge.progress.bestiary);
  const monsters = stageMonsters
    .slice(0, MAX_MONSTERS)
    .map((monster) => stageMonster(monster, known));
  const threats = statusThreats(stageMonsters);
  const threatCures = new Map<string, CureReport>();
  const threatSources = new Map<string, readonly string[]>();
  for (const threat of threats) {
    threatCures.set(
      threat.status,
      cureReport(input.knowledge, input.party, input.bag, threat.status),
    );
    threatSources.set(threat.status, sourceLabels(threat.sources));
  }
  // The party's own ability list is a fresher "learned" source than the save export; the
  // caller can override it, and blueMagicSources ignores every non-blue name anyway.
  const learned = input.learnedBlueMagic ?? input.party.flatMap((member) => member.spells);
  const blue = missingBlueMagic(input.knowledge, stageMonsters, target, learned);
  const chests = stageChests(input.knowledge, filter, target);
  const guideText = stageGuideText(input.knowledge, target);
  const points = collectPoints(input.atlas, input.knowledge, target, guideText);
  const shops = stageShops(input.knowledge, target);
  const facts: StageFacts = {
    target,
    monsters,
    statusThreats: threats.map((threat) => ({
      status: threat.status,
      monsters: unique(threat.moves.map((move) => move.monster)),
      likelihood: likelihoodOf(threat),
    })),
    blueMagicMissing: blue.facts,
    chests: chests.facts,
    savePoints: points.savePoints,
    recoveryPoints: points.recoveryPoints,
    shops: shops.facts,
    party: input.party,
    bag: input.bag,
    gil: input.gil,
    bossNotes: bossNotes(input.knowledge, stageMonsters, target),
    guideText,
  };
  DETAILS.set(facts, {
    knowledge: input.knowledge,
    threatCures,
    threatSources,
    blueMagicSources: blue.sources,
    chestSources: chests.sources,
    shopSources: shops.sources,
    pointSources: points.sources,
  });
  return facts;
}

/** The Chinese text for the stage officer: sections, compact, with a hard total limit. */
export function describeStageFacts(facts: StageFacts): string {
  const details = DETAILS.get(facts);
  const lines: string[] = [
    "你是阶段官。下面是代码整理的事实单,这一段只规划一次。",
    "### 目的地",
    stageTitle(facts.target),
  ];
  lines.push("### 怪物", ...monsterLines(facts.monsters));
  lines.push("### 状态威胁", ...threatLines(facts.statusThreats, details));
  lines.push("### 缺的青魔法", ...blueMagicLines(facts.blueMagicMissing, details));
  lines.push("### 宝箱", ...chestLines(facts.chests, details));
  lines.push("### 存档点 / 回复点", ...pointLines(facts, details));
  lines.push("### 商店", ...shopLines(facts.shops, details));
  lines.push("### 队伍", ...partyLines(facts.party));
  lines.push("### 背包", ...bagLines(facts.bag, facts.gil));
  if (facts.bossNotes.length > 0)
    lines.push("### 首领", ...facts.bossNotes.map((note) => `- ${note}`));
  lines.push(
    "### 攻略",
    facts.guideText === "" ? "攻略没有加载,或者没有找到这一段。" : facts.guideText,
  );
  lines.push("来源简写:游戏数据=桥插件导出,攻略=Steam/ludo 攻略,记录=地图记录。");
  return truncate(lines.join("\n"), STAGE_FACTS_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Monsters, threats and blue magic

function stageFilter(target: StageTarget): {
  readonly mapIds?: readonly number[];
  readonly areaName?: string;
} {
  const areaName =
    target.areaName ?? (target.mapId === null && target.label !== "" ? target.label : null);
  return {
    ...(target.mapId === null ? {} : { mapIds: [target.mapId] }),
    ...(areaName === null ? {} : { areaName }),
  };
}

function stageMonster(monster: MonsterKnowledge, known: ReadonlySet<number>): StageMonster {
  const masterBlue = monster.moves
    .filter((move) => move.blueMagic === true)
    .map((move) => move.name);
  return {
    id: monster.id,
    bookId: monster.bookId,
    name: monster.name,
    weak: monster.weak,
    absorb: monster.absorb,
    statusMoves: monster.moves
      .filter((move) => move.conditions.length > 0)
      .map((move) => ({ name: move.name, conditions: move.conditions })),
    // The master's move rows are the primary source; the guide's names only fill the gap (the
    // same merge rule `blueMagicSources` uses, so the two lists do not disagree).
    blueMagic: masterBlue.length > 0 ? unique(masterBlue) : unique(monster.guideBlueMagic),
    boss: monster.boss === true,
    sources: sourceLabels(monster.sources),
    registered: monster.bookId === null ? undefined : known.has(monster.bookId),
  };
}

function likelihoodOf(threat: StatusThreat): StageFacts["statusThreats"][number]["likelihood"] {
  if (threat.score === null) return "unknown";
  if (threat.score >= HIGH_THREAT) return "high";
  if (threat.score >= MEDIUM_THREAT) return "medium";
  return threat.unknown ? "unknown" : "low";
}

function cureReport(
  knowledge: Knowledge,
  party: readonly StagePartyMember[],
  bag: readonly StageBagItem[],
  status: string,
): CureReport {
  const cures = itemsThatCure(knowledge, status);
  const items: { name: string; count: number }[] = [];
  for (const cure of cures) {
    if (cure.kind !== "item") continue;
    const held = bag.find(
      (item) => item.count > 0 && normalizeName(item.name) === normalizeName(cure.name),
    );
    if (
      held !== undefined &&
      !items.some((item) => normalizeName(item.name) === normalizeName(held.name))
    ) {
      items.push({ name: held.name, count: held.count });
    }
  }
  const spells = unique(
    cures
      .filter((cure) => cure.kind === "magic")
      .filter((cure) =>
        party.some((member) =>
          member.spells.some((spell) => normalizeName(spell) === normalizeName(cure.name)),
        ),
      )
      .map((cure) => cure.name),
  );
  return { known: cures.length > 0, items, spells };
}

function missingBlueMagic(
  knowledge: Knowledge,
  stageMonsters: readonly MonsterKnowledge[],
  target: StageTarget,
  learned: readonly (number | string)[] | undefined,
): {
  facts: StageFacts["blueMagicMissing"];
  sources: ReadonlyMap<string, readonly string[]>;
} {
  const names = new Set(stageMonsters.map((monster) => normalizeName(monster.name)));
  const books = new Set(
    stageMonsters.flatMap((monster) => (monster.bookId === null ? [] : [monster.bookId])),
  );
  const areaKeys = targetAreaKeys(knowledge, target);
  const targetNames = [target.areaName, target.label, mapNameOf(knowledge, target.mapId)]
    .filter((name): name is string => name !== null && name !== "")
    .map(normalizeName);
  const sources = blueMagicSources(knowledge, learned === undefined ? {} : { learned });
  const facts: { name: string; monsters: string[]; missable: boolean | null }[] = [];
  const labels = new Map<string, readonly string[]>();
  for (const source of sources) {
    const from = source.from.filter(
      (item) =>
        names.has(normalizeName(item.monster)) ||
        (item.bookId !== null && books.has(item.bookId)) ||
        (targetNames.length > 0 &&
          item.areas.some((area) => {
            const own = normalizeName(area);
            return own !== "" && targetNames.some((key) => own.includes(key) || key.includes(own));
          })),
    );
    if (from.length === 0) continue;
    facts.push({
      name: source.name,
      monsters: unique(from.map((item) => item.monster)),
      missable: blueMagicMissable(knowledge, from, areaKeys),
    });
    labels.set(normalizeName(source.name), sourceLabels(source.sources));
  }
  return { facts, sources: labels };
}

function blueMagicMissable(
  knowledge: Knowledge,
  from: BlueMagicSource["from"],
  areaKeys: readonly number[],
): boolean | null {
  const profile = knowledge.profile;
  if (profile === null) return null;
  const numbers = new Set(from.flatMap((item) => (item.bookId === null ? [] : [item.bookId])));
  // Task 93's profile list is the game's own timed bestiary; a source number on it is gone for
  // good after its story point. A one-time place makes every spell taught there missable too.
  if (
    profile.bestiaryMissables.some((rule) => rule.numbers.some((number) => numbers.has(number)))
  ) {
    return true;
  }
  if (profile.oneTimePlaces.some((place) => areaKeys.includes(place.area))) return true;
  // A guide-only row without a bestiary number cannot be checked against the numbered rule.
  return from.every((item) => item.bookId === null) ? null : false;
}

// ---------------------------------------------------------------------------------------------
// Chests, points, shops

function stageChests(
  knowledge: Knowledge,
  filter: { readonly mapIds?: readonly number[]; readonly areaName?: string },
  target: StageTarget,
): {
  facts: StageFacts["chests"];
  sources: ReadonlyMap<string, readonly string[]>;
} {
  const chests = chestsIn(knowledge, filter);
  const areaKeys = targetAreaKeys(knowledge, target);
  const facts = chests.slice(0, MAX_CHESTS).map((chest) => ({
    label: chestLabel(knowledge, chest),
    content: chest.contentName,
    mapId: chest.mapId,
    cell: chest.cell,
    opened: chest.opened,
    missable: chestMissable(knowledge, chest, areaKeys),
  }));
  const sources = new Map<string, readonly string[]>();
  for (const chest of chests.slice(0, MAX_CHESTS)) {
    sources.set(chestKey(chest), sourceLabels(chest.sources));
  }
  return { facts, sources };
}

function chestLabel(knowledge: Knowledge, chest: ChestKnowledge): string {
  const where = chest.guide?.where.trim() ?? "";
  if (where !== "") return oneLine(where);
  const map = chest.mapId === null ? null : mapNameOf(knowledge, chest.mapId);
  const cell = chest.cell === null ? "" : ` (${chest.cell[0]},${chest.cell[1]})`;
  return `${map ?? (chest.mapId === null ? "地图不明" : `地图 ${chest.mapId}`)}${cell}`;
}

function chestMissable(
  knowledge: Knowledge,
  chest: ChestKnowledge,
  areaKeys: readonly number[],
): boolean | null {
  const guide = chest.guide?.text ?? "";
  if (/one[- ]visit|missable|can'?t (?:get|return)|gone after/iu.test(guide)) return true;
  const profile = knowledge.profile;
  if (profile === null) return null;
  const map = chest.mapId === null ? null : knowledge.maps.find((item) => item.id === chest.mapId);
  const areaId = chest.areaId ?? map?.areaId ?? null;
  if (areaId !== null && profile.oneTimePlaces.some((place) => place.area === areaId)) return true;
  // A guide-only chest has no area id; if the whole stage is a one-time place, it is missable.
  if (
    areaId === null &&
    areaKeys.some((id) => profile.oneTimePlaces.some((place) => place.area === id))
  ) {
    return true;
  }
  return false;
}

function chestKey(chest: ChestKnowledge): string {
  const cell = chest.cell === null ? "" : `${chest.cell[0]},${chest.cell[1]}`;
  return `\u0000${chest.mapId ?? ""}\u0000${cell}\u0000${normalizeName(chest.contentName ?? "")}`;
}

function collectPoints(
  atlas: Atlas | null | undefined,
  knowledge: Knowledge,
  target: StageTarget,
  guideText: string,
): PointCollection {
  const savePoints: { mapId: number; cell: Cell }[] = [];
  const recoveryPoints: { mapId: number; cell: Cell; label: string }[] = [];
  const sources = new Map<string, readonly string[]>();
  const relevant = new Set(stageTargetMapIds(knowledge, target));
  const targetNames = [target.areaName, target.label, mapNameOf(knowledge, target.mapId)]
    .filter((name): name is string => name !== null && name !== "")
    .map(normalizeName);
  for (const [key, entry] of atlas?.maps ?? []) {
    const mapId = Number(key);
    if (!Number.isFinite(mapId)) continue;
    if (!relevantPointMap(mapId, entry, relevant, targetNames)) continue;
    collectPointField(entry.savePoints, mapId, false, savePoints, recoveryPoints, sources);
    collectPointField(entry.save_points, mapId, false, savePoints, recoveryPoints, sources);
    collectPointField(entry.recoveryPoints, mapId, true, savePoints, recoveryPoints, sources);
    collectEntities(entry.entities, mapId, savePoints, recoveryPoints, sources);
    collectEntities(entry.points, mapId, savePoints, recoveryPoints, sources);
    collectChestPoints(entry.chests, mapId, savePoints, recoveryPoints, sources);
  }
  collectGuidePoints(guideText, relevant, target.mapId, savePoints, recoveryPoints, sources);
  return {
    savePoints: uniquePoints(savePoints).map((point) => ({ mapId: point.mapId, cell: point.cell })),
    recoveryPoints: uniqueRecoveries(recoveryPoints),
    sources,
  };
}

function relevantPointMap(
  mapId: number,
  entry: Json,
  relevant: ReadonlySet<number>,
  targetNames: readonly string[],
): boolean {
  if (relevant.size > 0) return relevant.has(mapId);
  if (targetNames.length === 0) return false;
  const name = normalizeName(text(entry.name) ?? "");
  return name !== "" && targetNames.some((key) => name.includes(key) || key.includes(name));
}

function collectPointField(
  value: unknown,
  mapId: number,
  recovery: boolean,
  savePoints: { mapId: number; cell: Cell }[],
  recoveryPoints: { mapId: number; cell: Cell; label: string }[],
  sources: Map<string, readonly string[]>,
): void {
  for (const raw of list(value)) {
    const cell = isRecord(raw) ? cellOf(raw.cell ?? raw.tile) : cellOf(raw);
    if (cell === null) continue;
    const label = isRecord(raw) ? (text(raw.label) ?? text(raw.name) ?? "回复点") : "回复点";
    if (recovery) recoveryPoints.push({ mapId, cell, label });
    else savePoints.push({ mapId, cell });
    sources.set(pointKey(recovery ? "recovery" : "save", mapId, cell), ["记录"]);
  }
}

function collectEntities(
  value: unknown,
  mapId: number,
  savePoints: { mapId: number; cell: Cell }[],
  recoveryPoints: { mapId: number; cell: Cell; label: string }[],
  sources: Map<string, readonly string[]>,
): void {
  for (const raw of records(value)) {
    const name = text(raw.name) ?? text(raw.kind) ?? "";
    const cell = cellOf(raw.cell ?? raw.tile);
    if (cell === null || name === "") continue;
    if (SAVE_POINT.test(name)) {
      savePoints.push({ mapId, cell });
      sources.set(pointKey("save", mapId, cell), ["记录"]);
    } else if (RECOVERY_POINT.test(name)) {
      recoveryPoints.push({ mapId, cell, label: name });
      sources.set(pointKey("recovery", mapId, cell), ["记录"]);
    }
  }
}

/** Older atlas records only kept chests; a save point sometimes sits in that list by name. */
function collectChestPoints(
  value: unknown,
  mapId: number,
  savePoints: { mapId: number; cell: Cell }[],
  recoveryPoints: { mapId: number; cell: Cell; label: string }[],
  sources: Map<string, readonly string[]>,
): void {
  for (const raw of records(value)) {
    const name = text(raw.name) ?? "";
    const cell = cellOf(raw.cell);
    if (cell === null || name === "") continue;
    if (SAVE_POINT.test(name)) {
      savePoints.push({ mapId, cell });
      sources.set(pointKey("save", mapId, cell), ["记录"]);
    } else if (RECOVERY_POINT.test(name)) {
      recoveryPoints.push({ mapId, cell, label: name });
      sources.set(pointKey("recovery", mapId, cell), ["记录"]);
    }
  }
}

/**
 * A guide sentence with a cell, e.g. "Save Point (12, 34)". Without coordinates the mention is
 * left to the guide text; a point is never given a guessed cell.
 */
function collectGuidePoints(
  guideText: string,
  relevant: ReadonlySet<number>,
  targetMapId: number | null,
  savePoints: { mapId: number; cell: Cell }[],
  recoveryPoints: { mapId: number; cell: Cell; label: string }[],
  sources: Map<string, readonly string[]>,
): void {
  if (guideText === "") return;
  const mapId = targetMapId ?? (relevant.size === 1 ? ([...relevant][0] ?? null) : null);
  if (mapId === null) return;
  for (const line of guideText.split(/\n+/u)) {
    const save = SAVE_POINT.test(line);
    const recovery = RECOVERY_POINT.test(line);
    if (!save && !recovery) continue;
    for (const match of line.matchAll(POINT_COORDINATES)) {
      const x = Number.parseInt(match[1] ?? "", 10);
      const y = Number.parseInt(match[2] ?? "", 10);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const cell: Cell = [x, y];
      if (save) {
        savePoints.push({ mapId, cell });
        sources.set(pointKey("save", mapId, cell), ["攻略"]);
      }
      if (recovery) {
        recoveryPoints.push({ mapId, cell, label: "回复装置" });
        sources.set(pointKey("recovery", mapId, cell), ["攻略"]);
      }
    }
  }
}

function stageShops(
  knowledge: Knowledge,
  target: StageTarget,
): {
  facts: StageFacts["shops"];
  sources: ReadonlyMap<string, readonly string[]>;
} {
  const picked = new Map<string, ShopKnowledge>();
  for (const query of shopQueries(knowledge, target)) {
    for (const shop of shopsNear(knowledge, query)) picked.set(shopKey(shop), shop);
  }
  const relevantMaps = new Set(stageTargetMapIds(knowledge, target));
  for (const shop of knowledge.shops) {
    if (shop.mapId !== null && relevantMaps.has(shop.mapId)) picked.set(shopKey(shop), shop);
  }
  // The start town is not part of `StageTarget` yet, so a stage with no shop of its own lists
  // the game's known shops instead of hiding where the officer may buy supplies (11-10).
  const shops = (picked.size > 0 ? [...picked.values()] : [...knowledge.shops]).slice(0, MAX_SHOPS);
  const sources = new Map<string, readonly string[]>();
  const facts = shops.map((shop) => {
    const area =
      shop.areaName ?? (shop.mapId === null ? "?" : (mapNameOf(knowledge, shop.mapId) ?? "?"));
    const kind = shop.kind ?? "商店";
    sources.set(shopFactKey(area, kind), sourceLabels(shop.sources));
    return {
      area,
      kind,
      products: shop.products
        .slice(0, MAX_SHOP_PRODUCTS)
        .map((product) => ({ name: product.name, price: product.price })),
    };
  });
  return { facts, sources };
}

function shopQueries(knowledge: Knowledge, target: StageTarget): string[] {
  const queries = [target.areaName, target.label, mapNameOf(knowledge, target.mapId)].filter(
    (query): query is string => query !== null && query !== "",
  );
  for (const mapId of stageTargetMapIds(knowledge, target)) {
    const map = knowledge.maps.find((item) => item.id === mapId);
    for (const value of [map?.name ?? null, map?.areaName ?? null]) {
      if (value !== null && value !== "" && !queries.includes(value)) queries.push(value);
    }
  }
  return unique(queries);
}

function shopKey(shop: ShopKnowledge): string {
  return `${shop.id ?? ""}\u0000${normalizeName(shop.areaName ?? "")}\u0000${normalizeName(shop.kind ?? "")}`;
}

function shopFactKey(area: string, kind: string): string {
  return `\u0000${normalizeName(area)}\u0000${normalizeName(kind)}`;
}

// ---------------------------------------------------------------------------------------------
// Guide, boss notes, target helpers

function stageGuideText(knowledge: Knowledge, target: StageTarget): string {
  const guide: Guide | null = knowledge.guide;
  if (guide === null) return "";
  const query =
    target.areaName ??
    (target.mapId === null ? target.label : (mapNameOf(knowledge, target.mapId) ?? target.label));
  if (query === "") return "";
  let body = guide.area(query, STAGE_GUIDE_LIMIT);
  if (body === "") body = guide.search(query, STAGE_GUIDE_LIMIT);
  return truncate(body, STAGE_GUIDE_LIMIT);
}

function bossNotes(
  knowledge: Knowledge,
  stageMonsters: readonly MonsterKnowledge[],
  target: StageTarget,
): string[] {
  const guide = knowledge.guide;
  if (guide === null) return [];
  const query =
    target.areaName ??
    (target.mapId === null ? target.label : (mapNameOf(knowledge, target.mapId) ?? target.label));
  const notes: string[] = [];
  for (const monster of stageMonsters) {
    if (monster.boss !== true) continue;
    const note = monster.bookId === null ? "" : guide.monsterNote(monster.bookId, BOSS_NOTE_LIMIT);
    notes.push(
      note === "" ? `${monster.name}:攻略没有单独写它。` : `${monster.name}:${oneLine(note)}`,
    );
  }
  const known = new Set(stageMonsters.map((monster) => normalizeName(monster.name)));
  const named = query === "" ? [] : guide.bossNames(query);
  const extra = named.filter((name) => !known.has(normalizeName(name)));
  if (extra.length > 0) notes.push(`攻略点名的首领:${extra.join("、")}`);
  return unique(notes).slice(0, MAX_BOSS_NOTES);
}

/** Task 106: every map the stage covers, for filtering a boss location to this stage. */
export function stageTargetMapIds(knowledge: Knowledge, target: StageTarget): number[] {
  const ids = new Set<number>();
  if (target.mapId !== null) ids.add(target.mapId);
  const keys = [target.areaName, target.label]
    .filter((name): name is string => name !== null && name !== "")
    .map(normalizeName);
  const areaIds = targetAreaKeys(knowledge, target);
  for (const map of knowledge.maps) {
    if (map.id === null) continue;
    if (map.areaId !== null && areaIds.includes(map.areaId)) ids.add(map.id);
    const name = normalizeName(map.name ?? "");
    if (name !== "" && keys.some((key) => name.includes(key) || key.includes(name))) {
      ids.add(map.id);
    }
  }
  return [...ids];
}

function targetAreaKeys(knowledge: Knowledge, target: StageTarget): number[] {
  const out = new Set<number>();
  const keys = [target.areaName, target.label]
    .filter((name): name is string => name !== null && name !== "")
    .map(normalizeName);
  for (const map of knowledge.maps) {
    if (map.areaId === null) continue;
    const name = normalizeName(map.name ?? "");
    const area = normalizeName(map.areaName ?? "");
    if (
      map.id === target.mapId ||
      keys.some(
        (key) =>
          (name !== "" && (name.includes(key) || key.includes(name))) ||
          (area !== "" && (area.includes(key) || key.includes(area))),
      )
    ) {
      out.add(map.areaId);
    }
  }
  return [...out];
}

function mapNameOf(knowledge: Knowledge, mapId: number | null): string | null {
  if (mapId === null) return null;
  return knowledge.maps.find((map) => map.id === mapId)?.name ?? null;
}

// ---------------------------------------------------------------------------------------------
// Description helpers

function monsterLines(monsters: readonly StageMonster[]): string[] {
  if (monsters.length === 0) return ["- 没有记录"];
  return monsters.map((monster) => {
    const tags: string[] = [];
    if (monster.weak.length > 0) tags.push(`弱:${monster.weak.join("、")}`);
    if (monster.absorb.length > 0) tags.push(`吸:${monster.absorb.join("、")}`);
    if (monster.statusMoves.length > 0) {
      tags.push(
        `状态:${monster.statusMoves
          .map((move) => `${move.name}→${move.conditions.join("/")}`)
          .join("、")}`,
      );
    }
    if (monster.blueMagic.length > 0) tags.push(`青魔法:${monster.blueMagic.join("、")}`);
    if (monster.boss) tags.push("首领");
    if (monster.registered === false) tags.push("本档图鉴:缺");
    const book = monster.bookId === null ? "" : ` #${String(monster.bookId).padStart(3, "0")}`;
    const suffix = sourceSuffix(monster.sources);
    return `- ${monster.name}${book}${tags.length > 0 ? ` ${tags.join(" ")}` : ""}${suffix}`;
  });
}

function threatLines(
  threats: StageFacts["statusThreats"],
  details: StageDetails | undefined,
): string[] {
  if (threats.length === 0) return ["- 没有数据"];
  return threats.map((threat) => {
    const cure = cureText(details?.threatCures.get(threat.status));
    const sources = details?.threatSources.get(threat.status) ?? [];
    return `- ${threat.status}(${likelihoodText(threat.likelihood)}):${threat.monsters.join("、")}${
      cure === "" ? "" : `;${cure}`
    }${sourceSuffix(sources)}`;
  });
}

function blueMagicLines(
  spells: StageFacts["blueMagicMissing"],
  details: StageDetails | undefined,
): string[] {
  if (spells.length === 0) return ["- 这一段没有缺的青魔法"];
  return spells.map((spell) => {
    const missable =
      spell.missable === null ? "是否错过:未知" : spell.missable ? "可能错过" : "不会错过";
    const sources = details?.blueMagicSources.get(normalizeName(spell.name)) ?? [];
    return `- ${spell.name}:${spell.monsters.join("、")};${missable}${sourceSuffix(sources)}`;
  });
}

function chestLines(chests: StageFacts["chests"], details: StageDetails | undefined): string[] {
  if (chests.length === 0) return ["- 没有记录"];
  return chests.map((chest) => {
    const opened = chest.opened === null ? "开没开:未知" : chest.opened ? "已开" : "未开";
    const missable = chest.missable === null ? "是否错过:未知" : chest.missable ? "可能错过" : "";
    const map = chest.mapId === null ? "" : `地图 ${chest.mapId}`;
    const cell = chest.cell === null ? "" : ` (${chest.cell[0]},${chest.cell[1]})`;
    const sources = details?.chestSources.get(chestKeyOfFact(chest)) ?? [];
    const tags = [opened, missable].filter((tag) => tag !== "").join(";");
    return `- ${chest.label}${map === "" ? "" : ` · ${map}`}${cell}:${chest.content ?? "内容不明"};${tags}${sourceSuffix(sources)}`;
  });
}

function chestKeyOfFact(chest: StageFacts["chests"][number]): string {
  const cell = chest.cell === null ? "" : `${chest.cell[0]},${chest.cell[1]}`;
  return `\u0000${chest.mapId ?? ""}\u0000${cell}\u0000${normalizeName(chest.content ?? "")}`;
}

function pointLines(facts: StageFacts, details: StageDetails | undefined): string[] {
  const lines: string[] = [];
  for (const point of facts.savePoints) {
    const sources = details?.pointSources.get(pointKey("save", point.mapId, point.cell)) ?? [];
    lines.push(
      `- 存档点 地图 ${point.mapId} (${point.cell[0]},${point.cell[1]})${sourceSuffix(sources)}`,
    );
  }
  for (const point of facts.recoveryPoints) {
    const sources = details?.pointSources.get(pointKey("recovery", point.mapId, point.cell)) ?? [];
    lines.push(
      `- 回复点 地图 ${point.mapId} (${point.cell[0]},${point.cell[1]}) ${point.label}${sourceSuffix(sources)}`,
    );
  }
  if (lines.length === 0) {
    const mentioned = SAVE_POINT.test(facts.guideText) || RECOVERY_POINT.test(facts.guideText);
    lines.push(
      mentioned ? "- 地图记录里没认出坐标;攻略提到过,见攻略" : "- 地图记录里没认出;攻略也没提",
    );
  }
  return lines;
}

function shopLines(shops: StageFacts["shops"], details: StageDetails | undefined): string[] {
  if (shops.length === 0) return ["- 没有记录"];
  return shops.map((shop) => {
    const key = shopFactKey(shop.area, shop.kind);
    const sources = details?.shopSources.get(key) ?? [];
    const goods =
      shop.products.length === 0
        ? "没有货品记录"
        : shop.products
            .map(
              (product) => `${product.name}${product.price === null ? " ?" : ` ${product.price}`}`,
            )
            .join("、");
    return `- ${shop.area} ${shop.kind}:${goods}${sourceSuffix(sources)}`;
  });
}

function partyLines(party: readonly StagePartyMember[]): string[] {
  if (party.length === 0) return ["- 读不到队伍"];
  return party.map((member) => {
    const status = member.status.length === 0 ? "无" : member.status.join("、");
    const spells = member.spells.length === 0 ? "无" : member.spells.join("、");
    return `- ${member.name} ${member.job} Lv${member.level} HP ${member.hp}/${member.maxHp} MP ${member.mp}/${member.maxMp} 状态:${status} 魔法:${spells}`;
  });
}

function bagLines(bag: readonly StageBagItem[], gil: number): string[] {
  const items =
    bag.length === 0 ? "空" : bag.map((item) => `${item.name}×${item.count}`).join("、");
  return [`- 金钱 ${gil}`, `- ${items}`];
}

function cureText(report: CureReport | undefined): string {
  if (report === undefined) return "";
  const known: string[] = [];
  if (report.items.length > 0) {
    known.push(`背包有${report.items.map((item) => `${item.name}×${item.count}`).join("、")}`);
  }
  if (report.spells.length > 0) known.push(`队伍会${report.spells.join("、")}`);
  if (known.length > 0) return known.join(";");
  return report.known ? "背包没有能治的,队伍也不会" : "资料里没有能治它的道具或魔法";
}

function sourceSuffix(sources: readonly string[]): string {
  return sources.length === 0 ? "" : ` [${sources.join("/")}]`;
}

function likelihoodText(likelihood: StageFacts["statusThreats"][number]["likelihood"]): string {
  switch (likelihood) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    case "unknown":
      return "未知";
  }
}

function sourceLabels(sources: readonly SourceRef[]): string[] {
  return unique(sources.map((source) => SOURCE_LABELS[source.kind]));
}

function pointKey(kind: "save" | "recovery", mapId: number, cell: Cell): string {
  return `${kind}:${mapId}:${cell[0]},${cell[1]}`;
}

function uniquePoints(points: readonly { mapId: number; cell: Cell }[]): {
  mapId: number;
  cell: Cell;
}[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = pointKey("save", point.mapId, point.cell);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueRecoveries(
  points: readonly { mapId: number; cell: Cell; label: string }[],
): { mapId: number; cell: Cell; label: string }[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = pointKey("recovery", point.mapId, point.cell);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x: unknown = value[0];
  const y: unknown = value[1];
  return typeof x === "number" && typeof y === "number" ? [x, y] : null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const suffix = "\n…(事实单太长,后面省略)";
  const room = Math.max(0, limit - Array.from(suffix).length);
  return characters.slice(0, room).join("") + suffix;
}

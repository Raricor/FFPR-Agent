/**
 * The fact sheet for one segment plan (task 137, 11-11). The player model writes one complete
 * `SegmentPlan` per route-book section; before it does, this module turns the loaded section,
 * the knowledge module and the party into one structured sheet plus the Chinese text the model
 * reads. The draft plan is the safe starting point: the route book's own stations, with the
 * battle and boss tables left empty for the model to fill.
 *
 * Pure: no bridge, no file, no clock. `segmentFacts` uses the same route-book → stage-plan
 * conversion as tasks 117/126/133/136, so an opened chest stays out, heal/save stops are
 * optional, and every station keeps the `book` origin.
 */

import type { Atlas } from "../atlas.ts";
import { cleanName } from "../icons.ts";
import {
  monstersIn,
  normalizeName,
  shopsNear,
  type Knowledge,
  type MonsterKnowledge,
  type ShopKnowledge,
} from "../knowledge/index.ts";
import type { Cell } from "../nav.ts";
import { HEAL_ITEMS, HEAL_SPELLS } from "../skills/battle.ts";
import { num, records, text } from "../values.ts";
import { routeFromBookSection } from "../stage/book-plan.ts";
import type {
  RouteBlueMagic,
  RouteBookFiles,
  RouteBookSave,
  RouteMonster,
  RouteSection,
} from "../stage/route-book.ts";
import type { StagePlan } from "../stage/types.ts";
import type { PlanStation, PlanStationAction, SegmentPlan } from "./types.ts";

/** The sheet is one prompt; past this the hard tail is cut with a pointer to the JSON. */
export const SEGMENT_FACTS_LIMIT = 8000;

const MAX_STATIONS = 40;
const MAX_MONSTERS = 40;
const MAX_BOSSES = 12;
const MAX_SHOPS = 12;
const MAX_SHOP_PRODUCTS = 12;
const MAX_CHESTS = 20;
const MAX_BAG = 20;
const MAX_GUIDE_NOTE = 600;
const DEFAULT_GRIND_MINUTES = 8;

/** One map this section covers, with the exits the atlas has recorded from it. */
export interface SegmentFactsMap {
  readonly mapId: number;
  readonly name: string;
  readonly areaName: string | null;
  readonly reasons: readonly string[];
  readonly exits: readonly { readonly mapId: number; readonly name: string }[];
}

/** A map the party may cross on the way to this section, or return to for "回头学". */
export interface SegmentFactsPassMap {
  readonly mapId: number;
  readonly name: string;
  readonly from: readonly number[];
}

export interface SegmentFactsMonster {
  readonly name: string;
  readonly guideName: string | null;
  readonly bookId: number | null;
  readonly level: number | null;
  readonly hp: number | null;
  readonly mp: number | null;
  readonly weak: readonly string[];
  readonly absorb: readonly string[];
  readonly nullify: readonly string[];
  readonly statusImmune: readonly string[];
  readonly statusMoves: readonly {
    readonly name: string;
    readonly conditions: readonly string[];
  }[];
  readonly blueMagic: readonly string[];
  readonly maps: readonly number[];
  /** 0–1 chance one battle has this monster; null when the weights are unknown. */
  readonly chance: number | null;
  readonly missable: boolean;
  readonly missableUntil: string | null;
  /** true / false from this save, null when the save has not said. */
  readonly registered: boolean | null;
  readonly boss: boolean;
  readonly note: string;
}

export interface SegmentFactsBoss {
  /** The route book's name (often the guide's English name). */
  readonly name: string;
  /** The game data's Chinese name, when the two could be paired. */
  readonly knowledgeName: string | null;
  readonly guideName: string | null;
  readonly bookId: number | null;
  readonly maps: readonly number[];
  /**
   * Task 146: event/NPC cells on this boss's maps whose name contains its Japanese name.
   * Empty when the knowledge name is unknown or no map file names it; never guessed.
   */
  readonly triggers: readonly { readonly map: number; readonly cell: Cell }[];
  /**
   * Task 146 follow-up: true when this save's bestiary already has the boss. False/null/absent
   * means unknown; the plan check then treats the boss as not beaten.
   */
  readonly defeated?: boolean | null;
  readonly hp: number | null;
  readonly mp: number | null;
  readonly level: number | null;
  readonly weak: readonly string[];
  readonly absorb: readonly string[];
  readonly nullify: readonly string[];
  readonly statusImmune: readonly string[];
  readonly guideNote: string;
  readonly note: string;
}

export interface SegmentFactsShopProduct {
  readonly name: string;
  readonly price: number | null;
  /** The item table id, so a plan can name the same thing in another language. */
  readonly itemId?: number | null;
}

export interface SegmentFactsShop {
  readonly area: string;
  readonly kind: string;
  readonly products: readonly SegmentFactsShopProduct[];
}

export interface SegmentFactsPartyMember {
  readonly name: string;
  readonly job: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly mp: number;
  readonly maxMp: number;
  readonly status: readonly string[];
  readonly spells: readonly string[];
  readonly abilities?: readonly string[];
}

export interface SegmentFactsBagItem {
  readonly name: string;
  readonly count: number;
}

/** Task 146: the facts behind the one "回复手段" line; no advice. */
export interface SegmentFactsHealing {
  /** Members who know 治疗/救疗, with the spell each knows. */
  readonly spells: readonly { readonly member: string; readonly spell: string }[];
  /** Healing items in the bag, from battle.ts's HEAL_ITEMS. */
  readonly items: readonly SegmentFactsBagItem[];
  /** Revive items in the bag, matched by the names the game and knowledge use. */
  readonly reviveItems: readonly SegmentFactsBagItem[];
}

export interface SegmentFactsChest {
  readonly item: string;
  readonly where: string | null;
  readonly mapId: number | null;
  readonly mapName: string | null;
  readonly cell: Cell | null;
  readonly opened: boolean | null;
  readonly note: string;
}

export interface SegmentFactsBlueMagic {
  readonly name: string;
  readonly learned: boolean;
  /** True when this party has a Blue Mage (or the route book says so). */
  readonly canLearn: boolean;
  readonly maps: readonly number[];
  readonly teachers: readonly {
    readonly monster: string;
    readonly bookId: number | null;
    readonly maps: readonly number[];
  }[];
  readonly timing: string;
  readonly when: string;
  readonly window: string;
  readonly note: string;
}

/** Everything structured the model may depend on. The text is built from this. */
export interface SegmentFactsData {
  readonly game: string;
  readonly section: string;
  readonly areaName: string | null;
  readonly goal: string;
  readonly maps: readonly SegmentFactsMap[];
  readonly passThrough: readonly SegmentFactsPassMap[];
  readonly revisitMaps: readonly SegmentFactsPassMap[];
  readonly stations: readonly PlanStation[];
  readonly chests: readonly SegmentFactsChest[];
  readonly monsters: readonly SegmentFactsMonster[];
  readonly bosses: readonly SegmentFactsBoss[];
  readonly shops: readonly SegmentFactsShop[];
  readonly party: readonly SegmentFactsPartyMember[];
  readonly bag: readonly SegmentFactsBagItem[];
  /** Task 146: structured form of the same facts the "回复手段" line shows. */
  readonly healing?: SegmentFactsHealing;
  readonly gil: number;
  readonly bestiaryMissing: readonly SegmentFactsMonster[];
  readonly blueMagic: readonly SegmentFactsBlueMagic[];
  readonly blueMagicMissing: readonly SegmentFactsBlueMagic[];
  readonly notes: readonly string[];
  /** Where the party stood when the sheet was built, when the caller knew it. */
  readonly currentMapId?: number | null;
  /** Why the default-section picker chose this section; absent for an explicit section. */
  readonly sectionReason?: string | null;
}

export interface SegmentFactsInput {
  readonly game?: string;
  readonly section: RouteSection;
  readonly knowledge: Knowledge;
  readonly save?: RouteBookSave | null;
  readonly party: readonly SegmentFactsPartyMember[];
  readonly bag: readonly SegmentFactsBagItem[];
  readonly gil: number;
  /** Config's cap for one grind stop; the draft copies it into `until.minutes`. */
  readonly grindMinutes?: number;
  /** Where the party stands now; legal station target even when it is another section's map. */
  readonly currentMapId?: number | null;
  /** Maps crossed from the current position to this section, from cross-map planning. */
  readonly routeMaps?: readonly number[];
  /** Task 146: the game files' events/NPCs, for putting a boss's trigger cell in the sheet. */
  readonly files?: RouteBookFiles | null;
  /** Why this section was chosen, when `section` was omitted. */
  readonly sectionReason?: string | null;
}

export interface SegmentFactsResult {
  readonly data: SegmentFactsData;
  readonly text: string;
  readonly draftPlan: SegmentPlan;
}

interface FactsDetails {
  readonly knowledge: Knowledge;
  readonly allowedMaps: ReadonlySet<number>;
  readonly sectionMaps: ReadonlySet<number>;
  readonly learnedBlueMagic: ReadonlySet<string>;
}

const DETAILS = new WeakMap<SegmentFactsData, FactsDetails>();

/** The knowledge behind a sheet, for `validatePlan`'s item/job checks. */
export function segmentFactsKnowledge(facts: SegmentFactsData): Knowledge | undefined {
  return DETAILS.get(facts)?.knowledge;
}

/** The maps a plan may target: this section, its direct exits and its "回头学" maps. */
export function segmentFactsAllowedMaps(facts: SegmentFactsData): ReadonlySet<number> {
  return DETAILS.get(facts)?.allowedMaps ?? new Set(facts.maps.map((map) => map.mapId));
}

/** The section's own maps, which a grind target must be met on. */
export function segmentFactsSectionMaps(facts: SegmentFactsData): ReadonlySet<number> {
  return DETAILS.get(facts)?.sectionMaps ?? new Set(facts.maps.map((map) => map.mapId));
}

/** Blue spells this save already knows, by normalized name. */
export function segmentFactsLearnedBlueMagic(facts: SegmentFactsData): ReadonlySet<string> {
  return DETAILS.get(facts)?.learnedBlueMagic ?? new Set();
}

function mapNameOf(knowledge: Knowledge, mapId: number): string | null {
  const fromAtlas = text(knowledge.atlas?.maps.get(String(mapId))?.name);
  if (fromAtlas !== undefined && fromAtlas !== "") return fromAtlas;
  const known = knowledge.maps.find((map) => map.id === mapId)?.name;
  return known ?? null;
}

function mapAreaOf(knowledge: Knowledge, mapId: number): string | null {
  return knowledge.maps.find((map) => map.id === mapId)?.areaName ?? null;
}

function exitsOf(
  knowledge: Knowledge,
  mapId: number,
): readonly { readonly mapId: number; readonly name: string }[] {
  const atlas: Atlas | null = knowledge.atlas;
  const entry = atlas?.maps.get(String(mapId));
  const out: { mapId: number; name: string }[] = [];
  const seen = new Set<number>();
  for (const raw of records(entry?.exits)) {
    const to = num(raw.to);
    if (to === undefined) continue;
    const target = Math.trunc(to);
    if (target <= 0 || target === mapId || seen.has(target)) continue;
    seen.add(target);
    out.push({
      mapId: target,
      name: text(raw.name) ?? mapNameOf(knowledge, target) ?? `地图 ${target}`,
    });
  }
  return out;
}

function sectionMaps(knowledge: Knowledge, section: RouteSection): SegmentFactsMap[] {
  return section.maps.map((map) => ({
    mapId: map.mapId,
    name: mapNameOf(knowledge, map.mapId) ?? map.name,
    areaName: map.areaName ?? mapAreaOf(knowledge, map.mapId),
    reasons: map.reasons,
    exits: exitsOf(knowledge, map.mapId),
  }));
}

function passThroughMaps(
  knowledge: Knowledge,
  maps: readonly SegmentFactsMap[],
  own: ReadonlySet<number>,
): SegmentFactsPassMap[] {
  const from = new Map<number, Set<number>>();
  for (const map of maps) {
    for (const exit of map.exits) {
      if (own.has(exit.mapId)) continue;
      const set = from.get(exit.mapId) ?? new Set<number>();
      set.add(map.mapId);
      from.set(exit.mapId, set);
    }
  }
  return [...from.entries()].slice(0, 40).map(([mapId, sources]) => ({
    mapId,
    name: mapNameOf(knowledge, mapId) ?? `地图 ${mapId}`,
    from: [...sources],
  }));
}

function revisitMaps(knowledge: Knowledge, section: RouteSection): SegmentFactsPassMap[] {
  const ids = new Set<number>();
  for (const map of section.revisit?.maps ?? []) ids.add(map.mapId);
  for (const station of section.revisit?.stations ?? []) {
    if (station.mapId !== null) ids.add(station.mapId);
  }
  return [...ids].map((mapId) => ({
    mapId,
    name: mapNameOf(knowledge, mapId) ?? `地图 ${mapId}`,
    from: [],
  }));
}

// ---------------------------------------------------------------------------------------------
// Monsters and bosses

function masterByBook(knowledge: Knowledge, bookId: number | null): MonsterKnowledge | null {
  if (bookId === null) return null;
  return knowledge.monsters.find((monster) => monster.bookId === bookId) ?? null;
}

function masterByName(knowledge: Knowledge, name: string): MonsterKnowledge | null {
  const wanted = normalizeName(name);
  if (wanted === "") return null;
  return (
    knowledge.monsters.find(
      (monster) =>
        normalizeName(monster.name) === wanted ||
        monster.guideAreas.some((area) => normalizeName(area) === wanted),
    ) ?? null
  );
}

function masterOf(knowledge: Knowledge, row: RouteMonster | null): MonsterKnowledge | null {
  if (row === null) return null;
  return (
    masterByBook(knowledge, row.bookId) ??
    masterByName(knowledge, row.name) ??
    (row.guideName === null ? null : masterByName(knowledge, row.guideName))
  );
}

/** The guide's bestiary table also maps a route-book English name to an in-game number. */
function bookIdForGuideName(knowledge: Knowledge, name: string): number | null {
  const wanted = normalizeName(name);
  if (wanted === "") return null;
  for (const [book, guideName] of knowledge.guide?.bestiary ?? []) {
    if (normalizeName(guideName) === wanted) return book;
  }
  return null;
}

function routeMonsterFor(
  section: RouteSection,
  master: MonsterKnowledge | null,
  name: string,
): RouteMonster | null {
  const wanted = normalizeName(name);
  return (
    section.monsters.find(
      (row) =>
        (master?.bookId !== null && master?.bookId !== undefined && row.bookId === master.bookId) ||
        normalizeName(row.name) === wanted ||
        (row.guideName !== null && normalizeName(row.guideName) === wanted),
    ) ??
    section.bosses.find(
      (row) =>
        (master?.bookId !== null && master?.bookId !== undefined && row.bookId === master.bookId) ||
        normalizeName(row.name) === wanted ||
        (row.guideName !== null && normalizeName(row.guideName) === wanted),
    ) ??
    null
  );
}

function registeredOf(
  master: MonsterKnowledge | null,
  row: RouteMonster | null,
  bestiary: ReadonlySet<number> | null | undefined,
): boolean | null {
  if (row?.registered !== null && row?.registered !== undefined) return row.registered;
  if (master?.bookId === null || master?.bookId === undefined) return null;
  return bestiary?.has(master.bookId) ?? null;
}

function monsterFacts(
  row: RouteMonster | null,
  master: MonsterKnowledge | null,
  bestiary: ReadonlySet<number> | null | undefined,
  fallbackMaps: readonly number[],
): SegmentFactsMonster {
  const name = master?.name ?? row?.name ?? "未知怪物";
  const maps =
    row !== null && row.maps.length > 0
      ? row.maps
      : master === null
        ? fallbackMaps
        : [...new Set(master.encounters.flatMap((encounter) => encounter.mapIds))];
  const masterBlue =
    master === null
      ? []
      : master.moves.filter((move) => move.blueMagic === true).map((move) => move.name);
  return {
    name,
    guideName: row?.guideName ?? null,
    bookId: master?.bookId ?? row?.bookId ?? null,
    level: master?.level ?? null,
    hp: master?.hp ?? null,
    mp: master?.mp ?? null,
    weak: master?.weak ?? [],
    absorb: master?.absorb ?? [],
    nullify: master?.nullify ?? [],
    statusImmune: master?.statusImmune ?? [],
    statusMoves:
      master === null
        ? []
        : master.moves
            .filter((move) => move.conditions.length > 0)
            .map((move) => ({ name: move.name, conditions: move.conditions })),
    blueMagic:
      masterBlue.length > 0 ? [...new Set(masterBlue)] : [...new Set(master?.guideBlueMagic ?? [])],
    maps,
    chance: master?.encounterChance ?? null,
    missable: row?.missable ?? false,
    missableUntil: row?.missableUntil ?? null,
    registered: registeredOf(master, row, bestiary),
    boss: master?.boss === true || row?.boss === true,
    note: row?.note ?? master?.guideNote ?? "",
  };
}

function collectMonsters(
  knowledge: Knowledge,
  section: RouteSection,
  bestiary: ReadonlySet<number> | null | undefined,
): SegmentFactsMonster[] {
  const sectionMapIds = section.maps.map((map) => map.mapId);
  const found = new Map<string, SegmentFactsMonster>();
  const keyOf = (monster: SegmentFactsMonster): string =>
    monster.bookId === null ? `name:${normalizeName(monster.name)}` : `book:${monster.bookId}`;
  for (const master of monstersIn(knowledge, { mapIds: sectionMapIds })) {
    const row = routeMonsterFor(section, master, master.name);
    const facts = monsterFacts(row, master, bestiary, sectionMapIds);
    found.set(keyOf(facts), facts);
  }
  for (const row of section.monsters) {
    const master = masterOf(knowledge, row);
    const facts = monsterFacts(row, master, bestiary, sectionMapIds);
    found.set(keyOf(facts), facts);
  }
  return [...found.values()];
}

function bossMaster(knowledge: Knowledge, row: RouteMonster): MonsterKnowledge | null {
  const direct = masterOf(knowledge, row);
  if (direct !== null) return direct;
  for (const name of [row.name, row.guideName]) {
    if (name === null) continue;
    const bookId = bookIdForGuideName(knowledge, name);
    const master = masterByBook(knowledge, bookId);
    if (master !== null) return master;
  }
  return null;
}

function bossGuideNote(
  knowledge: Knowledge,
  section: RouteSection,
  row: RouteMonster,
  master: MonsterKnowledge | null,
): string {
  const bookId = row.bookId ?? master?.bookId ?? null;
  const fromBestiary =
    bookId === null || knowledge.guide === null
      ? ""
      : knowledge.guide.monsterNote(bookId, MAX_GUIDE_NOTE);
  if (fromBestiary !== "") return fromBestiary;
  const name = normalizeName(row.name);
  const nearby = section.notes.find((note) => normalizeName(note.text).includes(name));
  if (nearby !== undefined) return nearby.text.slice(0, MAX_GUIDE_NOTE);
  return row.note;
}

/** The cell an event trigger starts at: its own cell, else the top-left of its rectangle. */
function eventCellOf(event: RouteBookFiles["events"][number]): Cell | null {
  if (event.cell !== null) return event.cell;
  if (event.rect === null) return null;
  return [event.rect.x1, event.rect.y1];
}

/**
 * Task 146: the trigger cells for one boss, from the game files' event/NPC names. The boss's
 * Japanese name is the knowledge monster name; a missing name means no triggers, never a guess.
 */
function bossTriggerCells(
  japaneseName: string | null,
  maps: readonly number[],
  files: RouteBookFiles | null | undefined,
): { readonly map: number; readonly cell: Cell }[] {
  const wanted = normalizeName(japaneseName ?? "");
  if (wanted === "" || files === null || files === undefined) return [];
  const own = new Set(maps);
  const found: { readonly map: number; readonly cell: Cell }[] = [];
  const seen = new Set<string>();
  const add = (map: number, cell: Cell): void => {
    if (!own.has(map)) return;
    const key = `${map}|${cell[0]},${cell[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ map, cell });
  };
  for (const event of files.events) {
    if (!own.has(event.mapId) || !normalizeName(event.name).includes(wanted)) continue;
    const cell = eventCellOf(event);
    if (cell !== null) add(event.mapId, cell);
  }
  for (const npc of files.npcs) {
    if (!own.has(npc.mapId)) continue;
    const names = [npc.name, npc.names?.ja, npc.names?.en, npc.names?.zhc].filter(
      (name): name is string => typeof name === "string" && name !== "",
    );
    if (!names.some((name) => normalizeName(name).includes(wanted))) continue;
    add(npc.mapId, npc.cell);
  }
  return found
    .sort(
      (left, right) =>
        left.map - right.map || left.cell[1] - right.cell[1] || left.cell[0] - right.cell[0],
    )
    .slice(0, 20);
}

function collectBosses(
  knowledge: Knowledge,
  section: RouteSection,
  files: RouteBookFiles | null | undefined,
): SegmentFactsBoss[] {
  return section.bosses.map((row) => {
    const master = bossMaster(knowledge, row);
    return {
      name: row.name,
      knowledgeName: master?.name ?? null,
      guideName: row.guideName,
      bookId: row.bookId ?? master?.bookId ?? null,
      maps: row.maps,
      triggers: bossTriggerCells(master?.name ?? null, row.maps, files),
      defeated: row.registered,
      hp: master?.hp ?? null,
      mp: master?.mp ?? null,
      level: master?.level ?? null,
      weak: master?.weak ?? [],
      absorb: master?.absorb ?? [],
      nullify: master?.nullify ?? [],
      statusImmune: master?.statusImmune ?? [],
      guideNote: bossGuideNote(knowledge, section, row, master),
      note: row.note,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Shops, chests, blue magic

function shopKey(shop: ShopKnowledge): string {
  return `${shop.id ?? ""}\u0000${normalizeName(shop.areaName ?? "")}\u0000${normalizeName(shop.kind ?? "")}`;
}

function collectShops(
  knowledge: Knowledge,
  section: RouteSection,
  routeMaps: readonly number[],
): SegmentFactsShop[] {
  const picked = new Map<string, ShopKnowledge>();
  // 11-11: a section's maps can be split across a region, and the shops the party buys from
  // can be in a town on the way in. Query every map's name and area, not just the section title.
  const queries = [
    section.areaName,
    section.title,
    ...section.maps.flatMap((map) => [map.name, map.areaName]),
    ...routeMaps.map((mapId) => mapNameOf(knowledge, mapId)),
    ...routeMaps.map((mapId) => mapAreaOf(knowledge, mapId)),
  ]
    .filter((value): value is string => value !== null && value.trim() !== "")
    .filter((value, index, all) => all.indexOf(value) === index);
  for (const query of queries) {
    for (const shop of shopsNear(knowledge, query)) picked.set(shopKey(shop), shop);
  }
  const mapIds = new Set([...section.maps.map((map) => map.mapId), ...routeMaps]);
  for (const shop of knowledge.shops) {
    if (shop.mapId !== null && mapIds.has(shop.mapId)) picked.set(shopKey(shop), shop);
  }
  return [...picked.values()].slice(0, MAX_SHOPS).map((shop) => ({
    area: cleanName(
      shop.areaName ?? (shop.mapId === null ? "?" : (mapNameOf(knowledge, shop.mapId) ?? "?")),
    ),
    kind: cleanName(shop.kind ?? "商店"),
    products: shop.products.slice(0, MAX_SHOP_PRODUCTS).map((product) => ({
      name: cleanName(product.name),
      price: product.price,
      itemId: product.itemId,
    })),
  }));
}

function chestFacts(knowledge: Knowledge, section: RouteSection): SegmentFactsChest[] {
  return section.chests
    .filter((chest) => chest.opened !== true)
    .slice(0, MAX_CHESTS)
    .map((chest) => ({
      item: chest.item,
      where: chest.where,
      mapId: chest.mapId,
      mapName: chest.mapName ?? (chest.mapId === null ? null : mapNameOf(knowledge, chest.mapId)),
      cell: chest.cell,
      opened: chest.opened,
      note: chest.note,
    }));
}

function isBlueMageJob(job: string): boolean {
  const wanted = normalizeName(job);
  return wanted === "bluemage" || wanted === "青魔导士";
}

function learnedBlueMagic(
  save: RouteBookSave | null | undefined,
  party: readonly SegmentFactsPartyMember[],
): Set<string> {
  const out = new Set<string>();
  for (const name of save?.blueMagic ?? []) {
    const normalized = normalizeName(name);
    if (normalized !== "") out.add(normalized);
  }
  for (const member of party) {
    for (const spell of member.spells) {
      const normalized = normalizeName(spell);
      if (normalized !== "") out.add(normalized);
    }
  }
  return out;
}

function collectBlueMagic(
  section: RouteSection,
  party: readonly SegmentFactsPartyMember[],
  learned: ReadonlySet<string>,
): SegmentFactsBlueMagic[] {
  const partyHasBlueMage = party.some((member) => isBlueMageJob(member.job));
  return section.blueMagic.map((spell: RouteBlueMagic) => {
    const name = normalizeName(spell.name);
    const known = spell.learned === true || learned.has(name);
    return {
      name: spell.name,
      learned: known,
      canLearn: spell.hasBlueMage === true || partyHasBlueMage,
      maps: spell.maps,
      teachers: spell.teachers.map((teacher) => ({
        monster: teacher.monster,
        bookId: teacher.bookId,
        maps: teacher.maps,
      })),
      timing: spell.timing,
      when: spell.when,
      window: spell.window,
      note: spell.note,
    };
  });
}

/** Existing spellings of the revive item; the knowledge names are added when present. */
const REVIVE_ITEM_NAMES: readonly string[] = [
  "不死鸟之尾",
  "凤凰尾",
  "Phoenix Down",
  "フェニックスの尾",
];
const REVIVE_ITEM_PATTERN = /不死鸟|凤凰|phoenix|フェニックス/iu;

function reviveItemNames(knowledge: Knowledge): string[] {
  const names = new Set(REVIVE_ITEM_NAMES);
  for (const item of knowledge.contentItems) {
    const known = [item.names.ja, item.names.en, item.names.zhc].filter(
      (name): name is string => name !== null && name.trim() !== "",
    );
    if (!known.some((name) => REVIVE_ITEM_PATTERN.test(name))) continue;
    for (const name of known) names.add(name);
  }
  return [...names];
}

function nameMatches(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a === "" || b === "") return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Task 146: party spells and bag items, as facts only; no "bring a white mage" advice. */
function healingFacts(
  party: readonly SegmentFactsPartyMember[],
  bag: readonly SegmentFactsBagItem[],
  knowledge: Knowledge,
): SegmentFactsHealing {
  const spells: { member: string; spell: string }[] = [];
  for (const member of party) {
    for (const spell of member.spells) {
      const name = cleanName(spell);
      if (!HEAL_SPELLS.includes(name)) continue;
      if (spells.some((entry) => entry.member === member.name && entry.spell === name)) continue;
      spells.push({ member: member.name, spell: name });
    }
  }
  const items = bag.filter(
    (item) => item.count > 0 && HEAL_ITEMS.some((name) => nameMatches(item.name, name)),
  );
  const revive = reviveItemNames(knowledge);
  const reviveItems = bag.filter(
    (item) => item.count > 0 && revive.some((name) => nameMatches(item.name, name)),
  );
  return { spells, items, reviveItems };
}

function healingLine(healing: SegmentFactsHealing): string {
  if (
    healing.spells.length === 0 &&
    healing.items.length === 0 &&
    healing.reviveItems.length === 0
  ) {
    return "回复手段:没人会回复魔法，没有回复道具";
  }
  const parts: string[] = [];
  if (healing.spells.length > 0) {
    parts.push(healing.spells.map((entry) => `${entry.spell}(${entry.member})`).join("、"));
  }
  if (healing.items.length > 0) {
    parts.push(`${healing.items.map((item) => `${item.name}×${item.count}`).join("、")}(回复)`);
  }
  if (healing.reviveItems.length > 0) {
    parts.push(
      `${healing.reviveItems.map((item) => `${item.name}×${item.count}`).join("、")}(复活)`,
    );
  }
  return `回复手段:${parts.join("、")}`;
}

// ---------------------------------------------------------------------------------------------
// Fact sheet
function mergePassThrough(
  base: readonly SegmentFactsPassMap[],
  extra: readonly SegmentFactsPassMap[],
): SegmentFactsPassMap[] {
  const byId = new Map<number, SegmentFactsPassMap>();
  for (const map of [...base, ...extra]) {
    const found = byId.get(map.mapId);
    if (found === undefined) {
      byId.set(map.mapId, map);
      continue;
    }
    byId.set(map.mapId, { ...found, from: [...new Set([...found.from, ...map.from])] });
  }
  return [...byId.values()];
}

/** Maps crossed from where the party stands to this section, plus the standing map itself. */
function routePassThrough(
  knowledge: Knowledge,
  own: ReadonlySet<number>,
  revisit: ReadonlySet<number>,
  currentMapId: number | null,
  routeMaps: readonly number[],
): SegmentFactsPassMap[] {
  const ids = new Set(routeMaps);
  if (currentMapId !== null) ids.add(currentMapId);
  return [...ids]
    .filter((mapId) => !own.has(mapId) && !revisit.has(mapId))
    .map((mapId) => ({
      mapId,
      name: mapNameOf(knowledge, mapId) ?? `地图 ${mapId}`,
      from: [],
    }));
}

export interface DefaultSectionChoice {
  readonly section: RouteSection;
  readonly index: number;
  readonly reason: string;
}

/**
 * The section `plan_facts` defaults to: the unfinished section covering the party's map, or
 * the next unfinished section in route-book order. 11-11: standing in a finished shrine still
 * needs the next plan; "no current section" must not make plan_facts fail.
 */
export function chooseDefaultSection(
  sections: readonly RouteSection[],
  mapId: number | null,
  finished: (section: RouteSection) => boolean,
): DefaultSectionChoice | null {
  if (sections.length === 0) return null;
  const containing =
    mapId === null
      ? []
      : sections.flatMap((section, index) =>
          section.maps.some((map) => map.mapId === mapId) ? [index] : [],
        );
  const here = containing.find((index) => {
    const section = sections[index];
    return section !== undefined && !finished(section);
  });
  if (here !== undefined) {
    const section = sections[here];
    if (section !== undefined) {
      return {
        section,
        index: here,
        reason: `当前地图 ${String(mapId)} 在「${section.title}」里,这一节还没完成`,
      };
    }
  }
  const next = sections.findIndex((section) => !finished(section));
  if (next < 0) return null;
  const section = sections[next];
  if (section === undefined) return null;
  const why =
    mapId === null
      ? "读不到当前地图"
      : containing.length === 0
        ? `当前地图 ${String(mapId)} 不属于路线书的任何一节`
        : `当前地图 ${String(mapId)} 所属的节都已完成`;
  return {
    section,
    index: next,
    reason: `${why},按路线书顺序取下一个没完成的节「${section.title}」`,
  };
}

/** Build the structured sheet, its Chinese text and the conservative draft plan. */
export function segmentFacts(input: SegmentFactsInput): SegmentFactsResult {
  const knowledge = input.knowledge;
  const section = input.section;
  const game = input.game ?? knowledge.game;
  const maps = sectionMaps(knowledge, section);
  const ownMaps = new Set(maps.map((map) => map.mapId));
  const revisit = revisitMaps(knowledge, section);
  const revisitIds = new Set(revisit.map((map) => map.mapId));
  const routeMaps = input.routeMaps ?? [];
  const passThrough = mergePassThrough(
    passThroughMaps(knowledge, maps, new Set([...ownMaps, ...revisitIds])),
    routePassThrough(knowledge, ownMaps, revisitIds, input.currentMapId ?? null, routeMaps),
  );
  const bestiary = input.save?.bestiary ?? null;
  const monsters = collectMonsters(knowledge, section, bestiary);
  const bosses = collectBosses(knowledge, section, input.files);
  const shops = collectShops(knowledge, section, routeMaps);
  const chests = chestFacts(knowledge, section);
  const party = input.party.map((member) => ({
    ...member,
    status: member.status,
    spells: member.spells,
  }));
  const learned = learnedBlueMagic(input.save, party);
  const blueMagic = collectBlueMagic(section, party, learned);
  const bag = input.bag.slice(0, MAX_BAG);
  const healing = healingFacts(party, bag, knowledge);
  const stations = draftStations(section, input.grindMinutes ?? DEFAULT_GRIND_MINUTES, bosses);
  const goal = goalOf(section, stations);
  const notes = [...section.mismatches];
  const data: SegmentFactsData = {
    game,
    section: section.title,
    areaName: section.areaName,
    goal,
    maps,
    passThrough,
    revisitMaps: revisit,
    stations,
    chests,
    monsters,
    bosses,
    shops,
    party,
    bag,
    healing,
    gil: input.gil,
    bestiaryMissing: monsters.filter((monster) => !monster.boss && monster.registered !== true),
    blueMagic,
    blueMagicMissing: blueMagic.filter((spell) => !spell.learned),
    notes,
    ...(input.currentMapId === undefined || input.currentMapId === null
      ? {}
      : { currentMapId: input.currentMapId }),
    ...(input.sectionReason === undefined || input.sectionReason === null
      ? {}
      : { sectionReason: input.sectionReason }),
  };
  const allowed = new Set<number>([
    ...ownMaps,
    ...passThrough.map((map) => map.mapId),
    ...revisit.map((map) => map.mapId),
  ]);
  DETAILS.set(data, {
    knowledge,
    allowedMaps: allowed,
    sectionMaps: ownMaps,
    learnedBlueMagic: learned,
  });
  const draftPlan = draftPlanOf(data, section, input.grindMinutes ?? DEFAULT_GRIND_MINUTES);
  return { data, text: describeSegmentFacts(data), draftPlan };
}

/**
 * Task 146: add boss trigger cells from the game files to an already-built sheet, then rebuild
 * the text. Game.ts's `planToolPorts` uses this because the synchronous sheet builder cannot
 * read files itself; tests may pass `files` to `segmentFacts` directly.
 */
export function withBossTriggers(
  result: SegmentFactsResult,
  files: RouteBookFiles | null | undefined,
): SegmentFactsResult {
  if (files === null || files === undefined) return result;
  const bosses = result.data.bosses.map((boss) => ({
    ...boss,
    triggers: bossTriggerCells(boss.knowledgeName, boss.maps, files),
  }));
  const withTargets = (stations: readonly PlanStation[]): PlanStation[] =>
    stations.map((station) =>
      station.do === "boss" ? { ...station, to: draftBossTarget(station.to, bosses) } : station,
    );
  const data: SegmentFactsData = {
    ...result.data,
    bosses,
    stations: withTargets(result.data.stations),
  };
  const draftPlan: SegmentPlan = {
    ...result.draftPlan,
    stations: withTargets(result.draftPlan.stations),
  };
  const details = DETAILS.get(result.data);
  if (details !== undefined) DETAILS.set(data, details);
  return { data, text: describeSegmentFacts(data), draftPlan };
}

function goalOf(section: RouteSection, stations: readonly PlanStation[]): string {
  const chests = section.chests.filter((chest) => chest.opened !== true).length;
  const boss =
    section.bosses.length === 0 ? "无首领" : section.bosses.map((row) => row.name).join("、");
  return `走完路线书「${section.title}」:${stations.length} 站,开 ${chests} 个宝箱,首领 ${boss}`;
}

function actionLabel(action: PlanStationAction): string {
  switch (action) {
    case "move":
      return "移动";
    case "open":
      return "开宝箱/找隐藏道具";
    case "save":
      return "存档";
    case "heal":
      return "回复";
    case "talk":
      return "对话/调查";
    case "switch":
      return "机关";
    case "story":
      return "剧情";
    case "choose":
      return "选择对话";
    case "grind":
      return "刷怪";
    case "boss":
      return "打首领";
  }
}

function stationAction(stop: StagePlan["route"][number]): PlanStationAction {
  const kind = stop.book?.kind;
  if (stop.do === "open") return "open";
  if (stop.do === "save") return "save";
  if (stop.do === "grind") return "grind";
  if (stop.do === "boss") return "boss";
  if (kind === "heal") return "heal";
  if (kind === "switch") return "switch";
  if (kind === "cutscene") return "story";
  return "talk";
}

/**
 * Task 146: the conservative draft already carries a boss's single trigger cell, so keeping
 * the draft's station is enough to pass the new boss check. Ambiguous maps stay as written.
 */
function draftBossTarget(to: string, bosses: readonly SegmentFactsBoss[]): string {
  const match = /^(?:地图\s*)?(\d+)$/u.exec(to.trim());
  if (match === null) return to;
  const mapId = Number(match[1] ?? "");
  const candidates = bosses.filter((boss) => boss.maps.includes(mapId));
  if (candidates.length !== 1) return to;
  const boss = candidates[0];
  if (boss === undefined) return to;
  const cells = boss.triggers.filter((trigger) => trigger.map === mapId);
  if (cells.length !== 1) return to;
  const cell = cells[0];
  if (cell === undefined) return to;
  return `${mapId}:${cell.cell[0]},${cell.cell[1]}`;
}

function draftStations(
  section: RouteSection,
  grindMinutes: number,
  bosses: readonly SegmentFactsBoss[] = [],
): PlanStation[] {
  const route = routeFromBookSection(section, { grindMinutes });
  const stations: PlanStation[] = [];
  for (const stop of route.slice(0, MAX_STATIONS)) {
    const action = stationAction(stop);
    const book = stop.book;
    const item = book?.item ?? null;
    const why =
      book === undefined
        ? actionLabel(action)
        : `路线书第 ${book.index + 1} 站:${actionLabel(action)}${item === null || item === "" ? "" : `(${item})`}`;
    const to = action === "boss" ? draftBossTarget(stop.to, bosses) : stop.to;
    stations.push({
      to,
      do: action,
      why,
      ...(action === "grind" && stop.until !== undefined ? { until: stop.until } : {}),
      ...(stop.optional === true ? { optional: true } : {}),
      ...(book === undefined ? {} : { book: { section: book.section, index: book.index } }),
    });
  }
  return stations;
}

function draftPlanOf(
  data: SegmentFactsData,
  section: RouteSection,
  grindMinutes: number,
): SegmentPlan {
  return {
    version: 1,
    section: section.title,
    goal: data.goal,
    prep: { jobs: [], equip: "keep", buy: [], rows: [] },
    stations: draftStations(section, grindMinutes, data.bosses),
    battle: [],
    bosses: [],
    turnBack: [
      { when: "party.lowest_hp_pct < 30", then: "heal-and-continue" },
      { when: "party.dead >= 1", then: "replan" },
    ],
    notes: "保守草稿:站点来自路线书,战斗表和首领表空着;请按事实补上。",
  };
}

// ---------------------------------------------------------------------------------------------
// Description

function describeSegmentFacts(facts: SegmentFactsData): string {
  const lines: string[] = [
    `段计划事实:${facts.section}${facts.areaName === null ? "" : `(${facts.areaName})`}`,
    ...(facts.sectionReason === undefined || facts.sectionReason === null
      ? []
      : [`取这一节:${facts.sectionReason}`]),
    `目标:${facts.goal}`,
    `### 地图与连通(${facts.maps.length} 张)`,
  ];
  if (facts.maps.length === 0) lines.push("- 这一节没对上地图;只能按攻略现场找。");
  for (const map of facts.maps) {
    const exits =
      map.exits.length === 0
        ? "出口没有记录"
        : `出口:${map.exits.map((exit) => `${exit.mapId} ${exit.name}`).join("、")}`;
    const reasons = map.reasons.length === 0 ? "" : `;依据:${map.reasons.join("、")}`;
    lines.push(
      `- ${map.mapId} ${map.name}${map.areaName === null ? "" : `(${map.areaName})`};${exits}${reasons}`,
    );
  }
  if (facts.passThrough.length > 0) {
    lines.push(
      `- 路上可经过:${facts.passThrough
        .slice(0, 12)
        .map((map) => `${map.mapId} ${map.name}`)
        .join("、")}`,
    );
  }
  if (facts.revisitMaps.length > 0) {
    lines.push(
      `- 回头学的地图:${facts.revisitMaps.map((map) => `${map.mapId} ${map.name}`).join("、")}`,
    );
  }
  lines.push(`### 站点草稿(${facts.stations.length} 站)`);
  if (facts.stations.length === 0) lines.push("- 没有可执行站点。");
  for (const [index, station] of facts.stations.entries()) {
    lines.push(
      `- ${index + 1}. ${station.to} ${actionLabel(station.do)}${station.optional === true ? "(可选)" : ""}${station.until === undefined ? "" : ` until ${untilText(station.until)}`}${station.why === undefined ? "" : ` — ${station.why}`}`,
    );
  }
  lines.push(`### 宝箱(${facts.chests.length} 个没开)`);
  if (facts.chests.length === 0) lines.push("- 没有未开的宝箱。");
  for (const chest of facts.chests) {
    const where =
      chest.mapId === null
        ? (chest.where ?? "地图不明")
        : `${chest.mapId} ${chest.mapName ?? "?"}${chest.cell === null ? "" : ` (${chest.cell[0]},${chest.cell[1]})`}`;
    lines.push(`- ${chest.item} @ ${where}${chest.note === "" ? "" : `;${chest.note}`}`);
  }
  lines.push(`### 怪物(${facts.monsters.length} 种)`);
  if (facts.monsters.length === 0) lines.push("- 没有怪物记录。");
  for (const monster of facts.monsters.slice(0, MAX_MONSTERS)) {
    lines.push(`- ${monsterLine(monster)}`);
  }
  lines.push(`### 首领(${facts.bosses.length} 个)`);
  if (facts.bosses.length === 0) lines.push("- 这一节没有首领记录。");
  for (const boss of facts.bosses.slice(0, MAX_BOSSES)) {
    lines.push(`- ${bossLine(boss)}`);
  }
  lines.push(`### 商店(${facts.shops.length} 家)`);
  if (facts.shops.length === 0) lines.push("- 附近没有商店记录。");
  for (const shop of facts.shops) {
    const goods =
      shop.products.length === 0
        ? "没有货品记录"
        : shop.products
            .map(
              (product) => `${product.name}${product.price === null ? " ?" : ` ${product.price}`}`,
            )
            .join("、");
    lines.push(`- ${shop.area} ${shop.kind}:${goods}`);
  }
  lines.push(`### 队伍(${facts.party.length} 人)`);
  if (facts.party.length === 0) lines.push("- 读不到队伍。");
  for (const member of facts.party) {
    const status = member.status.length === 0 ? "无" : member.status.join("、");
    const spells = member.spells.length === 0 ? "无" : member.spells.join("、");
    lines.push(
      `- ${member.name} ${member.job} Lv${member.level} HP ${member.hp}/${member.maxHp} MP ${member.mp}/${member.maxMp} 状态:${status} 魔法:${spells}`,
    );
  }
  if (facts.healing !== undefined) lines.push(`- ${healingLine(facts.healing)}`);
  lines.push("### 背包与金钱");
  lines.push(`- 金钱 ${facts.gil}`);
  if (facts.bag.length === 0) lines.push("- 背包空");
  else lines.push(`- ${facts.bag.map((item) => `${item.name}×${item.count}`).join("、")}`);
  lines.push("### 本档还缺");
  if (facts.bestiaryMissing.length === 0) lines.push("- 图鉴:没有缺的。");
  else {
    lines.push(
      `- 图鉴 ${facts.bestiaryMissing.length} 种:${facts.bestiaryMissing
        .slice(0, 20)
        .map((monster) => `${monster.name}${monster.missable ? "(可能错过)" : ""}`)
        .join("、")}`,
    );
  }
  if (facts.blueMagicMissing.length === 0) lines.push("- 青魔法:没有缺的。");
  else {
    lines.push(
      `- 青魔法 ${facts.blueMagicMissing.length} 种:${facts.blueMagicMissing
        .map(
          (spell) =>
            `${spell.name}(${spell.teachers.map((teacher) => teacher.monster).join("、") || "教的怪不明"};${spell.canLearn ? "队里有青魔导士" : "队里没有青魔导士"})`,
        )
        .join("、")}`,
    );
  }
  if (facts.notes.length > 0) lines.push("### 攻略说明", ...facts.notes.map((note) => `- ${note}`));
  return truncate(lines.join("\n"), SEGMENT_FACTS_LIMIT);
}

function monsterLine(monster: SegmentFactsMonster): string {
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
  if (monster.missable)
    tags.push(`可能错过${monster.missableUntil === null ? "" : `(${monster.missableUntil})`}`);
  if (monster.registered === false) tags.push("本档图鉴:缺");
  const book = monster.bookId === null ? "" : ` #${String(monster.bookId).padStart(3, "0")}`;
  const maps = monster.maps.length === 0 ? "" : ` 出没:${monster.maps.join("、")}`;
  const chance = monster.chance === null ? "" : ` 出现率:${Math.round(monster.chance * 100)}%`;
  return `${monster.name}${book}${tags.length === 0 ? "" : ` ${tags.join(" ")}`}${maps}${chance}`;
}

function bossLine(boss: SegmentFactsBoss): string {
  const names =
    boss.knowledgeName === null || boss.knowledgeName === boss.name
      ? boss.name
      : `${boss.name}(${boss.knowledgeName})`;
  const book = boss.bookId === null ? "" : ` #${String(boss.bookId).padStart(3, "0")}`;
  const hp = boss.hp === null ? "HP 不明" : `HP ${boss.hp}`;
  const weak = boss.weak.length === 0 ? "无" : boss.weak.join("、");
  const absorb = boss.absorb.length === 0 ? "无" : boss.absorb.join("、");
  const nullify = boss.nullify.length === 0 ? "无" : boss.nullify.join("、");
  const immune = boss.statusImmune.length === 0 ? "无" : boss.statusImmune.join("、");
  const maps = boss.maps.length === 0 ? "" : ` 地图:${boss.maps.join("、")}`;
  const triggers =
    boss.triggers.length === 0
      ? ""
      : ` 触发点 ${boss.triggers
          .map((trigger) => `${trigger.map}:${trigger.cell[0]},${trigger.cell[1]}`)
          .join("、")}`;
  const note = boss.guideNote === "" ? "" : ` 攻略:${oneLine(boss.guideNote).slice(0, 300)}`;
  return `${names}${book} ${hp}${maps}${triggers} 弱:${weak} 吸:${absorb} 抗:${nullify} 状态免疫:${immune}${note}`;
}

function untilText(until: NonNullable<PlanStation["until"]>): string {
  const parts: string[] = [];
  if (until.bestiary !== undefined && until.bestiary.length > 0) {
    parts.push(`图鉴:${until.bestiary.join("、")}`);
  }
  if (until.blueMagic !== undefined && until.blueMagic.length > 0) {
    parts.push(`青魔法:${until.blueMagic.join("、")}`);
  }
  if (until.battles !== undefined) parts.push(`战斗 ${until.battles} 场`);
  if (until.minutes !== undefined) parts.push(`${until.minutes} 分钟`);
  return parts.join(";");
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const suffix = "\n…(事实太长,后面省略;完整见 plan_facts 的结构化数据与路线书 JSON)";
  const room = Math.max(0, limit - Array.from(suffix).length);
  return characters.slice(0, room).join("") + suffix;
}

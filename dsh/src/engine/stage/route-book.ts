/**
 * The route book (task 115, 11-11): pure computation that puts a walkthrough section on the map
 * records before anything is executed. Input is `GuideSection[]` from task 114; this module
 * never parses the guide and never talks to the bridge, the game or a file.
 *
 * The user's plan (11-11): ① the route book (this module plus task 114) → user review; ② code
 * executes the book in one go; ③ every stage reports its numbers. This file is ① only.
 *
 * Alignment follows the user's four bases, in order: bestiary numbers through the encounter
 * table, floor headers (`2F`) against full-width map names (`２层`), same-area maps joined by
 * recorded exits, and the previous saves' first-arrival order for sections without monsters.
 * Nothing is guessed: a place with no evidence stays "没对上地图".
 */

import type { Atlas } from "../atlas.ts";
import { LAYER_Z, type Cell } from "../nav.ts";
import {
  areaKeys,
  blueMagicSources,
  bossMapIds,
  missablesAfter,
  monstersIn,
  normalizeName,
  restorePointsIn,
  savePointsIn,
  type BlueMagicSource,
  type ChestKnowledge,
  type Knowledge,
  type MapKnowledge,
  type MonsterKnowledge,
} from "../knowledge/index.ts";
import { isRecord, list, num, records, text, type Json } from "../values.ts";
import type { GuideSection, GuideStep, GuideStepKind } from "./guide-types.ts";

/** This save's progress; every field may be unknown (`null`). */
export interface RouteBookSave {
  /** Registered bestiary numbers. */
  readonly bestiary: ReadonlySet<number> | null;
  /** Learned blue spells, by name or ability id. */
  readonly blueMagic: readonly string[] | null;
  /** Current jobs; used only to see whether a Blue Mage is in the party. */
  readonly jobs: readonly string[] | null;
  /** Opened chests as `"mapId:x,y"`. */
  readonly openedChests: ReadonlySet<string> | null;
  /**
   * Story flags this save has already set. Optional: when the caller cannot read them, event
   * triggers are paired in event-number order instead.
   */
  readonly storyFlags?: ReadonlySet<string> | null;
}

/** One cutscene/mechanism trigger read from the game files (task 122). */
export interface RouteStoryEvent {
  readonly mapId: number;
  /** The Tiled event file ("ev_e_0021.json"). */
  readonly file: string;
  /** The object name, often "sc_e_0021:..." or a Japanese description. */
  readonly name: string;
  readonly cell: Cell | null;
  /** The trigger rectangle in cells, inclusive. */
  readonly rect: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  } | null;
  readonly scriptId: number | null;
}

/** One NPC read from the game files; the three-language names are optional when present. */
export interface RouteNpc {
  readonly mapId: number;
  readonly name: string;
  readonly cell: Cell;
  readonly names?: { readonly ja?: string; readonly en?: string; readonly zhc?: string } | null;
}

/** The game files' story data the book aligns against (task 122). */
export interface RouteBookFiles {
  readonly events: readonly RouteStoryEvent[];
  readonly npcs: readonly RouteNpc[];
}

export interface RouteBookInput {
  /** Task 114's product, in walkthrough order. */
  readonly sections: readonly GuideSection[];
  /** First section to include, inclusive. */
  readonly fromSection: string;
  /** Within `fromSection`, the first sub-location to keep; earlier steps are dropped. */
  readonly fromPlace?: string;
  /** Last section to include, inclusive. */
  readonly toSection: string;
  readonly knowledge: Knowledge;
  /** The map records: exits, chests and links. */
  readonly atlas: Atlas;
  /** Task 122: events and NPCs from `.deps/knowledge/<game>/files/maps/`. */
  readonly files?: RouteBookFiles | null;
  /** Previous saves' first-arrival order; names may repeat. */
  readonly visitOrder: readonly string[];
  readonly save: RouteBookSave;
}

/** One map the section touches, with every basis that put it here. */
export interface RouteMap {
  readonly mapId: number;
  readonly name: string;
  readonly areaName: string | null;
  readonly reasons: readonly string[];
}

/** One sub-location header of a section and the maps it resolved to. */
export interface RoutePlace {
  readonly title: string;
  readonly mapIds: readonly number[];
  readonly unmatched: boolean;
  /** Why the place is not split further, when it could not be. */
  readonly note: string | null;
}

export type ChestMatch = "name" | "order" | "none";

export interface RouteChestCandidate {
  readonly mapId: number;
  readonly mapName: string;
  readonly cell: Cell;
  readonly name: string | null;
  readonly opened: boolean | null;
}

/** A guide chest/hidden item and the atlas chest it was paired with, if any. */
export interface RouteChest {
  readonly stepIndex: number;
  readonly where: string | null;
  readonly kind: "chest" | "hidden";
  readonly n: number | null;
  readonly item: string;
  readonly text: string;
  readonly mapId: number | null;
  readonly mapName: string | null;
  readonly cell: Cell | null;
  readonly opened: boolean | null;
  readonly match: ChestMatch;
  readonly note: string;
  /** Atlas cells the guide item may be, when more than one candidate was left unpaired. */
  readonly candidates: readonly RouteChestCandidate[];
}

/** Task 122: what a "回头学" station grinds until, and why it is skipped when it is. */
export interface RouteStationGrind {
  /** The blue spell this stop learns; null for a bestiary stop. */
  readonly blueMagic: string | null;
  /** The bestiary number or name this stop registers; null for a blue-magic stop. */
  readonly bestiary: string | number | null;
  /** Chinese reason not to execute this stop (no Blue Mage, already known, unknown save). */
  readonly skipReason: string | null;
}

/** A guide sentence kept out of the station table (note lines and unmatched point mentions). */
export interface RouteNote {
  readonly index: number;
  readonly where: string | null;
  readonly text: string;
  readonly basis: string;
  readonly pointCandidate: "save" | "heal" | null;
}

/** One station of the execution order: a guide step plus its map, cell and basis. */
export interface RouteStation {
  readonly index: number;
  readonly where: string | null;
  readonly kind: GuideStepKind;
  readonly mapId: number | null;
  readonly cell: Cell | null;
  readonly action: string;
  readonly text: string;
  readonly basis: string;
  readonly chest: RouteChest | null;
  /** Set when the guide's save/heal line did not match a real point. */
  readonly pointCandidate: "save" | "heal" | null;
  /** For a "回头学" station: the grind target and, when non-null, why it is skipped. */
  readonly grind?: RouteStationGrind | null;
}

export interface RouteMonster {
  readonly bookId: number | null;
  readonly name: string;
  /** The guide's English name when it differs from the game's Chinese name. */
  readonly guideName: string | null;
  readonly boss: boolean;
  /** true / false from this save, null when the save has not said. */
  readonly registered: boolean | null;
  readonly missable: boolean;
  readonly missableUntil: string | null;
  readonly maps: readonly number[];
  readonly note: string;
}

export interface RouteBlueTeacher {
  readonly monster: string;
  readonly bookId: number | null;
  /** Maps in this section where the teacher appears. */
  readonly maps: readonly number[];
  /** Every map where the teacher appears, including other sections (task 119). */
  readonly allMaps: readonly number[];
}

/** When a blue spell can be learned relative to the Blue Mage unlock (task 119). */
export type BlueMagicTiming =
  | "now" // this save already has a Blue Mage
  | "after" // a teacher appears at or after the Blue Mage unlock
  | "missed" // teachers only before the unlock, but the place can be revisited
  | "unreachable" // teachers only before the unlock and there is no way back
  | "unknown"; // jobs or the unlock section are unknown

export interface RouteBlueMagic {
  readonly name: string;
  readonly teachers: readonly RouteBlueTeacher[];
  /** true / false from this save, null when unknown. */
  readonly learned: boolean | null;
  /** true / false from the party's jobs, null when the jobs are unknown. */
  readonly hasBlueMage: boolean | null;
  /** Maps in this section where a teacher appears. */
  readonly maps: readonly number[];
  /** Other places the teaching monsters still appear in. */
  readonly otherPlaces: readonly string[];
  readonly note: string;
  /** Machine-readable form of `when` (task 119). */
  readonly timing: BlueMagicTiming;
  /** "什么时候能学": now / after the unlock / missed / unreachable / unknown. */
  readonly when: string;
  /** "窗口": the walkthrough section(s) and maps where the teachers appear. */
  readonly window: string;
}

/** What a grind keeps doing until it is done (task 119). */
export interface RouteGrindUntil {
  /** Stop after learning this blue spell; null for a bestiary grind. */
  readonly blueMagic: string | null;
}

export interface RouteGrind {
  /** What to chase: the missable monster or the blue spell. */
  readonly what: string;
  readonly monster: string;
  readonly mapId: number;
  readonly weight: number | null;
  /** Weight / the map's total weight, 0-1; null when unknown. */
  readonly chance: number | null;
  readonly reason: string;
  /** Explicit stopping condition; blue-magic grinds set `blueMagic` (task 119). */
  readonly until: RouteGrindUntil;
}

/** The "回头学" block inserted at the end of the section that unlocks the Blue Mage. */
export interface RouteRevisit {
  readonly title: string;
  readonly note: string;
  readonly maps: readonly RouteMap[];
  /** Synthetic stations in the same shape as normal ones, so they render alike. */
  readonly stations: readonly RouteStation[];
  readonly grind: readonly RouteGrind[];
}

export interface RouteSection {
  readonly title: string;
  readonly order: number;
  /** Chinese area name(s), joined when a section spans two areas. */
  readonly areaName: string | null;
  readonly maps: readonly RouteMap[];
  readonly places: readonly RoutePlace[];
  readonly stations: readonly RouteStation[];
  /** Note-class guide lines, kept in JSON but rendered as one "另有 n 条攻略说明". */
  readonly notes: readonly RouteNote[];
  readonly chests: readonly RouteChest[];
  /** Every item the guide names for a chest/hidden step, in guide order. */
  readonly guideChestItems: readonly string[];
  readonly chestsMatched: number;
  readonly chestsTotal: number;
  readonly monsters: readonly RouteMonster[];
  /** Bosses are listed apart; they are still bestiary rows. */
  readonly bosses: readonly RouteMonster[];
  readonly blueMagic: readonly RouteBlueMagic[];
  readonly grind: readonly RouteGrind[];
  /** Non-null only at the section that unlocks the Blue Mage (task 119). */
  readonly revisit: RouteRevisit | null;
  readonly bestiaryMissing: number;
  readonly blueMagicMissing: number;
  readonly mismatches: readonly string[];
}

export interface RouteBook {
  readonly fromSection: string;
  /** Sub-location the first section starts at, when one was requested. */
  readonly fromPlace: string | null;
  readonly toSection: string;
  readonly sections: readonly RouteSection[];
  readonly totals: {
    readonly sections: number;
    readonly stations: number;
    readonly chestsMatched: number;
    readonly chestsTotal: number;
    readonly bestiaryMissing: number;
    /** True when at least one bestiary row has no save answer. */
    readonly bestiaryUnknown: boolean;
    readonly blueMagicMissing: number;
    /** Number of "回头学" actions across the book (task 119). */
    readonly revisit: number;
    readonly mismatches: number;
  };
}

interface Alignment {
  readonly maps: Map<number, string[]>;
}

interface BuildContext {
  readonly knowledge: Knowledge;
  readonly atlas: Atlas;
  readonly save: RouteBookSave;
  readonly allBlueMagic: readonly BlueMagicSource[];
  readonly missableByBook: ReadonlyMap<number, string>;
  readonly files: RouteBookFiles | null;
  readonly cache: BuildCache;
  readonly mention: MentionIndex;
}

/**
 * Per-build lookups (task 124, 11-11). The book asks the same map/monster questions thousands of
 * times; each of these functions is pure against the build inputs, so one map per build keeps
 * the answers without sharing state between calls.
 */
interface BuildCache {
  readonly mapById: Map<number, MapKnowledge>;
  readonly mapNames: Map<number, string>;
  readonly mapAreas: Map<number, string | null>;
  readonly connected: Map<number, readonly number[]>;
  readonly monstersByBook: Map<number, readonly MonsterKnowledge[]>;
  readonly mapsByKeys: Map<string, readonly MapKnowledge[]>;
  readonly monsterNamesByMap: Map<number, ReadonlySet<string>>;
}

/**
 * "Which sections mention this area?" (task 124). Built once from every section's title, places
 * and step text, keyed by each mentioned name and its guide aliases. `laterMention` used to
 * rescan the whole guide for every missed monster; this turns it into a table lookup.
 */
interface MentionIndex {
  /** Candidate name (normalized own value or guide alias) → section orders, ascending. */
  readonly orders: ReadonlyMap<string, readonly number[]>;
}

export interface BuildOutcome {
  readonly book: RouteBook;
  readonly timedOut: boolean;
}

interface BuildBudget {
  /** Epoch milliseconds after which the build stops and keeps what it has. */
  readonly deadline: number;
}

interface AtlasExit {
  readonly cell: Cell | null;
  readonly to: number;
  readonly name: string;
}

interface AtlasChest {
  readonly mapId: number;
  readonly cell: Cell;
  readonly name: string | null;
  readonly knowledgeNames: readonly string[];
}

interface RegionBetween {
  readonly names: readonly string[];
  readonly previous: string | null;
  readonly next: string | null;
}

/** Where the Blue Mage job enters the walkthrough, and which section every map belongs to. */
interface BlueTimeline {
  readonly sections: readonly GuideSection[];
  readonly fromIndex: number;
  readonly toIndex: number;
  /** First section of this route where a Blue Mage can exist; -1 when unknown. */
  readonly availableIndex: number;
  /** The section listing the Blue Mage job; -1 when the save already has one or none is found. */
  readonly unlockIndex: number;
  readonly hasBlueMageNow: boolean | null;
  readonly mapOrders: ReadonlyMap<number, readonly number[]>;
}

type ReturnVerdict = "yes" | "uncertain" | "no";

interface ReturnCheck {
  readonly verdict: ReturnVerdict;
  readonly basis: string;
}

const SAVE_POINT = /save\s*point|savepoint|存档点|セーブポイント/iu;
const RECOVERY_POINT =
  /recovery\s*(?:point|device)|restore\s*(?:point|device)|回复装置|回復装置|回复点|回復点|全回复|全回復|healing\s*point/iu;
/** The guide names a spring or a pot without calling it a "recovery point" (task 122). */
const GUIDE_RECOVERY = /\bspring\b|\bfountain\b|healing\s+pot|回復の壺|回复壶|回复的壶|壺/iu;
const REAL_SAVE_LINE = /save\s*point|savepoint|consecrated circle|存档点|セーブポイント/iu;

const ACTION_LABELS: Readonly<Record<GuideStepKind, string>> = {
  move: "移动",
  chest: "开宝箱",
  hidden: "找隐藏道具",
  talk: "对话",
  switch: "机关",
  save: "存档",
  heal: "回复",
  boss: "打首领",
  cutscene: "剧情",
  shop: "购物",
  piano: "钢琴",
  note: "笔记",
};

/** Build the whole book. Pure: the same input always gives the same book. */
export function buildRouteBook(input: RouteBookInput): RouteBook {
  return runBuild(buildRouteBookSteps(input));
}

/**
 * Build the book while yielding to the event loop after each section (task 124, 11-11: the
 * runtime build blocked the whole dsh process for minutes). Stops at the budget and returns the
 * sections finished so far with `timedOut: true`, so the caller can fall back or use the part.
 */
export async function buildRouteBookAsync(
  input: RouteBookInput,
  timeBudgetMs: number,
  signal?: AbortSignal,
): Promise<BuildOutcome> {
  const budget: BuildBudget = { deadline: Date.now() + Math.max(0, timeBudgetMs) };
  const steps = buildRouteBookSteps(input, budget, false);
  let step = steps.next();
  while (!step.done) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = steps.next();
  }
  return step.value;
}

function runBuild(steps: Generator<void, BuildOutcome>): RouteBook {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value.book;
}

function budgetSpent(budget: BuildBudget | undefined): boolean {
  return budget !== undefined && Date.now() >= budget.deadline;
}

function emptyBook(input: RouteBookInput): RouteBook {
  return {
    fromSection: input.fromSection,
    fromPlace: input.fromPlace ?? null,
    toSection: input.toSection,
    sections: [],
    totals: totalsOf([]),
  };
}

function* buildRouteBookSteps(
  input: RouteBookInput,
  budget?: BuildBudget,
  exactMapOrders = true,
): Generator<void, BuildOutcome> {
  const selected = selectSections(input.sections, input.fromSection, input.toSection);
  const sections =
    input.fromPlace === undefined ? selected : trimFromPlace(selected, input.fromPlace);
  yield;
  if (budgetSpent(budget)) return { book: emptyBook(input), timedOut: true };
  const ctx: BuildContext = {
    knowledge: input.knowledge,
    atlas: input.atlas,
    save: input.save,
    allBlueMagic: blueMagicSources(input.knowledge, { learned: [] }),
    missableByBook: missableRules(input.knowledge),
    files: input.files ?? null,
    cache: {
      mapById: new Map(),
      mapNames: new Map(),
      mapAreas: new Map(),
      connected: new Map(),
      monstersByBook: new Map(),
      mapsByKeys: new Map(),
      monsterNamesByMap: new Map(),
    },
    mention: buildMentionIndex(input.sections, input.knowledge),
  };
  const direct: Alignment[] = [];
  for (const section of sections) {
    direct.push(directAlignment(section, ctx));
    yield;
    if (budgetSpent(budget)) return { book: emptyBook(input), timedOut: true };
  }
  const fromIndex = input.sections.findIndex((section) => section.title === input.fromSection);
  const toIndex = input.sections.findIndex((section) => section.title === input.toSection);
  const timeline = buildBlueTimeline(input, ctx, fromIndex, toIndex, direct, exactMapOrders);
  const usedChests = new Set<string>();
  const out: RouteSection[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) continue;
    let alignment = direct[index] ?? { maps: new Map() };
    if (alignment.maps.size === 0) {
      const previousMaps = out.at(-1)?.maps.map((map) => map.mapId) ?? [];
      const nextKeys = nextAnchorKeys(sections, direct, index + 1, input.visitOrder, ctx);
      const visit = visitOrderAlignment(previousMaps, nextKeys, input.visitOrder, ctx);
      if (visit.maps.size > 0) {
        alignment = visit;
      } else {
        const byTitle = titleAlignment(section, ctx);
        if (byTitle.maps.size > 0) alignment = byTitle;
      }
    }
    out.push(buildSection(section, alignment, ctx, usedChests, timeline));
    yield;
    if (budgetSpent(budget)) {
      return {
        book: {
          fromSection: input.fromSection,
          fromPlace: input.fromPlace ?? null,
          toSection: input.toSection,
          sections: out,
          totals: totalsOf(out),
        },
        timedOut: true,
      };
    }
  }
  insertRevisit(out, timeline, ctx);
  return {
    book: {
      fromSection: input.fromSection,
      fromPlace: input.fromPlace ?? null,
      toSection: input.toSection,
      sections: out,
      totals: totalsOf(out),
    },
    timedOut: false,
  };
}

/**
 * Task 119: put a section on the timeline and find the job-list step that includes `Blue Mage`.
 * The guide writes the list as separate lines ("Jobs unlocked:", "Knight", "Blue Mage", ...),
 * so the names are collected after the marker and stop at the first non-name line.
 */
function buildBlueTimeline(
  input: RouteBookInput,
  ctx: BuildContext,
  fromIndex: number,
  toIndex: number,
  selectedDirect: readonly Alignment[],
  exactMapOrders: boolean,
): BlueTimeline {
  const from = fromIndex < 0 ? 0 : fromIndex;
  const hasBlueMageNow = hasBlueMageJob(input.save);
  const unlockIndex = input.sections.findIndex((section) => sectionUnlocksBlueMage(section));
  const availableIndex =
    hasBlueMageNow === true ? from : unlockIndex < 0 ? -1 : unlockIndex < from ? from : unlockIndex;
  const mapOrders = buildMapOrders(
    input.sections,
    ctx,
    selectedDirect,
    from,
    toIndex,
    exactMapOrders,
  );
  return {
    sections: input.sections,
    fromIndex: from,
    toIndex: toIndex < 0 ? input.sections.length - 1 : toIndex,
    availableIndex,
    unlockIndex,
    hasBlueMageNow,
    mapOrders,
  };
}

function sectionUnlocksBlueMage(section: GuideSection): boolean {
  for (let index = 0; index < section.steps.length; index += 1) {
    const step = section.steps[index];
    if (step === undefined) continue;
    if (!/jobs?\s+unlocked|set\s+of\s+jobs/iu.test(step.text)) continue;
    if (normalizeName(step.text).includes("bluemage")) return true;
    for (let next = index + 1; next < section.steps.length; next += 1) {
      const line = section.steps[next];
      if (line === undefined) continue;
      if (jobListEnds(line.text)) break;
      if (isBlueMageName(line.text)) return true;
    }
  }
  return false;
}

/** A job name is one short line without a sentence ending or an "Essence" caption. */
function jobListEnds(line: string): boolean {
  const text = line.trim();
  return text === "" || /[.!?。！？]$/u.test(text) || /essence/iu.test(text);
}

function isBlueMageName(line: string): boolean {
  return normalizeName(line) === "bluemage" || normalizeName(line) === "青魔导士";
}

/** Which sections each map belongs to; direct evidence first, then the section's area/title. */
function buildMapOrders(
  sections: readonly GuideSection[],
  ctx: BuildContext,
  selectedDirect: readonly Alignment[],
  fromIndex: number,
  toIndex: number,
  exact: boolean,
): ReadonlyMap<number, readonly number[]> {
  const orders = new Map<number, Set<number>>();
  if (exact) {
    // Offline builds keep task 115's exact whole-guide map orders. The build is pure and the
    // area-key cache makes this affordable for the 77-section review script.
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      if (section === undefined) continue;
      const direct =
        index >= fromIndex && index <= toIndex
          ? (selectedDirect[index - fromIndex] ?? directAlignment(section, ctx))
          : directAlignment(section, ctx);
      for (const mapId of direct.maps.keys()) addOrder(orders, mapId, index);
    }
  } else {
    // Task 124: a runtime build only aligns the sections it produces. Every other section
    // contributes its area/title name below, so "does this place appear later?" still sees the
    // whole guide without running the four-rule alignment 77 times for a 4-section book.
    for (let index = fromIndex; index <= toIndex; index += 1) {
      const direct = selectedDirect[index - fromIndex];
      if (direct === undefined) continue;
      for (const mapId of direct.maps.keys()) addOrder(orders, mapId, index);
    }
  }
  // A map that no monster/floor rule found still belongs to the section naming its area.
  const sectionKeys = sections.map((section) =>
    unique([
      ...sectionAreaKeys(section.title, ctx),
      ...section.places.flatMap((place) => areaKeys(ctx.knowledge.guide, place)),
    ]),
  );
  for (const map of ctx.knowledge.maps) {
    if (map.id === null || orders.has(map.id)) continue;
    for (let index = 0; index < sections.length; index += 1) {
      const keys = sectionKeys[index] ?? [];
      if (
        matchesAnyKey(map.areaName ?? "", keys, ctx) ||
        matchesAnyKey(map.name ?? "", keys, ctx)
      ) {
        addOrder(orders, map.id, index);
      }
    }
  }
  const out = new Map<number, readonly number[]>();
  for (const [mapId, indexes] of orders) {
    out.set(
      mapId,
      [...indexes].sort((left, right) => left - right),
    );
  }
  return out;
}

function addOrder(orders: Map<number, Set<number>>, mapId: number, index: number): void {
  const set = orders.get(mapId) ?? new Set<number>();
  set.add(index);
  orders.set(mapId, set);
}

/**
 * Index every section's title, places and step text by the names they mention (task 124,
 * 11-11). The old `laterMention` computed `areaKeys` for every string of every later section
 * for every missed monster/blue spell, which is where the runtime build spent its time.
 */
function buildMentionIndex(sections: readonly GuideSection[], knowledge: Knowledge): MentionIndex {
  const orders = new Map<string, number[]>();
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) continue;
    const values = [section.title, ...section.places, ...section.steps.map((step) => step.text)];
    for (const value of values) {
      for (const candidate of areaKeys(knowledge.guide, value)) {
        if (!atLeastTwo(candidate)) continue;
        const list = orders.get(candidate);
        if (list === undefined) {
          orders.set(candidate, [index]);
        } else if (list.at(-1) !== index) {
          list.push(index);
        }
      }
    }
  }
  return { orders };
}

/** The first section after `after` that mentions any of `keys`; `laterMention`'s old scan. */
function firstMentionOrder(
  keys: readonly string[],
  after: number,
  index: MentionIndex,
): number | null {
  let first: number | null = null;
  for (const [candidate, orders] of index.orders) {
    if (!keys.some((key) => candidateMatches(candidate, key))) continue;
    for (const order of orders) {
      if (order <= after) continue;
      if (first === null || order < first) first = order;
      break;
    }
  }
  return first;
}

function candidateMatches(candidate: string, key: string): boolean {
  if (candidate === key) return true;
  if (!atLeastTwo(candidate) || !atLeastTwo(key)) return false;
  return candidate.includes(key) || key.includes(candidate);
}

function atLeastTwo(value: string): boolean {
  return Array.from(value).length >= 2;
}

// ---------------------------------------------------------------------------------------------
// Section selection and the four alignment bases

function selectSections(
  sections: readonly GuideSection[],
  fromSection: string,
  toSection: string,
): GuideSection[] {
  const from = sections.findIndex((section) => section.title === fromSection);
  if (from < 0) throw new Error(`路线书:找不到开始小节「${fromSection}」`);
  const to = sections.findIndex((section) => section.title === toSection);
  if (to < 0) throw new Error(`路线书:找不到结束小节「${toSection}」`);
  if (from > to) {
    throw new Error(`路线书:开始小节「${fromSection}」排在「${toSection}」之后`);
  }
  return sections.slice(from, to + 1);
}

/** Drop everything before `fromPlace` in the first section, and keep later sections whole. */
function trimFromPlace(sections: readonly GuideSection[], fromPlace: string): GuideSection[] {
  const first = sections[0];
  if (first === undefined) return [...sections];
  const placeIndex = first.places.indexOf(fromPlace);
  const stepIndex = first.steps.findIndex((step) => step.where === fromPlace);
  if (placeIndex < 0 && stepIndex < 0) {
    throw new Error(`路线书:小节「${first.title}」里找不到小节「${fromPlace}」`);
  }
  const startStep =
    stepIndex >= 0
      ? stepIndex
      : first.steps.findIndex(
          (step) => step.where !== null && first.places.indexOf(step.where) >= placeIndex,
        );
  if (startStep < 0) {
    throw new Error(`路线书:小节「${first.title}」的「${fromPlace}」后面没有步骤`);
  }
  const startPlaceIndex = placeIndex >= 0 ? placeIndex : first.places.indexOf(fromPlace);
  const places =
    placeIndex >= 0
      ? first.places.slice(placeIndex)
      : unique(
          first.steps.slice(startStep).flatMap((step) => (step.where === null ? [] : [step.where])),
        );
  const monsters = first.monsters.filter((monster) => {
    if (monster.where === null) return true;
    const index = first.places.indexOf(monster.where);
    return index < 0 || startPlaceIndex < 0 || index >= startPlaceIndex;
  });
  return [
    { ...first, places, steps: first.steps.slice(startStep), monsters },
    ...sections.slice(1),
  ];
}

function directAlignment(section: GuideSection, ctx: BuildContext): Alignment {
  const alignment: Alignment = { maps: new Map() };
  alignMonsters(section, ctx, alignment);
  alignFloors(section, ctx, alignment);
  alignPlaces(section, ctx, alignment);
  alignConnected(section, ctx, alignment);
  return alignment;
}

/** Rule 1: bestiary number → game monster → encounter map (or every map of the area). */
function alignMonsters(section: GuideSection, ctx: BuildContext, alignment: Alignment): void {
  const booksByMap = new Map<number, Set<number>>();
  const sectionKeys = unique([
    ...sectionAreaKeys(section.title, ctx),
    ...section.places
      .filter((place) => !isGenericPlace(place))
      .flatMap((place) => areaKeys(ctx.knowledge.guide, place)),
  ]);
  const sectionMapIds = new Set(
    mapsInArea(sectionKeys, ctx).flatMap((map) => (map.id === null ? [] : [map.id])),
  );
  for (const guideMonster of section.monsters) {
    // A "BESTIARY: WIND SHRINE - 2F" table describes that floor. When the header names one,
    // only that floor's maps may be claimed; otherwise a 2F table would pull in 4F and hide
    // the fact that 4F still needs checking.
    const floor = guideMonster.where === null ? null : placeFloor(guideMonster.where);
    const keys = unique([
      ...sectionAreaKeys(section.title, ctx),
      ...(guideMonster.where === null ? [] : areaKeys(ctx.knowledge.guide, guideMonster.where)),
    ]);
    const areaMaps = mapsInArea(keys, ctx);
    const floorMaps =
      floor === null
        ? []
        : areaMaps.flatMap((map) =>
            map.id !== null && mapFloor(mapName(ctx, map.id)) === floor ? [map.id] : [],
          );
    const allowed = floorMaps.length === 0 ? null : new Set(floorMaps);
    // The guide's "Cave - 1F" has no alias to 洞窟 and its map names carry no floor, so a floor
    // header with no matching map must let the encounter rows name the cave maps. Everywhere
    // else stay inside the section's own maps: one book number can cover several game monsters
    // (book 001 is both "Goblin" and the all-questions-mark row), and their late-game encounters
    // once pulled 453/454 into the Prologue.
    const floorMissing = floor !== null && floorMaps.length === 0;
    const known = monstersByBook(guideMonster.id, ctx);
    const named = known.filter(
      (monster) => normalizeName(monster.name) === normalizeName(guideMonster.name),
    );
    for (const monster of named.length > 0 ? named : known) {
      for (const encounter of monster.encounters) {
        let maps = encounterMapIds(encounter);
        if (!floorMissing && sectionMapIds.size > 0) {
          maps = maps.filter((mapId) => sectionMapIds.has(mapId));
        }
        if (maps.length === 0) continue;
        const chosen = allowed === null ? maps : maps.filter((mapId) => allowed.has(mapId));
        for (const mapId of chosen) {
          const books = booksByMap.get(mapId) ?? new Set<number>();
          books.add(guideMonster.id);
          booksByMap.set(mapId, books);
        }
      }
    }
  }
  for (const [mapId, books] of booksByMap) {
    const numbers = [...books].sort((left, right) => left - right).map(padBook);
    addReason(alignment, mapId, `怪物 ${numbers.join("、")} 在这张图遇得到`);
  }
}

/** Rule 2: the guide's floor header against the map name's full-width floor. */
function alignFloors(section: GuideSection, ctx: BuildContext, alignment: Alignment): void {
  for (const place of section.places) {
    const floor = placeFloor(place);
    if (floor === null) continue;
    const keys = unique([
      ...sectionAreaKeys(section.title, ctx),
      ...areaKeys(ctx.knowledge.guide, place),
    ]);
    for (const map of mapsInArea(keys, ctx)) {
      if (map.id === null) continue;
      if (mapFloor(mapName(ctx, map.id)) !== floor) continue;
      const label = mapFloorLabel(mapName(ctx, map.id));
      addReason(alignment, map.id, `楼层 ${floor} ↔ ${label}`);
    }
  }
}

/** A sub-location header can name an area even when the section title does not. */
function alignPlaces(section: GuideSection, ctx: BuildContext, alignment: Alignment): void {
  for (const place of section.places) {
    if (placeFloor(place) !== null || isGenericPlace(place)) continue;
    const keys = areaKeys(ctx.knowledge.guide, place);
    for (const map of mapsInArea(keys, ctx)) {
      if (map.id === null) continue;
      addReason(alignment, map.id, `小节「${place}」对上了这个地区`);
    }
  }
}

/**
 * Rule 3: same-area maps joined by recorded exits. A map of a floor this section never names
 * is left out, so a 3F section does not silently pull in 4F and its chests.
 */
function alignConnected(section: GuideSection, ctx: BuildContext, alignment: Alignment): void {
  const floors = sectionFloors(section);
  const queue = [...alignment.maps.keys()];
  while (queue.length > 0) {
    const from = queue.shift();
    if (from === undefined) break;
    const fromArea = mapAreaName(from, ctx);
    if (fromArea === null) continue;
    for (const to of connectedMaps(from, ctx)) {
      if (alignment.maps.has(to)) continue;
      if (normalizeName(mapAreaName(to, ctx) ?? "") !== normalizeName(fromArea)) continue;
      if (!floorAllowed(to, floors, ctx)) continue;
      addReason(alignment, to, `和 ${from} 同属${fromArea}，出口相连`);
      queue.push(to);
    }
  }
}

/** Rule 4: a section with no monster/floor evidence sits between two first-arrival regions. */
function visitOrderAlignment(
  previousMaps: readonly number[],
  nextKeys: readonly string[],
  order: readonly string[],
  ctx: BuildContext,
): Alignment {
  const previousKeys = keysFromMaps(previousMaps, ctx);
  const region = regionsBetween(order, previousKeys, nextKeys);
  const alignment: Alignment = { maps: new Map() };
  if (region.names.length === 0) return alignment;
  const before = region.previous === null ? "" : `，在${region.previous}之后`;
  const after = region.next === null ? "" : `、${region.next}之前`;
  const basis = `按以前几档的到达先后${before}${after}`;
  for (const name of region.names) {
    const keys = areaKeys(ctx.knowledge.guide, name);
    for (const map of mapsInArea(keys, ctx)) {
      if (map.id === null) continue;
      addReason(alignment, map.id, basis);
    }
  }
  return alignment;
}

/** Last resort: the section title itself names the area, without any visit history. */
function titleAlignment(section: GuideSection, ctx: BuildContext): Alignment {
  const alignment: Alignment = { maps: new Map() };
  const keys = sectionAreaKeys(section.title, ctx);
  for (const map of mapsInArea(keys, ctx)) {
    if (map.id === null) continue;
    addReason(alignment, map.id, `小节标题「${section.title}」对上了这个地区`);
  }
  return alignment;
}

function nextAnchorKeys(
  sections: readonly GuideSection[],
  direct: readonly Alignment[],
  start: number,
  order: readonly string[],
  ctx: BuildContext,
): string[] {
  for (let index = start; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) continue;
    const keys =
      (direct[index]?.maps.size ?? 0) > 0
        ? keysFromMaps([...(direct[index]?.maps.keys() ?? [])], ctx)
        : sectionAreaKeys(section.title, ctx);
    if (order.some((name) => matchesAnyKey(name, keys, ctx))) return keys;
  }
  return [];
}

function regionsBetween(
  order: readonly string[],
  previousKeys: readonly string[],
  nextKeys: readonly string[],
): RegionBetween {
  let previousIndex = -1;
  let previous: string | null = null;
  if (previousKeys.length > 0) {
    order.forEach((name, index) => {
      if (matchesAnyKey(name, previousKeys, undefined)) {
        previousIndex = index;
        previous = name;
      }
    });
  }
  let nextIndex = -1;
  let next: string | null = null;
  if (nextKeys.length > 0) {
    for (let index = previousIndex + 1; index < order.length; index += 1) {
      const name = order[index];
      if (name !== undefined && matchesAnyKey(name, nextKeys, undefined)) {
        nextIndex = index;
        next = name;
        break;
      }
    }
  }
  let names: string[] = [];
  if (previousIndex >= 0 && nextIndex > previousIndex) {
    names = order.slice(previousIndex + 1, nextIndex);
  } else if (previousIndex >= 0) {
    const after = order[previousIndex + 1];
    names = after === undefined ? [] : [after];
  } else if (nextKeys.length > 0) {
    for (let index = 0; index < order.length; index += 1) {
      const name = order[index];
      if (name === undefined || !matchesAnyKey(name, nextKeys, undefined)) continue;
      next = name;
      if (index > 0) {
        const before = order[index - 1];
        names = before === undefined ? [] : [before];
      }
      break;
    }
  }
  return {
    names: unique(
      names.filter(
        (name) =>
          !matchesAnyKey(name, previousKeys, undefined) &&
          !matchesAnyKey(name, nextKeys, undefined),
      ),
    ),
    previous,
    next,
  };
}

function keysFromMaps(mapIds: readonly number[], ctx: BuildContext): string[] {
  const keys = new Set<string>();
  for (const mapId of mapIds) {
    const area = mapAreaName(mapId, ctx);
    if (area !== null) for (const key of areaKeys(ctx.knowledge.guide, area)) keys.add(key);
    const name = mapName(ctx, mapId);
    for (const key of areaKeys(ctx.knowledge.guide, name)) keys.add(key);
  }
  return [...keys];
}

function sectionAreaKeys(title: string, ctx: BuildContext): string[] {
  return areaKeys(ctx.knowledge.guide, title);
}

function mapsInArea(keys: readonly string[], ctx: BuildContext): readonly MapKnowledge[] {
  const cacheKey = keys.join("\u0000");
  const cached = ctx.cache.mapsByKeys.get(cacheKey);
  if (cached !== undefined) return cached;
  const found = ctx.knowledge.maps.filter((map) => {
    if (map.id === null) return false;
    return matchesAnyKey(map.areaName ?? "", keys, ctx) || matchesAnyKey(map.name ?? "", keys, ctx);
  });
  ctx.cache.mapsByKeys.set(cacheKey, found);
  return found;
}

function matchesAnyKey(
  value: string,
  keys: readonly string[],
  ctx: BuildContext | undefined,
): boolean {
  const own = normalizeName(value);
  if (own === "") return false;
  const candidates = new Set<string>([own]);
  if (ctx !== undefined) {
    for (const key of areaKeys(ctx.knowledge.guide, value)) candidates.add(key);
  }
  for (const candidate of candidates) {
    for (const key of keys) {
      if (key === "" || candidate === "") continue;
      if (candidate === key) return true;
      if (
        atLeastTwo(candidate) &&
        atLeastTwo(key) &&
        (candidate.includes(key) || key.includes(candidate))
      ) {
        return true;
      }
    }
  }
  return false;
}

function addReason(alignment: Alignment, mapId: number, reason: string): void {
  const reasons = alignment.maps.get(mapId) ?? [];
  if (!reasons.includes(reason)) reasons.push(reason);
  alignment.maps.set(mapId, reasons);
}

// ---------------------------------------------------------------------------------------------
// Floors

/** "Wind Shrine - 2F" → "2F"; "Cave - B3" → "B3". */
function placeFloor(place: string): string | null {
  const normalized = place.normalize("NFKC");
  const basement = /(?:^|[^A-Za-z0-9])B(\d{1,2})(?:F)?(?:$|[^A-Za-z0-9])/iu.exec(normalized);
  if (basement !== null) {
    const digits = basement[1] ?? "";
    return digits === "" ? null : `B${Number.parseInt(digits, 10)}`;
  }
  const above = /(?:^|[^A-Za-z0-9])(\d{1,2})F(?:$|[^A-Za-z0-9])/iu.exec(normalized);
  if (above === null) return null;
  const digits = above[1] ?? "";
  return digits === "" ? null : `${Number.parseInt(digits, 10)}F`;
}

/** "风之神殿 ２层" → "2F"; "卡纳克城 地下３层" → "B3". */
function mapFloor(name: string): string | null {
  const normalized = name.normalize("NFKC");
  const match = /(地下)?\s*(\d{1,2})\s*[层層階]/u.exec(normalized);
  if (match === null) return null;
  const digits = match[2] ?? "";
  if (digits === "") return null;
  return match[1] === undefined
    ? `${Number.parseInt(digits, 10)}F`
    : `B${Number.parseInt(digits, 10)}`;
}

/** The original floor text for the basis line, e.g. "２层" or "地下３层". */
function mapFloorLabel(name: string): string {
  const match = /(地下)?\s*[０-９0-9]+\s*[层層階]/u.exec(name);
  return match?.[0]?.trim() ?? name;
}

function sectionFloors(section: GuideSection): ReadonlySet<string> {
  const floors = new Set<string>();
  for (const place of section.places) {
    const floor = placeFloor(place);
    if (floor !== null) floors.add(floor);
  }
  return floors;
}

function floorAllowed(mapId: number, floors: ReadonlySet<string>, ctx: BuildContext): boolean {
  if (floors.size === 0) return true;
  const floor = mapFloor(mapName(ctx, mapId));
  return floor === null || floors.has(floor);
}

// ---------------------------------------------------------------------------------------------
// Atlas access

function connectedMaps(mapId: number, ctx: BuildContext): number[] {
  const cached = ctx.cache.connected.get(mapId);
  if (cached !== undefined) return [...cached];
  const out = new Set<number>();
  const entry = ctx.atlas.maps.get(String(mapId));
  for (const exit of exitsOf(entry ?? {})) {
    if (exit.to !== mapId) out.add(exit.to);
  }
  // "Exits connect" is undirected: map 191 leads to 192, and 192 must see 191 too.
  for (const [key, other] of ctx.atlas.maps) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    if (exitsOf(other).some((exit) => exit.to === mapId)) out.add(id);
  }
  const found = [...out];
  ctx.cache.connected.set(mapId, found);
  return found;
}

function exitsOf(entry: Json): AtlasExit[] {
  const out: AtlasExit[] = [];
  for (const raw of records(entry.exits)) {
    const to = numberOrNull(raw.to);
    if (to === null) continue;
    out.push({ cell: cellOf(raw.cell), to, name: text(raw.name) ?? "" });
  }
  return out;
}

function atlasChestsOf(mapId: number, ctx: BuildContext): AtlasChest[] {
  const entry = ctx.atlas.maps.get(String(mapId));
  const out: AtlasChest[] = [];
  const seats = new Set<string>();
  for (const raw of records(entry?.chests)) {
    const cell = cellOf(raw.cell);
    if (cell === null) continue;
    seats.add(cellKey(cell));
    out.push({
      mapId,
      cell,
      name: text(raw.name) ?? null,
      knowledgeNames: knowledgeNamesAt(mapId, cell, null, ctx),
    });
  }
  // The export sometimes knows a chest the atlas has not seen yet; keep it as a candidate but
  // never count it as a map-record chest (the user's "地图记录" is the atlas).
  for (const chest of ctx.knowledge.chests) {
    if (chest.mapId !== mapId || chest.cell === null) continue;
    const key = cellKey(chest.cell);
    if (seats.has(key)) continue;
    out.push({
      mapId,
      cell: chest.cell,
      name: chest.contentName,
      knowledgeNames: knowledgeNamesAt(mapId, chest.cell, null, ctx),
    });
  }
  return out;
}

function knowledgeNamesAt(
  mapId: number,
  cell: Cell,
  guideNumber: number | null,
  ctx: BuildContext,
): string[] {
  const names: string[] = [];
  for (const chest of ctx.knowledge.chests) {
    const sameCell =
      chest.mapId === mapId &&
      chest.cell !== null &&
      chest.cell[0] === cell[0] &&
      chest.cell[1] === cell[1];
    const sameGuide = guideNumber !== null && chest.guide !== null && chest.guide.n === guideNumber;
    if (!sameCell && !sameGuide) continue;
    if (chest.contentName !== null && chest.contentName !== "") names.push(chest.contentName);
  }
  return unique(names);
}

function knowledgeChestFor(
  mapId: number | null,
  cell: Cell | null,
  guideNumber: number | null,
  ctx: BuildContext,
): ChestKnowledge | undefined {
  return ctx.knowledge.chests.find((chest) => {
    if (guideNumber !== null && chest.guide !== null && chest.guide.n === guideNumber) return true;
    return (
      mapId !== null &&
      cell !== null &&
      chest.mapId === mapId &&
      chest.cell !== null &&
      chest.cell[0] === cell[0] &&
      chest.cell[1] === cell[1]
    );
  });
}

function mapKnowledge(mapId: number, ctx: BuildContext): MapKnowledge | undefined {
  if (ctx.cache.mapById.has(mapId)) return ctx.cache.mapById.get(mapId);
  const found = ctx.knowledge.maps.find((item) => item.id === mapId);
  if (found !== undefined) ctx.cache.mapById.set(mapId, found);
  return found;
}

function mapAreaName(mapId: number, ctx: BuildContext): string | null {
  if (ctx.cache.mapAreas.has(mapId)) return ctx.cache.mapAreas.get(mapId) ?? null;
  const area = mapKnowledge(mapId, ctx)?.areaName ?? null;
  ctx.cache.mapAreas.set(mapId, area);
  return area;
}

function mapName(ctx: BuildContext, mapId: number): string {
  const cached = ctx.cache.mapNames.get(mapId);
  if (cached !== undefined) return cached;
  const entry = ctx.atlas.maps.get(String(mapId));
  const observed = entry === undefined ? "" : (text(entry.name) ?? "");
  const known = observed !== "" ? observed : (mapKnowledge(mapId, ctx)?.name ?? "");
  const name = known !== "" ? known : `地图 ${mapId}`;
  ctx.cache.mapNames.set(mapId, name);
  return name;
}

function mapText(mapId: number, ctx: BuildContext): string {
  const parts = [mapName(ctx, mapId), mapAreaName(mapId, ctx) ?? ""];
  const entry = ctx.atlas.maps.get(String(mapId));
  if (entry !== undefined) {
    for (const exit of exitsOf(entry)) {
      parts.push(exit.name);
      parts.push(mapName(ctx, exit.to));
    }
  }
  return normalizeName(parts.join(" "));
}

function isSavePointName(name: string): boolean {
  return SAVE_POINT.test(name);
}

function isRecoveryName(name: string): boolean {
  return RECOVERY_POINT.test(name);
}

// ---------------------------------------------------------------------------------------------
// One section

function buildSection(
  section: GuideSection,
  alignment: Alignment,
  ctx: BuildContext,
  usedChests: Set<string>,
  timeline: BlueTimeline,
): RouteSection {
  const mapIds = [...alignment.maps.keys()].sort((left, right) => left - right);
  const maps: RouteMap[] = mapIds.map((mapId) => ({
    mapId,
    name: mapName(ctx, mapId),
    areaName: mapAreaName(mapId, ctx),
    reasons: alignment.maps.get(mapId) ?? [],
  }));
  const areaName = unique(
    maps.flatMap((map) => (map.areaName === null ? [] : [map.areaName])),
  ).join("、");
  const places = buildPlaces(section, maps, ctx);
  const chests: RouteChest[] = [];
  const notes: RouteNote[] = [];
  const guideChestItems: string[] = [];
  const chestByStep = new Map<number, RouteChest>();

  // Pair every chest first, so a later amount/name match can remove its cell from an earlier
  // unpaired group before the station text is written.
  for (const step of section.steps) {
    if (!isChestStep(step)) continue;
    const chest = matchChest(step, section, maps, ctx, usedChests, places);
    chests.push(chest);
    guideChestItems.push(chest.item);
    chestByStep.set(step.index, chest);
  }
  // A later amount/name match may take a cell that earlier appeared as a candidate; keep the
  // JSON candidates equal to the cells still unpaired at the end of the section.
  for (let index = 0; index < chests.length; index += 1) {
    const chest = chests[index];
    if (chest === undefined) continue;
    if (chest.match !== "none") continue;
    const remaining = chest.candidates.filter(
      (candidate) => !usedChests.has(chestKey(candidate.mapId, candidate.cell)),
    );
    if (remaining.length === chest.candidates.length) continue;
    const next = { ...chest, candidates: remaining };
    chests[index] = next;
    chestByStep.set(next.stepIndex, next);
  }

  const unpairedChestMaps = new Set<number>();
  const usedPoints = new Set<string>();
  const stationByStep = new Map<number, RouteStation>();
  const stations: RouteStation[] = [];
  const story: StoryMatchState = { usedEvents: new Set<string>() };

  for (const step of section.steps) {
    const chest = chestByStep.get(step.index) ?? null;
    if (chest !== null && chest.match === "none" && chest.candidates.length > 0) {
      const remaining = chest.candidates.filter(
        (candidate) => !usedChests.has(chestKey(candidate.mapId, candidate.cell)),
      );
      for (const mapId of unique(remaining.map((candidate) => candidate.mapId))) {
        if (unpairedChestMaps.has(mapId)) continue;
        unpairedChestMaps.add(mapId);
        const cells = remaining
          .filter((candidate) => candidate.mapId === mapId)
          .map(
            (candidate) =>
              `(${candidate.cell[0]},${candidate.cell[1]}) ${candidate.name ?? "东西不明"}`,
          );
        stations.push({
          index: step.index,
          where: step.where,
          kind: "chest",
          mapId,
          cell: null,
          action: "开这张图的宝箱",
          text: `地图记录:${cells.join("、")}`,
          basis: "名字对不上,按地图记录列出这张图的格子",
          chest,
          pointCandidate: null,
        });
      }
      continue;
    }
    if (step.kind === "note") {
      notes.push({
        index: step.index,
        where: step.where,
        text: step.text,
        basis: "攻略说明",
        pointCandidate: null,
      });
      continue;
    }
    const station = buildStation(step, chest, section, maps, ctx, usedPoints, places, story);
    if (station.kind === "note") {
      notes.push({
        index: step.index,
        where: step.where,
        text: step.text,
        basis: station.basis,
        pointCandidate: station.pointCandidate,
      });
      continue;
    }
    stations.push(station);
    stationByStep.set(step.index, station);
  }

  const allMonsters = buildMonsters(section, maps, stationByStep, ctx);
  const blueMagic = buildBlueMagic(section, maps, allMonsters, ctx, timeline);
  const grind = buildGrind(allMonsters, blueMagic, ctx);
  const pruned = pruneGrind(grind, new Set(maps.map((map) => map.mapId)), ctx);
  const atlasChestCount = countAtlasChests(maps, ctx);
  const mismatches = [
    ...buildMismatches(
      section,
      maps,
      places,
      chests,
      atlasChestCount,
      stations,
      notes,
      allMonsters,
      ctx,
    ),
    ...pruned.mismatches,
  ];
  const bestiaryMissing = allMonsters.filter((monster) => monster.registered === false).length;
  const blueMagicMissing = blueMagic.filter((spell) => spell.learned === false).length;

  return {
    title: section.title,
    order: section.order,
    areaName: areaName === "" ? null : areaName,
    maps,
    places,
    stations,
    notes,
    chests,
    guideChestItems,
    chestsMatched: chests.filter((chest) => chest.mapId !== null && chest.cell !== null).length,
    chestsTotal: chests.length,
    monsters: allMonsters.filter((monster) => !monster.boss),
    bosses: allMonsters.filter((monster) => monster.boss),
    blueMagic,
    grind: pruned.grind,
    revisit: null,
    bestiaryMissing,
    blueMagicMissing,
    mismatches,
  };
}

interface MapGroup {
  readonly key: string;
  readonly mapIds: number[];
}

function groupsByName(mapIds: readonly number[], maps: readonly RouteMap[]): MapGroup[] {
  return groupMaps(mapIds, maps, (map) => map.name);
}

function groupsByArea(mapIds: readonly number[], maps: readonly RouteMap[]): MapGroup[] {
  return groupMaps(mapIds, maps, (map) => map.areaName ?? map.name);
}

function groupMaps(
  mapIds: readonly number[],
  maps: readonly RouteMap[],
  keyOf: (map: RouteMap) => string,
): MapGroup[] {
  const byKey = new Map<string, number[]>();
  for (const mapId of [...mapIds].sort((left, right) => left - right)) {
    const map = maps.find((item) => item.mapId === mapId);
    if (map === undefined) continue;
    const key = normalizeName(keyOf(map));
    byKey.set(key, [...(byKey.get(key) ?? []), mapId]);
  }
  return [...byKey.entries()].map(([key, ids]) => ({ key, mapIds: ids }));
}

function firstUsableGroup(
  groups: readonly MapGroup[],
  used: ReadonlySet<number>,
): MapGroup | undefined {
  return groups.find((group) => group.mapIds.some((mapId) => !used.has(mapId)));
}

function buildPlaces(
  section: GuideSection,
  maps: readonly RouteMap[],
  ctx: BuildContext,
): RoutePlace[] {
  const titles =
    section.places.length > 0
      ? section.places
      : unique(section.steps.flatMap((step) => (step.where === null ? [] : [step.where])));
  const used = new Set<number>();
  const out: RoutePlace[] = [];
  for (let index = 0; index < titles.length; index += 1) {
    const title = titles[index];
    if (title === undefined) continue;
    if (isGenericPlace(title)) {
      out.push({
        title,
        mapIds: [],
        unmatched: false,
        note: "世界地图不按单张图算,现场看",
      });
      continue;
    }
    const floor = placeFloor(title);
    const specific = placeSpecificMaps(title, section, maps, ctx).filter(
      (mapId) => !used.has(mapId),
    );
    let chosen: number[] = [];
    if (specific.length > 0) {
      const groups = floor === null ? groupsByName(specific, maps) : groupsByArea(specific, maps);
      const group = firstUsableGroup(groups, used);
      chosen = (group?.mapIds ?? specific).filter((mapId) => !used.has(mapId));
      if (floor === null) chosen = withAreaSiblings(chosen, title, maps, ctx, used);
    }
    if (chosen.length === 0) chosen = connectedFromPrevious(out, maps, used, ctx);
    if (chosen.length === 0) {
      chosen = floorlessInNextPlaceArea(titles, index + 1, section, maps, ctx, used);
    }
    let note: string | null = null;
    if (chosen.length === 0 && floor === null) {
      chosen = maps.map((map) => map.mapId).filter((mapId) => !used.has(mapId));
      if (chosen.length > 0) note = "分不清是哪张图,整块归这一段";
    }
    if (chosen.length === 0) {
      out.push({ title, mapIds: [], unmatched: true, note: null });
      continue;
    }
    for (const mapId of chosen) used.add(mapId);
    out.push({ title, mapIds: chosen, unmatched: false, note });
  }
  return out;
}

/** Keep a room's unknown-name siblings (197) and its "area + room" maps (199-201). */
function withAreaSiblings(
  chosen: readonly number[],
  place: string,
  maps: readonly RouteMap[],
  ctx: BuildContext,
  used: ReadonlySet<number>,
): number[] {
  const keys = areaKeys(ctx.knowledge.guide, place);
  const first = chosen[0];
  if (first === undefined) return [...chosen];
  const own = maps.find((map) => map.mapId === first);
  if (own === undefined || !matchesAnyKey(own.areaName ?? own.name, keys, ctx)) return [...chosen];
  const areaName = own.areaName;
  if (areaName === null) return [...chosen];
  const extra = maps
    .filter((map) => map.areaName === areaName && !used.has(map.mapId))
    .filter((map) => {
      const name = normalizeName(map.name);
      return name === "" || name.startsWith("map") || name.startsWith(normalizeName(areaName));
    })
    .map((map) => map.mapId);
  return unique([...chosen, ...extra]);
}

function connectedFromPrevious(
  places: readonly RoutePlace[],
  maps: readonly RouteMap[],
  used: ReadonlySet<number>,
  ctx: BuildContext,
): number[] {
  const previous = [...places].reverse().find((place) => place.mapIds.length > 0);
  if (previous === undefined) return [];
  const candidates = new Set<number>();
  for (const mapId of previous.mapIds) {
    for (const to of connectedMaps(mapId, ctx)) {
      if (!used.has(to) && maps.some((map) => map.mapId === to)) candidates.add(to);
    }
  }
  const group = firstUsableGroup(groupsByName([...candidates], maps), used);
  if (group === undefined) return [];
  // The exit leads to one room of the name group; take the whole group (a club's two floors).
  const name = maps.find((map) => map.mapId === group.mapIds[0])?.name;
  return maps.filter((map) => map.name === name && !used.has(map.mapId)).map((map) => map.mapId);
}

function floorlessInNextPlaceArea(
  titles: readonly string[],
  start: number,
  section: GuideSection,
  maps: readonly RouteMap[],
  ctx: BuildContext,
  used: ReadonlySet<number>,
): number[] {
  for (let index = start; index < titles.length; index += 1) {
    const title = titles[index];
    if (title === undefined || isGenericPlace(title)) continue;
    const next = placeSpecificMaps(title, section, maps, ctx).filter((mapId) => !used.has(mapId));
    const first = next[0];
    if (first === undefined) continue;
    const areaName = maps.find((map) => map.mapId === first)?.areaName;
    if (areaName === null || areaName === undefined) continue;
    return maps
      .filter(
        (map) => map.areaName === areaName && mapFloor(map.name) === null && !used.has(map.mapId),
      )
      .map((map) => map.mapId);
  }
  return [];
}

function mapNameMatchesPlace(map: RouteMap, keys: readonly string[], ctx: BuildContext): boolean {
  const own = normalizeName(map.name);
  if (keys.some((key) => own === key || own.includes(key) || key.includes(own))) return true;
  // Aliases translate the area name; use them only for the area's main map (name == area).
  return (
    map.areaName !== null &&
    own === normalizeName(map.areaName) &&
    matchesAnyKey(map.areaName, keys, ctx)
  );
}

function placeSpecificMaps(
  place: string,
  section: GuideSection,
  maps: readonly RouteMap[],
  ctx: BuildContext,
): number[] {
  const floor = placeFloor(place);
  if (floor !== null) {
    return maps.filter((map) => mapFloor(map.name) === floor).map((map) => map.mapId);
  }
  const keys = areaKeys(ctx.knowledge.guide, place);
  const byArea = maps.filter((map) => matchesAnyKey(map.areaName ?? map.name, keys, ctx));
  if (byArea.length > 0) {
    // A place title that names one map should not claim its whole area (Tule vs the club).
    const byName = byArea.filter((map) => mapNameMatchesPlace(map, keys, ctx));
    return (byName.length > 0 ? byName : byArea).map((map) => map.mapId);
  }
  const tokens = placeTokens(place, section.title);
  if (tokens.length === 0) return [];
  const matched = maps.filter((map) => {
    const haystack = mapText(map.mapId, ctx);
    return tokens.some((token) => haystack.includes(token));
  });
  return matched.map((map) => map.mapId);
}

function isGenericPlace(place: string): boolean {
  return normalizeName(place) === "overworld";
}

function placeTokens(place: string, sectionTitle: string): string[] {
  const rest = normalizeName(place).replace(normalizeName(sectionTitle), " ");
  const source = rest.trim() === "" ? normalizeName(place) : rest;
  return unique(
    source
      .split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/u)
      .filter((token) => token.length >= 2)
      .filter(
        (token) => !["the", "and", "area", "overworld", "cave", "room", "floor"].includes(token),
      ),
  );
}

function stationPlaceMaps(
  step: GuideStep,
  section: GuideSection,
  maps: readonly RouteMap[],
  ctx: BuildContext,
  places: readonly RoutePlace[],
): readonly number[] {
  if (step.where !== null) {
    const place = places.find((item) => item.title === step.where);
    if (place !== undefined) return place.mapIds;
  }
  if (step.where !== null && isGenericPlace(step.where)) return [];
  if (step.where === null) {
    const only = maps[0];
    return maps.length === 1 && only !== undefined ? [only.mapId] : [];
  }
  const floor = placeFloor(step.where);
  if (floor !== null) {
    return maps.filter((map) => mapFloor(map.name) === floor).map((map) => map.mapId);
  }
  const specific = placeSpecificMaps(step.where, section, maps, ctx);
  if (specific.length > 0) return specific;
  return maps.map((map) => map.mapId);
}

function primaryMap(mapIds: readonly number[], ctx: BuildContext): number | null {
  let best: number | null = null;
  let bestScore = -1;
  for (const mapId of mapIds) {
    const entry = ctx.atlas.maps.get(String(mapId));
    const score = entry === undefined ? 0 : exitsOf(entry).length;
    if (score > bestScore || (score === bestScore && (best === null || mapId < best))) {
      best = mapId;
      bestScore = score;
    }
  }
  return best;
}

function isChestStep(step: GuideStep): boolean {
  return step.kind === "chest" || step.kind === "hidden" || step.ref !== null;
}

// ---------------------------------------------------------------------------------------------
// Chests

function matchChest(
  step: GuideStep,
  section: GuideSection,
  maps: readonly RouteMap[],
  ctx: BuildContext,
  used: Set<string>,
  places: readonly RoutePlace[],
): RouteChest {
  const placeMaps = stationPlaceMaps(step, section, maps, ctx, places);
  const candidates = atlasChestsFor(placeMaps, ctx).filter(
    (chest) => !used.has(chestKey(chest.mapId, chest.cell)),
  );
  const item = step.item ?? itemFromText(step.text) ?? "东西不明";
  const byName =
    item === "东西不明" ? undefined : candidates.find((chest) => nameMatches(item, chest, ctx));
  const totalPerMap = new Map<number, number>();
  for (const chest of atlasChestsFor(placeMaps, ctx)) {
    totalPerMap.set(chest.mapId, (totalPerMap.get(chest.mapId) ?? 0) + 1);
  }
  // Several chests on one map and no name match: never guess which cell the guide meant, even
  // after an earlier item took one of them. One chest per map is safe: the guide walks the
  // maps in order (205 then 206 on Wind Shrine 3F).
  const ambiguous = [...totalPerMap.values()].some((count) => count > 1);
  const ordered = byName === undefined && !ambiguous ? candidates[0] : undefined;
  const picked = byName ?? ordered;
  const match: ChestMatch =
    byName !== undefined ? "name" : ordered !== undefined ? "order" : "none";
  if (picked !== undefined) used.add(chestKey(picked.mapId, picked.cell));
  const opened = picked === undefined ? null : openedAt(ctx.save, picked.mapId, picked.cell);
  const note =
    match === "name"
      ? "按名字对上"
      : match === "order"
        ? candidates.length === 1
          ? "地图记录只有这一个宝箱"
          : "每张图只有一个宝箱,按地图顺序对上"
        : candidates.length > 1
          ? "名字对不上,不配对;地图记录见站点"
          : placeMaps.length === 0
            ? "地图没对上,这个宝箱现场找"
            : "地图记录里没有宝箱,现场找";
  return {
    stepIndex: step.index,
    where: step.where,
    kind: step.ref?.kind ?? (step.kind === "hidden" ? "hidden" : "chest"),
    n: step.ref?.n ?? null,
    item,
    text: step.text,
    mapId: picked?.mapId ?? null,
    mapName: picked === undefined ? null : mapName(ctx, picked.mapId),
    cell: picked?.cell ?? null,
    opened,
    match,
    note,
    candidates:
      match === "none"
        ? candidates.map((chest) => ({
            mapId: chest.mapId,
            mapName: mapName(ctx, chest.mapId),
            cell: chest.cell,
            name: chest.name,
            opened: openedAt(ctx.save, chest.mapId, chest.cell),
          }))
        : [],
  };
}

function atlasChestsFor(mapIds: readonly number[], ctx: BuildContext): AtlasChest[] {
  const out: AtlasChest[] = [];
  for (const mapId of [...mapIds].sort((left, right) => left - right)) {
    out.push(...atlasChestsOf(mapId, ctx));
  }
  return out;
}

function countAtlasChests(maps: readonly RouteMap[], ctx: BuildContext): number {
  let count = 0;
  for (const map of maps) {
    const entry = ctx.atlas.maps.get(String(map.mapId));
    count += records(entry?.chests).filter((raw) => cellOf(raw.cell) !== null).length;
  }
  return count;
}

function nameMatches(item: string, chest: AtlasChest, ctx: BuildContext): boolean {
  const wanted = normalizeName(item);
  if (wanted === "") return false;
  const content = knowledgeChestFor(chest.mapId, chest.cell, null, ctx)?.contentName ?? null;
  const names = [
    ...(chest.name === null ? [] : [chest.name]),
    ...chest.knowledgeNames,
    ...(content === null || content === "" ? [] : [content]),
  ];
  const amount = amountOf(item);
  if (amount !== null) {
    return names.some((name) => amountOf(name) === amount);
  }
  return names.some((name) => {
    const own = normalizeName(name);
    return own !== "" && (own === wanted || own.includes(wanted) || wanted.includes(own));
  });
}

/** "150 Gil" and "150ギル" are the same amount; other languages have no common name yet. */
function amountOf(value: string): number | null {
  const match = /(\d[\d,]*)\s*(?:gil|ギル)/iu.exec(value);
  if (match === null) return null;
  const amount = Number.parseInt((match[1] ?? "").replace(/,/gu, ""), 10);
  return Number.isFinite(amount) ? amount : null;
}

function itemFromText(value: string): string | null {
  const match =
    /(?:for|containing|find|receive|get|open(?:ed)?)\s+(?:an?\s+|the\s+)?([A-Z][A-Za-z' -]{1,40})/u.exec(
      value,
    );
  if (match === null) return null;
  const item = (match[1] ?? "").replace(/[\s.,;:!?]+$/u, "").trim();
  return item === "" ? null : item;
}

function openedAt(save: RouteBookSave, mapId: number, cell: Cell): boolean | null {
  if (save.openedChests === null) return null;
  return save.openedChests.has(`${mapId}:${cell[0]},${cell[1]}`);
}

function chestKey(mapId: number, cell: Cell): string {
  return `${mapId}:${cell[0]},${cell[1]}`;
}

// ---------------------------------------------------------------------------------------------
// Stations

function buildStation(
  step: GuideStep,
  chest: RouteChest | null,
  section: GuideSection,
  maps: readonly RouteMap[],
  ctx: BuildContext,
  usedPoints: Set<string>,
  places: readonly RoutePlace[],
  story: StoryMatchState,
): RouteStation {
  const placeMaps = storyPlaceMaps(step, section, maps, ctx, places);
  const action = `${ACTION_LABELS[step.kind]}${chest === null ? "" : `(${chest.item})`}`;
  if (chest !== null) {
    return {
      index: step.index,
      where: step.where,
      kind: step.kind,
      mapId: chest.mapId,
      cell: chest.cell,
      action,
      text: step.text,
      basis: stationBasis(chest.note, chest.mapId, chest.cell),
      chest,
      pointCandidate: null,
    };
  }
  if (step.kind === "save" || step.kind === "heal") {
    const point = findPoint(step, placeMaps, ctx, usedPoints);
    if (!point.real) {
      return {
        index: step.index,
        where: step.where,
        kind: "note",
        mapId: point.mapId,
        cell: null,
        action: "攻略说明",
        text: step.text,
        basis: point.basis,
        chest: null,
        pointCandidate: step.kind,
      };
    }
    return {
      index: step.index,
      where: step.where,
      kind: step.kind,
      mapId: point.mapId,
      cell: point.cell,
      action,
      text: step.text,
      basis: point.basis,
      chest: null,
      pointCandidate: null,
    };
  }
  if (step.kind === "cutscene" || step.kind === "talk" || step.kind === "switch") {
    const located =
      step.kind === "talk"
        ? matchNpc(step, placeMaps, ctx)
        : matchStoryEvent(placeMaps, ctx, story);
    if (located !== null) {
      return {
        index: step.index,
        where: step.where,
        kind: step.kind,
        mapId: located.mapId,
        cell: located.cell,
        action,
        text: step.text,
        basis: located.basis,
        chest: null,
        pointCandidate: null,
      };
    }
  }
  if (step.kind === "boss") {
    const boss = findBossMap(step, placeMaps, section, ctx);
    return {
      index: step.index,
      where: step.where,
      kind: step.kind,
      mapId: boss.mapId,
      cell: null,
      action,
      text: step.text,
      basis: boss.basis,
      chest: null,
      pointCandidate: null,
    };
  }
  const mapId = primaryMap(placeMaps, ctx);
  const map = maps.find((item) => item.mapId === mapId);
  const basis =
    mapId === null
      ? "没对上地图,执行时现场找"
      : stationBasis(map?.reasons[0] ?? "这一段的地图", mapId, null);
  return {
    index: step.index,
    where: step.where,
    kind: step.kind,
    mapId,
    cell: null,
    action,
    text: step.text,
    basis,
    chest: null,
    pointCandidate: null,
  };
}

function stationBasis(base: string, mapId: number | null, cell: Cell | null): string {
  if (mapId === null) return base;
  if (cell !== null) return base;
  return `${base};坐标没有,执行时现场找`;
}

interface StoryMatchState {
  readonly usedEvents: Set<string>;
}

/**
 * Task 122: a story/dialog/mechanism station's maps. Usually the sub-location's maps; a
 * single-map section is unambiguous even when the guide's header does not match a place.
 */
function storyPlaceMaps(
  step: GuideStep,
  section: GuideSection,
  maps: readonly RouteMap[],
  ctx: BuildContext,
  places: readonly RoutePlace[],
): readonly number[] {
  const placeMaps = stationPlaceMaps(step, section, maps, ctx, places);
  if (placeMaps.length > 0) return placeMaps;
  const only = maps[0];
  return maps.length === 1 && only !== undefined ? [only.mapId] : [];
}

/**
 * Task 122: pair a dialog station with an NPC. The guide's English sentence must contain the
 * NPC's name (or one of its three-language names); a role it cannot find stays unpaired
 * instead of taking the first NPC on the map.
 */
function matchNpc(
  step: GuideStep,
  mapIds: readonly number[],
  ctx: BuildContext,
): { mapId: number; cell: Cell; basis: string } | null {
  if (ctx.files === null || mapIds.length === 0) return null;
  const wanted = normalizeName(step.text);
  if (wanted === "") return null;
  let best: { mapId: number; cell: Cell; name: string; length: number } | null = null;
  for (const mapId of mapIds) {
    const npcs = ctx.files.npcs
      .filter((npc) => npc.mapId === mapId)
      .sort(
        (left, right) =>
          left.cell[1] - right.cell[1] ||
          left.cell[0] - right.cell[0] ||
          left.name.localeCompare(right.name),
      );
    for (const npc of npcs) {
      const names = [npc.name, npc.names?.ja, npc.names?.en, npc.names?.zhc].filter(
        (name): name is string => name !== undefined && name !== "",
      );
      for (const name of names) {
        const key = normalizeName(name);
        // One-character names would match almost any sentence; two is already weak but the
        // NPC data has many "兵士（青）"-style names, whose distinctive part is longer.
        if (Array.from(key).length < 2 || !wanted.includes(key)) continue;
        const candidate = { mapId, cell: npc.cell, name: npc.name, length: key.length };
        if (best === null || candidate.length > best.length) best = candidate;
      }
    }
  }
  return best === null
    ? null
    : { mapId: best.mapId, cell: best.cell, basis: `游戏文件：NPC ${best.name}` };
}

/**
 * Task 122: pair a cutscene/mechanism station with the next event trigger on its map, in event
 * number order (`sc_e_0021` → 21). When this save's story flags name a trigger, it is skipped;
 * without flags the order alone decides.
 */
function matchStoryEvent(
  mapIds: readonly number[],
  ctx: BuildContext,
  state: StoryMatchState,
): { mapId: number; cell: Cell; basis: string } | null {
  if (ctx.files === null || mapIds.length === 0) return null;
  const groups = new Map<
    string,
    {
      mapId: number;
      file: string;
      name: string;
      scriptId: number | null;
      events: RouteStoryEvent[];
    }
  >();
  for (const event of ctx.files.events) {
    if (!mapIds.includes(event.mapId)) continue;
    if (event.cell === null && event.rect === null) continue;
    const key = `${event.mapId}|${event.file}|${event.name}|${event.scriptId ?? ""}`;
    if (state.usedEvents.has(key) || storyEventDone(event, ctx.save)) continue;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        mapId: event.mapId,
        file: event.file,
        name: event.name,
        scriptId: event.scriptId,
        events: [event],
      });
    } else {
      group.events.push(event);
    }
  }
  const ordered = [...groups.values()].sort(
    (left, right) =>
      storyEventNumber(left) - storyEventNumber(right) ||
      left.mapId - right.mapId ||
      left.file.localeCompare(right.file) ||
      left.name.localeCompare(right.name),
  );
  const chosen = ordered[0];
  if (chosen === undefined) return null;
  const key = `${chosen.mapId}|${chosen.file}|${chosen.name}|${chosen.scriptId ?? ""}`;
  state.usedEvents.add(key);
  const cell = eventTriggerCell(chosen, ctx);
  if (cell === null) return null;
  const code = storyEventCode(chosen);
  return {
    mapId: chosen.mapId,
    cell,
    basis: `游戏文件：事件 ${code}(${storyEventLabel(chosen.name)})`,
  };
}

function storyEventNumber(event: {
  readonly file: string;
  readonly name: string;
  readonly scriptId: number | null;
}): number {
  const match = /(?:sc_e_|ev_e_)(\d+)/iu.exec(`${event.name} ${event.file}`);
  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}

function storyEventCode(event: { readonly file: string; readonly name: string }): string {
  const named = /(?:sc_e_|ev_e_)\d+/iu.exec(event.name);
  if (named !== null) return named[0];
  return event.file.replace(/\.json$/iu, "");
}

function storyEventLabel(name: string): string {
  const label = name.replace(/^(?:sc_e_|ev_e_)\d+\s*[:：]?\s*/iu, "").trim();
  return label === "" ? name : label;
}

/** A story flag may name the event file, its object name, or its script id. */
function storyEventDone(event: RouteStoryEvent, save: RouteBookSave): boolean {
  const flags = save.storyFlags;
  if (flags === undefined || flags === null) return false;
  const file = event.file.replace(/\.json$/iu, "");
  const keys = [
    file,
    event.file,
    event.name,
    ...(event.scriptId === null ? [] : [`script:${event.scriptId}`, String(event.scriptId)]),
  ];
  return keys.some((key) => flags.has(key));
}

/**
 * Task 122: the cell to stand on for an event rectangle. Prefer a walkable cell inside the
 * rectangle (the collision record comes from task 123's export when the map was never walked);
 * without collision data the first cell is the best the book can say.
 */
function eventTriggerCell(
  event: { readonly mapId: number; readonly events: readonly RouteStoryEvent[] },
  ctx: BuildContext,
): Cell | null {
  const cells: Cell[] = [];
  for (const item of event.events) {
    if (item.rect !== null) {
      for (let y = item.rect.y1; y <= item.rect.y2; y += 1) {
        for (let x = item.rect.x1; x <= item.rect.x2; x += 1) cells.push([x, y]);
      }
    } else if (item.cell !== null) {
      cells.push(item.cell);
    }
  }
  if (cells.length === 0) return null;
  const sorted = uniqueCells(cells).sort((left, right) => left[1] - right[1] || left[0] - right[0]);
  const walkable = sorted.find((cell) => isWalkable(event.mapId, cell, ctx));
  return walkable ?? sorted[0] ?? null;
}

function isWalkable(mapId: number, cell: Cell, ctx: BuildContext): boolean {
  const snapshot = ctx.knowledge.collisions?.get(mapId);
  if (snapshot === undefined) return true;
  const rowsByHeight = new Map<number, readonly string[]>();
  snapshot.layers.forEach((layer, index) => {
    rowsByHeight.set(LAYER_Z.get(layer.name) ?? index, layer.rows);
  });
  const z = snapshot.searchLayer ?? rowsByHeight.keys().next().value ?? 0;
  const rows = rowsByHeight.get(z) ?? snapshot.layers[0]?.rows;
  if (rows === undefined) return true;
  const row = rows[cell[1]];
  if (row === undefined || cell[0] < 0 || cell[0] >= row.length) return false;
  return (row[cell[0]] ?? "1") === "0";
}

function findPoint(
  step: GuideStep,
  mapIds: readonly number[],
  ctx: BuildContext,
  used: Set<string>,
): { mapId: number | null; cell: Cell | null; basis: string; real: boolean } {
  const recovery = step.kind === "heal";
  const label = recovery ? "回复点" : "存档点";
  const looksReal = recovery
    ? RECOVERY_POINT.test(step.text) || GUIDE_RECOVERY.test(step.text)
    : REAL_SAVE_LINE.test(step.text);
  if (!looksReal) {
    return {
      mapId: primaryMap(mapIds, ctx),
      cell: null,
      basis: `攻略提到${recovery ? "回复" : "存档"},但没对上真实的点`,
      real: false,
    };
  }
  const known = recovery
    ? restorePointsIn(ctx.knowledge, { mapIds })
    : savePointsIn(ctx.knowledge, { mapIds });
  for (const mapId of mapIds) {
    const point = known.find(
      (item) =>
        item.mapId === mapId && !used.has(pointKey(recovery, mapId, [item.cell[0], item.cell[1]])),
    );
    if (point !== undefined) {
      const cell: Cell = [point.cell[0], point.cell[1]];
      used.add(pointKey(recovery, mapId, cell));
      return {
        mapId,
        cell,
        basis: `游戏文件：${label} ${point.name}`,
        real: true,
      };
    }
  }
  let fallback: number | null = null;
  let fallbackKey: string | null = null;
  for (const mapId of mapIds) {
    const entry = ctx.atlas.maps.get(String(mapId));
    const cell = pointCells(entry, recovery).find(
      (candidate) => !used.has(pointKey(recovery, mapId, candidate)),
    );
    if (cell !== undefined) {
      used.add(pointKey(recovery, mapId, cell));
      return {
        mapId,
        cell,
        basis: `地图记录里 ${mapId} 有${label}`,
        real: true,
      };
    }
    const incoming = pointKey(recovery, mapId, null);
    if (fallback === null && !used.has(incoming) && incomingPointName(mapId, recovery, ctx)) {
      fallback = mapId;
      fallbackKey = incoming;
    }
  }
  if (fallback !== null) {
    if (fallbackKey !== null) used.add(fallbackKey);
    return {
      mapId: fallback,
      cell: null,
      basis: `地图记录里 ${fallback} 的出口写着${label}(没有坐标)`,
      real: true,
    };
  }
  return {
    mapId: primaryMap(mapIds, ctx),
    cell: null,
    basis: `攻略提到${recovery ? "回复" : "存档"},但没对上真实的点`,
    real: false,
  };
}

function pointKey(recovery: boolean, mapId: number, cell: Cell | null): string {
  const suffix = cell === null ? "incoming" : `${cell[0]},${cell[1]}`;
  return `${recovery ? "heal" : "save"}:${mapId}:${suffix}`;
}

function pointCells(entry: Json | undefined, recovery: boolean): Cell[] {
  if (entry === undefined) return [];
  const out: Cell[] = [];
  const fields = recovery ? ["recoveryPoints", "recovery_points"] : ["savePoints", "save_points"];
  for (const field of fields) {
    for (const raw of list(entry[field])) {
      const cell = isRecord(raw) ? cellOf(raw.cell ?? raw.tile) : cellOf(raw);
      if (cell !== null) out.push(cell);
    }
  }
  for (const field of ["entities", "points", "chests"]) {
    for (const raw of records(entry[field])) {
      const name = text(raw.name) ?? text(raw.kind) ?? "";
      if (name === "" || !(recovery ? isRecoveryName(name) : isSavePointName(name))) continue;
      const cell = cellOf(raw.cell ?? raw.tile);
      if (cell !== null) out.push(cell);
    }
  }
  return uniqueCells(out);
}

function incomingPointName(mapId: number, recovery: boolean, ctx: BuildContext): boolean {
  for (const [key, entry] of ctx.atlas.maps) {
    const from = Number(key);
    if (!Number.isFinite(from) || from === mapId) continue;
    for (const exit of exitsOf(entry)) {
      if (exit.to !== mapId) continue;
      if (recovery ? isRecoveryName(exit.name) : isSavePointName(exit.name)) return true;
    }
  }
  return false;
}

function findBossMap(
  step: GuideStep,
  placeMaps: readonly number[],
  section: GuideSection,
  ctx: BuildContext,
): { mapId: number | null; basis: string } {
  const name = step.boss?.name ?? "";
  const guideRow = section.monsters.find(
    (monster) => normalizeName(monster.name) === normalizeName(name),
  );
  const query =
    guideRow === undefined ? (name === "" ? {} : { name }) : { name, bookId: guideRow.id };
  const known = bossMapIds(ctx.knowledge, query);
  const knownHere = known.filter((mapId) => placeMaps.includes(mapId));
  if (knownHere.length > 0) {
    const mapId = knownHere[0] ?? null;
    return { mapId, basis: `知识模块记录首领在 ${mapId}` };
  }
  if (placeMaps.length === 1) {
    const mapId = placeMaps[0] ?? null;
    return { mapId, basis: `这一段只有 ${mapId} 一张图,首领在这里` };
  }
  const leaving = placeMaps.filter((mapId) =>
    connectedMaps(mapId, ctx).some((to) => !placeMaps.includes(to)),
  );
  if (leaving.length === 1) {
    const mapId = leaving[0] ?? null;
    return { mapId, basis: `首领在 ${mapId} 这张通往别处的图,现场找` };
  }
  const mapId = primaryMap(placeMaps, ctx);
  if (mapId === null) return { mapId: null, basis: "首领没对上地图,现场找" };
  return { mapId, basis: `按这一段的图 ${mapId},首领现场找` };
}

// ---------------------------------------------------------------------------------------------
// Bestiary

function buildMonsters(
  section: GuideSection,
  maps: readonly RouteMap[],
  stationByStep: ReadonlyMap<number, RouteStation>,
  ctx: BuildContext,
): RouteMonster[] {
  const sectionMapIds = new Set(maps.map((map) => map.mapId));
  const encountered =
    sectionMapIds.size === 0 ? [] : monstersIn(ctx.knowledge, { mapIds: [...sectionMapIds] });
  const byBook = new Map<number, RouteMonster>();
  const out: RouteMonster[] = [];
  const seenGuide = new Set<number>();

  for (const guideMonster of section.monsters) {
    const known = monstersByBook(guideMonster.id, ctx);
    const first = known[0];
    const mapsHere = first === undefined ? [] : mapsForMonster(first, sectionMapIds);
    const missable = missableInfo(guideMonster.id, first, sectionMapIds, ctx);
    const row = monsterRow(
      guideMonster.id,
      first?.name ?? guideMonster.name,
      guideMonster.name,
      first?.boss === true,
      mapsHere,
      missable,
      ctx,
    );
    out.push(row);
    seenGuide.add(guideMonster.id);
    byBook.set(guideMonster.id, row);
  }

  for (const monster of encountered) {
    const full = ctx.knowledge.monsters.find((candidate) => candidate.id === monster.id) ?? monster;
    const row = monster.bookId === null ? undefined : byBook.get(monster.bookId);
    if (row !== undefined) {
      const mapsHere = mapsForMonster(monster, sectionMapIds);
      const merged = { ...row, maps: unique([...row.maps, ...mapsHere]) };
      replaceRow(out, row, merged);
      if (monster.bookId !== null) byBook.set(monster.bookId, merged);
      continue;
    }
    const missable = missableInfo(monster.bookId, full, sectionMapIds, ctx);
    const created = monsterRow(
      monster.bookId,
      monster.name,
      null,
      monster.boss === true,
      mapsForMonster(monster, sectionMapIds),
      missable,
      ctx,
    );
    out.push(created);
    if (monster.bookId !== null) byBook.set(monster.bookId, created);
  }

  for (const step of section.steps) {
    if (step.kind !== "boss" || step.boss === null) continue;
    const bookId =
      section.monsters.find(
        (monster) => normalizeName(monster.name) === normalizeName(step.boss?.name ?? ""),
      )?.id ?? null;
    const mapId = stationByStep.get(step.index)?.mapId ?? null;
    if (bookId !== null && seenGuide.has(bookId)) {
      const existing = out.find((monster) => monster.bookId === bookId);
      if (existing !== undefined) {
        replaceRow(out, existing, {
          ...existing,
          boss: true,
          maps: mapId === null ? existing.maps : unique([...existing.maps, mapId]),
        });
      }
      continue;
    }
    const known = bookId === null ? undefined : monstersByBook(bookId, ctx)[0];
    const created = monsterRow(
      bookId,
      known?.name ?? step.boss.name,
      known === undefined ? step.boss.name : null,
      true,
      mapId === null ? [] : [mapId],
      {
        missable: false,
        until: null,
        note: "",
      },
      ctx,
    );
    out.push(created);
    if (bookId !== null) byBook.set(bookId, created);
  }

  return out;
}

function replaceRow(rows: RouteMonster[], oldRow: RouteMonster, next: RouteMonster): void {
  const index = rows.indexOf(oldRow);
  if (index >= 0) rows[index] = next;
}

function monsterRow(
  bookId: number | null,
  name: string,
  guideName: string | null,
  boss: boolean,
  maps: readonly number[],
  missable: { missable: boolean; until: string | null; note: string },
  ctx: BuildContext,
): RouteMonster {
  const registered =
    ctx.save.bestiary === null || bookId === null ? null : ctx.save.bestiary.has(bookId);
  return {
    bookId,
    name,
    guideName:
      guideName === null || normalizeName(guideName) === normalizeName(name) ? null : guideName,
    boss,
    registered,
    missable: missable.missable,
    missableUntil: missable.until,
    maps,
    note: missable.note,
  };
}

function monstersByBook(bookId: number, ctx: BuildContext): readonly MonsterKnowledge[] {
  const cached = ctx.cache.monstersByBook.get(bookId);
  if (cached !== undefined) return cached;
  const found = ctx.knowledge.monsters.filter((monster) => monster.bookId === bookId);
  ctx.cache.monstersByBook.set(bookId, found);
  return found;
}

function mapsForMonster(monster: MonsterKnowledge, sectionMapIds: ReadonlySet<number>): number[] {
  const out = new Set<number>();
  for (const encounter of monster.encounters) {
    for (const mapId of encounterMapIds(encounter)) {
      if (sectionMapIds.has(mapId)) out.add(mapId);
    }
  }
  return [...out].sort((left, right) => left - right);
}

function missableInfo(
  bookId: number | null,
  monster: MonsterKnowledge | undefined,
  sectionMapIds: ReadonlySet<number>,
  ctx: BuildContext,
): { missable: boolean; until: string | null; note: string } {
  const rule = bookId === null ? undefined : ctx.missableByBook.get(bookId);
  const onlyHere = monster !== undefined && onlyInSection(monster, sectionMapIds);
  if (rule !== undefined) {
    return { missable: true, until: rule, note: `错过就没了(${rule})` };
  }
  if (onlyHere) {
    return { missable: true, until: "只在这一段出现", note: "只在这一段出现,错过就没了" };
  }
  return { missable: false, until: null, note: "" };
}

function onlyInSection(monster: MonsterKnowledge, sectionMapIds: ReadonlySet<number>): boolean {
  if (monster.encounters.length === 0) return false;
  let sawMap = false;
  for (const encounter of monster.encounters) {
    const maps = encounterMapIds(encounter);
    if (maps.length === 0) return false;
    for (const mapId of maps) {
      sawMap = true;
      if (!sectionMapIds.has(mapId)) return false;
    }
  }
  return sawMap;
}

// ---------------------------------------------------------------------------------------------
// Blue magic

function buildBlueMagic(
  section: GuideSection,
  maps: readonly RouteMap[],
  monsters: readonly RouteMonster[],
  ctx: BuildContext,
  timeline: BlueTimeline,
): RouteBlueMagic[] {
  const sectionMapIds = new Set(maps.map((map) => map.mapId));
  const sectionBooks = new Set<number>();
  const sectionNames = new Set<string>();
  for (const monster of monsters) {
    if (monster.bookId !== null) sectionBooks.add(monster.bookId);
    sectionNames.add(normalizeName(monster.name));
    if (monster.guideName !== null) sectionNames.add(normalizeName(monster.guideName));
  }
  for (const guideMonster of section.monsters) {
    sectionBooks.add(guideMonster.id);
    sectionNames.add(normalizeName(guideMonster.name));
  }
  const areaKeysHere = sectionAreaKeys(section.title, ctx);

  const entries = new Map<string, { name: string; source: BlueMagicSource | null }>();
  for (const source of ctx.allBlueMagic) {
    const inSection = source.from.some(
      (item) =>
        (item.bookId !== null && sectionBooks.has(item.bookId)) ||
        sectionNames.has(normalizeName(item.monster)) ||
        item.areas.some((area) => matchesAnyKey(area, areaKeysHere, ctx)) ||
        mapsForSourceMonster(item.bookId, item.monster, sectionMapIds, ctx).length > 0,
    );
    if (inSection) entries.set(normalizeName(source.name), { name: source.name, source });
  }
  for (const guideMonster of section.monsters) {
    if (guideMonster.blueMagic === null) continue;
    const key = normalizeName(guideMonster.blueMagic);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.source ??= null;
      continue;
    }
    entries.set(key, { name: guideMonster.blueMagic, source: null });
  }

  const out: RouteBlueMagic[] = [];
  for (const entry of entries.values()) {
    const source = entry.source;
    const teachers = blueTeachers(entry.name, source, section, sectionMapIds, ctx);
    const spellMaps = unique(teachers.flatMap((teacher) => teacher.maps)).sort(
      (left, right) => left - right,
    );
    const otherPlaces = blueOtherPlaces(source, sectionMapIds, areaKeysHere, ctx);
    const learned = learnedBlue(entry.name, source?.abilityId ?? null, ctx.save);
    const hasBlueMage = hasBlueMageJob(ctx.save);
    const note = blueNote(learned, hasBlueMage, otherPlaces);
    const timing = blueWindow(teachers, timeline, ctx);
    out.push({
      name: entry.name,
      teachers,
      learned,
      hasBlueMage,
      maps: spellMaps,
      otherPlaces,
      note,
      timing: timing.timing,
      when: timing.when,
      window: timing.window,
    });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

function blueTeachers(
  name: string,
  source: BlueMagicSource | null,
  section: GuideSection,
  sectionMapIds: ReadonlySet<number>,
  ctx: BuildContext,
): RouteBlueTeacher[] {
  const out: RouteBlueTeacher[] = [];
  const seen = new Set<string>();
  for (const item of source?.from ?? []) {
    const maps = mapsForSourceMonster(item.bookId, item.monster, sectionMapIds, ctx);
    const allMaps = allMapsForSourceMonster(item.bookId, item.monster, ctx);
    const key =
      item.bookId === null ? `name:${normalizeName(item.monster)}` : `book:${item.bookId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ monster: item.monster, bookId: item.bookId, maps, allMaps });
  }
  for (const guideMonster of section.monsters) {
    if (normalizeName(guideMonster.blueMagic ?? "") !== normalizeName(name)) continue;
    const known = monstersByBook(guideMonster.id, ctx)[0];
    const maps = known === undefined ? [] : mapsForMonster(known, sectionMapIds);
    const allMaps = known === undefined ? [] : allMapsForMonster(known);
    const key = `book:${guideMonster.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ monster: guideMonster.name, bookId: guideMonster.id, maps, allMaps });
  }
  return out;
}

function mapsForSourceMonster(
  bookId: number | null,
  name: string,
  sectionMapIds: ReadonlySet<number>,
  ctx: BuildContext,
): number[] {
  const out = new Set<number>();
  for (const monster of sourceMonsters(bookId, name, ctx)) {
    for (const mapId of mapsForMonster(monster, sectionMapIds)) out.add(mapId);
  }
  return [...out].sort((left, right) => left - right);
}

function allMapsForSourceMonster(bookId: number | null, name: string, ctx: BuildContext): number[] {
  const out = new Set<number>();
  for (const monster of sourceMonsters(bookId, name, ctx)) {
    for (const mapId of allMapsForMonster(monster)) out.add(mapId);
  }
  return [...out].sort((left, right) => left - right);
}

function allMapsForMonster(monster: MonsterKnowledge): number[] {
  const out = new Set<number>();
  for (const encounter of monster.encounters) {
    for (const mapId of encounterMapIds(encounter)) out.add(mapId);
  }
  return [...out].sort((left, right) => left - right);
}

/** Prefer the same bestiary number and name; fall back to the number when names differ. */
function sourceMonsters(
  bookId: number | null,
  name: string,
  ctx: BuildContext,
): readonly MonsterKnowledge[] {
  const byBook: readonly MonsterKnowledge[] =
    bookId === null ? ctx.knowledge.monsters : monstersByBook(bookId, ctx);
  if (name === "") return byBook;
  const exact = byBook.filter((monster) => normalizeName(monster.name) === normalizeName(name));
  return exact.length > 0 ? exact : byBook;
}

function blueOtherPlaces(
  source: BlueMagicSource | null,
  sectionMapIds: ReadonlySet<number>,
  areaKeysHere: readonly string[],
  ctx: BuildContext,
): string[] {
  const labels: string[] = [];
  for (const item of source?.from ?? []) {
    for (const monster of sourceMonsters(item.bookId, item.monster, ctx)) {
      for (const encounter of monster.encounters) {
        for (const mapId of encounterMapIds(encounter)) {
          if (sectionMapIds.has(mapId)) continue;
          const area = mapAreaName(mapId, ctx);
          labels.push(
            area !== null && matchesAnyKey(area, areaKeysHere, ctx)
              ? `${area} ${mapId}`
              : (area ?? mapName(ctx, mapId)),
          );
        }
      }
    }
    for (const area of item.areas) {
      // Master map names ("Map_30041_2") are internal ids, not places the player knows.
      if (/^Map_/iu.test(area)) continue;
      if (matchesAnyKey(area, areaKeysHere, ctx)) continue;
      labels.push(area);
    }
  }
  const uniqueLabels = unique(labels);
  return uniqueLabels.length <= 6 ? uniqueLabels : [...uniqueLabels.slice(0, 6), "等其他地方"];
}

function learnedBlue(name: string, abilityId: number | null, save: RouteBookSave): boolean | null {
  if (save.blueMagic === null) return null;
  const wanted = normalizeName(name);
  return save.blueMagic.some((value) => {
    if (typeof value === "number") return abilityId !== null && value === abilityId;
    return normalizeName(value) === wanted;
  });
}

function hasBlueMageJob(save: RouteBookSave): boolean | null {
  if (save.jobs === null) return null;
  return save.jobs.some((job) => {
    const own = normalizeName(job);
    return own.includes("blue") || own.includes("青魔");
  });
}

function blueNote(
  learned: boolean | null,
  hasBlueMage: boolean | null,
  otherPlaces: readonly string[],
): string {
  if (learned === null) return "不知道本档学没学";
  if (learned) return "已经学会";
  if (hasBlueMage === null) return "不知道队伍里有没有青魔导士";
  if (hasBlueMage) return "队里有青魔导士,可以学";
  const elsewhere =
    otherPlaces.length === 0 ? "这只怪只在这里" : `这只怪还出现在 ${otherPlaces.join("、")}`;
  return `现在没人能学;${elsewhere}`;
}

interface BlueWindow {
  readonly timing: BlueMagicTiming;
  readonly when: string;
  readonly window: string;
}

/** Task 119: compare every teacher map's walkthrough section with the Blue Mage unlock. */
function blueWindow(
  teachers: readonly RouteBlueTeacher[],
  timeline: BlueTimeline,
  ctx: BuildContext,
): BlueWindow {
  const mapIds = routeMapsOf(unique(teachers.flatMap((teacher) => teacher.allMaps)), timeline);
  const orders = ordersOf(mapIds, timeline);
  const window = windowText(orders, mapIds, timeline);
  if (mapIds.length === 0 || orders.length === 0) {
    return { timing: "unknown", when: "窗口不明(遇敌表里没找到)", window };
  }
  if (timeline.hasBlueMageNow === true) {
    return { timing: "now", when: "现在就有", window };
  }
  if (timeline.availableIndex < 0) {
    return { timing: "unknown", when: "青魔导士什么时候有不确定", window };
  }
  if (orders.some((order) => order >= timeline.availableIndex)) {
    return { timing: "after", when: "青魔导士之后", window };
  }
  const check = returnCheck(mapIds, timeline, ctx);
  if (check.verdict === "yes") {
    return {
      timing: "missed",
      when: `青魔导士来之前就过去了;拿到职业后回${areaLabel(mapIds, ctx)}刷`,
      window,
    };
  }
  if (check.verdict === "uncertain") {
    return {
      timing: "missed",
      when: "青魔导士来之前就过去了;能不能回去不确定",
      window,
    };
  }
  return {
    timing: "unreachable",
    when: "这一档学不到(青魔导士来之前就过去了,回不去)",
    window,
  };
}

/** Keep only maps this book actually visits; a teacher may also live in later worlds. */
function routeMapsOf(mapIds: readonly number[], timeline: BlueTimeline): number[] {
  return unique(mapIds)
    .filter((mapId) =>
      (timeline.mapOrders.get(mapId) ?? []).some(
        (order) => order >= timeline.fromIndex && order <= timeline.toIndex,
      ),
    )
    .sort((left, right) => left - right);
}

function ordersOf(mapIds: readonly number[], timeline: BlueTimeline): number[] {
  // Only sections inside this book count as a learning window; a guide section after `toSection`
  // matters only as evidence that the place can be revisited later (task 119).
  return unique(mapIds.flatMap((mapId) => timeline.mapOrders.get(mapId) ?? []))
    .filter((order) => order >= timeline.fromIndex && order <= timeline.toIndex)
    .sort((left, right) => left - right);
}

/** "第1节 Prologue(192–194)、第5节 ..."; contiguous runs of three or more become a range. */
function windowText(
  orders: readonly number[],
  mapIds: readonly number[],
  timeline: BlueTimeline,
): string {
  if (orders.length === 0) return "遇敌表里没找到";
  return orders
    .map((order) => {
      const maps = mapIds
        .filter((mapId) => (timeline.mapOrders.get(mapId) ?? []).includes(order))
        .sort((left, right) => left - right);
      const title = timeline.sections[order]?.title ?? `第${order + 1}节`;
      return `第${order + 1}节 ${title}(${mapRanges(maps)})`;
    })
    .join("、");
}

function mapRanges(mapIds: readonly number[]): string {
  const ids = unique(mapIds).sort((left, right) => left - right);
  const parts: string[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const start = ids[index];
    if (start === undefined) continue;
    let end = index;
    while (end + 1 < ids.length && ids[end + 1] === (ids[end] ?? 0) + 1) end += 1;
    const last = ids[end] ?? start;
    if (end - index + 1 >= 3) {
      parts.push(`${start}–${last}`);
      index = end;
    } else {
      for (let each = index; each <= end; each += 1) {
        const id = ids[each];
        if (id !== undefined) parts.push(String(id));
      }
      index = end;
    }
  }
  return parts.join("、");
}

function areaLabel(mapIds: readonly number[], ctx: BuildContext): string {
  const labels = unique(
    mapIds.flatMap((mapId) => {
      const area = mapAreaName(mapId, ctx);
      return [area ?? mapName(ctx, mapId)];
    }),
  );
  return labels.join("、") || "原地";
}

/** Task 119: can the player go back to a place after leaving it? */
function returnCheck(
  mapIds: readonly number[],
  timeline: BlueTimeline,
  ctx: BuildContext,
): ReturnCheck {
  const cluster = new Set(mapIds);
  if (mapIds.some((mapId) => connectsToWorldMap(mapId, ctx))) {
    return {
      verdict: "yes",
      basis: `地图记录里 ${mapRanges(mapIds)} 通世界地图,以后能回去`,
    };
  }
  const laterLink = mapIds.find((mapId) =>
    connectedMaps(mapId, ctx).some((to) => {
      if (cluster.has(to)) return false;
      return (timeline.mapOrders.get(to) ?? []).some((order) => order > timeline.availableIndex);
    }),
  );
  if (laterLink !== undefined) {
    return {
      verdict: "yes",
      basis: `地图记录里 ${laterLink} 的出口通到后面还会去的图`,
    };
  }
  const mention = laterMention(mapIds, timeline, ctx);
  if (mention !== null) {
    return { verdict: "yes", basis: `攻略后面又提到「${mention}」` };
  }
  const outside = mapIds
    .flatMap((mapId) => connectedMaps(mapId, ctx))
    .some((to) => !cluster.has(to));
  if (outside) {
    return {
      verdict: "uncertain",
      basis: "地图记录里有出口,但攻略后面没再提这个地方",
    };
  }
  return {
    verdict: "no",
    basis: "地图记录里没有出口,攻略后面也没再提",
  };
}

function connectsToWorldMap(mapId: number, ctx: BuildContext): boolean {
  if (isWorldMap(mapId, ctx)) return true;
  return connectedMaps(mapId, ctx).some((to) => to === 1 || isWorldMap(to, ctx));
}

function isWorldMap(mapId: number, ctx: BuildContext): boolean {
  const name = normalizeName(`${mapName(ctx, mapId)} ${mapAreaName(mapId, ctx) ?? ""}`);
  return /worldmap|overworld|ワールドマップ|世界地図|世界地图/u.test(name);
}

function laterMention(
  mapIds: readonly number[],
  timeline: BlueTimeline,
  ctx: BuildContext,
): string | null {
  const keys = unique(
    mapIds.flatMap((mapId) => [
      ...areaKeys(ctx.knowledge.guide, mapName(ctx, mapId)),
      ...areaKeys(ctx.knowledge.guide, mapAreaName(mapId, ctx) ?? ""),
    ]),
  ).filter(atLeastTwo);
  if (keys.length === 0) return null;
  const order = firstMentionOrder(keys, timeline.availableIndex, ctx.mention);
  return order === null ? null : (timeline.sections[order]?.title ?? null);
}

/**
 * Task 119: blue spells missed before the unlock go at the end of the unlock section; missable
 * bestiary rows go at the next section after their last appearance, whatever the jobs are.
 */
function insertRevisit(sections: RouteSection[], timeline: BlueTimeline, ctx: BuildContext): void {
  const targets = new Set<number>();
  if (
    timeline.hasBlueMageNow !== true &&
    timeline.unlockIndex >= timeline.fromIndex &&
    timeline.unlockIndex <= timeline.toIndex
  ) {
    targets.add(timeline.unlockIndex);
  }
  for (const monster of missedBestiary(sections, timeline, ctx)) {
    const last = ordersOf(monster.mapIds, timeline).at(-1);
    if (last === undefined || last >= timeline.toIndex) continue;
    targets.add(last + 1);
  }
  for (const targetIndex of [...targets].sort((left, right) => left - right)) {
    const includeBlue = timeline.hasBlueMageNow !== true && targetIndex === timeline.unlockIndex;
    const revisit = buildRevisit(sections, timeline, ctx, targetIndex, includeBlue);
    if (revisit === null) continue;
    const at = targetIndex - timeline.fromIndex;
    const section = sections[at];
    if (section !== undefined) sections[at] = { ...section, revisit };
  }
}

interface MissedBestiary {
  readonly monster: RouteMonster;
  readonly mapIds: readonly number[];
  readonly check: ReturnCheck;
}

function missedBestiary(
  sections: readonly RouteSection[],
  timeline: BlueTimeline,
  ctx: BuildContext,
): MissedBestiary[] {
  const out: MissedBestiary[] = [];
  const seen = new Set<number>();
  for (const section of sections) {
    for (const monster of [...section.monsters, ...section.bosses]) {
      if (!monster.missable || monster.registered !== false) continue;
      if (monster.bookId === null || seen.has(monster.bookId)) continue;
      const mapIds = routeMapsOf(
        allMapsForSourceMonster(monster.bookId, monster.name, ctx),
        timeline,
      );
      if (mapIds.length === 0) continue;
      const check = returnCheck(mapIds, timeline, ctx);
      if (check.verdict !== "yes") continue;
      seen.add(monster.bookId);
      out.push({ monster, mapIds, check });
    }
  }
  return out;
}

function buildRevisit(
  sections: readonly RouteSection[],
  timeline: BlueTimeline,
  ctx: BuildContext,
  targetIndex: number,
  includeBlue: boolean,
): RouteRevisit | null {
  const stations: RouteStation[] = [];
  const grind: RouteGrind[] = [];
  const usedMaps = new Set<number>();
  if (includeBlue) {
    const seenSpells = new Set<string>();
    for (const section of sections) {
      for (const spell of section.blueMagic) {
        if (spell.learned === true) continue;
        const key = normalizeName(spell.name);
        if (seenSpells.has(key)) continue;
        const mapIds = routeMapsOf(
          unique(spell.teachers.flatMap((teacher) => teacher.allMaps)),
          timeline,
        );
        const orders = ordersOf(mapIds, timeline);
        if (orders.length === 0 || orders.some((order) => order >= timeline.availableIndex)) {
          continue;
        }
        const check = returnCheck(mapIds, timeline, ctx);
        if (check.verdict !== "yes") continue;
        const teacher = spell.teachers.find(
          (item) => bestSpot(mapIds, item.bookId, item.monster, ctx) !== null,
        );
        if (teacher === undefined) continue;
        const best = bestSpot(mapIds, teacher.bookId, teacher.monster, ctx);
        if (best === null) continue;
        seenSpells.add(key);
        for (const mapId of mapIds) usedMaps.add(mapId);
        grind.push({
          what: spell.name,
          monster: teacher.monster,
          mapId: best.mapId,
          weight: best.weight,
          chance: best.chance,
          reason: `青魔法;${check.basis}`,
          until: { blueMagic: spell.name },
        });
        stations.push(
          revisitStation(
            stations.length,
            best.mapId,
            {
              action: `回头学 ${spell.name}`,
              text: `到 ${areaLabel(mapIds, ctx)}(${mapRanges(mapIds)}) 刷 ${teacher.monster},直到学会 ${spell.name}`,
              basis: check.basis,
            },
            {
              blueMagic: spell.name,
              bestiary: null,
              skipReason: blueSkipReason(spell),
            },
          ),
        );
      }
    }
  }
  for (const missed of missedBestiary(sections, timeline, ctx)) {
    const orders = ordersOf(missed.mapIds, timeline);
    if (orders.at(-1) !== targetIndex - 1) continue;
    const best = bestSpot(missed.mapIds, missed.monster.bookId, missed.monster.name, ctx);
    if (best === null) continue;
    for (const mapId of missed.mapIds) usedMaps.add(mapId);
    grind.push({
      what: missed.monster.name,
      monster: missed.monster.name,
      mapId: best.mapId,
      weight: best.weight,
      chance: best.chance,
      reason: `图鉴;${missed.check.basis}`,
      until: { blueMagic: null },
    });
    stations.push(
      revisitStation(
        stations.length,
        best.mapId,
        {
          action: `回头补图鉴 ${missed.monster.name}`,
          text: `到 ${areaLabel(missed.mapIds, ctx)}(${mapRanges(missed.mapIds)}) 刷 ${missed.monster.name},直到登记`,
          basis: missed.check.basis,
        },
        {
          blueMagic: null,
          bestiary: missed.monster.bookId ?? missed.monster.name,
          skipReason: null,
        },
      ),
    );
  }
  if (stations.length === 0) return null;
  const mapIds = [...usedMaps].sort((left, right) => left - right);
  const unlockTitle = timeline.sections[timeline.availableIndex]?.title ?? "后面";
  const title = includeBlue ? "回头学青魔法" : "回头补图鉴";
  return {
    title,
    note: includeBlue
      ? `青魔导士要到「${unlockTitle}」才有;这些怪只在之前的段出现,拿到职业后回头补。`
      : "这些“错过就没了”的怪在前面没刷到,能回去时补上。",
    maps: mapIds.map((mapId) => ({
      mapId,
      name: mapName(ctx, mapId),
      areaName: mapAreaName(mapId, ctx),
      reasons: [includeBlue ? "青魔导士来之前去过,拿到职业后能回去" : "前面没刷到,能回去补"],
    })),
    stations,
    grind: dedupeGrind(grind),
  };
}

function revisitStation(
  index: number,
  mapId: number,
  text: { readonly action: string; readonly text: string; readonly basis: string },
  grind: RouteStationGrind,
): RouteStation {
  return {
    index: -(index + 1),
    where: "回头学",
    kind: "note",
    mapId,
    cell: null,
    action: text.action,
    text: text.text,
    basis: text.basis,
    chest: null,
    pointCandidate: null,
    grind,
  };
}

/**
 * Task 122: a "回头学" stop only runs when this save really has not learned the spell and the
 * party really has a Blue Mage. An unreadable job or save state is skipped with its reason
 * instead of guessing; the book still shows the stop.
 */
function blueSkipReason(spell: RouteBlueMagic): string | null {
  if (spell.learned) return "本档已经学会";
  if (spell.learned === null) return "不知道本档学没学";
  if (spell.hasBlueMage === null) return "不知道队里有没有青魔导士";
  if (!spell.hasBlueMage) return "队里没有青魔导士";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Grinding suggestions

function buildGrind(
  monsters: readonly RouteMonster[],
  blueMagic: readonly RouteBlueMagic[],
  ctx: BuildContext,
): RouteGrind[] {
  const out: RouteGrind[] = [];
  for (const monster of monsters) {
    if (!monster.missable) continue;
    const best = bestSpot(monster.maps, monster.bookId, monster.name, ctx);
    if (best === null) continue;
    out.push({
      what: monster.name,
      monster: monster.name,
      mapId: best.mapId,
      weight: best.weight,
      chance: best.chance,
      reason: monster.missableUntil ?? "错过就没了",
      until: { blueMagic: null },
    });
  }
  for (const spell of blueMagic) {
    if (spell.learned !== false) continue;
    let added = 0;
    for (const teacher of spell.teachers) {
      if (added >= 2) break;
      const best = bestSpot(teacher.maps, teacher.bookId, teacher.monster, ctx);
      if (best === null) continue;
      out.push({
        what: spell.name,
        monster: teacher.monster,
        mapId: best.mapId,
        weight: best.weight,
        chance: best.chance,
        reason: `青魔法;${spell.note}`,
        until: { blueMagic: spell.name },
      });
      added += 1;
    }
  }
  return dedupeGrind(out);
}

interface PrunedGrind {
  readonly grind: RouteGrind[];
  readonly mismatches: string[];
}

/**
 * Task 126, 11-11: a grind stop only runs on one of this section's maps, and only for a monster
 * that really turns up there. The alignment already builds rows that way, but a polluted table
 * (book 001 also covering an all-questions-mark row) once put 453/454 into the Prologue; drop
 * anything that still slipped through and say so in the book's "对不上" list.
 */
function pruneGrind(
  grind: readonly RouteGrind[],
  sectionMapIds: ReadonlySet<number>,
  ctx: BuildContext,
): PrunedGrind {
  const kept: RouteGrind[] = [];
  const mismatches: string[] = [];
  for (const row of grind) {
    if (!sectionMapIds.has(row.mapId)) {
      mismatches.push(`刷怪站 ${row.mapId} ${row.what}:不在本节地图里,已丢掉`);
      continue;
    }
    if (!monsterNamesOn(row.mapId, ctx).has(normalizeName(row.monster))) {
      mismatches.push(`刷怪站 ${row.mapId} ${row.what}:这张图遇不到 ${row.monster},已丢掉`);
      continue;
    }
    kept.push(row);
  }
  return { grind: kept, mismatches };
}

/** Normalized monsters the knowledge module's encounter rows place on one map. */
function monsterNamesOn(mapId: number, ctx: BuildContext): ReadonlySet<string> {
  const cached = ctx.cache.monsterNamesByMap.get(mapId);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  for (const monster of ctx.knowledge.monsters) {
    if (!monster.encounters.some((encounter) => encounterMapIds(encounter).includes(mapId))) {
      continue;
    }
    names.add(normalizeName(monster.name));
  }
  ctx.cache.monsterNamesByMap.set(mapId, names);
  return names;
}

function bestSpot(
  mapIds: readonly number[],
  bookId: number | null,
  name: string,
  ctx: BuildContext,
): { mapId: number; weight: number | null; chance: number | null } | null {
  let best: { mapId: number; weight: number | null; chance: number | null } | null = null;
  for (const mapId of mapIds) {
    const found = monstersIn(ctx.knowledge, { mapIds: [mapId] }).find((monster) =>
      monsterIdentityMatches(monster, bookId, name),
    );
    const candidate =
      found === undefined
        ? areaScopedSpot(mapId, bookId, name, ctx)
        : { mapId, weight: found.encounterWeight, chance: found.encounterChance };
    if (candidate === null) continue;
    if (
      best === null ||
      (candidate.weight ?? -1) > (best.weight ?? -1) ||
      ((candidate.weight ?? -1) === (best.weight ?? -1) && candidate.mapId < best.mapId)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * `monstersIn` selects encounters by map id, so an area-scoped encounter has no map row even
 * though the monster does appear there. Fall back to the monster's own encounter rows.
 */
function areaScopedSpot(
  mapId: number,
  bookId: number | null,
  name: string,
  ctx: BuildContext,
): { mapId: number; weight: number | null; chance: number | null } | null {
  const monster = ctx.knowledge.monsters.find(
    (item) =>
      monsterIdentityMatches(item, bookId, name) &&
      item.encounters.some((encounter) => encounterMapIds(encounter).includes(mapId)),
  );
  if (monster === undefined) return null;
  const groups = monster.encounters.filter((encounter) =>
    encounterMapIds(encounter).includes(mapId),
  );
  let weight: number | null = 0;
  for (const group of groups)
    weight = weight === null || group.weight === null ? null : weight + group.weight;
  const total = ctx.knowledge.encounters
    .filter((encounter) => encounterMapIds(encounter).includes(mapId))
    .reduce((sum, encounter) => sum + (encounter.weight ?? 0), 0);
  const chance = weight === null || total <= 0 ? null : weight / total;
  return { mapId, weight, chance };
}

function monsterIdentityMatches(
  monster: MonsterKnowledge,
  bookId: number | null,
  name: string,
): boolean {
  if (bookId !== null && monster.bookId !== bookId) return false;
  return name === "" || normalizeName(monster.name) === normalizeName(name);
}

function dedupeGrind(rows: readonly RouteGrind[]): RouteGrind[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.mapId}\u0000${row.what}\u0000${row.monster}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Mismatches, missables, totals

function buildMismatches(
  section: GuideSection,
  maps: readonly RouteMap[],
  places: readonly RoutePlace[],
  chests: readonly RouteChest[],
  atlasChestCount: number,
  stations: readonly RouteStation[],
  notes: readonly RouteNote[],
  monsters: readonly RouteMonster[],
  ctx: BuildContext,
): string[] {
  const out: string[] = [];
  if (maps.length === 0) out.push("整节没对上地图");
  for (const place of places) {
    if (!place.unmatched) continue;
    out.push(`${place.title}:没对上地图`);
  }
  if (chests.length > 0) {
    const unpaired = chests.filter(
      (chest) => chest.match === "none" && chest.candidates.length > 0,
    ).length;
    const unmatchedPlaces = unique(
      chests
        .filter((chest) => chest.match === "none" && chest.candidates.length === 0)
        .map((chest) => placeShort(chest.where, section.title)),
    );
    if (unpaired > 0) {
      out.push(`攻略 ${chests.length} 个，地图记录 ${atlasChestCount} 个；名字对不上,不配对`);
    } else if (atlasChestCount !== chests.length) {
      const suffix =
        unmatchedPlaces.length > 0
          ? `：${unmatchedPlaces.join("、")} 那个到了现场找`
          : atlasChestCount > chests.length
            ? "：地图记录多出的没对上攻略"
            : "：有宝箱没对上";
      out.push(`攻略 ${chests.length} 个，地图记录 ${atlasChestCount} 个${suffix}`);
    }
  }
  for (const note of notes) {
    if (note.pointCandidate === null) continue;
    const label = note.pointCandidate === "save" ? "存档" : "回复";
    out.push(`${placeShort(note.where, section.title)}:攻略提到${label},但没对上真实的点`);
  }
  for (const station of stations) {
    if (station.kind !== "save" && station.kind !== "heal" && station.kind !== "boss") continue;
    if (station.mapId !== null && station.cell !== null) continue;
    const label = station.kind === "boss" ? "首领" : station.kind === "save" ? "存档点" : "回复点";
    if (station.mapId === null)
      out.push(`${placeShort(station.where, section.title)}:${label}没对上地图`);
    else out.push(`${station.mapId}:${label}没对上坐标,现场找`);
  }
  for (const monster of monsters) {
    if (monster.bookId === null) continue;
    const known = monstersByBook(monster.bookId, ctx);
    if (known.length === 0) {
      out.push(`图鉴 ${padBook(monster.bookId)} ${monster.name}:知识模块里没有这只怪`);
      continue;
    }
    if (monster.maps.length === 0 && known.every((item) => item.encounters.length === 0)) {
      out.push(`图鉴 ${padBook(monster.bookId)} ${monster.name}:遇敌表里没找到`);
    }
  }
  return unique(out);
}

function placeShort(where: string | null, sectionTitle: string): string {
  if (where === null) return "这一段";
  const prefix = `${sectionTitle} - `;
  return where.startsWith(prefix) ? where.slice(prefix.length) : where;
}

function missableRules(knowledge: Knowledge): Map<number, string> {
  const out = new Map<number, string>();
  for (const rule of missablesAfter(knowledge, "")) {
    if (rule.kind !== "monster") continue;
    for (const number of rule.numbers) {
      if (!out.has(number)) out.set(number, rule.until);
    }
  }
  return out;
}

function totalsOf(sections: readonly RouteSection[]): RouteBook["totals"] {
  const allMonsters = sections.flatMap((section) => [...section.monsters, ...section.bosses]);
  return {
    sections: sections.length,
    stations: sections.reduce((sum, section) => sum + section.stations.length, 0),
    chestsMatched: sections.reduce((sum, section) => sum + section.chestsMatched, 0),
    chestsTotal: sections.reduce((sum, section) => sum + section.chestsTotal, 0),
    bestiaryMissing: sections.reduce((sum, section) => sum + section.bestiaryMissing, 0),
    bestiaryUnknown: allMonsters.some((monster) => monster.registered === null),
    blueMagicMissing: sections.reduce((sum, section) => sum + section.blueMagicMissing, 0),
    revisit: sections.reduce((sum, section) => sum + (section.revisit?.stations.length ?? 0), 0),
    mismatches: sections.reduce((sum, section) => sum + section.mismatches.length, 0),
  };
}

export { renderRouteBook } from "./route-book-render.ts";

// ---------------------------------------------------------------------------------------------
// Small shared helpers

// 11-11: the knowledge module (task 121) already resolves every encounter row to the maps it
// covers. Deriving maps from `areaId` here scanned all 643 maps per row (102 s of a 110 s build
// on real data) and repeated the old mix-up of encounter areas with map areas.
function encounterMapIds(encounter: {
  readonly mapId: number | null;
  readonly mapIds?: readonly number[];
}): number[] {
  if (encounter.mapIds !== undefined && encounter.mapIds.length > 0) return [...encounter.mapIds];
  return encounter.mapId === null ? [] : [encounter.mapId];
}

function padBook(bookId: number): string {
  return String(bookId).padStart(3, "0");
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x: unknown = value[0];
  const y: unknown = value[1];
  return typeof x === "number" && typeof y === "number" ? [x, y] : null;
}

function cellKey(cell: Cell): string {
  return `${cell[0]},${cell[1]}`;
}

function uniqueCells(cells: readonly Cell[]): Cell[] {
  const seen = new Set<string>();
  return cells.filter((cell) => {
    const key = cellKey(cell);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numberOrNull(value: unknown): number | null {
  const direct = num(value);
  if (direct !== undefined) return direct;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

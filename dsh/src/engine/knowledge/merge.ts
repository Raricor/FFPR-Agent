/**
 * Joining `master` and `guide` (task 93). The matching rules:
 * - monsters: the bestiary number first (`bookId`), the name second, because the bridge reads
 *   the number in battle and it survives the guides' English/Chinese name differences;
 * - chests: the guide's running number against the treasure id, then the area plus the content
 *   name (the Steam guide numbers the 225 chests and the 46 hidden items);
 * - shops: the area and the shop kind, then each product by name.
 *
 * Numbers prefer `master`; descriptions prefer `guide`. When both know a field and disagree,
 * both values go into `conflicts` — neither side is dropped. Guide-only rows are kept with
 * `guide` sources so the module still answers before the bridge has exported anything.
 */

import type { Chapter, Monster } from "../guide/ludo.ts";
import type { Guide } from "../guide/kb.ts";
import { SHOP_KINDS, type ShopTable, type SteamSection, type Treasure } from "../guide/steam.ts";
import { toElement } from "../elements.ts";
import { isRecord, text } from "../values.ts";
import type { LoadedKnowledge } from "./load.ts";
import { steamAreaTables, type SteamAreaMonster } from "./steam-monsters.ts";
import type {
  ChestGuide,
  ChestKnowledge,
  EncounterKnowledge,
  FactConflict,
  ItemKnowledge,
  Knowledge,
  MagicKnowledge,
  MapKnowledge,
  MonsterDropRow,
  MonsterKnowledge,
  MonsterMoveRow,
  MoveKnowledge,
  SaveProgress,
  ShopKnowledge,
  ShopProduct,
  SourceKind,
  SourceRef,
} from "./types.ts";

const MASTER_MONSTERS: SourceRef = { kind: "master", ref: "master:monsters.json" };
const MASTER_ENCOUNTERS: SourceRef = { kind: "master", ref: "master:encounters.json" };
const MASTER_MAPS: SourceRef = { kind: "master", ref: "master:maps.json" };
const MASTER_TREASURES: SourceRef = { kind: "master", ref: "master:treasures.json" };
const MASTER_SHOPS: SourceRef = { kind: "master", ref: "master:shops.json" };
const MASTER_ITEMS: SourceRef = { kind: "master", ref: "master:items.json" };
const MASTER_MAGIC: SourceRef = { kind: "master", ref: "master:magic.json" };
const STEAM_BESTIARY: SourceRef = { kind: "guide", ref: "guide:steam-bestiary" };
const OBSERVED_ATLAS: SourceRef = { kind: "observed", ref: "atlas" };
const SAVE_PROGRESS: SourceRef = { kind: "save", ref: "progress" };

/** Names from different languages and guides: ignore decoration, case, spaces and punctuation. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[☆★*]/g, "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function source(kind: SourceKind, ref: string): SourceRef {
  return { kind, ref };
}

/** Deduplicate by kind + ref, keeping the first occurrence. */
export function mergeSources(...groups: readonly (readonly SourceRef[])[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const group of groups) {
    for (const item of group) {
      const key = `${item.kind}\u0000${item.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function guideSources(guide: Guide | null): SourceRef[] {
  if (guide === null) return [];
  const refs = Object.entries(guide.sources).map(([key, url]) => source("guide", `${key}:${url}`));
  return refs.length > 0 ? refs : [source("guide", "guide.json")];
}

function guideSectionSource(section: string): SourceRef {
  return source("guide", `steam:${section}`);
}

function guideChapterSource(chapter: Chapter): SourceRef {
  return source("guide", `ludo:${chapter.slug}`);
}

function canonicalElement(value: string): string {
  return toElement(value) ?? value.trim().toLowerCase();
}

function sameCanonical(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left.map(canonicalElement))].sort();
  const b = [...new Set(right.map(canonicalElement))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function pickNumber(
  field: string,
  master: number | null,
  guide: number | null,
  conflicts: FactConflict[],
): number | null {
  if (master !== null && guide !== null && master !== guide) {
    conflicts.push({ field, master, guide });
  }
  return master ?? guide;
}

function pickBoolean(
  field: string,
  master: boolean | null,
  guide: boolean | null,
  conflicts: FactConflict[],
): boolean | null {
  if (master !== null && guide !== null && master !== guide) {
    conflicts.push({ field, master, guide });
  }
  return master ?? guide;
}

function pickElements(
  field: string,
  master: readonly string[],
  guide: readonly string[],
  conflicts: FactConflict[],
): readonly string[] {
  if (master.length > 0 && guide.length > 0 && !sameCanonical(master, guide)) {
    conflicts.push({ field, master: [...master], guide: [...guide] });
  }
  return master.length > 0 ? master : guide;
}

function guideElements(names: readonly string[]): string[] {
  return names.map((name) => toElement(name) ?? name.trim()).filter((name) => name !== "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}

function guideBlueNames(value: string): string[] {
  return unique(
    value
      .split(/,|;|\/|\band\b/gi)
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

function mapById(maps: readonly MapKnowledge[]): Map<number, MapKnowledge> {
  const out = new Map<number, MapKnowledge>();
  for (const map of maps) if (map.id !== null) out.set(map.id, map);
  return out;
}

function areaNameOf(areaId: number | null, maps: readonly MapKnowledge[]): string | null {
  if (areaId === null) return null;
  for (const map of maps) {
    if (map.areaId === areaId && map.areaName !== null) return map.areaName;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Maps

function buildMaps(input: LoadedKnowledge): MapKnowledge[] {
  const visited = new Set(input.progress.visitedMaps);
  const visitedKnown = input.progress.visitedMapsKnown === true;
  const saveSources = visitedKnown ? [SAVE_PROGRESS] : [];
  const out: MapKnowledge[] = input.static.maps.map((row) => ({
    id: row.id,
    name: row.name,
    areaId: row.areaId,
    areaName: row.areaName,
    areaType: row.areaType,
    visited: visitedKnown && row.id !== null ? visited.has(row.id) : null,
    sources: mergeSources([MASTER_MAPS], saveSources),
    conflicts: [],
  }));
  const ids = new Set(out.flatMap((map) => (map.id === null ? [] : [map.id])));
  for (const [key, entry] of input.atlas?.maps ?? []) {
    const id = Number(key);
    if (!Number.isFinite(id) || ids.has(id)) continue;
    ids.add(id);
    out.push({
      id,
      name: text(entry.name) ?? null,
      areaId: null,
      areaName: null,
      areaType: null,
      visited: visitedKnown ? visited.has(id) : null,
      sources: mergeSources([OBSERVED_ATLAS], saveSources),
      conflicts: [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Encounters

function buildEncounters(
  input: LoadedKnowledge,
  maps: readonly MapKnowledge[],
): EncounterKnowledge[] {
  const byMap = mapById(maps);
  return input.static.encounters.map((row) => {
    const map = row.mapId === null ? undefined : byMap.get(row.mapId);
    return {
      scope: row.scope,
      mapId: row.mapId,
      areaId: row.areaId,
      mapName: map?.name ?? null,
      areaName: row.areaId === null ? (map?.areaName ?? null) : areaNameOf(row.areaId, maps),
      groupId: row.groupId,
      weight: row.weight,
      monsterIds: row.monsterIds,
      sources: [MASTER_ENCOUNTERS],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Monsters

interface GuideMonster {
  readonly monster: Monster;
  readonly chapter: Chapter;
}

function guideMonsters(guide: Guide | null): GuideMonster[] {
  if (guide === null) return [];
  const out: GuideMonster[] = [];
  for (const chapter of guide.ludo) {
    for (const monster of chapter.monsters) out.push({ monster, chapter });
  }
  return out;
}

function matchGuideMonster(
  row: MonsterKnowledge | { bookId: number | null; name: string },
  byBook: ReadonlyMap<number, GuideMonster>,
  byName: ReadonlyMap<string, GuideMonster>,
): GuideMonster | null {
  if (row.bookId !== null) {
    const found = byBook.get(row.bookId);
    if (found !== undefined) return found;
  }
  return byName.get(normalizeName(row.name)) ?? null;
}

function moveKnowledge(move: MonsterMoveRow): MoveKnowledge {
  return {
    abilityId: move.abilityId,
    name: move.name ?? (move.abilityId === null ? "未知招式" : `能力 ${move.abilityId}`),
    blueMagic: move.blueMagic,
    conditions: move.conditions,
    rate: move.rate,
    sources: [MASTER_MONSTERS],
  };
}

function noteFor(guide: Guide, hit: GuideMonster | null, bookId: number | null): string | null {
  const parts: string[] = [];
  if (bookId !== null) {
    const note = guide.monsterNote(bookId);
    if (note !== "") parts.push(note);
  }
  const own = hit?.monster.notes ?? "";
  if (own !== "") parts.push(own);
  return parts.length > 0 ? [...new Set(parts)].join(" / ") : null;
}

function steamByBook(guide: Guide | null): Map<number, SteamAreaMonster[]> {
  const out = new Map<number, SteamAreaMonster[]>();
  for (const table of steamAreaTables(guide)) {
    for (const monster of table.monsters) {
      out.set(monster.book, [...(out.get(monster.book) ?? []), monster]);
    }
  }
  return out;
}

function steamAreas(rows: readonly SteamAreaMonster[]): string[] {
  return unique(rows.map((row) => row.area));
}

function steamBlueMagic(rows: readonly SteamAreaMonster[]): string[] {
  return unique(rows.flatMap((row) => row.blueMagic));
}

function steamSources(rows: readonly SteamAreaMonster[]): SourceRef[] {
  return mergeSources(...rows.map((row) => [row.source]));
}

function buildMonster(
  row: {
    readonly id: number | null;
    readonly bookId: number | null;
    readonly name: string;
    readonly level: number | null;
    readonly hp: number | null;
    readonly mp: number | null;
    readonly boss: boolean | null;
    readonly weak: readonly string[];
    readonly absorb: readonly string[];
    readonly nullify: readonly string[];
    readonly statusImmune: readonly string[];
    readonly drops: readonly MonsterDropRow[];
    readonly steal: readonly MonsterDropRow[];
    readonly moves: readonly MoveKnowledge[];
  },
  hit: GuideMonster | null,
  guide: Guide | null,
  steam: readonly SteamAreaMonster[] = [],
): MonsterKnowledge {
  const conflicts: FactConflict[] = [];
  const guideMonster = hit?.monster ?? null;
  const guideWeak = guideMonster === null ? [] : guideElements(guideMonster.weak);
  const guideAbsorb = guideMonster === null ? [] : guideElements(guideMonster.absorb);
  const guideImmune = guideMonster === null ? [] : guideElements(guideMonster.immune);
  const guideName = guideMonster?.name ?? null;
  const guideBook = guideMonster !== null && guideMonster.book > 0 ? guideMonster.book : null;
  const guideBoss = guideName?.includes("☆") ?? null;
  const sources = mergeSources(
    [MASTER_MONSTERS],
    hit === null ? [] : [guideChapterSource(hit.chapter)],
    steamSources(steam),
  );
  const bookId = pickNumber("bookId", row.bookId, guideBook, conflicts);
  const guideNote = guide !== null && bookId !== null ? noteFor(guide, hit, bookId) : null;
  // The area table fills a number the ludo row lacks; when the master already knows it, the
  // master wins without creating a conflict against the guide's table copy.
  const table = steam[0];
  const guideHp = guideMonster?.hp ?? (row.hp === null ? (table?.hp ?? null) : null);
  const guideMp = row.mp === null ? (table?.mp ?? null) : null;
  return {
    id: row.id,
    bookId,
    name: row.name,
    level: pickNumber("level", row.level, guideMonster?.level ?? null, conflicts),
    hp: pickNumber("hp", row.hp, guideHp, conflicts),
    mp: pickNumber("mp", row.mp, guideMp, conflicts),
    boss: pickBoolean("boss", row.boss, guideBoss, conflicts),
    weak: pickElements("weak", row.weak, guideWeak, conflicts),
    absorb: pickElements("absorb", row.absorb, guideAbsorb, conflicts),
    nullify: pickElements("nullify", row.nullify, guideImmune, conflicts),
    statusImmune: row.statusImmune,
    drops: row.drops,
    steal: row.steal,
    moves: row.moves,
    statuses: unique(row.moves.flatMap((move) => move.conditions)),
    guideBlueMagic: unique([
      ...(guideMonster === null ? [] : guideBlueNames(guideMonster.blue)),
      ...steamBlueMagic(steam),
    ]),
    guideAreas: unique([
      ...(guideMonster === null ? [] : [guideMonster.area, hit?.chapter.title ?? ""]),
      ...steamAreas(steam),
    ]),
    guideNote,
    encounters: [],
    encounterWeight: null,
    encounterChance: null,
    sources,
    conflicts,
  };
}

function guideOnlyMonster(
  hit: GuideMonster,
  guide: Guide,
  steam: readonly SteamAreaMonster[] = [],
): MonsterKnowledge {
  const monster = hit.monster;
  const bookId = monster.book > 0 ? monster.book : null;
  const table = steam[0];
  return {
    id: null,
    bookId,
    name: monster.name,
    level: monster.level,
    hp: monster.hp ?? table?.hp ?? null,
    mp: table?.mp ?? null,
    boss: monster.name.includes("☆") ? true : null,
    weak: guideElements(monster.weak),
    absorb: guideElements(monster.absorb),
    nullify: guideElements(monster.immune),
    statusImmune: [],
    drops: [],
    steal: [],
    moves: [],
    statuses: [],
    guideBlueMagic: unique([...guideBlueNames(monster.blue), ...steamBlueMagic(steam)]),
    guideAreas: unique([monster.area, hit.chapter.title, ...steamAreas(steam)]),
    guideNote: noteFor(guide, hit, bookId),
    encounters: [],
    encounterWeight: null,
    encounterChance: null,
    sources: mergeSources([guideChapterSource(hit.chapter)], steamSources(steam)),
    conflicts: [],
  };
}

/**
 * One row of the Steam bestiary (number → English name) when no master export exists. The ludo
 * chapter supplies stats and weaknesses, the area tables supply where it appears, its table
 * numbers and its blue-magic note.
 */
function guideBestiaryMonster(
  book: number,
  name: string,
  hit: GuideMonster | null,
  guide: Guide,
  steam: readonly SteamAreaMonster[],
): MonsterKnowledge {
  const monster = hit?.monster ?? null;
  const table = steam[0];
  return {
    id: null,
    bookId: book,
    name,
    level: monster?.level ?? null,
    hp: monster?.hp ?? table?.hp ?? null,
    mp: table?.mp ?? null,
    boss: name.includes("☆") ? true : null,
    weak: monster === null ? [] : guideElements(monster.weak),
    absorb: monster === null ? [] : guideElements(monster.absorb),
    nullify: monster === null ? [] : guideElements(monster.immune),
    statusImmune: [],
    drops: [],
    steal: [],
    moves: [],
    statuses: [],
    guideBlueMagic: unique([
      ...(monster === null ? [] : guideBlueNames(monster.blue)),
      ...steamBlueMagic(steam),
    ]),
    guideAreas: unique([
      ...(hit === null ? [] : [hit.monster.area, hit.chapter.title]),
      ...steamAreas(steam),
    ]),
    guideNote: noteFor(guide, hit, book),
    encounters: [],
    encounterWeight: null,
    encounterChance: null,
    sources: mergeSources(
      [STEAM_BESTIARY],
      hit === null ? [] : [guideChapterSource(hit.chapter)],
      steamSources(steam),
    ),
    conflicts: [],
  };
}

function buildMonsters(input: LoadedKnowledge): MonsterKnowledge[] {
  const guide = input.guide;
  const hits = guideMonsters(guide);
  const byBook = new Map<number, GuideMonster>();
  const byName = new Map<string, GuideMonster>();
  for (const hit of hits) {
    if (hit.monster.book > 0 && !byBook.has(hit.monster.book)) {
      byBook.set(hit.monster.book, hit);
    }
    const name = normalizeName(hit.monster.name);
    if (name !== "" && !byName.has(name)) byName.set(name, hit);
  }
  const steam = steamByBook(guide);
  const used = new Set<GuideMonster>();
  const out: MonsterKnowledge[] = [];
  const presentBooks = new Set<number>();
  const presentNames = new Set<string>();
  const remember = (monster: MonsterKnowledge): void => {
    if (monster.bookId !== null) presentBooks.add(monster.bookId);
    const name = normalizeName(monster.name);
    if (name !== "") presentNames.add(name);
  };

  for (const row of input.static.monsters) {
    const candidate: MonsterKnowledge = {
      id: row.id,
      bookId: row.bookId,
      name: row.name ?? "未知怪物",
      level: row.level,
      hp: row.hp,
      mp: row.mp,
      boss: row.boss,
      weak: row.weak,
      absorb: row.absorb,
      nullify: row.nullify,
      statusImmune: row.statusImmune,
      drops: row.drops,
      steal: row.steal,
      moves: (row.moves ?? []).map(moveKnowledge),
      statuses: unique((row.moves ?? []).flatMap((move) => move.conditions)),
      guideBlueMagic: [],
      guideAreas: [],
      guideNote: null,
      encounters: [],
      encounterWeight: null,
      encounterChance: null,
      sources: [MASTER_MONSTERS],
      conflicts: [],
    };
    const hit = matchGuideMonster(candidate, byBook, byName);
    if (hit !== null) used.add(hit);
    const steamRows = row.bookId === null ? [] : (steam.get(row.bookId) ?? []);
    const monster = buildMonster({ ...candidate, name: candidate.name }, hit, guide, steamRows);
    out.push(monster);
    remember(monster);
  }

  // No master: the Steam bestiary's 302 numbers are the base, not just the ludo chapters that
  // happen to have a parsed row. Area tables and ludo add the details on top.
  if (guide !== null && input.static.monsters.length === 0) {
    const entries = [...guide.bestiary.entries()].sort((left, right) => left[0] - right[0]);
    for (const [book, name] of entries) {
      if (presentBooks.has(book)) continue;
      const hit = byBook.get(book) ?? byName.get(normalizeName(name)) ?? null;
      if (hit !== null) used.add(hit);
      const monster = guideBestiaryMonster(book, name, hit, guide, steam.get(book) ?? []);
      out.push(monster);
      remember(monster);
    }
  }

  const seen = new Set<string>();
  for (const hit of hits) {
    if (used.has(hit) || guide === null) continue;
    if (hit.monster.book > 0 && presentBooks.has(hit.monster.book)) continue;
    const key =
      hit.monster.book > 0 ? `book:${hit.monster.book}` : `name:${normalizeName(hit.monster.name)}`;
    if (seen.has(key) || presentNames.has(normalizeName(hit.monster.name))) continue;
    seen.add(key);
    const monster = guideOnlyMonster(
      hit,
      guide,
      hit.monster.book > 0 ? (steam.get(hit.monster.book) ?? []) : [],
    );
    out.push(monster);
    remember(monster);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Treasure

interface GuideTreasure {
  readonly section: SteamSection;
  readonly treasure: Treasure;
}

function guideTreasures(guide: Guide | null): GuideTreasure[] {
  if (guide === null) return [];
  const out: GuideTreasure[] = [];
  for (const section of guide.walkthrough) {
    for (const treasure of section.treasures ?? []) out.push({ section, treasure });
  }
  return out;
}

const CONTENT_PHRASES: readonly RegExp[] = [
  /\bto\s+find\s+(?:(?:a|an|the)\s+)?([^,.;!?]+)/gi,
  /\bcontaining\s+(?:(?:a|an|the)\s+)?([^,.;!?]+)/gi,
  /\bfor\s+(?:(?:a|an|the)\s+)?([^,.;!?]+)/gi,
  /\bfind\s+(?:(?:a|an|the)\s+)?([^,.;!?]+)/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === "") return false;
  if (/^[\x20-\x7e]+$/.test(trimmed)) {
    const word = escapeRegExp(trimmed);
    return new RegExp(`(^|[^A-Za-z0-9-])${word}($|[^A-Za-z0-9-])`, "i").test(text);
  }
  return text.includes(trimmed);
}

function matchKnownName(text: string, known: readonly string[]): string | null {
  for (const name of known) {
    if (hasName(text, name)) return name;
  }
  return null;
}

function withoutParentheses(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanContent(value: string): string | null {
  const trimmed = withoutParentheses(value)
    .replace(/^[\s"'“”‘’]+/u, "")
    .replace(/[\s"'“”‘’,.;:!?]+$/u, "")
    .trim();
  return trimmed === "" ? null : trimmed;
}

/** The last content phrase in the sentence: `to find X`, `containing X`, `for X`, `find X`. */
function lastContentPhrase(text: string): string | null {
  let best: { readonly index: number; readonly value: string } | null = null;
  for (const pattern of CONTENT_PHRASES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      const index = match.index;
      if (value === undefined) continue;
      if (best === null || index > best.index) best = { index, value };
    }
  }
  return best?.value.trim() ?? null;
}

/**
 * The item a Steam chest sentence says it contains. The old version cut at the first `(`, `:`
 * or `;`, so a walkthrough sentence became the content ("Go through the nearby door"). Prefer
 * the last content phrase, then the longest known item name (shop goods, master items, monster
 * drops); with neither there is no content name and the full sentence stays in `guide.text`.
 */
export function guideContent(textValue: string, known: readonly string[] = []): string | null {
  const text = withoutParentheses(textValue);
  const phrase = lastContentPhrase(text);
  const content = phrase === null ? null : cleanContent(phrase);
  if (content !== null) {
    const knownInContent = matchKnownName(content, known);
    if (knownInContent !== null) return knownInContent;
    return content;
  }
  return matchKnownName(text, known);
}

function knownItemNames(input: LoadedKnowledge): string[] {
  const names = new Set<string>();
  const add = (value: string | null): void => {
    if (value !== null && value.trim() !== "") names.add(value.trim());
  };
  for (const item of input.static.items) add(item.name);
  for (const shop of input.static.shops) {
    for (const product of shop.products) add(product.name);
  }
  for (const monster of input.static.monsters) {
    for (const drop of monster.drops) add(drop.name);
    for (const steal of monster.steal) add(steal.name);
  }
  for (const shop of guideShops(input.guide)) {
    for (const good of shop.shop.goods) add(good.name);
  }
  return [...names].sort((left, right) => Array.from(right).length - Array.from(left).length);
}

function contentMatches(master: string | null, guideText: string): boolean {
  if (master === null || master.trim() === "") return false;
  const content = normalizeName(master);
  const line = normalizeName(guideText);
  return content !== "" && line.includes(content);
}

function areaMatches(section: string, name: string | null, guide: Guide | null): boolean {
  if (name === null) return false;
  const keys = areaKeys(guide, name);
  const title = normalizeName(section);
  const own = normalizeName(name);
  if (title === "" || own === "") return false;
  return (
    title === own ||
    title.includes(own) ||
    own.includes(title) ||
    keys.some((key) => key !== "" && (title.includes(key) || key.includes(title)))
  );
}

function mapsForSection(
  maps: readonly MapKnowledge[],
  guide: Guide | null,
  section: string,
): MapKnowledge[] {
  return maps.filter(
    (map) => areaMatches(section, map.name, guide) || areaMatches(section, map.areaName, guide),
  );
}

function mapForSection(
  maps: readonly MapKnowledge[],
  guide: Guide | null,
  section: string,
): MapKnowledge | null {
  const found = mapsForSection(maps, guide, section);
  return found.length === 1 ? (found[0] ?? null) : null;
}

function chestGuide(hit: GuideTreasure): ChestGuide {
  return {
    n: hit.treasure.n,
    section: hit.section.title,
    where: hit.treasure.where,
    text: hit.treasure.text,
    kind: hit.treasure.kind,
  };
}

function openedChest(
  progress: SaveProgress,
  id: number | null,
  flag: string | null,
): boolean | null {
  if (progress.openedChestsKnown !== true) return null;
  if (id !== null && progress.openedChests.includes(id)) return true;
  if (flag !== null && progress.openedChests.includes(flag)) return true;
  if (id === null && flag === null) return null;
  return false;
}

function buildChests(input: LoadedKnowledge, maps: readonly MapKnowledge[]): ChestKnowledge[] {
  const guide = input.guide;
  const mapsById = mapById(maps);
  const hits = guideTreasures(guide);
  const known = knownItemNames(input);
  const used = new Set<GuideTreasure>();
  const out: ChestKnowledge[] = [];
  for (const row of input.static.treasures) {
    const map = row.mapId === null ? undefined : mapsById.get(row.mapId);
    const areaName = row.areaId === null ? (map?.areaName ?? null) : areaNameOf(row.areaId, maps);
    const hidden = row.hidden === true;
    const conflicts: FactConflict[] = [];
    const hit =
      hits.find(
        (candidate) =>
          !used.has(candidate) &&
          ((row.id !== null && candidate.treasure.n === row.id) ||
            (areaMatches(candidate.section.title, areaName ?? map?.name ?? null, guide) &&
              contentMatches(row.contentName, candidate.treasure.text))),
      ) ?? null;
    if (hit !== null) {
      used.add(hit);
      if (row.hidden !== null && (hit.treasure.kind === "hidden") !== hidden) {
        conflicts.push({ field: "hidden", master: hidden, guide: hit.treasure.kind });
      }
      const content = guideContent(hit.treasure.text, known);
      if (
        row.contentName !== null &&
        content !== null &&
        !contentMatches(row.contentName, hit.treasure.text)
      ) {
        conflicts.push({
          field: "contentName",
          master: row.contentName,
          guide: content,
        });
      }
    }
    out.push({
      id: row.id,
      areaId: row.areaId,
      areaName,
      mapId: row.mapId,
      mapName: map?.name ?? null,
      cell: row.cell,
      hidden,
      contentId: row.contentId,
      contentName: row.contentName,
      count: row.count,
      flag: row.flag,
      opened: openedChest(input.progress, row.id, row.flag),
      guide: hit === null ? null : chestGuide(hit),
      observed: false,
      sources: mergeSources(
        hit === null
          ? [MASTER_TREASURES]
          : [MASTER_TREASURES, guideSectionSource(hit.section.title)],
        input.progress.openedChestsKnown === true ? [SAVE_PROGRESS] : [],
      ),
      conflicts,
    });
  }
  for (const hit of hits) {
    if (used.has(hit)) continue;
    const map = mapForSection(maps, guide, hit.section.title);
    out.push({
      id: null,
      areaId: map?.areaId ?? null,
      areaName: map?.areaName ?? hit.section.title,
      mapId: map?.id ?? null,
      mapName: map?.name ?? null,
      cell: null,
      hidden: hit.treasure.kind === "hidden",
      contentId: null,
      contentName: guideContent(hit.treasure.text, known),
      count: null,
      flag: null,
      opened: null,
      guide: chestGuide(hit),
      observed: false,
      sources: [guideSectionSource(hit.section.title)],
      conflicts: [],
    });
  }
  return addObservedChests(out, input, maps);
}

/** Atlas chests found by walking: enrich a known chest, else add an observed-only one. */
function addObservedChests(
  chests: readonly ChestKnowledge[],
  input: LoadedKnowledge,
  maps: readonly MapKnowledge[],
): ChestKnowledge[] {
  const out = [...chests];
  const byMap = mapById(maps);
  for (const [key, entry] of input.atlas?.maps ?? []) {
    const mapId = Number(key);
    if (!Number.isFinite(mapId)) continue;
    const map = byMap.get(mapId);
    for (const raw of Array.isArray(entry.chests) ? entry.chests : []) {
      if (!isRecord(raw)) continue;
      const cell = pairOf(raw.cell);
      const name = text(raw.name) ?? null;
      const index = out.findIndex(
        (chest) =>
          chest.mapId === mapId &&
          ((cell !== null &&
            chest.cell !== null &&
            chest.cell[0] === cell[0] &&
            chest.cell[1] === cell[1]) ||
            (name !== null &&
              chest.contentName !== null &&
              normalizeName(chest.contentName) === normalizeName(name))),
      );
      const existing = index < 0 ? undefined : out[index];
      if (existing !== undefined && index >= 0) {
        out[index] = {
          ...existing,
          observed: true,
          sources: mergeSources(existing.sources, [OBSERVED_ATLAS]),
        };
        continue;
      }
      out.push({
        id: null,
        areaId: map?.areaId ?? null,
        areaName: map?.areaName ?? null,
        mapId,
        mapName: map?.name ?? null,
        cell,
        hidden: false,
        contentId: null,
        contentName: name,
        count: null,
        flag: null,
        opened: null,
        guide: null,
        observed: true,
        sources: [OBSERVED_ATLAS],
        conflicts: [],
      });
    }
  }
  return out;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function pairOf(value: unknown): readonly [number, number] | null {
  if (!isUnknownArray(value)) return null;
  const x = value[0];
  const y = value[1];
  return typeof x === "number" && typeof y === "number" ? [x, y] : null;
}

// ---------------------------------------------------------------------------------------------
// Shops

interface GuideShop {
  readonly section: SteamSection;
  readonly shop: ShopTable;
}

function guideShops(guide: Guide | null): GuideShop[] {
  if (guide === null) return [];
  const out: GuideShop[] = [];
  for (const section of guide.walkthrough) {
    for (const shop of section.shops ?? []) out.push({ section, shop });
  }
  return out;
}

function kindKey(value: string | null): string {
  if (value === null) return "";
  return normalizeName(SHOP_KINDS[value] ?? value);
}

function productMatches(master: string | null, guide: string): boolean {
  if (master === null) return false;
  const own = normalizeName(master);
  const other = normalizeName(guide);
  return (
    own !== "" && other !== "" && (own === other || own.includes(other) || other.includes(own))
  );
}

function buildShops(input: LoadedKnowledge, maps: readonly MapKnowledge[]): ShopKnowledge[] {
  const guide = input.guide;
  const hits = guideShops(guide);
  const used = new Set<GuideShop>();
  const out: ShopKnowledge[] = [];
  for (const row of input.static.shops) {
    const map = row.mapId === null ? undefined : mapById(maps).get(row.mapId);
    const areaName = row.areaName ?? map?.areaName ?? map?.name ?? null;
    const hit =
      hits.find(
        (candidate) =>
          !used.has(candidate) &&
          areaMatches(candidate.section.title, areaName, guide) &&
          kindKey(candidate.shop.kind) === kindKey(row.kind),
      ) ??
      hits.find(
        (candidate) =>
          !used.has(candidate) &&
          areaMatches(candidate.section.title, areaName, guide) &&
          (kindKey(candidate.shop.kind) === "" || kindKey(row.kind) === ""),
      ) ??
      null;
    if (hit !== null) used.add(hit);
    const usedGoods = new Set<number>();
    const conflicts: FactConflict[] = [];
    const products: ShopProduct[] = row.products.map((product) => {
      const index =
        hit === null
          ? -1
          : hit.shop.goods.findIndex(
              (good, goodIndex) =>
                !usedGoods.has(goodIndex) && productMatches(product.name, good.name),
            );
      if (index < 0 || hit === null) {
        return {
          itemId: product.itemId,
          name: product.name ?? "未知道具",
          price: product.price,
          sources: [MASTER_SHOPS],
          conflicts: [],
        };
      }
      usedGoods.add(index);
      const good = hit.shop.goods[index];
      if (
        good !== undefined &&
        product.price !== null &&
        good.cost !== null &&
        product.price !== good.cost
      ) {
        conflicts.push({
          field: `product:${product.name ?? "?"}:price`,
          master: product.price,
          guide: good.cost,
        });
      }
      return {
        itemId: product.itemId,
        name: product.name ?? good?.name ?? "未知道具",
        price: product.price,
        sources: mergeSources([MASTER_SHOPS], [guideSectionSource(hit.section.title)]),
        conflicts: [],
      };
    });
    if (hit !== null) {
      for (const [index, good] of hit.shop.goods.entries()) {
        if (usedGoods.has(index)) continue;
        products.push({
          itemId: null,
          name: good.name,
          price: good.cost,
          sources: [guideSectionSource(hit.section.title)],
          conflicts: [],
        });
      }
    }
    out.push({
      id: row.id,
      mapId: row.mapId,
      areaName,
      kind: row.kind,
      products,
      guideWhere: hit?.shop.where ?? null,
      sources:
        hit === null
          ? [MASTER_SHOPS]
          : mergeSources([MASTER_SHOPS], [guideSectionSource(hit.section.title)]),
      conflicts,
    });
  }
  for (const hit of hits) {
    if (used.has(hit)) continue;
    const map = mapForSection(maps, guide, hit.section.title);
    out.push({
      id: null,
      mapId: map?.id ?? null,
      areaName: map?.areaName ?? hit.section.title,
      kind: hit.shop.kind,
      products: hit.shop.goods.map((good) => ({
        itemId: null,
        name: good.name,
        price: good.cost,
        sources: [guideSectionSource(hit.section.title)],
        conflicts: [],
      })),
      guideWhere: hit.shop.where,
      sources: [guideSectionSource(hit.section.title)],
      conflicts: [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Items and magic

function buildItems(input: LoadedKnowledge): ItemKnowledge[] {
  return input.static.items.map((row) => ({
    id: row.id,
    name: row.name ?? "未知道具",
    kind: row.kind,
    price: row.price,
    cures: row.cures,
    restores: row.restores,
    sources: [MASTER_ITEMS],
    conflicts: [],
  }));
}

function buildMagic(input: LoadedKnowledge): MagicKnowledge[] {
  return input.static.magic.map((row) => ({
    id: row.id,
    name: row.name ?? "未知魔法",
    school: row.school,
    mp: row.mp,
    cures: row.cures,
    sources: [MASTER_MAGIC],
    conflicts: [],
  }));
}

// ---------------------------------------------------------------------------------------------
// Assembly

/** The area keys a query means: its own normalized name plus the guide's English aliases. */
export function areaKeys(guide: Guide | null, value: string): string[] {
  const keys = new Set<string>();
  const own = normalizeName(value);
  if (own !== "") keys.add(own);
  for (const alias of guide?.areasFor(value) ?? []) {
    const key = normalizeName(alias);
    if (key !== "") keys.add(key);
  }
  return [...keys];
}

function attachEncounterGroups(
  monsters: readonly MonsterKnowledge[],
  encounters: readonly EncounterKnowledge[],
): MonsterKnowledge[] {
  const byId = new Map<number, EncounterKnowledge[]>();
  for (const encounter of encounters) {
    for (const id of encounter.monsterIds) {
      byId.set(id, [...(byId.get(id) ?? []), encounter]);
    }
  }
  return monsters.map((monster) => {
    if (monster.id === null) return monster;
    return { ...monster, encounters: byId.get(monster.id) ?? [] };
  });
}

/** Merge the loaded inputs; the result is what `query.ts` reads. */
export function buildKnowledge(input: LoadedKnowledge): Knowledge {
  const maps = buildMaps(input);
  const encounters = buildEncounters(input, maps);
  const monsters = attachEncounterGroups(buildMonsters(input), encounters);
  const chests = buildChests(input, maps);
  const shops = buildShops(input, maps);
  const items = buildItems(input);
  const magic = buildMagic(input);
  const allSources = mergeSources(
    input.static.sources,
    guideSources(input.guide),
    input.progress.openedChestsKnown === true || input.progress.visitedMapsKnown === true
      ? [SAVE_PROGRESS]
      : [],
    input.atlas === null ? [] : [OBSERVED_ATLAS],
    input.collisions === null ? [] : [source("observed", "collisions")],
  );
  const conflicts = [
    ...maps.flatMap((map) => map.conflicts),
    ...monsters.flatMap((monster) => monster.conflicts),
    ...chests.flatMap((chest) => chest.conflicts),
    ...shops.flatMap((shop) => [
      ...shop.conflicts,
      ...shop.products.flatMap((item) => item.conflicts),
    ]),
    ...items.flatMap((item) => item.conflicts),
    ...magic.flatMap((spell) => spell.conflicts),
  ];
  return {
    game: input.static.game,
    build: input.static.build,
    bridge: input.static.bridge,
    staticDir: input.static.dir,
    tables: input.static.tables,
    guide: input.guide,
    atlas: input.atlas,
    collisions: input.collisions,
    profile: input.profile,
    progress: input.progress,
    maps,
    encounters,
    monsters,
    chests,
    shops,
    items,
    magic,
    sources: allSources,
    conflicts,
  };
}

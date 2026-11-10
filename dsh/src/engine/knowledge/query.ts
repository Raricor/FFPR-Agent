/**
 * Pure queries over a loaded `Knowledge` (task 93). No file, no bridge, no clock: the same
 * object always answers the same way, which is what the stage layer, the route analyser, the
 * tactician's fact sheet, the completion check and the web panel all need.
 *
 * Every answer keeps its `sources`; when both `master` and `guide` knew a field and disagreed,
 * the merged object still carries the `conflicts`. Unknown numbers stay `null` rather than 0.
 */

import type {
  BlueMagicMonster,
  BlueMagicSource,
  ChestKnowledge,
  CureKnowledge,
  EncounterKnowledge,
  Knowledge,
  MissableKnowledge,
  MonsterKnowledge,
  ShopKnowledge,
  SourceRef,
  StatusMoveThreat,
  StatusThreat,
} from "./types.ts";
import { areaKeys, mergeSources, normalizeName } from "./merge.ts";

export interface MonsterFilter {
  readonly mapIds?: readonly number[];
  readonly areaIds?: readonly number[];
  /** Match by area name (Chinese, Japanese or the guide's English), as `shopsNear` does. */
  readonly areaName?: string;
}

export interface ChestFilter extends MonsterFilter {
  /** true: only opened; false: only known-unopened; undefined: every chest. */
  readonly opened?: boolean;
}

export interface BlueMagicOptions {
  /** Ability ids or names already learned; those spells are left out. */
  readonly learned?: readonly (number | string)[];
}

function source(kind: SourceRef["kind"], ref: string): SourceRef {
  return { kind, ref };
}

function includesNumber(values: readonly number[] | undefined, value: number | null): boolean {
  return value !== null && (values?.includes(value) ?? false);
}

function encounterMatches(encounter: EncounterKnowledge, filter: MonsterFilter): boolean {
  const byMap = filter.mapIds === undefined ? null : includesNumber(filter.mapIds, encounter.mapId);
  const byArea =
    filter.areaIds === undefined ? null : includesNumber(filter.areaIds, encounter.areaId);
  // "these maps or these areas": an area-scoped row has no mapId, so requiring both would cut
  // every area row as soon as an area name resolved to both its area id and its maps.
  if (byMap !== null && byArea !== null) return byMap || byArea;
  return byMap ?? byArea ?? true;
}

function otherAreaFiltered(filter: MonsterFilter): boolean {
  return (
    filter.mapIds !== undefined || filter.areaIds !== undefined || filter.areaName !== undefined
  );
}

function totalWeight(encounters: readonly EncounterKnowledge[]): number | null {
  const known = encounters.flatMap((encounter) =>
    encounter.weight === null ? [] : [encounter.weight],
  );
  return known.length === 0 ? null : known.reduce((sum, weight) => sum + weight, 0);
}

function groupWeight(encounters: readonly EncounterKnowledge[]): number | null {
  const known = encounters.flatMap((encounter) =>
    encounter.weight === null ? [] : [encounter.weight],
  );
  return known.length === 0 ? null : known.reduce((sum, weight) => sum + weight, 0);
}

function chanceOf(weight: number | null, total: number | null): number | null {
  if (weight === null || total === null || total <= 0) return null;
  return Math.min(1, weight / total);
}

function unknownMonster(id: number, encounter: EncounterKnowledge): MonsterKnowledge {
  return {
    id,
    bookId: null,
    name: `怪物 #${id}`,
    level: null,
    hp: null,
    mp: null,
    boss: null,
    weak: [],
    absorb: [],
    nullify: [],
    statusImmune: [],
    drops: [],
    steal: [],
    moves: [],
    statuses: [],
    guideBlueMagic: [],
    guideAreas: [],
    guideNote: null,
    encounters: [encounter],
    encounterWeight: null,
    encounterChance: null,
    sources: mergeSources(encounter.sources, [source("master", "master:monsters.json")]),
    conflicts: [],
  };
}

function seenInAreas(
  monster: MonsterKnowledge,
  filter: MonsterFilter,
  knowledge: Knowledge,
): boolean {
  if (!otherAreaFiltered(filter)) return true;
  const wanted = new Set<string>();
  for (const mapId of filter.mapIds ?? []) {
    const map = knowledge.maps.find((item) => item.id === mapId);
    for (const value of [map?.name ?? null, map?.areaName ?? null]) {
      if (value === null) continue;
      for (const key of areaKeys(knowledge.guide, value)) wanted.add(key);
    }
  }
  for (const areaId of filter.areaIds ?? []) {
    for (const map of knowledge.maps) {
      if (map.areaId !== areaId) continue;
      for (const value of [map.name, map.areaName]) {
        if (value === null) continue;
        for (const key of areaKeys(knowledge.guide, value)) wanted.add(key);
      }
    }
  }
  if (filter.areaName !== undefined) {
    for (const key of areaKeys(knowledge.guide, filter.areaName)) wanted.add(key);
  }
  if (wanted.size === 0) return true;
  return monster.guideAreas.some((area) => {
    const own = normalizeName(area);
    return [...wanted].some((key) => own !== "" && (own.includes(key) || key.includes(own)));
  });
}

function resolveAreaName(knowledge: Knowledge, filter: MonsterFilter): MonsterFilter {
  if (filter.areaName === undefined) return filter;
  const keys = areaKeys(knowledge.guide, filter.areaName);
  const mapIds = new Set(filter.mapIds ?? []);
  const areaIds = new Set(filter.areaIds ?? []);
  for (const map of knowledge.maps) {
    if (
      !matchesArea(knowledge, map.name, filter.areaName, keys) &&
      !matchesArea(knowledge, map.areaName, filter.areaName, keys)
    ) {
      continue;
    }
    if (map.id !== null) mapIds.add(map.id);
    if (map.areaId !== null) areaIds.add(map.areaId);
  }
  return { mapIds: [...mapIds], areaIds: [...areaIds] };
}

/**
 * Monsters that can appear in the encounter tables of these maps or areas (all tables when
 * neither is given), each with weaknesses, moves, inflicted statuses and its encounter chance.
 * Before any export exists, the Steam bestiary's rows answer, filtered by area name through
 * the walkthrough's per-area monster tables.
 */
export function monstersIn(knowledge: Knowledge, filter: MonsterFilter = {}): MonsterKnowledge[] {
  const effective = resolveAreaName(knowledge, filter);
  const selected = knowledge.encounters.filter((encounter) =>
    encounterMatches(encounter, effective),
  );
  const total = totalWeight(selected);
  const base = new Map<number, MonsterKnowledge>();
  for (const monster of knowledge.monsters) {
    if (monster.id !== null) base.set(monster.id, monster);
  }
  const order: number[] = [];
  for (const encounter of selected) {
    for (const id of encounter.monsterIds) {
      if (!order.includes(id)) order.push(id);
    }
  }
  if (order.length === 0) {
    if (knowledge.encounters.length > 0) return [];
    return knowledge.monsters.filter((monster) => seenInAreas(monster, filter, knowledge));
  }
  return order.flatMap((id) => {
    const monster = base.get(id);
    if (monster === undefined) {
      const first = selected.find((encounter) => encounter.monsterIds.includes(id));
      return first === undefined ? [] : [unknownMonster(id, first)];
    }
    const groups = selected.filter((encounter) => encounter.monsterIds.includes(id));
    const weight = groupWeight(groups);
    return [
      {
        ...monster,
        encounters: groups,
        encounterWeight: weight,
        encounterChance: chanceOf(weight, total),
        // The groups are this query's filter; the base row's sources already name the export.
        sources: mergeSources(
          monster.sources,
          groups.flatMap((group) => group.sources),
        ),
      },
    ];
  });
}

function probability(rate: number | null): number | null {
  if (rate === null || rate < 0) return null;
  return rate > 1 ? rate / 100 : rate;
}

function byScore(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/**
 * Who can inflict each status, and how often: encounter chance × move rate. A missing weight or
 * rate makes that move's score null and the aggregate `unknown`; the known part is still summed.
 */
export function statusThreats(monsters: readonly MonsterKnowledge[]): StatusThreat[] {
  const threats = new Map<string, StatusMoveThreat[]>();
  for (const monster of monsters) {
    for (const move of monster.moves) {
      const rate = probability(move.rate);
      const score =
        rate === null || monster.encounterChance === null ? null : rate * monster.encounterChance;
      for (const status of move.conditions) {
        const entry: StatusMoveThreat = {
          monster: monster.name,
          bookId: monster.bookId,
          move: move.name,
          rate,
          chance: monster.encounterChance,
          score,
          sources: move.sources,
        };
        threats.set(status, [...(threats.get(status) ?? []), entry]);
      }
    }
  }
  const out: StatusThreat[] = [];
  for (const [status, moves] of threats) {
    const known = moves.flatMap((move) => (move.score === null ? [] : [move.score]));
    const unknown = moves.some((move) => move.score === null);
    out.push({
      status,
      score: known.length === 0 ? null : known.reduce((sum, score) => sum + score, 0),
      unknown,
      moves: [...moves].sort((left, right) => byScore(left.score, right.score)),
      sources: mergeSources(...moves.map((move) => move.sources)),
    });
  }
  return out.sort((left, right) => byScore(left.score, right.score));
}

function areasOfMonster(monster: MonsterKnowledge): string[] {
  const names = new Set<string>();
  for (const encounter of monster.encounters) {
    if (encounter.areaName !== null) names.add(encounter.areaName);
    if (encounter.mapName !== null) names.add(encounter.mapName);
  }
  for (const area of monster.guideAreas) if (area !== "") names.add(area);
  return [...names];
}

function isLearned(
  learned: readonly (number | string)[],
  id: number | null,
  name: string,
): boolean {
  if (id !== null && learned.includes(id)) return true;
  const own = normalizeName(name);
  return learned.some((value) => typeof value === "string" && normalizeName(value) === own);
}

function magicIdFor(knowledge: Knowledge, name: string): number | null {
  const own = normalizeName(name);
  const spell = knowledge.magic.find((item) => normalizeName(item.name) === own);
  return spell?.id ?? null;
}

interface BlueEntry {
  abilityId: number | null;
  name: string;
  from: BlueMagicMonster[];
  sources: SourceRef[];
}

/**
 * The blue spells this save has not learned yet, and every monster that uses each one. Master
 * move rows are the primary source; the guides' "Blue Magic: …" lines fill the gap when no
 * export exists.
 */
export function blueMagicSources(
  knowledge: Knowledge,
  options: BlueMagicOptions = {},
): BlueMagicSource[] {
  const learned = options.learned ?? knowledge.progress.blueMagic;
  const entries = new Map<string, BlueEntry>();
  for (const monster of knowledge.monsters) {
    const areas = areasOfMonster(monster);
    const masterBlue = monster.moves.some((move) => move.blueMagic === true);
    for (const move of monster.moves) {
      if (move.blueMagic !== true) continue;
      const key =
        move.abilityId === null ? `name:${normalizeName(move.name)}` : `id:${move.abilityId}`;
      const entry = entries.get(key) ?? {
        abilityId: move.abilityId ?? magicIdFor(knowledge, move.name),
        name: move.name,
        from: [],
        sources: [],
      };
      entry.from.push({
        monster: monster.name,
        bookId: monster.bookId,
        move: move.name,
        areas,
        sources: mergeSources(monster.sources, move.sources),
      });
      entry.sources = mergeSources(entry.sources, move.sources);
      entries.set(key, entry);
    }
    if (masterBlue) continue;
    for (const name of monster.guideBlueMagic) {
      const already = [...entries.values()].some(
        (entry) => entry.name === name && entry.from.some((item) => item.monster === monster.name),
      );
      if (already) continue;
      const key = `guide:${normalizeName(name)}`;
      const entry = entries.get(key) ?? {
        abilityId: magicIdFor(knowledge, name),
        name,
        from: [],
        sources: [],
      };
      entry.from.push({
        monster: monster.name,
        bookId: monster.bookId,
        move: name,
        areas,
        sources: monster.sources,
      });
      entry.sources = mergeSources(entry.sources, monster.sources);
      entries.set(key, entry);
    }
  }
  return [...entries.values()]
    .filter((entry) => !isLearned(learned, entry.abilityId, entry.name))
    .map((entry) => ({
      abilityId: entry.abilityId,
      name: entry.name,
      learned: false,
      from: entry.from,
      sources: entry.sources,
    }));
}

/** Chests in these maps or areas, with this save's opened flag; guide-only chests are kept. */
export function chestsIn(knowledge: Knowledge, filter: ChestFilter = {}): ChestKnowledge[] {
  const keys = filter.areaName === undefined ? [] : areaKeys(knowledge.guide, filter.areaName);
  return knowledge.chests.filter((chest) => {
    if (filter.mapIds !== undefined && !includesNumber(filter.mapIds, chest.mapId)) return false;
    if (filter.areaIds !== undefined && !includesNumber(filter.areaIds, chest.areaId)) return false;
    if (filter.areaName !== undefined) {
      const map = knowledge.maps.find((item) => item.id === chest.mapId);
      if (
        !matchesArea(knowledge, chest.areaName, filter.areaName, keys) &&
        !matchesArea(knowledge, map?.name ?? null, filter.areaName, keys)
      ) {
        return false;
      }
    }
    if (filter.opened !== undefined && chest.opened !== filter.opened) return false;
    return true;
  });
}

function matchesArea(
  knowledge: Knowledge,
  value: string | null,
  query: string,
  keys: readonly string[],
): boolean {
  if (value === null) return false;
  const own = normalizeName(value);
  const wanted = normalizeName(query);
  if (own === "" || wanted === "") return false;
  if (own.includes(wanted) || wanted.includes(own)) return true;
  // Compare every alias of the value with every alias of the query. Comparing only `own` fails
  // when the query is English and the row is Chinese ("Wind Shrine" vs 风之神殿): the shared key
  // is the English alias on both sides, not either display name.
  const candidates = [own, ...areaKeys(knowledge.guide, value)];
  for (const candidate of candidates) {
    for (const key of keys) {
      if (candidate === "" || key === "") continue;
      if (candidate === key) return true;
      if (
        Array.from(candidate).length >= 2 &&
        Array.from(key).length >= 2 &&
        (candidate.includes(key) || key.includes(candidate))
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Shops in an area (Chinese or English name): master rows plus the guide's own shop tables. */
export function shopsNear(knowledge: Knowledge, area: string): ShopKnowledge[] {
  const keys = areaKeys(knowledge.guide, area);
  return knowledge.shops.filter((shop) => {
    if (matchesArea(knowledge, shop.areaName, area, keys)) return true;
    if (shop.mapId === null) return false;
    const map = knowledge.maps.find((item) => item.id === shop.mapId);
    return (
      matchesArea(knowledge, map?.name ?? null, area, keys) ||
      matchesArea(knowledge, map?.areaName ?? null, area, keys)
    );
  });
}

/** Every item and spell the master says cures this status, in table order. */
export function itemsThatCure(knowledge: Knowledge, status: string): CureKnowledge[] {
  const wanted = normalizeName(status);
  if (wanted === "") return [];
  const out: CureKnowledge[] = [];
  for (const item of knowledge.items) {
    if (item.cures.some((cure) => normalizeName(cure) === wanted)) {
      out.push({
        kind: "item",
        id: item.id,
        name: item.name,
        cures: item.cures,
        sources: item.sources,
      });
    }
  }
  for (const spell of knowledge.magic) {
    if (spell.cures.some((cure) => normalizeName(cure) === wanted)) {
      out.push({
        kind: "magic",
        id: spell.id,
        name: spell.name,
        cures: spell.cures,
        sources: spell.sources,
      });
    }
  }
  return out;
}

function storyOrder(knowledge: Knowledge, api: string): number {
  const profile = knowledge.profile;
  if (profile === null || api === "") return -1;
  return profile.achievements.findIndex((item) => item.api === api);
}

function lostAfter(knowledge: Knowledge, past: string | null, storyPoint: string): boolean {
  if (past === null) return false;
  const point = storyOrder(knowledge, storyPoint);
  const deadline = storyOrder(knowledge, past);
  return point >= 0 && deadline >= 0 && deadline <= point;
}

function monsterLabel(knowledge: Knowledge, numbers: readonly number[]): string {
  const named = numbers.flatMap((number) => {
    const monster = knowledge.monsters.find((item) => item.bookId === number);
    return monster === undefined ? [] : [monster.name];
  });
  const numbersText = numbers.map((number) => `#${number}`).join("、");
  return named.length > 0 ? `${named.join("、")}(${numbersText})` : `图鉴 ${numbersText}`;
}

/**
 * The timed content the profile already knows about, judged against a story point: rules whose
 * `past` flag is at or before the point are reported `lostAfter: true`. The data is the
 * existing `profiles/ff5.ts` deadline list (read only); a save's live flags are not needed here.
 */
export function missablesAfter(knowledge: Knowledge, storyPoint: string): MissableKnowledge[] {
  const profile = knowledge.profile;
  if (profile === null) return [];
  const guideRef: SourceRef = {
    kind: "guide",
    ref: `profile:${knowledge.game}:missables`,
  };
  const out: MissableKnowledge[] = profile.oneTimePlaces.map((place) => {
    const map = knowledge.maps.find((item) => item.areaId === place.area);
    return {
      kind: "treasure",
      label: map?.areaName ?? map?.name ?? `地区 ${place.area}`,
      areaIds: [place.area],
      numbers: [],
      until: place.until,
      past: place.past ?? null,
      lostAfter: lostAfter(knowledge, place.past ?? null, storyPoint),
      sources: [guideRef],
      conflicts: [],
    };
  });
  for (const rule of profile.bestiaryMissables) {
    out.push({
      kind: "monster",
      label: monsterLabel(knowledge, rule.numbers),
      areaIds: rule.areas,
      numbers: rule.numbers,
      until: rule.until,
      past: rule.past ?? null,
      lostAfter: lostAfter(knowledge, rule.past ?? null, storyPoint),
      sources: [guideRef],
      conflicts: [],
    });
  }
  return out.sort((left, right) => {
    const deadline =
      storyOrder(knowledge, left.past ?? "") - storyOrder(knowledge, right.past ?? "");
    return deadline !== 0 ? deadline : left.until.localeCompare(right.until);
  });
}

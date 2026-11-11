/**
 * The encounter table at the player's position (bridge 0.8.0 `encounters`): the game's current
 * MonsterSet, which on the world map changes with the grid area and the terrain underfoot.
 * 10-27 live: grass by Karnak was set 3 (Aegir ×3, Zu, Aegir+Zu+Aegir, Grass Tortoise ×2), the
 * desert a few steps east set 21 (five wolves), and the random battle there was a lone Zu.
 */

import { cellKey } from "./nav.ts";
import type { Pilot } from "./pilot.ts";
import { isRecord, list, num, text } from "./values.ts";

export interface EncounterMonster {
  readonly name: string;
  readonly book: number | null;
}

export interface EncounterParty {
  readonly id: number | null;
  readonly rate: number;
  readonly notEscape: boolean;
  readonly monsters: readonly EncounterMonster[];
}

export interface EncounterRegion {
  readonly grid: number | null;
  readonly start: readonly [number, number] | null;
  readonly end: readonly [number, number] | null;
  readonly current: boolean;
  readonly parties: readonly EncounterParty[];
}

/** The current vehicle and whether it can roll encounters (bridge 0.13.7, information only). */
export interface EncounterVehicle {
  readonly id: number | null;
  readonly encounter: boolean | null;
}

/**
 * The whole current map's encounter table (bridge 0.13.7): dungeons and towns union every grid,
 * the world map unions the terrains of the region the player is in. `scope` says which.
 */
export interface EncounterMap {
  readonly scope: "map" | "area" | null;
  readonly grids: readonly number[];
  readonly parties: readonly EncounterParty[];
  /** MonsterSet ids behind the union (bridge 0.13.8 `map.debug.setIds`). */
  readonly setIds: readonly number[];
  readonly error: string | null;
}

export interface EncounterTable {
  readonly monsterSet: number | null;
  readonly parties: readonly EncounterParty[];
  /** The world-map encounter area at the player, when the map has areas. */
  readonly region?: EncounterRegion | null;
  /** Every encounter area the loaded map model carries (world map: one per region). */
  readonly regions: readonly EncounterRegion[];
  /** False when a story script turned this map's encounters off (bridge 0.13.7). */
  readonly enabled: boolean | null;
  readonly vehicle: EncounterVehicle | null;
  /** The whole map's union; null for an old bridge or a reply without it. */
  readonly map: EncounterMap | null;
}

function parseParty(value: unknown): EncounterParty | null {
  if (!isRecord(value)) return null;
  const monsters = list(value.monsters)
    .filter(isRecord)
    .map((monster) => ({
      name: text(monster.name) ?? "",
      book: num(monster.book) ?? null,
    }))
    .filter((monster) => monster.name !== "");
  return {
    id: num(value.id) ?? null,
    rate: num(value.rate) ?? 0,
    notEscape: value.notEscape === true,
    monsters,
  };
}

function cellPair(value: unknown): readonly [number, number] | null {
  const pair = list(value);
  return typeof pair[0] === "number" && typeof pair[1] === "number" ? [pair[0], pair[1]] : null;
}

function parseRegion(value: unknown): EncounterRegion | null {
  if (!isRecord(value)) return null;
  const parties = list(value.parties)
    .map(parseParty)
    .filter((party): party is EncounterParty => party !== null && party.monsters.length > 0);
  return {
    grid: num(value.grid) ?? null,
    start: cellPair(value.start),
    end: cellPair(value.end),
    current: value.current === true,
    parties,
  };
}

function parseMap(value: unknown): EncounterMap | null {
  if (!isRecord(value)) return null;
  const scope = value.scope === "map" || value.scope === "area" ? value.scope : null;
  const debug = isRecord(value.debug) ? value.debug : null;
  return {
    scope,
    grids: list(value.grids).filter((grid): grid is number => typeof grid === "number"),
    parties: list(value.parties)
      .map(parseParty)
      .filter((party): party is EncounterParty => party !== null && party.monsters.length > 0),
    setIds: list(debug?.setIds).filter((id): id is number => typeof id === "number"),
    error: text(value.error) ?? null,
  };
}

/** The cache key for one cell on one map; the encounter grid never changes while it is loaded. */
function encounterGridKey(mapId: number | null, cell: readonly [number, number]): string {
  return `${mapId ?? "?"}:${cellKey(cell[0], cell[1])}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Task 69: the encounter grid number under cells on the loaded map (bridge 0.13.8
 * `encountgrid`, at most 64 cells per query). A cell's grid never changes on one map, so the
 * results are cached by map id + cell; the same cell is not asked twice during a grind.
 */
export class EncounterGridCache {
  private readonly cells = new Map<string, number | null>();

  /** Grids for `cells`, keyed with `cellKey`; throws when the bridge cannot answer. */
  async read(
    pilot: Pilot,
    mapId: number | null,
    cells: readonly (readonly [number, number])[],
  ): Promise<ReadonlyMap<string, number | null>> {
    const found = new Map<string, number | null>();
    const missing: (readonly [number, number])[] = [];
    for (const cell of cells) {
      const key = encounterGridKey(mapId, cell);
      if (this.cells.has(key)) {
        found.set(cellKey(cell[0], cell[1]), this.cells.get(key) ?? null);
      } else {
        missing.push(cell);
      }
    }
    for (const chunk of chunks(missing, 64)) {
      const reply = await pilot.query("encountgrid", {
        cells: chunk.map((cell) => [cell[0], cell[1]]),
      });
      const raw: unknown = reply.encountgrid;
      if (!Array.isArray(raw) || raw.length !== chunk.length) {
        throw new Error("读不到世界地图的遇敌格子号(桥插件可能不支持 encountgrid)");
      }
      const values = raw as unknown[];
      for (const [index, cell] of chunk.entries()) {
        const value = values[index];
        const grid = typeof value === "number" && Number.isFinite(value) ? value : null;
        this.cells.set(encounterGridKey(mapId, cell), grid);
        found.set(cellKey(cell[0], cell[1]), grid);
      }
    }
    return found;
  }
}

/** Narrow the reply; null off a map (the bridge answers null) or for a malformed one. */
export function parseEncounters(reply: unknown): EncounterTable | null {
  const body = isRecord(reply) && "encounters" in reply ? reply.encounters : reply;
  if (!isRecord(body)) return null;
  const region = parseRegion(body.region);
  const regions = list(body.regions)
    .map(parseRegion)
    .filter((item): item is EncounterRegion => item !== null);
  return {
    monsterSet: num(body.monsterSet) ?? null,
    parties: list(body.parties)
      .map(parseParty)
      .filter((party): party is EncounterParty => party !== null && party.monsters.length > 0),
    region,
    regions,
    enabled: typeof body.enabled === "boolean" ? body.enabled : null,
    vehicle: isRecord(body.vehicle)
      ? {
          id: num(body.vehicle.id) ?? null,
          encounter: typeof body.vehicle.encounter === "boolean" ? body.vehicle.encounter : null,
        }
      : null,
    map: parseMap(body.map),
  };
}

/** The current region's parties, else the table's own. */
export function encounterParties(table: EncounterTable | null): readonly EncounterParty[] {
  const region = table?.region;
  return region !== undefined && region !== null && region.parties.length > 0
    ? region.parties
    : (table?.parties ?? []);
}

/** Formations that can roll at all; a rate of 0 never appears in battle. */
export function activeParties(parties: readonly EncounterParty[]): readonly EncounterParty[] {
  return parties.filter((party) => party.rate > 0);
}

/** Each monster in a region once, by bestiary number/name. */
export function regionMonsters(region: EncounterRegion): EncounterMonster[] {
  return encounterMonsters({
    monsterSet: null,
    parties: region.parties,
    regions: [],
    enabled: null,
    vehicle: null,
    map: null,
  });
}

/** A readable fallback name; a profile may supply real place names by grid number. */
export function regionName(
  region: EncounterRegion,
  known: Readonly<Record<number, string>> = {},
): string {
  const grid = region.grid;
  const named = grid === null ? undefined : known[grid];
  if (named !== undefined && named !== "") return named;
  const label = grid === null ? "?" : String(grid);
  const bounds =
    region.start !== null && region.end !== null
      ? `(${region.start[0]},${region.start[1]})-(${region.end[0]},${region.end[1]})`
      : "范围未知";
  return `世界地图 · 区域 ${label}(${bounds})`;
}

/**
 * One line per formation, most likely first: 「艾吉尔 ×2、祖 · 23%」. A set can list the same
 * party in several slots (10-27: the desert's set 21 was five wolves four times), so a party's
 * rates add up. Rates are per mille: set 3's four rates summed to 1000.
 */
export function formationLines(table: EncounterTable | null): string[] {
  if (table === null) return [];
  const byParty = new Map<string, { party: EncounterParty; rate: number }>();
  for (const party of table.parties) {
    const key = party.id === null ? party.monsters.map((m) => m.name).join("、") : `#${party.id}`;
    const known = byParty.get(key);
    byParty.set(key, { party, rate: (known?.rate ?? 0) + party.rate });
  }
  return [...byParty.values()]
    .sort((left, right) => right.rate - left.rate)
    .map(({ party, rate }) => {
      const counts = new Map<string, number>();
      for (const monster of party.monsters) {
        counts.set(monster.name, (counts.get(monster.name) ?? 0) + 1);
      }
      const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
      const percent = `${Math.round(rate / 10)}%`;
      return `${names.join("、")} · ${percent}${party.notEscape ? " · 不能逃" : ""}`;
    });
}

/** Each monster once, in the order the formations list them. */
export function encounterMonsters(table: EncounterTable | null): EncounterMonster[] {
  const seen = new Set<string>();
  const out: EncounterMonster[] = [];
  for (const party of table?.parties ?? []) {
    for (const monster of party.monsters) {
      const key = monster.book === null ? `name:${monster.name}` : `no:${monster.book}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(monster);
    }
  }
  return out;
}

function partyHas(party: EncounterParty, target: EncounterMonster): boolean {
  return party.monsters.some((monster) =>
    target.book !== null && monster.book !== null
      ? monster.book === target.book
      : monster.name === target.name,
  );
}

/** A party set's chance for one monster: its weight over the set's total weight. */
function chanceIn(parties: readonly EncounterParty[], target: EncounterMonster): number | null {
  const active = activeParties(parties);
  const total = active.reduce((sum, party) => sum + party.rate, 0);
  if (total <= 0) return null;
  const hit = active.reduce((sum, party) => sum + (partyHas(party, target) ? party.rate : 0), 0);
  return hit / total;
}

/**
 * The whole-map union loses the MonsterSet boundaries: its parties are deduplicated by party
 * id and its total spans every set. With N sets the average must be multiplied by N to
 * estimate the best set's chance (task 68; the bridge reports the set ids but not their rows).
 */
function unionChance(
  parties: readonly EncounterParty[],
  target: EncounterMonster,
  sets: number,
): number | null {
  const chance = chanceIn(parties, target);
  if (chance === null || sets <= 1) return chance;
  return Math.min(1, chance * sets);
}

/**
 * Task 68: the chance that one battle in this map/region contains `target`, 0-1. Use the
 * MonsterSet underfoot when it can roll the monster; otherwise the best available table: the
 * current region, each loaded region, then the whole-map union. Null when no table has rates.
 */
export function monsterChance(
  table: EncounterTable | null,
  target: EncounterMonster,
): number | null {
  if (table === null) return null;
  const underfoot = chanceIn(table.parties, target);
  if (underfoot !== null && underfoot > 0) return underfoot;
  const candidates: number[] = [];
  if (table.region !== undefined && table.region !== null) {
    const region = chanceIn(table.region.parties, target);
    if (region !== null) candidates.push(region);
  }
  for (const region of table.regions) {
    const chance = chanceIn(region.parties, target);
    if (chance !== null) candidates.push(chance);
  }
  if (table.map !== null) {
    const chance = unionChance(table.map.parties, target, Math.max(1, table.map.setIds.length));
    if (chance !== null) candidates.push(chance);
  }
  if (underfoot !== null) candidates.push(underfoot);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/** One over the chance, rounded up; null when the chance is unknown or zero. */
export function expectedBattles(chance: number | null): number | null {
  return chance === null || chance <= 0 ? null : Math.ceil(1 / chance);
}

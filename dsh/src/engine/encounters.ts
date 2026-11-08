/**
 * The encounter table at the player's position (bridge 0.8.0 `encounters`): the game's current
 * MonsterSet, which on the world map changes with the grid area and the terrain underfoot.
 * 10-27 live: grass by Karnak was set 3 (Aegir ×3, Zu, Aegir+Zu+Aegir, Grass Tortoise ×2), the
 * desert a few steps east set 21 (five wolves), and the random battle there was a lone Zu.
 */

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
    .map((monster) => ({ name: text(monster.name) ?? "", book: num(monster.book) ?? null }))
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
  return {
    scope,
    grids: list(value.grids).filter((grid): grid is number => typeof grid === "number"),
    parties: list(value.parties)
      .map(parseParty)
      .filter((party): party is EncounterParty => party !== null && party.monsters.length > 0),
    error: text(value.error) ?? null,
  };
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

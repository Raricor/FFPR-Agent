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

export interface EncounterTable {
  readonly monsterSet: number | null;
  readonly parties: readonly EncounterParty[];
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

/** Narrow the reply; null off a map (the bridge answers null) or for a malformed one. */
export function parseEncounters(reply: unknown): EncounterTable | null {
  const body = isRecord(reply) && "encounters" in reply ? reply.encounters : reply;
  if (!isRecord(body)) return null;
  return {
    monsterSet: num(body.monsterSet) ?? null,
    parties: list(body.parties)
      .map(parseParty)
      .filter((party): party is EncounterParty => party !== null && party.monsters.length > 0),
  };
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

/**
 * Battle tactics per map (control plan §4.10), ported from ffpr_agent/ds/tactics.py: the rule
 * tables the player wrote for a map's monsters, a main one and spares, which one is in use,
 * and how the battles went. Regular battles on that map use the table in use; a battle that
 * went badly moves to the next one.
 *
 *     const tactics = await Tactics.load(path);
 *     await tactics.set(64, [tableA, tableB]); // from the player's set_tactics
 *     tactics.current(64);                      // tableA
 *     await tactics.record(64, "hard", "巴兹倒下"); // → tableB from the next battle on
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "./errors.ts";
import { isRecord, list, type Json } from "./values.ts";

const BAD = new Set(["lost", "hard"]); // a wipe, or someone down / the party under 40% HP

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return list(value).filter((item): item is string => typeof item === "string" && item !== "");
}

export interface TacticsEntry {
  tables: Json[];
  current: number;
  results: Json[];
  /** Monsters seen on the map when the tables were written (task 10). */
  monsters?: string[];
}

/** Map ids are strings at the file boundary; a Map keeps Python's insertion order. */
export class Tactics {
  readonly path: string | undefined;
  readonly maps = new Map<string, TacticsEntry>();

  constructor(path?: string) {
    this.path = path;
  }

  static async load(path?: string, signal?: AbortSignal): Promise<Tactics> {
    const tactics = new Tactics(path);
    if (path === undefined) return tactics;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return tactics;
      signal?.throwIfAborted();
      throw new Error(`读不了战术记录 ${path}:${describeError(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂战术记录 ${path}:${describeError(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`战术记录 ${path} 不是 JSON 对象`);
    for (const [mapId, raw] of Object.entries(parsed)) {
      if (!isRecord(raw) || !Array.isArray(raw.tables)) {
        throw new Error(`战术记录 ${path} 里的地图 ${mapId} 没有 tables`);
      }
      const tables = raw.tables.filter(isRecord);
      const current = typeof raw.current === "number" ? raw.current : 0;
      const results = Array.isArray(raw.results) ? raw.results.filter(isRecord) : [];
      const monsters = stringList(raw.monsters);
      tactics.maps.set(mapId, { tables, current, results, ...(monsters ? { monsters } : {}) });
    }
    return tactics;
  }

  async set(mapId: unknown, tables: readonly Json[], monsters?: readonly string[]): Promise<void> {
    const entry: TacticsEntry = { tables: [...tables], current: 0, results: [] };
    if (monsters !== undefined) entry.monsters = [...monsters];
    this.maps.set(String(mapId), entry);
    await this.save();
  }

  has(mapId: unknown): boolean {
    return Boolean(this.maps.get(String(mapId))?.tables.length);
  }

  /** The monsters seen when the tables were written; [] for a table with no record. */
  monstersSeen(mapId: unknown): string[] {
    return [...(this.maps.get(String(mapId))?.monsters ?? [])];
  }

  /** The map's battle results, oldest first (at most 30 are kept). */
  resultsFor(mapId: unknown): readonly Json[] {
    return this.maps.get(String(mapId))?.results ?? [];
  }

  current(mapId: unknown): Json | null {
    const entry = this.maps.get(String(mapId));
    const tables = entry?.tables ?? [];
    if (tables.length === 0) return null;
    return tables[(entry?.current ?? 0) % tables.length] ?? null;
  }

  /**
   * Note how a battle went; a bad one switches to the next table. Returns what to tell the
   * player ("" when the map has no tactics).
   */
  async record(mapId: unknown, verdict: string, detail: string): Promise<string> {
    const entry = this.maps.get(String(mapId));
    if (!entry || entry.tables.length === 0) return "";
    const index = entry.current;
    entry.results.push({ table: index, verdict, detail });
    entry.results = entry.results.slice(-30);
    let message = "";
    if (BAD.has(verdict)) {
      const count = entry.tables.length;
      entry.current = (index + 1) % count;
      const tried = new Set(
        entry.results
          .filter((result) => BAD.has(String(result.verdict)))
          .map((result) => result.table),
      );
      message = `策略 ${index + 1} 打得不好(${detail}),下一场换策略 ${entry.current + 1}`;
      if (tried.size >= count) {
        message += ";这张地图的每套策略都失败过,考虑练级、换职业或换装备,或者重写策略";
      }
    }
    await this.save();
    return message;
  }

  describe(mapId: unknown): string {
    const entry = this.maps.get(String(mapId));
    const tables = entry?.tables ?? [];
    if (tables.length === 0) return "这张地图还没有战斗策略";
    const bad = entry?.results.filter((result) => BAD.has(String(result.verdict))) ?? [];
    return (
      `这张地图有 ${tables.length} 套策略,正在用第 ${(entry?.current ?? 0) + 1} 套;` +
      `打得不好的记录 ${bad.length} 次`
    );
  }

  async save(): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    const data: Record<string, TacticsEntry> = {};
    for (const [mapId, entry] of this.maps) data[mapId] = entry;
    try {
      await writeFile(this.path, JSON.stringify(data, null, 1), "utf8");
    } catch (error) {
      throw new Error(`写不了战术记录 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }
}

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
import type { PartySnapshotMember } from "./dossier.ts";

const BAD = new Set(["lost", "hard"]); // a wipe, or someone down / the party under 40% HP

function bossRecord(value: unknown): BossRecord | null {
  if (!isRecord(value) || !isRecord(value.table) || typeof value.result !== "string") return null;
  if (typeof value.at !== "string") return null;
  const rewrites = Array.isArray(value.rewrites)
    ? value.rewrites.flatMap((item) => {
        if (
          !isRecord(item) ||
          typeof item.reason !== "string" ||
          typeof item.summary !== "string"
        ) {
          return [];
        }
        return [{ reason: item.reason, ok: item.ok === true, summary: item.summary }];
      })
    : undefined;
  return {
    table: value.table,
    result: value.result,
    at: value.at,
    ...(typeof value.walkerNotes === "string" ? { walkerNotes: value.walkerNotes } : {}),
    ...(typeof value.askUp === "string" ? { askUp: value.askUp } : {}),
    ...(rewrites === undefined ? {} : { rewrites }),
    ...(value.prepared === true ? { prepared: true } : {}),
  };
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return list(value).filter((item): item is string => typeof item === "string" && item !== "");
}

export interface BossRecord {
  readonly table: Json;
  readonly result: string;
  readonly at: string;
  /** The tactician's words from the boss call, so they survive with the table (task 40). */
  readonly walkerNotes?: string;
  readonly askUp?: string;
  /** Mid-battle rewrites, oldest first (task 34); absent on older records. */
  readonly rewrites?: readonly {
    readonly reason: string;
    readonly ok: boolean;
    readonly summary: string;
  }[];
  /** True for a boss table written before the fight (task 42 boss-prep), not a result. */
  readonly prepared?: boolean;
}

/**
 * The tactician's output belongs beside the tables (task 40): the walker notes and advice
 * used to live only in Game's memory and vanished on a web restart. The boss table is stored
 * per map too, so reopening the sidebar can show it without replaying the battle.
 */
export interface TacticsEntry {
  tables: Json[];
  current: number;
  results: Json[];
  /** Monsters seen on the map when the tables were written (task 10). */
  monsters?: string[];
  walkerNotes?: string;
  askUp?: string;
  writtenAt?: string;
  /** The jobs and commands the table was written with (task 42 party-changed). */
  party?: PartySnapshotMember[];
  boss?: BossRecord;
  /**
   * Task 110: "player" when the table came from the player's own set_tactics, not the
   * tactician. The mark lasts until the party leaves the map (Game retires it on a map change).
   */
  source?: "player";
  /** Task 110: when and for which map the player wrote the table. */
  sourceAt?: string;
  sourceMap?: number;
}

/** What the tactician said about a map; separate from the tables so a boss-only call fits. */
export interface TacticianNote {
  readonly walkerNotes: string;
  readonly askUp: string;
  readonly writtenAt: string;
}

function partySnapshotFrom(value: unknown): PartySnapshotMember[] | null {
  if (!Array.isArray(value)) return null;
  const out: PartySnapshotMember[] = [];
  for (const row of value) {
    if (!isRecord(row)) continue;
    const name = typeof row.name === "string" ? row.name : "";
    const job = typeof row.job === "string" ? row.job : "";
    const commands = stringList(row.commands) ?? [];
    if (name === "") continue;
    out.push({ name, job, commands });
  }
  return out.length > 0 ? out : null;
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
      const entry: TacticsEntry = {
        tables,
        current,
        results,
        ...(monsters ? { monsters } : {}),
      };
      if (typeof raw.walkerNotes === "string") entry.walkerNotes = raw.walkerNotes;
      if (typeof raw.askUp === "string") entry.askUp = raw.askUp;
      if (typeof raw.writtenAt === "string") entry.writtenAt = raw.writtenAt;
      const party = partySnapshotFrom(raw.party);
      if (party !== null) entry.party = party;
      const boss = bossRecord(raw.boss);
      if (boss !== null) entry.boss = boss;
      if (raw.source === "player") {
        entry.source = "player";
        if (typeof raw.sourceAt === "string") entry.sourceAt = raw.sourceAt;
        if (typeof raw.sourceMap === "number") entry.sourceMap = raw.sourceMap;
      }
      tactics.maps.set(mapId, entry);
    }
    return tactics;
  }

  async set(
    mapId: unknown,
    tables: readonly Json[],
    monsters?: readonly string[],
    note?: TacticianNote,
    party?: readonly PartySnapshotMember[],
  ): Promise<void> {
    const previous = this.maps.get(String(mapId));
    const entry: TacticsEntry = { tables: [...tables], current: 0, results: [] };
    if (monsters !== undefined) entry.monsters = [...monsters];
    if (party !== undefined) entry.party = [...party];
    else if (previous?.party !== undefined) entry.party = previous.party;
    if (note !== undefined) {
      entry.walkerNotes = note.walkerNotes;
      entry.askUp = note.askUp;
      entry.writtenAt = note.writtenAt;
    } else if (previous !== undefined) {
      if (previous.walkerNotes !== undefined) entry.walkerNotes = previous.walkerNotes;
      if (previous.askUp !== undefined) entry.askUp = previous.askUp;
      if (previous.writtenAt !== undefined) entry.writtenAt = previous.writtenAt;
    }
    if (previous?.boss !== undefined) entry.boss = previous.boss;
    this.maps.set(String(mapId), entry);
    await this.save();
  }

  /**
   * Task 110: a table the player wrote by hand. It carries the source mark and is not replaced
   * by the tactician while the party stays on that map. `set` (the tactician's path) rebuilds
   * the entry and so clears the mark when a tactician table finally takes over.
   */
  async setPlayer(
    mapId: unknown,
    tables: readonly Json[],
    monsters?: readonly string[],
    party?: readonly PartySnapshotMember[],
  ): Promise<void> {
    await this.set(mapId, tables, monsters, undefined, party);
    const entry = this.maps.get(String(mapId));
    if (entry === undefined) return;
    entry.source = "player";
    entry.sourceAt = new Date().toISOString();
    entry.sourceMap = Number(mapId);
    await this.save();
  }

  /** Task 110: true while the map's tables came from the player's own set_tactics. */
  isPlayerTable(mapId: unknown): boolean {
    return this.maps.get(String(mapId))?.source === "player";
  }

  /**
   * Task 110: leaving a map retires the hand-written mark there, so the next tactician call
   * on that map (after coming back) may install its table again. The table itself stays.
   */
  async retirePlayerSource(mapId: unknown): Promise<boolean> {
    const entry = this.maps.get(String(mapId));
    if (entry?.source !== "player") return false;
    delete entry.source;
    delete entry.sourceAt;
    delete entry.sourceMap;
    await this.save();
    return true;
  }

  /** Keep the tactician's words even for a boss-only call with no new regular table. */
  async setNote(mapId: unknown, note: TacticianNote): Promise<void> {
    const existing = this.maps.get(String(mapId));
    const entry: TacticsEntry = existing ?? { tables: [], current: 0, results: [] };
    entry.walkerNotes = note.walkerNotes;
    entry.askUp = note.askUp;
    entry.writtenAt = note.writtenAt;
    this.maps.set(String(mapId), entry);
    await this.save();
  }

  /** The note for one map, or null when no tactician has written about it. */
  note(mapId: unknown): TacticianNote | null {
    const entry = this.maps.get(String(mapId));
    if (entry?.walkerNotes !== undefined) {
      return {
        walkerNotes: entry.walkerNotes,
        askUp: entry.askUp ?? "",
        writtenAt: entry.writtenAt ?? "",
      };
    }
    const boss = entry?.boss;
    if (boss?.walkerNotes !== undefined) {
      return {
        walkerNotes: boss.walkerNotes,
        askUp: boss.askUp ?? "",
        writtenAt: boss.at,
      };
    }
    return null;
  }

  /** The party snapshot stored with the map's tables, if any (task 42). */
  party(mapId: unknown): readonly PartySnapshotMember[] | null {
    const party = this.maps.get(String(mapId))?.party;
    return party ?? null;
  }

  /** The boss table written for a map, if any. */
  boss(mapId: unknown): BossRecord | null {
    return this.maps.get(String(mapId))?.boss ?? null;
  }

  /** The newest boss table across maps, for the old `lastBossPlan()` view. */
  lastBoss(): (BossRecord & { readonly mapId: number }) | null {
    let newest: (BossRecord & { readonly mapId: number }) | null = null;
    for (const [key, entry] of this.maps) {
      const boss = entry.boss;
      if (boss === undefined) continue;
      if (newest === null || Date.parse(boss.at) > Date.parse(newest.at)) {
        newest = { ...boss, mapId: Number(key) };
      }
    }
    return newest;
  }

  async setBoss(mapId: unknown, boss: BossRecord): Promise<void> {
    const existing = this.maps.get(String(mapId));
    const entry: TacticsEntry = existing ?? { tables: [], current: 0, results: [] };
    entry.boss = boss;
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

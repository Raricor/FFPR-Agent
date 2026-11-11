/**
 * The save-local bestiary (task 45). The game stores its picture book outside the save files
 * (bridge README: PictureBookSaveManager), so the account-wide list says nothing about which
 * monsters this save has met. We keep our own set:
 *
 * - a kill is a won battle's enemies (`ok` / `hard`) and a `battle.hit` whose target's HP is 0;
 * - on every successful save, the set is snapshotted under the game's save count (pos.saves);
 * - after loading a save, the set starts from the snapshot with that save count and adds the
 *   battles fought after it.
 *
 * The file is .deps/ds/bestiary-save-<game>.json. An unset path keeps everything in memory so
 * unit tests never touch the real .deps tree.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BattleRecord } from "./battle-record.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { isRecord, list, num, record, text, type Json } from "./values.ts";

export interface BestiarySnapshot {
  /** When the save completed; only battles started after this are added back. */
  readonly at: string;
  readonly numbers: readonly number[];
}

interface SaveFile {
  readonly game: string;
  readonly snapshots: Record<string, BestiarySnapshot>;
}

export interface BestiaryBackfill {
  readonly records: number;
  readonly numbers: number;
}

function win(result: string | null | undefined): boolean {
  return result === "ok" || result === "hard";
}

/**
 * The bestiary numbers a completed battle record proves were fought (won only). Old records
 * before bridge 0.13.6 lack `book`; `names` maps a monster name to its bestiary number so the
 * one-time backfill can still count them.
 */
export function recordKills(
  battle: BattleRecord,
  names: ReadonlyMap<string, number> = new Map(),
): number[] {
  if (!win(battle.result)) return [];
  const numbers: number[] = [];
  for (const enemy of battle.enemies) {
    const book = enemy.book ?? names.get(enemy.name) ?? null;
    if (book !== null && book > 0) numbers.push(book);
  }
  return numbers;
}

/**
 * One `battle.hit` raw record: an enemy target whose HP is now 0 was killed by this action.
 * The bridge puts the target's post-effect HP and bestiary number on the unit.
 */
export function hitKill(raw: Json): number | null {
  if (raw.type !== "battle.hit") return null;
  const target = record(raw.target);
  if (target.side !== "enemy") return null;
  const hp = num(target.hp) ?? null;
  const book = num(target.book) ?? null;
  return hp === 0 && book !== null && book > 0 ? book : null;
}

export class BestiarySave {
  readonly game: string;
  readonly path: string | undefined;
  readonly snapshots = new Map<number, BestiarySnapshot>();
  readonly numbers = new Set<number>();
  /** The save count the in-memory set is based on, or null before the first sync. */
  saves: number | null = null;
  /** Set once when no snapshot existed and old battle records were used to seed the set. */
  backfill: BestiaryBackfill | null = null;

  private constructor(game: string, path: string | undefined) {
    this.game = game;
    this.path = path;
  }

  static async load(game: string, path?: string, signal?: AbortSignal): Promise<BestiarySave> {
    const store = new BestiarySave(game, path);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了本档图鉴 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂本档图鉴 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) throw new Error(`本档图鉴 ${path} 不是 JSON 对象`);
    const snapshots = isRecord(parsed.snapshots) ? parsed.snapshots : {};
    for (const [key, value] of Object.entries(snapshots)) {
      if (!isRecord(value)) continue;
      const saves = Number(key);
      if (!Number.isFinite(saves)) continue;
      store.snapshots.set(saves, {
        at: text(value.at) ?? "",
        numbers: list(value.numbers)
          .map((item) => num(item) ?? null)
          .filter((item): item is number => item !== null && item > 0),
      });
    }
    return store;
  }

  /**
   * Re-read the snapshots after a scout restored the file (task 105). The live number set is
   * cleared and its save count forgotten, so the caller's `restore()` rebuilds it from the
   * restored snapshots and the battle records outside the scout window.
   */
  async reload(signal?: AbortSignal): Promise<void> {
    const fresh = await BestiarySave.load(this.game, this.path, signal);
    this.snapshots.clear();
    for (const [saves, snapshot] of fresh.snapshots) this.snapshots.set(saves, snapshot);
    this.numbers.clear();
    this.saves = null;
    this.backfill = null;
  }

  /** The snapshot whose save count is exactly this one, if any. */
  snapshotFor(saves: number | null): BestiarySnapshot | null {
    if (saves === null) return null;
    return this.snapshots.get(saves) ?? null;
  }

  /**
   * Rebuild the set for the loaded save: its exact snapshot plus every won battle started after
   * the snapshot. Without a snapshot, start empty and (once) seed from all records on disk.
   */
  restore(
    saves: number | null,
    records: readonly BattleRecord[],
    names: ReadonlyMap<string, number> = new Map(),
  ): void {
    if (saves === this.saves) return;
    const snapshot = this.snapshotFor(saves);
    this.numbers.clear();
    for (const number of snapshot?.numbers ?? []) this.numbers.add(number);
    const after =
      snapshot === null ? records : records.filter((item) => item.startedAt > snapshot.at);
    const backfill = snapshot === null && saves !== null && records.length > 0;
    let added = 0;
    for (const battle of after) {
      for (const number of recordKills(battle, names)) {
        if (!this.numbers.has(number)) added += 1;
        this.numbers.add(number);
      }
    }
    if (backfill) this.backfill = { records: after.length, numbers: added };
    this.saves = saves;
  }

  /** Fold a live battle.hit (HP 0) into the set before the battle record exists. */
  observeHit(raw: Json): void {
    const number = hitKill(raw);
    if (number !== null) this.numbers.add(number);
  }

  /** Fold recent completed records after a battle; idempotent because it is a set. */
  observeRecords(
    records: readonly BattleRecord[],
    names: ReadonlyMap<string, number> = new Map(),
  ): void {
    for (const battle of records) {
      for (const number of recordKills(battle, names)) this.numbers.add(number);
    }
  }

  has(number: number | null): boolean {
    return number !== null && this.numbers.has(number);
  }

  /** Snapshot at a successful save's count; also writes the file. */
  async snapshot(saves: number, at = new Date().toISOString()): Promise<void> {
    const snapshot = {
      at,
      numbers: [...this.numbers].sort((left, right) => left - right),
    };
    this.snapshots.set(saves, snapshot);
    this.saves = saves;
    this.backfill = null;
    await this.save();
  }

  async save(): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    const snapshots: Record<string, BestiarySnapshot> = {};
    for (const [saves, snapshot] of [...this.snapshots].sort((left, right) => left[0] - right[0])) {
      snapshots[String(saves)] = snapshot;
    }
    const data: SaveFile = { game: this.game, snapshots };
    try {
      await writeFile(this.path, JSON.stringify(data, null, 1) + "\n", "utf8");
    } catch (error) {
      throw new Error(`写不了本档图鉴 ${this.path}:${describeError(error)}`, {
        cause: error,
      });
    }
  }
}

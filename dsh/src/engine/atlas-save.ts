/**
 * The save-local visited maps (task 57). The atlas keeps the game's own structure (exits,
 * links, chests) across runs, but "visited" means this save: a map recorded in an earlier run
 * is not explored again just because the file remembers it.
 *
 * The file is .deps/ds/atlas-save-<game>.json. An unset path keeps everything in memory so
 * unit tests never touch the real .deps tree. Besides per-save-count `snapshots`, it carries a
 * `live` set: the maps visited now and the save count that set is based on. `Atlas.visit`
 * writes `live` whenever a map is entered for the first time in this save.
 *
 * restore(saves) rules (11-05 review found why clearing on a missing snapshot is wrong):
 * - null: change nothing;
 * - same count as the one being tracked: change nothing;
 * - process just started and live.saves is this count: use live (a web restart keeps the maps
 *   entered after the last save);
 * - a snapshot for this count: use the snapshot (an older save was loaded);
 * - this count is larger than the tracked one and has no snapshot yet (just saved, before
 *   captureBestiary wrote it): keep live and only move the tracked count; the bestiary can
 *   rebuild from battle records, map visits cannot;
 * - anything else (a smaller count with no snapshot: a new game, or a pre-task-57 save):
 *   start empty.
 *
 * The three cases from the 11-05 review: a refresh between a save and captureBestiary used to
 * clear the set; a web restart used to lose maps entered after the last save; an existing
 * count with no snapshot used to clear on the first restore (an operator seeds that one).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Atlas } from "./atlas.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { isRecord, list, num, text } from "./values.ts";

export interface AtlasSnapshot {
  /** When the save completed; kept for the file's shape and for people reading it. */
  readonly at: string;
  readonly maps: readonly number[];
}

export interface AtlasLive {
  /** The save count this live set is based on, or null before a count was known. */
  readonly saves: number | null;
  readonly maps: readonly number[];
}

interface SaveFile {
  readonly game: string;
  readonly live: AtlasLive;
  readonly snapshots: Record<string, AtlasSnapshot>;
}

export class AtlasSave {
  readonly game: string;
  readonly path: string | undefined;
  readonly atlas: Atlas;
  readonly snapshots = new Map<number, AtlasSnapshot>();
  /** The save count the live visited set is based on, or null before the first sync. */
  saves: number | null = null;
  /** The set written on every new visit, for a restart before the next save. */
  live: AtlasLive = { saves: null, maps: [] };

  private constructor(game: string, path: string | undefined, atlas: Atlas) {
    this.game = game;
    this.path = path;
    this.atlas = atlas;
    // A new map in this save rewrites the live set; an already-visited map does not.
    this.atlas.onNewVisit = async () => {
      await this.recordVisit();
    };
  }

  static async load(
    game: string,
    path: string | undefined,
    atlas: Atlas,
    signal?: AbortSignal,
  ): Promise<AtlasSave> {
    const store = new AtlasSave(game, path, atlas);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了本档地图记录 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂本档地图记录 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) throw new Error(`本档地图记录 ${path} 不是 JSON 对象`);
    const live = isRecord(parsed.live) ? parsed.live : {};
    const liveSaves = num(live.saves);
    store.live = {
      saves: liveSaves === undefined ? null : Math.trunc(liveSaves),
      maps: mapNumbers(live.maps),
    };
    const snapshots = isRecord(parsed.snapshots) ? parsed.snapshots : {};
    for (const [key, value] of Object.entries(snapshots)) {
      if (!isRecord(value)) continue;
      const saves = Number(key);
      if (!Number.isFinite(saves)) continue;
      store.snapshots.set(saves, {
        at: text(value.at) ?? "",
        maps: mapNumbers(value.maps),
      });
    }
    return store;
  }

  /** The snapshot whose save count is exactly this one, if any. */
  snapshotFor(saves: number | null): AtlasSnapshot | null {
    if (saves === null) return null;
    return this.snapshots.get(saves) ?? null;
  }

  /** Rebuild the live visited set for the loaded save; see the rules in the file comment. */
  restore(saves: number | null): void {
    if (saves === null) return;
    if (saves === this.saves) return;
    const snapshot = this.snapshotFor(saves);
    if (this.saves === null && this.live.saves === saves) {
      this.apply(this.live.maps);
      this.saves = saves;
      return;
    }
    if (snapshot !== null) {
      this.apply(snapshot.maps);
      this.saves = saves;
      return;
    }
    if (this.saves !== null && saves > this.saves) {
      // Just saved: keep live until captureBestiary writes this count's snapshot.
      this.saves = saves;
      return;
    }
    this.apply([]);
    this.saves = saves;
  }

  /**
   * Re-read the file after a scout restored it (task 105). The atlas itself is map structure and
   * is deliberately left alone; only this save's visited set and snapshots are replaced.
   */
  async reload(signal?: AbortSignal): Promise<void> {
    const fresh = await AtlasSave.load(this.game, this.path, this.atlas, signal);
    this.snapshots.clear();
    for (const [saves, snapshot] of fresh.snapshots) this.snapshots.set(saves, snapshot);
    this.saves = fresh.saves;
    this.live = fresh.live;
    this.atlas.onNewVisit = async () => {
      await this.recordVisit();
    };
  }

  /** Snapshot the live visited set at a successful save's count; also writes the file. */
  async snapshot(saves: number, at = new Date().toISOString()): Promise<void> {
    const maps = this.mapsNow();
    this.snapshots.set(saves, { at, maps });
    this.saves = saves;
    this.live = { saves, maps };
    await this.save();
  }

  async save(): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    const snapshots: Record<string, AtlasSnapshot> = {};
    for (const [saves, snapshot] of [...this.snapshots].sort((left, right) => left[0] - right[0])) {
      snapshots[String(saves)] = snapshot;
    }
    const data: SaveFile = { game: this.game, live: this.live, snapshots };
    try {
      await writeFile(this.path, JSON.stringify(data, null, 1) + "\n", "utf8");
    } catch (error) {
      throw new Error(`写不了本档地图记录 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }

  private async recordVisit(): Promise<void> {
    this.live = { saves: this.saves, maps: this.mapsNow() };
    await this.save();
  }

  private mapsNow(): number[] {
    return [...this.atlas.visitedNow]
      .map((key) => Number(key))
      .filter((mapId) => Number.isFinite(mapId) && mapId > 0)
      .sort((left, right) => left - right);
  }

  private apply(maps: readonly number[]): void {
    this.atlas.visitedNow.clear();
    for (const mapId of maps) this.atlas.visitedNow.add(String(mapId));
  }
}

function mapNumbers(value: unknown): number[] {
  return list(value)
    .map((item) => num(item) ?? null)
    .filter((item): item is number => item !== null && item > 0)
    .map((item) => Math.trunc(item));
}

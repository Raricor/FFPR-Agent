/**
 * Scout snapshots (task 102): before entering a one-time place, copy this save's progress
 * files aside, scout the place for its map structure, then put the save's progress back.
 *
 * The game's map structure (`atlas-<game>.json`, `collision-<game>/`) is deliberately not in
 * the default list: scouting is supposed to keep what it learned there. The save-local files
 * (visited maps, bestiary, debts, incidents, notes, stage plan, route progress, drake) are
 * copied to `<dir>/scout/<time>/` and restored byte for byte. A file that did not exist before
 * the scout is removed on restore, so a progress file created by the scout cannot leak into
 * the loaded save.
 *
 * The 11-10 request: save in slot 20 before the dungeon, walk every exit/landing/mechanism,
 * load slot 20 again, and from then on the dungeon is "visited" and can be routed in one go.
 * The logs are append-only, so `scout-windows-<game>.json` records each scout's start and end
 * for readers that must exclude records written during it.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chmod, copyFile, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { describeError, isMissingFile } from "../errors.ts";
import { DEPS } from "../paths.ts";
import { isRecord, num, text } from "../values.ts";

/** The one game this task's default file list is for. */
export const SCOUT_GAME = "ff5";

/** `.deps/ds`, where the save-local files and the scout directory live. */
export const DS_DIR = join(DEPS, "ds");

/**
 * The save-local progress files, in the order the 11-10 note lists them. `atlas-<game>.json`
 * and `collision-<game>/` are intentionally absent: they are map structure and must survive.
 */
export const PROGRESS_FILE_NAMES: readonly string[] = [
  "atlas-save-{game}.json",
  "bestiary-save-{game}.json",
  "backlog-{game}.jsonl",
  "incidents-{game}.jsonl",
  "incidents-state-{game}.json",
  "notes-{game}.json",
  "stage-{game}.json",
  "route-{game}.json",
  "drake.json",
];

/** Resolve the default progress file list for one game under `dir`. */
export function defaultProgressFiles(game = SCOUT_GAME, dir = DS_DIR): string[] {
  return PROGRESS_FILE_NAMES.map((name) => join(dir, name.replaceAll("{game}", game)));
}

/** When a snapshot was taken and what each tracked file looked like at that moment. */
export interface SnapshotFile {
  /** Path relative to `sourceDir` when inside it, otherwise absolute. */
  readonly path: string;
  /** Name of the copy under `<snapshot>/files/`, or null when the file did not exist. */
  readonly backup: string | null;
  readonly exists: boolean;
  readonly size: number | null;
  /** ISO time, or null when the file did not exist. */
  readonly mtime: string | null;
  /** POSIX mode, kept so a restore puts executable bits back too. */
  readonly mode: number | null;
}

export interface SnapshotManifest {
  readonly version: 1;
  readonly at: string;
  readonly sourceDir: string;
  readonly files: readonly SnapshotFile[];
}

export interface Snapshot {
  readonly dir: string;
  readonly at: string;
  readonly sourceDir: string;
  readonly files: readonly SnapshotFile[];
}

export interface RestoreReport {
  readonly restored: readonly string[];
  readonly removed: readonly string[];
}

/** One safe directory name for a snapshot time; `:` and `.` are not portable. */
function stampOf(at: Date): string {
  return at.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function uniqueSnapshotDir(dir: string, at: Date): Promise<string> {
  const root = join(dir, "scout");
  const stamp = stampOf(at);
  for (let suffix = 0; ; suffix += 1) {
    const candidate = join(root, suffix === 0 ? stamp : `${stamp}-${suffix}`);
    try {
      await stat(candidate);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return candidate;
    }
  }
}

function manifestPath(sourceDir: string, file: string): string {
  const absolute = resolve(file);
  const rel = relative(resolve(sourceDir), absolute);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return absolute;
}

function targetOf(sourceDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(sourceDir, path);
}

function entryError(snapshotDir: string, message: string): Error {
  return new Error(`快照 ${snapshotDir} 的清单有问题:${message}`);
}

function parseManifest(value: unknown, snapshotDir: string): SnapshotManifest {
  if (!isRecord(value)) throw entryError(snapshotDir, "不是 JSON 对象");
  const version = num(value.version);
  const at = text(value.at);
  const sourceDir = text(value.sourceDir);
  if (version !== 1) throw entryError(snapshotDir, "version 不是 1");
  if (at === undefined) throw entryError(snapshotDir, "缺少时间");
  if (sourceDir === undefined) throw entryError(snapshotDir, "缺少来源目录");
  const files: SnapshotFile[] = [];
  for (const raw of Array.isArray(value.files) ? value.files : []) {
    if (!isRecord(raw)) continue;
    const path = text(raw.path);
    if (path === undefined) throw entryError(snapshotDir, "有一个文件条目没有 path");
    const backup = text(raw.backup);
    const exists = raw.exists === true;
    const size = num(raw.size);
    const mtime = text(raw.mtime);
    const mode = num(raw.mode);
    files.push({
      path,
      backup: backup ?? null,
      exists,
      size: size === undefined ? null : Math.trunc(size),
      mtime: mtime ?? null,
      mode: mode === undefined ? null : Math.trunc(mode),
    });
  }
  return { version: 1, at, sourceDir, files };
}

/**
 * Copy every tracked progress file under `dir` to `dir/scout/<time>/`, including entries for
 * files that are absent (that is how restore knows to delete one created during the scout).
 * `files` defaults to `defaultProgressFiles()` resolved against `dir`.
 */
export async function takeSnapshot(
  dir: string = DS_DIR,
  files: readonly string[] = defaultProgressFiles(SCOUT_GAME, dir),
  at = new Date(),
): Promise<Snapshot> {
  const sourceDir = resolve(dir);
  const snapshotDir = await uniqueSnapshotDir(sourceDir, at);
  const backupDir = join(snapshotDir, "files");
  await mkdir(backupDir, { recursive: true });

  const entries: SnapshotFile[] = [];
  for (const [index, file] of files.entries()) {
    const target = targetOf(sourceDir, file);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error(`读不了要快照的进度文件 ${target}:${describeError(error)}`, {
          cause: error,
        });
      }
      entries.push({
        path: manifestPath(sourceDir, target),
        backup: null,
        exists: false,
        size: null,
        mtime: null,
        mode: null,
      });
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`要快照的进度文件不是普通文件:${target}`);
    }
    const backup = join("files", `${index}-${basename(target)}`);
    await copyFile(target, join(snapshotDir, backup));
    entries.push({
      path: manifestPath(sourceDir, target),
      backup,
      exists: true,
      size: info.size,
      mtime: info.mtime.toISOString(),
      mode: info.mode,
    });
  }

  const manifest: SnapshotManifest = {
    version: 1,
    at: at.toISOString(),
    sourceDir,
    files: entries,
  };
  await writeFile(join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n", {
    encoding: "utf8",
  });
  return { dir: snapshotDir, at: manifest.at, sourceDir, files: entries };
}

/**
 * Put the files in a snapshot back exactly as they were, and delete the tracked files that did
 * not exist when it was taken. Map-structure files are not in the manifest and are untouched.
 */
export async function restoreSnapshot(snapshotDir: string): Promise<RestoreReport> {
  const root = resolve(snapshotDir);
  let body: string;
  try {
    body = await readFile(join(root, "manifest.json"), { encoding: "utf8" });
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`快照目录里没有清单:${root}`, { cause: error });
    }
    throw new Error(`读不了快照清单 ${join(root, "manifest.json")}:${describeError(error)}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`读不懂快照清单 ${join(root, "manifest.json")}:${describeError(error)}`, {
      cause: error,
    });
  }
  const manifest = parseManifest(parsed, root);
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of manifest.files) {
    const target = targetOf(manifest.sourceDir, entry.path);
    if (!entry.exists) {
      try {
        await rm(target, { force: true });
        removed.push(target);
      } catch (error) {
        throw new Error(`还原时删不掉侦察期间新建的文件 ${target}:${describeError(error)}`, {
          cause: error,
        });
      }
      continue;
    }
    if (entry.backup === null) {
      throw entryError(root, `文件 ${entry.path} 标记为存在却没有备份`);
    }
    const backup = join(root, entry.backup);
    let info;
    try {
      info = await stat(backup);
    } catch (error) {
      if (isMissingFile(error)) throw entryError(root, `备份文件不见了:${entry.backup}`);
      throw new Error(`读不了快照备份 ${backup}:${describeError(error)}`, {
        cause: error,
      });
    }
    if (!info.isFile()) throw entryError(root, `备份不是普通文件:${entry.backup}`);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(backup, target);
      if (entry.mode !== null) await chmod(target, entry.mode);
      if (entry.mtime !== null) {
        const time = new Date(entry.mtime);
        if (!Number.isNaN(time.valueOf())) await utimes(target, time, time);
      }
    } catch (error) {
      throw new Error(`还原不了 ${target}:${describeError(error)}`, {
        cause: error,
      });
    }
    restored.push(target);
  }
  return { restored, removed };
}

/** One scouting run's wall-clock interval; `end` absent while the scout is still running. */
export interface ScoutWindow {
  readonly start: string;
  readonly end?: string;
}

export type ScoutTimestamp = string | number | Date;

function isoTime(value: ScoutTimestamp): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) throw new Error("侦察时间不是有效日期");
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("侦察时间不是有效毫秒数");
    return new Date(value).toISOString();
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`侦察时间不是有效日期:${value}`);
  return new Date(ms).toISOString();
}

function timeMs(value: ScoutTimestamp): number | null {
  let ms: number;
  if (value instanceof Date) ms = value.valueOf();
  else if (typeof value === "number") ms = value;
  else ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `.deps/ds/scout-windows-<game>.json`: a list of closed intervals (both ends count). */
export function scoutWindowsFile(game = SCOUT_GAME, dir = DS_DIR): string {
  return join(dir, `scout-windows-${game}.json`);
}

/**
 * The scout windows of one game. `begin`/`end` write the file after every change, so a reader
 * that filters records by time sees an open window even if the scout is interrupted.
 */
export class ScoutWindows {
  readonly game: string;
  readonly path: string;
  readonly windows: ScoutWindow[];

  private constructor(game: string, path: string, windows: ScoutWindow[]) {
    this.game = game;
    this.path = path;
    this.windows = windows;
  }

  static async load(game = SCOUT_GAME, path = scoutWindowsFile(game)): Promise<ScoutWindows> {
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8" });
    } catch (error) {
      if (isMissingFile(error)) return new ScoutWindows(game, path, []);
      throw new Error(`读不了侦察时间记录 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂侦察时间记录 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) throw new Error(`侦察时间记录 ${path} 不是 JSON 对象`);
    const windows: ScoutWindow[] = [];
    for (const raw of Array.isArray(parsed.windows) ? parsed.windows : []) {
      if (!isRecord(raw)) continue;
      const start = text(raw.start);
      if (start === undefined) continue;
      const end = text(raw.end);
      windows.push(end === undefined ? { start } : { start, end });
    }
    return new ScoutWindows(text(parsed.game) ?? game, path, windows);
  }

  /** Start a window unless one is already open (a repeated call is idempotent). */
  async begin(at: ScoutTimestamp = new Date()): Promise<ScoutWindow> {
    const running = this.open();
    if (running !== null) return running;
    const window = { start: isoTime(at) };
    this.windows.push(window);
    await this.save();
    return window;
  }

  /** Close the open window, or return null when there is none. */
  async end(at: ScoutTimestamp = new Date()): Promise<ScoutWindow | null> {
    const running = this.open();
    if (running === null) return null;
    const closed = { ...running, end: isoTime(at) };
    const index = this.windows.indexOf(running);
    if (index >= 0) this.windows[index] = closed;
    await this.save();
    return closed;
  }

  /** Whether `timestamp` falls inside any window; start and end are both inside. */
  inScoutWindow(timestamp: ScoutTimestamp): boolean {
    return inScoutWindow(this.windows, timestamp);
  }

  /** The currently open window, if a scout was begun and not ended. */
  open(): ScoutWindow | null {
    const last = this.windows.at(-1);
    return last !== undefined && last.end === undefined ? last : null;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const data = { game: this.game, windows: this.windows };
    try {
      await writeFile(this.path, JSON.stringify(data, null, 1) + "\n", "utf8");
    } catch (error) {
      throw new Error(`写不了侦察时间记录 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }
}

/** Load one game's scout windows; the file is `scout-windows-<game>.json` under `dir`. */
export async function scoutWindows(
  game = SCOUT_GAME,
  dir = DS_DIR,
  signal?: AbortSignal,
): Promise<ScoutWindows> {
  signal?.throwIfAborted();
  return await ScoutWindows.load(game, scoutWindowsFile(game, dir));
}

/** The inverse of `scoutWindows`: load, check one timestamp, then release the in-memory copy. */
export async function isScoutTime(
  timestamp: ScoutTimestamp,
  game = SCOUT_GAME,
  dir = DS_DIR,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await scoutWindows(game, dir, signal)).inScoutWindow(timestamp);
}

/**
 * Whether a log record written at `timestamp` belongs to a scout. Accepts either argument
 * order so callers can pass a loaded `ScoutWindows` or a plain interval list. A timestamp the
 * log cannot parse is not evidence of scouting, so it returns false instead of throwing.
 */
export function inScoutWindow(
  windows: ScoutWindows | readonly ScoutWindow[],
  timestamp: ScoutTimestamp,
): boolean;
export function inScoutWindow(
  timestamp: ScoutTimestamp,
  windows: ScoutWindows | readonly ScoutWindow[],
): boolean;
export function inScoutWindow(
  first: ScoutWindows | readonly ScoutWindow[] | ScoutTimestamp,
  second: ScoutWindows | readonly ScoutWindow[] | ScoutTimestamp,
): boolean {
  const firstWindows = windowListOf(first);
  const secondWindows = windowListOf(second);
  if (firstWindows !== null && secondWindows === null) {
    return inWindowList(firstWindows, firstTimestamp(second));
  }
  if (firstWindows === null && secondWindows !== null) {
    return inWindowList(secondWindows, firstTimestamp(first));
  }
  return false;
}

function windowListOf(value: unknown): readonly ScoutWindow[] | null {
  if (value instanceof ScoutWindows) return value.windows;
  if (!Array.isArray(value)) return null;
  const windows: ScoutWindow[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const start = text(raw.start);
    if (start === undefined) continue;
    const end = text(raw.end);
    windows.push(end === undefined ? { start } : { start, end });
  }
  return windows;
}

function firstTimestamp(value: unknown): ScoutTimestamp | null {
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) {
    return value;
  }
  return null;
}

function inWindowList(windows: readonly ScoutWindow[], timestamp: ScoutTimestamp | null): boolean {
  if (timestamp === null) return false;
  const at = timeMs(timestamp);
  if (at === null) return false;
  for (const window of windows) {
    const start = timeMs(window.start);
    if (start === null || at < start) continue;
    if (window.end === undefined) return true;
    const end = timeMs(window.end);
    if (end !== null && at <= end) return true;
  }
  return false;
}

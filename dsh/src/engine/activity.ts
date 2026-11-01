/**
 * The activity log behind the overview page (task 24): one line per game operation, important
 * event, error and bridge connection change. Each game keeps its newest 500 entries in memory
 * and appends them to `.deps/ds/activity-<game>.jsonl`, so a web reload keeps the history.
 *
 * The log is written asynchronously through one ordered queue: a failed write costs a single
 * warning and never delays or breaks a tool call.
 */

import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError, isMissingFile } from "./errors.ts";
import { DEPS } from "./paths.ts";

export const MAX_ENTRIES = 500;
export const MAX_TEXT = 200;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LOG_LIMIT = 200;

export const ACTIVITY_KINDS = ["tool", "error", "event", "link"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityEntry {
  readonly at: string;
  readonly game: string;
  readonly kind: ActivityKind;
  readonly text: string;
}

/** The tool call the engine is running now; the overview page shows it instead of `last`. */
export interface BusyTool {
  readonly name: string;
  readonly at: string;
}

/** The on-disk log for one game; one file per game so six players never share a writer. */
export function activityFile(game: string): string {
  return join(DEPS, "ds", `activity-${game}.jsonl`);
}

export interface ActivityOptions {
  readonly game: string;
  /** JSONL path; omitted keeps the log in memory (tests, a deployment without .deps). */
  readonly file?: string;
  /** Masks secrets before they reach the log; the plugin passes the redact.ts redactor. */
  readonly redact?: (text: string) => string;
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}

export interface ActivityQuery {
  /** ISO time; only entries strictly newer are returned. */
  readonly since?: string;
  /** One game key; omitted keeps every game. */
  readonly game?: string;
  /** Defaults to 200 and is clamped to 500. */
  readonly limit?: number;
}

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === "string" &&
    typeof entry.game === "string" &&
    typeof entry.text === "string" &&
    typeof entry.kind === "string" &&
    (ACTIVITY_KINDS as readonly string[]).includes(entry.kind)
  );
}

/** The first line only: tool results are often several lines and one log row is one line. */
function oneLine(text: string): string {
  return text.split(/\r\n|\r|\n/, 1)[0] ?? "";
}

/** At most 200 code points, ellipsis included, so a log row stays one short line. */
function shorten(text: string): string {
  const points = Array.from(text);
  if (points.length <= MAX_TEXT) return text;
  return points.slice(0, MAX_TEXT - 1).join("") + "…";
}

export class ActivityLog {
  readonly game: string;
  readonly file: string | undefined;
  readonly entries: ActivityEntry[] = [];
  busy: BusyTool | null = null;
  private readonly redact: (text: string) => string;
  private readonly now: () => Date;
  private readonly warn: ((message: string) => void) | undefined;
  private warned = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ActivityOptions) {
    this.game = options.game;
    this.file = options.file;
    this.redact = options.redact ?? ((text) => text);
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn;
  }

  /** Load the last 500 lines, rotating a log file over 5 MB to `.1` first (task 24). */
  static async load(options: ActivityOptions): Promise<ActivityLog> {
    const log = new ActivityLog(options);
    if (options.file !== undefined) await log.restore(options.file);
    return log;
  }

  private async restore(file: string): Promise<void> {
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) {
        // Keep one old file only: replace yesterday's `.1`, then move today's log there.
        await rm(`${file}.1`, { force: true });
        await rename(file, `${file}.1`);
        return;
      }
      const body = await readFile(file, { encoding: "utf8" });
      const restored: ActivityEntry[] = [];
      for (const line of body.split(/\r\n|\r|\n/)) {
        if (line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isActivityEntry(parsed)) restored.push(parsed);
        } catch {
          // A crash mid-write leaves at most one broken line; skip it like keylog.load.
        }
      }
      this.entries.push(...restored.slice(-MAX_ENTRIES));
    } catch (error) {
      if (!isMissingFile(error)) this.warnOnce(`读不了活动日志 ${file}:${describeError(error)}`);
    }
  }

  /** Append one line; empty text is skipped so the page never shows a blank row. */
  record(kind: ActivityKind, text: string): void {
    const line = shorten(this.redact(oneLine(text)));
    if (line === "") return;
    const entry: ActivityEntry = {
      at: this.now().toISOString(),
      game: this.game,
      kind,
      text: line,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.append(entry);
  }

  beginTool(name: string): void {
    this.busy = { name, at: this.now().toISOString() };
  }

  endTool(): void {
    this.busy = null;
  }

  get last(): ActivityEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /** Wait for queued appends; tests use it, the plugin never has to. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private append(entry: ActivityEntry): void {
    const file = this.file;
    if (file === undefined) return;
    const line = JSON.stringify(entry) + "\n";
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, line, { encoding: "utf8" });
      } catch (error) {
        this.warnOnce(`写不了活动日志 ${file}:${describeError(error)}`);
      }
    });
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn?.(message);
  }
}

/**
 * Merge the six logs newest first and apply the page's filters. Equal timestamps keep the
 * game order (ff1 … ff6) because Array.sort is stable.
 */
export function mergeActivity(
  logs: Iterable<ActivityLog>,
  query: ActivityQuery = {},
): ActivityEntry[] {
  const parsedSince = query.since === undefined ? Number.NaN : Date.parse(query.since);
  const since = Number.isNaN(parsedSince) ? null : parsedSince;
  const requested =
    query.limit === undefined || !Number.isFinite(query.limit) ? DEFAULT_LOG_LIMIT : query.limit;
  const limit = Math.max(0, Math.min(Math.trunc(requested), MAX_ENTRIES));
  const merged: ActivityEntry[] = [];
  for (const log of logs) {
    for (const entry of log.entries) {
      if (query.game !== undefined && entry.game !== query.game) continue;
      if (since !== null && Date.parse(entry.at) <= since) continue;
      merged.push(entry);
    }
  }
  merged.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return merged.slice(0, limit);
}

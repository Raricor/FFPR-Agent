/**
 * Structured execution log (task 158, 11-12): one JSON object per line in
 * `.deps/ds/run-<game>.jsonl`. The activity log (`activity-<game>.jsonl`) stays as it was for
 * the sidebar; this file is for analysis, so every line carries the same context fields
 * (`run`, `chapter`, `segment`, `section`, `station`, `type`) and the event's own payload.
 *
 * Appends go through one ordered queue and a failed write costs a single warning, never a run.
 * The report command (`scripts/chapter-report.mts`) reads the file back line by line.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError, isMissingFile } from "./errors.ts";
import { DEPS } from "./paths.ts";

export const RUN_EVENT_TYPES = [
  "run.start",
  "run.end",
  "segment.start",
  "segment.end",
  "station.start",
  "station.end",
  "fallback",
  "blocked",
  "battle",
  "chest",
  "level",
  "heal",
  "buy",
  "resume",
  "warn",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type RunStationResult = "done" | "failed" | "skipped" | "blocked";

/** One line of the structured run log. Context fields are always present, payload fields only
 *  when the event has them; undefined payload fields are omitted by JSON.stringify. */
export interface RunEventInput {
  readonly type: RunEventType;
  readonly chapter?: number | null;
  readonly segment?: number | null;
  readonly section?: string | null;
  readonly station?: number | null;
  /** run.end / segment.end / station.end status. */
  readonly status?: string;
  readonly ms?: number | null;
  /** run.end: number of fallbacks used; run.start: station count. */
  readonly fallbacks?: number;
  readonly modelCalls?: number;
  /** Station target and the action it was planned for. */
  readonly do?: string;
  readonly to?: string;
  readonly map?: number | null;
  readonly cell?: readonly [number, number] | null;
  readonly result?: RunStationResult;
  readonly evidence?: readonly string[];
  readonly note?: string;
  readonly attempt?: number;
  /** fallback: retry/skip/heal/boss-retry/defer-segment/...; battle: normal/boss. */
  readonly kind?: string;
  readonly reason?: string;
  /** battle: enemies on screen. */
  readonly enemies?: readonly string[];
  readonly won?: boolean;
  /** chest/buy: the item. */
  readonly item?: string;
  readonly opened?: boolean;
  readonly count?: number;
  readonly bought?: number;
  /** heal: lowest party HP% before and after. */
  readonly beforeHp?: number | null;
  readonly afterHp?: number | null;
  readonly used?: string;
  /** level: member and the level transition. */
  readonly member?: string;
  readonly fromLevel?: number | null;
  readonly toLevel?: number | null;
  /** resume: first station this run executes and the stations it skips. */
  readonly from?: number | null;
  readonly skipped?: readonly number[];
  /** run.end: battles the reports counted (including grind fights). */
  readonly battles?: number;
}

export type RunEvent = RunEventInput & {
  readonly at: string;
  readonly run: string;
  readonly chapter: number | null;
  readonly segment: number | null;
  readonly section: string | null;
  readonly station: number | null;
};

/** The structured log for one game; one file per game, beside the activity log. */
export function runFile(game: string, deps = DEPS): string {
  return join(deps, "ds", `run-${game}.jsonl`);
}

export interface RunLoggerOptions {
  readonly game: string;
  /** JSONL path; omitted uses `runFile(game)`. */
  readonly file?: string;
  /** Fixed per logger so an execution/resume has one id; generated when omitted. */
  readonly run?: string;
  readonly chapter?: number | null;
  readonly segment?: number | null;
  readonly section?: string | null;
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}

/** What the executors see: the logger fills `at`/`run` and any default context. */
export interface RunLogSink {
  record(event: RunEventInput): void;
}

let runCounter = 0;

/** Short, sortable, and unique within a process: 20261112T131415-3f2a. */
function newRunId(now: Date): string {
  runCounter += 1;
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z");
  const suffix = (0x1000 + ((runCounter * 2654435761) % 0xf000)).toString(16);
  return `${stamp.slice(0, 15)}-${suffix}`;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "number";
}

function isCell(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number")
  );
}

/** Accept only a full line: a broken append must not be counted as a real event. */
export function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.at === "string" &&
    typeof event.run === "string" &&
    typeof event.type === "string" &&
    (RUN_EVENT_TYPES as readonly string[]).includes(event.type) &&
    isOptionalNumber(event.chapter) &&
    isOptionalNumber(event.segment) &&
    isOptionalNumber(event.station) &&
    (event.section === undefined || event.section === null || typeof event.section === "string") &&
    isCell(event.cell)
  );
}

export class RunLogger implements RunLogSink {
  readonly game: string;
  readonly file: string;
  readonly run: string;
  chapter: number | null;
  segment: number | null;
  section: string | null;
  private readonly now: () => Date;
  private readonly warn: ((message: string) => void) | undefined;
  private warned = false;
  private ready: Promise<unknown> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RunLoggerOptions) {
    this.game = options.game;
    this.file = options.file ?? runFile(options.game);
    this.now = options.now ?? (() => new Date());
    this.run = options.run ?? newRunId(this.now());
    this.chapter = options.chapter ?? null;
    this.segment = options.segment ?? null;
    this.section = options.section ?? null;
    this.warn = options.warn;
  }

  record(input: RunEventInput): void {
    const { type, chapter, segment, section, station, ...payload } = input;
    const event: RunEvent = {
      at: this.now().toISOString(),
      run: this.run,
      chapter: chapter ?? this.chapter,
      segment: segment ?? this.segment,
      section: section ?? this.section,
      station: station ?? null,
      type,
      ...payload,
    };
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (error) {
      this.warnOnce(`写不了执行日志 ${this.file}:${describeError(error)}`);
      return;
    }
    this.queue = this.queue.then(async () => {
      try {
        this.ready ??= mkdir(dirname(this.file), { recursive: true });
        await this.ready;
        await appendFile(this.file, line, { encoding: "utf8" });
      } catch (error) {
        // Let the next append retry the directory; one warning still covers this run.
        this.ready = null;
        this.warnOnce(`写不了执行日志 ${this.file}:${describeError(error)}`);
      }
    });
  }

  /** Wait for queued appends; the executors call it before returning. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn?.(message);
  }
}

/** Read every valid line; a missing file is an empty log, a broken line is skipped. */
export async function readRunEvents(file: string): Promise<RunEvent[]> {
  let body: string;
  try {
    body = await readFile(file, { encoding: "utf8" });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new Error(`读不了执行日志 ${file}:${describeError(error)}`, {
      cause: error,
    });
  }
  const events: RunEvent[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunEvent(parsed)) events.push(parsed);
    } catch {
      // A crash mid-write leaves at most one broken line; skip it like the activity log.
    }
  }
  return events;
}

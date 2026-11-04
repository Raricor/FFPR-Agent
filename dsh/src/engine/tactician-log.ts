/**
 * One line per tactician call (task 40): when it ran, which map, why it was called, how many
 * usable tables came back, what was wrong with them, and the first sentence of the walker
 * notes. The sidebar shows the recent calls so the user can see the second layer working
 * instead of only its latest plan.
 *
 * The file is `.deps/ds/tactician-<game>.jsonl`; a failed write costs one warning and never
 * fails the tool call that asked for the plan.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "./errors.ts";
import { isRecord, text } from "./values.ts";

export const MAX_TACTICIAN_CALLS = 100;

export interface TacticianCall {
  readonly at: string;
  readonly mapId: number;
  /** FactsTrigger.kind: new-map, new-monster, bad-battle, blocked, conveyor, boss. */
  readonly kind: string;
  readonly detail: string;
  /** How many tables passed the checks (0 when the call failed). */
  readonly tables: number;
  readonly problems: readonly string[];
  readonly walkerFirst: string;
}

export interface TacticianLogOptions {
  readonly file?: string;
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}

function isCall(value: unknown): value is TacticianCall {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.mapId === "number" &&
    typeof value.kind === "string" &&
    typeof value.detail === "string" &&
    typeof value.tables === "number" &&
    Array.isArray(value.problems) &&
    value.problems.every((item) => typeof item === "string") &&
    typeof value.walkerFirst === "string"
  );
}

/** The first sentence, at most 120 code points, so one row stays one short line. */
export function firstSentence(value: string): string {
  const first = value.split(/[。！？!?\n]/u)[0]?.trim() ?? "";
  const points = Array.from(first === "" ? value.trim() : first);
  return points.length <= 120 ? points.join("") : points.slice(0, 119).join("") + "…";
}

export class TacticianLog {
  readonly file: string | undefined;
  readonly entries: TacticianCall[] = [];
  private readonly now: () => Date;
  private readonly warn: ((message: string) => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(options: TacticianLogOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn;
  }

  static async load(options: TacticianLogOptions = {}): Promise<TacticianLog> {
    const log = new TacticianLog(options);
    if (options.file !== undefined) await log.restore(options.file);
    return log;
  }

  private async restore(file: string): Promise<void> {
    try {
      const body = await readFile(file, { encoding: "utf8" });
      const calls: TacticianCall[] = [];
      for (const line of body.split(/\r\n|\r|\n/u)) {
        if (line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isCall(parsed)) calls.push(parsed);
        } catch {
          // A crash can leave one broken last line; the rest of the file is still usable.
        }
      }
      this.entries.push(...calls.slice(-MAX_TACTICIAN_CALLS));
    } catch (error) {
      if (!isMissingFile(error)) this.warnOnce(`读不了战术官记录 ${file}:${describeError(error)}`);
    }
  }

  /** Record one call and append it; callers await so tests can read the file immediately. */
  async record(call: Omit<TacticianCall, "at">): Promise<void> {
    const entry: TacticianCall = { ...call, at: this.now().toISOString() };
    this.entries.push(entry);
    if (this.entries.length > MAX_TACTICIAN_CALLS) this.entries.shift();
    if (this.file === undefined) return;
    const line = JSON.stringify(entry) + "\n";
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(this.file ?? ""), { recursive: true });
        await appendFile(this.file ?? "", line, { encoding: "utf8" });
      } catch (error) {
        this.warnOnce(`写不了战术官记录 ${this.file ?? ""}:${describeError(error)}`);
      }
    });
    await this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn?.(message);
  }
}

/** The map number from a fact sheet's 「### 地图」 section; a call without one records -1. */
export function mapOfFacts(facts: string): number {
  const matched = /地图[:：]?\s*(\d+)/u.exec(facts)?.[1];
  if (matched === undefined) return -1;
  const parsed = Number.parseInt(matched, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

/** Trim a trigger detail to the one line the log stores. */
export function oneLine(value: string): string {
  const line = (text(value) ?? "").split(/\r\n|\r|\n/u)[0] ?? "";
  const points = Array.from(line);
  return points.length <= 200 ? points.join("") : points.slice(0, 199).join("") + "…";
}

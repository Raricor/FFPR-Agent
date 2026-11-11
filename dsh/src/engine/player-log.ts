/**
 * The first layer's journal (task 40): what the user/Claude asked for, what the AI said, and
 * which tools it called, kept per game in `.deps/ds/player-<game>.jsonl`. The sidebar turns the
 * newest 100 records into the ① 玩家 tab; everything is stored as plain JSONL so a web restart
 * keeps the conversation-facing history.
 *
 * Events arrive from `session/event`; the plugin decides which events count and this module
 * only stores and formats them.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { byKey } from "./games.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { isRecord, text } from "./values.ts";

export const MAX_PLAYER_ENTRIES = 100;
const MAX_STORED_TEXT = 2000;

export type PlayerEntry =
  | { readonly kind: "user"; readonly at: string; readonly text: string }
  | { readonly kind: "assistant"; readonly at: string; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly at: string;
      readonly callId: string;
      readonly name: string;
      readonly args: string;
    }
  | {
      readonly kind: "tool-result";
      readonly at: string;
      readonly callId: string;
      readonly ok: boolean;
      readonly text: string;
    };

export interface PlayerLogOptions {
  readonly file?: string;
  readonly warn?: (message: string) => void;
}

function stored(value: string): string {
  const points = Array.from(value);
  return points.length <= MAX_STORED_TEXT
    ? value
    : points.slice(0, MAX_STORED_TEXT - 1).join("") + "…";
}

function isEntry(value: unknown): value is PlayerEntry {
  if (!isRecord(value) || typeof value.at !== "string") return false;
  if (value.kind === "user" || value.kind === "assistant") return typeof value.text === "string";
  if (value.kind === "tool-call") {
    return (
      typeof value.callId === "string" &&
      typeof value.name === "string" &&
      typeof value.args === "string"
    );
  }
  if (value.kind === "tool-result") {
    return (
      typeof value.callId === "string" &&
      typeof value.ok === "boolean" &&
      typeof value.text === "string"
    );
  }
  return false;
}

export class PlayerJournal {
  readonly file: string | undefined;
  readonly entries: PlayerEntry[] = [];
  private readonly warn: ((message: string) => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(options: PlayerLogOptions = {}) {
    this.file = options.file;
    this.warn = options.warn;
  }

  static async load(options: PlayerLogOptions = {}): Promise<PlayerJournal> {
    const journal = new PlayerJournal(options);
    if (options.file !== undefined) await journal.restore(options.file);
    return journal;
  }

  private async restore(file: string): Promise<void> {
    try {
      const body = await readFile(file, { encoding: "utf8" });
      const entries: PlayerEntry[] = [];
      for (const line of body.split(/\r\n|\r|\n/u)) {
        if (line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isEntry(parsed)) entries.push(parsed);
        } catch {
          // A crash can leave one broken last line; the rest is still usable.
        }
      }
      this.entries.push(...entries.slice(-MAX_PLAYER_ENTRIES));
    } catch (error) {
      if (!isMissingFile(error)) this.warnOnce(`读不了玩家记录 ${file}:${describeError(error)}`);
    }
  }

  /** Append one record; callers may await, the polling plugin does not have to. */
  record(entry: PlayerEntry): void {
    const normalized: PlayerEntry =
      entry.kind === "user" || entry.kind === "assistant"
        ? { ...entry, text: stored(entry.text) }
        : entry.kind === "tool-call"
          ? { ...entry, args: stored(entry.args) }
          : { ...entry, text: stored(entry.text) };
    this.entries.push(normalized);
    if (this.entries.length > MAX_PLAYER_ENTRIES) this.entries.shift();
    const file = this.file;
    if (file === undefined) return;
    const line = JSON.stringify(normalized) + "\n";
    // Once the journal is full, rewrite its hundred lines instead of appending: the file then
    // holds exactly what the page can show, instead of growing with every event forever.
    const full = this.entries.length >= MAX_PLAYER_ENTRIES;
    const body = full ? this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n" : line;
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        if (full) await writeFile(file, body, { encoding: "utf8" });
        else await appendFile(file, body, { encoding: "utf8" });
      } catch (error) {
        this.warnOnce(`写不了玩家记录 ${file}:${describeError(error)}`);
      }
    });
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

export interface PlayerDecisionView {
  /** What the AI said right before the call, when it said anything. */
  readonly said: string | null;
  readonly line: string;
}

export interface PlayerMessageView {
  readonly timeText: string;
  readonly text: string;
}

export interface PlayerView {
  readonly title: string;
  readonly status: string;
  readonly goal: PlayerMessageView | null;
  readonly now: string;
  readonly notes: readonly string[];
  readonly decisions: readonly PlayerDecisionView[];
  readonly messages: readonly PlayerMessageView[];
  readonly messagesTitle: string;
  /** Task 45: one-time places whose missed count grew, newest last. */
  readonly incidents: readonly string[];
  /** Task 45: unresolved deliberate incomplete departures. */
  readonly backlog: readonly string[];
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function firstLine(value: string): string {
  return (value.split(/\r\n|\r|\n/u)[0] ?? "").trim();
}

function shorten(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit - 1).join("") + "…";
}

/** `{"x":5,"y":2}` → `x=5 y=2`; a non-JSON argument stays as the model sent it. */
export function argumentSummary(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return shorten(firstLine(raw), 80);
  }
  if (!isRecord(parsed)) return shorten(firstLine(raw), 80);
  const parts = Object.entries(parsed).map(([key, value]) => {
    const shown =
      typeof value === "string"
        ? value
        : typeof value === "number"
          ? String(value)
          : JSON.stringify(value);
    return `${key}=${shorten(shown, 30)}`;
  });
  return shorten(parts.join(" "), 80);
}

function decisionLine(at: string, name: string, args: string, result: string | null): string {
  const outcome = result === null ? "还没有结果" : shorten(firstLine(result), 120);
  return `${clock(at)} ${name} ${argumentSummary(args)} → ${outcome}`;
}

/** The ① 玩家 tab: goal, current words, notes, recent decisions and received messages. */
export function playerView(
  game: string,
  journal: PlayerJournal,
  notes: readonly string[],
  status: string,
): PlayerView {
  const calls = new Map<string, { at: string; name: string; args: string; said: string | null }>();
  const decisions: PlayerDecisionView[] = [];
  const messages: PlayerMessageView[] = [];
  let said: string | null = null;
  let lastUser: { readonly at: string; readonly text: string } | null = null;
  let lastAssistant = "";
  for (const entry of journal.entries) {
    if (entry.kind === "user") {
      messages.push({ timeText: clock(entry.at), text: entry.text });
      lastUser = { at: entry.at, text: entry.text };
      continue;
    }
    if (entry.kind === "assistant") {
      said = entry.text;
      lastAssistant = entry.text;
      continue;
    }
    if (entry.kind === "tool-call") {
      calls.set(entry.callId, {
        at: entry.at,
        name: entry.name,
        args: entry.args,
        said,
      });
      continue;
    }
    const call = calls.get(entry.callId);
    if (call === undefined) {
      decisions.push({
        said,
        line: decisionLine(entry.at, "工具", "{}", entry.text),
      });
      continue;
    }
    calls.delete(entry.callId);
    decisions.push({
      said: call.said,
      line: decisionLine(call.at, call.name, call.args, entry.text),
    });
  }
  // Calls still running are decisions too; the page says so instead of hiding them.
  for (const call of calls.values()) {
    decisions.push({
      said: call.said,
      line: decisionLine(call.at, call.name, call.args, null),
    });
  }
  const recent = decisions.slice(-15).reverse();
  return {
    title: `${byKey(game).label} 玩家`,
    status,
    goal:
      lastUser === null
        ? null
        : { timeText: clock(lastUser.at), text: shorten(lastUser.text, 400) },
    now: shorten(lastAssistant.trim(), 180),
    notes: [...notes],
    decisions: recent,
    messages,
    messagesTitle: `收到的消息(${messages.length} 条)`,
    incidents: [],
    backlog: [],
  };
}

/** Extract the text of one message's `content`; reasoning is deliberately ignored. */
export function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") continue;
    const value = text(block.text);
    if (value !== undefined && value !== "") parts.push(value);
  }
  return parts.join("\n");
}

/**
 * Key events, live: the bridge's stream fed through the key-log Builder, kept in windows the
 * planning layers read (control plan §4.8), ported from ffpr_agent/events.py.
 *
 *     const events = new KeyEvents();
 *     await events.seed(probeFile);        // what happened before we started listening
 *     new Watcher(stream, events).start(signal); // then follow the stream
 *     events.window(1);                    // strategy: the long window
 *     events.window(2);                    // tactics: the last minutes
 *     events.news();                       // entries new or grown since the last call
 *
 * The watcher also keeps the newest sample and the last raw events, so the player can describe
 * the game without reading the probe file over SSH.
 */

import { describeError } from "./errors.ts";
import { Builder, LABEL, formatLocalTime, load, localTime, type KeyEntry } from "./keylog.ts";
import { isRecord, list, num, text, truthy, type Json } from "./values.ts";

export interface Window {
  readonly types: ReadonlySet<string>;
  readonly minutes: number;
  readonly limit: number;
  /** How much of a scene's lines to show. */
  readonly storyChars: number;
}

export const WINDOWS: Readonly<Record<1 | 2, Window>> = {
  // Strategy: where the story stands, who is in the party, what is done; hours back.
  1: {
    types: new Set([
      "run",
      "place",
      "party",
      "story",
      "bossfight",
      "boss",
      "defeat",
      "item",
      "chest",
      "level",
      "save",
      "buy",
      "equip",
    ]),
    minutes: 240,
    limit: 30,
    storyChars: 600,
  },
  // Tactics: what just happened around the current sub-goal.
  2: {
    types: new Set([
      "place",
      "party",
      "story",
      "bossfight",
      "boss",
      "defeat",
      "item",
      "chest",
      "level",
      "buy",
      "equip",
    ]),
    minutes: 15,
    limit: 12,
    storyChars: 160,
  },
};

/** One line per entry, a story scene with as many of its lines as fit. */
export function describe(entries: readonly KeyEntry[], storyChars = 160): string {
  const out: string[] = [];
  for (const entry of entries) {
    let entryText = entry.text;
    if (entry.type === "story") {
      const lines = list(entry.data?.lines).filter(
        (value): value is string => typeof value === "string",
      );
      entryText = shorten(lines, storyChars) || entryText;
    }
    const progress = entry.progress;
    const tail = progress && progress !== "—" ? `(${progress})` : "";
    out.push(`${entry.ts.slice(11, 16)} ${LABEL[entry.type] ?? entry.type} ${entryText}${tail}`);
  }
  return out.join("\n");
}

/**
 * A scene's first and last lines within `chars`: the start says where it is, the end usually
 * says what to do next. Lengths count code points, as Python's len does.
 */
export function shorten(lines: readonly string[], chars: number): string {
  if (lines.reduce((sum, line) => sum + codePointLength(line), 0) <= chars) {
    return lines.join(" / ");
  }
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  let j = lines.length - 1;
  while (i <= j) {
    const front = head.length <= tail.length;
    const line = (front ? lines[i] : lines[j]) ?? "";
    if (used + codePointLength(line) > chars) break;
    used += codePointLength(line);
    if (front) {
      head.push(line);
      i += 1;
    } else {
      tail.unshift(line);
      j -= 1;
    }
  }
  if (head.length === 0) head.push(codePointSlice(lines[0] ?? "", 0, chars));
  return [...head, "……", ...tail].join(" / ");
}

export function version(value: string | null | undefined): number[] {
  const parts = (value || "0").split(".");
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^[+-]?\d+$/.test(part.trim())) return [0];
    numbers.push(Number.parseInt(part, 10));
  }
  return numbers;
}

/** Python tuple comparison, used for `version(plugin) >= (0, 7, 2)`. */
export function versionAtLeast(
  value: string | null | undefined,
  target: readonly number[],
): boolean {
  const actual = version(value);
  const length = Math.min(actual.length, target.length);
  for (let i = 0; i < length; i += 1) {
    const left = actual[i] ?? 0;
    const right = target[i] ?? 0;
    if (left !== right) return left > right;
  }
  return actual.length >= target.length;
}

/** Key entries across game runs, fed record by record (from probe files, then live). */
export class KeyEvents {
  readonly now: () => Date;
  readonly monotonic: () => number;
  readonly entries: KeyEntry[] = [];
  sample: Json | null = null;
  /** Monotonic time of the newest sample; 0 means none. */
  sampleAt = 0;
  /** Raw records other than samples, newest 50. */
  readonly recent: Json[] = [];
  enemies = new Map<unknown, Set<string>>(); // map id → monsters met there
  books = new Map<string, number>(); // monster name → bestiary number (the guides' key)
  private builder: Builder | null = null;
  private hello: unknown = null;
  private seq = 0;
  private readonly told = new Map<KeyEntry, string>(); // entry → the text news() last reported
  private numbersShown = false; // this run's bridge sends the numbers the bestiary shows
  private entryListener: ((entry: KeyEntry) => void) | undefined;

  /**
   * The game is one resource but JavaScript runs one statement at a time, so Python's
   * threading.Lock around feed/read is not needed: no await sits inside these methods.
   */
  constructor(
    now: () => Date = () => new Date(),
    monotonic: () => number = () => performance.now(),
  ) {
    this.now = now;
    this.monotonic = monotonic;
  }

  async seed(path: string, signal?: AbortSignal): Promise<void> {
    for (const record of await load(path, signal)) this.feed(record, false);
  }

  feed(record: Json, live = true): void {
    if (record.type === "hello") {
      // The stream resends the game's hello to every new connection: only a different one
      // (by its time) means the game started again.
      const stamp = record.t ?? null;
      if (stamp === this.hello) return;
      this.hello = stamp;
      this.numbersShown = versionAtLeast(text(record.plugin) ?? null, [0, 7, 2]);
      const previous = this.builder;
      this.builder = new Builder((text(record.t) ?? "").slice(0, 19));
      if (previous) this.builder.places = previous.places; // a first visit is first across runs too
      this.seq = 0;
    }
    const seq = num(record.seq) ?? 0;
    if (this.builder === null || seq <= this.seq) {
      return; // before the first hello, or already fed (seeded, then streamed)
    }
    this.seq = seq;
    if (record.type === "sample") {
      this.sample = record;
      this.sampleAt = live ? this.monotonic() : 0;
      const battle = isRecord(record.battle) ? record.battle : {};
      if (truthy(battle.active)) {
        this.recordEnemies(record, battle);
      }
    } else if (live) {
      this.recent.push(record);
      if (this.recent.length > 50) this.recent.shift();
    }
    const before = this.builder.entries.length;
    const previousLast = before > 0 ? this.builder.entries[before - 1]?.text : undefined;
    const previousStory = this.builder.story?.text;
    this.builder.feed(record);
    const built = this.builder.entries;
    const notified = new Set<KeyEntry>();
    for (let index = before; index < built.length; index += 1) {
      const entry = built[index];
      if (entry === undefined) continue;
      this.entries.push(entry);
      notified.add(entry);
      this.entryListener?.(entry);
    }
    // A merged level-up rewrites the last entry.
    if (built.length === before && before > 0 && built[before - 1]?.text !== previousLast) {
      const entry = built[before - 1];
      if (entry !== undefined && !notified.has(entry)) {
        notified.add(entry);
        this.entryListener?.(entry);
      }
    }
    // A story's next page can arrive after a sample added other entries in between.
    const story = this.builder.story;
    if (story !== null && story.text !== previousStory && !notified.has(story)) {
      this.entryListener?.(story);
    }
  }

  /**
   * Called for each new key entry, and again when the newest entry grows (a story's next line,
   * a battle's merged level-ups). The listener is for the activity page only: it does not mark
   * entries as told, so `news()` sees exactly what it would without a listener.
   */
  onEntry(listener: (entry: KeyEntry) => void): () => void {
    this.entryListener = listener;
    return () => {
      if (this.entryListener === listener) this.entryListener = undefined;
    };
  }

  private recordEnemies(record: Json, battle: Json): void {
    const user = isRecord(record.user) ? record.user : {};
    const mapId = user.mapId ?? null; // the monsters each map has shown (§4.10)
    let seen = this.enemies.get(mapId);
    if (!seen) {
      seen = new Set();
      this.enemies.set(mapId, seen);
    }
    for (const enemy of list(battle.enemies)) {
      if (!isRecord(enemy)) continue;
      const name = text(enemy.name);
      if (name) seen.add(name);
      // Bridges before 0.7.2 sent the bestiary's entry id, not the number it shows (10-21):
      // seeded probe files from them must not count.
      const book = num(enemy.book);
      if (name && book !== undefined && book !== 0 && this.numbersShown) {
        this.books.set(name, book);
      }
    }
  }

  /** The newest streamed sample if it is fresh (the stream is up), else null. */
  liveSample(maxAge = 3.0): Json | null {
    const fresh = this.sampleAt !== 0 && this.monotonic() - this.sampleAt <= maxAge * 1000;
    return fresh ? this.sample : null;
  }

  /**
   * A key entry the stream cannot show (a purchase, a change of equipment), told by the
   * player's own tools, so the windows remember it after the conversation is trimmed
   * (10-20: spells bought, forgotten, bought again).
   */
  note(kind: string, entryText: string): void {
    this.entries.push({
      ts: formatLocalTime(this.now()),
      run: "",
      key: true,
      type: kind,
      text: entryText,
      progress: "—",
    });
  }

  /**
   * Raw records streamed since the previous call (one reader: the player's view); position
   * updates are left out, the view shows the position anyway.
   */
  takeRecent(skip: ReadonlySet<string> = new Set(["pos.change"])): Json[] {
    const taken = this.recent.filter((record) => !skip.has(String(record.type)));
    this.recent.length = 0;
    return taken;
  }

  /** Minutes since the newest save entry, or null when there is none in view. */
  lastSaveMinutes(): number | null {
    const saves = this.entries.filter((entry) => entry.type === "save");
    const newest = saves[saves.length - 1];
    if (!newest) return null;
    return (this.now().getTime() - localTime(newest.ts).getTime()) / 60_000;
  }

  /**
   * The layer's window of key events. Whoever reads it is up to date: news() starts from here.
   */
  window(layer: 1 | 2): string {
    const spec = WINDOWS[layer];
    const since = this.now().getTime() - spec.minutes * 60_000;
    const picked = this.entries
      .filter((entry) => spec.types.has(entry.type) && localTime(entry.ts).getTime() >= since)
      .slice(-spec.limit);
    this.markTold();
    return describe(picked, spec.storyChars);
  }

  /** Entries added, or grown (a scene's lines, merged level-ups), since the last call. */
  news(layer: 1 | 2 = 2): string {
    const spec = WINDOWS[layer];
    const fresh = this.entries.filter(
      (entry) => spec.types.has(entry.type) && this.told.get(entry) !== entry.text,
    );
    this.markTold();
    return describe(fresh, spec.storyChars);
  }

  private markTold(): void {
    for (const entry of this.entries) this.told.set(entry, entry.text);
  }
}

export type Stream = (signal: AbortSignal) => AsyncIterable<Json>;

/** The link's state changes the activity page logs; repeated identical states are not sent. */
export interface LinkStatus {
  readonly up: boolean;
  readonly error?: string;
}

/**
 * Follows the bridge's stream, reconnecting when the link drops, until the signal aborts.
 * This is Python's daemon thread as one asynchronous loop; the stream itself is injected so
 * the watcher does not depend on bridge.ts.
 */
export class Watcher {
  readonly stream: Stream;
  readonly events: KeyEvents;
  readonly retry: number;
  readonly onStatus: ((status: LinkStatus) => void) | undefined;
  error: string | null = null;
  private status: LinkStatus | null = null;

  constructor(
    stream: Stream,
    events: KeyEvents,
    retry = 5.0,
    onStatus?: (status: LinkStatus) => void,
  ) {
    this.stream = stream;
    this.events = events;
    this.retry = retry;
    this.onStatus = onStatus;
  }

  start(signal: AbortSignal): this {
    void this.run(signal);
    return this;
  }

  /** Whether the newest connection is up; the overview page's green dot reads this. */
  get connected(): boolean {
    return this.status?.up === true;
  }

  private report(status: LinkStatus): void {
    if (this.status !== null && this.status.up === status.up) return;
    this.status = status;
    this.onStatus?.(status);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!aborted(signal)) {
      try {
        for await (const record of this.stream(signal)) {
          if (aborted(signal)) break;
          this.report({ up: true });
          this.events.feed(record);
          this.error = null;
        }
      } catch (error) {
        // A closed socket, a game restart: follow it again after the retry.
        if (aborted(signal)) break;
        this.error = describeError(error);
        this.report({ up: false, error: this.error });
      }
      if (aborted(signal)) break;
      this.report({ up: false, error: this.error ?? "连接已断开" });
      try {
        await delay(this.retry * 1000, signal);
      } catch {
        break; // the signal ended the wait
      }
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("操作已取消", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("操作已取消", "AbortError"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The lint rule against spreading strings does not apply: Python counts code points too. */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

function codePointSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

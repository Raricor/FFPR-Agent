/**
 * A Pilot that answers from a script, for tests of the skills: replies registered by op
 * (a fixed reply, a sequence of replies, or a function), every call recorded, and a fake
 * clock whose sleep only moves `now`.
 *
 * An op with no registered answer fails loudly with its name, so a test never walks down a
 * path it did not intend to.
 */

import type { Fields, Pilot, Reply } from "../src/engine/pilot.ts";

export type FakeReply = Reply | ((fields: Fields) => Reply | Promise<Reply>);
export type Answer = FakeReply | FakeReply[];

interface Slot {
  readonly steps: FakeReply[];
  readonly repeat: boolean;
  index: number;
}

export type Call =
  | { readonly kind: "send"; readonly op: string; readonly fields: Fields; readonly waitMs: number }
  | { readonly kind: "query"; readonly q: string; readonly fields: Fields };

function slotFor(answer: Answer): Slot {
  if (Array.isArray(answer)) return { steps: [...answer], repeat: false, index: 0 };
  return { steps: [answer], repeat: true, index: 0 };
}

export class FakePilot implements Pilot {
  readonly calls: Call[] = [];
  private readonly answers = new Map<string, Slot>();
  private readonly matched: { op: string; when: (fields: Fields) => boolean; answer: Reply }[] = [];
  private readonly queries = new Map<string, Slot>();
  private runPsAnswer: (() => string | Promise<string>) | null = null;
  private clock = 0;
  lastScript = "";

  /** Register the answer(s) for one pilot op. */
  on(op: string, answer: Answer): this {
    this.answers.set(op, slotFor(answer));
    return this;
  }

  /**
   * A fixed answer for the calls of one op whose fields match, checked before the op's other
   * answers: an extra query the TS version makes (10-27: entrances on the world map) can be
   * answered without disturbing a replayed Python transcript of that op.
   */
  when(op: string, when: (fields: Fields) => boolean, answer: Reply): this {
    this.matched.push({ op, when, answer });
    return this;
  }

  /** Register the answer(s) for one bridge query. */
  onQuery(q: string, answer: Answer): this {
    this.queries.set(q, slotFor(answer));
    return this;
  }

  onRunPs(answer: () => string | Promise<string>): this {
    this.runPsAnswer = answer;
    return this;
  }

  async send(op: string, fields: Fields = {}, waitMs = 30_000): Promise<Reply> {
    this.calls.push({ kind: "send", op, fields, waitMs });
    const match = this.matched.find((entry) => entry.op === op && entry.when(fields));
    if (match !== undefined) return match.answer;
    const slot = this.answers.get(op);
    if (slot === undefined) throw new Error(`假 pilot 没有注册 op「${op}」的回答`);
    return await this.next(slot, `op「${op}」`, fields);
  }

  async query(q: string, fields: Fields = {}): Promise<Reply> {
    this.calls.push({ kind: "query", q, fields });
    const slot = this.queries.get(q);
    if (slot === undefined) throw new Error(`假 pilot 没有注册 query「${q}」的回答`);
    return await this.next(slot, `query「${q}」`, fields);
  }

  async runPs(script: string): Promise<string> {
    this.lastScript = script;
    if (this.runPsAnswer === null) throw new Error("假 pilot 没有注册 runPs 的回答");
    return await this.runPsAnswer();
  }

  sleep(ms: number): Promise<void> {
    this.clock += ms;
    return Promise.resolve();
  }

  now(): number {
    return this.clock;
  }

  /** Move the fake clock without a sleep (a test that needs time to have passed). */
  advance(ms: number): void {
    this.clock += ms;
  }

  /** Every key sequence sent, in order. */
  keys(): string[][] {
    const out: string[][] = [];
    for (const call of this.calls) {
      if (call.kind !== "send" || call.op !== "keys") continue;
      const keys = call.fields.keys;
      if (Array.isArray(keys))
        out.push(keys.filter((key): key is string => typeof key === "string"));
    }
    return out;
  }

  private async next(slot: Slot, label: string, fields: Fields): Promise<Reply> {
    const step = slot.steps[slot.index];
    if (step === undefined) throw new Error(`假 pilot 的${label}没有更多回答`);
    if (!slot.repeat) slot.index += 1;
    if (typeof step === "function") return await step(fields);
    return step;
  }
}

export type TranscriptEntry =
  | { readonly kind: "send"; readonly op: string; readonly reply: Reply }
  | { readonly kind: "query"; readonly q: string; readonly reply: Reply };

/** Register a recorded transcript's replies per op/query, in the order they were recorded. */
export function scriptReplies(pilot: FakePilot, transcript: readonly TranscriptEntry[]): void {
  const sends = new Map<string, Reply[]>();
  const queries = new Map<string, Reply[]>();
  for (const entry of transcript) {
    const target = entry.kind === "send" ? sends : queries;
    const key = entry.kind === "send" ? entry.op : entry.q;
    const replies = target.get(key) ?? [];
    replies.push(entry.reply);
    target.set(key, replies);
  }
  for (const [op, replies] of sends) pilot.on(op, replies);
  for (const [q, replies] of queries) pilot.onQuery(q, replies);
}

/** The recorded calls in the fixture's shape: send waits in seconds, not milliseconds. */
export function recordedCalls(pilot: FakePilot): unknown[] {
  return pilot.calls.map((call) =>
    call.kind === "send"
      ? { kind: call.kind, op: call.op, fields: call.fields, wait: call.waitMs / 1000 }
      : call,
  );
}

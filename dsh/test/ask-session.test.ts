import assert from "node:assert/strict";
import test from "node:test";
// ask.mjs is a node-run script, not a typed module; only its pure turn helpers are tested.
import { promptTurn, turnEnded } from "../scripts/ask.mjs";

interface FakeEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

function message(seq: number, requestId: string, text: string): FakeEvent {
  return {
    seq,
    type: "user/message",
    data: { content: [{ type: "text", text }], source: { rpcId: requestId } },
  };
}

void test("a late turn/end from the interrupted previous round does not finish this wait", () => {
  const all: FakeEvent[] = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    message(2, "old", "上一轮"),
    { seq: 3, type: "turn/end", data: { turn: 1, reason: "aborted" } },
    // The new prompt is admitted and opens turn 2.
    { seq: 4, type: "turn/start", data: { turn: 2 } },
    message(5, "new", "继续"),
    // A restart wrote the old turn's ending late, after this round began.
    { seq: 6, type: "turn/end", data: { turn: 1, reason: "aborted" } },
  ];
  const prompt = promptTurn(all, "new", 3, "继续");
  assert.deepEqual(prompt, { turn: 2, seq: 5 });
  assert.equal(turnEnded(all, prompt), false);

  all.push({ seq: 7, type: "turn/end", data: { turn: 2, reason: "completed" } });
  assert.equal(turnEnded(all, prompt), true);
});

void test("the waiting prompt's own message is not read from the previous round", () => {
  const all: FakeEvent[] = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    message(2, "old", "继续"),
    { seq: 3, type: "turn/end", data: { turn: 1, reason: "aborted" } },
    { seq: 4, type: "turn/end", data: { turn: 1, reason: "aborted" } },
  ];
  assert.equal(promptTurn(all, "new", 3, "继续"), null);
});

void test("a log without the RPC identity still finds the prompt by its text", () => {
  const all: FakeEvent[] = [
    { seq: 1, type: "turn/end", data: { turn: 1, reason: "aborted" } },
    { seq: 2, type: "turn/start", data: { turn: 2 } },
    { seq: 3, type: "user/message", data: { content: [{ type: "text", text: "继续" }] } },
    { seq: 4, type: "turn/end", data: { turn: 2, reason: "completed" } },
  ];
  const prompt = promptTurn(all, "missing-rpc-id", 1, "继续");
  assert.deepEqual(prompt, { turn: 2, seq: 3 });
  assert.equal(turnEnded(all, prompt), true);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { PlayerJournal, playerView, argumentSummary } from "../src/engine/player-log.ts";
import { recordSessionEvent } from "../src/plugin/player.ts";

function event(type: string, time: number, data: unknown): SessionEvent {
  return { type, seq: 1, time, data } as unknown as SessionEvent;
}

void test("user text, assistant text and tool call/result become the first-layer journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-player-"));
  const path = join(directory, "player-ff5.jsonl");
  try {
    const journal = await PlayerJournal.load({ file: path });
    recordSessionEvent(
      journal,
      event("user/message", Date.parse("2026-11-03T10:00:00Z"), {
        source: { kind: "user" },
        content: [{ type: "text", text: "去火力船" }],
      }),
    );
    recordSessionEvent(
      journal,
      event("assistant/message", Date.parse("2026-11-03T10:00:10Z"), {
        source: { kind: "model", provider: "deepseek", model: "deepseek-flash" },
        message: {
          content: [
            { type: "reasoning", text: "想一下" },
            { type: "text", text: "我先走到入口" },
          ],
        },
      }),
    );
    recordSessionEvent(
      journal,
      event("tool/call", Date.parse("2026-11-03T10:00:20Z"), {
        callId: "call-1",
        name: "walk_to",
        arguments: '{"x":5,"y":2}',
      }),
    );
    recordSessionEvent(
      journal,
      event("tool/result", Date.parse("2026-11-03T10:00:30Z"), {
        message: {
          toolCallId: "call-1",
          isError: false,
          content: [{ type: "text", text: "走到了\n第二行不算" }],
        },
      }),
    );
    await journal.flush();
    assert.deepEqual(
      journal.entries.map((entry) => entry.kind),
      ["user", "assistant", "tool-call", "tool-result"],
    );
    const view = playerView("ff5", journal, ["记一条"], "");
    assert.equal(view.goal?.text, "去火力船");
    assert.equal(view.now, "我先走到入口");
    assert.deepEqual(view.notes, ["记一条"]);
    assert.equal(view.messagesTitle, "收到的消息(1 条)");
    assert.equal(view.decisions.length, 1);
    const decision = view.decisions[0];
    assert.ok(decision);
    assert.equal(decision.said, "我先走到入口");
    assert.match(decision.line, /walk_to x=5 y=2 → 走到了$/u);
    assert.equal(argumentSummary('{"a":"很长的值"}'), "a=很长的值");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the journal survives a restart and keeps only the newest 100 records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-player-"));
  const path = join(directory, "player-ff5.jsonl");
  try {
    const journal = new PlayerJournal({ file: path });
    for (let index = 0; index < 105; index++) {
      journal.record({
        kind: "user",
        at: new Date(Date.parse("2026-11-03T10:00:00Z") + index * 1000).toISOString(),
        text: `消息 ${index}`,
      });
    }
    await journal.flush();
    const reloaded = await PlayerJournal.load({ file: path });
    assert.equal(reloaded.entries.length, 100);
    assert.equal(reloaded.entries[0]?.kind, "user");
    assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 100);
    assert.equal(reloaded.entries.at(-1)?.kind, "user");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

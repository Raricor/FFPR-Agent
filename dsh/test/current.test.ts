import assert from "node:assert/strict";
import test from "node:test";
import type { DetectionResult } from "../src/plugin/detect.ts";
import { currentReply, decideCurrent, readCurrent } from "../src/plugin/current.ts";

const OPEN_FF3: DetectionResult = { ok: true, running: ["ff3"] };

void test("exactly one detected game wins even when another engine started later", () => {
  const choice = decideCurrent({
    detected: OPEN_FF3,
    engines: [{ game: "ff5", startedAt: "2026-11-03T10:00:00.000Z" }],
    activities: [{ game: "ff6", at: "2026-11-03T11:00:00.000Z" }],
  });
  assert.deepEqual(choice, {
    game: "ff3",
    running: true,
    reason: "detection",
    since: null,
  });
});

void test("two detected games fall through to the most recently started engine", () => {
  const choice = decideCurrent({
    detected: { ok: true, running: ["ff3", "ff5"] },
    engines: [
      { game: "ff3", startedAt: "2026-11-03T10:00:00.000Z" },
      { game: "ff5", startedAt: "2026-11-03T10:05:00.000Z" },
    ],
  });
  assert.equal(choice.game, "ff5");
  assert.equal(choice.reason, "engine");
  assert.equal(choice.running, true);
});

void test("without an engine the newest activity log decides, and detection says running", () => {
  const choice = decideCurrent({
    detected: { ok: false, error: "查不了" },
    activities: [
      { game: "ff3", at: "2026-11-03T09:00:00.000Z" },
      { game: "ff6", at: "2026-11-03T10:00:00.000Z" },
    ],
  });
  assert.equal(choice.game, "ff6");
  assert.equal(choice.reason, "activity");
  assert.equal(choice.running, false);
});

void test("nothing to go on falls back to ff5 and says it is not running", () => {
  assert.deepEqual(decideCurrent(), {
    game: "ff5",
    running: false,
    reason: "fallback",
    since: null,
  });
});

void test("readCurrent asks for activity logs only when detection and engines cannot decide", async () => {
  let reads = 0;
  const source = {
    detection: {
      peek: () => ({ result: OPEN_FF3, fresh: true, pending: false }),
    },
    engines: () => [],
    activities: () => {
      reads += 1;
      return Promise.resolve([{ game: "ff6", at: "2026-11-03T10:00:00.000Z" }]);
    },
  };
  assert.equal((await readCurrent(source)).game, "ff3");
  assert.equal(reads, 0);
  const none = await readCurrent({
    ...source,
    detection: {
      peek: () => ({ result: undefined, fresh: false, pending: false }),
    },
  });
  assert.equal(none.game, "ff6");
  assert.equal(reads, 1);
});

void test("the reply names the game in Chinese for the sidebar", () => {
  const reply = currentReply(
    {
      game: "ff5",
      running: true,
      reason: "detection",
      since: null,
    },
    "2026-11-03T10:00:00.000Z",
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.label, "FF5");
  assert.equal(reply.name, "最终幻想V");
  assert.equal(reply.title, "FF5 · 最终幻想V");
  assert.equal(reply.running, true);
});

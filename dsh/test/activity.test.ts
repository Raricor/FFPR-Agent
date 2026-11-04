import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ActivityLog,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_TEXT,
  mergeActivity,
} from "../src/engine/activity.ts";
import { Redactor } from "../src/engine/redact.ts";

async function inTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-activity-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function clock(start = "2026-10-29T10:00:00.000Z"): {
  readonly now: () => Date;
  readonly set: (iso: string) => void;
} {
  let at = Date.parse(start);
  return {
    now: () => new Date(at),
    set: (iso: string) => {
      at = Date.parse(iso);
    },
  };
}

/** One second per record, so the merged order does not depend on equal timestamps. */
function stepping(start: string): () => Date {
  let at = Date.parse(start);
  return () => {
    const value = new Date(at);
    at += 1000;
    return value;
  };
}

void test("activity keeps one line, redacts secrets, and caps the text at 200 characters", () => {
  const redactor = new Redactor();
  redactor.add("super-secret");
  const log = new ActivityLog({
    game: "ff5",
    redact: (value) => redactor.redact(value),
    now: clock().now,
  });
  log.record("tool", "第一行 super-secret\n第二行");
  assert.equal(log.entries[0]?.text, "第一行 ***");
  log.record("error", "长".repeat(MAX_TEXT + 20));
  const long = log.entries[1]?.text ?? "";
  assert.equal(Array.from(long).length, MAX_TEXT);
  assert.ok(long.endsWith("…"));
  // A blank line would render as an empty row; it is not recorded.
  log.record("link", "\n");
  assert.equal(log.entries.length, 2);
});

void test("activity keeps the newest 500 entries", () => {
  const log = new ActivityLog({ game: "ff5", now: clock().now });
  for (let index = 0; index < MAX_ENTRIES + 3; index += 1) {
    log.record("tool", `第 ${index} 次`);
  }
  assert.equal(log.entries.length, MAX_ENTRIES);
  assert.equal(log.entries[0]?.text, "第 3 次");
  assert.equal(log.last?.text, `第 ${MAX_ENTRIES + 2} 次`);
});

void test("activity appends to the JSONL file and loads the tail back", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "activity-ff5.jsonl");
    const first = new ActivityLog({ game: "ff5", file, now: clock().now });
    first.record("tool", "走了两步");
    first.record("event", "队伍 巴兹 入队");
    await first.flush();
    const body = await readFile(file, "utf8");
    assert.equal(body.trim().split("\n").length, 2);

    const restored = await ActivityLog.load({ game: "ff5", file });
    assert.deepEqual(
      restored.entries.map((entry) => entry.text),
      ["走了两步", "队伍 巴兹 入队"],
    );
    assert.deepEqual(
      restored.entries.map((entry) => entry.kind),
      ["tool", "event"],
    );
  });
});

void test("a broken line in the log file is skipped", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "activity-ff5.jsonl");
    await writeFile(
      file,
      '{"at":"2026-10-29T10:00:00.000Z","game":"ff5","kind":"tool","text":"好的"}\n{broken\n',
      "utf8",
    );
    const restored = await ActivityLog.load({ game: "ff5", file });
    assert.equal(restored.entries.length, 1);
    assert.equal(restored.entries[0]?.text, "好的");
  });
});

void test("a write failure warns once and does not reject", async () => {
  await inTemp(async (dir) => {
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "x", "utf8");
    const warnings: string[] = [];
    const log = new ActivityLog({
      game: "ff5",
      file: join(blocker, "activity.jsonl"),
      now: clock().now,
      warn: (message) => warnings.push(message),
    });
    log.record("tool", "第一次");
    log.record("tool", "第二次");
    await log.flush();
    assert.equal(warnings.length, 1);
    assert.equal(log.entries.length, 2);
  });
});

void test("activity files over 5 MB rotate to .1 at startup", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "activity-ff5.jsonl");
    await writeFile(file, "x".repeat(MAX_FILE_BYTES + 1), "utf8");
    await writeFile(`${file}.1`, "old", "utf8");
    const log = await ActivityLog.load({ game: "ff5", file });
    assert.equal(log.entries.length, 0);
    await assert.rejects(stat(file), /ENOENT/);
    assert.equal((await stat(`${file}.1`)).size, MAX_FILE_BYTES + 1);
  });
});

void test("mergeActivity filters by since, game and limit, newest first", () => {
  const ff5 = new ActivityLog({ game: "ff5", now: stepping("2026-10-29T10:00:00.000Z") });
  const ff6 = new ActivityLog({ game: "ff6", now: stepping("2026-10-29T10:00:02.000Z") });
  ff5.record("tool", "五之一");
  ff5.record("tool", "五之二");
  ff6.record("event", "六之一");
  ff6.record("tool", "六之二");

  const all = mergeActivity([ff5, ff6]);
  assert.deepEqual(
    all.map((entry) => entry.text),
    ["六之二", "六之一", "五之二", "五之一"],
  );
  assert.deepEqual(
    mergeActivity([ff5, ff6], { game: "ff5" }).map((entry) => entry.text),
    ["五之二", "五之一"],
  );
  assert.deepEqual(
    mergeActivity([ff5, ff6], { since: "2026-10-29T10:00:01.500Z" }).map((entry) => entry.text),
    ["六之二", "六之一"],
  );
  assert.deepEqual(
    mergeActivity([ff5, ff6], { limit: 2 }).map((entry) => entry.text),
    ["六之二", "六之一"],
  );
  assert.equal(mergeActivity([ff5], { limit: 0 }).length, 0);
  assert.equal(mergeActivity([ff5], { limit: 9999 }).length, 2);
});

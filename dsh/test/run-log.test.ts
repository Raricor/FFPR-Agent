/**
 * Task 158: the structured log writer always fills the fixed context fields and reports a bad
 * file once, never once per event.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRunEvents, RunLogger } from "../src/engine/run-log.ts";

void test("the run log fills at, run, chapter, segment, section and station on every line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-run-writer-"));
  try {
    const file = join(directory, "run-ff5.jsonl");
    const runLog = new RunLogger({
      game: "ff5",
      file,
      run: "r1",
      chapter: 2,
      segment: 1,
      section: "第二节",
    });
    runLog.record({ type: "station.start", station: 0, do: "move", to: "10:2,2", attempt: 1 });
    runLog.record({ type: "warn", reason: "测试" });
    await runLog.flush();
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      assert.equal(typeof parsed, "object");
      const event = parsed as Record<string, unknown>;
      assert.equal(typeof event.at, "string");
      assert.equal(event.run, "r1");
      assert.equal(event.chapter, 2);
      assert.equal(event.segment, 1);
      assert.equal(event.section, "第二节");
      assert.ok("station" in event);
    }
    const events = await readRunEvents(file);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.station, 0);
    assert.equal(events[1]?.station, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a failed write costs one warning, not one per event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-run-warn-"));
  try {
    // A directory cannot be appended to; the writer must keep running and warn once.
    const file = join(directory, "not-a-file");
    await mkdir(file);
    const warnings: string[] = [];
    const runLog = new RunLogger({
      game: "ff5",
      file,
      run: "r1",
      warn: (message) => warnings.push(message),
    });
    runLog.record({ type: "warn", reason: "一" });
    runLog.record({ type: "warn", reason: "二" });
    await runLog.flush();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /写不了执行日志/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

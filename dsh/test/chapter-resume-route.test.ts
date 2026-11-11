/**
 * Task 155: the operator route is a POST on the same authenticated connection. The route only
 * chooses the game and action; the runner does the work.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { chapterResumeRoute, CHAPTER_RESUME_ROUTE } from "../src/plugin/panel.ts";
import type { ChapterRunner } from "../src/plugin/player.ts";

function runner(calls: string[]): ChapterRunner {
  return {
    game: "ff5",
    runningChapter: () => 2,
    state: () => ({ chapter: 2, status: "running" }),
    disarmGoal: () => undefined,
    start: () => Promise.resolve(),
    resume: () => {
      calls.push("resume");
      return Promise.resolve({ chapter: 2, text: "已开始续跑第 2 章" });
    },
    abandon: () => {
      calls.push("abandon");
      return Promise.resolve("第 2 章的执行已结束,规则文件可以重新提交");
    },
  };
}

void test("POST chapter/resume starts the runner from the saved progress", async () => {
  const calls: string[] = [];
  const route = chapterResumeRoute(undefined, () => runner(calls));
  assert.equal(route.path, CHAPTER_RESUME_ROUTE);
  assert.deepEqual(route.methods, ["POST"]);
  const response = await route.fetch(
    new Request(`http://web${CHAPTER_RESUME_ROUTE}?game=ff5`, {
      method: "POST",
      body: JSON.stringify({ action: "resume" }),
    }),
  );
  const body: unknown = await response.json();
  assert.deepEqual(calls, ["resume"]);
  assert.equal((body as { ok?: boolean }).ok, true);
  assert.match((body as { text?: string }).text ?? "", /续跑第 2 章/u);
});

void test("POST --abandon hands planning back through the same route", async () => {
  const calls: string[] = [];
  const route = chapterResumeRoute(undefined, () => runner(calls));
  const response = await route.fetch(
    new Request(`http://web${CHAPTER_RESUME_ROUTE}?game=ff5&action=abandon`, {
      method: "POST",
      body: "{}",
    }),
  );
  const body: unknown = await response.json();
  assert.deepEqual(calls, ["abandon"]);
  assert.equal((body as { ok?: boolean }).ok, true);
  assert.match((body as { text?: string }).text ?? "", /规则文件可以重新提交/u);
});

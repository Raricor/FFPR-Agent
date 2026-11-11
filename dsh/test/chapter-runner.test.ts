/**
 * Task 155: submit hands the chapter to code. These tests use a fake host, slot and goal
 * service: a done run rearms goal rounds and asks for the next chapter, a blocked run stays
 * quiet, and the edit tools are refused while the executor owns the chapter.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ActivityLog } from "../src/engine/activity.ts";
import { INTERNAL_CHAPTER_RUN, type Game } from "../src/engine/game.ts";
import type { ChapterPlan, ChapterReport } from "../src/engine/plan/chapter-types.ts";
import { chapterBusyText } from "../src/engine/plan/chapter-tools.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";
import {
  chapterToolGuard,
  createChapterRunner,
  gameToolHost,
  type ChapterGate,
  type ChapterGoalService,
} from "../src/plugin/player.ts";
import type { EngineSlot } from "../src/plugin/registry.ts";
import type { GameToolHost } from "../src/plugin/tools.ts";
import { testChapterPlan, testSegmentPlan, testStation } from "./chapter-fixture.ts";
import { FakePilot } from "./fake-pilot.ts";

function plan(): ChapterPlan {
  return testChapterPlan({
    chapter: 2,
    segments: [testSegmentPlan("第二迷宫", [testStation({ to: "10:1,1", do: "move" })])],
  });
}

function report(chapter: number, status: ChapterReport["status"]): ChapterReport {
  return {
    chapter,
    status,
    segments: [],
    fallbacks: [],
    minutes: 1,
    modelCalls: 0,
    ...(status === "exception"
      ? {
          exception: {
            kind: "stuck" as const,
            segment: 0,
            station: 0,
            detail: "走不过去",
          },
        }
      : {}),
    ...(status === "blocked" ? { blockedText: "等待修复：第 1 节第 1 站：走不过去" } : {}),
  };
}

interface FakeWorld {
  readonly runner: ReturnType<typeof createChapterRunner>;
  readonly agent: Agent;
  readonly followups: string[];
  readonly calls: string[];
  readonly resumed: number[];
  readonly disarmed: number;
  readonly gate: ChapterGate;
  readonly engine: PlayerEngine;
}

function world(next: ChapterReport, hold = false): FakeWorld {
  const followups: string[] = [];
  const calls: string[] = [];
  const resumed: number[] = [];
  const gate = { chapter: null as number | null };
  let disarmed = 0;
  const chapter = plan();
  const game = {
    chapterPlans: { current: chapter },
    lastChapterReport: null as ChapterReport | null,
    abandonChapter: (reason: string) => Promise.resolve(`已放弃:${reason}`),
  } as unknown as Game;
  const activity = {
    entries: [],
    record: () => undefined,
    beginTool: () => undefined,
    endTool: () => undefined,
  } as unknown as ActivityLog;
  const engine = {
    stop: new AbortController(),
    activity,
    game,
  } as unknown as PlayerEngine;
  const slot: EngineSlot = {
    game: "ff5",
    current: () => engine,
    ensure: () => Promise.resolve(engine),
    stop: () => undefined,
  };
  const host = {
    pilot: () => new FakePilot(),
    run: async (name: string, _args: unknown, _pilot: unknown, signal: AbortSignal) => {
      calls.push(name);
      if (hold) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
      }
      game.lastChapterReport = next;
      return "ok";
    },
  } as unknown as Pick<GameToolHost, "pilot" | "run">;
  const goals: ChapterGoalService = {
    get: () =>
      ({
        id: "goal-1",
        revision: 7,
        phase: "active",
        activation: "armed",
      }) as unknown as ReturnType<ChapterGoalService["get"]>,
    disarm: () => {
      disarmed += 1;
    },
    resume: (_agent, ref) => {
      resumed.push(ref.revision);
    },
  };
  const runner = createChapterRunner({
    slot,
    host,
    gate,
    goals: () => goals,
    log: { warn: () => undefined },
  });
  const agent = {
    id: "agent-1",
    followup: (message: { content: readonly { type: string; text?: string }[] }) => {
      followups.push(message.content.map((part) => part.text ?? "").join(""));
    },
  } as unknown as Agent;
  return {
    runner,
    agent,
    followups,
    calls,
    resumed,
    get disarmed() {
      return disarmed;
    },
    gate,
    engine,
  };
}

async function settle(runner: ReturnType<typeof createChapterRunner>): Promise<void> {
  for (let step = 0; step < 50 && runner.runningChapter() !== null; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

void test("submit starts the internal executor, disarms goal rounds and asks for the next chapter", async () => {
  const box = world(report(2, "done"));
  await box.runner.start(plan(), box.agent);
  await settle(box.runner);
  assert.deepEqual(box.calls, [INTERNAL_CHAPTER_RUN]);
  assert.equal(box.disarmed, 1);
  assert.deepEqual(box.resumed, [7], "跑完后恢复自动续轮");
  assert.equal(box.gate.chapter, null);
  assert.equal(box.runner.state(), null, "done 后工具不再被挡");
  assert.deepEqual(box.followups.length, 1);
  assert.match(box.followups[0] ?? "", /第 2 章已跑完/u);
  assert.match(box.followups[0] ?? "", /请规划第 3 章/u);
  assert.equal(
    chapterToolGuard(() => box.runner.state())({ name: "create_goal" } as never),
    undefined,
  );
});

void test("a blocked chapter does not call the model and keeps the gate closed", async () => {
  const box = world(report(2, "blocked"));
  await box.runner.start(plan(), box.agent);
  await settle(box.runner);
  assert.equal(box.followups.length, 0);
  assert.deepEqual(box.resumed, []);
  assert.equal(box.gate.chapter, 2);
  assert.equal(box.gate.status, "blocked");
  assert.equal(box.runner.runningChapter(), null, "blocked 不是 running");
  assert.deepEqual(box.runner.state(), { chapter: 2, status: "blocked" });
});

void test("chapter draft and submit tools answer immediately while the executor runs", async () => {
  const engine = {
    activity: { beginTool: () => undefined, endTool: () => undefined },
    game: { run: () => Promise.resolve("当前章状态") },
  } as unknown as PlayerEngine;
  const host = gameToolHost(
    {
      game: "ff5",
      current: () => engine,
      ensure: () => Promise.resolve(engine),
      stop: () => undefined,
    },
    undefined,
    undefined,
    () => ({ chapter: 4, status: "running" }),
  );
  const busy = chapterBusyText({ chapter: 4, status: "running" });
  for (const name of ["chapter_draft_segment", "chapter_draft_meta", "submit_chapter_plan"]) {
    const text = await host.run(name, {}, new FakePilot(), new AbortController().signal);
    assert.equal(text, busy, name);
  }
  const other = await host.run("chapter_status", {}, new FakePilot(), new AbortController().signal);
  assert.equal(other, "当前章状态", "只有改规则的工具被挡");
});

void test("a blocked chapter also refuses a submit until the operator abandons it", async () => {
  let owner: { chapter: number; status: "running" | "blocked" } | null = {
    chapter: 4,
    status: "blocked",
  };
  const engine = {
    activity: { beginTool: () => undefined, endTool: () => undefined },
    game: { run: () => Promise.resolve("接收了") },
  } as unknown as PlayerEngine;
  const host = gameToolHost(
    {
      game: "ff5",
      current: () => engine,
      ensure: () => Promise.resolve(engine),
      stop: () => undefined,
    },
    undefined,
    undefined,
    () => owner,
  );
  const busy = chapterBusyText({ chapter: 4, status: "blocked" });
  const refused = await host.run(
    "submit_chapter_plan",
    {},
    new FakePilot(),
    new AbortController().signal,
  );
  assert.equal(refused, busy);
  assert.match(refused, /等待开发修复/u);
  owner = null;
  const accepted = await host.run(
    "submit_chapter_plan",
    {},
    new FakePilot(),
    new AbortController().signal,
  );
  assert.equal(accepted, "接收了", "--abandon 之后可以重新交");
});

void test("abandon clears the gate and hands planning back to the model", async () => {
  const box = world(report(2, "aborted"), true);
  await box.runner.start(plan(), box.agent);
  assert.equal(box.gate.chapter, 2);
  const text = await box.runner.abandon(new AbortController().signal);
  assert.match(text, /已放弃/u);
  assert.equal(box.gate.chapter, null);
  assert.equal(box.runner.state(), null);
  assert.equal(box.runner.runningChapter(), null);
  assert.equal(box.followups.length, 1);
  assert.match(box.followups[0] ?? "", /规划权交回你/u);
  assert.match(box.followups[0] ?? "", /操作员已结束第 2 章/u);
});

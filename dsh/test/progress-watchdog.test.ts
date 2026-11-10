import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GoalId } from "@deepseek-ai/dsh-goal/types";
import { ActivityLog } from "../src/engine/activity.ts";
import {
  ProgressWatchdog,
  isProgress,
  type GoalServiceLike,
  type GoalViewLike,
  type ProgressBuffer,
} from "../src/plugin/progress-watchdog.ts";

const AGENT = { id: "agent-1" } as unknown as Agent;
const GOAL_ID = "goal-1" as GoalId;

class FakeBuffer implements ProgressBuffer {
  readonly lines: string[] = [];

  get size(): number {
    return this.lines.length;
  }

  since(start: number): readonly string[] {
    return this.lines.slice(start);
  }

  push(...lines: string[]): void {
    this.lines.push(...lines);
  }
}

interface PauseCall {
  readonly agent: Agent;
  readonly id: GoalId;
  readonly revision: number;
}

function fakeGoals(phase = "active"): {
  readonly service: GoalServiceLike;
  readonly pauses: PauseCall[];
} {
  const pauses: PauseCall[] = [];
  let view: GoalViewLike = { id: GOAL_ID, revision: 7, phase };
  const service: GoalServiceLike = {
    get: () => view,
    pause: (agent, ref) => {
      pauses.push({ agent, id: ref.id, revision: ref.revision });
      view = { ...view, phase: "paused", revision: ref.revision + 1 };
      return view;
    },
  };
  return { service, pauses };
}

function setup(goals: () => GoalServiceLike | undefined = () => fakeGoals().service): {
  readonly buffer: FakeBuffer;
  readonly activity: ActivityLog;
  readonly watchdog: ProgressWatchdog;
  readonly warnings: string[];
} {
  const buffer = new FakeBuffer();
  const activity = new ActivityLog({ game: "ff5" });
  const warnings: string[] = [];
  const watchdog = new ProgressWatchdog({
    stallRounds: 3,
    goals,
    buffer: () => buffer,
    activity: () => activity,
    warn: (message) => warnings.push(message),
  });
  return { buffer, activity, watchdog, warnings };
}

function round(
  watchdog: ProgressWatchdog,
  buffer: FakeBuffer,
  lines: readonly string[] = [],
): void {
  watchdog.begin(AGENT);
  buffer.push(...lines);
  watchdog.end(AGENT);
}

void test("three consecutive rounds with no progress pause the goal and log why", () => {
  const { service, pauses } = fakeGoals();
  const { buffer, activity, watchdog } = setup(() => service);

  round(watchdog, buffer, ["go {} → 走到了 (1,1)"]);
  round(watchdog, buffer, ["look_around {} → 地图 1"]);
  assert.equal(pauses.length, 0);
  round(watchdog, buffer, ["interact {} → 调查了柜台"]);

  assert.equal(pauses.length, 1);
  const pause = pauses[0];
  assert.ok(pause);
  assert.equal(pause.agent, AGENT);
  assert.equal(pause.id, GOAL_ID);
  assert.equal(pause.revision, 7);
  const entry = activity.entries.find((item) => item.text.startsWith("目标暂停"));
  assert.ok(entry, "暂停要写进活动日志");
  assert.equal(entry.kind, "event");
  assert.match(entry.text, /连续 3 轮没有进展/);
  assert.match(entry.text, /最后几轮:/);
});

void test("one round with a progress signal clears the miss count", () => {
  const { service, pauses } = fakeGoals();
  const { buffer, watchdog } = setup(() => service);

  round(watchdog, buffer, ["go {} → 走到了 (1,1)"]);
  round(watchdog, buffer, ["go {} → 走到了 (1,2)"]);
  round(watchdog, buffer, ["地点 首次到达「图尔村」"]);
  round(watchdog, buffer, ["go {} → 走到了 (2,2)"]);
  round(watchdog, buffer, ["go {} → 走到了 (2,3)"]);
  assert.equal(pauses.length, 0, "有进展后要重新数满 3 轮");
  round(watchdog, buffer, ["go {} → 走到了 (2,4)"]);
  assert.equal(pauses.length, 1);
});

void test("without a goal service the watchdog does nothing", () => {
  const { buffer, activity, watchdog, warnings } = setup(() => undefined);

  for (let index = 0; index < 3; index += 1) {
    round(watchdog, buffer, ["go {} → 走到了 (1,1)"]);
  }
  assert.equal(activity.entries.length, 0);
  assert.deepEqual(warnings, []);
});

void test("a paused or completed goal is not paused again", () => {
  const { service, pauses } = fakeGoals("complete");
  const { buffer, activity, watchdog } = setup(() => service);

  for (let index = 0; index < 4; index += 1) {
    round(watchdog, buffer, ["go {} → 走到了 (1,1)"]);
  }
  assert.equal(pauses.length, 0);
  assert.equal(activity.entries.length, 0);
});

void test("the documented progress signals count, and near misses do not", () => {
  const progress = [
    "地点 首次到达「图尔村」",
    "宝箱 地图 5:凤凰之尾",
    "剧情 巴兹:我们走吧",
    "首领 击败「巨翼猛禽」",
    "升级 巴兹 10→11",
    "存档到 20 号位",
    "图鉴 新增怪物 #12",
    "grind {} → 刷了 5 场；学到 白风；停:青魔法已学会",
    "grind {} → 刷了 3 场；登记了 哥布林；停:图鉴已登记",
    "购买 治疗药 2 个",
  ];
  for (const line of progress) assert.equal(isProgress(line), true, line);
  for (const line of [
    "go {} → 走到了 (1,1)",
    "grind {} → 刷了 3 场；没有新登记；没学到新青魔法；停:时间到",
    'remember {"note":"宝箱 (9,6) 是陷阱"} → 已记下(第 2 条)',
  ]) {
    assert.equal(isProgress(line), false, line);
  }
});

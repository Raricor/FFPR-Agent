/**
 * Task 107: stop a goal that has stopped making progress. At the end of every round the
 * watchdog reads the activity log and the key-event stream; a round with no new map, chest,
 * story, boss, level, save, bestiary entry, blue magic or purchase counts as a miss. After
 * `goalStallRounds` misses in a row it pauses the active goal through the documented
 * `GoalService.pause` API (@deepseek-ai/dsh-goal README.zh 「观察 goal」) and records why.
 *
 * Pausing, not blocking: `blocked` means a stable blocker chosen by the model, while a silent
 * stretch of rounds only means the run is not moving. Without a goal service this does nothing.
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GoalId } from "@deepseek-ai/dsh-goal/types";
import type { ActivityLog } from "../engine/activity.ts";
import { describeError } from "../engine/errors.ts";

/** The part of a goal view the watchdog needs; `GoalView` satisfies it. */
export interface GoalViewLike {
  readonly id: GoalId;
  readonly revision: number;
  readonly phase: string;
}

/** The documented read/pause half of `ctx.goals` (@deepseek-ai/dsh-goal). */
export interface GoalServiceLike {
  get(agent: Agent): GoalViewLike | undefined;
  pause(agent: Agent, ref: { readonly id: GoalId; readonly revision: number }): unknown;
}

/** New lines from one round. `size` is a monotonic cursor; `since` returns what followed it. */
export interface ProgressBuffer {
  readonly size: number;
  since(start: number): readonly string[];
}

export interface ProgressWatchdogOptions {
  /** Consecutive rounds with no progress before the goal is paused (Config, default 3). */
  readonly stallRounds: number;
  readonly goals: () => GoalServiceLike | undefined;
  readonly buffer: () => ProgressBuffer | undefined;
  readonly activity: () => Pick<ActivityLog, "record"> | undefined;
  readonly warn: (message: string) => void;
}

/**
 * One line in the activity log or key-event stream that means the round moved the game forward.
 * Key-event lines are `${LABEL[type]} ${text}`, so the label anchors a real event and a note
 * that merely mentions 宝箱 in its arguments does not count.
 */
const PROGRESS_SIGNALS: readonly RegExp[] = [
  /^地点 首次到达/u,
  /^宝箱 /u,
  /^剧情 /u,
  /^首领 击败/u,
  /^升级 /u,
  /^购买 /u,
  /^图鉴 新增怪物/u,
  /存档到 \d+ 号位/u,
  /(?:^|[；;])学到 /u,
  /登记了 /u,
  /图鉴已登记/u,
];

export function isProgress(line: string): boolean {
  return PROGRESS_SIGNALS.some((pattern) => pattern.test(line));
}

/** What a miss round did, short enough for the pause reason. */
function summarize(lines: readonly string[]): string {
  const meaningful = lines.map((line) => line.trim()).filter((line) => line !== "");
  if (meaningful.length === 0) return "没有留下操作记录";
  const text = meaningful.slice(-2).join("；");
  const points = Array.from(text);
  return points.length <= 120 ? text : points.slice(0, 119).join("") + "…";
}

export class ProgressWatchdog {
  private readonly options: ProgressWatchdogOptions;
  private readonly misses = new Map<string, number>();
  private readonly starts = new Map<string, number>();
  private readonly lastRounds = new Map<string, string[]>();

  constructor(options: ProgressWatchdogOptions) {
    this.options = {
      ...options,
      stallRounds: Math.max(1, Math.trunc(options.stallRounds)),
    };
  }

  /** Mark the start of a round; the next `end` reads only what came after this point. */
  begin(agent: Agent): void {
    this.starts.set(agent.id, this.options.buffer()?.size ?? 0);
  }

  /** Finish a round and pause the goal once consecutive misses reach the configured limit. */
  end(agent: Agent): void {
    const goals = this.options.goals();
    if (goals === undefined) return;
    let goal: GoalViewLike | undefined;
    try {
      goal = goals.get(agent);
    } catch (error) {
      this.options.warn(`读目标失败,这轮不判进展:${describeError(error)}`);
      return;
    }
    if (goal?.phase !== "active") {
      this.forget(agent);
      return;
    }
    const start = this.starts.get(agent.id);
    this.starts.delete(agent.id);
    const buffer = this.options.buffer();
    const lines = start === undefined || buffer === undefined ? [] : buffer.since(start);
    if (lines.some(isProgress)) {
      this.misses.delete(agent.id);
      this.lastRounds.delete(agent.id);
      return;
    }
    const misses = (this.misses.get(agent.id) ?? 0) + 1;
    this.misses.set(agent.id, misses);
    const rounds = this.lastRounds.get(agent.id) ?? [];
    rounds.push(summarize(lines));
    if (rounds.length > this.options.stallRounds) rounds.shift();
    this.lastRounds.set(agent.id, rounds);
    if (misses >= this.options.stallRounds) this.pause(agent, goal, goals);
  }

  private forget(agent: Agent): void {
    this.misses.delete(agent.id);
    this.starts.delete(agent.id);
    this.lastRounds.delete(agent.id);
  }

  private pause(agent: Agent, goal: GoalViewLike, goals: GoalServiceLike): void {
    try {
      goals.pause(agent, { id: goal.id, revision: goal.revision });
    } catch (error) {
      this.options.warn(`暂停目标失败:${describeError(error)}`);
      return;
    }
    this.misses.delete(agent.id);
    const last = (this.lastRounds.get(agent.id) ?? []).join("；");
    this.lastRounds.delete(agent.id);
    this.options
      .activity()
      ?.record("event", `目标暂停:连续 ${this.options.stallRounds} 轮没有进展(最后几轮:${last})`);
  }
}

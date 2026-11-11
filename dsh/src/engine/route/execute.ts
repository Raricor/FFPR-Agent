/**
 * Route executor (task 87): walk an already ordered RoutePlan without asking the model at
 * every map or chest. Game actions come only through RoutePorts, so this module owns order,
 * deviation, stopping and the progress file and can be tested with doubles.
 *
 * The user's 11-05/11-10 direction: the AI names the destination, code plans the route, and
 * one tool call should finish a long stretch. The stages that still need a human/AI decision
 * (a boss, a shop without a purchase list, a story choice) are the few places that return.
 */

import type { Cell } from "../nav.ts";
import { readProgress, type RouteProgress, writeProgress } from "./state.ts";
import type { RouteLeg, RoutePlan, UnreachableWaypoint, Waypoint, WaypointKind } from "./types.ts";

/**
 * Task 87 defaults, taken from the 11-10 request; move them into the plugin Config when the
 * executor becomes a tool.
 */
export const DEFAULT_REPLAN_LIMIT = 5;
export const DEFAULT_MAX_WAYPOINT_FAILURES = 2;
export const DEFAULT_TIME_BUDGET_MS = 15 * 60 * 1000;
/** Task 129: a station interrupted by the story this many times is handed back to the AI. */
export const STORY_INTERRUPT_LIMIT = 3;

/** `describe` keeps plans to 30 lines for the model; run reports do the same. */
export const MAX_RESULT_LINES = 30;

/** Task 129: a walk that stopped on a story/dialog, from any of the walkers' markers. */
function interruptedByStory(text: string): boolean {
  return (
    /interrupted:(?:state:Event|dialog)/u.test(text) || /停在[^\n]*(?:Event|dialog)/u.test(text)
  );
}

export interface RoutePorts {
  position(): Promise<{ map: number; cell: Cell } | null>;
  /** Walk to the waypoint; the implementation is the existing `go` action. */
  goTo(stop: Waypoint): Promise<{ ok: boolean; text: string; decision?: string }>;
  /**
   * Do the waypoint's own action: open a chest, save, grind, advance story. inn/shop/boss/
   * places the executor has no plan for return `decision` and are handed back to the AI.
   */
  act(stop: Waypoint): Promise<{ ok: boolean; done: boolean; text: string; decision?: string }>;
  /**
   * Task 100: run the existing grind loop at a `grind` waypoint and return one line about
   * battles, registrations, learned blue magic and why it stopped. Omitted means the route
   * fails that waypoint instead of silently treating it as done.
   */
  grind?(stop: Waypoint): Promise<{ ok: boolean; done: boolean; text: string; decision?: string }>;
  /** Re-run analyzeRoute from where the party actually is, over the waypoints left. */
  replan(
    from: { map: number; cell: Cell },
    rest: Waypoint[],
    end: Waypoint | null,
  ): Promise<RoutePlan>;
  /**
   * Task 129: page the story/dialog that stopped `goTo`, then the executor rereads the
   * position and walks on. Omitted keeps the old "hand the interruption back" behaviour.
   */
  story?(): Promise<{ readonly text: string; readonly decision?: string }>;
  /** Task 89: countdown and the game-over popup, read together so one bridge call covers both. */
  watch?(): Promise<RouteWatch | null>;
  /** Task 89: seconds to walk to `stop` and then from it to `end`; null when unreadable. */
  estimate?(
    from: { map: number; cell: Cell },
    stop: Waypoint,
    end: Waypoint | null,
  ): Promise<number | null>;
  /** Task 89: record a waypoint the countdown made us skip (a chest becomes a debt). */
  skip?(stop: Waypoint): Promise<void>;
}

/** Task 117: what the executor did with one waypoint; the book progress file follows it. */
export type WaypointEvent = "done" | "skipped" | "current";

/** Bridge 0.14.3's `timer`, or null on an older bridge that does not report it. */
export interface RouteTimer {
  readonly active: boolean;
  /** Remaining seconds; null when the bridge reports no number. */
  readonly seconds: number | null;
}

/** `gameover` is a Chinese line for the model, or null when the popup is not open. */
export interface RouteWatch {
  readonly timer: RouteTimer | null;
  readonly gameover: string | null;
}

export interface RouteRunOptions {
  /** Where to keep the resumable snapshot; omitted means do not persist. */
  readonly progressFile?: string;
  readonly replanLimit?: number;
  readonly maxWaypointFailures?: number;
  readonly timeBudgetMs?: number;
  readonly signal?: AbortSignal;
  /** Task 89: the final destination when it is not one of the waypoints. */
  readonly end?: Waypoint | null;
  /**
   * The original waypoints. A RouteLeg keeps only what it needs to be displayed, so `after`
   * and `minutes` are lost; passing them keeps those fields across replans. Without them
   * the executor rebuilds waypoints from the plan's legs and unreachable entries.
   */
  readonly waypoints?: readonly Waypoint[];
  /** Task 117: called after each waypoint, before the next one, for the book progress file. */
  readonly onWaypoint?: (stop: Waypoint, event: WaypointEvent) => Promise<void> | void;
}

/** `resumeRoute` takes the same knobs except the file and the waypoints, which it reads. */
export type RouteResumeOptions = Omit<RouteRunOptions, "progressFile" | "waypoints">;

export type RouteStopReason =
  | "completed"
  | "decision"
  | "unreachable"
  | "failed"
  | "replan-limit"
  | "time-budget"
  | "gameover"
  | "aborted";

export interface RouteRunResult {
  readonly reason: RouteStopReason;
  /** Chinese explanation of why the run returned. */
  readonly message: string;
  /** What the AI should decide next, or null after a completed route. */
  readonly next: string | null;
  /** At most 30 lines: one per waypoint, deviations/replans, then the stop reason. */
  readonly text: string;
  readonly completed: readonly string[];
  readonly remaining: readonly Waypoint[];
  /** Task 89: waypoints the countdown skipped; the tool records these as debts. */
  readonly skipped: readonly Waypoint[];
  readonly replans: number;
  readonly elapsedMs: number;
}

const KIND_NAMES: Readonly<Record<WaypointKind | "end", string>> = {
  chest: "宝箱",
  grind: "刷怪",
  shop: "商店",
  inn: "旅馆",
  save: "存档",
  boss: "首领",
  move: "移动",
  story: "剧情",
  handoff: "交回",
  end: "终点",
};

async function reportWaypoint(
  options: RouteRunOptions,
  stop: Waypoint,
  event: WaypointEvent,
): Promise<void> {
  if (options.onWaypoint === undefined) return;
  await options.onWaypoint(stop, event);
}

interface RunSeed {
  readonly plan: RoutePlan;
  readonly pending: readonly Waypoint[];
  readonly completed: readonly string[];
  readonly next: number;
  readonly source: ReadonlyMap<string, Waypoint>;
}

function waypointFromLeg(leg: RouteLeg): Waypoint {
  if (leg.kind === "end") {
    return { id: leg.waypoint, kind: "move", map: leg.map, cell: leg.cell, label: leg.label };
  }
  return {
    id: leg.waypoint,
    kind: leg.kind,
    map: leg.map,
    cell: leg.cell,
    label: leg.label,
    ...(leg.until === undefined ? {} : { until: leg.until }),
  };
}

function waypointFromUnreachable(waypoint: UnreachableWaypoint): Waypoint {
  return {
    id: waypoint.id,
    kind: waypoint.kind,
    map: waypoint.map,
    cell: waypoint.cell,
    label: waypoint.label,
  };
}

/** Look up the full waypoint when the caller supplied one, otherwise rebuild what the plan has. */
function sourceOf(
  plan: RoutePlan,
  supplied: readonly Waypoint[] | undefined,
): ReadonlyMap<string, Waypoint> {
  const byId = new Map<string, Waypoint>();
  for (const waypoint of supplied ?? []) byId.set(waypoint.id, waypoint);
  for (const leg of plan.legs) {
    if (leg.waypoint !== "end" && !byId.has(leg.waypoint)) {
      byId.set(leg.waypoint, waypointFromLeg(leg));
    }
  }
  for (const waypoint of plan.unreachable) {
    if (!byId.has(waypoint.id)) byId.set(waypoint.id, waypointFromUnreachable(waypoint));
  }
  return byId;
}

/**
 * Everything the plan left to do, in plan order. A replan may drop unreachable waypoints from
 * `legs`; they stay here so the run can report them instead of pretending they were walked.
 */
function pendingOf(plan: RoutePlan, source: ReadonlyMap<string, Waypoint>): readonly Waypoint[] {
  const ids = new Set<string>();
  for (const leg of plan.legs) {
    if (leg.waypoint !== "end") ids.add(leg.waypoint);
  }
  for (const waypoint of plan.unreachable) ids.add(waypoint.id);
  const pending: Waypoint[] = [];
  for (const id of ids) {
    const waypoint = source.get(id);
    if (waypoint !== undefined) pending.push(waypoint);
  }
  return pending;
}

function targetOf(
  leg: RouteLeg,
  source: ReadonlyMap<string, Waypoint>,
  end: Waypoint | null,
): Waypoint {
  if (leg.waypoint === "end") {
    if (end !== null) return end;
    return {
      id: "end",
      kind: "move",
      map: leg.map,
      cell: leg.cell,
      label: leg.label,
    };
  }
  return source.get(leg.waypoint) ?? waypointFromLeg(leg);
}

function waypointLegCount(plan: RoutePlan): number {
  return plan.legs.filter((leg) => leg.waypoint !== "end").length;
}

function matchesPoint(
  position: { readonly map: number; readonly cell: Cell },
  map: number,
  cell: Cell | null,
): boolean {
  if (position.map !== map) return false;
  if (cell === null) return true;
  return position.cell[0] === cell[0] && position.cell[1] === cell[1];
}

function cellText(cell: Cell | null): string {
  return cell === null ? "任意格" : `(${cell[0]},${cell[1]})`;
}

function durationText(milliseconds: number): string {
  if (milliseconds <= 0) return "0 秒";
  if (milliseconds < 1000) return "不到 1 秒";
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)} 秒`;
  const minutes = milliseconds / 60_000;
  return minutes < 10 ? `${minutes.toFixed(1)} 分钟` : `${Math.round(minutes)} 分钟`;
}

function oneLine(value: string, limit = 80): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function waypointLabels(waypoints: readonly Waypoint[]): string {
  const shown = waypoints
    .slice(0, 8)
    .map((waypoint) => `「${waypoint.label}」`)
    .join("、");
  return waypoints.length > 8 ? `${shown}…（还有 ${waypoints.length - 8} 个）` : shown;
}

/** Task 100: drop every remaining grind stop when a countdown is already running. */
function grindIds(waypoints: readonly Waypoint[]): Set<string> {
  return new Set(
    waypoints.filter((waypoint) => waypoint.kind === "grind").map((waypoint) => waypoint.id),
  );
}

function clampLines(lines: readonly string[]): readonly string[] {
  if (lines.length <= MAX_RESULT_LINES) return [...lines];
  const head = lines.slice(0, MAX_RESULT_LINES - 2);
  const last = lines[lines.length - 1];
  if (last === undefined) return [...head];
  return [...head, `…（还有 ${lines.length - head.length - 1} 行）`, last];
}

/**
 * Follow the plan until it is done or a stop condition is met. The initial position is read
 * once so a resumed plan that was made somewhere else replans instead of walking backwards.
 */
async function run(
  seed: RunSeed,
  ports: RoutePorts,
  options: RouteRunOptions,
): Promise<RouteRunResult> {
  const startedAt = Date.now();
  const budget = Math.max(0, options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const replanLimit = Math.max(0, options.replanLimit ?? DEFAULT_REPLAN_LIMIT);
  const failureLimit = Math.max(1, options.maxWaypointFailures ?? DEFAULT_MAX_WAYPOINT_FAILURES);
  const signal = options.signal;
  const progressFile = options.progressFile;
  const end = options.end ?? null;

  let plan = seed.plan;
  let legs = plan.legs;
  let next = seed.next;
  let pending = [...seed.pending];
  const completed = [...seed.completed];
  const skipped: Waypoint[] = [];
  let replans = 0;
  let failureId: string | null = null;
  let failures = 0;
  let lastFailure = "";
  let attemptId: string | null = null;
  let attemptStarted = startedAt;
  // Task 129: story interruptions of the current station; a different station starts at 0.
  let storyId: string | null = null;
  let storyStops = 0;
  let lastWatch: RouteWatch | null = null;
  const lines: string[] = [];

  const elapsed = (): number => Date.now() - startedAt;

  /** Task 89: a bridge without the fields, or a failed read, is not a reason to stop. */
  const watchNow = async (): Promise<RouteWatch | null> => {
    if (ports.watch === undefined) return null;
    try {
      lastWatch = await ports.watch();
      return lastWatch;
    } catch {
      return null;
    }
  };

  const gameoverOf = (watch: RouteWatch | null): string | null => watch?.gameover ?? null;

  const snapshot = (): RouteProgress => ({
    version: 1,
    plan,
    waypoints: [...pending],
    completed: [...completed],
    next,
    ...(end === null ? {} : { end }),
    updatedAt: new Date().toISOString(),
  });

  const save = async (): Promise<void> => {
    if (progressFile === undefined) return;
    await writeProgress(progressFile, snapshot());
  };

  const resultOf = (
    reason: RouteStopReason,
    message: string,
    nextStep: string | null,
  ): RouteRunResult => {
    const timer =
      lastWatch?.timer?.active === true && lastWatch.timer.seconds !== null
        ? `；倒计时剩 ${Math.max(0, Math.round(lastWatch.timer.seconds))} 秒`
        : "";
    const finalLine =
      reason === "completed"
        ? `完成：${completed.length} 个路标走完，用时 ${durationText(elapsed())}${timer}`
        : `停下：${message}${nextStep === null ? "" : `；交给 AI：${nextStep}`}${timer}`;
    return {
      reason,
      message,
      next: nextStep,
      text: clampLines([...lines, finalLine]).join("\n"),
      completed: [...completed],
      remaining: [...pending],
      skipped: [...skipped],
      replans,
      elapsedMs: elapsed(),
    };
  };

  const halt = async (
    reason: RouteStopReason,
    message: string,
    nextStep: string | null = null,
  ): Promise<RouteRunResult> => {
    await save();
    return resultOf(reason, message, nextStep);
  };

  const unreachableMessage = (): string => {
    const labels = waypointLabels(pending);
    const reasons = plan.unreachable
      .slice(0, 5)
      .map((waypoint) => `「${waypoint.label}」${oneLine(waypoint.reason, 30)}`)
      .join("；");
    return reasons === ""
      ? `剩下的路标走不到：${labels}`
      : `剩下的路标走不到：${labels}（${reasons}）`;
  };

  const replanFrom = async (
    from: { map: number; cell: Cell },
    why: string,
  ): Promise<RouteRunResult | null> => {
    if (pending.length === 0) return null;
    if (replans >= replanLimit) {
      return halt(
        "replan-limit",
        `偏离后要第 ${replans + 1} 次重排，超过上限 ${replanLimit}`,
        "由 AI 判断剩下的路标怎么走",
      );
    }
    const rest = [...pending];
    const newPlan = await ports.replan(from, rest, end);
    if (signal?.aborted) {
      return halt("aborted", "重排时收到取消信号", "由 AI 决定是否继续这条路线");
    }
    replans += 1;
    plan = newPlan;
    legs = newPlan.legs;
    next = 0;
    const count = waypointLegCount(newPlan);
    const dropped = newPlan.unreachable.length;
    lines.push(
      `重排：${why}；从 地图 ${from.map} ${cellText(from.cell)} 重排 ${rest.length} 个路标，` +
        `${count} 段${dropped === 0 ? "" : `，${dropped} 个走不到`}`,
    );
    await save();
    if (count === 0) {
      return halt("unreachable", unreachableMessage(), "由 AI 决定换目标、换路线或手动前往");
    }
    return null;
  };

  const recordFailure = async (
    target: Waypoint,
    detail: string,
  ): Promise<RouteRunResult | null> => {
    if (failureId === target.id) failures += 1;
    else {
      failureId = target.id;
      failures = 1;
    }
    lastFailure = oneLine(detail);
    if (failures < failureLimit) return null;
    lines.push(`失败：「${target.label}」连续 ${failures} 次，最后一次：${lastFailure}`);
    return halt(
      "failed",
      `「${target.label}」连续失败 ${failures} 次：${lastFailure}`,
      "由 AI 检查路况、战斗或手动完成这个路标",
    );
  };

  await save();

  if (signal?.aborted) {
    return halt("aborted", "收到取消信号，一步都没走", "由 AI 决定是否继续这条路线");
  }
  if (elapsed() >= budget) {
    return halt(
      "time-budget",
      `时间预算 ${durationText(budget)} 在出发前就用完`,
      "由 AI 决定是否继续这条路线",
    );
  }

  const start = await ports.position();
  const first = legs[next];
  if (
    start !== null &&
    first !== undefined &&
    pending.length > 0 &&
    !matchesPoint(start, first.from.map, first.from.cell)
  ) {
    lines.push(
      `偏离：出发时在 地图 ${start.map} ${cellText(start.cell)}，` +
        `计划从 地图 ${first.from.map} ${cellText(first.from.cell)} 出发`,
    );
    const stopped = await replanFrom(start, "出发时不在计划起点");
    if (stopped !== null) return stopped;
  }

  for (;;) {
    if (signal?.aborted) {
      return halt("aborted", "收到取消信号，已停下", "由 AI 决定是否继续这条路线");
    }
    if (elapsed() >= budget) {
      return halt(
        "time-budget",
        `时间预算 ${durationText(budget)} 用完，停在 ${waypointLabels(pending)}`,
        "由 AI 决定是否继续执行剩下的路线",
      );
    }
    const before = await watchNow();
    const gameover = gameoverOf(before);
    if (gameover !== null) {
      return halt("gameover", gameover, "由 AI 决定读档还是继续");
    }
    // Task 100: a running countdown skips every grind stop, optional or not. Record why in
    // the text and drop the stops together so the remaining walk still reaches the end.
    const timerNow = before?.timer ?? null;
    if (timerNow?.active === true) {
      const ids = grindIds(pending);
      if (ids.size > 0) {
        const dropped = pending.filter((waypoint) => ids.has(waypoint.id));
        pending = pending.filter((waypoint) => !ids.has(waypoint.id));
        legs = legs.filter((entry, index) => index < next || !ids.has(entry.waypoint));
        for (const waypoint of dropped) await reportWaypoint(options, waypoint, "skipped");
        const left =
          timerNow.seconds === null
            ? "倒计时进行中"
            : `倒计时剩 ${Math.max(0, Math.round(timerNow.seconds))} 秒`;
        lines.push(`${left}，跳过刷怪${waypointLabels(dropped)}：倒计时期间不刷怪`);
        await save();
        continue;
      }
    }
    if (next >= legs.length) {
      if (pending.length > 0) {
        return halt("unreachable", unreachableMessage(), "由 AI 决定换目标、换路线或手动前往");
      }
      return halt("completed", "全部路标完成");
    }

    const leg = legs[next];
    if (leg === undefined) return halt("completed", "全部路标完成");
    const target = targetOf(leg, seed.source, end);
    if (attemptId !== target.id) {
      attemptId = target.id;
      attemptStarted = Date.now();
    }

    // Task 89: before an optional stop, check whether the countdown can still afford it and
    // the walk from it to the end. If not, drop every remaining optional stop and go to the
    // end; the port records the skipped chests as debts.
    const timer = before?.timer ?? null;
    if (timer?.active === true && target.optional === true && timer.seconds !== null) {
      const here = await ports.position();
      const need =
        here === null || ports.estimate === undefined
          ? null
          : await ports.estimate(here, target, end);
      if (need !== null && need > timer.seconds) {
        const optionalIds = new Set(
          legs
            .slice(next)
            .filter((entry) => entry.waypoint !== "end")
            .map((entry) => entry.waypoint)
            .filter((id) => seed.source.get(id)?.optional === true),
        );
        const dropped = pending.filter((waypoint) => optionalIds.has(waypoint.id));
        for (const waypoint of dropped) {
          if (ports.skip !== undefined) await ports.skip(waypoint);
          skipped.push(waypoint);
          await reportWaypoint(options, waypoint, "skipped");
        }
        pending = pending.filter((waypoint) => !optionalIds.has(waypoint.id));
        legs = legs.filter((entry, index) => index < next || !optionalIds.has(entry.waypoint));
        lines.push(
          `倒计时剩 ${Math.max(0, Math.round(timer.seconds))} 秒，` +
            `预计还要 ${Math.ceil(need)} 秒，跳过${waypointLabels(dropped)}`,
        );
        await save();
        continue;
      }
    }

    let went = await ports.goTo(target);
    if (signal?.aborted) {
      return halt("aborted", `走到「${target.label}」后收到取消信号`, "由 AI 决定是否继续");
    }
    // Task 129: navigate pages a story itself; these markers mean it hit the handoff limit
    // or opened a choice, so the executor must not walk into it again.
    if (!went.ok && went.text.includes("interrupted:story-decision")) {
      lines.push(
        `${completed.length + 1}. ${KIND_NAMES[target.kind]}「${target.label}」：` +
          `路上出现剧情选项，${oneLine(went.text)}`,
      );
      return halt(
        "decision",
        `「${target.label}」路上出现剧情选项，交给 AI 选`,
        "由 AI 选完剧情选项后重新 route",
      );
    }
    if (!went.ok && went.text.includes("interrupted:story-limit")) {
      lines.push(
        `${completed.length + 1}. ${KIND_NAMES[target.kind]}「${target.label}」：` +
          `剧情连续打断 ${STORY_INTERRUPT_LIMIT} 次，先交回`,
      );
      return halt(
        "decision",
        `「${target.label}」剧情连续打断 ${STORY_INTERRUPT_LIMIT} 次`,
        "由 AI 翻完剧情后重新 route",
      );
    }
    if (!went.ok && ports.story !== undefined && interruptedByStory(went.text)) {
      if (storyId !== target.id) {
        storyId = target.id;
        storyStops = 0;
      }
      while (storyStops < STORY_INTERRUPT_LIMIT && !went.ok && interruptedByStory(went.text)) {
        storyStops += 1;
        const advanced = await ports.story();
        if (signal?.aborted) {
          return halt("aborted", `翻「${target.label}」路上的剧情时收到取消信号`, "由 AI 接手");
        }
        if (advanced.decision !== undefined && advanced.decision.trim() !== "") {
          lines.push(
            `${completed.length + 1}. ${KIND_NAMES[target.kind]}「${target.label}」：` +
              `翻完剧情后需要决定，${oneLine(advanced.text)}`,
          );
          return halt(
            "decision",
            oneLine(advanced.decision),
            `由 AI 决定：${oneLine(advanced.decision)}`,
          );
        }
        const here = await ports.position();
        if (
          here !== null &&
          (target.reach === "map"
            ? here.map === target.map
            : matchesPoint(here, target.map, target.cell))
        ) {
          went = { ok: true, text: "剧情翻完,已经在目标" };
          break;
        }
        // The third interruption is the limit: do not start a fourth walk.
        if (storyStops >= STORY_INTERRUPT_LIMIT) break;
        went = await ports.goTo(target);
        if (signal?.aborted) {
          return halt(
            "aborted",
            `翻完「${target.label}」的剧情后收到取消信号`,
            "由 AI 决定是否继续",
          );
        }
      }
      if (!went.ok && interruptedByStory(went.text)) {
        lines.push(
          `${completed.length + 1}. ${KIND_NAMES[target.kind]}「${target.label}」：` +
            `剧情连续打断 ${STORY_INTERRUPT_LIMIT} 次，先交回`,
        );
        return halt(
          "decision",
          `「${target.label}」剧情连续打断 ${STORY_INTERRUPT_LIMIT} 次`,
          "由 AI 翻完剧情后重新 route",
        );
      }
    }
    if (went.decision !== undefined && went.decision.trim() !== "") {
      lines.push(
        `${completed.length + 1}. ${KIND_NAMES[target.kind]}「${target.label}」：到了，` +
          (oneLine(went.text) || "需要决定"),
      );
      return halt("decision", oneLine(went.decision), `由 AI 决定：${oneLine(went.decision)}`);
    }
    if (!went.ok) {
      const stopped = await recordFailure(target, went.text);
      if (stopped !== null) return stopped;
      continue;
    }
    const afterGoWatch = await watchNow();
    const gone = gameoverOf(afterGoWatch);
    if (gone !== null) {
      return halt("gameover", gone, "由 AI 决定读档还是继续");
    }

    const afterGo = await ports.position();
    if (signal?.aborted) {
      return halt("aborted", `走到「${target.label}」后收到取消信号`, "由 AI 决定是否继续");
    }
    const reached =
      afterGo === null
        ? true
        : target.reach === "map"
          ? afterGo.map === leg.map
          : matchesPoint(afterGo, leg.map, leg.cell);
    if (!reached && afterGo !== null) {
      lines.push(
        `偏离：去「${target.label}」时到了 地图 ${afterGo.map} ${cellText(afterGo.cell)}，` +
          `计划是 地图 ${leg.map} ${cellText(leg.cell)}`,
      );
      const stopped = await replanFrom(afterGo, `去「${target.label}」时被带走`);
      if (stopped !== null) return stopped;
      continue;
    }

    if (elapsed() >= budget) {
      return halt(
        "time-budget",
        `时间预算 ${durationText(budget)} 用完，到了「${target.label}」`,
        "由 AI 决定是否继续执行剩下的路线",
      );
    }

    // Task 117: a route-book station with no coordinate stops here; the model does it and
    // the next `route {}` records the handoff and walks on.
    if (target.kind === "handoff") {
      await reportWaypoint(options, target, "current");
      lines.push(`${completed.length + 1}. 交回「${target.label}」：到了，交给 AI`);
      return halt("decision", target.label, target.label);
    }

    if (target.kind === "boss") {
      await reportWaypoint(options, target, "current");
      lines.push(
        `${completed.length + 1}. 首领「${target.label}」：到了门口，没有开战，` +
          durationText(Date.now() - attemptStarted),
      );
      return halt(
        "decision",
        `首领「${target.label}」在门口，交给 AI 决定战不战、怎么打`,
        "决定首领战的阵容、打法和是否现在开战",
      );
    }

    if (leg.waypoint === "end") {
      next += 1;
      lines.push(
        `${completed.length + 1}. 终点：到了，${durationText(Date.now() - attemptStarted)}`,
      );
      await save();
      continue;
    }

    // A countdown may have begun during the walk; do not start a grind under it either.
    const beforeActWatch = await watchNow();
    const timerAtAct = beforeActWatch?.timer ?? null;
    if (target.kind === "grind" && timerAtAct?.active === true) {
      const ids = grindIds(pending);
      const dropped = pending.filter((waypoint) => ids.has(waypoint.id));
      pending = pending.filter((waypoint) => !ids.has(waypoint.id));
      legs = legs.filter((entry, index) => index < next || !ids.has(entry.waypoint));
      for (const waypoint of dropped) await reportWaypoint(options, waypoint, "skipped");
      const left =
        timerAtAct.seconds === null
          ? "倒计时进行中"
          : `倒计时剩 ${Math.max(0, Math.round(timerAtAct.seconds))} 秒`;
      lines.push(`${left}，跳过刷怪${waypointLabels(dropped)}：倒计时期间不刷怪`);
      await save();
      continue;
    }
    const acted =
      target.kind === "grind" && ports.grind !== undefined
        ? await ports.grind(target)
        : await ports.act(target);
    const afterActWatch = await watchNow();
    const gameoverAfterAct = gameoverOf(afterActWatch);
    if (gameoverAfterAct !== null) {
      return halt("gameover", gameoverAfterAct, "由 AI 决定读档还是继续");
    }
    if (acted.decision !== undefined && acted.decision.trim() !== "") {
      await reportWaypoint(options, target, "current");
      lines.push(
        `${completed.length + 1}. ${KIND_NAMES[target.kind]}「${target.label}」：到了，` +
          (oneLine(acted.text) || "需要决定"),
      );
      if (signal?.aborted) {
        return halt("aborted", `「${target.label}」需要决定时收到取消信号`, "由 AI 接手这个决定");
      }
      return halt("decision", oneLine(acted.decision), `由 AI 决定：${oneLine(acted.decision)}`);
    }
    if (!acted.ok || !acted.done) {
      if (signal?.aborted) {
        return halt("aborted", `做完「${target.label}」后收到取消信号`, "由 AI 决定是否继续");
      }
      const stopped = await recordFailure(target, acted.text || "动作没有完成");
      if (stopped !== null) return stopped;
      continue;
    }

    if (!completed.includes(target.id)) completed.push(target.id);
    pending = pending.filter((waypoint) => waypoint.id !== target.id);
    next += 1;
    failureId = null;
    failures = 0;
    attemptId = null;
    storyId = null;
    storyStops = 0;
    lines.push(
      `${completed.length}. ${KIND_NAMES[target.kind]}「${target.label}」：到了，` +
        `${oneLine(acted.text) || "完成"}，${durationText(Date.now() - attemptStarted)}`,
    );
    await reportWaypoint(options, target, "done");
    await save();

    if (signal?.aborted) {
      return halt("aborted", `完成「${target.label}」后收到取消信号`, "由 AI 决定是否继续");
    }
    const afterAct = await ports.position();
    // Task 89: interact stands beside a chest or NPC, so only a map change is a deviation here.
    if (afterAct !== null && afterAct.map !== leg.map) {
      lines.push(
        `偏离：完成「${target.label}」后到了 地图 ${afterAct.map} ${cellText(afterAct.cell)}，` +
          `计划还在 地图 ${leg.map}`,
      );
      const stopped = await replanFrom(afterAct, `完成「${target.label}」后被移走`);
      if (stopped !== null) return stopped;
    }
  }
}

/** Execute one plan from its first leg. */
export async function executeRoute(
  plan: RoutePlan,
  ports: RoutePorts,
  options: RouteRunOptions = {},
): Promise<RouteRunResult> {
  const source = sourceOf(plan, options.waypoints);
  return run(
    {
      plan,
      pending: pendingOf(plan, source),
      completed: [],
      next: 0,
      source,
    },
    ports,
    options,
  );
}

/**
 * Continue the snapshot written by an earlier run. The current position is read before the
 * first leg; if the party is no longer where the saved plan expects, the executor replans.
 */
export async function resumeRoute(
  file: string,
  ports: RoutePorts,
  options: RouteResumeOptions = {},
): Promise<RouteRunResult> {
  const progress = await readProgress(file);
  const source = sourceOf(progress.plan, progress.waypoints);
  return run(
    {
      plan: progress.plan,
      pending: progress.waypoints,
      completed: progress.completed,
      next: progress.next,
      source,
    },
    ports,
    {
      ...options,
      progressFile: file,
      ...(progress.end === undefined ? {} : { end: progress.end }),
    },
  );
}

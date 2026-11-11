/**
 * Offline dry run of a chapter plan at submit time (task 154, 11-11). The live game showed
 * the model spending 70 minutes on 27 plans and 18 runs because unreachable stations were only
 * found by walking to them. The route estimator (`estimatePair`, task 127) already knows the
 * atlas, cached collision, regions and learned jump links, so the same question can be asked
 * before the plan is accepted.
 *
 * The walk is sequential: start where the party is, then every station of every segment in
 * plan order. An unreachable station is a real problem unless the previous reached station was
 * an event (`story`/`talk`/`switch`/`choose`/`boss`): that event may have moved the party or
 * opened the way, so it is only a warning. Chest and examine targets often cannot be stepped
 * on, so they are estimated from a reachable neighbouring cell, like the executor's `go`.
 *
 * Pure apart from the clock: no bridge, no file. The caller supplies the world and start.
 */

import type { Cell } from "../nav.ts";
import { estimatePair, type PairResult } from "../route/distance.ts";
import type { RoutePoint, RouteWorld } from "../route/types.ts";
import { parseTarget } from "./validate.ts";
import type { ChapterPlan } from "./chapter-types.ts";
import type { PlanStationAction } from "./types.ts";

/** The whole chapter must check in this time; a slower run is reported as unfinished. */
export const DRY_RUN_TIMEOUT_MS = 2_000;

/** Stations whose action can move the party or change the map under it. */
const CHANGER_ACTIONS: ReadonlySet<PlanStationAction> = new Set([
  "story",
  "talk",
  "switch",
  "choose",
  "boss",
]);

/**
 * Actions that stop beside the target when the target cell itself is not walkable. This is the
 * executor's rule: `open`/`talk` walk beside a chest or NPC, a `switch` may be a wall fixture,
 * and a boss that is an object is faced from the cell below first.
 */
const BESIDE_ACTIONS: ReadonlySet<PlanStationAction> = new Set(["open", "talk", "switch", "boss"]);

/** Below, above, right, left: the boss-side order from `plan/execute.ts`. */
const BESIDE_SIDES: readonly { readonly dx: number; readonly dy: number }[] = [
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
];

export interface DryRunResult {
  /** Unreachable with no event in between: these reject the plan. */
  readonly problems: readonly string[];
  /** Unreachable only after an event, or the timeout; the plan may still be saved. */
  readonly warnings: readonly string[];
  readonly timedOut: boolean;
}

export interface DryRunOptions {
  readonly timeoutMs?: number;
}

interface ChapterStop {
  readonly segment: number;
  readonly station: number;
  readonly action: PlanStationAction;
  readonly map: number;
  readonly cell: Cell | null;
}

interface ReachedStop {
  readonly point: RoutePoint;
  readonly changer: boolean;
}

function stopsOf(plan: ChapterPlan): ChapterStop[] {
  const out: ChapterStop[] = [];
  for (const [segmentIndex, segment] of plan.segments.entries()) {
    for (const [stationIndex, station] of segment.stations.entries()) {
      const target = parseTarget(station.to);
      // A malformed target is already a chapter-validation problem; the dry run only checks
      // the stations it can read, so one typo does not hide the rest of the route.
      if (typeof target === "string") continue;
      out.push({
        segment: segmentIndex,
        station: stationIndex,
        action: station.do,
        map: target.mapId,
        cell: target.cell,
      });
    }
  }
  return out;
}

function pointOf(stop: ChapterStop): RoutePoint {
  return { map: stop.map, cell: stop.cell };
}

function pointText(point: RoutePoint): string {
  return point.cell === null
    ? `图 ${point.map} 任意格`
    : `图 ${point.map}:${point.cell[0]},${point.cell[1]}`;
}

function stopText(stop: ChapterStop): string {
  return `第 ${stop.segment + 1} 段第 ${stop.station + 1} 站 (${pointText(pointOf(stop))})`;
}

function besidePoints(map: number, cell: Cell): RoutePoint[] {
  return BESIDE_SIDES.map(({ dx, dy }) => ({
    map,
    cell: [cell[0] + dx, cell[1] + dy],
  }));
}

/**
 * Estimate the station and, for a target that cannot be stood on, the cheapest reachable side.
 * `reached` is the cell the party will actually stand on, so the next leg starts there.
 */
function estimateStop(
  world: RouteWorld,
  from: RoutePoint,
  stop: ChapterStop,
): { readonly pair: PairResult; readonly reached: RoutePoint } {
  const target = pointOf(stop);
  const exact = estimatePair(world, from, target);
  if (exact.ok) return { pair: exact, reached: target };
  if (!BESIDE_ACTIONS.has(stop.action) || target.cell === null) {
    return { pair: exact, reached: target };
  }
  let best: { readonly pair: PairResult; readonly reached: RoutePoint } | null = null;
  for (const side of besidePoints(target.map, target.cell)) {
    const pair = estimatePair(world, from, side);
    if (!pair.ok) continue;
    if (best === null || !best.pair.ok || pair.estimate.minutes < best.pair.estimate.minutes) {
      best = { pair, reached: side };
    }
  }
  if (best === null) {
    return {
      pair: {
        ok: false,
        reason: `目标格和旁边四格都走不到（${exact.reason}）`,
      },
      reached: target,
    };
  }
  return best;
}

function timeoutResult(): DryRunResult {
  return { problems: [], warnings: ["试走超时，未检查完"], timedOut: true };
}

/**
 * Walk the chapter plan offline. Both lists are Chinese and empty when the whole route is
 * reachable; `problems` rejects the submission, `warnings` does not.
 */
export function dryRunChapter(
  plan: ChapterPlan,
  start: { readonly map: number; readonly cell: Cell },
  world: RouteWorld,
  options: DryRunOptions = {},
): DryRunResult {
  const timeoutMs = options.timeoutMs ?? DRY_RUN_TIMEOUT_MS;
  const startedAt = performance.now();
  const timedOut = (): boolean => performance.now() - startedAt >= timeoutMs;

  const stops = stopsOf(plan);
  const problems: string[] = [];
  const warnings: string[] = [];
  let previous: ReachedStop = { point: start, changer: false };
  for (const stop of stops) {
    if (timedOut()) return timeoutResult();
    const estimated = estimateStop(world, previous.point, stop);
    if (estimated.pair.ok) {
      previous = {
        point: estimated.reached,
        changer: CHANGER_ACTIONS.has(stop.action),
      };
      continue;
    }
    const line =
      `${stopText(stop)} 从上一站 (${pointText(previous.point)}) 走不到：` + estimated.pair.reason;
    if (previous.changer) {
      warnings.push(`${line}（上一站是剧情/对话/机关/首领，可能改变位置或开路，只提醒）`);
    } else {
      problems.push(line);
    }
  }
  if (timedOut()) return timeoutResult();
  return { problems, warnings, timedOut: false };
}

/**
 * Route analysis (task 79): take the waypoints of one stage, estimate every directed pair
 * with `mapPath` (task 75) and cached collision, order them under their `after` constraints,
 * and return legs, unreachable waypoints and totals.
 *
 * It only plans. Executing the plan, watching for story triggers and calling the AI at a
 * decision point belong to the stage layer in a later task.
 */

import type { Cell } from "../nav.ts";
import { RegionIndex } from "../regions.ts";
import { estimatePair, type PairResult } from "./distance.ts";
import { orderStops, type OrderStop } from "./order.ts";
import type {
  PairEstimate,
  RouteInput,
  RouteLeg,
  RoutePlan,
  RoutePoint,
  RouteWorld,
  UnreachableWaypoint,
  Waypoint,
  WaypointKind,
} from "./types.ts";

function pointOf(map: number, cell: Cell | null): RoutePoint {
  return { map, cell };
}

function pairAt(matrix: readonly (readonly PairResult[])[], from: number, to: number): PairResult {
  const row = matrix[from];
  const pair = row?.[to];
  if (pair === undefined) throw new Error(`路线矩阵缺了 ${from} → ${to}`);
  return pair;
}

function dependsOn(
  index: number,
  target: string,
  waypoints: readonly Waypoint[],
  byId: ReadonlyMap<string, number>,
  seen: Set<number>,
): boolean {
  if (seen.has(index)) return false;
  seen.add(index);
  for (const id of waypoints[index]?.after ?? []) {
    if (id === target) return true;
    const next = byId.get(id);
    if (next !== undefined && dependsOn(next, target, waypoints, byId, seen)) return true;
  }
  return false;
}

/**
 * Task 100: the time the waypoint itself spends. A grind is budget battles × Config's
 * seconds per battle, or its own minutes cap. With neither, task 68's bestiary budget is
 * used; 15 battles is the deferral ceiling it starts from. `minimum` keeps several
 * conditions from being added: whichever is reached first ends the grind.
 */
function ownMinutesOf(waypoint: Waypoint, battleSeconds: number): number {
  if (waypoint.kind !== "grind" || waypoint.until === undefined) return waypoint.minutes ?? 0;
  const until = waypoint.until;
  const estimates: number[] = [];
  if (until.minutes !== undefined) estimates.push(until.minutes);
  if (until.battles !== undefined) estimates.push((until.battles * battleSeconds) / 60);
  if (
    until.battles === undefined &&
    until.minutes === undefined &&
    (until.bestiary !== undefined || until.blueMagic !== undefined)
  ) {
    estimates.push((DEFAULT_GRIND_BUDGET_BATTLES * battleSeconds) / 60);
  }
  return estimates.length === 0 ? (waypoint.minutes ?? 0) : Math.min(...estimates);
}

/** Task 68's deferral ceiling, used when a grind names no battle count. */
export const DEFAULT_GRIND_BUDGET_BATTLES = 15;

/** Route analysis falls back to the same 45 s as the plugin Config when no Config is passed. */
const FALLBACK_BATTLE_SECONDS = 45;

function legOf(
  from: RoutePoint,
  to: RoutePoint,
  waypoint: string,
  kind: WaypointKind | "end",
  label: string,
  estimate: PairEstimate,
  ownMinutes: number,
  until?: Waypoint["until"],
): RouteLeg {
  return {
    from,
    waypoint,
    kind,
    label,
    map: to.map,
    cell: to.cell,
    ...(until === undefined ? {} : { until }),
    maps: estimate.maps,
    hops: estimate.hops,
    cells: estimate.cells,
    minutes: estimate.minutes + ownMinutes,
  };
}

/**
 * Give the orderer each waypoint's `after` list plus the implicit "save before boss" rule.
 * The analyzer does not invent a save: with none it only warns. An explicit `after` that puts
 * a save behind the boss is reported and left unforced, instead of making the route
 * impossible in a way the stage layer could not explain.
 */
function prepare(
  waypoints: readonly Waypoint[],
  byId: ReadonlyMap<string, number>,
  reachable: readonly boolean[],
  warnings: Set<string>,
): readonly OrderStop[] {
  const after = waypoints.map((waypoint) => [...(waypoint.after ?? [])]);
  const saves = waypoints.flatMap((waypoint, index) =>
    waypoint.kind === "save" ? [{ waypoint, index }] : [],
  );
  const bosses = waypoints.flatMap((waypoint, index) =>
    waypoint.kind === "boss" ? [{ waypoint, index }] : [],
  );
  if (bosses.length > 0 && saves.length === 0) {
    warnings.add("首领前没有存档路标（不会自动造存档点）");
  }
  for (const boss of bosses) {
    for (const save of saves) {
      if (!reachable[save.index]) {
        warnings.add(`存档「${save.waypoint.label}」走不到，首领前没有可用的存档`);
        continue;
      }
      if (dependsOn(save.index, boss.waypoint.id, waypoints, byId, new Set())) {
        warnings.add(
          `存档「${save.waypoint.label}」的 after 把它排在首领「${boss.waypoint.label}」之后，` +
            "和「首领前存档」矛盾；没有强制这一条",
        );
        continue;
      }
      const list = after[boss.index];
      if (list !== undefined && !list.includes(save.waypoint.id)) list.push(save.waypoint.id);
    }
  }
  return waypoints.map((waypoint, index) => ({
    id: waypoint.id,
    after: after[index] ?? [],
  }));
}

/**
 * Plan one stage. The returned `total` includes each waypoint's own `minutes`; `legs` are in
 * execution order. The caller renders it with `describe`.
 */
export function analyzeRoute(input: RouteInput, givenWorld: RouteWorld): RoutePlan {
  const waypoints = input.waypoints;
  const byId = new Map<string, number>();
  waypoints.forEach((waypoint, index) => {
    if (byId.has(waypoint.id)) throw new Error(`路标 id 重复:${waypoint.id}`);
    byId.set(waypoint.id, index);
  });
  const world: RouteWorld =
    givenWorld.regions === undefined && givenWorld.collisions !== undefined
      ? {
          ...givenWorld,
          regions: RegionIndex.create(givenWorld.atlas, givenWorld.collisions),
        }
      : givenWorld;
  const battleSeconds = world.battleSeconds ?? FALLBACK_BATTLE_SECONDS;

  const end = input.end ?? null;
  const points: RoutePoint[] = [
    pointOf(input.start.map, input.start.cell),
    ...waypoints.map((waypoint) => pointOf(waypoint.map, waypoint.cell)),
    ...(end === null ? [] : [pointOf(end.map, end.cell)]),
  ];
  const matrix = points.map((from) => points.map((to) => estimatePair(world, from, to)));

  const preReason = new Map<number, string>();
  const reachable = waypoints.map((_, index) => {
    const pair = pairAt(matrix, 0, index + 1);
    if (pair.ok) return true;
    preReason.set(index, pair.reason);
    return false;
  });

  const warnings = new Set<string>();
  const stops = prepare(waypoints, byId, reachable, warnings);
  const endIndex = end === null ? null : waypoints.length + 1;
  const edge = (from: number, to: number): number | null => {
    const pair = pairAt(matrix, from, to);
    return pair.ok ? pair.estimate.minutes : null;
  };
  const ordered = orderStops(stops, edge, endIndex);
  const chosen = new Set(ordered.order);

  const legs: RouteLeg[] = [];
  let current = 0;
  for (const index of ordered.order) {
    const waypoint = waypoints[index];
    const pair = pairAt(matrix, current, index + 1);
    if (waypoint === undefined || !pair.ok) continue;
    legs.push(
      legOf(
        points[current] ?? pointOf(input.start.map, input.start.cell),
        points[index + 1] ?? pointOf(waypoint.map, waypoint.cell),
        waypoint.id,
        waypoint.kind,
        waypoint.label,
        pair.estimate,
        ownMinutesOf(waypoint, battleSeconds),
        waypoint.until,
      ),
    );
    current = index + 1;
  }
  if (ordered.endUsed && end !== null) {
    const pair = pairAt(matrix, current, waypoints.length + 1);
    if (pair.ok) {
      legs.push(
        legOf(
          points[current] ?? pointOf(input.start.map, input.start.cell),
          pointOf(end.map, end.cell),
          "end",
          "end",
          "终点",
          pair.estimate,
          0,
        ),
      );
    }
  } else if (end !== null) {
    warnings.add("终点走不到，计划停在最后一个路标");
    // 11-11: the stage plan's last stop may itself be a bad grind (453/454). The DP now keeps
    // the reachable waypoints, but `buildRoute` still wants an end leg. Make the documented
    // "stop at the last waypoint" real, as a zero-length end leg, so those waypoints execute
    // and the warning travels with the plan instead of the tool refusing the whole route.
    const last = points[current] ?? pointOf(input.start.map, input.start.cell);
    if (legs.length > 0) {
      legs.push(
        legOf(
          last,
          last,
          "end",
          "end",
          "终点（停在最后一个路标）",
          { maps: [last.map], hops: 0, cells: 0, minutes: 0 },
          0,
        ),
      );
    }
  }

  const unreachable: UnreachableWaypoint[] = waypoints.flatMap((waypoint, index) => {
    if (chosen.has(index)) return [];
    let reason = preReason.get(index) ?? ordered.blocked.get(index);
    if (reason === undefined) {
      const missing = (waypoint.after ?? []).flatMap((id) => {
        const at = byId.get(id);
        return at !== undefined && !chosen.has(at) ? [`「${waypoints[at]?.label ?? id}」`] : [];
      });
      reason =
        missing.length > 0
          ? `前置路标 ${missing.join("、")} 没有排进路线`
          : "和其余路标的先后约束、有向连接凑不成一条路线";
    }
    return [
      {
        id: waypoint.id,
        kind: waypoint.kind,
        map: waypoint.map,
        cell: waypoint.cell,
        label: waypoint.label,
        reason,
      },
    ];
  });

  const bossChosen = waypoints.some(
    (waypoint, index) => waypoint.kind === "boss" && chosen.has(index),
  );
  const saveChosen = waypoints.some(
    (waypoint, index) => waypoint.kind === "save" && chosen.has(index),
  );
  if (bossChosen && !saveChosen) warnings.add("首领前没有存档路标（不会自动造存档点）");
  for (const [index, waypoint] of waypoints.entries()) {
    if (waypoint.kind === "boss" && !chosen.has(index)) {
      warnings.add(`首领「${waypoint.label}」没有排进路线`);
    }
  }
  if (legs.length === 0) warnings.add("没有可以排进路线的路标");

  const total = legs.reduce(
    (sum, leg) => ({
      cells: sum.cells + leg.cells,
      hops: sum.hops + leg.hops,
      minutes: sum.minutes + leg.minutes,
    }),
    { cells: 0, hops: 0, minutes: 0 },
  );
  return {
    legs,
    unreachable,
    warnings: [...warnings],
    total,
  };
}

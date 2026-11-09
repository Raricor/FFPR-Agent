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

function legOf(
  from: RoutePoint,
  to: RoutePoint,
  waypoint: string,
  kind: WaypointKind | "end",
  label: string,
  estimate: PairEstimate,
  ownMinutes: number,
): RouteLeg {
  return {
    from,
    waypoint,
    kind,
    label,
    map: to.map,
    cell: to.cell,
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
      ? { ...givenWorld, regions: RegionIndex.create(givenWorld.atlas, givenWorld.collisions) }
      : givenWorld;

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
        waypoint.minutes ?? 0,
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

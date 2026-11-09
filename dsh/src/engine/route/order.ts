/**
 * Ordering waypoints with `after` constraints (task 79).
 *
 * Up to 13 waypoints the exact Held–Karp dynamic program is used; the state is (visited set,
 * last waypoint), and a waypoint is only added once all of its `after` ids are in the set.
 * Above 13 the nearest-neighbour order is improved with 2-opt: a reversed segment is accepted
 * only when every new edge exists and every `after` constraint still holds, because the map
 * graph is directed and a legal order is not necessarily legal backwards.
 *
 * The DP maximises the number of waypoints first and travel minutes second. That is how a
 * waypoint whose direction cannot be reached from the others is dropped (and reported by the
 * caller) instead of making the whole route fail.
 */

/** Exact ordering is cheap up to this many waypoints (2^13 × 13 states). */
export const EXACT_WAYPOINT_LIMIT = 13;

/** What the orderer needs to know about each waypoint. */
export interface OrderStop {
  readonly id: string;
  readonly after: readonly string[];
}

/**
 * Travel minutes for one directed pair. Indices: 0 is the start, 1..stops.length are the
 * waypoints, stops.length + 1 is the optional end. null means unreachable.
 */
export type EdgeMinutes = (from: number, to: number) => number | null;

export interface OrderResult {
  /** Waypoint indices, 0-based in the input order. */
  readonly order: readonly number[];
  /** Travel minutes over the chosen order, including the end when `endUsed`. */
  readonly cost: number;
  readonly endUsed: boolean;
  /** Waypoints the constraint pass refused outright, with the Chinese reason. */
  readonly blocked: ReadonlyMap<number, string>;
}

interface Precedence {
  readonly prereq: readonly number[];
  readonly blocked: ReadonlyMap<number, string>;
}

function precedence(stops: readonly OrderStop[]): Precedence {
  const count = stops.length;
  const byId = new Map<string, number>();
  stops.forEach((stop, index) => byId.set(stop.id, index));
  const prereq = Array.from({ length: count }, () => 0);
  const blocked = new Map<number, string>();
  for (let index = 0; index < count; index++) {
    const stop = stops[index];
    if (stop === undefined) continue;
    let mask = prereq[index] ?? 0;
    for (const id of stop.after) {
      const before = byId.get(id);
      if (before === undefined) {
        blocked.set(index, `after 里写的前置路标「${id}」不存在`);
        continue;
      }
      mask |= 1 << before;
    }
    prereq[index] = mask;
  }

  // A cycle means none of its members can ever be added; name the nodes instead of silently
  // dropping them later with the generic reason.
  const reach = prereq.map((mask) => {
    const found = new Set<number>();
    for (let index = 0; index < count; index++) {
      if ((mask & (1 << index)) !== 0) found.add(index);
    }
    return found;
  });
  for (let through = 0; through < count; through++) {
    const via = reach[through];
    if (via === undefined) continue;
    for (let from = 0; from < count; from++) {
      const set = reach[from];
      if (!set?.has(through)) continue;
      for (const target of via) set.add(target);
    }
  }
  for (let index = 0; index < count; index++) {
    if (reach[index]?.has(index) === true && !blocked.has(index)) {
      blocked.set(index, `after 顺序有环，路标「${stops[index]?.id ?? index}」绕回自己`);
    }
  }
  return { prereq, blocked };
}

function popcount(value: number): number {
  let bits = value;
  let count = 0;
  while (bits !== 0) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

function reconstruct(parent: Int32Array, width: number, mask: number, last: number): number[] {
  const order: number[] = [];
  let currentMask = mask;
  let current = last;
  while (current >= 0) {
    order.push(current);
    const previous = parent[currentMask * width + current] ?? -1;
    currentMask &= ~(1 << current);
    current = previous;
  }
  return order.reverse();
}

/** Best (most waypoints, then cheapest) state over all reachable subsets. */
function exactOrder(
  count: number,
  endIndex: number | null,
  edge: EdgeMinutes,
  prereq: readonly number[],
  blocked: ReadonlyMap<number, string>,
): OrderResult {
  if (count === 0) {
    const cost = endIndex === null ? 0 : edge(0, endIndex);
    return cost === null
      ? { order: [], cost: 0, endUsed: false, blocked }
      : { order: [], cost, endUsed: true, blocked };
  }
  const size = 1 << count;
  const width = count;
  const dp = new Float64Array(size * width).fill(Infinity);
  const parent = new Int32Array(size * width).fill(-1);
  for (let index = 0; index < count; index++) {
    if ((prereq[index] ?? 0) !== 0 || blocked.has(index)) continue;
    const cost = edge(0, index + 1);
    if (cost === null) continue;
    dp[(1 << index) * width + index] = cost;
    parent[(1 << index) * width + index] = -2;
  }

  for (let mask = 0; mask < size; mask++) {
    for (let last = 0; last < count; last++) {
      const cost = dp[mask * width + last] ?? Infinity;
      if (!Number.isFinite(cost)) continue;
      for (let next = 0; next < count; next++) {
        const bit = 1 << next;
        if ((mask & bit) !== 0 || blocked.has(next)) continue;
        if (((prereq[next] ?? 0) & ~mask) !== 0) continue;
        const tail = edge(last + 1, next + 1);
        if (tail === null) continue;
        const nextMask = mask | bit;
        const nextCost = cost + tail;
        if (nextCost < (dp[nextMask * width + next] ?? Infinity)) {
          dp[nextMask * width + next] = nextCost;
          parent[nextMask * width + next] = last;
        }
      }
    }
  }

  let bestCount = -1;
  let bestCost = Infinity;
  let bestMask = 0;
  let bestLast = -1;
  let bestEnd = false;
  for (let mask = 0; mask < size; mask++) {
    const visited = popcount(mask);
    for (let last = 0; last < count; last++) {
      const cost = dp[mask * width + last] ?? Infinity;
      if (!Number.isFinite(cost)) continue;
      const tail = endIndex === null ? 0 : edge(last + 1, endIndex);
      if (tail === null) continue;
      const total = cost + tail;
      const better = visited > bestCount || (visited === bestCount && total < bestCost);
      if (!better) continue;
      bestCount = visited;
      bestCost = total;
      bestMask = mask;
      bestLast = last;
      bestEnd = endIndex !== null;
    }
  }
  if (endIndex !== null) {
    const direct = edge(0, endIndex);
    if (direct !== null && (0 > bestCount || (0 === bestCount && direct < bestCost))) {
      return { order: [], cost: direct, endUsed: true, blocked };
    }
  }
  if (bestLast < 0) return { order: [], cost: 0, endUsed: false, blocked };
  return {
    order: reconstruct(parent, width, bestMask, bestLast),
    cost: bestCost,
    endUsed: bestEnd,
    blocked,
  };
}

function routeCost(order: readonly number[], edge: EdgeMinutes): number | null {
  let cost = 0;
  let previous = 0;
  for (const index of order) {
    const step = edge(previous, index + 1);
    if (step === null) return null;
    cost += step;
    previous = index + 1;
  }
  return cost;
}

function respects(order: readonly number[], prereq: readonly number[]): boolean {
  const position = new Int32Array(prereq.length).fill(-1);
  order.forEach((index, at) => {
    if (index >= 0 && index < position.length) position[index] = at;
  });
  for (let at = 0; at < order.length; at++) {
    const index = order[at];
    if (index === undefined) continue;
    const mask = prereq[index] ?? 0;
    for (let before = 0; before < prereq.length; before++) {
      if ((mask & (1 << before)) === 0) continue;
      if ((position[before] ?? -1) < 0 || (position[before] ?? -1) >= at) return false;
    }
  }
  return true;
}

function endCost(
  order: readonly number[],
  endIndex: number | null,
  edge: EdgeMinutes,
): number | null {
  if (endIndex === null) return 0;
  const previous = order.length === 0 ? 0 : (order.at(-1) ?? 0) + 1;
  return edge(previous, endIndex);
}

/**
 * Nearest neighbour, then 2-opt. Used above EXACT_WAYPOINT_LIMIT. With a directed graph the
 * reversed segment must be re-costed from scratch: its internal edges are reversed too.
 */
export function nearestNeighborOrder(
  count: number,
  endIndex: number | null,
  edge: EdgeMinutes,
  prereq: readonly number[],
  blocked: ReadonlyMap<number, string>,
): OrderResult {
  const order: number[] = [];
  let visited = 0;
  let current = 0;
  for (;;) {
    let best = -1;
    let bestCost = Infinity;
    for (let index = 0; index < count; index++) {
      const bit = 1 << index;
      if ((visited & bit) !== 0 || blocked.has(index)) continue;
      if (((prereq[index] ?? 0) & ~visited) !== 0) continue;
      const cost = edge(current, index + 1);
      if (cost === null || cost >= bestCost) continue;
      best = index;
      bestCost = cost;
    }
    if (best < 0) break;
    order.push(best);
    visited |= 1 << best;
    current = best + 1;
  }

  let bestCost = routeCost(order, edge) ?? 0;
  for (let pass = 0; pass < 50; pass++) {
    let improved = false;
    for (let left = 0; left < order.length - 1; left++) {
      for (let right = left + 1; right < order.length; right++) {
        const candidate = [
          ...order.slice(0, left),
          ...order.slice(left, right + 1).reverse(),
          ...order.slice(right + 1),
        ];
        if (!respects(candidate, prereq)) continue;
        const cost = routeCost(candidate, edge);
        if (cost === null || cost >= bestCost) continue;
        order.splice(0, order.length, ...candidate);
        bestCost = cost;
        improved = true;
      }
    }
    if (!improved) break;
  }

  const tail = endCost(order, endIndex, edge);
  if (tail === null) return { order, cost: bestCost, endUsed: false, blocked };
  return { order, cost: bestCost + tail, endUsed: endIndex !== null, blocked };
}

/** Order the waypoints and the optional end, respecting every `after` constraint. */
export function orderStops(
  stops: readonly OrderStop[],
  edge: EdgeMinutes,
  endIndex: number | null,
): OrderResult {
  const { prereq, blocked } = precedence(stops);
  if (stops.length <= EXACT_WAYPOINT_LIMIT) {
    return exactOrder(stops.length, endIndex, edge, prereq, blocked);
  }
  return nearestNeighborOrder(stops.length, endIndex, edge, prereq, blocked);
}

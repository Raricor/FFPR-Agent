/**
 * Route analyzer entry point (task 79). The stage layer imports `analyzeRoute`, passes its
 * map records and collision cache, and renders the result with `describe`.
 */

export { analyzeRoute } from "./analyze.ts";
export {
  ROUTE_CELLS_PER_MAP_HOP,
  ROUTE_SECONDS_PER_CELL,
  ROUTE_SECONDS_PER_MAP_CHANGE,
  estimatePair,
} from "./distance.ts";
export { describe } from "./describe.ts";
export { EXACT_WAYPOINT_LIMIT, orderStops } from "./order.ts";
export type { EdgeMinutes, OrderResult, OrderStop } from "./order.ts";
export type {
  GrindUntil,
  PairEstimate,
  RouteDistance,
  RouteInput,
  RouteLeg,
  RoutePlan,
  RoutePoint,
  RouteTotal,
  RouteWorld,
  UnreachableWaypoint,
  Waypoint,
  WaypointKind,
} from "./types.ts";

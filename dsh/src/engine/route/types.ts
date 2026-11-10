/**
 * Route analyzer types (task 79): the stage layer gives the analyzer the waypoints of one
 * stage (a dungeon, a town, the world map, the next dungeon) and gets back an ordered route.
 *
 * This module only analyses. It does not walk, press buttons or talk to the model; a later
 * task runs the plan and calls the AI only at decision points. The user's 11-10 direction:
 * each stage is planned in code, the AI is not asked to choose one map at a time.
 */

import type { Atlas } from "../atlas.ts";
import type { Cell } from "../nav.ts";
import type { CollisionStore, RegionIndex } from "../regions.ts";

export type WaypointKind = "chest" | "grind" | "shop" | "inn" | "save" | "boss" | "move" | "story";

/** Task 100: what a `grind` waypoint stops at. Any combination is allowed; the first met ends it. */
export interface GrindUntil {
  /** Bestiary names or book numbers that must be registered in this save. */
  readonly bestiary?: readonly (string | number)[];
  /** Blue magic names that must be learned by someone in the party. */
  readonly blueMagic?: readonly string[];
  /** Stop after this many battles. */
  readonly battles?: number;
  /** Stop after this many minutes. */
  readonly minutes?: number;
}

export interface Waypoint {
  readonly id: string;
  readonly kind: WaypointKind;
  readonly map: number;
  /** null: any cell on this map works, e.g. the area a grind happens in. */
  readonly cell: Cell | null;
  /** Chinese, for the stage layer and the model. */
  readonly label: string;
  /** Ids this waypoint must be ordered after. */
  readonly after?: readonly string[];
  /** Minutes spent at this waypoint (a grind budget), default 0. */
  readonly minutes?: number;
  /** Task 100: a grind waypoint's stopping conditions; ignored by the other kinds. */
  readonly until?: GrindUntil;
  /**
   * Task 89: a countdown may skip this waypoint (a chest) to reach the end in time. The route
   * tool defaults `do: open` to optional; the end is never optional.
   */
  readonly optional?: boolean;
  /**
   * Task 89: how close `goTo` has to get before `act` runs. "map" leaves the walk to the action
   * (interact walks beside a chest or NPC itself); the default is the exact cell.
   */
  readonly reach?: "cell" | "map";
}

export interface RouteInput {
  readonly start: { readonly map: number; readonly cell: Cell };
  /** Final destination; absent means stop at the last waypoint. */
  readonly end?: { readonly map: number; readonly cell: Cell | null } | null;
  readonly waypoints: readonly Waypoint[];
}

/** A point a pair distance is asked about; a null cell means "anywhere on this map". */
export interface RoutePoint {
  readonly map: number;
  readonly cell: Cell | null;
}

/**
 * One directed pair estimate. `hops` counts map changes, `cells` is the walking estimate
 * (with a per-map constant where no collision cache exists), `minutes` includes both.
 */
export interface PairEstimate {
  readonly maps: readonly number[];
  readonly hops: number;
  readonly cells: number;
  readonly minutes: number;
}

/** A caller-supplied metric; null means the destination cannot be reached. */
export type RouteDistance = (from: RoutePoint, to: RoutePoint) => PairEstimate | null;

/**
 * What the analyzer knows about the world. `atlas` is required; `regions`/`collisions` are
 * optional (mapPath still works map-to-map without them), and `distance` replaces the whole
 * built-in estimate, which is useful for tests and for a future route cache.
 */
export interface RouteWorld {
  readonly atlas: Atlas;
  /** Cached (map, block) regions from task 75. */
  readonly regions?: RegionIndex;
  /** Collision snapshots, used for walking estimates inside one map. */
  readonly collisions?: CollisionStore;
  /** Task 100: Config's estimated seconds per battle, for a grind waypoint's own time. */
  readonly battleSeconds?: number;
  readonly distance?: RouteDistance;
}

export interface RouteLeg {
  /** Where this leg starts; the previous waypoint, or the input's start for the first. */
  readonly from: RoutePoint;
  /** The waypoint id this leg reaches, or "end" for the input's final destination. */
  readonly waypoint: string;
  readonly kind: WaypointKind | "end";
  readonly label: string;
  readonly map: number;
  readonly cell: Cell | null;
  /** Task 100: kept across a plan so a resumed or analysed grind still knows its until. */
  readonly until?: GrindUntil;
  /** From the starting map to the destination map, inclusive. */
  readonly maps: readonly number[];
  readonly hops: number;
  readonly cells: number;
  /** Travel time plus this waypoint's own `minutes`. */
  readonly minutes: number;
}

export interface UnreachableWaypoint {
  readonly id: string;
  readonly kind: WaypointKind;
  readonly map: number;
  readonly cell: Cell | null;
  readonly label: string;
  /** Chinese, for the stage layer: why the map records cannot route to it. */
  readonly reason: string;
}

export interface RouteTotal {
  readonly cells: number;
  readonly hops: number;
  readonly minutes: number;
}

export interface RoutePlan {
  readonly legs: readonly RouteLeg[];
  readonly unreachable: readonly UnreachableWaypoint[];
  /** Non-waypoint remarks: a boss without a save, an unreachable end, and so on. */
  readonly warnings: readonly string[];
  readonly total: RouteTotal;
}

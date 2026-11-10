/**
 * Scout planning (task 102): decide what a scout should visit, in what order, from what the
 * map records and collision cache already say. Pure: it reads an in-memory Atlas and
 * CollisionStore, returns targets and route waypoints, and never presses a key or opens a file.
 *
 * The 11-10 observations drive the target kinds:
 * - 342 exits but only 43 recorded landings: every exit without `land` is a target;
 * - 245 of 254 "走不过去" records were seen once (a temporary NPC or story block): verify those;
 * - maps never entered have no structure: each collision block with no recorded entrance is a
 *   target;
 * - named DefaultEntity/Event objects may be doors or mechanisms no one has tried yet.
 *
 * Ordering uses task 79's `analyzeRoute`. Targets are grouped by kind (landings, unreachable
 * blocks, one-off blocks, named objects) and each group is ordered by the analyzer; a target
 * the records cannot reach is still kept, after the reachable ones, because the scout exists
 * to go where the records are incomplete. The executor replans after every target, so the
 * estimates here are for planning, not a promise of one uninterrupted walk.
 */

import type { Atlas } from "../atlas.ts";
import type { Cell } from "../nav.ts";
import { layeredComponents, layeredGrid } from "../nav.ts";
import type { CollisionStore } from "../regions.ts";
import type { RegionIndex } from "../regions.ts";
import { analyzeRoute } from "../route/analyze.ts";
import type {
  RouteInput,
  RoutePlan,
  RouteWorld,
  UnreachableWaypoint,
  Waypoint,
} from "../route/types.ts";
import { findMap } from "../skills/travel.ts";
import { num, records, text, type Json } from "../values.ts";

export type ScoutTargetKind = "landing" | "component" | "blocked" | "entity";

export type ScoutAction = "walk" | "talk";

/** A named object the map model may carry in an `entities` array (bridge look_around shape). */
export interface ScoutEntity {
  readonly map: number;
  readonly cell: Cell;
  readonly kind: string;
  readonly name: string;
  /** True when the game/records say this object was already tried. */
  readonly tried?: boolean;
  readonly active?: boolean;
}

/** One thing to visit; `route` is the stop the route tool would accept. */
export interface ScoutTarget {
  readonly id: string;
  readonly kind: ScoutTargetKind;
  readonly map: number;
  readonly cell: Cell;
  readonly label: string;
  readonly action: ScoutAction;
  /** `route`/`go` spelling: "map:x,y", plus `do: "talk"` for a mechanism. */
  readonly route: { readonly to: string; readonly do?: "talk" };
  readonly waypoint: Waypoint;
  /** The exit's destination map, for a landing target. */
  readonly toMap?: number;
  /** The step a blocked target asks the scout to try again. */
  readonly step?: { readonly from: Cell; readonly to: Cell; readonly layer: number | null };
}

export interface ScoutPhasePlan {
  readonly kind: ScoutTargetKind;
  readonly targets: readonly ScoutTarget[];
  readonly route: RoutePlan;
}

export interface ScoutPlan {
  /** Final order: landings, blocks, one-off verifications, named objects. */
  readonly targets: readonly ScoutTarget[];
  readonly waypoints: readonly Waypoint[];
  readonly phases: readonly ScoutPhasePlan[];
  /** Sum of the per-group analyzer estimates, in minutes. */
  readonly minutes: number;
  /** Targets the records could not reach; they still need a scout, so they are in `targets`. */
  readonly unreachable: readonly UnreachableWaypoint[];
  readonly warnings: readonly string[];
}

export interface ScoutInput {
  readonly atlas: Atlas;
  /** Cached regions, passed through to the route analyzer. */
  readonly regions?: RegionIndex;
  /** Collision cache, used both for route estimates and for finding unreachable blocks. */
  readonly collisions?: CollisionStore;
  readonly start: { readonly map: number; readonly cell: Cell };
  /** Map ids, map names, or area names; all matching maps are scouted. */
  readonly scope: readonly (number | string)[];
  /** Objects read from look_around/entities, when the caller has them. */
  readonly entities?: readonly ScoutEntity[];
  readonly battleSeconds?: number;
}

const OBJECT_KINDS: ReadonlySet<string> = new Set([
  "DefaultEntity",
  "DefaultAnimEntity",
  "Event",
  "OpenTrigger",
  "RelayInteraction",
  "TileAnimRegion",
  "PointIn",
]);

const PHASE_ORDER: readonly ScoutTargetKind[] = ["landing", "component", "blocked", "entity"];

const PHASE_NAMES: Readonly<Record<ScoutTargetKind, string>> = {
  landing: "出口落点",
  component: "走不到过的连通块",
  blocked: "只见过一次的走不过去",
  entity: "没试过的机关和事件格",
};

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x: unknown = value[0];
  const y: unknown = value[1];
  if (typeof x !== "number" || typeof y !== "number") return null;
  return [x, y];
}

function cellText(cell: Cell): string {
  return `(${cell[0]},${cell[1]})`;
}

function routeText(map: number, cell: Cell): string {
  return `${map}:${cell[0]},${cell[1]}`;
}

function mapText(map: number): string {
  return `地图 ${map}`;
}

/** A map entry's `areaName`/`area`/`name`, whichever exists, for scope matching. */
function namesOf(entry: Json): string[] {
  return [text(entry.name), text(entry.areaName), text(entry.area)].filter(
    (name): name is string => name !== undefined && name.trim() !== "",
  );
}

/**
 * Resolve the scout scope. Numbers and numeric strings are map ids; other strings match map
 * names/areas (all maps containing the text), with findMap's exact-match rules as a fallback.
 */
export function resolveScope(atlas: Atlas, scope: readonly (number | string)[]): number[] {
  const ids = new Set<number>();
  for (const item of scope) {
    if (typeof item === "number") {
      if (Number.isInteger(item)) ids.add(item);
      continue;
    }
    const query = item.trim();
    if (query === "") continue;
    const numbered = /^(?:地图\s*)?(\d+)$/u.exec(query);
    if (numbered !== null) {
      const id = Number(numbered[1]);
      if (Number.isInteger(id)) ids.add(id);
      continue;
    }
    const wanted = query.toLowerCase();
    let matched = false;
    for (const [key, entry] of atlas.maps) {
      const id = Number(key);
      if (!Number.isInteger(id)) continue;
      if (namesOf(entry).some((name) => name.toLowerCase().includes(wanted))) {
        ids.add(id);
        matched = true;
      }
    }
    if (!matched) {
      const choice = findMap(atlas, query);
      if (choice.ok) ids.add(choice.mapId);
    }
  }
  return [...ids].sort((left, right) => left - right);
}

interface TargetSeed {
  readonly kind: ScoutTargetKind;
  readonly map: number;
  readonly cell: Cell;
  readonly label: string;
  readonly action: ScoutAction;
  readonly toMap?: number;
  readonly step?: { readonly from: Cell; readonly to: Cell; readonly layer: number | null };
}

function waypointOf(id: string, seed: TargetSeed): Waypoint {
  return {
    id,
    kind: seed.action === "talk" ? "story" : "move",
    map: seed.map,
    cell: seed.cell,
    label: seed.label,
    optional: false,
    reach: seed.action === "talk" ? "map" : "cell",
  };
}

function targetOf(id: string, seed: TargetSeed): ScoutTarget {
  const waypoint = waypointOf(id, seed);
  return {
    id,
    kind: seed.kind,
    map: seed.map,
    cell: seed.cell,
    label: seed.label,
    action: seed.action,
    route:
      seed.action === "talk"
        ? { to: routeText(seed.map, seed.cell), do: "talk" }
        : { to: routeText(seed.map, seed.cell) },
    waypoint,
    ...(seed.toMap === undefined ? {} : { toMap: seed.toMap }),
    ...(seed.step === undefined ? {} : { step: seed.step }),
  };
}

/** One exit without a recorded landing. */
function landingSeeds(atlas: Atlas, map: number): TargetSeed[] {
  const entry = atlas.maps.get(String(map));
  const seeds: TargetSeed[] = [];
  for (const exit of records(entry?.exits)) {
    const cell = cellOf(exit.cell);
    const to = num(exit.to);
    if (cell === null || to === undefined) continue;
    if (cellOf(exit.land) !== null) continue;
    seeds.push({
      kind: "landing",
      map,
      cell,
      label: `出口 ${cellText(cell)} → ${mapText(Math.trunc(to))} 没记落点`,
      action: "walk",
      toMap: Math.trunc(to),
    });
  }
  return seeds;
}

/** The blocks of one cached map, with the ids the route's region index uses. */
interface MapComponents {
  readonly blocks: ReadonlyMap<string, number>;
  readonly heights: readonly number[];
}

function componentsOf(atlas: Atlas, collisions: CollisionStore, map: number): MapComponents | null {
  const collision = collisions.get(map);
  if (collision === undefined) return null;
  const grid = layeredGrid({ ...collision, playerCell: [-1, -1] }, [], [], atlas.moves(map), []);
  if (grid === null) return null;
  return { blocks: layeredComponents(grid), heights: [...grid.heights.keys()] };
}

function blocksAt(components: MapComponents, cell: Cell, layer: number | null): Set<number> {
  const heights =
    layer !== null && components.heights.includes(layer) ? [layer] : components.heights;
  const found = new Set<number>();
  for (const z of heights) {
    const block = components.blocks.get(`${cell[0]},${cell[1]},${z}`);
    if (block !== undefined) found.add(block);
  }
  return found;
}

/** Cells on `map` that a recorded route can enter it through: landings, rides, current cell. */
function entranceCells(atlas: Atlas, map: number, start: ScoutInput["start"]): Cell[] {
  const cells: Cell[] = [];
  if (start.map === map) cells.push(start.cell);
  for (const [key, entry] of atlas.maps) {
    const from = Number(key);
    if (!Number.isInteger(from)) continue;
    for (const exit of records(entry.exits)) {
      if (num(exit.to) === map) {
        const land = cellOf(exit.land);
        if (land !== null) cells.push(land);
      }
    }
  }
  for (const from of atlas.maps.keys()) {
    const fromId = Number(from);
    if (!Number.isInteger(fromId)) continue;
    for (const ride of atlas.rides(fromId)) {
      if (ride.to === map) cells.push(ride.land);
    }
  }
  return cells;
}

/** One target per collision block that no recorded entrance can reach. */
function componentSeeds(
  atlas: Atlas,
  collisions: CollisionStore,
  map: number,
  start: ScoutInput["start"],
): TargetSeed[] {
  const components = componentsOf(atlas, collisions, map);
  if (components === null) return [];
  const reachable = new Set<number>();
  for (const cell of entranceCells(atlas, map, start)) {
    for (const block of blocksAt(components, cell, null)) reachable.add(block);
  }
  const seeds: TargetSeed[] = [];
  const seen = new Set<number>();
  for (const [key, block] of components.blocks) {
    if (reachable.has(block) || seen.has(block)) continue;
    seen.add(block);
    const [x, y, z] = key.split(",").map(Number);
    if (x === undefined || y === undefined || z === undefined) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    seeds.push({
      kind: "component",
      map,
      cell: [x, y],
      label: `${mapText(map)} 走不到过的连通块 ${cellText([x, y])}`,
      action: "walk",
    });
  }
  return seeds;
}

/** One "走不过去" whose count is still 1: a block that may have been temporary. */
function blockedSeeds(atlas: Atlas, map: number): TargetSeed[] {
  const seeds: TargetSeed[] = [];
  for (const move of atlas.moves(map)) {
    if (move.how !== "走不过去") continue;
    if ((move.count ?? 1) >= 2) continue;
    seeds.push({
      kind: "blocked",
      map,
      cell: move.from,
      label: `验证走不过去 ${cellText(move.from)} → ${cellText(move.to)}`,
      action: "walk",
      step: { from: move.from, to: move.to, layer: move.layer ?? null },
    });
  }
  return seeds;
}

function entitiesOfMap(atlas: Atlas, map: number): ScoutEntity[] {
  const entry = atlas.maps.get(String(map));
  const found: ScoutEntity[] = [];
  for (const raw of records(entry?.entities)) {
    const cell = cellOf(raw.cell);
    const kind = text(raw.kind);
    const name = text(raw.name);
    if (cell === null || kind === undefined || name === undefined || name.trim() === "") continue;
    found.push({
      map,
      cell,
      kind,
      name,
      ...(raw.tried === true ? { tried: true } : {}),
      ...(typeof raw.active === "boolean" ? { active: raw.active } : {}),
    });
  }
  return found;
}

function entitySeeds(entities: readonly ScoutEntity[], scope: ReadonlySet<number>): TargetSeed[] {
  const seeds: TargetSeed[] = [];
  const seen = new Set<string>();
  for (const entity of entities) {
    if (!scope.has(entity.map)) continue;
    if (entity.tried === true) continue;
    if (!OBJECT_KINDS.has(entity.kind)) continue;
    const key = `${entity.map}:${entity.cell[0]},${entity.cell[1]}:${entity.kind}:${entity.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const talk = entity.kind === "DefaultEntity" || entity.kind === "DefaultAnimEntity";
    seeds.push({
      kind: "entity",
      map: entity.map,
      cell: entity.cell,
      label: `${talk ? "调查" : "走到"} ${entity.name} ${cellText(entity.cell)}`,
      action: talk ? "talk" : "walk",
    });
  }
  return seeds;
}

function collectSeeds(input: ScoutInput, maps: readonly number[]): TargetSeed[] {
  const scope = new Set(maps);
  const seeds: TargetSeed[] = [];
  const entities: ScoutEntity[] = [];
  for (const map of maps) {
    seeds.push(...landingSeeds(input.atlas, map));
    if (input.collisions !== undefined) {
      seeds.push(...componentSeeds(input.atlas, input.collisions, map, input.start));
    }
    seeds.push(...blockedSeeds(input.atlas, map));
    entities.push(...entitiesOfMap(input.atlas, map));
  }
  entities.push(...(input.entities ?? []));
  seeds.push(...entitySeeds(entities, scope));
  return seeds;
}

function uniqueTargets(seeds: readonly TargetSeed[]): ScoutTarget[] {
  const used = new Map<string, number>();
  return seeds.map((seed) => {
    const base = `scout-${seed.kind}-${seed.map}-${seed.cell[0]}-${seed.cell[1]}`;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return targetOf(count === 0 ? base : `${base}-${count}`, seed);
  });
}

function routeWorld(input: ScoutInput): RouteWorld {
  return {
    atlas: input.atlas,
    ...(input.regions === undefined ? {} : { regions: input.regions }),
    ...(input.collisions === undefined ? {} : { collisions: input.collisions }),
    ...(input.battleSeconds === undefined ? {} : { battleSeconds: input.battleSeconds }),
  };
}

/**
 * Order each kind with `analyzeRoute`, then concatenate the groups. A group's unreachable
 * targets stay in input order after its reachable ones, so a missing landing or block does not
 * silently drop the very thing the scout is for.
 */
export function planScout(input: ScoutInput): ScoutPlan {
  const maps = resolveScope(input.atlas, input.scope);
  const targets = uniqueTargets(collectSeeds(input, maps));
  const world = routeWorld(input);
  const phases: ScoutPhasePlan[] = [];
  const ordered: ScoutTarget[] = [];
  const unreachable: UnreachableWaypoint[] = [];
  const warnings: string[] = [];
  let minutes = 0;

  if (maps.length === 0) warnings.push("侦察范围没有匹配到任何地图记录。");

  for (const kind of PHASE_ORDER) {
    const phaseTargets = targets.filter((target) => target.kind === kind);
    if (phaseTargets.length === 0) continue;
    const inputRoute: RouteInput = {
      start: { map: input.start.map, cell: input.start.cell },
      waypoints: phaseTargets.map((target) => target.waypoint),
    };
    const plan = analyzeRoute(inputRoute, world);
    const byId = new Map(phaseTargets.map((target) => [target.id, target]));
    const used = new Set<string>();
    for (const leg of plan.legs) {
      if (leg.waypoint === "end") continue;
      const target = byId.get(leg.waypoint);
      if (target === undefined || used.has(target.id)) continue;
      used.add(target.id);
      ordered.push(target);
    }
    for (const target of phaseTargets) {
      if (!used.has(target.id)) ordered.push(target);
    }
    if (plan.unreachable.length > 0) {
      unreachable.push(...plan.unreachable);
      warnings.push(
        `${PHASE_NAMES[kind]}有 ${plan.unreachable.length} 个按现有记录走不到，` +
          "排在后面等走到那里再重排",
      );
    }
    minutes += plan.total.minutes;
    phases.push({ kind, targets: ordered.filter((target) => target.kind === kind), route: plan });
  }

  return {
    targets: ordered,
    waypoints: ordered.map((target) => target.waypoint),
    phases,
    minutes,
    unreachable,
    warnings,
  };
}

/** The same targets without the route plan, for a caller that only needs the list. */
export function exploreTargets(input: ScoutInput): readonly ScoutTarget[] {
  return planScout(input).targets;
}

/** One line naming what a plan will do, for a tool result or a log. */
export function describeScout(plan: ScoutPlan): string {
  if (plan.targets.length === 0)
    return "没有要侦察的地方:地图记录里没有缺落点、疑点或没试过的机关。";
  const counts = PHASE_ORDER.map((kind) => {
    const count = plan.targets.filter((target) => target.kind === kind).length;
    return count === 0 ? "" : `${PHASE_NAMES[kind]} ${count}`;
  }).filter((part) => part !== "");
  const places = new Set(plan.targets.map((target) => target.map));
  return (
    `要侦察 ${plan.targets.length} 处(${places.size} 张图):${counts.join("、")};` +
    `估计 ${Math.ceil(plan.minutes)} 分钟` +
    (plan.unreachable.length > 0 ? `,其中 ${plan.unreachable.length} 处记录里走不到` : "")
  );
}

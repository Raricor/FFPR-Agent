/**
 * Walking: one whole route per bridge command (0.14.0's walkpath), planned here, re-planned
 * when blocked; closed-loop legs on older bridges; and stepping up to a chest, NPC or counter
 * to interact with it. Ported from ffpr_agent/skills/move.py.
 */

import type { Pilot, Reply } from "../pilot.ts";
import {
  cellKey,
  corners,
  edgeKey,
  entityLayer,
  hasTerrain,
  layeredComponents,
  layeredGrid,
  layeredRouteAvoiding,
  pathToward,
  search,
  terrainRule,
} from "../nav.ts";
import type {
  Cell,
  CellGrid,
  CellRule,
  DangerCell,
  LayerChange,
  LayerNode,
  LayeredGrid,
  ObservedMove,
} from "../nav.ts";
import { isRecord, num, record, records, text, truthy, type Json } from "../values.ts";
import { movesFromMovingGimmickMap } from "../atlas.ts";
import { eventBaseName, fallMoves } from "../view.ts";
import {
  beginWalk,
  finishWalk,
  indoorBase,
  updateWalk,
  updateWalkFromReply,
  worldBase,
  type WalkBase,
  type WalkView,
} from "../walk-view.ts";
import {
  MAX_WORLD_WINDOWS,
  WORLD_RADIUS,
  createWorldCache,
  hasAt,
  mergeWindow,
  windowCenters,
  worldGrid,
} from "../world-grid.ts";
import type { WorldCache } from "../world-grid.ts";
import type { BattleHooks } from "./battle.ts";
import { regular } from "./battle.ts";
import { FIELD_HELP_STUCK, dismissFieldHelp } from "./screens.ts";

type Say = (line: string) => void;

/**
 * Task 84: carries seen in one `go`, shared by the recursive walk back across maps so the
 * repeat and total limits cover the whole call, not each map hop.
 */
export interface CarryBudget {
  readonly seen: Map<string, number>;
  total: number;
}

/**
 * The wind drake's state, once a module variable in Python: where it was last left, and the
 * battle hooks passed on to fights met on the way (the Game holds both).
 */
export interface MoveState {
  drake: Cell | null;
  /** The game key (ffN), for the walk view the dsh page reads (task 61). */
  game?: string;
  /** What this walk is for, set by the Game's tool handler; `walkpath` sends it. */
  label?: string;
  /** Which map hop is walking (travel.ts), appended to the label as "第 k 跳". */
  hop?: number;
  /** The current walk view, one per game (task 61). */
  walk?: WalkView | null;
  battle?: BattleHooks;
  /** Save slot a wipe loads during a walk; the Game sets it from its config. */
  saveSlot?: number;
  /** 11-05: battles met while walking run first; set by go/explore. */
  flee?: boolean;
  /** Task 58: the bridge walkpath's base timeout, blocked wait and turn lead (Config). */
  walkpathTimeoutMs?: number;
  walkpathBlockedMs?: number;
  walkpathTurnLead?: number;
  /** Task 63: how often and how long a walkpath's Event/dialog stop is watched for battle. */
  walkpathEventPollMs?: number;
  walkpathEventWaitMs?: number;
  /** Records a way found or refused while walking in the atlas; the Game wires it in. */
  link?: (
    mapId: unknown,
    from: Cell,
    to: Cell,
    how: string,
    detail?: { kind?: string; toLayer?: number; layer?: number; gimmick?: boolean },
  ) => Promise<void>;
  /** Forgets atlas "走不过去" records a walk proved wrong; the Game wires it in (task 73). */
  forgetBlocked?: (mapId: unknown, steps: readonly ObservedMove[]) => Promise<void>;
  /**
   * Task 73: a "走不过去" record hit this many times is a reliable wall and is not re-walked.
   * Config carries the live value; old records count as one hit.
   */
  blockedTrustCount?: number;
  /**
   * Task 83: how many times `go` tries to step onto an event cell from one side. A step onto
   * an event cell can be refused once and accepted later (11-10, Fire-Powered Ship 265), so a
   * refusal there is not a wall.
   */
  eventTryCount?: number;
  /** Task 83: how long to wait between those tries. */
  eventTryWaitMs?: number;
  /** Task 84: the same carry (same start cell → same landing) this many times stops one go. */
  carryRepeatLimit?: number;
  /** Task 84: how many carries one go may take before it stops. */
  carryTotalLimit?: number;
  /** Task 84: whether the atlas records a way from one map to another (the Game wires it in). */
  routeBack?: (from: number, to: number) => boolean;
  /**
   * Task 84: walk back to the goal's map and on to the goal, all inside the same go call. The
   * Game supplies it because crossing maps needs the atlas and travel.ts; null when the map
   * records say there is no way back.
   */
  returnToGoal?: (
    pilot: Pilot,
    goalMap: number,
    goal: Cell,
    say: Say,
    budget: CarryBudget,
  ) => Promise<[boolean, string]>;
  /**
   * Steps found blocked in the game, keyed by map (the bridge map id), then edgeKey. Kept for
   * the whole run so the next walk on that map does not hit the same wall again (11-03,
   * Fire-Powered Ship 261: the same (8,22)→(7,22) step was walked into twice).
   */
  cuts?: Map<string, Set<string>>;
  /**
   * Blocked steps found on a layered map, by map id then height (11-09, Walse Castle 54:
   * a step blocked on the ground floor must not close the same step on the upper floor).
   */
  layeredCuts?: Map<string, Map<number, Set<string>>>;
  /**
   * Task 99: maps this run has confirmed have a moving gimmick (seen in the entities or in
   * `pos.state: Gimmick`). Their refusals stay in this go's plan instead of the map record.
   */
  gimmickMaps?: Set<string>;
  /**
   * Task 99: maps whose `kind: All` entities have been read this run, so a non-moving map is
   * not re-read on every replan (the full query is the expensive one).
   */
  gimmickChecked?: Set<string>;
  /** Ways seen earlier on a map (conveyors, falls, layer changes), for the next plan. */
  moves?: (mapId: unknown) => readonly ObservedMove[];
  /**
   * World-map terrain read through bridge 0.14.0's `cells.at`, by map id. Memory only and one
   * per game's MoveState; the story can change terrain, so every plan rereads the player's
   * window over it (task 56).
   */
  world?: WorldCache;
}

const EMPTY_CUT: ReadonlySet<string> = new Set<string>();

/**
 * Task 73: after this many blocks a "走不过去" record is trusted as a wall. A stale record
 * (11-09, map 252: one temporary NPC turned (9,13)→(9,14) into a permanent wall) is re-walked
 * until then, but a real wall is not hit on every plan.
 */
export const BLOCKED_TRUST_COUNT = 3;

/*
 * Task 83: 11-10, Fire-Powered Ship 265. The four 通路に流される event cells on its south
 * row look like open floor in the collision grid. `go` was refused once, wrote "走不过去" and
 * never tried again, although grind walked onto (9,16) and (13,16) later. A refusal on an
 * event cell is a timing, not a wall: try again from every standable side.
 */
export const EVENT_TRY_COUNT = 3;
export const EVENT_TRY_WAIT_MS = 1_000;

/*
 * Task 84 (11-10): a conveyor, fall or trap can carry the party off the path, and the old
 * `go` handed the call back to the model after one ride. It now walks on from the landing.
 * Two limits keep a loop from running forever: the same edge twice, and four rides in one go.
 */
export const CARRY_REPEAT_LIMIT = 2;
export const CARRY_TOTAL_LIMIT = 4;

/*
 * Task 99 (11-10): Fire-Powered Ship 270's sliding floor is an entity, not a collision change,
 * so a step blocked while the platform was elsewhere was written as a permanent wall. The map
 * is recognised by inference: the bridge's entities name/type the moving gimmick, or a
 * position read on the map has been in MainState=Gimmick. Nothing in the game states it
 * directly, so keep these words conservative and easy to extend.
 */
const MOVING_GIMMICK_WORDS: readonly string[] = ["滑动地板", "移动平台", "Gimmick"];
const MOVING_GIMMICK_HOW = "移动机关";
export const MOVING_GIMMICK_QUERY_MAX = 400;

// Task 58: these are the defaults; Config carries the live values on MoveState.
export const WALKPATH_TIMEOUT_MS = 60_000;
export const WALKPATH_BLOCKED_MS = 800;
export const WALKPATH_TURN_LEAD = 0.6;
// Task 63: an encounter starts on a MainState=Event frame before the battle is up (11-08).
export const WALKPATH_EVENT_POLL_MS = 200;
export const WALKPATH_EVENT_WAIT_MS = 2_500;
/** The link waits for the bridge's walk plus this margin; the bridge's own timeout is smaller. */
export const WALKPATH_WAIT_MS = WALKPATH_TIMEOUT_MS + 5_000;

/**
 * A whole-map route on the world map can run past 100 cells; a fixed 60 s would end such a walk
 * with "timeout" and stop the call (11-05 review). One second a cell, between the configured
 * base and the bridge's 300 s cap.
 */
export function walkpathTimeout(cells: number, state?: MoveState): number {
  const base = state?.walkpathTimeoutMs ?? WALKPATH_TIMEOUT_MS;
  return Math.min(300_000, Math.max(base, cells * 1_000));
}

/** The label `walkpath` and a walk push carry: the tool's base plus the current hop. */
export function walkLabel(state?: MoveState): string {
  const base = state?.label ?? "";
  if (base === "") return "";
  const hop = state?.hop;
  return (hop === undefined ? base : `${base} 第 ${hop} 跳`).slice(0, 80);
}

/** Task 58: Config's values for the bridge walkpath, defaulting like before. */
export function walkpathBlockedMs(state?: MoveState): number {
  return state?.walkpathBlockedMs ?? WALKPATH_BLOCKED_MS;
}

export function walkpathTurnLead(state?: MoveState): number {
  return state?.walkpathTurnLead ?? WALKPATH_TURN_LEAD;
}

export function walkpathEventPollMs(state?: MoveState): number {
  return state?.walkpathEventPollMs ?? WALKPATH_EVENT_POLL_MS;
}

export function walkpathEventWaitMs(state?: MoveState): number {
  return state?.walkpathEventWaitMs ?? WALKPATH_EVENT_WAIT_MS;
}

/** Task 83: Config's tries per side when the goal is an event cell, defaulting to 3. */
export function eventTryCount(state?: MoveState): number {
  const count = state?.eventTryCount ?? EVENT_TRY_COUNT;
  return Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : EVENT_TRY_COUNT;
}

/** Task 83: Config's wait between those tries, defaulting to one second. */
export function eventTryWaitMs(state?: MoveState): number {
  const wait = state?.eventTryWaitMs ?? EVENT_TRY_WAIT_MS;
  return Number.isFinite(wait) ? Math.max(0, Math.trunc(wait)) : EVENT_TRY_WAIT_MS;
}

/** Task 84: Config's repeats of one carry before one go stops, defaulting to two. */
export function carryRepeatLimit(state?: MoveState): number {
  const count = state?.carryRepeatLimit ?? CARRY_REPEAT_LIMIT;
  return Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : CARRY_REPEAT_LIMIT;
}

/** Task 84: Config's carries per go before it stops, defaulting to four. */
export function carryTotalLimit(state?: MoveState): number {
  const count = state?.carryTotalLimit ?? CARRY_TOTAL_LIMIT;
  return Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : CARRY_TOTAL_LIMIT;
}
/** A whole navigate call's loop cap; battles do not count against `legs`, so this bounds them. */
const MAX_WALK_TURNS = 200;

// Named events that move the party although their cells are open floor (10-27: the
// Fire-Powered Ship's conveyor 流される carried the player off the path). A prefix can say
// how far it carries the party: Walse Castle's 54 "１マス流される" and "３マス流される".
const CONVEYOR_WORDS: readonly string[] = ["流される"];

export function isConveyorEvent(name: string): boolean {
  const base = eventBaseName(name);
  return CONVEYOR_WORDS.some((word) => base.includes(word));
}

/**
 * Task 99: whether one bridge entity is a moving gimmick, by its name or its type. This is a
 * guess from the words the games use; 11-10's map 270 gives `SlidingFloorGimmickArea` and its
 * display name contains 滑动地板/移动平台. An unknown moving object still gets caught by the
 * `pos.state: Gimmick` fallback.
 */
export function isMovingGimmickEntity(entity: Json): boolean {
  const words = [text(entity.name), text(entity.kind), text(entity.class)]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
  return MOVING_GIMMICK_WORDS.some((word) => words.includes(word.toLowerCase()));
}

/** Task 99: whether any of a map's entities (or a seen Gimmick state) marks it as moving. */
export function hasMovingGimmick(entities: readonly Json[], sawGimmickState = false): boolean {
  return sawGimmickState || entities.some((entity) => isMovingGimmickEntity(entity));
}

/** Python's tuple repr for a cell, which the messages embed. */
function cellText(cell: Cell | null): string {
  return cell === null ? "None" : `(${cell[0]}, ${cell[1]})`;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  return JSON.stringify(value);
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

/** A bridge map id as a number, for the walk view; null when it cannot be read. */
function mapNumber(value: unknown): number | null {
  const map = num(value);
  return map === undefined ? null : Math.trunc(map);
}

function sameCell(a: Cell | null, b: Cell | null): boolean {
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1];
}

/** Whether two recorded blocked steps are the same edge on the same floor (task 73). */
function sameBlockedMove(left: ObservedMove, right: ObservedMove): boolean {
  return (
    sameCell(left.from, right.from) &&
    sameCell(left.to, right.to) &&
    left.layer === right.layer &&
    left.kind === right.kind
  );
}

/** Whether a recorded blocked step is the directed step from→to being hit now. */
function sameMoveStep(move: ObservedMove, from: Cell, to: Cell): boolean {
  return sameCell(move.from, from) && sameCell(move.to, to);
}

/**
 * Task 83: a "走不过去" record that ends on an event cell. Such a step can be refused once
 * and accepted later (11-10, Fire-Powered Ship 265), so it must not close the edge.
 */
function blockedOnEvent(
  move: ObservedMove,
  events: ReadonlyMap<string, string> | undefined,
): boolean {
  return move.how === "走不过去" && events?.has(cellKey(move.to[0], move.to[1])) === true;
}

function adjacent(a: Cell, b: Cell): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

/**
 * The game's route given only at its turns, filled in cell by cell. Two consecutive points
 * that are neither on one row nor in one column are not a corner pair at all (a diagonal jump
 * or a broken route), so the caller uses its own plan instead (task 56).
 */
export function expandCorners(route: readonly Cell[]): Cell[] | null {
  const out: Cell[] = [];
  for (const cell of route) {
    const before = out[out.length - 1];
    if (before === undefined || sameCell(before, cell)) {
      out.push(cell);
      continue;
    }
    const dx = cell[0] - before[0];
    const dy = cell[1] - before[1];
    if (dx !== 0 && dy !== 0) return null;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    for (let i = 1; i <= Math.abs(dx) + Math.abs(dy); i++) {
      out.push([before[0] + stepX * i, before[1] + stepY * i]);
    }
  }
  return out;
}

/**
 * The part of a planned route walkpath can walk: every cell is four-way adjacent. Our search
 * gives every cell except where a conveyor, fall or other move carries the party: that step is
 * a jump, so the command stops on the cell before it and the next plan starts from wherever the
 * game put the party (task 56).
 */
export function walkPathCells(route: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of route) {
    const before = out[out.length - 1];
    if (before === undefined || sameCell(before, cell)) {
      out.push(cell);
      continue;
    }
    if (adjacent(before, cell)) {
      out.push(cell);
      continue;
    }
    // A planned route is cell by cell except where a move carries the party; any gap is that
    // jump, even along one row or column, so the command stops on the cell before it.
    break;
  }
  return out;
}

/** The blocked steps already found on this map, created on first use. */
function cutsFor(state: MoveState, map: unknown): Set<string> {
  state.cuts ??= new Map();
  const key = show(map);
  let cut = state.cuts.get(key);
  if (cut === undefined) {
    cut = new Set();
    state.cuts.set(key, cut);
  }
  return cut;
}

/** Task 99: the maps this run already knows move; the atlas field is written once per map. */
function gimmickMaps(state: MoveState | undefined): Set<string> | null {
  if (state === undefined) return null;
  return (state.gimmickMaps ??= new Set());
}

/**
 * Task 99: remember that a map moves, in this run and in the map record. The record goes
 * through `state.link` with `gimmick: true`; the Game's existing wiring passes it to
 * Atlas.link, which treats it as a mark, not as a move.
 */
async function markMovingGimmick(
  state: MoveState,
  map: unknown,
  cell: Cell | null = null,
): Promise<void> {
  const maps = gimmickMaps(state);
  if (maps === null) return;
  const key = show(map);
  if (maps.has(key)) return;
  maps.add(key);
  await state.link?.(map, cell ?? [0, 0], cell ?? [0, 0], MOVING_GIMMICK_HOW, {
    gimmick: true,
  });
}

/** Task 99: refusals kept for one `go` on a moving-gimmick map. */
interface TemporaryCuts {
  readonly edges: Set<string>;
  readonly layers: Map<number, Set<string>>;
}

/**
 * Keep a blocked step. On a layered map it belongs to the floor the party stood on, so the
 * same step on the other floor stays open (11-09, Walse Castle 54); a one-floor map keeps
 * the old map-wide cut.
 *
 * With `temporary`, the step only closes this `go`'s search: a moving platform may be gone
 * next time (task 99), and nothing goes into the atlas.
 */
async function recordBlockedStep(
  pilot: Pilot,
  state: MoveState,
  map: unknown,
  cut: Set<string>,
  from: Cell,
  to: Cell,
  layered: number | null,
  remember = true,
  temporary?: TemporaryCuts,
): Promise<void> {
  const layer = layered === null ? null : ((await collisionLayer(pilot)) ?? layered);
  if (layer === null) {
    cut.add(edgeKey(from, to));
    if (temporary === undefined) cutsFor(state, map).add(edgeKey(from, to));
  }
  if (temporary !== undefined) {
    if (layer !== null) {
      const edges = temporary.layers.get(layer) ?? new Set<string>();
      edges.add(edgeKey(from, to));
      temporary.layers.set(layer, edges);
    } else {
      temporary.edges.add(edgeKey(from, to));
    }
    return;
  }
  if (layer !== null) {
    state.layeredCuts ??= new Map();
    const key = show(map);
    const layers = state.layeredCuts.get(key) ?? new Map<number, Set<string>>();
    const edges = layers.get(layer) ?? new Set<string>();
    edges.add(edgeKey(from, to));
    layers.set(layer, edges);
    state.layeredCuts.set(key, layers);
  }
  // Task 83: an event cell is cut for this call only; the atlas never records it as a wall.
  if (remember && state.link) {
    await state.link(map, from, to, "走不过去", layer === null ? {} : { layer });
  }
}

function cellGridOf(value: unknown): CellGrid | null {
  if (!isRecord(value)) return null;
  const origin = cellOf(value.origin);
  const center = cellOf(value.center);
  if (origin === null || center === null || !Array.isArray(value.attr)) return null;
  const attr: (number | null)[][] = [];
  for (const row of value.attr) {
    if (!Array.isArray(row)) return null;
    attr.push(row.map((item) => (typeof item === "number" ? item : null)));
  }
  if (attr.length === 0) return null;
  return { origin, center, attr };
}

/**
 * Walk to a cell. Battles on the way are fought by the local battle skill; doors and
 * other gimmicks that briefly take control are waited out.
 */
export async function walkLeg(
  pilot: Pilot,
  x: number,
  y: number,
  say: Say,
  state: MoveState = { drake: null },
): Promise<Reply> {
  let result: Reply = {};
  for (let i = 0; i < 10; i++) {
    result = await pilot.send("walk", { to: [x, y], timeout: 30000 }, 40_000);
    const pos = record(result.pos);
    if (pos.state === "Gimmick" && num(pos.map) !== undefined) {
      await markMovingGimmick(state, pos.map, cellOf(pos.cell));
    }
    if (truthy(result.ok)) return result;
    if (truthy(pos.battle) || pos.state === "Battle") {
      const battle = await regular(pilot, state.battle ?? {}, say, state.saveSlot, {
        flee: state.flee === true,
      });
      say(`  途中遇敌,${battle}`);
    } else if (pos.state === "FieldHelp") {
      // First visit to a map: the walk stops on the hint overlay. Close it and walk on.
      const help = await dismissFieldHelp(pilot);
      if (help === "stuck") return { ok: false, error: FIELD_HELP_STUCK, pos };
      if (help === "closed") say("  关掉了操作提示");
    } else if (pos.state === "Gimmick" || String(result.error).includes("Gimmick")) {
      await pilot.send("wait", { timeout: 30000 }, 40_000);
    } else {
      return result;
    }
  }
  return result;
}

/**
 * Cells to keep off: chests, NPCs and shop counters (RelayInteraction: talking to it
 * talks to the keeper behind), none of them in the collision data, and entrances, since
 * crossing stairs or a door on the way swaps the map. Conveyors and currents are soft
 * hazards kept in `dangers`, not here. The caller removes the goal.
 */
export async function occupiedCells(pilot: Pilot): Promise<Cell[]> {
  return (await blockingCells(pilot)).blocked;
}

/** A PointIn cell a map exit may drop the party on, with the height it lands on. */
export interface Landing {
  readonly cell: Cell;
  readonly layer: number | null;
}

/** A hypothetical start, for asking whether a landing could reach a goal. */
export interface PlanStart {
  readonly cell: Cell;
  readonly layer?: number | null;
}

/**
 * The cells plan() must walk around, and the conveyor cells among them, from one entities
 * query per kind (a query per step would be far too slow). Conveyors stay in `conveyors`
 * even when the caller later lets a goal through, so a ride can still be recognised.
 *
 * `withTransitions` also asks for ToLayer cells, which are walkable but change the height
 * (11-03, Fire-Powered Ship 261: the game has four at the vent, (15,19), (16,19), (15,20)
 * and (16,20); the collision codes there are plain floor, so only the entities tell).
 */
async function blockingCells(
  pilot: Pilot,
  withTransitions = false,
  withGimmick = false,
): Promise<{
  blocked: Cell[];
  conveyors: ReadonlySet<string>;
  dangers: DangerCell[];
  transitions: LayerChange[];
  falls: Cell[];
  landings: Landing[];
  holeMoves: ObservedMove[];
  /** Task 83: active Event cells by cellKey, with the entity's name. */
  events: ReadonlyMap<string, string>;
  /** Task 99: this map has a moving gimmick (an entity or a seen Gimmick state). */
  gimmick: boolean;
}> {
  const found = new Map<string, Cell>();
  const conveyors = new Set<string>();
  const dangers = new Map<string, DangerCell>();
  const transitions = new Map<string, LayerChange>();
  const falls = new Map<string, Cell>();
  const landings = new Map<string, Landing>();
  const events = new Map<string, string>();
  const seenEntities: Json[] = [];
  let holeMoves: ObservedMove[] = [];
  const kinds = ["TresureBox", "Npc", "RelayInteraction", "GotoMap", "Event"];
  if (withTransitions) kinds.push("ToLayer", "PointIn");
  for (const kind of kinds) {
    const reply = record((await pilot.send("entities", { kind, max: 200 })).entities);
    for (const entity of Array.isArray(reply.entities) ? reply.entities : []) {
      if (!isRecord(entity)) continue;
      seenEntities.push(entity);
      const active = entity.active === undefined ? true : truthy(entity.active);
      const cell = cellOf(entity.cell);
      if (!active || cell === null) continue;
      const name = text(entity.name) ?? "";
      const key = cellKey(cell[0], cell[1]);
      // Task 83: every active Event entity is a trigger cell (look_around draws it as `!`),
      // named or not; a 流される entity of another kind counts by its name too.
      if (kind === "Event" || name.includes("流される")) rememberEvent(events, key, name);
      if (kind === "ToLayer") {
        transitions.set(key, { cell, to: targetLayer(entity) });
        continue;
      }
      // PointIn cells are arrival points, not obstacles; the named ones are landing spots
      // where a fall or a script puts the party (11-03, Fire-Powered Ship 261).
      if (kind === "PointIn") {
        if (name.includes("落下点")) {
          falls.set(key, cell);
        } else {
          landings.set(key, { cell, layer: entityLayer(entity.myLayer) });
        }
        continue;
      }
      // Events are ordinary floor unless they are known to carry the party away. Water
      // currents (流される) are the same as conveyors, but keep the layer they sit on: the
      // same cell on the other floor is ordinary floor (11-09, Walse Castle 54).
      if (kind === "Event") {
        if (!isConveyorEvent(name)) continue;
        conveyors.add(key);
        dangers.set(key, { cell, layer: entityLayer(entity.myLayer) });
        continue;
      }
      found.set(key, cell);
    }
  }
  // Task 99: moving gimmicks can sit in any group, so read them all (0.13.5's kind All). This
  // also gives the hole edges when transitions were asked for, instead of a second query.
  if (withTransitions || withGimmick) {
    const all = record(
      (await pilot.send("entities", { kind: "All", max: MOVING_GIMMICK_QUERY_MAX })).entities,
    );
    const entities = records(all.entities);
    seenEntities.push(...entities);
    if (withTransitions) holeMoves = fallMoves(entities);
  }
  return {
    blocked: [...found.values()],
    conveyors,
    dangers: [...dangers.values()],
    transitions: [...transitions.values()],
    falls: [...falls.values()],
    landings: [...landings.values()],
    holeMoves,
    events,
    gimmick: (withGimmick || withTransitions) && hasMovingGimmick(seenEntities),
  };
}

/**
 * Remember an event cell's name, keeping the first non-empty one when a map has several
 * entities on the cell (task 83). An empty name is still an event cell: look_around draws
 * every Event entity as `!`.
 */
function rememberEvent(events: Map<string, string>, key: string, name: string): void {
  if (!events.has(key) || (events.get(key) === "" && name !== "")) events.set(key, name);
}

/** Every PointIn cell a map exit may drop the party on, except the named fall landings. */
export async function landingCells(pilot: Pilot): Promise<Landing[]> {
  const reply = record((await pilot.send("entities", { kind: "PointIn", max: 60 })).entities);
  return records(reply.entities).flatMap((entity): Landing[] => {
    if (!isRecord(entity)) return [];
    const active = entity.active === undefined ? true : truthy(entity.active);
    const cell = cellOf(entity.cell);
    const name = text(entity.name) ?? "";
    if (!active || cell === null || name.includes("落下点")) return [];
    return [{ cell, layer: entityLayer(entity.myLayer) }];
  });
}

/** The layer a ToLayer entity puts the party on: the property's `layer` (0 bottom, 1
 * ground, 2 upper) or the `changeLayer` name (0.13.4+), null when the bridge has neither. */
function targetLayer(entity: Json): number | null {
  const raw = entity.layer ?? entity.targetLayer;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    const named = raw.toLowerCase();
    if (named.includes("upper") || named.includes("top")) return 2;
    if (named.includes("ground")) return 1;
    if (named.includes("bottom")) return 0;
  }
  return null;
}

/** Which floor the walk starts and ends on, when the map has more than one. */
interface LayerInfo {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly transitions: readonly LayerChange[];
}

interface Planned {
  readonly here: Cell | null;
  readonly path: Cell[];
  /**
   * False when the map could not be read well enough to tell a disconnected goal from an
   * unreadable one (no cells/collision reply, no layered grid, a start off the grid).
   * `canReach` then says "maybe" instead of stopping the walk (11-09).
   */
  readonly known: boolean;
  /** Conveyor cells including the goal, so a ride onto it can be recognised. */
  readonly conveyors: ReadonlySet<string>;
  /** Named 落下点 cells in view, so a fall off the path can be told apart from a walk. */
  readonly falls: ReadonlySet<string>;
  /** Danger cells the route has to step on; empty when another way was found. */
  readonly washed: readonly Cell[];
  /**
   * Task 83: active Event cells of this map, keyed with cellKey, with their names. Used to
   * tell an event cell from a wall and to try a goal that is one.
   */
  readonly events?: ReadonlyMap<string, string>;
  /**
   * Task 99: this map has a moving gimmick; refusals stay in this `go`'s plan instead of the
   * map record.
   */
  readonly gimmick?: boolean;
  /**
   * Task 83: cells reachable from the start when an event goal was planned, so the tries can
   * skip a side that is a wall without walking there. Undefined for other goals.
   */
  readonly reachable?: ReadonlySet<string>;
  /** Set on a multi-floor map (11-03, Fire-Powered Ship 261); undefined on one floor. */
  readonly layer?: LayerInfo;
  /** The grid this plan searched, for the walk view's cropped rows (task 61). */
  readonly base?: WalkBase;
  /**
   * Task 73: the atlas "走不过去" records this path went around because they were not yet
   * trusted. A walk that gets through forgets them; one blocked on the same step counts it.
   */
  readonly suspects?: readonly ObservedMove[];
}

/**
 * (start cell, path including start) toward goal on the current map, or (None, []) while a
 * map is still loading. `cut`: steps (from, to) found blocked on the way.
 */
export async function plan(
  pilot: Pilot,
  goal: Cell,
  byShip: boolean,
  cut: ReadonlySet<string> = EMPTY_CUT,
  state?: MoveState,
  map?: unknown,
  start?: PlanStart,
): Promise<[Cell | null, Cell[]]> {
  const { here, path } = await plannedRoute(pilot, goal, byShip, cut, state, map, start);
  return [here, path];
}

/**
 * Whether a route from `start` reaches `goal` on this map. Used to judge the landings of a
 * map record before sending the party through another map (11-09, Walse Castle 54).
 *
 * Only a route that was actually searched may say "no": an unreadable cells/collision reply,
 * a missing layered grid, a start cell off the grid or a malformed layer is "maybe", so
 * callers walk instead of refusing (11-09, Fire-Powered Ship 252: a party standing on the
 * door cell was told the goal was disconnected).
 */
export async function canReach(
  pilot: Pilot,
  goal: Cell,
  state?: MoveState,
  map?: unknown,
  start?: PlanStart,
): Promise<boolean> {
  try {
    const { here, path, known } = await plannedRoute(
      pilot,
      goal,
      false,
      EMPTY_CUT,
      state,
      map,
      start,
    );
    if (here === null || !known) return true;
    return sameCell(path[path.length - 1] ?? null, goal);
  } catch {
    // Reading the map failed (old bridge, malformed collision reply, no route data). That is
    // no evidence of a disconnected goal; let navigate try, as it did before task 70.
    return true;
  }
}

/**
 * The world map's known terrain, extended toward goal while the plan cannot reach it (task 56).
 * The first window is always the player's own, read over the cache so a story change is seen.
 * Extra windows need bridge 0.14.0's `at`; without it the old one-window behaviour stays.
 * At most MAX_WORLD_WINDOWS windows are read in one plan.
 */
async function worldPlanGrid(
  pilot: Pilot,
  first: unknown,
  cells: CellGrid,
  goal: Cell,
  aloft: boolean,
  rule: CellRule,
  entrances: readonly Cell[],
  cut: ReadonlySet<string>,
  state: MoveState | undefined,
  map: unknown,
): Promise<CellGrid> {
  const firstWindow = (): CellGrid => (aloft ? cells : withoutEntrances(cells, entrances, goal));
  if (state === undefined || map === undefined) return firstWindow();
  const cache = (state.world ??= createWorldCache());
  if (hasAt(first)) cache.at = true;
  const terrain = mergeWindow(cache, map, cells);
  const merged = (): CellGrid => {
    const grid = cache.at === true ? worldGrid(terrain, cells.center) : cells;
    return aloft ? grid : withoutEntrances(grid, entrances, goal);
  };
  let grid = merged();
  let path = pathToward(grid, goal, rule, cut);
  if (cache.at === false || sameCell(path[path.length - 1] ?? null, goal)) return grid;
  let reads = 1;
  const centers = windowCenters(terrain, cells.center, goal, MAX_WORLD_WINDOWS - reads);
  for (const center of centers) {
    if (reads >= MAX_WORLD_WINDOWS) break;
    // An old bridge ignores `at`; the missing echo marks it once and the old way stays.
    const raw = record(
      (await pilot.send("cells", { r: WORLD_RADIUS, at: [center[0], center[1]] })).cells,
    );
    if (!hasAt(raw)) {
      cache.at = false;
      break;
    }
    cache.at = true;
    const read = cellGridOf(raw);
    if (read === null) break;
    mergeWindow(cache, map, read);
    reads += 1;
    grid = merged();
    path = pathToward(grid, goal, rule, cut);
    if (sameCell(path[path.length - 1] ?? null, goal)) break;
  }
  return grid;
}

async function plannedRoute(
  pilot: Pilot,
  goal: Cell,
  byShip: boolean,
  cut: ReadonlySet<string>,
  state?: MoveState,
  map?: unknown,
  start?: PlanStart,
  temporaryLayers?: ReadonlyMap<number, ReadonlySet<string>>,
): Promise<Planned> {
  const raw = (await pilot.send("cells", { r: WORLD_RADIUS })).cells;
  const cells = cellGridOf(raw);
  if (cells === null) {
    return {
      here: null,
      path: [],
      known: false,
      conveyors: new Set(),
      falls: new Set<string>(),
      washed: [],
    };
  }
  if (hasTerrain(cells)) {
    const aloft = await flying(pilot);
    const rule = terrainRule(byShip, aloft);
    // On foot or by ship, stepping on another place's entrance walks into it (10-27, twice:
    // the way from (87, 76) to the Fire-Powered Ship at (84, 79) crossed Karnak Castle's door).
    // The drake does not land by flying over one, so flying keeps every cell.
    const entrances = aloft ? [] : await entranceCells(pilot);
    const grid = await worldPlanGrid(
      pilot,
      raw,
      cells,
      goal,
      aloft,
      rule,
      entrances,
      cut,
      state,
      map,
    );
    return {
      here: cells.center,
      path: pathToward(grid, goal, rule, cut),
      known: true,
      conveyors: new Set(),
      falls: new Set(),
      washed: [],
      base: worldBase(state?.game ?? "", mapNumber(map), grid),
    };
  }
  const collision = record((await pilot.send("collision")).collision);
  const floors = Array.isArray(collision.layers) ? collision.layers.length : 0;
  const mapKey = map === undefined ? null : show(map);
  const checked = mapKey !== null && (state?.gimmickChecked?.has(mapKey) ?? false);
  const { blocked, conveyors, dangers, transitions, falls, holeMoves, events, gimmick } =
    await blockingCells(pilot, floors > 1, map !== undefined && !checked);
  if (mapKey !== null && state !== undefined) {
    (state.gimmickChecked ??= new Set()).add(mapKey);
  }
  const recordedMoves = state?.moves && map !== undefined ? state.moves(map) : [];
  const seenGimmick =
    (mapKey !== null && (state?.gimmickMaps?.has(mapKey) ?? false)) ||
    movesFromMovingGimmickMap(recordedMoves);
  const movingGimmick = gimmick || seenGimmick;
  if (movingGimmick && state !== undefined && map !== undefined) {
    await markMovingGimmick(state, map, cells.center);
  }
  // Task 83: a "走不过去" record whose target is an event cell is not a wall. It stays in
  // the atlas (it is still history), but this plan must not use it. 11-10, map 265: the three
  // records all ended on 通路に流される cells, and grind walked two of those steps later.
  const moves = [...recordedMoves, ...holeMoves].filter(
    (move) =>
      !blockedOnEvent(move, events) &&
      // Task 99: a single refusal on a moving map is a snapshot, not a wall.
      !(movingGimmick && move.how === "走不过去" && (move.count ?? 1) < 2),
  );
  // A conveyor or fall whose landing we have seen is a directed edge; until then it stays a
  // danger cell, so the party does not walk onto it blind but can when there is no other way.
  const forced = new Set(
    moves
      .filter(
        (move) =>
          move.kind === "conveyor" ||
          move.kind === "fall" ||
          move.how.includes("传送带") ||
          move.how.includes("掉下去"),
      )
      .map((move) => cellKey(move.from[0], move.from[1])),
  );
  const occupied = blocked.filter((cell) => !sameCell(cell, goal));
  const risky = dangers.filter(
    (danger) =>
      !sameCell(danger.cell, goal) && !forced.has(cellKey(danger.cell[0], danger.cell[1])),
  );
  const grid = layeredGrid(collision, occupied, transitions, moves, risky);
  const fallSet = new Set(falls.map((cell) => cellKey(cell[0], cell[1])));
  if (grid === null) {
    return {
      here: cells.center,
      path: [],
      known: false,
      conveyors,
      falls: fallSet,
      washed: [],
    };
  }
  const startGrid = start === undefined ? grid : startAt(grid, start);
  const onGrid = startOnGrid(startGrid, startGrid.center);
  const layerCut = observedLayerCuts(moves, grid, state, map, undefined, temporaryLayers);
  const route = layeredRouteAvoiding(startGrid, goal, cut, layerCut);
  // Task 83: an event goal is tried from every standable side. The reachable cells tell the
  // tries which sides are walls without walking to each one first.
  const eventGoal = events.has(cellKey(goal[0], goal[1]));
  const reachable = eventGoal ? reachableCells(startGrid, cut, layerCut) : undefined;
  let nodes = route.path;
  let danger = route.danger;
  let suspects: ObservedMove[] | undefined;
  const last = nodes[nodes.length - 1];
  // 11-09: an old "走不过去" record may be one temporary block. When removing the untrusted
  // ones makes the goal reachable, walk that route and let the walk prove the record right or
  // wrong (task 73); the trusted records and this call's cuts stay walls. Without both callbacks
  // the atlas cannot be updated, so a test/standalone plan keeps reading the record as a wall.
  const canVerify = state?.link !== undefined && state.forgetBlocked !== undefined;
  if (
    canVerify &&
    onGrid &&
    !sameCell(last === undefined ? null : ([last[0], last[1]] as const), goal)
  ) {
    const untrusted = untrustedBlockedSteps(moves, grid, state, map);
    if (untrusted.length > 0) {
      const relaxedCuts = observedLayerCuts(
        moves,
        grid,
        state,
        map,
        (move) => !untrusted.includes(move),
        temporaryLayers,
      );
      const relaxed = layeredRouteAvoiding(startGrid, goal, cut, relaxedCuts);
      const relaxedPath = cellsOf(relaxed.path);
      if (sameCell(relaxedPath[relaxedPath.length - 1] ?? null, goal)) {
        nodes = relaxed.path;
        danger = relaxed.danger;
        suspects = untrusted.filter((move) => pathHasStep(relaxedPath, move.from, move.to));
        // In a one-way graph a removed record always appears on the new path; keep the list
        // whole if a loaded record duplicated another and the match missed.
        if (suspects.length === 0) suspects = untrusted;
      }
    }
  }
  return {
    here: startGrid.center,
    path: cellsOf(nodes),
    known: onGrid,
    conveyors,
    falls: fallSet,
    washed: danger.map(([x, y]) => [x, y] as const),
    events,
    ...(movingGimmick ? { gimmick: true } : {}),
    ...(reachable === undefined ? {} : { reachable }),
    layer: layerInfo(startGrid, nodes, transitions),
    base: indoorBase(state?.game ?? "", mapNumber(map), startGrid),
    ...(suspects === undefined ? {} : { suspects }),
  };
}

/** Whether a planned cell path walks the directed step from→to somewhere. */
function pathHasStep(path: readonly Cell[], from: Cell, to: Cell): boolean {
  for (let i = 1; i < path.length; i++) {
    if (sameCell(path[i - 1] ?? null, from) && sameCell(path[i] ?? null, to)) return true;
  }
  return false;
}

/** Whether the party's start cell lies on the floor the layered grid searched. */
function startOnGrid(grid: LayeredGrid, cell: Cell): boolean {
  const rows = grid.heights.get(grid.z);
  if (rows === undefined) return false;
  return (
    cell[1] >= 0 && cell[1] < rows.length && cell[0] >= 0 && cell[0] < (rows[cell[1]]?.length ?? 0)
  );
}

/** The grid seen from a hypothetical landing, as a map exit would drop the party there. */
function startAt(grid: LayeredGrid, start: PlanStart): LayeredGrid {
  const layer = start.layer ?? null;
  return {
    ...grid,
    center: start.cell,
    z: layer !== null && grid.heights.has(layer) ? layer : grid.z,
  };
}

/** The base collision layer of a map, where records without a layer are taken to belong. */
function baseLayer(grid: LayeredGrid): number | null {
  for (const layer of grid.heights.keys()) return layer;
  return null;
}

/**
 * Blocked steps from the atlas (and this run) as cuts per height. A record without a layer
 * belongs to the base floor: on 54 the old (28,52)→(28,53) refusal was made on the ground
 * floor and must not close the upper corridor to the world-map exit (11-09).
 *
 * `keep` leaves out untrusted atlas records for the verification route (task 73); this call's
 * own cuts in `state.layeredCuts` are never left out.
 */
function observedLayerCuts(
  moves: readonly ObservedMove[],
  grid: LayeredGrid,
  state: MoveState | undefined,
  map: unknown,
  keep: (move: ObservedMove) => boolean = () => true,
  temporary?: ReadonlyMap<number, ReadonlySet<string>>,
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const add = (layer: number, from: Cell, to: Cell): void => {
    if (!grid.heights.has(layer)) return;
    const set = out.get(layer) ?? new Set<string>();
    set.add(edgeKey(from, to));
    out.set(layer, set);
  };
  const addEdge = (layer: number, edge: string): void => {
    if (!grid.heights.has(layer)) return;
    const set = out.get(layer) ?? new Set<string>();
    set.add(edge);
    out.set(layer, set);
  };
  const base = baseLayer(grid);
  for (const move of moves) {
    if (move.how !== "走不过去" || !keep(move)) continue;
    const layer = move.layer ?? base;
    if (layer !== null) add(layer, move.from, move.to);
  }
  if (state?.layeredCuts !== undefined && map !== undefined) {
    for (const [layer, cut] of state.layeredCuts.get(show(map)) ?? []) {
      for (const edge of cut) addEdge(layer, edge);
    }
  }
  // Task 99: a moving-gimmick map also has refusals found earlier in this same go.
  for (const [layer, cut] of temporary ?? []) {
    for (const edge of cut) addEdge(layer, edge);
  }
  return out;
}

/** The atlas blocked steps still worth walking through: not yet trusted, not cut this call. */
function untrustedBlockedSteps(
  moves: readonly ObservedMove[],
  grid: LayeredGrid,
  state: MoveState | undefined,
  map: unknown,
): ObservedMove[] {
  const trust = blockedTrustCount(state);
  const base = baseLayer(grid);
  const own =
    state?.layeredCuts === undefined || map === undefined
      ? undefined
      : state.layeredCuts.get(show(map));
  return moves.filter((move) => {
    if (move.how !== "走不过去" || (move.count ?? 1) >= trust) return false;
    const layer = move.layer ?? base;
    if (layer === null || !grid.heights.has(layer)) return false;
    // A step cut in this same call stays a wall, whatever an old record says (task 73).
    return own?.get(layer)?.has(edgeKey(move.from, move.to)) !== true;
  });
}

/** Task 73's Config value: how many blocks make a "走不过去" record a wall. */
function blockedTrustCount(state: MoveState | undefined): number {
  const count = state?.blockedTrustCount ?? BLOCKED_TRUST_COUNT;
  return Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : BLOCKED_TRUST_COUNT;
}

function cellsOf(route: readonly LayerNode[]): Cell[] {
  return route.map(([x, y]) => [x, y] as const);
}

/** The cells connected to the party on the layered grid, ignoring danger but not cuts. */
function reachableCells(
  grid: LayeredGrid,
  cut: ReadonlySet<string>,
  layerCut: ReadonlyMap<number, ReadonlySet<string>>,
): ReadonlySet<string> {
  const blocks = layeredComponents(grid, cut, layerCut, true);
  const start = blocks.get(`${grid.center[0]},${grid.center[1]},${grid.z}`);
  const out = new Set<string>();
  if (start === undefined) return out;
  for (const [key, id] of blocks) {
    if (id !== start) continue;
    const [x, y] = key.split(",");
    if (x === undefined || y === undefined) continue;
    out.add(cellKey(Number(x), Number(y)));
  }
  return out;
}

function layerInfo(
  grid: { readonly z: number; readonly heights: ReadonlyMap<number, unknown> },
  route: readonly LayerNode[],
  transitions: readonly LayerChange[],
): LayerInfo | undefined {
  if (grid.heights.size < 2) return undefined;
  return {
    start: grid.z,
    end: route[route.length - 1]?.[2] ?? grid.z,
    count: grid.heights.size,
    transitions,
  };
}

/** The world map's entrance cells (GotoMap) in view. */
async function entranceCells(pilot: Pilot): Promise<Cell[]> {
  const found = record((await pilot.send("entities", { kind: "GotoMap", max: 300 })).entities);
  return records(found.entities).flatMap((entity) => {
    const cell = cellOf(entity.cell);
    return cell === null ? [] : [cell];
  });
}

/** The grid with every entrance but the goal made impassable (null crosses under no rule). */
function withoutEntrances(cells: CellGrid, entrances: readonly Cell[], goal: Cell): CellGrid {
  const [x0, y0] = cells.origin;
  const closed = entrances.filter((cell) => !sameCell(cell, goal));
  if (closed.length === 0) return cells;
  const attr = cells.attr.map((row) => [...row]);
  for (const [x, y] of closed) {
    const row = attr[y - y0];
    if (row !== undefined && x - x0 >= 0 && x - x0 < row.length) row[x - x0] = null;
  }
  return { ...cells, attr };
}

/** A conveyor on the planned path or right next to it, for a party that ended up elsewhere. */
function conveyorNear(path: readonly Cell[], conveyors: ReadonlySet<string>): Cell | null {
  for (const cell of path) {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = cell[0] + dx;
      const y = cell[1] + dy;
      if (conveyors.has(cellKey(x, y))) return [x, y];
    }
  }
  return null;
}

const RIDE_MS = 8000;
const RIDE_POLL_MS = 300;

function onConveyor(value: unknown, conveyors: ReadonlySet<string>): boolean {
  const cell = cellOf(value);
  return cell !== null && conveyors.has(cellKey(cell[0], cell[1]));
}

/** Where a belt ride ends: the first still position off the belts, or the last seen. */
async function rideEnd(pilot: Pilot, conveyors: ReadonlySet<string>): Promise<Json> {
  const deadline = pilot.now() + RIDE_MS;
  let pos = record((await pilot.send("pos")).pos);
  while (pilot.now() < deadline && (truthy(pos.moving) || onConveyor(pos.cell, conveyors))) {
    await pilot.sleep(RIDE_POLL_MS);
    pos = record((await pilot.send("pos")).pos);
  }
  return pos;
}

/** The layer the route searcher reports right now, or null when the bridge cannot say. */
export async function collisionLayer(pilot: Pilot): Promise<number | null> {
  const collision = record((await pilot.send("collision")).collision);
  const layer = collision.searchLayer;
  return typeof layer === "number" && Number.isFinite(layer) ? Math.trunc(layer) : null;
}

/** The ToLayer cell on the walked path that put the party on `layer`, else the last one. */
function transitionOnPath(
  path: readonly Cell[],
  changes: readonly LayerChange[],
  layer: number,
): Cell | null {
  let fallback: Cell | null = null;
  for (const change of changes) {
    if (!path.some((cell) => sameCell(cell, change.cell))) continue;
    fallback = change.cell;
    if (change.to === layer) return change.cell;
  }
  return fallback;
}

/** Task 84: the game carried the party off the path, within this map or to another one. */
interface CarriedAway {
  readonly from: Cell;
  readonly to: Cell;
  readonly how: "传送带" | "掉下去";
  readonly mapChanged: boolean;
  /** Where the party ended when the map changed; unused for a same-map carry. */
  readonly map: unknown;
}

type AfterWalk =
  | { readonly kind: "carried"; readonly carry: CarriedAway }
  /** The carry started on the goal itself: the cell asked for was reached, so not a deviation. */
  | { readonly kind: "arrived"; readonly text: string }
  | null;

/**
 * What the game did to the party during a walk, beyond the planned steps: a conveyor ride, a
 * fall onto a 落下点, or a layer change. Each is kept in the atlas as a directed way, so the
 * next plan on this map can use it (11-03, Fire-Powered Ship 261).
 *
 * Task 84: a ride or fall that lands on another map is reported too (untouched atlas: the edge
 * belongs to the old map), and a carry that starts on the goal is the arrival the caller asked
 * for, not a deviation.
 */
async function afterWalk(
  pilot: Pilot,
  position: unknown,
  mapId: unknown,
  planned: Planned,
  path: readonly Cell[],
  state: MoveState,
  seen: Set<string>,
  goal: Cell,
): Promise<AfterWalk> {
  let pos = record(position);
  const startedElsewhere = pos.map !== mapId;
  if (!startedElsewhere && planned.conveyors.size > 0 && onConveyor(pos.cell, planned.conveyors)) {
    // The walk reply can be read as the belt starts: the party still stands on it (10-27: the
    // atlas got "在 (13, 23) 传送带 到 (13, 23)" and the tactician took it for a loop belt).
    pos = await rideEnd(pilot, planned.conveyors);
  }
  const cell = cellOf(pos.cell);
  if (cell === null) return null;
  const mapChanged = pos.map !== mapId;
  // A same-cell landing on another map proves nothing, so leave the planned-cell test out.
  // A landing back on the cell the walk started from is a carry even though it is in the
  // path: a loop belt can put the party back where it stood (task 84).
  const backToStart =
    path.length > 1 &&
    sameCell(cell, path[0] ?? null) &&
    !sameCell(cell, path[path.length - 1] ?? null);
  const onPath =
    !mapChanged && !backToStart && path.some((cellOnPath) => sameCell(cellOnPath, cell));
  const layer = mapChanged || planned.layer === undefined ? null : await collisionLayer(pilot);

  if (planned.conveyors.size > 0 && (mapChanged || !onConveyor(pos.cell, planned.conveyors))) {
    const conveyor = conveyorNear(path, planned.conveyors);
    if (conveyor !== null && !onPath) {
      if (sameCell(conveyor, goal)) {
        return { kind: "arrived", text: `到达 ${cellText(goal)},踩上去后被带到 ${cellText(cell)}` };
      }
      const key = `conveyor:${cellKey(conveyor[0], conveyor[1])}>${cellKey(cell[0], cell[1])}`;
      if (!mapChanged && state.link && !seen.has(key)) {
        seen.add(key);
        await state.link(mapId, conveyor, cell, "传送带", {
          kind: "conveyor",
          ...(layer === null ? {} : { toLayer: layer }),
        });
      }
      return {
        kind: "carried",
        carry: { from: conveyor, to: cell, how: "传送带", mapChanged, map: pos.map },
      };
    }
  }

  if (planned.falls.size > 0) {
    const fall = conveyorNear(path, planned.falls);
    if (fall !== null && !onPath) {
      if (sameCell(fall, goal)) {
        return { kind: "arrived", text: `到达 ${cellText(goal)},踩上去后掉到 ${cellText(cell)}` };
      }
      const key = `fall:${cellKey(fall[0], fall[1])}>${cellKey(cell[0], cell[1])}`;
      if (!mapChanged && state.link && !seen.has(key)) {
        seen.add(key);
        await state.link(mapId, fall, cell, "掉下去", {
          kind: "fall",
          ...(layer === null ? {} : { toLayer: layer }),
        });
      }
      return {
        kind: "carried",
        carry: { from: fall, to: cell, how: "掉下去", mapChanged, map: pos.map },
      };
    }
  }

  if (layer !== null && planned.layer && layer !== planned.layer.start) {
    const change = transitionOnPath(path, planned.layer.transitions, layer);
    const key = `layer:${cellKey(change?.[0] ?? -1, change?.[1] ?? -1)}:${layer}`;
    if (change !== null && state.link && !seen.has(key)) {
      seen.add(key);
      await state.link(mapId, change, change, `换层到第 ${layer} 层`, {
        kind: "layer",
        toLayer: layer,
      });
    }
  }
  return null;
}

/**
 * The game's route (bridge `route`) as cells. Its points are local pixel positions, 16 a
 * cell, y growing upwards; the first is where the player stands (`from`), which gives the
 * offset to cells.
 *
 * Each point is taken relative to the first, a whole number of cells away. Rounding each
 * point alone, as the Python version does, breaks on maps whose points sit on half cells
 * (10-27, Fire-Powered Ship 261: x 40, 24, 8, -8 rounded to 2, 2, 0, 0 and the route came out
 * as (16,18),(16,18),(14,18),(14,18), so every route there was thrown away).
 */
export function routeCells(route: Reply): Cell[] {
  const points = Array.isArray(route.cells) ? route.cells : [];
  const start = cellOf(route.from);
  const first = points.length > 0 ? cellOf(points[0]) : null;
  if (points.length === 0 || start === null || first === null) return [];
  const cells: Cell[] = [];
  for (const point of points) {
    const cell = cellOf(point);
    if (cell === null) continue;
    const next: Cell = [
      start[0] + Math.round((cell[0] - first[0]) / 16),
      start[1] - Math.round((cell[1] - first[1]) / 16),
    ];
    if (!sameCell(cells[cells.length - 1] ?? null, next)) cells.push(next);
  }
  return cells;
}

export const FLYING: ReadonlySet<string> = new Set(["LowFlying", "HighFlying", "Flying"]);

/** On the wind drake (the field's moveState reads LowFlying, 10-21). */
export async function flying(pilot: Pilot): Promise<boolean> {
  const field = record(record((await pilot.query("sample")).sample).field);
  return typeof field.moveState === "string" && FLYING.has(field.moveState);
}

/** Grass and plains; the drake does not land on forest, desert or hills. */
export const LANDABLE: ReadonlySet<number> = new Set([3, 4]);

/**
 * Where the wind drake was last left: it stays on the cell it landed on, and standing there
 * with Enter boards it again (10-21).
 */
export async function landHere(pilot: Pilot, state: MoveState): Promise<boolean> {
  await pilot.send("keys", { keys: ["Enter"], gap: 200 });
  // The landing plays out over a second or two before the move state changes (10-21).
  const deadline = pilot.now() + 4000;
  while ((await flying(pilot)) && pilot.now() < deadline) await pilot.sleep(300);
  if (await flying(pilot)) return false;
  state.drake = cellOf(record((await pilot.send("pos")).pos).cell);
  return true;
}

/** Walk back to where the drake was left and get on (Enter on its cell). */
export async function board(
  pilot: Pilot,
  state: MoveState,
  say: Say = () => undefined,
): Promise<[boolean, string]> {
  if (await flying(pilot)) return [true, "已经骑在飞龙上了"];
  const drake = state.drake;
  if (drake === null) return [false, "不知道飞龙停在哪(还没在这次运行里降落过)"];
  const [reached, message] = await navigate(pilot, drake, false, say, 8, state);
  if (!reached) return [false, `走不到飞龙那里 ${cellText(drake)}:${message}`];
  await pilot.send("keys", { keys: ["Enter"], gap: 200 });
  const deadline = pilot.now() + 4000;
  while (!(await flying(pilot)) && pilot.now() < deadline) await pilot.sleep(300);
  return (await flying(pilot))
    ? [true, `骑上了飞龙,在 ${cellText(drake)}`]
    : [false, "按了确认没骑上"];
}

/**
 * Bring the wind drake down and step off. It lands on grass and plains only (10-21: it
 * would not land on the forest by Walse's gate, and the player never learned where it
 * could), so when the cell below will not do, fly to the nearest one that will. With `near`
 * (an entrance to walk into) only cells that connect to it on foot count, nearest by walk
 * (10-21: a landing west of Tycoon was cut off from the castle by mountains).
 */
export async function land(
  pilot: Pilot,
  state: MoveState,
  near: Cell | null = null,
  say: Say = () => undefined,
): Promise<[boolean, string]> {
  if (!(await flying(pilot))) return [false, "现在没有在飞"];
  const cells = cellGridOf((await pilot.send("cells", { r: 8 })).cells);
  let here = cells === null ? null : cells.center;
  let spots = cells === null ? [] : landingSpots(cells, near);
  if (near === null && here !== null && spots.some((spot) => sameCell(spot, here))) {
    spots = [here, ...spots.filter((spot) => !sameCell(spot, here))];
  }
  for (const spot of spots.slice(0, 4)) {
    if (!sameCell(spot, here)) {
      const [reached] = await navigate(pilot, spot, false, say, 8, state);
      if (!reached) continue;
    }
    if (await landHere(pilot, state)) {
      const pos = record((await pilot.send("pos")).pos);
      return [true, `降落了,在 ${show(pos.cell)}`];
    }
    here = cellOf(record((await pilot.send("pos")).pos).cell) ?? here;
  }
  const where = near === null ? "" : `能走到 ${cellText(near)} 的`;
  return [false, `附近 8 格内找不到${where}平原或草地可以降落,飞到开阔的平地上再试`];
}

/**
 * Grass and plains in view: those connected on foot to `near`, nearest by walk first, or
 * all of them nearest to the player first.
 */
export function landingSpots(cells: CellGrid, near: Cell | null): Cell[] {
  const [x0, y0] = cells.origin;
  const openGround = new Map<string, Cell>();
  for (let j = 0; j < cells.attr.length; j++) {
    const row = cells.attr[j] ?? [];
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (value !== null && value !== undefined && LANDABLE.has(value)) {
        const cell: Cell = [x0 + i, y0 + j];
        openGround.set(cellKey(cell[0], cell[1]), cell);
      }
    }
  }
  if (near === null) {
    const here = cells.center;
    return [...openGround.values()].sort(
      (a, b) =>
        Math.abs(a[0] - here[0]) +
        Math.abs(a[1] - here[1]) -
        (Math.abs(b[0] - here[0]) + Math.abs(b[1] - here[1])),
    );
  }
  // Breadth-first from the entrance on foot: the order of the search is the walking distance
  // (the predecessor map's keys are in visit order, like the Python dict).
  const walked = search({ ...cells, center: near }, [-1, -1], terrainRule(false));
  return [...walked.keys()].flatMap((key) => {
    const cell = openGround.get(key);
    return cell ? [cell] : [];
  });
}

/**
 * On the drake, to a town or dungeon entrance: fly near it, land on the closest open
 * ground, and walk in (the drake cannot enter; flying onto the entrance does nothing).
 */
export async function flyIn(
  pilot: Pilot,
  state: MoveState,
  goal: Cell,
  say: Say = () => undefined,
): Promise<[boolean, string]> {
  await navigate(pilot, goal, false, say, 8, state); // flying: the view then centres on the entrance
  const [ok, message] = await land(pilot, state, goal, say);
  if (!ok) return [false, message];
  say(`  ${message},走过去`);
  return navigate(pilot, goal, false, say, 8, state);
}

export async function onWorldMap(pilot: Pilot): Promise<boolean> {
  const cells = cellGridOf((await pilot.send("cells", { r: 2 })).cells);
  return cells !== null && hasTerrain(cells);
}

/**
 * The game's own route to goal, or [] when it has none. It knows stairs inside a map,
 * which the collision grid shows as walls (10-20, the Ship Graveyard's map 215).
 */
export async function gameRoute(pilot: Pilot, goal: Cell): Promise<Cell[]> {
  const route = record(
    (await pilot.send("route", { to: [goal[0], goal[1]], collision: true })).route,
  );
  // Only the collision-aware search counts: when it finds nothing, the bridge falls back to
  // SearchSimple, a straight line through walls (10-27, 261: tries {"theirs": 0, "used":
  // "simple"}, and the party walked into the same walls for dozens of steps).
  const used = text(record(route.tries).used) ?? "theirs";
  if (!used.startsWith("theirs")) return [];
  const path = routeCells(route);
  const last = path[path.length - 1] ?? null;
  if (path.length < 2 || last === null) return [];
  if (sameCell(last, goal)) return path;
  // The search stops beside a cell it cannot stand on, such as an exit: one more step.
  const beside = Math.abs(last[0] - goal[0]) + Math.abs(last[1] - goal[1]) === 1;
  return beside ? [...path, goal] : [];
}

/** How long a lift's map change is watched for (task 71: the Fire-Powered Ship lift takes ~15 s). */
export const LIFT_WAIT_MS = 30_000;
export const LIFT_POLL_MS = 500;

export interface RideOutcome {
  readonly map: number | null;
  readonly cell: Cell | null;
  readonly changed: boolean;
  readonly detail: string;
}

/**
 * Take a recorded lift: walk to `from`, face `dir`, press Enter, then wait for the map id to
 * change. The map id is the only arrival signal (257 → 634, 635 → 260); the platform animates
 * first, so a single pos read right after the key is not enough. Task 71.
 */
export async function rideAt(
  pilot: Pilot,
  state: MoveState,
  from: Cell,
  dir: string,
  say: Say = () => undefined,
): Promise<RideOutcome> {
  const start = record((await pilot.send("pos")).pos);
  const startMap = mapNumber(start.map);
  if (startMap === null) {
    return {
      map: null,
      cell: cellOf(start.cell),
      changed: false,
      detail: "读不到当前地图，没坐电梯",
    };
  }
  if (!sameCell(cellOf(start.cell), from)) {
    const [reached, message] = await navigate(pilot, from, false, say, 8, state);
    if (!reached) {
      return {
        map: startMap,
        cell: cellOf(record((await pilot.send("pos")).pos).cell),
        changed: false,
        detail: `走不到电梯 ${cellText(from)}:${message}`,
      };
    }
  }
  const help = await dismissFieldHelp(pilot);
  if (help === "stuck") {
    return { map: startMap, cell: from, changed: false, detail: FIELD_HELP_STUCK };
  }
  if (help === "closed") say("  关掉了操作提示");
  const result = await pilot.send("keys", { keys: [`${dir}:60`, "Enter"], gap: 250 });
  if (!truthy(result.ok)) {
    return {
      map: startMap,
      cell: from,
      changed: false,
      detail: `没按成:${show(result.error)}`,
    };
  }
  const deadline = pilot.now() + LIFT_WAIT_MS;
  let pos = record((await pilot.send("pos")).pos);
  while (pilot.now() < deadline) {
    const map = mapNumber(pos.map);
    if (map !== null && map !== startMap) {
      // The map id changed when the lift moved; wait for the field to settle, then read where
      // the party was put down (task 71: it is not always the PointIn cell).
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      const now = record((await pilot.send("pos")).pos);
      return {
        map: mapNumber(now.map) ?? map,
        cell: cellOf(now.cell) ?? cellOf(pos.cell),
        changed: true,
        detail: `坐了一趟到地图 ${show(now.map)},在 ${show(now.cell)}`,
      };
    }
    await pilot.sleep(LIFT_POLL_MS);
    pos = record((await pilot.send("pos")).pos);
  }
  return {
    map: mapNumber(pos.map),
    cell: cellOf(pos.cell),
    changed: false,
    detail: `按了${dir}的确认,地图号没变`,
  };
}

/** How long an arrival is watched for the map change an entrance makes (10-27). */
export const SETTLE_MS = 1500;
export const SETTLE_POLL_MS = 250;

/**
 * Standing on the goal does not mean staying on the map: an entrance or stairs swaps the map a
 * moment after the last step, and the position read right after the step still shows the old
 * map (10-27, Fire-Powered Ship 258 -> 255: "到达 (4, 8)", and the player walked to (4, 8)
 * again on the new map). Watch the map briefly before calling it an arrival. Not in the Python
 * version, which has the same race.
 */
async function enteredAfterArriving(
  pilot: Pilot,
  startMap: unknown,
): Promise<[boolean, string] | null> {
  const deadline = pilot.now() + SETTLE_MS;
  while (pilot.now() < deadline) {
    await pilot.sleep(SETTLE_POLL_MS);
    const pos = record((await pilot.send("pos")).pos);
    if (pos.map !== startMap) {
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      const now = record((await pilot.send("pos")).pos);
      return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
    }
  }
  return null;
}

/**
 * What a walkpath's Event/dialog stop turned out to be: `battle` once the fight is up, `clear`
 * when the party is back in Player/Transport, `event` when it is still a story stop.
 */
export type EventSettle =
  | { readonly outcome: "battle"; readonly pos: Reply }
  | { readonly outcome: "clear"; readonly pos: Reply }
  | { readonly outcome: "event"; readonly pos: Reply };

/**
 * Task 63: an encounter starts on a MainState=Event frame (11-08, bridge 0.14.1: walkpath
 * stopped at `state:Event` with battle false, and 1.5 s later the battle was up). Watch pos
 * rather than trust that first frame: a fight takes over, a short cutscene leaves the party in
 * Player/Transport, and anything still in Event or dialog is a real story stop.
 */
export async function settleWalkEvent(pilot: Pilot, state: MoveState): Promise<EventSettle> {
  const pollMs = Math.max(1, walkpathEventPollMs(state));
  const deadline = pilot.now() + Math.max(0, walkpathEventWaitMs(state));
  let pos: Reply = {};
  for (;;) {
    const left = deadline - pilot.now();
    if (left <= 0) return { outcome: "event", pos };
    await pilot.sleep(Math.min(pollMs, left));
    pos = record((await pilot.send("pos")).pos);
    if (truthy(pos.battle) || pos.state === "Battle") return { outcome: "battle", pos };
    if (!truthy(pos.dialog) && (pos.state === "Player" || pos.state === "Transport")) {
      return { outcome: "clear", pos };
    }
  }
}

/**
 * Task 83: the cells to stand on when stepping onto an event goal: the cell the planned
 * route comes from first, then every other reachable neighbour (11-10, Fire-Powered Ship 265:
 * the row is a line of event cells with ordinary floor between them).
 */
function eventApproachCells(
  goal: Cell,
  path: readonly Cell[],
  reachable: ReadonlySet<string> | undefined,
  events: ReadonlyMap<string, string>,
): Cell[] {
  const out: Cell[] = [];
  const add = (cell: Cell): void => {
    if (!adjacent(cell, goal)) return;
    if (reachable !== undefined && !reachable.has(cellKey(cell[0], cell[1]))) return;
    if (events.has(cellKey(cell[0], cell[1]))) return;
    if (!out.some((known) => sameCell(known, cell))) out.push(cell);
  };
  const approach = path[path.length - 2];
  if (approach) add(approach);
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    add([goal[0] + dx, goal[1] + dy]);
  }
  return out;
}

/** Wait for a map change to settle, then report it the way navigate does. */
async function enteredMap(pilot: Pilot): Promise<[true, string]> {
  await pilot.send("wait", { timeout: 30000 }, 40_000);
  const now = record((await pilot.send("pos")).pos);
  return [true, `进入了地图 ${show(now.map)},现在在 ${show(now.cell)}`];
}

/**
 * Task 83: one step onto an event cell, the way grind's stepTo does it: a one-cell walkpath
 * with no goal, holding one direction, not a corner route. Returns null when the game refused
 * the step (the caller waits and tries again), a result when the party got in or the event
 * took over.
 */
async function stepIntoEvent(
  pilot: Pilot,
  from: Cell,
  to: Cell,
  state: MoveState,
  startMap: unknown,
  say: Say,
): Promise<[boolean, string] | null> {
  const timeoutMs = walkpathTimeout(2, state);
  let result = await pilot.send(
    "walkpath",
    {
      path: [
        [from[0], from[1]],
        [to[0], to[1]],
      ],
      timeoutMs,
      blockedMs: walkpathBlockedMs(state),
      turnLead: walkpathTurnLead(state),
    },
    timeoutMs + 5_000,
  );
  if (text(result.error) === "walkpath_unsupported") {
    result = await pilot.send("walk", { to: [to[0], to[1]], timeout: 30_000 }, 40_000);
  }
  let pos = record(result.pos);
  let reason = text(result.reason) ?? (truthy(result.ok) ? "arrived" : "");
  if (reason === "state:Event" || reason === "dialog") {
    const settled = await settleWalkEvent(pilot, state);
    pos = record(settled.pos);
    if (settled.outcome === "battle") {
      const battle = await regular(pilot, state.battle ?? {}, say, state.saveSlot, {
        flee: state.flee === true,
      });
      say(`  途中遇敌,${battle}`);
      pos = record((await pilot.send("pos")).pos);
      if (pos.map !== startMap) return await enteredMap(pilot);
      return sameCell(cellOf(pos.cell), to) ? [true, `到达 ${cellText(to)}`] : null;
    }
    if (settled.outcome === "event") {
      if (pos.map !== startMap) return await enteredMap(pilot);
      // The event is playing: that is entering it, not a blocked step. Hand it to the story,
      // as a walk that stops on state:Event always has.
      return [false, `停在 ${show(pos.cell)}:${show("interrupted:state:Event")}`];
    }
    reason = "arrived";
  }
  if (
    pos.map !== startMap ||
    reason === "map_changed" ||
    reason === "state:ChangeMap" ||
    reason === "state:FieldReady" ||
    pos.state === "ChangeMap" ||
    pos.state === "FieldReady"
  ) {
    return await enteredMap(pilot);
  }
  if (truthy(result.ok) || reason === "arrived") {
    return sameCell(cellOf(pos.cell), to) ? [true, `到达 ${cellText(to)}`] : null;
  }
  if (reason === "state:FieldHelp" || pos.state === "FieldHelp") {
    const help = await dismissFieldHelp(pilot);
    if (help === "stuck") return [false, FIELD_HELP_STUCK];
    if (help === "closed") say("  关掉了操作提示");
    return null;
  }
  if (
    reason === "state:Gimmick" ||
    pos.state === "Gimmick" ||
    String(result.error).includes("Gimmick")
  ) {
    await markMovingGimmick(state, startMap, cellOf(pos.cell));
    await pilot.send("wait", { timeout: 30000 }, 40_000);
  }
  return null;
}

/**
 * Task 83: `go` to an event cell. Walk beside it, then try to step in from every reachable
 * side several times, with a wait between. A refusal is not recorded as "走不过去"; if the
 * party gets in, the Event or map change goes on to the story as usual.
 */
async function stepOntoEventGoal(
  pilot: Pilot,
  goal: Cell,
  name: string,
  planned: Planned,
  say: Say,
  state: MoveState,
  startMap: unknown,
): Promise<[boolean, string]> {
  const tries = eventTryCount(state);
  const waitMs = eventTryWaitMs(state);
  const spots = eventApproachCells(
    goal,
    planned.path,
    planned.reachable,
    planned.events ?? new Map(),
  );
  const tried: Cell[] = [];
  for (const spot of spots) {
    const here = cellOf(record((await pilot.send("pos")).pos).cell);
    if (!sameCell(here, spot)) {
      const [reached] = await navigate(pilot, spot, false, say, 8, state);
      if (!reached) continue;
    }
    tried.push(spot);
    for (let attempt = 0; attempt < tries; attempt++) {
      const outcome = await stepIntoEvent(pilot, spot, goal, state, startMap, say);
      if (outcome !== null) return outcome;
      if (attempt + 1 < tries) await pilot.sleep(waitMs);
    }
  }
  const label = name === "" ? "事件" : name;
  if (tried.length === 0) {
    return [false, `${cellText(goal)} 是事件格「${label}」,旁边没有能站的格子，没记成走不过去`];
  }
  const from = tried.map(cellText).join("、");
  return [
    false,
    `${cellText(goal)} 是事件格「${label}」,从 ${from} 各试了 ${tries} 次都被游戏挡住，没记成走不过去`,
  ];
}

/**
 * Route to goal and walk it, replanning when something gets in the way. World maps use
 * the terrain codes; towns and dungeons use the map's collision grid (bridge 0.2.5+).
 * Returns (reached, message).
 */
export async function navigate(
  pilot: Pilot,
  goal: Cell,
  byShip: boolean,
  say: Say = () => undefined,
  legs = 8,
  state: MoveState = { drake: null },
  budget?: CarryBudget,
): Promise<[boolean, string]> {
  const how = byShip ? "船" : "步行";
  const startMap = record((await pilot.send("pos")).pos).map;
  // Steps that turned out blocked though the map data says open (a closed gate, an object
  // the collision data lacks, the walled side of a 3/5 cell): the next plan goes around that
  // step instead of into it again; the cell stays usable from other sides. Kept on the map
  // in MoveState, so the next go on the same map also knows (11-03, Fire-Powered Ship
  // 261: the same step was walked into twice).
  const mapCut = cutsFor(state, startMap);
  // Task 99: on a moving-gimmick map a refusal only closes this go's search. Keep those
  // steps apart from the map's lasting cuts and layer cuts.
  const goCut = new Set<string>();
  const goLayers = new Map<number, Set<string>>();
  let cut = new Set<string>();
  const seen = new Set<string>();
  const washed = new Map<string, Cell>();
  /** Task 73: atlas records this walk is testing; they stay until the goal is reached. */
  const verifying: ObservedMove[] = [];
  const remember = (suspects: readonly ObservedMove[] | undefined): void => {
    for (const suspect of suspects ?? []) {
      if (!verifying.some((known) => sameBlockedMove(known, suspect))) verifying.push(suspect);
    }
  };
  const forgetVerified = async (): Promise<void> => {
    if (verifying.length === 0) return;
    const steps = [...verifying];
    verifying.length = 0;
    await state.forgetBlocked?.(startMap, steps);
  };
  // A bridge without walkpath (0.13.x) or a LAN that cannot be reached falls back to the
  // old corner-by-corner walk for the rest of this call; the pilot remembers it across calls.
  let useWalkpath = true;
  let plans = 0;
  let turns = 0;
  // A fight met on the way does not use up one of the caller's legs; the next plan is free.
  let freePlan = false;
  const endWalk = (reason: string): void => {
    if (state.walk !== null && state.walk !== undefined) {
      state.walk = finishWalk(state.walk, reason, new Date().toISOString());
    }
  };
  const noteWashed = (cells: readonly Cell[]): void => {
    for (const cell of cells) {
      const key = cellKey(cell[0], cell[1]);
      if (!washed.has(key)) washed.set(key, cell);
    }
  };
  const washedNote = (): string => {
    if (washed.size === 0) return "";
    const where = [...washed.values()].map((cell) => cellText(cell)).join("、");
    return `(这条路上会踩到危险格 ${where},没有别的路,可能被水流冲走或被传送带带走)`;
  };
  // Task 84: every carry of this go, in order, and the two loop limits. The budget is shared
  // with a walk back across maps so a recursive navigate counts against the same call.
  const carried: string[] = [];
  const carryBudget: CarryBudget = budget ?? { seen: new Map<string, number>(), total: 0 };
  const withCarried = (message: string): string => [...carried, message].join("\n");
  /** Record one carry; a return means one of the limits says to stop. */
  const noteCarry = (carry: CarriedAway): [boolean, string] | null => {
    const key = `${cellKey(carry.from[0], carry.from[1])}>${cellKey(carry.to[0], carry.to[1])}`;
    const count = (carryBudget.seen.get(key) ?? 0) + 1;
    carryBudget.seen.set(key, count);
    carryBudget.total += 1;
    const line =
      carry.how === "传送带"
        ? `在 ${cellText(carry.from)} 踩到传送带，被带到 ${cellText(carry.to)},从这里接着走`
        : `在 ${cellText(carry.from)} 踩到落下点，掉到 ${cellText(carry.to)},从这里接着走`;
    carried.push(line);
    const repeats = carryRepeatLimit(state);
    if (count >= repeats) {
      return [
        false,
        withCarried(
          `同一处 ${cellText(carry.from)} → ${cellText(carry.to)} 被带走了 ${count} 次,停下`,
        ),
      ];
    }
    const total = carryTotalLimit(state);
    if (carryBudget.total >= total) {
      return [false, withCarried(`这次 go 里已经被带走了 ${carryBudget.total} 次,到上限了,停下`)];
    }
    return null;
  };
  /** Where the party was last seen on the go's first map, for a map-change report. */
  let where: Cell | null = null;
  /**
   * Task 84: the go left its first map before reaching the goal. Reaching the goal and then
   * stepping into an entrance is still an arrival; a real detour walks back when the atlas
   * has a way, and otherwise stops with both places named.
   */
  const leftStartMap = async (
    now: Reply,
    fromCell: Cell | null,
    verb: string,
  ): Promise<[boolean, string]> => {
    if (fromCell !== null && sameCell(fromCell, goal)) {
      endWalk("map_changed");
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      const settled = record((await pilot.send("pos")).pos);
      return [true, withCarried(`进入了地图 ${show(settled.map)},现在在 ${show(settled.cell)}`)];
    }
    const goalMap = mapNumber(startMap);
    const nowMap = mapNumber(now.map);
    if (
      goalMap !== null &&
      nowMap !== null &&
      state.routeBack?.(nowMap, goalMap) === true &&
      state.returnToGoal
    ) {
      carried.push(
        `中途在 ${cellText(fromCell)} ${verb}地图 ${show(now.map)} ${cellText(cellOf(now.cell))},` +
          `地图记录里有回去的路,从这里走回去`,
      );
      endWalk("stopped");
      const [reached, message] = await state.returnToGoal(pilot, goalMap, goal, say, carryBudget);
      return [reached, withCarried(message)];
    }
    endWalk("map_changed");
    return [
      false,
      withCarried(
        `原目标在地图 ${show(startMap)} ${cellText(goal)},中途在 ${cellText(fromCell)} ` +
          `${verb}地图 ${show(now.map)} ${cellText(cellOf(now.cell))},按地图记录回不去`,
      ),
    ];
  };
  for (;;) {
    if (turns >= MAX_WALK_TURNS) break;
    turns += 1;
    if (!freePlan) {
      if (plans >= legs) break;
      plans += 1;
    }
    freePlan = false;
    cut = new Set([...mapCut, ...goCut]);
    const pos = record((await pilot.send("pos")).pos);
    if (pos.state === "Gimmick" && num(pos.map) !== undefined) {
      await markMovingGimmick(state, pos.map, cellOf(pos.cell));
    }
    if (pos.map !== startMap) {
      return await leftStartMap(pos, where, "被带到");
    }
    where = cellOf(pos.cell) ?? where;
    const planned = await plannedRoute(
      pilot,
      goal,
      byShip,
      cut,
      state,
      startMap,
      undefined,
      goLayers,
    );
    const temporary: TemporaryCuts | undefined = planned.gimmick
      ? { edges: goCut, layers: goLayers }
      : undefined;
    remember(planned.suspects);
    const [here, initial] = [planned.here, planned.path];
    noteWashed(planned.washed);
    if (here === null) {
      await pilot.send("wait", { timeout: 30000 }, 40_000);
      continue;
    }
    if (sameCell(here, goal)) {
      endWalk("arrived");
      await forgetVerified();
      const entered = await enteredAfterArriving(pilot, startMap);
      const floor = planned.layer
        ? `,第 ${planned.layer.end} 层(共 ${planned.layer.count} 层)`
        : "";
      return entered === null
        ? [true, withCarried(`到达 ${cellText(goal)}${floor}${washedNote()}`)]
        : [true, withCarried(entered[1])];
    }
    // Task 83: an event cell is not a wall. Walk beside it and try stepping in from every
    // reachable side; a refusal there is a matter of timing (11-10, Fire-Powered Ship 265).
    const eventName = planned.events?.get(cellKey(goal[0], goal[1]));
    if (eventName !== undefined) {
      endWalk("event_goal");
      const [eventReached, eventText] = await stepOntoEventGoal(
        pilot,
        goal,
        eventName,
        planned,
        say,
        state,
        startMap,
      );
      return [eventReached, withCarried(eventText)];
    }
    let path = walkPathCells(initial);
    if (!byShip && planned.suspects === undefined && !(await onWorldMap(pilot))) {
      // Indoors the game's own search comes first: it knows heights, stairs and which
      // side a cell can be entered from (control plan §4.9). Ours is the fallback, and
      // also when the game's route takes a step that already failed or crosses a conveyor.
      // 0.14.0: its points may only be the turns; fill them into cells first, and drop the
      // route when two points are diagonal (task 56).
      const theirs = expandCorners(await gameRoute(pilot, goal));
      if (theirs !== null && theirs.length > 0) {
        const steps = new Set<string>();
        for (let i = 1; i < theirs.length; i++) {
          const before = theirs[i - 1];
          const after = theirs[i];
          if (before && after) steps.add(edgeKey(before, after));
        }
        const crossesConveyor = theirs.some(
          (cell) => !sameCell(cell, goal) && planned.conveyors.has(cellKey(cell[0], cell[1])),
        );
        if (
          sameCell(theirs[0] ?? null, here) &&
          !crossesConveyor &&
          ![...steps].some((step) => cut.has(step))
        ) {
          path = theirs;
        }
      }
    }
    if (planned.layer) {
      const exits = planned.layer.transitions
        .slice(0, 6)
        .map((change) => {
          const where = cellText(change.cell);
          return change.to === null ? where : `${where}→第 ${change.to} 层`;
        })
        .join("、");
      say(
        `  第 ${planned.layer.start} 层(共 ${planned.layer.count} 层)` +
          (exits === "" ? "" : `,换层格 ${exits}`),
      );
    }
    if (path.length < 2) {
      endWalk("blocked");
      const floor = planned.layer
        ? `(第 ${planned.layer.start} 层,共 ${planned.layer.count} 层)`
        : "";
      return [
        false,
        withCarried(
          `在 ${cellText(here)} ${how}走不过去${floor},这里已是离 ${cellText(goal)} 最近的地方` +
            washedNote(),
        ),
      ];
    }
    say(`  ${cellText(here)} → ${cellText(path[path.length - 1] ?? null)}:${path.length - 1} 格`);

    if (useWalkpath) {
      const timeoutMs = walkpathTimeout(path.length, state);
      const label = walkLabel(state);
      // The map view belongs to this command: a push from an earlier walk has another seq,
      // and the page would otherwise show the last route against the new one.
      if (planned.base !== undefined) {
        state.walk = beginWalk(planned.base, path, goal, label, new Date().toISOString());
      }
      let result = await pilot.send(
        "walkpath",
        {
          path: path.map((cell) => [cell[0], cell[1]]),
          goal: [goal[0], goal[1]],
          label,
          timeoutMs,
          blockedMs: walkpathBlockedMs(state),
          turnLead: walkpathTurnLead(state),
        },
        timeoutMs + 5_000,
      );
      if (text(result.error) === "walkpath_unsupported") {
        useWalkpath = false;
        // No push and no walkpath reply: the old closed-loop walk below moves the view on
        // segment by segment, so keep the plan that is about to be walked.
      } else {
        state.walk = updateWalkFromReply(state.walk ?? null, result, new Date().toISOString());
        let current = record(result.pos);
        if (current.map === startMap) {
          where = cellOf(current.cell) ?? where;
        } else {
          // The walk changed the map: the last planned cell it could have stood on says
          // whether that was the goal itself (an exit cell) or an earlier detour.
          const index =
            typeof result.index === "number" && Number.isFinite(result.index)
              ? Math.trunc(result.index)
              : -1;
          where =
            (index >= 0 && index < path.length ? path[index] : path[path.length - 1]) ?? where;
        }
        let reason = text(result.reason) ?? (truthy(result.ok) ? "arrived" : "");
        if (reason === "state:Event" || reason === "dialog") {
          // Task 63: an encounter's opening Event frame looks like a story stop; wait to see
          // whether it turns into a battle or just a short cutscene.
          const settled = await settleWalkEvent(pilot, state);
          if (settled.outcome === "clear") continue;
          if (settled.outcome === "battle") {
            result = { ...result, reason: "battle", pos: settled.pos };
            state.walk = updateWalkFromReply(state.walk ?? null, result, new Date().toISOString());
            current = record(result.pos);
            reason = "battle";
          }
        }
        if (reason === "battle" || truthy(current.battle) || current.state === "Battle") {
          // The bridge stops on the frame a fight starts, so the keypresses cannot reach the
          // battle menu; the ordinary battle handler takes over from here.
          const battle = await regular(pilot, state.battle ?? {}, say, state.saveSlot, {
            flee: state.flee === true,
          });
          say(`  途中遇敌,${battle}`);
          const moved = await afterWalk(
            pilot,
            result.pos,
            startMap,
            planned,
            path,
            state,
            seen,
            goal,
          );
          if (moved !== null) {
            if (moved.kind === "arrived") return [true, withCarried(moved.text)];
            const stopped = noteCarry(moved.carry);
            if (stopped !== null) return stopped;
            if (moved.carry.mapChanged) {
              return await leftStartMap(
                { map: moved.carry.map, cell: moved.carry.to },
                moved.carry.from,
                moved.carry.how === "传送带" ? "被带到" : "掉到",
              );
            }
          }
          // Not one of the caller's legs: a long walk may meet several fights (task 56).
          freePlan = true;
          continue;
        }
        const moved = await afterWalk(
          pilot,
          result.pos,
          startMap,
          planned,
          path,
          state,
          seen,
          goal,
        );
        if (moved !== null) {
          if (moved.kind === "arrived") return [true, withCarried(moved.text)];
          const stopped = noteCarry(moved.carry);
          if (stopped !== null) return stopped;
          if (moved.carry.mapChanged) {
            return await leftStartMap(
              { map: moved.carry.map, cell: moved.carry.to },
              moved.carry.from,
              moved.carry.how === "传送带" ? "被带到" : "掉到",
            );
          }
          // A same-map carry: replan from the landing, not one of the caller's legs.
          freePlan = true;
          continue;
        }
        if (truthy(result.ok) || reason === "arrived") {
          if (sameCell(cellOf(current.cell), goal)) {
            await forgetVerified();
            const entered = await enteredAfterArriving(pilot, startMap);
            const floor = planned.layer
              ? `,第 ${planned.layer.end} 层(共 ${planned.layer.count} 层)`
              : "";
            return entered === null
              ? [true, withCarried(`到达 ${cellText(goal)}${floor}${washedNote()}`)]
              : [true, withCarried(entered[1])];
          }
          // The command stopped on the cell before a jump or at the window's edge: replan.
          continue;
        }
        if (reason === "state:FieldHelp" || current.state === "FieldHelp") {
          const help = await dismissFieldHelp(pilot);
          if (help === "stuck") return [false, withCarried(FIELD_HELP_STUCK)];
          if (help === "closed") say("  关掉了操作提示");
          continue;
        }
        if (
          reason === "state:Gimmick" ||
          current.state === "Gimmick" ||
          String(result.error).includes("Gimmick")
        ) {
          // The bridge already waited 5 s for the door; one more wait then replan.
          await markMovingGimmick(state, startMap, cellOf(current.cell));
          await pilot.send("wait", { timeout: 30000 }, 40_000);
          continue;
        }
        if (
          reason === "map_changed" ||
          reason === "state:ChangeMap" ||
          reason === "state:FieldReady" ||
          current.state === "ChangeMap" ||
          current.state === "FieldReady" ||
          String(result.error).includes("ChangeMap")
        ) {
          await pilot.send("wait", { timeout: 30000 }, 40_000);
          const now = record((await pilot.send("pos")).pos);
          const fromCell = current.map === startMap ? (cellOf(current.cell) ?? where) : where;
          return await leftStartMap(now, fromCell, "被带到");
        }
        if (reason === "blocked") {
          const index =
            typeof result.index === "number" && Number.isFinite(result.index)
              ? Math.trunc(result.index)
              : -1;
          const stuck =
            index >= 0 && index < path.length
              ? (path[index] ?? cellOf(current.cell))
              : cellOf(current.cell);
          const ahead = cellOf(result.next) ?? (index >= 0 ? path[index + 1] : undefined);
          const eventAhead =
            ahead !== undefined && planned.events?.has(cellKey(ahead[0], ahead[1])) === true;
          const suspect =
            stuck === null || ahead === undefined
              ? undefined
              : verifying.find((move) => sameMoveStep(move, stuck, ahead));
          if (stuck !== null && ahead !== undefined) {
            await recordBlockedStep(
              pilot,
              state,
              startMap,
              cut,
              stuck,
              ahead,
              planned.layer?.start ?? null,
              !eventAhead,
              temporary,
            );
          }
          say(
            `  在 ${show(current.cell)} 被挡住` +
              (ahead === undefined
                ? ""
                : eventAhead
                  ? `(到 ${cellText(ahead)} 是事件格,这次没进去,不记成走不过去)`
                  : `(到 ${cellText(ahead)} 这一步走不过去)`),
          );
          if (suspect !== undefined && stuck !== null) {
            // Task 73: the ignored record was right after all. The count is already one
            // higher through the link, and this walk ends blocked rather than trying again.
            endWalk("blocked");
            return [
              false,
              withCarried(
                `在 ${cellText(stuck)} ${how}走不过去(地图记录里的这一步又试了一次,还是被挡)`,
              ),
            ];
          }
          continue;
        }
        if (reason === "off_path") continue;
        if (reason === "dialog" || reason.startsWith("state:")) {
          return [
            false,
            withCarried(
              `停在 ${show(current.cell)}:${show(`interrupted:${reason || "walkpath"}`)}`,
            ),
          ];
        }
        return [
          false,
          withCarried(`停在 ${show(current.cell)}:${show(reason === "" ? result.error : reason)}`),
        ];
      }
    }

    // The old way, kept for bridge 0.13.x and a LAN that is down: one closed-loop walk per
    // turn of the route. Battles inside walkLeg do not use a leg either.
    let replanned = false;
    for (const [x, y] of corners(path)) {
      where = [x, y];
      const result = await walkLeg(pilot, x, y, say, state);
      const walked = record(result.pos);
      if (walked.map === startMap) where = cellOf(walked.cell) ?? where;
      const reached = cellOf(walked.cell);
      if (state.walk !== null && state.walk !== undefined && reached !== null) {
        const index = path.findIndex((cell) => sameCell(cell, reached));
        state.walk = updateWalk(state.walk, {
          ...(index < 0 ? {} : { index }),
          cell: reached,
          steps: Math.max(0, path.length - 1),
        });
      }
      const moved = await afterWalk(pilot, result.pos, startMap, planned, path, state, seen, goal);
      if (moved !== null) {
        if (moved.kind === "arrived") {
          endWalk("arrived");
          return [true, withCarried(moved.text)];
        }
        const stopped = noteCarry(moved.carry);
        if (stopped !== null) {
          endWalk("stopped");
          return stopped;
        }
        if (moved.carry.mapChanged) {
          return await leftStartMap(
            { map: moved.carry.map, cell: moved.carry.to },
            moved.carry.from,
            moved.carry.how === "传送带" ? "被带到" : "掉到",
          );
        }
        // A same-map carry: replan from the landing, not one of the caller's legs.
        freePlan = true;
        replanned = true;
        break;
      }
      if (truthy(result.ok)) continue;
      const current = record(result.pos);
      // Stepping onto an entrance swaps the map: that is arriving, not failing.
      if (
        current.state === "ChangeMap" ||
        current.state === "FieldReady" ||
        String(result.error).includes("ChangeMap")
      ) {
        await pilot.send("wait", { timeout: 30000 }, 40_000);
        const now = record((await pilot.send("pos")).pos);
        const fromCell = current.map === startMap ? (cellOf(current.cell) ?? where) : where;
        return await leftStartMap(now, fromCell, "被带到");
      }
      if (result.error === "blocked") {
        const stuck = cellOf(current.cell);
        const at = stuck === null ? -1 : path.findIndex((cell) => sameCell(cell, stuck));
        const ahead = at >= 0 && at < path.length - 1 ? path[at + 1] : undefined;
        const eventAhead =
          ahead !== undefined && planned.events?.has(cellKey(ahead[0], ahead[1])) === true;
        const suspect =
          stuck === null || ahead === undefined
            ? undefined
            : verifying.find((move) => sameMoveStep(move, stuck, ahead));
        if (stuck !== null && ahead !== undefined) {
          await recordBlockedStep(
            pilot,
            state,
            startMap,
            cut,
            stuck,
            ahead,
            planned.layer?.start ?? null,
            !eventAhead,
            temporary,
          );
        }
        say(
          `  在 ${show(current.cell)} 被挡住` +
            (ahead === undefined
              ? ""
              : eventAhead
                ? `(到 ${cellText(ahead)} 是事件格,这次没进去,不记成走不过去)`
                : `(到 ${cellText(ahead)} 这一步走不过去)`),
        );
        endWalk("blocked");
        if (suspect !== undefined && stuck !== null) {
          return [
            false,
            withCarried(
              `在 ${cellText(stuck)} ${how}走不过去(地图记录里的这一步又试了一次,还是被挡)`,
            ),
          ];
        }
        break;
      }
      endWalk("stopped");
      return [false, withCarried(`停在 ${show(current.cell)}:${show(result.error)}`)];
    }
    if (!replanned) endWalk("arrived");
    // A goal beyond the planning window: this leg ended at the nearest cell in view, and
    // the next plan, from there, sees further. One that gets no closer stops above.
  }
  if (turns >= MAX_WALK_TURNS) {
    endWalk("timeout");
    return [false, withCarried(`走了 ${turns} 次还没到 ${cellText(goal)}`)];
  }
  endWalk("stopped");
  return [false, withCarried(`走了 ${legs} 段还没到 ${cellText(goal)}${washedNote()}`)];
}

const FACING: readonly (readonly [number, number, string])[] = [
  [0, -1, "Up"],
  [0, 1, "Down"],
  [-1, 0, "Left"],
  [1, 0, "Right"],
];

/**
 * Stand next to a chest, NPC or object, face it, press Enter and page the dialog.
 * Shopkeepers and innkeepers stand behind a counter: when no neighbouring cell can be
 * reached, talk across one cell from two cells away, the way the games allow.
 *
 * A counter is marked by a RelayInteraction cell in front of the clerk; talking works only
 * through it, so a spot on the far side of a relay comes first (10-27, Karnak's item shop:
 * the cell behind the clerk was reachable, the player talked from there, and no shop opened).
 * When a spot turns out unreachable on the way, the next one is tried, up to three.
 */
export async function openAt(
  pilot: Pilot,
  target: Cell,
  say: Say = () => undefined,
  state: MoveState = { drake: null },
): Promise<string> {
  // A first-visit FieldHelp would swallow the Enter meant for the chest or clerk.
  const firstHelp = await dismissFieldHelp(pilot);
  if (firstHelp === "stuck") return FIELD_HELP_STUCK;
  let helpNote = firstHelp === "closed" ? "关掉了操作提示\n" : "";
  const [here] = await plan(pilot, target, false);
  if (here === null) return "地图还在切换,稍后再试";
  // plan() lets its goal through; a spot must not be an occupied cell.
  const taken = (await occupiedCells(pilot)).filter((cell) => !sameCell(cell, here));
  const relays = await relaysBeside(pilot, target);
  const candidates: { spot: Cell; path: Cell[]; direction: string; rank: number }[] = [];
  for (const [rank, distance] of [
    [0, 2],
    [1, 1],
    [2, 2],
  ] as const) {
    for (const [dx, dy, direction] of FACING) {
      const spot: Cell = [target[0] - dx * distance, target[1] - dy * distance];
      // Rank 0 is across a counter: the relay sits between the spot and the target.
      const across = relays.some((relay) => sameCell(relay, [target[0] - dx, target[1] - dy]));
      if (across !== (rank === 0)) continue;
      if (taken.some((cell) => sameCell(cell, spot))) continue;
      if (candidates.some((candidate) => sameCell(candidate.spot, spot))) continue;
      const [, path] = await plan(pilot, spot, false);
      const reachable =
        sameCell(spot, here) || (path.length > 0 && sameCell(path[path.length - 1] ?? null, spot));
      if (reachable) candidates.push({ spot, path, direction, rank });
    }
  }
  if (candidates.length === 0) return `${cellText(target)} 四周两格内都走不到`;
  candidates.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
  let failure = "";
  for (const best of candidates.slice(0, 3)) {
    const spot = best.spot;
    if (!sameCell(spot, here)) {
      const [reached, message] = await navigate(pilot, spot, false, say, 8, state);
      if (!reached) {
        failure = `走不到 ${cellText(target)} 旁边:${message}`;
        continue;
      }
    }
    const help = await dismissFieldHelp(pilot);
    if (help === "stuck") return FIELD_HELP_STUCK;
    if (help === "closed") helpNote = "关掉了操作提示\n";
    const result = await pilot.send("keys", { keys: [`${best.direction}:60`, "Enter"], gap: 250 });
    if (!truthy(result.ok)) return `没按成:${show(result.error)}`;
    const story = await pilot.send("story", { pageMs: 2500, timeout: 600000 }, 620_000);
    const via = best.rank === 0 ? "隔着柜台" : "";
    return (
      helpNote +
      `站在 ${cellText(spot)} ${via}面朝${best.direction}按了确认,` +
      `之后翻了 ${show(story.pages)} 页对话`
    );
  }
  return failure;
}

/** RelayInteraction cells next to `target`: the counter a clerk is talked to through. */
async function relaysBeside(pilot: Pilot, target: Cell): Promise<Cell[]> {
  const found = record(
    (await pilot.send("entities", { kind: "RelayInteraction", max: 60 })).entities,
  );
  return records(found.entities).flatMap((entity) => {
    const cell = cellOf(entity.cell);
    if (cell === null) return [];
    const beside = Math.abs(cell[0] - target[0]) + Math.abs(cell[1] - target[1]) === 1;
    return beside ? [cell] : [];
  });
}

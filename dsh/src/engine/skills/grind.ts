/**
 * The grind tool (task 47): walk back and forth near the party, fight every encounter with the
 * map's ordinary battle skill, rest at an inn when HP or MP runs low, and stop on one of the
 * caller's goals. The loop runs in code: no model call per step.
 *
 * The user's 11-04 rule: when gold is short or this area's bestiary is incomplete, farm near a
 * town with an inn and sleep when hurt instead of selling gear in use. Innkeeping is done in
 * code where the map records make it reliable; otherwise the party is left at the town gate
 * with a message asking the model to rest itself (the task's agreed fallback).
 */

import { Atlas } from "../atlas.ts";
import type { CompletionMonster, CompletionState } from "../completion.ts";
import type { EncounterRegion, EncounterTable } from "../encounters.ts";
import {
  EncounterGridCache,
  activeParties,
  encounterParties,
  parseEncounters,
} from "../encounters.ts";
import { describeError } from "../errors.ts";
import { cellKey, hasTerrain, terrainRule } from "../nav.ts";
import type { Cell, CellGrid } from "../nav.ts";
import type { Pilot, Reply } from "../pilot.ts";
import { parsePositionReply, type Position } from "../position.ts";
import { isRecord, list, num, record, records, text, truthy, type Json } from "../values.ts";
import { heldItems } from "./battle.ts";
import { useItem } from "./menu.ts";
import {
  occupiedCells,
  openAt,
  plan,
  settleWalkEvent,
  walkPathCells,
  walkpathBlockedMs,
  walkpathTimeout,
  walkpathTurnLead,
  type MoveState,
} from "./move.ts";
import { dismissFieldHelp } from "./screens.ts";
import {
  currentMapAndCell,
  mapExits,
  mapName,
  rideState,
  travelToCell,
  travelToMap,
  type MapExit,
} from "./travel.ts";

type Say = (line: string) => void;

/** The inn names the guide and the maps use; the first two are FF5's. */
const INN_WORDS: readonly string[] = ["宿屋", "旅店", "旅馆", "Inn"];
const REVIVE_ITEMS: readonly string[] = ["不死鸟之尾", "凤凰尾"];
const YES = /^(是|はい|yes)$/iu;
/** The old grind walk had eight hops and no clock of its own; keep both for its callers. */
const GRIND_TRAVEL = {
  maxHops: 8,
  maxMinutes: Number.POSITIVE_INFINITY,
} as const;
/** Task 68: a monster that comes back later gets at most this many battles before deferring. */
export const DEFAULT_BESTIARY_DEFER_BATTLES = 15;
/** Task 68: a missable monster's grind stops after this many minutes even if still missing. */
export const DEFAULT_BESTIARY_MISSABLE_MINUTES = 40;
/** Task 69: no grid number means the loop cannot promise to stay on this encounter area. */
const UNKNOWN_REGION = "读不到当前所在的世界地图区域，不能保证留在本区域，先停下";
/** Task 128: how long a chocobo dismount is watched for before giving up. */
const CHOCOBO_DISMOUNT_MS = 4000;

export interface GrindOptions {
  readonly untilGold?: number;
  readonly untilLevel?: number;
  readonly untilBestiary?: boolean;
  readonly maxMinutes: number;
  readonly restHpPct: number;
  readonly restMpPct: number;
  readonly inn?: number | string;
  /** Task 68 config: per-monster deferral cap for monsters that appear again later. */
  readonly bestiaryDeferBattles?: number;
  /** Task 68 config: wall-clock cap for a missable monster (max_minutes still caps it too). */
  readonly bestiaryMissableMinutes?: number;
}

export type GrindParse =
  | { readonly ok: true; readonly options: GrindOptions }
  | { readonly ok: false; readonly error: string };

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`不是整数:${show(value)}`);
  return Math.trunc(parsed);
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** Parse the tool arguments; at least one stopping condition is required. */
export function parseGrindOptions(args: Json): GrindParse {
  try {
    const untilGold =
      args.until_gold === undefined || args.until_gold === null
        ? undefined
        : integer(args.until_gold);
    const untilLevel =
      args.until_level === undefined || args.until_level === null
        ? undefined
        : integer(args.until_level);
    const untilBestiary = truthy(args.until_bestiary);
    if (untilGold === undefined && untilLevel === undefined && !untilBestiary) {
      return {
        ok: false,
        error:
          "至少给一个停止条件:until_gold(攒到多少钱)、until_level(全队最低等级)" +
          "或 until_bestiary(本图鉴刷齐)。",
      };
    }
    if (untilGold !== undefined && untilGold <= 0) {
      return { ok: false, error: "until_gold 要是正数。" };
    }
    if (untilLevel !== undefined && untilLevel <= 0) {
      return { ok: false, error: "until_level 要是正数。" };
    }
    const maxMinutes =
      args.max_minutes === undefined || args.max_minutes === null ? 20 : Number(args.max_minutes);
    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
      return { ok: false, error: "max_minutes 要是正数。" };
    }
    const restHpPct =
      args.rest_hp_pct === undefined || args.rest_hp_pct === null ? 40 : Number(args.rest_hp_pct);
    const restMpPct =
      args.rest_mp_pct === undefined || args.rest_mp_pct === null ? 25 : Number(args.rest_mp_pct);
    for (const [name, value] of [
      ["rest_hp_pct", restHpPct],
      ["rest_mp_pct", restMpPct],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return { ok: false, error: `${name} 要在 0 到 100 之间。` };
      }
    }
    let inn: number | string | undefined;
    if (typeof args.inn === "number" && Number.isFinite(args.inn)) inn = Math.trunc(args.inn);
    else if (typeof args.inn === "string" && args.inn.trim() !== "") inn = args.inn.trim();
    return {
      ok: true,
      options: {
        ...(untilGold === undefined ? {} : { untilGold }),
        ...(untilLevel === undefined ? {} : { untilLevel }),
        ...(untilBestiary ? { untilBestiary: true } : {}),
        maxMinutes,
        restHpPct,
        restMpPct,
        ...(inn === undefined ? {} : { inn }),
      },
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** What one rest and the fainter's return to the grind spot did. */
export interface GrindInnResult {
  readonly ok: boolean;
  readonly detail: string;
  /** False when the rest worked but the walk back to the grind spot did not. */
  readonly returned?: boolean;
}

/** The Game's side of the loop: ordinary battle, completion/bestiary, the atlas and walking. */
export interface GrindContext {
  readonly atlas: Atlas;
  readonly moveState: MoveState;
  /** The existing ordinary battle handler; the loop must not reimplement it. */
  readonly fighter: (pilot: Pilot, say: Say) => Promise<string>;
  /** Refresh task 45's save-local bestiary and the current map's completion. */
  readonly refresh: (pilot: Pilot) => Promise<{
    readonly completion: CompletionState | null;
    readonly known: ReadonlySet<number>;
    readonly names: ReadonlyMap<number, string>;
  }>;
  /** Task 68: write the deferred low-probability monsters into the backlog. */
  readonly defer?: (monsters: readonly CompletionMonster[], reason: string) => Promise<void> | void;
  /** Task 69: the Game's per-map/cell encounter grid cache; a fresh one is enough in tests. */
  readonly gridCache?: EncounterGridCache;
  readonly say?: Say;
}

export interface GrindReport {
  readonly text: string;
  readonly minutes: number;
  readonly battles: number;
  readonly gold: number;
  readonly goldGained: number;
  readonly minLevel: number | null;
  readonly levelGained: number;
  readonly bestiary: readonly string[];
  readonly items: readonly string[];
  readonly rests: number;
  readonly stop: string;
}

interface GrindSnapshot {
  readonly position: Position;
  readonly gold: number;
  readonly members: readonly Reply[];
  readonly minLevel: number | null;
  readonly minHpPct: number;
  readonly minMpPct: number;
}

function pct(value: unknown, top: unknown): number {
  const max = num(top) ?? 0;
  return max > 0 ? (100 * (num(value) ?? 0)) / max : 100;
}

async function readSnapshot(pilot: Pilot): Promise<GrindSnapshot> {
  const position = parsePositionReply(await pilot.send("pos"));
  const sample = record((await pilot.query("sample")).sample);
  const members = records(sample.party);
  const levels = members
    .map((member) => num(member.lv))
    .filter((level): level is number => level !== undefined);
  const hp = members.map((member) => pct(member.hp, member.maxHp));
  const mp = members.map((member) => pct(member.mp, member.maxMp));
  return {
    position,
    gold: num(record(sample.user).gil) ?? 0,
    members,
    minLevel: levels.length === 0 ? null : Math.min(...levels),
    minHpPct: hp.length === 0 ? 100 : Math.min(...hp),
    minMpPct: mp.length === 0 ? 100 : Math.min(...mp),
  };
}

function memberName(member: Reply): string {
  return text(member.name) ?? "";
}

function downed(members: readonly Reply[]): Reply[] {
  return members.filter((member) => (num(member.hp) ?? 0) <= 0);
}

function needsRest(snapshot: GrindSnapshot, options: GrindOptions): boolean {
  return snapshot.minHpPct < options.restHpPct || snapshot.minMpPct < options.restMpPct;
}

function safeHeldItems(pilot: Pilot): Promise<Record<string, number>> {
  return heldItems(pilot).catch(() => ({}));
}

/** Revive one fallen member with an item when the bag has one; false means "rest instead". */
async function tryRevive(pilot: Pilot, snapshot: GrindSnapshot, say: Say): Promise<boolean> {
  const fallen = downed(snapshot.members);
  if (fallen.length === 0) return true;
  const bag = await safeHeldItems(pilot);
  const item = REVIVE_ITEMS.find((wanted) =>
    Object.entries(bag).some(([name, count]) => count > 0 && name.includes(wanted)),
  );
  if (item === undefined) return false;
  const first = fallen[0];
  if (first === undefined) return false;
  const [ok, detail] = await useItem(pilot, item, memberName(first));
  say(`  ${detail}`);
  return ok;
}

interface WalkGrid {
  readonly cells: CellGrid | null;
  readonly world: boolean;
  readonly open: ReadonlySet<string>;
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
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

/** Terrain on the world map, every open collision row indoors; one read per grind leg. */
async function readWalkGrid(pilot: Pilot): Promise<WalkGrid> {
  const cells = cellGridOf((await pilot.send("cells", { r: 8 })).cells);
  if (cells !== null && hasTerrain(cells)) return { cells, world: true, open: new Set() };
  const collision = record((await pilot.send("collision")).collision);
  const open = new Set<string>();
  for (const raw of list(collision.layers)) {
    const layer = record(raw);
    for (const [y, row] of list(layer.rows).entries()) {
      if (typeof row !== "string") continue;
      for (let x = 0; x < row.length; x++) {
        const value = row[x];
        if (value !== undefined && value !== "1" && value !== "#") open.add(cellKey(x, y));
      }
    }
  }
  return { cells: null, world: false, open };
}

function walkable(grid: WalkGrid, cell: Cell, ship = false): boolean {
  if (grid.world) {
    const cells = grid.cells;
    if (cells === null) return false;
    const [x0, y0] = cells.origin;
    const row = cells.attr[cell[1] - y0];
    if (row === undefined) return false;
    const value = row[cell[0] - x0];
    if (value === undefined) return false;
    // Task 128: on a ship only the sea is walkable; on foot the old land rule applies.
    return terrainRule(ship)(value);
  }
  return grid.open.has(cellKey(cell[0], cell[1]));
}

function insideRegion(cell: Cell, region: EncounterRegion | null): boolean {
  if (region === null) return true;
  const start = region.start;
  const end = region.end;
  if (start === null || end === null) return true;
  return cell[0] >= start[0] && cell[0] <= end[0] && cell[1] >= start[1] && cell[1] <= end[1];
}

const STEPS: readonly Cell[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** The nearby open cells the loop may step to; cycling through them makes the back-and-forth. */
function stepCandidates(
  grid: WalkGrid,
  here: Cell,
  region: EncounterRegion | null,
  blocked: ReadonlySet<string>,
  ship = false,
): Cell[] {
  const choices: Cell[] = [];
  for (const [dx, dy] of STEPS) {
    const cell: Cell = [here[0] + dx, here[1] + dy];
    if (!insideRegion(cell, region)) continue;
    if (blocked.has(cellKey(cell[0], cell[1]))) continue;
    if (!walkable(grid, cell, ship)) continue;
    choices.push(cell);
  }
  return choices;
}

/** The encounter grid at one cell; throws when the bridge cannot answer. */
async function readGrid(
  pilot: Pilot,
  cache: EncounterGridCache,
  mapId: number | null,
  cell: Cell,
): Promise<number | null> {
  const grids = await cache.read(pilot, mapId, [cell]);
  return grids.get(cellKey(cell[0], cell[1])) ?? null;
}

/**
 * Task 69: on the world map only cells with the starting cell's encounter grid are walked.
 * The bridge is asked for all nearby cells in one `encountgrid` call; the cache answers the
 * rest. When the grid is unknown (an old bridge), the old rectangle filter still applies.
 */
async function nextStep(
  pilot: Pilot,
  grid: WalkGrid,
  here: Cell,
  region: EncounterRegion | null,
  startGrid: number | null,
  cache: EncounterGridCache,
  mapId: number | null,
  blocked: ReadonlySet<string>,
  turn: number,
  ship = false,
): Promise<Cell | null> {
  const choices = stepCandidates(grid, here, startGrid === null ? region : null, blocked, ship);
  if (startGrid === null || choices.length === 0) {
    return choices.length === 0 ? null : (choices[turn % choices.length] ?? null);
  }
  const grids = await cache.read(pilot, mapId, choices);
  const same = choices.filter((cell) => grids.get(cellKey(cell[0], cell[1])) === startGrid);
  return same.length === 0 ? null : (same[turn % same.length] ?? null);
}

/** The single grid `encounters.map.grids` gives on a world map, else null. */
function soleGrid(encounters: EncounterTable | null): number | null {
  const grids = encounters?.map?.grids ?? [];
  return grids.length === 1 ? (grids[0] ?? null) : null;
}

/**
 * The grind loop's one step: walkpath when the bridge has it (task 56), otherwise the old
 * `walk`. The target is usually a neighbour, so the route is just [here, target]; a diagonal
 * or two-cell choice is filled in by the shared planner.
 */
async function stepTo(
  pilot: Pilot,
  from: Cell,
  to: Cell,
  state: MoveState,
  map: unknown,
  ship = false,
): Promise<Reply> {
  const adjacent = Math.abs(from[0] - to[0]) + Math.abs(from[1] - to[1]) === 1;
  let path: Cell[] = adjacent ? [from, to] : [];
  if (path.length === 0) {
    const [here, planned] = await plan(pilot, to, ship, new Set<string>(), state, map ?? undefined);
    if (here !== null && here[0] === from[0] && here[1] === from[1]) {
      path = walkPathCells(planned);
    }
  }
  if (path.length >= 2) {
    const timeoutMs = walkpathTimeout(path.length, state);
    const result = await pilot.send(
      "walkpath",
      {
        path: path.map(([x, y]) => [x, y]),
        timeoutMs,
        blockedMs: walkpathBlockedMs(state),
        turnLead: walkpathTurnLead(state),
      },
      timeoutMs + 5_000,
    );
    if (result.error !== "walkpath_unsupported") {
      const reason = typeof result.reason === "string" ? result.reason : "";
      if (reason === "state:Event" || reason === "dialog") {
        // Task 63: an encounter's opening Event frame must become a battle here too, not a
        // story stop or a blocked step.
        const settled = await settleWalkEvent(pilot, state);
        if (settled.outcome === "battle") {
          return { ...result, reason: "battle", pos: settled.pos };
        }
        if (settled.outcome === "clear") return { ...result, ok: true, pos: settled.pos };
      }
      return walkShaped(result);
    }
  }
  return await pilot.send("walk", { to: [to[0], to[1]], timeout: 30_000 }, 40_000);
}

/**
 * A walkpath reply in the pilot agent's walk shape, which the loop below reads: walkpath says
 * why it stopped in `reason` and has no `error`, so a story stop read as "None" and counted as
 * blocked (11-05 review). blocked stays blocked; dialog and state:* become interrupted:*.
 */
function walkShaped(result: Reply): Reply {
  if (truthy(result.ok) || result.error !== undefined) return result;
  const reason = typeof result.reason === "string" ? result.reason : "";
  const interrupted = reason === "dialog" || reason.startsWith("state:");
  return { ...result, error: interrupted ? `interrupted:${reason}` : reason };
}

interface StopCheck {
  readonly reached: boolean;
  readonly reason: string;
}

function stopReason(
  options: GrindOptions,
  snapshot: GrindSnapshot,
  completion: CompletionState | null,
): StopCheck {
  if (options.untilGold !== undefined && snapshot.gold >= options.untilGold) {
    return {
      reached: true,
      reason: `钱够了(${snapshot.gold}/${options.untilGold})`,
    };
  }
  if (
    options.untilLevel !== undefined &&
    snapshot.minLevel !== null &&
    snapshot.minLevel >= options.untilLevel
  ) {
    return {
      reached: true,
      reason: `全队最低等级到了 ${snapshot.minLevel}/${options.untilLevel}`,
    };
  }
  if (options.untilBestiary === true) {
    if (completion === null || completion.encounter === "unknown") {
      return {
        reached: true,
        reason: "读不到本图的遇敌表，没法刷图鉴，先停下",
      };
    }
    if (completion.encounter === "none" || completion.monsters.total === 0) {
      return { reached: true, reason: "本图现在不遇敌，不用刷图鉴" };
    }
    if (completion.monsters.missing.length === 0) {
      return { reached: true, reason: "本图的怪都登记进本档图鉴了" };
    }
    if (completion.monsters.missing.every((monster) => monster.lost)) {
      return { reached: true, reason: "本图剩下的怪已经错过，刷不到了" };
    }
  }
  return { reached: false, reason: "" };
}

interface BestiaryBudgetItem {
  readonly number: number | null;
  readonly name: string;
  readonly chance: number | null;
  readonly expectedBattles: number | null;
  readonly missable: string | null;
  readonly lost: boolean;
  readonly deferBattles: number | null;
  readonly missableBattles: number | null;
  givenUp: boolean;
  /** The battle count when it gave up; null while its budget is not used up. */
  gaveUpAt: number | null;
  registered: boolean;
}

function clampBudget(expected: number, low: number, high: number): number {
  return Math.max(low, Math.min(expected, Math.max(low, high)));
}

/** Task 68: one budget per missing monster, from its chance and misses-forever category. */
function bestiaryBudget(
  completion: CompletionState | null,
  options: GrindOptions,
): BestiaryBudgetItem[] {
  const deferMax = options.bestiaryDeferBattles ?? DEFAULT_BESTIARY_DEFER_BATTLES;
  return (completion?.monsters.missing ?? [])
    .filter((monster) => !monster.lost)
    .map((monster) => {
      const expected = monster.expectedBattles;
      const deferBattles =
        monster.chance !== null &&
        monster.chance > 0 &&
        monster.missable === null &&
        expected !== null
          ? clampBudget(expected, 3, deferMax)
          : null;
      const missableBattles =
        monster.missable !== null && expected !== null
          ? Math.max(5 * expected, Math.max(3, deferMax))
          : null;
      return {
        number: monster.number,
        name: monster.name,
        chance: monster.chance,
        expectedBattles: expected,
        missable: monster.missable,
        lost: monster.lost,
        deferBattles,
        missableBattles,
        givenUp: false,
        gaveUpAt: null,
        registered: false,
      };
    });
}

function refreshBudget(budget: BestiaryBudgetItem[], completion: CompletionState | null): void {
  if (completion?.encounter !== "ok") return;
  const missing = new Set<number>();
  for (const monster of completion.monsters.missing) {
    if (monster.number !== null) missing.add(monster.number);
  }
  for (const item of budget) {
    item.registered = item.number === null || !missing.has(item.number);
  }
}

function pendingBudget(budget: readonly BestiaryBudgetItem[]): BestiaryBudgetItem[] {
  return budget.filter((item) => !item.registered && !item.givenUp && !item.lost);
}

function percentText(chance: number | null): string {
  return chance === null ? "?" : `${Math.round(chance * 100)}%`;
}

function deferredReason(budget: readonly BestiaryBudgetItem[]): string {
  const parts = budget.map((item) => {
    const body =
      `低概率(${percentText(item.chance)}),刷了 ${item.gaveUpAt ?? 0} 场没遇到;` +
      "以后还会出现，留到以后补";
    return budget.length === 1 ? body : `${item.name}:${body}`;
  });
  return parts.join("；");
}

function missableReason(budget: readonly BestiaryBudgetItem[], battles: number): string {
  const parts = budget.map(
    (item) =>
      `${budget.length === 1 ? "这只怪" : item.name}会错过(期限：${item.missable ?? "?"})，` +
      `刷了 ${battles} 场(平均 ${item.expectedBattles ?? "?"} 场一次)还没遇到，可能是数据有误`,
  );
  return `${parts.join("；")};要接着刷就再调 grind`;
}

/** After each refresh: stop when a missable one hit either cap, or every deferrable gave up. */
function budgetCheck(
  budget: BestiaryBudgetItem[],
  battles: number,
  elapsedMinutes: number,
  missableMinutes: number,
): StopCheck {
  for (const item of pendingBudget(budget)) {
    if (item.deferBattles !== null && battles >= item.deferBattles) {
      item.givenUp = true;
      item.gaveUpAt ??= battles;
    }
  }
  const missed = pendingBudget(budget).filter(
    (item) =>
      item.missable !== null &&
      ((item.missableBattles !== null && battles >= item.missableBattles) ||
        elapsedMinutes >= missableMinutes),
  );
  if (missed.length > 0) {
    return { reached: true, reason: missableReason(missed, battles) };
  }
  const left = pendingBudget(budget);
  if (left.length > 0) return { reached: false, reason: "" };
  const deferred = budget.filter((item) => item.givenUp && !item.registered && !item.lost);
  if (deferred.length > 0) {
    return { reached: true, reason: deferredReason(deferred) };
  }
  return { reached: true, reason: "本图的怪都登记进本档图鉴了" };
}

function innName(name: string): boolean {
  return INN_WORDS.some((word) => name.toLowerCase().includes(word.toLowerCase()));
}

function isInnMap(atlas: Atlas, mapId: number): boolean {
  return innName(mapName(atlas, mapId));
}

function nearestExit(exits: readonly MapExit[], here: Cell | null): MapExit | undefined {
  if (here === null) return exits[0];
  return [...exits].sort(
    (left, right) =>
      Math.abs(left.cell[0] - here[0]) +
      Math.abs(left.cell[1] - here[1]) -
      (Math.abs(right.cell[0] - here[0]) + Math.abs(right.cell[1] - here[1])),
  )[0];
}

/** The inn map to use: the argument first, else the nearest one the atlas knows. */
function findInnMap(
  atlas: Atlas,
  choice: number | string | undefined,
  current: number | null,
  here: Cell | null,
): number | null {
  if (typeof choice === "number") {
    if (isInnMap(atlas, choice)) return choice;
    const exits = mapExits(atlas, choice).filter((exit) => isInnMap(atlas, exit.to));
    return nearestExit(exits, here)?.to ?? null;
  }
  if (typeof choice === "string") {
    if (/^\d+$/u.test(choice)) return findInnMap(atlas, Number(choice), current, here);
    const wanted = choice.toLowerCase();
    for (const [key, entry] of atlas.maps) {
      const id = Number(key);
      if (!Number.isFinite(id)) continue;
      if (!innName(text(entry.name) ?? "")) continue;
      if ((text(entry.name) ?? "").toLowerCase().includes(wanted)) return id;
    }
    for (const [key] of atlas.maps) {
      const id = Number(key);
      if (!Number.isFinite(id)) continue;
      const target = isInnMap(atlas, id)
        ? id
        : nearestExit(
            mapExits(atlas, id).filter((exit) => isInnMap(atlas, exit.to)),
            here,
          )?.to;
      if (target === undefined) continue;
      if ((mapName(atlas, target) || mapName(atlas, id)).toLowerCase().includes(wanted))
        return target;
    }
    return null;
  }
  if (current === null) return null;
  if (isInnMap(atlas, current)) return current;
  const direct = mapExits(atlas, current).filter((exit) => isInnMap(atlas, exit.to));
  const nearest = nearestExit(direct, here);
  if (nearest !== undefined) return nearest.to;
  // BFS over the map records: the first inn reached by the nearest exits wins.
  const queue: number[] = [current];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const exits = [...mapExits(atlas, id)].sort((left, right) => {
      const distance = (exit: MapExit): number =>
        here === null ? 0 : Math.abs(exit.cell[0] - here[0]) + Math.abs(exit.cell[1] - here[1]);
      return distance(left) - distance(right);
    });
    for (const exit of exits) {
      if (isInnMap(atlas, exit.to)) return exit.to;
      if (seen.has(exit.to) || !atlas.maps.has(String(exit.to))) continue;
      seen.add(exit.to);
      queue.push(exit.to);
    }
  }
  return null;
}

/** The town that has an inn: the fallback's stopping place. */
function townForInn(atlas: Atlas, inn: number): number | null {
  for (const [key] of atlas.maps) {
    const id = Number(key);
    if (!Number.isFinite(id) || isInnMap(atlas, id)) continue;
    if (mapExits(atlas, id).some((exit) => exit.to === inn)) return id;
  }
  return null;
}

interface ChoiceView {
  readonly open: boolean;
  readonly options: readonly string[];
  readonly cursor: number;
}

function choiceOf(sample: Json): ChoiceView {
  for (const value of Object.values(record(sample.choice))) {
    if (!isRecord(value) || !truthy(value.open)) continue;
    const raw = truthy(value.options) ? value.options : value.labels;
    const options = list(raw).map((item) => show(item));
    return { open: true, options, cursor: num(value.cursor) ?? 0 };
  }
  return { open: false, options: [], cursor: 0 };
}

/** Pick 「是」 on the innkeeper's question and page the rest of the dialog. */
async function answerInn(pilot: Pilot): Promise<string> {
  const sample = record((await pilot.query("sample")).sample);
  const choice = choiceOf(sample);
  if (!choice.open) return "店主没有问要不要住宿";
  let index = choice.options.findIndex((option) => YES.test(option.trim()));
  if (index < 0) index = 0;
  const step = index >= choice.cursor ? "Down" : "Up";
  const keys = [...Array.from({ length: Math.abs(index - choice.cursor) }, () => step), "Enter"];
  await pilot.send("keys", { keys, gap: 200 });
  await pilot.send("story", { pageMs: 1200, timeout: 60_000 }, 70_000);
  return "选了「是」并付了钱";
}

/** The NPC that runs the inn: its name, the one behind a counter, else the only NPC. */
async function innKeeper(pilot: Pilot): Promise<Reply | null> {
  const found = records(
    record((await pilot.send("entities", { kind: "Npc", max: 60 })).entities).entities,
  );
  const named = found.find((npc) => innName(text(npc.name) ?? ""));
  if (named !== undefined) return named;
  const relays = records(
    record((await pilot.send("entities", { kind: "RelayInteraction", max: 60 })).entities).entities,
  ).flatMap((relay) => {
    const cell = cellOf(relay.cell);
    return cell === null ? [] : [cell];
  });
  const behind = found.find((npc) => {
    const cell = cellOf(npc.cell);
    return (
      cell !== null &&
      relays.some((relay) => Math.abs(relay[0] - cell[0]) + Math.abs(relay[1] - cell[1]) === 1)
    );
  });
  if (behind !== undefined) return behind;
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** Grind's old `(arrived, detail)` view of the shared map walk. */
async function grindTravel(
  pilot: Pilot,
  context: GrindContext,
  target: number,
  say: Say,
): Promise<[boolean, string]> {
  const result = await travelToMap(pilot, context, target, say, GRIND_TRAVEL);
  return [result.reached, result.detail];
}

/** Sleep at an inn, then walk back to the grind spot. */
export async function restAtInn(
  pilot: Pilot,
  context: GrindContext,
  home: number | null,
  spot: Cell,
  options: GrindOptions,
  say: Say,
): Promise<GrindInnResult> {
  const [current, here] = await currentMapAndCell(pilot);
  const inn = findInnMap(context.atlas, options.inn, current, here);
  if (inn === null) {
    return {
      ok: false,
      detail: "地图记录里找不到有旅店的城镇，没法自动住店。请自己回城住一晚，回满 HP/MP 再继续刷。",
    };
  }
  const [arrived, travel] = await grindTravel(pilot, context, inn, say);
  if (!arrived) return await restFallback(pilot, context, inn, travel, say);
  const keeper = await innKeeper(pilot);
  if (keeper === null) return await restFallback(pilot, context, inn, "旅店里没找到店主", say);
  const keeperCell = cellOf(keeper.cell);
  if (keeperCell === null) return await restFallback(pilot, context, inn, "店主没有格子坐标", say);
  const before = await readSnapshot(pilot);
  const said = await openAt(pilot, keeperCell, say, context.moveState);
  say(`  ${said}`);
  const paid = await answerInn(pilot);
  const after = await readSnapshot(pilot);
  const recovered =
    after.minHpPct > before.minHpPct ||
    after.minMpPct > before.minMpPct ||
    (after.minHpPct >= 99 && after.minMpPct >= 99);
  if (!recovered) {
    return await restFallback(
      pilot,
      context,
      inn,
      `和店主说话后没有回满(${before.minHpPct.toFixed(0)}% → ${after.minHpPct.toFixed(0)}% HP)`,
      say,
    );
  }
  const backTarget = home ?? before.position.map ?? inn;
  const [back, walked] = await grindTravel(pilot, context, backTarget, say);
  let returned = back;
  if (back) {
    const [atSpot, detail] = await travelToCell(pilot, context, spot, say);
    returned = atSpot;
    if (!atSpot) say(`  回刷怪点失败:${detail}`);
  }
  return {
    ok: true,
    returned,
    detail:
      `在「${mapName(context.atlas, inn)}」住了一晚(${paid})，` +
      (returned ? "回到刷怪点继续" : `没能回到刷怪点(${walked})`),
  };
}

/** Could not sleep automatically: go as far as the town and ask the model to do it. */
async function restFallback(
  pilot: Pilot,
  context: GrindContext,
  inn: number,
  why: string,
  say: Say,
): Promise<GrindInnResult> {
  const town = townForInn(context.atlas, inn);
  if (town !== null) {
    const [current] = await currentMapAndCell(pilot);
    if (current !== town) await grindTravel(pilot, context, town, say);
  }
  const [where] = await currentMapAndCell(pilot);
  const place = where === null ? "原地" : `地图 ${where}(${mapName(context.atlas, where)})`;
  return {
    ok: false,
    detail: `自动住店没做成(${why})，停在${place}。请自己进旅店住一晚，回满 HP/MP 再继续刷。`,
  };
}

function itemUseText(before: Record<string, number>, after: Record<string, number>): string[] {
  const used: string[] = [];
  for (const [name, count] of Object.entries(before)) {
    const left = after[name] ?? 0;
    if (count > left) used.push(`${name}×${count - left}`);
  }
  return used;
}

function minutesText(minutes: number): string {
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分钟`;
}

/** The loop itself. Throws only for a missing argument set; every in-game failure is a stop. */
/**
 * Task 128: 11-11 live, `grind(until_bestiary)` rode a chocobo for eight minutes and met no
 * battle at all. The game's field action for getting off is cancel (bridge `Backspace`); the
 * move state is the only proof, so wait for it to stop saying Chocobo before walking.
 */
async function leaveChocobo(pilot: Pilot): Promise<[boolean, string]> {
  await pilot.send("keys", { keys: ["Backspace"], gap: 200 });
  const deadline = pilot.now() + CHOCOBO_DISMOUNT_MS;
  while ((await rideState(pilot)) === "Chocobo" && pilot.now() < deadline) {
    await pilot.sleep(300);
  }
  return (await rideState(pilot)) === "Chocobo"
    ? [false, "骑着陆行鸟，按取消也没下来；先下鸟再刷"]
    : [true, "先从陆行鸟上下来再刷"];
}

/** Task 128: whether a ship at this spot can meet enemies at all. */
function shipEncounters(table: EncounterTable | null): boolean {
  if (table === null) return false;
  if (table.enabled === false || table.vehicle?.encounter === false) return false;
  return activeParties(encounterParties(table)).length > 0;
}

export async function grind(
  pilot: Pilot,
  options: GrindOptions,
  context: GrindContext,
): Promise<GrindReport> {
  const say = context.say ?? (() => undefined);
  const startedMs = pilot.now();
  const deadline = startedMs + options.maxMinutes * 60_000;
  const emptyBestiary = new Map<number, string>();
  let start = await readSnapshot(pilot);
  let ride = await rideState(pilot);
  // Task 128: 11-11 live, grind on a chocobo met no battle for eight minutes. Dismount first;
  // if that fails, say so at once instead of walking until max_minutes.
  if (ride === "Chocobo") {
    const [down, detail] = await leaveChocobo(pilot);
    if (!down) {
      return finish(pilot, start, start, emptyBestiary, 0, [], detail, startedMs, false);
    }
    say(detail);
    start = await readSnapshot(pilot);
    ride = await rideState(pilot);
  }
  const spot = start.position.cell;
  if (spot === null) throw new Error("读不到队伍现在站在哪一格，没法刷怪。");
  const grid0 = await readWalkGrid(pilot);
  let encounters = null;
  try {
    encounters = parseEncounters(await pilot.query("encounters"));
  } catch {
    // Indoors a missing table only costs the until_bestiary goal; on the world map it also
    // means the current region is unknown, and the check below stops instead of wandering.
  }
  // Task 128: a ship only meets enemies at sea when this region has a non-zero formation. The
  // 11-11 report was "船上的刷怪循环走不了格子"; either drive the ship on the sea or stop now.
  const ship = ride === "Ship";
  if (ship) {
    if (encounters === null) {
      return finish(
        pilot,
        start,
        start,
        emptyBestiary,
        0,
        [],
        "坐船时读不到这片海的遇敌表，先停下",
        startedMs,
        false,
      );
    }
    if (!shipEncounters(encounters)) {
      return finish(
        pilot,
        start,
        start,
        emptyBestiary,
        0,
        [],
        "这里坐船遇不到敌人",
        startedMs,
        false,
      );
    }
  }
  const region = grid0.world ? (encounters?.region ?? null) : null;
  const gridCache = context.gridCache ?? new EncounterGridCache();
  let startGrid = grid0.world ? soleGrid(encounters) : null;
  if (grid0.world && startGrid === null) {
    try {
      startGrid = await readGrid(pilot, gridCache, start.position.map, spot);
    } catch {
      startGrid = null;
    }
    // Task 69: a bridge that still gives the region's own grid is better than nothing, but a
    // query that fails there still stops below (candidate cells cannot be checked).
    startGrid ??= region?.grid ?? null;
  }
  if (grid0.world && startGrid === null && (region?.start == null || region.end == null)) {
    return finish(
      pilot,
      start,
      start,
      new Map<number, string>(),
      0,
      [],
      UNKNOWN_REGION,
      startedMs,
      false,
    );
  }
  let snapshot = start;
  let knowledge = await context.refresh(pilot);
  const startKnown = new Set(knowledge.known);
  const newBestiary = new Map<number, string>();
  const bagBefore = await safeHeldItems(pilot);
  let battles = 0;
  let rests = 0;
  let turn = 0;
  let blocked = 0;
  let stop = "";
  let fallback = false;
  let grid = grid0;
  let lastRest = "";
  const occupied = new Set((await occupiedCells(pilot)).map((cell) => cellKey(cell[0], cell[1])));

  const markNew = (known: ReadonlySet<number>, names: ReadonlyMap<number, string>): void => {
    for (const number of known) {
      if (startKnown.has(number) || newBestiary.has(number)) continue;
      newBestiary.set(number, names.get(number) ?? `#${number}`);
    }
  };
  markNew(knowledge.known, knowledge.names);

  // Task 68: until_bestiary sets its own per-monster budget; max_minutes stays the outer cap.
  const budgetEnabled = options.untilBestiary === true;
  const budget = budgetEnabled ? bestiaryBudget(knowledge.completion, options) : [];
  const missableMinutes = options.bestiaryMissableMinutes ?? DEFAULT_BESTIARY_MISSABLE_MINUTES;

  const atGoal = (): boolean => {
    const check = stopReason(options, snapshot, knowledge.completion);
    if (check.reached) {
      stop = check.reason;
      return true;
    }
    if (!budgetEnabled) return false;
    refreshBudget(budget, knowledge.completion);
    const elapsedMinutes = (pilot.now() - startedMs) / 60_000;
    const result = budgetCheck(budget, battles, elapsedMinutes, missableMinutes);
    if (result.reached) stop = result.reason;
    return result.reached;
  };

  if (atGoal()) {
    return finish(
      pilot,
      start,
      snapshot,
      newBestiary,
      battles,
      itemUseText(bagBefore, await safeHeldItems(pilot)),
      stop,
      startedMs,
      false,
      rests,
      lastRest,
    );
  }

  while (pilot.now() < deadline) {
    if (needsRest(snapshot, options)) {
      if (!(await tryRevive(pilot, snapshot, say))) {
        const rest = await restAtInn(pilot, context, start.position.map, spot, options, say);
        lastRest = rest.detail;
        say(`  ${rest.detail}`);
        if (!rest.ok) {
          fallback = true;
          stop = rest.detail;
          break;
        }
        rests += 1;
        if (rest.returned === false) {
          stop = rest.detail;
          break;
        }
        snapshot = await readSnapshot(pilot);
        knowledge = await context.refresh(pilot);
        markNew(knowledge.known, knowledge.names);
        grid = await readWalkGrid(pilot);
        if (atGoal()) break;
      } else {
        snapshot = await readSnapshot(pilot);
        if (!needsRest(snapshot, options)) continue;
        const rest = await restAtInn(pilot, context, start.position.map, spot, options, say);
        lastRest = rest.detail;
        say(`  ${rest.detail}`);
        if (!rest.ok) {
          fallback = true;
          stop = rest.detail;
          break;
        }
        rests += 1;
        if (rest.returned === false) {
          stop = rest.detail;
          break;
        }
        snapshot = await readSnapshot(pilot);
        knowledge = await context.refresh(pilot);
        markNew(knowledge.known, knowledge.names);
        grid = await readWalkGrid(pilot);
        if (atGoal()) break;
      }
    }
    if (pilot.now() >= deadline) {
      stop = `到 ${options.maxMinutes} 分钟了`;
      break;
    }
    const here = snapshot.position.cell;
    if (here === null) {
      stop = "读不到当前位置，先停下";
      break;
    }
    if (grid.world && startGrid === null && region !== null && !insideRegion(here, region)) {
      stop = `已经离开当前世界地图区域(在 ${here[0]}, ${here[1]})，先停下`;
      break;
    }
    if (grid.world && startGrid !== null) {
      let hereGrid: number | null;
      try {
        hereGrid = await readGrid(pilot, gridCache, snapshot.position.map, here);
      } catch {
        stop = UNKNOWN_REGION;
        break;
      }
      if (hereGrid !== startGrid) {
        stop = `已经离开当前世界地图遇敌区(在 ${here[0]}, ${here[1]})，先停下`;
        break;
      }
    }
    let target: Cell | null;
    try {
      target = await nextStep(
        pilot,
        grid,
        here,
        region,
        startGrid,
        gridCache,
        snapshot.position.map,
        occupied,
        turn,
        ship,
      );
    } catch {
      stop = UNKNOWN_REGION;
      break;
    }
    turn += 1;
    if (target === null) {
      stop = ship ? "船在这片海里没有能走的格子，先停下" : "附近没有能走的格子，走不过去，先停下";
      break;
    }
    const moved = await stepTo(pilot, here, target, context.moveState, snapshot.position.map, ship);
    const pos = record(moved.pos);
    const inBattle = truthy(pos.battle) || pos.state === "Battle";
    if (inBattle) {
      blocked = 0;
      const fought = await context.fighter(pilot, say);
      battles += 1;
      say(`  ${fought}`);
      snapshot = await readSnapshot(pilot);
      knowledge = await context.refresh(pilot);
      markNew(knowledge.known, knowledge.names);
      if (
        fought.startsWith("全灭") ||
        downed(snapshot.members).length === snapshot.members.length
      ) {
        stop = `全灭:${fought.split(/\r?\n/u, 1)[0] ?? fought}`;
        break;
      }
      if (atGoal()) break;
      if (snapshot.position.state !== "Player") {
        stop = `战斗后停在状态 ${show(snapshot.position.state)}，先停下`;
        break;
      }
      continue;
    }
    if (pos.state === "FieldHelp") {
      const help = await dismissFieldHelp(pilot);
      if (help === "stuck") {
        stop = "关不掉操作提示，先停下";
        break;
      }
      continue;
    }
    if (pos.state === "Gimmick" || String(moved.error).includes("Gimmick")) {
      await pilot.send("wait", { timeout: 30_000 }, 40_000);
      snapshot = await readSnapshot(pilot);
      continue;
    }
    if (!truthy(moved.ok)) {
      const error = show(moved.error);
      if (error.includes("blocked") || error === "None") {
        blocked += 1;
        snapshot = await readSnapshot(pilot);
        if (blocked >= 8) {
          stop = `连续 ${blocked} 次走不过去，先停下`;
          break;
        }
        continue;
      }
      if (error.startsWith("interrupted:")) {
        stop = `被剧情或对话打断(${error})，先停下：翻完剧情再接着刷`;
        break;
      }
      stop = `走不过去(${error})，先停下`;
      break;
    }
    blocked = 0;
    snapshot = await readSnapshot(pilot);
    if (snapshot.position.map !== start.position.map) {
      stop =
        `走到了地图 ${show(snapshot.position.map)}，不在原来刷怪的地图，先停下` +
        "(请自己走回去再刷)";
      break;
    }
    if (grid.world && startGrid === null && region !== null) {
      const now = snapshot.position.cell;
      if (now !== null && !insideRegion(now, region)) {
        stop = `走出了当前世界地图区域(在 ${now[0]}, ${now[1]})，先停下`;
        break;
      }
    }
    if (grid.world && startGrid !== null) {
      const now = snapshot.position.cell;
      if (now !== null) {
        let nowGrid: number | null;
        try {
          nowGrid = await readGrid(pilot, gridCache, snapshot.position.map, now);
        } catch {
          stop = UNKNOWN_REGION;
          break;
        }
        if (nowGrid !== startGrid) {
          stop = `走出了当前世界地图遇敌区(在 ${now[0]}, ${now[1]})，先停下`;
          break;
        }
      }
    }
    if (atGoal()) break;
  }

  refreshBudget(budget, knowledge.completion);
  const deferred = budget.filter((item) => item.givenUp && !item.registered && !item.lost);
  if (deferred.length > 0) {
    const reason = deferredReason(deferred);
    let note = `已记欠账:${reason}。可以直接离开，以后回来补。`;
    if (context.defer === undefined) {
      note = `本该记欠账但没记成:${reason}`;
    } else {
      try {
        await context.defer(deferred, reason);
      } catch (error) {
        note = `记欠账失败(${describeError(error)}):${reason}`;
      }
    }
    stop = stop === reason ? note : `${stop}；${note}`;
  }

  if (stop === "") stop = `到 ${options.maxMinutes} 分钟了`;
  return finish(
    pilot,
    start,
    snapshot,
    newBestiary,
    battles,
    itemUseText(bagBefore, await safeHeldItems(pilot)),
    stop,
    startedMs,
    fallback,
    rests,
    lastRest,
  );
}

/** Build the one result the model reads; shared by every early stop. */
function finish(
  pilot: Pilot,
  start: GrindSnapshot,
  end: GrindSnapshot,
  newBestiary: ReadonlyMap<number, string>,
  battles: number,
  items: readonly string[],
  stop: string,
  startedMs: number,
  fallback: boolean,
  rests = 0,
  lastRest = "",
): GrindReport {
  const minutes = Math.max(0, (pilot.now() - startedMs) / 60_000);
  const gained = end.gold - start.gold;
  const levelGained =
    start.minLevel === null || end.minLevel === null ? 0 : end.minLevel - start.minLevel;
  const bestiary = [...newBestiary.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, name]) => name);
  const levelText =
    start.minLevel === null || end.minLevel === null
      ? "等级读不到"
      : `全队最低等级 ${start.minLevel}→${end.minLevel}` +
        (levelGained > 0 ? `(+${levelGained})` : "");
  const parts = [
    `刷了 ${minutesText(minutes)}:打了 ${battles} 场`,
    `钱 ${start.gold}→${end.gold}(${gained >= 0 ? "+" : ""}${gained})`,
    levelText,
    bestiary.length > 0
      ? `本档图鉴新登记 ${bestiary.length} 种:${bestiary.join("、")}`
      : "本档图鉴没有新登记",
    items.length > 0 ? `用掉 ${items.join("、")}` : "没有用掉道具",
    rests > 0 ? `自动住了 ${rests} 次店` : fallback ? "没能自动住店" : "没有住店",
  ];
  if (lastRest !== "") parts.push(`住店:${lastRest}`);
  parts.push(`停:${stop.replace(/^停:/u, "")}`);
  return {
    text: parts.join(","),
    minutes,
    battles,
    gold: end.gold,
    goldGained: gained,
    minLevel: end.minLevel,
    levelGained,
    bestiary,
    items,
    rests,
    stop,
  };
}

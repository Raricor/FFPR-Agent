/**
 * Segment executor (task 138, 11-11): run one whole `SegmentPlan` with code only. The player
 * model wrote the plan (walking, chests, battles, grinding, boss actions); this module walks
 * the stations in order, pages story interruptions, fights the plan's tables and hands back a
 * `SegmentReport` only when something the plan did not answer happens.
 *
 * The user's 11-11 direction: after the plan is written, the model must not be asked to press
 * `go` again. Everything the executor needs is behind `ExecutePorts`, so the order, stopping
 * rules and report can be tested with doubles and the real device is only one implementation
 * (`game-ports.ts`). The tactician is never called from here; `modelCalls` must stay 0.
 */

import { cleanName } from "../icons.ts";
import { normalizeName } from "../knowledge/index.ts";
import type { Cell } from "../nav.ts";
import { executeRoute, type RoutePorts, type RouteRunOptions } from "../route/execute.ts";
import { targetCell } from "../route/tool.ts";
import type { RoutePlan, Waypoint, WaypointKind } from "../route/types.ts";
import type { RunEventInput, RunLogSink } from "../run-log.ts";
import { isRecord, type Json } from "../values.ts";
import type {
  PlanBattle,
  PlanBoss,
  PlanExceptionKind,
  PlanStation,
  PlanStationAction,
  SegmentPlan,
  SegmentReport,
} from "./types.ts";

/** The segment's own default budget; the route executor still caps each station. */
export const DEFAULT_SEGMENT_BUDGET_MS = 60 * 60 * 1000;
/** One station may not hold the segment past this; the plan's own walk is the slow part. */
export const DEFAULT_STATION_BUDGET_MS = 15 * 60 * 1000;
/** Task 156: the pre-boss heal uses items up to this line unless Config supplies its own. */
const DEFAULT_BOSS_HEAL_PERCENT = 95;
/** Task 159: one save-point detour may not hold the segment too long. */
const SAVE_POINT_WALK_BUDGET_MS = 5 * 60 * 1000;
/** Task 162: the default direction exploration cap; Config overrides it. */
export const DEFAULT_STORY_EXPLORE_MS = 3 * 60 * 1000;

export interface PlanPortMember {
  readonly name: string;
  readonly job: string;
  readonly lv: number | null;
  readonly hp: number;
  readonly maxHp: number;
  readonly mp: number;
  readonly maxMp: number;
  readonly status: readonly string[];
  /** Learned/command abilities, used for the report's new blue magic. */
  readonly abilities: readonly string[];
}

/** What the executor reads between stations and for the report. */
export interface PlanObservation {
  readonly map: number | null;
  readonly cell: Cell | null;
  /** Task 152: gil in hand, for `ChapterGrowthTarget.gil`; null when the bridge cannot read it. */
  readonly gil?: number | null;
  /** The map's area name when the knowledge module knows it; prep shops in the same area. */
  readonly area?: string | null;
  readonly members: readonly PlanPortMember[];
  /** Every normal item in the bag, by name. */
  readonly items: Readonly<Record<string, number>>;
  readonly bestiary: readonly {
    readonly number: number;
    readonly name: string;
  }[];
  readonly blueMagic: readonly string[];
  /** True flags in the save's treasure table; null when an old bridge cannot read it. */
  readonly chestsOpened: number | null;
  /** Battles the engine fought since `beginBattles`; the report adds boss fights. */
  readonly battles: number;
}

export interface PlanActionResult {
  readonly ok: boolean;
  readonly text: string;
  /** Task 145 follow-up 4: a no-effect action is a plan problem, not a retryable failure. */
  readonly fatal?: boolean;
  /** Task 145 follow-up 6: hard evidence the action did something (dialogue, party, item, ...). */
  readonly evidence?: readonly string[];
}

export interface PlanBuyResult extends PlanActionResult {
  /** Whether a shop was open; a purchase away from a shop is a note, not an exception. */
  readonly atShop: boolean;
  readonly bought: number;
}

/** One product a shop sells. `names` carries the other languages' and content-table names. */
export interface PlanShopProduct {
  readonly name: string;
  readonly names?: readonly string[];
  readonly itemId?: number | null;
  readonly price: number | null;
}

/**
 * One shop the game data locates: the map and the clerk's cell. `id` is the product group id
 * the map's NPC records, not the (sometimes misleading) shop export's map id.
 */
export interface PlanShop {
  readonly id: number | null;
  readonly map: number;
  readonly cell: Cell;
  readonly area: string;
  readonly kind: string;
  readonly products: readonly PlanShopProduct[];
}

export interface PlanStationResult extends PlanActionResult {
  readonly done: boolean;
  /** Chinese: the plan did not answer this dialog choice/shop/boss. */
  readonly decision?: string;
  /** Task 159: the station was deliberately skipped (a save that could not be made). */
  readonly skipReason?: string;
}

export interface PlanBossResult {
  readonly won: boolean;
  readonly text: string;
  /** Chinese battle summary for a `boss-lost` exception. */
  readonly summary: string;
}

export type PlanProgressStatus = "pending" | "current" | "done" | "failed" | "handoff" | "skipped";

/** One map exit/entrance the plan targets (task 145): stepping on it enters `toMap`. */
export interface PlanExitTarget {
  readonly toMap: number;
  /** Chinese (or the game's own) name of the destination; empty when unknown. */
  readonly name: string;
}

/** Task 152: an inn or recovery point the chapter executor can walk back to. */
export interface PlanRestorePoint {
  readonly map: number;
  readonly cell: Cell;
  /** Chinese: the game's own name or the knowledge entry's label. */
  readonly name: string;
  /** Whether sleeping here revives the fallen (inns do; a mere rest spot may not). */
  readonly revive?: boolean;
}

/** One story-trigger cell the executor may try (task 161). */
export interface PlanStoryCandidate {
  readonly cell: Cell;
  readonly name: string;
  /** `sc_e_NNNN`/`ev_e_NNNN` scene number, when the name has one. */
  readonly script: number | null;
  /** `npc` is faced and confirmed; `event` is stepped on. */
  readonly kind: "npc" | "event";
  /** The station's why/goal named this character (via knowledge aliases). */
  readonly matched: boolean;
}

/** One step of task 162's direction exploration. */
export interface PlanExploreStep {
  readonly map: number;
  readonly cell: Cell;
  readonly moved: boolean;
  readonly reason: string;
}

/** One map's story trigger candidates (task 145 follow-up 5, task 161). */
export interface PlanStoryTrigger {
  readonly cell: Cell | null;
  readonly name: string;
  /** Number of story-trigger cells found. */
  readonly count: number;
  /** Sorted candidates when more than one; older fake ports may omit it. */
  readonly candidates?: readonly PlanStoryCandidate[];
}

/** What the screen shows between stations (task 145): battle, story/dialog, or the field. */
export interface PlanScene {
  readonly state: string | null;
  readonly dialog: boolean;
  readonly battle: boolean;
  /** The bridge says this is a boss fight (not merely a monster whose name matches). */
  readonly boss: boolean;
  readonly enemies: readonly string[];
}

/**
 * Everything the executor may do. The real implementation is `game-ports.ts`; tests pass a
 * hand-written object and make an unexpected call fail loudly.
 */
export interface ExecutePorts {
  /** Suspend the model layers for the whole run; called once before anything else. */
  begin?(): Promise<void> | void;
  end?(): Promise<void> | void;

  position(): Promise<{ readonly map: number; readonly cell: Cell } | null>;
  /** `refresh` also re-reads the save-local bestiary and treasure flags (start/end only). */
  observe(refresh?: boolean): Promise<PlanObservation>;

  changeJob(member: string, job: string, abilities: readonly string[]): Promise<PlanActionResult>;
  optimizeEquipment(): Promise<PlanActionResult>;
  /** Every shop the game files place on a map, with the clerk's cell and goods. */
  shops(): Promise<readonly PlanShop[]>;
  /** Walk to the clerk, face them and press confirm until the shop menu is open. */
  openShop(cell: Cell): Promise<PlanActionResult>;
  /** Back out of the shop menu to the map. */
  leaveShop(): Promise<PlanActionResult>;
  buy(item: string, count: number): Promise<PlanBuyResult>;
  setRow(member: string, row: "front" | "back"): Promise<PlanActionResult>;

  /**
   * Task 141: a boss station's target cell. A story trigger (`sc_e_`/`ev_e_`) is stepped on;
   * anything else (a boss entity, an NPC, a collision object) is faced from a side.
   */
  bossTarget(cell: Cell, bossName: string): Promise<"trigger" | "object">;
  /** Task 141: whether a battle is up now, so a confirm that opened nothing can retry a side. */
  battleActive(): Promise<boolean>;
  /** Task 145: battle/story state at a station boundary; absent in older tests. */
  scene?(): Promise<PlanScene>;
  /** Task 152: inns and recovery points on every map, for the low-HP fallback. */
  restorePoints?(): Promise<readonly PlanRestorePoint[]>;
  /** Task 152 follow-up: sleep at an inn / use a restore point already reached. */
  restAt?(point: PlanRestorePoint): Promise<PlanActionResult>;
  /**
   * Task 156: fallback boss trigger cells when the boss station writes only a map. Knowledge
   * events/NPCs whose name contains the boss's Japanese name come first, then live
   * script/battle entities on that map; `hint` is the station/guide text for distance.
   */
  bossTriggerCandidates?(map: number, boss: PlanBoss, hint: string): Promise<readonly Cell[]>;
  /** Task 145: the exit/entrance at one cell, if the target is one. */
  exitTarget?(map: number, cell: Cell): Promise<PlanExitTarget | null>;
  /** Task 145 follow-up: whether the target map exists in any map record. */
  mapKnown?(map: number): Promise<boolean>;
  /** Task 145 follow-up 3: whether the target cell is a story/event trigger. */
  eventAt?(map: number, cell: Cell): Promise<boolean>;
  /** Task 145 follow-up 5 / task 161: the map's story triggers, with the station hint. */
  storyTrigger?(map: number, hint?: string): Promise<PlanStoryTrigger>;
  /** Task 162: one safe step in a direction inside the current connected block. */
  exploreStoryStep?(map: number, direction: string): Promise<PlanExploreStep>;
  /** Task 145 follow-up 7: the open dialog choice's option labels, for the exception text. */
  choiceOptions?(): Promise<readonly string[]>;
  /** Task 145 follow-up 7: where the owned vehicles are, for a world-map route failure. */
  vehicleStatus?(): Promise<string>;
  /** Task 145 follow-up 8: restore/save point object at a cell (not a walkable floor). */
  pointAt?(map: number, cell: Cell): Promise<"restore" | "save" | null>;
  /** Task 159: known save-point cells on one map, for a failed save station's fallback. */
  savePoints?(map: number): Promise<readonly Cell[]>;
  /** Task 145 follow-up 8: stand beside a point object, press it, and verify its effect. */
  usePoint?(cell: Cell, kind: "restore" | "save"): Promise<PlanStationResult>;
  /** Task 149 follow-up: re-read the live collision after a switch/story or a failed block
   *  plan; returns the activity-log line when it refreshed, null when it skipped/failed. */
  refreshCollision?(mapId: number): Promise<string | null>;
  /** Task 145 follow-up 3: whether this chest's save flag already says it was opened. */
  chestAlreadyOpen?(map: number, cell: Cell): Promise<boolean>;
  /** Task 145: other names a plan boss is known by (Japanese/English/Chinese). */
  bossAliases?(name: string): Promise<readonly string[]>;

  /** The existing route executor's walking, story and watch ports. */
  routePorts(): RoutePorts;
  /** Analyze a route from where the party is; the station is the only waypoint. */
  planRoute(
    from: { readonly map: number; readonly cell: Cell },
    waypoints: readonly Waypoint[],
    end: Waypoint | null,
  ): Promise<RoutePlan>;
  /** Walk beside a chest/NPC and press it; the port pages ordinary dialog itself. */
  interact(cell: Cell): Promise<PlanStationResult>;
  /** Page the story/dialog that stopped a walk once more. */
  story(): Promise<{ readonly text: string; readonly decision?: string }>;
  choose(option: number | string, cell?: Cell): Promise<PlanActionResult>;
  save(): Promise<PlanActionResult>;
  /** Field recovery: revive, heal, cure and use a tent where allowed. `belowPct` is the
   *  chapter's threshold, so the port knows when a healing item is worth spending. */
  heal(belowPct?: number): Promise<PlanActionResult>;
  grind(stop: Waypoint): Promise<PlanStationResult>;

  beginBattles(battles: readonly PlanBattle[]): Promise<void>;
  endBattles(): Promise<void>;
  fightBoss(boss: PlanBoss): Promise<PlanBossResult>;
  /** Task 145: a normal battle met at the end of a station, using the plan's normal tables. */
  fightNormal?(tables: readonly Json[]): Promise<PlanBossResult>;
  /** Game-over popup handling (the existing 20 号位 route). */
  recoverGameover(): Promise<PlanActionResult>;
  battleCount(): number;

  /** Task 145: what the plan left incomplete on maps it passed, for the report. */
  leaveNotes?(): Promise<readonly string[]>;
  /** Task 145 follow-up: model calls made while the plan ran (0 in plan mode). */
  modelCalls?(): number;

  startProgress(section: string, goal: string, labels: readonly string[]): Promise<void>;
  markProgress(index: number, status: PlanProgressStatus, note: string): Promise<void>;
  finishProgress(status?: "done" | "exception" | "aborted"): Promise<void>;
}

export interface ExecutePlanOptions {
  readonly signal?: AbortSignal;
  readonly timeBudgetMs?: number;
  readonly stationBudgetMs?: number;
  /** One line per notable decision; the CLI prints it, tests may collect it. */
  readonly log?: (line: string) => void;
  /** Task 152: the chapter owns begin/end, so a segment must not restore the model layers. */
  readonly manageLayers?: boolean;
  /** Task 152: start at this station (a chapter fallback retries from the failed one). */
  readonly startAt?: number;
  /** Task 152: these stations are skipped and recorded; used by the chapter's optional skip. */
  readonly skipStations?: readonly number[];
  /** Task 152 follow-up: bosses already won earlier in this chapter; skip their boss station. */
  readonly alreadyWonBosses?: readonly string[];
  /** Task 152: run after every station, so the chapter can heal before the next one. A returned
   *  Chinese line stops the segment with `stuck`; null continues. */
  readonly checkpoint?: (
    observation: PlanObservation | null,
    next: number,
  ) => Promise<string | null>;
  /** Task 152: mirror each station status into the chapter progress file. */
  readonly onProgress?: (event: ExecuteProgressEvent) => Promise<void> | void;
  /** Task 162: the chapter progress's real status/note for a retry-prefix station. */
  readonly stationProgress?: (
    index: number,
  ) => { readonly status: PlanProgressStatus; readonly note: string } | undefined;
  /** Task 156: fill a boss pre-fight heal to this HP%; the game passes Config's value. */
  readonly healFullPercent?: number;
  /** Task 162: how long a story station may explore for a trigger; Config's value. */
  readonly storyExploreBudgetMs?: number;
  /** Task 156: boss trigger cells from the chapter facts (task 146), tried before the ports. */
  readonly bossTriggers?: (boss: PlanBoss, map: number) => readonly Cell[];
  /** Task 158: structured run log; absent means execute without writing one. */
  readonly runLog?: RunLogSink;
  /** Task 158: false when the chapter owns run.start/run.end (it passes the same sink down). */
  readonly runLifecycle?: boolean;
  /** Task 158: chapter number for the structured log (null for a standalone segment). */
  readonly chapter?: number;
  /** Task 158: segment index for the structured log. */
  readonly segmentIndex?: number;
}

/** One station status the segment executor reports to the chapter progress writer. */
export interface ExecuteProgressEvent {
  readonly section: string;
  readonly index: number;
  readonly status: PlanProgressStatus;
  readonly note: string;
}

/** One parsed `turnBack.when`; `null` means the syntax is not understood here. */
export interface TurnBackState {
  /** Lowest HP share in the party, 0–100. */
  readonly lowestHpPct: number;
  /** Total MP share, 0–100. */
  readonly mpPct: number;
  readonly dead: number;
  readonly items: Readonly<Record<string, number>>;
}

const TURN_BACK =
  /^\s*(?:party\.(lowest_hp_pct|mp_pct|dead)|item\.(.+?))\s*(<=|>=|==|<|>)\s*(\d+(?:\.\d+)?)\s*$/u;

/**
 * Parse and test the small turn-back syntax shared with task 137:
 * `party.lowest_hp_pct < 30`, `party.dead >= 2`, `party.mp_pct < 20`, `item.不死鸟之尾 < 1`.
 * A condition this parser does not know returns null instead of silently firing or not firing.
 */
export function evaluateTurnBack(when: string, state: TurnBackState): boolean | null {
  const match = TURN_BACK.exec(when);
  if (match === null) return null;
  const partyField = match[1];
  const item = match[2];
  const operator = match[3];
  const threshold = Number(match[4]);
  if (!Number.isFinite(threshold)) return null;
  let value: number;
  if (partyField === "lowest_hp_pct") value = state.lowestHpPct;
  else if (partyField === "mp_pct") value = state.mpPct;
  else if (partyField === "dead") value = state.dead;
  else if (item !== undefined) value = itemCount(state.items, item);
  else return null;
  if (operator === "<") return value < threshold;
  if (operator === "<=") return value <= threshold;
  if (operator === ">") return value > threshold;
  if (operator === ">=") return value >= threshold;
  return value === threshold;
}

/** Bag names may carry icon markup; an exact name wins, then a containing name. */
function itemCount(items: Readonly<Record<string, number>>, name: string): number {
  const wanted = name.trim();
  const exact = items[wanted];
  if (exact !== undefined) return exact;
  let total = 0;
  for (const [held, count] of Object.entries(items)) {
    if (held.includes(wanted) || wanted.includes(held)) total += count;
  }
  return total;
}

/** The turn-back state for the report's parser, from one observation. */
export function turnBackStateOf(observation: PlanObservation): TurnBackState {
  const members = observation.members;
  let lowestHpPct = 100;
  let mp = 0;
  let maxMp = 0;
  let dead = 0;
  for (const member of members) {
    if (member.hp <= 0) dead += 1;
    const share = member.maxHp > 0 ? (100 * member.hp) / member.maxHp : 100;
    if (share < lowestHpPct) lowestHpPct = share;
    mp += member.mp;
    maxMp += member.maxMp;
  }
  // No readable party must not look like a wipe.
  if (members.length === 0) {
    mp = 1;
    maxMp = 1;
  }
  return {
    lowestHpPct,
    mpPct: maxMp > 0 ? (100 * mp) / maxMp : 100,
    dead,
    items: observation.items,
  };
}

const ACTION_LABELS: Readonly<Record<PlanStationAction, string>> = {
  move: "移动",
  open: "开宝箱",
  save: "存档",
  heal: "回复",
  talk: "对话",
  switch: "机关",
  story: "剧情",
  choose: "选项",
  grind: "刷怪",
  boss: "首领",
  buy: "买东西",
};

const KIND_OF_ACTION: Readonly<Record<PlanStationAction, WaypointKind>> = {
  move: "move",
  open: "chest",
  save: "save",
  heal: "inn",
  talk: "story",
  switch: "story",
  story: "story",
  choose: "story",
  grind: "grind",
  boss: "boss",
  buy: "shop",
};

function parseTarget(to: string): { readonly map: number; readonly cell: Cell | null } | null {
  const match = /^(?:地图\s*)?(\d+)(?:\s*:\s*(.+))?$/u.exec(to.trim());
  if (match === null) return null;
  const map = Number(match[1]);
  if (!Number.isInteger(map) || map <= 0) return null;
  const raw = match[2]?.trim();
  if (raw === undefined || raw === "") return { map, cell: null };
  const cell = targetCell(raw);
  return cell === null ? null : { map, cell };
}

/** Task 162: direction words, longest first so 东北 is not read as 东. */
const STORY_DIRECTIONS = ["东北", "西北", "东南", "西南", "北", "南", "东", "西"] as const;

function storyDirectionsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/东北|西北|东南|西南|北|南|东|西/gu)) found.add(match[0]);
  return STORY_DIRECTIONS.filter((direction) => found.has(direction));
}

function directionToward(from: Cell, to: Cell): string | null {
  const dx = Math.sign(to[0] - from[0]);
  const dy = Math.sign(to[1] - from[1]);
  if (dx === 0 && dy === 0) return null;
  if (dx > 0 && dy < 0) return "东北";
  if (dx < 0 && dy < 0) return "西北";
  if (dx > 0 && dy > 0) return "东南";
  if (dx < 0 && dy > 0) return "西南";
  if (dy < 0) return "北";
  if (dy > 0) return "南";
  return dx > 0 ? "东" : "西";
}

/** Task 161: the scene number in `sc_e_0013:ガラフ` / `ev_e_0004`. */
function storyScriptNumber(name: string): number | null {
  const match = /(?:sc_e_|ev_e_)(\d+)/iu.exec(name);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

/** `open`/`talk` walk beside the target; story cells and a move must be stepped on. */
function reachOf(action: PlanStationAction, cell: Cell | null): "cell" | "map" {
  if (cell === null) return "map";
  if (action === "open" || action === "talk" || action === "switch" || action === "grind") {
    return "map";
  }
  return "cell";
}

/**
 * Task 141: where to stand for a boss that cannot be stepped on. The cell directly below the
 * boss (facing Up) comes first; the guide's "interact with the boss by the stairs" uses it.
 */
const BOSS_SIDES: readonly {
  readonly dx: number;
  readonly dy: number;
  readonly direction: string;
}[] = [
  { dx: 0, dy: 1, direction: "Up" },
  { dx: 0, dy: -1, direction: "Down" },
  { dx: 1, dy: 0, direction: "Left" },
  { dx: -1, dy: 0, direction: "Right" },
];

interface BossSide {
  readonly cell: Cell;
  readonly direction: string;
}

function bossSides(target: Cell): BossSide[] {
  return BOSS_SIDES.map((side) => ({
    cell: [target[0] + side.dx, target[1] + side.dy] as Cell,
    direction: side.direction,
  }));
}

/** Task 156: a cell written in the station/boss text, for ordering live entity candidates. */
function hintCell(hint: string): Cell | null {
  const match = /(?:地图\s*)?(\d+)\s*[:：]\s*(\d+)\s*,\s*(\d+)/u.exec(hint);
  if (match === null) return null;
  return [Number(match[2]), Number(match[3])];
}

/** Keep fact triggers on this map; a coordinate in the description picks the nearest first. */
function orderTriggerCells(cells: readonly Cell[], hint: string): Cell[] {
  const anchor = hintCell(hint);
  const unique: Cell[] = [];
  for (const cell of cells) {
    if (!unique.some((entry) => entry[0] === cell[0] && entry[1] === cell[1])) unique.push(cell);
  }
  if (anchor === null) return unique;
  return [...unique].sort(
    (left, right) =>
      Math.abs(left[0] - anchor[0]) +
      Math.abs(left[1] - anchor[1]) -
      (Math.abs(right[0] - anchor[0]) + Math.abs(right[1] - anchor[1])),
  );
}

function cellText(cell: Cell | null): string {
  return cell === null ? "位置不明" : `(${cell[0]},${cell[1]})`;
}

function sameCell(left: Cell | null, right: Cell | null): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1];
}

function itemKey(value: string): string {
  return normalizeName(cleanName(value));
}

/** A plan may name a product in any language, with or without `<IC_...>` tags. */
function shopSells(shop: PlanShop, item: string): boolean {
  const wanted = itemKey(item);
  if (wanted === "") return false;
  for (const product of shop.products) {
    for (const name of [product.name, ...(product.names ?? [])]) {
      const key = itemKey(name);
      if (key !== "" && (key === wanted || key.includes(wanted) || wanted.includes(key))) {
        return true;
      }
    }
  }
  return false;
}

function shopKey(shop: PlanShop): string {
  return `${shop.id ?? "?"}@${shop.map}:${shop.cell[0]},${shop.cell[1]}`;
}

function shopLabel(shop: PlanShop): string {
  const kind = shop.kind.trim();
  return kind === "" ? shop.area : `${shop.area}${kind}`;
}

function waypointOf(station: PlanStation, index: number): Waypoint | null {
  const target = parseTarget(station.to);
  if (target === null) return null;
  return {
    id: `plan-${index}`,
    kind: KIND_OF_ACTION[station.do],
    map: target.map,
    cell: target.cell,
    label: `第 ${index + 1} 站 ${ACTION_LABELS[station.do]}`,
    reach: reachOf(station.do, target.cell),
    optional: station.optional === true,
    ...(station.until === undefined ? {} : { until: station.until }),
  };
}

/** The `boss-lost` summary: what was fought and the last few actions. */
function bossSummary(result: PlanBossResult): string {
  return result.summary.trim() === "" ? result.text : result.summary;
}

/**
 * Match one boss station to the plan's boss entry: the station text naming it wins, then the
 * map it is on, then the plan's only boss. A plan with several bosses on one map must name it.
 */
function bossForStation(
  plan: SegmentPlan,
  station: PlanStation,
  targetMap: number | null,
): PlanBoss | undefined {
  const label = `${station.to} ${station.why ?? ""}`;
  const named = plan.bosses.find((entry) => entry.name !== "" && label.includes(entry.name));
  if (named !== undefined) return named;
  if (targetMap !== null) {
    const onMap = plan.bosses.find((entry) => entry.map === targetMap);
    if (onMap !== undefined) return onMap;
  }
  return plan.bosses.length === 1 ? plan.bosses[0] : undefined;
}

/** Normal-battle tables in plan order; an empty list lets the game use its default table. */
function normalTables(plan: SegmentPlan): Json[] {
  return plan.battle.flatMap((battle) => [...battle.tables]);
}

/** Task 156 follow-up: small kana and their full-size forms are the same name. */
const SMALL_KANA: Readonly<Record<string, string>> = {
  ぁ: "あ",
  ぃ: "い",
  ぅ: "う",
  ぇ: "え",
  ぉ: "お",
  っ: "つ",
  ゃ: "や",
  ゅ: "ゆ",
  ょ: "よ",
  ゎ: "わ",
  ゕ: "か",
  ゖ: "け",
  ァ: "ア",
  ィ: "イ",
  ゥ: "ウ",
  ェ: "エ",
  ォ: "オ",
  ッ: "ツ",
  ャ: "ヤ",
  ュ: "ユ",
  ョ: "ヨ",
  ヮ: "ワ",
  ヵ: "カ",
  ヶ: "ケ",
};

/**
 * Task 156 follow-up: a boss name key that ignores small/large kana, the long-vowel mark and
 * the middle dot, besides the usual case/punctuation cleaning. 10-29 live: the object
 * "ウィングラプター" must equal "ウイングラプター".
 */
export function bossNameKey(value: string): string {
  return normalizeName(cleanName(value))
    .replace(
      /[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ]/gu,
      (kana) => SMALL_KANA[kana] ?? kana,
    )
    .replace(/[ー・･·]/gu, "");
}

/**
 * Task 145: plan boss names may be Chinese, Japanese or English. Compare cleaned names both
 * ways; a plan that writes "首领 龙虾" still matches an enemy called "龙虾".
 */
function bossNameMatches(planName: string, enemyName: string): boolean {
  const left = bossNameKey(planName);
  const right = bossNameKey(enemyName);
  if (left === "" || right === "") return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** The plan's boss entry for a battle scene, or undefined when the plan did not name it. */
async function bossForScene(
  plan: SegmentPlan,
  ports: ExecutePorts,
  scene: PlanScene,
  map: number | null,
): Promise<PlanBoss | undefined> {
  for (const boss of plan.bosses) {
    const names = [boss.name, ...((await ports.bossAliases?.(boss.name)) ?? [])];
    if (names.some((name) => scene.enemies.some((enemy) => bossNameMatches(name, enemy)))) {
      return boss;
    }
  }
  // The bridge says boss but no enemy name matched: a plan with exactly one boss on this map
  // is still that boss (a plan with several must name it).
  if (!scene.boss) return undefined;
  const onMap = plan.bosses.filter((boss) => boss.map === map || boss.map === null);
  return onMap.length === 1 ? onMap[0] : undefined;
}

function exitNote(exit: PlanExitTarget): string {
  return `走进入口到了地图 ${exit.toMap}${exit.name === "" ? "" : `「${exit.name}」`}`;
}

function storyScene(scene: PlanScene): boolean {
  return (
    scene.dialog ||
    scene.state === "Event" ||
    scene.state === "Dialog" ||
    scene.state === "FieldHelp"
  );
}

function sceneText(scene: PlanScene): string {
  if (scene.battle) {
    const names = scene.enemies.length === 0 ? "敌人读不到" : `敌人:${scene.enemies.join("、")}`;
    return `战斗里(${names})`;
  }
  if (
    scene.dialog ||
    scene.state === "Event" ||
    scene.state === "Dialog" ||
    scene.state === "FieldHelp"
  ) {
    return `剧情/对话里(状态 ${scene.state ?? "读不到"})`;
  }
  return `能操作(状态 ${scene.state ?? "读不到"})`;
}

/** The dsh layer sometimes throws a plain object; never show `[object Object]` in the log. */
function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (isRecord(error) && typeof error.name === "string") return error.name;
  return "";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "未知错误";
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "";
    const name = typeof error.name === "string" ? error.name : "";
    if (message !== "" || name !== "") return message || name;
    try {
      return JSON.stringify(error);
    } catch {
      return "未知错误";
    }
  }
  return String(error);
}

function roundedMinutes(started: number): number {
  return Math.round(((Date.now() - started) / 60_000) * 10) / 10;
}

function partySignature(observation: PlanObservation | null): string | null {
  if (observation === null) return null;
  return observation.members.map((member) => member.name).join("|");
}

function partyLine(observation: PlanObservation | null): string {
  if (observation === null || observation.members.length === 0) return "队伍读不到";
  const members = observation.members
    .map(
      (member) =>
        `${member.name} Lv${member.lv ?? "?"} HP ${member.hp}/${member.maxHp} ` +
        `MP ${member.mp}/${member.maxMp}`,
    )
    .join("；");
  const ailments = [
    ...new Set(
      observation.members.flatMap((member) => member.status).filter((line) => line !== ""),
    ),
  ];
  const where =
    observation.map === null
      ? "位置读不到"
      : `地图 ${observation.map}${observation.cell === null ? "" : ` (${observation.cell[0]},${observation.cell[1]})`}`;
  return (
    `${where}；${members}` +
    (ailments.length === 0 ? "" : `；状态:${ailments.join("、")}`) +
    `；图鉴 ${observation.bestiary.length} 条，青魔法 ${observation.blueMagic.length} 种`
  );
}

interface ChoiceAnswer {
  readonly text: string;
  /** The station whose `choose` was used, or null when the plan has no answer. */
  readonly station: number | null;
}

function choiceOption(station: PlanStation): number | string {
  return station.choose ?? 0;
}

/**
 * Run the plan. A required station that cannot be walked to is `unreachable`; an unanswered
 * dialog choice is `story-choice`; a boss that does not fall is `boss-lost`; the game-over
 * popup (after a wipe) is `gameover` and is recovered through the existing slot-20 route.
 */
export async function executeSegmentPlan(
  plan: SegmentPlan,
  ports: ExecutePorts,
  options: ExecutePlanOptions = {},
): Promise<SegmentReport> {
  const started = Date.now();
  const log = options.log ?? ((): void => undefined);
  const signal = options.signal;
  const runLifecycle = options.runLifecycle !== false;
  let fallbackCount = 0;
  const emitRun = (event: RunEventInput): void => {
    options.runLog?.record({
      chapter: options.chapter ?? null,
      segment: options.segmentIndex ?? 0,
      section: plan.section,
      station: null,
      ...event,
    });
  };
  const deadline = started + (options.timeBudgetMs ?? DEFAULT_SEGMENT_BUDGET_MS);
  const stationBudget = options.stationBudgetMs ?? DEFAULT_STATION_BUDGET_MS;
  const done = new Set<number>();
  /** Task 159: a save station that could not save and has no known point is skipped. */
  const actionSkips = new Map<number, string>();
  const consumedChoices = new Set<number>();
  const healAttempts = new Map<string, number>();
  const attempt = new Map<number, number>();
  /** Task 141: a boss station's heal/save prep runs once, even when the walk is retried. */
  const bossPrepared = new Set<number>();
  const bossKinds = new Map<number, "trigger" | "object">();
  const bossEntries = new Map<number, PlanBoss>();
  let before: PlanObservation | null = null;
  let last: PlanObservation | null = null;
  let battlesBefore = 0;
  let bossFights = 0;
  const bossesWon: string[] = [];
  /** Task 145: notes that belong in the report's party paragraph (unlisted boss, leave debt). */
  const reportNotes: string[] = [];
  let current: number | null = null;
  const emitFallback = (kind: string, reason: string, station: number | null = current): void => {
    fallbackCount += 1;
    emitRun({ type: "fallback", kind, reason, station });
  };
  /** Task 145 follow-up 3: story seen during the station, and where a script moved the party. */
  const scriptMarks = new Set<string>();
  const scriptMovedAt = new Map<string, { readonly map: number; readonly cell: Cell }>();
  const stationEvidence = new Set<string>();
  let exception:
    | {
        readonly kind: PlanExceptionKind;
        readonly map: number | null;
        readonly cell: readonly [number, number] | null;
        readonly station: number | null;
        readonly detail: string;
      }
    | undefined;
  let aborted = false;
  const prepNotes: string[] = [];
  let battlesStarted = false;
  const purchases: {
    readonly item: string;
    readonly count: number;
    remaining: number;
  }[] = plan.prep.buy.map((purchase) => ({
    item: purchase.item,
    count: purchase.count,
    remaining: purchase.count,
  }));
  const visitedShops = new Set<string>();
  const blockedItems = new Set<string>();
  let shopIndex: readonly PlanShop[] = [];
  let shopIndexReady = false;
  let outOfMoney = false;
  const note = (line: string): void => {
    prepNotes.push(line);
    log(line);
  };
  const pendingPurchases = (): typeof purchases =>
    purchases.filter(
      (purchase) => purchase.remaining > 0 && !blockedItems.has(purchase.item) && !outOfMoney,
    );
  const openAndBuy = async (shop: PlanShop): Promise<void> => {
    const items = pendingPurchases().filter((purchase) => shopSells(shop, purchase.item));
    if (items.length === 0) return;
    visitedShops.add(shopKey(shop));
    const here = await ports.position();
    if (here === null) {
      note(`没法去${shopLabel(shop)}:读不到当前位置`);
      return;
    }
    if (here.map !== shop.map) {
      const waypoint: Waypoint = {
        id: `shop-${shopKey(shop)}`,
        kind: "move",
        map: shop.map,
        cell: null,
        label: `${shopLabel(shop)}的店员`,
        reach: "map",
      };
      const routePlan = await ports.planRoute(here, [waypoint], null);
      if (!routePlan.legs.some((leg) => leg.waypoint === waypoint.id)) {
        note(
          `走不到卖「${items.map((purchase) => purchase.item).join("、")}」的${shopLabel(shop)}`,
        );
        return;
      }
      const budget = Math.max(0, Math.min(deadline - Date.now(), stationBudget));
      const walked = await executeRoute(routePlan, ports.routePorts(), {
        signal,
        timeBudgetMs: budget,
        maxWaypointFailures: 2,
        waypoints: [waypoint],
      });
      if (walked.reason !== "completed") {
        note(`去${shopLabel(shop)}没走到:${walked.message}`);
        return;
      }
    }
    let opened: PlanActionResult;
    try {
      opened = await ports.openShop(shop.cell);
    } catch (error) {
      note(`在${shopLabel(shop)}开商店出错:${String(error)}`);
      return;
    }
    if (!opened.ok) {
      note(`在${shopLabel(shop)}没打开商店:${opened.text}`);
      return;
    }
    const bought: string[] = [];
    for (const purchase of items) {
      if (outOfMoney || blockedItems.has(purchase.item)) break;
      let result: PlanBuyResult;
      try {
        result = await ports.buy(purchase.item, purchase.remaining);
      } catch (error) {
        blockedItems.add(purchase.item);
        note(
          `没买成：${purchase.item}×${purchase.remaining}（${shopLabel(shop)}）:${String(error)}`,
        );
        continue;
      }
      emitRun({
        type: "buy",
        map: shop.map,
        item: purchase.item,
        count: purchase.remaining,
        bought: result.bought,
        reason: result.ok ? undefined : result.text,
        note: shopLabel(shop),
      });
      if (result.ok) {
        bought.push(`${purchase.item}×${purchase.remaining}`);
        purchase.remaining = 0;
        continue;
      }
      if (/钱不够|金钱没有变化/u.test(result.text)) {
        outOfMoney = true;
        note(`钱不够没买：${purchase.item}×${purchase.remaining}:${result.text}`);
        break;
      }
      blockedItems.add(purchase.item);
      note(`没买成：${purchase.item}×${purchase.remaining}（${shopLabel(shop)}）:${result.text}`);
    }
    if (bought.length > 0) note(`在${shopLabel(shop)}买了:${bought.join("、")}`);
    try {
      const left = await ports.leaveShop();
      if (!left.ok) log(`离开${shopLabel(shop)}的商店菜单:${left.text}`);
    } catch (error) {
      log(`离开${shopLabel(shop)}的商店菜单出错:${String(error)}`);
    }
  };
  const shopsOnRoute = (maps: readonly number[]): PlanShop[] => {
    const out: PlanShop[] = [];
    if (outOfMoney) return out;
    for (const map of maps) {
      for (const shop of shopIndex) {
        if (shop.map !== map || visitedShops.has(shopKey(shop))) continue;
        if (!pendingPurchases().some((purchase) => shopSells(shop, purchase.item))) continue;
        if (!out.some((entry) => shopKey(entry) === shopKey(shop))) out.push(shop);
      }
    }
    return out;
  };
  const logRemainingPurchases = (): void => {
    if (!shopIndexReady) return;
    for (const purchase of purchases) {
      if (purchase.remaining <= 0 || blockedItems.has(purchase.item) || outOfMoney) continue;
      const sellers = shopIndex.filter((shop) => shopSells(shop, purchase.item));
      if (sellers.length === 0) {
        note(`这段路上没有店卖：${purchase.item}×${purchase.remaining}`);
      } else {
        const where = sellers
          .slice(0, 3)
          .map((shop) => shopLabel(shop))
          .join("、");
        note(`没走到卖「${purchase.item}」的店：${where}`);
      }
    }
  };

  const labels = plan.stations.map(
    (station, index) => `第 ${index + 1} 站 ${ACTION_LABELS[station.do]} ${station.to}`,
  );
  const tagOf = (index: number): string => `第 ${index + 1}/${plan.stations.length} 站`;

  const positionOf = (index: number | null): { map: number | null; cell: Cell | null } => {
    if (last !== null) return { map: last.map, cell: last.cell };
    if (index === null) return { map: null, cell: null };
    const target = parseTarget(plan.stations[index]?.to ?? "");
    return { map: target?.map ?? null, cell: target?.cell ?? null };
  };

  /** TypeScript does not follow assignments made inside `refresh`; this keeps them visible. */
  const seen = (): PlanObservation | null => last;

  const failed = (): boolean => exception !== undefined;

  const fail = (
    kind: PlanExceptionKind,
    detail: string,
    station: number | null = current,
  ): void => {
    const at = positionOf(station);
    exception = {
      kind,
      map: at.map,
      cell: at.cell === null ? null : [at.cell[0], at.cell[1]],
      station,
      detail,
    };
    const where = at.map === null ? "" : ` 地图 ${at.map} ${cellText(at.cell)}`;
    log(`例外(${kind})${where}:${detail}`);
  };

  const partyLevels = new Map<string, number>();
  const noteLevels = (observation: PlanObservation | null): void => {
    if (observation === null) return;
    for (const member of observation.members) {
      if (member.lv === null) continue;
      const from = partyLevels.get(member.name);
      if (from !== undefined && member.lv > from) {
        emitRun({
          type: "level",
          member: member.name,
          fromLevel: from,
          toLevel: member.lv,
        });
      }
      partyLevels.set(member.name, member.lv);
    }
  };
  const refresh = async (deep = false): Promise<void> => {
    try {
      last = await ports.observe(deep);
      noteLevels(last);
    } catch (error) {
      log(`读不到队伍状态:${String(error)}`);
      emitRun({
        type: "warn",
        reason: `读不到队伍状态:${String(error)}`,
        station: current,
      });
    }
  };

  /** Task 158: record the lowest party HP% around a heal; the extra read is log-only. */
  const lowestHp = (observation: PlanObservation | null): number | null => {
    if (observation === null || observation.members.length === 0) return null;
    let lowest = 100;
    for (const member of observation.members) {
      const share = member.maxHp > 0 ? (100 * member.hp) / member.maxHp : 100;
      if (share < lowest) lowest = share;
    }
    return lowest;
  };
  const healLogged = async (
    belowPct: number | undefined,
    why: string,
  ): Promise<PlanActionResult> => {
    const before = lowestHp(last);
    const result = await ports.heal(belowPct);
    await refresh();
    emitRun({
      type: "heal",
      beforeHp: before,
      afterHp: lowestHp(last),
      used: result.text,
      note: why,
      station: current,
    });
    return result;
  };

  /** Task 149 follow-up: at most one live collision refresh per map in this execution. */
  const refreshedCollisionMaps = new Set<number>();
  const refreshCollisionAt = async (mapId: number): Promise<boolean> => {
    if (ports.refreshCollision === undefined || refreshedCollisionMaps.has(mapId)) return false;
    refreshedCollisionMaps.add(mapId);
    try {
      const line = await ports.refreshCollision(mapId);
      if (line !== null) log(line);
      return line !== null;
    } catch (error) {
      log(`刷新地图 ${mapId} 的实时碰撞失败：${String(error)}`);
      return false;
    }
  };

  const stationStarts = new Map<number, number>();
  const stationAttempts = new Map<number, number>();
  const mark = async (index: number, status: PlanProgressStatus, note: string): Promise<void> => {
    const station = plan.stations[index];
    const target = station === undefined ? null : parseTarget(station.to);
    const at = {
      map: target?.map ?? null,
      cell: target?.cell ?? null,
    };
    if (status === "current") {
      const attemptNumber = (stationAttempts.get(index) ?? 0) + 1;
      stationAttempts.set(index, attemptNumber);
      stationStarts.set(index, Date.now());
      emitRun({
        type: "station.start",
        station: index,
        do: station?.do,
        to: station?.to,
        ...at,
        attempt: attemptNumber,
      });
    } else if (status === "done" || status === "skipped" || status === "failed") {
      // Task 162: a retry prefix re-marks every earlier station done. The chapter knows which
      // of them were really skipped; the structured log must say skipped, not done.
      const reported =
        status === "done" && note === "重试前已完成"
          ? options.stationProgress?.(index)
          : undefined;
      const reportedStatus = reported?.status ?? status;
      const reportedNote = reported?.note ?? note;
      const result =
        reportedStatus === "done"
          ? "done"
          : reportedStatus === "skipped"
            ? "skipped"
            : reportedStatus === "handoff"
              ? "failed"
              : reportedStatus === "failed"
                ? "failed"
                : reportedStatus === "pending" || reportedStatus === "current"
                  ? "blocked"
                  : "failed";
      const startedAt = stationStarts.get(index);
      const evidence = startedAt === undefined ? [] : [...stationEvidence];
      emitRun({
        type: "station.end",
        station: index,
        do: station?.do,
        to: station?.to,
        ...at,
        result,
        evidence,
        note: reportedNote,
        reason: reportedNote,
        ms: startedAt === undefined ? null : Math.max(0, Date.now() - startedAt),
        attempt: stationAttempts.get(index) ?? 0,
      });
      if (station?.do === "open") {
        emitRun({
          type: "chest",
          station: index,
          map: at.map,
          cell: at.cell,
          item: station.why ?? station.to,
          opened: reportedStatus === "done" && reportedNote.trim() !== "已开过",
          result,
          reason: reportedStatus === "done" ? undefined : reportedNote,
          note: reportedNote,
        });
      }
    }
    try {
      await ports.markProgress(index, status, note);
    } catch (error) {
      log(`进度没写成:${String(error)}`);
      emitRun({
        type: "warn",
        reason: `进度没写成:${String(error)}`,
        station: index,
      });
    }
    try {
      await options.onProgress?.({
        section: plan.section,
        index,
        status,
        note,
      });
    } catch (error) {
      log(`章节进度没写成:${String(error)}`);
    }
  };

  const complete = async (index: number, note: string): Promise<void> => {
    if (done.has(index)) return;
    done.add(index);
    await mark(index, "done", note);
  };

  const skip = async (index: number, note: string): Promise<void> => {
    if (done.has(index)) return;
    done.add(index);
    await mark(index, "skipped", note);
  };

  /** Use the plan's next `choose` station for a dialog choice that just opened. */
  const answerChoice = async (why: string): Promise<ChoiceAnswer | null> => {
    // Task 145 follow-up 7: only the current station's own choose may answer a dialog. An
    // option met on the road must never consume a later section's choose station.
    const chosen = current;
    if (chosen === null) return null;
    const station = plan.stations[chosen];
    if (station?.do !== "choose" || consumedChoices.has(chosen)) return null;
    const target = parseTarget(station.to);
    const here = await ports.position();
    if (target === null) return null;
    if (here === null) return null;
    if (target.map !== here.map) return null;
    const result = await ports.choose(choiceOption(station));
    if (!result.ok) {
      log(`计划里的选项没选成:${result.text}`);
      return null;
    }
    consumedChoices.add(chosen);
    scriptMarks.add("story");
    const paged = await ports.story();
    const text = [why, result.text, paged.text].filter((line) => line !== "").join("\n");
    return { text, station: chosen };
  };

  /** Task 145 follow-up 7: include the actual option labels in a story-choice exception. */
  const choiceProblem = async (message: string): Promise<string> => {
    try {
      const options = (await ports.choiceOptions?.()) ?? [];
      return options.length === 0 ? message : `${message}(选项:${options.join("/")})`;
    } catch {
      return message;
    }
  };

  /** Task 145 follow-up 7: vehicle positions/state for a world-map route failure. */
  const vehicleText = async (): Promise<string> => {
    try {
      const text = (await ports.vehicleStatus?.()) ?? "";
      return text.trim() === "" ? "" : `；交通工具:${text}`;
    } catch {
      return "";
    }
  };

  /** Task 145: finish an ordinary battle at a station boundary with the plan's normal tables. */
  const fightNormal = async (): Promise<PlanBossResult> => {
    const tables = normalTables(plan);
    if (ports.fightNormal !== undefined) return await ports.fightNormal(tables);
    // Older test doubles only have fightBoss: pass the same normal table through it.
    return await ports.fightBoss({
      name: "普通战斗",
      map: last?.map ?? null,
      healFirst: false,
      saveFirst: false,
      tables,
    });
  };

  /** Task 145: fight whatever is on screen now; returns false when the run must stop. */
  const fightScene = async (index: number | null, scene: PlanScene): Promise<boolean> => {
    const tag = index === null ? "段末" : tagOf(index);
    const boss = await bossForScene(plan, ports, scene, last?.map ?? null);
    const isBoss = scene.boss || boss !== undefined;
    const enemyText = scene.enemies.length === 0 ? "敌人读不到" : scene.enemies.join("、");
    if (isBoss) {
      if (boss !== undefined) {
        bossFights += 1;
        log(`${tag} 战斗:首领「${boss.name}」(${enemyText})，用计划的首领表`);
      } else {
        // The ordinary-table fight is already counted by planFightNormal; only note the gap.
        const line = `计划里没有这个首领，用普通表打的(${enemyText})`;
        reportNotes.push(line);
        log(`${tag} 战斗:${line}`);
      }
    } else {
      log(`${tag} 战斗:普通战斗(${enemyText})`);
    }
    const fightStarted = Date.now();
    const result = isBoss && boss !== undefined ? await ports.fightBoss(boss) : await fightNormal();
    emitRun({
      type: "battle",
      kind: isBoss ? "boss" : "normal",
      enemies: isBoss && boss !== undefined ? [boss.name, ...scene.enemies] : scene.enemies,
      won: result.won,
      ms: Math.max(0, Date.now() - fightStarted),
      note: result.summary || result.text,
      station: index,
    });
    if (result.won) {
      if (isBoss) {
        const name = boss?.name ?? scene.enemies[0] ?? "首领";
        if (!bossesWon.includes(name)) bossesWon.push(name);
        log(`${tag} 战斗打赢:「${name}」`);
      } else {
        log(`${tag} 战斗打赢`);
      }
      return true;
    }
    const recovered = await ports.recoverGameover();
    if (recovered.ok) {
      fail("gameover", `${bossSummary(result)}；${recovered.text}`, index);
      return false;
    }
    if (isBoss) {
      fail("boss-lost", `首领「${boss?.name ?? enemyText}」没打赢:${bossSummary(result)}`, index);
    } else {
      fail("gameover", `普通战斗没打赢:${bossSummary(result)}；${recovered.text}`, index);
    }
    return false;
  };

  /**
   * Task 145: before a station or the whole segment is called finished, page story and fight
   * battles until the field is controllable. The budget is the station's own; a screen that
   * never settles is `stuck`, never a silent "done".
   */
  const settleScene = async (
    index: number | null,
    when: string,
    force = false,
  ): Promise<boolean> => {
    if (ports.scene === undefined) return true;
    const tag = index === null ? "段末" : tagOf(index);
    const limit = Date.now() + stationBudget;
    for (;;) {
      if (aborted || (!force && failed())) return false;
      if (Date.now() >= (force ? limit : Math.min(deadline, limit))) {
        let line = "场面读不到";
        try {
          const scene = await ports.scene();
          line = sceneText(scene);
        } catch {
          // The timeout message still says which boundary stopped.
        }
        fail("stuck", `${tag} ${when}场面没有稳定，超时停在${line}`, index);
        return false;
      }
      const scene = await ports.scene();
      if (scene.battle) {
        log(`${tag} ${when}:${sceneText(scene)}，先打完`);
        if (!(await fightScene(index, scene))) return false;
        continue;
      }
      if (storyScene(scene)) {
        log(`${tag} ${when}:${sceneText(scene)}，先翻页`);
        const advanced = await ports.story();
        if (advanced.decision !== undefined && advanced.decision.trim() !== "") {
          const answered = await answerChoice(advanced.decision);
          if (answered === null) {
            fail(
              "story-choice",
              await choiceProblem(`${tag} ${when}剧情选项计划没回答:${advanced.decision}`),
              index,
            );
            return false;
          }
        }
        continue;
      }
      return true;
    }
  };

  /** Task 145: settle the screen first, then record the station done with one Chinese line. */
  const completeStation = async (index: number, why: string): Promise<boolean> => {
    if (!(await settleScene(index, "站末"))) return false;
    const station = plan.stations[index];
    if (station !== undefined && (station.do === "switch" || station.do === "story")) {
      const here = await ports.position();
      const target = parseTarget(station.to);
      if (here !== null && (target === null || target.map === here.map)) {
        await refreshCollisionAt(here.map);
      }
    }
    const line = `${tagOf(index)} 完成:${why}`;
    await complete(index, line);
    log(line);
    return true;
  };

  /** Task 145: settle first as well; a skipped optional station is still skipped on purpose. */
  const skipStation = async (index: number, why: string): Promise<void> => {
    if (!(await settleScene(index, "站末"))) return;
    emitFallback("skip", why, index);
    const line = `${tagOf(index)} 跳过:${why}`;
    await skip(index, line);
    log(line);
  };

  /** Between stations and after a fight: fire the plan's turn-back conditions. */
  const turnBack = async (): Promise<boolean> => {
    if (plan.turnBack.length === 0) return false;
    await refresh();
    if (last === null) return false;
    const state = turnBackStateOf(last);
    for (const condition of plan.turnBack) {
      const hit = evaluateTurnBack(condition.when, state);
      if (hit === null) {
        log(`回头条件看不懂，跳过:${condition.when}`);
        emitRun({
          type: "warn",
          reason: `回头条件看不懂:${condition.when}`,
          station: current,
        });
        continue;
      }
      if (!hit) continue;
      if (condition.then === "replan") {
        fail("turn-back", `回头条件成立:${condition.when}；按计划交给模型重排`, current);
        return true;
      }
      const tries = healAttempts.get(condition.when) ?? 0;
      if (tries < 2) {
        healAttempts.set(condition.when, tries + 1);
        const full = options.healFullPercent ?? DEFAULT_BOSS_HEAL_PERCENT;
        emitFallback("heal", `回头条件成立:${condition.when}`, current);
        const healed = await healLogged(full, `回头条件:${condition.when}`);
        log(`回头条件成立:${condition.when}；按计划回复(${full}% 线)后继续:${healed.text}`);
      } else {
        log(`回头条件仍成立:${condition.when}；已经回复 ${tries} 次，继续按计划走`);
      }
    }
    return false;
  };

  /**
   * Task 152: a `buy` station. Walk to the shop's own counter on the station's map, open it,
   * buy `items` in order, and record what the gil could not cover. A shop that never opens is
   * a station failure (the chapter retries or skips it); running out of money is only a note.
   */
  const buyAtStation = async (index: number, station: PlanStation): Promise<PlanStationResult> => {
    const target = parseTarget(station.to);
    if (target === null) {
      return {
        ok: false,
        done: false,
        text: `这一站的 to 读不懂:「${station.to}」`,
      };
    }
    const wanted = station.items ?? [];
    if (wanted.length === 0) {
      return { ok: true, done: true, text: "这一站没写要买的东西" };
    }
    if (!shopIndexReady) {
      try {
        shopIndex = await ports.shops();
        shopIndexReady = true;
      } catch (error) {
        log(`${tagOf(index)} 读商店位置出错:${String(error)}`);
      }
    }
    // Prefer the counter the station names, then the shop that covers the most of `items`.
    const onMap = shopIndex
      .filter(
        (shop) => shop.map === target.map && wanted.some((entry) => shopSells(shop, entry.item)),
      )
      .sort(
        (left, right) =>
          wanted.filter((entry) => shopSells(right, entry.item)).length -
          wanted.filter((entry) => shopSells(left, entry.item)).length,
      );
    const atCounter =
      target.cell === null ? undefined : onMap.find((shop) => sameCell(shop.cell, target.cell));
    const shop = atCounter ?? onMap[0];
    if (shop === undefined) {
      return {
        ok: false,
        done: false,
        text: `地图 ${target.map} 没有卖「${wanted.map((entry) => entry.item).join("、")}」的店`,
      };
    }
    const here = await ports.position();
    if (here === null) return { ok: false, done: false, text: "读不到当前位置，没法去买" };
    if (here.map !== shop.map) {
      const waypoint: Waypoint = {
        id: `buy-${shopKey(shop)}`,
        kind: "move",
        map: shop.map,
        cell: null,
        label: shopLabel(shop),
        reach: "map",
      };
      const routePlan = await ports.planRoute(here, [waypoint], null);
      if (!routePlan.legs.some((leg) => leg.waypoint === waypoint.id)) {
        return { ok: false, done: false, text: `走不到${shopLabel(shop)}` };
      }
      const budget = Math.max(0, Math.min(deadline - Date.now(), stationBudget));
      const walked = await executeRoute(routePlan, ports.routePorts(), {
        signal,
        timeBudgetMs: budget,
        maxWaypointFailures: 2,
        waypoints: [waypoint],
      });
      if (walked.reason !== "completed") {
        return {
          ok: false,
          done: false,
          text: `去${shopLabel(shop)}没走到:${walked.message}`,
        };
      }
    }
    let opened: PlanActionResult;
    try {
      opened = await ports.openShop(shop.cell);
    } catch (error) {
      return {
        ok: false,
        done: false,
        text: `开${shopLabel(shop)}出错:${String(error)}`,
      };
    }
    if (!opened.ok) {
      return {
        ok: false,
        done: false,
        text: `没打开${shopLabel(shop)}:${opened.text}`,
      };
    }
    const bought: string[] = [];
    const missed: string[] = [];
    for (let position = 0; position < wanted.length; position += 1) {
      const entry = wanted[position];
      if (entry === undefined) break;
      const count = Math.max(1, Math.trunc(entry.count));
      if (!shopSells(shop, entry.item)) {
        missed.push(`${entry.item}×${count}(店不卖)`);
        continue;
      }
      let result: PlanBuyResult;
      try {
        result = await ports.buy(entry.item, count);
      } catch (error) {
        missed.push(`${entry.item}×${count}(${String(error)})`);
        continue;
      }
      emitRun({
        type: "buy",
        station: index,
        map: shop.map,
        item: entry.item,
        count,
        bought: result.bought,
        reason: result.ok ? undefined : result.text,
        note: shopLabel(shop),
      });
      if (result.ok) {
        bought.push(`${entry.item}×${count}`);
        continue;
      }
      missed.push(`${entry.item}×${count}(${result.text})`);
      if (/钱不够|金钱没有变化/u.test(result.text)) {
        // Record every later item too: the plan must show what this stop left unbought.
        for (const rest of wanted.slice(position + 1)) {
          if (shopSells(shop, rest.item)) {
            missed.push(`${rest.item}×${Math.max(1, Math.trunc(rest.count))}(钱不够)`);
          }
        }
        log(`${tagOf(index)} 钱不够，剩下没买到:${missed.join("、")}`);
        break;
      }
    }
    try {
      const left = await ports.leaveShop();
      if (!left.ok) log(`${tagOf(index)} 离开${shopLabel(shop)}的商店菜单:${left.text}`);
    } catch (error) {
      log(`${tagOf(index)} 离开${shopLabel(shop)}的商店菜单出错:${String(error)}`);
    }
    let optimized = "";
    try {
      const result = await ports.optimizeEquipment();
      optimized = result.ok ? "" : `；整备:${result.text}`;
      log(`${tagOf(index)} 买完整备装备:${result.text}`);
    } catch (error) {
      log(`${tagOf(index)} 买完整备装备出错:${String(error)}`);
    }
    const parts = [
      bought.length === 0 ? "什么都没买到" : `买了:${bought.join("、")}`,
      missed.length === 0 ? "" : `没买到:${missed.join("、")}`,
    ].filter((line) => line !== "");
    return { ok: true, done: true, text: parts.join("；") + optimized };
  };

  /** Task 159: walk to a save point, using a standable side when it is an object. */
  const walkToSavePoint = async (index: number, map: number, cell: Cell): Promise<Cell | null> => {
    const here = await ports.position();
    if (here === null) return null;
    let object = false;
    try {
      const at = ports.pointAt === undefined ? null : await ports.pointAt(map, cell);
      object = at !== null;
    } catch (error) {
      log(`${tagOf(index)} 判断存档点 (${cell[0]},${cell[1]}) 出错:${String(error)}`);
    }
    const stands: Cell[] = object
      ? bossSides(cell).map((side) => side.cell)
      : [cell, ...bossSides(cell).map((side) => side.cell)];
    interface Candidate {
      readonly stand: Cell;
      readonly route: Awaited<ReturnType<ExecutePorts["planRoute"]>>;
      readonly minutes: number;
      readonly waypoint: Waypoint;
    }
    let best: Candidate | null = null;
    for (const stand of stands) {
      const waypoint: Waypoint = {
        id: `save-point-${index}-${map}-${stand[0]}-${stand[1]}`,
        kind: "move",
        map,
        cell: stand,
        label: "存档点",
        reach: "cell",
      };
      try {
        const route = await ports.planRoute(here, [waypoint], null);
        if (!route.legs.some((leg) => leg.waypoint === waypoint.id)) continue;
        if (best === null || route.total.minutes < best.minutes) {
          best = { stand, route, minutes: route.total.minutes, waypoint };
        }
        if (!object && sameCell(stand, cell)) break;
      } catch (error) {
        log(`${tagOf(index)} 估算去存档点 (${cell[0]},${cell[1]}) 出错:${String(error)}`);
      }
    }
    if (best === null) return null;
    const budget = Math.max(
      0,
      Math.min(deadline - Date.now(), stationBudget, SAVE_POINT_WALK_BUDGET_MS),
    );
    const walked = await executeRoute(best.route, ports.routePorts(), {
      signal,
      timeBudgetMs: budget,
      maxWaypointFailures: 2,
      waypoints: [best.waypoint],
    });
    if (walked.reason !== "completed") {
      log(`${tagOf(index)} 去存档点 (${cell[0]},${cell[1]}) 没走到:${walked.message}`);
      return null;
    }
    const arrived = await ports.position();
    return arrived !== null && sameCell(arrived.cell, best.stand) ? best.stand : null;
  };

  /**
   * Task 159: a save station counts only when a save really happened. When the plan's target
   * is not a save point, look for a known save point on this map, walk there and save; with none,
   * skip the station with the game's own reason instead of recording it done (11-11 live: map
   * 204's save was grey, yet the station was "complete" and the boss fight had no recent save).
   */
  const saveStation = async (index: number, station: PlanStation): Promise<PlanStationResult> => {
    const target = parseTarget(station.to);
    const targetCell = target?.cell ?? null;
    const asStation = (result: PlanActionResult): PlanStationResult => ({
      ...result,
      done: result.ok,
    });
    const skipSave = (reason: string): PlanStationResult => {
      emitRun({
        type: "warn",
        reason: /首领|boss/iu.test(station.why ?? "") ? "首领前没存上档" : "存档站没存上档",
        station: index,
        note: reason,
      });
      return { ok: false, done: false, skipReason: reason, text: reason };
    };
    let firstText = "";
    if (target !== null && targetCell !== null && ports.usePoint !== undefined) {
      let point: "restore" | "save" | null = null;
      try {
        point = ports.pointAt === undefined ? null : await ports.pointAt(target.map, targetCell);
      } catch (error) {
        log(`${tagOf(index)} 判断存档点 (${targetCell[0]},${targetCell[1]}) 出错:${String(error)}`);
      }
      if (point === "save") {
        const used = await ports.usePoint(targetCell, "save");
        log(`${tagOf(index)} 动作:存档:${used.text}`);
        if (used.ok) return used;
        firstText = used.text;
      }
    }
    if (firstText === "") {
      const saved = asStation(await ports.save());
      log(`${tagOf(index)} 动作:存档:${saved.text}`);
      if (saved.ok) return saved;
      firstText = saved.text.trim() === "" ? "这里不能存档" : saved.text;
    }
    const here = await ports.position();
    const map = here?.map ?? target?.map ?? null;
    if (map === null) return skipSave(firstText);
    let points: readonly Cell[] = [];
    if (ports.savePoints !== undefined) {
      try {
        points = await ports.savePoints(map);
      } catch (error) {
        log(`${tagOf(index)} 读存档点出错:${String(error)}`);
      }
    }
    for (const cell of points) {
      if (sameCell(targetCell, cell)) continue;
      const stand = await walkToSavePoint(index, map, cell);
      if (stand === null) continue;
      let saved: PlanStationResult;
      if (sameCell(stand, cell)) {
        saved = asStation(await ports.save());
      } else if (ports.usePoint !== undefined) {
        saved = await ports.usePoint(cell, "save");
      } else {
        saved = asStation(await ports.save());
      }
      log(
        `${tagOf(index)} 改到存档点 ${map}:${cell[0]},${cell[1]}` +
          (sameCell(stand, cell) ? "" : ` 站 ${map}:${stand[0]},${stand[1]}`) +
          ` 存档:${saved.text}`,
      );
      if (saved.ok) {
        return {
          ...saved,
          evidence: [...(saved.evidence ?? []), `存档点 ${map}:${cell[0]},${cell[1]}`],
          text: `${firstText}；${saved.text}`,
        };
      }
    }
    return skipSave(firstText);
  };

  const runStation = async (index: number): Promise<PlanStationResult> => {
    const station = plan.stations[index];
    if (station === undefined) return { ok: false, done: false, text: "这一站不存在" };
    if (station.do === "move") {
      log(`${tagOf(index)} 动作:移动完成`);
      return { ok: true, done: true, text: "走到了" };
    }
    if (station.do === "story" && scriptMarks.has("story")) {
      log(`${tagOf(index)} 路上播了剧情，不再按确认`);
      return {
        ok: true,
        done: true,
        evidence: ["对话/剧情"],
        text: "路上播了剧情",
      };
    }
    const asStation = (result: PlanActionResult): PlanStationResult => ({
      ...result,
      done: result.ok,
    });
    if (station.do === "save") {
      return await saveStation(index, station);
    }
    if (station.do === "heal") {
      const target = parseTarget(station.to);
      const cell = target?.cell ?? null;
      const point =
        target === null || cell === null || ports.pointAt === undefined
          ? null
          : await ports.pointAt(target.map, cell);
      if (point !== null && cell !== null && ports.usePoint !== undefined) {
        const used = await ports.usePoint(cell, point);
        log(`${tagOf(index)} 动作:回复:${used.text}`);
        emitRun({
          type: "heal",
          beforeHp: lowestHp(last),
          afterHp: null,
          used: used.text,
          note: tagOf(index),
          station: index,
        });
        return used;
      }
      const healed = asStation(await healLogged(undefined, `${tagOf(index)} 动作:回复`));
      log(`${tagOf(index)} 动作:回复:${healed.text}`);
      return healed;
    }
    if (station.do === "choose") {
      const chosen = await ports.choose(
        choiceOption(station),
        parseTarget(station.to)?.cell ?? undefined,
      );
      log(`${tagOf(index)} 动作:选项:${chosen.text}`);
      return {
        ...chosen,
        done: chosen.ok,
        ...(chosen.ok ? {} : { decision: chosen.text }),
      };
    }
    if (station.do === "boss") {
      return {
        ok: false,
        done: false,
        text: "首领站要开战",
        decision: "首领站要开战",
      };
    }
    if (station.do === "grind") {
      const waypoint = waypointOf(station, index);
      if (waypoint === null) return { ok: false, done: false, text: "刷怪站没有坐标" };
      const ground = await ports.grind(waypoint);
      log(`${tagOf(index)} 动作:刷怪:${ground.text}`);
      return ground;
    }
    if (station.do === "buy") {
      const result = await buyAtStation(index, station);
      log(`${tagOf(index)} 动作:买东西:${result.text}`);
      return result;
    }
    const target = parseTarget(station.to);
    if (target?.cell === null || target?.cell === undefined) {
      return { ok: false, done: false, text: "这一站没有格子，没法调查" };
    }
    const acted = await ports.interact(target.cell);
    log(`${tagOf(index)} 动作:调查:${acted.text}`);
    if (acted.decision === undefined || acted.decision.trim() === "") return acted;
    const answered = await answerChoice(acted.decision);
    if (answered === null) return acted;
    return {
      ok: true,
      done: true,
      text: [acted.text, answered.text].join("\n"),
    };
  };

  let routePorts: RoutePorts | null = null;
  const portsForRoute = (): RoutePorts => {
    if (routePorts !== null) return routePorts;
    const base = ports.routePorts();
    routePorts = {
      ...base,
      goTo: async (stop) => {
        const before = await base.position();
        let result = await base.goTo(stop);
        const after = await base.position();
        if (
          before !== null &&
          after !== null &&
          /(?:interrupted|停在|被带走)/u.test(result.text) &&
          (before.map !== after.map ||
            Math.abs(before.cell[0] - after.cell[0]) + Math.abs(before.cell[1] - after.cell[1]) > 3)
        ) {
          scriptMovedAt.set("at", after);
        }
        if (/(?:interrupted|停在.*(?:Event|dialog)|翻.*页|被带走)/u.test(result.text)) {
          scriptMarks.add("story");
        }
        // Task 145 follow-up: the walk can stop on a dialog that the route did not recognise
        // as a story stop. Page it here and walk on, so a station cannot sit on one page.
        for (let attempt = 0; attempt < 3; attempt++) {
          const scene = await ports.scene?.();
          if (scene === undefined || !storyScene(scene)) return result;
          scriptMarks.add("story");
          log(`路线遇到剧情/对话，先翻页`);
          const advanced = await ports.story();
          if (advanced.decision !== undefined && advanced.decision.trim() !== "") {
            return { ...result, decision: advanced.decision };
          }
          result = await base.goTo(stop);
        }
        return result;
      },
      act: async (stop) => {
        if (stop.kind === "move") return { ok: true, done: true, text: "走到了" };
        const index = Number(stop.id.replace(/^plan-/u, ""));
        if (!Number.isInteger(index)) return { ok: false, done: false, text: "不认识这一站" };
        const result = await runStation(index);
        for (const evidence of result.evidence ?? []) stationEvidence.add(evidence);
        if (result.skipReason !== undefined) {
          actionSkips.set(index, result.skipReason);
          return { ...result, ok: true, done: true };
        }
        if (result.fatal === true) {
          const station = plan.stations[index];
          const target = station === undefined ? null : (parseTarget(station.to)?.cell ?? null);
          const detail =
            station?.do === "story" && target !== null
              ? `到了 (${target[0]},${target[1]}) 附近，剧情没有触发(没有对话、没有入队、地图没变)`
              : result.text;
          fail("stuck", detail, index);
          return { ...result, decision: detail };
        }
        return result;
      },
      grind: async (stop) => await ports.grind(stop),
      story: async () => {
        scriptMarks.add("story");
        const before = await ports.position();
        const advanced = await ports.story();
        const after = await ports.position();
        if (
          before !== null &&
          after !== null &&
          (before.map !== after.map ||
            Math.abs(before.cell[0] - after.cell[0]) + Math.abs(before.cell[1] - after.cell[1]) > 3)
        ) {
          scriptMovedAt.set("at", after);
        }
        if (advanced.decision === undefined || advanced.decision.trim() === "") return advanced;
        const answered = await answerChoice(advanced.decision);
        if (answered === null) return advanced;
        return {
          text: [advanced.text, answered.text].filter((line) => line !== "").join("\n"),
        };
      },
    };
    routePorts.replan = async (from, rest, end) => await ports.planRoute(from, rest, end);
    return routePorts;
  };

  /** Task 141: heal/save before the boss, once per station, before the walk starts. */
  const prepareBoss = async (index: number, station: PlanStation): Promise<PlanBoss | null> => {
    const target = parseTarget(station.to);
    const boss = bossForStation(plan, station, target?.map ?? null);
    if (boss === undefined) {
      fail("invalid", `首领站「${station.to}」在 plan.bosses 里没有对应的首领表`, index);
      return null;
    }
    bossEntries.set(index, boss);
    if (bossPrepared.has(index)) return boss;
    bossPrepared.add(index);
    if (boss.healFirst) {
      // Task 156: a boss is not a field fight; spend items up to Config's healFullPercent,
      // not only below the chapter's 40% line (11-12 live: Bartz entered at 49%).
      const full = options.healFullPercent ?? DEFAULT_BOSS_HEAL_PERCENT;
      const healed = await healLogged(full, `${tagOf(index)} 首领前回复`);
      prepNotes.push(`首领前回复:${healed.text}`);
      reportNotes.push(`首领前回复:${healed.text}`);
      log(
        `${tagOf(index)} 首领前回复(${full}% 线):${healed.text}` +
          (healed.ok ? "" : "；没到线，照计划打"),
      );
    }
    if (boss.saveFirst) {
      const saved = await ports.save();
      prepNotes.push(`首领前存档:${saved.text}`);
      log(`${tagOf(index)} 首领前存档:${saved.text}`);
      if (!saved.ok) {
        emitRun({ type: "warn", reason: "首领前没存上档", station: index, note: saved.text });
      }
    }
    return boss;
  };

  /**
   * Task 156: find a boss's trigger when the station wrote only a map. Chapter-fact triggers
   * (task 146) come first; then the ports' knowledge events/NPCs and live script entities.
   * A candidate that cannot be stood on is faced from a side. Fails only when every candidate
   * is unreachable, so the caller can report what it tried.
   */
  const findBossTrigger = async (
    index: number,
    boss: PlanBoss,
    map: number,
    station: PlanStation,
    waypoint: Waypoint,
    here: { readonly map: number; readonly cell: Cell },
  ): Promise<{ readonly cell: Cell | null; readonly found: number }> => {
    const hint = [station.why ?? "", boss.notes ?? ""].filter((line) => line !== "").join("；");
    const cells = orderTriggerCells(options.bossTriggers?.(boss, map) ?? [], hint);
    if (ports.bossTriggerCandidates !== undefined) {
      try {
        for (const cell of await ports.bossTriggerCandidates(map, boss, hint)) {
          if (!cells.some((entry) => sameCell(entry, cell))) cells.push(cell);
        }
      } catch (error) {
        log(`${tagOf(index)} 读首领触发点出错:${errorText(error)}`);
      }
    }
    let found = 0;
    for (const cell of cells) {
      found += 1;
      let kind: "trigger" | "object";
      try {
        kind = await ports.bossTarget(cell, boss.name);
      } catch (error) {
        log(`${tagOf(index)} 判断首领触发点 ${cellText(cell)} 出错:${errorText(error)}`);
        continue;
      }
      const probes =
        kind === "trigger"
          ? [{ cell, direction: "确认" }]
          : bossSides(cell).map((side) => ({
              cell: side.cell,
              direction: side.direction,
            }));
      for (const probe of probes) {
        const probeWaypoint: Waypoint = {
          ...waypoint,
          cell: probe.cell,
          reach: "cell",
        };
        let route;
        try {
          route = await ports.planRoute(here, [probeWaypoint], null);
        } catch (error) {
          log(`${tagOf(index)} 估算去首领触发点 ${cellText(cell)} 出错:${errorText(error)}`);
          continue;
        }
        if (!route.legs.some((leg) => leg.waypoint === probeWaypoint.id)) continue;
        const how =
          kind === "trigger" ? "走上去" : `从 ${cellText(probe.cell)} 面朝${probe.direction}`;
        log(`${tagOf(index)} 首领站没写坐标，找到触发点 ${cellText(cell)}，${how}`);
        return { cell, found };
      }
    }
    return { cell: null, found };
  };

  /**
   * Task 141: walk to another side of a boss that could not be stepped on. A side the route
   * cannot reach is only a note; the caller tries the next one.
   */
  const walkBossSide = async (
    index: number,
    waypoint: Waypoint,
    side: BossSide,
  ): Promise<boolean> => {
    const here = await ports.position();
    if (here === null) return false;
    const atSide: Waypoint = { ...waypoint, cell: side.cell };
    const sidePlan = await ports.planRoute(here, [atSide], null);
    if (!sidePlan.legs.some((leg) => leg.waypoint === atSide.id)) {
      log(`${tagOf(index)} 首领旁边 ${cellText(side.cell)} 走不到`);
      return false;
    }
    log(`${tagOf(index)} 换到 ${cellText(side.cell)} 面朝${side.direction}再试`);
    const budget = Math.max(0, Math.min(deadline - Date.now(), stationBudget));
    const result = await executeRoute(sidePlan, portsForRoute(), {
      signal,
      timeBudgetMs: Math.max(0, budget),
      maxWaypointFailures: 2,
      waypoints: [atSide],
    });
    if (result.replans > 0) log(`${tagOf(index)} 重排 ${result.replans} 次`);
    if (result.reason === "aborted") {
      aborted = true;
      return false;
    }
    if (result.reason === "gameover") {
      const recovered = await ports.recoverGameover();
      fail("gameover", `${result.message}；${recovered.text}`, index);
      return false;
    }
    if (result.reason === "time-budget") {
      fail("stuck", `${tagOf(index)} 换边时超时:${result.message}`, index);
      return false;
    }
    const arrived = await ports.position();
    return arrived !== null && sameCell(arrived.cell, side.cell);
  };

  /** Task 141: face the boss, confirm, and only then hand the fight to the plan's table. */
  const finishBoss = async (
    index: number,
    station: PlanStation,
    waypoint: Waypoint,
  ): Promise<void> => {
    const boss = bossEntries.get(index) ?? (await prepareBoss(index, station));
    if (boss === null) return;
    const target = parseTarget(station.to)?.cell ?? null;
    const tag = tagOf(index);
    // Task 145: the walk may already have started the boss fight; fight it here with the plan's
    // boss table instead of pressing confirm at a cell where the battle already took over.
    if (ports.scene !== undefined) {
      const scene = await ports.scene();
      if (scene.battle) {
        log(`${tag} 首领战已经开打，直接按计划打:${boss.name}`);
        if (await fightScene(index, scene)) {
          await completeStation(index, `打赢首领「${boss.name}」`);
        }
        return;
      }
    }
    const kind = bossKinds.get(index) ?? "object";
    if (target === null) {
      if (!(await ports.battleActive())) {
        fail("invalid", `首领站「${station.to}」没有坐标，走到这张图也没开战`, index);
        return;
      }
    }
    let active = await ports.battleActive();
    const tried: string[] = [];
    if (!active && target !== null && kind === "trigger") {
      // A trigger cell starts its scene when stepped on; page the pre-battle dialog here.
      const paged = await ports.story();
      log(`${tag} 走上触发格后翻剧情:${paged.text}`);
      if (paged.decision !== undefined && paged.decision.trim() !== "") {
        const answered = await answerChoice(paged.decision);
        if (answered !== null) log(`${tag} 触发格对话按计划选:${answered.text}`);
      }
      active = await ports.battleActive();
      if (!active) tried.push(`${cellText(target)} 走上触发格`);
    }
    if (!active && target !== null) {
      let sides = bossSides(target);
      const here = await ports.position();
      if (here !== null) {
        const currentSide = sides.find((side) => sameCell(side.cell, here.cell));
        if (currentSide !== undefined) {
          sides = [currentSide, ...sides.filter((side) => side !== currentSide)];
        }
      }
      for (const side of sides) {
        if (aborted || failed()) return;
        const at = await ports.position();
        if (at === null || !sameCell(at.cell, side.cell)) {
          const walked = await walkBossSide(index, waypoint, side);
          if (!walked) {
            tried.push(`${cellText(side.cell)} 面朝${side.direction}(走不到)`);
            if (signal?.aborted === true) aborted = true;
            if (aborted || failed()) return;
            continue;
          }
        }
        log(`${tag} 在 ${cellText(side.cell)} 面朝${side.direction}按确认调查首领`);
        const acted = await ports.interact(target);
        log(`${tag} 调查结果:${acted.text}`);
        if (acted.decision !== undefined && !acted.decision.includes("首领战")) {
          const answered = await answerChoice(acted.decision);
          if (answered !== null) log(`${tag} 开战前对话按计划选:${answered.text}`);
        }
        tried.push(`${cellText(side.cell)} 面朝${side.direction}`);
        active = await ports.battleActive();
        if (active) break;
        log(`${tag} 这个方向按了确认没开战，换另一侧`);
      }
    }
    if (aborted || failed()) return;
    if (!active) {
      fail(
        "stuck",
        `首领「${boss.name}」没开战;试过:${tried.length === 0 ? "没有任何能站的格" : tried.join("、")}`,
        index,
      );
      return;
    }

    bossFights += 1;
    const tables = boss.tables.length === 0 ? "没有规则表" : `首领表 1/${boss.tables.length}`;
    log(`${tag} 首领战开始:${boss.name}(${tables})`);
    const fightStarted = Date.now();
    const result = await ports.fightBoss(boss);
    emitRun({
      type: "battle",
      kind: "boss",
      enemies: [boss.name],
      won: result.won,
      ms: Math.max(0, Date.now() - fightStarted),
      note: result.summary || result.text,
      station: index,
    });
    log(`${tag} 首领战结束:${result.won ? "赢了" : "没赢"}:${result.text}`);
    if (result.won) {
      if (!bossesWon.includes(boss.name)) bossesWon.push(boss.name);
      log(`${tag} 完成:打赢首领「${boss.name}」`);
      // Task 145: post-battle text and any second fight belong to the same station boundary.
      await completeStation(index, `打赢首领「${boss.name}」`);
      return;
    }
    const recovered = await ports.recoverGameover();
    if (recovered.ok) {
      fail("gameover", `${bossSummary(result)}；${recovered.text}`, index);
      return;
    }
    fail("boss-lost", `首领「${boss.name}」没打赢:${bossSummary(result)}`, index);
  };

  if (runLifecycle) {
    emitRun({
      type: "run.start",
      note: plan.goal,
      count: plan.stations.length,
      modelCalls: 0,
    });
  }
  if (runLifecycle && ((options.startAt ?? 0) > 0 || (options.skipStations?.length ?? 0) > 0)) {
    emitRun({
      type: "resume",
      from: options.startAt ?? 0,
      skipped: [...(options.skipStations ?? [])],
      note: "从上一轮停下的站接着跑",
    });
  }
  try {
    if (options.manageLayers !== false && ports.begin !== undefined) await ports.begin();
    try {
      await ports.startProgress(plan.section, plan.goal, labels);
    } catch (error) {
      log(`进度没能开始:${String(error)}`);
    }
    await refresh(true);
    before = seen();
    battlesBefore = before?.battles ?? 0;
    log(`段「${plan.section}」开始:${plan.stations.length} 站;目标:${plan.goal}`);
    log(`出发状态:${partyLine(before)}`);

    // Task 145: a plan can start in a battle or a cutscene. Install its battle tables first,
    // settle that screen, and only then do the departure preparation and station 1.
    let earlyBattles = false;
    if (ports.scene !== undefined) {
      let initial: PlanScene | null = null;
      try {
        initial = await ports.scene();
      } catch (error) {
        log(`出发时读不到场面:${String(error)}`);
      }
      if (initial !== null && (initial.battle || storyScene(initial))) {
        try {
          await ports.beginBattles(plan.battle);
          battlesStarted = true;
          battlesBefore = 0;
          earlyBattles = true;
        } catch (error) {
          fail("invalid", `战斗表通不过检查:${String(error)}`, null);
        }
        if (!failed()) {
          await settleScene(null, "出发前");
          await refresh();
        }
      }
    }

    if (failed()) {
      log("出发前的场面没收拾好，跳过出发准备和站点");
    } else {
      log("出发准备开始");

      // Departure preparation, exactly the plan's order: jobs/skills, equipment, shopping, rows.
      for (const job of plan.prep.jobs) {
        const result = await ports.changeJob(job.member, job.job, job.abilities ?? []);
        prepNotes.push(`${job.member} 换职业:${result.text}`);
        log(`${job.member} 换职业:${result.text}`);
      }
      if (plan.prep.equip === "optimize") {
        const result = await ports.optimizeEquipment();
        prepNotes.push(`最强装备:${result.text}`);
        log(`最强装备:${result.text}`);
      }
      try {
        shopIndex = await ports.shops();
        shopIndexReady = true;
      } catch (error) {
        log(`读商店位置出错:${String(error)}`);
      }
      if (shopIndex.length === 0) {
        // Older/synthetic ports have no location index: keep the old "buy where a shop is open".
        for (const purchase of purchases) {
          const result = await ports.buy(purchase.item, purchase.count);
          const line = result.atShop
            ? `买 ${purchase.item}×${purchase.count}:${result.text}`
            : `没买成:${result.text}`;
          prepNotes.push(line);
          log(line);
          if (result.ok) {
            purchase.remaining = Math.max(0, purchase.remaining - Math.max(0, result.bought));
          }
        }
      } else {
        // Shops in the departure town/area first, in the plan's purchase order.
        const currentMap = seen()?.map ?? null;
        const currentArea = itemKey(seen()?.area ?? "");
        const departureShops: PlanShop[] = [];
        for (const purchase of purchases) {
          const shop = shopIndex.find(
            (entry) =>
              (entry.map === currentMap ||
                (currentArea !== "" && itemKey(entry.area) === currentArea)) &&
              shopSells(entry, purchase.item),
          );
          if (
            shop !== undefined &&
            !departureShops.some((entry) => shopKey(entry) === shopKey(shop))
          ) {
            departureShops.push(shop);
          }
        }
        for (const shop of departureShops) await openAndBuy(shop);
      }
      for (const row of plan.prep.rows) {
        const result = await ports.setRow(row.member, row.row);
        prepNotes.push(`${row.member} 站${row.row === "front" ? "前排" : "后排"}:${result.text}`);
        log(`${row.member} 站${row.row === "front" ? "前排" : "后排"}:${result.text}`);
      }
      log("出发准备结束");

      try {
        if (!earlyBattles) {
          await ports.beginBattles(plan.battle);
          battlesStarted = true;
          // beginBattles resets the engine's counter, so the run starts at zero even when one Game
          // executes a second plan after an earlier one.
          battlesBefore = 0;
        }
        for (const battle of plan.battle) {
          const maps = battle.maps.length === 0 ? "默认" : `地图 ${battle.maps.join("、")}`;
          log(`普通战斗表:${maps} ${battle.tables.length} 套`);
        }
        if (plan.battle.length === 0) log("普通战斗表:没有，这一段的普通战斗不换表");
      } catch (error) {
        fail("invalid", `战斗表通不过检查:${String(error)}`, null);
      }

      if (!failed()) {
        const startAt = Math.max(0, Math.min(options.startAt ?? 0, plan.stations.length));
        const skipStations = new Set(options.skipStations ?? []);
        // A chapter retry starts after the stations the failed run already finished; mark
        // them done so the section progress file and the report still show the whole section.
        for (let index = 0; index < startAt; index += 1) {
          await complete(index, "重试前已完成，从这里接着走");
        }
        for (let index = startAt; index < plan.stations.length; index += 1) {
          current = index;
          let station = plan.stations[index];
          if (station === undefined) break;
          if (skipStations.has(index)) {
            await skip(index, "按兜底跳过这一站");
            continue;
          }
          if (consumedChoices.has(index)) {
            const note =
              station.do === "choose"
                ? "前面的对话里已经按计划选过这一站；证据:对话/剧情"
                : "前面的对话里已经按计划选过这一站";
            await complete(index, note);
            continue;
          }
          if (station.do === "boss") {
            const target = parseTarget(station.to);
            const boss = bossForStation(plan, station, target?.map ?? null);
            const won = [...bossesWon, ...(options.alreadyWonBosses ?? [])];
            if (boss !== undefined && won.some((name) => bossNameMatches(name, boss.name))) {
              const line =
                `${tagOf(index)} 完成:首领「${boss.name}」前面的剧情里已经打过，` +
                "不再走去首领站写的地图";
              await complete(index, line);
              log(line);
              continue;
            }
          }
          if (signal?.aborted === true) {
            aborted = true;
            break;
          }
          if (Date.now() >= deadline) {
            fail("stuck", "整段的时间预算用完了，停在这一站", index);
            break;
          }
          if (options.checkpoint !== undefined) {
            const problem = await options.checkpoint(last, index);
            if (problem !== null) {
              fail("stuck", problem, index);
              break;
            }
          }
          await mark(index, "current", `正在执行:${station.why ?? station.to}`);
          log(
            `${tagOf(index)} ${ACTION_LABELS[station.do]} ${station.to} 开始` +
              (station.why === undefined ? "" : `:${station.why}`),
          );
          if (await turnBack()) break;

          let waypoint = waypointOf(station, index);
          if (waypoint === null) {
            fail("invalid", `这一站的 to 读不懂:「${station.to}」`, index);
            break;
          }
          let here = await ports.position();
          if (here === null) {
            fail("stuck", "读不到当前位置，没法走这一站", index);
            break;
          }
          log(`${tagOf(index)} 从 地图 ${here.map} ${cellText(here.cell)} 出发`);
          scriptMarks.clear();
          scriptMovedAt.clear();
          stationEvidence.clear();
          const partyBefore = partySignature(seen());
          // Task 145: the target cell may be an exit/entrance. Reaching the map it leads to is
          // arrival too; walk to that map instead of back to the old map's exit cell.
          const targetNow = parseTarget(station.to);
          if (station.do === "open" && targetNow?.cell !== null && targetNow?.cell !== undefined) {
            try {
              if (await ports.chestAlreadyOpen?.(targetNow.map, targetNow.cell)) {
                const note = "已开过";
                log(`${tagOf(index)} ${note}`);
                if (await completeStation(index, note)) {
                  if (await turnBack()) break;
                  continue;
                }
                break;
              }
            } catch (error) {
              log(`${tagOf(index)} 读宝箱标记出错:${String(error)}`);
            }
          }
          let targetEvent = false;
          if (targetNow?.cell !== null && targetNow?.cell !== undefined) {
            try {
              targetEvent = (await ports.eventAt?.(targetNow.map, targetNow.cell)) === true;
            } catch {
              targetEvent = false;
            }
          }
          if (
            targetNow !== null &&
            targetNow.map !== here.map &&
            ports.mapKnown !== undefined &&
            !(await ports.mapKnown(targetNow.map))
          ) {
            fail(
              "unreachable",
              `第 ${index + 1} 站「${station.to}」:地图 ${targetNow.map} 在地图记录里没有路`,
              index,
            );
            break;
          }
          let enteredExit: PlanExitTarget | null = null;
          if (targetNow?.cell !== null && targetNow?.cell !== undefined) {
            try {
              const exit = await ports.exitTarget?.(targetNow.map, targetNow.cell);
              if (exit !== null && exit !== undefined && exit.toMap !== targetNow.map) {
                enteredExit = exit;
                if (here.map === exit.toMap) {
                  const note = exitNote(exit);
                  log(`${tagOf(index)} ${note}`);
                  if (await completeStation(index, note)) {
                    if (await turnBack()) break;
                    continue;
                  }
                  break;
                }
                if (here.map === targetNow.map) {
                  waypoint = {
                    ...waypoint,
                    map: exit.toMap,
                    cell: null,
                    reach: "map",
                    label: `${waypoint.label} → 地图 ${exit.toMap}`,
                  };
                  log(`${tagOf(index)} 目标 ${station.to} 是入口，走去地图 ${exit.toMap}`);
                }
              }
            } catch (error) {
              log(`${tagOf(index)} 读入口信息出错:${String(error)}`);
            }
          }
          if (
            (station.do === "heal" || station.do === "save") &&
            targetNow?.cell !== null &&
            targetNow?.cell !== undefined &&
            ports.pointAt !== undefined
          ) {
            try {
              const point = await ports.pointAt(targetNow.map, targetNow.cell);
              if (point !== null) {
                waypoint = { ...waypoint, reach: "map" };
                log(
                  `${tagOf(index)} 目标 ${station.to} 是${point === "save" ? "存档" : "回复"}点物件，走到旁边按确认`,
                );
              }
            } catch (error) {
              log(`${tagOf(index)} 读回复/存档点出错:${String(error)}`);
            }
          }
          const scriptTarget =
            station.do === "story" ||
            station.do === "talk" ||
            (station.do === "move" && (enteredExit !== null || targetEvent));
          // A shop on the way is inserted by the executor: the route's map order decides when.
          if (pendingPurchases().length > 0) {
            const previewId = waypoint.id;
            const preview = await ports.planRoute(here, [waypoint], null);
            const leg = preview.legs.find((entry) => entry.waypoint === previewId);
            if (leg !== undefined) {
              for (const shop of shopsOnRoute(leg.maps)) {
                if (!pendingPurchases().some((purchase) => shopSells(shop, purchase.item))) {
                  continue;
                }
                log(`${tagOf(index)} 路过${shopLabel(shop)}，顺便去买东西`);
                await openAndBuy(shop);
              }
              const moved = await ports.position();
              if (moved !== null) here = moved;
            }
          }
          if (station.do === "boss") {
            const boss = await prepareBoss(index, station);
            if (boss === null) break;
            const targetMap = parseTarget(station.to)?.map ?? null;
            let target = parseTarget(station.to)?.cell ?? null;
            if (target === null && targetMap !== null && !(await ports.battleActive())) {
              // Task 156: a boss station may write only its map. Find the trigger before the
              // walk: chapter facts first, then knowledge events/NPCs and live script entities.
              const found = await findBossTrigger(index, boss, targetMap, station, waypoint, here);
              if (found.cell === null) {
                fail(
                  "invalid",
                  found.found === 0
                    ? `首领站「${station.to}」没写坐标，章事实、知识库和场上实体里都找不到` +
                        `「${boss.name}」的触发点`
                    : `首领站「${station.to}」找到 ${found.found} 个触发点，但都走不到`,
                  index,
                );
                break;
              }
              target = found.cell;
              station = {
                ...station,
                to: `${targetMap}:${target[0]},${target[1]}`,
              };
              waypoint = waypointOf(station, index) ?? {
                ...waypoint,
                cell: target,
                reach: "cell",
              };
              log(`${tagOf(index)} 首领站改走 ${station.to}`);
            }
            if (target !== null) {
              const kind = await ports.bossTarget(target, boss.name);
              bossKinds.set(index, kind);
              if (kind === "object") {
                // The boss cell itself cannot be walked on: pick a reachable side, below first.
                let chosen: BossSide | null = null;
                for (const side of bossSides(target)) {
                  const probe: Waypoint = { ...waypoint, cell: side.cell };
                  const sidePlan = await ports.planRoute(here, [probe], null);
                  if (sidePlan.legs.some((leg) => leg.waypoint === probe.id)) {
                    chosen = side;
                    break;
                  }
                }
                if (chosen === null) {
                  fail(
                    "unreachable",
                    `${tagOf(index)} 首领「${boss.name}」四周两格内没有能站的格`,
                    index,
                  );
                  break;
                }
                waypoint = { ...waypoint, cell: chosen.cell };
                log(
                  `${tagOf(index)} 首领「${boss.name}」在 ${cellText(target)}，` +
                    `去 ${cellText(chosen.cell)} 面朝${chosen.direction}`,
                );
              } else {
                log(`${tagOf(index)} 首领「${boss.name}」是触发格 ${cellText(target)}，走上去`);
              }
            }
          }
          let routePlan = await ports.planRoute(here, [waypoint], null);
          let reachable = routePlan.legs.some((leg) => leg.waypoint === waypoint.id);
          if (!reachable) {
            // Task 149 follow-up: a switch may have opened the wall the cached grid still has.
            // Only replan when a refresh actually happened; otherwise the old fallback path
            // (a fresh route) must stay in charge.
            if (await refreshCollisionAt(here.map)) {
              routePlan = await ports.planRoute(here, [waypoint], null);
              reachable = routePlan.legs.some((leg) => leg.waypoint === waypoint.id);
            }
          }
          if (!reachable) {
            const why = routePlan.unreachable.map((entry) => entry.reason).join("；");
            const note = `走不到:${why === "" ? "路线里没有这一站" : why}`;
            if (station.optional === true) {
              await skipStation(index, note);
              continue;
            }
            const vehicles = targetNow?.map === 1 || here.map === 1 ? await vehicleText() : "";
            fail("unreachable", `第 ${index + 1} 站「${station.to}」${note}${vehicles}`, index);
            break;
          }
          const budget = Math.max(0, Math.min(deadline - Date.now(), stationBudget));
          const runOptions: RouteRunOptions = {
            signal,
            timeBudgetMs: budget,
            maxWaypointFailures: 2,
            waypoints: [waypoint],
          };
          const battlesAtStation = ports.battleCount();
          const stationStarted = Date.now();
          const result = await executeRoute(routePlan, portsForRoute(), runOptions);
          await refresh();
          if (failed()) break;
          if (Date.now() - stationStarted > stationBudget && result.reason !== "aborted") {
            let where = "场面读不到";
            try {
              const scene = await ports.scene?.();
              if (scene !== undefined) where = sceneText(scene);
            } catch {
              // Keep the station's own result text.
            }
            fail(
              "stuck",
              `第 ${index + 1} 站超过 ${Math.round(stationBudget / 1000)} 秒，停在${where}:${result.message}`,
              index,
            );
            break;
          }
          if (result.replans > 0) log(`${tagOf(index)} 重排 ${result.replans} 次`);
          const fought = Math.max(0, ports.battleCount() - battlesAtStation);
          if (fought > 0) log(`${tagOf(index)} 普通战斗 ${fought} 场`);
          if (result.reason !== "completed") {
            log(`${tagOf(index)} 路线结果(${result.reason}):${result.message}`);
          }
          const reached = await ports.position();
          if (reached !== null)
            log(`${tagOf(index)} 到达 地图 ${reached.map} ${cellText(reached.cell)}`);
          // Task 145: the walk may have entered the exit's map and stopped there; that is arrival.
          if (enteredExit !== null && reached?.map === enteredExit.toMap) {
            const evidence =
              station.do === "story" ||
              station.do === "talk" ||
              station.do === "switch" ||
              station.do === "choose"
                ? "；证据:地图变了"
                : "";
            const note = `${exitNote(enteredExit)}${evidence}`;
            if (await completeStation(index, note)) {
              if (await turnBack()) break;
              continue;
            }
            break;
          }
          const partyAfter = partySignature(seen());
          const partyChanged =
            partyBefore !== null && partyAfter !== null && partyBefore !== partyAfter;
          // 11-11 (new game, cave 193): compare with the start map too. A failed walk that never
          // left 193 was read as "the story moved us" because 193 is not the target map 194.
          const mapMoved =
            reached !== null &&
            targetNow !== null &&
            reached.map !== targetNow.map &&
            reached.map !== here.map;
          if (scriptMarks.has("story")) stationEvidence.add("对话/剧情");
          if (partyChanged) stationEvidence.add("队伍入离队");
          if (mapMoved) stationEvidence.add("地图变了");
          if (scriptMovedAt.size > 0) stationEvidence.add("脚本移动");
          try {
            const scene = await ports.scene?.();
            if (scene?.battle === true) stationEvidence.add("开战");
          } catch {
            // The action's own evidence still decides.
          }
          if (
            scriptTarget &&
            result.reason !== "decision" &&
            result.reason !== "gameover" &&
            result.reason !== "aborted" &&
            (scriptMarks.has("story") || scriptMovedAt.size > 0 || mapMoved || partyChanged)
          ) {
            const evidence = [...stationEvidence].join("、");
            const note =
              station.do === "story" && scriptMarks.has("story")
                ? `路上播了剧情${evidence === "" ? "" : `；证据:${evidence}`}`
                : reached === null
                  ? `剧情把队伍带走了，位置读不到；证据:${evidence}`
                  : `剧情把人带到了 地图 ${reached.map} ${cellText(reached.cell)}；证据:${evidence}`;
            log(`${tagOf(index)} ${note}`);
            if (await completeStation(index, note)) {
              if (await turnBack()) break;
              continue;
            }
            break;
          }
          if (
            station.do === "story" &&
            targetNow?.cell === null &&
            ports.storyTrigger !== undefined
          ) {
            // Task 161: several active story entities are not an error any more. The port
            // sorts by name match (knowledge item aliases), scene number and cell; here we
            // then prefer the shortest walk within the same rank and try each one.
            const hint = [station.why ?? "", plan.goal]
              .map((line) => line.trim())
              .filter((line) => line !== "")
              .join("；");
            const trigger = await ports.storyTrigger(targetNow.map, hint);
            const candidates: PlanStoryCandidate[] =
              trigger.candidates !== undefined && trigger.candidates.length > 0
                ? [...trigger.candidates]
                : trigger.count === 1 && trigger.cell !== null
                  ? [
                      {
                        cell: trigger.cell,
                        name: trigger.name,
                        script: storyScriptNumber(trigger.name),
                        kind: "event",
                        matched: false,
                      },
                    ]
                  : [];
            if (candidates.length === 0) {
              log(
                `${tagOf(index)} 这张图没有读到剧情触发点` +
                  `${trigger.count > 1 ? `（${trigger.count} 个但读不到候选）` : ""}，先按方向探索`,
              );
            }
            const here = await ports.position();
            if (here === null) {
              fail("stuck", "读不到当前位置，没法试剧情触发点", index);
              break;
            }
            interface StoryTry {
              readonly candidate: PlanStoryCandidate;
              readonly route: Awaited<ReturnType<ExecutePorts["planRoute"]>>;
              readonly stand: Cell;
              readonly waypoint: Waypoint;
              readonly minutes: number;
            }
            const tries: StoryTry[] = [];
            for (const candidate of candidates) {
              const stands =
                candidate.kind === "npc"
                  ? bossSides(candidate.cell).map((side) => side.cell)
                  : [candidate.cell];
              let best: StoryTry | null = null;
              for (const stand of stands) {
                const waypoint: Waypoint = {
                  id: `story-${index}-${candidate.cell[0]}-${candidate.cell[1]}-${stand[0]}-${stand[1]}`,
                  kind: "move",
                  map: targetNow.map,
                  cell: stand,
                  label:
                    candidate.name === ""
                      ? `剧情触发点 (${candidate.cell[0]},${candidate.cell[1]})`
                      : `剧情触发点「${candidate.name}」`,
                  reach: "cell",
                };
                try {
                  const route = await ports.planRoute(here, [waypoint], null);
                  if (!route.legs.some((leg) => leg.waypoint === waypoint.id)) continue;
                  if (best === null || route.total.minutes < best.minutes) {
                    best = { candidate, route, stand, waypoint, minutes: route.total.minutes };
                  }
                  if (candidate.kind === "event") break;
                } catch (error) {
                  log(
                    `${tagOf(index)} 估算去剧情触发点 ${cellText(candidate.cell)} 出错:${errorText(error)}`,
                  );
                }
              }
              if (best !== null) tries.push(best);
            }
            tries.sort(
              (left, right) =>
                Number(right.candidate.matched) - Number(left.candidate.matched) ||
                (left.candidate.script ?? Number.MAX_SAFE_INTEGER) -
                  (right.candidate.script ?? Number.MAX_SAFE_INTEGER) ||
                left.minutes - right.minutes,
            );
            log(
              `${tagOf(index)} 剧情站候选(名字/场景号/路程):` +
                tries
                  .map((entry) => {
                    const why = entry.candidate.matched
                      ? "名字对上"
                      : entry.candidate.script === null
                        ? "场景号不明"
                        : `场景 ${entry.candidate.script}`;
                    return (
                      `${cellText(entry.candidate.cell)}「${entry.candidate.name || "无名"}」` + why
                    );
                  })
                  .join("、"),
            );
            const gatherStoryEvidence = async (
              expected: { readonly map: number; readonly cell: Cell },
              beforeParty: string | null,
              start: { readonly map: number; readonly cell: Cell } | null,
              reachedExpected: boolean,
            ): Promise<string[]> => {
              await refresh();
              const after = seen();
              const now = await ports.position();
              if (scriptMarks.has("story")) stationEvidence.add("对话/剧情");
              if (beforeParty !== null && partySignature(after) !== beforeParty) {
                stationEvidence.add("队伍入离队");
              }
              const nearStart =
                start !== null &&
                now !== null &&
                now.map === start.map &&
                Math.abs(now.cell[0] - start.cell[0]) + Math.abs(now.cell[1] - start.cell[1]) < 3;
              // Task 162: a script move is only evidence when the walk really reached the
              // trigger (or its Npc side) and the party did not just get pushed back near the
              // start. 11-11 live: a wrong trigger pushed the party 2 cells and was "done".
              if (
                reachedExpected &&
                !nearStart &&
                now !== null &&
                (now.map !== expected.map || !sameCell(now.cell, expected.cell))
              ) {
                stationEvidence.add("脚本移动");
              }
              if (now !== null && now.map !== expected.map) stationEvidence.add("地图变了");
              try {
                const scene = await ports.scene?.();
                if (scene?.battle === true) stationEvidence.add("开战");
                if (scene !== undefined && storyScene(scene)) {
                  scriptMarks.add("story");
                  stationEvidence.add("对话/剧情");
                }
              } catch {
                // The walk and interaction evidence above still decides.
              }
              return [...stationEvidence];
            };
            let completed = false;
            let terminal = false;
            const tried: string[] = [];
            for (const entry of tries) {
              if (aborted || failed()) break;
              stationEvidence.clear();
              scriptMarks.clear();
              scriptMovedAt.clear();
              const beforeParty = partySignature(seen());
              log(
                `${tagOf(index)} 试剧情触发点 ${cellText(entry.candidate.cell)}` +
                  `「${entry.candidate.name || "无名"}」` +
                  (entry.candidate.matched
                    ? "(why 名字对上)"
                    : entry.candidate.script === null
                      ? ""
                      : `(场景 ${entry.candidate.script})`),
              );
              const budget = Math.max(0, Math.min(deadline - Date.now(), stationBudget));
              const result = await executeRoute(entry.route, portsForRoute(), {
                signal,
                timeBudgetMs: budget,
                maxWaypointFailures: 1,
                waypoints: [entry.waypoint],
              });
              const reachedAfterWalk = await ports.position();
              const reachedExpected =
                reachedAfterWalk !== null &&
                reachedAfterWalk.map === targetNow.map &&
                sameCell(reachedAfterWalk.cell, entry.stand);
              await refresh();
              if (result.reason === "aborted") {
                aborted = true;
                terminal = true;
                break;
              }
              if (result.reason === "gameover") {
                const recovered = await ports.recoverGameover();
                fail("gameover", `${result.message}；${recovered.text}`, index);
                terminal = true;
                break;
              }
              let scene = await ports.scene?.();
              if (scene !== undefined && storyScene(scene)) {
                scriptMarks.add("story");
                const advanced = await ports.story();
                if (advanced.decision !== undefined && advanced.decision.trim() !== "") {
                  const answered = await answerChoice(advanced.decision);
                  if (answered !== null) log(`${tagOf(index)} 剧情选项按计划选:${answered.text}`);
                }
                scene = await ports.scene?.();
              }
              let evidence = await gatherStoryEvidence(
                { map: targetNow.map, cell: entry.stand },
                beforeParty,
                here,
                reachedExpected,
              );
              if (evidence.length === 0) {
                const acted = await ports.interact(entry.candidate.cell);
                for (const line of acted.evidence ?? []) stationEvidence.add(line);
                log(
                  `${tagOf(index)} 调查剧情触发点 ${cellText(entry.candidate.cell)}:${acted.text}`,
                );
                if (acted.decision !== undefined && acted.decision.trim() !== "") {
                  const answered = await answerChoice(acted.decision);
                  if (answered !== null) log(`${tagOf(index)} 剧情选项按计划选:${answered.text}`);
                }
                evidence = await gatherStoryEvidence(
                  { map: targetNow.map, cell: entry.stand },
                  beforeParty,
                  here,
                  reachedExpected,
                );
              }
              if (evidence.length > 0) {
                const reason = entry.candidate.matched
                  ? "名字对上"
                  : entry.candidate.script === null
                    ? "按候选顺序"
                    : `场景号 ${entry.candidate.script}`;
                const note =
                  entry.candidate.kind === "npc"
                    ? `调查剧情 NPC ${cellText(entry.candidate.cell)}` +
                      `「${entry.candidate.name || "无名"}」(${reason})；证据:${evidence.join("、")}`
                    : `踩了剧情触发点 ${cellText(entry.candidate.cell)}` +
                      `「${entry.candidate.name || "无名"}」(${reason})；证据:${evidence.join("、")}`;
                log(`${tagOf(index)} ${note}`);
                completed = await completeStation(index, note);
                if (!completed || (await turnBack())) terminal = true;
                break;
              }
              tried.push(`${cellText(entry.candidate.cell)}「${entry.candidate.name || "无名"}」`);
            }
            if (terminal) break;
            const exploreStep = ports.exploreStoryStep;
            if (!completed && exploreStep !== undefined) {
              // Task 162: no candidate worked. Walk one safe step at a time toward the
              // direction in why/goal (then the next station), checking for story evidence
              // after every step. The budget is Config's storyExploreMinutes (default 3 min).
              const start = await ports.position();
              if (start !== null) {
                const end =
                  Date.now() + (options.storyExploreBudgetMs ?? DEFAULT_STORY_EXPLORE_MS);
                const nextTarget = parseTarget(plan.stations[index + 1]?.to ?? "");
                const nextDirection =
                  nextTarget !== null && nextTarget.cell !== null && nextTarget.map === start.map
                    ? directionToward(start.cell, nextTarget.cell)
                    : null;
                const directions = [
                  ...new Set([
                    ...storyDirectionsIn(`${station.why ?? ""} ${plan.goal}`),
                    ...(nextDirection === null ? [] : [nextDirection]),
                    ...STORY_DIRECTIONS,
                  ]),
                ];
                const beforeParty = partySignature(seen());
                const storyTrigger = ports.storyTrigger;
                const followEventMap = async (entryMap: number): Promise<number> => {
                  let currentMap = entryMap;
                  for (
                    let guard = 0;
                    guard < 24 &&
                    Date.now() < end &&
                    currentMap !== targetNow.map &&
                    !aborted &&
                    !failed();
                    guard += 1
                  ) {
                    const trigger = await storyTrigger(currentMap, hint);
                    const storyCandidates: PlanStoryCandidate[] =
                      trigger.candidates !== undefined && trigger.candidates.length > 0
                        ? [...trigger.candidates]
                        : trigger.count === 1 && trigger.cell !== null
                          ? [
                              {
                                cell: trigger.cell,
                                name: trigger.name,
                                script: storyScriptNumber(trigger.name),
                                kind: "event",
                                matched: false,
                              },
                            ]
                          : [];
                    if (storyCandidates.length === 0) break;
                    let progressed = false;
                    for (const candidate of storyCandidates) {
                      const at = await ports.position();
                      if (at === null || at.map !== currentMap) break;
                      const stands =
                        candidate.kind === "npc"
                          ? bossSides(candidate.cell).map((side) => side.cell)
                          : [candidate.cell];
                      let best: {
                        readonly route: Awaited<ReturnType<ExecutePorts["planRoute"]>>;
                        readonly waypoint: Waypoint;
                        readonly stand: Cell;
                      } | null = null;
                      for (const stand of stands) {
                        const waypoint: Waypoint = {
                          id: `event-map-${currentMap}-${candidate.cell[0]}-${candidate.cell[1]}-${stand[0]}-${stand[1]}`,
                          kind: "move",
                          map: currentMap,
                          cell: stand,
                          label: `事件图触发点「${candidate.name || "无名"}」`,
                          reach: "cell",
                        };
                        const route = await ports.planRoute(at, [waypoint], null);
                        if (!route.legs.some((leg) => leg.waypoint === waypoint.id)) continue;
                        best = { route, waypoint, stand };
                        if (candidate.kind === "event") break;
                      }
                      if (best === null) continue;
                      const budget = Math.max(
                        0,
                        Math.min(end - Date.now(), stationBudget),
                      );
                      const result = await executeRoute(best.route, portsForRoute(), {
                        signal,
                        timeBudgetMs: budget,
                        maxWaypointFailures: 1,
                        waypoints: [best.waypoint],
                      });
                      await refresh();
                      if (result.reason === "aborted") {
                        aborted = true;
                        return currentMap;
                      }
                      if (result.reason === "gameover") {
                        const recovered = await ports.recoverGameover();
                        fail("gameover", `${result.message}；${recovered.text}`, index);
                        return currentMap;
                      }
                      let scene = await ports.scene?.();
                      if (scene !== undefined && storyScene(scene)) {
                        scriptMarks.add("story");
                        const advanced = await ports.story();
                        if (
                          advanced.decision !== undefined &&
                          advanced.decision.trim() !== ""
                        ) {
                          const answered = await answerChoice(advanced.decision);
                          if (answered !== null) {
                            log(`${tagOf(index)} 事件图选项按计划选:${answered.text}`);
                          }
                        }
                        scene = await ports.scene?.();
                      }
                      if (!(await settleScene(index, "事件图"))) return currentMap;
                      const now = await ports.position();
                      if (now !== null) currentMap = now.map;
                      progressed = true;
                      if (currentMap === targetNow.map) break;
                    }
                    if (!progressed) break;
                  }
                  return currentMap;
                };
                let explored = false;
                for (const direction of directions) {
                  while (!explored && !aborted && !failed() && Date.now() < end) {
                    let step: PlanExploreStep;
                    try {
                      step = await exploreStep(targetNow.map, direction);
                    } catch (error) {
                      log(`${tagOf(index)} 朝${direction}探索出错:${errorText(error)}`);
                      break;
                    }
                    if (!step.moved) {
                      log(`${tagOf(index)} 朝${direction}探索:${step.reason}`);
                      break;
                    }
                    log(
                      `${tagOf(index)} 朝${direction}探索到 地图 ${step.map} ` +
                        `${cellText(step.cell)}:${step.reason}`,
                    );
                    if (step.map !== targetNow.map) {
                      const back = await followEventMap(step.map);
                      if (back !== targetNow.map) {
                        log(`${tagOf(index)} 事件图剧情走完仍在地图 ${back}，先停`);
                        break;
                      }
                      stationEvidence.add("地图变了");
                      stationEvidence.add("剧情走过事件图");
                    }
                    let scene = await ports.scene?.();
                    if (scene !== undefined && storyScene(scene)) {
                      scriptMarks.add("story");
                      const advanced = await ports.story();
                      if (
                        advanced.decision !== undefined &&
                        advanced.decision.trim() !== ""
                      ) {
                        const answered = await answerChoice(advanced.decision);
                        if (answered !== null) {
                          log(`${tagOf(index)} 探索剧情选项按计划选:${answered.text}`);
                        }
                      }
                      scene = await ports.scene?.();
                    }
                    const evidence = await gatherStoryEvidence(
                      { map: step.map, cell: step.cell },
                      beforeParty,
                      start,
                      true,
                    );
                    if (evidence.length > 0) {
                      const note =
                        `朝${direction}探索到 地图 ${step.map} ${cellText(step.cell)}` +
                        `；证据:${evidence.join("、")}；${step.reason}`;
                      log(`${tagOf(index)} ${note}`);
                      explored = await completeStation(index, note);
                      if (!explored || (await turnBack())) terminal = true;
                      break;
                    }
                  }
                  if (explored || terminal || aborted || failed()) break;
                }
                completed = explored && !terminal;
              }
            }
            if (terminal) break;
            if (completed) continue;
            if (aborted || failed()) break;
            fail(
              "stuck",
              `剧情站「${station.to}」的 ${tries.length} 个触发点都试过，` +
                `朝 ${storyDirectionsIn(`${station.why ?? ""} ${plan.goal}`).join("、") || "各方向"} ` +
                `探索也没拿到对话/入队/换图/脚本移动/开战的证据` +
                (tried.length === 0 ? "" : `:${tried.join("、")}`),
              index,
            );
            break;
          }
          const actionSkip = actionSkips.get(index);
          if (actionSkip !== undefined) {
            actionSkips.delete(index);
            await skipStation(index, actionSkip);
            if (await turnBack()) break;
            continue;
          }
          const needsEffectEvidence =
            options.manageLayers !== false &&
            (station.do === "story" ||
              station.do === "talk" ||
              station.do === "switch" ||
              station.do === "choose");
          if (
            needsEffectEvidence &&
            stationEvidence.size === 0 &&
            result.reason !== "decision" &&
            result.reason !== "gameover" &&
            result.reason !== "aborted"
          ) {
            const at = reached?.cell ?? targetNow?.cell ?? here.cell;
            fail(
              "stuck",
              station.do === "story"
                ? `到了 (${at[0]},${at[1]}) 附近，剧情没有触发(没有对话、没有入队、地图没变)`
                : `第 ${index + 1} 站到了 (${at[0]},${at[1]}) 附近，但没有动作生效的证据`,
              index,
            );
            break;
          }
          if (result.reason === "completed") {
            if (station.do === "boss") {
              await finishBoss(index, station, waypoint);
              if (failed()) break;
              if (await turnBack()) break;
              continue;
            }
            const evidence = [...stationEvidence].join("、");
            const note =
              needsEffectEvidence && evidence !== ""
                ? `${station.why ?? "到达"}；证据:${evidence}`
                : (station.why ?? "到达");
            if (await completeStation(index, note)) {
              if (await turnBack()) break;
              continue;
            }
            break;
          }
          if (result.reason === "decision") {
            if (station.do === "boss") {
              // A boss halt names the boss; anything else is a story choice met on the way.
              if (!result.message.includes("首领")) {
                const answered = await answerChoice(result.message);
                if (answered !== null) {
                  log(`${tagOf(index)} 开战前剧情选项已按计划选，重走这一站`);
                  index = Math.max(startAt, index - 1);
                  continue;
                }
              }
              const at = await ports.position();
              if (at !== null) log(`${tagOf(index)} 到达 地图 ${at.map} ${cellText(at.cell)}`);
              await finishBoss(index, station, waypoint);
              if (failed()) break;
              if (await turnBack()) break;
              continue;
            }
            const answered = await answerChoice(result.message);
            if (answered !== null) {
              const tries = (attempt.get(index) ?? 0) + 1;
              attempt.set(index, tries);
              if (tries <= 2) {
                emitFallback("retry", `剧情选项已按计划选，重走这一站:${result.message}`, index);
                log(`第 ${index + 1} 站剧情选项已按计划选，重走这一站`);
                index = Math.max(startAt, index - 1);
                continue;
              }
            }
            fail(
              "story-choice",
              await choiceProblem(`第 ${index + 1} 站「${station.to}」:${result.message}`),
              index,
            );
            break;
          }
          if (result.reason === "gameover") {
            const recovered = await ports.recoverGameover();
            fail("gameover", `${result.message}；${recovered.text}`, index);
            break;
          }
          if (result.reason === "aborted") {
            aborted = true;
            break;
          }
          if (result.reason === "unreachable" || result.reason === "replan-limit") {
            if (station.do === "boss") {
              log(`${tagOf(index)} 这一侧没走到，换首领旁边别的格`);
              await finishBoss(index, station, waypoint);
              if (failed()) break;
              if (await turnBack()) break;
              continue;
            }
            if (station.optional === true) {
              await skipStation(index, `走不到:${result.message}`);
              continue;
            }
            const vehicles = targetNow?.map === 1 || here.map === 1 ? await vehicleText() : "";
            fail(
              "unreachable",
              `第 ${index + 1} 站「${station.to}」:${result.message}${vehicles}`,
              index,
            );
            break;
          }
          if (result.reason === "time-budget") {
            let where = "场面读不到";
            try {
              const scene = await ports.scene?.();
              if (scene !== undefined) where = sceneText(scene);
            } catch {
              // Keep the route's own timeout message.
            }
            fail("stuck", `第 ${index + 1} 站超时，停在${where}:${result.message}`, index);
            break;
          }
          if (station.do === "boss") {
            log(`${tagOf(index)} 走到首领旁边时没做成，换别的格再试`);
            await finishBoss(index, station, waypoint);
            if (failed()) break;
            if (await turnBack()) break;
            continue;
          }
          if (station.optional === true) {
            await skipStation(index, result.message);
            continue;
          }
          fail("stuck", `第 ${index + 1} 站「${station.to}」没做成:${result.message}`, index);
          break;
        }
      }
    }
    if (signal?.aborted === true) aborted = true;
    // Task 145/152: a battle or cutscene started by the last station must not outlive the
    // segment, even when the segment is already returning an exception for the chapter.
    if (!aborted) await settleScene(null, "段末", true);
    logRemainingPurchases();
  } catch (error) {
    if (signal?.aborted === true || errorName(error) === "AbortError") {
      aborted = true;
      log("执行被打断(网页重启或取消)");
    } else {
      fail("other", `执行器出错:${errorText(error)}`);
    }
  } finally {
    if (battlesStarted) {
      try {
        await ports.endBattles();
      } catch (error) {
        log(`收战斗表时出错:${String(error)}`);
      }
    }
    if (exception !== undefined && !aborted) {
      const at = exception.station;
      if (at !== null && !done.has(at)) {
        await mark(at, "failed", `第 ${at + 1} 站 失败(${exception.kind}):${exception.detail}`);
      }
    }
    try {
      await ports.finishProgress(
        aborted ? "aborted" : exception === undefined ? "done" : "exception",
      );
    } catch (error) {
      log(`进度收尾没写成:${String(error)}`);
    }
    if (options.manageLayers !== false && ports.end !== undefined) {
      try {
        await ports.end();
      } catch (error) {
        log(`恢复模型层时出错:${String(error)}`);
      }
    }
  }

  if (signal?.aborted === true) aborted = true;
  // The final observation also refreshes the bestiary flags, so the report counts this run.
  await refresh(true);
  const after = seen();
  const bestiaryBefore = new Set((before?.bestiary ?? []).map((entry) => entry.number));
  const names = new Map(
    (after?.bestiary ?? []).map((entry) => [entry.number, entry.name] as const),
  );
  const bestiaryNew = (after?.bestiary ?? [])
    .filter((entry) => !bestiaryBefore.has(entry.number))
    .map((entry) => names.get(entry.number) || `#${entry.number}`);
  const blueBefore = new Set(before?.blueMagic ?? []);
  const blueMagicNew = (after?.blueMagic ?? []).filter((name) => !blueBefore.has(name));
  const chests =
    before?.chestsOpened !== null &&
    before?.chestsOpened !== undefined &&
    after?.chestsOpened !== null &&
    after?.chestsOpened !== undefined
      ? Math.max(0, after.chestsOpened - before.chestsOpened)
      : [...done].filter((index) => plan.stations[index]?.do === "open").length;
  const battles = Math.max(0, (after?.battles ?? battlesBefore) - battlesBefore) + bossFights;
  let leaveLines: readonly string[] = [];
  try {
    leaveLines = (await ports.leaveNotes?.()) ?? [];
  } catch (error) {
    log(`读离开时缺的东西出错:${String(error)}`);
  }
  const reportExtra = [...new Set([...reportNotes, ...leaveLines])].filter((line) => line !== "");
  const party = [partyLine(after), ...reportExtra].filter((line) => line !== "").join("；");
  const remaining = plan.stations
    .map((_station, index) => index)
    .filter((index) => !done.has(index));
  const fullDetail =
    exception === undefined
      ? ""
      : prepNotes.length === 0
        ? exception.detail
        : `${exception.detail}；准备:${prepNotes.join("；")}`;
  // Task 141: the report keeps one readable paragraph; the whole text goes to the run log.
  const detail =
    Array.from(fullDetail).length <= 500
      ? fullDetail
      : `${Array.from(fullDetail).slice(0, 500).join("")}…(完整见日志)`;
  if (detail !== fullDetail) log(`例外全文(${exception?.kind ?? "?"}):${fullDetail}`);
  log(
    `段「${plan.section}」结束:${aborted ? "中止" : exception === undefined ? "完成" : `例外(${exception.kind})`};` +
      `完成 ${done.size}/${plan.stations.length} 站，用时 ${roundedMinutes(started)} 分`,
  );
  const status = aborted ? "aborted" : exception === undefined ? "done" : "exception";
  const report: SegmentReport = {
    section: plan.section,
    status,
    ...(exception === undefined ? {} : { exception: { ...exception, detail } }),
    done: {
      stations: done.size,
      chestsOpened: chests,
      battles,
      bestiaryNew,
      blueMagicNew,
      bossesWon,
    },
    remaining,
    party,
    minutes: roundedMinutes(started),
    modelCalls: ports.modelCalls?.() ?? 0,
  };
  if (runLifecycle) {
    emitRun({
      type: "run.end",
      status,
      station: exception?.station ?? null,
      ms: Math.max(0, Date.now() - started),
      fallbacks: fallbackCount,
      modelCalls: report.modelCalls,
      battles: report.done.battles,
      note: exception?.detail ?? (aborted ? "执行被打断" : undefined),
    });
  }
  return report;
}

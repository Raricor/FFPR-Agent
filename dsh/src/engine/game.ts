/**
 * The tool side of the DeepSeek player: runs each tool through the skills and describes what
 * the player sees afterwards. Notes the model keeps survive between runs. Ported from
 * ffpr_agent/ds/game.py; control plan §4.8–§4.11 and §10.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Laptop } from "./laptop.ts";
import { MonsterCache, monsterStatus } from "./bestiary.ts";
import {
  MonsterAiCache,
  monsterAiPath,
  partySnapshot,
  readBag,
  readParty,
  type BagInfo,
  type DossierInput,
  type PartyMember,
} from "./dossier.ts";
import { BestiarySave } from "./bestiary-save.ts";
import { missedTreasureByArea, parseAchievements, progressRows } from "./achievements.ts";
import {
  Backlog,
  Incidents,
  backlogLines,
  completionLine,
  completionState,
  completionWhere as whereOf,
  incidentLines,
  isComplete,
  isStoryEventName,
  missingLines,
  parseTreasureEntities,
  regionLines,
  timedLine,
  type CompletionMonster,
  type CompletionState,
  type EncounterStatus,
} from "./completion.ts";
import {
  EncounterGridCache,
  activeParties,
  encounterMonsters,
  parseEncounters,
} from "./encounters.ts";
import type { EncounterTable } from "./encounters.ts";
import { parsePositionReply } from "./position.ts";
import { profileFor } from "./profiles/index.ts";
import { Atlas } from "./atlas.ts";
import { AtlasSave } from "./atlas-save.ts";
import { CollisionStore } from "./regions.ts";
import {
  BattleLog,
  battleUnits,
  gapText,
  type BattleGap,
  type BattleRecord,
} from "./battle-record.ts";
import { Elements } from "./elements.ts";
import { byKey } from "./games.ts";
import { DEPS } from "./paths.ts";
import {
  areaOf,
  buildFacts,
  chooseTrigger,
  dossierForTrigger,
  isTown,
  type FactsTrigger,
  type TacticianCall,
  type TacticianPlan,
  type TacticianRunner,
  type TriggerReason,
} from "./facts.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { cleanName } from "./icons.ts";
import { KeyEvents } from "./events.ts";
import { Guide } from "./guide/kb.ts";
import { MAX_NOTES, loadNotes } from "./notes.ts";
import type { Pilot } from "./pilot.ts";
import { describeBattle, FLOOR_MARKS, renderFloor, renderTerrain } from "./prompt.ts";
import { placeName } from "./status.ts";
import { Tactics } from "./tactics.ts";
import { firstSentence, oneLine as tacticianOneLine, TacticianLog } from "./tactician-log.ts";
import {
  isRecord,
  list,
  num,
  pyRound,
  record,
  records,
  text,
  truthy,
  type Json,
} from "./values.ts";
import * as gambit from "./skills/gambit.ts";
import { mentionedSkills } from "./strategy/execute.ts";
import { checkStrategy } from "./strategy/strategy.ts";
import { coverageProblems, partyChangedProblem } from "./coverage.ts";
import * as menu from "./skills/menu.ts";
import * as move from "./skills/move.ts";
import * as battle from "./skills/battle.ts";
import type { BattleHooks } from "./skills/battle.ts";
import type { MoveState } from "./skills/move.ts";
import * as save from "./skills/save.ts";
import { recoverFromGameover, type GameoverResult } from "./skills/gameover.ts";
import * as screens from "./skills/screens.ts";
import * as shop from "./skills/shop.ts";
import * as grind from "./skills/grind.ts";
import * as travel from "./skills/travel.ts";
import { cursorPath, stateScript, parseState } from "./state-script.ts";
import { analyzeRoute } from "./route/analyze.ts";
import { executeRoute, resumeRoute, type RoutePorts, type RouteWatch } from "./route/execute.ts";
import { readProgress } from "./route/state.ts";
import {
  DEFAULT_ROUTE_BATTLE_SECONDS,
  ROUTE_ENCOUNTER_CELLS,
  parseGameover,
  parseRouteEnd,
  parseRouteStop,
  parseRouteTimer,
  resolveRouteStop,
  targetCell,
  type RouteStopInput,
} from "./route/tool.ts";
import type { Waypoint } from "./route/types.ts";
import {
  describeScout,
  planScout,
  type ScoutEntity,
  type ScoutPlan,
  type ScoutTarget,
} from "./scout/explore.ts";
import { scoutSaveGuard } from "./scout/save-guard.ts";
import {
  defaultProgressFiles,
  restoreSnapshot,
  ScoutWindows,
  scoutWindowsFile,
  takeSnapshot,
  type Snapshot,
} from "./scout/snapshot.ts";
import { loadSlotFromMenu, SCOUT_SLOT } from "./skills/load.ts";
import {
  BookProgressStore,
  bookStatsLine,
  handoffText,
  routeFromBookSection,
  type BookPlanOptions,
} from "./stage/book-plan.ts";
import { buildStageFacts, describeStageFacts, stageTargetMapIds } from "./stage/facts.ts";
import {
  MAX_RECOVERY_DISTANCE,
  departureCheck,
  turnBackCheck,
  type AheadPoint,
  type StageTravelState,
} from "./stage/gate.ts";
import {
  isOtherRegionDungeon,
  mapPlace,
  placeName as stagePlaceName,
  resolveStageTarget,
  sameRegion,
  sameStageTarget,
  targetForMap,
  type MapPlace,
} from "./stage/places.ts";
import { purchaseList, type ShopHere } from "./stage/purchase.ts";
import { describeStagePlan } from "./stage/report.ts";
import type { StageOfficerRunner } from "./stage/runner.ts";
import { StagePlanStore, type StagePlanRecord, type StageStats } from "./stage/store.ts";
import type {
  StageBossPartyMember,
  StageBossTable,
  StageFacts,
  StagePlan,
  StageTarget,
} from "./stage/types.ts";
import {
  loadRouteBook,
  readLearnedPoints,
  readVisitOrder,
  selectSectionIndex,
  writeLearnedPoint,
  type LearnedPoint,
  type RouteBookRuntime,
} from "./stage/route-book-load.ts";
import type { RouteBook, RouteSection } from "./stage/route-book.ts";
import {
  bossMapIds,
  loadKnowledge,
  normalizeName,
  shopsNear,
  type Knowledge,
} from "./knowledge/index.ts";
import { applyWalkPush, type WalkView } from "./walk-view.ts";
import * as nav from "./nav.ts";
import type { Cell } from "./nav.ts";
import * as view from "./view.ts";

export const GEAR: ReadonlySet<string> = new Set(["Weapon", "Armor"]); // bridge 0.6.8
export const WORLD_EXIT = "ワールドマップ"; // events by this name take the party out to the world map
export const TOWN_WORDS: readonly string[] = ["宿屋", "武器", "防具", "魔法屋", "道具屋"];

/**
 * Two rewrites per boss battle: one form change and one "no damage" are the usual pair, and
 * every rewrite freezes the table for the ten-plus seconds the tactician takes while the ATB
 * keeps hitting the party. A third would mostly spend the battle in 防御 (task 34). The opening
 * call (task 51) does not hold the battle and does not use one of these slots.
 */
export const MAX_BOSS_REWRITES = 2;
/** Three attacks in a row that leave the boss's HP alone mean the table is not working. */
export const BOSS_NO_DAMAGE_TURNS = 3;
/** Task 86: the road-trigger gap's default, also used by tests that never set the Config. */
export const DEFAULT_TACTICIAN_INTERVAL_MINUTES = 10;

// The guides name items in English; CURES names them as the Chinese game does.
const CURE_ITEM_EN: Readonly<Record<string, readonly string[]>> = {
  解毒药: ["Antidote"],
  眼药: ["Eye Drops"],
  金针: ["Gold Needle"],
  少女之吻: ["Maiden's Kiss"],
  木槌: ["Mallet"],
  回音草: ["Echo Herbs", "Echo Grass"],
};

/** The shop the guide says sells `item` in this area (where it is), or "" when it knows none. */
export function shopSelling(guide: Guide | null, area: string, item: string): string {
  if (guide === null || area === "" || item === "") return "";
  const aliases = CURE_ITEM_EN[item] ?? [item];
  for (const section of guide.sectionsFor(area).slice(0, 1)) {
    for (const table of section.shops ?? []) {
      const sells = table.goods.some((good) =>
        aliases.some((alias) => good.name.toLowerCase().includes(alias.toLowerCase())),
      );
      if (sells) return table.where || section.title;
    }
  }
  return "";
}

export interface GameOptions {
  readonly laptop: Laptop;
  readonly game: string;
  /** save_game writes this slot and a wipe loads it; slot 20 for all six games (10-29). */
  readonly saveSlot: number;
  readonly notesFile?: string;
  readonly events?: KeyEvents;
  readonly atlasFile?: string;
  /** Task 75: collision cache directory; defaults beside atlasFile as collision-<game>. */
  readonly collisionDir?: string;
  /**
   * Task 123: the game files' map export used for unvisited maps; defaults to
   * `.deps/knowledge/<game>/files/maps`. `null` turns the fallback off (synthetic tests).
   */
  readonly gameFilesDir?: string | null;
  /** Task 57: save-local visited maps; defaults next to atlasFile. Unset stays in memory. */
  readonly atlasSaveFile?: string;
  readonly tacticsFile?: string;
  readonly elementsFile?: string;
  /** JSONL battle records (task 36); unset keeps them in memory only (tests, previews). */
  readonly battlesFile?: string;
  /** JSONL tactician calls (task 40); unset keeps them in memory only. */
  readonly tacticianFile?: string;
  /** Task 45: deliberate incomplete departures, missed one-time chests, save-local bestiary. */
  readonly backlogFile?: string;
  readonly incidentsFile?: string;
  readonly incidentsStateFile?: string;
  readonly bestiarySaveFile?: string;
  /** Task 42: monster AI scripts, cached under .deps/ds/monsterai-<game>.json. */
  readonly monsterAiFile?: string;
  readonly signal?: AbortSignal;
  /** The second layer, when this build has one: facts in, a plan back. */
  readonly tactician?: TacticianRunner;
  /** Let the tactician write and the code fight a boss battle (default true). */
  readonly tacticianBoss?: boolean;
  /** Task 86: the least gap between two road triggers on one map, in minutes (default 10). */
  readonly tacticianIntervalMinutes?: number;
  /** Task 48: a map route/explore's hop and wall-clock caps (Config). */
  readonly travelMaxHops?: number;
  readonly travelMaxMinutes?: number;
  /** Task 68: until_bestiary's low-probability deferral and missable grinding caps. */
  readonly bestiaryDeferBattles?: number;
  readonly bestiaryMissableMinutes?: number;
  /** Task 58: the bridge walkpath's base timeout, blocked wait and turn lead (Config). */
  readonly walkpathTimeoutMs?: number;
  readonly walkpathBlockedMs?: number;
  readonly walkpathTurnLead?: number;
  /** Task 63: how often and how long a walkpath Event/dialog stop is watched for battle. */
  readonly walkpathEventPollMs?: number;
  readonly walkpathEventWaitMs?: number;
  /** Task 73: a "走不过去" record hit this many times is a wall and is not re-walked. */
  readonly blockedTrustCount?: number;
  /** Task 84: one go stops after the same carry twice or four carries in all (Config). */
  readonly carryRepeatLimit?: number;
  readonly carryTotalLimit?: number;
  /** Task 89: resumable route progress, one file per game (Config). */
  readonly routeFile?: string;
  /** Task 89: estimated seconds of one road battle in the countdown check (Config). */
  readonly routeBattleSeconds?: number;
  /** Task 91: after-battle HP/MP thresholds and reserve (Config). */
  readonly healHpPercent?: number;
  readonly healMpReservePercent?: number;
  readonly healItemHpPercent?: number;
  readonly healFullPercent?: number;
  /** Task 91: refuse a save under a running countdown with fewer seconds left (Config). */
  readonly saveTimerMinSeconds?: number;
  /** Task 91: stop a wait after this many seconds with no screen change (Config). */
  readonly storyStuckSeconds?: number;
  /** Task 97: the one stage plan file per game (Config). */
  readonly stagePlanFile?: string;
  /** Task 97: let the code call the stage officer on a town-to-dungeon move (Config). */
  readonly stageAutoPlan?: boolean;
  /** Task 101: refuse a coordinate `go` inside an active stage plan (Config, default on). */
  readonly stageGoGate?: boolean;
  /** Task 113: turn a refused coordinate `go` into following the plan (Config, default on). */
  readonly stageGoFollowPlan?: boolean;
  /** Task 113: after arriving, keep following the plan in the same go (Config, default on). */
  readonly stageContinueAfterTravel?: boolean;
  /** Task 97: how close a recovery point must be to keep walking (Config). */
  readonly stageTurnBackDistance?: number;
  /** Task 106: this many levels of change at a checkpoint rewrites the boss table (Config). */
  readonly stageBossLevelGap?: number;
  /** Task 117: route book executor switch, grind cap, progress and learned-coordinate files. */
  readonly routeBookEnabled?: boolean;
  readonly routeBookGrindMinutes?: number;
  /** Task 124: how many sections from the current one and the build's time budget (Config). */
  readonly routeBookAheadSections?: number;
  readonly routeBookTimeBudgetMs?: number;
  readonly routeBookProgressFile?: string;
  readonly routeBookLearnedFile?: string;
  /** Task 117: guide cache path and an injected book for tests and previews. */
  readonly routeBookGuideFile?: string;
  readonly routeBook?: RouteBook;
  /** A preloaded knowledge module (tests and previews); otherwise it loads on first use. */
  readonly knowledge?: Knowledge;
  /** The stage officer runner (the plugin supplies it; tests use a fake). */
  readonly stageOfficer?: StageOfficerRunner;
  /** Task 105: the snapshot/window directory and the scout's default limits (Config). */
  readonly scoutDir?: string;
  readonly scoutMinutes?: number;
  readonly scoutMaxTargets?: number;
}

interface HandlerResult {
  readonly text: string;
  /** The Python handler returned before settle/chart/hints (remember, guide, refusals). */
  readonly early?: boolean;
}

type ToolHandler = (args: Json, pilot: Pilot, signal?: AbortSignal) => Promise<HandlerResult>;

/** Task 105: why a scout stopped; the cleanup path and the report both read it. */
type ScoutEnd =
  "completed" | "time-budget" | "max-targets" | "gameover" | "aborted" | "decision" | "error";

/** How much map structure the scout had before and after; the report shows the difference. */
interface ScoutStats {
  readonly landings: number;
  readonly walks: number;
  readonly mechanisms: number;
  readonly blockedOnce: number;
}

interface ScoutRunState {
  readonly end: ScoutEnd;
  readonly note: string;
  readonly elapsedMs: number;
  readonly before: ScoutStats;
  readonly after: ScoutStats;
  readonly initial: ScoutPlan;
  readonly scouted: readonly ScoutTarget[];
  readonly failed: readonly string[];
}

const EARLY_GUIDE = "攻略知识库还没有准备好(要先运行 ffpr-guide fetch)";

/** Python's str() for values the messages embed, so a missing field reads "None". */
function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(([key, item]) => `'${key}': ${show(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** Python's int() for the values the model sends; a bad value is a tool error in Chinese. */
function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`不是整数:${show(value)}`);
  return Math.trunc(parsed);
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function matchesCell(left: Cell, right: Cell): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/**
 * Task 101: a coordinate `go`, including the route-only "map:x,y" spelling. `map` is null for
 * a bare cell, which means the current map; `go` itself only walks a cell on the current map.
 */
function goCellTarget(value: unknown): { readonly map: number | null; readonly cell: Cell } | null {
  if (typeof value === "string") {
    const match = /^(?:地图\s*)?(\d+)\s*:\s*(.+)$/u.exec(value.trim());
    if (match !== null) {
      const cell = targetCell(match[2]);
      const map = Number(match[1]);
      if (cell !== null && Number.isInteger(map) && map > 0) return { map, cell };
    }
  }
  const cell = targetCell(value);
  return cell === null ? null : { map: null, cell };
}

/** `navigate` stops on a story Event/dialog before the goal; the route pages it itself. */
function interruptedByStory(text: string): boolean {
  return /interrupted:(state:Event|dialog)|停在[^\n]*Event|停在[^\n]*dialog/u.test(text);
}

/** `openAt` reports these as text only; a route must not count them as done. */
function interactionFailed(text: string): boolean {
  return /^(没按成|走不到|地图还在切换|四周两格内都走不到|关不掉操作提示)/u.test(text.trim());
}

async function fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await readFile(path, { signal });
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    signal?.throwIfAborted();
    throw new Error(`读不了 ${path}:${describeError(error)}`, { cause: error });
  }
}

export async function saveNotes(path: string | undefined, notes: readonly string[]): Promise<void> {
  if (path === undefined) return;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify(notes, null, 1), "utf8");
  } catch (error) {
    throw new Error(`写不了笔记文件 ${path}:${describeError(error)}`, {
      cause: error,
    });
  }
}

/** One mid-battle rewrite: why it was asked for, whether a new table arrived, and its gist. */
export interface BossRewriteRecord {
  readonly reason: string;
  readonly ok: boolean;
  readonly summary: string;
}

/** What settle() keeps between turns of one boss battle (task 34). */
interface BossWatch {
  table: Json;
  /** Ids the table in use was written knowing; a living form outside this set is a rewrite. */
  readonly knownIds: Set<number>;
  /** Every id seen this battle, so a new table also knows the forms it came through. */
  readonly observedIds: Set<number>;
  latestEnemies: Json[];
  latestPlayers: Json[];
  readonly history: string[];
  noDamage: number;
  readonly rewrites: { reason: string; ok: boolean; summary: string }[];
  /** Skills the table mentions; an enemy's first other skill asks for a rewrite (task 41). */
  readonly mentioned: Set<string>;
  /** Enemy skills already seen this battle, so each one triggers at most once. */
  readonly seenSkills: Set<string>;
  /** How many bridge events have been read for the trigger. */
  eventIndex: number;
  /** Party HP after the previous turn, for the "lost over half in one round" trigger. */
  lastPartyHp: number;
  partyMaxHp: number;
  hpDropTriggered: boolean;
  gaps: readonly BattleGap[];
  pending: Promise<void> | null;
  abort: Error | null;
  /** Trigger rewrites already started; the opening call is not counted (task 51). */
  triggered: number;
  /** True while the opening call is in flight: the battle runs on instead of defending. */
  opening: boolean;
  /** The opening table arrived; the next turn's table read records which turn uses it. */
  openingArrived: boolean;
  /** The battle turn that first read the opening table, for the result text (task 51). */
  openingTurn: number | null;
  /** Turns whose table was read, so the opening table can name the turn it took over. */
  turnsRead: number;
}

/** Everything a background call needs, read while the tool call's pilot is still alive. */
interface TacticianFacts {
  readonly facts: string;
  readonly party: readonly PartyMember[];
  readonly bag: BagInfo;
  readonly dossier: DossierInput;
  readonly met: readonly string[];
}

/** One background rule-table write; `task` resolves after the table is installed or the call fails. */
interface BackgroundCall {
  readonly mapId: number;
  task: Promise<void>;
}

/** Older tests and previews return a plain plan promise; treat it as already published. */
function asTacticianCall(value: TacticianCall | Promise<TacticianPlan>): TacticianCall {
  if (value instanceof Promise) return { started: Promise.resolve(), result: value };
  return value;
}

/** The last boss table a tactician wrote, for the sidebar's strategy page. */
export interface BossPlanRecord {
  readonly mapId: number;
  readonly table: Json;
  readonly result: string;
  readonly at: string;
  /** Mid-battle rewrites, oldest first (task 34); absent on records from before it. */
  readonly rewrites?: readonly BossRewriteRecord[];
}

/** The tool side: runs each tool through the pilot and describes what the player now sees. */
export class Game {
  readonly laptop: Laptop;
  readonly game: string;
  readonly saveSlot: number;
  readonly notesFile: string | undefined;
  readonly events: KeyEvents | undefined;
  readonly atlas: Atlas;
  readonly atlasSave: AtlasSave;
  /** Task 75: per-map collision replies, written on every indoor entry. */
  readonly collisions: CollisionStore;
  readonly tactics: Tactics;
  readonly elements: Elements;
  readonly battles: BattleLog;
  readonly guide: Guide | null;
  readonly tacticianLog: TacticianLog;
  readonly backlog: Backlog;
  readonly incidents: Incidents;
  readonly bestiary: BestiarySave;
  /** Task 42: monster AI scripts, also read by the fact sheet outside battle. */
  readonly monsterAi: MonsterAiCache;
  /** The plugin's activity log sink for an incident (task 45); unset in tests. */
  onIncident: ((message: string) => void) | undefined;
  /** Task 101: a non-error activity line (a planned-coordinate go allowed with a reason). */
  onActivity: ((message: string) => void) | undefined;
  readonly advised = new Set<string>();
  readonly moveState: MoveState = { drake: null };
  readonly hooks: BattleHooks;
  /** Static monster data shared by the fact sheet and the strategy page. */
  readonly monsterCache = new MonsterCache();
  notes: string[] = [];
  savePoint: Cell | null = null; // on the current map, if it has one
  gear: Record<string, number> | null = null; // weapons and armour in the bag, last look
  mapId: number | null = null;
  /** 11-09 (task 78): the bridge's title screen; it reports map 0, which is not a map. */
  private titleScene = false;
  town: number | null = null; // the town map last hinted about
  ailmentCombo: string | null = null; // the uncured-ailment group last hinted about
  ailmentMap: number | null = null; // the map it was hinted on
  readonly tacticianBoss: boolean;
  /** Task 48: the configured route caps, also used by tests that never set them. */
  readonly travelMaxHops: number;
  readonly travelMaxMinutes: number;
  /** Task 68: until_bestiary's per-monster deferral and missable grinding caps. */
  readonly bestiaryDeferBattles: number;
  readonly bestiaryMissableMinutes: number;
  /** Task 86: the configured gap between two road triggers on one map. */
  readonly tacticianIntervalMinutes: number;
  private tactician: TacticianRunner | undefined;
  private tacticianCalled = false; // one call per tool invocation (task 10)
  /** The one background call, and at most one waiting to start after it (task 86). */
  private background: BackgroundCall | null = null;
  private pending: {
    readonly trigger: FactsTrigger;
    readonly prepared: TacticianFacts;
    readonly install: boolean;
  } | null = null;
  /** Finished background calls whose text the next tool result must carry. */
  private readonly backgroundNotices: string[] = [];
  /** The pilot clock time of the last road trigger per map, for the gap. */
  private readonly roadCallAt = new Map<number, number>();
  private readonly blockedCounts = new Map<string, number>(); // map+cell → times blocked
  private blocked: { count: number; detail: string } | null = null;
  private ride: string | null = null;
  private lastBattle: {
    mapId: number | null;
    verdict: string;
    detail: string;
  } | null = null;
  private lastBoss: BossPlanRecord | null = null;
  private readonly tacticianInfoByMap = new Map<number, { walkerNotes: string; askUp: string }>();
  private readonly handlers: ReadonlyMap<string, ToolHandler>;
  private lastCompletion: import("./completion.ts").CompletionState | null = null;
  private lastAchievements: import("./achievements.ts").AchievementsData | null = null;
  /** Task 69: per-map/cell encounter grid numbers; also shared with the grind loop. */
  private readonly encounterGrids = new EncounterGridCache();
  private lastCompletionAt = 0;
  private leaveNotice: string | null = null;
  private readonly timedSeen = new Set<string>();
  /** Task 89: the countdown last read from the bridge, for the leave guard and tactician mute. */
  private lastTimer: {
    readonly active: boolean;
    readonly seconds: number | null;
  } | null = null;
  private readonly routeFile: string | undefined;
  private readonly routeBattleSeconds: number;
  /** Task 97: the one stage plan, its gate settings and the lazily loaded knowledge. */
  readonly stagePlans: StagePlanStore;
  private stageOfficer: StageOfficerRunner | undefined;
  readonly stageAutoPlan: boolean;
  /** Task 101: refuse a coordinate `go` while a stage plan is in progress (default on). */
  readonly stageGoGate: boolean;
  /** Task 113: a refused coordinate `go` follows the plan instead (default on). */
  readonly stageGoFollowPlan: boolean;
  /** Task 113: a go that arrives at the plan's map keeps following it (default on). */
  readonly stageContinueAfterTravel: boolean;
  readonly stageTurnBackDistance: number;
  /** Task 106: levels moved this much or a job changed before the boss rewrites its table. */
  readonly stageBossLevelGap: number;
  /** Task 117: the route book's switch, grind cap and live files. */
  readonly routeBookEnabled: boolean;
  readonly routeBookGrindMinutes: number;
  /** Task 124: the runtime build's window and budget. */
  readonly routeBookAheadSections: number;
  readonly routeBookTimeBudgetMs: number;
  private readonly routeBookGuideFile: string | undefined;
  private readonly routeBookOption: RouteBook | undefined;
  private readonly routeBookLearnedFile: string | undefined;
  private readonly bookProgress: BookProgressStore;
  private bookCache: {
    readonly book: RouteBook;
    readonly sectionIndex: number;
    readonly section: RouteSection;
    readonly mapId: number | null;
  } | null = null;
  /** Task 117: a handoff/boss the model took over; the next `route {}` records it. */
  private pendingBook: {
    readonly section: string;
    readonly index: number;
    readonly kind: string;
  } | null = null;
  /** Task 117: remember the guide sections by title for progress restarts. */
  private bookSectionsByTitle = new Map<string, RouteSection>();
  private readonly knowledgeOption: Knowledge | undefined;
  private knowledge: Knowledge | null = null;
  private knowledgeLoading: Promise<Knowledge> | null = null;
  private stageBossWon = false;
  private stageNotice = "";
  /** Task 113: the tool whose handler is running, so a departure counts that call. */
  private stageCallName: string | null = null;
  /** Task 97: the map of the previous tool result, so a map entry runs the turn-back check. */
  private stageLastMap: number | null = null;
  /** Task 105: scout limits, the running flag and the cached scout-window file. */
  readonly scoutDir: string;
  readonly scoutMinutes: number;
  readonly scoutMaxTargets: number;
  private scouting = false;
  private scoutWindowsCache: ScoutWindows | null = null;
  /** Task 91: Config's healing thresholds, save-timer guard and wait-stall limit. */
  readonly healHpPercent: number;
  readonly healMpReservePercent: number;
  readonly healItemHpPercent: number;
  readonly healFullPercent: number;
  readonly saveTimerMinSeconds: number;
  readonly storyStuckSeconds: number;
  /** The map/cell/state read by chart, so the save-point check needs no extra pos query. */
  private lastCell: Cell | null = null;
  private lastState = "";
  /** Task 91: an inn's map, where magic may use all MP without a save point. */
  private innHere = false;

  private constructor(
    laptop: Laptop,
    game: string,
    saveSlot: number,
    notesFile: string | undefined,
    events: KeyEvents | undefined,
    atlas: Atlas,
    atlasSave: AtlasSave,
    collisions: CollisionStore,
    tactics: Tactics,
    elements: Elements,
    battles: BattleLog,
    guide: Guide | null,
    tacticianLog: TacticianLog,
    backlog: Backlog,
    incidents: Incidents,
    bestiary: BestiarySave,
    monsterAi: MonsterAiCache,
    tactician: TacticianRunner | undefined,
    tacticianBoss: boolean,
    tacticianIntervalMinutes: number,
    travelMaxHops: number,
    travelMaxMinutes: number,
    bestiaryDeferBattles: number,
    bestiaryMissableMinutes: number,
    routeBattleSeconds: number,
    routeFile: string | undefined,
    stagePlans: StagePlanStore,
    stageOfficer: StageOfficerRunner | undefined,
    stageAutoPlan: boolean,
    stageGoGate: boolean,
    stageGoFollowPlan: boolean,
    stageContinueAfterTravel: boolean,
    stageTurnBackDistance: number,
    stageBossLevelGap: number,
    routeBookEnabled: boolean,
    routeBookGrindMinutes: number,
    routeBookAheadSections: number,
    routeBookTimeBudgetMs: number,
    routeBookGuideFile: string | undefined,
    routeBookOption: RouteBook | undefined,
    routeBookLearnedFile: string | undefined,
    bookProgress: BookProgressStore,
    knowledge: Knowledge | undefined,
    scoutDir: string,
    scoutMinutes: number,
    scoutMaxTargets: number,
    healHpPercent: number,
    healMpReservePercent: number,
    healItemHpPercent: number,
    healFullPercent: number,
    saveTimerMinSeconds: number,
    storyStuckSeconds: number,
  ) {
    this.laptop = laptop;
    this.game = game;
    this.saveSlot = saveSlot;
    this.notesFile = notesFile;
    this.events = events;
    this.atlas = atlas;
    this.atlasSave = atlasSave;
    this.collisions = collisions;
    this.tactics = tactics;
    this.elements = elements;
    this.battles = battles;
    this.guide = guide;
    this.tacticianLog = tacticianLog;
    this.backlog = backlog;
    this.incidents = incidents;
    this.bestiary = bestiary;
    this.monsterAi = monsterAi;
    this.tactician = tactician;
    this.tacticianBoss = tacticianBoss;
    this.tacticianIntervalMinutes = tacticianIntervalMinutes;
    this.travelMaxHops = travelMaxHops;
    this.travelMaxMinutes = travelMaxMinutes;
    this.bestiaryDeferBattles = bestiaryDeferBattles;
    this.bestiaryMissableMinutes = bestiaryMissableMinutes;
    this.routeBattleSeconds = routeBattleSeconds;
    this.routeFile = routeFile;
    this.stagePlans = stagePlans;
    this.stageOfficer = stageOfficer;
    this.stageAutoPlan = stageAutoPlan;
    this.stageGoGate = stageGoGate;
    this.stageGoFollowPlan = stageGoFollowPlan;
    this.stageContinueAfterTravel = stageContinueAfterTravel;
    this.stageTurnBackDistance = stageTurnBackDistance;
    this.stageBossLevelGap = stageBossLevelGap;
    this.routeBookEnabled = routeBookEnabled;
    this.routeBookGrindMinutes = routeBookGrindMinutes;
    this.routeBookAheadSections = routeBookAheadSections;
    this.routeBookTimeBudgetMs = routeBookTimeBudgetMs;
    this.routeBookGuideFile = routeBookGuideFile;
    this.routeBookOption = routeBookOption;
    this.routeBookLearnedFile = routeBookLearnedFile;
    this.bookProgress = bookProgress;
    this.knowledgeOption = knowledge;
    this.scoutDir = scoutDir;
    this.scoutMinutes = scoutMinutes;
    this.scoutMaxTargets = scoutMaxTargets;
    this.healHpPercent = healHpPercent;
    this.healMpReservePercent = healMpReservePercent;
    this.healItemHpPercent = healItemHpPercent;
    this.healFullPercent = healFullPercent;
    this.saveTimerMinSeconds = saveTimerMinSeconds;
    this.storyStuckSeconds = storyStuckSeconds;
    // Task 42: a `battle.ai` push says a script exists; the body is queried later by `ensure`.
    this.events?.onRecord((record) => {
      if (record.type === "battle.ai") this.monsterAi.recordEvent(record);
    });
    // Task 61: the bridge's walk pushes update this game's walking view. A view is only
    // updated while it exists; `navigate` creates it for each walkpath.
    this.events?.onWalk((record) => {
      this.moveState.walk = applyWalkPush(
        this.moveState.walk ?? null,
        record,
        new Date().toISOString(),
      );
    });
    // The player's tactics per map fight the regular battles (control plan §4.10).
    this.hooks = {
      tableFor: (mapId) => this.tactics.current(mapId),
      tableIndexFor: (mapId) => {
        if (mapId === null) return null;
        return this.tactics.maps.get(String(mapId))?.current ?? null;
      },
      recorder: this.battles,
      report: async (mapId, verdict, detail) => {
        this.lastBattle = { mapId, verdict, detail };
        return await this.tactics.record(mapId, verdict, detail);
      },
      onIncident: (message) => this.onIncident?.(message),
      elements: this.elements,
      heal: this.healOptions(),
    };
    this.moveState.game = this.game;
    this.moveState.battle = this.hooks;
    this.moveState.saveSlot = this.saveSlot;
    this.moveState.link = (mapId, from, to, how, detail) =>
      this.atlas.link(mapId, from, to, how, detail);
    this.moveState.forgetBlocked = (mapId, steps) => this.atlas.forgetBlocked(mapId, steps);
    this.moveState.moves = (mapId) => this.atlas.moves(mapId);
    // Task 84: a same-map go carried onto another map walks back to the goal's map and on to
    // the goal, all inside this call, when the atlas records a way.
    this.moveState.routeBack = (from, to) =>
      travel.mapPath(this.atlas, from, to, new Set<string>(), true) !== null;
    this.moveState.returnToGoal = async (pilot, goalMap, goal, say, budget) => {
      const result = await travel.travelToMap(
        pilot,
        {
          atlas: this.atlas,
          moveState: this.moveState,
          collisions: this.collisions,
        },
        goalMap,
        say,
        { maxHops: this.travelMaxHops, maxMinutes: this.travelMaxMinutes },
      );
      if (!result.reached) return [false, result.text];
      return await move.navigate(pilot, goal, false, say, 8, this.moveState, budget);
    };
    this.handlers = new Map<string, ToolHandler>([
      ["go", (args, pilot, signal) => this.toolGo(args, pilot, signal)],
      ["route", (args, pilot, signal) => this.toolRoute(args, pilot, signal)],
      ["explore", (args, pilot) => this.toolExplore(args, pilot)],
      ["plan_stage", (args, pilot, signal) => this.toolPlanStage(args, pilot, signal)],
      ["scout", (args, pilot, signal) => this.toolScout(args, pilot, signal)],
      ["terrain", (args, pilot) => this.toolTerrain(args, pilot)],
      ["entrances", (_args, pilot) => this.toolEntrances(pilot)],
      ["look_around", (_args, pilot) => this.toolLookAround(pilot)],
      ["interact", (args, pilot) => this.toolInteract(args, pilot)],
      ["advance_story", (_args, pilot) => this.toolAdvanceStory(pilot)],
      ["press", (args, pilot) => this.toolPress(args, pilot)],
      ["choose", (args, pilot) => this.toolChoose(args, pilot)],
      ["fight", (args, pilot) => this.toolFight(args, pilot)],
      ["grind", (args, pilot) => this.toolGrind(args, pilot)],
      ["sell", (args, pilot) => this.toolSell(args, pilot)],
      ["shop_gear", (_args, pilot) => this.toolShopGear(pilot)],
      ["buy", (args, pilot) => this.toolBuy(args, pilot)],
      ["cast", (args, pilot) => this.toolCast(args, pilot)],
      ["use_item", (args, pilot) => this.toolUseItem(args, pilot)],
      ["change_job", (args, pilot) => this.toolChangeJob(args, pilot)],
      ["leave_menu", (_args, pilot) => this.toolLeaveMenu(pilot)],
      ["save_game", (_args, pilot) => this.toolSaveGame(pilot)],
      ["land", (_args, pilot) => this.toolLand(pilot)],
      ["board", (_args, pilot) => this.toolBoard(pilot)],
      ["optimize_equipment", (_args, pilot) => this.toolOptimizeEquipment(pilot)],
      ["set_tactics", (args, pilot) => this.toolSetTactics(args, pilot)],
      ["guide", (args) => this.toolGuide(args)],
      ["atlas", (_args, pilot) => this.toolAtlas(pilot)],
      ["inventory", (_args, pilot) => this.toolInventory(pilot)],
      ["remember", (args) => this.toolRemember(args)],
      ["forget", (args) => this.toolForget(args)],
      // Task 107: kept for sessions that still carry the old tool list; in goal mode the turn
      // ends by answering, not by calling done.
      [
        "done",
        () =>
          Promise.resolve({
            text: "目标模式下不用 done:这一轮写进展即可，系统会自动开始下一轮;整个目标真的完成时用目标工具标完成",
            early: true,
          }),
      ],
    ]);
  }

  static async create(options: GameOptions): Promise<Game> {
    const signal = options.signal;
    const game = byKey(options.game).key;
    const atlas = await Atlas.load(options.atlasFile, signal);
    const collisionDir =
      options.collisionDir ??
      (options.atlasFile === undefined
        ? undefined
        : join(dirname(options.atlasFile), `collision-${game}`));
    // Task 123: the game files' map export is the collision/exit fallback for unvisited maps.
    const gameFilesDir =
      options.gameFilesDir === null
        ? undefined
        : (options.gameFilesDir ?? join(DEPS, "knowledge", game, "files", "maps"));
    const collisions = await CollisionStore.load(collisionDir, signal, gameFilesDir);
    const atlasSaveFile =
      options.atlasSaveFile ??
      (options.atlasFile === undefined
        ? undefined
        : join(dirname(options.atlasFile), `atlas-save-${game}.json`));
    const atlasSave = await AtlasSave.load(game, atlasSaveFile, atlas, signal);
    const tactics = await Tactics.load(options.tacticsFile, signal);
    // The guide knowledge is FF5's (.deps/knowledge/ff5): using it for another game would give
    // that game FF5's shops and monster notes under the same names.
    const guide = game === "ff5" ? await Guide.load(undefined, signal) : null;
    const elementsFile =
      options.elementsFile ??
      (game === "ff5" ? undefined : join(DEPS, "ds", `elements-${game}.json`));
    const elements = await Elements.load(
      elementsFile,
      guide?.ludo ?? [],
      signal,
      guide?.bestiary ?? new Map(),
    );
    const battles = await BattleLog.load(game, options.battlesFile, signal);
    const tacticianLog = await TacticianLog.load({
      file: options.tacticianFile,
    });
    const backlog = await Backlog.load(options.backlogFile, signal);
    const incidents = await Incidents.load(
      options.incidentsFile,
      options.incidentsStateFile,
      signal,
    );
    const bestiary = await BestiarySave.load(game, options.bestiarySaveFile, signal);
    const aiFile = options.monsterAiFile ?? (game === "ff5" ? monsterAiPath(game) : undefined);
    const monsterAi = await MonsterAiCache.load(game, aiFile, signal);
    const stagePlans = await StagePlanStore.load(options.stagePlanFile, signal);
    const created = new Game(
      options.laptop,
      game,
      options.saveSlot,
      options.notesFile,
      options.events,
      atlas,
      atlasSave,
      collisions,
      tactics,
      elements,
      battles,
      guide,
      tacticianLog,
      backlog,
      incidents,
      bestiary,
      monsterAi,
      options.tactician,
      options.tacticianBoss ?? true,
      options.tacticianIntervalMinutes ?? DEFAULT_TACTICIAN_INTERVAL_MINUTES,
      options.travelMaxHops ?? travel.DEFAULT_TRAVEL_MAX_HOPS,
      options.travelMaxMinutes ?? travel.DEFAULT_TRAVEL_MAX_MINUTES,
      options.bestiaryDeferBattles ?? grind.DEFAULT_BESTIARY_DEFER_BATTLES,
      options.bestiaryMissableMinutes ?? grind.DEFAULT_BESTIARY_MISSABLE_MINUTES,
      options.routeBattleSeconds ?? DEFAULT_ROUTE_BATTLE_SECONDS,
      options.routeFile,
      stagePlans,
      options.stageOfficer,
      options.stageAutoPlan ?? true,
      options.stageGoGate ?? true,
      options.stageGoFollowPlan ?? true,
      options.stageContinueAfterTravel ?? true,
      options.stageTurnBackDistance ?? MAX_RECOVERY_DISTANCE,
      options.stageBossLevelGap ?? 3,
      options.routeBookEnabled ?? true,
      options.routeBookGrindMinutes ?? 8,
      options.routeBookAheadSections ?? 4,
      options.routeBookTimeBudgetMs ?? 5_000,
      options.routeBookGuideFile,
      options.routeBook,
      options.routeBookLearnedFile,
      await BookProgressStore.load(game, options.routeBookProgressFile, signal),
      options.knowledge,
      options.scoutDir ?? join(DEPS, "ds"),
      options.scoutMinutes ?? 20,
      options.scoutMaxTargets ?? 200,
      options.healHpPercent ?? 70,
      options.healMpReservePercent ?? 30,
      options.healItemHpPercent ?? 40,
      options.healFullPercent ?? 95,
      options.saveTimerMinSeconds ?? 300,
      options.storyStuckSeconds ?? 60,
    );
    created.moveState.walkpathTimeoutMs = options.walkpathTimeoutMs;
    created.moveState.walkpathBlockedMs = options.walkpathBlockedMs;
    created.moveState.walkpathTurnLead = options.walkpathTurnLead;
    created.moveState.walkpathEventPollMs = options.walkpathEventPollMs;
    created.moveState.walkpathEventWaitMs = options.walkpathEventWaitMs;
    created.moveState.blockedTrustCount = options.blockedTrustCount;
    created.moveState.carryRepeatLimit = options.carryRepeatLimit;
    created.moveState.carryTotalLimit = options.carryTotalLimit;
    // Task 129: the walk opens the game files' hidden passages and pages a story itself.
    created.moveState.passages = (mapId) => created.collisions.passages(mapId);
    created.moveState.story = (pilot) => created.storyAdvance(pilot);
    created.notes =
      options.notesFile === undefined ? [] : await loadNotes(options.notesFile, signal);
    // A web restart must still show the boss table and walker notes the tactician wrote.
    created.lastBoss = tactics.lastBoss();
    return created;
  }

  /** Install the second layer after the plugin has built its tool-call binding. */
  setTactician(tactician: TacticianRunner | undefined): void {
    this.tactician = tactician;
  }

  /** Install the stage officer (task 97); without it the stage layer stays off. */
  setStageOfficer(officer: StageOfficerRunner | undefined): void {
    this.stageOfficer = officer;
  }

  /** The saved stage plan, for tests and the sidebar. */
  stagePlan(): StagePlanRecord | null {
    return this.stagePlans.current;
  }

  // -------------------------------------------------------------------------------------------
  // Task 117: the route book executor

  private bookPlanOptions(): BookPlanOptions {
    return { grindMinutes: this.routeBookGrindMinutes };
  }

  /** This save's live data for the book: bestiary, jobs, learned spells and opened chests. */
  private async liveBookSave(pilot: Pilot): Promise<import("./stage/route-book.ts").RouteBookSave> {
    let jobs: string[] | null = null;
    let blueMagic: string[] | null = null;
    try {
      const sample = record((await pilot.query("sample")).sample);
      const party = readParty(sample);
      jobs = party.map((member) => member.job);
      blueMagic = party.flatMap((member) => member.abilities.map((ability) => ability.name));
    } catch {
      // An old bridge without sample still gets the book's chest order and bestiary.
    }
    return {
      bestiary: new Set(this.bestiary.numbers),
      blueMagic,
      jobs,
      openedChests: await this.openedChestsHere(pilot),
    };
  }

  /** `"mapId:x,y"` for every opened treasure entity the bridge reports on this map. */
  private async openedChestsHere(pilot: Pilot): Promise<ReadonlySet<string> | null> {
    const { map } = await this.stagePosition(pilot);
    if (map === null) return null;
    try {
      const reply = record(
        (await pilot.send("entities", { kind: "TresureBox", max: 400 })).entities,
      );
      const opened = new Set<string>();
      for (const entity of records(reply.entities)) {
        if (entity.opened !== true) continue;
        const cell = cellOf(entity.cell);
        if (cell === null) continue;
        opened.add(`${map}:${cell[0]},${cell[1]}`);
      }
      return opened;
    } catch {
      return null;
    }
  }

  /** Build (or inject) the route book and pick the section for one map/plan. */
  private async buildBookRuntime(
    pilot: Pilot,
    signal: AbortSignal | undefined,
    options: {
      readonly preferredSection?: string;
      readonly preferredMapId?: number | null;
    } = {},
  ): Promise<RouteBookRuntime | null> {
    if (!this.routeBookEnabled) return null;
    const position = await this.stagePosition(pilot);
    const previous =
      this.bookProgress.current === null
        ? null
        : {
            title: this.bookProgress.current.section,
            finished: this.bookProgress.current.finishedAt !== null,
          };
    if (this.routeBookOption !== undefined) {
      const book = this.routeBookOption;
      this.bookSectionsByTitle = new Map(book.sections.map((section) => [section.title, section]));
      const sectionIndex = selectSectionIndex(book, position.map, {
        ...(options.preferredSection === undefined
          ? {}
          : { preferredSection: options.preferredSection }),
        ...(options.preferredMapId === undefined ? {} : { preferredMapId: options.preferredMapId }),
        ...(previous === null ? {} : { previous }),
      });
      const section = sectionIndex === null ? undefined : book.sections[sectionIndex];
      return section === undefined || sectionIndex === null
        ? null
        : { book, sectionIndex, section };
    }
    const knowledge = await this.ensureStageKnowledge(signal);
    const visitOrder = await readVisitOrder(this.game, undefined, signal);
    const learned = await readLearnedPoints(this.game, this.routeBookLearnedFile, signal);
    const runtime = await loadRouteBook(
      {
        game: this.game,
        knowledge,
        atlas: this.atlas,
        visitOrder,
        save: await this.liveBookSave(pilot),
        ...(this.routeBookGuideFile === undefined ? {} : { guideFile: this.routeBookGuideFile }),
        ...(options.preferredSection === undefined
          ? {}
          : { preferredSection: options.preferredSection }),
        ...(options.preferredMapId === undefined ? {} : { preferredMapId: options.preferredMapId }),
        ...(previous === null ? {} : { previous }),
        mapId: position.map,
        learned,
        aheadSections: this.routeBookAheadSections,
        timeBudgetMs: this.routeBookTimeBudgetMs,
        onWarning: (message: string) => this.onActivity?.(message),
      },
      signal,
    );
    if (runtime !== null) {
      this.bookSectionsByTitle = new Map(
        runtime.book.sections.map((section) => [section.title, section]),
      );
    }
    return runtime;
  }

  /**
   * The cached current-section runtime. A build happens on the first call and whenever the map
   * changes; the progress file is only restarted when the section itself changes.
   */
  private async ensureBook(
    pilot: Pilot,
    signal: AbortSignal | undefined,
    preferredSection?: string,
  ): Promise<RouteBookRuntime | null> {
    if (!this.routeBookEnabled) return null;
    const position = await this.stagePosition(pilot);
    const cached = this.bookCache;
    const finished =
      this.bookProgress.current !== null && this.bookProgress.current.finishedAt !== null;
    if (
      cached !== null &&
      cached.mapId === position.map &&
      !(finished && cached.section.title === this.bookProgress.current?.section) &&
      (preferredSection === undefined || cached.section.title === preferredSection)
    ) {
      return {
        book: cached.book,
        sectionIndex: cached.sectionIndex,
        section: cached.section,
      };
    }
    const runtime = await this.buildBookRuntime(pilot, signal, {
      ...(preferredSection === undefined ? {} : { preferredSection }),
    });
    if (runtime === null) return null;
    const current = this.bookProgress.current;
    if (current?.finishedAt != null && current.section === runtime.section.title) {
      // The last section is finished and the party is still on one of its maps; there is no
      // next section, so do not start the same one again.
      return null;
    }
    if (current?.section !== runtime.section.title) {
      if (current !== null && current.finishedAt === null) await this.finishBookProgress();
      await this.bookProgress.start(runtime.section, new Date(), this.stageCallName);
    }
    this.bookCache = {
      book: runtime.book,
      sectionIndex: runtime.sectionIndex,
      section: runtime.section,
      mapId: position.map,
    };
    return runtime;
  }

  /** Close the current section (if open) and put its acceptance line in the activity log. */
  private async finishBookProgress(): Promise<string> {
    const current = this.bookProgress.current;
    if (current === null) return "";
    if (current.finishedAt === null) {
      await this.bookProgress.finish();
      const line = bookStatsLine(this.bookProgress.current ?? current);
      this.onActivity?.(line);
      return line;
    }
    return bookStatsLine(current);
  }

  /** The book's route for a plan target, or null when the book does not cover it. */
  private async bookRouteForTarget(
    pilot: Pilot,
    target: StageTarget,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly runtime: RouteBookRuntime;
    readonly route: StagePlan["route"];
  } | null> {
    const runtime = await this.buildBookRuntime(pilot, signal, {
      ...(target.mapId === null ? {} : { preferredMapId: target.mapId }),
    });
    if (runtime === null) return null;
    const section =
      runtime.book.sections.find(
        (candidate) =>
          (target.mapId !== null && candidate.maps.some((map) => map.mapId === target.mapId)) ||
          (target.areaName !== null && candidate.areaName === target.areaName) ||
          candidate.title === target.label,
      ) ?? null;
    if (section === null) return null;
    return {
      runtime,
      route: routeFromBookSection(section, this.bookPlanOptions()),
    };
  }

  /**
   * A missing plan created from the current book section. The officer still writes supplies,
   * jobs and levels when it is wired; its route is replaced by the book's.
   */
  private async ensureBookPlan(
    pilot: Pilot,
    runtime: RouteBookRuntime,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly record: StagePlanRecord } | { readonly error: string }> {
    const position = await this.stagePosition(pilot);
    const section = runtime.section;
    const mapId = section.maps[0]?.mapId ?? position.map;
    if (mapId === null) return { error: "路线书这一节没有对上地图，没法执行" };
    const target: StageTarget = {
      mapId,
      areaName: section.areaName,
      label: section.title,
    };
    if (this.stageOfficer !== undefined) {
      const created = await this.createStagePlan(pilot, target, signal);
      if (created.record === null) {
        return {
          error:
            `路线书这一节「${section.title}」自动建计划没通过：\n` +
            created.problems.map((problem) => `- ${problem}`).join("\n"),
        };
      }
      const marked: StagePlanRecord = {
        ...created.record,
        book: { section: section.title, order: section.order },
      };
      await this.stagePlans.save(marked);
      return { record: marked };
    }
    const plan: StagePlan = {
      threats: [],
      supplies: [],
      spells: [],
      gear: [],
      jobs: [],
      minLevel: null,
      route: routeFromBookSection(section, this.bookPlanOptions()),
      turnBack: [],
      notes: `路线书自动计划：${section.title}`,
    };
    const record: StagePlanRecord = {
      target,
      plan,
      createdAt: new Date().toISOString(),
      status: "planned",
      ...(position.map === null
        ? {}
        : {
            startMapId: position.map,
            startLabel: stagePlaceName(
              this.knowledgeOption ?? this.knowledge ?? null,
              this.atlas,
              position.map,
            ),
          }),
      book: { section: section.title, order: section.order },
    };
    await this.stagePlans.save(record);
    return { record };
  }

  /** `route {}`'s first choice: a book section with no plan starts one and runs it. */
  private async autoBookRoute(
    pilot: Pilot,
    args: Json,
    signal: AbortSignal | undefined,
  ): Promise<HandlerResult | null> {
    if (!this.routeBookEnabled) return null;
    const active = this.stagePlans.current;
    if (active !== null && active.status !== "completed") return null;
    const runtime = await this.ensureBook(pilot, signal);
    if (runtime === null) return null;
    const position = await this.stagePosition(pilot);
    const covered =
      position.map === null ||
      position.map === 1 ||
      runtime.section.maps.some((map) => map.mapId === position.map);
    // A finished section may have ended on its last map; the next section's first travel leg
    // starts from there. Any other map outside the book is not "in the book's range".
    const afterFinished =
      this.bookProgress.current?.finishedAt != null &&
      runtime.book.sections.some((section) =>
        section.maps.some((map) => map.mapId === position.map),
      );
    if (!covered && !afterFinished) return null;
    const created = await this.ensureBookPlan(pilot, runtime, signal);
    if ("error" in created) return { text: created.error, early: true };
    const refusal = await this.stageBeforeTravel(pilot, args, created.record.target.mapId, signal);
    if (refusal !== null) return refusal;
    await this.stageMarkDeparted();
    return await this.followBookSection(pilot, args, signal);
  }

  /**
   * A pending handoff/boss decision is finished when the model calls `route {}` again: the
   * station becomes handoff, and the next station runs in the same call.
   */
  private async settleBookDecision(record: StagePlanRecord): Promise<void> {
    const progress = this.bookProgress.current;
    if (progress === null) return;
    for (const station of progress.stations) {
      if (station.status !== "current") continue;
      const stop = record.plan.route.find(
        (candidate) =>
          candidate.book?.index === station.index && candidate.book.section === progress.section,
      );
      if (stop === undefined) continue;
      const kind = stop.book?.kind ?? stop.do ?? "";
      if (kind !== "boss" && stop.do !== "handoff") continue;
      await this.bookProgress.mark(
        station.index,
        "handoff",
        kind === "boss" ? "首领交回处理完" : "交回处理完",
        kind,
      );
    }
    this.pendingBook = null;
  }

  /** The event cell a cutscene/talk handoff can walk itself, when exactly one is untriggered. */
  private async bookAutoStoryCell(pilot: Pilot): Promise<Cell | null> {
    try {
      const reply = record((await pilot.send("entities", { kind: "Event", max: 200 })).entities);
      const cells: Cell[] = [];
      for (const entity of records(reply.entities)) {
        if (entity.active === false) continue;
        const name = text(entity.name) ?? "";
        if (!isStoryEventName(name)) continue;
        const cell = cellOf(entity.cell);
        if (cell !== null) cells.push(cell);
      }
      return cells.length === 1 ? (cells[0] ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Map one plan stop to the executor's stop input, learning an event cell for a handoff. */
  private async bookStopsOf(
    pilot: Pilot,
    record: StagePlanRecord,
    section: RouteSection,
  ): Promise<RouteStopInput[]> {
    const progress = this.bookProgress.current;
    const terminal = new Set(
      (progress?.stations ?? [])
        .filter(
          (station) =>
            station.status === "done" ||
            station.status === "handoff" ||
            station.status === "skipped",
        )
        .map((station) => station.index),
    );
    const position = await this.stagePosition(pilot);
    const stops: RouteStopInput[] = [];
    for (const stop of record.plan.route) {
      const book = stop.book;
      if (book?.section !== section.title) continue;
      if (terminal.has(book.index)) continue;
      let action: RouteStopInput["action"] = stop.do ?? "move";
      let to: unknown = stop.to;
      if (action === "handoff" && (book.kind === "cutscene" || book.kind === "talk")) {
        const mapId = Number.parseInt(stop.to.split(":")[0] ?? "", 10);
        if (Number.isFinite(mapId) && mapId === position.map) {
          const cell = await this.bookAutoStoryCell(pilot);
          if (cell !== null) {
            action = "talk";
            to = `${mapId}:${cell[0]},${cell[1]}`;
          }
        }
      }
      const mapId = Number.parseInt(stop.to.split(":")[0] ?? "", 10);
      const label =
        action === "handoff"
          ? handoffText(section.title, book, Number.isFinite(mapId) ? `地图 ${mapId}` : "当前地图")
          : undefined;
      stops.push({
        to,
        action,
        optional: stop.optional ?? false,
        ...(label === undefined ? {} : { label }),
        ...(stop.until === undefined ? {} : { until: stop.until }),
        book: {
          ...book,
          ...(action === "talk" && book.kind !== "talk" ? { autoStory: true } : {}),
        },
      });
    }
    return stops;
  }

  /** Per-waypoint book progress; multi-cell stations complete only when every part did. */
  private bookWaypointCallback(): (
    stop: Waypoint,
    event: "done" | "skipped" | "current",
  ) => Promise<void> {
    const parts = new Map<number, Set<number>>();
    const skipped = new Map<number, Set<number>>();
    return async (stop, event) => {
      const book = stop.book;
      if (book === undefined) return;
      const part = book.part ?? 1;
      const total = book.parts ?? 1;
      if (event === "current") {
        await this.bookProgress.mark(book.index, "current", "交回 AI", book.kind);
        if (stop.kind === "boss" || stop.kind === "handoff") {
          this.pendingBook = {
            section: book.section,
            index: book.index,
            kind: book.kind,
          };
        }
        return;
      }
      const set = event === "done" ? parts : skipped;
      const found = set.get(book.index) ?? new Set<number>();
      found.add(part);
      set.set(book.index, found);
      if (event === "done" && total > 1 && found.size < total) {
        await this.bookProgress.mark(
          book.index,
          "current",
          `已处理 ${found.size}/${total}`,
          book.kind,
        );
        return;
      }
      await this.bookProgress.mark(
        book.index,
        event === "done" ? "done" : "skipped",
        event === "done" ? this.bookDoneNote(stop) : "倒计时跳过",
        book.kind,
      );
    };
  }

  private bookDoneNote(stop: Waypoint): string {
    if (stop.kind === "chest") return `开了 ${stop.label.replace(/^宝箱 /u, "")}`;
    if (stop.kind === "save") return `存档 ${stop.label.replace(/^存档 /u, "")}`;
    if (stop.kind === "boss") return "首领完成";
    if (stop.kind === "handoff") return "交回完成";
    return `处理了 ${stop.label}`;
  }

  /** Finish the section once every station is terminal; log the acceptance line. */
  private async finishBookIfDone(): Promise<string> {
    const progress = this.bookProgress.current;
    if (progress === null) return "";
    const done = progress.stations.every(
      (station) =>
        station.status === "done" || station.status === "handoff" || station.status === "skipped",
    );
    if (!done) return bookStatsLine(progress);
    const line = await this.finishBookProgress();
    const record = this.stagePlans.current;
    if (record?.book !== undefined && record.status !== "completed") {
      const finishedAt = new Date().toISOString();
      const stats = record.stats === undefined ? undefined : { ...record.stats, finishedAt };
      await this.stagePlans.save({
        ...record,
        status: "completed",
        ...(stats === undefined ? {} : { stats }),
      });
    }
    return line;
  }

  /** Execute the active plan's book section, filtering stations the progress already has. */
  private async followBookSection(
    pilot: Pilot,
    args: Json,
    signal?: AbortSignal,
  ): Promise<HandlerResult> {
    const record = this.stagePlans.current;
    if (record?.book === undefined) {
      return { text: "没有进行中的路线书计划", early: true };
    }
    const runtime = await this.ensureBook(pilot, signal, record.book.section);
    if (runtime === null) {
      return { text: "路线书没有生成，不能按书执行", early: true };
    }
    const section =
      runtime.book.sections.find((candidate) => candidate.title === record.book?.section) ??
      this.bookSectionsByTitle.get(record.book.section) ??
      runtime.section;
    await this.settleBookDecision(record);
    const stops = await this.bookStopsOf(pilot, record, section);
    if (stops.length === 0) {
      const line = await this.finishBookIfDone();
      return {
        text: `路线书这一节「${section.title}」没有要执行的站了。\n${line}`,
        early: true,
      };
    }
    const result = await this.runRouteStops(
      pilot,
      args,
      stops,
      null,
      signal,
      true,
      false,
      this.bookWaypointCallback(),
    );
    // A decision the executor reported without the per-waypoint callback (an ordinary dialog
    // choice on a talk stop) still hands the station back to the model.
    if (result.early === true) {
      const pending = this.pendingBook;
      if (pending === null && this.bookProgress.current !== null) {
        const current = this.bookProgress.current.stations.find(
          (station) => station.status === "current",
        );
        const stop =
          current === undefined
            ? undefined
            : record.plan.route.find(
                (candidate) =>
                  candidate.book?.index === current.index &&
                  candidate.book.section === record.book?.section,
              );
        if (stop?.book !== undefined && (stop.do === "boss" || stop.do === "handoff")) {
          this.pendingBook = {
            section: stop.book.section,
            index: stop.book.index,
            kind: stop.book.kind,
          };
        }
      }
    }
    const line = await this.finishBookIfDone();
    return {
      text: [result.text, line].filter((part) => part !== "").join("\n"),
      early: result.early,
    };
  }

  /**
   * The model actually interacted or walked while a handoff was pending: remember that cell,
   * keyed by section + station + map, so the next book build gives the station a coordinate.
   */
  private async captureBookCell(
    name: string,
    args: Json,
    pilot: Pilot,
    resultText: string,
  ): Promise<void> {
    const pending = this.pendingBook;
    if (pending === null) return;
    if (name !== "interact" && name !== "go" && name !== "advance_story") return;
    if (/阶段计划拦下|还没完成|没有执行|没有可接着走/u.test(resultText)) return;
    const position = await this.stagePosition(pilot);
    if (position.map === null) return;
    let cell: Cell | null = null;
    if (name === "interact") {
      const x = num(args.x);
      const y = num(args.y);
      if (x !== undefined && y !== undefined) cell = [Math.trunc(x), Math.trunc(y)];
    } else if (position.cell !== null) {
      cell = position.cell;
    }
    if (cell === null) return;
    const point: LearnedPoint = {
      section: pending.section,
      station: pending.index,
      mapId: position.map,
      cell,
      at: new Date().toISOString(),
    };
    try {
      await writeLearnedPoint(this.game, point, this.routeBookLearnedFile);
    } catch (error) {
      this.onIncident?.(`路线书学会坐标没写成:${describeError(error)}`);
    }
  }

  /**
   * Task 86: wait until no road trigger is writing in the background. The web rebuild and tests
   * use this to read the tables and notes the background call leaves behind.
   */
  async whenTacticianIdle(): Promise<void> {
    while (this.background !== null) {
      await this.background.task.catch(() => undefined);
    }
  }

  /** The current walking view, or null before this run has walked (task 61). */
  walkView(): WalkView | null {
    return this.moveState.walk ?? null;
  }

  /** Any map's walker notes and advice, for the strategy page. */
  tacticianInfoFor(mapId: number): {
    mapId: number;
    walkerNotes: string;
    askUp: string;
    writtenAt?: string;
  } | null {
    const info = this.tacticianInfoByMap.get(mapId);
    if (info !== undefined) return { mapId, ...info };
    const stored = this.tactics.note(mapId);
    if (stored === null) return null;
    return {
      mapId,
      walkerNotes: stored.walkerNotes,
      askUp: stored.askUp,
      writtenAt: stored.writtenAt,
    };
  }

  /** The current map's walker notes and advice, for the first layer's dynamic context. */
  tacticianInfo(): {
    mapId: number;
    walkerNotes: string;
    askUp: string;
    writtenAt?: string;
  } | null {
    return this.mapId === null ? null : this.tacticianInfoFor(this.mapId);
  }

  /** The last boss table the tactician wrote, or null before one. */
  lastBossPlan(): BossPlanRecord | null {
    return this.lastBoss ?? this.tactics.lastBoss();
  }

  /** The stored walker notes for a map, including a note written by a boss-only call. */
  tacticianWrittenAt(mapId: number): string {
    return this.tactics.note(mapId)?.writtenAt ?? "";
  }

  /** Every tool name this Game dispatches; the plugin's TOOLS minus `done` must all be here. */
  handledTools(): string[] {
    return [...this.handlers.keys()];
  }

  async observe(pilot: Pilot): Promise<string> {
    if (this.events) {
      const sample = this.events.liveSample();
      if (sample !== null) return view.summarize(sample, this.events.takeRecent().slice(-8));
    }
    const stateText = await pilot.runPs(stateScript(this.laptop, this.game));
    const [sample, events] = await parseState(stateText, cursorPath(this.game));
    const kept = events.filter((event) => event.type !== "pos.change");
    return view.summarize(sample, kept.slice(-8));
  }

  /** The key events in this layer's window (control plan §4.8), "" without the stream. */
  window(layer: 1 | 2): string {
    return this.events ? this.events.window(layer) : "";
  }

  news(): string {
    return this.events ? this.events.news() : "";
  }

  /**
   * None when keys can reach the game; otherwise why not (the laptop is locked, or another
   * window is in front). A bridge that presses its virtual gamepad needs neither, and the game
   * is never pulled to the front then (10-27: the laptop stays usable while the game plays).
   */
  async ready(pilot: Pilot): Promise<string | null> {
    let status = await pilot.send("status");
    if (truthy(status.gameButtons)) return null;
    if (truthy(status.locked)) return "locked";
    if (!truthy(status.focused)) {
      await pilot.send("focus");
      status = await pilot.send("status");
      if (!truthy(status.focused)) return "not_focused";
    }
    return null;
  }

  /** Task 42: cache the AI scripts of the enemies now on screen, once per monster. */
  private async ensureMonsterAi(pilot: Pilot, enemies: readonly Json[]): Promise<void> {
    const infos = (await this.monsterCache.load(pilot)) ?? [];
    const ids: number[] = [];
    for (const enemy of enemies) {
      const book = num(enemy.book) ?? null;
      const name = text(enemy.name) ?? "";
      const info =
        (book === null ? undefined : infos.find((known) => known.number === book)) ??
        infos.find((known) => known.name === name);
      const id = info?.monster ?? info?.number ?? book;
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
    await this.monsterAi.ensure(pilot, ids);
  }

  /**
   * Finish a regular battle locally, so the model never waits on enemies. A boss battle
   * (bridge 0.4.0+ reads the flag) is fought by the code too: it starts on the best table at
   * hand and takes a late tactician table in the background (task 51).
   */
  async settle(pilot: Pilot): Promise<string> {
    const pos = record((await pilot.send("pos")).pos);
    if (!(truthy(pos.battle) || pos.state === "Battle")) return "";
    const sample = record((await pilot.query("sample")).sample);
    const fight = record(sample.battle);
    await this.ensureMonsterAi(pilot, records(fight.enemies));
    if (truthy(fight.boss)) {
      const old =
        "首领战开始了!战斗暂停等你决定:用 fight 交一张规则表。\n" +
        describeBattle(fight, list(sample.party), this.elements);
      if (this.tactician === undefined || !this.tacticianBoss) {
        if (this.tactician !== undefined) this.tacticianCalled = true; // the first layer fights it
        return old;
      }
      const mapId = num(record(sample.user).mapId) ?? this.mapId;
      if (mapId === null) return old;
      // Task 42: a boss table written before the fight (boss-prep) is used as it is; the
      // battle does not spend its first seconds writing the same table again.
      const boss = this.tactics.boss(mapId);
      // Task 106: the boss cell can start the fight before the stage's boss map is reached, so
      // when this map has no table the stage's plan is matched by the enemy's name or number.
      const stageBoss = boss === null ? this.stageBossMatch(records(fight.enemies)) : null;
      const prepared = boss?.prepared === true || stageBoss !== null;
      let table: Json;
      let startText: string;
      if (boss !== null) {
        table = boss.table;
        startText = prepared
          ? boss.result.includes("出发前")
            ? `用的是出发前写好的首领表(地图 ${mapId})`
            : `用首领战前写好的表(地图 ${mapId})`
          : `开打时用的是这张图上次的首领表(地图 ${mapId})`;
      } else if (stageBoss !== null) {
        table = stageBoss.table;
        startText = "用的是出发前写好的首领表" + `（这一段：${stageBoss.names.join("、")}）`;
      } else {
        const regular = this.tactics.current(mapId);
        if (regular !== null) {
          table = regular;
          startText = `开打时用的是本图的普通战斗表(地图 ${mapId})`;
        } else {
          table = gambit.defaultTable(records(fight.players));
          startText = "开打时没有现成的表,全员普通攻击";
        }
      }
      // Task 51: no prepared table is no reason to stand still. The battle starts on the best
      // table at hand while the tactician writes the boss table in the background.
      const baseFacts = prepared ? "" : undefined;
      const initial = records(fight.enemies);
      const watch: BossWatch = {
        table,
        knownIds: new Set(enemyIds(initial)),
        observedIds: new Set(enemyIds(initial)),
        latestEnemies: initial,
        latestPlayers: records(fight.players),
        history: [],
        noDamage: 0,
        rewrites: [],
        mentioned: mentionedSkills(table),
        seenSkills: new Set(),
        eventIndex: 0,
        lastPartyHp: partyHp(records(fight.players)),
        partyMaxHp: partyMaxHp(records(fight.players)),
        hpDropTriggered: false,
        gaps: [],
        pending: null,
        abort: null,
        triggered: 0,
        opening: false,
        openingArrived: false,
        openingTurn: null,
        turnsRead: 0,
      };
      const session = this.battles.start({
        mapId,
        mapName: placeName(sample),
        boss: true,
        enemies: battleUnits(initial),
        party: battleUnits(records(fight.players)),
        table: { kind: "boss", mapId },
        startedAt: new Date().toISOString(),
        startedMs: pilot.now(),
      });
      const openingReason = "开打时还没有首领表,战术官写好后换上";
      const startRewrite = (reason: string, opening = false): void => {
        if (watch.pending !== null) return;
        if (!opening && watch.triggered >= MAX_BOSS_REWRITES) return;
        if (!opening) watch.triggered += 1;
        if (opening) watch.opening = true;
        const entry = { reason, ok: false, summary: "正在等新表" };
        watch.rewrites.push(entry);
        const trigger: FactsTrigger = {
          kind: "boss",
          mapId,
          detail: reason,
          battle: {
            ...fight,
            enemies: watch.latestEnemies,
            players: watch.latestPlayers,
          },
          pilot,
        };
        let task: Promise<void> | null = null;
        task = this.rewriteBoss(trigger, opening ? undefined : baseFacts, reason, {
          enemies: watch.latestEnemies,
          players: watch.latestPlayers,
          history: watch.history,
          pilot,
          gaps: watch.gaps,
        })
          .then((rewrite) => {
            entry.ok = rewrite.table !== undefined;
            entry.summary = rewrite.summary;
            // The code has now seen these forms, whether or not the tactician answered: the
            // same unseen id must not start rewrite after rewrite. Going back to 281 (seen at
            // the start) also must not; a genuinely new 283 still does.
            for (const id of watch.observedIds) watch.knownIds.add(id);
            if (rewrite.table !== undefined) {
              watch.table = rewrite.table;
              watch.noDamage = 0;
              if (opening) watch.openingArrived = true;
            }
          })
          .catch((error: unknown) => {
            if (isAbortError(error)) {
              watch.abort = error instanceof Error ? error : new Error("操作已取消");
              entry.summary = "已取消";
              return;
            }
            entry.summary = `战术官出错:${describeError(error)}`;
          })
          .finally(() => {
            if (watch.pending === task) watch.pending = null;
            if (opening) watch.opening = false;
          });
        watch.pending = task;
      };
      const fighting = battle.fight(pilot, table, 300, () => undefined, this.elements, {
        table: () => {
          watch.turnsRead += 1;
          if (watch.openingArrived && watch.openingTurn === null)
            watch.openingTurn = watch.turnsRead;
          return watch.table;
        },
        hold: () => watch.pending !== null && !watch.opening,
        record: session,
        onTurn: (turn) => {
          watch.latestEnemies = [...turn.afterEnemies];
          watch.latestPlayers = [...turn.afterPlayers];
          for (const id of enemyIds(turn.afterEnemies)) watch.observedIds.add(id);
          watch.history.push(turnEffect(turn));
          if (watch.history.length > 6) watch.history.shift();
          watch.gaps = session.gaps();
          if (watch.pending !== null) return;
          const events = session.recentEvents();
          for (; watch.eventIndex < events.length; watch.eventIndex++) {
            const event = events[watch.eventIndex];
            if (event?.kind !== "battle.act") continue;
            const name = text(event.actor) ?? "";
            const isEnemy = records(watch.latestEnemies).some((enemy) => text(enemy.name) === name);
            if (!isEnemy || event.action === "") continue;
            if (watch.mentioned.has(event.action) || watch.seenSkills.has(event.action)) continue;
            watch.seenSkills.add(event.action);
            startRewrite(`敌人第一次用了策略里没提到的招式「${event.action}」`);
            break;
          }
          const nowHp = partyHp(turn.afterPlayers);
          if (
            !watch.hpDropTriggered &&
            watch.lastPartyHp > 0 &&
            watch.lastPartyHp - nowHp > watch.partyMaxHp / 2
          ) {
            watch.hpDropTriggered = true;
            startRewrite("我方在一轮里掉了超过一半的 HP");
          }
          watch.lastPartyHp = nowHp;
          const fresh = enemyIds(turn.afterEnemies).filter((id) => !watch.knownIds.has(id));
          if (fresh.length > 0) {
            startRewrite(`敌人变了编号:出现了写表时还没见过的编号 ${fresh.join("、")}`);
            return;
          }
          if (isAttackTurn(turn)) {
            const before = bossHp(turn.beforeEnemies);
            const after = bossHp(turn.afterEnemies);
            if (after < before) watch.noDamage = 0;
            else watch.noDamage += 1;
            if (watch.noDamage >= BOSS_NO_DAMAGE_TURNS) {
              const count = watch.noDamage;
              watch.noDamage = 0;
              startRewrite(`连续 ${count} 次攻击,首领的 HP 都没有减少`);
            }
          } else {
            watch.noDamage = 0;
          }
        },
      });
      // Start the opening call after fight() has begun: it must not hold the first turn.
      if (!prepared) startRewrite(openingReason, true);
      const result = await fighting;
      const foughtAt = pilot.now();
      // A rewrite may still be in flight when the battle ends; collect it so the result can
      // say what happened, and let a cancelled call reach the tool boundary.
      if (watch.pending !== null) await watch.pending;
      if (watch.abort !== null) throw watch.abort;
      const opening = watch.rewrites.find((entry) => entry.reason === openingReason);
      if (opening?.ok === true) {
        opening.summary +=
          watch.openingTurn === null
            ? "(战斗已经结束,存成这张图的首领表)"
            : `(第 ${watch.openingTurn} 回合换上)`;
      }
      const [verdict, judgeDetail] = battle.judgePlayers(result.players);
      const recorded =
        result.error === "wiped"
          ? "wipe"
          : result.error === "timeout"
            ? "timeout"
            : verdict === "lost"
              ? "wipe"
              : verdict === "hard"
                ? "hard"
                : "ok";
      const finished = await session.finish(
        foughtAt,
        recorded,
        result.error === "wiped"
          ? "首领战全灭"
          : result.error === "timeout"
            ? "战斗超时"
            : judgeDetail,
        watch.rewrites,
      );
      const wiped = result.error === "wiped";
      const done = wiped
        ? "首领战全灭"
        : truthy(result.ok)
          ? "战斗结束"
          : `战斗没打完:${show(result.error)}`;
      let fought =
        `${startText}\n` +
        `首领战由战术官写表,代码照表打:${done};出招:${list(result.turns).map(show).join("、")}`;
      if (watch.rewrites.length > 0) fought += "\n" + rewriteText(watch.rewrites);
      const gaps = gapText(watch.gaps);
      if (gaps !== "") fought += "\n" + gaps;
      if (result.learned.length > 0) fought += "\n" + result.learned.join(";");
      if (truthy(result.ok)) {
        if (truthy(fight.boss)) this.stageBossWon = true;
        const healed = await battle.patchUp(
          pilot,
          () => undefined,
          4,
          (message) => this.onIncident?.(message),
          this.healOptions(),
        );
        if (healed.length > 0) fought += "\n战后回复:" + healed.join(";");
      }
      if (wiped) {
        fought +=
          "\n" + (await battle.wipeReport(pilot, battle.enemyNames(initial), this.saveSlot));
      }
      this.lastBoss = {
        mapId,
        table: watch.table,
        result: fought,
        at: new Date().toISOString(),
        rewrites: watch.rewrites,
      };
      // Task 40: the boss table and its rewrites survive a web restart with the map's entry.
      const bossNote = this.tacticianInfoFor(mapId);
      await this.tactics.setBoss(mapId, {
        table: watch.table,
        result: fought,
        at: this.lastBoss.at,
        ...(bossNote === null ? {} : { walkerNotes: bossNote.walkerNotes, askUp: bossNote.askUp }),
        rewrites: watch.rewrites,
      });
      // Task 42: after a boss wipe the next table is written with this battle's record.
      if (wiped) {
        const debrief = await this.runTactician(
          {
            kind: "bad-battle",
            mapId,
            detail: "首领战全灭",
            battle: {
              ...fight,
              enemies: watch.latestEnemies,
              players: watch.latestPlayers,
            },
            record: finished,
            pilot,
          },
          false,
        );
        const next = debrief.tables[0];
        if (next !== undefined) {
          await this.tactics.setBoss(mapId, {
            table: next,
            result: fought,
            at: this.lastBoss.at,
            ...(bossNote === null
              ? {}
              : { walkerNotes: bossNote.walkerNotes, askUp: bossNote.askUp }),
            prepared: true,
          });
          this.lastBoss = { ...this.lastBoss, table: next };
          fought += `\n战后复盘:${debrief.text}`;
        } else if (debrief.text !== "") {
          fought += `\n战后复盘:${debrief.text}`;
        }
      }
      return fought;
    }
    return `(途中遇敌,${await battle.regular(pilot, this.hooks, () => undefined, this.saveSlot)})`;
  }

  /**
   * Read the fact sheet and the coverage data while the calling tool's pilot is alive. A
   * background call cannot query the bridge after the tool returns (task 86).
   */
  private async prepareTactician(
    trigger: FactsTrigger,
    givenFacts?: string,
  ): Promise<TacticianFacts | { readonly error: string }> {
    let facts: string;
    try {
      facts = givenFacts ?? (await buildFacts(this, trigger));
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { error: `战术官没有叫成:${describeError(error)}` };
    }
    try {
      // Task 42: the coverage check reads the party, the bag and the enemy dossier, not just
      // the table's shape.
      const sample = record((await trigger.pilot.query("sample")).sample);
      const party = readParty(sample);
      const bag = readBag(await battle.heldItems(trigger.pilot));
      const dossier = await dossierForTrigger(this, trigger);
      const met = [...(this.events?.enemies.get(trigger.mapId) ?? new Set<string>())].sort();
      return { facts, party, bag, dossier, met };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { error: `战术官没有叫成:${describeError(error)}` };
    }
  }

  /**
   * Call the second layer once for this tool invocation, retrying at most twice when the
   * returned tables do not pass gambit.check. Tables that do pass are installed; the text
   * always says what happened, even when nothing usable came back (task 10). Bosses and
   * boss-prep still use this synchronous path (task 86).
   */
  private async runTactician(
    trigger: FactsTrigger,
    install: boolean,
    givenFacts?: string,
  ): Promise<{ text: string; tables: Json[]; facts: string }> {
    // 11-09 (task 78): no map (title screen, map 0, or still changing) means no tactician.
    if (!this.onMap(trigger.mapId)) return { text: "", tables: [], facts: givenFacts ?? "" };
    this.tacticianCalled = true;
    if (this.tactician === undefined) return { text: "", tables: [], facts: givenFacts ?? "" };
    const prepared = await this.prepareTactician(trigger, givenFacts);
    if ("error" in prepared) {
      await this.recordTacticianCall(trigger, 0, [prepared.error], "");
      return { text: prepared.error, tables: [], facts: givenFacts ?? "" };
    }
    let facts = prepared.facts;
    let plan: TacticianPlan | null = null;
    let problems: string[] = [];
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        plan = await this.callTacticianPlan(facts);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const text = `战术官没有回答:${describeError(error)}`;
        await this.recordTacticianCall(trigger, 0, [text], "");
        return { text, tables: [], facts };
      }
      problems = this.planProblems(plan, prepared);
      if (problems.length === 0) break;
      if (attempt < 2) {
        facts +=
          "\n\n### 上次交回的规则表有问题\n" +
          problems.join("\n") +
          "\n请改好再交:1–3 套,每套 {角色名: [规则…]}。";
      }
    }
    if (plan === null) {
      await this.recordTacticianCall(trigger, 0, ["战术官没有交回结果"], "");
      return { text: "战术官没有交回结果", tables: [], facts };
    }
    return await this.applyPlan(trigger, plan, problems, prepared, install);
  }

  /** The runner may be one old plan promise or a started dsh child (task 86). */
  private async callTacticianPlan(facts: string): Promise<TacticianPlan> {
    if (this.tactician === undefined) throw new Error("战术官没有接上");
    return await asTacticianCall(this.tactician(facts)).result;
  }

  private planProblems(plan: TacticianPlan, prepared: TacticianFacts): string[] {
    return [
      ...tacticianProblems(plan.tables, this.game, prepared.party),
      ...coverageProblems({
        tables: plan.tables,
        party: prepared.party,
        bag: prepared.bag,
        dossier: prepared.dossier,
      }),
    ];
  }

  /** Install a returned plan and word the note the player sees (shared by both paths). */
  private async applyPlan(
    trigger: FactsTrigger,
    plan: TacticianPlan,
    problems: readonly string[],
    prepared: TacticianFacts,
    install: boolean,
  ): Promise<{ text: string; tables: Json[]; facts: string }> {
    const good = plan.tables
      .filter((table) => tablePasses(table, this.game, prepared.party))
      .slice(0, 3);
    // Task 110: a road call may finish while the party is still on the map where the player's
    // own table is in use (possibly written while this call was already running). Keep the
    // player's table and only attach the tactician's words; leaving the map lifts this.
    const heldByPlayer = install && this.playerTableHolds(trigger.mapId);
    const note = {
      walkerNotes: plan.walkerNotes,
      askUp: plan.askUp,
      writtenAt: new Date().toISOString(),
    };
    this.tacticianInfoByMap.set(trigger.mapId, {
      walkerNotes: plan.walkerNotes,
      askUp: plan.askUp,
    });
    let text = `战术官(地图 ${trigger.mapId}):${plan.walkerNotes}`;
    if (plan.askUp !== "") text += `\n战术官建议:${plan.askUp}`;
    if (problems.length > 0) {
      text +=
        `\n战术官的规则表有问题:${problems.join(";")}` +
        (good.length > 0
          ? heldByPlayer
            ? ";这次先不换上"
            : `;先装上能通过的 ${good.length} 套`
          : ";这次没有可用的规则表");
    }
    if (install && good.length > 0 && !heldByPlayer) {
      await this.tactics.set(
        trigger.mapId,
        good,
        prepared.met,
        note,
        partySnapshot(prepared.party),
      );
    } else if (this.tactics.maps.has(String(trigger.mapId))) {
      // A boss rewrite has no new regular table, but its walker notes still belong to the map.
      // Creating an empty table entry here would change the boss flow's own bookkeeping.
      await this.tactics.setNote(trigger.mapId, note);
    }
    if (heldByPlayer) {
      text +=
        `\n你手写的表还在用;战术官这次写的表没有装上,建议仅供参考,` +
        `要换就自己 set_tactics(地图 ${trigger.mapId})。`;
    }
    await this.recordTacticianCall(trigger, good.length, problems, plan.walkerNotes);
    return { text, tables: good, facts: prepared.facts };
  }

  /** Append one call to the tactician journal; a write failure is logged, never fatal. */
  private async recordTacticianCall(
    trigger: FactsTrigger,
    tables: number,
    problems: readonly string[],
    walkerNotes: string,
  ): Promise<void> {
    try {
      await this.tacticianLog.record({
        mapId: trigger.mapId,
        kind: trigger.kind,
        detail: tacticianOneLine(trigger.detail),
        tables,
        problems: [...problems],
        walkerFirst: firstSentence(walkerNotes),
      });
    } catch {
      // The log is for the sidebar; a failed write must not turn a working tool call into one.
    }
  }

  /**
   * Ask for a new boss table with the original fact sheet plus what has happened since: current
   * forms and HP, the party's HP, the last turns' damage, and the game's own dialog (11-03:
   * 「如果在合并翅膀的时候进行攻击……」). A table that cannot be used leaves the old one in place.
   */
  private async rewriteBoss(
    trigger: FactsTrigger,
    originalFacts: string | undefined,
    reason: string,
    state: {
      readonly enemies: readonly Json[];
      readonly players: readonly Json[];
      readonly history: readonly string[];
      readonly pilot: Pilot;
      readonly gaps?: readonly BattleGap[];
    },
  ): Promise<{ table?: Json; summary: string }> {
    const progress = await this.battleProgress(state.pilot, reason, state);
    // Task 51: the opening call has no pre-fight fact sheet, so build one in the background.
    let facts = originalFacts;
    if (facts === undefined) {
      try {
        facts = await buildFacts(this, trigger);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const text = `战术官没有叫成:${describeError(error)}`;
        await this.recordTacticianCall(trigger, 0, [text], "");
        return { summary: text };
      }
    }
    const outcome = await this.runTactician(trigger, false, `${facts}\n\n${progress}`);
    const table = outcome.tables[0];
    if (table === undefined) return { summary: outcome.text };
    return { table, summary: `新表:${tableSummary(table)}` };
  }

  /** The 「### 战斗到现在」 section for a mid-battle rewrite. */
  private async battleProgress(
    pilot: Pilot,
    reason: string,
    state: {
      readonly enemies: readonly Json[];
      readonly players: readonly Json[];
      readonly history: readonly string[];
      readonly gaps?: readonly BattleGap[];
    },
  ): Promise<string> {
    const sample = record((await pilot.query("sample")).sample);
    const live = record(sample.battle);
    const enemies = records(live.enemies);
    const players = records(live.players);
    const currentEnemies = enemies.length > 0 ? enemies : state.enemies;
    const currentPlayers = players.length > 0 ? players : state.players;
    const lines = ["### 战斗到现在", `为什么要重新写表:${reason}`, "敌人:"];
    if (currentEnemies.length === 0) lines.push("- 读不到敌人");
    for (const enemy of currentEnemies) {
      const id = num(enemy.id);
      lines.push(
        `- ${show(enemy.name)}${id === undefined ? "" : `(编号 ${id})`} ` +
          `HP ${show(enemy.hp)}/${show(enemy.maxHp)}`,
      );
    }
    lines.push(
      "我方:" +
        (currentPlayers.length === 0
          ? "读不到队伍"
          : currentPlayers
              .map((member) => `${show(member.name)} HP ${show(member.hp)}/${show(member.maxHp)}`)
              .join("、")),
    );
    lines.push("最近的出招和效果:");
    if (state.history.length === 0) lines.push("- 还没有出招");
    else for (const line of state.history) lines.push(`- ${line}`);
    const gaps = gapText(state.gaps ?? []);
    if (gaps !== "") lines.push("### 缺口", gaps);
    const dialog = list(record(sample.dialog).lines)
      .map((line) => show(line))
      .filter((line) => line !== "");
    if (dialog.length > 0) {
      lines.push("游戏里的提示或对话:\n" + dialog.map((line) => `- ${line}`).join("\n"));
    }
    return lines.join("\n");
  }

  /** After a tool: the one trigger chooseTrigger finds, if the tactician has not spoken yet. */
  /** Town areas whose maps share the tactician's one call (chooseTrigger). */
  private readonly townsCovered = new Set<string>();
  /** Maps whose boss-prep call has been made (task 42). */
  private readonly bossPrepAsked = new Set<number>();

  /** A map's atlas name; "" when the atlas has not seen it. */
  mapNameOf(mapId: number | null): string {
    if (mapId === null) return "";
    const entry = this.atlas.maps.get(String(mapId)) ?? {};
    return typeof entry.name === "string" ? entry.name : "";
  }

  private mapName(): string {
    return this.mapNameOf(this.mapId);
  }

  /**
   * 11-09 (task 78): the title screen reports map 0 (and a null map means no map yet), so a
   * tactician has nothing to write about. This one gate covers every trigger below.
   */
  private onMap(mapId: number | null = this.mapId): boolean {
    return mapId !== null && mapId > 0 && !this.titleScene;
  }

  /**
   * Task 91: after every tool, if the game-over popup is open, take the user's 11-10 route
   * (否 → 是 → 标题 LoadGame → 20 号位) and report it. Null when there is no popup.
   */
  private async recoverGameover(pilot: Pilot): Promise<string | null> {
    const result = await recoverFromGameover(pilot, this.saveSlot);
    if (result === null) return null;
    if (result.ok) {
      // The countdown ended with the game-over screen; do not keep muting the tactician with
      // the last reading from before the load.
      this.lastTimer = null;
    } else {
      this.onIncident?.(result.text);
    }
    return result.text;
  }

  /** Task 91: Config's thresholds for every patchUp call in this Game. */
  healOptions(): battle.PatchUpOptions {
    return {
      hpTarget: this.healHpPercent,
      mpReservePercent: this.healMpReservePercent,
      itemHpPercent: this.healItemHpPercent,
    };
  }

  /** Standing on the current map's save point (chart read both). */
  private atSavePoint(): boolean {
    return (
      this.lastState === "Player" &&
      this.savePoint !== null &&
      this.lastCell !== null &&
      matchesCell(this.lastCell, this.savePoint)
    );
  }

  /** Task 91: on a save point or at an inn, top up to Config's `healFullPercent`. */
  private async restoreAtSavePoint(pilot: Pilot): Promise<string> {
    const atSave = this.atSavePoint();
    if (!atSave && !(this.lastState === "Player" && this.innHere)) return "";
    const healed = await battle.patchUp(
      pilot,
      () => undefined,
      8,
      (message) => this.onIncident?.(message),
      {
        ...this.healOptions(),
        hpTarget: this.healFullPercent,
        mpReservePercent: 0,
        allowTent: atSave,
      },
    );
    return healed.length === 0 ? "" : `整备:${healed.join(";")}`;
  }

  /** Task 91: before a boss table is written, heal to the full threshold with all MP allowed. */
  private async restoreBeforeBoss(pilot: Pilot): Promise<string> {
    const healed = await battle.patchUp(
      pilot,
      () => undefined,
      8,
      (message) => this.onIncident?.(message),
      {
        ...this.healOptions(),
        hpTarget: this.healFullPercent,
        mpReservePercent: 0,
        allowTent: this.atSavePoint(),
      },
    );
    return healed.length === 0 ? "" : `首领前整备:${healed.join(";")}`;
  }

  /**
   * Task 110: the player's own table holds while the party is still on the map it was written
   * for. A background call that finishes after they left is free to install (tactician takes
   * over again); a call that finishes while they are still there must not replace it.
   */
  private playerTableHolds(mapId: number | null = this.mapId): boolean {
    if (mapId === null || mapId <= 0 || this.mapId !== mapId) return false;
    return this.tactics.isPlayerTable(mapId);
  }

  /**
   * Task 110: with a player table in use, only a hard/lost battle may still start a tactician
   * call. chooseTrigger may report that battle as `new-monster` when a fresh boss appeared at
   * the same time, so the last battle's verdict counts too.
   */
  private playerTableAllowsCall(trigger: Pick<TriggerReason, "kind" | "mapId">): boolean {
    if (trigger.kind === "bad-battle") return true;
    const last = this.lastBattle;
    return (
      trigger.kind === "new-monster" &&
      last !== null &&
      last.mapId === trigger.mapId &&
      (last.verdict === "hard" || last.verdict === "lost")
    );
  }

  private async afterTool(pilot: Pilot): Promise<string> {
    // The previous background call may have finished while this tool was running.
    const lines = this.backgroundNotices.splice(0);
    const finish = (): string => lines.filter((line) => line !== "").join("\n");
    // Task 105: no tactician during a scout; the next tool call after it restores the normal flow.
    if (this.scouting) return finish();
    // Task 89: during a countdown the party stays on the clock, so even the background
    // tactician is not started; the next call after the timer ends picks the map back up.
    if (this.lastTimer?.active === true) return finish();
    if (this.tactician === undefined || !this.onMap()) return finish();
    // Task 106: the last save/recovery point before the boss rewrites a table that the walk's
    // job changes made stale. It runs before the road triggers so the same tool cannot start
    // two tactician calls.
    if (!this.tacticianCalled) {
      const bossCheck = await this.stageBossCheckpointCheck(pilot);
      if (bossCheck !== "") {
        lines.push(bossCheck);
        return finish();
      }
    }
    if (this.tacticianCalled) return finish();
    const mapId = this.mapId;
    if (mapId !== null) {
      // Task 42: before the map's next battle, check the table against the party as it is now.
      // Task 110: a table the player wrote by hand is not rewritten behind their back, so the
      // party-changed check waits until they leave the map and the mark is retired.
      const table = this.tactics.current(mapId);
      if (table !== null && !this.playerTableHolds(mapId)) {
        const sample = await this.sampleNow(pilot);
        const changed = partyChangedProblem(table, readParty(sample), this.tactics.party(mapId));
        if (changed.length > 0) {
          this.lastBattle = null;
          const started = await this.startBackground(
            { kind: "party-changed", mapId, detail: changed.join(";"), pilot },
            true,
          );
          if (started.attempted) this.clearRoadState();
          if (started.text !== "") lines.push(started.text);
          return finish();
        }
      }
      // Task 42: the guide marks a boss on this map (or look_around named one): write its
      // table once, before the fight, and keep it for the battle that starts by itself. Bosses
      // stay synchronous: the table must be there before the fight (task 86).
      if (this.tactics.boss(mapId) === null && !this.bossPrepAsked.has(mapId)) {
        const names = await this.bossNamesHere(pilot);
        if (names.length > 0) {
          this.bossPrepAsked.add(mapId);
          // Task 91: the party the tactician writes for is the healed one, and the boss
          // fight starts from the full threshold.
          const prepared = await this.restoreBeforeBoss(pilot);
          if (prepared !== "") lines.push(prepared);
          const outcome = await this.runTactician(
            {
              kind: "boss-prep",
              mapId,
              detail: `攻略标了首领:${names.join("、")}`,
              monsters: names,
              pilot,
            },
            false,
          );
          const table = outcome.tables[0];
          if (table !== undefined) {
            const info = this.tacticianInfoByMap.get(mapId);
            await this.tactics.setBoss(mapId, {
              table,
              result: "首领战前准备",
              at: new Date().toISOString(),
              ...(info === undefined ? {} : { walkerNotes: info.walkerNotes, askUp: info.askUp }),
              prepared: true,
            });
            lines.push(`${outcome.text}\n首领表已经按地图 ${mapId} 存好,开打时直接用。`);
          } else if (outcome.text !== "") {
            lines.push(outcome.text);
          }
          return finish();
        }
      }
    }
    const area = areaOf(this.mapName());
    const met = [...(this.events?.enemies.get(this.mapId) ?? new Set<string>())];
    const reason = chooseTrigger({
      mapId: this.mapId,
      tactics: this.tactics,
      met,
      lastBattle: this.lastBattle,
      blocked: this.blocked,
      ride: this.ride,
      partyChanged: null,
      mapName: this.mapName(),
      townsCovered: this.townsCovered,
      bossNames: this.guide?.bossNames(area) ?? [],
    });
    if (reason === null) return finish();
    // Task 110: on a map where the player's own table is in use, no road trigger writes a new
    // table except a hard/lost battle. That call runs, but applyPlan only attaches its advice.
    if (this.playerTableHolds(this.mapId) && !this.playerTableAllowsCall(reason)) return finish();
    if (reason.kind === "new-map" && isTown(area)) this.townsCovered.add(area);
    const last = this.recentRecord(this.mapId);
    const trigger: FactsTrigger = {
      ...reason,
      pilot,
      ...(last === undefined ? {} : { record: last }),
    };
    const started = await this.startBackground(trigger, true);
    if (started.attempted) this.clearRoadState(reason.kind);
    if (started.text !== "") lines.push(started.text);
    return finish();
  }

  /** Forget the road events once a call is on its way; an interval-skipped one stays. */
  private clearRoadState(kind?: string): void {
    this.lastBattle = null;
    if (kind === "blocked") this.blockedCounts.clear();
    this.blocked = null;
    this.ride = null;
  }

  /** Task 86: two road triggers for one map are at least Config's minutes apart. */
  private roadGap(pilot: Pilot, mapId: number): boolean {
    if (this.tacticianIntervalMinutes <= 0) return true;
    const last = this.roadCallAt.get(mapId);
    return last === undefined || pilot.now() - last >= this.tacticianIntervalMinutes * 60_000;
  }

  /**
   * Start a road trigger in the background. The child is published before this returns; the
   * caller only waits for the facts and the dsh activation, never for the rules themselves.
   */
  private async startBackground(
    trigger: FactsTrigger,
    install: boolean,
  ): Promise<{ readonly text: string; readonly attempted: boolean }> {
    const runner = this.tactician;
    if (runner === undefined) return { text: "", attempted: false };
    // Task 110: the player's hand-written table holds until they leave the map; only a
    // hard/lost battle may still start a call (its table is not installed, only its advice).
    if (this.playerTableHolds(trigger.mapId) && !this.playerTableAllowsCall(trigger)) {
      return { text: "", attempted: false };
    }
    if (!this.roadGap(trigger.pilot, trigger.mapId)) return { text: "", attempted: false };
    if (this.background !== null) {
      if (this.background.mapId === trigger.mapId) {
        // Already writing this map: one child at a time and no duplicate (task 86).
        return { text: "", attempted: true };
      }
      const prepared = await this.prepareTactician(trigger);
      if ("error" in prepared) return { text: prepared.error, attempted: true };
      this.pending = { trigger, prepared, install };
      return {
        text:
          `战术官还在后台写地图 ${this.background.mapId} 的规则表;` +
          `地图 ${trigger.mapId} 的等它写完再写,写好之前按现有表 / 默认规则打`,
        attempted: true,
      };
    }
    const prepared = await this.prepareTactician(trigger);
    if ("error" in prepared) {
      await this.recordTacticianCall(trigger, 0, [prepared.error], "");
      return { text: prepared.error, attempted: true };
    }
    let call: TacticianCall;
    try {
      call = asTacticianCall(runner(prepared.facts, { background: true }));
    } catch (error) {
      if (isAbortError(error)) throw error;
      const text = `战术官没有叫成:${describeError(error)}`;
      await this.recordTacticianCall(trigger, 0, [text], "");
      return { text, attempted: true };
    }
    try {
      await call.started;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const text = `战术官没有叫成:${describeError(error)}`;
      await this.recordTacticianCall(trigger, 0, [text], "");
      return { text, attempted: true };
    }
    this.tacticianCalled = true;
    this.roadCallAt.set(trigger.mapId, trigger.pilot.now());
    this.launchBackground(trigger, prepared, install, call);
    return {
      text: `战术官在后台写地图 ${trigger.mapId} 的规则表，写好之前按现有表 / 默认规则打`,
      attempted: true,
    };
  }

  /** Track one started background call; its text waits for the next tool result (task 86). */
  private launchBackground(
    trigger: FactsTrigger,
    prepared: TacticianFacts,
    install: boolean,
    call: TacticianCall,
  ): void {
    const entry: BackgroundCall = {
      mapId: trigger.mapId,
      task: Promise.resolve(),
    };
    this.background = entry;
    entry.task = this.finishBackground(trigger, prepared, install, call).finally(() => {
      if (this.background === entry) this.background = null;
      this.startPending();
    });
  }

  /** Wait for the background plan, install it, and leave its text for the next tool. */
  private async finishBackground(
    trigger: FactsTrigger,
    prepared: TacticianFacts,
    install: boolean,
    call: TacticianCall,
  ): Promise<void> {
    try {
      let facts = prepared.facts;
      let plan = await call.result;
      let problems = this.planProblems(plan, prepared);
      // Same two retries as the synchronous path, but each child starts in the background so
      // the tool call that queued it has long returned (task 86).
      for (let attempt = 0; attempt < 2 && problems.length > 0; attempt++) {
        // Task 110: the player wrote a table while this call was running; retrying for a table
        // that will not be installed only spends another child.
        if (this.playerTableHolds(trigger.mapId)) break;
        const runner = this.tactician;
        if (runner === undefined) break;
        facts +=
          "\n\n### 上次交回的规则表有问题\n" +
          problems.join("\n") +
          "\n请改好再交:1–3 套,每套 {角色名: [规则…]}。";
        const next = asTacticianCall(runner(facts, { background: true }));
        await next.started;
        plan = await next.result;
        problems = this.planProblems(plan, prepared);
      }
      const outcome = await this.applyPlan(trigger, plan, problems, prepared, install);
      this.backgroundNotices.push(outcome.text);
    } catch (error) {
      if (isAbortError(error)) {
        this.backgroundNotices.push(`战术官(地图 ${trigger.mapId})在后台被取消,规则表没有写成。`);
        return;
      }
      const text = `战术官在后台写地图 ${trigger.mapId} 时出错:${describeError(error)}`;
      this.backgroundNotices.push(text);
      await this.recordTacticianCall(trigger, 0, [text], "");
    }
  }

  /** Start the one waiting trigger after the previous background call has installed. */
  private startPending(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    const runner = this.tactician;
    if (runner === undefined) return;
    // Task 110: the player wrote a table for that map while this trigger waited; a non-bad
    // road trigger is pointless now, and its result would not be installed anyway.
    if (
      this.playerTableHolds(pending.trigger.mapId) &&
      !this.playerTableAllowsCall(pending.trigger)
    ) {
      return;
    }
    let call: TacticianCall;
    try {
      call = asTacticianCall(runner(pending.prepared.facts, { background: true }));
    } catch (error) {
      const text = `战术官没有叫成:${describeError(error)}`;
      this.backgroundNotices.push(text);
      void this.recordTacticianCall(pending.trigger, 0, [text], "");
      return;
    }
    const entry: BackgroundCall = {
      mapId: pending.trigger.mapId,
      task: Promise.resolve(),
    };
    this.background = entry;
    entry.task = (async () => {
      try {
        await call.started;
      } catch (error) {
        if (isAbortError(error)) {
          this.backgroundNotices.push(
            `战术官(地图 ${pending.trigger.mapId})在后台被取消,规则表没有写成。`,
          );
          return;
        }
        const text = `战术官没有叫成:${describeError(error)}`;
        this.backgroundNotices.push(text);
        await this.recordTacticianCall(pending.trigger, 0, [text], "");
        return;
      }
      this.roadCallAt.set(pending.trigger.mapId, pending.trigger.pilot.now());
      await this.finishBackground(pending.trigger, pending.prepared, pending.install, call);
    })().finally(() => {
      if (this.background === entry) this.background = null;
      this.startPending();
    });
  }

  /** The freshest party read, for the party-changed check. */
  private async sampleNow(pilot: Pilot): Promise<Json> {
    const live = this.events?.liveSample() ?? null;
    if (live !== null) return live;
    return record((await pilot.query("sample")).sample);
  }

  /** The newest battle on this map, for the debrief fact sheet. */
  private recentRecord(mapId: number | null) {
    if (mapId === null) return undefined;
    const found = this.battles.recentRecords().filter((record) => record.mapId === mapId);
    return found[found.length - 1];
  }

  /** Boss names the guide marks for this area, or a boss-looking event cell (task 42). */
  private async bossNamesHere(pilot: Pilot): Promise<string[]> {
    const sample = await this.sampleNow(pilot);
    const area = text(record(sample.user).areaText) ?? this.mapName();
    const names = new Set(this.guide?.bossNames(area) ?? []);
    let entities: readonly Json[];
    try {
      entities = records(
        record((await pilot.send("entities", { kind: "Event", max: 200 })).entities).entities,
      );
    } catch {
      entities = [];
    }
    const eventNames = entities
      .map((entity) => text(entity.name) ?? "")
      .filter((name) => name !== "");
    for (const name of [...names]) {
      if (eventNames.some((event) => event.includes(name) || name.includes(event))) names.add(name);
    }
    for (const event of eventNames) {
      if (/boss|首领|ボス/iu.test(event)) names.add(event);
    }
    return [...names];
  }

  /** Remember blocked steps and conveyor rides from this tool's walking messages. */
  private noteTravel(message: string, mapId: number | null): void {
    if (mapId === null) return;
    for (const match of message.matchAll(/\[(\d+), (\d+)\] 被挡住/gu)) {
      const cell: Cell = [Number(match[1]), Number(match[2])];
      const key = `${mapId}:${cell[0]},${cell[1]}`;
      const count = (this.blockedCounts.get(key) ?? 0) + 1;
      this.blockedCounts.set(key, count);
      if (count >= 3) {
        this.blocked = { count, detail: `在 (${cell[0]}, ${cell[1]}) 被挡住` };
      }
    }
    // Task 84: the message now starts with the cell ("在 (13,25) 踩到传送带，被带到 …") and
    // the old bare form is still read for a stored or slightly older walk.
    const ride =
      /在 \((\d+), (\d+)\) 踩到传送带，被带到 \((\d+), (\d+)\)|踩到传送带 \((\d+), (\d+)\),被带到 \((\d+), (\d+)\)/u.exec(
        message,
      );
    if (ride !== null) this.ride = ride[0];
  }

  /** Record the current map's exits and chests in the atlas; returns the map id. */
  async chart(pilot: Pilot): Promise<number | null> {
    const pos = record((await pilot.send("pos")).pos);
    this.lastCell = cellOf(pos.cell);
    this.lastState = text(pos.state) ?? "";
    // 11-09 (task 78): Title has map 0 and no real scene; keep that out of tactician calls.
    this.titleScene =
      pos.state === "GotoTitle" || pos.state === "Init" || text(record(pos.scene).name) === "Title";
    const mapId = num(pos.map) ?? null;
    // Task 110: the player's hand-written table lasts only until they leave that map. Retire
    // the mark on the map being left; map 0/title is not "another map", so it does not count,
    // and a scout walks through other maps only to come back to this save, so it does not.
    const previous = this.mapId;
    if (
      !this.scouting &&
      mapId !== null &&
      mapId > 0 &&
      previous !== null &&
      previous > 0 &&
      previous !== mapId
    ) {
      await this.tactics.retirePlayerSource(previous);
    }
    if (mapId === null || pos.state === "ChangeMap" || pos.state === "FieldReady") return mapId;
    // Task 75: keep the collision data of every indoor map as it is entered, not on every
    // tool (chart runs after each one). A re-entry has a different previous map id; the story
    // changes maps, so the newest entry overwrites the file. The world map has terrain, not
    // layers, and is never cached.
    if (mapId !== 1 && this.mapId !== mapId) {
      try {
        const collision = record((await pilot.send("collision")).collision);
        await this.collisions.remember(mapId, collision);
      } catch {
        // A map still loading or an older bridge: the atlas and the hints still work.
      }
    }
    const found = new Map<string, Json[]>();
    for (const kind of ["GotoMap", "TresureBox", "Event"]) {
      const listing = record((await pilot.send("entities", { kind, max: 200 })).entities);
      found.set(
        kind,
        records(listing.entities).filter((entity) =>
          entity.active === undefined ? true : truthy(entity.active),
        ),
      );
    }
    const sample =
      (this.events ? this.events.liveSample() : null) ??
      record((await pilot.query("sample")).sample);
    const user = record(sample.user);
    const name = [user.areaText, user.locationText]
      .map((value) => text(value))
      .filter((value): value is string => value !== undefined && value !== "")
      .join(" ");
    this.innHere = /宿屋|旅馆|旅店|\bInn\b/iu.test(name);
    const exits: Json[] = [];
    for (const entity of found.get("GotoMap") ?? []) {
      if (!truthy(entity.cell) || entity.toMap === null || entity.toMap === undefined) continue;
      exits.push({
        cell: entity.cell,
        to: entity.toMap,
        name: text(entity.name) ?? "",
      });
    }
    // A town's way out to the world map can be an event, not an entrance (10-22: Karnak's
    // at (27,45); the player found no exit and walked the town for fifty steps).
    for (const entity of found.get("Event") ?? []) {
      if (!truthy(entity.cell) || !(text(entity.name) ?? "").includes(WORLD_EXIT)) continue;
      exits.push({ cell: entity.cell, to: 1, name: text(entity.name) ?? "" });
    }
    const chests = (found.get("TresureBox") ?? []).map((entity) => {
      // 11-11 (task 116): bridge 0.13.6 gives what a chest holds, so the route book can pair
      // it with the guide instead of the truncated Japanese entity name. Copy only what the
      // bridge sent, so an older bridge still records just cell and name. `opened` is this
      // save's progress, not part of the map record.
      const chest: Json = { cell: entity.cell, name: text(entity.name) ?? "" };
      for (const key of ["content", "num", "flag", "hidden", "contentName"] as const) {
        const value = entity[key];
        if (value !== undefined && value !== null) chest[key] = value;
      }
      return chest;
    });
    await this.atlas.visit(mapId, name, exits, chests);
    const savePoint = (found.get("Event") ?? []).find((entity) =>
      (text(entity.name) ?? "").includes("SavePoint"),
    );
    this.savePoint = savePoint ? cellOf(savePoint.cell) : null;
    return mapId;
  }

  /** Remember where the drake was left, across runs (the file next to the atlas). */
  async keepDrake(): Promise<void> {
    const path = this.atlas.path ? join(dirname(this.atlas.path), "drake.json") : undefined;
    if (path === undefined) return;
    if (this.moveState.drake === null) {
      if (!(await fileExists(path))) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, { encoding: "utf8" }));
      } catch (error) {
        throw new Error(`读不懂飞龙位置 ${path}:${describeError(error)}`, {
          cause: error,
        });
      }
      const cell = cellOf(parsed);
      if (cell === null) throw new Error(`飞龙位置 ${path} 不是 [x, y]`);
      this.moveState.drake = cell;
    } else {
      try {
        await writeFile(path, JSON.stringify(this.moveState.drake), "utf8");
      } catch (error) {
        throw new Error(`写不了飞龙位置 ${path}:${describeError(error)}`, {
          cause: error,
        });
      }
    }
  }

  /** An entrance (town, castle, dungeon) on the world map at or right next to goal. */
  async worldEntrance(pilot: Pilot, goal: Cell): Promise<boolean> {
    const found = record((await pilot.send("entities", { kind: "GotoMap", max: 300 })).entities);
    return records(found.entities).some((entity) => {
      const cell = cellOf(entity.cell);
      return cell !== null && Math.abs(cell[0] - goal[0]) + Math.abs(cell[1] - goal[1]) <= 1;
    });
  }

  async gearInBag(pilot: Pilot): Promise<Record<string, number>> {
    const held = records(record((await pilot.query("items")).items).normal);
    const bag: Record<string, number> = {};
    for (const item of held) {
      const entry = record(item);
      const type = text(entry.type);
      const name = cleanName(entry.name);
      if (type === undefined || !GEAR.has(type) || name === "") continue;
      bag[name] = num(entry.count) ?? 0;
    }
    return bag;
  }

  /**
   * New weapons or armour in the bag since the last look (a chest, an event, a shop): put on
   * the strongest, the game's own 最强装备 deciding who wears what, and say what changed. Gear
   * put on leaves the bag, so that is never new. Waits for the field: in a shop or a dialog the
   * new gear stays new until the next look (10-21: the Mythril helmet from North Mountain went
   * unworn).
   */
  async checkGear(pilot: Pilot): Promise<string> {
    const bag = await this.gearInBag(pilot);
    if (this.gear === null) {
      this.gear = bag;
      return "";
    }
    const before = this.gear;
    const fresh = Object.entries(bag)
      .filter(([name, count]) => count > (before[name] ?? 0))
      .map(([name]) => name);
    if (fresh.length === 0) {
      this.gear = bag;
      return "";
    }
    if (record((await pilot.send("pos")).pos).state !== "Player") return "";
    const [ok, detail] = await this.optimizeEquipment(pilot);
    this.gear = await this.gearInBag(pilot);
    if (ok && this.events) this.events.note("equip", detail);
    return `得到新装备「${fresh.join("、")}」,已检查最强装备:${detail}`;
  }

  /**
   * The guides' warnings for an area entered and for monsters met for the first time (control
   * plan §4.11; 10-21: Jackanapes, "RUN from" it, wiped the party twice).
   */
  guideHint(): string {
    if (this.guide === null) return "";
    const out: string[] = [];
    const sample = (this.events ? this.events.liveSample() : null) ?? {};
    const area = text(record(sample.user).areaText);
    if (area !== undefined && area !== "" && !this.advised.has(area)) {
      this.advised.add(area);
      const warnings = this.guide.warnings(area);
      if (warnings.length > 0)
        out.push(`攻略(「${area}」):${warnings.join(";")}。详情用 guide 查。`);
    }
    const met =
      (this.events && this.mapId !== null ? this.events.enemies.get(this.mapId) : null) ??
      new Set<string>();
    for (const name of [...met].sort()) {
      if (this.advised.has(name)) continue;
      this.advised.add(name);
      const book = this.events?.books.get(name);
      const note = book !== undefined ? this.guide.monsterNote(book) : "";
      if (note !== "") out.push(`攻略(怪物「${name}」= #${String(book).padStart(3, "0")}):${note}`);
    }
    return out.join("\n");
  }

  /**
   * In a town (its exits lead to an inn or shops) with the party below full: say to get ready
   * there first, once per visit (10-21: the party left Walse at half HP, with its shops
   * unvisited, and fell in the castle basement).
   */
  async townHint(pilot: Pilot): Promise<string> {
    const entry = this.atlas.maps.get(String(this.mapId)) ?? {};
    const names = records(entry.exits)
      .map((exit) => text(exit.name) ?? "")
      .join(" ");
    if (this.mapId === this.town || !TOWN_WORDS.some((word) => names.includes(word))) return "";
    const party = await menu.partyState(pilot);
    const hp: [number, number] = [
      party.reduce((sum, member) => sum + (num(member.hp) ?? 0), 0),
      party.reduce((sum, member) => sum + (num(member.maxHp) ?? 0), 0),
    ];
    const mp: [number, number] = [
      party.reduce((sum, member) => sum + (num(member.mp) ?? 0), 0),
      party.reduce((sum, member) => sum + (num(member.maxMp) ?? 0), 0),
    ];
    this.town = this.mapId;
    const sample = (this.events ? this.events.liveSample() : null) ?? {};
    const area = text(record(sample.user).areaText) ?? "";
    const stock = this.townStock(area);
    const lines: string[] = [];
    if (hp[0] < hp[1] || mp[0] < mp[1]) {
      lines.push(
        `提示:这里是城镇,队伍 HP ${hp[0]}/${hp[1]}、MP ${mp[0]}/${mp[1]} 没满。` +
          "出发去迷宫前先整备:住店回满;看看魔法店、武器防具店有没有新东西" +
          "(买到的装备会自动穿上)。",
      );
    }
    const ailing = new Set<string>();
    for (const member of party) {
      for (const status of gambit.statuses(member)) {
        if (status in gambit.CURES) ailing.add(status);
      }
    }
    if (ailing.size > 0) {
      const sorted = [...ailing].sort();
      const items = sorted.flatMap((status) => {
        const cure = gambit.CURES[status];
        return cure && truthy(cure[1]) ? [cure[1]] : [];
      });
      lines.push(
        `提示:队伍有状态异常(${sorted.join("、")}),住店能治好;` +
          `道具店买些治它的道具(${items.join("、")})带着,战斗里会自动用。`,
      );
    }
    if (stock !== "") {
      lines.push(`攻略:${area}的商店卖 ${stock}。详情用 guide(kind=shop)查。`);
    }
    return lines.join("\n");
  }

  /**
   * Ailments nobody can cure now (no item in the bag, no white mage with MP): say what to buy
   * and where, once per group of ailing members, or again on a new map. 10-27: Bartz and Lenna
   * stayed blind through the whole Fire-Powered Ship because nothing said the bag had no Eye
   * Drops.
   */
  async ailmentHint(pilot: Pilot): Promise<string> {
    const sample =
      (this.events ? this.events.liveSample() : null) ??
      record((await pilot.query("sample")).sample);
    const party = records(sample.party);
    const groups = new Map<string, string[]>();
    for (const member of party) {
      for (const status of gambit.statuses(member)) {
        if (!(status in gambit.CURES)) continue;
        groups.set(status, [...(groups.get(status) ?? []), show(member.name)]);
      }
    }
    if (groups.size === 0) {
      this.ailmentCombo = "";
      return "";
    }
    const held = await battle.heldItems(pilot);
    const uncured: [string, string[]][] = [];
    for (const [status, names] of groups) {
      const cure = gambit.CURES[status];
      if (cure === undefined) continue;
      const [spell, item] = cure;
      const hasItem = Object.entries(held).some(
        ([name, count]) => count > 0 && (name.includes(item) || item.includes(name)),
      );
      const canCast =
        spell !== null &&
        party.some(
          (member) =>
            member.jobName === "白魔法师" &&
            (num(member.hp) ?? 0) > 0 &&
            (num(member.mp) ?? 0) >= 2,
        );
      if (!hasItem && !canCast) uncured.push([status, names.sort()]);
    }
    if (uncured.length === 0) {
      this.ailmentCombo = "";
      return "";
    }
    const combo = uncured.map(([status, names]) => `${status}:${names.join("、")}`).join(";");
    if (combo === this.ailmentCombo && this.mapId === this.ailmentMap) return "";
    this.ailmentCombo = combo;
    this.ailmentMap = this.mapId;
    const area = text(record(sample.user).areaText) ?? "";
    return uncured
      .map(([status, names]) => {
        const item = gambit.CURES[status]?.[1] ?? "";
        const shop = shopSelling(this.guide, area, item);
        return (
          `${names.join("、")} ${status}:包里没有${item},没人会治。` +
          `${shop !== "" ? `去${shop}买${item}` : `去商店买${item}`},或者住店。`
        );
      })
      .join("\n");
  }

  /** The magic and gear the guide lists for this town's shops, names and prices. */
  townStock(area: string): string {
    if (this.guide === null || area === "") return "";
    const parts: string[] = [];
    for (const section of this.guide.sectionsFor(area).slice(0, 1)) {
      for (const table of section.shops ?? []) {
        if (!["魔法", "武器", "防具", "饰品", "盾", "头盔"].includes(table.kind)) continue;
        const goods = table.goods
          .map((good) => `${good.name} ${truthy(good.cost) ? good.cost : "?"}`)
          .join("、");
        parts.push(`${table.kind}:${goods}`);
      }
    }
    return parts.join(";");
  }

  /** Monsters met on this map and no tactics for them yet: ask for some (§4.10). */
  tacticsHint(): string {
    if (this.tactician !== undefined) return ""; // the tactician writes these tables now
    if (this.mapId === null || this.mapId === 1 || this.tactics.has(this.mapId)) return "";
    const met = [
      ...((this.events ? this.events.enemies.get(this.mapId) : null) ?? new Set<string>()),
    ].sort();
    if (met.length === 0) return "";
    return (
      `提示:这张地图遇到过的怪物有 ${met.join("、")},还没有战斗策略。` +
      "用 set_tactics 针对它们写 2–3 套规则表(主策略和备用策略),普通战斗就会按策略打。"
    );
  }

  /**
   * A save point on this map and no save for a while (10-20: run 8 walked past one with
   * nothing saved since the canal): say so; saving stays the player's call.
   */
  saveHint(): string {
    if (this.savePoint === null) return "";
    const last = this.events ? this.events.lastSaveMinutes() : null;
    if (last !== null && last < 10) return "";
    const since =
      last === null ? "这次还没存过档" : `上次存档是 ${pyRound(last, 0).toFixed(0)} 分钟前`;
    return `提示:这张地图有存档点 (${this.savePoint[0]}, ${this.savePoint[1]}),${since}。站上去用 save_game 可以存档。`;
  }

  /**
   * After interact: standing somewhere far from where the press was made, on the same map,
   * means a jump stone carried the party; the atlas keeps it as a link. A changed map id is
   * a lift ride instead: the edge is cross-map and keeps the standing cell, the direction
   * pressed, the target map and the landing cell (task 71, Fire-Powered Ship 257 → 634).
   */
  async noteJump(
    pilot: Pilot,
    message: string,
    startMap: number | null = null,
    press: Cell | null = null,
  ): Promise<void> {
    const match = /站在 \((\d+), (\d+)\)/u.exec(message);
    const facing = /面朝(Up|Down|Left|Right)/u.exec(message);
    const pos = record((await pilot.send("pos")).pos);
    const cell = cellOf(pos.cell);
    const map = num(pos.map);
    if (match === null || cell === null) return;
    const start: Cell = [Number(match[1]), Number(match[2])];
    if (map !== undefined && startMap !== null && map !== startMap) {
      const dir = facing?.[1];
      if (press !== null && dir !== undefined) {
        let layer: number | null = null;
        try {
          layer = await move.collisionLayer(pilot);
        } catch {
          // An older bridge or a test without the reply: the landing is still recorded.
        }
        await this.atlas.ride(startMap, start, press, dir, map, cell, "坐一趟", layer);
      }
      return;
    }
    if (pos.state !== "Player") return;
    if (Math.abs(cell[0] - start[0]) + Math.abs(cell[1] - start[1]) > 1) {
      await this.atlas.link(pos.map, start, cell, "调查后跳");
    }
  }

  /** Towns, dungeons, the canal: the collision grid with the entities marked. */
  async floor(pilot: Pilot, radius: number): Promise<string> {
    const collision = record((await pilot.send("collision")).collision);
    const grid = nav.layeredGrid(collision, new Set());
    if (grid === null) return "这里读不到地图(可能正在切换地图)";
    const marks = new Map<string, string>();
    const all = record((await pilot.send("entities", { kind: "All", max: 400 })).entities);
    for (const entity of records(all.entities)) {
      for (const cell of view.fallCells(entity)) {
        marks.set(nav.cellKey(cell[0], cell[1]), "H");
      }
    }
    for (const [kind, [baseMark]] of FLOOR_MARKS) {
      const found = record((await pilot.send("entities", { kind, max: 200 })).entities);
      for (const entity of records(found.entities)) {
        const cell = cellOf(entity.cell);
        const name = text(entity.name) ?? "";
        let mark = baseMark;
        if (kind === "Event" && view.eventNote(name) !== "") mark = "B";
        if (kind === "PointIn") {
          // Most PointIn cells are arrival markers; only the named landing spots matter on
          // the map (11-03, Fire-Powered Ship 261).
          if (!name.includes("落下点")) continue;
          mark = "F";
        }
        const named =
          (kind !== "DefaultEntity" && kind !== "DefaultAnimEntity") ||
          (name !== "" && !name.includes("吹き出し") && !name.includes("【汎用】"));
        if (truthy(entity.active === undefined ? true : entity.active) && cell !== null && named) {
          const key = nav.cellKey(cell[0], cell[1]);
          if (!marks.has(key)) marks.set(key, mark);
        }
      }
    }
    return renderFloor(nav.layeredView(grid), radius, marks);
  }

  async run(name: string, args: Json, pilot: Pilot, signal?: AbortSignal): Promise<string> {
    const handler = this.handlers.get(name);
    if (handler === undefined) return `未知工具 ${name}`;
    this.tacticianCalled = false;
    this.blocked = null;
    this.ride = null;
    this.leaveNotice = null;
    this.lastBattle = null;
    this.stageBossWon = false;
    this.stageNotice = "";
    // Task 113: the model's own calls are the denominator of the stage report; internal calls
    // made by the route executor do not pass through `run`.
    this.stageCallName = name;
    await this.stageTrackTool(name);
    const outcome = await handler(args, pilot, signal);
    // Task 117: while a handoff is pending, the model's own action names the cell to learn.
    await this.captureBookCell(name, args, pilot, outcome.text);
    // Task 91: a wait can stop on a game-over popup; recover before the usual settle/hints.
    const ended = await this.recoverGameover(pilot);
    if (ended !== null) {
      return [outcome.text, ended].filter((part) => part !== "").join("\n");
    }
    if (outcome.early) {
      const timed = this.lastCompletion === null ? "" : timedLine(this.lastCompletion);
      return timed === "" ? outcome.text : `${outcome.text}\n${timed}`;
    }
    const text = outcome.text;
    const settled = await this.settle(pilot);
    // A wipe during settle opens the same popup after the handler's own check.
    const endedAfterSettle = await this.recoverGameover(pilot);
    if (endedAfterSettle !== null) {
      return [text, settled, endedAfterSettle].filter((part) => part !== "").join("\n");
    }
    this.mapId = await this.chart(pilot);
    // Task 97: a battle or a new map in the destination runs the plan's turn-back check.
    const stageEntered = this.stageLastMap !== this.mapId;
    this.stageLastMap = this.mapId;
    const stageBattle = await this.stageAfterBattle(
      pilot,
      stageEntered || Boolean(this.lastBattle),
    );
    // Task 91: a save point (or an inn) tops the party up before the next hint.
    const restored = await this.restoreAtSavePoint(pilot);
    if (this.lastCompletion !== null && this.lastCompletion.mapId !== this.mapId) {
      this.lastCompletionAt = 0; // a new map always needs a fresh completion line
    }
    this.noteTravel(text, this.mapId);
    await this.keepDrake();
    const gear = await this.checkGear(pilot);
    const news = this.news();
    const hints = [
      this.guideHint(),
      this.saveHint(),
      this.tacticsHint(),
      await this.townHint(pilot),
      await this.ailmentHint(pilot),
    ];
    const hint = hints.filter((line) => line !== "").join("\n");
    // A tool can open a chest, win a battle or change the map: always read the result fresh.
    // Read it before the tactician, whose fact sheet carries this same line.
    this.lastCompletionAt = 0;
    const completion = await this.completionReport(pilot);
    const stageDone = await this.stageCompletion(pilot);
    const tactical = await this.afterTool(pilot);
    const parts = [
      text,
      settled,
      restored,
      this.stageNotice,
      stageBattle,
      stageDone,
      completion.line,
      completion.timed,
      this.leaveMessage(),
      gear,
      news !== "" ? "新的重要事件:\n" + news : "",
      hint,
      tactical,
      "当前状态:\n" + (await this.observe(pilot)),
    ];
    return parts.filter((part) => part !== "").join("\n");
  }

  /**
   * Task 69: the world-map encounter grid at one cell. The caller prefers a single `map.grids`
   * value; otherwise this asks `encountgrid` (cached). Null means unreadable, so callers fall
   * back to the old region rectangle rather than pretending the party is on another grid.
   */
  private async worldGridAt(
    pilot: Pilot,
    mapId: number | null,
    cell: readonly [number, number] | null,
    fallback: number | null,
  ): Promise<number | null> {
    if (cell === null) return fallback;
    try {
      const grids = await this.encounterGrids.read(pilot, mapId, [cell]);
      return grids.get(nav.cellKey(cell[0], cell[1])) ?? fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Task 45: ask the bridge for the current map's completion and update the save-local bestiary.
   * `force` skips the short cache (a leave check must see the chest just opened).
   */
  private async refreshCompletion(
    pilot: Pilot,
  ): Promise<import("./completion.ts").CompletionState | null> {
    let pos;
    try {
      const reply = await pilot.send("pos");
      pos = parsePositionReply(reply);
      // Task 89: pos.timer is bridge 0.14.3's countdown; an older bridge has no field and
      // leaves the previous reading alone, so the route tool's own watch decides.
      const timer = parseRouteTimer(record(reply.pos).timer);
      if (timer !== null) {
        this.lastTimer = timer;
      } else if (this.lastTimer?.active === true) {
        // 0.14.3 may omit the field once the countdown is over; ask sample once before
        // keeping the old reading, so a finished timer cannot mute the tactician forever.
        try {
          this.lastTimer = parseRouteTimer(record((await pilot.query("sample")).sample).timer);
        } catch {
          this.lastTimer = null;
        }
      }
    } catch {
      return this.lastCompletion;
    }
    let data;
    try {
      data = parseAchievements(await pilot.query("achievements"));
    } catch {
      return this.lastCompletion;
    }
    this.lastAchievements = data;
    const profile = profileFor(this.game);
    // Fold the incidents first: an unreadable entities/encounters reply must not lose them.
    try {
      const missed = missedTreasureByArea(data, profile);
      const created = await this.incidents.observe(missed);
      for (const incident of created) {
        this.onIncident?.(
          `${incident.place} 错过 ${incident.lost} 个宝箱(累计 ${incident.total} 个)` +
            (incident.supplement === true ? "，补记" : ""),
        );
      }
    } catch {
      // The completion line is still useful when the incident file cannot be written.
    }
    try {
      const records = await this.scoutFreeRecords(await this.battles.allRecords());
      const names = this.bestiaryNames();
      this.bestiary.restore(pos.saves, records, names);
      this.bestiary.observeRecords(
        await this.scoutFreeRecords(this.battles.recentRecords()),
        names,
      );
      this.atlasSave.restore(pos.saves);
    } catch {
      // A broken battle-record file only loses the backfill, not the live set.
    }
    let entities: Json[] = [];
    try {
      const reply = record((await pilot.send("entities", { kind: "All", max: 600 })).entities);
      entities = records(reply.entities);
    } catch {
      // Keep going; with no entity list this map's chests cannot be required.
    }
    let encounters: EncounterTable | null = null;
    try {
      encounters = parseEncounters(await pilot.query("encounters"));
    } catch {
      // Unreadable: say so and require no monsters. 11-05: the bestiary "habitats" fallback
      // pulled in monsters this map cannot meet (Wind Shrine's boss, later-game islands).
    }
    // Task 128: 11-11 map 189 (Tycoon's meteor) reported areaType 0 too, so areaType alone called
    // it the world map. Ask the game files (map 1 is always a world map; later worlds 12/18/19/29
    // carry a world grid too) instead of trusting the area type.
    const world =
      travel.isWorldMap(pos.map) || (pos.map !== null && this.collisions.hasWorld(pos.map));
    const area = pos.area ?? null;
    const areaName = pos.areaText ?? "";
    const mapName =
      [areaName, this.mapName()].filter((value) => value !== "").join(" ") ||
      (world ? "世界地图" : `地图 ${pos.map ?? "?"}`);
    const region = encounters?.region ?? null;
    // 11-09 (task 69): the world map's regions report all four bounds as 0, so the current
    // "region" is its encounter grid number. `map.grids` has exactly one value at the player;
    // otherwise ask encountgrid for the player's cell. The region's own grid is the last resort.
    const mapGrids = encounters?.map?.grids ?? [];
    const soleGrid = mapGrids.length === 1 ? (mapGrids[0] ?? null) : null;
    const grid = world
      ? (soleGrid ?? (await this.worldGridAt(pilot, pos.map, pos.cell, region?.grid ?? null)))
      : null;
    // 11-05 rule: only what this map can meet now. Bridge 0.13.7's whole-map union wins; an old
    // bridge falls back to the parties underfoot. A vehicle never changes the answer (grinding on
    // a chocobo still farms the current region). Rate-0 formations never roll.
    let encounter: EncounterStatus = "unknown";
    let monsters: { name: string; book: number | null }[] = [];
    if (encounters !== null) {
      if (encounters.enabled === false) {
        encounter = "none";
      } else {
        // 11-05 live: on the world map the union can fail ("no encounter area at player cell")
        // while the cell underfoot still has its table; use that rather than nothing.
        const union = encounters.map !== null && encounters.map.error === null;
        const parties =
          union && encounters.map !== null ? encounters.map.parties : encounters.parties;
        monsters = encounterMonsters({
          monsterSet: null,
          parties: activeParties(parties),
          regions: [],
          enabled: null,
          vehicle: null,
          map: null,
        });
        // Empty only means "no encounters" when the whole-map union was read without error; an
        // old bridge's empty cell underfoot (an entrance, a chocobo) or a failed union is unknown.
        // Empty only means "no encounters" when the whole-map union was read without error. 11-05:
        // bridge 0.13.7 also said "no map encounter data" on caves that do have encounters.
        const trusted = encounters.map !== null && encounters.map.error === null;
        encounter = monsters.length > 0 ? "ok" : trusted ? "none" : "unknown";
      }
    }
    const oneTime = profile.oneTimePlaces.find((place) => place.area === area);
    const timedUntil =
      oneTime !== undefined && /限时|逃/u.test(oneTime.until) ? oneTime.until : null;
    // Task 68: the guide's missable rules, with the save's story flags, per missing monster.
    const passed = new Set(
      progressRows(data, profile)
        .filter((row) => row.current === 1)
        .map((row) => row.api),
    );
    const areasByNumber = new Map<number, readonly number[]>();
    for (const entry of data.bestiary?.entries ?? []) {
      if (entry.number !== null) areasByNumber.set(entry.number, entry.areas);
    }
    const statuses = new Map<number, string | null>();
    for (const monster of monsters) {
      if (monster.book === null) continue;
      statuses.set(
        monster.book,
        monsterStatus(
          monster.book,
          areasByNumber.get(monster.book) ?? [],
          (api) => passed.has(api),
          profile.bestiaryMissables,
        ),
      );
    }
    const state = completionState({
      mapId: pos.map,
      areaId: area,
      mapName,
      world,
      region,
      grid,
      treasure: data.save?.treasure ?? [],
      entities,
      monsters,
      encounter,
      known: this.bestiary.numbers,
      encounterTable: encounters,
      monsterStatuses: statuses,
      timedUntil,
      oneTime: oneTime !== undefined,
    });
    this.lastCompletion = state;
    this.lastCompletionAt = Date.now();
    try {
      await this.backlog.resolveComplete(state);
    } catch {
      // A failed rewrite only leaves an already-closed debt in the opening message.
    }
    return state;
  }

  private leaveMessage(): string {
    return this.leaveNotice ?? "";
  }

  /** Opening message's incident and backlog lines, after refreshing the bridge's completion. */
  async openingNotes(pilot: Pilot): Promise<string> {
    try {
      await this.refreshCompletion(pilot);
    } catch {
      // The files loaded at start still list what was known.
    }
    return [...incidentLines(this.incidents.entries), ...backlogLines(this.backlog.pending())]
      .filter((line) => line !== "")
      .join("\n");
  }

  /** Old battle records have only names; the achievements bestiary gives their numbers. */
  private bestiaryNames(): ReadonlyMap<string, number> {
    const names = new Map<string, number>();
    for (const entry of this.lastAchievements?.bestiary?.entries ?? []) {
      if (entry.name !== null && entry.name !== "" && entry.number !== null) {
        if (!names.has(entry.name)) names.set(entry.name, entry.number);
      }
    }
    return names;
  }

  /** The current map's last completion line, for the tactician's fact sheet. */
  completionText(): string {
    return this.lastCompletion === null ? "" : completionLine(this.lastCompletion);
  }

  private async completionReport(
    pilot: Pilot,
  ): Promise<{ readonly line: string; readonly timed: string }> {
    const state =
      this.lastCompletion !== null && Date.now() - this.lastCompletionAt < 4000
        ? this.lastCompletion
        : await this.refreshCompletion(pilot);
    if (state === null) return { line: "", timed: "" };
    const timed = timedLine(state);
    if (timed === "") return { line: completionLine(state), timed: "" };
    const key = `${state.mapId ?? "?"}:${state.areaId ?? "?"}:${state.region?.grid ?? "-"}`;
    if (!this.timedSeen.has(key)) {
      this.timedSeen.add(key);
      const all =
        state.chests.missing.length === 0
          ? "宝箱已经全拿到"
          : "剩下的宝箱：" +
            state.chests.missing
              .map((spot) =>
                spot.cell === null ? spot.label : `(${spot.cell[0]},${spot.cell[1]}) ${spot.label}`,
              )
              .join("、");
      return {
        line: completionLine(state),
        timed: `限时开始：${all}。倒计时里不拦你离开。`,
      };
    }
    return { line: completionLine(state), timed };
  }

  /** Refuse a leave/story step on an incomplete one-time or normal map; allow with a reason. */
  private async guardLeave(args: Json, pilot: Pilot, goal: Cell): Promise<HandlerResult | null> {
    // Task 105: a scout is a temporary run that loads back; completion debts and leave refusals
    // would stop it at the very exits it has to walk, and the snapshot would undo them anyway.
    if (this.scouting) return null;
    const state = await this.refreshCompletion(pilot);
    if (state === null || isComplete(state)) return null;
    // Task 128: use the knowledge module to tell "以后还会出现" from "错过就没了". Where its
    // encounter rows disagree with completion.ts's guide-only monsterStatus, knowledge wins:
    // the game files know every map a monster can appear in, the guide remembers only the
    // deadlines it wrote down. A normal place is revisitable either way, so its monsters never
    // justify a refusal; only a deadline or a one-time place does.
    let knowledge: Knowledge | null = null;
    if (state.monsters.missing.length > 0) {
      try {
        knowledge = await this.ensureStageKnowledge();
      } catch {
        // A missing export only loses the "appears again" proof; deadlines and one-time places
        // below still block, so the guard stays conservative.
      }
    }
    const excused = this.excusedBestiary(state, knowledge);
    const remaining = missingLines(state, excused);
    const later = this.laterBestiaryNote(state, excused);
    // Task 69: look up both grids before judging, so the leave check is one decision. Null means
    // the bridge cannot answer and isLeaving keeps the old rectangle behaviour.
    const gridOutside = await this.worldGridOutside(state, pilot, goal);
    const leaving = this.isLeaving(state, goal, gridOutside);
    const story = state.oneTime ? this.storyEventAt(state, goal) : null;
    if (!leaving && !story) return null;
    // A countdown escape is not blocked: the clock is the deadline, not this guard. The
    // remaining chests are attached to every tool result instead. Task 89: bridge 0.14.3's
    // timer is checked too, because a route can carry a countdown the profile does not name.
    if (state.timedUntil !== null || this.lastTimer?.active === true) return null;
    if (remaining.length === 0) {
      // Task 128: these monsters can be found again, so leaving is allowed without a reason
      // and without a debt. The reminder still reaches the model at the end of the result.
      if (later !== "") this.leaveNotice = later;
      return null;
    }
    const reason = text(args.leave_incomplete)?.trim() ?? "";
    if (reason !== "") {
      await this.backlog.add({
        mapId: state.mapId,
        areaId: state.areaId,
        region: state.world ? (state.region?.grid ?? null) : null,
        mapName: this.completionWhere(state),
        missing: remaining,
        reason,
      });
      this.leaveNotice = `已按理由「${reason}」放行，记了一条欠账；回来补齐后自动销掉。`;
      return null;
    }
    const where = this.completionWhere(state);
    const missing = remaining.join("；");
    const storyName = story === null || story.label === "" ? "" : `「${story.label}」`;
    const why = story
      ? `「${where}」是一次性地点，你正要踩剧情/首领事件格 ${goal[0]},${goal[1]}${storyName}`
      : `要离开「${where}」`;
    const grindHint = remaining.some((line) => line.startsWith("本图鉴还缺"))
      ? "这图还缺的怪用 grind(until_bestiary) 刷齐，不要一步步走；"
      : "";
    return {
      early: true,
      text:
        `${why}，但这里还没完成：${missing}。\n` +
        "先拿完宝箱和隐藏道具；" +
        grindHint +
        '确实要离开就带 leave_incomplete，并写具体理由，例如 leave_incomplete="需要钥匙"、' +
        '"打不过，等升级"、"剧情强制离开"。带理由离开会记一条欠账，回来补齐后自动销掉。' +
        (later === "" ? "" : `\n${later}`),
    };
  }

  /**
   * Task 48: leaving a map only on the way to another one. An existing backlog is the model's
   * earlier decision, so it is not asked again and no second entry is written.
   */
  private async guardTransit(pilot: Pilot, goal: Cell): Promise<HandlerResult | null> {
    const state = await this.refreshCompletion(pilot);
    if (state === null || isComplete(state)) return null;
    const region = state.world ? (state.region?.grid ?? null) : null;
    const owed = this.backlog
      .pending()
      .some(
        (entry) =>
          entry.mapId === state.mapId && entry.areaId === state.areaId && entry.region === region,
      );
    if (owed) return null;
    return await this.guardLeave({}, pilot, goal);
  }

  /** Task 48: the route and its report are the whole result; no completion hints are added. */
  private travelOptions(originArgs?: Json): travel.TravelOptions {
    return {
      guard: async (runner, goal, origin) =>
        origin
          ? await this.guardLeave(originArgs ?? {}, runner, goal)
          : await this.guardTransit(runner, goal),
      maxHops: this.travelMaxHops,
      maxMinutes: this.travelMaxMinutes,
    };
  }

  /**
   * 11-05: go/explore take `flee`; the flag lives on MoveState because
   * every walk leg (and the map hops between them) reads it. Put the old value back afterwards
   * so a later interact or grind is not made to run from every battle.
   */
  private async withFlee(args: Json, run: () => Promise<HandlerResult>): Promise<HandlerResult> {
    const previous = this.moveState.flee;
    this.moveState.flee = truthy(args.flee);
    try {
      return await run();
    } finally {
      this.moveState.flee = previous;
    }
  }

  /** Task 61: the base sentence `walkpath` shows, put back afterwards like `flee`. */
  private async withWalkLabel(
    label: string,
    run: () => Promise<HandlerResult>,
  ): Promise<HandlerResult> {
    const previous = this.moveState.label;
    const previousHop = this.moveState.hop;
    this.moveState.label = label;
    this.moveState.hop = undefined;
    try {
      return await run();
    } finally {
      this.moveState.label = previous;
      this.moveState.hop = previousHop;
    }
  }

  /**
   * Task 97: the knowledge module is loaded once, on the first stage call. A missing export
   * gives an empty module, so planning before the bridge has exported still answers from the
   * guide (and from the atlas).
   */
  private async ensureStageKnowledge(signal?: AbortSignal): Promise<Knowledge> {
    if (this.knowledgeOption !== undefined) return this.knowledgeOption;
    if (this.knowledge !== null) return this.knowledge;
    if (this.knowledgeLoading === null) {
      const pending = loadKnowledge({
        game: this.game,
        guide: this.guide,
        atlas: this.atlas,
        collisions: this.collisions,
        atlasSave: this.atlasSave,
        bestiarySave: this.bestiary,
        signal,
      })
        .then((knowledge) => {
          this.knowledge = knowledge;
          return knowledge;
        })
        .finally(() => {
          if (this.knowledgeLoading === pending) this.knowledgeLoading = null;
        });
      this.knowledgeLoading = pending;
    }
    return await this.knowledgeLoading;
  }

  /** Party, bag and gil as the stage checks read them (the same reads the tactician uses). */
  private async stageTravelState(pilot: Pilot): Promise<StageTravelState> {
    const sample = record((await pilot.query("sample")).sample);
    const party = readParty(sample).map((member) => ({
      name: member.name,
      job: member.job,
      level: member.lv ?? 1,
      hp: member.hp,
      maxHp: member.maxHp,
      mp: member.mp,
      maxMp: member.maxMp,
      status: member.status,
      spells: member.abilities.map((ability) => ability.name),
    }));
    const held = await battle.heldItems(pilot);
    const bag = Object.entries(held)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count }));
    return { party, bag, gil: num(sample.gil) ?? 0 };
  }

  /** The current map and cell, or nulls when the bridge cannot answer. */
  private async stagePosition(
    pilot: Pilot,
  ): Promise<{ readonly map: number | null; readonly cell: Cell | null }> {
    try {
      const [map, cell] = await travel.currentMapAndCell(pilot);
      return { map, cell };
    } catch {
      return { map: null, cell: null };
    }
  }

  /** The bridge's countdown, or null on an older bridge / a failed read. */
  private async stagePosTimer(pilot: Pilot): Promise<ReturnType<typeof parseRouteTimer>> {
    try {
      return parseRouteTimer(record((await pilot.send("pos")).pos).timer);
    } catch {
      return null;
    }
  }

  /** The open shop's actual wares, or null outside a shop / before the list is drawn. */
  private async stageShop(pilot: Pilot): Promise<ShopHere | null> {
    try {
      const shop = record((await pilot.query("shop")).shop);
      if (!truthy(shop.open)) return null;
      const products = records(shop.products)
        .map((product) => ({
          name: text(product.name) ?? "",
          price: num(product.price) ?? null,
        }))
        .filter((product) => product.name !== "");
      if (products.length === 0) return null;
      return {
        ...(text(shop.areaName) === undefined ? {} : { area: text(shop.areaName) }),
        ...(text(shop.kind) === undefined ? {} : { kind: text(shop.kind) }),
        products,
      };
    } catch {
      // A bridge without the shop query is simply "not in a shop" here.
      return null;
    }
  }

  /** The purchase list to show: the open shop's quantities, or where to go for each gap. */
  private async stagePurchaseText(
    pilot: Pilot,
    plan: StagePlan,
    state: StageTravelState,
    knowledge: Knowledge,
    currentMap: number,
  ): Promise<string> {
    const shop = await this.stageShop(pilot);
    if (shop !== null) {
      const list = purchaseList(plan, state.bag, state.gil, [shop]);
      const lines = ["### 本店采购单"];
      if (list.buy.length === 0 && list.skipped.length === 0) lines.push("没有要买的。");
      for (const purchase of list.buy) {
        lines.push(
          `- ${purchase.item} ×${purchase.count}，单价 ${purchase.price} gil，` +
            `共 ${purchase.count * purchase.price} gil`,
        );
      }
      for (const skipped of list.skipped) lines.push(`- ${skipped}`);
      return lines.join("\n");
    }
    return this.stageShopAdvice(plan, state, knowledge, currentMap);
  }

  /** Outside a shop: which kind of shop sells each missing supply, from the knowledge export. */
  private stageShopAdvice(
    plan: StagePlan,
    state: StageTravelState,
    knowledge: Knowledge,
    currentMap: number,
  ): string {
    const place = mapPlace(knowledge, this.atlas, currentMap);
    const nearby = shopsNear(knowledge, place.areaName || place.name);
    const lines = ["### 采购单（不在商店）"];
    let any = false;
    for (const supply of plan.supplies) {
      const have = stageBagCount(state.bag, supply.item);
      const need = Math.max(0, supply.buyTo - have);
      if (need === 0) continue;
      any = true;
      const selling = nearby.find((shop) =>
        shop.products.some((product) => product.name === supply.item),
      );
      if (selling === undefined) {
        lines.push(
          `- ${supply.item} 还差 ${need} 个：附近商店数据里没找到，先到有道具屋的城镇问问`,
        );
        continue;
      }
      const product = selling.products.find((row) => row.name === supply.item);
      const price =
        product?.price === null || product?.price === undefined
          ? ""
          : `，单价 ${product.price} gil`;
      lines.push(
        `- ${supply.item} 还差 ${need} 个：去「${place.name}」的「${shopKindLabel(selling.kind)}」买${price}`,
      );
    }
    if (!any) lines.push("没有要买的。");
    lines.push("到店后打开商店，再用 plan_stage 看一次本店采购单。");
    return lines.join("\n");
  }

  /** One boss name the stage plan names, with the numbers a fight can be matched on. */
  private stageBossNames(
    facts: StageFacts,
    knowledge: Knowledge,
  ): {
    readonly name: string;
    readonly bookId: number | null;
    readonly monsterId: number | null;
  }[] {
    const names = new Map<string, string>();
    for (const monster of facts.monsters) {
      if (monster.boss) names.set(normalizeName(monster.name), monster.name);
    }
    for (const note of facts.bossNotes) {
      const extra = /^攻略点名的首领[:：](.+)$/u.exec(note);
      const raw =
        extra === null ? [note.split(/[:：]/u)[0] ?? ""] : (extra[1] ?? "").split(/[、,，]/u);
      for (const name of raw) {
        const clean = name.trim();
        if (clean !== "") names.set(normalizeName(clean), clean);
      }
    }
    return [...names.values()].map((name) => {
      const known = knowledge.monsters.find(
        (monster) => normalizeName(monster.name) === normalizeName(name),
      );
      const staged = facts.monsters.find(
        (monster) => normalizeName(monster.name) === normalizeName(name),
      );
      return {
        name,
        bookId: known?.bookId ?? staged?.bookId ?? null,
        monsterId: known?.id ?? staged?.id ?? null,
      };
    });
  }

  /**
   * Task 106: the one map knowledge can pin all of the stage's bosses to, or null. Only maps
   * inside the stage count: the same boss can appear in another chapter, and writing this
   * stage's table there would make the other chapter start with a stale plan.
   */
  private stageBossLocation(
    knowledge: Knowledge,
    facts: StageFacts,
    bosses: readonly {
      readonly name: string;
      readonly bookId: number | null;
    }[],
  ): number | null {
    const target = new Set(stageTargetMapIds(knowledge, facts.target));
    const found = new Set<number>();
    for (const boss of bosses) {
      for (const mapId of bossMapIds(knowledge, {
        name: boss.name,
        bookId: boss.bookId,
      })) {
        if (target.has(mapId)) found.add(mapId);
      }
    }
    if (found.size !== 1) return null;
    return [...found][0] ?? null;
  }

  /**
   * Write the stage's boss table before the walk (task 106), the same way boss-prep does: a
   * synchronous tactician call, then Tactics for the located map and the stage plan for the
   * name match. The table is deliberately kept even when the map is unknown: the Fire-Powered
   * Ship's boss starts from an event cell, so the fight is the first moment the map is known.
   */
  private async stageBossPrep(
    pilot: Pilot,
    facts: StageFacts,
    knowledge: Knowledge,
    reason: string,
    kind: "boss-prep" | "party-changed",
  ): Promise<{
    readonly boss: StageBossTable | null;
    readonly text: string;
    readonly error: string;
  }> {
    const bosses = this.stageBossNames(facts, knowledge);
    if (bosses.length === 0) return { boss: null, text: "", error: "" };
    if (this.tactician === undefined) {
      return { boss: null, text: "", error: "战术官没有接上，首领表没有写成" };
    }
    const location = this.stageBossLocation(knowledge, facts, bosses);
    const triggerMap = location ?? facts.target.mapId ?? this.mapId;
    if (triggerMap === null || !this.onMap(triggerMap)) {
      return {
        boss: null,
        text: "",
        error: "读不到首领在哪张图，首领表没有写成",
      };
    }
    const names = bosses.map((boss) => boss.name);
    const where = location === null ? "这一段的首领" : `这一段的首领（地图 ${location}）`;
    const section = [
      "### 首领战",
      `${where}:${names.join("、")}`,
      kind === "party-changed"
        ? "队伍在首领前的最后一个存档点变了。按现在的职业、等级和背包重写这一战的首领表。"
        : "这一段有首领。按事实单写这一战的首领表，出发前就要能用。",
    ];
    const outcome = await this.runTactician(
      {
        kind,
        mapId: triggerMap,
        detail:
          kind === "party-changed" ? `队伍变了:${reason}` : `阶段计划里有首领:${names.join("、")}`,
        monsters: names,
        pilot,
      },
      false,
      `${describeStageFacts(facts)}\n\n${section.join("\n")}`,
    );
    const table = outcome.tables[0];
    if (table === undefined) {
      return {
        boss: null,
        text: "",
        error: outcome.text === "" ? "战术官没有交回首领表" : outcome.text,
      };
    }
    const info = this.tacticianInfoByMap.get(triggerMap);
    const at = new Date().toISOString();
    const result = kind === "boss-prep" ? "出发前阶段计划的首领表" : "队伍变了以后改写的首领表";
    const party: StageBossPartyMember[] = facts.party.map((member) => ({
      name: member.name,
      job: member.job,
      level: member.level,
    }));
    const boss: StageBossTable = {
      names,
      bookIds: [...new Set(bosses.flatMap((row) => (row.bookId === null ? [] : [row.bookId])))],
      monsterIds: [
        ...new Set(bosses.flatMap((row) => (row.monsterId === null ? [] : [row.monsterId]))),
      ],
      mapId: location,
      table,
      at,
      result,
      ...(info === undefined ? {} : { walkerNotes: info.walkerNotes, askUp: info.askUp }),
      party,
    };
    if (location !== null) {
      await this.tactics.setBoss(location, {
        table,
        result,
        at,
        ...(info === undefined ? {} : { walkerNotes: info.walkerNotes, askUp: info.askUp }),
        prepared: true,
      });
    }
    return {
      boss,
      text: `首领「${names.join("、")}」的表已经写好${location === null ? "（这一段）" : `（地图 ${location}）`}`,
      error: "",
    };
  }

  /** Task 106: the line the tool result and the sidebar show for a prepared boss table. */
  private stageBossLine(record: StagePlanRecord): string {
    const boss = record.boss;
    if (boss === undefined) return "";
    return (
      `首领「${boss.names.join("、")}」的表已经写好` +
      `${boss.mapId === null ? "（这一段）" : `（地图 ${boss.mapId}）`}。`
    );
  }

  /** Task 106: match a starting fight to the stage's table by name, bestiary number or id. */
  private stageBossMatch(enemies: readonly Json[]): StageBossTable | null {
    const record = this.stagePlans.current;
    if (record === null || record.status === "completed") return null;
    const boss = record.boss;
    if (boss === undefined) return null;
    const names = new Set(boss.names.map((name) => normalizeName(name)));
    const books = new Set(boss.bookIds);
    const ids = new Set(boss.monsterIds);
    for (const enemy of enemies) {
      const name = normalizeName(text(enemy.name) ?? "");
      if (name !== "" && names.has(name)) return boss;
      const book = num(enemy.book);
      if (book !== undefined && books.has(Math.trunc(book))) return boss;
      const id = num(enemy.id);
      if (id !== undefined && ids.has(Math.trunc(id))) return boss;
    }
    return null;
  }

  /** Task 106: what changed since the boss table was written; [] means it still fits. */
  private stageBossPartyChange(
    boss: StageBossTable,
    party: StageFacts["party"],
    levelGap: number,
  ): string[] {
    const before = boss.party;
    if (before === undefined || before.length === 0) return [];
    const changes: string[] = [];
    const old = new Map(before.map((member) => [member.name, member]));
    const now = new Set(party.map((member) => member.name));
    for (const member of before) {
      if (!now.has(member.name)) changes.push(`「${member.name}」不在队伍里了`);
    }
    for (const member of party) {
      const previous = old.get(member.name);
      if (previous === undefined) {
        changes.push(`「${member.name}」是新加入的`);
        continue;
      }
      if (previous.job !== member.job) {
        changes.push(
          `「${member.name}」从${previous.job || "无职业"}换成了${member.job || "无职业"}`,
        );
      }
      if (Math.abs(previous.level - member.level) >= Math.max(1, levelGap)) {
        changes.push(`「${member.name}」从 ${previous.level} 级变成 ${member.level} 级`);
      }
    }
    return changes;
  }

  /**
   * Task 106: true when the party is standing on the last save/recovery point before the boss
   * on the plan's route. Only that checkpoint rewrites the table; the earlier ones would use a
   * party the walk is about to change again.
   */
  private stageBossCheckpoint(
    record: StagePlanRecord,
    facts: StageFacts,
    map: number,
    cell: Cell,
  ): boolean {
    const route = record.plan.route;
    if (route.length === 0) return false;
    let bossIndex = route.length - 1;
    const bossMap = record.boss?.mapId ?? record.target.mapId;
    if (bossMap !== null) {
      for (const [index, stop] of route.entries()) {
        try {
          const waypoint = resolveRouteStop(
            {
              to: stop.to,
              action: stop.do ?? "move",
              optional: stop.optional ?? false,
            },
            `boss${index}`,
            map,
            this.atlas,
            false,
          );
          if (waypoint.map === bossMap) {
            bossIndex = index;
            break;
          }
        } catch {
          // A bad stop cannot be the boss's; the other stops still decide.
        }
      }
    }
    let last: { readonly map: number; readonly cell: Cell } | null = null;
    for (const [index, stop] of route.entries()) {
      if (index >= bossIndex) break;
      let waypoint: Waypoint;
      try {
        waypoint = resolveRouteStop(
          {
            to: stop.to,
            action: stop.do ?? "move",
            optional: stop.optional ?? false,
          },
          `check${index}`,
          map,
          this.atlas,
          false,
        );
      } catch {
        continue;
      }
      if (waypoint.cell === null) continue;
      const point = waypoint.cell;
      const recovery = facts.recoveryPoints.some(
        (row) => row.mapId === waypoint.map && matchesCell(point, row.cell),
      );
      const save =
        stop.do === "save" ||
        facts.savePoints.some((row) => row.mapId === waypoint.map && matchesCell(point, row.cell));
      if (!recovery && !save) continue;
      last = { map: waypoint.map, cell: point };
    }
    return last !== null && last.map === map && matchesCell(cell, last.cell);
  }

  /**
   * Task 106: at the last checkpoint before the boss, rewrite a table whose party no longer
   * fits. Silent unless that exact checkpoint is reached and something actually changed.
   */
  private async stageBossCheckpointCheck(pilot: Pilot): Promise<string> {
    if (this.scouting || this.tactician === undefined) return "";
    const record = this.stagePlans.current;
    if (record === null) return "";
    if (record.status !== "departed" || record.boss === undefined) return "";
    try {
      const { map, cell } = await this.stagePosition(pilot);
      if (map === null || cell === null) return "";
      const knowledge = await this.ensureStageKnowledge();
      const state = await this.stageTravelState(pilot);
      const facts = buildStageFacts({
        target: record.target,
        knowledge,
        atlas: this.atlas,
        party: state.party,
        bag: state.bag,
        gil: state.gil,
      });
      if (!this.stageBossCheckpoint(record, facts, map, cell)) return "";
      const changed = this.stageBossPartyChange(record.boss, state.party, this.stageBossLevelGap);
      if (changed.length === 0) return "";
      const prepared = await this.stageBossPrep(
        pilot,
        facts,
        knowledge,
        changed.join(";"),
        "party-changed",
      );
      if (prepared.boss === null) return prepared.error;
      await this.stagePlans.save({ ...record, boss: prepared.boss });
      return `${prepared.text}（队伍变了:${changed.join(";")}）`;
    } catch (error) {
      return `首领表在存档点没有改成:${describeError(error)}`;
    }
  }

  /** Task 117: keep the officer's route as a note; the book's route is what executes. */
  private bookPlanNotes(notes: string, officerRoute: StagePlan["route"], section: string): string {
    const line =
      officerRoute.length === 0
        ? `阶段官没有给路线；路线书「${section}」的站直接执行。`
        : `阶段官路线（不执行）：${officerRoute.map((stop) => stop.to).join(" → ")}；` +
          `执行路线书「${section}」的站。`;
    return [notes.trim(), line].filter((part) => part !== "").join("\n");
  }

  /**
   * One stage officer call, shared by the tool and the auto trigger. Only a plan that passed
   * `checkStagePlan` is saved; an invalid one is returned with its problems so the caller can
   * refuse the walk instead of trusting it.
   */
  private async createStagePlan(
    pilot: Pilot,
    target: import("./stage/types.ts").StageTarget,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly record: StagePlanRecord | null;
    readonly text: string;
    readonly problems: readonly string[];
  }> {
    const officer = this.stageOfficer;
    if (officer === undefined) throw new Error("阶段官没有接上：没有可用的 dsh 子智能体");
    const knowledge = await this.ensureStageKnowledge(signal);
    const state = await this.stageTravelState(pilot);
    const facts = buildStageFacts({
      target,
      knowledge,
      atlas: this.atlas,
      party: state.party,
      bag: state.bag,
      gil: state.gil,
    });
    const answer = await officer(
      facts,
      describeStageFacts(facts),
      signal ?? AbortSignal.timeout(600_000),
    );
    const startMap = (await this.stagePosition(pilot)).map;
    const problems = answer.problems.length === 0 ? [] : [...answer.problems];
    // Task 117: when the book covers this target, its stations are the route. The officer's
    // route still goes into the notes for review, but the executor never walks it.
    const bookRoute =
      problems.length === 0 ? await this.bookRouteForTarget(pilot, target, signal) : null;
    const plan: StagePlan =
      bookRoute === null
        ? answer.plan
        : {
            ...answer.plan,
            route: bookRoute.route,
            notes: this.bookPlanNotes(
              answer.plan.notes,
              answer.plan.route,
              bookRoute.runtime.section.title,
            ),
          };
    const prepared =
      problems.length === 0
        ? await this.stageBossPrep(pilot, facts, knowledge, "", "boss-prep")
        : { boss: null, text: "", error: "" };
    const record: StagePlanRecord = {
      target: facts.target,
      plan,
      createdAt: new Date().toISOString(),
      status: "planned",
      ...(startMap === null
        ? {}
        : {
            startMapId: startMap,
            startLabel: stagePlaceName(knowledge, this.atlas, startMap),
          }),
      ...(prepared.boss === null ? {} : { boss: prepared.boss }),
      ...(prepared.error === "" ? {} : { bossError: prepared.error }),
      ...(bookRoute === null
        ? {}
        : {
            book: {
              section: bookRoute.runtime.section.title,
              order: bookRoute.runtime.section.order,
            },
          }),
    };
    if (problems.length === 0) {
      // Task 113: a new plan replaces the old one; the old stage's numbers go to the log.
      const previous = this.stagePlans.current;
      if (previous !== null && previous.status === "departed") this.stageLogStats(previous);
      await this.stagePlans.save(record);
    }
    return {
      record: problems.length === 0 ? record : null,
      text: [answer.text, prepared.text, prepared.error].filter((line) => line !== "").join("\n"),
      problems,
    };
  }

  /** Task 97: `plan_stage(to, reason?, replan?)`; an unfinished same-destination plan is reused. */
  private async toolPlanStage(
    args: Json,
    pilot: Pilot,
    signal?: AbortSignal,
  ): Promise<HandlerResult> {
    if (this.stageOfficer === undefined) {
      return {
        text: "阶段官没有接上：这个插件实例没有 dsh 子智能体，plan_stage 用不了",
        early: true,
      };
    }
    try {
      const knowledge = await this.ensureStageKnowledge(signal);
      const target = resolveStageTarget(args.to, this.atlas, knowledge);
      const reason = text(args.reason)?.trim() ?? "";
      const existing = this.stagePlans.current;
      if (
        existing !== null &&
        existing.status !== "completed" &&
        sameStageTarget(existing.target, target) &&
        !truthy(args.replan)
      ) {
        return {
          text: await this.stageReport(
            pilot,
            existing,
            knowledge,
            "### 已有这一段还没完成的计划，直接沿用（要重做就带 replan=true）",
          ),
          early: true,
        };
      }
      const created = await this.createStagePlan(pilot, target, signal);
      if (created.record === null) {
        return {
          text:
            `${created.text}\n\n计划没存盘，出发检查不能用：\n` +
            created.problems.map((problem) => `- ${problem}`).join("\n"),
          early: true,
        };
      }
      return {
        text: await this.stageReport(
          pilot,
          created.record,
          knowledge,
          `### 阶段计划已存盘${reason === "" ? "" : `（${reason}）`}`,
        ),
        early: true,
      };
    } catch (error) {
      return {
        text: `阶段官没有出成计划：${describeError(error)}`,
        early: true,
      };
    }
  }

  /**
   * Task 105: `scout(area?, minutes?)`. Save slot 20, snapshot this save's progress, walk every
   * target `planScout` names through the ordinary route executor (fleeing encounters), then load
   * slot 20 back, restore the snapshot and reload the save-local caches. The tool is deliberately
   * FF5-only: the snapshot file list and the scout knowledge are FF5's.
   */
  private async toolScout(args: Json, pilot: Pilot, signal?: AbortSignal): Promise<HandlerResult> {
    if (this.game !== "ff5") {
      return {
        text: "scout 只支持 FF5:快照文件列表和侦察记录都是 FF5 的",
        early: true,
      };
    }
    if (this.saveSlot !== SCOUT_SLOT) {
      return {
        text: `scout 只写 ${SCOUT_SLOT} 号位,现在配置的是 ${this.saveSlot} 号位;没有按键`,
        early: true,
      };
    }
    const minutes = this.scoutMinutesOf(args);
    if (minutes === null) {
      return { text: "scout 的 minutes 要是正数(分钟)", early: true };
    }
    const reply = await pilot.send("pos");
    const pos = parsePositionReply(reply);
    if (
      pos.state !== "Player" ||
      pos.battle ||
      pos.dialog ||
      pos.map === null ||
      pos.cell === null
    ) {
      return {
        text:
          `现在不能侦察:要站在地图上、不在战斗/对话/菜单里(状态 ${show(pos.state)})。` +
          "没有按键。",
        early: true,
      };
    }
    const timer = parseRouteTimer(record(reply.pos).timer);
    if (timer?.active === true) {
      const left =
        timer.seconds === null ? "" : `(还剩 ${Math.max(0, Math.floor(timer.seconds))} 秒)`;
      return {
        text: `倒计时进行中${left},不能开始侦察:读回 20 号位会丢掉这段时间。没有按键。`,
        early: true,
      };
    }

    const [saved, savedText] = await save.saveGame(pilot, this.saveSlot, this.saveTimerMinSeconds);
    if (!saved) {
      return { text: `侦察没有开始:${savedText}`, early: true };
    }
    await this.captureBestiary(pilot);
    let snapshot: Snapshot;
    let windows: ScoutWindows;
    try {
      snapshot = await takeSnapshot(this.scoutDir, defaultProgressFiles(this.game, this.scoutDir));
      windows = await this.scoutWindows(signal);
      await windows.begin();
    } catch (error) {
      return {
        text: `侦察没有开始:存好了 ${this.saveSlot} 号位,但快照或侦察窗口没做成:${describeError(error)}`,
        early: true,
      };
    }

    const scope = this.scoutScopeOf(args.area, pos.map);
    const previousFlee = this.moveState.flee;
    this.moveState.flee = true;
    this.scouting = true;
    let state: ScoutRunState;
    try {
      state = await this.scoutLoop(pilot, scope, minutes, signal);
    } catch (error) {
      state = {
        end: signal?.aborted === true ? "aborted" : "error",
        note: describeError(error),
        elapsedMs: 0,
        before: this.scoutStats(),
        after: this.scoutStats(),
        initial: {
          targets: [],
          waypoints: [],
          phases: [],
          minutes: 0,
          unreachable: [],
          warnings: [],
        },
        scouted: [],
        failed: [],
      };
    }

    let ending = "";
    try {
      ending = await this.finishScout(pilot, snapshot, state);
    } finally {
      this.scouting = false;
      this.moveState.flee = previousFlee;
      try {
        await windows.end();
        this.scoutWindowsCache = windows;
      } catch (error) {
        ending = `${ending}\n关闭侦察窗口失败:${describeError(error)}`;
      }
    }
    return { text: ending, early: true };
  }

  /** `minutes` from the tool call, or null when it is not a positive number. */
  private scoutMinutesOf(args: Json): number | null {
    if (args.minutes === undefined || args.minutes === null || args.minutes === "") {
      return this.scoutMinutes > 0 ? this.scoutMinutes : null;
    }
    const value = num(args.minutes);
    if (value === undefined || value <= 0) return null;
    return value;
  }

  /** The area argument, or the current map; planScout resolves map names and areas itself. */
  private scoutScopeOf(area: unknown, currentMap: number): (number | string)[] {
    if (typeof area === "number" && Number.isFinite(area)) return [Math.trunc(area)];
    if (typeof area === "string" && area.trim() !== "") return [area.trim()];
    return [currentMap];
  }

  /**
   * Walk one target at a time, re-planning after each. `planScout` orders a whole scope; the
   * scout only takes the first target it has not tried yet, so every completed target changes
   * what the next plan sees (a new landing, a verified block, a new map).
   */
  private async scoutLoop(
    pilot: Pilot,
    scope: readonly (number | string)[],
    minutes: number,
    signal?: AbortSignal,
  ): Promise<ScoutRunState> {
    const startedAt = pilot.now();
    const deadline = startedAt + minutes * 60_000;
    const before = this.scoutStats();
    const attempted = new Set<string>();
    const scouted: ScoutTarget[] = [];
    const failed: string[] = [];
    let initial: ScoutPlan | null = null;
    let end: ScoutEnd = "completed";
    let note: string | undefined;
    for (;;) {
      if (signal?.aborted === true) {
        end = "aborted";
        note = "收到取消信号";
        break;
      }
      if (pilot.now() >= deadline) {
        end = "time-budget";
        note = `时间预算 ${Math.round(minutes)} 分钟用完`;
        break;
      }
      if (attempted.size >= this.scoutMaxTargets) {
        end = "max-targets";
        note = `最多侦察 ${this.scoutMaxTargets} 个目标`;
        break;
      }
      const here = await this.scoutPosition(pilot);
      if (here === null) {
        end = "error";
        note = "读不到当前位置";
        break;
      }
      // Record the map just entered before planning: this is the map structure the scout keeps,
      // and AtlasSave's live set is one of the files the snapshot later puts back.
      try {
        this.mapId = await this.chart(pilot);
      } catch {
        // A map that is still switching must not end the scout; the next target retries.
      }
      const plan = planScout({
        atlas: this.atlas,
        collisions: this.collisions,
        start: here,
        scope,
        entities: await this.scoutEntities(pilot),
        battleSeconds: this.routeBattleSeconds,
      });
      initial ??= plan;
      const target = plan.targets.find(
        (candidate) => !attempted.has(this.scoutTargetKey(candidate)),
      );
      if (target === undefined) {
        note = attempted.size === 0 ? describeScout(plan) : "计划里的目标都试过了";
        break;
      }
      attempted.add(this.scoutTargetKey(target));
      const remaining = Math.max(1_000, deadline - pilot.now());
      const outcome = await this.scoutTarget(pilot, target, remaining, signal);
      if (outcome.end === "gameover") {
        end = "gameover";
        note = outcome.note;
        break;
      }
      if (outcome.end === "aborted") {
        end = "aborted";
        note = outcome.note;
        break;
      }
      if (outcome.ok) scouted.push(target);
      else failed.push(target.label);
      if (outcome.end === "decision") {
        end = "decision";
        note = outcome.note;
        break;
      }
      if (outcome.end === "time-budget") {
        end = "time-budget";
        note = outcome.note;
        break;
      }
      if (outcome.end === "error") {
        end = "error";
        note = outcome.note;
        break;
      }
    }
    return {
      end,
      note,
      elapsedMs: Math.max(0, pilot.now() - startedAt),
      before,
      after: this.scoutStats(),
      initial: initial ?? {
        targets: [],
        waypoints: [],
        phases: [],
        minutes: 0,
        unreachable: [],
        warnings: [],
      },
      scouted,
      failed,
    };
  }

  /** One target through `buildRoute` and the ordinary route executor; no progress file. */
  private async scoutTarget(
    pilot: Pilot,
    target: ScoutTarget,
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; end: ScoutEnd; note: string }> {
    const stop: RouteStopInput = {
      to: target.route.to,
      action: target.action === "talk" ? "talk" : "move",
      optional: false,
    };
    const built = await this.buildRoute(pilot, [stop], null);
    if (built === null) return { ok: false, end: "error", note: "读不到当前位置" };
    if ("error" in built) return { ok: false, end: "completed", note: built.error };
    const result = await executeRoute(built.plan, this.routePorts(pilot, { flee: true }), {
      waypoints: built.waypoints,
      end: built.end,
      signal,
      // The scout re-plans itself after every target; a deviation inside one target must stop
      // instead of walking back and forth.
      replanLimit: 0,
      maxWaypointFailures: 1,
      timeBudgetMs: budgetMs,
    });
    if (result.reason === "gameover") return { ok: false, end: "gameover", note: result.message };
    if (result.reason === "aborted") return { ok: false, end: "aborted", note: result.message };
    if (result.reason === "decision") return { ok: true, end: "decision", note: result.message };
    if (result.reason === "time-budget") {
      return { ok: true, end: "time-budget", note: result.message };
    }
    return await this.scoutTargetEffect(pilot, target, result.reason);
  }

  /**
   * Read what a target actually changed. A landing is only recorded after the map changed (the
   * ordinary travel path writes `landExit`; a plain walk onto an exit does not), and a one-off
   * block is verified by trying the blocked step and forgetting the record when it now works.
   */
  private async scoutTargetEffect(
    pilot: Pilot,
    target: ScoutTarget,
    reason: string,
  ): Promise<{ ok: boolean; end: ScoutEnd; note: string }> {
    if (target.kind === "landing") {
      const here = await this.scoutPosition(pilot);
      if (here !== null && target.toMap !== undefined && here.map === target.toMap) {
        await this.atlas.landExit(target.map, target.cell, target.toMap, here.cell);
        return { ok: true, end: "completed", note: `落点记在 ${target.label}` };
      }
      return { ok: false, end: "completed", note: reason };
    }
    if (target.kind === "blocked" && target.step !== undefined) {
      if (reason === "failed" || reason === "unreachable" || reason === "replan-limit") {
        return { ok: false, end: "completed", note: `没走到 ${target.label}` };
      }
      const step = target.step;
      await move.navigate(pilot, step.to, false, () => undefined, 8, this.moveState);
      const here = await this.scoutPosition(pilot);
      if (here !== null && here.map === target.map) {
        if (here.cell[0] === step.to[0] && here.cell[1] === step.to[1]) {
          await this.atlas.forgetBlocked(target.map, [
            { from: step.from, to: step.to, how: "走不过去" },
          ]);
          return {
            ok: true,
            end: "completed",
            note: `验证通过 ${target.label}`,
          };
        }
      }
      return {
        ok: false,
        end: "completed",
        note: `还是走不过去 ${target.label}`,
      };
    }
    if (reason === "unreachable" || reason === "replan-limit" || reason === "failed") {
      return { ok: false, end: "completed", note: reason };
    }
    return { ok: true, end: "completed", note: reason };
  }

  private async scoutPosition(pilot: Pilot): Promise<{ map: number; cell: Cell } | null> {
    const pos = parsePositionReply(await pilot.send("pos"));
    if (pos.map === null || pos.cell === null) return null;
    return { map: pos.map, cell: [pos.cell[0], pos.cell[1]] };
  }

  /** Named objects on the current map, as `planScout` takes them; an old bridge is empty. */
  private async scoutEntities(pilot: Pilot): Promise<ScoutEntity[]> {
    let raw: readonly Json[];
    try {
      raw = records(
        record((await pilot.send("entities", { kind: "All", max: 600 })).entities).entities,
      );
    } catch {
      return [];
    }
    const map = await this.scoutPosition(pilot);
    if (map === null) return [];
    const found: ScoutEntity[] = [];
    for (const entity of raw) {
      const cell = cellOf(entity.cell);
      const kind = text(entity.kind);
      const name = text(entity.name);
      if (cell === null || kind === undefined || name === undefined || name.trim() === "") continue;
      found.push({
        map: map.map,
        cell,
        kind,
        name,
        ...(entity.tried === true ? { tried: true } : {}),
        ...(typeof entity.active === "boolean" ? { active: entity.active } : {}),
      });
    }
    return found;
  }

  /** Counts of the map structure a scout may add to; the report subtracts before from after. */
  private scoutStats(): ScoutStats {
    let landings = 0;
    let walks = 0;
    let mechanisms = 0;
    let blockedOnce = 0;
    for (const [key, entry] of this.atlas.maps) {
      const map = Number(key);
      for (const exit of records(entry.exits)) {
        if (cellOf(exit.land) !== null) landings += 1;
      }
      if (Number.isInteger(map)) {
        for (const move of this.atlas.moves(map)) {
          if (move.how === "走不过去") {
            if ((move.count ?? 1) < 2) blockedOnce += 1;
          } else {
            walks += 1;
          }
        }
        mechanisms += this.atlas.rides(map).length;
      }
      for (const link of records(entry.links)) {
        if (text(link.how) === "调查后跳") mechanisms += 1;
      }
    }
    return { landings, walks, mechanisms, blockedOnce };
  }

  private scoutTargetKey(target: ScoutTarget): string {
    return `${target.kind}:${target.map}:${target.cell[0]},${target.cell[1]}`;
  }

  /**
   * The report plus the one cleanup rule: load slot 20 → restore the snapshot → reload caches.
   * A failed load stops here and leaves the snapshot alone, because restoring files onto a game
   * that did not load would make the mismatch worse.
   */
  private async finishScout(
    pilot: Pilot,
    snapshot: Snapshot,
    state: ScoutRunState,
  ): Promise<string> {
    const report = this.scoutReport(state);
    if (state.end === "gameover") {
      let recovered: GameoverResult | null;
      try {
        recovered = await this.recoverScoutGameover(pilot);
      } catch (error) {
        return `${report}\n游戏结束处理失败:${describeError(error)}\n快照没有还原:游戏状态和快照现在对不上。`;
      }
      if (recovered !== null) {
        if (!recovered.ok) {
          return `${report}\n${recovered.text}\n快照没有还原:游戏状态和快照现在对不上。`;
        }
        return `${report}\n${recovered.text}\n${await this.restoreScoutSnapshot(pilot, snapshot)}`;
      }
    }
    let loaded: [boolean, string];
    try {
      loaded = await loadSlotFromMenu(pilot, this.saveSlot);
    } catch (error) {
      return `${report}\n读档失败:${describeError(error)}\n快照没有还原:游戏状态和快照现在对不上。`;
    }
    if (!loaded[0]) {
      return `${report}\n读档失败:${loaded[1]}\n快照没有还原:游戏状态和快照现在对不上。`;
    }
    return `${report}\n${loaded[1]}\n${await this.restoreScoutSnapshot(pilot, snapshot)}`;
  }

  /** Task 91's recovery, split out so the scout's game-over test can stand in for it. */
  private async recoverScoutGameover(pilot: Pilot) {
    return await recoverFromGameover(pilot, this.saveSlot);
  }

  /** Restore the save-local files, then rebuild every in-memory cache that reads them. */
  private async restoreScoutSnapshot(pilot: Pilot, snapshot: Snapshot): Promise<string> {
    try {
      await restoreSnapshot(snapshot.dir);
    } catch (error) {
      return `快照没有还原:${describeError(error)};游戏状态和快照现在对不上。`;
    }
    try {
      await this.reloadAfterScout(pilot);
    } catch (error) {
      return `已还原快照,但重载内存缓存失败:${describeError(error)}`;
    }
    return "已还原侦察前的本档进度并重载缓存(去过哪些图、图鉴、欠账、事故、笔记、阶段计划、路线进度、飞龙位置);侦察期间新记的地图结构保留。";
  }

  /**
   * Task 105 rule 5/6: read the restored save-local files back into memory. The map structure
   * (atlas, collisions) is not reloaded. Battle records are filtered by the scout windows so
   * the restored bestiary does not count monsters killed during the scout.
   */
  private async reloadAfterScout(pilot: Pilot): Promise<void> {
    const pos = parsePositionReply(await pilot.send("pos"));
    await this.atlasSave.reload();
    this.atlasSave.restore(pos.saves);
    await this.bestiary.reload();
    const names = this.bestiaryNames();
    const all = await this.scoutFreeRecords(await this.battles.allRecords());
    this.bestiary.restore(pos.saves, all, names);
    this.bestiary.observeRecords(await this.scoutFreeRecords(this.battles.recentRecords()), names);
    await this.backlog.reload();
    await this.incidents.reload();
    this.notes = this.notesFile === undefined ? [] : await loadNotes(this.notesFile);
    await this.stagePlans.reload();
    this.moveState.drake = null;
    await this.keepDrake();
    this.mapId = pos.map;
    this.lastTimer = null;
    this.lastCompletion = null;
    this.lastAchievements = null;
  }

  /** The cached scout-window file; one read per Game, updated when a scout begins or ends. */
  private async scoutWindows(signal?: AbortSignal): Promise<ScoutWindows> {
    this.scoutWindowsCache ??= await ScoutWindows.load(
      this.game,
      scoutWindowsFile(this.game, this.scoutDir),
    );
    signal?.throwIfAborted();
    return this.scoutWindowsCache;
  }

  /** Battle records written outside this save's scout windows (task 105 rule 6). */
  private async scoutFreeRecords(
    records: readonly BattleRecord[],
    signal?: AbortSignal,
  ): Promise<BattleRecord[]> {
    const windows = await this.scoutWindows(signal);
    return records.filter((battle) => !windows.inScoutWindow(battle.startedAt));
  }

  /** The result text: what was scouted, what the map learned, how long, and whether it loaded. */
  private scoutReport(state: ScoutRunState): string {
    const lines: string[] = [];
    const minutes = state.elapsedMs / 60_000;
    const headline =
      state.end === "completed"
        ? "侦察结束"
        : state.end === "gameover"
          ? "侦察中游戏结束"
          : state.end === "aborted"
            ? "侦察中止"
            : "侦察没有全部完成";
    lines.push(
      `${headline}:${state.note === "" ? "" : ` ${state.note};`}用时 ${minutes.toFixed(1)} 分钟。`,
    );
    lines.push(describeScout(state.initial));
    if (state.scouted.length > 0) {
      const shown = state.scouted
        .slice(0, 8)
        .map((target) => target.label)
        .join(";");
      lines.push(
        `侦察了 ${state.scouted.length} 个目标${state.scouted.length > 8 ? "(前 8 个)" : ""}:${shown}`,
      );
    }
    if (state.failed.length > 0) {
      lines.push(`没能侦察 ${state.failed.length} 个:${state.failed.slice(0, 6).join(";")}`);
    }
    const landings = state.after.landings - state.before.landings;
    const walks = state.after.walks - state.before.walks;
    const mechanisms = state.after.mechanisms - state.before.mechanisms;
    const verified = state.before.blockedOnce - state.after.blockedOnce;
    lines.push(
      `地图结构:新记 ${landings} 个落点、${walks} 条走法(其中机关/调查效果 ${mechanisms} 条)、` +
        `验证掉 ${Math.max(0, verified)} 条单次「走不过去」。`,
    );
    return lines.join("\n");
  }

  /** The tool result: plan summary, the purchase list here, and the departure check now. */
  private async stageReport(
    pilot: Pilot,
    record: StagePlanRecord,
    knowledge: Knowledge,
    headline: string,
  ): Promise<string> {
    const state = await this.stageTravelState(pilot);
    const currentMap = (await this.stagePosition(pilot)).map;
    const purchase =
      currentMap === null
        ? "### 采购单（读不到当前位置）"
        : await this.stagePurchaseText(pilot, record.plan, state, knowledge, currentMap);
    const check = departureCheck(record.plan, state);
    const departure = check.ok
      ? "出发检查：通过"
      : `出发检查：还不行\n${check.unmet.map((line) => `- ${line}`).join("\n")}`;
    return [
      headline,
      describeStagePlan(record.plan, record.target.label),
      this.stageBossLine(record),
      record.bossError === undefined ? "" : `首领表没有写成：${record.bossError}`,
      purchase,
      departure,
      this.stageStatsLine(record, new Date(), true),
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  /** Task 113: a fresh counter block, started when the plan leaves the town. */
  private stageNewStats(): StageStats {
    return {
      departedAt: new Date().toISOString(),
      tools: 0,
      go: 0,
      route: 0,
      planStage: 0,
      stops: 0,
    };
  }

  /** Task 113: count one model tool call while the active plan is on the road. */
  private async stageTrackTool(name: string): Promise<void> {
    // Task 117: the route book keeps its own acceptance numbers, independent of a stage plan.
    if (this.bookProgress.current !== null && this.bookProgress.current.finishedAt === null) {
      try {
        await this.bookProgress.countTool(name);
      } catch (error) {
        this.onIncident?.(`路线书统计没写成:${describeError(error)}`);
      }
    }
    const record = this.stagePlans.current;
    if (record?.status !== "departed") return;
    const stats = record.stats ?? this.stageNewStats();
    const next: StageStats = {
      ...stats,
      tools: stats.tools + 1,
      go: stats.go + (name === "go" ? 1 : 0),
      route: stats.route + (name === "route" ? 1 : 0),
      planStage: stats.planStage + (name === "plan_stage" ? 1 : 0),
    };
    try {
      await this.stagePlans.save({ ...record, stats: next });
    } catch (error) {
      this.onIncident?.(`阶段统计没写成:${describeError(error)}`);
    }
  }

  /** Task 113: departure starts the clock and counts the tool call that set out. */
  private stageDepartureStats(): StageStats {
    const name = this.stageCallName;
    return {
      departedAt: new Date().toISOString(),
      tools: name === null ? 0 : 1,
      go: name === "go" ? 1 : 0,
      route: name === "route" ? 1 : 0,
      planStage: name === "plan_stage" ? 1 : 0,
      stops: 0,
    };
  }

  /** Task 113: departure starts the clock; a plan loaded as departed keeps its own or starts now. */
  private async stageMarkDeparted(): Promise<void> {
    const record = this.stagePlans.current;
    if (record === null) return;
    const stats = record.stats ?? this.stageDepartureStats();
    await this.stagePlans.save({ ...record, status: "departed", stats });
  }

  /** Task 113: waypoints the route executor finished while following the stage plan. */
  private async stageAddStops(count: number): Promise<void> {
    if (count <= 0) return;
    const record = this.stagePlans.current;
    if (record?.status !== "departed") return;
    const stats = record.stats ?? this.stageNewStats();
    try {
      await this.stagePlans.save({
        ...record,
        stats: { ...stats, stops: stats.stops + count },
      });
    } catch (error) {
      this.onIncident?.(`阶段统计没写成:${describeError(error)}`);
    }
  }

  /**
   * Task 113's one line: the activity log uses the exact acceptance wording; the plan_stage
   * result adds plan_stage's own count so the model sees what it did during the stage.
   */
  private stageStatsLine(record: StagePlanRecord, end = new Date(), withPlanStage = false): string {
    const stats = record.stats;
    const zero = withPlanStage ? "go 0、route 0、plan_stage 0" : "go 0、route 0";
    if (stats === undefined) {
      return (
        `阶段统计「${record.target.label}」:工具 0 次(${zero}),` +
        "按计划走了 0 站，用时 0 分(还没出发)"
      );
    }
    const finished = stats.finishedAt ?? end.toISOString();
    const started = Date.parse(stats.departedAt);
    const ended = Date.parse(finished);
    const minutes =
      Number.isFinite(started) && Number.isFinite(ended)
        ? Math.max(0, Math.round((ended - started) / 60_000))
        : 0;
    const calls = withPlanStage
      ? `go ${stats.go}、route ${stats.route}、plan_stage ${stats.planStage}`
      : `go ${stats.go}、route ${stats.route}`;
    return (
      `阶段统计「${record.target.label}」:工具 ${stats.tools} 次(${calls}),` +
      `按计划走了 ${stats.stops} 站，用时 ${minutes} 分`
    );
  }

  /** Task 113: one activity line when the plan completes or is replaced by a new one. */
  private stageLogStats(record: StagePlanRecord): void {
    if (record.stats === undefined) return;
    this.onActivity?.(this.stageStatsLine(record));
  }

  /**
   *
   * Auto trigger is inference: the party is in a town (or on the world map), the destination
   * is not a town, and the destination's area differs from the current area. Nothing in the
   * game states "this is another region's dungeon", so `places.ts` says how the guess is made.
   */
  private async stageBeforeTravel(
    pilot: Pilot,
    args: Json,
    destinationMap: number | null,
    signal: AbortSignal | undefined,
  ): Promise<HandlerResult | null> {
    // Task 105: the scout replans itself; the stage officer is off for its whole run.
    if (this.scouting) return null;
    // Without an officer the stage layer is off (tests and previews that never set one keep
    // their old movement behaviour).
    if (this.stageOfficer === undefined) return null;
    const currentMap = (await this.stagePosition(pilot)).map;
    if (currentMap === null) return null;
    const knowledge = await this.ensureStageKnowledge(signal);
    const current = mapPlace(knowledge, this.atlas, currentMap);
    const destination =
      destinationMap === null ? null : mapPlace(knowledge, this.atlas, destinationMap);

    let active = this.stagePlans.current;
    if (
      this.stageAutoPlan &&
      destination !== null &&
      (active === null ||
        active.status === "completed" ||
        !sameStageTarget(active.target, targetForMap(knowledge, this.atlas, destination.mapId))) &&
      isOtherRegionDungeon(current, destination)
    ) {
      try {
        const created = await this.createStagePlan(
          pilot,
          targetForMap(knowledge, this.atlas, destination.mapId),
          signal,
        );
        if (created.record === null) {
          return {
            early: true,
            text:
              `去「${destination.name}」前先叫阶段官出了计划，但没通过检查：\n` +
              created.problems.map((problem) => `- ${problem}`).join("\n") +
              "\n补齐后重试，或自己用 plan_stage 再叫一次。",
          };
        }
        active = created.record;
        this.stageNotice = `已自动叫阶段官规划「${destination.name}」。`;
      } catch (error) {
        return {
          early: true,
          text:
            `去「${destination.name}」前先叫阶段官，但没有叫成：${describeError(error)}\n` +
            "先用 plan_stage 手动叫一次，或者原地再试。",
        };
      }
    }
    if (active === null || active.status === "completed") return null;

    if (active.status === "planned") {
      const targetPlace =
        active.target.mapId === null ? null : mapPlace(knowledge, this.atlas, active.target.mapId);
      const toward =
        (active.target.mapId !== null && destinationMap === active.target.mapId) ||
        (targetPlace !== null && destination !== null && sameRegion(targetPlace, destination)) ||
        destination?.world === true;
      if (!toward) return null;
      if (await this.stageTimerRunning(pilot)) {
        await this.stageMarkDeparted();
        this.stageNotice = "倒计时期间出发检查不拦，阶段计划记为已出发。";
        return null;
      }
      const state = await this.stageTravelState(pilot);
      const check = departureCheck(active.plan, state);
      if (!check.ok) {
        const reason = text(args.leave_incomplete)?.trim() ?? "";
        if (reason === "") {
          return {
            early: true,
            text: await this.stageDepartureRefusal(
              pilot,
              active,
              state,
              check.unmet,
              knowledge,
              currentMap,
            ),
          };
        }
        await this.stageRecordDebt(pilot, active, check.unmet, reason);
      }
      await this.stageMarkDeparted();
      this.stageNotice =
        this.stageNotice === "" ? "阶段计划：出发。" : `${this.stageNotice}阶段计划：出发。`;
      return null;
    }

    if (!this.stageInPlanArea(active, current, knowledge)) return null;
    if (await this.stageTimerRunning(pilot)) return null;
    const state = await this.stageTravelState(pilot);
    const ahead = await this.stageAhead(pilot, active, state, knowledge);
    const check = turnBackCheck(active.plan, state, ahead, {
      maxRecoveryDistance: this.stageTurnBackDistance,
    });
    if (check.turnBack) {
      const reason = text(args.leave_incomplete)?.trim() ?? "";
      if (reason === "") {
        return {
          early: true,
          text: this.stageTurnBackRefusal(active, check.reasons, currentMap, knowledge),
        };
      }
      await this.stageRecordDebt(pilot, active, check.reasons, reason);
      return null;
    }
    if (check.continueTo !== null) {
      this.stageNotice = `阶段计划：${check.reasons.join("；")}。`;
    }
    return null;
  }

  /**
   * Task 101: a coordinate `go` inside the active stage's maps is refused unless the cell is a
   * plan waypoint, a nameless hidden-item/event cell, or the model gives a reason. Task 113
   * turns that refusal into walking the plan, unless its switch is off. The gate is deliberately
   * before any key press: the countdown rule neither loosens nor tightens it.
   */
  private async stageBeforeGoCell(
    pilot: Pilot,
    args: Json,
    cell: Cell,
    targetMap: number | null = null,
    signal?: AbortSignal,
  ): Promise<HandlerResult | null> {
    // Task 105: a scout walks its own target cells; the plan gate must not stop it.
    if (this.scouting) return null;
    if (!this.stageGoGate) return null;
    const active = this.stagePlans.current;
    if (active === null || active.status === "completed") return null;
    // Task 117: a station handed to the model has no coordinate by definition; its own
    // interact/go must not be turned back into the plan that just stopped there.
    if (
      active.book !== undefined &&
      this.bookProgress.current?.stations.some((station) => station.status === "current") === true
    ) {
      return null;
    }
    const { map: currentMap, cell: currentCell } = await this.stagePosition(pilot);
    if (currentMap === null) return null;
    let knowledge: Knowledge;
    try {
      knowledge = await this.ensureStageKnowledge(signal);
    } catch {
      // A broken knowledge module must not make movement impossible; the gate fails open.
      return null;
    }
    const current = mapPlace(knowledge, this.atlas, currentMap);
    if (!this.stagePlanCovers(active, current, knowledge)) return null;
    const goalMap = targetMap ?? currentMap;
    const waypoints = this.stageRouteWaypoints(active, currentMap);
    if (
      waypoints.some(
        (waypoint) =>
          waypoint.map === goalMap && waypoint.cell !== null && matchesCell(waypoint.cell, cell),
      )
    ) {
      return null;
    }
    if (goalMap === currentMap && (await this.stageNamelessCell(pilot, cell))) return null;
    const reason = text(args.leave_incomplete)?.trim() ?? "";
    if (reason !== "") {
      this.onActivity?.(`阶段计划放行 go(${goalMap}:${cell[0]},${cell[1]}) 理由:${reason}`);
      const where =
        goalMap === currentMap
          ? `(${cell[0]},${cell[1]})`
          : `地图 ${goalMap} (${cell[0]},${cell[1]})`;
      this.stageNotice = `阶段计划放行：带理由走坐标 ${where}（${reason}）；没有记欠账。`;
      return null;
    }
    // Task 113: the refusal becomes the walk itself. A plan with no executable stop still
    // answers with the old explanation instead of pretending to have moved.
    if (this.stageGoFollowPlan) {
      const followed = await this.stageFollowPlan(pilot, args, signal);
      if (followed !== null) {
        return {
          early: followed.early,
          text:
            "这个坐标不在阶段计划里，代码按计划接着走了。\n" +
            "要离开计划就带 leave_incomplete 写理由再 go。\n" +
            followed.text,
        };
      }
    }
    return {
      early: true,
      text: this.stageGoCellRefusal(
        active,
        waypoints,
        currentMap,
        currentCell,
        goalMap,
        cell,
        knowledge,
      ),
    };
  }

  /**
   * Task 113: a target cell exactly on a known exit/entrance is that map's arrival, so a
   * coordinate `go` can trigger the same stage planning and departure check as a named `go`.
   * Only the exact cell counts: an adjacent exit must not change what a normal walk means.
   */
  private async stageEntranceDestination(
    pilot: Pilot,
    cell: Cell,
    currentMap: number,
  ): Promise<number | null> {
    const best: { map: number | null; distance: number } = {
      map: null,
      distance: Number.POSITIVE_INFINITY,
    };
    const consider = (target: Cell, to: number): void => {
      if (to === currentMap) return;
      const distance = Math.abs(target[0] - cell[0]) + Math.abs(target[1] - cell[1]);
      if (distance !== 0 || distance >= best.distance) return;
      best.map = to;
      best.distance = distance;
    };
    const entry = this.atlas.maps.get(String(currentMap));
    if (entry !== undefined) {
      for (const exit of records(entry.exits)) {
        const target = cellOf(exit.cell);
        const to = num(exit.to);
        if (target !== null && to !== undefined) consider(target, Math.trunc(to));
      }
    }
    try {
      const found = record((await pilot.send("entities", { kind: "GotoMap", max: 300 })).entities);
      for (const entity of records(found.entities)) {
        if (entity.active === false) continue;
        const target = cellOf(entity.cell);
        const to = num(entity.toMap);
        if (target !== null && to !== undefined) consider(target, Math.trunc(to));
      }
    } catch {
      // An older bridge or a failed read still leaves the atlas exits usable.
    }
    return best.map;
  }

  /**
   * Task 113: after a go reached the plan's map, keep following it in this same tool call.
   * The route executor's `early` rule still returns for a story choice, a boss or a game over.
   */
  private async stageContinuePlanAfterTravel(
    pilot: Pilot,
    args: Json,
    destinationMap: number | null,
    signal?: AbortSignal,
  ): Promise<HandlerResult | null> {
    if (!this.stageContinueAfterTravel) return null;
    if (this.scouting) return null;
    const record = this.stagePlans.current;
    if (record?.status !== "departed") return null;
    const { map: currentMap } = await this.stagePosition(pilot);
    if (currentMap === null) return null;
    if (destinationMap !== null && currentMap !== destinationMap) return null;
    let knowledge: Knowledge;
    try {
      knowledge = await this.ensureStageKnowledge(signal);
    } catch {
      return null;
    }
    const current = mapPlace(knowledge, this.atlas, currentMap);
    if (!this.stagePlanCovers(record, current, knowledge)) return null;
    const followed = await this.stageFollowPlan(pilot, args, signal);
    if (followed === null) return null;
    return {
      early: followed.early,
      text: `阶段计划：到了「${stagePlaceName(knowledge, this.atlas, currentMap)}」，代码接着按计划走。\n${followed.text}`,
    };
  }

  /**
   * Task 113: the same path as `route()` without stops: saved progress first, then the stage
   * plan's own stops. Returns null when the plan has no executable stop.
   */
  private async stageFollowPlan(
    pilot: Pilot,
    args: Json,
    signal?: AbortSignal,
  ): Promise<HandlerResult | null> {
    const bookPlan = this.stagePlans.current;
    if (
      this.routeBookEnabled &&
      bookPlan !== null &&
      bookPlan.status !== "completed" &&
      bookPlan.book !== undefined
    ) {
      return await this.followBookSection(pilot, args, signal);
    }
    if (this.routeFile !== undefined) {
      try {
        let completedBefore = 0;
        try {
          completedBefore = (await readProgress(this.routeFile)).completed.length;
        } catch {
          // No readable progress: resumeRoute will report the real reason below.
        }
        const result = await resumeRoute(this.routeFile, this.routePorts(pilot, args), { signal });
        await this.stageAddStops(Math.max(0, result.completed.length - completedBefore));
        return {
          text: result.text,
          early: result.reason === "gameover" || result.reason === "decision",
        };
      } catch (error) {
        const body = describeError(error);
        if (!body.startsWith("没有路线进度文件")) {
          return { text: `没有可接着走的路线：${body}`, early: true };
        }
      }
    }
    const record = this.stagePlans.current;
    if (record !== null && record.status !== "completed" && record.plan.route.length > 0) {
      const stops = this.stagePlanRouteStops(record);
      if (stops.length > 0) return await this.runRouteStops(pilot, args, stops, null, signal, true);
    }
    return null;
  }

  /** Is this map the stage's destination area or one the plan route passes through? */
  private stagePlanCovers(
    record: StagePlanRecord,
    current: MapPlace,
    knowledge: Knowledge,
  ): boolean {
    if (this.stageInPlanArea(record, current, knowledge)) return true;
    for (const waypoint of this.stageRouteWaypoints(record, current.mapId)) {
      if (waypoint.map === current.mapId) return true;
      if (sameRegion(mapPlace(knowledge, this.atlas, waypoint.map), current)) return true;
    }
    return false;
  }

  /** The plan's route as executable waypoints; a name the atlas cannot resolve is skipped. */
  private stageRouteWaypoints(record: StagePlanRecord, startMap: number): Waypoint[] {
    const waypoints: Waypoint[] = [];
    for (const [index, stop] of record.plan.route.entries()) {
      try {
        waypoints.push(
          resolveRouteStop(
            {
              to: stop.to,
              action: stop.do ?? "move",
              optional: stop.optional ?? false,
            },
            `stage-go-${index + 1}`,
            startMap,
            this.atlas,
            false,
          ),
        );
      } catch {
        // The gate can still use the other stops; checkStagePlan reports bad plan targets.
      }
    }
    return waypoints;
  }

  /**
   * Task 83/99: an active Event entity is a trigger cell even without a name, and a hidden
   * treasure (TresureBox with hidden/treasureType 2) is a nameless pick-up cell. Both are the
   * kinds of places `go` coordinates are still for; open chests are not.
   */
  private async stageNamelessCell(pilot: Pilot, cell: Cell): Promise<boolean> {
    try {
      const events = records(
        record((await pilot.send("entities", { kind: "Event", max: 200 })).entities).entities,
      );
      for (const event of events) {
        if (event.active === false) continue;
        const found = cellOf(event.cell);
        if (found !== null && matchesCell(found, cell)) return true;
      }
      const treasures = records(
        record((await pilot.send("entities", { kind: "TresureBox", max: 200 })).entities).entities,
      );
      return parseTreasureEntities(treasures).some(
        (spot) =>
          spot.kind === "hidden" &&
          !spot.opened &&
          spot.cell !== null &&
          matchesCell(spot.cell, cell),
      );
    } catch {
      return false;
    }
  }

  /** The refusal: the plan's destination, route, next waypoint and the three ways forward. */
  private stageGoCellRefusal(
    record: StagePlanRecord,
    waypoints: readonly Waypoint[],
    currentMap: number,
    currentCell: Cell | null,
    goalMap: number,
    goal: Cell,
    knowledge: Knowledge,
  ): string {
    const where =
      goalMap === currentMap
        ? `(${goal[0]}, ${goal[1]})`
        : `地图 ${goalMap} (${goal[0]}, ${goal[1]})`;
    const lines = [
      `阶段计划拦下：这一段「${record.target.label}」还在进行，先别用 go 走坐标 ${where}。`,
    ];
    if (waypoints.length === 0) {
      lines.push("计划路线：计划里没有能落地执行的路标。");
    } else {
      lines.push(
        `计划路线：${waypoints.map((waypoint, index) => `${index + 1}. ${waypoint.label}`).join(" → ")}`,
      );
      let next = 0;
      for (const [index, waypoint] of waypoints.entries()) {
        if (
          waypoint.map === currentMap &&
          (waypoint.cell === null ||
            (currentCell !== null && matchesCell(waypoint.cell, currentCell)))
        ) {
          next = index + 1;
        }
      }
      if (next >= waypoints.length) next = Math.max(0, waypoints.length - 1);
      const remaining = waypoints.slice(next);
      lines.push(
        `还剩 ${remaining.length} 个路标：` +
          remaining.map((waypoint) => waypoint.label).join(" → ") +
          `；下一个：${remaining[0]?.label ?? "（没有）"}`,
      );
    }
    const place = stagePlaceName(knowledge, this.atlas, currentMap);
    lines.push(
      `接着走用 route()（会按阶段计划的路线走）；要改路标就用 route 再给 stops；` +
        `要重做计划用 plan_stage(replan: true)。现在在「${place}」。`,
    );
    lines.push(
      "这一格是没有名字的隐藏道具格、事件触发格，或者确实要走坐标，就带 leave_incomplete " +
        '写具体理由，例如 leave_incomplete="要先踩这个触发格"。',
    );
    return lines.join("\n");
  }

  private stageInPlanArea(
    record: StagePlanRecord,
    current: MapPlace,
    knowledge: Knowledge,
  ): boolean {
    if (record.target.mapId !== null && record.target.mapId === current.mapId) return true;
    if (record.target.mapId !== null) {
      const target = mapPlace(knowledge, this.atlas, record.target.mapId);
      return sameRegion(target, current);
    }
    return record.target.areaName !== null && record.target.areaName === current.areaName;
  }

  /** Live countdown: never block, per task 89's rule. */
  private async stageTimerRunning(pilot: Pilot): Promise<boolean> {
    let timer = await this.stagePosTimer(pilot);
    if (timer === null) {
      try {
        timer = parseRouteTimer(record((await pilot.query("sample")).sample).timer);
      } catch {
        timer = null;
      }
    }
    if (timer !== null) this.lastTimer = timer;
    return this.lastTimer?.active === true;
  }

  private async stageDepartureRefusal(
    pilot: Pilot,
    record: StagePlanRecord,
    state: StageTravelState,
    unmet: readonly string[],
    knowledge: Knowledge,
    currentMap: number,
  ): Promise<string> {
    const purchase = await this.stagePurchaseText(pilot, record.plan, state, knowledge, currentMap);
    const where = stagePlaceName(knowledge, this.atlas, currentMap);
    return [
      `去「${record.target.label}」这一段还没备齐，先别从「${where}」出发：`,
      ...unmet.map((line) => `- ${line}`),
      purchase,
      '补齐后再走；确实要出发就带 leave_incomplete 写具体理由，例如 leave_incomplete="药不够，路上小心"。带理由出发会记一条欠账。',
    ].join("\n");
  }

  private stageTurnBackRefusal(
    record: StagePlanRecord,
    reasons: readonly string[],
    currentMap: number,
    knowledge: Knowledge,
  ): string {
    return [
      "回头检查不通过，先别往更深处走：",
      ...reasons.map((line) => `- ${line}`),
      this.stageReturnRoute(record, currentMap, knowledge),
      '确实要往里走就带 leave_incomplete 写具体理由，例如 leave_incomplete="还能撑到下一个存档点"。带理由往里走会记一条欠账。',
    ].join("\n");
  }

  /** A named way back to the plan's starting town, from the atlas when it knows one. */
  private stageReturnRoute(
    record: StagePlanRecord,
    currentMap: number,
    knowledge: Knowledge,
  ): string {
    const start = record.startMapId;
    if (start !== undefined && start !== null) {
      const path = travel.mapPath(this.atlas, currentMap, start, new Set<string>(), true);
      if (path !== null) {
        const names = [currentMap, ...path.map((hop) => hop.to)].map((mapId) =>
          stagePlaceName(knowledge, this.atlas, mapId),
        );
        return `回城路线：${names.join(" → ")}`;
      }
    }
    return `回城路线：先走出这张图，回「${record.startLabel ?? "出发城镇"}」`;
  }

  /** One debt entry for an allowed incomplete departure, matching go's leave_incomplete. */
  private async stageRecordDebt(
    pilot: Pilot,
    record: StagePlanRecord,
    missing: readonly string[],
    reason: string,
  ): Promise<void> {
    const mapId = (await this.stagePosition(pilot)).map;
    const mapName =
      mapId === null
        ? (record.startLabel ?? "出发城镇")
        : stagePlaceName(this.knowledgeOption ?? this.knowledge ?? null, this.atlas, mapId);
    try {
      await this.backlog.add({
        mapId,
        areaId: null,
        region: null,
        mapName,
        missing: [...missing],
        reason,
      });
      this.stageNotice = `阶段计划没齐，按理由「${reason}」放行，记了一条欠账。`;
    } catch {
      this.stageNotice = `阶段计划没齐，按理由「${reason}」放行；欠账没写进文件。`;
    }
  }

  /** Recovery/save points still on the plan's route, with the analyzer's walking distance. */
  private async stageAhead(
    pilot: Pilot,
    record: StagePlanRecord,
    state: StageTravelState,
    knowledge: Knowledge,
  ): Promise<AheadPoint[]> {
    const { map: currentMap, cell: currentCell } = await this.stagePosition(pilot);
    if (currentMap === null || currentCell === null) return [];
    const facts = buildStageFacts({
      target: record.target,
      knowledge,
      atlas: this.atlas,
      party: state.party,
      bag: state.bag,
      gil: state.gil,
    });
    const points: AheadPoint[] = [];
    for (const [index, stop] of record.plan.route.entries()) {
      let waypoint: Waypoint;
      try {
        waypoint = resolveRouteStop(
          {
            to: stop.to,
            action: stop.do ?? "move",
            optional: stop.optional ?? false,
          },
          `stage${index + 1}`,
          currentMap,
          this.atlas,
          false,
        );
      } catch {
        continue;
      }
      if (waypoint.cell === null) continue;
      const cell = waypoint.cell;
      let kind: "recovery" | "save" | null = null;
      if (stop.do === "save") kind = "save";
      if (
        facts.recoveryPoints.some(
          (point) => point.mapId === waypoint.map && matchesCell(point.cell, cell),
        )
      ) {
        kind = "recovery";
      } else if (
        kind === null &&
        facts.savePoints.some(
          (point) => point.mapId === waypoint.map && matchesCell(point.cell, cell),
        )
      ) {
        kind = "save";
      }
      if (kind === null) continue;
      points.push({
        kind,
        target: {
          mapId: waypoint.map,
          areaName: stagePlaceName(knowledge, this.atlas, waypoint.map),
          label: waypoint.label,
        },
        distance: stageDistance(this.atlas, this.collisions, currentMap, currentCell, waypoint),
      });
    }
    return points;
  }

  /** Task 97: after a battle or a map entry in the stage, check the turn-back conditions. */
  private async stageAfterBattle(pilot: Pilot, touched: boolean): Promise<string> {
    if (this.scouting) return "";
    if (!touched) return "";
    const record = this.stagePlans.current;
    if (record === null) return "";
    if (record.status !== "departed") return "";
    try {
      if (this.mapId === null) return "";
      const knowledge = await this.ensureStageKnowledge();
      const current = mapPlace(knowledge, this.atlas, this.mapId);
      if (!this.stageInPlanArea(record, current, knowledge)) return "";
      const state = await this.stageTravelState(pilot);
      const ahead = await this.stageAhead(pilot, record, state, knowledge);
      const check = turnBackCheck(record.plan, state, ahead, {
        maxRecoveryDistance: this.stageTurnBackDistance,
      });
      if (check.reasons.length === 0) return "";
      return (
        "阶段回头检查：\n" +
        check.reasons.map((line) => `- ${line}`).join("\n") +
        (check.turnBack
          ? "\n该回头了；再往深处走会被拒绝，写 leave_incomplete 才能硬走。"
          : `\n先到回复点「${check.continueTo?.label ?? "前面那个"}」处理，不拦你继续走。`)
      );
    } catch (error) {
      return `阶段回头检查没做成：${describeError(error)}`;
    }
  }

  /** Task 97: reaching the plan's last stop or beating a boss closes the plan. */
  private async stageCompletion(pilot: Pilot): Promise<string> {
    if (this.scouting) return "";
    const record = this.stagePlans.current;
    if (record === null || record.status === "completed") return "";
    // Task 117: a book plan finishes when its stations are done, not when the party happens to
    // stand on the last route target (a handoff has no cell at all).
    if (record.book !== undefined) return "";
    let reason = "";
    if (this.stageBossWon) {
      if (this.mapId !== null) {
        const knowledge = await this.ensureStageKnowledge();
        const current = mapPlace(knowledge, this.atlas, this.mapId);
        if (this.stageInPlanArea(record, current, knowledge)) reason = "首领打完";
      }
    } else {
      const { map: currentMap, cell: currentCell } = await this.stagePosition(pilot);
      if (currentMap !== null) {
        const last = record.plan.route.at(-1);
        if (last !== undefined) {
          try {
            const waypoint = resolveRouteStop(
              {
                to: last.to,
                action: last.do ?? "move",
                optional: last.optional ?? false,
              },
              "stage-end",
              currentMap,
              this.atlas,
              true,
            );
            if (
              waypoint.map === currentMap &&
              (waypoint.cell === null ||
                (currentCell !== null && matchesCell(waypoint.cell, currentCell)))
            ) {
              reason = `到了计划终点「${waypoint.label}」`;
            }
          } catch {
            reason = "";
          }
        } else if (record.target.mapId !== null && record.target.mapId === currentMap) {
          reason = `到了「${record.target.label}」`;
        }
      }
    }
    if (reason === "") return "";
    this.stageBossWon = false;
    const finishedAt = new Date().toISOString();
    const stats = record.stats === undefined ? undefined : { ...record.stats, finishedAt };
    const completed: StagePlanRecord = {
      ...record,
      status: "completed",
      ...(stats === undefined ? {} : { stats }),
    };
    await this.stagePlans.save(completed);
    if (stats !== undefined) this.stageLogStats(completed);
    return (
      `阶段计划：已完成（${reason}）。` +
      (stats === undefined ? "" : `\n${this.stageStatsLine(completed)}`)
    );
  }

  /**
   * Task 58: one movement tool. `to` is a map (id or part of a name) or a cell; either way the
   * result is the old route/walk text and the Game then appends completion and the current
   * state as before. Task 97 runs the stage gates before a map move.
   */
  private async toolGo(args: Json, pilot: Pilot, signal?: AbortSignal): Promise<HandlerResult> {
    const coordinate = goCellTarget(args.to);
    if (coordinate !== null) {
      const cell = coordinate.cell;
      const leaveReason = text(args.leave_incomplete)?.trim() ?? "";
      let current: number | null = null;
      try {
        [current] = await travel.currentMapAndCell(pilot);
      } catch {
        current = null;
      }
      if (coordinate.map !== null && current === null) {
        return {
          text: "go 读不到当前位置，没法走「地图号:x,y」",
          early: true,
        };
      }
      // Task 113: a cell on an exit/entrance is this go's destination map, so the auto plan
      // and departure check run exactly as they do for a named map.
      const entranceMap =
        current !== null && (coordinate.map === null || coordinate.map === current)
          ? await this.stageEntranceDestination(pilot, cell, current)
          : null;
      if (entranceMap !== null) {
        const refusal = await this.stageBeforeTravel(pilot, args, entranceMap, signal);
        if (refusal !== null) return refusal;
      }
      const refusal = await this.stageBeforeGoCell(pilot, args, cell, coordinate.map, signal);
      if (refusal !== null) return refusal;
      const targetMap = coordinate.map ?? current;
      const label =
        targetMap === null || targetMap === current
          ? `go → (${cell[0]}, ${cell[1]})`
          : `go → 地图 ${targetMap} (${cell[0]}, ${cell[1]})`;
      // 11-10: the exact entrance cell is still walked by goCell; stepping onto it changes the
      // map, and that map is the arrival. Only continue the plan after the map really changed.
      if (entranceMap !== null) {
        return await this.withWalkLabel(label, async () => {
          const walked = await this.goCell(args, pilot, cell);
          const arrived = (await this.stagePosition(pilot)).map === entranceMap;
          const followed =
            arrived && leaveReason === ""
              ? await this.stageContinuePlanAfterTravel(pilot, args, entranceMap, signal)
              : null;
          if (followed === null) return walked;
          return {
            text: [walked.text, followed.text].join("\n"),
            early: followed.early,
          };
        });
      }
      return await this.withWalkLabel(label, async () => {
        if (targetMap === null || current === null || targetMap === current) {
          return await this.goCell(args, pilot, cell);
        }
        return await this.withFlee(args, async () => {
          const travelled = await travel.travelToMap(
            pilot,
            {
              atlas: this.atlas,
              moveState: this.moveState,
              collisions: this.collisions,
            },
            targetMap,
            () => undefined,
            this.travelOptions(args),
          );
          if (!travelled.reached) return { text: travelled.text };
          const walked = await this.goCell(args, pilot, cell);
          return { text: [travelled.text, walked.text].join("\n") };
        });
      });
    }
    const choice = travel.findMap(this.atlas, args.to);
    if (!choice.ok) return { text: `go 没有执行:${choice.error}`, early: true };
    const refusal = await this.stageBeforeTravel(pilot, args, choice.mapId, signal);
    if (refusal !== null) return refusal;
    const name = this.mapNameOf(choice.mapId);
    const label =
      name === "" ? `go → 地图 ${choice.mapId}` : `go → 地图 ${choice.mapId}「${name}」`;
    return await this.withWalkLabel(label, () =>
      this.withFlee(args, async () => {
        const result = await travel.travelToMap(
          pilot,
          {
            atlas: this.atlas,
            moveState: this.moveState,
            collisions: this.collisions,
          },
          choice.mapId,
          () => undefined,
          this.travelOptions(args),
        );
        if (!result.reached) return { text: result.text };
        const followed = await this.stageContinuePlanAfterTravel(pilot, args, choice.mapId, signal);
        if (followed === null) return { text: result.text };
        return {
          text: [result.text, followed.text].join("\n"),
          early: followed.early,
        };
      }),
    );
  }

  /**
   * Task 89: one tool call for a whole stretch. The stops are planned by the analyzer, then the
   * executor walks them; normal battles and dialog are handled in code. The tool only returns
   * for an end, a decision, an unreachable rest, repeated failure, a game-over popup or cancel.
   */
  private async toolRoute(args: Json, pilot: Pilot, signal?: AbortSignal): Promise<HandlerResult> {
    const rawStops = args.stops === null ? undefined : args.stops;
    const endInput = parseRouteEnd(args.end);
    if (rawStops === undefined && endInput === null) {
      return await this.resumeRouteTool(pilot, signal);
    }
    if (rawStops !== undefined && !Array.isArray(rawStops)) {
      throw new Error("route 的 stops 要写成数组");
    }
    const stops = list(rawStops).map((entry, index) => parseRouteStop(entry, `stops[${index}]`));
    if (stops.length === 0 && endInput === null) {
      return await this.resumeRouteTool(pilot, signal);
    }
    return await this.runRouteStops(pilot, args, stops, endInput, signal);
  }

  /** One route execution, shared by explicit stops and the stage plan's fallback. */
  private async runRouteStops(
    pilot: Pilot,
    args: Json,
    stops: readonly RouteStopInput[],
    endInput: RouteStopInput | null,
    signal?: AbortSignal,
    followPlan = false,
    persistProgress = true,
    onWaypoint?: (stop: Waypoint, event: "done" | "skipped" | "current") => Promise<void>,
  ): Promise<HandlerResult> {
    const destination = await this.routeDestinationMap(pilot, stops, endInput);
    const refusal = await this.stageBeforeTravel(pilot, args, destination, signal);
    if (refusal !== null) return refusal;
    return await this.withFlee(args, () =>
      this.withWalkLabel("route", async () => {
        const built = await this.buildRoute(pilot, stops, endInput);
        if (built === null) return { text: "路线没有排出来：读不到当前位置", early: true };
        if ("error" in built) return { text: built.error, early: true };
        const result = await executeRoute(built.plan, this.routePorts(pilot, args), {
          ...(persistProgress ? { progressFile: this.routeFile } : {}),
          waypoints: built.waypoints,
          end: built.end,
          signal,
          ...(onWaypoint === undefined ? {} : { onWaypoint }),
        });
        // Task 113: only a code-driven plan walk counts toward the stage's stop total; an
        // explicit `route` from the model is its own plan.
        if (followPlan) await this.stageAddStops(result.completed.length);
        return {
          text: result.text,
          early: result.reason === "gameover" || result.reason === "decision",
        };
      }),
    );
  }

  /**
   * `route()` without stops: a saved route progress wins; without one, the active stage plan's
   * route becomes the stops (task 101 review). The plan is what the AI was just told to follow,
   * so a fresh plan must not leave `route()` with nothing to walk.
   */
  private async resumeRouteTool(pilot: Pilot, signal?: AbortSignal): Promise<HandlerResult> {
    // Task 117: with no running plan, a book section that covers where the party is starts
    // its own plan first. It is `route {}` = execute the next section, not a manual plan call.
    const automatic = await this.autoBookRoute(pilot, {}, signal);
    if (automatic !== null) return automatic;
    const followed = await this.stageFollowPlan(pilot, {}, signal);
    if (followed !== null) return followed;
    return {
      text: "没有可接着走的路线：没有路线进度，也没有进行中的阶段计划",
      early: true,
    };
  }

  /** The plan's route as route-tool stops, keeping `do`, `optional` and a grind's `until`. */
  private stagePlanRouteStops(record: StagePlanRecord): RouteStopInput[] {
    return record.plan.route.map((stop) => ({
      to: stop.to,
      action: stop.do ?? "move",
      optional: stop.optional ?? stop.do === "open",
      ...(stop.until === undefined ? {} : { until: stop.until }),
      ...(stop.book === undefined ? {} : { book: stop.book }),
    }));
  }

  /** Task 97: the map the whole route heads for, for the auto trigger and the gates. */
  private async routeDestinationMap(
    pilot: Pilot,
    stops: readonly RouteStopInput[],
    endInput: RouteStopInput | null,
  ): Promise<number | null> {
    const [startMap] = await travel.currentMapAndCell(pilot);
    if (startMap === null) return null;
    const last = endInput ?? stops[stops.length - 1];
    if (last === undefined) return null;
    try {
      return resolveRouteStop(last, "stage-destination", startMap, this.atlas, true).map;
    } catch {
      return null;
    }
  }

  private async buildRoute(
    pilot: Pilot,
    stops: readonly RouteStopInput[],
    endInput: RouteStopInput | null,
  ): Promise<
    | {
        plan: import("./route/types.ts").RoutePlan;
        waypoints: Waypoint[];
        end: Waypoint;
      }
    | { error: string }
    | null
  > {
    const [startMap, startCell] = await travel.currentMapAndCell(pilot);
    if (startMap === null || startCell === null) return null;
    const resolved = stops.map((stop, index) =>
      resolveRouteStop(stop, `s${index + 1}`, startMap, this.atlas, false),
    );
    let waypoints: Waypoint[];
    let end: Waypoint;
    if (endInput !== null) {
      waypoints = resolved;
      end = resolveRouteStop(endInput, "end", startMap, this.atlas, true);
    } else {
      const lastStop = stops[stops.length - 1];
      const last = resolved[resolved.length - 1];
      if (lastStop === undefined || last === undefined) throw new Error("route 需要 stops 或 end");
      if (lastStop.action === "move") {
        // The last stop is the destination: no separate action to run there.
        waypoints = resolved.slice(0, -1);
        end = resolveRouteStop(lastStop, "end", startMap, this.atlas, true);
      } else {
        // Keep the chest/save/talk action, then finish at the same place (the end is free).
        waypoints = resolved;
        end = {
          ...last,
          id: "end",
          kind: "move",
          reach: "cell",
          optional: false,
          label: `终点 ${last.label}`,
        };
      }
    }
    const plan = analyzeRoute(
      {
        start: { map: startMap, cell: [startCell[0], startCell[1]] },
        end: { map: end.map, cell: end.cell },
        waypoints,
      },
      {
        atlas: this.atlas,
        collisions: this.collisions,
        battleSeconds: this.routeBattleSeconds,
      },
    );
    if (!plan.legs.some((leg) => leg.waypoint === "end")) {
      const why = plan.warnings.join("；") || "地图记录里没有到终点的路";
      return { error: `终点走不到：${why}` };
    }
    return { plan, waypoints, end };
  }

  private routePorts(pilot: Pilot, args: Json): RoutePorts {
    const flee = truthy(args.flee);
    const now = async (): Promise<{ map: number; cell: Cell } | null> => {
      const pos = parsePositionReply(await pilot.send("pos"));
      if (pos.map === null || pos.cell === null) return null;
      return { map: pos.map, cell: [pos.cell[0], pos.cell[1]] };
    };
    return {
      position: now,
      goTo: async (stop) => {
        const from = await now();
        if (from === null) return { ok: false, text: "读不到当前位置" };
        const lines: string[] = [];
        if (from.map !== stop.map) {
          const travelled = await travel.travelToMap(
            pilot,
            {
              atlas: this.atlas,
              moveState: this.moveState,
              collisions: this.collisions,
            },
            stop.map,
            () => undefined,
            this.travelOptions(args),
          );
          lines.push(travelled.text);
          if (!travelled.reached) return { ok: false, text: travelled.text };
        }
        if (stop.reach === "map") return { ok: true, text: lines.join("\n") || "到了地图" };
        if (stop.cell === null) return { ok: true, text: lines.join("\n") || "到了地图" };
        let walked = await this.goCell(
          { to: [stop.cell[0], stop.cell[1]], flee },
          pilot,
          stop.cell,
        );
        let after = await now();
        if (after !== null && after.map === stop.map && matchesCell(after.cell, stop.cell)) {
          return { ok: true, text: [...lines, walked.text].join("\n") };
        }
        // A story event or a dialog stops the walk before the goal; page it here, as
        // advance_story would, and only return to the AI when it opens a choice.
        if (interruptedByStory(walked.text)) {
          const advanced = await this.toolAdvanceStory(pilot);
          lines.push(advanced.text);
          const decision = await this.storyDecision(pilot);
          if (decision !== null) {
            return {
              ok: false,
              text: [...lines, walked.text].join("\n"),
              decision,
            };
          }
          walked = await this.goCell({ to: [stop.cell[0], stop.cell[1]], flee }, pilot, stop.cell);
          lines.push(walked.text);
          after = await now();
          if (after !== null && after.map === stop.map && matchesCell(after.cell, stop.cell)) {
            return { ok: true, text: lines.join("\n") };
          }
        }
        if (after !== null && after.map !== stop.map) {
          return { ok: true, text: [...lines, walked.text].join("\n") };
        }
        return { ok: false, text: [...lines, walked.text].join("\n") };
      },
      act: async (stop) => {
        if (stop.kind === "move") return { ok: true, done: true, text: "走到了" };
        if (stop.kind === "save") {
          const windows = await this.scoutWindows();
          const refusal = scoutSaveGuard({ scouting: this.scouting, windows });
          if (refusal !== null) return { ok: false, done: false, text: refusal };
          const [ok, detail] = await save.saveGame(pilot, this.saveSlot, this.saveTimerMinSeconds);
          if (ok) await this.captureBestiary(pilot);
          return { ok, done: ok, text: detail };
        }
        if (stop.cell === null) return { ok: false, done: false, text: "这个路标没有格子" };
        const acted = await this.toolInteract({ x: stop.cell[0], y: stop.cell[1] }, pilot);
        const decision = await this.storyDecision(pilot);
        if (decision !== null) {
          return { ok: false, done: false, text: acted.text, decision };
        }
        if (acted.early) {
          return {
            ok: false,
            done: false,
            text: acted.text,
            decision: acted.text,
          };
        }
        if (interactionFailed(acted.text)) {
          return { ok: false, done: false, text: acted.text };
        }
        return { ok: true, done: true, text: acted.text };
      },
      story: async () => await this.storyAdvance(pilot),
      replan: (from, rest, end) =>
        Promise.resolve(
          analyzeRoute(
            {
              start: from,
              end: end === null ? null : { map: end.map, cell: end.cell },
              waypoints: rest,
            },
            {
              atlas: this.atlas,
              collisions: this.collisions,
              battleSeconds: this.routeBattleSeconds,
            },
          ),
        ),
      grind: async (stop) => await this.routeGrind(pilot, stop),
      watch: async () => await this.routeWatch(pilot),
      estimate: (from, stop, end) => {
        const plan = analyzeRoute(
          {
            start: from,
            end: end === null ? null : { map: end.map, cell: end.cell },
            waypoints: [stop],
          },
          {
            atlas: this.atlas,
            collisions: this.collisions,
            battleSeconds: this.routeBattleSeconds,
          },
        );
        if (!plan.legs.some((leg) => leg.waypoint === stop.id)) return Promise.resolve(null);
        if (end !== null && !plan.legs.some((leg) => leg.waypoint === "end")) {
          return Promise.resolve(null);
        }
        const battles = Math.ceil(plan.total.cells / ROUTE_ENCOUNTER_CELLS);
        return Promise.resolve(plan.total.minutes * 60 + battles * this.routeBattleSeconds);
      },
      skip: (stop) => this.recordRouteDebt(pilot, stop),
    };
  }

  private async routeWatch(pilot: Pilot): Promise<RouteWatch> {
    const pos = record((await pilot.send("pos")).pos);
    let timer = parseRouteTimer(pos.timer);
    let gameover = parseGameover(pos.gameover);
    try {
      const sample = record((await pilot.query("sample")).sample);
      timer ??= parseRouteTimer(sample.timer);
      gameover ??= parseGameover(sample.gameover);
    } catch {
      // An old bridge or a failed sample read still lets the route walk; only the countdown
      // and game-over checks are skipped for this step.
    }
    this.lastTimer = timer;
    return { timer, gameover };
  }

  /**
   * Task 89: stop for a story choice, a shop with no list, or a boss that is already starting.
   * Queried after every interact and after a dialog stop; no key is pressed here.
   */
  private async storyDecision(pilot: Pilot): Promise<string | null> {
    const sample = record((await pilot.query("sample")).sample);
    const choice = record(sample.choice);
    if (Object.values(choice).some((value) => isRecord(value) && truthy(value.open))) {
      return "路上出现了剧情选项，交给 AI 选";
    }
    const pos = record((await pilot.send("pos")).pos);
    const state = text(pos.state) ?? "";
    if (state === "Shop") return "打开了商店，没有采购单，交给 AI 决定买什么或离开";
    if (state === "Menu") return "打开了菜单，交给 AI 决定怎么处理";
    const battle = record(sample.battle);
    if (truthy(battle.boss)) return "首领战开始了，交给 AI 决定怎么打";
    return null;
  }

  /** Task 89: a skipped chest becomes one debt on the map it was skipped on. */
  private async recordRouteDebt(pilot: Pilot, stop: Waypoint): Promise<void> {
    try {
      const state = await this.refreshCompletion(pilot);
      const mapId = state?.mapId ?? stop.map;
      const areaId = state?.areaId ?? null;
      const region = state?.world === true ? (state.region?.grid ?? null) : null;
      const mapName = state === null ? `地图 ${stop.map}` : this.completionWhere(state);
      await this.backlog.add({
        mapId,
        areaId,
        region,
        mapName,
        missing: [stop.label],
        reason: "倒计时不够，路线跳过了它",
      });
      this.leaveNotice = `倒计时不够，跳过「${stop.label}」并记了欠账。`;
    } catch {
      // A failed backlog write must not turn a successful walk into a failed route.
    }
  }

  private async toolExplore(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const options = this.travelOptions(args);
    return await this.withWalkLabel("explore", () =>
      this.withFlee(args, async () => {
        const result = await travel.explore(pilot, {
          atlas: this.atlas,
          moveState: this.moveState,
          collisions: this.collisions,
          limits: {
            maxHops: this.travelMaxHops,
            maxMinutes: this.travelMaxMinutes,
          },
          guard: options.guard,
          lookAround: async (runner) => (await this.toolLookAround(runner)).text,
        });
        return { text: result.text, early: true };
      }),
    );
  }

  /**
   * Task 68 + 128: bestiary numbers this map's leave check may ignore. That is an already lost
   * monster, one a low-probability grind deferred for this exact place, and one that can be
   * found again (knowledge's encounter rows name a map other than this one) or that lives in a
   * normal, revisitable map. Only a deadline or a monster exclusive to a one-time place still
   * blocks. Knowledge wins over completion.ts's guide-only status when the two disagree.
   */
  private excusedBestiary(
    state: import("./completion.ts").CompletionState,
    knowledge: Knowledge | null,
  ): Set<number> {
    const numbers = new Set<number>();
    for (const monster of state.monsters.missing) {
      if (monster.number === null) continue;
      if (monster.lost) {
        numbers.add(monster.number);
        continue;
      }
      const elsewhere =
        knowledge === null ? null : this.monsterElsewhere(knowledge, state, monster.number);
      if (elsewhere === true) {
        numbers.add(monster.number);
        continue;
      }
      if (monster.missable === null && !state.oneTime) numbers.add(monster.number);
    }
    const region = state.world ? (state.region?.grid ?? null) : null;
    for (const entry of this.backlog.pending()) {
      if (entry.mapId !== state.mapId || entry.areaId !== state.areaId || entry.region !== region) {
        continue;
      }
      for (const number of entry.bestiary) numbers.add(number);
    }
    return numbers;
  }

  /**
   * Task 128: whether the game files put this bestiary number on any map other than the current
   * one. Null means the knowledge module has no encounter rows for it, so the caller stays
   * conservative. World regions are counted by encounter-area id: a monster in more than one
   * region can be met again later.
   */
  private monsterElsewhere(
    knowledge: Knowledge,
    state: import("./completion.ts").CompletionState,
    number: number,
  ): boolean | null {
    const monsters = knowledge.monsters.filter((monster) => monster.bookId === number);
    const groups = monsters.flatMap((monster) => monster.encounters);
    if (groups.length === 0) return null;
    if (state.world) {
      const areas = new Set(
        groups.flatMap((group) => (group.encounterAreaId === null ? [] : [group.encounterAreaId])),
      );
      return areas.size > 1;
    }
    return groups.some((group) => {
      const maps =
        group.mapIds.length > 0 ? group.mapIds : group.mapId === null ? [] : [group.mapId];
      return maps.some((mapId) => mapId !== state.mapId);
    });
  }

  /** Task 128: the one-line reminder for monsters that will appear again. */
  private laterBestiaryNote(
    state: import("./completion.ts").CompletionState,
    excused: ReadonlySet<number>,
  ): string {
    const region = state.world ? (state.region?.grid ?? null) : null;
    const deferred = new Set(
      this.backlog
        .pending()
        .filter(
          (entry) =>
            entry.mapId === state.mapId && entry.areaId === state.areaId && entry.region === region,
        )
        .flatMap((entry) => entry.bestiary),
    );
    const later = state.monsters.missing.filter(
      (monster) =>
        monster.number !== null &&
        excused.has(monster.number) &&
        !monster.lost &&
        !deferred.has(monster.number),
    );
    if (later.length === 0) return "";
    return (
      `另有 ${later.length} 种以后还会出现的怪，不拦离开，也不记欠账：` +
      later.map((monster) => monster.name).join("、")
    );
  }

  private completionWhere(state: import("./completion.ts").CompletionState): string {
    // Task 128: 11-11 Tycoon's meteor (189) reported areaType 0, so state.world alone called it
    // the world map. Only the real world map (map 1) may use the encounter-region label.
    if (state.world && state.mapId !== 1) {
      return state.mapName === "" ? `地图 ${state.mapId ?? "?"}` : state.mapName;
    }
    return whereOf(state);
  }

  /**
   * Task 69: whether the goal is on another world-map encounter grid. Null when either grid
   * cannot be read (an old bridge or a failed query), so isLeaving can use the old rectangle.
   */
  private async worldGridOutside(
    state: import("./completion.ts").CompletionState,
    pilot: Pilot,
    goal: Cell,
  ): Promise<boolean | null> {
    if (!state.world) return null;
    let current = state.region?.grid ?? null;
    if (current === null) {
      let pos;
      try {
        pos = parsePositionReply(await pilot.send("pos"));
      } catch {
        return null;
      }
      if (pos.cell === null) return null;
      current = await this.worldGridAt(pilot, pos.map, pos.cell, null);
    }
    const target = await this.worldGridAt(pilot, state.mapId, goal, null);
    if (current === null || target === null) return null;
    return target !== current;
  }

  /** Does this goal cross an exit, or leave the current world-map region/grid? */
  private isLeaving(
    state: import("./completion.ts").CompletionState,
    goal: Cell,
    gridOutside: boolean | null = null,
  ): boolean {
    if (gridOutside === true) return true;
    // Task 69: the rectangle is only a fallback; a known grid number wins over a stale range.
    if (gridOutside === null && state.world && state.region !== null) {
      const start = state.region.start;
      const end = state.region.end;
      const outside =
        start === null ||
        end === null ||
        goal[0] < start[0] ||
        goal[0] > end[0] ||
        goal[1] < start[1] ||
        goal[1] > end[1];
      if (outside) return true;
    }
    return state.exits.some((cell) => cell[0] === goal[0] && cell[1] === goal[1]);
  }

  private storyEventAt(
    state: import("./completion.ts").CompletionState,
    goal: Cell,
  ): { readonly label: string } | null {
    const found = state.storyEvents.find(
      (event) => event.cell[0] === goal[0] && event.cell[1] === goal[1],
    );
    return found === undefined ? null : { label: found.label };
  }

  private async goCell(args: Json, pilot: Pilot, goal: Cell): Promise<HandlerResult> {
    return await this.withFlee(args, async () => {
      const help = await screens.dismissFieldHelp(pilot);
      if (help === "stuck") return { text: screens.FIELD_HELP_STUCK, early: true };
      const legs = help === "closed" ? ["关掉了操作提示"] : [];
      const [startMap] = await travel.currentMapAndCell(pilot);
      const refusal = await this.guardLeave(args, pilot, goal);
      if (refusal !== null) return refusal;
      let message: string;
      if ((await move.flying(pilot)) && (await this.worldEntrance(pilot, goal))) {
        [, message] = await move.flyIn(pilot, this.moveState, goal, (line) => legs.push(line));
      } else {
        // Task 58: a ship is read from the field, so the model no longer fills by_ship; when
        // the sample cannot be read the optional argument is the fallback.
        let ship = truthy(args.by_ship);
        const ride = await travel.rideState(pilot);
        if (ride !== "") ship = ride === "Ship";
        // 11-09: an exit may be in another region of this map (Walse Castle 54). Leave and
        // re-enter through a landing that reaches it, or say which landings would.
        const detour = await travel.detourToCell(
          pilot,
          {
            atlas: this.atlas,
            moveState: this.moveState,
            collisions: this.collisions,
          },
          goal,
          (line) => legs.push(line),
          this.travelOptions(args),
        );
        if (detour !== null) {
          legs.push(detour);
          return { text: legs.join("\n") };
        }
        [, message] = await move.navigate(
          pilot,
          goal,
          ship,
          (line) => legs.push(line),
          8,
          this.moveState,
        );
      }
      const named = startMap === null ? null : travel.namedExitAt(this.atlas, startMap, goal);
      const lines = [...legs, message];
      if (named !== null) {
        lines.push(
          `(这一格是去地图 ${named.to}「${named.name}」的出口，下次可以写 go(to=${named.to}))`,
        );
      }
      return { text: lines.join("\n") };
    });
  }

  private async toolTerrain(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const raw = truthy(args.radius) ? args.radius : 12;
    const radius = Math.max(4, Math.min(24, integer(raw)));
    const cells = (await pilot.send("cells", { r: radius })).cells;
    if (truthy(cells)) {
      const grid = gridOf(record(cells));
      if (nav.hasTerrain(grid)) return { text: renderTerrain(grid) };
    }
    return { text: await this.floor(pilot, radius) };
  }

  private async toolEntrances(pilot: Pilot): Promise<HandlerResult> {
    const mapId = record((await pilot.send("pos")).pos).map;
    const found = (await pilot.send("entities", { kind: "GotoMap", max: 300 })).entities;
    const parts: string[] = [];
    if (truthy(found)) parts.push(view.describeEntities(found));
    const gimmicks = await this.mechanismEntities(pilot);
    const lines = view.describeMechanisms(gimmicks, this.atlas.moves(mapId));
    if (lines !== "") parts.push(lines);
    return { text: parts.join("\n") || "这里读不到入口" };
  }

  /**
   * ToLayer, OpenTrigger, TileAnimRegion and PointIn entities, plus the map's other groups
   * through `kind: "All"` (0.13.5). The all-query is how a hole or timed floor that the
   * current group does not hold still reaches look_around.
   */
  private async mechanismEntities(pilot: Pilot): Promise<Json[]> {
    const found: Json[] = [];
    const known = new Set(["ToLayer", "OpenTrigger", "TileAnimRegion", "PointIn"]);
    for (const kind of known) {
      const reply = record((await pilot.send("entities", { kind, max: 200 })).entities);
      found.push(...records(reply.entities));
    }
    const all = record((await pilot.send("entities", { kind: "All", max: 400 })).entities);
    for (const entity of records(all.entities)) {
      if (!known.has(text(entity.kind) ?? "")) found.push(entity);
    }
    return found;
  }

  private async toolLookAround(pilot: Pilot): Promise<HandlerResult> {
    const parts: string[] = [];
    const mapId = record((await pilot.send("pos")).pos).map;
    const exits = (await pilot.send("entities", { kind: "Event", max: 200 })).entities;
    const events = records(record(exits).entities);
    const out = events.filter((entity) => (text(entity.name) ?? "").includes(WORLD_EXIT));
    if (out.length > 0) {
      parts.push(
        out
          .map((entity) => `  出口 @ ${show(entity.cell)} 通往世界地图(事件点,走上去就出去)`)
          .join("\n"),
      );
    }
    // Conveyors and other named events are open floor in the collision data: without this
    // list the model walks onto them blind (10-27: the Fire-Powered Ship, 流される①/②).
    const named = events.filter((entity) => {
      const name = text(entity.name) ?? "";
      return name !== "" && !name.includes(WORLD_EXIT);
    });
    const eventLines = view.describeEvents(named);
    if (eventLines !== "") parts.push(eventLines);
    const gimmicks = await this.mechanismEntities(pilot);
    const gimmickLines = view.describeMechanisms(gimmicks, this.atlas.moves(mapId));
    if (gimmickLines !== "") parts.push(gimmickLines);
    for (const kind of ["GotoMap", "TresureBox", "Npc", "DefaultEntity", "DefaultAnimEntity"]) {
      let found = (await pilot.send("entities", { kind, max: 60 })).entities;
      if (found && (kind === "DefaultEntity" || kind === "DefaultAnimEntity")) {
        found = view.namedObjects(found);
      }
      if (found && list(record(found).entities).length > 0) {
        let lines = view.describeEntities(found).split("\n").slice(1);
        if (kind === "GotoMap") {
          lines = lines.map((line, index) => {
            const entity = records(record(found).entities)[index];
            return entity && "toMap" in entity ? line + this.atlas.mark(entity.toMap) : line;
          });
        }
        if (kind === "Npc") {
          // A RelayInteraction beside an NPC is a counter: shopkeepers and innkeepers stand
          // behind one (10-27: in Karnak the player tried every NPC before the old man at
          // the counter turned out to be the item shop).
          const counters = records(
            record(
              (
                await pilot.send("entities", {
                  kind: "RelayInteraction",
                  max: 60,
                })
              ).entities,
            ).entities,
          ).flatMap((entity) => {
            const cell = list(entity.cell);
            return typeof cell[0] === "number" && typeof cell[1] === "number"
              ? [[cell[0], cell[1]] as const]
              : [];
          });
          lines = lines.map((line, index) => {
            const npc = list(records(record(found).entities)[index]?.cell);
            const [x, y] = [npc[0], npc[1]];
            const behind =
              typeof x === "number" &&
              typeof y === "number" &&
              counters.some(([cx, cy]) => Math.abs(cx - x) + Math.abs(cy - y) === 1);
            return behind ? `${line}(在柜台后，多半是店员;interact 会隔着柜台说话)` : line;
          });
        }
        parts.push(lines.join("\n"));
      }
    }
    const links = this.atlas.links(mapId);
    if (links !== "") parts.push(`走法 ${links}`);
    try {
      const encounters = parseEncounters(await pilot.query("encounters"));
      const regions = encounters?.regions ?? [];
      if (regions.length > 0) {
        parts.push("世界地图各区域会出的怪:\n" + regionLines(regions).join("\n"));
      }
    } catch {
      // The rest of look_around is still useful without the region list.
    }
    return { text: parts.join("\n") || "附近没有入口、宝箱、NPC 或物体" };
  }

  private async toolInteract(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const goal: Cell = [integer(args.x), integer(args.y)];
    return await this.withWalkLabel(`interact (${goal[0]}, ${goal[1]})`, async () => {
      const refusal = await this.guardLeave(args, pilot, goal);
      if (refusal !== null) return refusal;
      const [startMap] = await travel.currentMapAndCell(pilot);
      const message = await move.openAt(pilot, goal, () => undefined, this.moveState);
      await this.noteJump(pilot, message, startMap, goal);
      return { text: message };
    });
  }

  /** Task 129: page the story that stopped a walk, then report a choice/shop/boss handoff. */
  private async storyAdvance(pilot: Pilot): Promise<move.StoryAdvance> {
    const advanced = await this.toolAdvanceStory(pilot);
    const decision = await this.storyDecision(pilot);
    return { text: advanced.text, ...(decision === null ? {} : { decision }) };
  }

  private async toolAdvanceStory(pilot: Pilot): Promise<HandlerResult> {
    // FF5 is the running game: its paging stays the pilot agent's story op, but the new-game
    // FieldHelp and naming screens the op now stops on are handled before each try (10-29).
    if (this.game === "ff5") {
      return { text: await this.pilotAdvanceStory(pilot) };
    }
    const outcome = await screens.advanceStory(pilot, {
      stuckMs: this.storyStuckSeconds * 1000,
    });
    const notes = outcome.notes.length > 0 ? outcome.notes.join("\n") + "\n" : "";
    if (outcome.stop === "gameover") {
      return {
        text: notes + `游戏结束弹窗出现，停止等待。\n当前状态:${outcome.detail}`,
        early: true,
      };
    }
    if (outcome.stop === "stuck") {
      return {
        text: notes + "画面没有变化，可能是工具认不出的界面,停下不再按键。\n" + outcome.detail,
        early: true,
      };
    }
    if (outcome.stop === "fieldhelp") {
      return {
        text: notes + `${screens.FIELD_HELP_STUCK}\n当前状态:${outcome.detail}`,
        early: true,
      };
    }
    return {
      text: `${notes}翻了 ${outcome.pages} 页,停下原因:${outcome.stop}`,
    };
  }

  /**
   * FF5's story op pages by itself, but it stops on the first-visit FieldHelp and the naming
   * box; close those with the five-game helpers, then let it page again. Task 91 runs the op in
   * short slices (5 s) so a game-over popup or a frozen screen is seen within a few seconds
   * instead of waiting out the old ten-minute call.
   */
  private async pilotAdvanceStory(pilot: Pilot): Promise<string> {
    const notes: string[] = [];
    let pages = 0;
    let why: string | undefined;
    const stuckMs = this.storyStuckSeconds * 1000;
    const deadline = pilot.now() + 600_000;
    let lastKey: string | null = null;
    let since = pilot.now();
    for (let attempt = 0; attempt < 200; attempt++) {
      if (pilot.now() >= deadline) {
        why = "timeout";
        break;
      }
      const screen = await this.storyScreen(pilot);
      if (screen.gameover) {
        return [...notes, `游戏结束弹窗出现，停止等待。\n当前状态:${screen.detail}`].join("\n");
      }
      if (screen.key !== lastKey) {
        lastKey = screen.key;
        since = pilot.now();
      } else if (pilot.now() - since >= stuckMs) {
        return [...notes, `画面 ${this.storyStuckSeconds} 秒没有变化：${screen.detail}`].join("\n");
      }
      const help = await screens.dismissFieldHelp(pilot);
      if (help === "stuck") return [...notes, screens.FIELD_HELP_STUCK].join("\n");
      if (help === "closed") notes.push("关掉了操作提示");
      const named = await screens.nameFocusedField(pilot);
      if (named !== null) notes.push(named);

      const result = await pilot.send("story", { pageMs: 3000, timeout: 5_000 }, 15_000);
      pages += num(result.pages) ?? 0;
      why = text(result.stop) || text(result.error);
      // 11-02: FF5's new-game naming box opens inside an Event, so the story op stops on
      // "textinput"; confirm the name on the next try just as for state:ChangeName.
      if (why === "timeout") continue;
      if (why !== "state:ChangeName" && why !== "textinput" && why !== "state:FieldHelp") break;
    }
    const line = `翻了 ${pages} 页,停下原因:${show(why)}`;
    return notes.length > 0 ? `${notes.join("\n")}\n${line}` : line;
  }

  /** Task 91: the FF5 wait's state/dialog/scene identity, plus whether game over is open. */
  private async storyScreen(
    pilot: Pilot,
  ): Promise<{ key: string; detail: string; gameover: boolean }> {
    const pos = record((await pilot.send("pos")).pos);
    let sample: Json = {};
    try {
      sample = record((await pilot.query("sample")).sample);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // An older bridge without sample still gets the stall check from pos alone.
    }
    const dialog = record(sample.dialog);
    const line = list(dialog.lines).filter(truthy).map(show).join(" / ");
    const spoken = line === "" ? "" : `,对话「${line}」`;
    return {
      key: JSON.stringify([pos.state ?? null, pos.map ?? null, line]),
      detail: `状态 ${show(pos.state)}${spoken}`,
      gameover: record(sample.gameover).open === true,
    };
  }

  private async toolPress(args: Json, pilot: Pilot): Promise<HandlerResult> {
    // Only the five newly started games get this tool; the gamepad keys are sent through the
    // same virtual pad the other presses use (bridge 0.10.0).
    const keys = screens.pressKeys(args.keys);
    await screens.pressOnScreen(pilot, keys);
    // Early: an unrecognised screen should not run charts, hints or tactician triggers.
    return {
      text: `已按 ${keys.join("、")}\n当前状态:\n${await this.observe(pilot)}`,
      early: true,
    };
  }

  private async toolChoose(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const state = record((await pilot.send("pos")).pos).state;
    if (state === "Shop" || state === "Menu") {
      return {
        text: "现在是商店/菜单界面,不是选项。要离开就用 leave_menu。",
        early: true,
      };
    }
    const index = Math.max(0, Math.min(integer(args.index), 9));
    // Bridge 0.4.0 reports where the cursor is; older ones start from the top.
    const choice = record(record((await pilot.query("sample")).sample).choice);
    const open = Object.values(choice).find(
      (value): value is Json => isRecord(value) && truthy(value.open),
    );
    const at = open ? (num(open.cursor) ?? 0) : 0;
    const step = index >= at ? "Down" : "Up";
    const keys = [...Array.from({ length: Math.abs(index - at) }, () => step), "Enter"];
    const result = await pilot.send("keys", { keys, gap: 250 });
    return {
      text: truthy(result.ok) ? "已选择" : `没选成:${show(result.error)}`,
    };
  }

  private async toolFight(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const raw = record(args.plan);
    // Task 42: fight takes either language, like set_tactics and the tactician's own tables.
    const plan = raw.version === 2 ? raw : gambit.normalize(raw);
    const problems = raw.version === 2 ? checkStrategy(raw) : gambit.check(plan, this.game);
    if (problems.length > 0) {
      // Sent back before a key is pressed (§4.6): the battle waits for a full table.
      return {
        text: "规则表没有通过检查,请改好再交:\n" + problems.join("\n"),
        early: true,
      };
    }
    const sample = record((await pilot.query("sample")).sample);
    const fight = record(sample.battle);
    const enemies = records(fight.enemies);
    const boss = truthy(fight.boss);
    const mapId = num(record(sample.user).mapId) ?? null;
    const session = this.battles.start({
      mapId,
      mapName: placeName(sample),
      boss,
      enemies: battleUnits(enemies),
      party: battleUnits(records(sample.party)),
      table: { kind: boss ? "boss" : "manual", mapId },
      startedAt: new Date().toISOString(),
      startedMs: pilot.now(),
    });
    const result = await battle.fight(pilot, plan, 300, () => undefined, this.elements, {
      record: session,
    });
    const foughtAt = pilot.now();
    const [verdict, detail] = battle.judgePlayers(result.players);
    const outcome =
      result.error === "wiped"
        ? "wipe"
        : result.error === "timeout"
          ? "timeout"
          : verdict === "lost"
            ? "wipe"
            : verdict === "hard"
              ? "hard"
              : "ok";
    await session.finish(
      foughtAt,
      outcome,
      result.error === "wiped" ? "全员倒下" : result.error === "timeout" ? "战斗超时" : detail,
    );
    if (result.error === "wiped") {
      const report = await battle.wipeReport(pilot, battle.enemyNames(enemies), this.saveSlot);
      return {
        text: `${report};出招:${list(result.turns).map(show).join("、")}`,
      };
    }
    const done = truthy(result.ok) ? "战斗结束" : `战斗没打完:${show(result.error)}`;
    let text = `${done};出招:${list(result.turns).map(show).join("、")}`;
    if (result.learned.length > 0) text += "\n" + result.learned.join(";");
    if (truthy(result.ok)) {
      const healed = await battle.patchUp(
        pilot,
        () => undefined,
        4,
        (message) => this.onIncident?.(message),
        this.healOptions(),
      );
      if (healed.length > 0) text += "\n战后回复:" + healed.join(";");
    }
    return { text };
  }

  /**
   * Task 47: the code-driven farm loop. A missing stopping condition is refused before a key
   * is pressed; every in-game failure comes back in the report as the reason it stopped.
   */
  /** The existing grind loop's Game-side context, shared by the tool and route stops. */
  private grindContext(): grind.GrindContext {
    return {
      atlas: this.atlas,
      moveState: this.moveState,
      fighter: (runner, say) => battle.regular(runner, this.hooks, say, this.saveSlot),
      refresh: async (runner) => {
        const completion = await this.refreshCompletion(runner);
        const names = new Map<number, string>();
        for (const [name, number] of this.bestiaryNames()) {
          if (!names.has(number)) names.set(number, name);
        }
        return { completion, known: new Set(this.bestiary.numbers), names };
      },
      gridCache: this.encounterGrids,
      defer: async (monsters, reason) => {
        const state = this.lastCompletion;
        if (state === null) return;
        await this.backlog.add({
          mapId: state.mapId,
          areaId: state.areaId,
          region: state.world ? (state.region?.grid ?? null) : null,
          mapName: this.completionWhere(state),
          missing: missingLines(state),
          bestiary: monsters.flatMap((monster) =>
            monster.number === null ? [] : [monster.number],
          ),
          reason,
        });
        this.leaveNotice =
          `grind 已把 ${monsters.map((monster) => monster.name).join("、")} ` +
          "记进欠账，可以直接离开，以后回来补。";
      },
    };
  }

  /** Party abilities, used to tell whether a route grind learned the blue magic it wanted. */
  private async learnedAbilities(pilot: Pilot): Promise<Set<string> | null> {
    try {
      const sample = record((await pilot.query("sample")).sample);
      const names = readParty(sample).flatMap((member) =>
        member.abilities.map((ability) => ability.name),
      );
      return new Set(
        names.filter((name) => name.trim() !== "").map((name) => normalizeName(cleanName(name))),
      );
    } catch {
      // An old bridge without abilities: "learned" is unreadable, so the stop list falls
      // back to battles/minutes as task 100 says.
      return null;
    }
  }

  /**
   * Task 100: a `route` grind stop. It calls the existing grind loop once, but wraps its
   * refresh/fighter hooks so a named bestiary list, learned blue magic or a battle count can
   * end it. The loop itself still owns walking, resting and fighting; no logic is copied.
   */
  private async routeGrind(
    pilot: Pilot,
    stop: Waypoint,
  ): Promise<{ ok: boolean; done: boolean; text: string; decision?: string }> {
    const until = stop.until;
    if (until === undefined) {
      return { ok: false, done: false, text: "刷怪路标没有 until" };
    }
    const base = this.grindContext();
    const targets = [...(until.bestiary ?? [])];
    const blueTargets = new Set((until.blueMagic ?? []).map((name) => normalizeName(name)));
    const matchesBestiary = (monster: CompletionMonster): boolean =>
      targets.some((target) => {
        const number =
          typeof target === "number"
            ? target
            : /^\d+$/u.test(target.trim())
              ? Number(target)
              : null;
        if (number !== null) return monster.number === number;
        const name = normalizeName(monster.name);
        const wanted = normalizeName(String(target));
        return (
          name !== "" &&
          wanted !== "" &&
          (name === wanted || name.includes(wanted) || wanted.includes(name))
        );
      });
    const learnedBefore = await this.learnedAbilities(pilot);
    const learnedReadable = learnedBefore !== null;
    const learned = new Set(learnedBefore ?? []);
    let battles = 0;
    let finalCompletion: CompletionState | null = this.lastCompletion;
    let blueDone =
      learnedReadable &&
      blueTargets.size > 0 &&
      [...blueTargets].every((name) => learned.has(name));
    const placeholder: CompletionMonster = {
      number: null,
      name: "刷怪目标",
      chance: null,
      expectedBattles: null,
      missable: null,
      lost: false,
    };

    const refresh = async (runner: Pilot) => {
      const real = await base.refresh(runner);
      finalCompletion = real.completion;
      const now = await this.learnedAbilities(runner);
      if (learnedReadable && now !== null) for (const name of now) learned.add(name);
      blueDone =
        learnedReadable &&
        blueTargets.size > 0 &&
        [...blueTargets].every((name) => learned.has(name));
      const battleDone = until.battles !== undefined && battles >= until.battles;
      let missing = real.completion?.monsters.missing ?? [];
      if (targets.length > 0) missing = missing.filter(matchesBestiary);
      if (blueDone || battleDone) {
        missing = [];
      } else if (targets.length === 0) {
        // Only a blue spell or battle count is being hunted: a finished bestiary must not
        // stop the loop before that other goal. A placeholder with no chance keeps task 68's
        // budget from deferring it.
        missing = [...missing, placeholder];
      }
      const completion =
        real.completion === null
          ? null
          : {
              ...real.completion,
              monsters: {
                total: Math.max(real.completion.monsters.total, missing.length),
                missing,
              },
            };
      return { ...real, completion };
    };

    const fighter = async (runner: Pilot, say: (line: string) => void): Promise<string> => {
      const text = await base.fighter(runner, say);
      battles += 1;
      return text;
    };

    const caps: number[] = [];
    if (until.minutes !== undefined) caps.push(until.minutes);
    if (until.battles !== undefined) {
      caps.push((until.battles * this.routeBattleSeconds) / 60);
    }
    const maxMinutes = caps.length > 0 ? Math.min(...caps) : 40;
    const options: grind.GrindOptions = {
      // A forced stop (bestiary, blue magic, battles) is checked between battles; time-only
      // stops leave until_bestiary off and rely on max_minutes.
      ...(targets.length > 0 || blueTargets.size > 0 || until.battles !== undefined
        ? { untilBestiary: true }
        : {}),
      maxMinutes,
      restHpPct: 40,
      restMpPct: 25,
      bestiaryDeferBattles: this.bestiaryDeferBattles,
      bestiaryMissableMinutes: this.bestiaryMissableMinutes,
    };
    const report = await grind.grind(pilot, options, {
      ...base,
      fighter,
      refresh,
    });

    const learnedAfter = await this.learnedAbilities(pilot);
    if (learnedReadable && learnedAfter !== null) {
      for (const name of learnedAfter) learned.add(name);
    }
    const before = learnedBefore ?? new Set<string>();
    const newly =
      learnedReadable && learnedAfter !== null
        ? [...learned].filter((name) => !before.has(name))
        : [];
    const wantedBlue = new Set(
      newly.filter((name) => blueTargets.size === 0 || blueTargets.has(name)),
    );
    const gotBlue =
      learnedReadable &&
      learnedAfter !== null &&
      blueTargets.size > 0 &&
      [...blueTargets].every((name) => learned.has(name));
    const leftBestiary =
      targets.length === 0
        ? 0
        : (finalCompletion?.monsters.missing ?? []).filter(matchesBestiary).length;
    const gotBestiary = targets.length > 0 && leftBestiary === 0;
    const battleDone = until.battles !== undefined && battles >= until.battles;
    const learnedNames = [...wantedBlue].map((name) => name);
    const stopReason = gotBlue
      ? `青魔法已学会${learnedNames.length === 0 ? "" : `:${learnedNames.join("、")}`}`
      : gotBestiary
        ? `图鉴已登记:${targets.map(String).join("、")}`
        : battleDone
          ? `打满 ${until.battles ?? 0} 场`
          : report.stop;
    const parts = [
      `刷了 ${report.battles} 场`,
      report.bestiary.length === 0 ? "没有新登记" : `登记了 ${report.bestiary.join("、")}`,
      learnedNames.length === 0 ? "没学到新青魔法" : `学到 ${learnedNames.join("、")}`,
      `停:${stopReason}`,
    ];
    return { ok: true, done: true, text: parts.join("；") };
  }

  /**
   * Task 47: the code-driven farm loop. A missing stopping condition is refused before a key
   * is pressed; every in-game failure comes back in the report as the reason it stopped.
   */
  private async toolGrind(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const parsed = grind.parseGrindOptions(args);
    if (!parsed.ok) return { text: `grind 没有执行:${parsed.error}`, early: true };
    return await this.withWalkLabel("grind(刷怪)", async () => {
      const report = await grind.grind(
        pilot,
        {
          ...parsed.options,
          bestiaryDeferBattles: this.bestiaryDeferBattles,
          bestiaryMissableMinutes: this.bestiaryMissableMinutes,
        },
        this.grindContext(),
      );
      return { text: report.text };
    });
  }

  private async toolSell(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [ok, detail] = await shop.sell(pilot, String(args.item), integer(args.count || 1));
    if (ok && this.events) this.events.note("buy", detail);
    return { text: detail };
  }

  private async toolShopGear(pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await shop.gearReport(pilot);
    return { text: detail };
  }

  private async toolBuy(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [ok, detail] = await shop.buy(pilot, String(args.product), integer(args.count || 1));
    if (ok && this.events) this.events.note("buy", detail);
    return { text: detail };
  }

  private async toolCast(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await menu.cast(
      pilot,
      String(args.caster),
      String(args.spell),
      text(args.target),
    );
    return { text: detail };
  }

  private async toolUseItem(args: Json, pilot: Pilot): Promise<HandlerResult> {
    // 11-09: when the item list's cursor cannot reach the item, leave the bridge's rows and
    // keys in the activity log (kind error) so the next failure has real data.
    const [, detail] = await menu.useItem(
      pilot,
      String(args.item),
      String(args.target),
      (message) => this.onIncident?.(message),
    );
    return { text: detail };
  }

  private async toolChangeJob(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await menu.changeJob(pilot, String(args.member), String(args.job));
    return { text: detail };
  }

  private async toolLeaveMenu(pilot: Pilot): Promise<HandlerResult> {
    return { text: await menu.leaveMenu(pilot) };
  }

  private async toolSaveGame(pilot: Pilot): Promise<HandlerResult> {
    // Task 105: a scout must be able to load the save from before the dungeon; never overwrite it.
    // The window file is read too, so an interrupted scout still blocks a save after a restart.
    const windows = await this.scoutWindows();
    const refusal = scoutSaveGuard({ scouting: this.scouting, windows });
    if (refusal !== null) return { text: refusal, early: true };
    // Task 91: heal at a save point before the save, so the file keeps the restored party.
    const restored = await this.restoreAtSavePoint(pilot);
    const [ok, detail] = await save.saveGame(pilot, this.saveSlot, this.saveTimerMinSeconds);
    if (ok) await this.captureBestiary(pilot);
    return { text: restored === "" ? detail : `${restored}\n${detail}` };
  }

  /**
   * Snapshot this save's bestiary and visited maps at the current save count. Called after
   * `save_game` and by the plugin's `save.write` listener, so a save made outside the tool is
   * captured too.
   */
  async captureBestiary(pilot: Pilot): Promise<void> {
    try {
      this.lastAchievements ??= parseAchievements(await pilot.query("achievements"));
      const pos = parsePositionReply(await pilot.send("pos"));
      const previous = this.bestiary.saves;
      const records = await this.scoutFreeRecords(await this.battles.allRecords());
      const names = this.bestiaryNames();
      this.bestiary.restore(pos.saves, records, names);
      this.bestiary.observeRecords(
        await this.scoutFreeRecords(this.battles.recentRecords()),
        names,
      );
      if (pos.saves !== null && (previous === null || pos.saves > previous)) {
        await this.bestiary.snapshot(pos.saves);
      }
      // 11-05: restore may have moved the count before the snapshot existed, so ask the file
      // whether this count already has one instead of comparing with the previous count.
      if (pos.saves !== null && this.atlasSave.snapshotFor(pos.saves) === null) {
        await this.atlasSave.snapshot(pos.saves);
      }
    } catch {
      // The save itself succeeded; a failed snapshot is retried on the next save.
    }
  }

  private async toolLand(pilot: Pilot): Promise<HandlerResult> {
    return await this.withWalkLabel("land(降落)", async () => {
      const [, detail] = await move.land(pilot, this.moveState, null, () => undefined);
      return { text: detail };
    });
  }

  private async toolBoard(pilot: Pilot): Promise<HandlerResult> {
    return await this.withWalkLabel("board(骑飞龙)", async () => {
      const [, detail] = await move.board(pilot, this.moveState, () => undefined);
      return { text: detail };
    });
  }

  /** Overridable in tests, as Python monkeypatches menu.optimize_equipment. */
  async optimizeEquipment(pilot: Pilot): Promise<[boolean, string]> {
    return menu.optimizeEquipment(pilot);
  }

  private async toolOptimizeEquipment(pilot: Pilot): Promise<HandlerResult> {
    const [ok, detail] = await this.optimizeEquipment(pilot);
    if (ok && this.events) this.events.note("equip", detail);
    return { text: detail };
  }

  private async toolSetTactics(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const tables: Json[] = [];
    const problems: string[] = [];
    const raw = list(args.tables).filter((table) => truthy(table));
    raw.forEach((table, index) => {
      const label = `第 ${index + 1} 套:`;
      if (!isRecord(table)) {
        problems.push(`${label}要写成 JSON 对象`);
        return;
      }
      // Task 41: both languages are accepted. A version 2 strategy is stored as written so
      // the executor can use its reactions/phases; an old {角色: [规则…]} table is normalized.
      if (table.version === 2) {
        const bad = checkStrategy(table);
        if (bad.length > 0) problems.push(...bad.map((problem) => `${label}${problem}`));
        else tables.push(table);
        return;
      }
      const normalized = gambit.normalize(table);
      const bad = gambit.check(normalized, this.game);
      if (bad.length > 0) problems.push(...bad.map((problem) => `${label}${problem}`));
      else tables.push(normalized);
    });
    if (tables.length === 0 || problems.length > 0) {
      return {
        text: "策略没有通过检查,请改好再交:\n" + (problems.join("\n") || "至少要一套"),
        early: true,
      };
    }
    const mapId = args.map || record((await pilot.send("pos")).pos).map;
    const id = integer(mapId);
    const met = [...(this.events?.enemies.get(id) ?? new Set<string>())].sort();
    let roster: ReturnType<typeof partySnapshot> | undefined;
    try {
      const sample = record((await pilot.query("sample")).sample);
      roster = partySnapshot(readParty(sample));
    } catch {
      // Older bridges or tests without a sample still store the table; the party-changed
      // check then has no snapshot and simply waits for the next tactician call.
    }
    await this.tactics.setPlayer(id, tables, met, roster);
    return {
      text:
        `已为地图 ${id} 设好 ${tables.length} 套战斗策略;` +
        "普通战斗先用第 1 套,打得不好会自动换下一套;" +
        "在离开这张图之前，战术官不会覆盖这张表。",
    };
  }

  private toolGuide(args: Json): Promise<HandlerResult> {
    if (this.guide === null) return Promise.resolve({ text: EARLY_GUIDE, early: true });
    const query = String(truthy(args.query) ? args.query : "");
    const kind = String(truthy(args.kind) ? args.kind : "area");
    const part = integer(args.part || 1);
    const found = this.guide.lookup(query, part, kind);
    return Promise.resolve({
      text: found || `攻略里没有找到「${query}」;换个说法(英文名、地区名或图鉴编号)再查`,
      early: true,
    });
  }

  private async toolAtlas(pilot: Pilot): Promise<HandlerResult> {
    return { text: this.atlas.describe(await this.chart(pilot)) };
  }

  private async toolInventory(pilot: Pilot): Promise<HandlerResult> {
    return {
      text: view.describeItems(record((await pilot.query("items")).items)),
    };
  }

  private async toolRemember(args: Json): Promise<HandlerResult> {
    this.notes = [...this.notes, String(args.note)].slice(-MAX_NOTES);
    await saveNotes(this.notesFile, this.notes);
    return { text: `已记下(第 ${this.notes.length} 条)`, early: true };
  }

  private async toolForget(args: Json): Promise<HandlerResult> {
    const index = integer(args.index) - 1;
    if (!(index >= 0 && index < this.notes.length)) {
      return { text: `没有第 ${index + 1} 条笔记`, early: true };
    }
    const removed = this.notes.splice(index, 1)[0] ?? "";
    await saveNotes(this.notesFile, this.notes);
    return { text: `已删除:${removed}`, early: true };
  }
}

/** The battle-form ids of the living enemies (the bridge sends 281/282 for one Wing Raptor). */
function enemyIds(rows: readonly Json[]): number[] {
  const ids: number[] = [];
  for (const row of rows) {
    if ((num(row.hp) ?? 0) <= 0) continue;
    const id = num(row.id);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function enemyHp(rows: readonly Json[]): number {
  return rows.reduce((sum, row) => sum + (num(row.hp) ?? 0), 0);
}

/** The party's total HP and max HP, for the "lost over half in one round" rewrite trigger. */
function partyHp(rows: readonly Json[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, num(row.hp) ?? 0), 0);
}

function partyMaxHp(rows: readonly Json[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, num(row.maxHp) ?? 0), 0);
}

/** The boss's HP, or every enemy's when the bridge does not mark the boss flag. */
function bossHp(rows: readonly Json[]): number {
  const bosses = rows.filter((row) => truthy(row.boss));
  return enemyHp(bosses.length > 0 ? bosses : rows);
}

/** An action meant to hurt an enemy; 防御, items and 换列 do not count for "no damage". */
function isAttackTurn(turn: battle.FightTurn): boolean {
  return turn.target === gambit.ENEMY && !["防御", "道具", "换列"].includes(turn.command);
}

/** 「巴兹→攻击→首领(敌人 HP -40)」 for the rewrite fact sheet. */
function turnEffect(turn: battle.FightTurn): string {
  const enemyDelta = enemyHp(turn.afterEnemies) - enemyHp(turn.beforeEnemies);
  const partyDelta = enemyHp(turn.afterPlayers) - enemyHp(turn.beforePlayers);
  const notes: string[] = [];
  if (enemyDelta !== 0) notes.push(`敌人 HP ${signed(enemyDelta)}`);
  if (partyDelta !== 0) notes.push(`我方 HP ${signed(partyDelta)}`);
  return (
    `${turn.actor}→${turn.done}` + `(${notes.length > 0 ? notes.join(",") : "没有看到 HP 变化"})`
  );
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** A new table's key rules in one line: 「巴兹:enemy.id.282 >= 1 防御/攻击」. */
function tableSummary(table: Json): string {
  return Object.entries(gambit.normalize(table))
    .map(([actor, rules]) => `${actor}:${rules.map(ruleSummary).join("/")}`)
    .join("、");
}

function ruleSummary(rule: unknown): string {
  const row = isRecord(rule) ? rule : {};
  const condition = typeof row.if === "string" && row.if.trim() !== "" ? `${row.if.trim()} ` : "";
  const action = typeof row.do === "string" && row.do !== "" ? row.do : "攻击";
  return `${condition}${action}`;
}

/** The tool result's 「中途重新写表」 paragraph. */
function rewriteText(
  rewrites: readonly { reason: string; ok: boolean; summary: string }[],
): string {
  return (
    `中途重新写表 ${rewrites.length} 次:` +
    rewrites
      .map(
        (rewrite, index) =>
          `第 ${index + 1} 次(${rewrite.reason}):` +
          (rewrite.ok ? "成功" : "没有换成") +
          `,${rewrite.summary}`,
      )
      .join(";")
  );
}

/** Cancellation is dsh's, not a tactician failure: let it reach the tool boundary. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** How many of `item` the stage bag holds, exact name only (the officer chose the name). */
function stageBagCount(bag: StageFacts["bag"], item: string): number {
  let total = 0;
  for (const row of bag) {
    if (row.name === item) total += Math.max(0, row.count);
  }
  return total;
}

/** A shop kind as the first layer names it; unknown kinds are an item shop by default. */
function shopKindLabel(kind: string | null | undefined): string {
  const key = (kind ?? "").toLowerCase();
  if (kind === "武器" || key.includes("weapon")) return "武器屋";
  if (kind === "防具" || key.includes("armor")) return "防具屋";
  if (kind === "魔法" || key.includes("magic")) return "魔法屋";
  return "道具屋";
}

/** The route analyzer's walking distance in cells, or Infinity when the point is unreachable. */
function stageDistance(
  atlas: Atlas,
  collisions: CollisionStore,
  fromMap: number,
  fromCell: Cell,
  waypoint: Waypoint,
): number {
  if (waypoint.cell !== null && waypoint.map === fromMap) {
    if (matchesCell(waypoint.cell, fromCell)) return 0;
  }
  if (waypoint.cell === null) return Number.POSITIVE_INFINITY;
  const plan = analyzeRoute(
    {
      start: { map: fromMap, cell: [fromCell[0], fromCell[1]] },
      end: { map: waypoint.map, cell: waypoint.cell },
      waypoints: [],
    },
    { atlas, collisions },
  );
  return plan.legs.some((leg) => leg.waypoint === "end")
    ? plan.total.cells
    : Number.POSITIVE_INFINITY;
}

/** What makes a tactician table unusable, numbered by table (1-based). */
export function tacticianProblems(
  tables: readonly Json[],
  game = "ff5",
  party?: readonly unknown[],
): string[] {
  const problems: string[] = [];
  if (tables.length === 0) problems.push("一套规则表都没有");
  if (tables.length > 3) problems.push(`最多 3 套,这次交了 ${tables.length} 套`);
  for (const [index, table] of tables.entries()) {
    const bad = tableProblems(table, game, party);
    problems.push(...bad.map((problem) => `第 ${index + 1} 套:${problem}`));
  }
  return problems;
}

/** Shape checks for either language: 2.0 through checkStrategy, old through gambit.check. */
function tableProblems(table: Json, game: string, party?: readonly unknown[]): string[] {
  if (isRecord(table) && table.version === 2) return checkStrategy(table, party);
  return gambit.check(table, game);
}

function tablePasses(table: Json, game: string, party: readonly unknown[]): boolean {
  return tableProblems(table, game, party).length === 0;
}

/** A cells reply narrowed to the grid nav and prompt renderers take. */
function gridOf(cells: Json): nav.CellGrid {
  const origin = cellOf(cells.origin);
  const center = cellOf(cells.center);
  if (origin === null || center === null || !Array.isArray(cells.attr)) {
    throw new Error("cells 回复不是地图格子");
  }
  const attr: nav.CellValue[][] = [];
  for (const row of cells.attr) {
    if (!Array.isArray(row)) throw new Error("cells 回复的 attr 不是二维数组");
    attr.push(row.map((value) => (typeof value === "number" ? value : null)));
  }
  return { origin, center, attr };
}

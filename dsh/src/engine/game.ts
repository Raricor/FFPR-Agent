/**
 * The tool side of the DeepSeek player: runs each tool through the skills and describes what
 * the player sees afterwards. Notes the model keeps survive between runs. Ported from
 * ffpr_agent/ds/game.py; control plan §4.8–§4.11 and §10.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Laptop } from "./laptop.ts";
import { MonsterCache, monsterStatus } from "./bestiary.ts";
import { MonsterAiCache, monsterAiPath, partySnapshot, readBag, readParty } from "./dossier.ts";
import { BestiarySave } from "./bestiary-save.ts";
import { missedTreasureByArea, parseAchievements, progressRows } from "./achievements.ts";
import {
  Backlog,
  Incidents,
  backlogLines,
  completionLine,
  completionState,
  incidentLines,
  isComplete,
  missingLines,
  regionLabel,
  regionLines,
  timedLine,
  type EncounterStatus,
} from "./completion.ts";
import { activeParties, encounterMonsters, parseEncounters } from "./encounters.ts";
import type { EncounterTable } from "./encounters.ts";
import { parsePositionReply } from "./position.ts";
import { profileFor } from "./profiles/index.ts";
import { Atlas } from "./atlas.ts";
import { AtlasSave } from "./atlas-save.ts";
import { BattleLog, battleUnits, gapText, type BattleGap } from "./battle-record.ts";
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
  type TacticianPlan,
} from "./facts.ts";
import { describeError, isMissingFile } from "./errors.ts";
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
import * as screens from "./skills/screens.ts";
import * as shop from "./skills/shop.ts";
import * as grind from "./skills/grind.ts";
import * as travel from "./skills/travel.ts";
import { cursorPath, stateScript, parseState } from "./state-script.ts";
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
  readonly tactician?: (facts: string) => Promise<TacticianPlan>;
  /** Let the tactician write and the code fight a boss battle (default true). */
  readonly tacticianBoss?: boolean;
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
}

interface HandlerResult {
  readonly text: string;
  /** The Python handler returned before settle/chart/hints (remember, guide, refusals). */
  readonly early?: boolean;
}

type ToolHandler = (args: Json, pilot: Pilot) => Promise<HandlerResult>;

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

/**
 * Task 58/66: `go`'s `to` may be a cell as [x, y] or as a string such as "x,y", "x y",
 * "[x, y]" or "(x, y)"; anything else is a map. The sign stays optional as before.
 */
function targetCell(value: unknown): Cell | null {
  const cell = cellOf(value);
  if (cell !== null) return cell;
  if (typeof value !== "string") return null;
  const trimmed = value
    .trim()
    .replace(/^[[(]\s*/u, "")
    .replace(/\s*[\])]$/u, "");
  const match = /^(-?\d+)\s*(?:,|\s)\s*(-?\d+)$/u.exec(trimmed);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
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
    throw new Error(`写不了笔记文件 ${path}:${describeError(error)}`, { cause: error });
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
  readonly advised = new Set<string>();
  readonly moveState: MoveState = { drake: null };
  readonly hooks: BattleHooks;
  /** Static monster data shared by the fact sheet and the strategy page. */
  readonly monsterCache = new MonsterCache();
  notes: string[] = [];
  savePoint: Cell | null = null; // on the current map, if it has one
  gear: Record<string, number> | null = null; // weapons and armour in the bag, last look
  mapId: number | null = null;
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
  private tactician: ((facts: string) => Promise<TacticianPlan>) | undefined;
  private tacticianCalled = false; // one call per tool invocation (task 10)
  private readonly blockedCounts = new Map<string, number>(); // map+cell → times blocked
  private blocked: { count: number; detail: string } | null = null;
  private ride: string | null = null;
  private lastBattle: { mapId: number | null; verdict: string; detail: string } | null = null;
  private lastBoss: BossPlanRecord | null = null;
  private readonly tacticianInfoByMap = new Map<number, { walkerNotes: string; askUp: string }>();
  private readonly handlers: ReadonlyMap<string, ToolHandler>;
  private lastCompletion: import("./completion.ts").CompletionState | null = null;
  private lastAchievements: import("./achievements.ts").AchievementsData | null = null;
  private lastCompletionAt = 0;
  private leaveNotice: string | null = null;
  private readonly timedSeen = new Set<string>();

  private constructor(
    laptop: Laptop,
    game: string,
    saveSlot: number,
    notesFile: string | undefined,
    events: KeyEvents | undefined,
    atlas: Atlas,
    atlasSave: AtlasSave,
    tactics: Tactics,
    elements: Elements,
    battles: BattleLog,
    guide: Guide | null,
    tacticianLog: TacticianLog,
    backlog: Backlog,
    incidents: Incidents,
    bestiary: BestiarySave,
    monsterAi: MonsterAiCache,
    tactician: ((facts: string) => Promise<TacticianPlan>) | undefined,
    tacticianBoss: boolean,
    travelMaxHops: number,
    travelMaxMinutes: number,
    bestiaryDeferBattles: number,
    bestiaryMissableMinutes: number,
  ) {
    this.laptop = laptop;
    this.game = game;
    this.saveSlot = saveSlot;
    this.notesFile = notesFile;
    this.events = events;
    this.atlas = atlas;
    this.atlasSave = atlasSave;
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
    this.travelMaxHops = travelMaxHops;
    this.travelMaxMinutes = travelMaxMinutes;
    this.bestiaryDeferBattles = bestiaryDeferBattles;
    this.bestiaryMissableMinutes = bestiaryMissableMinutes;
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
      elements: this.elements,
    };
    this.moveState.game = this.game;
    this.moveState.battle = this.hooks;
    this.moveState.saveSlot = this.saveSlot;
    this.moveState.link = (mapId, from, to, how, detail) =>
      this.atlas.link(mapId, from, to, how, detail);
    this.moveState.moves = (mapId) => this.atlas.moves(mapId);
    this.handlers = new Map<string, ToolHandler>([
      ["go", (args, pilot) => this.toolGo(args, pilot)],
      ["explore", (args, pilot) => this.toolExplore(args, pilot)],
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
    ]);
  }

  static async create(options: GameOptions): Promise<Game> {
    const signal = options.signal;
    const game = byKey(options.game).key;
    const atlas = await Atlas.load(options.atlasFile, signal);
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
    const tacticianLog = await TacticianLog.load({ file: options.tacticianFile });
    const backlog = await Backlog.load(options.backlogFile, signal);
    const incidents = await Incidents.load(
      options.incidentsFile,
      options.incidentsStateFile,
      signal,
    );
    const bestiary = await BestiarySave.load(game, options.bestiarySaveFile, signal);
    const aiFile = options.monsterAiFile ?? (game === "ff5" ? monsterAiPath(game) : undefined);
    const monsterAi = await MonsterAiCache.load(game, aiFile, signal);
    const created = new Game(
      options.laptop,
      game,
      options.saveSlot,
      options.notesFile,
      options.events,
      atlas,
      atlasSave,
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
      options.travelMaxHops ?? travel.DEFAULT_TRAVEL_MAX_HOPS,
      options.travelMaxMinutes ?? travel.DEFAULT_TRAVEL_MAX_MINUTES,
      options.bestiaryDeferBattles ?? grind.DEFAULT_BESTIARY_DEFER_BATTLES,
      options.bestiaryMissableMinutes ?? grind.DEFAULT_BESTIARY_MISSABLE_MINUTES,
    );
    created.moveState.walkpathTimeoutMs = options.walkpathTimeoutMs;
    created.moveState.walkpathBlockedMs = options.walkpathBlockedMs;
    created.moveState.walkpathTurnLead = options.walkpathTurnLead;
    created.moveState.walkpathEventPollMs = options.walkpathEventPollMs;
    created.moveState.walkpathEventWaitMs = options.walkpathEventWaitMs;
    created.notes =
      options.notesFile === undefined ? [] : await loadNotes(options.notesFile, signal);
    // A web restart must still show the boss table and walker notes the tactician wrote.
    created.lastBoss = tactics.lastBoss();
    return created;
  }

  /** Install the second layer after the plugin has built its tool-call binding. */
  setTactician(tactician: ((facts: string) => Promise<TacticianPlan>) | undefined): void {
    this.tactician = tactician;
  }

  /** The current walking view, or null before this run has walked (task 61). */
  walkView(): WalkView | null {
    return this.moveState.walk ?? null;
  }

  /** Any map's walker notes and advice, for the strategy page. */
  tacticianInfoFor(
    mapId: number,
  ): { mapId: number; walkerNotes: string; askUp: string; writtenAt?: string } | null {
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
      const prepared = boss?.prepared === true;
      let table: Json;
      let startText: string;
      if (boss !== null) {
        table = boss.table;
        startText = prepared
          ? `用首领战前写好的表(地图 ${mapId})`
          : `开打时用的是这张图上次的首领表(地图 ${mapId})`;
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
          battle: { ...fight, enemies: watch.latestEnemies, players: watch.latestPlayers },
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
        const healed = await battle.patchUp(pilot, () => undefined);
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
   * Call the second layer once for this tool invocation, retrying at most twice when the
   * returned tables do not pass gambit.check. Tables that do pass are installed; the text
   * always says what happened, even when nothing usable came back (task 10).
   */
  private async runTactician(
    trigger: FactsTrigger,
    install: boolean,
    givenFacts?: string,
  ): Promise<{ text: string; tables: Json[]; facts: string }> {
    this.tacticianCalled = true;
    if (this.tactician === undefined) return { text: "", tables: [], facts: givenFacts ?? "" };
    let facts: string;
    try {
      facts = givenFacts ?? (await buildFacts(this, trigger));
    } catch (error) {
      if (isAbortError(error)) throw error;
      const text = `战术官没有叫成:${describeError(error)}`;
      await this.recordTacticianCall(trigger, 0, [text], "");
      return { text, tables: [], facts: givenFacts ?? "" };
    }
    // Task 42: the coverage check reads the party, the bag and the enemy dossier, not just
    // the table's shape. A failed read leaves empty data; the shape check still runs.
    const sample = record((await trigger.pilot.query("sample")).sample);
    const party = readParty(sample);
    const bag = readBag(await battle.heldItems(trigger.pilot));
    const dossier = await dossierForTrigger(this, trigger);
    let plan: TacticianPlan | null = null;
    let problems: string[] = [];
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        plan = await this.tactician(facts);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const text = `战术官没有回答:${describeError(error)}`;
        await this.recordTacticianCall(trigger, 0, [text], "");
        return { text, tables: [], facts };
      }
      problems = [
        ...tacticianProblems(plan.tables, this.game, party),
        ...coverageProblems({ tables: plan.tables, party, bag, dossier }),
      ];
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
    const good = plan.tables.filter((table) => tablePasses(table, this.game, party)).slice(0, 3);
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
        (good.length > 0 ? `;先装上能通过的 ${good.length} 套` : ";这次没有可用的规则表");
    }
    if (install && good.length > 0) {
      const met = [...(this.events?.enemies.get(trigger.mapId) ?? new Set<string>())].sort();
      await this.tactics.set(trigger.mapId, good, met, note, partySnapshot(party));
    } else if (this.tactics.maps.has(String(trigger.mapId))) {
      // A boss rewrite has no new regular table, but its walker notes still belong to the map.
      // Creating an empty table entry here would change the boss flow's own bookkeeping.
      await this.tactics.setNote(trigger.mapId, note);
    }
    await this.recordTacticianCall(trigger, good.length, problems, plan.walkerNotes);
    return { text, tables: good, facts };
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

  private async afterTool(pilot: Pilot): Promise<string> {
    if (this.tactician === undefined || this.tacticianCalled) return "";
    const mapId = this.mapId;
    if (mapId !== null) {
      // Task 42: before the map's next battle, check the table against the party as it is now.
      const table = this.tactics.current(mapId);
      if (table !== null) {
        const sample = await this.sampleNow(pilot);
        const changed = partyChangedProblem(table, readParty(sample), this.tactics.party(mapId));
        if (changed.length > 0) {
          this.lastBattle = null;
          const outcome = await this.runTactician(
            {
              kind: "party-changed",
              mapId,
              detail: changed.join(";"),
              pilot,
            },
            true,
          );
          return outcome.text;
        }
      }
      // Task 42: the guide marks a boss on this map (or look_around named one): write its
      // table once, before the fight, and keep it for the battle that starts by itself.
      if (this.tactics.boss(mapId) === null && !this.bossPrepAsked.has(mapId)) {
        const names = await this.bossNamesHere(pilot);
        if (names.length > 0) {
          this.bossPrepAsked.add(mapId);
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
            return `${outcome.text}\n首领表已经按地图 ${mapId} 存好,开打时直接用。`;
          }
          return outcome.text;
        }
      }
    }
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
    });
    if (reason === null) return "";
    if (reason.kind === "new-map" && isTown(areaOf(this.mapName()))) {
      this.townsCovered.add(areaOf(this.mapName()));
    }
    const last = this.recentRecord(this.mapId);
    this.lastBattle = null;
    if (reason.kind === "blocked") this.blockedCounts.clear();
    this.blocked = null;
    this.ride = null;
    const trigger: FactsTrigger = {
      ...reason,
      pilot,
      ...(last === undefined ? {} : { record: last }),
    };
    const outcome = await this.runTactician(trigger, true);
    return outcome.text;
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
    const ride = /踩到传送带 \((\d+), (\d+)\),被带到 \((\d+), (\d+)\)/u.exec(message);
    if (ride !== null) this.ride = ride[0];
  }

  /** Record the current map's exits and chests in the atlas; returns the map id. */
  async chart(pilot: Pilot): Promise<number | null> {
    const pos = record((await pilot.send("pos")).pos);
    const mapId = num(pos.map) ?? null;
    if (mapId === null || pos.state === "ChangeMap" || pos.state === "FieldReady") return mapId;
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
    const exits: Json[] = [];
    for (const entity of found.get("GotoMap") ?? []) {
      if (!truthy(entity.cell) || entity.toMap === null || entity.toMap === undefined) continue;
      exits.push({ cell: entity.cell, to: entity.toMap, name: text(entity.name) ?? "" });
    }
    // A town's way out to the world map can be an event, not an entrance (10-22: Karnak's
    // at (27,45); the player found no exit and walked the town for fifty steps).
    for (const entity of found.get("Event") ?? []) {
      if (!truthy(entity.cell) || !(text(entity.name) ?? "").includes(WORLD_EXIT)) continue;
      exits.push({ cell: entity.cell, to: 1, name: text(entity.name) ?? "" });
    }
    const chests = (found.get("TresureBox") ?? []).map((entity) => ({
      cell: entity.cell,
      name: text(entity.name) ?? "",
    }));
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
        throw new Error(`读不懂飞龙位置 ${path}:${describeError(error)}`, { cause: error });
      }
      const cell = cellOf(parsed);
      if (cell === null) throw new Error(`飞龙位置 ${path} 不是 [x, y]`);
      this.moveState.drake = cell;
    } else {
      try {
        await writeFile(path, JSON.stringify(this.moveState.drake), "utf8");
      } catch (error) {
        throw new Error(`写不了飞龙位置 ${path}:${describeError(error)}`, { cause: error });
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
      const name = text(entry.name);
      if (type === undefined || !GEAR.has(type) || name === undefined || name === "") continue;
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
   * means a jump stone (or a lift) carried the party; the atlas keeps it as a link.
   */
  async noteJump(pilot: Pilot, message: string): Promise<void> {
    const match = /站在 \((\d+), (\d+)\)/u.exec(message);
    const pos = record((await pilot.send("pos")).pos);
    const cell = cellOf(pos.cell);
    if (match === null || cell === null || pos.state !== "Player") return;
    const start: Cell = [Number(match[1]), Number(match[2])];
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

  async run(name: string, args: Json, pilot: Pilot): Promise<string> {
    const handler = this.handlers.get(name);
    if (handler === undefined) return `未知工具 ${name}`;
    this.tacticianCalled = false;
    this.blocked = null;
    this.ride = null;
    this.leaveNotice = null;
    this.lastBattle = null;
    const outcome = await handler(args, pilot);
    if (outcome.early) {
      const timed = this.lastCompletion === null ? "" : timedLine(this.lastCompletion);
      return timed === "" ? outcome.text : `${outcome.text}\n${timed}`;
    }
    const text = outcome.text;
    const settled = await this.settle(pilot);
    this.mapId = await this.chart(pilot);
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
    const tactical = await this.afterTool(pilot);
    const parts = [
      text,
      settled,
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
   * Task 45: ask the bridge for the current map's completion and update the save-local bestiary.
   * `force` skips the short cache (a leave check must see the chest just opened).
   */
  private async refreshCompletion(
    pilot: Pilot,
  ): Promise<import("./completion.ts").CompletionState | null> {
    let pos;
    try {
      pos = parsePositionReply(await pilot.send("pos"));
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
      const records = await this.battles.allRecords();
      const names = this.bestiaryNames();
      this.bestiary.restore(pos.saves, records, names);
      this.bestiary.observeRecords(this.battles.recentRecords(), names);
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
    const world = pos.areaType === 0;
    const area = pos.area ?? null;
    const areaName = pos.areaText ?? "";
    const mapName =
      [areaName, this.mapName()].filter((value) => value !== "").join(" ") ||
      (world ? "世界地图" : `地图 ${pos.map ?? "?"}`);
    const region = encounters?.region ?? null;
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
      regionLabel: region === null ? null : regionLabel(region),
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
      return { line: completionLine(state), timed: `限时开始：${all}。倒计时里不拦你离开。` };
    }
    return { line: completionLine(state), timed };
  }

  /** Refuse a leave/story step on an incomplete one-time or normal map; allow with a reason. */
  private async guardLeave(args: Json, pilot: Pilot, goal: Cell): Promise<HandlerResult | null> {
    const state = await this.refreshCompletion(pilot);
    if (state === null || isComplete(state)) return null;
    // Task 68: a monster automatically deferred by grind(until_bestiary), or one already lost
    // for good, is not a reason to stay. Other gaps on this map still block.
    const excused = this.excusedBestiary(state);
    const remaining = missingLines(state, excused);
    if (remaining.length === 0) return null;
    const leaving = this.isLeaving(state, goal);
    const story = state.oneTime ? this.storyEventAt(state, goal) : null;
    if (!leaving && !story) return null;
    // A countdown escape is not blocked: the clock is the deadline, not this guard. The
    // remaining chests are attached to every tool result instead.
    if (state.timedUntil !== null) return null;
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
    const grindHint =
      state.monsters.missing.length > 0
        ? "这图还缺的怪用 grind(until_bestiary) 刷齐，不要一步步走；"
        : "";
    return {
      early: true,
      text:
        `${why}，但这里还没完成：${missing}。\n` +
        "先拿完宝箱和隐藏道具；" +
        grindHint +
        '确实要离开就带 leave_incomplete，并写具体理由，例如 leave_incomplete="需要钥匙"、' +
        '"打不过，等升级"、"剧情强制离开"。带理由离开会记一条欠账，回来补齐后自动销掉。',
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
   * Task 58: one movement tool. `to` is a map (id or part of a name) or a cell; either way the
   * result is the old route/walk text and the Game then appends completion and the current
   * state as before.
   */
  private async toolGo(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const cell = targetCell(args.to);
    if (cell !== null) {
      return await this.withWalkLabel(`go → (${cell[0]}, ${cell[1]})`, () =>
        this.goCell(args, pilot, cell),
      );
    }
    const choice = travel.findMap(this.atlas, args.to);
    if (!choice.ok) return { text: `go 没有执行:${choice.error}`, early: true };
    const name = this.mapNameOf(choice.mapId);
    const label =
      name === "" ? `go → 地图 ${choice.mapId}` : `go → 地图 ${choice.mapId}「${name}」`;
    return await this.withWalkLabel(label, () =>
      this.withFlee(args, async () => {
        const result = await travel.travelToMap(
          pilot,
          { atlas: this.atlas, moveState: this.moveState },
          choice.mapId,
          () => undefined,
          this.travelOptions(args),
        );
        return { text: result.text };
      }),
    );
  }

  private async toolExplore(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const options = this.travelOptions(args);
    return await this.withWalkLabel("explore", () =>
      this.withFlee(args, async () => {
        const result = await travel.explore(pilot, {
          atlas: this.atlas,
          moveState: this.moveState,
          limits: { maxHops: this.travelMaxHops, maxMinutes: this.travelMaxMinutes },
          guard: options.guard,
          lookAround: async (runner) => (await this.toolLookAround(runner)).text,
        });
        return { text: result.text, early: true };
      }),
    );
  }

  /**
   * Task 68: bestiary numbers this map's leave check may ignore: already impossible ones and
   * the ones a low-probability grind deferred into the backlog for this exact place.
   */
  private excusedBestiary(state: import("./completion.ts").CompletionState): Set<number> {
    const numbers = new Set<number>();
    for (const monster of state.monsters.missing) {
      if (monster.lost && monster.number !== null) numbers.add(monster.number);
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

  private completionWhere(state: import("./completion.ts").CompletionState): string {
    return state.world
      ? (state.region?.label ?? "世界地图")
      : state.mapName === ""
        ? `地图 ${state.mapId ?? "?"}`
        : state.mapName;
  }

  /** Does this goal cross an exit, or leave the current world-map region? */
  private isLeaving(state: import("./completion.ts").CompletionState, goal: Cell): boolean {
    if (state.world && state.region !== null) {
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
            record((await pilot.send("entities", { kind: "RelayInteraction", max: 60 })).entities)
              .entities,
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
      const message = await move.openAt(pilot, goal, () => undefined, this.moveState);
      await this.noteJump(pilot, message);
      return { text: message };
    });
  }

  private async toolAdvanceStory(pilot: Pilot): Promise<HandlerResult> {
    // FF5 is the running game: its paging stays the pilot agent's story op, but the new-game
    // FieldHelp and naming screens the op now stops on are handled before each try (10-29).
    if (this.game === "ff5") {
      return { text: await this.pilotAdvanceStory(pilot) };
    }
    const outcome = await screens.advanceStory(pilot);
    const notes = outcome.notes.length > 0 ? outcome.notes.join("\n") + "\n" : "";
    if (outcome.stop === "stuck") {
      return {
        text:
          notes +
          "画面没有变化，可能是工具认不出的界面,停下不再按键。\n" +
          `当前状态:${outcome.detail}`,
        early: true,
      };
    }
    if (outcome.stop === "fieldhelp") {
      return {
        text: notes + `${screens.FIELD_HELP_STUCK}\n当前状态:${outcome.detail}`,
        early: true,
      };
    }
    return { text: `${notes}翻了 ${outcome.pages} 页,停下原因:${outcome.stop}` };
  }

  /**
   * FF5's story op pages by itself, but it stops on the first-visit FieldHelp and the naming
   * box; close those with the five-game helpers, then let it page again (at most three tries).
   */
  private async pilotAdvanceStory(pilot: Pilot): Promise<string> {
    const notes: string[] = [];
    let pages = 0;
    let why: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const help = await screens.dismissFieldHelp(pilot);
      if (help === "stuck") return [...notes, screens.FIELD_HELP_STUCK].join("\n");
      if (help === "closed") notes.push("关掉了操作提示");
      const named = await screens.nameFocusedField(pilot);
      if (named !== null) notes.push(named);

      const result = await pilot.send("story", { pageMs: 3000, timeout: 600000 }, 620_000);
      pages += num(result.pages) ?? 0;
      why = text(result.stop) || text(result.error);
      // 11-02: FF5's new-game naming box opens inside an Event, so the story op stops on
      // "textinput"; confirm the name on the next try just as for state:ChangeName.
      if (why !== "state:ChangeName" && why !== "textinput" && why !== "state:FieldHelp") break;
    }
    const line = `翻了 ${pages} 页,停下原因:${show(why)}`;
    return notes.length > 0 ? `${notes.join("\n")}\n${line}` : line;
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
      return { text: "现在是商店/菜单界面,不是选项。要离开就用 leave_menu。", early: true };
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
    return { text: truthy(result.ok) ? "已选择" : `没选成:${show(result.error)}` };
  }

  private async toolFight(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const raw = record(args.plan);
    // Task 42: fight takes either language, like set_tactics and the tactician's own tables.
    const plan = raw.version === 2 ? raw : gambit.normalize(raw);
    const problems = raw.version === 2 ? checkStrategy(raw) : gambit.check(plan, this.game);
    if (problems.length > 0) {
      // Sent back before a key is pressed (§4.6): the battle waits for a full table.
      return { text: "规则表没有通过检查,请改好再交:\n" + problems.join("\n"), early: true };
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
      return { text: `${report};出招:${list(result.turns).map(show).join("、")}` };
    }
    const done = truthy(result.ok) ? "战斗结束" : `战斗没打完:${show(result.error)}`;
    let text = `${done};出招:${list(result.turns).map(show).join("、")}`;
    if (result.learned.length > 0) text += "\n" + result.learned.join(";");
    if (truthy(result.ok)) {
      const healed = await battle.patchUp(pilot, () => undefined);
      if (healed.length > 0) text += "\n战后回复:" + healed.join(";");
    }
    return { text };
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
        {
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
        },
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
    const [, detail] = await menu.useItem(pilot, String(args.item), String(args.target));
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
    const [ok, detail] = await save.saveGame(pilot, this.saveSlot);
    if (ok) await this.captureBestiary(pilot);
    return { text: detail };
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
      const records = await this.battles.allRecords();
      const names = this.bestiaryNames();
      this.bestiary.restore(pos.saves, records, names);
      this.bestiary.observeRecords(this.battles.recentRecords(), names);
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
    await this.tactics.set(id, tables, met, undefined, roster);
    return {
      text:
        `已为地图 ${id} 设好 ${tables.length} 套战斗策略;` +
        "普通战斗先用第 1 套,打得不好会自动换下一套。",
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
    return { text: view.describeItems(record((await pilot.query("items")).items)) };
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

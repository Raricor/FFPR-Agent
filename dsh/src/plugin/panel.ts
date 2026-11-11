/**
 * The sidebar's read-only routes (task 14, task 24): GET /api/ffpr/achievements,
 * /api/ffpr/tactics and /api/ffpr/book answer for the game named by `?game=ffN`, so one
 * registration serves all six players. The connection service only exists in a web composition,
 * so it is injected optionally (Cordis `ctx.inject([...], callback)`), not listed in the plugin's
 * required inject array.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { type BestiaryAreaCache } from "../engine/achievements.ts";
import { Backlog, Incidents } from "../engine/completion.ts";
import { BattleLog } from "../engine/battle-record.ts";
import { type MonsterCache } from "../engine/bestiary.ts";
import { parseEncounters, type EncounterTable } from "../engine/encounters.ts";
import { describeError, isMissingFile } from "../engine/errors.ts";
import { CalledProcessError } from "../engine/laptop.ts";
import { LinkError } from "../engine/bridge.ts";
import { byKey, type Game } from "../engine/games.ts";
import type { Cell } from "../engine/nav.ts";
import { DEPS } from "../engine/paths.ts";
import { PlayerJournal, playerView, type PlayerView } from "../engine/player-log.ts";
import type {
  BookSectionStats,
  BookStationProgress,
  BookStationStatus,
} from "../engine/stage/book-progress-types.ts";
import { TacticianLog } from "../engine/tactician-log.ts";
import { tacticianView, type TacticianPanelView } from "../engine/tactician-view.ts";
import { createPilot } from "../engine/link-pilot.ts";
import { profileFor } from "../engine/profiles/index.ts";
import type { GameProfile } from "../engine/profiles/types.ts";
import { heldItems } from "../engine/skills/battle.ts";
import { inBattle as inBattleOf, placeName as placeNameOf } from "../engine/status.ts";
import { loadNotes } from "../engine/notes.ts";
import { Tactics } from "../engine/tactics.ts";
import { tacticsView, type TacticsPanelView } from "../engine/tactics-view.ts";
import { isRecord, num, record, records, text, truthy } from "../engine/values.ts";
import { walkDisplay } from "../engine/walk-view.ts";
import { currentGame, readAchievementView, type CommandPilotFactory } from "./commands.ts";
import { defaultPlanFiles, planRoute, type PlanFilesOf } from "./plan-panel.ts";
import { currentRoute, readCurrent, type CurrentSource } from "./current.ts";
import { gameDefaults } from "./config.ts";
import type { PlayerEngine } from "./player.ts";

export const ACHIEVEMENTS_ROUTE = "/api/ffpr/achievements";
export const TACTICS_ROUTE = "/api/ffpr/tactics";
export const BATTLES_ROUTE = "/api/ffpr/battles";
export const PLAYER_ROUTE = "/api/ffpr/player";
export const TACTICIAN_ROUTE = "/api/ffpr/tactician";
export const WALK_ROUTE = "/api/ffpr/walk";
export const BOOK_ROUTE = "/api/ffpr/book";
export { PLAN_ROUTE, defaultPlanFiles, planRoute, readPlanPanel } from "./plan-panel.ts";
export type {
  PlanBattleGroupView,
  PlanBossView,
  PlanDroppedRowView,
  PlanFiles,
  PlanFilesOf,
  PlanPanelView,
  PlanReportView,
  PlanRuleTableView,
  PlanStationRowView,
  PlanView,
} from "./plan-panel.ts";

/** The root panel entry's way to find the player preset that started one game's engine. */
export type EngineLookup = (game: string) => PlayerEngine | undefined;

type GameChoice =
  { readonly ok: true; readonly game: Game } | { readonly ok: false; readonly error: string };

/**
 * `?game=ffN`, defaulting to ff5 so the old FF5 pages keep working; an unknown key reports the
 * Chinese unknown-game error instead of picking an engine.
 */
async function requestedGame(request: Request, current?: CurrentSource): Promise<GameChoice> {
  const raw = new URL(request.url).searchParams.get("game");
  const key =
    raw === null || raw.trim() === ""
      ? current === undefined
        ? "ff5"
        : (await readCurrent(current)).game
      : raw.trim();
  try {
    return { ok: true, game: byKey(key) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** What the strategy route shows before (or without) a loaded player for this game. */
function emptyTacticsView(game: Game, status: string): TacticsPanelView {
  return {
    ...tacticsView({
      profile: profileFor(game.key),
      strategy: false,
      mapId: null,
      party: [],
      inBattle: false,
      tactics: new Tactics(),
      mapNameOf: () => "",
      tacticianInfoFor: () => null,
      lastBossPlan: () => null,
      areaId: null,
      encountered: () => [],
      monsters: null,
      bestiaryEntries: null,
      items: {},
      elements: null,
      encounters: null,
    }),
    status,
  };
}

/** One exact Fetch route; owner authentication and cookies are handled by the connection. */
export function achievementRoute(
  engineFor: EngineLookup,
  pilotFor?: CommandPilotFactory,
  monsterCache?: MonsterCache,
  current?: CurrentSource,
): ConnectionFetchRoute {
  return {
    path: ACHIEVEMENTS_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = await requestedGame(request, current);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      const engine = engineFor(choice.game.key);
      if (engine === undefined) {
        // The preset is loaded but its lazy engine has not started (task 31).
        return json({ ok: false, error: `${choice.game.label} 没在运行`, at });
      }
      const result = await readAchievementView(engine, request.signal, pilotFor, monsterCache);
      return result.ok
        ? json({ ok: true, view: result.view, at })
        : json({ ok: false, error: result.error, at });
    },
  };
}

function defaultTacticsPilot(engine: PlayerEngine, signal: AbortSignal) {
  return createPilot(engine.laptop, engine.bridge, signal, {
    game: engine.game.game,
    agentCheckMs: engine.agentCheckMs,
  });
}

/** The configured game's profile: what a down bridge or an unknown product falls back to. */
function configuredProfile(engine: PlayerEngine): GameProfile {
  return profileFor(byKey(engine.game.game).key);
}

function downView(engine: PlayerEngine, status = "连不上桥插件，游戏可能没开"): TacticsPanelView {
  return {
    ...tacticsView({
      profile: configuredProfile(engine),
      strategy: true,
      mapId: null,
      party: [],
      inBattle: false,
      tactics: engine.game.tactics,
      mapNameOf: (mapId) => engine.game.mapNameOf(mapId),
      tacticianInfoFor: (mapId) => engine.game.tacticianInfoFor(mapId),
      lastBossPlan: () => engine.game.lastBossPlan(),
      areaId: null,
      encountered: () => [],
      monsters: null,
      bestiaryEntries: null,
      items: {},
      elements: engine.game.elements,
      encounters: null,
    }),
    status,
  };
}

/** The current map, party and battle state, or the stored strategies when the bridge is down. */
export async function readTacticsView(
  engine: PlayerEngine,
  signal: AbortSignal,
  pilotFor: CommandPilotFactory = defaultTacticsPilot,
  monsterCache?: MonsterCache,
  bestiaryCache?: BestiaryAreaCache,
): Promise<TacticsPanelView> {
  if (engine.bridge === undefined) return downView(engine);
  const pilot = pilotFor(engine, signal);
  try {
    const game = await currentGame(engine, signal);
    const profile = profileFor(game.key);
    // Only the configured game (ff5 today) has the AI player and its rule tables.
    const strategy = game.key === byKey(engine.game.game).key;
    const sample = record((await pilot.query("sample")).sample);
    const mapId = num(record(sample.user).mapId) ?? null;
    const areaId = num(record(sample.user).areaId) ?? null;
    const placeName = placeNameOf(sample);
    const party = records(sample.party);
    let items: Record<string, number> = {};
    try {
      if (strategy) items = await heldItems(pilot);
    } catch {
      // Without the bag the simulation only misses item rules; the page is still worth showing.
      signal.throwIfAborted();
    }
    let encounters: EncounterTable | null = null;
    try {
      encounters = parseEncounters(await pilot.query("encounters"));
    } catch {
      // Bridges before 0.8.0 have no `encounters`; the enemy list then uses the other sources.
      signal.throwIfAborted();
    }
    const monsters =
      monsterCache === undefined ? null : await monsterCache.load(pilot, signal, game.key);
    const bestiary =
      bestiaryCache === undefined ? null : await bestiaryCache.load(pilot, signal, game.key);
    let pos: Record<string, unknown> = {};
    try {
      pos = record((await pilot.send("pos")).pos);
    } catch {
      // The sample's battle flag is enough when an older pilot has no pos answer.
      signal.throwIfAborted();
    }
    const inBattle = truthy(pos.battle) || pos.state === "Battle" || inBattleOf(sample);
    return tacticsView({
      profile,
      strategy,
      mapId,
      areaId,
      placeName,
      party,
      inBattle,
      tactics: engine.game.tactics,
      mapNameOf: (id) => engine.game.mapNameOf(id),
      tacticianInfoFor: (id) => engine.game.tacticianInfoFor(id),
      lastBossPlan: () => engine.game.lastBossPlan(),
      encountered: (id) => [...(engine.game.events?.enemies.get(id) ?? [])],
      monsters,
      bestiaryEntries: bestiary?.entries ?? null,
      items,
      elements: engine.game.elements,
      encounters,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof LinkError || error instanceof CalledProcessError) return downView(engine);
    return downView(engine, `读不了当前地图:${describeError(error)}`);
  }
}

/** One exact Fetch route for the strategy page; always 200 with a rendered view. */
export function tacticsRoute(
  engineFor: EngineLookup,
  pilotFor?: CommandPilotFactory,
  monsterCache?: MonsterCache,
  bestiaryCache?: BestiaryAreaCache,
  current?: CurrentSource,
): ConnectionFetchRoute {
  return {
    path: TACTICS_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = await requestedGame(request, current);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      const engine = engineFor(choice.game.key);
      if (engine === undefined) {
        return json({
          ok: true,
          view: emptyTacticsView(choice.game, `${choice.game.label} 没在运行`),
          at,
        });
      }
      const view = await readTacticsView(
        engine,
        request.signal,
        pilotFor,
        monsterCache,
        bestiaryCache,
      );
      return json({ ok: true, view, at });
    },
  };
}

/** Load this game's battle file when no engine is running, so history still appears. */
async function storedBattles(game: Game): Promise<BattleLog> {
  return await BattleLog.load(game.key, gameDefaults(game.key).battlesFile);
}

/**
 * GET /api/ffpr/battles?game=ffN: the live battle (units and last ten turns) and the last 30
 * summaries; `&id=N` returns one full record. The engine records while it fights; with no
 * started engine the route reads `.deps/ds/battles-<game>.jsonl` instead (task 40).
 */
export function battlesRoute(
  engineFor: EngineLookup,
  current?: CurrentSource,
): ConnectionFetchRoute {
  return {
    path: BATTLES_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = await requestedGame(request, current);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      const engine = engineFor(choice.game.key);
      let battles: BattleLog;
      try {
        battles = engine?.game.battles ?? (await storedBattles(choice.game));
      } catch (error) {
        return json({ ok: false, error: `读不了战斗记录:${describeError(error)}`, at });
      }
      const raw = new URL(request.url).searchParams.get("id");
      if (raw !== null && raw.trim() !== "") {
        const id = Number.parseInt(raw, 10);
        if (!Number.isFinite(id)) {
          return json({ ok: false, error: `战斗编号「${raw}」不是数字`, at });
        }
        const record = await battles.recordView(id);
        if (record === null) return json({ ok: false, error: `没有第 ${id} 场战斗`, at });
        return json({ ok: true, at, record });
      }
      return json({
        ok: true,
        at,
        live: battles.currentView(),
        recent: battles.recentViews(),
      });
    },
  };
}

/** The ① 玩家 tab, from the live engine's journal or the file left by an earlier run. */
export async function readPlayerPanel(
  game: Game,
  engine: PlayerEngine | undefined,
): Promise<PlayerView> {
  const defaults = gameDefaults(game.key);
  const journal = engine?.journal ?? (await PlayerJournal.load({ file: defaults.playerFile }));
  const notes = engine === undefined ? await loadNotes(defaults.notesFile) : engine.game.notes;
  const status =
    engine === undefined
      ? `${game.label} 没在运行`
      : engine.watcher !== undefined && !engine.watcher.connected
        ? "连不上桥插件，显示存下的记录"
        : "";
  const backlog = engine?.game.backlog ?? (await Backlog.load(defaults.backlogFile));
  const incidents =
    engine?.game.incidents ??
    (await Incidents.load(defaults.incidentsFile, defaults.incidentsStateFile));
  const view = playerView(game.key, journal, notes, status);
  return {
    ...view,
    incidents: incidents.entries
      .slice(-5)
      .map(
        (entry) =>
          `${entry.place} 错过 ${entry.lost} 个宝箱(累计 ${entry.total} 个)` +
          (entry.supplement === true ? "，补记" : ""),
      ),
    backlog: backlog
      .pending()
      .map(
        (entry) =>
          `${entry.mapName === "" ? `地图 ${entry.mapId ?? "?"}` : entry.mapName}：` +
          `${entry.missing.join("、")}；理由：${entry.reason}`,
      ),
  };
}

/**
 * GET /api/ffpr/player?game=ffN: goal, current words, notes, recent decisions and messages.
 * The journal file is enough when the engine is not started.
 */
export function playerRoute(
  engineFor: EngineLookup,
  current?: CurrentSource,
): ConnectionFetchRoute {
  return {
    path: PLAYER_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = await requestedGame(request, current);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      try {
        return json({
          ok: true,
          at,
          view: await readPlayerPanel(choice.game, engineFor(choice.game.key)),
        });
      } catch (error) {
        return json({ ok: false, error: `读不了玩家记录:${describeError(error)}`, at });
      }
    },
  };
}

/** The ② 战术官 tab, from the engine or the tactics/calls files of an earlier run. */
export async function readTacticianPanel(
  game: Game,
  engine: PlayerEngine | undefined,
): Promise<TacticianPanelView> {
  const defaults = gameDefaults(game.key);
  const tactics = engine?.game.tactics ?? (await Tactics.load(defaults.tacticsFile));
  const records =
    engine?.game.battles.recentRecords() ??
    (await BattleLog.load(game.key, defaults.battlesFile)).recentRecords();
  const calls =
    engine?.game.tacticianLog.entries ??
    (await TacticianLog.load({ file: defaults.tacticianFile })).entries;
  const sample = engine?.events?.lastSample()?.sample ?? null;
  const mapId = num(record(record(sample).user).mapId) ?? engine?.game.mapId ?? null;
  const mapNameOf = (id: number): string => {
    const name = engine?.game.mapNameOf(id) ?? "";
    return name === "" ? `地图 ${id}` : name;
  };
  const status =
    engine === undefined
      ? `${game.label} 没在运行，下面是存下的战术`
      : engine.watcher !== undefined && !engine.watcher.connected
        ? "连不上桥插件，下面是存下的战术"
        : undefined;
  return tacticianView({
    game: game.key,
    tactics,
    records,
    calls,
    mapId,
    mapNameOf,
    ...(status === undefined ? {} : { status }),
  });
}

/**
 * GET /api/ffpr/tactician?game=ffN: walker notes, translated tables with hit/skip counts,
 * the boss table, recent calls and the other maps. Always 200 with a rendered view.
 */
export function tacticianRoute(
  engineFor: EngineLookup,
  current?: CurrentSource,
): ConnectionFetchRoute {
  return {
    path: TACTICIAN_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = await requestedGame(request, current);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      try {
        return json({
          ok: true,
          at,
          view: await readTacticianPanel(choice.game, engineFor(choice.game.key)),
        });
      } catch (error) {
        return json({ ok: false, error: `读不了战术官记录:${describeError(error)}`, at });
      }
    },
  };
}

/**
 * GET /api/ffpr/walk?game=ffN: the game's current walking view, or `view: null` before this
 * run has walked. The display lines are computed here so the browser bundle only lays them out
 * (task 61).
 */
export function walkRoute(engineFor: EngineLookup, current?: CurrentSource): ConnectionFetchRoute {
  return {
    path: WALK_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = await requestedGame(request, current);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      const view = engineFor(choice.game.key)?.game.walkView() ?? null;
      return json({
        ok: true,
        at,
        view: view === null ? null : { ...view, display: walkDisplay(view, Date.now()) },
      });
    },
  };
}

/** Where the route book and its executor progress live for one game (task 118). */
export interface BookFiles {
  readonly book: string;
  readonly progress: string;
}

/**
 * Task 117 will put both paths into Config. Until that merges, task 118 reads the default files
 * under `.deps/ds/`; the route takes a provider so the panel entry can pass Config later without
 * changing the view code or the tests.
 */
export function defaultBookFiles(game: string): BookFiles {
  return {
    book: join(DEPS, "ds", `routebook-${game}.json`),
    progress: join(DEPS, "ds", `routebook-progress-${game}.json`),
  };
}

export type BookFilesOf = (game: string) => BookFiles;

/** One station row the browser lays out; every label is already Chinese. */
export interface BookStationRowView {
  readonly number: number;
  readonly mapText: string;
  readonly cellText: string;
  readonly action: string;
  readonly statusText: string;
  readonly note: string;
  readonly current: boolean;
}

/** A small table; the route book's totals and stations both use this shape. */
export interface BookTableView {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface BookSectionView {
  readonly heading: string;
  readonly startedText: string;
  readonly stateText: string;
  readonly acceptanceText: string;
  readonly headers: readonly string[];
  readonly stations: readonly BookStationRowView[];
  readonly emptyText: string;
}

export interface BookPanelView {
  readonly title: string;
  readonly status: string;
  readonly message: string | null;
  readonly section: BookSectionView | null;
  readonly totals: BookTableView | null;
}

interface BookStationSummary {
  /** The guide step's own index, used only when executor progress indexed by it. */
  readonly stepIndex: number | null;
  readonly mapId: number | null;
  readonly cell: Cell | null;
  readonly action: string;
}

interface BookSectionSummary {
  readonly title: string;
  readonly areaName: string | null;
  readonly stations: readonly BookStationSummary[];
}

interface BookTotals {
  readonly sections: number;
  readonly stations: number;
  readonly chestsMatched: number;
  readonly chestsTotal: number;
  readonly bestiaryMissing: number;
  readonly bestiaryUnknown: boolean;
  readonly blueMagicMissing: number;
  readonly mismatches: number;
}

interface BookSummary {
  readonly sections: readonly BookSectionSummary[];
  readonly totals: BookTotals | null;
}

interface ProgressSummary {
  readonly section: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly stations: readonly BookStationProgress[];
  readonly stats: BookSectionStats;
}

type JsonRead =
  | { readonly state: "missing" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ok"; readonly value: unknown };

const STATION_STATUS_LABELS: Readonly<Record<BookStationStatus, string>> = {
  pending: "待做",
  current: "进行中",
  done: "完成",
  handoff: "交回",
  skipped: "跳过",
};

function countOf(value: unknown): number {
  return Math.max(0, Math.trunc(num(value) ?? 0));
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = num(value[0]);
  const y = num(value[1]);
  return x === undefined || y === undefined ? null : [Math.trunc(x), Math.trunc(y)];
}

function readBookTotals(value: unknown): BookTotals | null {
  if (!isRecord(value)) return null;
  return {
    sections: countOf(value.sections),
    stations: countOf(value.stations),
    chestsMatched: countOf(value.chestsMatched),
    chestsTotal: countOf(value.chestsTotal),
    bestiaryMissing: countOf(value.bestiaryMissing),
    bestiaryUnknown: value.bestiaryUnknown === true,
    blueMagicMissing: countOf(value.blueMagicMissing),
    mismatches: countOf(value.mismatches),
  };
}

/** The route book JSON is written by task 115; keep the panel tolerant of unknown extra fields. */
function readBook(value: unknown): BookSummary {
  if (!isRecord(value)) throw new Error("路线书不是 JSON 对象");
  if (!Array.isArray(value.sections)) throw new Error("路线书里没有 sections");
  const sections = value.sections.map((rawSection, sectionIndex): BookSectionSummary => {
    if (!isRecord(rawSection)) throw new Error(`路线书第 ${sectionIndex + 1} 段不是对象`);
    const title = text(rawSection.title);
    if (title === undefined || title.trim() === "") {
      throw new Error(`路线书第 ${sectionIndex + 1} 段没有标题`);
    }
    if (!Array.isArray(rawSection.stations)) {
      throw new Error(`路线书第 ${sectionIndex + 1} 段没有站点表`);
    }
    const stations = rawSection.stations.map((rawStation, stationIndex): BookStationSummary => {
      if (!isRecord(rawStation)) {
        throw new Error(`路线书「${title}」第 ${stationIndex + 1} 站不是对象`);
      }
      const mapId = num(rawStation.mapId);
      const stepIndex = num(rawStation.index);
      return {
        stepIndex: stepIndex === undefined ? null : Math.trunc(stepIndex),
        mapId: mapId === undefined ? null : Math.trunc(mapId),
        cell: cellOf(rawStation.cell),
        action: text(rawStation.action) ?? "",
      };
    });
    const areaName = text(rawSection.areaName);
    return {
      title,
      areaName: areaName === undefined || areaName.trim() === "" ? null : areaName,
      stations,
    };
  });
  return { sections, totals: readBookTotals(value.totals) };
}

function readProgressStats(value: unknown): BookSectionStats {
  const raw = record(value);
  const missing = (item: unknown): number | null => {
    const number = num(item);
    return number === undefined ? null : Math.max(0, Math.trunc(number));
  };
  return {
    tools: countOf(raw.tools),
    go: countOf(raw.go),
    route: countOf(raw.route),
    handoffs: countOf(raw.handoffs),
    chestsOpened: countOf(raw.chestsOpened),
    chestsTotal: countOf(raw.chestsTotal),
    bestiaryMissing: missing(raw.bestiaryMissing),
    blueMagicMissing: missing(raw.blueMagicMissing),
    minutes: countOf(raw.minutes),
  };
}

function statusOf(value: unknown): BookStationStatus {
  return value === "current" || value === "done" || value === "handoff" || value === "skipped"
    ? value
    : "pending";
}

/** The executor writes BookProgress (task 117); a damaged file becomes a Chinese read error. */
function readProgress(value: unknown): ProgressSummary {
  if (!isRecord(value)) throw new Error("进度文件不是 JSON 对象");
  const section = text(value.section);
  if (section === undefined || section.trim() === "") throw new Error("进度文件里没有段名");
  const startedAt = text(value.startedAt);
  if (startedAt === undefined || startedAt.trim() === "") {
    throw new Error("进度文件里没有开始时间");
  }
  if (!Array.isArray(value.stations)) throw new Error("进度文件里没有站点状态");
  const finishedAt = text(value.finishedAt);
  const stations = value.stations.flatMap((raw): BookStationProgress[] => {
    if (!isRecord(raw)) return [];
    const index = num(raw.index);
    if (index === undefined) return [];
    return [
      {
        index: Math.trunc(index),
        status: statusOf(raw.status),
        note: text(raw.note) ?? "",
      },
    ];
  });
  return {
    section,
    startedAt,
    finishedAt: finishedAt === undefined || finishedAt.trim() === "" ? null : finishedAt,
    stations,
    stats: readProgressStats(value.stats),
  };
}

async function readJson(path: string, label: string, signal?: AbortSignal): Promise<JsonRead> {
  let body: string;
  try {
    body = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingFile(error)) return { state: "missing" };
    return { state: "error", message: `读不了${label}:${describeError(error)}` };
  }
  try {
    return { state: "ok", value: JSON.parse(body) };
  } catch (error) {
    signal?.throwIfAborted();
    return { state: "error", message: `读不懂${label}:${describeError(error)}` };
  }
}

function stateText(progress: ProgressSummary): string {
  return progress.finishedAt === null ? "进行中" : "已完成";
}

function clockText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function acceptanceText(stats: BookSectionStats): string {
  const missing = (value: number | null): string => (value === null ? "未知" : String(value));
  return (
    `工具 ${stats.tools}(go ${stats.go}、route ${stats.route})、交回 ${stats.handoffs}、` +
    `宝箱 ${stats.chestsOpened}/${stats.chestsTotal}、图鉴还缺 ${missing(stats.bestiaryMissing)}、` +
    `青魔法还缺 ${missing(stats.blueMagicMissing)}、用时 ${stats.minutes} 分`
  );
}

function totalsView(totals: BookTotals | null): BookTableView | null {
  if (totals === null) return null;
  return {
    headers: ["段", "站点", "宝箱", "图鉴缺", "青魔法缺", "对不上"],
    rows: [
      [
        `${totals.sections} 段`,
        String(totals.stations),
        `${totals.chestsMatched}/${totals.chestsTotal}`,
        `${totals.bestiaryMissing}${totals.bestiaryUnknown ? "+?" : ""}`,
        String(totals.blueMagicMissing),
        String(totals.mismatches),
      ],
    ],
  };
}

function stationProgress(
  progress: ProgressSummary,
  position: number,
  station: BookStationSummary,
): BookStationProgress | undefined {
  const byPosition = progress.stations.find((item) => item.index === position);
  if (byPosition !== undefined) return byPosition;
  // Some executor builds may have written RouteStation.index (the guide step number) instead.
  return station.stepIndex === null
    ? undefined
    : progress.stations.find((item) => item.index === station.stepIndex);
}

function sectionView(section: BookSectionSummary, progress: ProgressSummary): BookSectionView {
  const started = clockText(progress.startedAt);
  const rows = section.stations.map((station, position): BookStationRowView => {
    const entry = stationProgress(progress, position, station);
    const status = entry?.status ?? "pending";
    return {
      number: position + 1,
      mapText: station.mapId === null ? "—" : String(station.mapId),
      cellText: station.cell === null ? "—" : `(${station.cell[0]},${station.cell[1]})`,
      action: station.action === "" ? "—" : station.action,
      statusText: STATION_STATUS_LABELS[status],
      note: entry?.note ?? "",
      current: status === "current",
    };
  });
  return {
    heading: `${section.title}(${section.areaName ?? "没对上地图"})`,
    startedText: started === "" ? "开始时间未知" : `开始 ${started}`,
    stateText: stateText(progress),
    acceptanceText: acceptanceText(progress.stats),
    headers: ["序号", "图", "坐标", "做什么", "状态"],
    stations: rows,
    emptyText: "这一段没有站点",
  };
}

/**
 * Read `.deps/ds/routebook-<game>.json` and `routebook-progress-<game>.json` (tasks 115/117).
 * Missing files and damaged JSON become Chinese view text, never an exception: the sidebar must
 * keep showing the rest of the panel.
 */
export async function readBookPanel(
  files: BookFiles,
  signal?: AbortSignal,
): Promise<BookPanelView> {
  const [bookRead, progressRead] = await Promise.all([
    readJson(files.book, "路线书", signal),
    readJson(files.progress, "路线书进度", signal),
  ]);
  const base: BookPanelView = {
    title: "路线书",
    status: "还没有路线书",
    message: "还没有路线书",
    section: null,
    totals: null,
  };
  if (bookRead.state === "missing") return base;
  if (bookRead.state === "error") {
    return { ...base, status: "路线书读不了", message: bookRead.message };
  }
  let book: BookSummary;
  try {
    book = readBook(bookRead.value);
  } catch (error) {
    return { ...base, status: "路线书读不了", message: `读不懂路线书:${describeError(error)}` };
  }
  const totals = totalsView(book.totals);
  if (progressRead.state === "missing") {
    return { ...base, status: "还没开始执行", message: "还没开始执行", totals };
  }
  if (progressRead.state === "error") {
    return { ...base, status: "进度读不了", message: progressRead.message, totals };
  }
  let progress: ProgressSummary;
  try {
    progress = readProgress(progressRead.value);
  } catch (error) {
    return {
      ...base,
      status: "进度读不了",
      message: `读不懂路线书进度:${describeError(error)}`,
      totals,
    };
  }
  const section = book.sections.find((item) => item.title === progress.section);
  if (section === undefined) {
    return {
      ...base,
      status: stateText(progress),
      message: `进度里的段「${progress.section}」不在路线书里`,
      totals,
    };
  }
  return {
    title: "路线书",
    status: stateText(progress),
    message: null,
    section: sectionView(section, progress),
    totals,
  };
}

/** GET /api/ffpr/book?game=ffN: the route book's current section and acceptance numbers. */
export function bookRoute(
  current?: CurrentSource,
  filesFor: BookFilesOf = defaultBookFiles,
): ConnectionFetchRoute {
  return {
    path: BOOK_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = await requestedGame(request, current);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      try {
        return json({
          ok: true,
          at,
          view: await readBookPanel(filesFor(choice.game.key), request.signal),
        });
      } catch (error) {
        request.signal.throwIfAborted();
        return json({ ok: false, error: `读不了路线书:${describeError(error)}`, at });
      }
    },
  };
}

/**
 * Register the routes on the plugin's ctx when this deployment has a connection service. The
 * root panel entry calls this once; the player presets no longer register routes themselves.
 */
export function installPanel(
  ctx: Context,
  engineFor: EngineLookup,
  pilotFor?: CommandPilotFactory,
  monsterCache?: MonsterCache,
  bestiaryCache?: BestiaryAreaCache,
  current?: CurrentSource,
  bookFilesFor: BookFilesOf = defaultBookFiles,
  planFilesFor: PlanFilesOf = defaultPlanFiles,
): void {
  ctx.inject(["connection"], (connectionCtx) => {
    if (current !== undefined) {
      connectionCtx.effect(() => connectionCtx.connection.fetch.register(currentRoute(current)));
    }
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(
        achievementRoute(engineFor, pilotFor, monsterCache, current),
      ),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(
        tacticsRoute(engineFor, pilotFor, monsterCache, bestiaryCache, current),
      ),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(battlesRoute(engineFor, current)),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(playerRoute(engineFor, current)),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(tacticianRoute(engineFor, current)),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(walkRoute(engineFor, current)),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(bookRoute(current, bookFilesFor)),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(planRoute(current, planFilesFor)),
    );
  });
}

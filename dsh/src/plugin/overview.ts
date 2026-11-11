/**
 * The six-game overview's route (task 24): GET /api/ffpr/overview returns one card per game
 * and the merged activity log. It reads only what each engine already holds (the cached sample,
 * the activity log, the running tool), so polling it never takes the bridge lock from a player.
 *
 * Task 31: each request reads only the shared detection cache and starts the one game's engine
 * in the background when only that game is open. A missing or stale cache triggers one shared
 * refresh without waiting for SSH; the next request (usually the page's next poll) sees it. The
 * reply is not blocked by detection or the start (task 31 review).
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import type { ActivityEntry, ActivityKind, ActivityQuery } from "../engine/activity.ts";
import { mergeActivity } from "../engine/activity.ts";
import { describeError } from "../engine/errors.ts";
import { GAMES, byKey, gameHeading, titleOf, type Game } from "../engine/games.ts";
import {
  partyDetails,
  partyMembers,
  placeName,
  sceneStatus,
  type PartyDetailView,
} from "../engine/status.ts";
import { num, record, text, type Json } from "../engine/values.ts";
import { gameDefaults } from "./config.ts";
import type { DetectionResult, DetectionSource } from "./detect.ts";
import { readCurrent, type CurrentSource } from "./current.ts";
import type { EngineLookup } from "./panel.ts";
import type { PlayerEngine, PlayerLog } from "./player.ts";
import type { EngineSlot } from "./registry.ts";

export type SlotLookup = (game: string) => EngineSlot | undefined;

export const OVERVIEW_ROUTE = "/api/ffpr/overview";

export interface OverviewLast {
  readonly at: string;
  readonly kind: ActivityKind;
  readonly text: string;
}

export interface GameCard {
  readonly game: string;
  readonly title: string;
  readonly loaded: boolean;
  readonly link: "up" | "down";
  readonly linkText: string | null;
  readonly status: string;
  readonly place: string;
  readonly party: readonly {
    readonly name: string;
    readonly hp: number;
    readonly maxHp: number;
  }[];
  readonly busy: { readonly name: string; readonly at: string } | null;
  readonly last: OverviewLast | null;
  readonly saveSlot: number;
}

export interface CurrentBridgeView {
  readonly version: string | null;
  readonly connected: boolean;
  /** `sample.battle.atb`: 等待 / 实时 / null when the bridge is older than 0.13. */
  readonly atb: "等待" | "实时" | null;
}

export interface CurrentPlaceView {
  readonly mapId: number | null;
  readonly name: string;
}

export interface CurrentCard {
  readonly game: string;
  readonly title: string;
  readonly label: string;
  readonly name: string;
  readonly running: boolean;
  readonly statusText: string;
  readonly bridge: CurrentBridgeView;
  readonly place: CurrentPlaceView;
  readonly party: readonly PartyDetailView[];
  readonly gil: number | null;
  readonly saveCount: number | null;
  readonly busy: { readonly name: string; readonly at: string } | null;
  readonly last: OverviewLast | null;
  readonly lastKnownAt: string | null;
  readonly saveSlot: number;
}

export interface Overview {
  readonly at: string;
  /** The six legacy cards stay for older callers; the page uses `current` only (task 40). */
  readonly games: readonly GameCard[];
  readonly current: CurrentCard | null;
  readonly log: readonly ActivityEntry[];
}

const BRIDGE_DOWN = "连不上桥插件，游戏可能没开";

function linkOf(engine: PlayerEngine | undefined): {
  readonly link: "up" | "down";
  readonly linkText: string | null;
} {
  if (engine?.bridge === undefined) {
    return { link: "down", linkText: BRIDGE_DOWN };
  }
  const watcher = engine.watcher;
  if (watcher === undefined) return { link: "up", linkText: null };
  if (watcher.error !== null) return { link: "down", linkText: watcher.error };
  if (!watcher.connected) return { link: "down", linkText: BRIDGE_DOWN };
  return { link: "up", linkText: null };
}

function lastOf(engine: PlayerEngine | undefined): OverviewLast | null {
  const entry = engine?.activity.last;
  return entry === undefined ? null : { at: entry.at, kind: entry.kind, text: entry.text };
}

/** A card without an engine: the detection says whether the game is even open. */
function idleText(game: Game, detection: DetectionResult | undefined): string {
  if (!detection?.ok) return "还没启动";
  return detection.running.includes(game.key) ? "还没启动" : "没开";
}

function cardOf(
  game: Game,
  engine: PlayerEngine | undefined,
  detection: DetectionResult | undefined,
): GameCard {
  const title = gameHeading(game.key);
  if (engine === undefined) {
    return {
      game: game.key,
      title,
      loaded: false,
      link: "down",
      linkText: idleText(game, detection),
      status: "",
      place: "",
      party: [],
      busy: null,
      last: null,
      saveSlot: gameDefaults(game.key).saveSlot,
    };
  }
  const link = linkOf(engine);
  // Only a fresh live sample describes the game now; after a disconnect the cached sample is
  // yesterday's state, so status, place and party stay empty instead (task 24 review).
  const sample = link.link === "up" ? (engine.events?.liveSample() ?? null) : null;
  const busy = engine.activity.busy;
  return {
    game: game.key,
    title,
    loaded: true,
    link: link.link,
    linkText: link.linkText,
    status: sceneStatus(sample),
    place: placeName(sample),
    party: partyMembers(sample),
    busy: busy === null ? null : { name: busy.name, at: busy.at },
    last: lastOf(engine),
    saveSlot: engine.game.saveSlot,
  };
}

function saveCountOf(engine: PlayerEngine | undefined): number | null {
  const view = engine?.achievement;
  if (view === null || view === undefined) return null;
  for (const line of view.summary) {
    const matched = /存过\s*([\d,]+)\s*次/u.exec(line);
    if (matched?.[1] !== undefined) return Number.parseInt(matched[1].replaceAll(",", ""), 10);
  }
  return null;
}

function atbOf(sample: unknown): "等待" | "实时" | null {
  const value = text(record(record(sample).battle).atb);
  if (value === "wait") return "等待";
  if (value === "active") return "实时";
  return null;
}

/**
 * The one total-control card (task 40): title and running state, bridge version/link/ATB,
 * place, party rows, gil and saves, the running tool, and the last known time. With the bridge
 * down it still shows the last sample, marked with when it was seen.
 */
export function buildCurrentCard(
  gameKey: string,
  engine: PlayerEngine | undefined,
  detection: DetectionResult | undefined,
): CurrentCard {
  const game = byKey(gameKey);
  const running =
    detection?.ok === true
      ? detection.running.includes(game.key)
      : engine?.watcher?.connected === true;
  const link = linkOf(engine);
  // Tests build engines with a minimal `events`; older engines may lack these helpers.
  const events = engine?.events as unknown as
    | {
        lastSample?: () => {
          sample: unknown;
          at: string;
          live: boolean;
        } | null;
        liveSample?: () => unknown;
      }
    | undefined;
  const lastSample = events?.lastSample?.() ?? null;
  const live = events?.liveSample?.() ?? null;
  const sample = (
    link.link === "up" ? (live ?? lastSample?.sample ?? null) : (lastSample?.sample ?? null)
  ) as Json | null;
  const busy = engine?.activity.busy ?? null;
  const last = lastOf(engine);
  const user = record(record(sample).user);
  const mapId = num(user.mapId) ?? null;
  const knownAt =
    lastSample?.live === true ? new Date().toISOString() : lastSample?.at || last?.at || null;
  return {
    game: game.key,
    title: gameHeading(game.key),
    label: game.label,
    name: titleOf(game.key),
    running,
    statusText: running ? "运行中" : "没在运行",
    bridge: {
      version: engine?.events?.pluginVersion ?? null,
      connected: link.link === "up",
      atb: atbOf(sample),
    },
    place: {
      mapId,
      name: placeName(sample),
    },
    party: partyDetails(sample),
    gil: num(user.gil) ?? null,
    saveCount: num(user.saves) ?? saveCountOf(engine),
    busy: busy === null ? null : { name: busy.name, at: busy.at },
    last,
    lastKnownAt: knownAt,
    saveSlot: engine?.game.saveSlot ?? gameDefaults(game.key).saveSlot,
  };
}

/** Six cards in ff1 … ff6 order (unloaded games included) plus the filtered log. */
export function buildOverview(
  engineFor: EngineLookup,
  query: ActivityQuery = {},
  detection?: DetectionResult,
  currentGame?: string,
): Overview {
  const engines = GAMES.map((game) => engineFor(game.key));
  const logs = engines.flatMap((engine) => (engine === undefined ? [] : [engine.activity]));
  const currentKey = currentGame ?? query.game;
  return {
    at: new Date().toISOString(),
    games: GAMES.map((game, index) => cardOf(game, engines[index], detection)),
    current:
      currentKey === undefined || !GAMES.some((game) => game.key === currentKey)
        ? null
        : buildCurrentCard(currentKey, engineFor(currentKey), detection),
    log: mergeActivity(logs, query),
  };
}

/**
 * Start the one open game's engine in the background. It must not delay the reply, and a
 * failure (the game closed between detection and now, no token) only goes to the log; the next
 * request or turn retries.
 */
function startOpenGame(
  detection: DetectionResult,
  slotFor: SlotLookup,
  log: PlayerLog | undefined,
): void {
  if (!detection.ok || detection.running.length !== 1) return;
  const key = detection.running[0];
  if (key === undefined) return;
  const slot = slotFor(key);
  if (slot === undefined || slot.current() !== undefined) return;
  void slot.ensure().catch((error: unknown) => {
    log?.warn(`总控页启动 ${slot.game.toUpperCase()} 的引擎失败:${describeError(error)}`);
  });
}

/** The route is read-only and always 200: the page tolerates six "no player" cards. */
export function overviewRoute(
  engineFor: EngineLookup,
  slotFor: SlotLookup,
  detection: DetectionSource,
  log?: PlayerLog,
  current?: CurrentSource,
): ConnectionFetchRoute {
  return {
    path: OVERVIEW_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const url = new URL(request.url);
      const requested = url.searchParams.get("game")?.trim() ?? "";
      const game =
        requested !== ""
          ? requested
          : current === undefined
            ? ""
            : (await readCurrent(current)).game;
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
      const query: ActivityQuery = {
        since: url.searchParams.get("since") ?? undefined,
        game: game === "" ? undefined : game,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      };
      const snapshot = detection.peek();
      // Only a fresh answer may start an engine; a stale one may name a game the user already
      // closed. Either way the refresh runs in the background.
      if (snapshot.fresh && snapshot.result !== undefined) {
        startOpenGame(snapshot.result, slotFor, log);
      } else {
        void detection.detect().catch((error: unknown) => {
          log?.warn(`总控页检测笔记本上开着的作品失败:${describeError(error)}`);
        });
      }
      const body = {
        ok: true,
        ...buildOverview(engineFor, query, snapshot.result, game),
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    },
  };
}

export function installOverview(
  ctx: Context,
  engineFor: EngineLookup,
  slotFor: SlotLookup,
  detection: DetectionSource,
  log?: PlayerLog,
  current?: CurrentSource,
): void {
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(
        overviewRoute(engineFor, slotFor, detection, log, current),
      ),
    );
  });
}

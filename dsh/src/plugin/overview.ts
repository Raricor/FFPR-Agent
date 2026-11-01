/**
 * The six-game overview's route (task 24): GET /api/ffpr/overview returns one card per game
 * and the merged activity log. It reads only what each engine already holds (the cached sample,
 * the activity log, the running tool), so polling it never takes the bridge lock from a player.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import type { ActivityEntry, ActivityKind, ActivityQuery } from "../engine/activity.ts";
import { mergeActivity } from "../engine/activity.ts";
import { GAMES, type Game } from "../engine/games.ts";
import { partyMembers, placeName, sceneStatus } from "../engine/status.ts";
import { gameDefaults } from "./config.ts";
import type { EngineLookup } from "./panel.ts";
import type { PlayerEngine } from "./player.ts";

export const OVERVIEW_ROUTE = "/api/ffpr/overview";

/** The Chinese names the overview cards show; FF5 keeps its roman numeral from the task. */
const TITLES: Readonly<Record<string, string>> = {
  ff1: "最终幻想",
  ff2: "最终幻想II",
  ff3: "最终幻想III",
  ff4: "最终幻想IV",
  ff5: "最终幻想V",
  ff6: "最终幻想VI",
};

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
  readonly party: readonly { readonly name: string; readonly hp: number; readonly maxHp: number }[];
  readonly busy: { readonly name: string; readonly at: string } | null;
  readonly last: OverviewLast | null;
  readonly saveSlot: number;
}

export interface Overview {
  readonly at: string;
  readonly games: readonly GameCard[];
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

function cardOf(game: Game, engine: PlayerEngine | undefined): GameCard {
  const link = linkOf(engine);
  // Only a fresh live sample describes the game now; after a disconnect the cached sample is
  // yesterday's state, so status, place and party stay empty instead (task 24 review).
  const sample = link.link === "up" ? (engine?.events?.liveSample() ?? null) : null;
  const loaded = engine !== undefined;
  const busy = engine?.activity.busy;
  return {
    game: game.key,
    title: `${game.label} · ${TITLES[game.key] ?? game.title}`,
    loaded,
    link: link.link,
    linkText: link.linkText,
    status: loaded ? sceneStatus(sample) : "",
    place: loaded ? placeName(sample) : "",
    party: loaded ? partyMembers(sample) : [],
    busy: busy === undefined || busy === null ? null : { name: busy.name, at: busy.at },
    last: lastOf(engine),
    saveSlot: engine?.game.saveSlot ?? gameDefaults(game.key).saveSlot,
  };
}

/** Six cards in ff1 … ff6 order (unloaded games included) plus the filtered log. */
export function buildOverview(engineFor: EngineLookup, query: ActivityQuery = {}): Overview {
  const engines = GAMES.map((game) => engineFor(game.key));
  const logs = engines.flatMap((engine) => (engine === undefined ? [] : [engine.activity]));
  return {
    at: new Date().toISOString(),
    games: GAMES.map((game, index) => cardOf(game, engines[index])),
    log: mergeActivity(logs, query),
  };
}

/** The route is read-only and always 200: the page tolerates six "no player" cards. */
export function overviewRoute(engineFor: EngineLookup): ConnectionFetchRoute {
  return {
    path: OVERVIEW_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: (request) => {
      const url = new URL(request.url);
      const game = url.searchParams.get("game")?.trim() ?? "";
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
      const query: ActivityQuery = {
        since: url.searchParams.get("since") ?? undefined,
        game: game === "" ? undefined : game,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      };
      const body = { ok: true, ...buildOverview(engineFor, query) };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }),
      );
    },
  };
}

export function installOverview(ctx: Context, engineFor: EngineLookup): void {
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register(overviewRoute(engineFor)));
  });
}

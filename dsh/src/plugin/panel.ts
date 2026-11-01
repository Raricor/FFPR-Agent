/**
 * The sidebar's read-only routes (task 14, task 24): GET /api/ffpr/achievements and
 * GET /api/ffpr/tactics answer for the game named by `?game=ffN`, so one registration serves
 * all six players. The connection service only exists in a web composition, so it is injected
 * optionally (Cordis `ctx.inject([...], callback)`), not listed in the plugin's required inject
 * array.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { type BestiaryAreaCache } from "../engine/achievements.ts";
import { type MonsterCache } from "../engine/bestiary.ts";
import { parseEncounters, type EncounterTable } from "../engine/encounters.ts";
import { describeError } from "../engine/errors.ts";
import { CalledProcessError } from "../engine/laptop.ts";
import { LinkError } from "../engine/bridge.ts";
import { byKey, type Game } from "../engine/games.ts";
import { createPilot } from "../engine/link-pilot.ts";
import { profileFor } from "../engine/profiles/index.ts";
import type { GameProfile } from "../engine/profiles/types.ts";
import { heldItems } from "../engine/skills/battle.ts";
import { inBattle as inBattleOf, placeName as placeNameOf } from "../engine/status.ts";
import { Tactics } from "../engine/tactics.ts";
import { tacticsView, type TacticsPanelView } from "../engine/tactics-view.ts";
import { num, record, records, truthy } from "../engine/values.ts";
import { currentGame, readAchievementView, type CommandPilotFactory } from "./commands.ts";
import type { PlayerEngine } from "./player.ts";

export const ACHIEVEMENTS_ROUTE = "/api/ffpr/achievements";
export const TACTICS_ROUTE = "/api/ffpr/tactics";

/** The root panel entry's way to find the player preset that started one game's engine. */
export type EngineLookup = (game: string) => PlayerEngine | undefined;

type GameChoice =
  { readonly ok: true; readonly game: Game } | { readonly ok: false; readonly error: string };

/**
 * `?game=ffN`, defaulting to ff5 so the old FF5 pages keep working; an unknown key reports the
 * Chinese unknown-game error instead of picking an engine.
 */
function requestedGame(request: Request): GameChoice {
  const raw = new URL(request.url).searchParams.get("game");
  const key = raw === null || raw.trim() === "" ? "ff5" : raw.trim();
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
): ConnectionFetchRoute {
  return {
    path: ACHIEVEMENTS_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = requestedGame(request);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      const engine = engineFor(choice.game.key);
      if (engine === undefined) {
        return json({ ok: false, error: `${choice.game.label} 玩家没有加载`, at });
      }
      const result = await readAchievementView(engine, request.signal, pilotFor, monsterCache);
      return result.ok
        ? json({ ok: true, view: result.view, at })
        : json({ ok: false, error: result.error, at });
    },
  };
}

function defaultTacticsPilot(engine: PlayerEngine, signal: AbortSignal) {
  return createPilot(engine.laptop, engine.bridge, signal, { game: engine.game.game });
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
): ConnectionFetchRoute {
  return {
    path: TACTICS_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const at = new Date().toISOString();
      const choice = requestedGame(request);
      if (!choice.ok) return json({ ok: false, error: choice.error, at });
      const engine = engineFor(choice.game.key);
      if (engine === undefined) {
        return json({
          ok: true,
          view: emptyTacticsView(choice.game, `${choice.game.label} 玩家没有加载`),
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
): void {
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(achievementRoute(engineFor, pilotFor, monsterCache)),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(
        tacticsRoute(engineFor, pilotFor, monsterCache, bestiaryCache),
      ),
    );
  });
}

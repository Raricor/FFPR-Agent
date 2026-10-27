/**
 * The sidebar's read-only route (task 14): GET /api/ffpr/achievements returns the same
 * AchievementView `/ach` renders, so the browser never reads the game itself. The connection
 * service only exists in a web composition, so it is injected optionally (Cordis
 * `ctx.inject([...], callback)`), not listed in the plugin's required inject array.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { type BestiaryAreaCache } from "../engine/achievements.ts";
import { type MonsterCache } from "../engine/bestiary.ts";
import { parseEncounters, type EncounterTable } from "../engine/encounters.ts";
import { describeError } from "../engine/errors.ts";
import { CalledProcessError } from "../engine/laptop.ts";
import { LinkError } from "../engine/bridge.ts";
import { createPilot } from "../engine/link-pilot.ts";
import { heldItems } from "../engine/skills/battle.ts";
import { tacticsView, type TacticsPanelView } from "../engine/tactics-view.ts";
import { num, record, records, truthy } from "../engine/values.ts";
import { readAchievementView, type CommandPilotFactory } from "./commands.ts";
import type { PlayerEngine } from "./player.ts";

export const ACHIEVEMENTS_ROUTE = "/api/ffpr/achievements";
export const TACTICS_ROUTE = "/api/ffpr/tactics";

/** One exact Fetch route; owner authentication and cookies are handled by the connection. */
export function achievementRoute(
  engine: PlayerEngine,
  pilotFor?: CommandPilotFactory,
  monsterCache?: MonsterCache,
): ConnectionFetchRoute {
  return {
    path: ACHIEVEMENTS_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const result = await readAchievementView(engine, request.signal, pilotFor, monsterCache);
      const at = new Date().toISOString();
      const body = result.ok
        ? { ok: true, view: result.view, at }
        : { ok: false, error: result.error, at };
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

function defaultTacticsPilot(engine: PlayerEngine, signal: AbortSignal) {
  return createPilot(engine.laptop, engine.bridge, signal);
}

function downView(engine: PlayerEngine, status = "连不上桥插件，游戏可能没开"): TacticsPanelView {
  return {
    ...tacticsView({
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
    const sample = record((await pilot.query("sample")).sample);
    const mapId = num(record(sample.user).mapId) ?? null;
    const areaId = num(record(sample.user).areaId) ?? null;
    const party = records(sample.party);
    let items: Record<string, number> = {};
    try {
      items = await heldItems(pilot);
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
    const monsters = monsterCache === undefined ? null : await monsterCache.load(pilot, signal);
    const bestiary = bestiaryCache === undefined ? null : await bestiaryCache.load(pilot, signal);
    let pos: Record<string, unknown> = {};
    try {
      pos = record((await pilot.send("pos")).pos);
    } catch {
      // The sample's battle flag is enough when an older pilot has no pos answer.
      signal.throwIfAborted();
    }
    const inBattle =
      truthy(pos.battle) || pos.state === "Battle" || truthy(record(sample.battle).active);
    return tacticsView({
      mapId,
      areaId,
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
  engine: PlayerEngine,
  pilotFor?: CommandPilotFactory,
  monsterCache?: MonsterCache,
  bestiaryCache?: BestiaryAreaCache,
): ConnectionFetchRoute {
  return {
    path: TACTICS_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const view = await readTacticsView(
        engine,
        request.signal,
        pilotFor,
        monsterCache,
        bestiaryCache,
      );
      const at = new Date().toISOString();
      return new Response(JSON.stringify({ ok: true, view, at }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    },
  };
}

/**
 * Register the route on the plugin's ctx when this deployment has a connection service. Without
 * one (a non-web profile) the callback never runs: no route, no error.
 */
export function installPanel(
  ctx: Context,
  engine: PlayerEngine,
  pilotFor?: CommandPilotFactory,
  monsterCache?: MonsterCache,
  bestiaryCache?: BestiaryAreaCache,
): void {
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(achievementRoute(engine, pilotFor, monsterCache)),
    );
    connectionCtx.effect(() =>
      connectionCtx.connection.fetch.register(
        tacticsRoute(engine, pilotFor, monsterCache, bestiaryCache),
      ),
    );
  });
}

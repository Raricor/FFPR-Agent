import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { BestiaryAreaCache } from "../src/engine/achievements.ts";
import type { BridgeLink } from "../src/engine/bridge.ts";
import { Tactics } from "../src/engine/tactics.ts";
import { currentGame } from "../src/plugin/commands.ts";
import { installPanel, TACTICS_ROUTE } from "../src/plugin/panel.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";
import { FakePilot } from "./fake-pilot.ts";

const REPLY = {
  achievements: {
    defs: [],
    account: [],
    save: {
      playTime: 61,
      saveCount: 2,
      chests: 1,
      hiddenItems: 0,
      treasure: [{ area: 12, name: "卡纳克城", type: 1, total: 5, open: 3 }],
    },
  },
};

/** A bridge whose only job is the hello product currentGame reads. */
function linkWith(product = "FINAL FANTASY V"): BridgeLink {
  return {
    health: () => Promise.resolve({ ok: true, hello: { product } }),
  } as unknown as BridgeLink;
}

function engine(): PlayerEngine {
  return { bridge: linkWith(), game: { game: "ff5" } } as unknown as PlayerEngine;
}

function tacticsEngine(
  tactics: Tactics,
  bridge: BridgeLink | undefined = linkWith(),
): PlayerEngine {
  return {
    bridge,
    game: {
      game: "ff5",
      tactics,
      mapNameOf: (mapId: number) => (mapId === 64 ? "火力船 机房" : ""),
      tacticianInfoFor: () => null,
      lastBossPlan: () => null,
      elements: null,
      events: undefined,
    },
  } as unknown as PlayerEngine;
}

function tacticsWithMap(): Tactics {
  const tactics = new Tactics();
  tactics.maps.set("64", {
    tables: [{ 巴兹: [{ do: "攻击" }] }],
    current: 0,
    results: [],
  });
  return tactics;
}

interface FakeServer {
  readonly ctx: Context;
  readonly routes: ConnectionFetchRoute[];
  readonly disposers: (() => void | Promise<void>)[];
}

function fakeContext(hasConnection: boolean): FakeServer {
  const routes: ConnectionFetchRoute[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  const child = {
    connection: {
      fetch: {
        register: (route: ConnectionFetchRoute) => {
          routes.push(route);
          return () => Promise.resolve();
        },
      },
    },
    effect: (start: () => () => Promise<void>) => {
      disposers.push(start());
    },
  };
  const ctx = {
    connection: hasConnection ? child.connection : undefined,
    effect: (start: () => () => void) => {
      disposers.push(start());
    },
    inject: (deps: readonly string[], callback: (scope: typeof child) => void) => {
      if (hasConnection && deps.includes("connection")) callback(child);
    },
  } as unknown as Context;
  return { ctx, routes, disposers };
}

void test("currentGame reads the hello product and falls back to the configured game", async () => {
  const signal = new AbortController().signal;
  const ff6: PlayerEngine = {
    bridge: linkWith("FINAL FANTASY VI"),
    game: { game: "ff5" },
  } as unknown as PlayerEngine;
  assert.equal((await currentGame(ff6, signal)).key, "ff6");
  const unknown = {
    bridge: linkWith("SOME OTHER GAME"),
    game: { game: "ff4" },
  } as unknown as PlayerEngine;
  assert.equal((await currentGame(unknown, signal)).key, "ff4");
});

void test("the panel route returns the view with no-store and an ISO timestamp", async () => {
  const server = fakeContext(true);
  const pilot = new FakePilot().onQuery("achievements", REPLY);
  installPanel(server.ctx, engine(), () => pilot);
  const route = server.routes[0];
  assert.ok(route);
  assert.equal(route.path, "/api/ffpr/achievements");
  assert.deepEqual(route.methods, ["GET"]);
  assert.equal(route.requestBody, "buffered");
  const response = await route.fetch(new Request("http://localhost/api/ffpr/achievements"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "ok" in body);
  assert.equal(body.ok, true);
  assert.ok("at" in body && typeof body.at === "string");
  assert.equal(Number.isNaN(Date.parse(body.at)), false);
  assert.ok("view" in body && typeof body.view === "object" && body.view !== null);
  assert.equal("title" in body.view ? body.view.title : undefined, "FF5 成就 · 当前存档");
  assert.deepEqual(pilot.calls, [{ kind: "query", q: "achievements", fields: {} }]);
});

void test("the route reports a down bridge with HTTP 200", async () => {
  const server = fakeContext(true);
  installPanel(server.ctx, { bridge: undefined } as unknown as PlayerEngine);
  const route = server.routes[0];
  assert.ok(route);
  const response = await route.fetch(new Request("http://localhost/api/ffpr/achievements"));
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "ok" in body);
  assert.equal(body.ok, false);
  assert.equal("error" in body ? body.error : undefined, "连不上桥插件，游戏可能没开");
});

void test("without a connection service no route is registered and nothing throws", () => {
  const server = fakeContext(false);
  installPanel(server.ctx, engine());
  assert.deepEqual(server.routes, []);
  assert.deepEqual(server.disposers, []);
});

void test("the tactics route returns the current map from the sample", async () => {
  const server = fakeContext(true);
  const pilot = new FakePilot()
    .onQuery("sample", {
      sample: {
        user: { mapId: 64 },
        party: [{ name: "巴兹", jobName: "骑士" }],
        battle: { active: false },
      },
    })
    .on("pos", { pos: { state: "Player", battle: false } })
    .onQuery("items", { items: { normal: [{ name: "恢复药", count: 2 }], important: [] } });
  installPanel(server.ctx, tacticsEngine(tacticsWithMap()), () => pilot);
  const route = server.routes.find((item) => item.path === TACTICS_ROUTE);
  assert.ok(route);
  const response = await route.fetch(new Request("http://localhost/api/ffpr/tactics"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "ok" in body);
  assert.equal(body.ok, true);
  assert.ok("view" in body && typeof body.view === "object" && body.view !== null);
  assert.equal("status" in body.view ? body.view.status : undefined, "当前地图：火力船 机房");
  assert.equal("current" in body.view && body.view.current !== null, true);
  assert.ok(pilot.calls.some((call) => call.kind === "query" && call.q === "items"));
});

void test("the tactics route caches the bestiary areas across requests", async () => {
  const server = fakeContext(true);
  const pilot = new FakePilot()
    .onQuery("sample", {
      sample: {
        user: { mapId: 64, areaId: 12 },
        party: [{ name: "巴兹", jobName: "骑士" }],
        battle: { active: false },
      },
    })
    .on("pos", { pos: { state: "Player", battle: false } })
    .onQuery("items", { items: { normal: [], important: [] } })
    .onQuery("achievements", {
      achievements: {
        defs: [],
        account: [],
        save: null,
        bestiary: {
          entries: [{ number: 38, name: "甲怪", registered: false, areas: [12] }],
          areas: { "12": "图尔村" },
        },
      },
    });
  const cache = new BestiaryAreaCache();
  installPanel(server.ctx, tacticsEngine(tacticsWithMap()), () => pilot, undefined, cache);
  const route = server.routes.find((item) => item.path === TACTICS_ROUTE);
  assert.ok(route);
  await route.fetch(new Request("http://localhost/api/ffpr/tactics"));
  await route.fetch(new Request("http://localhost/api/ffpr/tactics"));
  assert.equal(
    pilot.calls.filter((call) => call.kind === "query" && call.q === "achievements").length,
    1,
  );
});

void test("the tactics route still returns stored maps when the bridge is down", async () => {
  const server = fakeContext(true);
  // A default parameter turns an explicit undefined into its default, so set the field itself.
  const engine: PlayerEngine = { ...tacticsEngine(tacticsWithMap()), bridge: undefined };
  installPanel(server.ctx, engine);
  const route = server.routes.find((item) => item.path === TACTICS_ROUTE);
  assert.ok(route);
  const response = await route.fetch(new Request("http://localhost/api/ffpr/tactics"));
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "ok" in body);
  assert.equal(body.ok, true);
  assert.ok("view" in body && typeof body.view === "object" && body.view !== null);
  assert.equal("status" in body.view ? body.view.status : undefined, "连不上桥插件，游戏可能没开");
  assert.equal("current" in body.view ? body.view.current : "missing", null);
  assert.equal(
    "others" in body.view && Array.isArray(body.view.others) ? body.view.others.length : 0,
    1,
  );
});

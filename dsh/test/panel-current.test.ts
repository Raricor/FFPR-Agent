import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { CURRENT_ROUTE, currentRoute, type CurrentSource } from "../src/plugin/current.ts";
import {
  BOOK_ROUTE,
  PLAN_ROUTE,
  PLAYER_ROUTE,
  TACTICIAN_ROUTE,
  WALK_ROUTE,
  installPanel,
  playerRoute,
  tacticianRoute,
} from "../src/plugin/panel.ts";

interface FakeServer {
  readonly ctx: Context;
  readonly routes: ConnectionFetchRoute[];
}

function fakeContext(): FakeServer {
  const routes: ConnectionFetchRoute[] = [];
  const child = {
    connection: {
      fetch: {
        register: (route: ConnectionFetchRoute) => {
          routes.push(route);
          return () => Promise.resolve();
        },
      },
    },
    effect: (start: () => () => Promise<void>) => start(),
  };
  const ctx = {
    effect: (start: () => () => void) => start(),
    inject: (deps: readonly string[], callback: (scope: typeof child) => void) => {
      if (deps.includes("connection")) callback(child);
    },
  } as unknown as Context;
  return { ctx, routes };
}

const SOURCE: CurrentSource = {
  detection: {
    peek: () => ({ result: { ok: true, running: ["ff5"] }, fresh: true, pending: false }),
  },
  engines: () => [],
};

void test("GET /api/ffpr/current names the one open game", async () => {
  const route = currentRoute(SOURCE);
  assert.equal(route.path, CURRENT_ROUTE);
  const body = (await (
    await route.fetch(new Request("http://localhost/api/ffpr/current"))
  ).json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.game, "ff5");
  assert.equal(body.running, true);
  assert.equal(body.title, "FF5 · 最终幻想V");
});

void test("player and tactician routes answer from files when their engine is not started", async () => {
  const player = playerRoute(() => undefined);
  const playerBody = (await (
    await player.fetch(new Request("http://localhost/api/ffpr/player?game=ff4"))
  ).json()) as Record<string, unknown>;
  assert.equal(playerBody.ok, true);
  assert.ok(playerBody.view);
  const tactician = tacticianRoute(() => undefined);
  const tacticianBody = (await (
    await tactician.fetch(new Request("http://localhost/api/ffpr/tactician?game=ff4"))
  ).json()) as Record<string, unknown>;
  assert.equal(tacticianBody.ok, true);
  assert.ok(tacticianBody.view);
  const view = tacticianBody.view as Record<string, unknown>;
  assert.match(String(view.status), /没在运行/u);
});

void test("installPanel registers the eight read routes", () => {
  const server = fakeContext();
  installPanel(server.ctx, () => undefined);
  assert.deepEqual(
    server.routes.map((route) => route.path),
    [
      "/api/ffpr/achievements",
      "/api/ffpr/tactics",
      "/api/ffpr/battles",
      PLAYER_ROUTE,
      TACTICIAN_ROUTE,
      WALK_ROUTE,
      BOOK_ROUTE,
      PLAN_ROUTE,
    ],
  );
});

void test("installPanel adds the current-game route when it has a current source", () => {
  const server = fakeContext();
  installPanel(server.ctx, () => undefined, undefined, undefined, undefined, SOURCE);
  assert.equal(server.routes[0]?.path, CURRENT_ROUTE);
});

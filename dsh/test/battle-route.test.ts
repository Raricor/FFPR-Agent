import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { BattleLog } from "../src/engine/battle-record.ts";
import { BATTLES_ROUTE, installPanel } from "../src/plugin/panel.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";

interface FakeServer {
  readonly ctx: Context;
  readonly routes: ConnectionFetchRoute[];
  readonly disposers: (() => void | Promise<void>)[];
}

function fakeContext(): FakeServer {
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
    effect: (start: () => () => void) => {
      disposers.push(start());
    },
    inject: (deps: readonly string[], callback: (scope: typeof child) => void) => {
      if (deps.includes("connection")) callback(child);
    },
  } as unknown as Context;
  return { ctx, routes, disposers };
}

function engineWith(battles: BattleLog): PlayerEngine {
  return { game: { battles } } as unknown as PlayerEngine;
}

async function logWithRecord(): Promise<BattleLog> {
  const log = await BattleLog.load("ff5", undefined);
  const session = log.start({
    mapId: 229,
    mapName: "北山",
    boss: false,
    enemies: [{ name: "哥布林", id: 1, maxHp: 100, hp: 100, mp: null, status: [], boss: false }],
    party: [{ name: "巴兹", id: null, maxHp: 100, hp: 50, mp: 10, status: [], boss: false }],
    table: { kind: "map", mapId: 229, table: 1 },
    startedAt: "2026-11-03T10:00:00.000Z",
    startedMs: 0,
  });
  session.turn(
    {
      actor: "巴兹",
      rule: 1,
      condition: "ally.hp_pct(50) < 60",
      skipped: [],
      command: "攻击",
      ability: "",
      targetName: "哥布林",
      done: "攻击→哥布林",
      item: null,
      beforeEnemies: [{ name: "哥布林", hp: 100, maxHp: 100 }],
      afterEnemies: [{ name: "哥布林", hp: 90, maxHp: 100 }],
      beforePlayers: [{ name: "巴兹", hp: 50, maxHp: 100 }],
      afterPlayers: [{ name: "巴兹", hp: 48, maxHp: 100 }],
    },
    1000,
  );
  await session.finish(12_000, "ok", "全队 HP 48%");
  return log;
}

function bodyOf(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null);
  return value as Record<string, unknown>;
}

function battlesRouteOf(server: FakeServer): ConnectionFetchRoute {
  const route = server.routes.find((item) => item.path === BATTLES_ROUTE);
  assert.ok(route);
  return route;
}

void test("the battles route shows the live battle and the recent summaries", async () => {
  const server = fakeContext();
  const log = await logWithRecord();
  log.start({
    mapId: 229,
    mapName: "北山",
    boss: true,
    enemies: [{ name: "巨翼猛禽", id: 281, maxHp: 500, hp: 400, mp: null, status: [], boss: true }],
    party: [{ name: "巴兹", id: null, maxHp: 100, hp: 48, mp: 10, status: [], boss: false }],
    table: { kind: "boss", mapId: 229 },
    startedAt: "2026-11-03T10:01:00.000Z",
    startedMs: 0,
  });
  installPanel(server.ctx, () => engineWith(log));
  const route = battlesRouteOf(server);
  const body = bodyOf(
    await (await route.fetch(new Request("http://localhost/api/ffpr/battles"))).json(),
  );
  assert.equal(body.ok, true);
  const live = bodyOf(body.live);
  assert.equal(live.title, "首领战 · 地图 229 北山");
  assert.equal((live.enemies as unknown[]).length, 1);
  assert.equal((body.recent as unknown[]).length, 1);
});

void test("the battles route without a battle returns a null live view", async () => {
  const server = fakeContext();
  const log = await logWithRecord();
  installPanel(server.ctx, () => engineWith(log));
  const route = battlesRouteOf(server);
  const body = bodyOf(
    await (await route.fetch(new Request("http://localhost/api/ffpr/battles?game=ff5"))).json(),
  );
  assert.equal(body.ok, true);
  assert.equal(body.live, null);
  const recent = body.recent as Record<string, unknown>[];
  assert.equal(recent.length, 1);
  assert.match(String(recent[0]?.line), /哥布林 赢 12 秒/);
});

void test("&id returns one full record", async () => {
  const server = fakeContext();
  const log = await logWithRecord();
  installPanel(server.ctx, () => engineWith(log));
  const route = battlesRouteOf(server);
  const body = bodyOf(
    await (await route.fetch(new Request("http://localhost/api/ffpr/battles?id=1"))).json(),
  );
  assert.equal(body.ok, true);
  const record = bodyOf(body.record);
  assert.equal(record.id, 1);
  assert.match(String(record.title), /第 1 场/);
  assert.equal((record.turns as unknown[]).length, 1);
  assert.match(String((record.hits as string[])[0]), /巴兹 规则 1:1 次/);
});

void test("the battles route reads the file when the engine is not started", async () => {
  const server = fakeContext();
  installPanel(server.ctx, () => undefined);
  const route = battlesRouteOf(server);
  const body = bodyOf(
    await (await route.fetch(new Request("http://localhost/api/ffpr/battles?game=ff4"))).json(),
  );
  assert.equal(body.ok, true);
  assert.equal(body.live, null);
  assert.ok(Array.isArray(body.recent));
});

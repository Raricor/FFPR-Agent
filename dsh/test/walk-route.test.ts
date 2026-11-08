import assert from "node:assert/strict";
import test from "node:test";
import type { Cell, CellGrid } from "../src/engine/nav.ts";
import { beginWalk, worldBase, type WalkView } from "../src/engine/walk-view.ts";
import { WALK_ROUTE, walkRoute } from "../src/plugin/panel.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";

function view(): WalkView {
  const cells: CellGrid = {
    origin: [0, 0],
    center: [1, 1],
    attr: [
      [0, 0, 0, 16],
      [0, 0, 0, 16],
    ],
  };
  const path: Cell[] = [
    [1, 1],
    [2, 1],
  ];
  return beginWalk(
    worldBase("ff5", 30, cells),
    path,
    [2, 1],
    "go → 地图 30",
    "2026-11-05T05:12:03Z",
  );
}

function engineWith(walk: WalkView | null): PlayerEngine {
  return { game: { walkView: () => walk } } as unknown as PlayerEngine;
}

function bodyOf(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null);
  return value as Record<string, unknown>;
}

void test("GET /api/ffpr/walk returns the current game's walking view", async () => {
  const route = walkRoute(() => engineWith(view()));
  assert.equal(route.path, WALK_ROUTE);
  const body = bodyOf(
    await (await route.fetch(new Request("http://localhost/api/ffpr/walk?game=ff5"))).json(),
  );
  assert.equal(body.ok, true);
  const walk = bodyOf(body.view);
  assert.equal(walk.game, "ff5");
  assert.equal(walk.map, 30);
  assert.deepEqual(walk.origin, [-2, -2]);
  assert.ok(Array.isArray(walk.rows) && walk.rows.length === 7);
  const display = bodyOf(walk.display);
  assert.equal(display.statusText, "正在走");
  assert.equal(display.progressText, "已走 0 / 1 格");
});

void test("GET /api/ffpr/walk returns null when this run has not walked", async () => {
  const route = walkRoute(() => undefined);
  const body = bodyOf(
    await (await route.fetch(new Request("http://localhost/api/ffpr/walk?game=ff4"))).json(),
  );
  assert.equal(body.ok, true);
  assert.equal(body.view, null);
});

void test("GET /api/ffpr/walk rejects an unknown game key", async () => {
  const route = walkRoute(() => engineWith(view()));
  const body = bodyOf(
    await (await route.fetch(new Request("http://localhost/api/ffpr/walk?game=ff9"))).json(),
  );
  assert.equal(body.ok, false);
  assert.match(String(body.error), /ff9|作品|游戏/u);
});

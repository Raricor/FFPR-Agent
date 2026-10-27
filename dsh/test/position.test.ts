import assert from "node:assert/strict";
import test from "node:test";
import { parsePositionReply, renderPosition, type Position } from "../src/engine/position.ts";

function position(overrides: Partial<Position> = {}): Position {
  return {
    map: 238,
    state: "Field",
    cell: [12, 7],
    dir: "Down",
    moving: false,
    dialog: false,
    battle: false,
    saves: 3,
    ...overrides,
  };
}

void test("where_am_i renders the example line in Chinese", () => {
  assert.equal(renderPosition(position()), "地图 238,格子 (12, 7),状态 Field,朝下");
});

void test("where_am_i says dialog and battle out loud", () => {
  assert.equal(
    renderPosition(position({ dialog: true, battle: true, moving: true })),
    "地图 238,格子 (12, 7),状态 Field,朝下,移动中,对话中,战斗中",
  );
});

void test("where_am_i maps all four directions and keeps an unknown one", () => {
  assert.match(renderPosition(position({ dir: "Up" })), /朝上$/);
  assert.match(renderPosition(position({ dir: "Left" })), /朝左$/);
  assert.match(renderPosition(position({ dir: "Right" })), /朝右$/);
  assert.match(renderPosition(position({ dir: "North" })), /朝North$/);
});

void test("where_am_i shows a missing cell and state as unknown", () => {
  assert.equal(
    renderPosition(position({ cell: null, state: null, dir: null })),
    "地图 238,格子 未知,状态 未知",
  );
});

void test("parsePositionReply reads the bridge's pos object", () => {
  assert.deepEqual(
    parsePositionReply({
      type: "reply",
      ok: true,
      pos: { map: 1, state: "Battle", cell: [2, 3], dir: "Up", moving: false },
    }),
    {
      map: 1,
      state: "Battle",
      cell: [2, 3],
      dir: "Up",
      moving: false,
      dialog: false,
      battle: false,
      saves: null,
    },
  );
});

void test("parsePositionReply turns a bridge failure into a Chinese error", () => {
  assert.throws(
    () => parsePositionReply({ type: "reply", ok: false, error: "地图还没加载" }),
    /查位置失败:地图还没加载/,
  );
  assert.throws(() => parsePositionReply({ type: "reply", ok: true }), /没有 pos/);
  assert.throws(
    () => parsePositionReply({ type: "reply", ok: true, pos: { cell: [1] } }),
    /pos\.cell/,
  );
});

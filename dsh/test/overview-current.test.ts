import assert from "node:assert/strict";
import test from "node:test";
import { ActivityLog } from "../src/engine/activity.ts";
import { buildCurrentCard } from "../src/plugin/overview.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";

function engine(): PlayerEngine {
  const sample = {
    user: {
      mapId: 64,
      areaText: "卡纳克",
      locationText: "旅店",
      gil: 1234,
      saves: 7,
    },
    party: [
      {
        name: "巴兹",
        jobName: "骑士",
        lv: 12,
        hp: 80,
        maxHp: 100,
        mp: 5,
        maxMp: 20,
      },
      {
        name: "蕾娜",
        jobName: "白魔法师",
        lv: 11,
        hp: 30,
        maxHp: 90,
        mp: 18,
        maxMp: 30,
      },
    ],
    battle: { active: true, atb: "wait" },
  };
  const activity = new ActivityLog({
    game: "ff5",
    now: () => new Date("2026-11-03T10:00:00Z"),
  });
  activity.beginTool("fight");
  return {
    bridge: {},
    watcher: { connected: true, error: null },
    events: {
      pluginVersion: "0.13.0",
      liveSample: () => sample,
      lastSample: () => ({
        sample,
        at: "2026-11-03T10:00:00.000Z",
        live: false,
      }),
    },
    activity,
    game: { saveSlot: 20 },
    achievement: { summary: ["存过 7 次"], rows: [], notes: [] },
  } as unknown as PlayerEngine;
}

void test("the total-control card shows bridge, ATB, place, party, gil, saves and the busy tool", () => {
  const card = buildCurrentCard("ff5", engine(), {
    ok: true,
    running: ["ff5"],
  });
  assert.equal(card.title, "FF5 · 最终幻想V");
  assert.equal(card.running, true);
  assert.equal(card.statusText, "运行中");
  assert.deepEqual(card.bridge, {
    version: "0.13.0",
    connected: true,
    atb: "等待",
  });
  assert.deepEqual(card.place, { mapId: 64, name: "卡纳克 旅店" });
  const baz = card.party[0];
  assert.ok(baz);
  assert.equal(baz.job, "骑士");
  assert.equal(baz.level, 12);
  assert.equal(baz.mp, 5);
  assert.equal(card.gil, 1234);
  assert.equal(card.saveCount, 7);
  assert.equal(card.busy?.name, "fight");
  assert.equal(card.lastKnownAt, "2026-11-03T10:00:00.000Z");
});

void test("a game that is not running keeps the last sample and marks the time", () => {
  const source = engine();
  const card = buildCurrentCard("ff5", source, { ok: true, running: [] });
  assert.equal(card.running, false);
  assert.equal(card.statusText, "没在运行");
  assert.equal(card.party.length, 2);
  assert.equal(card.lastKnownAt, "2026-11-03T10:00:00.000Z");
});

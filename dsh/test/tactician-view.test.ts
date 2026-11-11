import assert from "node:assert/strict";
import test from "node:test";
import type { BattleRecord } from "../src/engine/battle-record.ts";
import { Tactics } from "../src/engine/tactics.ts";
import { tacticianView } from "../src/engine/tactician-view.ts";
import type { TacticianCall } from "../src/engine/tactician-log.ts";

function tactics(): Tactics {
  const store = new Tactics();
  store.maps.set("64", {
    tables: [
      {
        巴兹: [{ if: "ally.hp_pct < 50", do: "白魔法:治疗" }, { do: "攻击" }],
        蕾娜: [{ do: "防御" }],
      },
    ],
    current: 0,
    results: [
      { table: 0, verdict: "ok", detail: "全队 HP 80%" },
      { table: 0, verdict: "hard", detail: "巴兹倒下" },
    ],
    walkerNotes: "先开开关",
    askUp: "缺眼药",
    writtenAt: "2026-11-03T10:00:00.000Z",
    boss: {
      table: { 巴兹: [{ do: "攻击" }] },
      result: "首领战全灭",
      at: "2026-11-03T10:05:00.000Z",
      rewrites: [{ reason: "换了形态", ok: true, summary: "新表" }],
    },
  });
  return store;
}

function records(): readonly BattleRecord[] {
  return [
    {
      table: { kind: "map", mapId: 64, table: 0 },
      turns: [
        {
          actor: "巴兹",
          rule: 1,
          skipped: [{ rule: 2, condition: "", why: "没有这个指令(现在是武僧)" }],
        },
        { actor: "巴兹", rule: 1, skipped: [] },
      ],
    },
    {
      table: { kind: "map", mapId: 64, table: 0 },
      turns: [
        {
          actor: "巴兹",
          rule: 1,
          skipped: [{ rule: 2, condition: "", why: "没有这个指令" }],
        },
      ],
    },
  ] as unknown as BattleRecord[];
}

function calls(): readonly TacticianCall[] {
  return [
    {
      at: "2026-11-03T10:00:00.000Z",
      mapId: 64,
      kind: "new-map",
      detail: "这张地图还没有战斗策略",
      tables: 1,
      problems: [],
      walkerFirst: "先开开关",
    },
  ];
}

void test("rules are strategy-2.0 Chinese with hit and skip counts per map table", () => {
  const view = tacticianView({
    game: "ff5",
    tactics: tactics(),
    records: records(),
    calls: calls(),
    mapId: 64,
    mapNameOf: (mapId) => (mapId === 64 ? "火力船 机房" : `地图 ${mapId}`),
  });
  assert.equal(view.status, "当前地图：火力船 机房");
  assert.ok(view.map);
  assert.equal(view.map.walkerNotes, "先开开关");
  assert.equal(view.map.askUp, "缺眼药");
  assert.equal(view.map.tables.length, 1);
  const table = view.map.tables[0];
  assert.ok(table);
  assert.equal(table.inUse, true);
  assert.match(table.recordText, /用过 2 次 · 赢 1 \/ 吃力 1 \/ 全灭 0/u);
  const baz = table.members.find((member) => member.name === "巴兹");
  assert.ok(baz);
  assert.match(baz.rules[0]?.text ?? "", /用白魔法「治疗」/u);
  assert.equal(baz.rules[0]?.hits, 3);
  const skipped = baz.rules[1];
  assert.ok(skipped);
  assert.equal(skipped.skipped, true);
  assert.match(skipped.skipText, /跳过 2 次：没有这个指令/u);
  assert.equal(skipped.hits, 0);
  assert.ok(view.map.boss);
  assert.equal(view.map.boss.result, "首领战全灭");
  assert.match(view.map.boss.rewrites[0] ?? "", /换了形态/u);
  assert.equal(view.calls.length, 1);
  assert.match(view.calls[0]?.line ?? "", /地图 64 · new-map/u);
});

void test("a game without an AI player says so and still lists stored maps", () => {
  const view = tacticianView({
    game: "ff6",
    tactics: tactics(),
    records: [],
    calls: [],
    mapId: null,
    mapNameOf: (mapId) => `地图 ${mapId}`,
  });
  assert.match(view.message ?? "", /还没有 AI 玩家/u);
  assert.equal(view.map, null);
  assert.deepEqual(
    view.others.map((other) => other.mapId),
    [64],
  );
  assert.equal(view.callsEmpty, "还没叫过战术官");
});

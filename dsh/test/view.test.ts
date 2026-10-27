import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  describeEntities,
  describeEvents,
  describeItems,
  eventNote,
  marks,
  namedObjects,
  parseTail,
  PLACEHOLDER_ITEMS,
  RIDES,
  summarize,
} from "../src/engine/view.ts";

interface ViewFixture {
  readonly items: { readonly input: unknown; readonly text: string };
  readonly entities: { readonly input: unknown; readonly text: string };
  readonly namedObjects: { readonly input: unknown; readonly out: Record<string, unknown> };
  readonly parseTail: { readonly text: string; readonly out: unknown[] };
  readonly marks: readonly { readonly unit: unknown; readonly out: string }[];
  readonly summarize: readonly {
    readonly sample: unknown;
    readonly events: unknown[];
    readonly text: string;
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "view", "view.json"), "utf8"),
) as ViewFixture;

void test("describeItems strips icon tags and empty-slot placeholders", () => {
  assert.equal(describeItems(fixture.items.input), fixture.items.text);
  assert.ok(PLACEHOLDER_ITEMS.has("空手"));
  assert.equal(
    describeItems({ normal: [{ name: "<IC_X>恢复药", count: 2 }], important: [] }),
    "道具:恢复药×2\n贵重物品:无",
  );
});

void test("describeEntities shows kind, cell and what it holds", () => {
  assert.equal(describeEntities(fixture.entities.input), fixture.entities.text);
  assert.match(fixture.entities.text, /共 5 个实体,列出 5 个:/);
  assert.match(fixture.entities.text, /TresureBox @ \[13, 54\] 宝箱 内容 フレイル×1/);
});

void test("describeEvents merges same-named cells and notes a conveyor", () => {
  const events = [
    { kind: "Event", name: "流される①", cell: [13, 23] },
    { kind: "Event", name: "流される①", cell: [13, 25] },
    { kind: "Event", name: "流される②", cell: [11, 9] },
    { kind: "Event", name: "流される②", cell: [12, 9] },
    { kind: "Event", name: "SavePoint", cell: [1, 2] },
    { kind: "Event", name: "", cell: [9, 9] },
  ];
  assert.equal(
    describeEvents(events),
    [
      "  Event @ [13, 23]、[13, 25] 流される① 传送带，踩上去会被带走",
      "  Event @ [11, 9]、[12, 9] 流される② 传送带，踩上去会被带走",
      "  Event @ [1, 2] SavePoint",
    ].join("\n"),
  );
  assert.equal(eventNote("流される③"), "传送带，踩上去会被带走");
  assert.equal(eventNote("SavePoint"), "");
});

void test("namedObjects keeps doors and drops props", () => {
  assert.deepEqual(namedObjects(fixture.namedObjects.input), fixture.namedObjects.out);
  assert.equal((namedObjects(fixture.namedObjects.input).entities as unknown[]).length, 3);
});

void test("parseTail skips a cut first line and unreadable records", () => {
  assert.deepEqual(parseTail(fixture.parseTail.text), fixture.parseTail.out);
  assert.deepEqual(parseTail('cut\n{"a":1}\nnot json\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseTail("only one line"), []);
});

void test("marks puts the statuses in brackets", () => {
  for (const item of fixture.marks) {
    assert.equal(marks(item.unit), item.out);
  }
  assert.equal(marks({ status: ["Poison", "Blind"] }), "[毒、黑暗]");
  assert.equal(marks({ name: "巴兹" }), "");
});

void test("summarize matches Python on real probe samples", () => {
  for (const item of fixture.summarize) {
    assert.equal(summarize(item.sample, item.events), item.text);
  }
  assert.deepEqual([...RIDES.keys()], ["LowFlying", "HighFlying", "Ship", "Chocobo"]);
});

void test("summarize shows the party, dialog, choice and battle state", () => {
  const sample = {
    scene: { name: "MainGame", state: "Player" },
    user: { mapId: 198, areaText: "海盗船", gil: 1360 },
    field: { cell: [20, 10] },
    battle: { active: false },
    dialog: { open: true, speaker: "巴兹", lines: ["好，我们出发吧！！"] },
  };
  const events = [{ seq: 1, type: "dialog.play", ids: ["E0012"], speaker: "巴兹", lines: ["好"] }];
  const text = summarize(sample, events);
  assert.ok(text.includes("MainGame/Player · 地图 198 海盗船 · 格子 20,10 · 非战斗 · 金钱 1360"));
  assert.ok(text.includes("对话框打开 【巴兹】好，我们出发吧！！"));
  assert.ok(text.includes("+ 对话 E0012 【巴兹】好"));
});

void test("summarize shows choice labels with the cursor", () => {
  const sample = {
    choice: { select: { open: true, options: [], labels: ["是", "否"], cursor: 1 } },
  };
  assert.ok(summarize(sample, []).includes("选项(select):是 / [否]"));
});

void test("summarize renders the ride and the battle sides", () => {
  const sample = {
    scene: { name: "MainGame", state: "Player" },
    user: { mapId: 1, areaText: "世界地图", gil: 10 },
    field: { cell: [140, 99], moveState: "Ship" },
    battle: {
      active: true,
      enemies: [{ name: "哥布林", hp: 16, maxHp: 16 }],
      players: [{ name: "巴兹", hp: 41, maxHp: 172, status: ["Poison"] }],
    },
    party: [{ name: "巴兹", lv: 7, hp: 41, maxHp: 172, status: ["Poison"] }],
  };
  const text = summarize(sample, [{ type: "sysmsg", text: "风之神殿　１层" }]);
  assert.ok(text.includes("· 坐船 · 战斗中"));
  assert.ok(text.includes("敌人:哥布林 16/16"));
  assert.ok(text.includes("我方:巴兹 41/172[毒]"));
  assert.ok(text.includes("队伍 巴兹 Lv7 41/172[毒]"));
  assert.ok(text.includes("+ 系统消息 风之神殿　１层"));
});

void test("summarize dumps unknown events like Python's json.dumps", () => {
  const text = summarize(null, [
    { seq: 3, t: "now", frame: 4, type: "map.change", from: 0, to: 1, toCell: [2, 3] },
  ]);
  assert.equal(text, '  + map.change {"from": 0, "to": 1, "toCell": [2, 3]}');
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { KeyEvents, Watcher, describe, shorten, version, WINDOWS } from "../src/engine/events.ts";
import { Builder } from "../src/engine/keylog.ts";
import type { KeyEntry } from "../src/engine/keylog.ts";
import type { Json } from "../src/engine/values.ts";

interface EventsFixture {
  readonly runs: readonly {
    readonly name: string;
    readonly records: readonly Json[];
    readonly stages: readonly {
      readonly feed: number;
      readonly now: string;
      readonly calls: readonly { readonly op: "window" | "news"; readonly layer: 1 | 2 }[];
      readonly expected: readonly string[];
    }[];
    readonly late: {
      readonly now: string;
      readonly calls: readonly { readonly op: "window" | "news"; readonly layer: 1 | 2 }[];
      readonly expected: readonly string[];
    };
    readonly entries: readonly KeyEntry[];
    readonly enemies: readonly { readonly mapId: unknown; readonly names: readonly string[] }[];
    readonly books: readonly { readonly name: string; readonly book: number }[];
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "events", "runs.json"), "utf8"),
) as EventsFixture;

function call(
  events: KeyEvents,
  calls: EventsFixture["runs"][number]["stages"][number]["calls"],
): string[] {
  return calls.map((request) =>
    request.op === "window" ? events.window(request.layer) : events.news(request.layer),
  );
}

for (const run of fixture.runs) {
  void test(`KeyEvents matches Python on real probe ${run.name}`, () => {
    let now = new Date();
    const events = new KeyEvents(() => now);
    let fed = 0;
    for (const stage of run.stages) {
      for (const record of run.records.slice(fed, stage.feed)) events.feed(record, false);
      fed = stage.feed;
      now = new Date(stage.now);
      assert.deepEqual(call(events, stage.calls), stage.expected);
    }
    assert.deepEqual(events.entries, run.entries);
    assert.deepEqual(normalizeEnemies(events), run.enemies);
    assert.deepEqual(
      [...events.books]
        .map(([name, book]) => ({ name, book }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      run.books,
    );

    const lateNow = new Date(run.late.now);
    const late = new KeyEvents(() => lateNow);
    for (const record of run.records) late.feed(record, false);
    assert.deepEqual(call(late, run.late.calls), run.late.expected);
  });
}

type Body = Record<string, unknown>;

function rec(seq: number, sec: number, type: string, body: Body = {}): Json {
  const minute = Math.floor(sec / 60);
  const second = sec % 60;
  return {
    seq,
    t: `2026-10-20T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`,
    type,
    ...body,
  };
}

function sample(
  seq: number,
  sec: number,
  options: {
    names?: readonly string[];
    hp?: number;
    battle?: Json;
    mapId?: number;
    wins?: number;
    escapes?: number;
  } = {},
): Json {
  const names = options.names ?? ["巴兹", "蕾娜", "加拉夫", "法利斯"];
  const party = names.map((name) => ({ name, lv: 7, hp: options.hp ?? 50 }));
  const user = {
    mapId: options.mapId ?? 30,
    areaText: "图尔村",
    gil: 100,
    wins: options.wins,
    escapes: options.escapes,
  };
  return rec(seq, sec, "sample", {
    user,
    party,
    battle: options.battle ?? { active: false },
  });
}

function line(seq: number, sec: number, scene: string, speaker: string, text: string): Json {
  return rec(seq, sec, "dialog.play", {
    ids: [`${scene}_a_01`],
    speaker,
    lines: [text],
  });
}

function entries(records: readonly Json[]): [string, string, string][] {
  const builder = new Builder("r");
  for (const record of records) builder.feed(record);
  return builder.entries.map((entry) => [entry.type, entry.text, entry.progress]);
}

function at(minute: number): Date {
  return new Date(`2026-10-20T20:${String(minute).padStart(2, "0")}:00+08:00`);
}

function normalizeEnemies(events: KeyEvents): { mapId: unknown; names: string[] }[] {
  return [...events.enemies]
    .map(([mapId, names]) => ({ mapId, names: [...names].sort() }))
    .sort((left, right) => String(left.mapId).localeCompare(String(right.mapId)));
}

void test("who leaves and joins the party", () => {
  const got = entries([
    sample(1, 0, { names: [] }), // title screen: no party yet, no entry
    sample(2, 1),
    sample(3, 2, { names: ["巴兹", "蕾娜", "加拉夫"] }), // 10-20: Faris left entering Tule
    sample(4, 3, { names: [] }), // loading a save: not a change
    sample(5, 4),
  ]);
  assert.deepEqual(
    got.filter((entry) => entry[0] === "party"),
    [
      ["party", "法利斯 离队", "队伍 3 人"],
      ["party", "法利斯 入队", "队伍 4 人"],
    ],
  );
});

void test("story lines gather into one entry per scene", () => {
  const got = entries([
    line(1, 0, "E0001_00_071", "蕾娜", "父王！"),
    line(2, 3, "E0001_00_071", "泰空王", "蕾娜，你要保护城堡。"),
    line(3, 6, "E0001_00_071", "", "风停了！"),
    line(4, 9, "E0002_00_010", "巴兹", "那是？"),
    line(5, 300, "E0002_00_010", "巴兹", "那是？"), // the scene again, minutes later
    rec(6, 301, "dialog.play", { ids: ["N0001_a_01"], speaker: "村民", lines: ["你好"] }),
  ]);
  assert.deepEqual(got, [
    ["story", "蕾娜:父王！ …… 风停了！", "3 句"],
    ["story", "巴兹:那是？", "1 句"],
    ["story", "巴兹:那是？", "1 句"],
  ]);
});

void test("boss start win and defeat from the game counters", () => {
  const fight = { active: true, boss: true, enemies: [{ name: "卡拉波斯" }] };
  const goblin = { active: true, enemies: [{ name: "哥布林" }] };
  const got = entries([
    sample(1, 0, { wins: 20, escapes: 0 }),
    sample(2, 1, { battle: fight, wins: 20, escapes: 0 }),
    sample(3, 2, { battle: fight, wins: 20, escapes: 0 }),
    sample(4, 3, { wins: 21, escapes: 0 }), // won
    sample(5, 4, { battle: fight, wins: 21, escapes: 0 }),
    sample(6, 5, { hp: 0, wins: 21, escapes: 0 }), // everyone down: lost
    sample(7, 6, { battle: goblin, wins: 21, escapes: 0 }),
    sample(8, 7, { wins: 21, escapes: 1 }), // fled a regular battle: no entry
  ]);
  assert.deepEqual(
    got
      .filter((entry) => ["bossfight", "boss", "defeat"].includes(entry[0]))
      .map((entry) => entry.slice(0, 2)),
    [
      ["bossfight", "开始:「卡拉波斯」"],
      ["boss", "击败「卡拉波斯」"],
      ["bossfight", "开始:「卡拉波斯」"],
      ["defeat", "全灭:「卡拉波斯」"],
    ],
  );
});

void test("shorten keeps the first and last lines", () => {
  const lines = [
    "甲".repeat(10),
    "乙".repeat(10),
    "丙".repeat(10),
    "丁".repeat(10),
    "戊".repeat(10),
  ];
  assert.equal(shorten(lines, 100), lines.join(" / "));
  assert.equal(
    shorten(lines, 30),
    `${"甲".repeat(10)} / ${"乙".repeat(10)} / …… / ${"戊".repeat(10)}`,
  );
  assert.equal(shorten(["长".repeat(50)], 20), `${"长".repeat(20)} / ……`);
});

void test("seed then stream without doubles and a restart starts a new run", () => {
  const hello = rec(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.5.2" });
  const events = new KeyEvents(() => at(30));
  for (const record of [hello, sample(2, 1), sample(3, 2, { names: ["巴兹", "蕾娜", "加拉夫"] })]) {
    events.feed(record, false);
  }
  // The stream resends the hello and may overlap what the file held.
  for (const record of [hello, sample(3, 2, { names: ["巴兹", "蕾娜", "加拉夫"] }), sample(4, 3)]) {
    events.feed(record);
  }
  assert.deepEqual(
    events.entries.filter((entry) => entry.type === "party").map((entry) => entry.text),
    ["法利斯 离队", "法利斯 入队"],
  );
  const restarted = rec(1, 600, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.5.2" });
  events.feed(restarted);
  events.feed(sample(2, 601)); // seq starts again at 1 in the new run
  assert.equal(events.entries.filter((entry) => entry.type === "run").length, 2);
  assert.notEqual(events.liveSample(), null);
});

void test("windows per layer and news since the last read", () => {
  let now = at(30);
  const events = new KeyEvents(() => now);
  events.feed(rec(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.5.2" }));
  events.feed(rec(2, 0, "save.write", { slot: 3, result: "Success" })); // 20:00 local
  events.feed(sample(3, 1500)); // 20:25
  events.feed(sample(4, 1501, { names: ["巴兹", "蕾娜", "加拉夫"] }));
  const strategy = events.window(1);
  const tactics = events.window(2);
  assert.ok(strategy.includes("存档到 3 号位") && strategy.includes("法利斯 离队"));
  assert.ok(!tactics.includes("存档") && tactics.includes("法利斯 离队"));
  assert.equal(events.news(), ""); // the window was read: nothing new
  events.feed(line(5, 1502, "E0003_00_001", "巴兹", "法利斯去哪了？"));
  assert.equal(events.news(), "20:25 剧情 巴兹:法利斯去哪了？(1 句)");
  events.feed(line(6, 1503, "E0003_00_001", "加拉夫", "去酒馆看看。"));
  assert.ok(events.news().includes("去酒馆看看")); // the scene grew
  assert.equal(events.news(), "");
  now = at(59);
  assert.equal(events.window(2), "");
});

void test("minutes since the last save", () => {
  const events = new KeyEvents(() => at(30));
  events.feed(rec(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.6.4" }));
  assert.equal(events.lastSaveMinutes(), null);
  events.feed(rec(2, 600, "save.write", { slot: 3, result: "Success" })); // 20:10 local
  assert.equal(events.lastSaveMinutes(), 20);
});

void test("purchases told by the tools stay in the windows", () => {
  const events = new KeyEvents(() => at(30));
  events.note("buy", "买了「催眠」×1,花了 300");
  assert.ok(events.window(1).includes("20:30 购买 买了「催眠」×1,花了 300"));
  assert.ok(events.window(2).includes("购买"));
});

void test("monsters met are kept per map", () => {
  const events = new KeyEvents(() => at(30));
  events.feed(rec(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.6.8" }));
  const fight = { active: true, enemies: [{ name: "小妖魔" }] };
  events.feed(sample(2, 1, { battle: fight, mapId: 64 }));
  assert.deepEqual(events.enemies.get(64), new Set(["小妖魔"]));
});

void test("bestiary numbers only from bridges that send the shown ones", () => {
  const events = new KeyEvents(() => at(30));
  const fight: Json = { active: true, enemies: [{ name: "寒冰士兵", book: 30 }] };
  events.feed(rec(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.6.9" }), false);
  events.feed(sample(2, 1, { battle: fight, mapId: 238 }), false);
  assert.equal(events.books.size, 0); // an entry id from an old bridge
  events.feed(rec(1, 60, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.7.2" }));
  const enemies = fight.enemies as { book: number }[];
  const first = enemies[0];
  if (first) first.book = 26;
  events.feed(sample(2, 61, { battle: fight, mapId: 238 }));
  assert.deepEqual(events.books, new Map([["寒冰士兵", 26]]));
});

void test("version compares like a Python tuple", () => {
  assert.deepEqual(version("0.7.2"), [0, 7, 2]);
  assert.deepEqual(version("bad"), [0]);
  assert.deepEqual(WINDOWS[1].minutes, 240);
});

void test("watcher reconnects after a dropped stream until the signal aborts", async () => {
  const hello = rec(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.7.2" });
  const events = new KeyEvents(() => at(30));
  const controller = new AbortController();
  let attempts = 0;
  const stream = async function* (signal: AbortSignal): AsyncIterable<Json> {
    await Promise.resolve();
    attempts += 1;
    if (attempts === 1) {
      yield hello;
      throw new Error("连接断开");
    }
    yield sample(2, 61);
    controller.abort(signal.reason);
  };
  const watcher = new Watcher(stream, events, 0.01);
  await watcher.run(controller.signal);
  assert.equal(attempts, 2);
  assert.equal(events.entries.filter((entry) => entry.type === "run").length, 1);
  assert.equal(events.entries.filter((entry) => entry.type === "place").length, 1);
});

void test("describe keeps story lines short and progress in parentheses", () => {
  const entries_: KeyEntry[] = [
    {
      ts: "2026-10-20T20:25:00+08:00",
      run: "",
      seq: null,
      key: true,
      type: "story",
      text: "x",
      progress: "1 句",
      data: { scene: "E1", lines: ["甲".repeat(20), "乙".repeat(20)] },
    },
  ];
  assert.equal(
    describe(entries_, 20),
    "20:25 剧情 甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲 / ……(1 句)",
  );
});

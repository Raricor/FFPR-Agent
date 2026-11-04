import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Builder, type KeyEntry } from "../src/engine/keylog.ts";
import type { Json } from "../src/engine/values.ts";

interface KeylogFixture {
  readonly runs: readonly {
    readonly name: string;
    readonly records: readonly Json[];
    readonly entries: readonly KeyEntry[];
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "keylog", "runs.json"), "utf8"),
) as KeylogFixture;

for (const run of fixture.runs) {
  void test(`Builder matches Python on real probe ${run.name}`, () => {
    const builder = new Builder(run.name);
    for (const record of run.records) builder.feed(record);
    assert.deepEqual(builder.entries, run.entries);
  });
}

type Body = Record<string, unknown>;

function rec(seq: number, sec: number, type: string, body: Body = {}): Json {
  return { seq, t: `2026-10-19T17:00:${String(sec).padStart(2, "0")}Z`, type, ...body };
}

function sample(
  sec: number,
  seq: number,
  options: {
    gil: number;
    chests?: number;
    lv?: number;
    battle?: Json;
    area?: string;
  },
): Json {
  const party = [
    { name: "巴兹", lv: options.lv ?? 5, hp: 50 },
    { name: "蕾娜", lv: 5, hp: 40 },
  ];
  const user = {
    mapId: 203,
    areaText: options.area ?? "风之神殿",
    gil: options.gil,
    chests: options.chests ?? 0,
  };
  return rec(seq, sec, "sample", {
    user,
    party,
    battle: options.battle ?? { active: false },
  });
}

function kinds(builder: Builder): [string, string, string][] {
  return builder.entries.map((entry) => [entry.type, entry.text, entry.progress]);
}

void test("build extracts key events", () => {
  const builder = new Builder("20261020-0100");
  for (const record of [
    rec(1, 0, "hello", {
      product: "FINAL FANTASY V",
      gameVersion: "1.2.0",
      plugin: "0.3.0",
    }),
    sample(1, 2, { gil: 100 }),
    rec(3, 2, "dialog.play", {
      ids: ["T0001_01_01"],
      lines: ["宝箱中发现了", "【帐篷】！"],
    }),
    sample(3, 4, { gil: 100, chests: 5 }),
    sample(4, 5, {
      gil: 100,
      chests: 5,
      battle: { active: true, enemies: [{ name: "翼龙" }] },
    }),
    sample(5, 6, { gil: 100, chests: 5, lv: 6 }), // won, no gil: likely a boss
    sample(6, 7, {
      gil: 100,
      chests: 5,
      battle: { active: true, enemies: [{ name: "杀人蜂" }] },
    }),
    sample(7, 8, { gil: 260, chests: 5 }), // a normal battle: gil gained, no entry
    rec(9, 8, "dialog.play", { ids: ["E0017_a"], lines: ["得到了【水晶碎片】！"] }),
    rec(10, 9, "save.write", { slot: 3, result: "Success" }),
  ]) {
    builder.feed(record);
  }
  assert.deepEqual(kinds(builder), [
    ["run", "开始:FINAL FANTASY V 1.2.0,桥插件 0.3.0", "—"],
    ["place", "首次到达「风之神殿」", "—"],
    ["chest", "地图 203:帐篷", "本作已开 5 个"],
    ["boss", "击败「翼龙」(推测为首领:战后没有金钱)", "—"],
    ["level", "巴兹 5→6", "全员最低 Lv5"],
    ["item", "得到「水晶碎片」", "—"],
    ["save", "存档到 3 号位", "—"],
  ]);
  assert.equal(builder.entries[0]?.ts, "2026-10-20T01:00:00+08:00");
});

void test("level ups from one result screen merge", () => {
  const builder = new Builder("r");
  builder.feed(sample(0, 1, { gil: 0, lv: 4 }));
  builder.feed(sample(1, 2, { gil: 0, lv: 5 }));
  const later = sample(2, 3, { gil: 0, lv: 5 });
  const party = later.party as Json[];
  const lenna = party[1];
  if (lenna) lenna.lv = 6; // Lenna's level shows up a second later
  builder.feed(later);
  assert.deepEqual(
    builder.entries.filter((entry) => entry.type === "level").map((entry) => entry.text),
    ["巴兹 4→5、蕾娜 5→6"],
  );
});

void test("level ups from separate battles stay separate", () => {
  const builder = new Builder("r");
  builder.feed(sample(0, 1, { gil: 0, lv: 4 }));
  builder.feed(sample(1, 2, { gil: 0, lv: 5 }));
  builder.feed(sample(2, 3, { gil: 0, lv: 5, battle: { active: true, enemies: [] } }));
  builder.feed(sample(3, 4, { gil: 10, lv: 6 }));
  assert.deepEqual(
    builder.entries.filter((entry) => entry.type === "level").map((entry) => entry.text),
    ["巴兹 4→5", "巴兹 5→6"],
  );
});

void test("boss flag beats the gil guess", () => {
  const builder = new Builder("r");
  builder.feed(sample(0, 1, { gil: 100 }));
  const fight = { active: true, boss: true, enemies: [{ name: "卡拉波斯", boss: 1 }] };
  builder.feed(sample(1, 2, { gil: 100, battle: fight }));
  builder.feed(sample(2, 3, { gil: 400 })); // this boss dropped gil: still a boss
  builder.feed(sample(3, 4, { gil: 400, battle: { active: true, boss: false, enemies: [] } }));
  builder.feed(sample(4, 5, { gil: 400 })); // flagged as no boss: no entry
  assert.deepEqual(
    builder.entries.filter((entry) => entry.type === "boss").map((entry) => entry.text),
    ["击败「卡拉波斯」"],
  );
});

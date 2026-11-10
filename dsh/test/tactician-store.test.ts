import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Tactics } from "../src/engine/tactics.ts";

const TABLE = { 巴兹: [{ if: "ally.hp_pct < 50", do: "白魔法:治疗" }] };

void test("walker notes, advice and the boss table stay in the map entry across reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactics-store-"));
  const path = join(directory, "tactics-ff5.json");
  try {
    const tactics = await Tactics.load(path);
    await tactics.set(64, [TABLE], ["哥布林"], {
      walkerNotes: "先开开关",
      askUp: "缺眼药",
      writtenAt: "2026-11-03T10:00:00.000Z",
    });
    await tactics.setBoss(64, {
      table: { 巴兹: [{ do: "攻击" }] },
      result: "首领战全灭",
      at: "2026-11-03T10:05:00.000Z",
      walkerNotes: "首领表说明",
      askUp: "带眼药",
      rewrites: [{ reason: "换了形态", ok: true, summary: "新表" }],
    });
    const reloaded = await Tactics.load(path);
    assert.deepEqual(reloaded.note(64), {
      walkerNotes: "先开开关",
      askUp: "缺眼药",
      writtenAt: "2026-11-03T10:00:00.000Z",
    });
    const boss = reloaded.boss(64);
    assert.ok(boss);
    assert.equal(boss.result, "首领战全灭");
    assert.equal(boss.rewrites?.[0]?.reason, "换了形态");
    assert.equal(reloaded.note(64)?.walkerNotes, "先开开关");
    assert.equal(reloaded.lastBoss()?.mapId, 64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an old tactics file without the new fields still loads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactics-store-"));
  const path = join(directory, "tactics-ff5.json");
  try {
    await writeFile(path, JSON.stringify({ "64": { tables: [TABLE], current: 0, results: [] } }));
    const tactics = await Tactics.load(path);
    assert.equal(tactics.current(64)?.巴兹 instanceof Array, true);
    assert.equal(tactics.note(64), null);
    assert.equal(tactics.boss(64), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a player-written table keeps its source mark across reloads until retired", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactics-store-"));
  const path = join(directory, "tactics-ff5.json");
  try {
    const tactics = await Tactics.load(path);
    await tactics.setPlayer(64, [TABLE], ["哥布林"]);
    assert.equal(tactics.isPlayerTable(64), true);
    assert.equal(tactics.maps.get("64")?.sourceMap, 64);
    assert.equal(Number.isNaN(Date.parse(tactics.maps.get("64")?.sourceAt ?? "")), false);
    const reloaded = await Tactics.load(path);
    assert.equal(reloaded.isPlayerTable(64), true);
    assert.equal(reloaded.maps.get("64")?.source, "player");
    assert.equal(await reloaded.retirePlayerSource(64), true);
    assert.equal(reloaded.isPlayerTable(64), false);
    assert.equal((await Tactics.load(path)).isPlayerTable(64), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

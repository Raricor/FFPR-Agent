import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BattleLog } from "../src/engine/battle-record.ts";
import { Tactics } from "../src/engine/tactics.ts";
import { tacticianView } from "../src/engine/tactician-view.ts";
import { REPO } from "../src/engine/paths.ts";

const TACTICS = join(REPO, ".deps", "ds", "tactics-ff5.json");
const BATTLES = join(REPO, ".deps", "ds", "battles-ff5.jsonl");

void test("the real FF5 tactics and battle files translate and carry hit counts", async (t) => {
  if (!existsSync(TACTICS) || !existsSync(BATTLES)) {
    t.skip("没有 .deps/ds/tactics-ff5.json 或 battles-ff5.jsonl，跳过真数据检查");
    return;
  }
  const tactics = await Tactics.load(TACTICS);
  const mapId = [...tactics.maps.keys()].map(Number).find((id) => tactics.has(id)) ?? null;
  if (mapId === null) {
    t.skip("真战术文件里没有带规则表的地图，跳过");
    return;
  }
  const battles = await BattleLog.load("ff5", BATTLES);
  const view = tacticianView({
    game: "ff5",
    tactics,
    records: battles.recentRecords(),
    calls: [],
    mapId,
    mapNameOf: (id) => `地图 ${id}`,
  });
  assert.ok(view.map);
  assert.ok(view.map.tables.length > 0);
  const first = view.map.tables[0]?.members[0]?.rules[0];
  assert.ok(first);
  assert.notEqual(first.text, "");
  assert.equal(typeof first.hits, "number");
  assert.equal(typeof first.skipped, "boolean");
});

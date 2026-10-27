import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptEntry } from "./fake-pilot.ts";
import { FakePilot, recordedCalls, scriptReplies } from "./fake-pilot.ts";
import { buy, findRow, whoCan } from "../src/engine/skills/shop.ts";

interface Case {
  readonly name: string;
  readonly out: unknown;
  readonly calls: unknown[];
  readonly transcript: TranscriptEntry[];
}

interface Fixture {
  readonly whoCan: string;
  readonly cases: Case[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "shop", "shop.json"), "utf8"),
) as Fixture;

void test("who can wear it, from the shop's marks", () => {
  const rows = [
    { name: "巴兹", canEquip: true, up: true },
    { name: "加拉夫", canEquip: true, equipped: true },
    { name: "蕾娜", canEquip: false },
    { name: "法利斯", canEquip: true, down: true },
    { name: "可露儿", canEquip: true },
  ];
  assert.equal(whoCan(rows), fixture.whoCan);
});

const gearNames: Record<string, string> = {
  "scroll down to a late item": "青铜铠",
  "scroll back up for an early item": "帐篷",
  "item not in the bag": "没有的东西",
};

const runners: Record<string, (pilot: FakePilot) => Promise<unknown>> = {
  "buy only for members it helps": (pilot) => buy(pilot, "铁盔", 4),
  "nobody can use the gear": (pilot) => buy(pilot, "铁盔", 4),
  "scroll down to a late item": (pilot) =>
    findRow(pilot, gearNames["scroll down to a late item"] ?? ""),
  "scroll back up for an early item": (pilot) =>
    findRow(pilot, gearNames["scroll back up for an early item"] ?? ""),
  "item not in the bag": (pilot) => findRow(pilot, gearNames["item not in the bag"] ?? ""),
};

for (const item of fixture.cases) {
  void test(item.name, async () => {
    const run = runners[item.name] ?? assert.fail(`no runner for ${item.name}`);
    const pilot = new FakePilot();
    scriptReplies(pilot, item.transcript);
    assert.deepEqual(await run(pilot), item.out);
    assert.deepEqual(recordedCalls(pilot), item.calls);
  });
}

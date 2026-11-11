import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import { FakeItemMenu } from "./fake-item-menu.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

async function gameIn(directory: string): Promise<Game> {
  return await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    segmentReportFile: join(directory, "segment-report-ff5.json"),
  });
}

function member(name: string, hp: number, maxHp: number, abilities: string[] = [], mp = 10) {
  return {
    name,
    jobName: "骑士",
    lv: 10,
    hp,
    maxHp,
    mp,
    maxMp: 20,
    status: [],
    abilities: abilities.map((ability) => ({ name: ability })),
  };
}

function pilotWith(
  party: readonly ReturnType<typeof member>[],
  items: Record<string, number>,
): FakePilot {
  const pilot = new FakePilot();
  pilot.on("wait", { ok: true });
  pilot.onQuery("sample", { sample: { party } });
  pilot.onQuery("items", {
    items: {
      normal: Object.entries(items).map(([name, count]) => ({ name, count })),
    },
  });
  return pilot;
}

async function healText(
  party: readonly ReturnType<typeof member>[],
  items: Record<string, number>,
) {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-heal-"));
  try {
    const game = await gameIn(directory);
    return await game.planHeal(pilotWith(party, items));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("planHeal says the party is full only when every HP bar is full", async () => {
  const result = await healText([member("蕾娜", 168, 168), member("加拉夫", 175, 175)], {});
  assert.equal(result.ok, true);
  assert.match(result.text, /队伍 HP 已经是满的/u);
});

void test("planHeal names the lowest member when HP is above the full threshold", async () => {
  const result = await healText([member("蕾娜", 162, 168), member("加拉夫", 170, 175)], {});
  assert.equal(result.ok, true);
  assert.match(result.text, /都在 95% 以上/u);
  assert.match(result.text, /最低 蕾娜 96%/u);
  assert.doesNotMatch(result.text, /满的/u);
});

void test("planHeal explains the missing healing means below the threshold", async () => {
  const result = await healText([member("蕾娜", 120, 168), member("加拉夫", 126, 175)], {});
  assert.equal(result.ok, true);
  assert.match(result.text, /没有回复手段/u);
  assert.match(result.text, /不在旅店\/回复点/u);
  assert.match(result.text, /没人会回复魔法/u);
  assert.match(result.text, /没有回复道具/u);
  assert.match(result.text, /最低 蕾娜 71%/u);
  assert.doesNotMatch(result.text, /满的/u);
});

void test("planHeal does not claim a healer when the only caster has no MP", async () => {
  const result = await healText([member("蕾娜", 50, 100, ["治疗"], 0)], {});
  assert.match(result.text, /没人会回复魔法/u);
});

void test("planHeal revives the fallen with a Phoenix Down before healing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-heal-"));
  try {
    const game = await gameIn(directory);
    const pilot = new FakePilot();
    const itemMenu = new FakeItemMenu({
      items: [{ name: "不死鸟之尾", count: 2 }],
      members: [
        { name: "巴兹", hp: 0, maxHp: 100 },
        { name: "蕾娜", hp: 100, maxHp: 100 },
      ],
      target: "巴兹",
    });
    itemMenu.install(pilot);
    const result = await game.planHeal(pilot);
    assert.equal(result.ok, true);
    assert.match(result.text, /不死鸟之尾/u);
    assert.equal(itemMenu.items[0]?.count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

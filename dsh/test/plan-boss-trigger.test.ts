/**
 * Task 156 follow-up: the Wind Shrine 205 boss object. The export adds `bossObjects` to each
 * map; the plan executor matches its monster ids to the plan boss, and kana variants must not
 * split the same name. No bridge or laptop is involved.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import { loadKnowledge, type Knowledge } from "../src/engine/knowledge/index.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { PlanBoss } from "../src/engine/plan/types.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

const BOSS: PlanBoss = {
  name: "Wing Raptor(巨翼猛禽)",
  map: 205,
  healFirst: false,
  saveFirst: false,
  tables: [],
};

function fakeKnowledge(bossObjects: readonly unknown[]): Knowledge {
  return {
    filesDir: null,
    guide: null,
    monsters: [{ id: 281, bookId: 229, name: "巨翼猛禽" }],
    mapFiles: [{ id: 205, name: "风之神殿", bossObjects }],
  } as unknown as Knowledge;
}

async function gameWith(knowledge: Knowledge, directory: string): Promise<Game> {
  return await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    gameFilesDir: null,
    knowledge,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    segmentPlanFile: join(directory, "segment-plan.json"),
    chapterPlanFile: join(directory, "chapter-plan.json"),
    chapterDraftFile: join(directory, "chapter-draft.json"),
    chapterProgressFile: join(directory, "chapter-progress.json"),
    chapterReportFile: join(directory, "chapter-report.json"),
  });
}

function pilotAt205(): FakePilot {
  return new FakePilot()
    .on("pos", { pos: { map: 205, cell: [1, 1] } })
    .on("entities", { entities: [] });
}

void test("a boss object whose monster ids name the boss is a trigger cell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-boss-trigger-"));
  try {
    const game = await gameWith(
      fakeKnowledge([
        {
          cell: [14, 11],
          name: "ウィングラプター",
          objectType: 10,
          monsterIds: [281],
        },
      ]),
      directory,
    );
    const cells = await game.planBossTriggerCandidates(pilotAt205(), 205, BOSS, "");
    assert.deepEqual(cells, [[14, 11]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a boss object name matches through small kana, long vowels and middle dots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-boss-trigger-"));
  try {
    const game = await gameWith(
      fakeKnowledge([{ cell: [15, 12], name: "ウィングラプター", objectType: 10 }]),
      directory,
    );
    const cells = await game.planBossTriggerCandidates(
      pilotAt205(),
      205,
      { ...BOSS, name: "ウイングラプター" },
      "",
    );
    assert.deepEqual(cells, [[15, 12]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("loadKnowledge keeps the exported bossObjects field", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-boss-export-"));
  try {
    await mkdir(join(directory, "maps"), { recursive: true });
    const bossObjects = [
      { cell: [14, 11], name: "ウィングラプター", objectType: 10, monsterIds: [281] },
    ];
    await writeFile(
      join(directory, "maps", "205.json"),
      JSON.stringify({ id: 205, name: "风之神殿", bossObjects }),
      "utf8",
    );
    const knowledge = await loadKnowledge({
      game: "ff5",
      guide: null,
      staticDir: join(directory, "missing-static"),
      filesDir: directory,
      atlas: null,
      collisions: null,
    });
    const map = knowledge.mapFiles?.find((entry) => entry.id === 205) as
      { readonly bossObjects?: readonly unknown[] } | undefined;
    assert.deepEqual(map?.bossObjects, bossObjects);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("story trigger candidates match the Chinese why through item-name aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-story-trigger-"));
  try {
    const knowledge = {
      filesDir: null,
      guide: null,
      monsters: [],
      mapFiles: [],
      contentItems: [
        {
          id: 39,
          kind: "Armor",
          names: { zhc: "加拉夫的手镯", en: "Galuf's Bangle", ja: "ガラフの腕輪" },
          sources: [],
          conflicts: [],
        },
      ],
    } as unknown as Knowledge;
    const game = await gameWith(knowledge, directory);
    const pilot = new FakePilot().on("entities", {
      entities: {
        entities: [
          { kind: "Npc", name: "sc_e_0005:ボコ", cell: [16, 21], active: true },
          { kind: "Npc", name: "sc_e_0004:ガラフ", cell: [46, 12], active: true },
        ],
      },
    });
    const trigger = await game.planStoryTrigger(
      pilot,
      189,
      "靠近倒地的老人加拉夫触发对话,第三名同伴入队",
    );
    assert.equal(trigger.count, 2);
    assert.match(trigger.candidates[0]?.name ?? "", /ガラフ/u);
    assert.equal(trigger.candidates[0]?.matched, true);
    assert.deepEqual(trigger.candidates[0].cell, [46, 12]);

    const noHint = await game.planStoryTrigger(pilot, 189, "");
    assert.deepEqual(
      noHint.candidates.map((candidate) => candidate.script),
      [4, 5],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

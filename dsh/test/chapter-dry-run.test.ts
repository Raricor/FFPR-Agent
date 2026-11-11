/**
 * Task 154: the submit-time dry run. Synthetic maps only: a wall splits map 10, a story or
 * switch on the near side may move the party, a chest sits on a wall cell, and a zero budget
 * stands in for a chapter that takes too long.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import type { ChapterPlan } from "../src/engine/plan/chapter-types.ts";
import { dryRunChapter, type DryRunResult } from "../src/engine/plan/dry-run.ts";
import type { PlanStation, PlanStationAction, SegmentPlan } from "../src/engine/plan/types.ts";
import type { RouteWorld } from "../src/engine/route/types.ts";

/** A solid column at x=3; every cell starts walkable. */
const SPLIT_ROWS = ["00010000", "00010000", "00010000", "00010000"];

function station(to: string, action: PlanStationAction): PlanStation {
  return { to, do: action, why: "测试" };
}

function segment(stations: readonly PlanStation[]): SegmentPlan {
  return {
    version: 1,
    section: "测试一节",
    goal: "走完测试一节",
    prep: { jobs: [], equip: "keep", buy: [], rows: [] },
    stations,
    battle: [],
    bosses: [],
    turnBack: [],
  };
}

function chapter(stations: readonly PlanStation[]): ChapterPlan {
  return {
    version: 1,
    chapter: 1,
    goal: "走完测试章",
    segments: [segment(stations)],
    growth: [],
    fallback: {
      retries: 1,
      bossLost: { levels: 1, where: null, tries: 1 },
      skipOptional: true,
      healBelowPct: 30,
    },
  };
}

async function setup(rows: readonly string[]): Promise<{
  readonly dir: string;
  readonly world: RouteWorld;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-chapter-dry-run-"));
  const atlas = new Atlas();
  atlas.maps.set("10", { name: "测试地图", exits: [], chests: [] });
  const collisions = await CollisionStore.load(dir);
  await collisions.remember(10, {
    searchLayer: 1,
    layers: [{ name: "GroundCollision", rows }],
  });
  return {
    dir,
    world: {
      atlas,
      collisions,
      regions: RegionIndex.create(atlas, collisions),
    },
  };
}

function checked(result: DryRunResult): DryRunResult {
  assert.equal(result.timedOut, false);
  return result;
}

void test("an ordinary station behind a wall is rejected with both cells and the reason", async () => {
  const { dir, world } = await setup(SPLIT_ROWS);
  try {
    const result = checked(
      dryRunChapter(chapter([station("10:5,1", "move")]), { map: 10, cell: [0, 1] }, world),
    );
    assert.equal(result.warnings.length, 0);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0] ?? "", /第 1 段第 1 站 \(图 10:5,1\)/u);
    assert.match(result.problems[0] ?? "", /从上一站 \(图 10:0,1\) 走不到/u);
    assert.match(result.problems[0] ?? "", /走不到/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a story between the cells turns the unreachable station into a warning", async () => {
  const { dir, world } = await setup(SPLIT_ROWS);
  try {
    const result = checked(
      dryRunChapter(
        chapter([station("10:1,1", "story"), station("10:5,1", "move")]),
        { map: 10, cell: [0, 1] },
        world,
      ),
    );
    assert.equal(result.problems.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /只提醒/u);
    assert.match(result.warnings[0] ?? "", /上一站是剧情/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a switch between the cells also only warns", async () => {
  const { dir, world } = await setup(SPLIT_ROWS);
  try {
    const result = checked(
      dryRunChapter(
        chapter([station("10:1,1", "switch"), station("10:5,1", "move")]),
        { map: 10, cell: [0, 1] },
        world,
      ),
    );
    assert.equal(result.problems.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /上一站是剧情\/对话\/机关\/首领/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a chest on a wall cell is estimated from a standable side", async () => {
  const rows = ["00000", "00000", "00100", "00000", "00000"];
  const { dir, world } = await setup(rows);
  try {
    const result = checked(
      dryRunChapter(chapter([station("10:2,2", "open")]), { map: 10, cell: [0, 2] }, world),
    );
    assert.equal(result.problems.length, 0);
    assert.equal(result.warnings.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a timeout only warns that the walk was not finished", async () => {
  const { dir, world } = await setup(SPLIT_ROWS);
  try {
    const result = dryRunChapter(
      chapter([station("10:5,1", "move")]),
      { map: 10, cell: [0, 1] },
      world,
      { timeoutMs: 0 },
    );
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, ["试走超时，未检查完"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

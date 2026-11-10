import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { CollisionStore } from "../src/engine/regions.ts";
import {
  describeScout,
  exploreTargets,
  planScout,
  resolveScope,
} from "../src/engine/scout/explore.ts";

function testAtlas(): Atlas {
  const atlas = new Atlas();
  atlas.maps.set("10", {
    name: "测试洞窟",
    areaName: "测试地区",
    exits: [
      { cell: [10, 10], to: 11, name: "北口" },
      { cell: [11, 11], to: 12, name: "东口", land: [2, 3] },
    ],
    chests: [],
    links: [
      { from: [6, 6], to: [7, 6], how: "走不过去", count: 1, at: "2026-11-10T00:00:00Z" },
      { from: [6, 7], to: [7, 7], how: "走不过去", count: 2, at: "2026-11-10T00:00:00Z" },
      { from: [5, 8], to: [4, 2], how: "跳下去", kind: "fall" },
    ],
    entities: [
      {
        kind: "DefaultEntity",
        name: "トルナ運河の開錠_右扉",
        cell: [8, 3],
        active: false,
      },
      { kind: "Event", name: "剧情触发", cell: [9, 9] },
      { kind: "TresureBox", name: "宝箱", cell: [9, 1] },
      { kind: "DefaultEntity", name: "已经试过的门", cell: [3, 3], tried: true },
    ],
  });
  atlas.maps.set("11", { name: "北边小房间", exits: [], chests: [] });
  atlas.maps.set("12", { name: "东边小房间", exits: [], chests: [] });
  return atlas;
}

void test("an exit without a landing, a one-off block and named objects all become targets", () => {
  const atlas = testAtlas();
  const plan = planScout({
    atlas,
    start: { map: 10, cell: [5, 5] },
    scope: [10],
  });
  const kinds = plan.targets.map((target) => target.kind);
  assert.deepEqual(kinds.slice(0, 2), ["landing", "blocked"]);
  assert.deepEqual(kinds.slice(2), ["entity", "entity"]);
  assert.deepEqual(
    new Set(plan.targets.map((target) => target.route.to)),
    new Set(["10:10,10", "10:6,6", "10:8,3", "10:9,9"]),
  );
  // The exit with a recorded landing and the block hit twice are already answered.
  assert.ok(!plan.targets.some((target) => target.cell[0] === 11 && target.cell[1] === 11));
  assert.ok(!plan.targets.some((target) => target.step?.from[1] === 7));
  // Chests and already-tried objects are not scout targets.
  assert.ok(!plan.targets.some((target) => target.label.includes("宝箱")));
  assert.ok(!plan.targets.some((target) => target.label.includes("已经试过")));
  // The mechanism is investigated, the event cell is just walked onto.
  const mechanism = plan.targets.find((target) => target.label.includes("右扉"));
  assert.ok(mechanism);
  assert.equal(mechanism.waypoint.kind, "story");
  assert.equal(mechanism.waypoint.reach, "map");
  const event = plan.targets.find((target) => target.label.includes("剧情触发"));
  assert.ok(event);
  assert.equal(event.waypoint.kind, "move");
  assert.equal(event.waypoint.reach, "cell");
  assert.match(describeScout(plan), /出口落点 1/);
  assert.match(describeScout(plan), /走不过去 1/);
});

void test("scope accepts all map names containing the text, and numeric strings", () => {
  const atlas = testAtlas();
  assert.deepEqual(resolveScope(atlas, ["测试地区"]), [10]);
  assert.deepEqual(resolveScope(atlas, ["10"]), [10]);
  assert.deepEqual(resolveScope(atlas, ["地图 12"]), [12]);
  const targets = exploreTargets({
    atlas,
    start: { map: 10, cell: [5, 5] },
    scope: ["测试洞窟"],
  });
  assert.ok(targets.every((target) => target.map === 10));
});

void test("a collision block no recorded entrance reaches is a target even when unroutable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-scout-explore-"));
  try {
    const collisions = await CollisionStore.load(dir);
    assert.equal(
      await collisions.remember(20, {
        searchLayer: 1,
        layers: [{ name: "GroundCollision", rows: ["0001000"] }],
      }),
      true,
    );
    const atlas = new Atlas();
    atlas.maps.set("20", { name: "分叉洞窟", exits: [], chests: [], links: [] });
    const plan = planScout({
      atlas,
      collisions,
      start: { map: 20, cell: [0, 0] },
      scope: [20],
    });
    const component = plan.targets.find((target) => target.kind === "component");
    assert.ok(component);
    assert.deepEqual(component.cell, [4, 0]);
    assert.match(component.label, /走不到过的连通块/u);
    // The records cannot route into the block; it stays in the plan, after the reachable work.
    assert.equal(plan.unreachable.length, 1);
    assert.match(plan.warnings.join("\n"), /走不到/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the same object supplied twice is planned once", () => {
  const atlas = testAtlas();
  const plan = planScout({
    atlas,
    start: { map: 10, cell: [5, 5] },
    scope: [10],
    entities: [
      { map: 10, cell: [8, 3], kind: "DefaultEntity", name: "トルナ運河の開錠_右扉" },
      { map: 10, cell: [8, 3], kind: "DefaultEntity", name: "トルナ運河の開錠_右扉" },
    ],
  });
  assert.equal(plan.targets.filter((target) => target.label.includes("右扉")).length, 1);
});

/**
 * Task 87: the route executor with stand-in ports. These tests never touch a laptop; they
 * cover order, deviation/replan, decision stops, failures, the abort signal and the progress
 * file that lets a later run resume.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Cell } from "../src/engine/nav.ts";
import { executeRoute, resumeRoute, type RoutePorts } from "../src/engine/route/execute.ts";
import { readProgress } from "../src/engine/route/state.ts";
import type { RouteLeg, RoutePlan, Waypoint, WaypointKind } from "../src/engine/route/types.ts";

interface Point {
  map: number;
  cell: Cell;
}

interface ActResult {
  ok: boolean;
  done: boolean;
  text: string;
  decision?: string;
}

interface FakeState {
  position: Point | null;
  went: string[];
  acted: string[];
  replans: { from: Point; rest: string[] }[];
}

interface FakeHandlers {
  onPosition?: () => Promise<void>;
  goTo?: (stop: Waypoint, state: FakeState) => Promise<{ ok: boolean; text: string } | null>;
  act?: (stop: Waypoint, state: FakeState) => Promise<ActResult | null>;
  replan?: (from: Point, rest: readonly Waypoint[], state: FakeState) => Promise<RoutePlan>;
}

const START: Point = { map: 1, cell: [5, 5] };

function waypoint(id: string, kind: WaypointKind, x: number, label = id): Waypoint {
  return { id, kind, map: 1, cell: [x, 5], label };
}

function planFrom(start: Point, stops: readonly Waypoint[]): RoutePlan {
  const legs: RouteLeg[] = [];
  let from: Point = { map: start.map, cell: start.cell };
  for (const stop of stops) {
    legs.push({
      from,
      waypoint: stop.id,
      kind: stop.kind,
      label: stop.label,
      map: stop.map,
      cell: stop.cell,
      maps: from.map === stop.map ? [stop.map] : [from.map, stop.map],
      hops: from.map === stop.map ? 0 : 1,
      cells: 1,
      minutes: 0.1,
    });
    if (stop.cell !== null) from = { map: stop.map, cell: stop.cell };
  }
  return {
    legs,
    unreachable: [],
    warnings: [],
    total: {
      cells: legs.length,
      hops: legs.reduce((sum, leg) => sum + leg.hops, 0),
      minutes: legs.length * 0.1,
    },
  };
}

function fakePorts(state: FakeState, handlers: FakeHandlers = {}): RoutePorts {
  return {
    position: async () => {
      if (handlers.onPosition !== undefined) await handlers.onPosition();
      return state.position;
    },
    goTo: async (stop) => {
      state.went.push(stop.id);
      if (handlers.goTo !== undefined) {
        const custom = await handlers.goTo(stop, state);
        if (custom !== null) return custom;
      }
      if (stop.cell !== null) state.position = { map: stop.map, cell: stop.cell };
      return { ok: true, text: "走到了" };
    },
    act: async (stop) => {
      state.acted.push(stop.id);
      if (handlers.act !== undefined) {
        const custom = await handlers.act(stop, state);
        if (custom !== null) return custom;
      }
      return { ok: true, done: true, text: "完成" };
    },
    replan: async (from, rest) => {
      state.replans.push({ from, rest: rest.map((entry) => entry.id) });
      if (handlers.replan === undefined) throw new Error("没料到会重排");
      const plan = await handlers.replan(from, rest, state);
      return plan;
    },
  };
}

function newState(position: Point | null = START): FakeState {
  return { position, went: [], acted: [], replans: [] };
}

async function inTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-route-exec-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("four waypoints run in order and the progress file grows after each", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [
      waypoint("a", "chest", 1),
      waypoint("b", "save", 2),
      waypoint("c", "story", 3),
      waypoint("d", "grind", 4),
    ];
    const state = newState();
    const snapshots: string[][] = [];
    const ports = fakePorts(state, {
      onPosition: async () => {
        const progress = await readProgress(file);
        const completed = [...progress.completed];
        if (snapshots[snapshots.length - 1]?.join(",") !== completed.join(",")) {
          snapshots.push(completed);
        }
      },
    });

    const result = await executeRoute(planFrom(START, stops), ports, { progressFile: file });

    assert.equal(result.reason, "completed");
    assert.deepEqual(state.acted, ["a", "b", "c", "d"]);
    assert.deepEqual(snapshots, [[], ["a"], ["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]]);
    const saved = await readProgress(file);
    assert.equal(saved.next, 4);
    assert.deepEqual(saved.completed, ["a", "b", "c", "d"]);
    assert.match(result.text, /完成/);
  });
});

void test("resumeRoute continues from the saved leg instead of starting over", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [
      waypoint("a", "chest", 1),
      waypoint("b", "chest", 2),
      waypoint("c", "save", 3),
      waypoint("d", "story", 4),
    ];
    const controller = new AbortController();
    const first = newState();
    const firstPorts = fakePorts(first, {
      act: (stop) => {
        if (stop.id === "b") controller.abort();
        return Promise.resolve(null);
      },
    });
    const aborted = await executeRoute(planFrom(START, stops), firstPorts, {
      progressFile: file,
      signal: controller.signal,
    });
    assert.equal(aborted.reason, "aborted");
    assert.deepEqual(first.acted, ["a", "b"]);
    const saved = await readProgress(file);
    assert.equal(saved.next, 2);
    assert.deepEqual(saved.completed, ["a", "b"]);

    const second = newState({ map: 1, cell: [2, 5] });
    const resumed = await resumeRoute(file, fakePorts(second));
    assert.equal(resumed.reason, "completed");
    assert.deepEqual(second.acted, ["c", "d"]);
    assert.deepEqual(resumed.completed, ["a", "b", "c", "d"]);
  });
});

void test("a position change after waypoint two replans from there and follows the new order", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [
      waypoint("a", "chest", 1),
      waypoint("b", "chest", 2),
      waypoint("c", "chest", 3),
      waypoint("d", "chest", 4),
    ];
    const byId = new Map(stops.map((stop) => [stop.id, stop]));
    const state = newState();
    let deviated = false;
    const ports = fakePorts(state, {
      goTo: (stop, current) => {
        if (stop.id !== "c" || deviated) return Promise.resolve(null);
        deviated = true;
        current.position = { map: 9, cell: [0, 0] };
        return Promise.resolve({ ok: true, text: "踩到传送带" });
      },
      replan: (from, rest) => {
        assert.deepEqual(from, { map: 9, cell: [0, 0] });
        assert.deepEqual(
          rest.map((entry) => entry.id),
          ["c", "d"],
        );
        const d = byId.get("d");
        const c = byId.get("c");
        assert.ok(d !== undefined && c !== undefined);
        return Promise.resolve(planFrom(from, [d, c]));
      },
    });

    const result = await executeRoute(planFrom(START, stops), ports, { progressFile: file });

    assert.equal(result.reason, "completed");
    assert.deepEqual(state.acted, ["a", "b", "d", "c"]);
    assert.equal(state.replans.length, 1);
    assert.match(result.text, /偏离/);
    assert.match(result.text, /重排/);
  });
});

void test("a boss waypoint stops at the door and hands the fight to the AI", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [
      waypoint("a", "chest", 1, "宝箱 A"),
      waypoint("boss", "boss", 2, "卡纳克首领"),
      waypoint("c", "save", 3, "存档 C"),
    ];
    const state = newState();
    const result = await executeRoute(planFrom(START, stops), fakePorts(state), {
      progressFile: file,
    });

    assert.equal(result.reason, "decision");
    assert.deepEqual(state.acted, ["a"]);
    assert.deepEqual(
      result.remaining.map((entry) => entry.id),
      ["boss", "c"],
    );
    assert.match(result.message, /首领/);
    assert.match(result.message, /AI/);
    assert.match(result.text, /首领/);
    const saved = await readProgress(file);
    assert.equal(saved.next, 1);
    assert.deepEqual(saved.completed, ["a"]);
  });
});

void test("an act decision such as a shop without a list is handed back to the AI", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [waypoint("shop", "shop", 1, "卡纳克商店")];
    const state = newState();
    const ports = fakePorts(state, {
      act: () =>
        Promise.resolve({
          ok: true,
          done: false,
          text: "到了柜台",
          decision: "没有采购单，买什么",
        }),
    });

    const result = await executeRoute(planFrom(START, stops), ports, { progressFile: file });

    assert.equal(result.reason, "decision");
    assert.match(result.message, /采购单/);
    assert.deepEqual(state.acted, ["shop"]);
    assert.deepEqual(
      result.remaining.map((entry) => entry.id),
      ["shop"],
    );
    const saved = await readProgress(file);
    assert.equal(saved.next, 0);
    assert.deepEqual(saved.completed, []);
  });
});

void test("when every remaining waypoint becomes unreachable the run stops and lists them", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [waypoint("a", "chest", 1), waypoint("b", "chest", 2, "卡纳克宝箱")];
    const state = newState();
    const ports = fakePorts(state, {
      act: (stop, current) => {
        if (stop.id === "a") current.position = { map: 9, cell: [1, 1] };
        return Promise.resolve(null);
      },
      replan: () =>
        Promise.resolve({
          legs: [],
          unreachable: [
            {
              id: "b",
              kind: "chest",
              map: 1,
              cell: [2, 5],
              label: "卡纳克宝箱",
              reason: "路被水淹了",
            },
          ],
          warnings: [],
          total: { cells: 0, hops: 0, minutes: 0 },
        }),
    });

    const result = await executeRoute(planFrom(START, stops), ports, { progressFile: file });

    assert.equal(result.reason, "unreachable");
    assert.match(result.message, /卡纳克宝箱/);
    assert.match(result.message, /水淹/);
    assert.deepEqual(
      result.remaining.map((entry) => entry.id),
      ["b"],
    );
    assert.equal(state.replans.length, 1);
  });
});

void test("the same waypoint failing twice stops the run", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [waypoint("a", "chest", 1), waypoint("b", "chest", 2, "卡住的门")];
    const state = newState();
    const ports = fakePorts(state, {
      goTo: (stop) => Promise.resolve(stop.id === "b" ? { ok: false, text: "路被挡住" } : null),
    });

    const result = await executeRoute(planFrom(START, stops), ports, { progressFile: file });

    assert.equal(result.reason, "failed");
    assert.deepEqual(state.went, ["a", "b", "b"]);
    assert.deepEqual(state.acted, ["a"]);
    assert.match(result.message, /2 次/);
    const saved = await readProgress(file);
    assert.equal(saved.next, 1);
    assert.deepEqual(saved.completed, ["a"]);
  });
});

void test("an abort signal stops immediately and leaves the finished legs saved", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "route-progress.json");
    const stops = [waypoint("a", "chest", 1), waypoint("b", "chest", 2), waypoint("c", "chest", 3)];
    const controller = new AbortController();
    const state = newState();
    const ports = fakePorts(state, {
      act: (stop) => {
        if (stop.id === "a") controller.abort();
        return Promise.resolve(null);
      },
    });

    const result = await executeRoute(planFrom(START, stops), ports, {
      progressFile: file,
      signal: controller.signal,
    });

    assert.equal(result.reason, "aborted");
    assert.deepEqual(state.acted, ["a"]);
    assert.match(result.text, /取消/);
    const saved = await readProgress(file);
    assert.equal(saved.next, 1);
    assert.deepEqual(saved.completed, ["a"]);
  });
});

void test("the replan limit stops repeated deviation instead of looping", async () => {
  const stops = [waypoint("a", "chest", 1), waypoint("b", "chest", 2)];
  const state = newState();
  let plan = planFrom(START, stops);
  const ports = fakePorts(state, {
    goTo: (stop, current) => {
      if (stop.id !== "b") return Promise.resolve(null);
      current.position = { map: 9, cell: [0, 0] };
      return Promise.resolve({ ok: true, text: "又被带走" });
    },
    replan: (from, rest) => {
      plan = planFrom(from, rest);
      return Promise.resolve(plan);
    },
  });

  const result = await executeRoute(plan, ports, { replanLimit: 1 });

  assert.equal(result.reason, "replan-limit");
  assert.equal(state.replans.length, 1);
  assert.equal(result.replans, 1);
});

void test("a zero time budget stops before the first step", async () => {
  const state = newState();
  const result = await executeRoute(
    planFrom(START, [waypoint("a", "chest", 1)]),
    fakePorts(state),
    {
      timeBudgetMs: 0,
    },
  );
  assert.equal(result.reason, "time-budget");
  assert.deepEqual(state.went, []);
});

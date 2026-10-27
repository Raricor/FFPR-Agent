import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptEntry } from "./fake-pilot.ts";
import { FakePilot, recordedCalls, scriptReplies } from "./fake-pilot.ts";
import type { Cell, CellGrid } from "../src/engine/nav.ts";
import {
  landHere,
  landingSpots,
  navigate,
  openAt,
  occupiedCells,
  SETTLE_MS,
  SETTLE_POLL_MS,
  plan,
  gameRoute,
  routeCells,
} from "../src/engine/skills/move.ts";
import type { MoveState } from "../src/engine/skills/move.ts";

interface Case {
  readonly name: string;
  readonly out: unknown;
  readonly calls: unknown[];
  readonly transcript: TranscriptEntry[];
}

interface Fixture {
  readonly route: { points: Cell[]; empty: Cell[] };
  readonly landing: { near: Cell[]; anywhere: Cell[] };
  readonly cases: Case[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "move", "move.json"), "utf8"),
) as Fixture;

void test("route cells come from the game's pixel points", () => {
  const route = {
    from: [16, 23],
    cells: [
      [16, -128, 249],
      [16, -144, 249],
      [16, -160, 249],
      [0, -160, 249],
      [0, -144, 249],
      [0, -128, 249],
      [-16, -128, 249],
      [-32, -128, 249],
    ],
  };
  assert.deepEqual(routeCells(route), fixture.route.points);
  assert.deepEqual(routeCells({ from: [1, 1], cells: [] }), fixture.route.empty);
});

void test("landing spots connect to the entrance on foot", () => {
  const cells: CellGrid = {
    origin: [0, 0],
    center: [3, 0],
    attr: [
      [4, 19, 7, 10],
      [19, 19, 7, 7],
      [4, 4, 7, 6],
    ],
  };
  assert.deepEqual(landingSpots(cells, [3, 0]), fixture.landing.near);
  assert.deepEqual(landingSpots(cells, null), fixture.landing.anywhere);
});

const runners: Record<string, (pilot: FakePilot) => Promise<unknown>> = {
  "plan over terrain": async (pilot) => {
    const [here, path] = await plan(pilot, [3, 3], true);
    return { here, path };
  },
  "the drake lands": async (pilot) => {
    const state: MoveState = { drake: null };
    const ok = await landHere(pilot, state);
    return { ok, drake: state.drake === null ? null : [...state.drake] };
  },
  "navigate goes on past the planning window": async (pilot) => {
    const said: string[] = [];
    const out = await navigate(pilot, [10, 0], true, (line) => said.push(line));
    return { out, said };
  },
  "a blocked step closes that step": async (pilot) => {
    const said: string[] = [];
    const out = await navigate(pilot, [17, 17], true, (line) => said.push(line));
    return { out, said };
  },
  "occupied cells keep props off": async (pilot) => {
    const cells = await occupiedCells(pilot);
    return cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  },
};

/**
 * Where the TS version deliberately differs from Python's recorded calls: after arriving it
 * watches the map for SETTLE_MS (enteredAfterArriving, 10-27), one more pos per poll.
 */
const SETTLE_POLLS = SETTLE_MS / SETTLE_POLL_MS;
const ARRIVES: Readonly<Record<string, { map: number; cell: Cell }>> = {
  "navigate goes on past the planning window": { map: 1, cell: [10, 0] },
};

/**
 * The task-09 conveyor check asks for the Event cells as well; the Python fixture predates
 * it, so this case gets one more reply and call after the other occupied kinds.
 */
const EXTRA_EVENT_QUERY: Readonly<
  Record<string, { reply: Record<string, unknown>; call: unknown }>
> = {
  "occupied cells keep props off": {
    reply: { entities: { total: 0, entities: [] } },
    call: { kind: "send", op: "entities", fields: { kind: "Event", max: 200 }, wait: 30 },
  },
};

for (const item of fixture.cases) {
  void test(item.name, async () => {
    const run = runners[item.name] ?? assert.fail(`no runner for ${item.name}`);
    const pilot = new FakePilot();
    const arrives = ARRIVES[item.name];
    const settle = arrives ? Array.from({ length: SETTLE_POLLS }, () => arrives) : [];
    const extra = EXTRA_EVENT_QUERY[item.name];
    const extraReply = extra ? [{ kind: "send" as const, op: "entities", reply: extra.reply }] : [];
    scriptReplies(pilot, [...item.transcript, ...extraReply, ...settle.map(toPosReply)]);
    noEntrances(pilot);
    assert.deepEqual(await run(pilot), item.out);
    const settleCalls = settle.map(() => ({ kind: "send", op: "pos", fields: {}, wait: 30 }));
    const extraCalls = extra ? [extra.call] : [];
    const calls = recordedCalls(pilot).filter((call) => !isEntranceQuery(call));
    assert.deepEqual(calls, [...item.calls, ...extraCalls, ...settleCalls]);
  });
}

/**
 * World-map plans also ask for the entrances to keep off (TS only, 10-27). Python's
 * transcripts have no such query: answer it with none and leave it out of the comparison.
 */
function noEntrances(pilot: FakePilot): void {
  pilot.when("entities", (fields) => fields.kind === "GotoMap" && fields.max === 300, {
    entities: { total: 0, entities: [] },
  });
}

function isEntranceQuery(call: unknown): boolean {
  const { op, fields } = call as { op?: string; fields?: { kind?: unknown; max?: unknown } };
  return op === "entities" && fields?.kind === "GotoMap" && fields.max === 300;
}

function toPosReply(pos: { map: number; cell: Cell }): TranscriptEntry {
  return { kind: "send", op: "pos", reply: { pos } };
}

void test("an entrance that swaps the map just after the last step is entering, not arriving", async () => {
  const pilot = new FakePilot();
  noEntrances(pilot);
  const open = Array.from({ length: 5 }, () => [3, 3, 3, 3, 3]);
  scriptReplies(pilot, [
    { kind: "send", op: "pos", reply: { pos: { map: 258, cell: [4, 8] } } },
    { kind: "send", op: "pos", reply: { pos: { map: 258, cell: [4, 8] } } },
    { kind: "send", op: "cells", reply: { cells: { origin: [2, 6], center: [4, 8], attr: open } } },
    { kind: "query", q: "sample", reply: { sample: { field: { moveState: null } } } },
    // The settle watch: the game swaps the map on the second poll.
    { kind: "send", op: "pos", reply: { pos: { map: 258, cell: [4, 8] } } },
    { kind: "send", op: "pos", reply: { pos: { map: 255, cell: [19, 21] } } },
    { kind: "send", op: "wait", reply: { ok: true } },
    { kind: "send", op: "pos", reply: { pos: { map: 255, cell: [19, 21] } } },
  ]);
  assert.deepEqual(await navigate(pilot, [4, 8], false), [true, "进入了地图 255,现在在 [19, 21]"]);
});

const OPEN_ROWS = ["00000", "00000", "00000"];
const OPEN_ATTR = [
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
];

/** An indoor pilot whose replies follow `here`, with one conveyor at (2, 1). */
function conveyorPilot(here: () => Cell): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 260, cell: [here()[0], here()[1]] } }));
  pilot.on("cells", () => ({
    cells: { origin: [0, 0], center: [here()[0], here()[1]], attr: OPEN_ATTR },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here()[0], here()[1]],
      layers: [{ name: "GroundCollision", rows: OPEN_ROWS }],
    },
  }));
  pilot.on("entities", (fields) =>
    fields.kind === "Event"
      ? {
          entities: {
            total: 1,
            entities: [{ kind: "Event", cell: [2, 1], name: "流される①", active: true }],
          },
        }
      : { entities: { total: 0, entities: [] } },
  );
  return pilot;
}

function walkedTo(pilot: FakePilot): Cell[] {
  return pilot.calls.flatMap((call) => {
    if (call.kind !== "send" || call.op !== "walk") return [];
    const to = call.fields.to;
    return Array.isArray(to) && typeof to[0] === "number" && typeof to[1] === "number"
      ? [[to[0], to[1]] as const]
      : [];
  });
}

void test("plan walks around a conveyor unless that is the goal", async () => {
  const pilot = conveyorPilot(() => [0, 1]);
  const [here, path] = await plan(pilot, [4, 1], false);
  assert.deepEqual(here, [0, 1]);
  assert.ok(path.length >= 2);
  assert.ok(!path.some(([x, y]) => x === 2 && y === 1), "planned through the conveyor");
  const [, toConveyor] = await plan(pilot, [2, 1], false);
  assert.deepEqual(toConveyor.at(-1), [2, 1]);
});

void test("navigate ignores the game's route when it crosses a conveyor", async () => {
  let here: Cell = [0, 1];
  const pilot = conveyorPilot(() => here);
  // A straight route from (0, 1) through the conveyor at (2, 1) to the goal.
  pilot.on("route", () => ({
    route: {
      from: [0, 1],
      cells: [
        [16, -16],
        [32, -16],
        [48, -16],
        [64, -16],
        [80, -16],
      ],
    },
  }));
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (Array.isArray(to) && typeof to[0] === "number" && typeof to[1] === "number") {
      here = [to[0], to[1]];
    }
    return { ok: true, pos: { map: 260, cell: [here[0], here[1]] } };
  });
  assert.deepEqual(await navigate(pilot, [4, 1], false), [true, "到达 (4, 1)"]);
  assert.ok(pilot.calls.some((call) => call.kind === "send" && call.op === "route"));
  const walks = walkedTo(pilot);
  assert.ok(walks.length > 0);
  assert.notDeepEqual(walks[0], [4, 1], "used the game's straight route through the conveyor");
});

void test("a conveyor ride is reported and recorded as a way in the atlas", async () => {
  let here: Cell = [0, 1];
  const pilot = conveyorPilot(() => here);
  pilot.on("route", { route: {} });
  pilot.on("walk", () => {
    here = [9, 30];
    return { ok: true, pos: { map: 260, cell: [9, 30] } };
  });
  const links: unknown[] = [];
  const state: MoveState = {
    drake: null,
    link: (mapId, from, to, how) => {
      links.push({ mapId, from: [...from], to: [...to], how });
      return Promise.resolve();
    },
  };
  assert.deepEqual(await navigate(pilot, [4, 1], false, () => undefined, 8, state), [
    false,
    "踩到传送带 (2, 1),被带到 (9, 30)",
  ]);
  assert.deepEqual(links, [{ mapId: 260, from: [2, 1], to: [9, 30], how: "传送带" }]);
});

void test("a ride read as it starts is followed to where the belt stops", async () => {
  // 10-27, map 261: the walk's reply still showed the party on the belt, and the atlas got a
  // ride from (13, 23) to (13, 23).
  let here: Cell = [0, 1];
  let polls = 0;
  const pilot = conveyorPilot(() => here);
  pilot.on("route", { route: {} });
  pilot.on("walk", () => {
    here = [2, 1];
    return { ok: true, pos: { map: 260, cell: [2, 1], moving: true } };
  });
  pilot.on("pos", () => {
    polls += 1;
    if (polls > 3) here = [9, 30]; // the belt moves the party on after a few polls
    return { pos: { map: 260, cell: [here[0], here[1]], moving: polls <= 3 } };
  });
  const links: unknown[] = [];
  const state: MoveState = {
    drake: null,
    link: (mapId, from, to, how) => {
      links.push({ mapId, from: [...from], to: [...to], how });
      return Promise.resolve();
    },
  };
  const [, text] = await navigate(pilot, [4, 1], false, () => undefined, 8, state);
  assert.equal(text, "踩到传送带 (2, 1),被带到 (9, 30)");
  assert.deepEqual(links, [{ mapId: 260, from: [2, 1], to: [9, 30], how: "传送带" }]);
});

void test("a clerk behind a counter is talked to through the counter, not from behind", async () => {
  // 10-27, Karnak's item shop: the cell behind the clerk was reachable, the player talked from
  // there, and no shop opened. The RelayInteraction in front of the clerk marks the counter.
  let here: Cell = [0, 4];
  const rows = ["00000", "00000", "00000", "00000", "00000"];
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 89, cell: [here[0], here[1]] } }));
  pilot.on("cells", () => ({
    cells: { origin: [0, 0], center: [here[0], here[1]], attr: rows.map(() => [0, 0, 0, 0, 0]) },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here[0], here[1]],
      layers: [{ name: "GroundCollision", rows }],
    },
  }));
  pilot.on("entities", (fields) => {
    const byKind: Record<string, unknown[]> = {
      RelayInteraction: [{ kind: "RelayInteraction", cell: [2, 2], active: true }],
      Npc: [{ kind: "Npc", cell: [2, 1], name: "帽子を被った男性（緑）", active: true }],
    };
    const list = byKind[String(fields.kind)] ?? [];
    return { entities: { total: list.length, entities: list } };
  });
  pilot.on("route", { route: {} });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (Array.isArray(to) && typeof to[0] === "number" && typeof to[1] === "number") {
      here = [to[0], to[1]];
    }
    return { ok: true, pos: { map: 89, cell: [here[0], here[1]] } };
  });
  pilot.on("keys", { ok: true });
  pilot.on("story", { pages: 1 });
  const text = await openAt(pilot, [2, 1]);
  assert.equal(text, "站在 (2, 3) 隔着柜台面朝Up按了确认,之后翻了 1 页对话");
});

void test("a world-map walk keeps off other places' entrances but may end on its own", async () => {
  // 10-27: the way to the Fire-Powered Ship crossed Karnak Castle's door and walked in.
  const pilot = new FakePilot();
  const grass = Array.from({ length: 3 }, () => [3, 3, 3, 3, 3]);
  pilot.on("cells", { cells: { origin: [0, 0], center: [0, 1], attr: grass } });
  pilot.onQuery("sample", { sample: { field: { moveState: null } } });
  pilot.when("entities", (fields) => fields.kind === "GotoMap" && fields.max === 300, {
    entities: {
      total: 2,
      entities: [
        { kind: "GotoMap", cell: [2, 1], name: "カルナック城" },
        { kind: "GotoMap", cell: [4, 1], name: "火力船" },
      ],
    },
  });
  const [, path] = await plan(pilot, [4, 1], false);
  assert.deepEqual(path.at(-1), [4, 1], "the goal is an entrance and stays reachable");
  assert.ok(
    !path.some(([x, y]) => x === 2 && y === 1),
    `went through the castle door: ${JSON.stringify(path)}`,
  );
});

void test("indoors the sideways-stairs plan is used only when the strict one cannot arrive", async () => {
  const pilot = new FakePilot();
  const rows = ["11111", "00300", "11111"];
  pilot.on("pos", { pos: { map: 261, cell: [0, 1] } });
  pilot.on("cells", { cells: { origin: [0, 0], center: [0, 1], attr: [[0, 0, 0, 0, 0]] } });
  pilot.on("collision", {
    collision: { searchLayer: 0, playerCell: [0, 1], layers: [{ name: "GroundCollision", rows }] },
  });
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  const [, across] = await plan(pilot, [4, 1], false);
  assert.deepEqual(across.at(-1), [4, 1]);
  const [, near] = await plan(pilot, [1, 1], false);
  assert.ok(!near.some(([x]) => x === 2), "a reachable goal keeps the strict path");
});

void test("route points on half cells convert one cell per point", () => {
  // 10-27, Fire-Powered Ship 261: the game's route to the exit (10, 25) from (16, 18).
  const route = {
    from: [16, 18],
    cells: [
      [40, -8, 0],
      [24, -8, 0],
      [8, -8, 0],
      [-8, -8, 0],
      [-24, -8, 0],
      [-40, -8, 0],
      [-40, -24, 0],
      [-40, -40, 0],
    ],
  };
  assert.deepEqual(routeCells(route), [
    [16, 18],
    [15, 18],
    [14, 18],
    [13, 18],
    [12, 18],
    [11, 18],
    [11, 19],
    [11, 20],
  ]);
});

void test("the game's route that stops beside the goal gets the last step", async () => {
  const pilot = new FakePilot();
  pilot.on("route", {
    route: {
      from: [16, 18],
      cells: [
        [40, -8, 0],
        [24, -8, 0],
        [8, -8, 0],
      ],
    },
  });
  assert.deepEqual(await gameRoute(pilot, [13, 18]), [
    [16, 18],
    [15, 18],
    [14, 18],
    [13, 18],
  ]);
  assert.deepEqual(await gameRoute(pilot, [10, 18]), [], "two cells short is not a route");
});

void test("a straight-line fallback route is not taken for the game's route", async () => {
  // 10-27, 261: the collision search found nothing and the bridge sent SearchSimple's line.
  const pilot = new FakePilot();
  const cells = [
    [40, -8, 0],
    [24, -8, 0],
    [8, -8, 0],
  ];
  pilot.on("route", [
    { route: { from: [16, 18], cells, tries: { theirs: 0, simple: 3, used: "simple" } } },
    { route: { from: [16, 18], cells, tries: { theirs: 3, used: "theirs" } } },
    { route: { from: [16, 18], cells, tries: { "theirs@2": 3, used: "theirs@2" } } },
  ]);
  assert.deepEqual(await gameRoute(pilot, [14, 18]), []);
  assert.deepEqual((await gameRoute(pilot, [14, 18])).at(-1), [14, 18]);
  assert.deepEqual((await gameRoute(pilot, [14, 18])).at(-1), [14, 18], "another height counts");
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptEntry } from "./fake-pilot.ts";
import { FakePilot, recordedCalls, scriptReplies } from "./fake-pilot.ts";
import type { Cell, CellGrid } from "../src/engine/nav.ts";
import { Atlas } from "../src/engine/atlas.ts";
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
    const out = await navigate(pilot, [10, 0], true, (line) => said.push(line), 8, oldWorld());
    return { out, said };
  },
  "a blocked step closes that step": async (pilot) => {
    const said: string[] = [];
    const out = await navigate(pilot, [17, 17], true, (line) => said.push(line), 8, oldWorld());
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
    noWalkpath(pilot);
    assert.deepEqual(await run(pilot), item.out);
    const settleCalls = settle.map(() => ({ kind: "send", op: "pos", fields: {}, wait: 30 }));
    const extraCalls = extra ? [extra.call] : [];
    const calls = recordedCalls(pilot).filter(
      (call) => !isEntranceQuery(call) && !isWalkpathCall(call),
    );
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

/** The window-only world plan the Python transcripts recorded (no bridge `cells.at`). */
function oldWorld(): MoveState {
  return { drake: null, world: { maps: new Map(), at: false } };
}

/** A bridge without walkpath, as the Python-era transcripts and the old walk tests assume. */
function noWalkpath(pilot: FakePilot): void {
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
}

function isWalkpathCall(call: unknown): boolean {
  return (call as { op?: unknown }).op === "walkpath";
}

function toPosReply(pos: { map: number; cell: Cell }): TranscriptEntry {
  return { kind: "send", op: "pos", reply: { pos } };
}

void test("an entrance that swaps the map just after the last step is entering, not arriving", async () => {
  const pilot = new FakePilot();
  noEntrances(pilot);
  noWalkpath(pilot);
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
  noWalkpath(pilot);
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

/** A 5x3 room with the middle column walled above and below the belt at (2,1). */
function beltPilot(here: () => Cell): FakePilot {
  const rows = ["00100", "00000", "00100"];
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 260, cell: [here()[0], here()[1]] } }));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [here()[0], here()[1]],
      attr: rows.map(() => Array.from({ length: 5 }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here()[0], here()[1]],
      layers: [{ name: "GroundCollision", rows }],
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
  pilot.on("route", { route: {} });
  return pilot;
}

function arrivedAt(here: Cell): Record<string, unknown> {
  return {
    ok: true,
    reason: "arrived",
    index: 0,
    steps: 0,
    pos: { map: 260, cell: [here[0], here[1]] },
    next: null,
    turns: [],
  };
}

void test("a conveyor ride is reported, recorded, and go walks on to the goal", async () => {
  let here: Cell = [0, 1];
  let sent = 0;
  const pilot = beltPilot(() => here);
  pilot.on("walkpath", () => {
    sent += 1;
    if (sent === 1) {
      here = [0, 2];
      return {
        ok: false,
        reason: "off_path",
        index: -1,
        steps: 0,
        pos: { map: 260, cell: [0, 2] },
        next: null,
        turns: [],
      };
    }
    here = [4, 1];
    return arrivedAt(here);
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
    true,
    "在 (2, 1) 踩到传送带，被带到 (0, 2),从这里接着走\n" +
      "到达 (4, 1)(这条路上会踩到危险格 (2, 1),没有别的路,可能被水流冲走或被传送带带走)",
  ]);
  assert.equal(sent, 2, "the walk went on from the landing");
  assert.deepEqual(links, [{ mapId: 260, from: [2, 1], to: [0, 2], how: "传送带" }]);
});

void test("a ride read as it starts is followed to where the belt stops, then go walks on", async () => {
  // 10-27, map 261: the walk's reply still showed the party on the belt, and the atlas got a
  // ride from (13, 23) to (13, 23).
  let here: Cell = [0, 1];
  let polls = 0;
  let riding = false;
  let sent = 0;
  const pilot = beltPilot(() => here);
  pilot.on("walkpath", () => {
    sent += 1;
    if (sent === 1) {
      here = [2, 1];
      polls = 0;
      riding = true;
      return {
        ok: true,
        reason: "off_path",
        index: 1,
        steps: 1,
        pos: { map: 260, cell: [2, 1], moving: true },
        next: null,
        turns: [],
      };
    }
    here = [4, 1];
    return arrivedAt(here);
  });
  pilot.on("pos", () => {
    if (riding) {
      polls += 1;
      if (polls > 3) {
        here = [0, 2]; // the belt moves the party on after a few polls
        riding = false;
      }
    }
    return { pos: { map: 260, cell: [here[0], here[1]], moving: riding } };
  });
  const links: unknown[] = [];
  const state: MoveState = {
    drake: null,
    link: (mapId, from, to, how) => {
      links.push({ mapId, from: [...from], to: [...to], how });
      return Promise.resolve();
    },
  };
  const [reached, text] = await navigate(pilot, [4, 1], false, () => undefined, 8, state);
  assert.equal(reached, true);
  assert.equal(
    text,
    "在 (2, 1) 踩到传送带，被带到 (0, 2),从这里接着走\n" +
      "到达 (4, 1)(这条路上会踩到危险格 (2, 1),没有别的路,可能被水流冲走或被传送带带走)",
  );
  assert.deepEqual(links, [{ mapId: 260, from: [2, 1], to: [0, 2], how: "传送带" }]);
});

void test("the same conveyor edge carrying the party twice stops one go", async () => {
  // The belt throws the party back to (0,2) every time, so the second try is the same edge.
  let here: Cell = [0, 1];
  let sent = 0;
  const pilot = beltPilot(() => here);
  pilot.on("walkpath", () => {
    sent += 1;
    here = [0, 2];
    return {
      ok: false,
      reason: "off_path",
      index: -1,
      steps: 0,
      pos: { map: 260, cell: [0, 2] },
      next: null,
      turns: [],
    };
  });
  assert.deepEqual(await navigate(pilot, [4, 1], false, () => undefined, 8), [
    false,
    "在 (2, 1) 踩到传送带，被带到 (0, 2),从这里接着走\n" +
      "在 (2, 1) 踩到传送带，被带到 (0, 2),从这里接着走\n" +
      "同一处 (2, 1) → (0, 2) 被带走了 2 次,停下",
  ]);
  assert.equal(sent, 2, "the third walk was not sent");
});

void test("carrying away more than the total limit stops one go", async () => {
  let here: Cell = [0, 1];
  const pilot = beltPilot(() => here);
  pilot.on("walkpath", () => {
    here = [0, 2];
    return {
      ok: false,
      reason: "off_path",
      index: -1,
      steps: 0,
      pos: { map: 260, cell: [0, 2] },
      next: null,
      turns: [],
    };
  });
  const state: MoveState = { drake: null, carryTotalLimit: 1 };
  const [reached, text] = await navigate(pilot, [4, 1], false, () => undefined, 8, state);
  assert.equal(reached, false);
  assert.equal(
    text,
    "在 (2, 1) 踩到传送带，被带到 (0, 2),从这里接着走\n" +
      "这次 go 里已经被带走了 1 次,到上限了,停下",
  );
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
  noWalkpath(pilot);
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

void test("indoors a 3/5 wall is not crossed even when it is the only way", async () => {
  // 11-03, Fire-Powered Ship 261: the old plan treated the 3 as a stair and crossed it
  // sideways; the game refused every such step. The walled side stays closed now.
  const pilot = new FakePilot();
  const rows = ["11111", "00300", "11111"];
  pilot.on("pos", { pos: { map: 261, cell: [0, 1] } });
  pilot.on("cells", { cells: { origin: [0, 0], center: [0, 1], attr: [[0, 0, 0, 0, 0]] } });
  pilot.on("collision", {
    collision: { searchLayer: 0, playerCell: [0, 1], layers: [{ name: "GroundCollision", rows }] },
  });
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  const [, across] = await plan(pilot, [4, 1], false);
  assert.deepEqual(across.at(-1), [2, 1], "the 3 on (2,1) walls off its right edge");
  const [, near] = await plan(pilot, [1, 1], false);
  assert.ok(!near.some(([x]) => x === 2), "a reachable goal keeps the path before the wall");
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

/** An open indoor map whose position follows `here`, with no entities and no game route. */
function indoorPilot(here: () => Cell, size = 8): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 260, cell: [here()[0], here()[1]] } }));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [here()[0], here()[1]],
      attr: Array.from({ length: size }, () => Array.from({ length: size }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here()[0], here()[1]],
      layers: [
        { name: "GroundCollision", rows: Array.from({ length: size }, () => "0".repeat(size)) },
      ],
    },
  }));
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  pilot.on("route", { route: {} });
  pilot.on("wait", { ok: true });
  return pilot;
}

function walkpathCalls(pilot: FakePilot): Cell[][] {
  return pilot.calls.flatMap((call) => {
    if (call.kind !== "send" || call.op !== "walkpath") return [];
    const path = call.fields.path;
    if (!Array.isArray(path)) return [];
    return [
      path.flatMap((cell) =>
        Array.isArray(cell) && typeof cell[0] === "number" && typeof cell[1] === "number"
          ? [[cell[0], cell[1]] as Cell]
          : [],
      ),
    ];
  });
}

function isCellPath(path: readonly Cell[]): boolean {
  return path.every((cell, index) => {
    const before = path[index - 1];
    return (
      before === undefined || Math.abs(cell[0] - before[0]) + Math.abs(cell[1] - before[1]) === 1
    );
  });
}

void test("a route with corners is one walkpath of adjacent cells", async () => {
  let here: Cell = [0, 0];
  const pilot = indoorPilot(() => here, 6);
  pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    const last = path[path.length - 1];
    assert.ok(last);
    here = [last[0], last[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [here[0], here[1]] },
      next: null,
      turns: [],
    };
  });
  const said: string[] = [];
  assert.deepEqual(await navigate(pilot, [5, 5], false, (line) => said.push(line)), [
    true,
    "到达 (5, 5)",
  ]);
  const paths = walkpathCalls(pilot);
  assert.equal(paths.length, 1, "one command for the whole route");
  const path = paths[0];
  assert.ok(path);
  assert.deepEqual(path[0], [0, 0]);
  assert.deepEqual(path.at(-1), [5, 5]);
  assert.ok(isCellPath(path));
  // One line per plan, not one per corner.
  assert.equal(said.filter((line) => line.includes("格")).length, 1);
});

void test("walkpath carries the tool label and goal, and the reply fills the walk view", async () => {
  let here: Cell = [0, 0];
  const pilot = indoorPilot(() => here, 6);
  const sent: Record<string, unknown>[] = [];
  pilot.on("walkpath", (fields) => {
    sent.push(fields);
    const path = fields.path as Cell[];
    const last = path[path.length - 1];
    assert.ok(last);
    here = [last[0], last[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [here[0], here[1]] },
      next: null,
      turns: [],
    };
  });
  const state: MoveState = {
    drake: null,
    game: "ff5",
    label: "go → 地图 260「图尔村」",
    hop: 2,
  };
  assert.deepEqual(await navigate(pilot, [5, 5], false, () => undefined, 8, state), [
    true,
    "到达 (5, 5)",
  ]);
  const first = sent[0];
  assert.ok(first);
  assert.equal(first.label, "go → 地图 260「图尔村」 第 2 跳");
  assert.deepEqual(first.goal, [5, 5]);
  const view = state.walk;
  assert.ok(view);
  assert.equal(view.game, "ff5");
  assert.equal(view.map, 260);
  assert.equal(view.index, view.steps);
  assert.equal(view.reason, "arrived");
  assert.notEqual(view.endedAt, null);
  assert.equal(view.segment.n, 2, "the L-shaped route turns once");
  assert.ok(
    view.rows.some((row) => row.includes(".")),
    "the floor is drawn",
  );
});

void test("a battle on the way does not use up a leg and the walk is replanned", async () => {
  let here: Cell = [0, 0];
  let sent = 0;
  const pilot = indoorPilot(() => here, 10);
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    if (sent === 1) {
      here = [4, 0];
      return {
        ok: false,
        reason: "battle",
        index: 4,
        steps: 4,
        pos: { map: 260, cell: [4, 0], battle: true },
        next: null,
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    here = [last[0], last[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [here[0], here[1]] },
      next: null,
      turns: [],
    };
  });
  pilot.onQuery("battlemenu", { battlemenu: {} });
  pilot.on("battle", { ok: true, seconds: 3 });
  const said: string[] = [];
  // One leg is enough only because the battle's replan is free.
  assert.deepEqual(await navigate(pilot, [8, 0], false, (line) => said.push(line), 1), [
    true,
    "到达 (8, 0)",
  ]);
  assert.equal(sent, 2);
  assert.ok(said.some((line) => line.includes("途中遇敌")));
});

void test("a blocked walkpath step is cut and the next plan goes around it", async () => {
  let here: Cell = [0, 0];
  let sent = 0;
  const pilot = indoorPilot(() => here, 6);
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    if (sent === 1) {
      here = [1, 0];
      return {
        ok: false,
        reason: "blocked",
        index: 1,
        steps: 1,
        pos: { map: 260, cell: [1, 0] },
        next: [2, 0],
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    here = [last[0], last[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [here[0], here[1]] },
      next: null,
      turns: [],
    };
  });
  const links: unknown[] = [];
  const state: MoveState = {
    drake: null,
    link: (_map, from, to, how) => {
      links.push({ from: [...from], to: [...to], how });
      return Promise.resolve();
    },
  };
  assert.deepEqual(await navigate(pilot, [4, 0], false, () => undefined, 4, state), [
    true,
    "到达 (4, 0)",
  ]);
  assert.ok(state.cuts?.get("260")?.has("1,0>2,0"));
  assert.deepEqual(links, [{ from: [1, 0], to: [2, 0], how: "走不过去" }]);
  const paths = walkpathCalls(pilot);
  assert.ok(
    paths[0]?.some(
      (cell, index) => cell[0] === 1 && cell[1] === 0 && paths[0]?.[index + 1]?.[0] === 2,
    ),
  );
  assert.ok(
    !paths[1]?.some(
      (cell, index) => cell[0] === 1 && cell[1] === 0 && paths[1]?.[index + 1]?.[0] === 2,
    ),
    "the new route walked into the cut step",
  );
});

interface EventPilot {
  readonly pilot: FakePilot;
  here: () => Cell;
  map: () => number;
  setHere: (cell: Cell) => void;
  setMap: (map: number) => void;
}

/** An indoor map (map 265) with one named Event cell and its collision rows. */
function eventGoalPilot(rows: readonly string[], event: Cell, name: string): EventPilot {
  let here: Cell = [0, 0];
  let map = 265;
  const width = rows[0]?.length ?? 0;
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map, cell: [here[0], here[1]] } }));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [here[0], here[1]],
      attr: Array.from({ length: rows.length }, () => Array.from({ length: width }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here[0], here[1]],
      layers: [{ name: "GroundCollision", rows: [...rows] }],
    },
  }));
  pilot.on("entities", (fields) =>
    fields.kind === "Event"
      ? {
          entities: {
            total: 1,
            entities: [{ kind: "Event", cell: [event[0], event[1]], name, active: true }],
          },
        }
      : { entities: { total: 0, entities: [] } },
  );
  pilot.on("route", { route: {} });
  pilot.on("wait", { ok: true });
  return {
    pilot,
    here: () => here,
    map: () => map,
    setHere: (cell) => {
      here = [cell[0], cell[1]];
    },
    setMap: (value) => {
      map = value;
    },
  };
}

void test("go tries an event goal again and does not record the refused steps", async () => {
  // 11-10, Fire-Powered Ship 265: (12,16)→(13,16) was refused by go, but grind walked it
  // later. The same step is tried again instead of becoming a permanent wall.
  const env = eventGoalPilot(["000000", "000000", "000000"], [2, 0], "通路に流される3");
  let attempts = 0;
  env.pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    if (fields.goal === undefined) {
      attempts += 1;
      if (attempts < 3) {
        return {
          ok: false,
          reason: "blocked",
          index: 0,
          steps: 0,
          pos: { map: 265, cell: [1, 0] },
          next: [2, 0],
          turns: [],
        };
      }
      env.setMap(261);
      env.setHere([2, 0]);
      return {
        ok: false,
        reason: "state:Event",
        index: 1,
        steps: 1,
        pos: { map: 265, cell: [2, 0], state: "Event" },
        next: null,
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    env.setHere(last);
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: env.map(), cell: [last[0], last[1]] },
      next: null,
      turns: [],
    };
  });
  const links: unknown[] = [];
  const state: MoveState = {
    drake: null,
    link: (_map, from, to, how) => {
      links.push({ from: [...from], to: [...to], how });
      return Promise.resolve();
    },
  };
  assert.deepEqual(await navigate(env.pilot, [2, 0], false, () => undefined, 8, state), [
    true,
    "进入了地图 261,现在在 [2, 0]",
  ]);
  assert.equal(attempts, 3, "the step was tried three times from the same side");
  assert.deepEqual(links, [], "a refused event step is not written as 走不过去");
  assert.deepEqual([...(state.cuts?.get("265") ?? [])], []);
});

void test("go names every side it tried when an event goal stays blocked", async () => {
  // The cell above (2,0) is a wall and the one below is off the map, so only (1,0) and
  // (3,0) can be stood on; the report must name exactly those and the tries per side.
  const env = eventGoalPilot(["000000", "001000", "000000", "000000"], [2, 0], "通路に流される3");
  let attempts = 0;
  env.pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    if (fields.goal === undefined) {
      attempts += 1;
      const from = path[0];
      assert.ok(from);
      return {
        ok: false,
        reason: "blocked",
        index: 0,
        steps: 0,
        pos: { map: 265, cell: [from[0], from[1]] },
        next: [2, 0],
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    env.setHere(last);
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: env.map(), cell: [last[0], last[1]] },
      next: null,
      turns: [],
    };
  });
  const links: unknown[] = [];
  const state: MoveState = {
    drake: null,
    link: (_map, from, to, how) => {
      links.push({ from: [...from], to: [...to], how });
      return Promise.resolve();
    },
  };
  assert.deepEqual(await navigate(env.pilot, [2, 0], false, () => undefined, 8, state), [
    false,
    "(2, 0) 是事件格「通路に流される3」,从 (1, 0)、(3, 0) 各试了 3 次都被游戏挡住，没记成走不过去",
  ]);
  assert.equal(attempts, 6, "three tries from each of the two standable sides");
  assert.deepEqual(links, []);
  assert.deepEqual([...(state.cuts?.get("265") ?? [])], []);
});

void test("an old blocked record onto an event cell no longer closes the step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-event-"));
  const file = join(directory, "atlas.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        260: {
          name: "火力船",
          exits: [],
          chests: [],
          links: [{ from: [1, 0], to: [2, 0], how: "走不过去", count: 1 }],
        },
      }),
      "utf8",
    );
    const atlas = await Atlas.load(file);
    const env = eventGoalPilot(["000000", "111111"], [2, 0], "通路に流される3");
    const state: MoveState = { drake: null, moves: () => atlas.moves(260) };
    const [here, path] = await plan(env.pilot, [3, 0], false, new Set<string>(), state, 260);
    assert.deepEqual(here, [0, 0]);
    assert.deepEqual(path.at(-1), [3, 0], "the recorded step is not a wall for an event cell");
    assert.equal(atlas.moves(260).length, 1, "the record is kept, only not used");
    // Without entity information (an old bridge, a failed query) the record still counts.
    env.pilot.on("entities", { entities: { total: 0, entities: [] } });
    const [, withoutEvents] = await plan(env.pilot, [3, 0], false, new Set<string>(), state, 260);
    assert.deepEqual(withoutEvents.at(-1), [1, 0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("off path is replanned from where the party is", async () => {
  let here: Cell = [0, 0];
  let sent = 0;
  const pilot = indoorPilot(() => here, 6);
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    if (sent === 1) {
      return {
        ok: false,
        reason: "off_path",
        index: -1,
        steps: 0,
        pos: { map: 260, cell: [0, 0] },
        next: null,
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    here = [last[0], last[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [here[0], here[1]] },
      next: null,
      turns: [],
    };
  });
  assert.deepEqual(await navigate(pilot, [3, 0], false, () => undefined, 4), [true, "到达 (3, 0)"]);
  assert.equal(sent, 2);
});

void test("a map change reported by walkpath is entering a map", async () => {
  const pilot = indoorPilot(() => [0, 0], 6);
  let map = 260;
  pilot.on("pos", () => ({ pos: { map, cell: [4, 0] } }));
  pilot.on("walkpath", () => {
    map = 261;
    return {
      ok: false,
      reason: "map_changed",
      index: 4,
      steps: 4,
      pos: { map: 260, cell: [4, 0] },
      next: null,
      turns: [],
    };
  });
  assert.deepEqual(await navigate(pilot, [4, 0], false), [true, "进入了地图 261,现在在 [4, 0]"]);
});

void test("a same-map go carried to another map stops when the record has no way back", async () => {
  const pilot = indoorPilot(() => [0, 0], 8);
  let map = 260;
  pilot.on("pos", () => ({ pos: { map, cell: [5, 0] } }));
  pilot.on("walkpath", () => {
    map = 261;
    return {
      ok: false,
      reason: "map_changed",
      index: 2,
      steps: 2,
      pos: { map: 260, cell: [2, 0] },
      next: null,
      turns: [],
    };
  });
  assert.deepEqual(await navigate(pilot, [5, 0], false), [
    false,
    "原目标在地图 260 (5, 0),中途在 (2, 0) 被带到地图 261 (5, 0),按地图记录回不去",
  ]);
});

void test("a same-map go carried to another map walks back when the record has a way", async () => {
  const pilot = indoorPilot(() => [0, 0], 8);
  let map = 260;
  pilot.on("pos", () => ({ pos: { map, cell: [5, 0] } }));
  pilot.on("walkpath", () => {
    map = 261;
    return {
      ok: false,
      reason: "map_changed",
      index: 2,
      steps: 2,
      pos: { map: 260, cell: [2, 0] },
      next: null,
      turns: [],
    };
  });
  const asked: unknown[] = [];
  const state: MoveState = {
    drake: null,
    routeBack: (from, to) => {
      asked.push({ from, to });
      return true;
    },
    returnToGoal: (runner, goalMap, goal) => {
      assert.equal(runner, pilot);
      assert.equal(goalMap, 260);
      assert.deepEqual(goal, [5, 0]);
      return Promise.resolve([true, "到达 (5, 0)"]);
    },
  };
  assert.deepEqual(await navigate(pilot, [5, 0], false, () => undefined, 8, state), [
    true,
    "中途在 (2, 0) 被带到地图 261 (5, 0),地图记录里有回去的路,从这里走回去\n到达 (5, 0)",
  ]);
  assert.deepEqual(asked, [{ from: 261, to: 260 }]);
});

void test("a carry that falls onto another map reports both maps and stops", async () => {
  let here: Cell = [0, 1];
  const pilot = conveyorPilot(() => here);
  pilot.on("route", { route: {} });
  pilot.on("walk", () => {
    here = [3, 3];
    return { ok: true, pos: { map: 261, cell: [3, 3] } };
  });
  assert.deepEqual(await navigate(pilot, [4, 1], false), [
    false,
    "在 (2, 1) 踩到传送带，被带到 (3, 3),从这里接着走\n" +
      "原目标在地图 260 (4, 1),中途在 (2, 1) 被带到地图 261 (3, 3),按地图记录回不去",
  ]);
});

void test("a state event that turns into a battle is fought as one", async () => {
  let here: Cell = [0, 0];
  let event = false;
  let polls = 0;
  const pilot = indoorPilot(() => here, 10);
  pilot.on("pos", () => {
    if (!event) return { pos: { map: 260, cell: [here[0], here[1]], state: "Player" } };
    polls += 1;
    if (polls === 1) {
      return { pos: { map: 260, cell: [here[0], here[1]], state: "Event" } };
    }
    if (polls === 2) {
      return { pos: { map: 260, cell: [here[0], here[1]], state: "Battle", battle: true } };
    }
    return { pos: { map: 260, cell: [here[0], here[1]], state: "Player" } };
  });
  let sent = 0;
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    if (sent === 1) {
      here = [4, 0];
      event = true;
      return {
        ok: false,
        reason: "state:Event",
        index: 4,
        steps: 4,
        pos: { map: 260, cell: [4, 0], state: "Event", battle: false },
        next: null,
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    here = [last[0], last[1]];
    event = false;
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [here[0], here[1]], state: "Player" },
      next: null,
      turns: [],
    };
  });
  pilot.onQuery("battlemenu", { battlemenu: {} });
  pilot.on("battle", { ok: true, seconds: 3 });
  const said: string[] = [];
  // One leg is enough only because the battle's replan is free.
  assert.deepEqual(await navigate(pilot, [8, 0], false, (line) => said.push(line), 1), [
    true,
    "到达 (8, 0)",
  ]);
  assert.equal(sent, 2);
  assert.equal(
    pilot.calls.filter((call) => call.kind === "send" && call.op === "battle").length,
    1,
  );
  assert.ok(said.some((line) => line.includes("途中遇敌")));
});

void test("a brief state event back to Player replans and keeps walking", async () => {
  let here: Cell = [0, 0];
  let event = false;
  let polls = 0;
  const pilot = indoorPilot(() => here, 10);
  pilot.on("pos", () => {
    if (event) {
      polls += 1;
      event = false;
      return { pos: { map: 260, cell: [here[0], here[1]], state: "Event" } };
    }
    return { pos: { map: 260, cell: [here[0], here[1]], state: "Player" } };
  });
  let sent = 0;
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    if (sent === 1) {
      here = [3, 0];
      event = true;
      return {
        ok: false,
        reason: "state:Event",
        index: 3,
        steps: 3,
        pos: { map: 260, cell: [3, 0], state: "Event" },
        next: null,
        turns: [],
      };
    }
    const last = path[path.length - 1];
    assert.ok(last);
    here = [last[0], last[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [here[0], here[1]], state: "Player" },
      next: null,
      turns: [],
    };
  });
  const said: string[] = [];
  assert.deepEqual(await navigate(pilot, [6, 0], false, (line) => said.push(line)), [
    true,
    "到达 (6, 0)",
  ]);
  assert.equal(sent, 2);
  assert.equal(polls, 1, "one Event frame, then Player");
  assert.ok(!pilot.calls.some((call) => call.kind === "send" && call.op === "battle"));
  assert.ok(!said.some((line) => line.includes("途中遇敌")));
});

void test("a state event that stays Event stops the walk with interrupted", async () => {
  const pilot = indoorPilot(() => [0, 0], 6);
  pilot.on("pos", () => ({ pos: { map: 260, cell: [2, 0], state: "Event" } }));
  pilot.on("walkpath", () => ({
    ok: false,
    reason: "state:Event",
    index: 2,
    steps: 2,
    pos: { map: 260, cell: [2, 0], state: "Event" },
    next: null,
    turns: [],
  }));
  const [, text] = await navigate(pilot, [4, 0], false);
  assert.match(text, /停在 \[2, 0\].*interrupted:state:Event/);
  // It watched the Event for the whole 2.5 s instead of returning on the first frame.
  assert.equal(pilot.now(), 2_500);
});

void test("an old bridge falls back to the corner-by-corner walk", async () => {
  let here: Cell = [0, 0];
  const pilot = indoorPilot(() => here, 6);
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (Array.isArray(to) && typeof to[0] === "number" && typeof to[1] === "number") {
      here = [to[0], to[1]];
    }
    return { ok: true, pos: { map: 260, cell: [here[0], here[1]] } };
  });
  assert.deepEqual(await navigate(pilot, [4, 0], false), [true, "到达 (4, 0)"]);
  const ops = pilot.calls.flatMap((call) => (call.kind === "send" ? [call.op] : []));
  assert.equal(ops.filter((op) => op === "walkpath").length, 1);
  assert.ok(ops.includes("walk"));
});

void test("a game route given only at its corners is filled into cells", async () => {
  const goal: Cell = [4, 3];
  let here: Cell = [0, 0];
  const pilot = indoorPilot(() => here, 6);
  pilot.on("route", {
    route: {
      from: [0, 0],
      cells: [
        [0, 0, 0],
        [64, 0, 0],
        [64, 48, 0],
      ],
    },
  });
  pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    here = [goal[0], goal[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [goal[0], goal[1]] },
      next: null,
      turns: [],
    };
  });
  assert.deepEqual(await navigate(pilot, goal, false), [true, "到达 (4, 3)"]);
  const path = walkpathCalls(pilot)[0];
  assert.deepEqual(path, [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [4, 1],
    [4, 2],
    [4, 3],
  ]);
});

void test("a diagonal game route is dropped for our own plan", async () => {
  const goal: Cell = [3, 3];
  let here: Cell = [0, 0];
  const pilot = indoorPilot(() => here, 5);
  pilot.on("route", {
    route: {
      from: [0, 0],
      cells: [
        [0, 0, 0],
        [48, 48, 0],
      ],
    },
  });
  pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    here = [goal[0], goal[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 260, cell: [goal[0], goal[1]] },
      next: null,
      turns: [],
    };
  });
  assert.deepEqual(await navigate(pilot, goal, false), [true, "到达 (3, 3)"]);
  const path = walkpathCalls(pilot)[0];
  assert.ok(path);
  assert.ok(isCellPath(path), "our own plan is given cell by cell");
  assert.ok(path.length > 2);
});

void test("a jump in the route stops the walkpath just before it", async () => {
  let here: Cell = [0, 0];
  const rows = ["000111", "000111", "000111", "111111", "111110", "111110"];
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 260, cell: [here[0], here[1]] } }));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [here[0], here[1]],
      attr: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here[0], here[1]],
      layers: [{ name: "GroundCollision", rows }],
    },
  }));
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  pilot.on("route", { route: {} });
  pilot.on("wait", { ok: true });
  let sent = 0;
  pilot.on("walkpath", (fields) => {
    sent += 1;
    const path = fields.path as Cell[];
    assert.deepEqual(path.at(-1), [2, 2], "sent past the conveyor jump");
    here = [5, 4];
    return {
      ok: false,
      reason: "off_path",
      index: -1,
      steps: 0,
      pos: { map: 260, cell: [5, 4] },
      next: null,
      turns: [],
    };
  });
  const state: MoveState = {
    drake: null,
    moves: () => [{ from: [2, 2], to: [5, 4], how: "传送带", kind: "conveyor" }],
  };
  assert.deepEqual(await navigate(pilot, [5, 4], false, () => undefined, 8, state), [
    true,
    "到达 (5, 4)",
  ]);
  assert.equal(sent, 1);
});

/** A world map with grass everywhere, a mountain wall at x=30, and one gap at y=25. */
function worldPilot(position: { cell: Cell }, withAt: boolean): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 1, cell: [position.cell[0], position.cell[1]] } }));
  pilot.on("cells", (fields) => {
    const r = typeof fields.r === "number" ? fields.r : 24;
    const at = fields.at;
    const cx = Array.isArray(at) && typeof at[0] === "number" ? at[0] : position.cell[0];
    const cy = Array.isArray(at) && typeof at[1] === "number" ? at[1] : position.cell[1];
    const attr = Array.from({ length: 2 * r + 1 }, (_, j) =>
      Array.from({ length: 2 * r + 1 }, (_, i) => {
        const x = cx - r + i;
        const y = cy - r + j;
        return x === 30 && y >= -24 && y <= 24 ? 19 : 3;
      }),
    );
    return {
      cells: {
        origin: [cx - r, cy - r],
        center: [position.cell[0], position.cell[1]],
        attr,
        ...(withAt && at !== undefined ? { at: [cx, cy] } : {}),
      },
    };
  });
  pilot.onQuery("sample", { sample: { field: { moveState: null } } });
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  pilot.on("wait", { ok: true });
  pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    const last = path[path.length - 1];
    assert.ok(last);
    position.cell = [last[0], last[1]];
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      steps: path.length - 1,
      pos: { map: 1, cell: [position.cell[0], position.cell[1]] },
      next: null,
      turns: [],
    };
  });
  return pilot;
}

void test("a world-map goal 60 cells away is reached in one plan over the merged terrain", async () => {
  const position = { cell: [0, 0] as Cell };
  const pilot = worldPilot(position, true);
  assert.deepEqual(await navigate(pilot, [60, 0], false), [true, "到达 (60, 0)"]);
  const paths = walkpathCalls(pilot);
  assert.equal(paths.length, 1, "one walkpath for the whole route");
  const path = paths[0];
  assert.ok(path);
  assert.ok(isCellPath(path));
  assert.ok(
    path.some(([x, y]) => x === 30 && Math.abs(y) > 24),
    `did not go around the mountain: ${JSON.stringify(path)}`,
  );
  const reads = pilot.calls.filter(
    (call) => call.kind === "send" && call.op === "cells" && call.fields.r === 24,
  );
  assert.ok(reads.length <= 40, `read ${reads.length} windows`);
});

void test("an old bridge without cells.at keeps the one-window world walk", async () => {
  const position = { cell: [0, 0] as Cell };
  const pilot = worldPilot(position, false);
  const [reached, message] = await navigate(pilot, [60, 0], false);
  assert.equal(reached, false);
  assert.match(message, /走不过去/);
  const paths = walkpathCalls(pilot);
  assert.ok(paths.length > 1, "the goal outside the window needs several walks");
  assert.ok((paths[0]?.at(-1)?.[0] ?? 0) < 60);
  const atReads = pilot.calls.filter(
    (call) => call.kind === "send" && call.op === "cells" && call.fields.at !== undefined,
  );
  assert.ok(atReads.length <= 1, "an old bridge is not asked for at again");
});

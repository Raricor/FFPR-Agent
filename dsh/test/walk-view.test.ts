import assert from "node:assert/strict";
import test from "node:test";
import type { Cell, CellGrid, LayeredGrid } from "../src/engine/nav.ts";
import { layeredGrid } from "../src/engine/nav.ts";
import { KeyEvents } from "../src/engine/events.ts";
import {
  applyWalkPush,
  beginWalk,
  cropWalk,
  indoorBase,
  segmentFor,
  updateWalkFromReply,
  walkDisplay,
  walkSegments,
  worldBase,
} from "../src/engine/walk-view.ts";

const PATH: readonly Cell[] = [
  [5, 8],
  [6, 8],
  [7, 8],
  [8, 8],
  [9, 8],
  [9, 9],
];
const STARTED = "2026-11-05T05:12:03.120Z";

function world(): CellGrid {
  return {
    origin: [10, 20],
    center: [11, 21],
    attr: [
      [16, 19, 27, 3, 4, null, 5],
      [0, 0, 0, 0, 0, 0, 0],
    ],
  };
}

function indoor(): LayeredGrid {
  const collision = {
    searchLayer: 1,
    playerCell: [1, 1],
    layers: [
      {
        name: "GroundCollision",
        rows: ["0111", "0001", "0101", "0000"],
      },
    ],
  };
  const grid = layeredGrid(collision, [[2, 2]]);
  assert.ok(grid);
  return grid;
}

void test('the world view uses ~ for sea, ^ for mountains and " for plains', () => {
  const base = worldBase("ff5", 1, world());
  assert.deepEqual(base.origin, [10, 20]);
  const row = base.rows[0] ?? "";
  assert.equal(row[0], "~");
  assert.equal(row[1], "^");
  assert.equal(row[2], "^");
  assert.equal(row[3], '"');
  assert.equal(row[4], '"');
  assert.equal(row[5], " ");
  assert.equal(row[6], ".");
});

void test("the indoor view shows the current layer's walls and floor", () => {
  const base = indoorBase("ff5", 260, indoor());
  assert.deepEqual(base.rows, [".###", "...#", ".###", "...."]);
});

void test("the view crops the route and goal with three cells of margin", () => {
  const base = worldBase("ff5", 1, world());
  const path: Cell[] = [
    [12, 22],
    [13, 22],
  ];
  const crop = cropWalk(base, path, [14, 22]);
  assert.deepEqual(crop.origin, [9, 19]);
  assert.equal(crop.rows.length, 7);
  assert.equal(crop.rows[0]?.length, 9);
});

void test("an L-shaped route has two segments and the second starts at the corner", () => {
  assert.deepEqual(walkSegments(PATH), [
    { from: [5, 8], to: [9, 8] },
    { from: [9, 8], to: [9, 9] },
  ]);
  assert.deepEqual(segmentFor(PATH, 0), {
    n: 1,
    of: 2,
    from: [5, 8],
    to: [9, 8],
  });
  assert.deepEqual(segmentFor(PATH, 4), {
    n: 2,
    of: 2,
    from: [9, 8],
    to: [9, 9],
  });
});

void test("walk.start, progress and end move the view and a wrong walkSeq is ignored", () => {
  const base = worldBase("ff5", 30, world());
  const goal: Cell = [12, 15];
  let view = beginWalk(base, PATH, goal, "go → 地图 30「图尔村」 第 2 跳", STARTED);
  assert.equal(view.seq, null);
  assert.equal(view.index, 0);

  view =
    applyWalkPush(
      view,
      {
        type: "walk.start",
        walkSeq: 12,
        map: 30,
        path: PATH,
        goal,
        label: "go → 地图 30「图尔村」 第 2 跳",
      },
      STARTED,
    ) ?? view;
  assert.equal(view.seq, 12);
  assert.equal(view.map, 30);

  view =
    applyWalkPush(
      view,
      {
        type: "walk.progress",
        walkSeq: 12,
        index: 3,
        steps: 5,
        cell: [8, 8],
        segment: { n: 1, of: 2 },
      },
      STARTED,
    ) ?? view;
  assert.equal(view.index, 3);
  assert.equal(view.cell[0], 8);
  assert.equal(view.segment.n, 1);

  const before = view;
  view =
    applyWalkPush(
      view,
      {
        type: "walk.progress",
        walkSeq: 13,
        index: 5,
        steps: 5,
        cell: [9, 9],
      },
      STARTED,
    ) ?? view;
  assert.equal(view, before, "another walkSeq does not touch this walk");

  view =
    applyWalkPush(
      view,
      { type: "walk.end", walkSeq: 12, reason: "arrived", index: 5, steps: 5, cell: [9, 9] },
      "2026-11-05T05:12:13.120Z",
    ) ?? view;
  assert.equal(view.index, 5);
  assert.equal(view.reason, "arrived");
  assert.equal(view.endedAt, "2026-11-05T05:12:13.120Z");
});

void test("a start with another path is ignored until the next plan", () => {
  const base = worldBase("ff5", 30, world());
  const view = beginWalk(base, PATH, [12, 15], "go", STARTED);
  const unchanged =
    applyWalkPush(
      view,
      {
        type: "walk.start",
        walkSeq: 7,
        map: 30,
        path: [
          [0, 0],
          [0, 1],
        ],
        goal: [0, 1],
      },
      STARTED,
    ) ?? view;
  assert.equal(unchanged.seq, null);
  assert.deepEqual(unchanged.path, PATH);
});

void test("without pushes the walkpath reply updates the index and reason", () => {
  const base = worldBase("ff5", 30, world());
  const view = beginWalk(base, PATH, [9, 9], "go", STARTED);
  const updated = updateWalkFromReply(
    view,
    {
      ok: false,
      reason: "blocked",
      index: 2,
      steps: 5,
      pos: { map: 30, cell: [7, 8] },
    },
    "2026-11-05T05:12:05.120Z",
  );
  assert.ok(updated);
  assert.equal(updated.index, 2);
  assert.equal(updated.cell[0], 7);
  assert.equal(updated.reason, "blocked");
  assert.equal(updated.segment.n, 1);
  assert.equal(updated.endedAt, "2026-11-05T05:12:05.120Z");
});

void test("the display lines name the state event and the elapsed time in Chinese", () => {
  const base = worldBase("ff5", 30, world());
  const view = beginWalk(base, PATH, [9, 9], "go", STARTED);
  const stopped = updateWalkFromReply(
    view,
    { ok: false, reason: "state:Event", index: 5, steps: 5, pos: { cell: [9, 9] } },
    "2026-11-05T05:13:03.120Z",
  );
  assert.ok(stopped);
  const display = walkDisplay(stopped, Date.parse("2026-11-05T05:14:03.120Z"));
  assert.equal(display.statusText, "剧情");
  assert.equal(display.progressText, "已走 5 / 5 格");
  assert.equal(display.segmentText, "第 2/2 段 (9, 8)→(9, 9)");
  assert.equal(display.elapsedText, "已用 1 分 00 秒");
});

void test("the event stream forwards live walk pushes to the walk listener", () => {
  const events = new KeyEvents();
  const seen: string[] = [];
  events.onWalk((record) => seen.push(String(record.type)));
  events.feed({ type: "hello", t: "2026-11-05T05:00:00Z", seq: 0 });
  events.feed({ type: "walk.start", seq: 1, walkSeq: 1, path: PATH, goal: [9, 9] });
  events.feed({ type: "sample", seq: 2 });
  events.feed({ type: "walk.end", seq: 3, walkSeq: 1, reason: "arrived" });
  assert.deepEqual(seen, ["walk.start", "walk.end"]);
});

void test("a walk push keeps the stream's own seq, so a later walk number is not dropped", () => {
  // 11-05: the bridge first wrote the walkpath number into `seq`; events.ts dedupes on `seq`,
  // so a push numbered 2 after stream record 900 was thrown away.
  const events = new KeyEvents();
  const seen: unknown[] = [];
  events.onWalk((record) => seen.push(record.walkSeq));
  events.feed({ type: "hello", t: "2026-11-05T05:00:00Z", seq: 0 });
  events.feed({ type: "sample", seq: 900 });
  events.feed({ type: "walk.start", seq: 901, walkSeq: 2, path: PATH, goal: [9, 9] });
  events.feed({ type: "walk.end", seq: 902, walkSeq: 2, reason: "arrived" });
  assert.deepEqual(seen, [2, 2]);
});

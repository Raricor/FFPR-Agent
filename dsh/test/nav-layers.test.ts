import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FakePilot } from "./fake-pilot.ts";
import {
  cellKey,
  edgeKey,
  layeredGrid,
  layeredRoute,
  layeredView,
  STAIRS,
} from "../src/engine/nav.ts";
import type { Cell, LayerChange, LayeredGrid } from "../src/engine/nav.ts";
import { navigate, plan } from "../src/engine/skills/move.ts";
import type { MoveState } from "../src/engine/skills/move.ts";

interface RecordedEntity {
  readonly kind: string;
  readonly active?: boolean;
  readonly cell: [number, number];
  readonly toMap?: number;
  readonly layer?: number;
  readonly changeLayer?: string;
}

interface Map261 {
  readonly pos: { readonly map: number; readonly cell: [number, number] };
  readonly cells: {
    readonly center: [number, number];
    readonly attr: number[][];
  };
  readonly collision: unknown;
  readonly entities: { readonly entities: RecordedEntity[] };
}

const map261 = JSON.parse(
  await readFile(
    join(import.meta.dirname, "fixtures", "nav", "map261-firepowered-ship.json"),
    "utf8",
  ),
) as Map261;

const TO_LAYER: LayerChange[] = map261.entities.entities
  .filter((entity) => entity.kind === "ToLayer" && entity.active !== false)
  .map((entity) => ({ cell: entity.cell, to: entity.layer ?? null }));

const TO_LAYER_CELLS: Cell[] = TO_LAYER.map((change) => [change.cell[0], change.cell[1]] as Cell);

/** The exits the bridge's route was asked about (11-03, Fire-Powered Ship 261). */
const EXITS: [number, number][] = [
  [10, 25],
  [13, 7],
  [20, 13],
  [6, 18],
  [20, 22],
  [16, 25],
  [18, 18],
];

/** These three were walked toward on 11-03; all are beyond a 3/5 wall from (17,21). */
const FORWARD_EXITS: [number, number][] = [
  [10, 25],
  [20, 22],
  [16, 25],
];

/** Steps the real walk on 11-03 found blocked: the walled sides of 5 and 3. */
const BLOCKED: readonly (readonly [Cell, Cell])[] = [
  [
    [8, 22],
    [7, 22],
  ],
  [
    [8, 23],
    [7, 23],
  ],
  [
    [17, 23],
    [18, 23],
  ],
];

function grid(): LayeredGrid {
  const found = layeredGrid(map261.collision, [], TO_LAYER);
  assert.ok(found, "map 261 collision");
  return found;
}

function codeAt(layered: LayeredGrid, cell: readonly [number, number, number]): string {
  return layered.heights.get(cell[2])?.[cell[1]]?.[cell[0]] ?? "1";
}

function assertHeightChangesAtStairsOrToLayer(
  layered: LayeredGrid,
  route: readonly (readonly [number, number, number])[],
  transitions: ReadonlySet<string>,
): void {
  for (let i = 1; i < route.length; i++) {
    const before = route[i - 1];
    const after = route[i];
    if (!before || !after || before[2] === after[2]) continue;
    assert.ok(
      transitions.has(cellKey(after[0], after[1])) ||
        transitions.has(cellKey(before[0], before[1])) ||
        STAIRS.has(codeAt(layered, before)) ||
        STAIRS.has(codeAt(layered, after)),
      `height changed at ${after.join(",")} without a stair or ToLayer cell`,
    );
  }
}

void test("map 261 starts on the route searcher's height and keeps two floors apart", () => {
  const layered = grid();
  assert.deepEqual(layered.center, [17, 21]);
  assert.equal(layered.z, 1);
  assert.deepEqual([...layered.heights.keys()], [1, 2]);
  assert.deepEqual(TO_LAYER_CELLS, [
    [15, 19],
    [16, 19],
    [15, 20],
    [16, 20],
  ]);
  assert.deepEqual(
    [...(layered.transitions ?? new Map()).entries()],
    [
      ["15,19", 2],
      ["16,19", 2],
      ["15,20", 1],
      ["16,20", 1],
    ],
  );
});

void test("only (18,18) is walkable from (17,21), over the 4 ledge", () => {
  // 11-03: with 3/5 as whole walls every exit was cut off; adding 2/4 opens the one door the
  // 4 ledge leads to. The other six are still behind 3/5 walls (conveyors/vents, not walking).
  const layered = grid();
  for (const exit of EXITS) {
    const route = layeredRoute(layered, exit);
    const end = route[route.length - 1];
    assert.ok(end, `${exit.join(",")} has a route`);
    const reached = end[0] === exit[0] && end[1] === exit[1];
    assert.equal(
      reached,
      exit[0] === 18 && exit[1] === 18,
      `${exit.join(",")}: ${JSON.stringify(end)}`,
    );
    assert.deepEqual(route[0], [17, 21, 1], `${exit.join(",")} starts on height 1`);
    assertHeightChangesAtStairsOrToLayer(
      layered,
      route,
      new Set(TO_LAYER_CELLS.map((c) => cellKey(...c))),
    );
  }
});

void test("routes from (17,21) and (13,13) never cross the steps the game blocked", () => {
  const layered = grid();
  const cut = new Set(BLOCKED.map(([from, to]) => edgeKey(from, to)));
  for (const start of [
    [17, 21],
    [13, 13],
  ] as const) {
    const from = { ...layered, center: [start[0], start[1]] as Cell };
    for (const exit of FORWARD_EXITS) {
      for (const edges of [cut, new Set<string>()]) {
        const route = layeredRoute(from, exit, edges);
        assert.ok(route.length > 0, `${start.join(",")} → ${exit.join(",")}`);
        for (let i = 1; i < route.length; i++) {
          const before = route[i - 1];
          const after = route[i];
          assert.ok(before && after, "route cells");
          assert.equal(
            edges.has(edgeKey([before[0], before[1]], [after[0], after[1]])),
            false,
            `${start.join(",")} → ${exit.join(",")} crossed a blocked step`,
          );
        }
      }
    }
  }
});

void test("the 4 ledge carries both starts to the (18,18) door", () => {
  const layered = grid();
  for (const start of [
    [17, 21],
    [13, 13],
  ] as const) {
    const route = layeredRoute({ ...layered, center: [start[0], start[1]] as Cell }, [18, 18]);
    assert.deepEqual(route.at(-1), [18, 18, 1], start.join(","));
    const cells = route.map(([x, y]) => cellKey(x, y));
    const ledge = cells.indexOf(cellKey(15, 18));
    assert.ok(ledge > 0, `${start.join(",")} entered the 4 ledge`);
    assert.equal(cells[ledge - 1], cellKey(15, 17), "entered the 4 from above, not below");
    assert.ok(cells.includes(cellKey(17, 18)), "walked along the 4 cells to the door");
  }
});

void test("the vent changes height only on its ToLayer cells", () => {
  const layered = grid();
  const transitions = new Set(TO_LAYER_CELLS.map((cell) => cellKey(cell[0], cell[1])));
  const route = layeredRoute(layered, [16, 15]);
  assert.deepEqual(route.at(-1), [16, 15, 2], "the upper duct is reachable by the vent");
  assertHeightChangesAtStairsOrToLayer(layered, route, transitions);
  const stopped = layeredRoute({ ...layered, transitions: new Map() }, [16, 15]);
  assert.notDeepEqual(stopped.at(-1), [16, 15, 2], "without ToLayer cells the duct is closed");
});

void test("a ToLayer cell puts the party on its target layer, not any open layer", () => {
  const layered = grid();
  // (15,19)/(16,19) are Upper, whichever side they are entered from.
  const intoUpper = layeredRoute({ ...layered, center: [15, 18], z: 1 }, [16, 19]);
  assert.deepEqual(intoUpper.at(-1), [16, 19, 2]);

  // From the upper duct, (16,19) stays upper; (15,20) is a Ground cell, so it drops.
  const alongUpper = layeredRoute({ ...layered, center: [15, 19], z: 2 }, [16, 19]);
  assert.deepEqual(alongUpper.at(-1), [16, 19, 2]);
  assert.equal(
    alongUpper.some((node) => node[0] === 16 && node[1] === 19 && node[2] === 1),
    false,
  );
  const toGround = layeredRoute({ ...layered, center: [15, 19], z: 2 }, [15, 20]);
  assert.deepEqual(toGround.at(-1), [15, 20, 1]);
});

void test("a planned layer change names the target floor", () => {
  const layered = grid();
  const route = layeredRoute(layered, [16, 15]);
  assert.deepEqual(route.at(-1), [16, 15, 2]);
  assert.ok(
    route.every((node, index) => {
      const before = route[index - 1];
      if (!before || before[2] === node[2]) return true;
      const change = TO_LAYER.find((item) => cellKey(...item.cell) === cellKey(node[0], node[1]));
      return change?.to === node[2];
    }),
    JSON.stringify(route),
  );
});

void test("a walked conveyor becomes a directed edge over the wall", () => {
  const collision = {
    searchLayer: 1,
    playerCell: [0, 0],
    layers: [{ name: "GroundCollision", rows: ["000", "111", "000"] }],
  };
  const moves = [
    {
      from: [0, 0] as Cell,
      to: [0, 2] as Cell,
      how: "传送带",
      kind: "conveyor",
    },
  ];
  const walked = layeredGrid(collision, [], [], moves);
  assert.ok(walked);
  assert.deepEqual(layeredRoute(walked, [0, 2]), [
    [0, 0, 1],
    [0, 2, 1],
  ]);
  const plain = layeredGrid(collision, [], []);
  assert.ok(plain);
  assert.notDeepEqual(layeredRoute(plain, [0, 2]).at(-1), [0, 2, 1]);
});

void test("the terrain view marks half-walls by side and ToLayer cells with =", () => {
  const layered = grid();
  const view = layeredView(layered);
  assert.equal(view.center[0], 17);
  assert.equal(view.center[1], 21);
  const row20 = view.rows[20] ?? "";
  assert.equal(row20[16], "=", "the vent cell (16,20)");
  assert.equal(view.rows[19]?.[15], "=", "the vent cell (15,19)");
  assert.equal(row20[17], ">", "(17,20) is a 3, walled on its right");
  assert.equal(row20[8], "<", "(8,20) is a 5, walled on its left");
  assert.equal(view.rows[18]?.[16], "v", "(16,18) is a 4, walled below");
  assert.equal(view.rows[15]?.[16], ":", "the upper duct is on another height");
});

/** A FakePilot whose replies are the 11-03 recording; `route` is left empty like the game's. */
function recordedPilot(): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: map261.pos });
  pilot.on("cells", { cells: { ...map261.cells, origin: [0, 0] } });
  pilot.on("collision", { collision: map261.collision });
  pilot.on("entities", (fields) => {
    const found = map261.entities.entities.filter(
      (entity) => entity.kind === fields.kind && entity.active !== false,
    );
    return { entities: { total: found.length, entities: found } };
  });
  pilot.on("route", { route: {} });
  return pilot;
}

void test("plan uses the recorded map 261 layers and asks for ToLayer cells", async () => {
  const pilot = recordedPilot();
  const blocked = new Set(BLOCKED.map(([from, to]) => edgeKey(from, to)));
  for (const exit of FORWARD_EXITS) {
    const [here, path] = await plan(pilot, exit, false);
    assert.deepEqual(here, [17, 21], exit.join(","));
    assert.notDeepEqual(path.at(-1), exit, `${exit.join(",")} is behind a 3/5 wall`);
    for (let i = 1; i < path.length; i++) {
      const before = path[i - 1];
      const after = path[i];
      assert.ok(before && after, "path cells");
      assert.equal(
        blocked.has(edgeKey(before, after)),
        false,
        `${exit.join(",")} crossed a blocked step`,
      );
    }
  }
  const [, ledge] = await plan(pilot, [18, 18], false);
  assert.deepEqual(ledge.at(-1), [18, 18], "the 4 ledge makes the door at (18,18) walkable");
  assert.ok(
    pilot.calls.some(
      (call) => call.kind === "send" && call.op === "entities" && call.fields.kind === "ToLayer",
    ),
    "the plan asked which cells change height",
  );
});

void test("a two-floor walk says which floor it is on", async () => {
  let here: Cell = [0, 0];
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 261, cell: [here[0], here[1]] } }));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [here[0], here[1]],
      attr: [
        [0, 0],
        [0, 0],
      ],
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here[0], here[1]],
      layers: [
        { name: "GroundCollision", rows: ["00", "11"] },
        { name: "UpperCollision", rows: ["00", "11"] },
      ],
    },
  }));
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", () => {
    here = [1, 0];
    return { ok: true, pos: { map: 261, cell: [1, 0] } };
  });
  const said: string[] = [];
  const [ok, message] = await navigate(pilot, [1, 0], false, (line) => said.push(line));
  assert.equal(ok, true);
  assert.equal(message, "到达 (1, 0),第 1 层(共 2 层)");
  assert.ok(
    said.some((line) => line.includes("第 1 层(共 2 层)")),
    said.join("\n"),
  );
});

void test("a layer change walked through is kept in the atlas", async () => {
  let here: Cell = [0, 0];
  let layer = 1;
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 261, cell: [here[0], here[1]] } }));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [here[0], here[1]],
      attr: [
        [0, 0],
        [0, 0],
      ],
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: layer,
      playerCell: [here[0], here[1]],
      layers: [
        { name: "GroundCollision", rows: ["00", "00"] },
        { name: "UpperCollision", rows: ["00", "00"] },
      ],
    },
  }));
  pilot.on("entities", (fields) =>
    fields.kind === "ToLayer"
      ? {
          entities: {
            total: 1,
            entities: [{ kind: "ToLayer", cell: [1, 0], active: true, layer: 2 }],
          },
        }
      : { entities: { total: 0, entities: [] } },
  );
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", () => {
    here = [1, 1];
    layer = 2;
    return { ok: true, pos: { map: 261, cell: [1, 1] } };
  });
  const links: {
    from: number[];
    to: number[];
    how: string;
    detail?: unknown;
  }[] = [];
  const state: MoveState = {
    drake: null,
    link: (_map, from, to, how, detail) => {
      links.push({ from: [...from], to: [...to], how, detail });
      return Promise.resolve();
    },
  };
  assert.deepEqual(await navigate(pilot, [1, 1], false, () => undefined, 8, state), [
    true,
    "到达 (1, 1),第 2 层(共 2 层)",
  ]);
  assert.deepEqual(links, [
    {
      from: [1, 0],
      to: [1, 0],
      how: "换层到第 2 层",
      detail: { kind: "layer", toLayer: 2 },
    },
  ]);
});

void test("a blocked step is kept for the next walk on the same map", async () => {
  let walks = 0;
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { map: 42, cell: [0, 0] } });
  pilot.on("cells", {
    cells: {
      origin: [0, 0],
      center: [0, 0],
      attr: [
        [0, 0],
        [0, 0],
      ],
    },
  });
  pilot.on("collision", {
    collision: {
      searchLayer: 1,
      playerCell: [0, 0],
      layers: [{ name: "GroundCollision", rows: ["00", "11"] }],
    },
  });
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", () => {
    walks += 1;
    return { ok: false, error: "blocked", pos: { map: 42, cell: [0, 0] } };
  });
  const links: { map: unknown; from: number[]; to: number[]; how: string }[] = [];
  const state: MoveState = {
    drake: null,
    link: (map, from, to, how) => {
      links.push({ map, from: [...from], to: [...to], how });
      return Promise.resolve();
    },
  };
  assert.deepEqual(await navigate(pilot, [1, 0], false, () => undefined, 8, state), [
    false,
    "在 (0, 0) 步行走不过去,这里已是离 (1, 0) 最近的地方",
  ]);
  assert.ok(
    state.cuts?.get("42")?.has(edgeKey([0, 0], [1, 0])) === true,
    "the blocked step is recorded on map 42",
  );
  assert.deepEqual(links, [{ map: 42, from: [0, 0], to: [1, 0], how: "走不过去" }]);
  const walked = walks;
  const [again] = await navigate(pilot, [1, 0], false, () => undefined, 8, state);
  assert.equal(again, false);
  assert.equal(walks, walked, "the next walk did not run into the same wall again");
});

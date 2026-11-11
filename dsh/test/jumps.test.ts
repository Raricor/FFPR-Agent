/**
 * Task 149: script-moved jumps. The export reads the player's `Move` sequence, names the
 * facing and landing, and refuses a landing that is a wall or in the same collision block.
 * The same edges then drive the map planner, the route estimate and the walk.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { jumpsFromObserved, parseJumps } from "../src/engine/knowledge/jumps.ts";
import type { MapJump } from "../src/engine/knowledge/jumps.ts";
import type { Cell } from "../src/engine/nav.ts";
import { CollisionStore, RegionIndex } from "../src/engine/regions.ts";
import { estimatePair } from "../src/engine/route/distance.ts";
import { navigate, takeJump } from "../src/engine/skills/move.ts";
import { mapPath } from "../src/engine/skills/travel.ts";
import { FakePilot } from "./fake-pilot.ts";

const ROWS = [
  "11111111111111",
  "11111111111111",
  "00011100011100",
  "00011100011100",
  "00011100011100",
];

function layer(name = "GroundCollision"): {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
} {
  return {
    name,
    width: ROWS[0]?.length ?? 0,
    height: ROWS.length,
    rows: ROWS,
  };
}

function object(
  id: number,
  name: string,
  cell: readonly [number, number],
  type: number,
  scriptId: number,
): Record<string, unknown> {
  return {
    gid: 2025,
    id,
    name,
    width: 16,
    height: 16,
    x: cell[0] * 16,
    y: (cell[1] + 1) * 16,
    properties: [
      { name: "object_type", type: "int", value: type },
      { name: "script_id", type: "int", value: scriptId },
    ],
  };
}

function script(
  name: string,
  entry: number,
  moves: readonly (readonly [number, number])[],
  branch?: readonly number[],
): { readonly file: string; readonly value: unknown } {
  const mnemonics: unknown[] = [];
  if (branch === undefined) {
    mnemonics.push({
      mnemonic: "Nop",
      label: "Main",
      operands: { iValues: [] },
    });
    mnemonics.push({
      mnemonic: "SetPuppet",
      label: "",
      operands: { iValues: [0, -1001, entry] },
    });
    mnemonics.push({
      mnemonic: "Return",
      label: "",
      operands: { iValues: [] },
    });
  } else {
    mnemonics.push({
      mnemonic: "Nop",
      label: "Main",
      operands: { iValues: [] },
    });
    mnemonics.push({
      mnemonic: "BranchByPlayerDirection",
      label: "",
      operands: { iValues: branch },
    });
    mnemonics.push({
      mnemonic: "SetPuppet",
      label: "",
      operands: { iValues: [0, -1001, entry] },
    });
    mnemonics.push({ mnemonic: "Exit", label: "", operands: { iValues: [] } });
  }
  while (mnemonics.length < entry) {
    mnemonics.push({ mnemonic: "Nop", label: "", operands: { iValues: [] } });
  }
  mnemonics.push({
    mnemonic: "Nop",
    label: "Player",
    operands: { iValues: [] },
  });
  for (const [direction, cells] of moves) {
    mnemonics.push({
      mnemonic: "Move",
      label: "",
      operands: { iValues: [direction, cells, 0] },
    });
  }
  mnemonics.push({ mnemonic: "Exit", label: "", operands: { iValues: [] } });
  return { file: `${name}.json`, value: { Mnemonics: mnemonics } };
}

function fixture(): {
  readonly entity: unknown;
  readonly scripts: readonly {
    readonly file: string;
    readonly value: unknown;
  }[];
  readonly names: ReadonlyMap<number, string>;
} {
  const entity = {
    layers: [
      {
        objects: [
          object(1, "step", [2, 2], 2, 1),
          object(2, "touch", [9, 2], 5, 2),
          object(3, "wall land", [9, 4], 5, 3),
        ],
      },
    ],
  };
  return {
    entity,
    scripts: [
      script("sc_step", 3, [[1, 4]]),
      script("sc_touch", 3, [[1, 4]]),
      script("sc_wall", 3, [[1, 20]]),
    ],
    names: new Map([
      [1, "sc_step"],
      [2, "sc_touch"],
      [3, "sc_wall"],
    ]),
  };
}

void test("a step jump enters from the left and lands four cells right", () => {
  const data = fixture();
  const parsed = parseJumps(data.entity, data.scripts, data.names, [layer()]);
  assert.deepEqual(
    parsed.jumps.map((jump) => [jump.cell, jump.kind, jump.facing, jump.land]),
    [
      [[2, 2], "step", "Up", [6, 2]],
      [[2, 2], "step", "Right", [6, 2]],
      [[9, 2], "touch", "Right", [12, 2]],
    ],
  );
  assert.equal(parsed.skipped.length, 1, "the wall landing is not exported");
  assert.match(parsed.skipped[0]?.reason ?? "", /落点不可走|同一块/u);
});

void test("a direction branch picks the facing and refuses an unlisted one", () => {
  const branch = script("sc_branch", 6, [[1, 4]], [0, 5, 0, 0]);
  const parsed = parseJumps(
    { layers: [{ objects: [object(1, "branch", [2, 2], 2, 1)] }] },
    [branch],
    new Map([[1, "sc_branch"]]),
    [layer()],
  );
  assert.deepEqual(
    parsed.jumps.map((jump) => [jump.facing, jump.land]),
    [["Right", [6, 2]]],
    "only the branched facing has a standable cell",
  );
});

void test("a landing on a step stone follows that stone until it stops", () => {
  const rows = [
    "11111111111111",
    "11111111111111",
    "00011110111100",
    "11111111111111",
    "11111111111111",
  ];
  const entity = {
    layers: [
      {
        objects: [
          object(1, "touch-into-step", [3, 2], 5, 1),
          object(2, "step-chain", [7, 2], 2, 2),
        ],
      },
    ],
  };
  const parsed = parseJumps(
    entity,
    [script("sc_touch_chain", 3, [[1, 5]]), script("sc_step_chain", 3, [[1, 5]])],
    new Map([
      [1, "sc_touch_chain"],
      [2, "sc_step_chain"],
    ]),
    [{ rows }],
  );
  assert.deepEqual(
    parsed.jumps.map((jump) => [jump.cell, jump.kind, jump.facing, jump.land]),
    [[[3, 2], "touch", "Right", [12, 2]]],
    "the exported land is the end of the step chain, not (7, 2)",
  );
});

function rawScript(
  name: string,
  mnemonics: readonly {
    readonly mnemonic: string;
    readonly iValues?: readonly number[];
    readonly sValues?: readonly string[];
  }[],
): { readonly file: string; readonly value: unknown } {
  return {
    file: `${name}.json`,
    value: {
      Mnemonics: mnemonics.map((item) => ({
        mnemonic: item.mnemonic,
        label: "",
        operands: { iValues: item.iValues ?? [], sValues: item.sValues ?? [] },
      })),
    },
  };
}

const CHAIN_ROWS = [
  "11111111111111",
  "11111111111111",
  "00011100011100",
  "11111111111111",
  "11111111111111",
];

void test("ChangeScript chains append every later Move", () => {
  const entity = { layers: [{ objects: [object(1, "chain", [3, 2], 5, 1)] }] };
  const scripts = [
    rawScript("sc_a", [
      { mnemonic: "SetPuppet", iValues: [0, -1001, 3] },
      { mnemonic: "ChangeScript", sValues: ["sc_b"] },
      { mnemonic: "Return" },
      { mnemonic: "Move", iValues: [1, 2] },
      { mnemonic: "Exit" },
    ]),
    rawScript("sc_b", [
      { mnemonic: "SetPuppet", iValues: [0, -1001, 2] },
      { mnemonic: "ChangeScript", sValues: ["sc_c"] },
      { mnemonic: "Move", iValues: [1, 2] },
      { mnemonic: "Exit" },
    ]),
    rawScript("sc_c", [
      { mnemonic: "SetPuppet", iValues: [0, -1001, 1] },
      { mnemonic: "Move", iValues: [1, 2] },
      { mnemonic: "Exit" },
    ]),
  ];
  const parsed = parseJumps(entity, scripts, new Map([[1, "sc_a"]]), [{ rows: CHAIN_ROWS }]);
  assert.deepEqual(
    parsed.jumps.map((jump) => [jump.cell, jump.facing, jump.land]),
    [[[3, 2], "Right", [8, 2]]],
    "2 + 2 + 2 cells right",
  );
});

void test("a timer start uses the script it relocates the jump stone to", () => {
  const entity = { layers: [{ objects: [object(1, "timer", [2, 2], 2, 1)] }] };
  const scripts = [
    rawScript("sc_timer_start", [
      { mnemonic: "SetTimer", iValues: [1], sValues: ["sc_stone"] },
      { mnemonic: "Exit" },
    ]),
    rawScript("sc_stone", [
      { mnemonic: "ChangeScript", sValues: ["sc_jump"] },
      { mnemonic: "Exit" },
    ]),
    rawScript("sc_jump", [
      { mnemonic: "SetPuppet", iValues: [0, -1001, 1] },
      { mnemonic: "Move", iValues: [1, 4] },
      { mnemonic: "Exit" },
    ]),
  ];
  const parsed = parseJumps(entity, scripts, new Map([[1, "sc_timer_start"]]), [
    { rows: CHAIN_ROWS },
  ]);
  assert.deepEqual(
    parsed.jumps.map((jump) => [jump.cell, jump.kind, jump.facing, jump.land]),
    [[[2, 2], "step", "Right", [6, 2]]],
  );
});

void test("an atlas 调查后跳 link becomes a touch jump from a standable neighbour", () => {
  const walkable = new Set(["1,2", "4,2", "0,2"]);
  const jumps = jumpsFromObserved(
    [
      { from: [2, 2], to: [4, 2], how: "调查后跳" },
      { from: [0, 2], to: [4, 2], how: "走不过去" },
    ],
    (cell) => walkable.has(`${cell[0]},${cell[1]}`),
  );
  assert.deepEqual(jumps, [
    {
      cell: [2, 2],
      kind: "touch",
      facing: "Right",
      land: [4, 2],
      script: "atlas-link",
    },
  ]);
});

void test("mapPath crosses an atlas jump link between blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-jump-link-"));
  try {
    const rows = ["111111", "111111", "001100", "111111", "111111", "111111"];
    const atlas = new Atlas();
    atlas.maps.set("80", {
      name: "观察跳石",
      exits: [],
      chests: [],
      links: [{ from: [2, 2], to: [4, 2], how: "调查后跳" }],
    });
    const store = await CollisionStore.load(dir);
    await store.remember(80, {
      searchLayer: 1,
      layers: [{ name: "GroundCollision", rows }],
    });
    const regions = RegionIndex.create(atlas, store);
    assert.deepEqual(
      mapPath(atlas, 80, 80, new Set(), true, {
        start: [0, 2],
        startLayer: 1,
        regions,
        collisions: store,
        toCell: [4, 2],
        toLayer: 1,
      }),
      [],
      "the atlas link joins the two blocks",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("the walk executes an atlas jump link as a touch jump", async () => {
  let here: Cell = [0, 2];
  const pilot = jumpPilot(
    (keys) => {
      if (keys.includes("Enter")) here = [6, 2];
    },
    () => here,
    (cell) => {
      here = cell;
    },
  );
  const state = {
    drake: null,
    moves: () => [{ from: [3, 2] as const, to: [6, 2] as const, how: "调查后跳" }],
    passages: () => [],
  };
  assert.deepEqual(await navigate(pilot, [6, 2], false, () => undefined, 8, state), [
    true,
    "到达 (6, 2)",
  ]);
  assert.ok(pilot.keys().some((keys) => keys.includes("Enter")));
});

function gameMap(rows: readonly string[], jumps: readonly MapJump[]): unknown {
  return {
    id: 70,
    collision: [{ name: "GroundCollision", rows }],
    jumps,
    exits: [],
    events: [],
    points: [],
    damage: [],
    hiddenPassages: [],
  };
}

async function storeWith(jumps: readonly MapJump[]): Promise<{
  readonly dir: string;
  readonly gameDir: string;
  readonly atlas: Atlas;
  readonly store: CollisionStore;
  readonly regions: RegionIndex;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-jumps-cache-"));
  const gameDir = await mkdtemp(join(tmpdir(), "ffpr-jumps-files-"));
  await writeFile(join(gameDir, "70.json"), JSON.stringify(gameMap(ROWS, jumps)));
  const atlas = new Atlas();
  atlas.maps.set("70", { name: "跳石测试", exits: [], chests: [] });
  const store = await CollisionStore.load(dir, undefined, gameDir);
  return {
    dir,
    gameDir,
    atlas,
    store,
    regions: RegionIndex.create(atlas, store),
  };
}

const JUMPS: readonly MapJump[] = [
  {
    cell: [2, 2],
    kind: "step",
    facing: "Right",
    land: [6, 2],
    script: "sc_step",
  },
  {
    cell: [9, 2],
    kind: "touch",
    facing: "Right",
    land: [12, 2],
    script: "sc_touch",
  },
];

void test("mapPath and the route estimate cross the map through its jumps", async () => {
  const world = await storeWith(JUMPS);
  try {
    assert.deepEqual(
      mapPath(world.atlas, 70, 70, new Set(), true, {
        start: [1, 2],
        startLayer: 1,
        regions: world.regions,
        collisions: world.store,
        toCell: [12, 2],
        toLayer: 1,
      }),
      [],
      "the start block reaches the goal through the jumps",
    );
    const pair = estimatePair(
      { atlas: world.atlas, collisions: world.store, regions: world.regions },
      { map: 70, cell: [1, 2] },
      { map: 70, cell: [12, 2] },
    );
    assert.ok(pair.ok);
    assert.equal(pair.estimate.maps.length, 1, "the estimate stays on the same map");
    assert.ok(
      pair.estimate.cells <= 6,
      `two jumps plus four walking cells, got ${pair.estimate.cells}`,
    );
  } finally {
    await rm(world.dir, { recursive: true, force: true });
    await rm(world.gameDir, { recursive: true, force: true });
  }
});

void test("without the exported jumps the same block is unreachable", async () => {
  const world = await storeWith([]);
  try {
    const pair = estimatePair(
      { atlas: world.atlas, collisions: world.store, regions: world.regions },
      { map: 70, cell: [1, 2] },
      { map: 70, cell: [12, 2] },
    );
    assert.equal(pair.ok, false);
  } finally {
    await rm(world.dir, { recursive: true, force: true });
    await rm(world.gameDir, { recursive: true, force: true });
  }
});

function jumpPilot(
  onKeys: (keys: readonly string[], here: () => Cell) => void,
  here: () => Cell,
  setHere: (cell: Cell) => void,
): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => ({ pos: { map: 70, cell: [here()[0], here()[1]] } }));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [here()[0], here()[1]],
      attr: ROWS.map(() => Array.from({ length: ROWS[0]?.length ?? 0 }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [here()[0], here()[1]],
      layers: [{ name: "GroundCollision", rows: ROWS }],
    },
  }));
  pilot.on("entities", { entities: { total: 0, entities: [] } });
  pilot.onQuery("sample", { sample: { field: { moveState: "" } } });
  pilot.on("route", { route: {} });
  pilot.on("wait", { ok: true });
  pilot.on("keys", (fields) => {
    const keys = Array.isArray(fields.keys)
      ? fields.keys.filter((key): key is string => typeof key === "string")
      : [];
    onKeys(keys, here);
    return { ok: true };
  });
  pilot.on("walkpath", (fields) => {
    const path = fields.path as Cell[];
    const last = path[path.length - 1];
    if (last === undefined)
      return {
        ok: false,
        reason: "blocked",
        pos: { map: 70, cell: [here()[0], here()[1]] },
      };
    setHere([last[0], last[1]]);
    return {
      ok: true,
      reason: "arrived",
      index: path.length - 1,
      pos: { map: 70, cell: [last[0], last[1]] },
    };
  });
  return pilot;
}

void test("the walk steps onto a step stone in the facing direction, then presses a touch stone", async () => {
  let here: Cell = [0, 2];
  let enteredStep = false;
  const pilot = jumpPilot(
    (keys) => {
      if (keys[0] === "Right:90" && !enteredStep) {
        enteredStep = true;
        here = [6, 2];
      }
      if (keys.includes("Enter")) here = [12, 2];
    },
    () => here,
    (cell) => {
      here = cell;
    },
  );
  const state = {
    drake: null,
    passages: () => ({ passages: [], jumps: JUMPS }),
  };
  const said: string[] = [];
  assert.deepEqual(await navigate(pilot, [12, 2], false, (line) => said.push(line), 8, state), [
    true,
    "到达 (12, 2)",
  ]);
  const keys = pilot.keys();
  assert.ok(
    keys.some((sent) => sent[0] === "Right:90" && sent.length === 1),
    "step uses a direction only",
  );
  assert.ok(
    keys.some((sent) => sent.includes("Enter")),
    "touch presses confirm",
  );
  assert.ok(
    said.some((line) => line.includes("跳石")),
    "the walk says it used a jump",
  );
});

void test("a timer-start step jump waits through intermediate cells for the landing", async () => {
  let cell: Cell = [2, 1];
  let reads = 0;
  const pilot = new FakePilot();
  pilot.on("pos", () => {
    reads += 1;
    if (reads >= 6) cell = [2, 5];
    else if (reads > 1) cell = [2, 2];
    return { pos: { map: 70, cell: [cell[0], cell[1]] } };
  });
  pilot.on("keys", { ok: true });
  const jump: MapJump = {
    cell: [2, 2],
    kind: "step",
    facing: "Down",
    land: [2, 5],
    script: "timer-start",
  };
  const [ok, message] = await takeJump(pilot, jump);
  assert.equal(ok, true);
  assert.match(message, /到 \(2, 5\)/u);
  assert.ok(reads >= 6, "it kept polling instead of accepting (2, 2)");
});

void test("takeJump fails when the script leaves the party away from the landing", async () => {
  let here: Cell = [1, 2];
  const pilot = jumpPilot(
    (keys) => {
      if (keys[0] === "Right:90") here = [4, 2];
    },
    () => here,
    (cell) => {
      here = cell;
    },
  );
  const jump = JUMPS[0];
  assert.ok(jump);
  const [ok, message] = await takeJump(pilot, jump);
  assert.equal(ok, false);
  assert.match(message, /不是落点/u);
});

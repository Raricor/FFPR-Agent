import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { EnemyResistances } from "../src/engine/elements.ts";
import { cellKey } from "../src/engine/nav.ts";
import type { CellGrid } from "../src/engine/nav.ts";
import {
  describeBattle,
  FLOOR_MARKS,
  renderFloor,
  renderTerrain,
  SYSTEM_PROMPT,
  TERRAIN,
  TOOLS,
} from "../src/engine/prompt.ts";

interface RawCells {
  readonly origin: [number, number];
  readonly center: [number, number];
  readonly attr: (number | null)[][];
}

interface FloorView {
  readonly center: [number, number];
  readonly rows: string[];
}

interface PromptFixture {
  readonly systemPrompt: string;
  readonly tools: unknown;
  readonly terrain: {
    readonly entries: [number, [string, string]][];
    readonly cases: readonly { readonly cells: RawCells; readonly text: string }[];
  };
  readonly floor: {
    readonly marks: [string, [string, string]][];
    readonly cases: readonly {
      readonly name: string;
      readonly view: FloorView;
      readonly radius: number;
      readonly marks: { readonly cell: [number, number]; readonly mark: string }[];
      readonly text: string;
    }[];
  };
  readonly battle: readonly {
    readonly battle: unknown;
    readonly party: unknown[];
    readonly text: string;
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "prompt", "prompt.json"), "utf8"),
) as PromptFixture;

function cells(raw: RawCells): CellGrid {
  return { origin: raw.origin, center: raw.center, attr: raw.attr };
}

function floorMarks(
  items: readonly { cell: [number, number]; mark: string }[],
): Map<string, string> {
  return new Map(items.map((item) => [cellKey(item.cell[0], item.cell[1]), item.mark]));
}

void test("the system prompt and tool definitions keep the ported text", () => {
  // The new enemy conditions are an addition over the Python fixture (task 19).
  const restored = SYSTEM_PROMPT.replace(
    "、\n  enemy.name.喧嚣鬼(有几只活敌人叫这个名字);目标可以写敌人:喧嚣鬼、敌人:hp最低、敌人:弱冰。",
    "。",
  );
  assert.equal(restored, fixture.systemPrompt);
  assert.ok(SYSTEM_PROMPT.includes("enemy.name.喧嚣鬼"));
  assert.ok(SYSTEM_PROMPT.includes("敌人:hp最低"));
  assert.ok(SYSTEM_PROMPT.includes("目标:{goal}") && SYSTEM_PROMPT.endsWith("{hint}"));
  assert.deepEqual(TOOLS, fixture.tools);
});

void test("the terrain symbols and floor marks keep Python's order", () => {
  assert.deepEqual([...TERRAIN], fixture.terrain.entries);
  assert.deepEqual([...FLOOR_MARKS], fixture.floor.marks);
  assert.equal(TERRAIN.get(16)?.[0], "~");
  assert.equal(FLOOR_MARKS.get("TresureBox")?.[0], "T");
});

void test("renderTerrain marks the player and special cells", () => {
  for (const item of fixture.terrain.cases) {
    assert.equal(renderTerrain(cells(item.cells)), item.text);
  }
  const text = renderTerrain({
    origin: [9, 4],
    center: [10, 5],
    attr: [
      [16, 19, 3],
      [10, 3, 99],
    ],
  });
  const lines = text.split("\n");
  assert.ok(lines[0]?.startsWith("地形图:左上角是格子 (9,4),@ 是你 (10,5)"));
  assert.equal(lines[2], "    4 ~^.");
  assert.equal(lines[3], "    5 0@1");
  assert.ok(text.includes("0 特殊格(编码 10") && text.includes("1 特殊格(编码 99"));
});

void test("renderFloor marks walls, floor and entities", () => {
  for (const item of fixture.floor.cases) {
    assert.equal(renderFloor(item.view, item.radius, floorMarks(item.marks)), item.text, item.name);
  }
  const text = renderFloor(
    { center: [2, 1], rows: ["####", "#...", "#.##"] },
    4,
    floorMarks([
      { cell: [3, 1], mark: "!" },
      { cell: [1, 2], mark: "T" },
    ]),
  );
  const lines = text.split("\n");
  assert.ok(lines[0]?.startsWith("地图:左上角是格子 (0,0),@ 是你 (2,1)"));
  assert.deepEqual(lines.slice(2, 5), ["    0 ####", "    1 #.@!", "    2 #T##"]);
  assert.ok(lines.at(-1)?.includes("! 事件触发点") && lines.at(-1)?.includes(". 你这一层能走"));
});

void test("renderFloor clips the view to the map edges", () => {
  const text = renderFloor({ center: [0, 0], rows: ["##", "#."] }, 4, new Map());
  assert.equal(text.split("\n")[1], "      0 ");
  assert.equal(text.split("\n")[2], "    0 @#");
});

void test("the prompt tells the model that 最强 avoids absorbs and prefers weaknesses", () => {
  assert.ok(SYSTEM_PROMPT.includes("enemy.weak.冰") && SYSTEM_PROMPT.includes("enemy.absorbs.冰"));
  const fight = TOOLS.find((tool) => tool.function.name === "fight");
  const tactics = TOOLS.find((tool) => tool.function.name === "set_tactics");
  assert.ok(fight?.function.description.includes("避开它吸收、无效的属性"));
  assert.ok(tactics?.function.description.includes("enemy.weak.冰"));
});

void test("describeBattle marks the elements an enemy is known to use", () => {
  const text = describeBattle(
    { enemies: [{ name: "败怨魔", book: 39, hp: 80, maxHp: 80 }], players: [] },
    [],
    {
      lookup: (enemy): EnemyResistances | null =>
        typeof enemy === "object" && enemy !== null && (enemy as { book?: number }).book === 39
          ? { weak: ["冰"], absorb: ["火"], immune: [] }
          : null,
    },
  );
  assert.equal(text.split("\n")[0], "敌人:败怨魔 HP 80/80(弱 冰;吸收 火)");
});

void test("describeBattle names both sides with jobs and MP", () => {
  for (const item of fixture.battle) {
    assert.equal(describeBattle(item.battle, item.party), item.text);
  }
  const text = describeBattle(
    {
      enemies: [{ name: "哥布林", hp: 16, maxHp: 16 }],
      players: [{ name: "蕾娜", hp: 60, maxHp: 142, mp: 16, status: ["Poison"] }],
    },
    [{ name: "蕾娜", jobName: "白魔法师" }],
  );
  assert.equal(text, "敌人:哥布林 HP 16/16\n我方:蕾娜(白魔法师) HP 60/142 MP 16 [毒]");
});

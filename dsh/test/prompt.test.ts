import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
  systemPrompt,
  tacticianPrompt,
  TERRAIN,
  TOOLS,
  toolSchemas,
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
    readonly cases: readonly {
      readonly cells: RawCells;
      readonly text: string;
    }[];
  };
  readonly floor: {
    readonly marks: [string, [string, string]][];
    readonly cases: readonly {
      readonly name: string;
      readonly view: FloorView;
      readonly radius: number;
      readonly marks: {
        readonly cell: [number, number];
        readonly mark: string;
      }[];
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

const ff5System = await readFile(
  join(import.meta.dirname, "fixtures", "prompt", "system-prompt-ff5.txt"),
  "utf8",
);
const ff5Tactician = await readFile(
  join(import.meta.dirname, "fixtures", "prompt", "tactician-prompt-ff5.txt"),
  "utf8",
);
const ff5PlanMode = await readFile(
  join(import.meta.dirname, "fixtures", "prompt", "system-prompt-ff5-plan.txt"),
  "utf8",
);
const ff5ChapterMode = await readFile(
  join(import.meta.dirname, "fixtures", "prompt", "system-prompt-ff5-chapter.txt"),
  "utf8",
);

void test("the FF5 prompts and tool definitions keep the ported text", () => {
  // 10-29 (task 26): FF5 now starts a new game in slot 20 instead of reading its old slot 3.
  // 11-10 (task 105): the scout paragraph was added.
  // 11-10 (task 107): the old "call done" line became the goal-mode paragraph.
  // 11-10 (task 110): the set_tactics sentence says the player's table holds until they leave.
  // Only these places differ from the ported constant: the new-game/save-slot sentence before
  // {hint}, save_game's description naming slot 20, the scout rule, the goal-mode paragraph
  // and the set_tactics sentence.
  assert.equal(systemPrompt("ff5"), ff5System);
  assert.ok(ff5System.includes("存档只写 20 号存档位"));
  assert.equal(tacticianPrompt("ff5"), ff5Tactician);
  assert.ok(ff5System.includes("enemy.name.喧嚣鬼"));
  assert.ok(ff5System.includes("敌人:hp最低"));
  assert.ok(ff5System.includes("目标:{goal}") && ff5System.endsWith("{hint}"));
  assert.deepEqual(TOOLS, fixture.tools);
});

void test("plan mode replaces the old how-to-play text with the plan loop", () => {
  const text = systemPrompt("ff5", 20, true);
  assert.equal(text, ff5PlanMode);
  for (const step of [
    "plan_facts",
    "submit_plan",
    "execute_plan",
    "plan_status",
    "status 是 done",
    "status 是 exception",
  ]) {
    assert.ok(text.includes(step), `计划模式提示词应该提到 ${step}`);
  }
  // The old walk/chest/interact advice belongs to direct play and must not appear.
  for (const old of [
    "一段路上要去的地方已经清楚时",
    "宝箱在 look_around 里写作 TresureBox",
    "宝箱用 interact",
    "剧情对话用 advance_story",
    "普通战斗的策略由战术官自动写好",
  ]) {
    assert.equal(text.includes(old), false, `计划模式提示词不该有:${old}`);
  }
  assert.equal(text.includes("save_game"), false);
  assert.ok(text.includes("存档只写 20 号存档位"));
  assert.ok(text.includes("计划里写 save 站"));
  assert.ok(text.includes("{hint}"));
});

void test("chapter mode replaces the plan loop with the chapter loop", () => {
  const text = systemPrompt("ff5", 20, false, true);
  assert.equal(text, ff5ChapterMode);
  // Chapter mode overrides plan mode when both are on.
  assert.equal(systemPrompt("ff5", 20, true, true), ff5ChapterMode);
  for (const step of [
    "chapter_facts",
    "read_guide",
    "chapter_draft_segment",
    "chapter_draft_meta",
    "submit_chapter_plan",
    "chapter_status",
    "规则文件已定稿",
    "执行器接管",
    "blocked",
    "续跑",
  ]) {
    assert.ok(text.includes(step), `整章模式提示词应该提到 ${step}`);
  }
  for (const covered of [
    "宝箱",
    "隐藏道具",
    "图鉴",
    "青魔法",
    "城镇采购",
    "growth",
    "bosses",
    "fallback",
    "skipped",
  ]) {
    assert.ok(text.includes(covered), `整章规则要覆盖 ${covered}`);
  }
  for (const oldTool of ["plan_facts", "submit_plan", "execute_plan", "plan_status"]) {
    assert.equal(text.includes(oldTool), false, `整章模式不该提到 ${oldTool}`);
  }
  assert.equal(text.includes("execute_chapter"), false, "整章模式不该再让模型执行本章");
  for (const old of [
    "一段路上要去的地方已经清楚时",
    "宝箱用 interact",
    "剧情对话用 advance_story",
    "普通战斗的策略由战术官自动写好",
  ]) {
    assert.equal(text.includes(old), false, `整章模式提示词不该有:${old}`);
  }
  assert.equal(text.includes("save_game"), false);
  assert.ok(text.includes("存档只写 20 号存档位"));
  assert.ok(text.includes("计划里写 save 站"));
  assert.ok(text.includes("{hint}"));
});

void test("the five games get the same plan-only persona without direct-play advice", () => {
  for (const key of ["ff1", "ff2", "ff3", "ff4", "ff6"]) {
    const text = systemPrompt(key, 20, true);
    assert.ok(text.includes("计划模式"));
    assert.ok(text.includes("plan_facts"));
    assert.ok(text.includes("存档只写 20 号存档位"));
    // Direct-play points mention press, menus, the drake or jobs; plan mode has none of them.
    assert.equal(text.includes("这一作的要点:"), false, key);
    assert.equal(text.includes("press"), false, key);
    assert.equal(text.includes("飞龙"), false, key);
    assert.equal(text.includes("change_job"), false, key);
  }
});

void test("the prompt describes goal mode instead of calling done", () => {
  const text = systemPrompt("ff5");
  assert.equal(text.includes("调用 done"), false);
  assert.ok(text.includes("这个会话有一个长期目标"));
  assert.ok(text.includes("没有目标时 get_goal 返回 null"));
  assert.ok(text.includes("create_goal(objective)"));
  assert.ok(text.includes("get_goal 拿到 goal_id 和 revision"));
  assert.ok(text.includes("再 update_goal"));
  assert.ok(text.includes("每一轮推进一段"));
  assert.ok(text.includes("轮末用两三句写这一次的进展"));
  assert.ok(text.includes("只有真正达成才标完成"));
  assert.ok(text.includes("同一个阻塞条件连续 3 轮才算阻塞"));
  assert.ok(text.includes("blocked_reason"));
  const done = TOOLS.find((tool) => tool.function.name === "done");
  assert.ok(done, "旧会话仍要能看到 done 的定义");
  assert.match(done.function.description, /目标模式下不用 done/);
  assert.match(done.function.description, /整个目标真的完成时用 update_goal 标完成/);
});

void test("save_game names the slot passed to toolSchemas", () => {
  const description = (slot: number): string =>
    String(
      toolSchemas(slot).find((tool) => tool.function.name === "save_game")?.function.description,
    );
  assert.match(description(20), /存档到 20 号存档位/);
  assert.match(description(7), /存档到 7 号存档位/);
  assert.equal(description(7).includes("{saveSlot}"), false);
});

void test("the five new games get their own points, save slot and no FF5-only lines", () => {
  const cases = [
    ["ff1", "最终幻想", "四个光之战士"],
    ["ff2", "最终幻想II", "没有等级"],
    ["ff3", "最终幻想III", "四个洋葱剑士"],
    ["ff4", "最终幻想IV", "主角塞西尔"],
    ["ff6", "最终幻想VI", "角色很多"],
  ] as const;
  for (const [key, name, point] of cases) {
    const text = systemPrompt(key);
    assert.ok(text.startsWith(`你在玩《${name} 像素重制版》(中文版)`), key);
    assert.ok(text.includes("这一作的要点:"), key);
    assert.ok(text.includes(point), key);
    assert.ok(text.includes("20 号存档位"), key);
    assert.ok(text.includes("过了起名"), key);
    // The five games have no drake, jobs, guide, cast or combat magic (task 21).
    for (const forbidden of [
      "飞龙",
      "board",
      "land",
      "change_job",
      "cast",
      "guide",
      "魔法要先在魔法店",
      "中文版的魔法名",
      "规则表里的「最强」",
      "X+",
      "enemy.weak.",
    ]) {
      assert.equal(text.includes(forbidden), false, `${key} 不该有 ${forbidden}`);
    }
  }
});

void test("the five tacticians may only attack, defend or use an item", () => {
  for (const key of ["ff1", "ff2", "ff3", "ff4", "ff6"]) {
    const text = tacticianPrompt(key);
    assert.ok(text.includes("do 只能写「攻击」「防御」,或「道具:道具名」"), key);
    assert.ok(text.includes("这一作的魔法和特技暂时不能写进规则表"), key);
    assert.ok(text.includes("以游戏里的道具名为准"), key);
    assert.equal(text.includes("白魔法"), false, key);
    assert.equal(text.includes("黑魔法"), false, key);
    assert.equal(text.includes("最强"), false, key);
    assert.equal(text.includes("X+"), false, key);
    assert.equal(text.includes("属性"), false, key);
    assert.equal(text.includes("换职业"), false, key);
  }
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
  assert.ok(ff5System.includes("enemy.weak.冰") && ff5System.includes("enemy.absorbs.冰"));
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

void test("the model-facing prompt and tools use go, not the three old movement tools", async () => {
  const old = /walk_to|go_to|travel_to/u;
  assert.doesNotMatch(systemPrompt("ff5"), old);
  assert.doesNotMatch(tacticianPrompt("ff5"), old);
  const go = TOOLS.find((tool) => tool.function.name === "go");
  assert.ok(go);
  assert.deepEqual(go.function.parameters.required, ["to"]);
  assert.ok(go.function.description.includes("地图"));
  for (const name of ["walk_to", "go_to", "travel_to"]) {
    assert.equal(
      TOOLS.some((tool) => tool.function.name === name),
      false,
      `${name} 不该还在工具列表里`,
    );
  }
  // Every model-facing string and comment in src/ has moved to the one tool (task 58).
  const files = await readdir(join(import.meta.dirname, "..", "src"), {
    recursive: true,
  });
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    // Task 64: metrics.ts reads old session logs, so it must still recognize the old names.
    if (file === join("engine", "metrics.ts")) continue;
    const text = await readFile(join(import.meta.dirname, "..", "src", file), "utf8");
    assert.doesNotMatch(text, old, file);
  }
});

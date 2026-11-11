import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BattleLog, gapText, type BattleEvent } from "../src/engine/battle-record.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import { fight, heldItems } from "../src/engine/skills/battle.ts";
import { parseStrategy } from "../src/engine/strategy/index.ts";
import { StrategyRuntime } from "../src/engine/strategy/execute.ts";
import type { BattleSnapshot, Strategy } from "../src/engine/strategy/types.ts";
import type { FightTurn } from "../src/engine/skills/battle.ts";
import { FakePilot } from "./fake-pilot.ts";
import { FakeBattle, startRows } from "./fake-battle.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

async function fixture(name: string): Promise<Strategy> {
  const text = await readFile(join(import.meta.dirname, "fixtures", "strategy", name), "utf8");
  const parsed = parseStrategy(JSON.parse(text));
  if (Array.isArray(parsed)) assert.fail(parsed.join("\n"));
  return parsed;
}

function magicEvent(action = "火炎"): BattleEvent {
  return {
    at: 1,
    kind: "battle.act",
    actor: "玛基莎",
    action,
    target: "蕾娜",
    counter: false,
    value: null,
    heal: false,
    magic: true,
  };
}

void test("the giant bird is defended against at id 282 and attacked at 281", async () => {
  const strategy = await fixture("giant-bird.json");
  for (const [id, command] of [
    [282, "防御"],
    [281, "攻击"],
  ] as const) {
    const sim = new FakeBattle({
      party: [
        {
          name: "蕾娜",
          hp: 100,
          maxHp: 100,
          mp: 20,
          status: [],
          spells: ["治疗"],
        },
        { name: "加拉夫", hp: 100, maxHp: 100, mp: 10, status: [] },
        { name: "法利斯", hp: 100, maxHp: 100, mp: 10, status: [] },
      ],
      enemies: [{ name: "巨翼猛禽", id, hp: 300, maxHp: 300, boss: true }],
      maxTurns: 3,
    });
    const result = await fight(sim.pilot, strategy, 300);
    assert.equal(result.ok, true);
    assert.deepEqual(
      sim.actions.map((action) => action.command),
      [command, command, command],
    );
  }
});

void test("Magissa's reactions revive first and then shield the unsheltered ally", async () => {
  const strategy = await fixture("magissa-fuza.json");
  const events = [magicEvent()];
  const sim = new FakeBattle({
    party: [
      {
        name: "蕾娜",
        hp: 80,
        maxHp: 100,
        mp: 20,
        status: [],
        spells: ["治疗", "魔法护盾"],
      },
      { name: "加拉夫", hp: 70, maxHp: 90, mp: 10, status: [] },
      {
        name: "巴兹",
        hp: 0,
        maxHp: 90,
        mp: 0,
        status: ["战斗不能"],
      },
    ],
    enemies: [
      { name: "玛基莎", id: 500, hp: 300, maxHp: 300 },
      { name: "弗扎", id: 501, hp: 200, maxHp: 200 },
    ],
    items: [{ name: "不死鸟之尾", count: 2 }],
    maxTurns: 4,
  });
  const result = await fight(sim.pilot, strategy, 300, () => undefined, null, {
    events: () => events,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    sim.actions.map((action) => `${action.command}:${action.ability}`),
    ["道具:不死鸟之尾", "攻击:", "攻击:", "白魔法:魔法护盾"],
  );
  assert.equal(sim.actions[0]?.target, "巴兹");
  assert.equal(sim.itemCount("不死鸟之尾"), 1);
});

void test("a revive rule with no target never uses the item on a living actor", async () => {
  const sim = new FakeBattle({
    party: [
      { name: "蕾娜", hp: 100, maxHp: 100, mp: 20, status: [] },
      { name: "巴兹", hp: 100, maxHp: 100, mp: 10, status: [] },
    ],
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    items: [{ name: "不死鸟之尾", count: 2 }],
    maxTurns: 1,
  });
  const strategy: Strategy = {
    version: 2,
    roles: {},
    reactions: [],
    phases: [],
    rules: [
      { who: "all", do: "道具:不死鸟之尾", to: "self" },
      { who: "all", do: "攻击" },
    ],
  };
  const seen: FightTurn[] = [];
  const result = await fight(sim.pilot, strategy, 30, () => undefined, null, {
    onTurn: (turn) => seen.push(turn),
  });
  assert.equal(result.ok, true);
  assert.equal(sim.actions[0]?.command, "攻击");
  assert.equal(sim.itemCount("不死鸟之尾"), 2);
  assert.ok(seen[0]?.skipped.some((skip) => skip.why === "没有倒下的人"));
});

void test("the same fallen ally is not revived twice while the first command is queued", async () => {
  const sim = new FakeBattle({
    party: [
      { name: "蕾娜", hp: 100, maxHp: 100, mp: 10, status: [] },
      { name: "巴兹", hp: 0, maxHp: 100, mp: 0, status: ["战斗不能"] },
    ],
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    items: [{ name: "不死鸟之尾", count: 3 }],
    maxTurns: 3,
    reviveOnUse: false,
  });
  const strategy: Strategy = {
    version: 2,
    roles: {},
    reactions: [
      {
        who: "all",
        on: "ally.count(not alive) > 0 and item(不死鸟之尾) > 0",
        do: "道具:不死鸟之尾",
        to: "ally.first(not alive)",
      },
    ],
    phases: [],
    rules: [],
  };
  const result = await fight(sim.pilot, strategy, 30);
  assert.equal(result.ok, true);
  assert.equal(sim.itemCount("不死鸟之尾"), 2, "only one phoenix down was ordered");
  assert.equal(sim.actions[0]?.command, "道具");
  assert.equal(sim.actions[1]?.command, "攻击");
  assert.equal(sim.actions[2]?.command, "攻击");
});

void test("an item list that never opens is retried once, then the next rule takes the turn", async () => {
  const sim = new FakeBattle({
    party: [
      { name: "蕾娜", hp: 100, maxHp: 100, mp: 10, status: [] },
      { name: "巴兹", hp: 0, maxHp: 100, mp: 0, status: ["战斗不能"] },
    ],
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    items: [{ name: "不死鸟之尾", count: 1 }],
    maxTurns: 1,
    itemOpenFailures: 99,
  });
  const strategy: Strategy = {
    version: 2,
    roles: {},
    reactions: [],
    phases: [],
    rules: [
      {
        who: "all",
        if: "item(不死鸟之尾) > 0",
        do: "道具:不死鸟之尾",
        to: "ally.first(not alive)",
      },
      { who: "all", do: "攻击" },
    ],
  };
  const result = await fight(sim.pilot, strategy, 30);
  assert.equal(result.ok, true);
  assert.equal(sim.itemOpens, 2, "one press plus one retry");
  assert.equal(sim.itemCount("不死鸟之尾"), 1);
  assert.equal(sim.actions[0]?.command, "攻击");
  assert.match(result.turns[0] ?? "", /道具列表没有打开/);
  for (const turn of result.turns) assert.doesNotMatch(turn, /回合已经轮到别人/);
});

void test("a rule skipped twice for a missing item becomes a gap in the record", async () => {
  const party = [
    { name: "蕾娜", hp: 100, maxHp: 100, mp: 10, status: [] },
    { name: "加拉夫", hp: 100, maxHp: 100, mp: 10, status: [] },
    { name: "巴兹", hp: 0, maxHp: 100, mp: 0, status: ["战斗不能"] },
  ];
  const sim = new FakeBattle({
    party,
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    items: [{ name: "不死鸟之尾", count: 0 }],
    maxTurns: 2,
  });
  const log = await BattleLog.load("ff5", undefined);
  const session = log.start({
    mapId: 1,
    mapName: "测试",
    boss: false,
    enemies: startRows(sim).enemies,
    party: startRows(sim).party,
    table: { kind: "manual", mapId: 1 },
  });
  const strategy: Strategy = {
    version: 2,
    roles: {},
    reactions: [
      {
        who: "all",
        on: "ally.count(not alive) > 0",
        do: "道具:不死鸟之尾",
        to: "ally.first(not alive)",
      },
    ],
    phases: [],
    rules: [],
  };
  const result = await fight(sim.pilot, strategy, 30, () => undefined, null, {
    record: session,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.gaps, [{ item: "不死鸟之尾", held: 0, basis: "对策 1", skips: 2 }]);
  assert.match(gapText(result.gaps), /缺口:不死鸟之尾 0 个,对策 1 跳过了 2 次/);
  await session.finish(0, "ok", "测试");
  const summary = session.view();
  assert.ok(summary.turns.length > 0);
  const record = await log.recordView(1);
  assert.ok(record);
  assert.match(record.summaryText, /缺口:不死鸟之尾 0 个/);
});

void test("set_tactics accepts a version 2 strategy and still checks it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-strategy-"));
  try {
    const game = await Game.create({
      laptop: LAPTOP,
      game: "ff5",
      saveSlot: 20,
      atlasFile: join(directory, "atlas.json"),
      tacticsFile: join(directory, "tactics.json"),
      elementsFile: join(directory, "elements.json"),
    });
    const strategy: Strategy = {
      version: 2,
      roles: { 蕾娜: "治疗" },
      reactions: [],
      phases: [],
      rules: [
        {
          who: "蕾娜",
          if: "ally.any(hp_pct < 60)",
          do: "白魔法:治疗",
          to: "ally.lowest(hp_pct)",
        },
        { who: "all", do: "攻击" },
      ],
    };
    const tools = game as unknown as {
      toolSetTactics(
        args: Record<string, unknown>,
        pilot: FakePilot,
      ): Promise<{ readonly text: string }>;
    };
    const pilot = new FakePilot();
    const good = await tools.toolSetTactics({ tables: [strategy], map: 64 }, pilot);
    assert.match(good.text, /已为地图 64 设好 1 套战斗策略/);
    assert.deepEqual(game.tactics.current(64), strategy);
    const bad = await tools.toolSetTactics(
      {
        tables: [{ version: 2, roles: {}, reactions: [], phases: [], rules: [] }],
        map: 64,
      },
      pilot,
    );
    assert.match(bad.text, /策略里没有规则/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("held items are read from the bag for the snapshot", async () => {
  const sim = new FakeBattle({
    party: [{ name: "蕾娜", hp: 100, maxHp: 100, mp: 10, status: [] }],
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    items: [{ name: "恢复药", count: 4 }],
    maxTurns: 0,
  });
  assert.deepEqual(await heldItems(sim.pilot), { 恢复药: 4 });
});
const RUNTIME_SNAPSHOT: BattleSnapshot = {
  allies: [{ name: "蕾娜", hp: 40, maxHp: 100, mp: 10 }],
  enemies: [{ name: "哥布林", id: 1, hp: 50, maxHp: 100 }],
  actor: "蕾娜",
  turn: 1,
};

void test("a rule whose if cannot be evaluated is skipped and recorded once", () => {
  const runtime = new StrategyRuntime();
  const strategy: Strategy = {
    version: 2,
    roles: {},
    reactions: [],
    phases: [],
    rules: [
      { who: "all", if: "ally.lowest(hp_pct) < 30", do: "防御" },
      { who: "all", do: "攻击" },
    ],
  };
  const first = runtime.choices(strategy, RUNTIME_SNAPSHOT);
  assert.equal(first.steps[0]?.action.command, "攻击");
  const gaps = runtime.gaps();
  assert.equal(gaps.length, 1);
  assert.match(gaps[0]?.item ?? "", /规则 1出错:.*不是数/u);
  const second = runtime.choices(strategy, RUNTIME_SNAPSHOT);
  assert.equal(second.steps[0]?.action.command, "攻击");
  assert.equal(runtime.gaps().length, 1, "the error is recorded only once");
});

void test("a phase whose when cannot be evaluated is passed over", () => {
  const runtime = new StrategyRuntime();
  const strategy: Strategy = {
    version: 2,
    roles: {},
    reactions: [],
    phases: [
      {
        name: "坏阶段",
        when: "ally.lowest(hp_pct) < 30",
        rules: [{ who: "all", do: "防御" }],
      },
      { name: "好阶段", when: "true", rules: [{ who: "all", do: "攻击" }] },
    ],
    rules: [],
  };
  const choice = runtime.choices(strategy, RUNTIME_SNAPSHOT);
  assert.equal(choice.steps[0]?.basis, "阶段「好阶段」第 1 条");
  assert.match(runtime.gaps()[0]?.item ?? "", /阶段「坏阶段」的 when出错:.*不是数/u);
});

void test("a reaction whose on cannot be evaluated does not block the next rule", () => {
  const runtime = new StrategyRuntime();
  const strategy: Strategy = {
    version: 2,
    roles: {},
    reactions: [{ who: "all", on: "enemy.lowest(hp) < 30", do: "防御" }],
    phases: [],
    rules: [{ who: "all", do: "攻击" }],
  };
  const choice = runtime.choices(strategy, RUNTIME_SNAPSHOT);
  assert.equal(choice.steps[0]?.action.command, "攻击");
  assert.match(runtime.gaps()[0]?.item ?? "", /对策 1出错:.*不是数/u);
});

void test("a table that fails the static check falls back to attacking and says why", async () => {
  const sim = new FakeBattle({
    party: [{ name: "蕾娜", hp: 100, maxHp: 100, mp: 10, status: [] }],
    enemies: [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }],
    maxTurns: 1,
  });
  const bad: Strategy = {
    version: 2,
    roles: {},
    reactions: [],
    phases: [],
    rules: [{ who: "all", if: "enemy.lowest(hp) < 30", do: "防御" }],
  };
  const result = await fight(sim.pilot, bad, 30);
  assert.equal(result.ok, true);
  assert.equal(sim.actions[0]?.command, "攻击");
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0]?.item ?? "", /策略表出错:.*不是数/u);
});

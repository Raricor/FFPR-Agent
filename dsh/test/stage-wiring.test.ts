import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import { loadKnowledge, type Knowledge } from "../src/engine/knowledge/index.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Json } from "../src/engine/values.ts";
import { describeStagePlan } from "../src/engine/stage/report.ts";
import type { StageOfficerRunner } from "../src/engine/stage/runner.ts";
import { readStageRecord, type StagePlanRecord } from "../src/engine/stage/store.ts";
import type { StageFacts, StagePlan } from "../src/engine/stage/types.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

const MAPS = [
  { id: 30, name: "卡纳克镇", areaId: 3, areaName: "卡纳克", areaType: "Town" },
  { id: 252, name: "火力船", areaId: 9, areaName: "火力船", areaType: "Dungeon" },
  { id: 253, name: "火力船 深处", areaId: 9, areaName: "火力船", areaType: "Dungeon" },
  { id: 254, name: "火力船 最深处", areaId: 9, areaName: "火力船", areaType: "Dungeon" },
];

const PLAN: StagePlan = {
  threats: ["中毒"],
  supplies: [{ item: "恢复药", min: 2, buyTo: 3 }],
  spells: [],
  gear: [],
  jobs: [],
  minLevel: null,
  route: [{ to: "253:1,1" }, { to: "253:5,5" }],
  turnBack: [{ kind: "status-uncurable", status: "中毒" }],
  notes: "",
};

async function staticKnowledge(directory: string, boss = false): Promise<Knowledge> {
  const home = join(directory, "knowledge");
  const staticDir = join(home, "static");
  await mkdir(staticDir, { recursive: true });
  await writeFile(
    join(staticDir, "maps.json"),
    JSON.stringify({ game: "ff5", table: "maps", rows: MAPS }),
    "utf8",
  );
  await writeFile(
    join(staticDir, "shops.json"),
    JSON.stringify({
      game: "ff5",
      table: "shops",
      rows: [
        {
          id: 1,
          mapId: 30,
          areaName: "卡纳克",
          kind: "Item",
          products: [{ itemId: 1, name: "恢复药", price: 20 }],
        },
      ],
    }),
    "utf8",
  );
  if (boss) {
    await writeFile(
      join(staticDir, "monsters.json"),
      JSON.stringify({
        game: "ff5",
        table: "monsters",
        rows: [
          {
            id: 8,
            name: "液态火焰",
            bookId: 8,
            level: 10,
            hp: 500,
            mp: 0,
            weak: ["冰"],
            absorb: [],
            nullify: [],
            statusImmune: [],
            drops: [],
            steal: [],
            boss: true,
            scriptId: null,
            moves: [],
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(staticDir, "encounters.json"),
      JSON.stringify({
        game: "ff5",
        table: "encounters",
        rows: [
          {
            scope: "map",
            mapId: 252,
            areaId: 9,
            groupId: 1,
            weight: 1,
            monsterIds: [8],
          },
        ],
      }),
      "utf8",
    );
  }
  return await loadKnowledge({
    game: "ff5",
    home,
    guide: null,
    atlas: null,
    atlasFile: null,
    collisions: null,
    collisionDir: null,
    bestiarySave: null,
    bestiaryFile: null,
    atlasSave: null,
    atlasSaveFile: null,
  });
}

async function temporaryGame(
  officer: StageOfficerRunner,
  options: {
    readonly planFile?: string;
    readonly recovery?: boolean;
    readonly boss?: boolean;
    readonly knowledge?: Knowledge;
    /** Task 113: the two new switches, default on. */
    readonly goFollowPlan?: boolean;
    readonly continueAfterTravel?: boolean;
  } = {},
): Promise<{ readonly game: Game; readonly directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-stage-wiring-"));
  const knowledge = options.knowledge ?? (await staticKnowledge(directory, options.boss === true));
  const atlas: Record<string, Json> = {
    "30": { name: "卡纳克镇", exits: [] },
    "252": { name: "火力船", exits: [] },
    "253": {
      name: "火力船 深处",
      exits: [],
      ...(options.recovery === true
        ? { recoveryPoints: [{ cell: [5, 5], label: "回复装置" }] }
        : {}),
    },
    "254": { name: "火力船 最深处", exits: [] },
  };
  const atlasFile = join(directory, "atlas.json");
  await writeFile(atlasFile, JSON.stringify(atlas), "utf8");
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile,
    collisionDir: join(directory, "collision"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    stagePlanFile: options.planFile ?? join(directory, "stage.json"),
    knowledge,
    stageOfficer: officer,
    stageGoFollowPlan: options.goFollowPlan ?? true,
    stageContinueAfterTravel: options.continueAfterTravel ?? true,
  });
  return { game, directory };
}

function party(status: readonly string[] = []): Json {
  return {
    party: [
      {
        name: "巴兹",
        jobName: "骑士",
        lv: 10,
        hp: 100,
        maxHp: 100,
        mp: 20,
        maxMp: 20,
        status,
        abilities: [],
      },
    ],
  };
}

function pilotFor(
  options: {
    readonly map?: number;
    readonly cell?: [number, number];
    readonly status?: readonly string[];
    readonly items?: Record<string, number>;
    readonly gil?: number;
    readonly timer?: Json;
    readonly shop?: boolean;
  } = {},
): FakePilot {
  const pilot = new FakePilot();
  const map = options.map ?? 30;
  pilot.on("pos", {
    pos: {
      state: options.shop === true ? "Shop" : "Player",
      map,
      cell: options.cell ?? [1, 1],
      ...(options.timer === undefined ? {} : { timer: options.timer }),
    },
  });
  pilot.onQuery("sample", {
    sample: { ...party(options.status ?? []), gil: options.gil ?? 100 },
  });
  pilot.onQuery("items", {
    items: {
      normal: Object.entries(options.items ?? {}).map(([name, count]) => ({ name, count })),
    },
  });
  pilot.onQuery("shop", {
    shop: {
      open: options.shop === true,
      kind: "Item",
      products: [{ name: "恢复药", price: 20 }],
    },
  });
  return pilot;
}

function officer(plan: StagePlan = PLAN, calls: StageFacts[] = []): StageOfficerRunner {
  return (facts) => {
    calls.push(facts);
    return Promise.resolve({
      plan,
      problems: [],
      text: describeStagePlan(plan, facts.target.label),
    });
  };
}

function record(status: StagePlanRecord["status"], plan: StagePlan = PLAN): StagePlanRecord {
  return {
    target: { mapId: 252, areaName: "火力船", label: "火力船" },
    plan,
    createdAt: "2026-11-10T00:00:00.000Z",
    status,
    startMapId: 30,
    startLabel: "卡纳克镇",
  };
}

void test("plan_stage plans, saves, and reads the plan back after a restart", async () => {
  const calls: StageFacts[] = [];
  const directory = await mkdtemp(join(tmpdir(), "ffpr-stage-plan-"));
  const path = join(directory, "stage.json");
  try {
    const first = await temporaryGame(officer(PLAN, calls), { planFile: path });
    const pilot = pilotFor({ items: {}, shop: true });
    const text = await first.game.run("plan_stage", { to: 252 }, pilot);
    assert.match(text, /阶段计划已存盘/);
    assert.match(text, /本店采购单/);
    assert.match(text, /恢复药 ×3/);
    assert.match(text, /60 gil/);
    assert.match(text, /出发检查：还不行/);
    assert.match(text, /阶段统计「火力船」:工具 0 次\(go 0、route 0、plan_stage 0\)/);
    assert.equal(calls.length, 1);
    assert.equal(first.game.stagePlan()?.status, "planned");
    await rm(first.directory, { recursive: true, force: true });

    const second = await temporaryGame(officer(PLAN, calls), { planFile: path });
    const again = await second.game.run("plan_stage", { to: 252 }, pilot);
    assert.match(again, /直接沿用/);
    assert.equal(calls.length, 1);
    assert.equal(second.game.stagePlan()?.target.mapId, 252);
    await rm(second.directory, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("go from a town to another region's dungeon calls the stage officer first", async () => {
  const calls: StageFacts[] = [];
  const { game, directory } = await temporaryGame(officer(PLAN, calls));
  try {
    const pilot = pilotFor();
    const text = await game.run("go", { to: 252 }, pilot);
    assert.equal(calls.length, 1);
    assert.match(text, /还没备齐/);
    assert.equal(game.stagePlan()?.target.mapId, 252);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("route to another region's dungeon also calls the stage officer first", async () => {
  const calls: StageFacts[] = [];
  const { game, directory } = await temporaryGame(officer(PLAN, calls));
  try {
    const text = await game.run("route", { stops: [{ to: 252 }] }, pilotFor());
    assert.equal(calls.length, 1);
    assert.match(text, /还没备齐/);
    assert.equal(game.stagePlan()?.target.mapId, 252);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an incomplete departure is refused and says what the shop sells", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save(record("planned"));
    const text = await game.run("go", { to: 252 }, pilotFor({ shop: true }));
    assert.match(text, /去「火力船」这一段还没备齐/);
    assert.match(text, /本店采购单/);
    assert.match(text, /恢复药 ×3/);
    assert.equal(game.stagePlan()?.status, "planned");
    assert.equal(game.backlog.pending().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("leave_incomplete lets an incomplete departure go and records a debt", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save(record("planned"));
    await game
      .run("go", { to: 252, leave_incomplete: "药不够，路上小心" }, pilotFor())
      .catch(() => undefined);
    assert.equal(game.stagePlan()?.status, "departed");
    assert.equal(game.stagePlan()?.stats?.tools, 1);
    assert.equal(game.stagePlan()?.stats?.go, 1);
    const pending = game.backlog.pending();
    assert.equal(pending.length, 1);
    const first = pending[0];
    assert.ok(first);
    assert.equal(first.reason, "药不够，路上小心");
    assert.match(first.missing.join(""), /恢复药/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a running countdown does not block the departure check", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save(record("planned"));
    await game
      .run("go", { to: 252 }, pilotFor({ timer: { active: true, seconds: 60 } }))
      .catch(() => undefined);
    assert.equal(game.stagePlan()?.status, "departed");
    assert.equal(game.backlog.pending().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an uncurable status with no recovery point ahead refuses going deeper", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save(record("departed"));
    const text = await game.run("go", { to: 254 }, pilotFor({ map: 253, status: ["中毒"] }));
    assert.match(text, /回头检查不通过/);
    assert.match(text, /中毒/);
    assert.match(text, /回城路线：/);
    assert.equal(game.stagePlan()?.status, "departed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a recovery point 12 cells ahead only tells the party to go there first", async () => {
  const { game, directory } = await temporaryGame(officer(), { recovery: true });
  try {
    await game.stagePlans.save(record("departed"));
    const before = (
      game as unknown as {
        stageBeforeTravel(
          pilot: FakePilot,
          args: Json,
          destinationMap: number,
          signal: AbortSignal | undefined,
        ): Promise<unknown>;
      }
    ).stageBeforeTravel.bind(game);
    const refusal = await before(
      pilotFor({ map: 253, status: ["中毒"] }),
      { to: 254 },
      254,
      undefined,
    );
    assert.equal(refusal, null);
    assert.match((game as unknown as { stageNotice: string }).stageNotice, /先到|前面 12 格/);
    assert.equal(game.stagePlan()?.status, "departed");
    assert.equal(game.backlog.pending().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("reaching the plan's last stop completes the stage plan", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    const plan: StagePlan = {
      ...PLAN,
      route: [{ to: "253:9,9" }],
      turnBack: [],
    };
    await game.stagePlans.save(record("departed", plan));
    const stageCompletion = (
      game as unknown as {
        stageCompletion(pilot: FakePilot): Promise<string>;
      }
    ).stageCompletion.bind(game);
    const text = await stageCompletion(pilotFor({ map: 253, cell: [9, 9] }));
    assert.match(text, /阶段计划：已完成/);
    assert.equal(game.stagePlan()?.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a finished boss battle also completes the stage plan", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save(record("departed"));
    game.mapId = 252;
    (game as unknown as { stageBossWon: boolean }).stageBossWon = true;
    const stageCompletion = (
      game as unknown as {
        stageCompletion(pilot: FakePilot): Promise<string>;
      }
    ).stageCompletion.bind(game);
    const text = await stageCompletion(pilotFor({ map: 252 }));
    assert.match(text, /首领打完/);
    assert.equal(game.stagePlan()?.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a battle-ended story event is a displayed key event", async () => {
  const { KeyEvents, WINDOWS } = await import("../src/engine/events.ts");
  assert.ok(WINDOWS[1].types.has("battle-ended"));
  assert.ok(WINDOWS[2].types.has("battle-ended"));
  const events = new KeyEvents(() => new Date("2026-11-10T12:00:10Z"));
  events.feed({ seq: 0, t: "2026-11-10T12:00:00Z", type: "hello", plugin: "0.14.5" });
  const sample = (seq: number, battle: Json, hp: number): Json => ({
    seq,
    t: `2026-11-10T12:00:0${seq}Z`,
    type: "sample",
    user: { mapId: 203, areaText: "卡纳克城", gil: 100, wins: 0, escapes: 0 },
    party: [
      { name: "巴兹", lv: 10, hp },
      { name: "蕾娜", lv: 10, hp },
    ],
    battle,
  });
  events.feed(sample(1, { active: true, enemies: [{ name: "中士" }] }, 78), false);
  events.feed(sample(2, { active: false }, 78), false);
  assert.match(events.window(2), /战斗结束 战斗被剧情结束：「中士」/);
});

type GoGate = (
  pilot: FakePilot,
  args: Json,
  cell: readonly [number, number],
) => Promise<{ readonly text: string } | null>;

function goGate(game: Game): GoGate {
  return (
    game as unknown as {
      stageBeforeGoCell(
        pilot: FakePilot,
        args: Json,
        cell: readonly [number, number],
      ): Promise<{ readonly text: string } | null>;
    }
  ).stageBeforeGoCell.bind(game);
}

void test("a coordinate go inside a departed plan is refused with the next waypoint and route()", async () => {
  const { game, directory } = await temporaryGame(officer(), { goFollowPlan: false });
  try {
    await game.stagePlans.save(record("departed"));
    const text = await game.run("go", { to: [3, 3] }, pilotFor({ map: 253, cell: [1, 1] }));
    assert.match(text, /阶段计划拦下/);
    assert.match(text, /下一个：.*\(5,5\)/);
    assert.match(text, /route\(\)/);
    assert.match(text, /会按阶段计划的路线走/);
    assert.match(text, /leave_incomplete/);
    const prefixed = await game.run("go", { to: "253:3,3" }, pilotFor({ map: 253, cell: [1, 1] }));
    assert.match(prefixed, /阶段计划拦下/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a plan waypoint, an event cell and an unopened hidden item cell are allowed", async () => {
  const { game, directory } = await temporaryGame(officer(), { goFollowPlan: false });
  try {
    await game.stagePlans.save(record("departed"));
    const pilot = pilotFor({ map: 253, cell: [1, 1] });
    pilot.on("entities", (fields) => {
      if (fields.kind === "Event") {
        return { entities: { entities: [{ kind: "Event", name: "", cell: [7, 7] }] } };
      }
      return {
        entities: {
          entities: [{ kind: "TresureBox", hidden: true, contentName: "银镜", cell: [8, 8] }],
        },
      };
    });
    assert.equal(await goGate(game)(pilot, { to: [5, 5] }, [5, 5]), null);
    assert.equal(await goGate(game)(pilot, { to: [7, 7] }, [7, 7]), null);
    assert.equal(await goGate(game)(pilot, { to: [8, 8] }, [8, 8]), null);
    const refused = await goGate(game)(pilot, { to: [9, 9] }, [9, 9]);
    assert.notEqual(refused, null);
    assert.match(refused?.text ?? "", /阶段计划拦下/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("leave_incomplete lets a planned-coordinate go through and records an activity line", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save(record("departed"));
    const lines: string[] = [];
    game.onActivity = (message) => lines.push(message);
    const result = await goGate(game)(
      pilotFor({ map: 253, cell: [1, 1] }),
      { to: [3, 3], leave_incomplete: "要先踩这个触发格" },
      [3, 3],
    );
    assert.equal(result, null);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /阶段计划放行/);
    assert.match(lines[0] ?? "", /要先踩这个触发格/);
    assert.match((game as unknown as { stageNotice: string }).stageNotice, /没有记欠账/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the coordinate gate is silent without a plan or outside the stage's maps", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    assert.equal(
      await goGate(game)(pilotFor({ map: 253, cell: [1, 1] }), { to: [3, 3] }, [3, 3]),
      null,
    );
    await game.stagePlans.save(record("departed"));
    assert.equal(
      await goGate(game)(pilotFor({ map: 30, cell: [1, 1] }), { to: [3, 3] }, [3, 3]),
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("plan_stage with a boss writes its table once and stores it on the boss map", async () => {
  const calls: string[] = [];
  const { game, directory } = await temporaryGame(officer(), { boss: true });
  game.setTactician((facts) => {
    calls.push(facts);
    return Promise.resolve({
      tables: [{ 巴兹: [{ do: "攻击" }] }],
      walkerNotes: "首领用冰",
      askUp: "",
    });
  });
  try {
    const text = await game.run(
      "plan_stage",
      { to: 252 },
      pilotFor({ items: { 不死鸟之尾: 2, 恢复药: 2 } }),
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /### 首领/);
    assert.match(text, /首领「液态火焰」的表已经写好/);
    const boss = game.tactics.boss(252);
    assert.ok(boss);
    assert.equal(boss.prepared, true);
    assert.equal(game.stagePlan()?.boss?.names[0], "液态火焰");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a stage without bosses does not call the tactician for a boss table", async () => {
  let calls = 0;
  const { game, directory } = await temporaryGame(officer());
  game.setTactician(() => {
    calls += 1;
    return Promise.resolve({ tables: [{ 巴兹: [{ do: "攻击" }] }], walkerNotes: "", askUp: "" });
  });
  try {
    const text = await game.run("plan_stage", { to: 252 }, pilotFor());
    assert.equal(calls, 0);
    assert.doesNotMatch(text, /首领/);
    assert.equal(game.stagePlan()?.boss, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a changed party at the last checkpoint before the boss rewrites the table", async () => {
  const calls: string[] = [];
  const { game, directory } = await temporaryGame(officer(), { boss: true, recovery: true });
  game.setTactician((facts) => {
    calls.push(facts);
    return Promise.resolve({
      tables: [{ 巴兹: [{ do: "攻击" }] }],
      walkerNotes: "按现在的队伍改好",
      askUp: "",
    });
  });
  const plan: StagePlan = {
    ...PLAN,
    route: [{ to: "253:1,1" }, { to: "253:5,5" }, { to: "252:9,9" }],
    turnBack: [],
  };
  try {
    await game.stagePlans.save({
      target: { mapId: 252, areaName: "火力船", label: "火力船" },
      plan,
      createdAt: "2026-11-10T00:00:00.000Z",
      status: "departed",
      startMapId: 30,
      startLabel: "卡纳克镇",
      boss: {
        names: ["液态火焰"],
        bookIds: [8],
        monsterIds: [],
        mapId: 252,
        table: { 巴兹: [{ do: "防御" }] },
        at: "2026-11-10T00:00:00.000Z",
        result: "出发前阶段计划的首领表",
        party: [{ name: "巴兹", job: "战士", level: 1 }],
      },
    });
    game.mapId = 253;
    const text = await (
      game as unknown as { afterTool(pilot: FakePilot): Promise<string> }
    ).afterTool(pilotFor({ map: 253, cell: [5, 5], items: { 不死鸟之尾: 2, 恢复药: 2 } }));
    assert.equal(calls.length, 1);
    assert.match(text, /队伍变了/);
    assert.match(text, /首领「液态火焰」的表已经写好/);
    assert.deepEqual(game.stagePlan()?.boss?.table, { 巴兹: [{ do: "攻击" }] });
    assert.deepEqual(game.tactics.boss(252)?.table, { 巴兹: [{ do: "攻击" }] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a saved stage plan reads its boss table and party back", () => {
  const parsed = readStageRecord({
    target: { mapId: 252, areaName: "火力船", label: "火力船" },
    plan: PLAN,
    createdAt: "2026-11-10T00:00:00.000Z",
    status: "planned",
    boss: {
      names: ["液态火焰"],
      bookIds: [8],
      monsterIds: [8],
      mapId: 252,
      table: { 巴兹: [{ do: "攻击" }] },
      at: "2026-11-10T00:00:00.000Z",
      result: "出发前阶段计划的首领表",
      party: [{ name: "巴兹", job: "骑士", level: 10 }],
    },
  });
  const boss = parsed.boss;
  assert.ok(boss);
  assert.deepEqual(boss.names, ["液态火焰"]);
  assert.equal(boss.mapId, 252);
  assert.deepEqual(boss.party, [{ name: "巴兹", job: "骑士", level: 10 }]);
});

void test("a coordinate go on an atlas exit triggers the stage officer and departure check", async () => {
  const calls: StageFacts[] = [];
  const { game, directory } = await temporaryGame(officer(PLAN, calls));
  try {
    game.atlas.maps.set("30", { name: "卡纳克镇", exits: [{ cell: [5, 5], to: 252 }] });
    const text = await game.run("go", { to: [5, 5] }, pilotFor({ map: 30, cell: [4, 5] }));
    assert.equal(calls.length, 1);
    assert.match(text, /还没备齐/);
    assert.equal(game.stagePlan()?.target.mapId, 252);
    // A normal cell is not an entrance: the officer is not called again.
    await game
      .run("go", { to: [9, 9] }, pilotFor({ map: 30, cell: [4, 5] }))
      .catch(() => undefined);
    assert.equal(calls.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a coordinate go on a bridge GotoMap entity also names its destination map", async () => {
  const calls: StageFacts[] = [];
  const { game, directory } = await temporaryGame(officer(PLAN, calls));
  try {
    const pilot = pilotFor({ map: 30, cell: [4, 5] });
    pilot.on("entities", (fields) => ({
      entities: {
        entities:
          fields.kind === "GotoMap"
            ? [{ kind: "GotoMap", cell: [5, 5], toMap: 252, active: true }]
            : [],
      },
    }));
    const text = await game.run("go", { to: [5, 5] }, pilot);
    assert.equal(calls.length, 1);
    assert.match(text, /还没备齐/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("scouting keeps bypassing the coordinate gate", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save(record("departed"));
    (game as unknown as { scouting: boolean }).scouting = true;
    assert.equal(
      await goGate(game)(pilotFor({ map: 253, cell: [1, 1] }), { to: [9, 9] }, [9, 9]),
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("plan_stage shows the current plan's tool, stop and time numbers", async () => {
  const { game, directory } = await temporaryGame(officer());
  try {
    await game.stagePlans.save({
      ...record("departed"),
      stats: {
        departedAt: new Date().toISOString(),
        tools: 3,
        go: 2,
        route: 0,
        planStage: 1,
        stops: 4,
      },
    });
    const text = await game.run("plan_stage", { to: 252 }, pilotFor());
    // This plan_stage call is itself counted before the result is rendered.
    assert.match(
      text,
      /阶段统计「火力船」:工具 4 次\(go 2、route 0、plan_stage 2\),按计划走了 4 站，用时 0 分/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

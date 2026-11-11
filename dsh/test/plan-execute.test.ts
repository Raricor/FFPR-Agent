/**
 * Task 138: the segment executor is tested with doubles only. The fake ports record every call
 * and simulate the route executor's walking, story interruptions, choices, boss fights and
 * turn-back conditions; no bridge, laptop or model is involved.
 */

/* eslint-disable @typescript-eslint/require-await -- the fake ports mirror async engine methods */

import assert from "node:assert/strict";
import test from "node:test";
import type { Cell } from "../src/engine/nav.ts";
import type { RoutePlan, Waypoint } from "../src/engine/route/types.ts";
import type { RoutePorts } from "../src/engine/route/execute.ts";
import {
  evaluateTurnBack,
  executeSegmentPlan,
  turnBackStateOf,
  type ExecutePorts,
  type PlanBossResult,
  type PlanBuyResult,
  type PlanExitTarget,
  type PlanObservation,
  type PlanScene,
  type PlanProgressStatus,
  type PlanShop,
  type PlanStationResult,
} from "../src/engine/plan/execute.ts";
import type { PlanBattle, PlanBoss, PlanStation, SegmentPlan } from "../src/engine/plan/types.ts";

function member(
  name: string,
  hp = 100,
  maxHp = 100,
  mp = 20,
  maxMp = 20,
  status: readonly string[] = [],
  abilities: readonly string[] = [],
) {
  return { name, job: "战士", lv: 10, hp, maxHp, mp, maxMp, status, abilities };
}

function sameCell(left: Cell, right: Cell): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function observation(overrides: Partial<PlanObservation> = {}): PlanObservation {
  return {
    map: 10,
    cell: [5, 5],
    members: [member("巴兹")],
    items: { 恢复药: 3 },
    bestiary: [{ number: 1, name: "哥布林" }],
    blueMagic: [],
    chestsOpened: 2,
    battles: 0,
    ...overrides,
  };
}

class FakePorts implements ExecutePorts {
  readonly calls: string[] = [];
  positionAt: { map: number; cell: Cell } = { map: 10, cell: [5, 5] };
  current = observation();
  unreachable = new Set<string>();
  /** Station id → how many goTo calls are interrupted by dialog first. */
  readonly interruptions = new Map<string, number>();
  readonly decisions = new Map<string, string>();
  boss: PlanBossResult = { won: true, text: "打倒", summary: "首领倒下" };
  gameoverOk = false;
  buys: PlanBuyResult = { ok: true, atShop: true, bought: 1, text: "买了" };
  readonly buyQueue: PlanBuyResult[] = [];
  shopsList: readonly PlanShop[] = [];
  shopOpen = false;
  shopRequired = false;
  shopOpens = true;
  readonly openedShops: Cell[] = [];
  readonly leftShops: string[] = [];
  /** Station/shop waypoint id → the maps the fake route crosses. */
  readonly routeMaps = new Map<string, readonly number[]>();
  readonly chosen: (number | string)[] = [];
  readonly fought: string[] = [];
  readonly tables: (readonly PlanBattle[])[] = [];
  readonly routeCells: Cell[] = [];
  /** Task 141: the boss cell, how it is reached, and how many confirms start the fight. */
  bossCell: Cell | null = null;
  bossKind: "trigger" | "object" = "object";
  bossPressesNeeded = 1;
  bossPressed = 0;
  bossActiveFlag = false;
  storyDecision: string | undefined;
  /** Task 145: battle/story at station boundaries; stable by default. */
  sceneValue: PlanScene = {
    state: "Player",
    dialog: false,
    battle: false,
    boss: false,
    enemies: [],
  };
  readonly exits = new Map<string, PlanExitTarget>();
  readonly aliasTable = new Map<string, readonly string[]>();
  /** Set a battle when the next walk arrives, to test the station boundary. */
  battleOnArrive: { readonly boss: boolean; readonly enemies: readonly string[] } | null = null;
  dialogOnArrive = false;
  readonly unknownMaps = new Set<number>();
  modelCallCount = 0;
  normalFights = 0;
  normalTables: (readonly unknown[])[] = [];
  normal: PlanBossResult = { won: true, text: "普通战斗打赢", summary: "普通战斗打赢" };
  leave: string[] = [];
  private interrupted = new Map<string, number>();

  async begin(): Promise<void> {
    this.calls.push("begin");
  }
  async end(): Promise<void> {
    this.calls.push("end");
  }
  async position(): Promise<{ map: number; cell: Cell } | null> {
    return this.positionAt;
  }
  async observe(refresh = false): Promise<PlanObservation> {
    this.calls.push(refresh ? "observe:deep" : "observe");
    return this.current;
  }
  async changeJob(memberName: string, job: string, abilities: readonly string[]) {
    this.calls.push(`job:${memberName}:${job}:${abilities.join(",")}`);
    return { ok: true, text: "换了" };
  }
  async optimizeEquipment() {
    this.calls.push("optimize");
    return { ok: true, text: "最强装备" };
  }
  async shops(): Promise<readonly PlanShop[]> {
    this.calls.push("shops");
    return this.shopsList;
  }
  async openShop(cell: Cell) {
    this.calls.push(`openShop:${cell[0]},${cell[1]}`);
    this.openedShops.push(cell);
    if (this.shopOpens) this.shopOpen = true;
    return { ok: this.shopOpens, text: this.shopOpens ? "商店开了" : "没打开" };
  }
  async leaveShop() {
    this.calls.push("leaveShop");
    this.leftShops.push("left");
    this.shopOpen = false;
    return { ok: true, text: "回到地图" };
  }
  async buy(item: string, count: number): Promise<PlanBuyResult> {
    this.calls.push(`buy:${item}:${count}`);
    if (this.shopRequired && !this.shopOpen) {
      return { ok: false, atShop: false, bought: 0, text: "不在商店" };
    }
    return this.buyQueue.shift() ?? this.buys;
  }
  async setRow(memberName: string, row: "front" | "back") {
    this.calls.push(`row:${memberName}:${row}`);
    return { ok: true, text: "站好" };
  }
  routePorts(): RoutePorts {
    return {
      position: async () => this.positionAt,
      goTo: async (stop) => {
        this.calls.push(`go:${stop.id}`);
        const left = this.interrupted.get(stop.id) ?? this.interruptions.get(stop.id) ?? 0;
        if (left > 0) {
          this.interrupted.set(stop.id, left - 1);
          return { ok: false, text: "走了一半 interrupted:dialog" };
        }
        this.positionAt = { map: stop.map, cell: stop.cell ?? [0, 0] };
        this.routeCells.push(this.positionAt.cell);
        if (this.battleOnArrive !== null) {
          this.sceneValue = {
            state: "Battle",
            dialog: false,
            battle: true,
            boss: this.battleOnArrive.boss,
            enemies: [...this.battleOnArrive.enemies],
          };
        } else if (this.dialogOnArrive) {
          this.sceneValue = {
            state: "Event",
            dialog: true,
            battle: false,
            boss: false,
            enemies: [],
          };
        }
        if (
          this.bossKind === "trigger" &&
          this.bossCell !== null &&
          sameCell(this.positionAt.cell, this.bossCell)
        ) {
          this.bossActiveFlag = true;
        }
        return { ok: true, text: "走到了" };
      },
      act: async () => ({ ok: true, done: true, text: "占了位" }),
      replan: async (from, rest) => this.planRoute(from, rest),
      story: async () => {
        this.calls.push("story");
        if (this.storyDecision !== undefined) {
          const decision = this.storyDecision;
          this.storyDecision = undefined;
          return { text: "翻了一页", decision };
        }
        return { text: "翻了 2 页" };
      },
      watch: async () => ({ timer: null, gameover: null }),
    };
  }
  async planRoute(
    from: { map: number; cell: Cell },
    waypoints: readonly Waypoint[],
  ): Promise<RoutePlan> {
    const unreachable = waypoints
      .filter((waypoint) => this.unreachable.has(waypoint.id))
      .map((waypoint) => ({
        id: waypoint.id,
        kind: waypoint.kind,
        map: waypoint.map,
        cell: waypoint.cell,
        label: waypoint.label,
        reason: "地图记录里没有路",
      }));
    const reachable = waypoints.filter((waypoint) => !this.unreachable.has(waypoint.id));
    const legs = reachable.map((waypoint, index) => ({
      from:
        index === 0
          ? { map: from.map, cell: from.cell }
          : {
              map: reachable[index - 1]?.map ?? from.map,
              cell: reachable[index - 1]?.cell ?? null,
            },
      waypoint: waypoint.id,
      kind: waypoint.kind,
      label: waypoint.label,
      map: waypoint.map,
      cell: waypoint.cell,
      maps: this.routeMaps.get(waypoint.id) ?? [waypoint.map],
      hops: 0,
      cells: 1,
      minutes: 0,
    }));
    return {
      legs,
      unreachable,
      warnings: [],
      total: { cells: legs.length, hops: 0, minutes: 0 },
    };
  }
  async interact(cell: Cell): Promise<PlanStationResult> {
    this.calls.push(`interact:${cell[0]},${cell[1]}`);
    const decision = this.decisions.get(`interact:${cell[0]},${cell[1]}`);
    if (decision !== undefined) return { ok: false, done: false, text: "对话", decision };
    if (this.bossCell !== null && sameCell(cell, this.bossCell)) {
      this.bossPressed += 1;
      if (this.bossPressed >= this.bossPressesNeeded) {
        this.bossActiveFlag = true;
        return {
          ok: false,
          done: false,
          text: "首领战开始",
          decision: "首领战开始了，交给 AI",
        };
      }
      return { ok: true, done: true, text: "按了确认，没有反应" };
    }
    return { ok: true, done: true, text: "打开了" };
  }
  async bossTarget(): Promise<"trigger" | "object"> {
    this.calls.push("bossTarget");
    return this.bossKind;
  }
  async battleActive(): Promise<boolean> {
    this.calls.push("battleActive");
    // Tests that do not model a boss cell are already at the fight after the walk.
    return this.bossCell === null ? true : this.bossActiveFlag;
  }
  async scene(): Promise<PlanScene> {
    return this.sceneValue;
  }
  async exitTarget(map: number, cell: Cell): Promise<PlanExitTarget | null> {
    return this.exits.get(`${map}:${cell[0]},${cell[1]}`) ?? null;
  }
  async mapKnown(map: number): Promise<boolean> {
    return !this.unknownMaps.has(map);
  }
  modelCalls(): number {
    return this.modelCallCount;
  }
  async bossAliases(name: string): Promise<readonly string[]> {
    return this.aliasTable.get(name) ?? [];
  }
  async fightNormal(tables: readonly unknown[]): Promise<PlanBossResult> {
    this.calls.push("fightNormal");
    this.normalFights += 1;
    this.normalTables.push(tables);
    if (this.normal.won)
      this.sceneValue = { ...this.sceneValue, battle: false, boss: false, enemies: [] };
    return this.normal;
  }
  async leaveNotes(): Promise<readonly string[]> {
    const lines = [...this.leave];
    this.leave.length = 0;
    return lines;
  }
  async story(): Promise<{ text: string; decision?: string }> {
    this.calls.push("story");
    this.sceneValue = { ...this.sceneValue, dialog: false, state: "Player" };
    if (this.storyDecision === undefined) return { text: "翻了 2 页" };
    const decision = this.storyDecision;
    this.storyDecision = undefined;
    return { text: "翻了一页", decision };
  }
  async choose(option: number | string) {
    this.calls.push(`choose:${String(option)}`);
    this.chosen.push(option);
    return { ok: true, text: `选了 ${String(option)}` };
  }
  async save() {
    this.calls.push("save");
    return { ok: true, text: "存了" };
  }
  async heal() {
    this.calls.push("heal");
    return { ok: true, text: "补满了" };
  }
  async grind(stop: Waypoint) {
    this.calls.push(`grind:${stop.id}`);
    return { ok: true, done: true, text: "刷完了" };
  }
  async beginBattles(battles: readonly PlanBattle[]): Promise<void> {
    this.calls.push("beginBattles");
    this.tables.push(battles);
  }
  async endBattles(): Promise<void> {
    this.calls.push("endBattles");
  }
  async fightBoss(boss: PlanBoss): Promise<PlanBossResult> {
    this.calls.push(`boss:${boss.name}`);
    this.fought.push(boss.name);
    if (this.boss.won)
      this.sceneValue = { ...this.sceneValue, battle: false, boss: false, enemies: [] };
    return this.boss;
  }
  async recoverGameover() {
    this.calls.push("recoverGameover");
    return {
      ok: this.gameoverOk,
      text: this.gameoverOk ? "已读 20 号位" : "没有弹窗",
    };
  }
  battleCount(): number {
    return this.current.battles;
  }
  async startProgress(section: string, _goal: string, labels: readonly string[]): Promise<void> {
    this.calls.push(`progress:start:${section}:${labels.length}`);
  }
  async markProgress(index: number, status: PlanProgressStatus, note: string): Promise<void> {
    this.calls.push(`progress:${index}:${status}:${note}`);
  }
  async finishProgress(): Promise<void> {
    this.calls.push("progress:finish");
  }
}

function station(
  doIt: PlanStation["do"],
  to: string,
  extra: Partial<PlanStation> = {},
): PlanStation {
  return { to, do: doIt, why: "测试", ...extra };
}

function plan(stations: readonly PlanStation[], extra: Partial<SegmentPlan> = {}): SegmentPlan {
  return {
    version: 1,
    section: "风之神殿",
    goal: "打完这一节",
    prep: { jobs: [], equip: "keep", buy: [], rows: [] },
    stations,
    battle: [{ maps: [], tables: [{ 巴兹: ["攻击"] }] }],
    bosses: [],
    turnBack: [],
    ...extra,
  };
}

void test("preparation runs in the plan's order and a shop miss is only a note", async () => {
  const ports = new FakePorts();
  ports.buys = { ok: false, atShop: false, bought: 0, text: "不在商店，没买" };
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], {
      prep: {
        jobs: [
          { member: "巴兹", job: "盗贼", abilities: ["偷窃"] },
          { member: "蕾娜", job: "白魔法师" },
        ],
        equip: "optimize",
        buy: [{ item: "恢复药", count: 3 }],
        rows: [{ member: "巴兹", row: "front" }],
      },
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(
    ports.calls.filter((call) => !call.startsWith("progress") && !call.startsWith("observe")),
    [
      "begin",
      "job:巴兹:盗贼:偷窃",
      "job:蕾娜:白魔法师:",
      "optimize",
      "shops",
      "buy:恢复药:3",
      "row:巴兹:front",
      "beginBattles",
      "go:plan-0",
      "endBattles",
      "end",
    ],
  );
});

function shop(
  id: number,
  map: number,
  cell: Cell,
  area: string,
  kind: string,
  products: readonly { name: string; names?: readonly string[]; price?: number }[],
): PlanShop {
  return {
    id,
    map,
    cell,
    area,
    kind,
    products: products.map((product) => ({
      name: product.name,
      names: product.names ?? [product.name],
      price: product.price ?? 10,
    })),
  };
}

void test("shopping walks to the clerk and opens the menu before buying", async () => {
  const ports = new FakePorts();
  ports.current = observation({ map: 10, area: "图尔村" });
  ports.shopsList = [
    shop(38, 10, [7, 6], "图尔村", "魔法店", [
      { name: "火炎", names: ["火炎", "Fire"], price: 150 },
    ]),
  ];
  ports.shopOpen = false;
  ports.shopRequired = true;
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], {
      prep: {
        jobs: [],
        equip: "keep",
        buy: [{ item: "Fire", count: 1 }],
        rows: [],
      },
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(ports.openedShops, [[7, 6]]);
  const order = ports.calls.filter((call) => /^(openShop|buy|leaveShop)/u.test(call));
  assert.deepEqual(order, ["openShop:7,6", "buy:Fire:1", "leaveShop"]);
});

void test("two shops group the purchases and each is visited once", async () => {
  const ports = new FakePorts();
  ports.current = observation({ map: 10, area: "图尔村" });
  ports.shopsList = [
    shop(38, 10, [7, 6], "图尔村", "魔法店", [
      { name: "火炎", names: ["火炎", "Fire"] },
      { name: "冰结", names: ["冰结", "Blizzard"] },
    ]),
    shop(4, 10, [3, 4], "图尔村", "道具店", [{ name: "恢复药", names: ["恢复药", "Potion"] }]),
  ];
  ports.shopRequired = true;
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], {
      prep: {
        jobs: [],
        equip: "keep",
        buy: [
          { item: "Fire", count: 1 },
          { item: "Potion", count: 2 },
          { item: "Blizzard", count: 1 },
        ],
        rows: [],
      },
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.equal(ports.openedShops.length, 2);
  assert.deepEqual(
    ports.calls.filter((call) => /^(openShop|buy:)/u.test(call)),
    ["openShop:7,6", "buy:Fire:1", "buy:Blizzard:1", "openShop:3,4", "buy:Potion:2"],
  );
});

void test("money running out stops shopping with a note, not an exception", async () => {
  const ports = new FakePorts();
  ports.current = observation({ map: 10, area: "图尔村" });
  ports.shopsList = [
    shop(38, 10, [7, 6], "图尔村", "魔法店", [
      { name: "火炎", names: ["火炎", "Fire"] },
      { name: "治疗", names: ["治疗", "Cure"] },
    ]),
  ];
  ports.shopRequired = true;
  ports.buyQueue.push(
    { ok: true, atShop: true, bought: 1, text: "买了火炎" },
    { ok: false, atShop: true, bought: 0, text: "钱不够:Cure×1 要 180,只有 20" },
  );
  const lines: string[] = [];
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], {
      prep: {
        jobs: [],
        equip: "keep",
        buy: [
          { item: "Fire", count: 1 },
          { item: "Cure", count: 1 },
        ],
        rows: [],
      },
    }),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "done");
  assert.ok(lines.some((line) => line.includes("钱不够没买：Cure×1")));
  assert.deepEqual(
    ports.calls.filter((call) => call.startsWith("buy:")),
    ["buy:Fire:1", "buy:Cure:1"],
  );
});

void test("a shop passed on the way is inserted before the station", async () => {
  const ports = new FakePorts();
  ports.current = observation({ map: 10, area: "起点镇" });
  ports.shopsList = [
    shop(20, 11, [4, 5], "路上镇", "道具店", [{ name: "恢复药", names: ["恢复药", "Potion"] }]),
  ];
  ports.routeMaps.set("plan-0", [10, 11, 12]);
  ports.shopRequired = true;
  const report = await executeSegmentPlan(
    plan([station("move", "12:8,8")], {
      prep: {
        jobs: [],
        equip: "keep",
        buy: [{ item: "Potion", count: 2 }],
        rows: [],
      },
    }),
    ports,
  );
  assert.equal(report.status, "done");
  const interesting = ports.calls.filter((call) => /^(openShop|buy:|leaveShop$|go:)/u.test(call));
  assert.deepEqual(interesting, [
    "go:shop-20@11:4,5",
    "openShop:4,5",
    "buy:Potion:2",
    "leaveShop",
    "go:plan-0",
  ]);
  assert.deepEqual(ports.positionAt, { map: 12, cell: [8, 8] });
});

void test("an item no shop sells is only a note", async () => {
  const ports = new FakePorts();
  ports.current = observation({ map: 10, area: "图尔村" });
  ports.shopsList = [
    shop(4, 10, [3, 4], "图尔村", "道具店", [{ name: "恢复药", names: ["恢复药", "Potion"] }]),
  ];
  const lines: string[] = [];
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], {
      prep: {
        jobs: [],
        equip: "keep",
        buy: [{ item: "Fire", count: 1 }],
        rows: [],
      },
    }),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "done");
  assert.ok(lines.some((line) => line.includes("这段路上没有店卖：Fire×1")));
  assert.equal(ports.openedShops.length, 0);
});

void test("stations execute in plan order", async () => {
  const ports = new FakePorts();
  const report = await executeSegmentPlan(
    plan([
      station("open", "10:6,5"),
      station("save", "10:7,5"),
      station("talk", "10:8,5"),
      station("move", "10:9,5"),
    ]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.equal(report.done.stations, 4);
  assert.deepEqual(
    ports.calls.filter((call) => /^(go|interact|save|choose)/u.test(call)),
    ["go:plan-0", "interact:6,5", "go:plan-1", "save", "go:plan-2", "interact:8,5", "go:plan-3"],
  );
});

void test("a story interruption is paged and the station continues", async () => {
  const ports = new FakePorts();
  ports.interruptions.set("plan-0", 1);
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports);
  assert.equal(report.status, "done");
  assert.equal(ports.calls.filter((call) => call === "story").length, 1);
  assert.deepEqual(
    ports.calls.filter((call) => call.startsWith("go:")),
    ["go:plan-0", "go:plan-0"],
  );
});

void test("an unreachable required station is an unreachable exception", async () => {
  const ports = new FakePorts();
  ports.unreachable.add("plan-1");
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5"), station("open", "10:8,8")]),
    ports,
  );
  assert.equal(report.status, "exception");
  assert.ok(report.exception);
  assert.equal(report.exception.kind, "unreachable");
  assert.equal(report.exception.station, 1);
  assert.deepEqual(report.remaining, [1]);
});

void test("an unreachable optional save station is skipped, not an exception", async () => {
  const ports = new FakePorts();
  ports.unreachable.add("plan-0");
  const report = await executeSegmentPlan(
    plan([station("save", "10:99,99", { optional: true })]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(report.remaining, []);
  assert.ok(ports.calls.some((call) => call.includes(":skipped:")));
});

void test("the plan's choose station answers a dialog choice", async () => {
  const ports = new FakePorts();
  ports.decisions.set("interact:6,5", "路上出现了剧情选项，交给 AI 选");
  const report = await executeSegmentPlan(
    plan([station("talk", "10:6,5"), station("choose", "10:6,5", { choose: "是" })]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(ports.chosen, ["是"]);
  assert.equal(report.done.stations, 2);
});

void test("a dialog choice the plan did not answer is a story-choice exception", async () => {
  const ports = new FakePorts();
  ports.decisions.set("interact:6,5", "路上出现了剧情选项，交给 AI 选");
  const report = await executeSegmentPlan(plan([station("talk", "10:6,5")]), ports);
  assert.equal(report.status, "exception");
  assert.equal(report.exception?.kind, "story-choice");
  assert.deepEqual(report.remaining, [0]);
});

void test("a boss heals first, saves, then fights with the plan's boss table", async () => {
  const ports = new FakePorts();
  const boss: PlanBoss = {
    name: "风之水晶",
    map: 10,
    healFirst: true,
    saveFirst: true,
    tables: [{ 巴兹: ["攻击"] }],
  };
  const report = await executeSegmentPlan(
    plan([station("boss", "10:9,9")], { bosses: [boss] }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(ports.fought, ["风之水晶"]);
  assert.deepEqual(report.done.bossesWon, ["风之水晶"]);
  const bossAt = ports.calls.findIndex((call) => call === "boss:风之水晶");
  assert.ok(ports.calls.indexOf("heal") < bossAt);
  assert.ok(ports.calls.indexOf("save") < bossAt);
});

void test("a lost boss is a boss-lost exception with a battle summary", async () => {
  const ports = new FakePorts();
  ports.boss = {
    won: false,
    text: "全灭",
    summary: "敌人:风之水晶,全队 HP 只剩 0%",
  };
  const report = await executeSegmentPlan(
    plan([station("boss", "10:9,9")], {
      bosses: [
        {
          name: "风之水晶",
          map: 10,
          healFirst: false,
          saveFirst: false,
          tables: [{}],
        },
      ],
    }),
    ports,
  );
  assert.equal(report.status, "exception");
  assert.ok(report.exception);
  assert.equal(report.exception.kind, "boss-lost");
  assert.match(report.exception.detail, /风之水晶/u);
});

void test("a lost boss that lands on the game-over popup is a gameover exception", async () => {
  const ports = new FakePorts();
  ports.boss = { won: false, text: "全灭", summary: "全队倒下" };
  ports.gameoverOk = true;
  const report = await executeSegmentPlan(
    plan([station("boss", "10:9,9")], {
      bosses: [
        {
          name: "风之水晶",
          map: 10,
          healFirst: false,
          saveFirst: false,
          tables: [{}],
        },
      ],
    }),
    ports,
  );
  assert.equal(report.status, "exception");
  assert.equal(report.exception?.kind, "gameover");
  assert.ok(ports.calls.includes("recoverGameover"));
});

void test("a replan turn-back stops the segment", async () => {
  const ports = new FakePorts();
  ports.current = observation({ members: [member("巴兹", 10, 100)] });
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], {
      turnBack: [{ when: "party.lowest_hp_pct < 30", then: "replan" }],
    }),
    ports,
  );
  assert.equal(report.status, "exception");
  assert.equal(report.exception?.kind, "turn-back");
});

void test("a heal-and-continue turn-back heals and keeps walking", async () => {
  const ports = new FakePorts();
  ports.current = observation({ members: [member("巴兹", 10, 100)] });
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], {
      turnBack: [{ when: "party.lowest_hp_pct < 30", then: "heal-and-continue" }],
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("heal"));
  assert.ok(ports.calls.includes("go:plan-0"));
});

void test("the report counts chests, new bestiary, blue magic and battles", async () => {
  const ports = new FakePorts();
  ports.current = observation({
    members: [member("巴兹", 90, 100, 10, 20, [], ["治疗"])],
    chestsOpened: 2,
    bestiary: [{ number: 1, name: "哥布林" }],
    blueMagic: ["治疗"],
    battles: 0,
  });
  const original = ports.interact.bind(ports);
  ports.interact = async (cell) => {
    const result = await original(cell);
    ports.current = observation({
      members: [member("巴兹", 90, 100, 10, 20, [], ["治疗", "青魔法"])],
      chestsOpened: 3,
      bestiary: [
        { number: 1, name: "哥布林" },
        { number: 2, name: "风精灵" },
      ],
      blueMagic: ["治疗", "青魔法"],
      battles: 4,
    });
    return result;
  };
  const report = await executeSegmentPlan(plan([station("open", "10:6,5")]), ports);
  assert.equal(report.done.chestsOpened, 1);
  assert.deepEqual(report.done.bestiaryNew, ["风精灵"]);
  assert.deepEqual(report.done.blueMagicNew, ["青魔法"]);
  assert.equal(report.done.battles, 4);
  assert.equal(report.modelCalls, 0);
  assert.match(report.party, /巴兹 Lv10/u);
});

void test("a boss cell that cannot be stepped on is faced from below and fought", async () => {
  const ports = new FakePorts();
  ports.positionAt = { map: 10, cell: [9, 10] };
  ports.bossCell = [9, 9];
  const boss: PlanBoss = {
    name: "巨翼猛禽",
    map: 10,
    healFirst: true,
    saveFirst: true,
    tables: [{ 巴兹: ["攻击"] }],
  };
  const report = await executeSegmentPlan(
    plan([station("boss", "10:9,9", { why: "首领 巨翼猛禽" })], {
      bosses: [boss],
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(report.done.bossesWon, ["巨翼猛禽"]);
  assert.deepEqual(ports.fought, ["巨翼猛禽"]);
  // The stand cell is directly below the boss, so the confirm faces Up.
  assert.deepEqual(ports.routeCells[0], [9, 10]);
  assert.equal(ports.bossPressed, 1);
  assert.ok(ports.calls.indexOf("heal") < ports.calls.indexOf("boss:巨翼猛禽"));
  assert.ok(ports.calls.indexOf("save") < ports.calls.indexOf("boss:巨翼猛禽"));
});

void test("a boss confirm that opens nothing retries another side", async () => {
  const ports = new FakePorts();
  ports.positionAt = { map: 10, cell: [9, 10] };
  ports.bossCell = [9, 9];
  ports.bossPressesNeeded = 2;
  const report = await executeSegmentPlan(
    plan([station("boss", "10:9,9", { why: "首领 巨翼猛禽" })], {
      bosses: [
        {
          name: "巨翼猛禽",
          map: 10,
          healFirst: false,
          saveFirst: false,
          tables: [{}],
        },
      ],
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.equal(ports.bossPressed, 2);
  assert.deepEqual(ports.routeCells.slice(0, 2), [
    [9, 10],
    [9, 8],
  ]);
});

void test("a story-trigger boss is stepped on instead of faced", async () => {
  const ports = new FakePorts();
  ports.positionAt = { map: 10, cell: [9, 10] };
  ports.bossCell = [9, 9];
  ports.bossKind = "trigger";
  const report = await executeSegmentPlan(
    plan([station("boss", "10:9,9", { why: "首领 巨翼猛禽" })], {
      bosses: [
        {
          name: "巨翼猛禽",
          map: 10,
          healFirst: false,
          saveFirst: false,
          tables: [{}],
        },
      ],
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(ports.routeCells[0], [9, 9]);
  assert.equal(ports.bossPressed, 0);
});

void test("the process log names the station, the approach and each boss fight", async () => {
  const ports = new FakePorts();
  ports.positionAt = { map: 10, cell: [5, 5] };
  ports.bossCell = [7, 5];
  const lines: string[] = [];
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5"), station("boss", "10:7,5", { why: "首领 风之水晶" })], {
      bosses: [
        {
          name: "风之水晶",
          map: 10,
          healFirst: false,
          saveFirst: false,
          tables: [{}],
        },
      ],
    }),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "done");
  assert.ok(lines.includes("段「风之神殿」开始:2 站;目标:打完这一节"));
  assert.ok(lines.some((line) => line.startsWith("第 1/2 站 移动 10:6,5 开始")));
  assert.ok(lines.includes("第 1/2 站 到达 地图 10 (6,5)"));
  assert.ok(lines.some((line) => line.startsWith("第 2/2 站 首领 10:7,5 开始")));
  assert.ok(lines.includes("第 2/2 站 首领战开始:风之水晶(首领表 1/1)"));
  assert.ok(lines.some((line) => line.startsWith("第 2/2 站 首领战结束:赢了")));
  assert.ok(lines.some((line) => line.startsWith("段「风之神殿」结束:完成")));
});

void test("a long exception detail stays whole in the log and is shortened in the report", async () => {
  const ports = new FakePorts();
  ports.positionAt = { map: 10, cell: [9, 10] };
  ports.bossCell = [9, 9];
  const summary = "出招后全员倒下。".repeat(80);
  ports.boss = { won: false, text: "全灭", summary };
  const lines: string[] = [];
  const report = await executeSegmentPlan(
    plan([station("boss", "10:9,9", { why: "首领 巨翼猛禽" })], {
      bosses: [
        {
          name: "巨翼猛禽",
          map: 10,
          healFirst: false,
          saveFirst: false,
          tables: [{}],
        },
      ],
    }),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "exception");
  assert.ok(report.exception);
  assert.match(report.exception.detail, /完整见日志/u);
  assert.ok(Array.from(report.exception.detail).length <= 520);
  assert.ok(
    lines.some((line) => line.startsWith("例外全文(boss-lost):") && line.includes(summary)),
  );
});

void test("turn-back expressions share one syntax", () => {
  const state = turnBackStateOf(
    observation({
      members: [member("巴兹", 20, 100, 5, 20), member("蕾娜", 0, 80, 0, 20)],
      items: { 不死鸟之尾: 0, 恢复药: 2 },
    }),
  );
  assert.equal(evaluateTurnBack("party.lowest_hp_pct < 30", state), true);
  assert.equal(evaluateTurnBack("party.dead >= 1", state), true);
  assert.equal(evaluateTurnBack("party.mp_pct < 20", state), true);
  assert.equal(evaluateTurnBack("item.不死鸟之尾 < 1", state), true);
  assert.equal(evaluateTurnBack("item.恢复药 < 3", state), true);
  assert.equal(evaluateTurnBack("enemy.hp < 3", state), null);
});

void test("a station on an exit cell is done once the party reaches the map it leads to", async () => {
  const ports = new FakePorts();
  ports.positionAt = { map: 1, cell: [170, 87] };
  ports.exits.set("1:170,88", { toMap: 210, name: "托纳运河" });
  const lines: string[] = [];
  const report = await executeSegmentPlan(plan([station("move", "1:170,88")]), ports, {
    log: (line) => lines.push(line),
  });
  assert.equal(report.status, "done");
  assert.equal(report.done.stations, 1);
  assert.deepEqual(report.remaining, []);
  assert.ok(lines.some((line) => line.includes("走进入口到了地图 210「托纳运河」")));
  assert.ok(
    ports.calls.includes("progress:0:done:第 1/1 站 完成:走进入口到了地图 210「托纳运河」"),
  );
});

void test("a battle at the station boundary is fought with the boss table before completion", async () => {
  const ports = new FakePorts();
  ports.battleOnArrive = { boss: true, enemies: ["龙虾"] };
  const boss: PlanBoss = {
    name: "龙虾",
    map: 10,
    healFirst: false,
    saveFirst: false,
    tables: [{ 巴兹: ["攻击"] }],
  };
  const report = await executeSegmentPlan(
    plan([station("move", "10:6,5")], { bosses: [boss] }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(ports.fought, ["龙虾"]);
  assert.equal(ports.normalFights, 0);
  assert.deepEqual(report.done.bossesWon, ["龙虾"]);
  const fightAt = ports.calls.indexOf("boss:龙虾");
  assert.ok(fightAt >= 0);
  assert.ok(fightAt < ports.calls.indexOf("progress:0:done:第 1/1 站 完成:测试"));
});

void test("a boss the plan did not name is fought with the normal table and noted", async () => {
  const ports = new FakePorts();
  ports.battleOnArrive = { boss: true, enemies: ["龙虾"] };
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports);
  assert.equal(report.status, "done");
  assert.equal(ports.normalFights, 1);
  assert.deepEqual(report.done.bossesWon, ["龙虾"]);
  assert.match(report.party, /计划里没有这个首领，用普通表打的/u);
});

void test("a battle already running when the plan starts is fought before station 1", async () => {
  const ports = new FakePorts();
  ports.sceneValue = {
    state: "Battle",
    dialog: false,
    battle: true,
    boss: false,
    enemies: ["哥布林"],
  };
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports);
  assert.equal(report.status, "done");
  assert.equal(ports.normalFights, 1);
  const fightAt = ports.calls.indexOf("fightNormal");
  const goAt = ports.calls.indexOf("go:plan-0");
  assert.ok(fightAt >= 0 && goAt >= 0 && fightAt < goAt);
});

void test("what a plan left behind on a map reaches the report", async () => {
  const ports = new FakePorts();
  ports.leave = ["离开「托纳运河」时还缺:本图鉴还缺 2 种：龙虾、墨鱼"];
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports);
  assert.equal(report.status, "done");
  assert.match(report.party, /离开「托纳运河」时还缺/u);
});

void test("a dialog met while walking is paged before the station continues", async () => {
  const ports = new FakePorts();
  ports.dialogOnArrive = true;
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports);
  assert.equal(report.status, "done");
  const storyAt = ports.calls.indexOf("story");
  const secondGoAt = ports.calls.lastIndexOf("go:plan-0");
  assert.ok(storyAt >= 0 && secondGoAt > storyAt);
});

void test("an unknown target map is unreachable before a route is attempted", async () => {
  const ports = new FakePorts();
  ports.unknownMaps.add(198);
  const report = await executeSegmentPlan(plan([station("move", "198:15,23")]), ports);
  assert.ok(report.exception);
  assert.equal(report.status, "exception");
  assert.equal(report.exception.kind, "unreachable");
  assert.match(report.exception.detail, /地图记录里没有路/u);
});

void test("model calls made while the plan runs are counted in the report", async () => {
  const ports = new FakePorts();
  ports.modelCallCount = 2;
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports);
  assert.equal(report.modelCalls, 2);
});

void test("an action station that could not act is an exception, never a completed station", async () => {
  const ports = new FakePorts();
  ports.interact = async () => ({
    ok: false,
    done: false,
    text: "(47,48) 四周两格内都走不到",
  });
  const report = await executeSegmentPlan(plan([station("open", "211:47,48")]), ports);
  assert.equal(report.status, "exception");
  assert.notEqual(report.exception, undefined);
  assert.equal(report.done.stations, 0);
  assert.deepEqual(report.remaining, [0]);
});

void test("a thrown plain object becomes Chinese text, not [object Object]", async () => {
  const ports = new FakePorts();
  ports.begin = async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- dsh can throw a plain object
    throw { message: "桥插件断线" };
  };
  const lines: string[] = [];
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports, {
    log: (line) => lines.push(line),
  });
  assert.equal(report.status, "exception");
  assert.match(report.exception?.detail ?? "", /执行器出错:桥插件断线/u);
  assert.ok(lines.some((line) => line.includes("执行器出错:桥插件断线")));
  assert.ok(lines.every((line) => !line.includes("[object Object]")));
});

void test("an aborted execution says the web restart/cancel, not an executor error", async () => {
  const ports = new FakePorts();
  ports.begin = async () => {
    throw new DOMException("aborted", "AbortError");
  };
  const lines: string[] = [];
  const report = await executeSegmentPlan(plan([station("move", "10:6,5")]), ports, {
    log: (line) => lines.push(line),
  });
  assert.equal(report.status, "aborted");
  assert.ok(lines.includes("执行被打断(网页重启或取消)"));
});

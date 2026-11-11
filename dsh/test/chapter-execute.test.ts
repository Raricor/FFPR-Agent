/**
 * Task 152: the chapter executor is tested with doubles only. The fake ports simulate the
 * segment executor's route, shops, boss fights, growth and inn walks; no bridge or model runs.
 */

/* eslint-disable @typescript-eslint/require-await -- the fake ports mirror async engine methods */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Cell } from "../src/engine/nav.ts";
import type { RoutePlan, Waypoint } from "../src/engine/route/types.ts";
import type { RoutePorts } from "../src/engine/route/execute.ts";
import type {
  ChapterFactsData,
  ChapterPlan,
  ChapterProgress,
  ChapterReport,
} from "../src/engine/plan/chapter-types.ts";
import {
  chapterResumeFrom,
  describeChapterResume,
  executeChapterPlan,
} from "../src/engine/plan/chapter-execute.ts";
import type {
  ExecutePorts,
  PlanActionResult,
  PlanBossResult,
  PlanBuyResult,
  PlanObservation,
  PlanProgressStatus,
  PlanRestorePoint,
  PlanScene,
  PlanShop,
  PlanStationResult,
} from "../src/engine/plan/execute.ts";
import type { PlanBattle, PlanBoss, PlanStation, SegmentPlan } from "../src/engine/plan/types.ts";
import { readRunEvents, RunLogger } from "../src/engine/run-log.ts";
import { testBoss, testSegmentFacts } from "./chapter-fixture.ts";

function member(lv = 10, hp = 100, maxHp = 100) {
  return {
    name: "巴兹",
    job: "战士",
    lv,
    hp,
    maxHp,
    mp: 20,
    maxMp: 20,
    status: [],
    abilities: [],
  };
}

function observation(overrides: Partial<PlanObservation> = {}): PlanObservation {
  return {
    map: 1,
    cell: [1, 1],
    members: [member()],
    items: {},
    gil: 100,
    bestiary: [],
    blueMagic: [],
    chestsOpened: 0,
    battles: 0,
    ...overrides,
  };
}

function station(doIt: PlanStation["do"], to: string, extra: Partial<PlanStation> = {}) {
  return { to, do: doIt, why: "测试", ...extra };
}

function segment(name: string, stations: readonly PlanStation[], extra: Partial<SegmentPlan> = {}) {
  return {
    version: 1 as const,
    section: name,
    goal: `${name}的目标`,
    prep: { jobs: [], equip: "keep" as const, buy: [], rows: [] },
    stations,
    battle: [],
    bosses: [],
    turnBack: [],
    ...extra,
  };
}

function chapter(segments: readonly SegmentPlan[], extra: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    version: 1,
    chapter: 2,
    goal: "跑完第二章",
    segments,
    growth: [],
    fallback: {
      retries: 1,
      bossLost: { levels: 2, where: null, tries: 2 },
      skipOptional: true,
      healBelowPct: 30,
    },
    ...extra,
  };
}

function shop(map: number, cell: Cell, products: readonly string[]): PlanShop {
  return {
    id: 1,
    map,
    cell,
    area: "测试镇",
    kind: "道具店",
    products: products.map((name) => ({ name, names: [name], price: 10 })),
  };
}

class FakeChapterPorts implements ExecutePorts {
  readonly calls: string[] = [];
  positionAt = { map: 1, cell: [1, 1] as Cell };
  current = observation();
  readonly failRoute: Map<string, number> = new Map<string, number>();
  readonly brokenRoutes = new Set<string>();
  readonly shopsList: PlanShop[] = [];
  shopOpen = false;
  readonly buyQueue: PlanBuyResult[] = [];
  buyDefault: PlanBuyResult = {
    ok: true,
    atShop: true,
    bought: 1,
    text: "买了",
  };
  readonly healQueue: PlanActionResult[] = [];
  healDefault: PlanActionResult = { ok: true, text: "补满了" };
  readonly bossResults: PlanBossResult[] = [];
  bossDefault: PlanBossResult = {
    won: true,
    text: "打赢",
    summary: "首领倒下",
  };
  gameoverOk = true;
  readonly restoreList: PlanRestorePoint[] = [];
  readonly routeMinutes = new Map<number, number>();
  readonly unknownMaps = new Set<number>();
  routeUnreachableReason = "地图记录里没有路";
  readonly battleOnGo = new Map<
    string,
    { readonly boss: boolean; readonly enemies: readonly string[] }
  >();
  readonly grindHook: ((stop: Waypoint) => void)[] = [];
  readonly grindQueue: PlanStationResult[] = [];
  grindDefault: PlanStationResult = { ok: true, done: true, text: "刷完了" };
  readonly routedCells: Cell[] = [];
  readonly pointObjects = new Set<string>();
  bossTriggerCells: readonly Cell[] = [];
  weakStoryCell: Cell | null = null;
  fatalText: string | null = null;
  sceneValue: PlanScene = {
    state: "Player",
    dialog: false,
    battle: false,
    boss: false,
    enemies: [],
  };
  private fightCount = 0;

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
  async changeJob(name: string, job: string): Promise<PlanActionResult> {
    this.calls.push(`job:${name}:${job}`);
    return { ok: true, text: "换了" };
  }
  async optimizeEquipment(): Promise<PlanActionResult> {
    this.calls.push("optimize");
    return { ok: true, text: "最强装备" };
  }
  async shops(): Promise<readonly PlanShop[]> {
    this.calls.push("shops");
    return this.shopsList;
  }
  async openShop(cell: Cell): Promise<PlanActionResult> {
    this.calls.push(`openShop:${cell[0]},${cell[1]}`);
    this.shopOpen = true;
    return { ok: true, text: "商店开了" };
  }
  async leaveShop(): Promise<PlanActionResult> {
    this.calls.push("leaveShop");
    this.shopOpen = false;
    return { ok: true, text: "回到地图" };
  }
  async buy(item: string, count: number): Promise<PlanBuyResult> {
    this.calls.push(`buy:${item}:${count}`);
    return this.buyQueue.shift() ?? this.buyDefault;
  }
  async setRow(name: string, row: "front" | "back"): Promise<PlanActionResult> {
    this.calls.push(`row:${name}:${row}`);
    return { ok: true, text: "站好" };
  }

  routePorts(): RoutePorts {
    return {
      position: async () => this.positionAt,
      goTo: async (stop) => {
        this.calls.push(`go:${stop.id}`);
        this.positionAt = { map: stop.map, cell: stop.cell ?? [1, 1] };
        if (stop.cell !== null) this.routedCells.push([stop.cell[0], stop.cell[1]]);
        const battle = this.battleOnGo.get(stop.id);
        if (battle !== undefined) {
          this.sceneValue = {
            state: "Battle",
            dialog: false,
            battle: true,
            boss: battle.boss,
            enemies: [...battle.enemies],
          };
        }
        return { ok: true, text: "走到了" };
      },
      act: async () => ({ ok: true, done: true, text: "做了" }),
      replan: async (from, rest) => this.planRoute(from, rest),
      story: async () => ({ text: "翻了一页" }),
      watch: async () => ({ timer: null, gameover: null }),
    };
  }
  async planRoute(
    from: { map: number; cell: Cell },
    waypoints: readonly Waypoint[],
  ): Promise<RoutePlan> {
    const unreachable = waypoints.flatMap((waypoint) => {
      const left = this.failRoute.get(waypoint.id) ?? 0;
      if (left > 0) this.failRoute.set(waypoint.id, left - 1);
      if (left > 0 || this.brokenRoutes.has(waypoint.id)) {
        return [
          {
            id: waypoint.id,
            kind: waypoint.kind,
            map: waypoint.map,
            cell: waypoint.cell,
            label: waypoint.label,
            reason: this.routeUnreachableReason,
          },
        ];
      }
      return [];
    });
    const reachable = waypoints.filter(
      (waypoint) => !unreachable.some((entry) => entry.id === waypoint.id),
    );
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
      maps: [from.map, waypoint.map],
      hops: 0,
      cells: 1,
      minutes: 0,
    }));
    const minutes = reachable.reduce(
      (sum, waypoint) => sum + (this.routeMinutes.get(waypoint.map) ?? 0),
      0,
    );
    return {
      legs,
      unreachable,
      warnings: [],
      total: { cells: legs.length, hops: 0, minutes },
    };
  }
  async interact(cell: Cell): Promise<PlanStationResult> {
    this.calls.push(`interact:${cell[0]},${cell[1]}`);
    if (this.fatalText !== null) {
      return { ok: false, done: false, fatal: true, text: this.fatalText };
    }
    return { ok: true, done: true, text: "打开了" };
  }
  async bossTarget(): Promise<"trigger" | "object"> {
    return "trigger";
  }
  async battleActive(): Promise<boolean> {
    return true;
  }
  async scene(): Promise<PlanScene> {
    return this.sceneValue;
  }
  async restorePoints(): Promise<readonly PlanRestorePoint[]> {
    return this.restoreList;
  }
  async pointAt(map: number, cell: Cell): Promise<"restore" | "save" | null> {
    return this.pointObjects.has(`${map}:${cell[0]},${cell[1]}`) ? "restore" : null;
  }
  async restAt(point: PlanRestorePoint): Promise<PlanActionResult> {
    this.calls.push(`restAt:${point.name}`);
    this.current = observation({
      ...this.current,
      members: this.current.members.map((entry) => ({
        ...entry,
        hp: entry.maxHp,
        status: [],
      })),
    });
    return { ok: true, text: `在「${point.name}」住了一晚` };
  }
  async exitTarget(): Promise<null> {
    return null;
  }
  async mapKnown(map: number): Promise<boolean> {
    return !this.unknownMaps.has(map);
  }
  async bossAliases(): Promise<readonly string[]> {
    return [];
  }
  async bossTriggerCandidates(): Promise<readonly Cell[]> {
    this.calls.push("bossTriggers");
    return this.bossTriggerCells;
  }
  async storyTrigger(map: number) {
    const cell = this.weakStoryCell;
    if (cell === null) return { cell: null, name: "", count: 0 };
    return {
      cell,
      name: "sc_e_0004:weak",
      count: 1,
      candidates: [
        { cell, name: "sc_e_0004:weak", script: 4, kind: "event" as const, matched: true },
      ],
    };
  }
  async story(): Promise<{ text: string }> {
    this.calls.push("story");
    return { text: "翻了一页" };
  }
  async choose(option: number | string): Promise<PlanActionResult> {
    this.calls.push(`choose:${String(option)}`);
    return { ok: true, text: "选了" };
  }
  async save(): Promise<PlanActionResult> {
    this.calls.push("save");
    return { ok: true, text: "存了" };
  }
  async heal(belowPct = 30): Promise<PlanActionResult> {
    this.calls.push(`heal:${belowPct}`);
    const result = this.healQueue.shift() ?? this.healDefault;
    if (result.ok) {
      this.current = observation({
        ...this.current,
        members: this.current.members.map((entry) => ({
          ...entry,
          hp: entry.maxHp,
          status: [],
        })),
      });
    }
    return result;
  }
  async grind(stop: Waypoint): Promise<PlanStationResult> {
    this.calls.push(`grind:${stop.id}`);
    for (const hook of this.grindHook) hook(stop);
    return this.grindQueue.shift() ?? this.grindDefault;
  }
  async beginBattles(battles: readonly PlanBattle[]): Promise<void> {
    this.calls.push(`beginBattles:${battles.length}`);
  }
  async endBattles(): Promise<void> {
    this.calls.push("endBattles");
  }
  async fightBoss(boss: PlanBoss): Promise<PlanBossResult> {
    this.calls.push(`boss:${boss.name}`);
    this.fightCount += 1;
    const result = this.bossResults.shift() ?? this.bossDefault;
    if (result.won) {
      this.sceneValue = {
        ...this.sceneValue,
        battle: false,
        boss: false,
        enemies: [],
      };
    }
    return result;
  }
  async fightNormal(): Promise<PlanBossResult> {
    this.calls.push("fightNormal");
    this.sceneValue = {
      ...this.sceneValue,
      battle: false,
      boss: false,
      enemies: [],
    };
    return { won: true, text: "普通战斗打赢", summary: "普通战斗打赢" };
  }
  async recoverGameover(): Promise<PlanActionResult> {
    this.calls.push("recoverGameover");
    return {
      ok: this.gameoverOk,
      text: this.gameoverOk ? "读了 20 号位" : "没有弹窗",
    };
  }
  battleCount(): number {
    return this.current.battles;
  }
  modelCalls(): number {
    return 0;
  }
  async startProgress(): Promise<void> {
    this.calls.push("progress:start");
  }
  async markProgress(index: number, status: PlanProgressStatus): Promise<void> {
    this.calls.push(`progress:${index}:${status}`);
  }
  async finishProgress(): Promise<void> {
    this.calls.push("progress:finish");
  }
  get fights(): number {
    return this.fightCount;
  }
}

void test("two segments run in order and the chapter reports done", async () => {
  const ports = new FakeChapterPorts();
  const report = await executeChapterPlan(
    chapter([
      segment("第一节", [station("move", "1:2,2")]),
      segment("第二节", [station("move", "1:3,3")]),
    ]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(
    report.segments.map((entry) => entry.section),
    ["第一节", "第二节"],
  );
  assert.deepEqual(
    ports.calls.filter((call) => call.startsWith("go:")),
    ["go:plan-0", "go:plan-0"],
  );
});

void test("growth runs before its segment and stops on level or gil", async () => {
  const ports = new FakeChapterPorts();
  ports.grindHook.push((stop) => {
    if (stop.until?.level !== undefined) {
      ports.current = observation({
        ...ports.current,
        gil: stop.until.gil ?? ports.current.gil,
        members: [member(stop.until.level)],
      });
    }
  });
  const report = await executeChapterPlan(
    chapter(
      [
        segment("第一节", [station("move", "1:2,2")]),
        segment("第二节", [station("move", "1:3,3")]),
      ],
      {
        growth: [
          {
            before: 1,
            level: 15,
            gil: 500,
            where: "1",
            why: "练级",
            maxMinutes: 10,
          },
        ],
      },
    ),
    ports,
  );
  assert.equal(report.status, "done");
  const grindAt = ports.calls.indexOf("grind:chapter-growth-1");
  const secondGo = ports.calls.lastIndexOf("go:plan-0");
  assert.ok(grindAt >= 0 && grindAt < secondGo);
});

void test("growth blocked by the opening ride is deferred and retried after the next segment", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ members: [member(1, 100, 100)] });
  ports.grindQueue.push({
    ok: false,
    done: false,
    text: "刷了 0 场…停：骑着陆行鸟，按取消也没下来",
  });
  let grinds = 0;
  ports.grindHook.push(() => {
    grinds += 1;
    if (grinds === 2) ports.current = observation({ members: [member(5, 100, 100)] });
  });
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter(
      [
        segment("第一节", [station("move", "1:2,2")]),
        segment("第二节", [station("move", "1:3,3")]),
      ],
      { growth: [{ before: 0, level: 3, where: "1", why: "开场练级", maxMinutes: 5 }] },
    ),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "done");
  assert.ok(report.fallbacks.some((line) => line.includes("往后挪到下一段")));
  assert.ok(lines.some((line) => line.includes("后面能刷了")));
  assert.equal(
    ports.calls.filter((call) => call.startsWith("grind:chapter-growth")).length,
    2,
    JSON.stringify(ports.calls),
  );
});

void test("a resumed run at segment zero still tries growth before that segment", async () => {
  const ports = new FakeChapterPorts();
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])], {
      growth: [{ before: 0, level: 3, where: "1", why: "开场练级", maxMinutes: 5 }],
    }),
    ports,
    { startAt: 0, skipStations: {} },
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("grind:chapter-growth-1"));
});

void test("growth that still cannot run at chapter end is skipped, not blocked", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ members: [member(1, 100, 100)] });
  ports.grindQueue.push({
    ok: false,
    done: false,
    text: "刷了 0 场…停：骑着陆行鸟，按取消也没下来",
  });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])], {
      growth: [{ before: 0, level: 3, where: "1", why: "开场练级", maxMinutes: 5 }],
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.equal(report.exception, undefined);
  assert.ok(report.fallbacks.some((line) => line.includes("到章末还没刷成，跳过")));
});

void test("growth that does not reach the target is deferred and skipped at chapter end", async () => {
  const ports = new FakeChapterPorts();
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])], {
      growth: [{ before: 0, level: 15, where: "1", why: "练级", maxMinutes: 1 }],
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(report.fallbacks.some((line) => line.includes("成长目标没达到")));
  assert.ok(report.fallbacks.some((line) => line.includes("到章末还没刷成，跳过")));
  assert.ok(ports.calls.some((call) => call === "go:plan-0"));
});

void test("a failed station is retried on a fresh route and then completes", async () => {
  const ports = new FakeChapterPorts();
  ports.failRoute.set("plan-0", 1);
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(report.fallbacks.some((line) => line.includes("换新路线重试")));
  assert.equal(ports.calls.filter((call) => call === "go:plan-0").length, 1);
  const first = report.segments[0];
  assert.ok(first !== undefined);
  assert.deepEqual(first.remaining, []);
  assert.equal(first.done.stations, 1);
});

void test("an optional chest whose cell is unreachable is skipped and recorded", async () => {
  const ports = new FakeChapterPorts();
  ports.brokenRoutes.add("plan-0");
  ports.routeUnreachableReason = "地图 1 里从 (1,1) 走不到 (2,2)（同图另一块，经别的图也绕不过去）";
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("open", "1:2,2")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(report.fallbacks.some((line) => line.includes("按兜底跳过")));
  assert.ok(ports.calls.some((call) => call === "progress:0:skipped"));
});

void test("a lost boss is ground up, healed and fought again", async () => {
  const ports = new FakeChapterPorts();
  const boss: PlanBoss = {
    name: "首领",
    map: 1,
    healFirst: false,
    saveFirst: false,
    tables: [{ 巴兹: ["攻击"] }],
  };
  ports.bossResults.push(
    { won: false, text: "输了", summary: "队伍全灭" },
    { won: true, text: "赢了", summary: "首领倒下" },
  );
  ports.grindHook.push((stop) => {
    if (stop.until?.level === undefined) return;
    ports.current = observation({
      ...ports.current,
      members: [member(stop.until.level)],
    });
  });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("boss", "1:3,3")], { bosses: [boss] })]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.equal(ports.fights, 2);
  assert.ok(report.fallbacks.some((line) => line.includes("首领没打赢")));
  assert.ok(ports.calls.includes("grind:chapter-boss-grind"));
  assert.ok(ports.calls.includes("boss:首领"));
});

void test("low HP walks back to the inn, heals and returns to the station", async () => {
  const ports = new FakeChapterPorts();
  ports.restoreList.push({ map: 1, cell: [9, 9], name: "测试旅店" });
  ports.healQueue.push({ ok: false, text: "野外没有回复手段" }, { ok: true, text: "睡了一觉" });
  let afterFirst = false;
  const originalInteract = ports.interact.bind(ports);
  ports.interact = async (cell: Cell): Promise<PlanStationResult> => {
    const result = await originalInteract(cell);
    if (!afterFirst) {
      afterFirst = true;
      ports.current = observation({
        ...ports.current,
        members: [member(10, 5, 100)],
      });
    }
    return result;
  };
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("open", "1:2,2"), station("open", "1:3,3")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("go:chapter-restore-1-9-9"));
  assert.ok(ports.calls.includes("go:chapter-restore-back"));
  assert.ok(ports.calls.includes("restAt:测试旅店"));
  assert.ok(report.fallbacks.some((line) => line.includes("测试旅店")));
});

void test("when every fallback fails the chapter returns an exception with what was tried", async () => {
  const ports = new FakeChapterPorts();
  ports.failRoute.set("plan-0", 99);
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])], {
      fallback: {
        retries: 1,
        bossLost: { levels: 1, where: null, tries: 1 },
        skipOptional: false,
        healBelowPct: 30,
      },
    }),
    ports,
  );
  assert.equal(report.status, "exception");
  assert.ok(report.fallbacks.some((line) => line.includes("换新路线重试")));
  assert.ok(report.fallbacks.some((line) => line.includes("地图记录里没有路")));
  const exception = report.exception;
  assert.ok(exception);
  assert.equal(exception.kind, "unreachable");
  assert.equal(exception.segment, 0);
  assert.equal(exception.station, 0);
  assert.match(exception.detail, /兜底记录/u);
});

void test("a resumed chapter skips completed segments and finished stations", async () => {
  const ports = new FakeChapterPorts();
  const plan = chapter([
    segment("第一节", [station("move", "1:2,2")]),
    segment("第二节", [
      station("move", "1:2,2"),
      station("move", "1:3,3"),
      station("move", "1:4,4"),
    ]),
  ]);
  const progress: ChapterProgress = {
    game: "ff5",
    chapter: 2,
    goal: "跑完第二章",
    revision: 2,
    startedAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:01:00.000Z",
    finishedAt: null,
    status: "running",
    segment: 1,
    segments: [
      {
        section: "第一节",
        stations: [{ index: 0, status: "done", note: "做完了" }],
      },
      {
        section: "第二节",
        stations: [
          { index: 0, status: "pending", note: "" },
          { index: 1, status: "skipped", note: "到不了" },
          { index: 2, status: "pending", note: "" },
        ],
      },
    ],
    fallbacks: ["第一次运行跳过一站"],
    previousException: { kind: "unreachable", detail: "第 2 节第 2 站到不了" },
  };
  const resume = chapterResumeFrom(plan, progress);
  assert.deepEqual(resume, {
    startAt: 1,
    skipStations: { 1: { startAt: 0, skip: [1], done: { 1: 1 } } },
  });
  assert.ok(resume);
  const report = await executeChapterPlan(plan, ports, resume);
  assert.equal(report.status, "done");
  assert.deepEqual(
    ports.calls.filter((call) => call.startsWith("go:")),
    ["go:plan-0", "go:plan-2"],
  );
  assert.ok(ports.calls.includes("progress:1:skipped"));
  assert.deepEqual(
    report.segments.map((entry) => entry.section),
    ["第二节"],
  );
});

void test("a buy station buys in order and records what the gil could not cover", async () => {
  const ports = new FakeChapterPorts();
  ports.shopsList.push(shop(1, [3, 3], ["恢复药", "以太"]));
  ports.buyQueue.push(
    { ok: true, atShop: true, bought: 1, text: "买了恢复药" },
    {
      ok: false,
      atShop: true,
      bought: 0,
      text: "钱不够:以太×1 要 100,只有 10",
    },
  );
  const report = await executeChapterPlan(
    chapter([
      segment("第一节", [
        station("buy", "1:3,3", {
          items: [
            { item: "恢复药", count: 1 },
            { item: "以太", count: 1 },
          ],
        }),
      ]),
    ]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(
    ports.calls.filter((call) => /^(openShop|buy:|leaveShop|optimize)/u.test(call)),
    ["openShop:3,3", "buy:恢复药:1", "buy:以太:1", "leaveShop", "optimize"],
  );
  assert.ok(ports.calls.some((call) => call.includes("progress:0:done")));
});

interface OldStation {
  readonly index: number;
  readonly status: ChapterProgress["segments"][number]["stations"][number]["status"];
  readonly note: string;
  readonly to: string;
  readonly do: PlanStation["do"];
}

function progressWith(stations: readonly OldStation[], goal: string): ChapterProgress {
  return {
    game: "ff5",
    chapter: 2,
    goal,
    revision: 1,
    startedAt: "2026-11-11T07:58:23.000Z",
    updatedAt: "2026-11-11T07:58:53.000Z",
    finishedAt: null,
    status: "exception",
    segment: 0,
    segments: [{ section: "Prologue", stations }],
    fallbacks: [],
    previousException: null,
  } as unknown as ChapterProgress;
}

function oldDone(
  index: number,
  to: string,
  doIt: PlanStation["do"],
  note = `旧站 ${index + 1} 完成`,
): OldStation {
  return { index, status: "done", note, to, do: doIt };
}

function oldPending(index: number, to: string, doIt: PlanStation["do"]): OldStation {
  return { index, status: "pending", note: "", to, do: doIt };
}

void test("old 11 stations with the first 3 done resume a new 14-station section at station 4", async () => {
  const old: OldStation[] = [
    oldDone(0, "1:175,143", "move"),
    oldDone(1, "1:175,142", "move"),
    oldDone(2, "189:52,32", "open"),
    {
      index: 3,
      status: "failed",
      note: "对话没写成坐标",
      to: "189",
      do: "talk",
    },
    ...Array.from({ length: 7 }, (_value, index) =>
      oldPending(index + 4, `189:${index + 1},${index + 2}`, "move"),
    ),
  ];
  const stationValues = [
    station("move", "1:175,143"),
    station("move", "1:175,142"),
    station("open", "189:52,32"),
    station("talk", "189:1,1"),
    ...Array.from({ length: 10 }, (_value, index) =>
      station("move", `189:${index + 2},${index + 3}`),
    ),
  ];
  assert.equal(stationValues.length, 14);
  const plan = chapter([segment("Prologue", stationValues)]);
  const progress = progressWith(old, plan.goal);
  const resume = chapterResumeFrom(plan, progress);
  assert.equal(resume?.startAt, 0);
  const segmentResume = resume.skipStations[0];
  assert.ok(segmentResume);
  assert.deepEqual(segmentResume, {
    startAt: 3,
    skip: [],
    done: { 0: 0, 1: 1, 2: 2 },
  });
  assert.match(describeChapterResume(plan, resume), /第 4 站开始/u);
  assert.match(describeChapterResume(plan, resume), /旧 1–3/u);

  const ports = new FakeChapterPorts();
  ports.brokenRoutes.add("plan-13");
  const dir = await mkdtemp(join(tmpdir(), "chapter-match-"));
  const progressPath = join(dir, "chapter-progress-ff5.json");
  try {
    const report = await executeChapterPlan(plan, ports, {
      priorProgress: progress,
      ...resume,
      progressPath,
    });
    assert.equal(report.status, "exception");
    assert.deepEqual(
      ports.calls.filter((call) => call.startsWith("go:")),
      Array.from({ length: 10 }, (_value, index) => `go:plan-${index + 3}`),
    );
    const saved = JSON.parse(await readFile(progressPath, "utf8")) as ChapterProgress;
    const firstSegment = saved.segments[0];
    assert.ok(firstSegment);
    assert.deepEqual(
      firstSegment.stations.slice(0, 3).map((entry) => entry.status),
      ["done", "done", "done"],
    );
    assert.deepEqual(
      firstSegment.stations.slice(0, 3).map((entry) => entry.note),
      ["旧站 1 完成", "旧站 2 完成", "旧站 3 完成"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("an inserted station runs, and later old done stations still match in order", () => {
  const old: OldStation[] = [
    oldDone(0, "1:1,1", "move"),
    oldDone(1, "1:2,2", "move"),
    oldDone(2, "1:3,3", "move"),
    oldDone(3, "1:4,4", "move"),
    ...Array.from({ length: 7 }, (_value, index) =>
      oldPending(index + 4, `1:${index + 5},${index + 5}`, "move"),
    ),
  ];
  const plan = chapter([
    segment("Prologue", [
      station("move", "1:1,1"),
      station("move", "1:2,2"),
      station("move", "1:3,3"),
      station("talk", "189:9,9"),
      station("move", "1:4,4"),
      ...Array.from({ length: 9 }, (_value, index) =>
        station("move", `1:${index + 5},${index + 5}`),
      ),
    ]),
  ]);
  const resume = chapterResumeFrom(plan, progressWith(old, plan.goal));
  const segmentResume = resume?.skipStations[0];
  assert.ok(segmentResume);
  assert.equal(segmentResume.startAt, 3);
  assert.deepEqual(segmentResume.done, { 0: 0, 1: 1, 2: 2, 4: 3 });
});

void test("deleted stations do not break later order matching", () => {
  const old: OldStation[] = [
    oldDone(0, "1:1,1", "move"),
    oldDone(1, "1:2,2", "move"),
    oldDone(2, "1:3,3", "move"),
    oldDone(3, "1:4,4", "move"),
    ...Array.from({ length: 7 }, (_value, index) =>
      oldPending(index + 4, `1:${index + 5},${index + 5}`, "move"),
    ),
  ];
  const plan = chapter([
    segment("Prologue", [
      station("move", "1:1,1"),
      station("move", "1:2,2"),
      station("move", "1:4,4"),
      ...Array.from({ length: 10 }, (_value, index) =>
        station("move", `1:${index + 5},${index + 5}`),
      ),
    ]),
  ]);
  const resume = chapterResumeFrom(plan, progressWith(old, plan.goal));
  const segmentResume = resume?.skipStations[0];
  assert.ok(segmentResume);
  assert.equal(segmentResume.startAt, 3);
  assert.deepEqual(segmentResume.done, { 0: 0, 1: 1, 2: 3 });
});

void test("the same old to+do is paired only once", () => {
  const old: OldStation[] = [
    oldDone(0, "1:175,143", "move"),
    oldDone(1, "1:175,143", "move"),
    ...Array.from({ length: 9 }, (_value, index) =>
      oldPending(index + 2, `1:${index + 2},${index + 2}`, "move"),
    ),
  ];
  const plan = chapter([
    segment("Prologue", [
      station("move", "1:175,143"),
      station("move", "1:175,143"),
      station("move", "1:175,143"),
      ...Array.from({ length: 11 }, (_value, index) =>
        station("move", `1:${index + 2},${index + 2}`),
      ),
    ]),
  ]);
  const resume = chapterResumeFrom(plan, progressWith(old, plan.goal));
  const segmentResume = resume?.skipStations[0];
  assert.ok(segmentResume);
  assert.equal(segmentResume.startAt, 2);
  assert.deepEqual(segmentResume.done, { 0: 0, 1: 1 });
});

function fourteenStationPlan(): ChapterPlan {
  const stations = (prefix: string, count: number) =>
    Array.from({ length: count }, (_value, index) =>
      station("move", `1:${index + 1},1`, { why: `${prefix} ${index + 1}` }),
    );
  return chapter([
    segment("Prologue", stations("序章", 14)),
    segment("Tule", stations("图尔", 21)),
    segment("Wind Shrine", stations("风之神殿", 13)),
  ]);
}

void test("the old blanket-done note never resumes past unrun segments", () => {
  const plan = fourteenStationPlan();
  const done = (section: string, count: number) => ({
    section,
    stations: Array.from({ length: count }, (_value, index) => ({
      index,
      status: "done" as const,
      note: "之前的运行已完成",
    })),
  });
  const progress: ChapterProgress = {
    game: "ff5",
    chapter: 2,
    goal: plan.goal,
    revision: 4,
    startedAt: "2026-11-11T07:43:00.000Z",
    updatedAt: "2026-11-11T07:43:43.000Z",
    finishedAt: null,
    status: "exception",
    segment: 2,
    segments: [done("Prologue", 14), done("Tule", 21), done("Wind Shrine", 13)],
    fallbacks: [],
    previousException: null,
  };
  assert.deepEqual(chapterResumeFrom(plan, progress), {
    startAt: 0,
    skipStations: {},
  });
});

void test("a 4-done + 1-failed resume starts at Prologue station 5, not Wind Shrine", async () => {
  const plan = fourteenStationPlan();
  const withKeys = (
    index: number,
    status: ChapterProgress["segments"][number]["stations"][number]["status"],
    note: string,
  ) => ({ index, status, note, to: `1:${index + 1},1`, do: "move" });
  const stations = [
    ...Array.from({ length: 4 }, (_value, index) => withKeys(index, "done", "做完了")),
    withKeys(4, "failed", "第 5 站卡住"),
    ...Array.from({ length: 9 }, (_value, index) => withKeys(index + 5, "pending", "")),
  ];
  const progress = {
    game: "ff5",
    chapter: 2,
    goal: plan.goal,
    revision: 4,
    startedAt: "2026-11-11T07:43:00.000Z",
    updatedAt: "2026-11-11T07:43:43.000Z",
    finishedAt: null,
    status: "exception" as const,
    segment: 0,
    segments: [
      { section: "Prologue", stations },
      {
        section: "Tule",
        stations: Array.from({ length: 21 }, (_value, index) => withKeys(index, "pending", "")),
      },
      {
        section: "Wind Shrine",
        stations: Array.from({ length: 13 }, (_value, index) => withKeys(index, "pending", "")),
      },
    ],
    fallbacks: [],
    previousException: null,
  } as unknown as ChapterProgress;
  const resume = chapterResumeFrom(plan, progress);
  assert.equal(resume?.startAt, 0);
  assert.deepEqual(resume.skipStations, {
    0: { startAt: 4, skip: [], done: { 0: 0, 1: 1, 2: 2, 3: 3 } },
  });
  assert.match(describeChapterResume(plan, resume), /第 1 节「Prologue」第 5 站/u);

  const ports = new FakeChapterPorts();
  ports.brokenRoutes.add("plan-13");
  const dir = await mkdtemp(join(tmpdir(), "chapter-resume-"));
  const progressPath = join(dir, "chapter-progress-ff5.json");
  const reportPath = join(dir, "chapter-report-ff5.json");
  const logs: string[] = [];
  try {
    const report = await executeChapterPlan(plan, ports, {
      priorProgress: progress,
      ...resume,
      progressPath,
      reportPath,
      log: (line) => logs.push(line),
    });
    assert.equal(report.status, "exception");
    const goCalls = ports.calls.filter((call) => call.startsWith("go:"));
    assert.deepEqual(
      goCalls,
      Array.from({ length: 9 }, (_value, index) => `go:plan-${index + 4}`),
    );
    assert.ok(logs.some((line) => line.includes("续跑从第 1 节「Prologue」第 5 站开始")));
    const saved = JSON.parse(await readFile(progressPath, "utf8")) as ChapterProgress;
    const savedReport = JSON.parse(await readFile(reportPath, "utf8")) as {
      resume?: string;
    };
    assert.match(savedReport.resume ?? "", /第 1 节「Prologue」第 5 站/u);
    assert.deepEqual(
      saved.segments[1]?.stations.map((entry) => entry.status),
      Array.from({ length: 21 }, () => "pending"),
    );
    assert.deepEqual(
      saved.segments[2]?.stations.map((entry) => entry.status),
      Array.from({ length: 13 }, () => "pending"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("a changed station to/do is pending even when the old status says done", () => {
  const plan = chapter([
    segment("Prologue", [
      station("move", "1:1,1"),
      station("move", "1:2,2"),
      station("move", "1:3,3"),
      station("move", "1:4,4"),
      station("move", "1:5,5"),
    ]),
  ]);
  const progress: ChapterProgress = {
    game: "ff5",
    chapter: 2,
    goal: plan.goal,
    revision: 1,
    startedAt: "2026-11-11T07:43:00.000Z",
    updatedAt: "2026-11-11T07:43:43.000Z",
    finishedAt: null,
    status: "exception",
    segment: 0,
    segments: [
      {
        section: "Prologue",
        stations: [
          { index: 0, status: "done", note: "做完了", to: "1:1,1", do: "move" },
          { index: 1, status: "done", note: "做完了", to: "1:2,2", do: "move" },
          { index: 2, status: "done", note: "做完了", to: "1:3,3", do: "move" },
          { index: 3, status: "done", note: "做完了", to: "1:4,4", do: "move" },
          // Same station count and section, but the plan now targets another cell.
          { index: 4, status: "done", note: "做完了", to: "1:9,9", do: "move" },
        ],
      },
    ],
    fallbacks: [],
    previousException: null,
  } as unknown as ChapterProgress;
  assert.deepEqual(chapterResumeFrom(plan, progress), {
    startAt: 0,
    skipStations: {
      0: { startAt: 4, skip: [], done: { 0: 0, 1: 1, 2: 2, 3: 3 } },
    },
  });
});

void test("progress and report files carry the chapter, stations and fallbacks", async () => {
  const ports = new FakeChapterPorts();
  ports.failRoute.set("plan-0", 1);
  const dir = await mkdtemp(join(tmpdir(), "chapter-execute-"));
  const progressPath = join(dir, "chapter-progress-ff5.json");
  const reportPath = join(dir, "chapter-report-ff5.json");
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])], {
      growth: [],
    }),
    ports,
    { game: "ff5", progressPath, reportPath, revision: 3 },
  );
  assert.equal(report.status, "done");
  const progress = JSON.parse(await readFile(progressPath, "utf8")) as ChapterProgress;
  assert.equal(progress.game, "ff5");
  assert.equal(progress.chapter, 2);
  assert.equal(progress.revision, 3);
  assert.equal(progress.status, "done");
  assert.notEqual(progress.finishedAt, null);
  assert.deepEqual(
    progress.segments[0]?.stations.map((entry) => entry.status),
    ["done"],
  );
  assert.ok(progress.fallbacks.some((line) => line.includes("换新路线重试")));
  const saved = JSON.parse(await readFile(reportPath, "utf8")) as ChapterReport;
  assert.equal(saved.status, "done");
  assert.equal(saved.chapter, 2);
  assert.deepEqual(
    saved.segments.map((entry) => entry.section),
    ["第一节"],
  );
  assert.ok(saved.fallbacks.length >= 1);
});

void test("field recovery that revives the fallen is enough; no inn detour", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ members: [member(10, 0, 100)] });
  ports.healQueue.push({ ok: true, text: "用不死鸟之尾救起了巴兹" });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("heal:30"));
  assert.ok(!ports.calls.some((call) => call.startsWith("go:chapter-restore")));
});

void test("when someone is down only a revive-capable place is chosen", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ members: [member(10, 0, 100)] });
  ports.restoreList.push(
    { map: 1, cell: [2, 2], name: "北山休憩所", revive: false },
    { map: 1, cell: [9, 9], name: "卡文镇旅店", revive: true },
  );
  ports.healQueue.push({ ok: false, text: "野外没有复活手段" }, { ok: true, text: "住店复活" });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("go:chapter-restore-1-9-9"));
  assert.ok(!ports.calls.includes("go:chapter-restore-1-2-2"));
});

void test("the nearest restore point is the shortest route estimate, not list order", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ members: [member(10, 5, 100)] });
  ports.restoreList.push(
    { map: 2, cell: [9, 9], name: "远旅店", revive: true },
    { map: 1, cell: [8, 8], name: "近旅店", revive: true },
  );
  ports.routeMinutes.set(1, 2);
  ports.routeMinutes.set(2, 20);
  ports.healQueue.push({ ok: false, text: "野外回复不了" }, { ok: true, text: "住店回满" });
  const report = await executeChapterPlan(
    chapter([
      segment("第一节", [station("move", "1:2,2")]),
      segment("第二节", [station("move", "2:3,3")]),
    ]),
    ports,
  );
  assert.equal(report.status, "done");
  const restores = ports.calls.filter((call) => call.startsWith("go:chapter-restore-"));
  assert.equal(restores[0], "go:chapter-restore-1-8-8");
});

void test("a restore point outside this chapter's route is never a detour", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ members: [member(10, 0, 100)] });
  ports.restoreList.push({
    map: 99,
    cell: [9, 9],
    name: "北山休憩所",
    revive: true,
  });
  ports.healQueue.push({ ok: false, text: "野外没有复活手段" });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])]),
    ports,
  );
  assert.equal(report.status, "exception");
  assert.ok(report.fallbacks.some((line) => line.includes("本章路线上的旅店")));
  assert.ok(!ports.calls.some((call) => call.startsWith("go:chapter-restore-")));
});

void test("a boss already won in an earlier story station skips its misplaced boss station", async () => {
  const ports = new FakeChapterPorts();
  const boss: PlanBoss = {
    name: "玛基莎",
    map: 10,
    healFirst: false,
    saveFirst: false,
    tables: [{ 巴兹: ["攻击"] }],
  };
  ports.battleOnGo.set("plan-0", { boss: true, enemies: ["玛基莎"] });
  const report = await executeChapterPlan(
    chapter([
      segment(
        "第一节",
        [station("move", "10:2,2"), station("boss", "227:5,5", { why: "玛基莎" })],
        { bosses: [boss] },
      ),
    ]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("boss:玛基莎"));
  assert.ok(!ports.calls.includes("go:plan-1"));
  assert.ok(ports.calls.some((call) => call.includes("progress:1:done")));
});

void test("a battle left after a deferred growth is fought before the chapter returns", async () => {
  const ports = new FakeChapterPorts();
  ports.sceneValue = {
    state: "Battle",
    dialog: false,
    battle: true,
    boss: false,
    enemies: ["风筝猫"],
  };
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])], {
      growth: [{ before: 0, level: 99, where: "1", why: "练级", maxMinutes: 1 }],
    }),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(report.fallbacks.some((line) => line.includes("到章末还没刷成，跳过")));
  assert.ok(ports.calls.includes("fightNormal"));
  assert.equal(ports.sceneValue.battle, false);
});

void test("an ailment alone is cured in the field instead of walking to town", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({
    members: [{ ...member(10, 100), status: ["中毒"] }],
  });
  ports.healQueue.push({ ok: true, text: "用了解毒药" });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("heal:30"));
  assert.ok(!ports.calls.some((call) => call.startsWith("go:chapter-restore")));
});

void test("a station with no cell is a plan problem, not retried", async () => {
  const ports = new FakeChapterPorts();
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("switch", "1")])]),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "exception");
  assert.ok(lines.some((line) => line.includes("不重试：计划本身的问题")));
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
  assert.equal(ports.calls.filter((call) => call === "progress:start").length, 1);
});

void test("a target map missing from the map records is not retried", async () => {
  const ports = new FakeChapterPorts();
  ports.unknownMaps.add(99);
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "99:1,1")])]),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "exception");
  assert.ok(lines.some((line) => line.includes("不重试：计划本身的问题")));
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
  assert.equal(ports.calls.filter((call) => call === "progress:start").length, 1);
});

void test("a whole map that cannot be reached is an exception even for an optional stop", async () => {
  const ports = new FakeChapterPorts();
  ports.unknownMaps.add(99);
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "99:1,1", { optional: true })])]),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "exception");
  assert.equal(report.exception?.kind, "unreachable");
  assert.match(report.exception.detail, /整张图 99 现在去不了/u);
  assert.ok(lines.some((line) => line.includes("不重试：计划本身的问题")));
  assert.ok(!report.fallbacks.some((line) => line.includes("按兜底跳过")));
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
});

void test("a route with no way to the target map is not skipped as an optional cell", async () => {
  const ports = new FakeChapterPorts();
  ports.brokenRoutes.add("plan-0");
  ports.routeUnreachableReason = "地图记录里没有从地图 1 到地图 30 的出口路线";
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("open", "30:5,5", { optional: true })])]),
    ports,
  );
  assert.equal(report.status, "exception");
  assert.equal(report.exception?.kind, "unreachable");
  assert.match(report.exception.detail, /整张图 30 现在去不了/u);
  assert.ok(!report.fallbacks.some((line) => line.includes("按兜底跳过")));
});

void test("an invalid boss station without a boss table is not retried", async () => {
  const ports = new FakeChapterPorts();
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("boss", "1:2,2")])]),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "exception");
  assert.ok(lines.some((line) => line.includes("不重试：计划本身的问题")));
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
});

void test("a skipped station stays skipped when a later retry marks the prefix done", async () => {
  const ports = new FakeChapterPorts();
  ports.brokenRoutes.add("plan-0");
  ports.failRoute.set("plan-1", 1);
  const dir = await mkdtemp(join(tmpdir(), "chapter-skip-"));
  const progressPath = join(dir, "chapter-progress-ff5.json");
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("open", "1:2,2"), station("move", "1:3,3")])]),
    ports,
    { game: "ff5", progressPath },
  );
  assert.equal(report.status, "done");
  assert.equal(report.segments[0]?.done.stations, 1);
  assert.ok(ports.calls.includes("progress:0:skipped"));
  assert.ok(!ports.calls.includes("progress:0:done"));
  const progress = JSON.parse(await readFile(progressPath, "utf8")) as ChapterProgress;
  assert.deepEqual(
    progress.segments[0]?.stations.map((entry) => entry.status),
    ["skipped", "done"],
  );
  const first = progress.segments[0].stations[0];
  assert.ok(first !== undefined);
  assert.doesNotMatch(first.note, /重试前已完成/u);
});

void test("a story with no effect is a plan problem, not retried", async () => {
  const ports = new FakeChapterPorts();
  ports.fatalText = "到了 (2,2) 附近，剧情没有触发";
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("story", "1:2,2")])]),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "exception");
  assert.ok(lines.some((line) => line.includes("不重试：计划本身的问题")));
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
  assert.equal(ports.calls.filter((call) => call === "progress:start").length, 1);
});

void test("an investigation that changes nothing is a plan problem, not retried", async () => {
  const ports = new FakeChapterPorts();
  ports.fatalText = "调查 (2,2) 后什么也没发生(没有对话、附近实体没变)";
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("talk", "1:2,2")])]),
    ports,
    { log: (line) => lines.push(line) },
  );
  assert.equal(report.status, "exception");
  assert.ok(lines.some((line) => line.includes("不重试：计划本身的问题")));
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
  assert.equal(ports.calls.filter((call) => call === "progress:start").length, 1);
});

function battleOnTrigger(ports: FakeChapterPorts): void {
  let active = false;
  ports.battleActive = async () => active;
  ports.interact = async (cell: Cell): Promise<PlanStationResult> => {
    active = true;
    ports.calls.push(`interact:${cell[0]},${cell[1]}`);
    return { ok: true, done: true, text: "开战了" };
  };
}

function bossFacts(cell: Cell): ChapterFactsData {
  return {
    game: "ff5",
    chapter: 2,
    from: 0,
    to: 0,
    sections: [
      {
        index: 0,
        title: "第一节",
        done: false,
        facts: testSegmentFacts("第一节", [10], {
          bosses: [
            {
              ...testBoss({ name: "首领", maps: [10] }),
              knowledgeName: "首领",
              triggers: [{ map: 10, cell }],
            },
          ],
        }),
      },
    ],
    hiddenItems: [],
    shops: [],
    encounters: [],
  };
}

void test("a boss station with only a map walks to the chapter fact trigger", async () => {
  const ports = new FakeChapterPorts();
  battleOnTrigger(ports);
  const boss: PlanBoss = {
    name: "首领",
    map: 10,
    healFirst: true,
    saveFirst: false,
    tables: [{ 巴兹: ["攻击"] }],
  };
  ports.healQueue.push({
    ok: false,
    text: "有恢复药×2，已用 1 瓶，最低 60% 仍低于 95%",
  });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("boss", "10")], { bosses: [boss] })]),
    ports,
    { facts: bossFacts([3, 3]), healFullPercent: 95 },
  );
  assert.equal(report.status, "done");
  assert.ok(ports.routedCells.some((cell) => cell[0] === 3 && cell[1] === 3));
  assert.ok(ports.calls.includes("heal:95"));
  assert.ok(ports.calls.includes("boss:首领"));
  assert.match(report.segments[0]?.party ?? "", /首领前回复/u);
  assert.match(report.segments[0]?.party ?? "", /已用 1 瓶/u);
});

void test("without facts a boss trigger comes from the live entity port", async () => {
  const ports = new FakeChapterPorts();
  battleOnTrigger(ports);
  ports.bossTriggerCells = [[4, 4]];
  const boss: PlanBoss = {
    name: "首领",
    map: 10,
    healFirst: false,
    saveFirst: false,
    tables: [{ 巴兹: ["攻击"] }],
  };
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("boss", "10")], { bosses: [boss] })]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.routedCells.some((cell) => cell[0] === 4 && cell[1] === 4));
  assert.ok(ports.calls.includes("bossTriggers"));
});

void test("a boss station with no cell and no trigger is a plan problem", async () => {
  const ports = new FakeChapterPorts();
  battleOnTrigger(ports);
  const boss: PlanBoss = {
    name: "首领",
    map: 10,
    healFirst: false,
    saveFirst: false,
    tables: [{ 巴兹: ["攻击"] }],
  };
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("boss", "10")], { bosses: [boss] })]),
    ports,
  );
  assert.equal(report.status, "exception");
  const exception = report.exception;
  assert.ok(exception);
  assert.equal(exception.kind, "invalid");
  assert.match(exception.detail, /找不到「首领」的触发点/u);
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
});

void test("a whole segment whose boat is disabled runs after the later ones and then retries", async () => {
  const ports = new FakeChapterPorts();
  ports.failRoute.set("plan-0", 1);
  ports.routeUnreachableReason = "交通工具:船 地图 1 不能用";
  const report = await executeChapterPlan(
    chapter([
      segment("第一节", [station("move", "99:1,1")]),
      segment("第二节", [station("switch", "1:2,2")]),
    ]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.deepEqual(
    report.segments.map((entry) => entry.section),
    ["第一节", "第二节"],
  );
  assert.ok(report.fallbacks.some((line) => line.includes("先跑后面的段")));
  assert.deepEqual(ports.routedCells, [
    [2, 2],
    [1, 1],
  ]);
});

void test("a restore point without a revive flag revives by default", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ members: [member(10, 0, 100)] });
  ports.restoreList.push({ map: 1, cell: [9, 9], name: "风之神殿回复罐" });
  ports.healQueue.push({ ok: false, text: "野外没有复活手段" }, { ok: true, text: "罐子复活" });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "1:2,2")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("go:chapter-restore-1-9-9"));
  assert.ok(ports.calls.includes("restAt:风之神殿回复罐"));
});

void test("a replan turn-back heals and continues instead of blocking the chapter", async () => {
  const ports = new FakeChapterPorts();
  ports.current = observation({ items: { 恢复药: 1 } });
  const lines: string[] = [];
  const report = await executeChapterPlan(
    chapter([
      segment("第一节", [station("move", "1:2,2"), station("move", "1:3,3")], {
        turnBack: [{ when: "item.恢复药 < 2", then: "replan" }],
      }),
    ]),
    ports,
    { log: (line) => lines.push(line), healFullPercent: 95 },
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("heal:95"));
  assert.equal(
    lines.filter((line) => line.includes("规则里的 replan 在执行期间不交回模型")).length,
    1,
  );
  assert.ok(lines.some((line) => line.includes("按计划回复(95% 线)后继续")));
  assert.ok(!lines.some((line) => line.includes("交给模型重排")));
  assert.equal(report.fallbacks.length, 0);
});

void test("a restore-point object is approached from a standable side and reported with both cells", async () => {
  const ports = new FakeChapterPorts();
  ports.positionAt = { map: 202, cell: [1, 1] };
  ports.current = observation({ map: 202, cell: [1, 1], members: [member(10, 5, 100)] });
  ports.restoreList.push({ map: 202, cell: [10, 22], name: "风之神殿回复罐" });
  ports.pointObjects.add("202:10,22");
  ports.healQueue.push({ ok: false, text: "野外没有回复手段" }, { ok: true, text: "回复罐回满" });
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("move", "202:2,2")])]),
    ports,
  );
  assert.equal(report.status, "done");
  assert.ok(ports.calls.includes("go:chapter-restore-202-10-23"));
  assert.ok(!ports.calls.includes("go:chapter-restore-202-10-22"));
  assert.ok(ports.calls.includes("restAt:风之神殿回复罐"));
  const line = report.fallbacks.find((entry) => entry.includes("风之神殿回复罐"));
  assert.ok(line !== undefined);
  assert.match(line, /202:10,22/u);
  assert.match(line, /站 202:10,23/u);
});

void test("a failed pre-station restore blocks the chapter without retrying or skipping that station", async () => {
  const ports = new FakeChapterPorts();
  ports.healDefault = { ok: false, text: "野外没有回复手段" };
  const originalInteract = ports.interact.bind(ports);
  let first = true;
  ports.interact = async (cell: Cell): Promise<PlanStationResult> => {
    const result = await originalInteract(cell);
    if (first) {
      first = false;
      ports.current = observation({ map: 1, cell: [2, 2], members: [member(10, 5, 100)] });
    }
    return result;
  };
  const report = await executeChapterPlan(
    chapter([segment("第一节", [station("open", "1:2,2"), station("open", "1:3,3")])]),
    ports,
  );
  assert.equal(report.status, "exception");
  const exception = report.exception;
  assert.ok(exception);
  assert.equal(exception.station, null);
  assert.equal(exception.kind, "stuck");
  assert.match(exception.detail, /^等待修复：第 1 节第 2 站前回复失败：.*本章路线上的旅店/u);
  assert.equal(report.segments[0]?.exception?.station, null);
  assert.ok(!report.fallbacks.some((line) => line.includes("换新路线重试")));
  assert.ok(!report.fallbacks.some((line) => line.includes("按兜底跳过")));
  assert.ok(!ports.calls.includes("go:plan-1"));
  assert.equal(ports.calls.filter((call) => call === "progress:start").length, 1);
});

void test("the chapter run log records run, segment and station events for a retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-chapter-run-log-"));
  try {
    const runLog = new RunLogger({
      game: "ff5",
      file: join(directory, "run-ff5.jsonl"),
      run: "chapter-run",
    });
    const ports = new FakeChapterPorts();
    ports.failRoute.set("plan-0", 1);
    const report = await executeChapterPlan(
      chapter([segment("第一节", [station("move", "1:2,2")])]),
      ports,
      { runLog },
    );
    await runLog.flush();
    assert.equal(report.status, "done");
    const events = await readRunEvents(join(directory, "run-ff5.jsonl"));
    const types = events.map((event) => event.type);
    assert.ok(types.includes("run.start"));
    assert.ok(types.includes("run.end"));
    assert.ok(types.includes("segment.start"));
    assert.ok(types.includes("segment.end"));
    assert.ok(types.includes("station.start"));
    assert.ok(types.includes("station.end"));
    assert.ok(events.some((event) => event.type === "fallback" && event.kind === "retry"));
    for (const event of events) {
      assert.equal(event.run, "chapter-run");
      assert.equal(event.chapter, 2);
      assert.ok(event.segment !== null || event.type === "run.start");
    }
    const end = events.find((event) => event.type === "run.end");
    assert.ok(end !== undefined);
    assert.equal(end.status, "done");
    assert.equal(end.modelCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("two unreachable stations rewind to the last weak-evidence story station", async () => {
  const ports = new FakeChapterPorts();
  ports.positionAt = { map: 1, cell: [0, 0] };
  ports.current = observation({ map: 1, cell: [0, 0] });
  ports.weakStoryCell = [10, 10];
  ports.brokenRoutes.add("plan-0");
  ports.brokenRoutes.add("plan-1");
  let storyRuns = 0;
  ports.interact = async (cell: Cell): Promise<PlanStationResult> => {
    if (cell[0] === 10 && cell[1] === 10) {
      storyRuns += 1;
      if (storyRuns === 1) {
        ports.positionAt = { map: 1, cell: [20, 20] };
        ports.current = observation({ map: 1, cell: [20, 20] });
        return { ok: true, done: true, text: "被推走" };
      }
      ports.brokenRoutes.clear();
      return { ok: true, done: true, text: "对话", evidence: ["对话/剧情"] };
    }
    return { ok: true, done: true, text: "开了" };
  };
  const report = await executeChapterPlan(
    chapter([
      segment("第一节", [station("story", "1", { why: "往北走" })]),
      segment("第二节", [
        station("open", "99:1,1"),
        station("open", "99:2,2"),
      ]),
    ]),
    ports,
  );
  assert.equal(report.status, "done", JSON.stringify(report.exception));
  assert.ok(report.fallbacks.some((line) => line.includes("回头补剧情")));
  assert.equal(storyRuns, 2);
  assert.ok(!report.fallbacks.some((line) => line.includes("等待修复")));
});

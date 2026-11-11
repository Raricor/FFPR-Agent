import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PLAN_ROUTE,
  defaultPlanFiles,
  planRoute,
  readPlanPanel,
  type PlanFiles,
  type PlanPanelView,
  type PlanView,
} from "../src/plugin/plan-panel.ts";

const STARTED = "2026-11-11T10:00:00";
const UPDATED = "2026-11-11T10:12:00";

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    section: "测试神殿",
    goal: "走完测试神殿，拿到测试道具",
    prep: {
      jobs: [{ member: "甲", job: "骑士", abilities: ["掩护"] }],
      equip: "optimize",
      buy: [{ item: "测试药水", count: 3 }],
      rows: [{ member: "甲", row: "front" }],
    },
    stations: [
      { to: "12:3,4", do: "move", why: "去入口" },
      { to: "12:5,6", do: "open", why: "拿宝箱", optional: true },
      {
        to: "12:7,8",
        do: "grind",
        why: "刷测试怪",
        until: { bestiary: ["测试怪"], battles: 5, minutes: 10 },
      },
      { to: "12:9,10", do: "boss", why: "打首领" },
    ],
    battle: [
      {
        maps: [12],
        tables: [
          {
            甲: [{ if: "ally.hp_pct < 40", do: "道具:测试药水" }, { do: "攻击" }],
          },
        ],
      },
    ],
    bosses: [
      {
        name: "测试首领",
        map: 12,
        healFirst: true,
        saveFirst: true,
        tables: [{ 甲: [{ do: "攻击" }] }],
        notes: "先防御",
      },
    ],
    turnBack: [{ when: "party.lowest_hp_pct < 30", then: "replan" }],
    dropped: [{ to: "12:11,12", do: "open", why: "宝箱已经拿过" }],
    notes: "测试备注",
    ...overrides,
  };
}

function planFile(current: Record<string, unknown> | null): Record<string, unknown> {
  return {
    game: "ff5",
    current,
    history: current === null ? {} : { [String(current.section)]: [current] },
  };
}

function progress(): Record<string, unknown> {
  return {
    game: "ff5",
    section: "测试神殿",
    goal: "走完测试神殿，拿到测试道具",
    revision: 2,
    startedAt: STARTED,
    updatedAt: UPDATED,
    finishedAt: null,
    status: "running",
    stations: [
      { index: 0, status: "done", note: "到了入口" },
      { index: 1, status: "current", note: "开了宝箱" },
      { index: 2, status: "pending", note: "" },
      { index: 3, status: "failed", note: "到不了首领" },
    ],
    previousException: { kind: "unreachable", detail: "上一份走不过去" },
  };
}

function report(): Record<string, unknown> {
  return {
    section: "测试神殿",
    status: "exception",
    exception: {
      kind: "unreachable",
      map: 12,
      cell: [1, 1],
      station: 2,
      detail: "第 3 站的格子走不过去",
    },
    done: {
      stations: 3,
      chestsOpened: 2,
      battles: 7,
      bestiaryNew: ["测试怪"],
      blueMagicNew: [],
      bossesWon: ["测试首领"],
    },
    remaining: [3],
    party: "测试队伍",
    minutes: 12,
    modelCalls: 0,
  };
}

function atlas(): Record<string, unknown> {
  return { "12": { name: "测试地图" } };
}

async function withFiles(
  files: {
    readonly plan?: unknown;
    readonly progress?: unknown;
    readonly report?: unknown;
    readonly atlas?: unknown;
  },
  run: (paths: PlanFiles) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-"));
  const paths: PlanFiles = {
    plan: join(directory, "segment-plan-ff5.json"),
    progress: join(directory, "segment-progress-ff5.json"),
    report: join(directory, "segment-report-ff5.json"),
    atlas: join(directory, "atlas-ff5.json"),
  };
  try {
    for (const [key, path] of Object.entries(paths) as [keyof typeof files, string][]) {
      const value = files[key];
      if (value === undefined) continue;
      await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
    }
    await run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function planOf(view: PlanPanelView): PlanView {
  assert.ok(view.plan);
  return view.plan;
}

void test("the whole plan, its progress and the last report are shown in Chinese", async () => {
  await withFiles(
    {
      plan: planFile(plan()),
      progress: progress(),
      report: report(),
      atlas: atlas(),
    },
    async (paths) => {
      const view = await readPlanPanel(paths);
      assert.equal(view.title, "段计划");
      assert.equal(view.status, "执行中");
      assert.equal(view.message, null);
      const shown = planOf(view);
      assert.equal(shown.section, "测试神殿");
      assert.equal(shown.goalText, "目标：走完测试神殿，拿到测试道具");
      assert.equal(shown.revisionText, "本节第 2 份计划");
      assert.equal(shown.statusText, "执行中");
      assert.match(shown.startedText, /^开始 11-11 10:00$/u);
      assert.match(shown.updatedText, /^更新 11-11 10:12$/u);
      assert.match(shown.whyText ?? "", /上一份在第 3 站出例外（unreachable）/u);
      assert.deepEqual(shown.prep, [
        "换职业：甲 → 骑士（技能：掩护）",
        "装备：自动挑最强",
        "购买：测试药水 ×3",
        "站位：甲 前排",
      ]);

      assert.deepEqual(shown.stationHeaders, [
        "序号",
        "图",
        "坐标",
        "做什么",
        "为什么",
        "停止条件",
        "状态",
      ]);
      assert.deepEqual(
        shown.stations.map((row) => [
          row.number,
          row.mapText,
          row.cellText,
          row.action,
          row.statusSymbol,
          row.statusText,
          row.current,
        ]),
        [
          [1, "12 测试地图", "(3,4)", "移动", "✓", "做完", false],
          [2, "12 测试地图", "(5,6)", "开宝箱", "▶", "正在做", true],
          [3, "12 测试地图", "(7,8)", "刷怪", "·", "待做", false],
          [4, "12 测试地图", "(9,10)", "首领", "✗", "失败", false],
        ],
      );
      assert.equal(shown.stations[1]?.note, "开了宝箱");
      assert.equal(shown.stations[2]?.untilText, "图鉴：测试怪；战斗 5 场；10 分钟");

      assert.deepEqual(
        shown.dropped.map((row) => [row.mapText, row.cellText, row.action, row.why]),
        [["12 测试地图", "(11,12)", "开宝箱", "宝箱已经拿过"]],
      );

      assert.equal(shown.battle.length, 1);
      const battle = shown.battle[0];
      assert.ok(battle);
      assert.equal(battle.title, "普通战斗表 1（12 测试地图）");
      const table = battle.tables[0];
      assert.ok(table);
      const battleLines = table.lines;
      assert.equal(battleLines.length, 2);
      assert.match(battleLines[0] ?? "", /甲/u);
      assert.match(battleLines[0] ?? "", /测试药水/u);
      assert.match(battleLines[1] ?? "", /攻击/u);

      assert.deepEqual(
        shown.boss.map((boss) => [boss.name, boss.mapText, boss.prepText]),
        [["测试首领", "12 测试地图", "先回复：是；先存档：是"]],
      );
      const boss = shown.boss[0];
      assert.ok(boss);
      assert.match(boss.tables[0]?.lines[0] ?? "", /甲/u);
      assert.equal(boss.notes, "先防御");
      assert.deepEqual(shown.turnBack, ["party.lowest_hp_pct < 30 → 重新规划"]);

      const shownReport = shown.report;
      assert.ok(shownReport);
      assert.equal(shownReport.heading, "最近一份报告（测试神殿）");
      assert.deepEqual(shownReport.lines, [
        "状态：出例外",
        "完成 3 站，开箱 2 个，战斗 7 场",
        "新图鉴：测试怪；新青魔法：无；击败首领：测试首领",
        "用时 12 分钟，模型调用 0 次",
      ]);
      assert.match(shownReport.exceptionText ?? "", /第 3 站/u);
      assert.equal(shown.notes, "测试备注");
      assert.deepEqual(shown.warnings, []);
    },
  );
});

void test("without a progress file the plan still shows and every station is 未开始", async () => {
  await withFiles({ plan: planFile(plan()), report: report(), atlas: atlas() }, async (paths) => {
    const view = await readPlanPanel(paths);
    assert.equal(view.status, "没在执行");
    const shown = planOf(view);
    assert.equal(shown.revisionText, "本节计划");
    assert.deepEqual(
      shown.stations.map((row) => [row.statusSymbol, row.statusText]),
      [
        ["·", "未开始"],
        ["·", "未开始"],
        ["·", "未开始"],
        ["·", "未开始"],
      ],
    );
    assert.equal(shown.whyText, null);
  });
});

void test("a broken plan file is a Chinese message, not an exception", async () => {
  await withFiles({ plan: "{not json", progress: progress() }, async (paths) => {
    const view = await readPlanPanel(paths);
    assert.equal(view.status, "段计划读不了");
    assert.match(view.message ?? "", /读不懂段计划/u);
    assert.equal(view.plan, null);
  });
});

void test("a broken progress file keeps the plan and the stations read as 未开始", async () => {
  await withFiles(
    { plan: planFile(plan()), progress: "{not json", atlas: atlas() },
    async (paths) => {
      const view = await readPlanPanel(paths);
      assert.equal(view.status, "没在执行");
      const shown = planOf(view);
      assert.ok(shown.warnings.some((warning) => warning.includes("读不懂执行进度")));
      assert.equal(
        shown.stations.every((row) => row.statusText === "未开始"),
        true,
      );
    },
  );
});

void test("a plan without dropped stations has no dropped table", async () => {
  const withoutDropped = plan({ dropped: undefined });
  await withFiles(
    { plan: planFile(withoutDropped), progress: progress(), atlas: atlas() },
    async (paths) => {
      const view = await readPlanPanel(paths);
      assert.deepEqual(planOf(view).dropped, []);
    },
  );
});

void test("a broken report file keeps the plan and names the report problem", async () => {
  await withFiles(
    {
      plan: planFile(plan()),
      progress: progress(),
      report: "{not json",
      atlas: atlas(),
    },
    async (paths) => {
      const view = await readPlanPanel(paths);
      assert.equal(view.status, "执行中");
      const shown = planOf(view);
      assert.equal(shown.report, null);
      assert.ok(shown.warnings.some((warning) => warning.includes("读不懂执行报告")));
    },
  );
});

void test("without a readable atlas the map column falls back to the bare number", async () => {
  await withFiles(
    {
      plan: planFile(plan()),
      progress: progress(),
      report: report(),
      atlas: "{not json",
    },
    async (paths) => {
      const view = await readPlanPanel(paths);
      assert.equal(planOf(view).stations[0]?.mapText, "12");
    },
  );
});

void test("a progress file for another section is not applied to this plan", async () => {
  const other = { ...progress(), section: "别的节" };
  await withFiles({ plan: planFile(plan()), progress: other, atlas: atlas() }, async (paths) => {
    const view = await readPlanPanel(paths);
    assert.equal(view.status, "没在执行");
    const shown = planOf(view);
    assert.match(shown.warnings.join("\n"), /执行进度是上一份计划的/u);
    assert.equal(shown.revisionText, "本节第 3 份计划(未开始)");
    assert.equal(
      shown.stations.every((row) => row.statusText === "未开始"),
      true,
    );
  });
});

void test("a previous plan's goal does not mark a new plan's stations", async () => {
  const previous = { ...progress(), goal: "上一份计划的目标" };
  await withFiles({ plan: planFile(plan()), progress: previous, atlas: atlas() }, async (paths) => {
    const view = await readPlanPanel(paths);
    assert.equal(view.status, "没在执行");
    const shown = planOf(view);
    assert.match(shown.warnings.join("\n"), /执行进度是上一份计划的/u);
    assert.equal(shown.revisionText, "本节第 3 份计划(未开始)");
    assert.equal(shown.startedText, "开始时间未知");
    assert.equal(shown.updatedText, "更新时间未知");
  });
});

void test("a previous plan's station count does not mark a new plan's stations", async () => {
  const previous = {
    ...progress(),
    goal: "走完测试神殿，拿到测试道具",
    stations: [{ index: 0, status: "done", note: "到了入口" }],
  };
  await withFiles({ plan: planFile(plan()), progress: previous, atlas: atlas() }, async (paths) => {
    const view = await readPlanPanel(paths);
    assert.equal(view.status, "没在执行");
    const shown = planOf(view);
    assert.match(shown.warnings.join("\n"), /执行进度是上一份计划的/u);
    assert.equal(shown.revisionText, "本节第 3 份计划(未开始)");
    assert.equal(
      shown.stations.every((row) => row.statusText === "未开始"),
      true,
    );
  });
});

void test("the plan route returns the rendered view over HTTP", async () => {
  await withFiles(
    {
      plan: planFile(plan()),
      progress: progress(),
      report: report(),
      atlas: atlas(),
    },
    async (paths) => {
      const route = planRoute(undefined, () => paths);
      assert.equal(route.path, PLAN_ROUTE);
      const body = (await (
        await route.fetch(new Request("http://localhost/api/ffpr/plan?game=ff5"))
      ).json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      const view = body.view as PlanPanelView;
      assert.equal(view.status, "执行中");
      assert.equal(view.plan?.section, "测试神殿");
    },
  );
});

void test("default files are the .deps/ds names the store and the other tasks use", () => {
  const paths = defaultPlanFiles("ff5");
  assert.match(paths.plan, /\.deps[/\\]ds[/\\]segment-plan-ff5\.json$/u);
  assert.match(paths.progress, /\.deps[/\\]ds[/\\]segment-progress-ff5\.json$/u);
  assert.match(paths.report, /\.deps[/\\]ds[/\\]segment-report-ff5\.json$/u);
  assert.match(paths.atlas, /\.deps[/\\]ds[/\\]atlas-ff5\.json$/u);
});

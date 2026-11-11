import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as ts from "typescript";
import type { PlanPanelView, PlanView } from "../src/plugin/plan-panel.ts";
import type { ChapterRouteMapView, ChapterRouteView } from "../src/plugin/route-view.ts";

interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown> | null;
  readonly children: readonly unknown[];
}

interface FakeReact {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): Element;
  useState<T>(initial: T): [T, (value: T) => void];
  useEffect(effect: () => (() => void) | undefined): void;
  useRef<T>(initial: T): { current: T };
}

type RenderRouteBlock = (
  view: ChapterRouteView | null,
  map: ChapterRouteMapView | null,
  routeError: string | null,
  mapError: string | null,
  selected: string,
  onSelect: (mapId: number) => void,
) => unknown;

function isElement(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "children" in value &&
    Array.isArray((value as { children?: unknown }).children)
  );
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isElement(node)) return "";
  return node.children.map(textOf).join(" ");
}

function findAll(node: unknown, type: string, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found);
  } else if (isElement(node)) {
    if (node.type === type) found.push(node);
    findAll(node.children, type, found);
  }
  return found;
}

function planView(): PlanView {
  return {
    section: "测试神殿",
    goalText: "目标：走完测试神殿",
    revisionText: "本节第 2 份计划",
    statusText: "执行中",
    startedText: "开始 11-11 10:00",
    updatedText: "更新 11-11 10:12",
    whyText: "上一份在第 3 站出例外（unreachable）：走不过去",
    prep: ["换职业：甲 → 骑士", "装备：自动挑最强"],
    prepEmptyText: "没有准备事项",
    stationHeaders: ["序号", "图", "坐标", "做什么", "为什么", "停止条件", "状态"],
    stations: [
      {
        number: 1,
        mapText: "12 测试地图",
        cellText: "(3,4)",
        action: "开宝箱",
        why: "拿宝箱",
        untilText: "—",
        statusSymbol: "✓",
        statusText: "做完",
        note: "开了宝箱",
        current: false,
      },
      {
        number: 2,
        mapText: "12 测试地图",
        cellText: "(5,6)",
        action: "刷怪",
        why: "刷测试怪",
        untilText: "战斗 5 场",
        statusSymbol: "▶",
        statusText: "正在做",
        note: "",
        current: true,
      },
    ],
    stationEmptyText: "这份计划没有站点",
    dropped: [
      {
        number: 1,
        mapText: "12 测试地图",
        cellText: "(7,8)",
        action: "开宝箱",
        why: "已经拿过",
      },
    ],
    droppedHeaders: ["序号", "图", "坐标", "做什么", "为什么"],
    battle: [
      {
        title: "普通战斗表 1（本节所有地图）",
        tables: [
          {
            title: "第 1 套",
            lines: ["甲:同伴 HP 低于 40%时,用道具「测试药水」", "甲:其他情况,攻击"],
          },
        ],
      },
    ],
    boss: [
      {
        name: "测试首领",
        mapText: "12 测试地图",
        prepText: "先回复：是；先存档：是",
        tables: [{ title: "第 1 套", lines: ["甲:其他情况,攻击"] }],
        notes: "先防御",
      },
    ],
    turnBack: ["party.lowest_hp_pct < 30 → 重新规划"],
    turnBackEmptyText: "没有回头条件",
    report: {
      heading: "最近一份报告（测试神殿）",
      lines: ["状态：完成", "完成 2 站，开箱 1 个，战斗 3 场"],
      exceptionText: null,
    },
    reportEmptyText: "还没有执行报告",
    notes: "测试备注",
    warnings: [],
  };
}

function routeView(): ChapterRouteView {
  return {
    title: "章路线",
    status: "进行中",
    message: null,
    chapter: 1,
    goalText: "目标：走完测试章",
    startText: "从 地图 203「测试洞窟」(1,2) 出发",
    currentMapId: 203,
    currentCell: [1, 2],
    currentCellText: "(1,2)",
    maps: [
      { id: 203, name: "测试洞窟", text: "203 测试洞窟", stationCount: 2, current: true },
      { id: 205, name: "洞窟深处", text: "205 洞窟深处", stationCount: 1, current: false },
    ],
    segments: [
      {
        number: 1,
        section: "第一迷宫",
        stateText: "进行中",
        current: true,
        chestsText: "宝箱/隐藏道具 2 个：计划 2、已开 1、跳过 0（宝箱 1、隐藏 1）",
        distanceText: "总路程：1 跳、4 格、约 9 秒",
        unreachableText: null,
        stations: [
          {
            number: 1,
            segmentNumber: 1,
            label: "①",
            mapId: 203,
            mapText: "203 测试洞窟",
            cell: [1, 2],
            cellText: "(1,2)",
            unknownCell: false,
            candidates: [],
            candidateText: "",
            action: "开宝箱",
            why: "拿恢复药",
            kind: "chest",
            itemName: "恢复药",
            itemText: "恢复药",
            status: "done",
            statusText: "做完",
            note: "开了恢复药",
            current: false,
          },
          {
            number: 2,
            segmentNumber: 1,
            label: "②",
            mapId: 205,
            mapText: "205 洞窟深处",
            cell: [2, 2],
            cellText: "(2,2)",
            unknownCell: false,
            candidates: [],
            candidateText: "",
            action: "开宝箱",
            why: "拿隐藏道具",
            kind: "hidden",
            itemName: "隐形草",
            itemText: "隐形草",
            status: "current",
            statusText: "正在做",
            note: "",
            current: true,
          },
        ],
        legs: [
          {
            number: 1,
            fromNumber: null,
            fromLabel: "起点",
            toNumber: 1,
            toLabel: "①",
            text: "起点→①：测试洞窟，0 跳，2 格，约 1 秒",
            mapsText: "测试洞窟",
            mapIds: [203],
            hops: 0,
            cells: 2,
            seconds: 0.44,
            durationText: "约 1 秒",
            ok: true,
            reason: null,
            from: { map: 203, cell: [1, 2] },
            to: { map: 203, cell: [1, 2] },
          },
          {
            number: 2,
            fromNumber: 1,
            fromLabel: "①",
            toNumber: 2,
            toLabel: "②",
            text: "①→②：测试洞窟 → 洞窟深处，1 跳，2 格：走不到：地图记录里没有从地图 203 到地图 205 的出口路线",
            mapsText: "测试洞窟 → 洞窟深处",
            mapIds: [203, 205],
            hops: 0,
            cells: 0,
            seconds: 0,
            durationText: "",
            ok: false,
            reason: "地图记录里没有从地图 203 到地图 205 的出口路线",
            from: { map: 203, cell: [1, 2] },
            to: { map: 205, cell: [2, 2] },
          },
        ],
      },
    ],
    totalsText: "全程：1 跳、4 格、约 9 秒；有走不到的路段",
    emptyText: "这份章计划没有站点",
    warnings: [],
  };
}

function mapView(): ChapterRouteMapView {
  return {
    title: "路线地图",
    status: "第 1 章 · 203 测试洞窟",
    message: null,
    mapId: 203,
    mapName: "测试洞窟",
    width: 5,
    height: 5,
    origin: [0, 0],
    layer: 1,
    rows: ["00100", "00100", "00+00", "00100", "00100"],
    legendText: "# 墙 · . 可走 · + 隐藏通道 · : 另一层 · S 楼梯 · = 换层",
    maps: [
      { id: 203, name: "测试洞窟", text: "203 测试洞窟", stationCount: 2, current: true },
      { id: 205, name: "洞窟深处", text: "205 洞窟深处", stationCount: 1, current: false },
    ],
    stations: [
      {
        number: 1,
        segmentNumber: 1,
        label: "①",
        cell: [3, 2],
        cellText: "(3,2)",
        unknownCell: false,
        candidateText: "",
        action: "开宝箱",
        kind: "chest",
        itemName: "恢复药",
        status: "done",
        statusText: "做完",
        current: false,
      },
      {
        number: 2,
        segmentNumber: 1,
        label: "②",
        cell: [4, 2],
        cellText: "(4,2)",
        unknownCell: false,
        candidateText: "",
        action: "首领",
        kind: "boss",
        itemName: null,
        status: "current",
        statusText: "正在做",
        current: true,
      },
    ],
    paths: [
      {
        legNumber: 1,
        fromNumber: null,
        fromLabel: "起点",
        toNumber: 1,
        toLabel: "①",
        text: "起点→① 的这张图",
        points: [
          [1, 2],
          [2, 2],
          [3, 2],
        ],
        entryText: "起点 (1,2)",
        exitText: "到目标 (3,2)",
        ok: true,
        reason: null,
      },
    ],
    exits: [
      {
        cell: [4, 2],
        cellText: "(4,2)",
        to: 205,
        toName: "洞窟深处",
        text: "(4,2) → 205 洞窟深处（东门）",
      },
    ],
    party: { cell: [1, 2], cellText: "(1,2)", text: "队伍在 测试洞窟 (1,2)" },
    emptyText: "",
    warnings: [],
  };
}

async function loadPlanBlock(): Promise<{
  readonly render: (view: PlanPanelView, error: string | null) => unknown;
  readonly renderRoute: RenderRouteBlock;
  readonly storage: { value: string | null; readonly writes: string[] };
}> {
  const source = await readFile("src/client/index.ts", "utf8");
  const output = ts.transpileModule(
    `${source}\nexports.__test = { planBlock, chapterRouteBlock };\n`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const storage = {
    value: null as string | null,
    writes: [] as string[],
    getItem(): string | null {
      return storage.value;
    },
    setItem(_key: string, value: string): void {
      storage.writes.push(value);
      storage.value = value;
    },
  };
  const React: FakeReact = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? null,
      children,
    }),
    useState: <T>(initial: T): [T, (value: T) => void] => [initial, () => undefined],
    useEffect: () => undefined,
    useRef: <T>(initial: T): { current: T } => ({ current: initial }),
  };
  const context: Record<string, unknown> = {
    exports: {},
    require: (name: string): unknown => {
      if (name === "react") return React;
      throw new Error(`unexpected require ${name}`);
    },
    localStorage: storage,
    console,
  };
  context.globalThis = context;
  runInNewContext(output, context);
  const exported = context.exports as {
    __test?: { planBlock?: unknown; chapterRouteBlock?: unknown };
  };
  const render = exported.__test?.planBlock;
  assert.equal(typeof render, "function");
  const renderRoute = exported.__test?.chapterRouteBlock;
  assert.equal(typeof renderRoute, "function");
  if (typeof render !== "function" || typeof renderRoute !== "function") {
    throw new Error("client blocks were not exported");
  }
  return {
    render: render as (view: PlanPanelView, error: string | null) => unknown,
    renderRoute: renderRoute as RenderRouteBlock,
    storage,
  };
}

void test("the plan panel renders the plan, stations, dropped rows and folded tables", async () => {
  const { render, storage } = await loadPlanBlock();
  const tree = render({ title: "段计划", status: "执行中", message: null, plan: planView() }, null);
  assert.ok(isElement(tree));
  assert.equal(tree.type, "details");
  assert.equal(tree.props?.open, true);
  const text = textOf(tree);
  for (const wanted of [
    "段计划",
    "测试神殿",
    "目标：走完测试神殿",
    "本节第 2 份计划",
    "准备",
    "站点",
    "✓ 做完",
    "▶ 正在做",
    "不做的站",
    "普通战斗表 1",
    "首领",
    "回头条件",
    "最近一份报告",
  ]) {
    assert.match(text, new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.equal(findAll(tree, "details").length >= 3, true);
  assert.equal(findAll(tree, "table").length, 2);
  assert.deepEqual(storage.writes, []);
  const props = tree.props;
  assert.ok(props);
  const onToggle = props.onToggle;
  assert.equal(typeof onToggle, "function");
  if (typeof onToggle === "function") {
    (onToggle as (event: unknown) => void)({ currentTarget: { open: false } });
  }
  assert.deepEqual(storage.writes, ["0"]);

  storage.value = "0";
  const closed = render(
    { title: "段计划", status: "执行中", message: null, plan: planView() },
    null,
  );
  assert.ok(isElement(closed));
  assert.equal(closed.props?.open, false);
});

void test("a plan panel with no plan shows the Chinese message instead of throwing", async () => {
  const { render } = await loadPlanBlock();
  const tree = render(
    {
      title: "段计划",
      status: "还没有段计划",
      message: "还没有段计划",
      plan: null,
    },
    null,
  );
  assert.match(textOf(tree), /还没有段计划/u);
});

void test("the chapter route section shows numbered stations, chest items, legs and the map grid", async () => {
  const { renderRoute, storage } = await loadPlanBlock();
  const tree = renderRoute(routeView(), mapView(), null, null, "", () => undefined);
  assert.ok(isElement(tree));
  assert.equal(tree.type, "details");
  assert.equal(tree.props?.open, true);
  const text = textOf(tree);
  for (const wanted of [
    "路线",
    "从 地图 203",
    "全程：1 跳",
    "第一迷宫",
    "宝箱/隐藏道具 2 个",
    "①",
    "恢复药",
    "②",
    "隐形草",
    "站间路段",
    "走不到",
    "地图",
    "203 测试洞窟",
    "队伍在 测试洞窟",
    "隐藏通道",
    "本图路段",
    "起点 (1,2)",
    "出口",
  ]) {
    assert.match(text, new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.equal(findAll(tree, "polyline").length, 1);
  assert.equal(findAll(tree, "table").length, 0);
  assert.equal(findAll(tree, "button").length, 2);

  const unknownMap = {
    ...mapView(),
    stations: mapView().stations.map((row, index) =>
      index === 1
        ? {
            ...row,
            cell: [3, 3] as const,
            cellText: "格子未定",
            unknownCell: true,
            candidateText: "候选 (3,3) ガラフ",
          }
        : row,
    ),
  };
  const unknownTree = renderRoute(routeView(), unknownMap, null, null, "", () => undefined);
  assert.match(textOf(unknownTree), /\?/u);
  assert.match(textOf(unknownTree), /ガラフ/u);

  const props = tree.props;
  assert.ok(props);
  const onToggle = props.onToggle;
  assert.equal(typeof onToggle, "function");
  if (typeof onToggle === "function") {
    (onToggle as (event: unknown) => void)({ currentTarget: { open: false } });
  }
  assert.deepEqual(storage.writes, ["0"]);
});

void test("a missing route or map shows the Chinese message instead of throwing", async () => {
  const { renderRoute } = await loadPlanBlock();
  const tree = renderRoute(null, null, "读不了章路线", null, "", () => undefined);
  assert.match(textOf(tree), /读不了章路线/u);
  const noMap = renderRoute(routeView(), null, null, "读不了章路线地图", "", () => undefined);
  assert.match(textOf(noMap), /读不了章路线地图/u);
});

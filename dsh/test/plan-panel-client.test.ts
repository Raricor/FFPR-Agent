import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as ts from "typescript";
import type { PlanPanelView, PlanView } from "../src/plugin/plan-panel.ts";

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

async function loadPlanBlock(): Promise<{
  readonly render: (view: PlanPanelView, error: string | null) => unknown;
  readonly storage: { value: string | null; readonly writes: string[] };
}> {
  const source = await readFile("src/client/index.ts", "utf8");
  const output = ts.transpileModule(`${source}\nexports.__test = { planBlock };\n`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
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
    createElement: (type, props, ...children) => ({ type, props: props ?? null, children }),
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
  const exported = context.exports as { __test?: { planBlock?: unknown } };
  const render = exported.__test?.planBlock;
  assert.equal(typeof render, "function");
  return {
    render: render as (view: PlanPanelView, error: string | null) => unknown,
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
    { title: "段计划", status: "还没有段计划", message: "还没有段计划", plan: null },
    null,
  );
  assert.match(textOf(tree), /还没有段计划/u);
});

# 任务 96:阶段层③——出发检查、回头检查、采购单

工作目录 `dsh/`。**只许新建** `src/engine/stage/types.ts`(见共用结构，规则同下)、`src/engine/stage/gate.ts`、`src/engine/stage/purchase.ts`、`test/stage-gate*.test.ts`、`test/stage-purchase*.test.ts`;现有文件只读。另外两个任务 94、95 同时在 `src/engine/stage/` 里新建别的文件，不要碰。不碰 git,不连笔记本,**不用 docker、不绕开沙箱**。

## 起因

用户 11-10 定的：出发清单没备齐要**硬拦**(写理由才放行，和“本图没完成不让走”一样);进了副本，回头条件成立(比如治不了的状态、复活手段用完)要拦住继续深入。用户还提醒：判断能不能继续时要算上前面的**回复点**(火力船首领房门口有回复装置),前面能治就继续走到那里。

这三个都是纯函数，接线(挂到 `go`/`route`、存盘)另做。

## 共用数据结构(94、95、96 三个任务一字不差地共用)

文件 `src/engine/stage/types.ts`。**谁先开始谁新建，内容必须和下面一字不差**(另外两个任务可能同时在写同一个文件;已经存在就只读，不改;发现内容和这里不一致就停下在回报里说明)。

```ts
/**
 * Shared shapes of the stage layer (tasks 94/95/96, 11-10). A stage is one destination
 * (a dungeon or story place) with the town it starts from and the world map in between.
 */

export type Cell = readonly [number, number];

/** Where the stage goes: a map, an area name from the guide, or both. */
export interface StageTarget {
  readonly mapId: number | null;
  readonly areaName: string | null;
  readonly label: string;
}

export interface StageMonster {
  readonly id: number | null;
  readonly bookId: number | null;
  readonly name: string;
  readonly weak: readonly string[];
  readonly absorb: readonly string[];
  readonly statusMoves: readonly { readonly name: string; readonly conditions: readonly string[] }[];
  readonly blueMagic: readonly string[];
  readonly boss: boolean;
  readonly sources: readonly string[];
}

/** What the code puts in front of the stage officer. */
export interface StageFacts {
  readonly target: StageTarget;
  readonly monsters: readonly StageMonster[];
  readonly statusThreats: readonly {
    readonly status: string;
    readonly monsters: readonly string[];
    readonly likelihood: "high" | "medium" | "low" | "unknown";
  }[];
  readonly blueMagicMissing: readonly {
    readonly name: string;
    readonly monsters: readonly string[];
    readonly missable: boolean | null;
  }[];
  readonly chests: readonly {
    readonly label: string;
    readonly content: string | null;
    readonly mapId: number | null;
    readonly cell: Cell | null;
    readonly opened: boolean | null;
    readonly missable: boolean | null;
  }[];
  readonly savePoints: readonly { readonly mapId: number; readonly cell: Cell }[];
  readonly recoveryPoints: readonly { readonly mapId: number; readonly cell: Cell; readonly label: string }[];
  readonly shops: readonly {
    readonly area: string;
    readonly kind: string;
    readonly products: readonly { readonly name: string; readonly price: number | null }[];
  }[];
  readonly party: readonly {
    readonly name: string;
    readonly job: string;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    readonly mp: number;
    readonly maxMp: number;
    readonly status: readonly string[];
    readonly spells: readonly string[];
  }[];
  readonly bag: readonly { readonly name: string; readonly count: number }[];
  readonly gil: number;
  readonly bossNotes: readonly string[];
  readonly guideText: string;
}

export type TurnBack =
  | { readonly kind: "item-below"; readonly item: string; readonly count: number }
  | { readonly kind: "status-uncurable"; readonly status: string }
  | { readonly kind: "no-revive" }
  | { readonly kind: "hp-below"; readonly percent: number };

/** What the stage officer hands back; the code checks it before using it. */
export interface StagePlan {
  readonly threats: readonly string[];
  readonly supplies: readonly { readonly item: string; readonly min: number; readonly buyTo: number }[];
  readonly spells: readonly { readonly spell: string; readonly for: string | null }[];
  readonly gear: readonly string[];
  readonly jobs: readonly { readonly member: string; readonly job: string; readonly reason: string }[];
  readonly minLevel: number | null;
  readonly route: readonly {
    readonly to: string;
    readonly do?: "open" | "save" | "talk";
    readonly optional?: boolean;
  }[];
  readonly turnBack: readonly TurnBack[];
  readonly notes: string;
}
```

## 做法

1. **`departureCheck(plan, state)`** → `{ ok: boolean; unmet: string[] }`:`state` = `{ party, bag, gil }`(形状同 `StageFacts`)。逐项：`supplies` 每项背包数量 ≥ `min`;`spells` 已会;`jobs` 已换上;`minLevel` 达到。`unmet` 是中文一句一项。
2. **`turnBackCheck(plan, state, ahead)`** → `{ turnBack: boolean; reasons: string[]; continueTo: StageTarget | null }`:
   - 四种 kind:`item-below`(某道具少于 N)、`status-uncurable`(有人带着某状态，背包没药、没人会魔法)、`no-revive`(没有不死鸟之尾也没人会复活)、`hp-below`(全队平均 HP 低于百分比);
   - `ahead` = 路线上前面的回复点 / 存档点列表(带预计距离，格数);如果成立的条件**能在前面的回复点解决**(状态、HP),而且距离在常数以内，就 `turnBack: false`,`continueTo` 指向那个回复点，`reasons` 写清楚;
   - 解决不了才 `turnBack: true`。
3. **`purchaseList(plan, bag, gil, shopsHere)`** → `{ buy: {item, count, price}[]; skipped: string[] }`:按 `buyTo − 持有` 算要买的数量，只买 `shopsHere` 有卖的;钱不够时按优先级(先能治高威胁状态的药、复活道具，再别的)买到哪算哪，没买成的写进 `skipped`。
4. 所有文字中文;常数写在模块顶部，注释写出处。

## 测试

- 出发检查：全齐 / 缺药 / 缺魔法 / 职业不对 / 等级不够;
- 回头检查：四种条件各一例;状态治不了但前面 20 格有回复点 → 继续去回复点;没有回复点 → 回头;
- 采购：正常买齐;钱不够按优先级;本店不卖的进 `skipped`;
- `npm run check` 全过。

## 回报

不超过 25 行：新建了哪些文件、三个函数的规则和常数、`npm run check` 结尾、拿不准的地方。

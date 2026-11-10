# 任务 95:阶段层②——阶段官(子智能体)和计划检查

工作目录 `dsh/`。**可以新建** `src/engine/stage/types.ts`(见共用结构，规则同下)、`src/engine/stage/plan.ts`、`src/plugin/stage-officer.ts`、`test/stage-plan*.test.ts`、`test/stage-officer*.test.ts`;**可以改** `src/index.ts`(只加一行安装阶段官，照 `installTactician` 的样子)。其余现有文件只读。另外两个任务 94、96 同时在 `src/engine/stage/` 里新建别的文件，不要碰。不碰 git,不连笔记本,**不用 docker、不绕开沙箱**。

## 起因

用户 11-10 定的方向：一段路开始前，由“阶段官”一次想清楚这一段要带什么、学什么、怎么走、什么时候回头;之后代码执行，中途不再问 AI。出发清单没备齐要**硬拦**(用户定的)。

阶段官的做法照战术官(`src/plugin/tactician.ts`:dsh 子智能体、自己的预设和提示词、结构化结果按 schema 校验、检查不过打回重写、最多重试两次;任务 86 起可以在后台跑)。

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

1. **预设** `ffpr-stage-officer`(中文提示词):读事实单(任务 94 的 `describeStageFacts` 文字，这里当作输入字符串),交回 `StagePlan`。提示词要点：按状态威胁备药(数量要够这一段)、按弱点和首领准备魔法、要不要换职业(包括为学青魔法安排青魔法师)、最低等级、路线(`route` 的路标：可选宝箱、存档点、回复点、终点)、回头条件;不写泛泛的建议。**不写具体游戏攻略进提示词**,攻略只来自事实单。
2. **schema**:和 `StagePlan` 一致，按 dsh 子智能体结构化结果的方式校验(照战术官的写法)。
3. **`checkStagePlan(plan, facts): string[]`**(纯函数，在 `src/engine/stage/plan.ts`):返回问题列表，空表示通过。检查：
   - 要买的东西在 `facts.shops` 里有卖，或者背包里已经够;总价不超过 `facts.gil`(价格未知的单独提醒);
   - `spells` 在商店有卖或队伍已会;`jobs` 的成员在队伍里;
   - `route` 每个路标的 `to` 能按 `go`/`route` 的写法解析(地图号、地图名、"x,y"、"地图号:x,y");
   - `turnBack` 只用四种 kind,数值合理;
   - 状态威胁里 likelihood 为 high 的，计划里要有对应的药或魔法，否则算问题。
4. **`callStageOfficer(...)`**(在 `src/plugin/stage-officer.ts`):起子智能体、拿结构化结果、跑 `checkStagePlan`,不过就把问题附上打回，最多重试两次;返回 `{ plan, problems, text }`。接成工具(`plan_stage`)、和游戏流程接线不在这个任务里。
5. 在 `src/index.ts` 安装预设(一行)。

## 测试

- `checkStagePlan`:买不到、超预算、未知职业成员、坏路标、高威胁没准备、通过——各一例;
- `callStageOfficer`:用替身子智能体(照战术官测试的做法):第一次交坏计划被打回、第二次通过;
- `npm run check` 全过。

## 回报

不超过 25 行：新建/改了哪些文件、提示词的要点(列出来)、`checkStagePlan` 的规则、`npm run check` 结尾、拿不准的地方。

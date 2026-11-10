# 任务 94:阶段层①——事实单(这一段的怪、状态威胁、缺的青魔法、宝箱、商店……)

工作目录 `dsh/`。**只许新建** `src/engine/stage/types.ts`(见下面的共用结构)、`src/engine/stage/facts.ts`、`test/stage-facts*.test.ts`、`test/fixtures/stage/`;现有文件只读。另外两个任务 95、96 同时在 `src/engine/stage/` 里新建别的文件，不要碰它们的文件。不碰 git,不连笔记本,**不用 docker、不绕开沙箱**(`npm` 跑不起来就照以前拷到 `/tmp` 跑)。

## 起因

用户 11-10 定的方向：本能层要厚，AI 只在一段开始时规划一次。一段 = 一个目的地(副本、剧情地点)+ 出发的城镇 + 路上的世界地图。出发前由“阶段官”(子智能体，任务 95)按代码拼好的**事实单**交出“出发清单 + 路线 + 回头条件”,代码检查(任务 96)、采购、执行(`route` 工具，任务 89 已有)。

事实单要回答：这一段会遇到哪些怪、它们会放什么状态(11-09/10 两次带着黑暗走火力船)、哪些青魔法还没学且会不会错过(用户要求像图鉴一样规划青魔法)、有哪些宝箱(开没开、会不会错过)、存档点和回复点在哪(用户 11-10 提醒火力船首领房门口有回复装置)、附近商店卖什么、队伍和背包现在怎样、攻略对这一段怎么说(首领、走法)。

知识模块已经有了(任务 93,`src/engine/knowledge/`):`loadKnowledge`、`monstersIn`、`statusThreats`、`blueMagicSources`、`chestsIn`(可按 `areaName` 筛)、`shopsNear`、`itemsThatCure`、`missablesAfter`,结果都带来源。地图记录 `Atlas`、碰撞缓存 `CollisionStore` 在 `src/engine/atlas.ts`、`regions.ts`。

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

1. `buildStageFacts(input)`(纯函数，不碰游戏):输入是 `{ target: StageTarget; knowledge; atlas?; party; bag; gil; learnedBlueMagic?: string[] }`(队伍和背包由调用方读好传进来，形状照 `StageFacts.party`/`bag`)。
   - 怪：`monstersIn` 按 `mapId`/`areaName`;每只的弱点、吸收、会附带状态的招、能学的青魔法、是不是首领;
   - 状态威胁:`statusThreats`,并标出背包里有没有能治的道具(`itemsThatCure`)、队伍里有没有人会对应的魔法;
   - 青魔法：只列还没学的;
   - 宝箱:`chestsIn`;
   - 存档点、回复点：从地图记录里能认出的实体(`SavePoint` 等,`src/engine/completion.ts` 里有存档点的认法)和攻略正文里的提及;认不出就空，不要猜;
   - 商店:`shopsNear`(出发城镇和这一段路上的);
   - 首领说明和攻略正文：这一段对应的攻略章节，截到合理长度(常数，写注释)。
2. `describeStageFacts(facts): string`:给阶段官看的中文文字，分节、紧凑，总长有上限(常数);每条事实后面带来源简写(游戏数据 / 攻略 / 记录)。
3. 没有导出文件、只有攻略时也要能出事实单(来源全是攻略)。

## 测试

- 合成知识 + 合成队伍背包：怪、威胁(含“包里没有能治的”)、缺的青魔法、宝箱、商店都出现在 `StageFacts` 和文字里;
- 只有攻略时也能出;文字长度不超过上限;
- 本机有真实攻略缓存时(`.deps/knowledge/ff5/guide.json`,没有就跳过):目标“火力船”的事实单里至少有 3 种怪、至少 1 个宝箱;
- `npm run check` 全过。

## 回报

不超过 25 行：新建了哪些文件、`describeStageFacts` 对真实“火力船”的输出前 15 行(原文)、`npm run check` 结尾、拿不准的地方。

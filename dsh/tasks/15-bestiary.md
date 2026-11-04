# 任务 15:面板和 `/ach` 加上怪物图鉴的进度(按地点)

先读 `dsh/CLAUDE.md` 和 `dsh/tasks/13-achievements.md`、`14-achievement-panel.md`。这次改桥插件(C#)、引擎、前端三处。Python 版不动。

## 起因和前提

- 用户想在面板上看怪物图鉴的进度。
- 图鉴**没有按存档的进度**:游戏把它存在单独的文件里(`PictureBookSaveManager`),所有存档共用。P0 实测，读旧档不倒退、开新档不清零。
- 所以这一节明确标「全账号共用」。它要回答的是：还缺哪些怪、在哪里能碰到。

## 已查清的数据来源(反编译源码在 `.deps/ff5/decompiled/`,只读)

- **图鉴主数据** `Last.Data.Master.PictureBook`:
  - `Id`、`MonsterId`、`HabitatPointGroupId`、`ScenarioNumber`;
  - 现有的 `GameState.Bestiary()`(`GameState.Battle.cs`)已经在读它。图鉴上显示的编号来自 `PictureBookGroup`(`Groups()` 那段),共 302 个编号、370 项(一个编号可以有几项)。
- **出没地点**:
  - `PictureBook.HabitatPointGroupId` 指向 `Last.Data.Master.HabitatPointGroup`(`Id`、`GroupId`、`PointMax`、`BaseId`);
  - `Last.Data.Master.HabitatPoint`(`Id`、`AreaId`、`GroupId`、`PosX`、`PosY`)按 `GroupId` 归组。`HabitatPointGroup.GroupId` 和 `HabitatPoint.GroupId` 怎么对上，你查清楚，回报写出处;
  - `AreaId` 就是宝箱用的那个 `Area`。地点名照 `AreaName()` 取。
- **登记了没有**:`PictureBookSaveManager.Instance().SaveData.MonsterDefeats`(`Dictionary<int, int>`,怪物 id → 打倒数)。
  - 一项的 `MonsterId` 打倒数 > 0 就算登记;一个编号下任何一项登记了，这个编号就算登记。
  - **核对办法**:登记了的编号数，要等于账号层 `picture_book` 的 `current`。10-27 是 45。对不上就在回报里写出两边的数，不要硬凑。

## 1. 桥插件:`achievements` 回复里加 `bestiary`

放在顶层(和 `defs`、`account`、`save` 并列，因为它不属于存档):

```jsonc
"bestiary": {
  "entries": [ { "number": 10, "name": "风形魔", "registered": false, "areas": [8] } ],
  "areas": { "8": "风之神殿" }
}
```

- 一个编号一行，按 `number` 排序。
  - `name` 用这个编号第一项的怪物名;
  - `areas` 是这个编号各项出没地点的并集，去重排序。
- `areas` 只收 `entries` 里出现过的地点 id。名字取不到的写 `null`。
- 每一部分单独 try/catch,和现有写法一样;整个读不到时写 `null`。
- **只读**:不调 `Registration`、`Save`、`Update*`。
- 版本号改成 0.7.8。编译要 0 错误，不要装进游戏。

## 2. 引擎(`achievements.ts`)

- 解析 `bestiary`。
- `AchievementView` 加 `bestiary`:
  - `header`,例如「魔物图鉴(全账号共用) 已登记 45 / 302」;
  - `areas`:每个地点一项 `{ name, count, missing }`。
    - `count` 是「5 / 7」这样的文字，拿满了加 ✓;
    - `missing` 是这个地点还没登记的编号和名字，例如 `["No.012 风形魔", …]`。
  - 一个编号出没在几个地点，就在每个地点都算。
  - 地点按 id 排序;名字缺失写「地点 12」;同名地点合并成一行(和宝箱一样)。
  - 读不到时只给一句 `message`:「桥插件还读不到图鉴」。
- **`formatAchievements`(`/ach`)** 在成就表和宝箱之间加一节:
  - 表头是 `header`;
  - 表格 `| 地点 | 已登记 | 未登记 |`,未登记一列用「、」连起来。
- 前端照样不算任何东西，文字都在这里算好。

## 3. 前端(`src/client/index.ts`)

- 在成就表和宝箱之间加这一节：标题行是 `header`。
- 每个地点一行，用 `<details>`:
  - `<summary>` 里是地点名和 `count`;
  - 展开后列出 `missing`,每个一行，字号小一点;
  - 拿满了的地点不需要展开(没有 `missing`),只显示一行。
- 「只看未完成」勾上时，拿满了的地点也隐藏(成就表照旧)。
- 样式跟现有的一致。

## 测试

在 `test/achievements.test.ts` 或 `test/achievement-view.test.ts` 里加:

- 一个编号出没在两个地点，两边都算;
- 拿满的地点 ✓、没有 `missing`;
- 同名地点合并;
- `bestiary: null`;
- `/ach` 里出现图鉴那一节，表格正确;
- 现有测试全过。

## 回报

不超过 40 行，写清楚:
- 改了哪些文件;
- 桥插件编译、`npm run build`、`npm run check` 的结尾;
- `GroupId` 怎么对上的(出处);
- 拿不准的地方。

不要重启网页，不要装插件。

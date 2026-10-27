# 任务 13b:宝箱和隐藏道具按地点列出进度(接着任务 13)

先读 `dsh/CLAUDE.md` 和 `dsh/tasks/13-achievements.md`。在任务 13 的基础上改，Python 版不动。

## 起因

用户想看宝箱、隐藏道具**每个地点**的进度，不只是总数。

## 已查清的数据来源(反编译源码只读)

- **宝箱主数据** `Last.Data.Master.TreasureBox`:
  - `Id`;
  - `Flag`:这个宝箱的旗标号;
  - `GpsAreaId`:它属于哪个地点，游戏的地图画面就按这个分组;
  - `TreasureType`:宝箱或隐藏道具;
  - `Count`。
- **开没开**:`Last.Map.MapUIManager.GetTreasureFlag(int index)`,游戏自己的静态取值函数，参数大概就是 `TreasureBox.Flag`。
  - 核对办法：按它数出来的总数，要等于 `TresureBoxUtility.GetOpenChestCount()` 加 `GetOpenHiddenItemCount(false)`。
  - 对不上的话，在回报里写出两边的数，不要硬凑。
- **地点名**:`Last.Data.Master.Area`,字段 `Id`、`MapType`、`AreaName`。`AreaName` 多半是消息键，照现有写法用 `Text()` 转成中文。
  - `GpsAreaId` 是不是就是 `Area.Id`,源码里看不出来。先按 `Area` 取名，取不到写 `null`,真机由 Claude 核对。

## 1. 桥插件(`GameState.Achievements.cs`)

在 `save` 里加 `treasure`(去掉任务 13 的 `treasureTypes`,能从这里算出来):

```jsonc
"treasure": [
  { "area": 12, "name": "卡纳克城", "type": 1, "total": 5, "open": 3 }
]
```

- 按 (`GpsAreaId`, `TreasureType`) 分组，每组一行，按 `area`、`type` 排序。
- `open` 是 `GetTreasureFlag(Flag)` 为真的个数。
- `GetTreasureFlag` 抛异常时，`open` 写 `null`,`total` 照写。
- 版本号还是 0.7.6(还没装过)。编译要 0 错误。

## 2. 引擎(`achievements.ts`)

- 解析 `treasure`。
- 哪个 `type` 是宝箱、哪个是隐藏道具：在常量 `TREASURE_KINDS` 里写成 `{ chest: 1, hidden: 2 }`,注释写明这是待真机核对的猜测(10-27)。
- **`formatAchievements` 在成就表后面加一节**:

  ```
  **宝箱和隐藏道具(按地点)** 宝箱 22 / 225 · 隐藏道具 3 / 40

  | 地点 | 宝箱 | 隐藏道具 |
  | --- | --- | --- |
  | 风之神殿 | 6 / 6 ✓ | — |
  | 卡纳克城 | 3 / 5 | 0 / 1 |
  ```

  - 一个地点一行，按 `area` 排序。两类都没有的地点不列。
  - 某类在这个地点为 0 个时写「—」;拿满了加 ✓。
  - 地点名缺失时写「地点 12」。
  - `treasure` 缺失或 `null` 时，这一节只写一句「桥插件还读不到按地点的宝箱数」。

## 测试

在 `test/achievements.test.ts` 里加:

- 一个地点两类都有;
- 只有宝箱;
- 拿满了的 ✓;
- 地点名缺失;
- `open` 为 `null`;
- `treasure` 缺失。

## 回报

不超过 30 行：改了哪些文件、两边的编译和 `npm run check` 结尾、拿不准的地方。不要编译 TS,不要重启网页。

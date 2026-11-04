# 任务 17:面板加「策略」页，看当前的战斗策略

先读 `dsh/CLAUDE.md` 和 `dsh/tasks/14`、`16`。这次只改 TS(引擎、服务端、前端),桥插件不动。Python 版不动。

## 起因

用户想在面板上看到当前的战斗策略。新页签排在「宝箱」后面:「成就 / 图鉴 / 宝箱 / 策略」。

## 现有的数据(都在引擎里)

- **地图策略**:`engine.game.tactics`(`src/engine/tactics.ts`),来自 `tactics-ff5.json`。
  - 每张地图有 `tables`(1–3 套)、`current`(正在用第几套，从 0 数)、`results`(每场 `{ table, verdict, detail }`,`verdict` 是 `ok` / `hard` / `lost`)、`monsters`。
  - 一套规则表是 `{ 角色名: [规则…] }`,一条规则是 `{ if?, do, target? }`。
  - 例:`{ if: "ally.dead >= 1 and item.不死鸟之尾 >= 1", do: "道具:不死鸟之尾", target: "倒下的同伴" }`。
- **默认规则**:地图没有策略时，普通战斗用 `gambit.defaultTable(party)`(按职业)。
- **条件的写法**:`gambit.parse()`(`src/engine/skills/gambit.ts`)。只支持比较和「and / 且」,词表是 `VOCABULARY`、`OPEN_ENDED`。
- **战术官的走法说明和建议**:`Game` 里的 `tacticianInfoByMap`(在内存里，重启就没了)。现在只有 `tacticianInfo()` 能读，而且只给当前地图。
- **首领战**:`Game.settle()` 里，战术官写的首领规则表打完就丢了，没有存下来。

## 1. 引擎

### `Game`(`src/engine/game.ts`,只加不改行为)

- `tacticianInfoFor(mapId)`:任意地图的走法说明和建议。
- `mapNameOf(mapId)`:用现在 `mapName()` 的读法，按 id 查名字;`mapName()` 改成调它。
- `lastBossPlan()`:最近一场由战术官写表的首领战，形如 `{ mapId, table, result, at }`,没有就是 `null`。
  - 在 `settle()` 里拿到 `table` 并打完以后记下;`result` 就是现在拼出的 `fought` 那段文字。
  - 只存在内存里。

### 新文件 `src/engine/tactics-view.ts`

纯函数，不碰笔记本。

- **`describeCondition(text)`**:把条件翻成中文，用 `gambit.parse` 拆开:

  | 词 | 中文 |
  | --- | --- |
  | `self.hp` / `self.hp_pct` / `self.mp` | 自己 HP / 自己 HP% / 自己 MP |
  | `ally.hp_pct` | 同伴最低 HP% |
  | `ally.dead` | 倒下的同伴 |
  | `party.alive` | 活着的人 |
  | `enemy.count` | 敌人数 |
  | `enemy.boss` | 首领战 |
  | `enemy.hp_pct` | 敌人最低 HP% |
  | `enemy.weak.冰` / `enemy.absorbs.冰` | 弱冰的敌人 / 吸收冰的敌人 |
  | `turn` | 第几次行动 |
  | `item.X` | X(背包数量) |
  | `ally.status.X` / `self.status.X` | X 状态的同伴 / 自己 X 状态 |

  - 比较符写成 ≥ ≤ = ≠ < >,子句之间用「且」;没有比较符的子句只写词，比如「首领战」。
  - 例:`ally.dead >= 1 and item.不死鸟之尾 >= 1` 写成「倒下的同伴 ≥ 1 且 不死鸟之尾 ≥ 1」。
  - `parse` 报错时原样返回原文。
- **`describeRule(rule)`**:「条件 → 行动(目标)」。没有条件写「其他情况 → 攻击」;没有目标就不写括号。
- **`tacticsView(input)`**:输入是当前地图 id(可能为 `null`)、队伍(给默认规则用)、是否在战斗中、`Tactics`、`Game` 上面那几个读函数。返回:

```ts
interface RuleTableView { title: string; inUse: boolean; members: { name: string; rules: string[] }[] }
interface MapTacticsView {
  mapId: number;
  name: string;        // 地图名，查不到写「地图 261」
  summary: string;     // 「3 套策略，正在用第 2 套」或「没有专属策略，普通战斗用默认规则(按职业)」
  tables: RuleTableView[];
  results: string[];   // 最近的在前，最多 8 条:「策略 1 · 吃力:巴兹倒下」(ok 顺利、hard 吃力、lost 全灭)
  notes: string[];     // 「走法:…」「建议:…」,有才有
}
interface TacticsPanelView {
  status: string;      // 「当前地图：火力船 机房 · 战斗中」;地图不明时「读不到当前地图」
  current: MapTacticsView | null;
  boss: { title: string; table: RuleTableView; result: string } | null;  // title 如「最近一场首领战(火力船 机房)」
  others: MapTacticsView[];  // 其他有策略的地图，按地图 id 排序，不含当前地图
}
```

  - 当前地图没有策略时，`tables` 只放一套默认规则，标题「默认规则(按职业)」,`inUse: true`。
  - 地图策略的标题是「策略 1」「策略 2(正在用)」。

## 2. 服务端：路由 `GET /api/ffpr/tactics`(`src/plugin/panel.ts`)

- 和成就那条路由一样，注册在同一个可选的 `connection` 下面。
- 每次查一次桥插件的 `sample`,取:
  - `user.mapId`(当前地图);
  - `party`(默认规则要用);
  - 战斗中没有(`battle` 有值，或 `pos` 的 state,照 `Game.settle` 的判断)。
- 返回 `{ ok: true, view, at }`。
- **连不上桥插件时**照样返回 `ok: true`:`current: null`,`status` 写「连不上桥插件，游戏可能没开」,`others` 照常给，这样还能看已存的策略。
- 请求的 `signal` 一路传下去;`Cache-Control: no-store`。

## 3. 前端(`src/client/index.ts`)

- 页签加「策略」,放在最后。选中时每次刷新也取 `api/ffpr/tactics`,和成就那条一起取(同一个计时器、同一个刷新按钮)。没选中策略页时不取。
- 「只看未完成」在这一页不显示。
- 版面从上到下:
  1. `status`;
  2. 当前地图：标题是地图名，下面是 `summary`;
     - `inUse` 那套展开显示：每个角色一个小标题，下面是编号的规则列表;
     - 别的那几套用 `<details>` 收起;
  3. 「最近的战斗」:`results`,吃力的橙色、全灭的红色;
  4. 战术官的 `notes`;
  5. `boss`:有才显示，规则表照 2 的样子;
  6. 「其他地图的策略」:每张地图一个 `<details>`,summary 是名字和 `summary`,展开后和当前地图一样。
- 样式和别的页一致，规则列表的字号 12px。

## 测试

- **`describeCondition`**:例子那条;「首领战」;`enemy.weak.冰`;`self.status.毒`;`parse` 报错时原样返回。
- **`describeRule`**:有目标、没有目标、没有条件。
- **`tacticsView`**:
  - 有策略的地图，第 2 套在用;
  - 没有策略时用默认规则;
  - `results` 倒序，最多 8 条;
  - `notes`;
  - `boss`;
  - `others` 不含当前地图;
  - 地图 id 为 `null`。
- **路由**:成功;连不上时 `current: null`、`others` 照给。
- **`Game.lastBossPlan`**:用现有的 game 测试替身，打一场首领战后记下了。如果太难测，说明原因。
- 现有测试全过。

## 回报

不超过 40 行：改了哪些文件、`npm run build` 和 `npm run check` 的结尾、拿不准的地方。不要重启网页。

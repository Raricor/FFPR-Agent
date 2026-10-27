# 任务 18:策略拆成独立的右侧栏标签;策略页加「敌人」

先读 `dsh/CLAUDE.md` 和 `dsh/tasks/14`、`16`、`17`。只改 TS,桥插件不动。Python 版不动。

## 起因(用户 10-27 的两点意见)

1. **策略和成就是同一级的。** 现在「策略」是「FF5 成就」面板里的第 4 页，上面还顶着成就的进度，层级不对。
2. **策略只有角色，和敌人无关。** 规则表按队员列，看不出是冲着哪些怪写的、对每种怪会怎么打。

## 1. 拆成两个标签(`src/client/index.ts`)

- **「FF5 成就」**:保留成就 / 图鉴 / 宝箱三页，去掉「策略」页。
  - 存下来的页签值是 `strategy` 时退回「成就」。
- **「FF5 策略」**:新的标签类型。
  - `id: "@local/ffpr-dsh/tactics"`(每个注册要有自己的 id,内容组件的 slot key 也用它);
  - `kind: "ffpr-tactics"`,`title: () => "FF5 策略"`;
  - guide 一项:「FF5 策略」/「当前地图的战斗策略和敌人」,`order: 71`。
- **策略标签的版面**:
  - 自己的顶部：标题「FF5 策略」、刷新按钮、`status`、「更新于」;
  - 下面就是任务 17 的内容，加上第 2 节的「敌人」。
  - 不显示成就的数字。
- **刷新**:每个标签各自计时，30 秒一次。各自只取自己的路由：成就标签取 `achievements`,策略标签取 `tactics`。
- **自动打开**:两个标签各自「每个会话打开一次」,`localStorage` 的键分开(策略用 `ffpr-dsh.tactics.opened.<会话>`)。
  - 两个都要开时，依次 `openTab`;第二个失败也照样按 200ms 重试 3 次。
- 两个组件尽量共用代码(取数据、刷新、表格的写法),不要复制一大段。

## 2. 策略页的「敌人」(`src/engine/tactics-view.ts`)

`MapTacticsView` 加 `enemies: EnemyView[]` 和 `enemyNote: string`:

```ts
interface EnemyView {
  label: string;   // 「No.038 喧嚣鬼」;查不到编号就只写名字
  facts: string;   // 「HP 240 · 弱：水、风 · 吸收：冰 · 无效：火、雷、土、毒、圣」,没有的不写
  plan: string[];  // 每个队员遇到它的第一招:「法利斯：黑魔法:火炎(打弱点)」
}
```

### 哪些怪

- **当前地图**,按顺序去重:
  1. 这张地图已经遇到过的(`engine.game.events?.enemies.get(mapId)`);
  2. 写策略时记下的(`tactics.monstersSeen(mapId)`);
  3. 这一带会出现的：图鉴里 `areas` 包含 `sample.user.areaId` 的编号。
- **世界地图**(地点号 0,或地图 1)只用 1 和 2:那里有 102 种，太多。
- **其他地图**只用 1 和 2。
- 名字对编号：用怪物资料缓存(`MonsterCache`,任务 16)里的 `name`。同名取编号最小的。
- 怪物资料还没取到时,`facts` 为空字符串，照样列出名字。

### 每个队员的第一招(推演)

- 用 `gambit.choose(这个队员的规则, new gambit.Situation(...))`,局面是:
  - 队伍：用 `sample.party`,但每人 HP 设成满的(`hp = maxHp`),MP 照实;
  - 敌人：只有这一只，满 HP。名字用怪物名，`hp`、`maxHp` 用怪物资料的 HP;
  - 第 1 回合;`boss` 照怪物资料;
  - 道具：当前背包，用现有的 `items` 查询，照 `battle.ts` 里组 `items` 的写法;
  - 属性知识:`engine.game.elements`。
- 写成「角色：行动」。如果行动是带属性的法术(`gambit.elementOf`):
  - 这只怪吸收这个属性，加「(它吸收X!)」;
  - 怪弱这个属性，加「(打弱点)」;
  - 属性按怪物资料判断。
- 「最强」「治疗+」这类，能用现有的 `gambit.abilityCandidates` 加队员的 `abilities` 算出具体法术，就写出来，例如「黑魔法:最强 → 火炎(打弱点)」;算不出就照写原文。
- 用的是正在用的那套规则;没有地图策略时用默认规则。
- `enemyNote` 写:「按全员满 HP、第一回合、只有这一只敌人推演」。

### 服务端(`src/plugin/panel.ts` 的 tactics 路由)

- 多查一次 `items`。`sample` 里的 `user.areaId` 和 `party` 传给 `tacticsView`。
- 怪物资料用 `index.ts` 里那个共用的 `MonsterCache`。
- 图鉴的 `areas` 要用 `achievements` 回复里的 `bestiary`:
  - 不要每 30 秒为这个再查一次整份 `achievements`;
  - 在插件进程里缓存，和怪物资料一样。登记状态这里用不到，地点是静态的。
  - 读不到时就只用 1 和 2。

## 3. 前端：敌人一节

- 放在当前地图的规则表下面，标题「敌人」,下面一行小字是 `enemyNote`。
- 每只怪一个 `<details>`:
  - summary 是 `label` 和 `facts`(facts 小一点、淡一点);
  - 展开后是 `plan`,每行一个;「它吸收」的那行用红色。
- 其他地图展开后也有这一节(没有就不显示)。

## 测试

- **`tacticsView` 的敌人**:
  - 三个来源的顺序和去重;
  - 世界地图不用图鉴;
  - 推演出的第一招;
  - 「它吸收X!」和「打弱点」;
  - 资料缺失时只有名字。
- **路由**:多查了 `items`;图鉴地点只取一次(缓存)。
- 现有测试全过。

## 回报

不超过 40 行：改了哪些文件、`npm run build` 和 `npm run check` 的结尾、拿不准的地方。不要重启网页。

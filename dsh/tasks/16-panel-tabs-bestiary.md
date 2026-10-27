# 任务 16:面板分页;图鉴加「不可再获得」和每只怪的详细介绍

先读 `dsh/CLAUDE.md` 和 `dsh/tasks/13`–`15`。改桥插件(C#)、引擎、服务端、前端四处。Python 版不动。

## 起因

用户要三件事:
1. 面板分成「成就 / 图鉴 / 宝箱」三页;
2. 图鉴也标出「不可再获得」;
3. 图鉴里每只怪有详细介绍。

## 1. 桥插件：新查询 `monsters`(静态的怪物资料)

新文件 `bridge/src/GameState.Monsters.cs`。`Requests.cs` 加 `case "monsters"`,回复放在 `reply["monsters"]`。

- 一个图鉴编号一行，按编号排序。
- 用这个编号**第一项**(`PictureBook` 按 `Id` 排序)的 `MonsterId`,读 `Last.Data.Master.Monster`:

```jsonc
{ "number": 38, "monster": 121, "name": "喧嚣鬼", "lv": 17, "hp": 240, "mp": 0, "exp": 300, "gil": 120,
  "boss": false, "species": 3,
  "resistanceAttribute": 12, "attributes": [ { "id": 2, "name": "冰", "type": 4 } ],
  "resistanceCondition": 5, "conditions": ["石化", "即死"],
  "drops": ["药草"], "steals": ["凤凰之尾"] }
```

- **属性**:`Monster.ResistanceAttribute` 是 `Last.Data.Master.AttributeGroup` 的 `GroupId`。
  - 每行有 `AttributeId`、`TypeId`、`MesIdName`。`TypeId` 就是 `ResistanceAttributeType`(`decompiled/` 里能搜到):1 弱、2 减半、3 无效、4 吸收，还有 401–403。
  - 名字可能在 `AttributeGroup.MesIdName`,也可能要另查属性表，你查清楚，回报写出处。
  - `type` 为 0(普通)的不列。
- **状态免疫**:`Monster.ResistanceCondition` 是 `ConditionGroup` 的 `GroupId`。每行的 `ConditionId` 指向 `Condition`,名字是 `Condition.MesIdName`。
- **掉落**:`DropContentId1..8`;**偷窃**:`StealContentId1..4`。都是 `Content` 的 id,名字是 `Content.MesIdName`。0 跳过，同名去重。
- 名字都用现有的 `Text()` 转中文，去掉 `<IC_…>` 图标标记。
- `resistanceAttribute`、`resistanceCondition`、`species` 的原始值照写，给 Claude 核对用。
- 每个字段单独 try/catch,读不到写 `null`。只读，不调任何会改状态的函数。
- 版本号改成 0.7.9。编译要 0 错误，不要装进游戏。

## 2. 引擎(`src/engine/achievements.ts`,或者拆出 `src/engine/bestiary.ts`,一个文件管一件事)

### 怪物资料

- 解析 `monsters` 回复。
- 每只怪的介绍做成几行中文(空的那行不出):
  1. `Lv 17 · HP 240 · MP 0 · 经验 300 · 金钱 120`,首领加「· 首领」;
  2. `弱点：冰、雷 · 减半：… · 无效：… · 吸收：…`(401–403 分别写「双倍弱点」「大幅减半」「吸收(物理为弱点)」);
  3. `状态免疫：石化、即死…`,最多 8 个，多了写「等 N 种」;
  4. `掉落：… · 偷窃：…`;
  5. `出没：火力船、沃尔斯塔`(来自 `bestiary` 的地点，用 `habitatName`);
  6. `攻略：…`:`engine.game.guide?.monsterNote(编号)`,有才写(是英文，原样);
  7. 错过的说明(见下)。
- **缓存**:资料是静态的。第一次取成功后缓存在插件进程里，`/ach` 和面板路由共用一份。
  - 取不到时这次不带介绍，下次再试。
  - 缓存对象在 `index.ts` 里建一个，传给 `installCommands` 和 `installPanel`。

### 不可再获得

图鉴是全账号的，这里说的是**这个存档**再也碰不到。新常量 `BESTIARY_MISSABLES`,照抄下表(来源：本地的 Steam 错过物品攻略，地点号来自 10-27 真机):

```ts
// numbers: 图鉴编号; areas: 攻略说的那个地点; until: 提醒文字; past: 一定在时限之后的剧情成就
[
  { numbers: [191, 192], areas: [11], until: "离开托纳运河前", past: "scenario_3" },
  { numbers: [233], areas: [15], until: "北山首领战里让玛基莎把它召唤出来", past: "scenario_3" },
  { numbers: [28, 29], areas: [71], until: "打倒沃尔斯塔顶的首领前", past: "scenario_3" },
  { numbers: [27], areas: [66, 71], until: "打倒两歧塔首领前(沃尔斯塔之后还有一次机会)" },
  { numbers: [41, 42, 43, 44, 238], areas: [24], until: "火力船首领后的 10 分钟逃脱里", past: "scenario_5" },
  { numbers: [62, 64, 65, 66, 67, 68, 69], areas: [34], until: "打倒隆卡遗迹首领前", past: "scenario_7" },
  { numbers: [76, 77, 78, 79], areas: [54], until: "大桥的战斗结束前", past: "scenario_10" },
  { numbers: [263], areas: [0], until: "泽扎的船队上，等吉尔伽美什召唤它再打倒吉尔伽美什", past: "scenario_10" },
  { numbers: [106, 107, 108, 109, 110, 111, 112], areas: [57], until: "打倒屏障之塔首领前", past: "scenario_10" },
  { numbers: [122], areas: [79, 86], until: "慕亚大森林变化前", past: "scenario_11" },
  { numbers: [71, 72], areas: [40], until: "艾克斯迪司城地下室，解除幻术前", past: "scenario_11" },
  { numbers: [30, 82, 121, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 158, 255, 271, 272, 273],
    areas: [40], until: "打倒十三层的艾克斯迪司前", past: "scenario_11" },
  { numbers: [162, 163, 164, 165, 166, 167], areas: [66, 67, 68], until: "打倒两歧塔首领前" },
]
```

每只**没登记**的怪，按它所在的那一条判断:

| 情况 | 状态 |
| --- | --- |
| `past` 的剧情旗标已立(用现有的 `storyPassed`),**并且**它的出没地点全都在 `areas` 里 | 「不可再获得」 |
| 没有 `past`,或旗标还没立 | 「限时:<until>」 |
| 旗标已立，但游戏记录它在别处也出现 | 不标 |

- 第三种情况：游戏的出没数据和攻略对不上，就不能断定错过了。宁可不标，也不错标。
- 状态同时写进介绍的第 7 行。
- 注释写明这三条规则和原因(10-27:地点号会复用，比如 71 号也是第三世界的沉没的沃尔斯塔)。

### 视图

- `AchievementView.bestiary` 改成:
  - `header`:「魔物图鉴(全账号共用) 已登记 45 / 302 · 这个存档已错过 N 只」,N 为 0 时不写后半句;
  - `areas`:每个地点 `{ name, count, done, monsters }`。
    - `monsters` 是这个地点**所有**的怪(不只是没登记的),每只 `{ label, registered, status, details }`;
    - `label` 如「No.041 中士」,`status` 是上面的状态文字或 `null`,`details` 是介绍的那几行;
    - `count` 照旧;有不可再获得的，加「· 已错过 N」。
- 宝箱的 `places` 每项加 `done`(拿满了)。
- **`/ach`(Markdown)不放介绍**,太长。图鉴表改成 `| 地点 | 已登记 | 未登记 | 不可再获得 |`,未登记那列照旧，不可再获得列写编号。

## 3. 前端(`src/client/index.ts`)

- **顶部**:标题和 `summary` 两行、「更新于」、刷新按钮保持在最上面，不随分页变。
- **页签**:下面一排「成就 / 图鉴 / 宝箱」,选中的那个存 `localStorage`(包 try/catch),默认「成就」。
- **「只看未完成」**放在页签下面，三页都管用:
  - 成就：只看没达成的;
  - 图鉴：只看没登记的怪，拿满的地点隐藏;
  - 宝箱：拿满的地点隐藏。
- **图鉴页**:
  - 每个地点一个 `<details>`(summary 是名字和 `count`,照现在的写法，保留展开的小三角);
  - 里面每只怪又是一个 `<details>`:summary 是 `label`,登记了的打 ✓ 并淡一点，有 `status` 的在后面加一个小标签;
  - 展开后是 `details` 的几行，字号小一点。
- **颜色**:「不可再获得」「已错过」用红色(#d64545),「限时」用橙色(#d9822b),深浅主题都要看得清。宝箱页「已错过」也改成红色。

## 测试

- **桥插件**:编译通过即可。
- **引擎**:
  - 介绍的每一行(空行不出、免疫超过 8 个、首领、401–403);
  - 不可再获得的三种情况，各写一个;
  - 已登记的不标;
  - 缓存：第一次失败、第二次成功;两次成功只查一次;
  - `/ach` 图鉴表的新列;
  - 现有测试全过(图鉴相关的断言随新结构改，别的不动)。
- **前端**:不写单元测试。

## 回报

不超过 40 行，写清楚:
- 改了哪些文件;
- 桥插件编译、`npm run build`、`npm run check` 的结尾;
- 属性名从哪读的(出处);
- 拿不准的地方。

不要重启网页，不要装插件。

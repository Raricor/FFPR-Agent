# 任务 13:当前存档的成就进度(`/ach` 命令)

先读 `dsh/CLAUDE.md`。这次改两处：桥插件(C#,`bridge/`)和 TS 版(`dsh/`)。Python 版不动。

## 起因

用户想在 dsh 网页上看到**这个存档**的成就进度，而不是 Steam 账号的整体进度。

- 两者不一样:Steam 记的是「有没有解锁过」,哪个存档解锁的都算;读一个早期存档，Steam 不会倒退。
- 游戏里也有一份账号层的进度(`AchievementManager.values`,和 Steam 同步)。所以本档进度要从存档数据里自己算。
- P0 实测：击杀数、图鉴是账号层累计的(开新档不清零)。可是游戏菜单的「游玩数据」页按存档显示击败数，所以存档里另有一份。

## 已查清的数据来源(反编译源码在 `/root/data/mediaflow/FFPR-Agent/.deps/ff5/decompiled/`,只读)

- **成就主数据**:`MasterManager.GetList<Last.Data.Master.Achievement>()`,返回 `Dictionary<int, Achievement>`。
  - 字段:`Id`、`Type`、`Value`(目标值)、`ConditionValue`、`AchievmentId`(就是 Steam 的 API 名)、`PlatformType`。
  - `Type` 对应 `AchievementManager.Type` 枚举(Scenario=1、OwnedGil、MonsterSubjugationCount……共 21 种)。
- **账号层**:`SingletonMonoBehaviour<Last.Management.AchievementManager>.instance.values`,类型是 `List<AchievmentSaveData>`。
  - 字段:`achievmentId`、`achieved`、`progressCurrentValue`、`progressMaxValue`、`achievmentName`、`achievmentDescription`、`type`、`conditionValue`。
- **存档层**:`Last.Management.UserDataManager.instance`:
  - `PlayTime`(秒)、`SaveCompleteCount`、`OwendGil`、`TotalGil`、`MonstersKilledCount`、`BattleCount`、`OpenChestCount`;
  - `OwnedCharacterList`:每人 `Id`、`Name`、等级(照 `GameState.Party.cs` 现有的读法)、`OwnedJobDataList`(每个职业的 `Id`、`Level`);
  - `ReleasedJobs`(`List<Job>`,取 `Id`);
  - `OwnedMagicList`(`HashSet<int>`,技能 id)。
- **宝箱**:`Last.Map.TresureBoxUtility.GetOpenChestCount()`、`GetOpenHiddenItemCount(false)`。两个都是游戏自己的静态取值函数。
  - 主数据 `Last.Data.Master.TreasureBox` 有 `TreasureType`(宝箱和隐藏道具各是一种值)。
- **剧情旗标**:`Last.Interpreter.DataStorage.instance.Get(DataStorage.Category.kScenarioFlag1..4, index)`。
- **职业精通**:游戏自己的 `Serial.FF5.Management.JobInfomationData.IsJobMaster(OwnedCharacterData, jobId)`。
  - 实例大概要从 `Serial.Template.Management.JobInfomationProvider` 的 `serialData` 拿，你查清楚。
  - 实在拿不到，`mastered` 写 `null`,回报里说明。
- **成就中文名**:`dsh/tasks/13-ff5-steam-achievements.json`,一共 39 条，是 Steam 公开成就页的简体中文(`api_name`、`name`、`description`、`hidden`)。
  - API 名带着目标值，比如 `treasure_box_225` 就是全部 225 个宝箱。

## 1. 桥插件：新查询 `achievements`(新文件 `bridge/src/GameState.Achievements.cs`)

在 `Requests.cs` 里加 `case "achievements"`,回复放在 `reply["achievements"]`,形状如下:

```jsonc
{
  "defs": [ { "id": 1, "api": "scenario_1", "type": 1, "typeName": "Scenario", "value": 1, "condition": 6, "platform": 1 } ],
  "account": [ { "api": "scenario_1", "achieved": true, "current": 1, "max": 1, "name": "…", "description": "…" } ],
  "save": {
    "playTime": 12345, "saveCount": 25, "gil": 3036, "totalGil": 155798, "kills": 312, "battles": 280,
    "chests": 22, "openChestCount": 22, "hiddenItems": 3,
    "treasureTypes": { "1": 225, "2": 40 },
    "members": [ { "id": 1, "name": "巴兹", "level": 22, "jobs": [ { "id": 1, "level": 3, "mastered": false } ] } ],
    "releasedJobs": [1, 2, 3],
    "magicTypes": { "1": { "total": 32, "owned": 6 } },
    "flags": { "6": [1, 0, 0, 0] }
  }
}
```

- **`defs`**:主数据全部行，按 `id` 排序。
- **`account`**:`values` 的每一条。`values` 还没有时(标题画面)写 `null`。
- **`save`**:没读档时(`UserDataManager` 没有角色)写 `null`。
  - `treasureTypes`:主数据 `TreasureBox` 按 `TreasureType` 数行数。
  - `magicTypes`:主数据 `Ability` 按 `TypeId` 分组。`total` 是行数,`owned` 是其中 id 在 `OwnedMagicList` 里的个数。
  - `flags`:`defs` 里 `typeName` **不是**下面这些计数类型的每个 `condition`,各读 `kScenarioFlag1..4` 四个值:
    - `OwnedGil`、`SlotTotalGil`、`MonsterSubjugationCount`、`PictureBookComplete`、`ChestComplete`、`HiddenItems`;
    - `MemberLevel`、`JobMasters`、`LearningBlueMagic`、`AllComplete`。
- 每一项单独 try/catch,一项读不到写 `null`,不影响其他项。写法照 `GameState.Bestiary()`。
- **只读**:只调用取值函数和纯计算，不调用任何 `Update*`、`SetProgress`、`Upload*`。
- 版本号改成 0.7.6(`bridge/src/Plugin.cs`)。
- 编译：在 `/root/data/mediaflow/FFPR-Agent` 下运行 `~/.dotnet/dotnet build bridge -c Release -p:Game=ff5 -nologo -v:q`,要 0 错误。不要装进游戏(Claude 来装)。

## 2. 引擎：`src/engine/achievements.ts`(新文件，不 import dsh)

- **`ACHIEVEMENTS`**:把那份 JSON 写成 TS 常量表(`api`、`name`、`description`、`hidden`),顺序照 JSON。不要运行时读文件。
- **`parseAchievements(reply: unknown)`**:检查形状，收窄成类型。缺字段或 `null` 照实保留，不报错。
- **`progressRows(data)`**:每个成就一行，内容是：
  - 名字、条件(Steam 描述);
  - **本档**:`{ current, target, done }`,或「读不到」;
  - **Steam**:`account` 里的 `achieved`。
  - 以主数据 `defs` 为准(按 `api` 对上名字表);名字表里有、`defs` 里没有的也列出来，本档写「读不到」。
- **本档进度的算法，按 `typeName` 一张表(`SAVE_RULES`)**:

  | typeName | current | target |
  | --- | --- | --- |
  | `SlotTotalGil` | `save.totalGil` | `value` |
  | `OwnedGil` | `save.gil` | `value` |
  | `MonsterSubjugationCount` | `save.kills` | `value` |
  | `ChestComplete` | `save.chests` | `value` |
  | `HiddenItems` | `save.hiddenItems` | `value` |
  | `MemberLevel` | 全体角色里最低的等级 | `value` |
  | `JobMasters` | 至少一人精通了的职业种数(按职业 id 去重) | `value` |
  | `Scenario` | `flags[condition][0]` 不为 0 记 1,否则 0 | 1 |
  | `AllComplete` | `account` 里已解锁的个数(不算它自己) | 成就总数减 1 |
  | `PictureBookComplete` | 图鉴是全账号共用的：用 `account` 的 `current`,标注「全账号」 | `value` |

  - `done` 就是 `current >= target`。
  - 表里没有的类型(`LearningBlueMagic`、`SpecificItems` 等),本档写「读不到」。Claude 拿到真机数据后再补上。
  - `value` 是 0 或缺失时，用 API 名末尾的数字当目标。
- **`formatAchievements(data)`**:给用户看的 Markdown,大致这样:

  ```
  **FF5 成就 · 当前存档**(游戏时间 21:13:05,存过 25 次)
  本档达成 9 / 39 · Steam 已解锁 12 / 39

  | 成就 | 条件 | 本档 | Steam |
  | --- | --- | --- | --- |
  | 旅行的决心 | 救助了蕾娜和加拉夫并一同踏上了旅程。 | ✓ | ✓ |
  | 新手宝物猎人 | 宝箱的回收率达到了10%。 | 22 / 21 ✓ | ✓ |
  | 老练宝物猎人 | 宝箱的回收率达到了50%。 | 22 / 112 | — |
  | 魔物图鉴·基础知识篇 | … | 45 / 30 ✓(全账号) | ✓ |
  | 传说中的武器 | … | 读不到 | — |
  ```

  - **表后的说明**,只在相关时出现:
    - 「击杀：本档 312 只;Steam 的击杀数是全账号累计的」;
    - 「图鉴全账号共用，没有本档进度」;
    - 有「读不到」时说一句「桥插件还读不到这些成就的本档进度」。
  - `save` 是 `null` 时只说「还没读档，只能看 Steam 的解锁情况」,表里本档一列写「—」。
  - 金钱、击杀数加千位分隔符。

## 3. 命令 `/ach`(`src/plugin/commands.ts`,新文件)

- 用 dsh 的 `ctx.commands.register`(`@deepseek-ai/dsh-commands`,接口在 `lib/types/index.d.ts`)。
  - `name: "ach"`,`description: "当前存档的成就进度(对照 Steam 解锁情况)"`。
  - handler 不经过模型：用 `createPilot(engine.laptop, engine.bridge, invocation.signal)` 发 `achievements` 查询，再 `formatAchievements`,返回 `{ kind: "success", text }`。
- 连不上桥插件(游戏没开)时直接返回 `{ kind: "error", text: "连不上桥插件，游戏可能没开" }`。
  - 不要用 `HealthWaiter` 等;报错消息照 `reasonOf` 的风格，不带命令行和密钥。
- 只在玩家这一侧装(`index.ts` 里 `role !== "tactician"` 那条路)。`inject` 加上 `"commands"`。
  - 注册挂在插件的 `ctx` 上，卸载时自动清掉(`register` 返回的就是 disposer,`ctx.effect` 包住)。
- 不给模型加工具，不改提示词。

## 测试

- **`test/achievements.test.ts`**:手写一份 `achievements` 回复(照第 1 节的形状;中文名用真表),测这些:
  - 剧情旗标已立和未立;
  - 宝箱的本档进度和 Steam 状态不一致(本档 22/112 未达成，Steam 已解锁);
  - 图鉴标「全账号」;
  - 类型不在表里时写「读不到」,并出现那句说明;
  - `save: null`;
  - `account: null`;
  - 目标值缺失时用 API 名末尾的数字。
- **命令**:用替身的 `ctx.commands`(记下注册的定义)和 fake-pilot,测成功返回表格、桥插件连不上时返回 error。

## 回报

不超过 40 行，写清楚:
- 改了哪些文件;
- 两边的编译和 `npm run check` 结尾;
- `JobInfomationData` 的实例从哪拿的;
- 拿不准的地方。

dsh 那边不要编译 TS,不要重启网页。

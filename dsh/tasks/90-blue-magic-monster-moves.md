# 任务 90(桥插件 0.14.4):青魔法(已学会 + 怪物会放哪些)、怪物招式查询、战斗状态补全

工作目录 `bridge/`。只改 `bridge/src/`、`bridge/README.md`、`src/Version.cs`。不碰 `../dsh/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**、不装插件(Claude 来装)。桥插件**只读**游戏状态，不改游戏数据和存档。

编译只编 FF5 一次:`dotnet build -p:Game=ff5`(先确认没有别的 `dotnet build` 在跑)。FF5 专有的部分包在 FF5 的条件编译里，确认其他五作不受影响。如果沙箱读不到 `~/.dotnet`,照上次的办法编，回报里写明怎么编的。

反编译代码在 `../.deps/ff5/decompiled/`(只有类、字段、方法名，没有方法体)。**一定先读** `../.deps/tmp/research-81/report.md`(任务 81 的调查报告:能力 → 状态组 → 状态的链路、怪物 → AI 脚本 → 能力的入口、`battle.hit` 丢状态的原因)。

## 起因

用户 11-10:
- 成就里有青魔法(学会 10 个 / 全部),可是队伍从来没有青魔法师。青魔法只能在战斗中被怪物施放、由会“学习”的人学会;有些怪只在一个地方出现，错过就学不到。要像图鉴一样，在规划一段路时就知道：这一段的怪会放哪些青魔法、我们还缺哪些、会不会错过、要不要在这里刷。
- 要按“这一段的怪会放什么状态”准备药(11-09 两次带着黑暗走火力船)。

现状：桥插件读不到已学会的青魔法(待办 31:`OwnedMagicList` 不是已学列表);`battle.hit` 296 场里只有 4 条带状态(只读 `MesIdName`,空名就丢);没有“某只怪会用哪些招”的查询。

## 做法

1. **已学会的青魔法**:找到存档里记录“已学会的青魔法”的地方(线索：成就主数据里有 `LearningBlueMagic` 这一类;主数据 `Last.Data.Master/Learning.cs` 有 `TypeId`、`Value1`、`Value2`、`JobId`、`ContentId`;用户数据在 `Last.Data.User` 和各个 Manager 里)。给出查询 `bluemagic`:`{ learned: [{id, name}], all: [{id, name, learnedBy: 学法说明或 null}] }`,`all` 是游戏里全部青魔法(主数据),`learned` 是这一档已学会的。读不到就照实写 `learned: null`,不要猜。
2. **怪物招式** 新查询 `monstermoves`(参数 `ids`:怪物 id 列表):每只怪 `{id, name, moves: [{abilityId, name, blueMagic: bool, conditions: [状态名…], rate?}]}`:
   - 招式来自 `Monster.ScriptId` 的 AI 脚本(现有 `monsterai` 查询已经能读脚本原文和能力名，复用);能力名用游戏自己的取名函数;
   - `blueMagic`:这招能不能被学成青魔法(按 1 里找到的青魔法主数据对 id);
   - `conditions`:按报告里的链 `Ability.ConditionGroupId → ConditionGroup → Condition` 取状态;名字空的用 `ConditionType` 枚举名兜底(做法照 `GameState.Party.cs:116-121`);
   - 推断的字段在 README 里标“推断，待真机核对”。
3. **`battle.hit` 补状态**:状态名为空时用 `ConditionType` 枚举名兜底(同上),不再丢弃。
4. **游戏结束弹窗的自动保存栏**(任务 88 留下的):`sample.gameover.autosave` 现在总是 null,画面上明明有“自动保存 2026/11/10 2:41 卡纳克城 2 层”。查 `GameOverLoadPopup.saveContentController` / `SaveContentView` 的读法，修好;还读不到就在 README 写明。
5. README 写清新查询和字段，版本号 0.14.4,更新记录写一条。

## 回报

不超过 30 行：找到的类和字段(文件名)、两个新查询的形状、`dotnet build -p:Game=ff5` 结尾输出、要真机核对的地方。

# 任务 135:一次读出全作宝箱旗标(桥插件 0.14.8),代码记住哪些已开，重启也不忘

工作目录：仓库根(`bridge/` 和 `dsh/` 都要改)。可以改 `bridge/src/GameState.Achievements.cs`(或新建 `bridge/src/GameState.Treasure.cs`)、`bridge/src/Requests.cs`(只加一个 case)、`bridge/src/Version.cs`(0.14.8)、`bridge/README.md`(查询表和版本说明);`dsh/src/engine/` 里读宝箱开没开的地方(路线书的 `opened`、`sectionFinished`、阶段统计的宝箱数、执行器跳过已开的站)、`dsh/test/`。不碰 `../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。沙箱里编不了 C# 就只写代码，回报里说明，Claude 在外面编译。测试数据自己编。

## 起因(11-11 10:28 真机)

图尔村 11 个宝箱/隐藏道具早就全开了，可网页重启后，代码只知道“当前这张图”的宝箱开没开(桥插件 `entities` 的 `opened`,只读得到已载入的图),于是反复为图尔村这一节生成计划(14 站 → 8 站 → …),每次 20–30 秒，还会派人去开已经开过的格子。任务 133 回报里也写了：跨图的开箱状态只在进程内累计，重启就没了。

游戏判断宝箱开没开就是 `Last.Map.MapUIManager.GetTreasureFlag(flagId)`,任意旗标都能读，不用载入那张图;桥插件的成就查询(`GameState.Achievements.cs` 的 `Treasure()`)已经对主数据 `TreasureBox` 的每个旗标调过它，只是汇总成了每个地区的数量。游戏文件导出(`../.deps/knowledge/ff5/files/maps/<id>.json`)里每个宝箱都有 `flag`。

## 做法

1. **桥插件**(只读，版本 0.14.8):新查询 `treasureflags`,返回 `{ "flags": { "<flagId>": true|false|null, ... }, "total": n }`(null = 读这个旗标时抛错);遍历主数据 `TreasureBox`,对每个 `Flag` 调 `GetTreasureFlag`;在标题画面/读档中主数据或存档没准备好时返回 `{ "ready": false }`。照现有查询的写法注册、写注释(注明 0.14.8、为什么加)。`bridge/README.md` 的查询表加一行。
2. **dsh**:引擎维护“全作开箱状态”(旗标 → 开没开):
   - 引擎启动、读档后、每次换图后读一次 `treasureflags`(桥插件旧版本不支持时退回现在的做法);
   - 路线书(`route-book-load` 的本档 `openedChests`)、`sectionFinished`、阶段/路线书统计的宝箱数、执行器“已开就跳过”,都按“游戏文件里这个宝箱的旗标 → 开没开”判断;
   - 开箱后更新内存里的状态(不必等下一次读)。
3. **测试**:假桥插件返回旗标表 → 路线书把已开的标“已开”、`sectionFinished` 判为完成、不再为已完成的节建计划;旧桥插件(没有这个查询)→ 退回旧行为不报错;C# 部分在回报里贴出代码要点(你编不了就由 Claude 编)。`npm run check` 全过。

## 回报

不超过 15 行：桥插件查询的形状和版本、dsh 哪些地方改用了旗标、旧版本退回怎么做、`npm run check` 结尾、C# 是否在沙箱里编译成功。

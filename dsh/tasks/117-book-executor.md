# 任务 117:路线书执行器——`route {}` 就是“执行下一段”,代码一口气走完，只在交回点叫模型

工作目录 `dsh/`。可以改 `src/engine/game.ts`、`src/engine/route/`、`src/engine/stage/`(**不改** `route-book.ts`、`route-book-render.ts`——任务 119 同时在改，只读它们导出的函数和类型;**不改** `guide-types.ts`、`book-progress-types.ts`——Claude 写的共用类型)、新建 `src/engine/stage/book-plan.ts`、`src/engine/stage/route-book-load.ts`、`src/engine/prompt.ts`(只改讲 `route`/`plan_stage`/`go` 的那几行)、`src/plugin/config.ts`(只加本任务的 Config 项)、`test/`(含 `test/fixtures/prompt/` 随提示词变的对照文件)。不碰 `src/client/`、`src/plugin/panel.ts`(任务 118),不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11,用户定的方向)

用户要“长时间规划，然后无延迟高速地寻路、开箱、战斗，保证青魔法、图鉴、宝箱收集，完整路径显示”,并且要能验收。现状：新游戏开场模型调了 23 次坐标 `go`,每步都要想一次。任务 114/115 已经做出了路线书(`src/engine/stage/route-book.ts` 的 `buildRouteBook`,命令行 `scripts/routebook.mts`,开发机上的产物 `../.deps/ds/routebook-ff5.md`/`.json`,用户审过“现在 → 风之神殿”这一段)。本任务让代码照路线书执行。

现有的能接上的东西(先读懂再改):
- 阶段计划 `StagePlan.route`(`stage/types.ts`)、`plan_stage`、自动规划和出发检查(`stageBeforeTravel`)、坐标 `go` 被计划拦下时改成按计划走(任务 113 的 `stageGoFollowPlan`)、到了计划覆盖的图接着走(`stageContinueAfterTravel`)、阶段统计 `StagePlanRecord.stats`;
- `route {}` 不带站点时先接路线进度、没有就用 `stagePlanRouteStops`(`game.ts`);
- 路线执行器 `route/execute.ts`:站点类型 chest/save/grind/boss/story/move,首领到门口 `halt("decision")`,刷怪 `ports.grind`(带 `until.bestiary`),进度存盘，偏离后从当前位置重排。

## 做法

1. **运行时生成路线书**(`stage/route-book-load.ts`):照 `scripts/routebook.mts` 读攻略、知识模块、地图记录、到达先后;本档数据用活的:本档图鉴、已学青魔法、队伍职业(从现有的读法取)、宝箱开没开(桥插件 `entities` 的宝箱 `opened`,到了那张图再读也行)。按当前地图找出“当前段”(路线书里覆盖当前地图的那一节;在世界地图上就取下一节);结果缓存，进了新的一节再算。
2. **路线书 → 阶段计划的路线**(`stage/book-plan.ts`):有路线书覆盖目标时，阶段计划的 `route` 由路线书站点转换，不用阶段官编的路线(阶段官照旧出药品、职业、最低等级这些;它给的路线写进说明，不执行):
   - 有坐标的宝箱/隐藏道具 → `open`(收集要保证:不设 optional;倒计时例外照旧);“开这张图的宝箱”那种多格站 → 每格一个 `open`;已开的跳过;
   - 真实存档点 → `save`;首领 → `boss`(照旧在门口交给模型);
   - 路线书“刷怪建议”里本档没登记、标「错过就没了」的怪 → `grind`,`until.bestiary` 写那几只，`until.minutes` 用 Config 上限(默认 8);队里有青魔导士、而这一段有没学的青魔法时同理加 `until.blueMagic`;
   - 剧情/对话/机关这类没坐标的站 → 新的“交回”站(见第 3 条);纯移动的站不单独执行(到下一站的路由执行器算)。
3. **没坐标的站**:执行到这里时:
   - 剧情/对话：当前图上恰好有一个本档还没触发过的剧情事件实体(看现有对 `Event` 实体、事件格的处理),就自动走过去触发，翻完剧情接着走;
   - 其余：停下(`halt("decision")`),工具结果写清“第 n 站交给你:<中文做什么>,攻略原文:<原文>,在地图 X。处理完再 `route {}` 接着走”。模型处理完再调 `route {}` 时，这一站记为 handoff 完成，接着下一站;
   - **学会坐标**:模型处理交回站时实际 `interact`/`talk`/触发事件的那一格，记进 `.deps/ds/routebook-learned-<game>.json`(键：攻略节名 + 站序号 + 地图),下次生成路线书时这一站就有坐标(`route-book-load.ts` 读它补进站点)。
4. **`route {}` = 执行下一段**:没有进行中的计划、当前位置在路线书覆盖的范围里时，`route {}` 先按路线书自动建计划(照 `plan_stage` 的流程，含出发检查),然后执行。
5. **进度和验收数字**:每走完一站写 `.deps/ds/routebook-progress-<game>.json`(格式见 `src/engine/stage/book-progress-types.ts`,路径进 Config 默认值);一节结束(最后一站完成或换到下一节)时在活动日志写一行「路线书统计「X」:工具 N 次(go a、route b),交回 h 次，宝箱 o/t,图鉴还缺 m,青魔法还缺 k,用时 x 分」,`route` 的结果末尾也带这组数字。工具次数沿用任务 113 的统计口径。
6. **提示词**:只改 `route`/`plan_stage`/`go` 那几行：有路线书时 `route {}` 就是执行下一段，代码交回时只处理交回的那一站，处理完再 `route {}`。不加打法建议。
7. 新 Config 项：路线书开关(默认开)、刷怪上限分钟、进度/学会坐标文件路径。

## 测试

- 用小的假路线书(手写 `RouteBook` 对象，或用 `buildRouteBook` 跑小数据)+ 假桥插件:
  - 宝箱站按顺序打开、已开的跳过;多格站每格都开;
  - 刷怪站只在有“错过就没了”且没登记的怪时出现，满足就停;
  - 首领站在门口交回;
  - 剧情站：有唯一没触发的剧情事件 → 自动走过去;没有 → 交回，第二次 `route {}` 接着下一站，并记下模型处理的格子;
  - `route {}` 在没有计划时按路线书建计划再执行;
  - 进度文件格式符合 `BookProgress`;节结束写统计行;
- 原有的 route/stage/go 测试照旧通过;
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑;真实目录有 `.deps`,`knowledge-real` 那一项失败是已知的)。

## 回报

不超过 25 行：改了哪些文件、路线书站点怎么转成路线(各类站点一句)、交回站和“学会坐标”怎么做、`route {}` 建计划的条件、进度文件和统计行示例、新 Config 项、`npm run check` 结尾、拿不准的地方。

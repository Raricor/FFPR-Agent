# 任务 154:提交整章计划时先离线试走一遍，走不到的站当场退回

工作目录 `dsh/`。可以改 `src/engine/plan/chapter-tools.ts`(加端口和调用)、`src/engine/plan/chapter-validate.ts`(若试走结果并进检查问题)、新建 `src/engine/plan/dry-run.ts`、`src/engine/game.ts`(**只改章工具的端口接线**,任务 145 续 4 同时在改 game.ts 的计划交互方法)、`test/`。可以 import、不改 `src/engine/route/`、`regions.ts`、`skills/travel.ts`。不碰 `execute.ts`、`knowledge/`、`plugin/`、`client/`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自编。

## 起因(11-11 真机，新游戏第 1 章)

70 分钟里模型交了 27 份计划、执行 18 次、16 次出例外，用户看到的是 AI “还在各种尝试”。很多例外是站点在真机上走到了才发现走不到(目标格走不上去、要绕的路不通、地图之间没有路)。这些用现有的离线路线分析(任务 127 的 `route/analyze.ts`、`estimatePair`、`scripts/route-debug.mts`)提交时就能算出来，不必等真机执行才失败、再回模型。

## 做法

1. `dry-run.ts`:`dryRunChapter(plan, start, world)`:从队伍当前位置出发，按章计划里所有段、所有站的顺序，逐站用现有的离线估算(`estimatePair`,含跳石、同图换块、地图记录里学到的跳坎)判断从上一站能不能走到这一站。
2. 结果分两类:
   - **退回**:两站之间没有会改变局面的站(story、talk、switch、choose、boss)时，离线走不到 → 退回，写清『第 N 段第 M 站 (图:x,y) 从上一站 (图:x,y) 走不到：原因』;
   - **只提醒**:中间隔着上面那几类站(剧情可能把人带走、机关可能开路),离线走不到只提醒，不退回。
   - 目标是宝箱/调查格这类本身不可站的格，按“站到旁边”估算(沿用现有规则)。
3. `submit_chapter_plan` 先跑原有的整章检查，再跑试走;退回的项并进问题列表，提醒的项附在通过/退回的文字后面。试走要快(整章几十站，总共 < 2 秒;超时就只提醒『试走超时，未检查完』)。
4. `game.ts` 给章工具加试走端口：拿当前位置、地图记录、碰撞缓存、区域、跳石(与执行器走路用的是同一份)。

## 测试

自编小地图：两站间普通移动走不到 → 退回;中间隔一个 story/switch 站 → 只提醒;宝箱格按旁边估算;超时只提醒。`npm run check` 全过。

## 回报

不超过 12 行：改了哪些文件、退回/提醒的规则、用真实 `.deps` 跑一份第 1 章计划(`.deps/ds/chapter-plan-ff5.json` 的当前计划，从 193 (19,6) 出发)的试走结果摘要(不进测试)、`npm run check` 结尾。

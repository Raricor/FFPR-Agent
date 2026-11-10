# 任务 102:侦察模式的独立模块——进度快照/还原、自动侦察的走法、从菜单读回 20 号档

工作目录 `dsh/`。**只许新建** `src/engine/scout/` 下的文件、`src/engine/skills/load.ts`、`test/scout*.test.ts`、`test/load*.test.ts`;现有文件只读(接进游戏流程另做;另有任务 100 正在改 `game.ts`、`prompt.ts`、`route/`、`stage/`,任务 104 在改 `skills/gambit.ts`、`skills/battle.ts`、`strategy/`)。不碰 git,**不连笔记本**(测试全用替身桥),**不用 docker、不绕开沙箱**。

## 起因

用户 11-10:地图记录不全(342 个出口只记了 43 个落点;254 条“走不过去”里 245 条只见过一次;没去过的图什么都没有),整段推演需要准确的图。用户提出“SL 大法”:进副本前存 20 号档，进去把出口、落点、机关都走一遍记下来，再读回 20 号档，这样这个副本就成了“去过的”,之后一段路可以整段推演、一口气走完。地图记录在开发机上，读档不会丢。

要处理的:
1. 侦察期间**不能存档**(只能写 20 号位，存了就回不到进副本前);
2. **地图结构**(出口、落点、走法、机关效果、碰撞)要留下;**本档进度**(本档去过的图、图鉴登记、欠账、事故、AI 的笔记、阶段计划、路线进度、飞龙位置)要在读档后还原;
3. 侦察要尽量由代码自动做，遇敌就逃，不问 AI;
4. 读档：主菜单里有「读取」(11-10 真机菜单命令 id:`['Item','Magic','Equipment','Job','Ability','Status','Sort','Config','Interruption','Save','Load']`)。

本档进度相关的文件(都在 `.deps/ds/`,FF5):`atlas-save-ff5.json`(本档去过的图)、`bestiary-save-ff5.json`、`backlog-ff5.jsonl`、`incidents-ff5.jsonl`、`incidents-state-ff5.json`、`notes-ff5.json`、`stage-ff5.json`、`route-ff5.json`、`drake.json`。地图结构(要留下):`atlas-ff5.json`、`collision-ff5/`。只追加的日志：`battles-ff5.jsonl`、`activity-ff5.jsonl`、`player-ff5.jsonl`(留下，但要能认出哪些是侦察期间写的)。

## 做法

1. **`src/engine/scout/snapshot.ts`**:
   - `takeSnapshot(dir, files)`:把本档进度文件复制到 `.deps/ds/scout/<时间>/`,写一个清单(文件、大小、时间);
   - `restoreSnapshot(snapshotDir)`:按清单原样恢复(侦察期间新建的进度文件删掉，原来没有的就不留);
   - `scoutWindows`:在 `.deps/ds/scout-windows-<game>.json` 记每次侦察的开始和结束时间，并提供 `inScoutWindow(timestamp)`,以后从日志推算本档进度的地方(比如按存档算图鉴)用它排除侦察期间的记录;
   - 文件列表做成参数，默认是上面那些，路径用 `src/engine/paths.ts` 的 `DEPS`。
2. **`src/engine/scout/explore.ts`**(纯函数，规划“要侦察哪些地方”):
   - 输入：地图记录、碰撞缓存(区域)、当前位置、侦察范围(地图号列表或区域名);
   - 输出：按顺序的侦察目标：没记落点的出口、走不到过的连通块、没试过的事件格 / 机关(`DefaultEntity` 等带名字的物体)、只见过一次的“走不过去”(去验证);
   - 用任务 79 的 `analyzeRoute` 排顺序;给出预计用时;
   - 侦察每个目标的动作写成 `route` 路标(`to`、`do: talk` 调查机关、或只是走到),执行交给现有的路线执行器(只 import,不改它)。
3. **`src/engine/skills/load.ts`**:`loadSlotFromMenu(pilot, slot)`,从地图上用主菜单读档：
   - 每按一键前用桥插件核对:`menu` 查询的 `commands`/`cursor` 找到 `Load`;读档列表用 `saveui` 的 `slots`/`cursor` 移到 `slot`;确认框按“是”(11-10 真机：读档确认框默认“否”,按 Left 再 Enter);
   - 等 `pos.state` 变 `Player`,回报地图、格子、存档次数;
   - 任何一步核对不上就停下，照实报告，**绝不盲按**;
   - 只允许 `slot = 20`(参数传别的就报错，不按键)。
4. **侦察期间的存档保护**:`scoutSaveGuard(state)`,侦察进行中返回拒绝理由(接线另做)。

## 测试

- 快照 / 还原：侦察期间改了、新建了进度文件 → 还原后和快照前一字不差;地图结构文件不受影响;
- `inScoutWindow` 的边界;
- `explore`:合成地图记录里有没记落点的出口、只见过一次的“走不过去”、带名字的机关 → 都进侦察目标，顺序合理;
- `loadSlotFromMenu`:替身桥按真机的菜单、读档列表、确认框走完;光标读数不对 → 停下不按;`slot` 不是 20 → 报错不按;
- `npm run check` 全过。

## 回报

不超过 30 行：新建了哪些文件、快照的文件列表、侦察目标的种类和顺序规则、读档的按键流程、`npm run check` 结尾、之后接线时 `game.ts` 要做什么(列出来)。

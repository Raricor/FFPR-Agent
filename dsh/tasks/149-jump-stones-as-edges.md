# 任务 149:跳石这类脚本移动——导出成同图连线，寻路和走路都认

工作目录 `dsh/`。可以改 `scripts/game-files.mts`、`src/engine/knowledge/`、`src/engine/regions.ts`、`src/engine/skills/travel.ts`、`src/engine/skills/move.ts`、`src/engine/route/`、`test/`。**不碰** `src/engine/game.ts`、`src/engine/plan/`、`src/plugin/`、`src/client/`(任务 145/147 的后续在改)、`src/engine/prompt.ts`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编，不放游戏原文;真实游戏文件只在本机 `.deps/` 里读来核对，不拷进测试。

## 起因(11-11 真机，计划模式，FF5 船舶墓场)

船舶墓场外面(地图 211,`Map_30060`)被水隔成好几块，靠“跳石”连起来。执行器不认识跳石，报“地图 211 里从 (30,33) 走不到 (34,33)(同图另一块，经别的图也绕不过去)”;模型只能看地形猜跳石在哪，用 `open` 去“调查”,猜错格子((30,43),实际在 (30,45))就卡住。我们导出的地图 `events` 里没有这些对象。

原始数据(在 `.deps/ff5/files/Res/Map/Map_30060/Map_30060/`):
- `entity_default.json` 里有约 20 个对象“石の上を飛ぶN”,`object_type` 为 2(踩上去触发)或 5(碰/调查触发),带 `script_id`、`direction`(看起来是允许的朝向位掩码，15 = 全部)。格子 = (x/16, y/16−1)。例:`石の上を飛ぶ10` (30,45) type 5;`石の上を飛ぶ2` (17,45)、`3` (17,46) type 2。
- 脚本 `sc_30060_jump_N.json`:`BranchByPlayerDirection` 按朝向分支，朝下 `Call Jump_Front`,朝上 `Call Jump_Back`;里面 `SetPos`、`Move [2,2]`(sValues `JumpFront`/`JumpBack`)。看起来是朝当前方向跳 2 格。请读懂 `Move`/`SetPos` 的参数(可对照别的已知脚本),不要猜;读不准的，用碰撞核对：落点必须可走、且和起点不在同一个连通块。

现有的同图连线：任务 71 的电梯(`mapRides`/rides),还有测试里的“定时机关连到 PointIn 变成 fall edge”。跳石照这一类接。

## 做法

1. **导出**(`scripts/game-files.mts` + `knowledge/`):每张图导出 `jumps: [{cell, kind: "step"|"touch", facing, land, script}]`。`facing` 是要朝的方向(或方向列表),`land` 是落点格。脚本读不懂或落点核对不过的不导出，汇总里记一笔(多少个、哪张图)。
2. **寻路**(`regions.ts`、`travel.ts`、`route/`):跳石当作同图的有向连线(从起点格所在块到落点所在块),`mapPath` 的(地图，块)搜索、任务 148 的同图换块、`sameMapResult` 的估算都能用它。
3. **走路**(`move.ts`):走到一条跳石连线时，`step` 类从反方向走上触发格(进格时的移动方向就是 `facing`),`touch` 类站到相邻格面朝它按确认;等脚本放完、位置稳定，核对到了 `land`(或同一块里),没到就按现有失败处理。
4. 用 `.deps` 里真实的 211 核对(不进测试):(12,23) 到 (13,54)、到 (34,45)(去 224 的入口)、到 (47,32) 都能规划出路线;回报里贴这三条路线的跳石序列。

## 测试

自编小地图：两块被水隔开，中间一个 `step` 跳石和一个 `touch` 跳石;导出得出正确的 `facing`/`land`;落点是墙的不导出;`mapPath` 经跳石从一块到另一块;同图换块的估算用上跳石;走路按方向进格/面朝按确认(用假桥插件)。`npm run check` 全过。

## 回报

不超过 25 行:`Move`/`SetPos` 参数怎么读的(依据)、211 导出了几个跳石、三条真实路线、改了哪些文件、拿不准的地方、`npm run check` 结尾。

# 任务 105:把侦察模式(SL 大法)接进游戏——`scout` 工具

工作目录 `dsh/`。可以改 `src/engine/game.ts`、`src/engine/prompt.ts`、`src/engine/scout/`、`src/engine/skills/save.ts`、`src/engine/skills/load.ts`、`src/engine/bestiary-save.ts`(第 6 条)、以及其他“从日志推算本档进度”的模块(第 6 条，回报里列出改了哪些)、`src/plugin/config.ts`、`src/plugin/player.ts`、`test/`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**(测试全用替身),**不用 docker、不绕开沙箱**。

## 起因

用户 11-10 提出“SL 大法”:进一个副本前存 20 号档，进去把出口、落点、机关都走一遍记下来，再读回 20 号档，这样整段可以准确推演、一口气走完。地图记录在开发机上，读档不会丢。任务 102 已经做好独立模块(都还没接进游戏):
- `src/engine/scout/snapshot.ts`:`takeSnapshot`/`restoreSnapshot`(9 个本档进度文件:`atlas-save-ff5.json`、`bestiary-save-ff5.json`、`backlog-ff5.jsonl`、`incidents-ff5.jsonl`、`incidents-state-ff5.json`、`notes-ff5.json`、`stage-ff5.json`、`route-ff5.json`、`drake.json`;地图结构 `atlas-ff5.json`、`collision-ff5/` 不动)、`ScoutWindows`/`inScoutWindow`;
- `src/engine/scout/explore.ts`:`planScout`/`exploreTargets`/`describeScout`(侦察目标：没记落点的出口 → 没有入口记录的连通块 → 只见过一次的“走不过去” → 没试过的机关;每个目标写成 `route` 路标);
- `src/engine/scout/save-guard.ts`:`scoutSaveGuard`;
- `src/engine/skills/load.ts`:`loadSlotFromMenu(pilot, 20)`(每键核对，只许 20 号)。

任务 102 列出的接线要求(照做):
1. 进入侦察前先存档 20 号位，`takeSnapshot`,`ScoutWindows.begin`;
2. `save_game` 前调 `scoutSaveGuard`,侦察中拒绝存档(**侦察期间绝不写 20 号位**);
3. 用 `planScout` 的目标交给现有路线执行器，遇敌逃，机关 `talk`,每个目标后重排;
4. 侦察结束 `loadSlotFromMenu(pilot, 20)` → `restoreSnapshot` → 关窗口;
5. 读档后重载本档进度的内存缓存(atlas-save、bestiary、notes、stage、route、drake),地图结构保留;
6. 从追加日志推算本档进度的地方用 `inScoutWindow` 排除侦察期间的记录(比如按存档算图鉴从战斗记录补算的那段);日志本身保留;
7. 中止或失败(取消、游戏结束、读档失败)也要关窗口、还原快照;读档失败时**不还原快照**,而是停下照实报告(这时游戏状态和快照对不上)。

## 做法

1. **`scout(area?, minutes?)` 工具**:`area` 是侦察范围(地图号、地图名或区域名;不给就用当前所在区域);`minutes` 是时间预算(默认 `Config`,比如 20)。按上面 1–7 执行，结果写：侦察了哪些目标、新记了几个落点 / 走法 / 机关效果、验证掉了几条单次“走不过去”、耗时、是否已读回 20 号档并还原。
2. **只在安全的地方开始**:人在地图上、不在战斗 / 对话 / 菜单、没有倒计时(`timer.active` 为真时拒绝，说明原因)、能存档的地方(复用存档技能对“能不能存”的判断，不能存就拒绝)。
3. **侦察中遇敌一律逃**(现有 `flee`);逃不掉就照规则表打;全灭 / 游戏结束 → 走任务 91 的“回 20 号档”流程，然后还原快照，报告。
4. **不叫战术官、不叫阶段官**(侦察期间这些都关掉，结束后恢复)。
5. **提示词**:加两三句说明 `scout` 的用途(进一个没走全的区域前，先侦察一遍再定计划)和代价(会花时间、结束时读回 20 号档),不写具体关卡攻略。
6. 数值进 `Config`。

## 测试

替身桥 / 替身 pilot:
- 完整一遍：存档 → 快照 → 侦察两个目标(其中一个遇敌逃跑)→ 菜单读回 20 号 → 还原 → 本档进度文件和快照前一致、地图结构多了新记录;
- 侦察中 `save_game` 被拒;
- 倒计时激活时 `scout` 被拒;不能存档的地方被拒;
- 中途游戏结束 → 回 20 号档、还原、报告;
- 读档失败 → 不还原、停下报告;
- 按存档算图鉴时侦察窗口内的战斗不计入;
- `npm run check` 全过。

## 回报

不超过 30 行：改了哪些文件、`scout` 的参数和结果样例、第 6 条改了哪些推算的地方、新 `Config`、`npm run check` 结尾、拿不准的地方。

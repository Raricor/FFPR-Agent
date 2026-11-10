# 任务 97:把阶段层接进游戏——`plan_stage` 工具、出发检查硬拦、回头检查、计划存盘

工作目录 `dsh/`。可以改 `src/engine/game.ts`、`src/engine/prompt.ts`、`src/engine/stage/`(94–96 的文件可以小改，类型文件 `types.ts` 只能加可选字段)、`src/engine/route/tool.ts`、`src/engine/events.ts`(只为第 6 条)、`src/plugin/`、`test/`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**(测试全用替身),**不用 docker、不绕开沙箱**。

## 起因

用户 11-10 定的方向：一段路(一个副本 + 出发城镇 + 路上的世界地图)开始前，代码叫“阶段官”一次想清楚要带什么、学什么、怎么走、什么时候回头;之后由代码执行，中途不再问 AI。出发清单没备齐要**硬拦**(写理由才放行，和“本图没完成不让走”一样);要有 `plan_stage` 让 AI 自己调，也要代码自动触发。

已经有的零件(都还没接进游戏):
- 任务 93 知识模块 `src/engine/knowledge/`(`loadKnowledge` 和查询);
- 任务 94 `src/engine/stage/facts.ts`:`buildStageFacts(input)`、`describeStageFacts(facts)`;
- 任务 95 `src/plugin/stage-officer.ts`:`callStageOfficer(...)` → `{plan, problems, text}`(预设 `ffpr-stage-officer` 已在 `src/index.ts` 安装);`src/engine/stage/plan.ts` 的 `checkStagePlan`;
- 任务 96 `src/engine/stage/gate.ts`:`departureCheck`、`turnBackCheck`;`purchase.ts`:`purchaseList`;
- 任务 89 `route` 工具(`src/engine/route/tool.ts`),一段路一次走完;
- 战术官的调用和后台运行(任务 86)在 `src/plugin/tactician.ts`、`game.ts`,做法可以照搬。

## 做法

1. **`plan_stage(to, reason?)` 工具**:`to` 是目的地(地图号、地图名、或攻略里的区域名)。
   - 读当前队伍、背包、金钱(现有读法)、知识模块，调 `buildStageFacts` → `callStageOfficer`;
   - 通过检查的计划存到 `.deps/ds/stage-<game>.json`(`{target, plan, createdAt, status}`),网页重启、换会话都还在;
   - 工具结果给 AI 看：计划摘要(威胁、要带的、魔法、职业、最低等级、路线、回头条件)、**本店能买的采购单**(人在商店时用 `purchaseList` 算;不在商店就列“要去哪种店买什么”)、出发检查的结果;
   - 已有同一目的地、还没完成的计划时，直接给出它(可选参数 `replan: true` 重做)。
2. **自动触发**:AI 在城镇或世界地图上用 `go`/`route` 去**另一个区域的副本**(目的地的区域和当前区域不同、而且不是城镇;认法写成函数、注释写清是推断),而没有这个目的地的计划时，先自动叫阶段官出计划(照 `plan_stage`),再按第 3 条检查。
3. **出发检查(硬拦)**:有计划且还没出发时，离开出发城镇往目的地走(`go`/`route` 的目标在目的地方向)前跑 `departureCheck`:
   - 不满足就拒绝，结果写清缺什么、在本镇哪里能买(按采购单);
   - 写了 `leave_incomplete`(复用现有参数)理由就放行，记一条欠账;
   - 倒计时期间不拦(任务 89 的规则)。
4. **回头检查**:按计划进入目的地后，每场战斗后、每次进图时跑 `turnBackCheck`(`ahead` 用计划路线里前面的回复点 / 存档点和路线分析器的距离):
   - 成立且前面的回复点解决不了 → `go`/`route` 往更深处走时拒绝，列出回城路线(写理由才放行);
   - 能在前面的回复点解决 → 提示“先到回复点 X”,不拒绝。
5. **完成**:到达计划终点、或首领打完，计划状态记为完成;结果里写一行。
6. **小尾巴**(任务 99 留下的):`battle-ended`(战斗被剧情结束)加进 `events.ts` 的事件种类和显示。
7. **提示词**:说明 `plan_stage` 的用法(一段路开始前调一次;代码也会自动调)和出发 / 回头检查的拒绝怎么处理。只加，不改原有段落意思，**不写任何具体关卡的攻略**。
8. 数值进 `Config`。

## 测试

替身桥 / 替身阶段官(可控结果)/ 合成知识:
- `plan_stage`:出计划、存盘、重启后读回;人在商店时给采购单;
- 自动触发：从城镇 `go` 到另一个区域的副本、没有计划 → 先叫阶段官;
- 出发检查：缺药被拒、写理由放行(记欠账)、倒计时期间不拦;
- 回头检查：治不了的状态 + 前面没有回复点 → 拒绝往深处走;前面 20 格有回复点 → 提示先去;
- 到终点 / 首领打完 → 计划完成;
- `battle-ended` 显示正确;
- `npm run check` 全过。

## 回报

不超过 35 行：改了哪些文件、自动触发怎么认“去另一个区域的副本”、拒绝时给 AI 的原文各一例、新 `Config` 项和默认值、`npm run check` 结尾、拿不准的地方。

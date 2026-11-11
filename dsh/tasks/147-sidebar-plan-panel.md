# 任务 147:侧栏“段计划”面板——让用户看到 AI 写的整份计划和执行到哪

工作目录 `dsh/`。可以改 `src/plugin/panel.ts`(或新建 `src/plugin/plan-panel.ts`,由 panel.ts 注册)、`src/client/index.ts`、`src/client/globals.d.ts`(只在要用新的 dsh 前端接口时)、`test/`。**只读不改** `src/engine/plan/types.ts`、`src/engine/plan/store.ts`(用里面的 `SegmentPlan`、`SegmentReport`、`SegmentProgress`、`segmentPlanPath`、`segmentProgressPath`)。不碰 `src/engine/`(任务 145、146 同时在改)、`../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编，不放攻略和游戏原文。

## 起因(11-11,用户:“我怎么没看到长时间的规划呢”)

计划模式下 AI 先写一整段计划(站点顺序、普通战斗规则表、刷怪目标、首领准备和首领规则表、回头条件),代码照计划执行。可是网页上看不到计划：侧栏只有路线书和活动日志，计划只在 `submit_plan` 那一行里截了一小段，完整内容只在 `.deps/ds/segment-plan-<game>.json`。用户没法判断 AI 有没有在做长规划，也看不到执行到哪、为什么改了计划。

## 数据(都是现成的文件，路径用 store.ts 的函数，`game` 是 `ff5` 这种)

- `segment-plan-<game>.json`:`{game, current: SegmentPlan|null, history: {节名: SegmentPlan[]}}`(每节最多 5 份);
- `segment-report-<game>.json`:最近一份 `SegmentReport`;
- `segment-progress-<game>.json`:`SegmentProgress`(任务 145 正在加写入;文件没有时，面板照样显示计划，站点状态显示“未开始”)。

## 做法

1. **服务端路由** `GET /api/ffpr/plan?game=ffN`(照 `BOOK_ROUTE`/`readBookPanel` 的写法):读上面三个文件，算好要显示的中文，前端只排版。文件缺失、JSON 坏了都变成中文提示，不抛异常。内容:
   - 标题行：节名、目标、“本节第 N 份计划”(进度文件的 `revision`)、状态(执行中/完成/出例外/没在执行)、开始和更新时间;
   - 为什么有这一份:`previousException`(“上一份在第 3 站出例外(unreachable):…”);
   - 准备：换职业、装备、要买的东西、前后排，一行一项;
   - 站点表：序号、图(带中文图名，读不到就只写编号)、坐标、做什么(中文动作名，和执行器日志一致)、为什么、刷怪的停止条件、状态和备注;当前站醒目;
   - 不做的站(`dropped`,任务 146 加的字段;没有就不显示);
   - 普通战斗表：每套表每人第一两条规则的中文摘要(“巴兹：同伴 HP<40% 用恢复药，否则攻击”),整表折叠;
   - 首领：名字、图、先回复/先存档、每套表的摘要，折叠;
   - 回头条件：逐条;
   - 最近一份报告的摘要：状态、完成几站、开箱、战斗、新图鉴、新青魔法、击败的首领、用时、模型调用次数。
2. **前端面板**“段计划”,放在路线书面板旁边(上面或下面，和路线书一样能收起),定时刷新(和路线书面板同一个间隔)。站点状态用简单的符号(做完 ✓、正在做 ▶、待做 ·、失败 ✗、跳过 ↷)。`localStorage` 读写包 try/catch。
3. 只读：面板和路由不写任何文件，不调桥插件。

## 测试

服务端：自编三个文件，路由返回的文字正确;进度文件缺失时站点显示“未开始”;JSON 坏了返回中文提示;`dropped` 有无两种。前端按现有面板测试的方式(若有)补一个渲染检查。`npm run check` 全过，`npm run build` 后 `lib/client.js` 正常产出。

## 回报

不超过 20 行:改了哪些文件、路由返回的样例(截一段)、拿不准的地方、`npm run check` 结尾。

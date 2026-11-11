# 任务 146:改计划时保留没做的站、首领触发点进事实表、回复手段一行

工作目录 `dsh/`。可以改 `src/engine/plan/facts.ts`、`src/engine/plan/validate.ts`、`src/engine/plan/tools.ts`、`src/engine/prompt.ts`(和 `test/fixtures/prompt/` 对照文件)、`src/engine/game.ts`(**只改 `planToolPorts` 这一个方法**,任务 145 同时在改 game.ts 的其他方法)、`src/engine/skills/battle.ts`(**只许**给 `HEAL_SPELLS`/`HEAL_ITEMS` 加 `export`)、`test/`。**不改** `src/engine/plan/types.ts`(Claude 已经加好 `SegmentPlan.dropped`)、`src/engine/plan/execute.ts|game-ports.ts|store.ts`(145 在改)、`src/plugin/`、`src/client/`(147 在改)。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编，不放攻略和游戏原文。

## 起因(11-11 真机，计划模式，用户:“我怎么没看到长时间的规划呢”)

1. **计划越改越短**:一节路线书(海盗据点和托纳运河)42 分钟交了 24 份计划。第一份 10 站(佐克家拿钥匙 → 洞窟刷图鉴 → 196 三个宝箱 → 运河刷图鉴 → 卡尔拉波斯),出一次例外后模型交的是 1–5 站的“先过这一关”(“走到魔法店柜台前”“确认 (182,57) 能否登船”),上一份没做的站就丢了;过一会儿再交一份长的，又断。用户要的是 AI 一次写完整的计划，出例外只**修订**这份计划。
2. **首领站没有坐标**:模型写 `boss 210`,执行器走到这张图没开战，报 `invalid`。事实表的首领只有 `maps`,没有触发点。其实知识库地图里有:`.deps/knowledge/ff5/files/maps/210.json` 的 `events` 有 `{"name":"カーラボスと戦闘","cell":[58,34],...}`,名字里含着首领的日文名。
3. **回复手段**:四人全是骑士，没人会回复魔法，只靠恢复药。用户问“队伍里为啥没有白魔法师，回血跟不上”。事实表里每人一行“魔法:无”、背包一行，分散在各处。要加一行汇总的**事实**(不是建议)。

## 做法

1. **修订保留没做的站**(`validate.ts` + `tools.ts` + `planToolPorts`):
   - `PlanToolPorts` 加一个端口，取同一节的上一份计划和上一份报告(`segment-plan-<game>.json` 的 current、`segment-report-<game>.json`),`planToolPorts` 接上;
   - 上一份报告是**同一节**且 `status` 是 `exception` 时：上一份计划里 `report.remaining` 的每一站，新计划要么还有(同一张图、同一个 `do` 就算，坐标可以改),要么写进 `plan.dropped`(`{to, do, why}`,`why` 非空);两样都没有的，`submit_plan` 退回，列出缺的站(“上一份计划还没做的站要留着，不做的写进 dropped 并说明原因：第 5 站 open 196:… …”);
   - 新的一节、上一份是 `done`、或读不到上一份时不检查;
   - `dropped` 的格式检查(数组、`do` 是合法动作、`why` 非空);`submit_plan` 的参数 schema 加上 `dropped`;`plan_status` 显示 dropped。
2. **首领触发点**(`facts.ts` + `validate.ts`):
   - `SegmentFactsBoss` 加 `triggers: {map, cell}[]`:在这个首领的 `maps` 里，找知识库地图 `events`/`npcs` 中名字含该首领日文名的条目(日文名从知识库的怪物名取;取不到就空数组,不猜);
   - 事实文字里首领那行加“触发点 210:58,34”;
   - 首领站的 `to` 只写了地图、而事实表里这个首领在这张图上恰好有一个触发点时,`submit_plan` 退回:“首领站「210」要写坐标：卡尔拉波斯的触发点是 210:58,34”。有多个或没有时不退回。
3. **回复手段一行**(`facts.ts`):在“队伍”下面加一行“回复手段”,只列事实：会回复魔法的人和魔法名(用 `skills/battle.ts` 的 `HEAL_SPELLS`)、背包里回复道具的数量(`HEAL_ITEMS`)和复活道具的数量(仓库里已有的复活道具名单，没有就用知识库里不死鸟之尾的中英日名);都没有就写“没人会回复魔法，没有回复道具”。结构化数据里也放上。**不写建议**(不写“建议带白魔”之类)。
4. **提示词**(`prompt.ts`,计划模式那段):说明修订的规矩——出例外后改计划时，保留上一份没做的站，只改出问题的部分;确实不做的写进 `dropped` 并写原因;首领站写触发点坐标。只写流程和格式，不写打法。

## 测试

自编事实和计划:同一节上一份出例外时，少了没做的站被退回、写进 dropped 就收、同图同动作换坐标也收;新的一节不检查;首领触发点从自编地图 events 里按日文名找出、只写地图的首领站被退回;回复手段一行的几种情况(有人会治疗、只有道具、什么都没有);提示词对照文件更新。`npm run check` 全过。

## 回报

不超过 25 行:改了哪些文件、新端口的形状、事实表多出来的两处文字样例、拿不准的地方、`npm run check` 结尾。

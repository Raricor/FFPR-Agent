# 任务 138:整段执行器——照段计划把一整段做完，全程不叫模型

工作目录 `dsh/`。可以新建 `src/engine/plan/execute.ts`、`src/engine/plan/game-ports.ts`、`scripts/run-plan.mts`、`test/plan-execute*.test.ts`;可以在 `src/engine/game.ts` 里**只加**执行器需要的公开方法(把现有的私有能力包成公开端口，不改原有行为);可以读 `src/engine/route/`、`src/engine/stage/`、`src/engine/skills/`、`src/engine/tactics.ts`。**不改** `src/engine/plan/types.ts`(共用类型)、不碰 `src/engine/plan/facts.ts|validate.ts|tools.ts|store.ts`(任务 137 同时在写)、`src/plugin/`、`src/engine/prompt.ts`(任务 139),不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编。

## 起因(11-11,用户定的方向)

用户:“让玩的 AI 生成一套详细的规则(走路、开箱路径、打怪、刷怪图鉴和青魔法、打 boss 的动作计划),之后就不要让 AI 来执行了。”今天的真机记录：模型一步步 `go`,风之神殿 10 分钟调了 31 次工具、写理由绕过计划 9 次。新结构：模型出 `SegmentPlan`(`src/engine/plan/types.ts`),**代码执行整段**,返回 `SegmentReport`;出例外才交回模型改计划。本任务做执行这一半。

## 做法

1. `executeSegmentPlan(plan, ports, options)` → `SegmentReport`。`ports`(`ExecutePorts` 接口，在 `execute.ts` 定义)是执行需要的引擎能力;`game-ports.ts` 用 Game 的公开方法实现它。
2. **出发准备**(`plan.prep`,按顺序):换职业/技能、`optimize` 装备、买东西(要在店里时才买;不在就记一条“没买成”,不算例外)、调前后排。用 Game 已有的能力(看 `change_job`、`optimize_equipment`、`buy`/`shop_gear`、队形的实现)。
3. **站点**:按 `plan.stations` 顺序执行，复用路线执行器(`route/execute.ts`)和任务 117/125/129/134/136 的能力：走路(跨图、坐船)、开箱、调查/对话(翻页)、机关、剧情触发格、`choose` 按给定选项、刷怪(`until`)、存档/回复(可选站的跳过规则沿用 136)。被剧情打断翻完继续;走不到的必经站 → 例外 `unreachable`;对话里出现计划没答的选项 → 例外 `story-choice`。
4. **战斗**:执行期间**关掉战术官**(不发起任何模型调用)。普通战斗用 `plan.battle` 里覆盖当前地图的表(没有就用 `maps` 为空的那份;都没有就用现有的默认规则);打得不好换下一张表(沿用现有换表规则)。首领站:`healFirst`/`saveFirst` 先补满、存档，再用 `plan.bosses` 里对应首领的表打;输了 → 例外 `boss-lost`(带战斗经过摘要);游戏结束 → 例外 `gameover`(沿用现有的回 20 号档)。
5. **回头条件**:每站之间、每场战斗后检查 `plan.turnBack`(条件解析可以先写一个本地的小解析器，支持 `party.lowest_hp_pct < N`、`party.dead >= N`、`item.<名> < N`、`party.mp_pct < N`;任务 137 的检查用同一套语法，接线时统一):`heal-and-continue` → 去最近的回复点/用药再继续;`replan` → 例外 `turn-back`。
6. **报告**:`SegmentReport` 的各项如实统计(开箱数按宝箱旗标，任务 135;新登记的图鉴/青魔法按前后对比;`modelCalls` 统计执行期间发起的模型调用，应为 0)。进度同时写 `routebook-progress`(沿用 `BookProgress`,让网页侧栏能看到)。
7. **命令行**:`scripts/run-plan.mts <计划.json>`:不经过 dsh,直接建引擎连真机执行一份计划(读 `~/.config/ffpr-agent/secrets.env` 的方式照现有脚本),打印报告。这是给 Claude 在真机上单独测执行器用的;**单元测试不连真机**。

## 测试

- 用假桥插件/替身端口：准备阶段按顺序调用;站点依次执行;剧情打断后继续;必经站走不到 → `unreachable`;对话选项 → 按 `choose`;首领前补满存档、用首领表、输了 → `boss-lost`;`turnBack` 两种处理;执行期间没有任何模型调用(战术官端口被调用就让测试失败);报告字段。
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑)。

## 回报

不超过 25 行：`ExecutePorts` 有哪些、在 `game.ts` 加了哪些公开方法、战术官怎么关、各类例外怎么判、`run-plan.mts` 怎么用、`npm run check` 结尾、拿不准的地方。

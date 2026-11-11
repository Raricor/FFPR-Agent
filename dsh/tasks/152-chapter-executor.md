# 任务 152:整章执行器——按规则文件跑完一章，代码先兜底，兜不住才交回模型

工作目录 `dsh/`。可以新建 `src/engine/plan/chapter-execute.ts`,可以改 `src/engine/plan/execute.ts`、`src/engine/plan/game-ports.ts`、`src/engine/game.ts`(只加/改计划执行用的方法和端口)、`src/engine/skills/` 里刷怪和商店相关的文件(不改 `skills/move.ts`、`skills/travel.ts`)、`test/`。**不改** `types.ts`、`chapter-types.ts`(共用类型，缺字段在回报里提)。不碰 `chapters.ts`、`chapter-facts.ts`、`knowledge/`、`scripts/`(150)、`validate.ts`、`chapter-validate.ts|store|tools`(151)、`regions.ts`、`skills/move.ts`、`skills/travel.ts`(149 后续)、`src/plugin/`、`src/client/`、`prompt.ts`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试用替身端口。

## 起因

见任务 150(用户 11-11 的新方向)。用户选的兜底方式：执行器先按规则里的兜底自己处理(重试、换路、回旅店/回复点、首领输了多练级再打、拿不到的可选站记下跳过),都不行才叫模型改规则。共用类型在 `chapter-types.ts`:`ChapterPlan`、`ChapterGrowthTarget`、`ChapterFallback`、`ChapterProgress`、`ChapterReport`。`PlanStation` 新加 `do: "buy"` + `items`;`GrindUntil` 新加 `level`、`gil`。

## 做法

1. **整章执行** `chapter-execute.ts`:`executeChapterPlan(plan, ports, options)`:按顺序跑 `growth`(到 `before` 那一段之前先刷到目标)和各段(复用 `executeSegmentPlan`),一章跑完或兜底失败才返回 `ChapterReport`。执行期间不叫模型;计数照 145 的 `planModelCalls()`。
2. **兜底**(读 `plan.fallback`):
   - 站点失败：换新路线重试 `retries` 次;
   - 可选站(宝箱、隐藏道具、刷怪)始终到不了且 `skipOptional`:跳过，记进 `fallbacks`;
   - 首领输了(读档回来后):按 `bossLost` 去 `where` 刷 `levels` 级、回复，再打，最多 `tries` 次;
   - 最低 HP% 低于 `healBelowPct` 且野外回复不了：走回最近的旅店/回复点(知识库地图的 `restorePoints`、旅店)回满再回来接着走;
   - 每次兜底在活动日志写一行、进 `ChapterProgress.fallbacks`;都不行才以 `exception` 返回，写清用过哪些兜底。
3. **`buy` 站**:走到那张图的店里(任务 144 的 `planOpenShop`,柜台站位),按 `items` 顺序买，钱不够买到没钱为止并记下没买到的;买完自动 `optimize` 装备。
4. **刷到等级/金钱**:`GrindUntil.level`(队伍最低等级)和 `gil` 生效，和已有条件一起，先满足哪个停哪个;`growth` 的 `maxMinutes` 是硬上限。
5. **进度和报告**:写 `.deps/ds/chapter-progress-<game>.json`(`ChapterProgress`,开始、每站、每次兜底、结束都写;写盘失败只记警告),段级的 `segment-progress` 照旧写。报告存 `.deps/ds/chapter-report-<game>.json`。路径由调用方传。

## 测试

替身端口：两段一章跑完;growth 刷到等级/金钱才进下一段、超时报;站点失败重试后走通;可选站跳过并记录;首领输一次 → 刷级 → 再打赢;HP 低走回旅店再回来;兜底都失败才 exception;`buy` 站钱不够买一部分;进度和报告文件内容。`npm run check` 全过。

## 回报

不超过 20 行：改了哪些文件、兜底的顺序、`buy`/刷等级金钱怎么接的、拿不准的地方、`npm run check` 结尾。

# 任务 158:执行日志结构化 + 一条命令出整章汇总

工作目录 `dsh/`。可以改 `src/engine/plan/execute.ts`、`src/engine/plan/chapter-execute.ts`(只改日志调用，不改执行逻辑)、活动日志的写入模块(`src/engine/` 下写 `activity-<game>.jsonl` 的地方)、`src/engine/game.ts`(**只改把执行日志接到新文件的地方**)、新建 `scripts/chapter-report.mts`、`test/`。不碰 `src/plugin/`、`src/client/`(任务 157 在改)、`knowledge/`、`regions.ts`、`skills/`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11 晚，用户)

“没必要监控，也仅仅只是浪费 token,你优化一下日志系统，后面你的分析从日志里弄。”

现在执行器往 `activity-ff5.jsonl` 写的是 `kind: "plan"` + 一句中文，类型混在一起;分析一次执行要逐行翻、靠关键字猜(哪站完成、为什么跳过、兜底几次、宝箱开了几个)。Claude 以前开实时监视器盯事件流，费 token。

## 做法

1. **结构化执行日志**:新文件 `.deps/ds/run-<game>.jsonl`(追加写),每条一个对象，固定字段:
   - `at`、`run`(每次执行/续跑一个 id)、`chapter`、`segment`(段下标)、`section`、`station`(站下标，可空)、`type`;
   - `type` 取值至少有:`run.start`/`run.end`(含 status、用时、兜底次数、模型调用数)、`segment.start`/`segment.end`、`station.start`/`station.end`(含 `do`、`to`、`map`、`cell`、`result`: done/failed/skipped/blocked、`evidence`、`note`、`ms`、`attempt`)、`fallback`(含 kind: retry/skip/heal/boss-retry/defer-segment、原因)、`blocked`、`battle`(普通/首领、敌人、胜负、ms)、`chest`(图、格、物品、opened)、`level`、`heal`(前后 HP、用了什么)、`buy`、`resume`(从哪站接着跑、跳过了哪些)、`warn`;
   - 原来的中文活动日志照旧写(面板要用),两边同一时刻写。
2. **汇总命令** `node scripts/chapter-report.mts [--run <id>|--last] [--chapter N]`:读 `run-<game>.jsonl`(和章计划、章进度),输出一屏文字:
   - 每段每站一行：结果、用时、尝试次数、证据/原因(跳过和失败必须写原因);
   - 宝箱/隐藏道具：计划几个、开了几个、跳过几个(逐个列原因);
   - 兜底按类型计数和列表;等待修复的位置和原因;
   - 战斗场数(普通/首领、胜负)、升级、回复;
   - 本次执行用时、执行期间模型调用数;
   - `--json` 输出同样内容的 JSON。
3. 读写都要快(文件可能几万行，汇总 < 1 秒);写盘失败只记一行警告。

## 测试

替身执行：跑一段含完成/失败/跳过/兜底/首领/宝箱的执行，`run-*.jsonl` 字段齐全;汇总命令对自编日志输出正确的计数和原因。`npm run check` 全过。

## 回报

不超过 12 行：字段清单、汇总输出样例(截一段)、改了哪些文件、`npm run check` 结尾。

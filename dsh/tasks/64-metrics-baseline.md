# 任务 64:衡量标准——从日志算一局的指标

范围:
- 只新建文件:`src/engine/metrics.ts`、`test/metrics.test.ts`、`scripts/metrics.ts`(命令行入口);不改已有文件;
- 不改 `../bridge/`、`../agent/`、`../deploy/`;不碰 git;不连笔记本。
- 同时还有另外两个 dsh 任务在改 `src/engine/skills/`、`src/plugin/`:**只跑你自己的测试**(`node --test test/metrics.test.ts`),不要跑整套 `npm run check`,整套我来跑。

## 起因

现在每次改动都只凭一局的印象，说不清变好还是变差。11-08 FF5 从新游戏重新开始，代码也刚换了一大批(连续走路、`go`),正好拿这一局当基线;上一局(11-04 晚到 11-05 早上)当对照。

## 数据在哪(都只读)

- 玩家会话日志:`~/.dsh/sessions/--root-data-FFPR-Agent--/<会话号>/session.v4.jsonl.zstd`,zstd 分帧的 JSONL,`scripts/ask.mjs` 里的 `events()` 有解法(逐帧 `zlib.zstdDecompressSync`)。里面有用户消息(第一条是开局目标，之后每一条都算一次“插手”)、模型的工具调用和结果、每步的 token 用量、轮次开始结束。子代理(战术官)是别的会话目录，头一行 `parentSession` 指回玩家会话。
- `../.deps/ds/activity-ff5.jsonl`:`{at, game, kind, text}`,`kind` 有 `tool`、`event`、`link`、`error`。`event` 的 `text` 以类别开头:`剧情`、`升级 巴兹 1→2`、`首领战 开始:「…」`、`地点 首次到达「…」`、`宝箱 地图 189:…`、`队伍 … 离队`、`首领 击败「…」`、`战败 没有打赢「…」…`。这个文件跨好几局，要按会话的时间窗口截取。
- `../.deps/ds/battles-ff5.jsonl` 和 `battles-ff5.jsonl.bak-*`(以前几局的):每行一场，`startedAt`、`endedAt`、`mapId`、`kind`(`regular`/`boss`)、`result`(`ok`/`wipe`/…)、`detail`、`enemies`、`rewrites`。按时间窗口取。
- `../.deps/ds/tactician-ff5.jsonl`:每次叫战术官一行(`kind` 是触发原因)。
- `../.deps/pilot/timing.jsonl`(35 MB,只读尾部或流式读):`{t, op, via, ms}`,`op` 有 `walkpath`、`walk` 等。走了几格要从会话日志里 `go` 的结果找(结果文字里有 `(x, y) → (x, y):N 格`,也有 `walk.start`/`walk.end` 推送，用哪个可靠你看)。

## 要算的(每局一份，按“玩的小时数”归一)

1. 时长：第一条到最后一条事件的墙钟时间;模型步数;输入/输出 token。
2. 推进:`地点 首次到达` 个数、`首领 击败` 个数、宝箱个数、队伍最高等级(从 `升级` 取)。每小时多少。
3. 战斗：场数、胜率、`wipe` 次数(注意：西侧山谷那场哥布林剧情战输了也会继续，`result` 记成 `wipe`;按 `detail`/地图能区分就单列“剧情战失败”,区分不了就照实算并在输出里注明)、首领战场数和输掉的次数、平均时长。
4. 重复:同一个 `guide` 查询(参数相同)在一局里查了几次;同一个工具 + 相同参数连续失败的次数(结果是错误或 `ok:false`)。
5. 插手：玩家会话里除第一条以外的用户消息条数，列出每条的时间和前 40 个字(区分“继续”和其他)。
6. 走路:`go` 调用次数、其中用地图名/地图号的和用坐标的各多少;`walkpath` 总秒数和总格数 → 每格秒数;“被挡住”次数。旧局用的是 `walk_to`/`walk`,按同样口径算，算不了的写“无”。
7. 工具分布：各工具调用次数和失败次数。
8. 战术官：叫了几次，按 `kind` 分。

## 输出

- `node scripts/metrics.ts --session <会话号> [--session <另一个>]`:每个会话一列，打印一张对比表(中文行名);`--json` 输出同样内容的 JSON。会话号可以只给前 8 位。
- 文件读不到、字段缺失时那一项写“无”,不要整体报错。

## 测试

`test/metrics.test.ts`:用小的假数据(手写几行 JSONL;会话日志用 `zlib.zstdCompressSync` 现场造)测每一类指标，至少：插手计数、时间窗口截取、重复查询、走路每格秒数、`wipe` 的统计。

## 回报

20 行以内：文件、怎么跑、你自己的测试结果，再用真数据跑一次上一局和新局两个会话贴出对比表。沙箱读不到 `~/.dsh/sessions` 或 `../.deps` 的话就说读不到，不要拿复制品或假数据充数，真数据我来跑。

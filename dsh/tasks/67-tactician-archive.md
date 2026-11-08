# 任务 67:战术官交完结果后自动归档它的子会话，只留最近几个

范围:
- 只改 `src/plugin/`(主要是 `tactician.ts`,需要的话 `config.ts`)、`src/index.ts`(如果要加 `inject`),和对应的测试;
- 同时还有另外两个 dsh 任务(新建 `metrics.*`;改 `src/engine/game.ts`、`src/engine/skills/grind.ts`),不要碰它们的文件。**只跑你改到的测试文件**,整套 `npm run check` 我来跑。
- 不改 `../bridge/`、`../agent/`、`../deploy/`;不碰 git;不连笔记本，不连正在跑的网页(3081)。

## 起因

`callTactician` 每叫一次战术官就用 `startActivation({provider: "spawn", delivery: "caller", …})` 开一个新的子会话(标签“战术官 地图 N”)。上一局一晚上开了 110 个，用户在 dsh 网页上看到满屏的子代理，很不方便。
- 复用同一个战术官不行:dsh-subagent 的 README 写着，子代理成功提交结构化结果后就不再收新消息。
- 战术官写的表已经记在 `.deps/ds/tactician-ff5.jsonl` 和战术表文件里，网页右侧“策略”标签也能看，子会话本身归档了不丢东西。
- dsh 自带“归档会话”:`@deepseek-ai/dsh-api-workspace-controller` 的 Host 服务 `ctx.workspaceController`,方法 `archiveSession({ sessionId, stopActivity? })`(见该包 `README.zh.md` 和 `lib/types/commands.d.ts`)。归档可以取消，不删文件。11-08 我从网页接口 `workspace/archiveSession`(参数 `{request: {sessionId}}`)手动归档过 35 个会话，确认能用。

## 要做的

1. `startActivation` 的返回值里有 `childId`(见 dsh-subagent 的 `README.zh.md`“使用本包”一节和类型)。`TacticianActivation` 加上它。
2. 战术官结束后(不管成功、失败、超时)，把它的 `childId` 记进一个按游戏分开的先进先出列表;列表超过 `Config.tacticianKeepVisible`(新配置，默认 2)时，把最老的那个归档(`stopActivity: true`,它已经结束了，这只是保险)。
3. 归档用 Host 服务，按 `dsh/CLAUDE.md` 的规矩:只用有文档的接口，`inject` 拿服务，代码旁注明出自哪个包。服务拿不到、或者归档报错：只 `log.warn` 一次说明原因，战术官照常工作，绝不让它影响打仗。
4. 网页重启后列表是空的，重启前的那几个不会被归档，可以接受，在注释里写明。
5. 测试：用假的 starter 和假的归档服务，测“超过 2 个时归档最老的”“归档报错不影响战术官的结果”“失败的战术官也会被记进列表”。

## 回报

20 行以内：用的哪个接口、怎么拿到的;你跑的测试结果;拿不准的地方。

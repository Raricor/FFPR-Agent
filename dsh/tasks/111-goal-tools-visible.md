# 任务 111:目标工具让玩家看得见(任务 107 的漏洞)

工作目录 `dsh/`。可以改 `src/plugin/player.ts`、`src/engine/prompt.ts`(只改“长期目标”那几行和 `done` 工具的回复)、`test/`(含 `test/fixtures/prompt/` 里随提示词变的对照文件)。不碰 `src/plugin/tactician.ts`、`src/plugin/stage-officer.ts`、`../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-10 真机)

- 新游戏的第一条消息要模型“先用目标工具创建长期目标”。模型的思考原文:"there's no goal tool listed in the functions! ... So I can't create a goal",直接去玩了。上一个会话也是 0 个 goal 事件：目标模式从来没在真机上生效过。
- 原因一:`src/plugin/player.ts` 的 `registerAgent` 里 `agent.ctx.tools.restrict({ allow: [] })` 挡掉所有继承来的工具。`@deepseek-ai/dsh-tool-goal` 注册的 `get_goal` / `create_goal` / `update_goal` 是继承来的，一起被挡了(`dsh-tools` 的 `README.zh.md` 第 85 行:掩码只作用于继承的全局工具，作用域注册保持可见)。
- 原因二：玩家人设段是 `complete: true`(`dsh-system-prompt` 的 `README.zh.md`:complete 段就是完整提示词),`dsh-tool-goal` 自己注册的 `tool:goal` 说明段也进不了提示词。

## 做法

1. 玩家的 `restrict` 放行这三个目标工具，其他继承工具照旧挡住。名字写成一个常量，旁边注明出自 `@deepseek-ai/dsh-tool-goal` 的 `README.zh.md`「工具」表。先读 `dsh-tools` 的 README 和 `lib/types` 确认 `allow` 的语义(继承工具里只留名单上的);预设里没挂 `dsh-tool-goal` 时，名单上的名字不存在也不能出错。
2. 战术官、阶段官的 `allow: []` 不动(子智能体不许碰目标,`dsh-tool-goal` 也会拒绝)。
3. 提示词“长期目标”那几行补上工具用法(因为 `tool:goal` 段进不来):
   - 没有目标时 `get_goal` 返回 null;人在对话里要求时用 `create_goal(objective)` 创建;
   - 改状态前先 `get_goal` 拿到 `goal_id` 和 `revision`,再 `update_goal`(`complete` 只在整个目标真的达成时用;`blocked` 要同一条件连续 3 轮，并在 `blocked_reason` 写清);
   - 保留现有的“每一轮推进一段、轮末两三句进展、不要因为一段结束就标完成”。
4. `done` 工具的回复里“用目标工具标完成”写明是 `update_goal`。

## 测试

- 玩家:`restrict` 收到的掩码放行这三个目标工具，不放行别的继承工具(比如 `bash`、`read_file`);我们自己注册的游戏工具照旧可见。能用 dsh 真的 tools 服务测“玩家看到的工具清单”就用真的，测不了就用替身并在回报里说明;
- 战术官、阶段官的掩码仍是 `allow: []`;
- 提示词对照文件更新;
- `npm run check` 全过。

## 回报

不超过 15 行：改了哪些文件、`allow` 的语义查的是哪份文档、测试用的是真 tools 服务还是替身、`npm run check` 结尾。

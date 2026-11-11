# 任务 139:计划模式接线——玩家只出计划、改计划;执行全交给代码

工作目录 `dsh/`。可以改 `src/engine/game.ts`(注册工具、接端口)、`src/plugin/player.ts`(工具限制)、`src/plugin/config.ts`(Config 项)、`src/engine/prompt.ts`(玩法说明)、`test/`(含 `test/fixtures/prompt/`)。**不改** `src/engine/plan/types.ts`;不碰 `src/engine/plan/execute.ts`、`src/engine/plan/game-ports.ts`、`src/engine/skills/`、`src/engine/regions.ts`、`src/engine/route/`(任务 140 同时在改);可以 import 任务 137 的 `plan/facts.ts|validate.ts|tools.ts|store.ts` 和 138 的 `plan/execute.ts`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编，不放攻略和游戏原文。

## 起因(11-11,用户定的方向)

用户:“让玩的 AI 生成一套详细的规则(走路、开箱路径、打怪、刷怪图鉴和青魔法、打 boss 的动作计划),之后就不要让 AI 来执行了。”今天真机：模型一步步 `go`,写理由就能绕过计划(风之神殿 10 分钟绕 9 次)。任务 137 做好了事实/草稿/检查/工具定义/存盘，138 做好了整段执行器(`executeSegmentPlan`,执行期间不叫模型，返回 `SegmentReport`)。本任务把它们接成玩家的玩法。

## 做法

1. **工具**(在 Game 里注册，处理函数用 137/138 的):
   - `plan_facts`(137 的定义):当前或指定节的事实 + 草稿;
   - `submit_plan`(137):检查，通过就存盘;
   - `execute_plan`:执行当前存盘的计划(138 的 `executeSegmentPlan` + `game-ports`),**一直跑到这一段做完或出例外才返回**;返回报告的中文摘要 + 结构化 JSON;报告同时存盘;
   - `plan_status`:当前计划摘要、上一份报告。
2. **计划模式**(Config `planMode`,默认开):玩家能用的工具只剩 `plan_facts`、`submit_plan`、`execute_plan`、`plan_status`,加上只读查询(`guide`、`atlas`、`inventory`、图鉴/成就查询、`look_around` 若它只读——逐个核对，凡是会按键、走路、改游戏状态的都不留);`go`、`route`、`interact`、`advance_story`、`fight`、`set_tactics`、`grind`、`buy`、`change_job`、`save_game` 等一律不给(准备、存档都写进计划)。`planMode` 关掉时恢复现在的工具集(兼容)。看任务 111 的 `restrict` 写法，目标工具照旧放行。
3. **执行期间不叫模型**:`execute_plan` 运行时战术官、阶段官暂停(138 已经做了暂停，这里确认接上);目标模式的轮次在工具返回前不会发起新的模型调用。
4. **提示词**:改写“怎么玩”那一段，说明计划模式的循环:`plan_facts` → 按事实写完整计划(走路开箱顺序、普通战斗规则表、刷怪目标、首领准备和首领规则表、回头条件)→ `submit_plan`(不通过按问题改)→ `execute_plan` → 读报告：完成就规划下一节;出例外就按报告改计划再执行。只写玩法流程和格式，不写打法建议。旧的走路/开箱说明在计划模式下不出现。
5. **测试**:计划模式下玩家工具清单(用真的 dsh `ToolRuntime`,照 `player-goal-tools.test.ts`)只有上述工具 + 目标工具;`execute_plan` 调用执行器并返回报告(用替身执行器);`planMode` 关掉时工具集照旧;提示词对照文件更新;`npm run check` 全过。

## 回报

不超过 20 行：注册了哪些工具、计划模式留下的只读工具清单(逐个说明为什么只读)、提示词改了哪些段、`npm run check` 结尾、拿不准的地方。

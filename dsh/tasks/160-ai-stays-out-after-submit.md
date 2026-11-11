# 任务 160:提交后 AI 真的退场——执行中、等待修复时不许再起目标、不许重交

工作目录 `dsh/`。可以改 `src/plugin/player.ts`、`src/plugin/` 下章相关的胶水(工具把关、提示词段)、`src/engine/plan/chapter-tools.ts`(只加“执行中不许交”的检查)、`test/`。不碰 `src/engine/plan/execute.ts`、`chapter-execute.ts`、`game.ts`、`game-ports.ts`、`dry-run.ts`(任务 161 在改)、`src/client/`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11 晚真机，新游戏第 1 章)

用户的要求(原话):“一旦规则完成之后，AI 就停止接入，完全交给执行器。”执行器处理不了就记“等待修复”,由开发这边修代码后用 `scripts/chapter-resume.mjs` 续跑;**整章跑完才再叫 AI**。

实际经过(会话事件):
1. 第 1 轮:AI `submit_chapter_plan` 通过 → `ChapterRunner.start` 去停自动续轮，但这时**还没有目标**,什么也没停。
2. 同一轮里 AI 接着 `create_goal`(“一路玩到通关…”),新目标是 armed,第 1 轮结束后 dsh 自动开第 2 轮。
3. 这时执行器已经“等待修复”(成长目标在片头刷不了)。第 2 轮里 AI 读了第 2 章的攻略，又 `chapter_status`、`look_around`,第 3 轮把第 1 章计划重写一遍再交;执行器被重新启动。它原话:“考虑到上两轮游戏内毫无动作，这轮我主动重建并重交了计划”。
4. `submit_chapter_plan` 不检查当前章是不是正在跑/等待修复，要是交了第 2 章，会把第 1 章计划覆盖掉。
5. `chapterAbandonText` 里还写着“改好受影响的段后用 submit_chapter_plan 重新交”,这是任务 153 的旧说法，和 155 以后的做法矛盾。

## 做法

1. **执行中、等待修复时，模型的工具全部挡掉**(用 `ctx.tools.guard`,最弱够用的机制):章执行器状态是 running 或 blocked 时，除了只读的 `chapter_status`,其余工具(含 `create_goal`/`update_goal`、章草稿/提交工具、所有游戏工具)一律返回一句中文:「第 N 章正由执行器在后台跑(或：等待开发修复)，这一轮到此结束，不要再调用工具；整章跑完会再叫你」。
2. **目标**:执行中/等待修复时新建或恢复的目标，立刻 disarm(第 1 步挡住之外的兜底，比如 dsh 自己恢复会话);整章 done 时照 155 的做法 rearm 并发下一章的提示。没有目标时，章跑完照旧用 followup 叫模型。
3. **`submit_chapter_plan` 自己也检查**:当前章计划状态是 running/blocked 时拒绝，原因同上;只有没有当前章、上一章 done，或操作员 `chapter-resume.mjs --abandon` 之后才收。
4. 提交成功的工具结果写清：「规则文件已定稿，执行器接管第 N 章。你这一轮现在就结束，不要再调用任何工具(包括建目标)。」
5. 改掉 `chapterAbandonText` 里和 155 矛盾的说法(abandon 后才是重新规划，可以照旧交;要写清这是操作员结束了本章)。提示词段里如果还有“出例外改受影响的段再交”的旧说法，一并改成“执行中你不参与，跑完才叫你”。

## 测试

替身 dsh 接口:
- 提交后同一轮再 `create_goal` → 被挡，返回那句话，没有新的 armed 目标;
- 执行器 blocked 时，模型调游戏工具/草稿/提交都被挡,`chapter_status` 能用;
- running/blocked 时 `submit_chapter_plan` 被拒;`--abandon` 之后能交;
- 整章 done → 目标 rearm、下一章提示发出，工具不再被挡。

`npm run check` 全过。

## 回报

不超过 12 行：怎么判定 running/blocked(读的哪个状态)、把关挂在哪、改了哪些文件、`npm run check` 结尾。

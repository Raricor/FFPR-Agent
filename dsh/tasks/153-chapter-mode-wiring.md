# 任务 153:整章模式接线——工具、执行/续跑、提示词、侧栏面板

工作目录 `dsh/`。可以改 `src/engine/game.ts`(注册工具、接端口)、`src/plugin/player.ts`、`src/plugin/config.ts`、`src/engine/prompt.ts` 和 `test/fixtures/prompt/` 对照文件、`src/plugin/plan-panel.ts`(或新建 `src/plugin/chapter-panel.ts` 由 panel.ts 注册)、`src/plugin/panel.ts`(只注册)、`src/client/index.ts`、`src/engine/plan/chapter-execute.ts`(只为填 `ChapterReport.exception` 和续跑)、`test/`。**不改** `types.ts`、`chapter-types.ts`(共用类型，缺字段在回报里提)、`chapters.ts`、`chapter-facts.ts`、`chapter-validate.ts`、`chapter-store.ts`、`chapter-tools.ts`(150/151 刚写完，只 import;发现 bug 在回报里写清)、`knowledge/`、`skills/move.ts`、`regions.ts`(149 在改)。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编。

## 起因

用户 11-11 的方向(详见任务 150):AI 读攻略，一次规划一整章(23 章之一)写成规则文件，代码检查后整章执行，代码兜底不了才叫 AI;规划用 max 思考强度(profile 已设)。150(章节表、整章事实、攻略原文)、151(六个工具的定义和处理函数、分段起草、整章检查、存盘)、152(`executeChapterPlan`、兜底、`buy` 站、刷到等级/金钱、章进度和报告文件)都已完成，本任务把它们接成玩家的玩法。

## 做法

1. **工具注册**(game.ts):`chapter-tools.ts` 的六个工具 + 新的 `execute_chapter`:
   - `chapter_facts` 端口用 `buildChapterFactsFromDisk` + `chapterFactsText`,默认当前章(`chapters.ts` 的 `currentChapter`);
   - `read_guide` 端口用 `chapters.ts` 的攻略原文;
   - 草稿/计划存盘用 `chapter-store.ts`;
   - `execute_chapter`:执行当前通过检查的章计划(`executeChapterPlan` + 152 的端口),**从章进度续跑**:已完成的段和站跳过(用 152 的 `startAt`/`skipStations`),一直跑到整章完成或兜底都失败;返回章报告的中文摘要 + JSON,报告存盘;`ChapterReport.exception` 在 `chapter-execute.ts` 里填上(哪段哪站、什么例外、试过哪些兜底)。
2. **整章模式**(Config `chapterMode`,默认开;开时盖过 `planMode`):玩家工具只剩七个章工具 + 只读查询(沿用 139 的清单)+ 目标工具;`plan_facts`/`submit_plan`/`execute_plan` 不给。`chapterMode` 关掉时回到 139 的计划模式。执行期间不起战术官/阶段官(145 已做，确认接上)。
3. **提示词**(prompt.ts,整章模式那段，替换计划模式的循环说明):`chapter_facts` → 逐节 `read_guide` 读本章攻略原文 → 逐段 `chapter_draft_segment`(本章每个没完成的节一段)→ `chapter_draft_meta`(growth、fallback、skipped)→ `submit_chapter_plan`(不通过按问题改)→ `execute_chapter` → 读报告：完成就进下一章;出例外就 `chapter_status` 看停在哪，改受影响的段再提交，再 `execute_chapter` 续跑。写清规则文件要覆盖什么(宝箱、隐藏道具、每图图鉴和青魔法、城镇采购、练级攒钱、首领准备和规则表、兜底)、不做的写进 `skipped`。只写流程和格式，**不写打法建议**。
4. **侧栏面板**:章节进度(读 `chapter-plan-<game>.json`、`chapter-progress-<game>.json`、`chapter-report-<game>.json`):章号和标题、目标、第几份规则文件、各段(节名、站数、完成到哪)、当前段的站点表(沿用 147 的显示)、growth 目标、兜底记录、skipped 清单、最近报告(例外详情)。整章模式下显示章面板，原来的段计划面板在计划模式下照旧。
5. **测试**:整章模式下玩家工具清单(真 `ToolRuntime`,照 `player-goal-tools.test.ts`);`execute_chapter` 续跑(替身执行器，已完成的段/站被跳过);报告 exception 字段;面板路由(自编三个文件、缺文件、坏 JSON);提示词对照文件。`npm run check` 全过，`npm run build` 后 `lib/client.js` 正常。

## 回报

不超过 20 行：改了哪些文件、整章模式下工具清单、续跑怎么判断从哪接着跑、面板路由返回样例(截一段)、拿不准的地方、`npm run check` 结尾。

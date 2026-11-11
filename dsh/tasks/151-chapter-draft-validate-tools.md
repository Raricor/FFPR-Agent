# 任务 151:整章规则文件——分段起草、整章检查、存盘、工具

工作目录 `dsh/`。可以新建 `src/engine/plan/chapter-validate.ts`、`chapter-store.ts`、`chapter-tools.ts`,可以改 `src/engine/plan/validate.ts`(导出已有检查函数、加 `buy` 站的检查)、`test/`。**不改** `types.ts`、`chapter-types.ts`(共用类型，缺字段在回报里提)。不碰 `chapters.ts`、`chapter-facts.ts`、`knowledge/`、`scripts/`(任务 150 在写)、`execute.ts`、`game-ports.ts`、`game.ts`(152 在改)、`src/plugin/`、`src/client/`、`prompt.ts`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编。

## 起因

见任务 150 的起因(用户 11-11 的新方向)。共用类型在 `src/engine/plan/chapter-types.ts`:`ChapterPlan`(多个 `SegmentPlan` + `growth` + `fallback` + `skipped`)、`ChapterFactsData`。`types.ts` 的 `PlanStation` 新加了 `do: "buy"` 和 `items`;`route/types.ts` 的 `GrindUntil` 新加了 `level`、`gil`。

一章的规则文件可能有上百站，一次工具调用写不下，所以分段起草，最后一次性检查。

## 做法

1. **存盘** `chapter-store.ts`:`.deps/ds/chapter-draft-<game>.json`(草稿)和 `chapter-plan-<game>.json`(通过检查的当前计划 + 每章最多 5 份历史)。路径函数照 `store.ts` 的写法，调用方传入。异步读写，坏文件变中文错误。
2. **工具定义和处理函数** `chapter-tools.ts`(照 `tools.ts` 的写法，只定义和处理，注册由任务 153 做;处理函数用端口，不直接碰游戏):
   - `chapter_facts({chapter?})`:端口取 `ChapterFactsData` 和文字版;
   - `read_guide({section})`:端口取某一节攻略原文;
   - `chapter_draft_segment({index, plan})`:把第 index 段的 `SegmentPlan` 放进草稿(覆盖同下标)，并当场用这一节的事实检查这一段，把问题列给模型;
   - `chapter_draft_meta({chapter, goal, growth, fallback, skipped, notes})`;
   - `submit_chapter_plan()`:整章检查，通过就存成当前计划、清草稿，不通过就逐条列问题;
   - `chapter_status()`:草稿/当前计划摘要。
3. **整章检查** `chapter-validate.ts`(每段用现有 `validatePlan`,再加整章的):
   - **覆盖**:本章没开的宝箱和隐藏道具 → 有同图同格的 `open` 站或在 `skipped`;没打的首领 → 有 `boss` 站或在 `skipped`;每张图缺的图鉴 → 某个 `grind` 站的 `until.bestiary` 含它，或在 `skipped`;能学没学的青魔法 → `until.blueMagic` 含它，或在 `skipped`(队里没有青魔导士又不换职业时，只能 `skipped` 并写原因);
   - **`buy` 站**:地图上有这家店，`items` 都是这家店卖的(三语名/编号比对，沿用 142 的清洗);整章采购总价超过“现有金钱 + 本章宝箱里的金币”时给警告(不退回);
   - **growth**:`before` 在段的范围内，`where` 是合法站点写法，`level`/`gil` 至少一个，`maxMinutes` > 0;
   - **fallback**:字段齐全、数值合理(重试 0–3、首领重打 0–3 次、`healBelowPct` 10–60);
   - **段的顺序**:段按章内节的顺序，已完成的节不用写。
   - 问题文字中文，一条一行，指出第几段第几站。
4. 测试：自编章事实和计划：漏了宝箱/隐藏道具/图鉴/青魔法/首领被退回、写进 skipped 就收;`buy` 站卖不卖;growth/fallback 的边界;分段起草后整章提交;坏草稿文件。

`npm run check` 全过。

## 回报

不超过 20 行：改了哪些文件、六个工具的参数形状、整章检查的条目、拿不准的地方、`npm run check` 结尾。

# 任务 150:章节划分 + 整章事实(含隐藏道具、各图遇敌、各城镇商店、攻略原文)

工作目录 `dsh/`。可以新建/改 `src/engine/plan/chapters.ts`、`src/engine/plan/chapter-facts.ts`(都新建)、`src/engine/knowledge/game-files.ts`、`src/engine/knowledge/` 下**新建**的文件(不改 `knowledge/jumps.ts`,任务 149 的后续在改)、`scripts/game-files.mts`、`src/engine/plan/facts.ts`(只许导出已有函数，不改行为)、`test/`。**不改** `src/engine/plan/types.ts`、`chapter-types.ts`(Claude 定的共用类型，缺字段在回报里提)。不碰 `src/engine/plan/validate.ts|execute.ts|game-ports.ts|store.ts|tools.ts`(151/152 在改)、`src/engine/game.ts`、`src/plugin/`、`src/client/`、`src/engine/prompt.ts`、`skills/move.ts`、`regions.ts`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编，不放攻略和游戏原文;真实 `.deps` 只在本机核对，不进测试。

## 起因(11-11,用户定的新方向)

一节攻略一份计划太短，AI 总在补洞。用户要：AI 自己读攻略，一次规划到下一个主线节点的全部内容——路线、宝箱和隐藏道具、每张图的图鉴和青魔法、城镇里的装备/魔法/道具采购、练级和攒钱——写成一份规则文件，代码照着执行完，AI 不再介入(代码兜底不了才叫它)。全游戏分 15–30 个节点。

共用类型在 `src/engine/plan/chapter-types.ts`(先读它):`ChapterRange`、`ChapterFactsData`、`ChapterHiddenItem`、`ChapterShop`、`ChapterEncounterMap`。

## 做法

1. **章节表** `chapters.ts`:攻略 walkthrough 一共 77 节(下标 0–76,0 是介绍、76 是结尾，不算)。按下标区间分 23 章，代码里只写数字，不写标题(标题运行时从 `.deps/knowledge/ff5/guide.json` 读):
   `[1,3] [4,7] [8,10] [11,14] [15,16] [17,20] [21,23] [24,25] [26,27] [28,31] [32,33] [34,36] [37,40] [41,44] [45,47] [48,51] [52,53] [54,58] [59,61] [62,64] [65,67] [68,71] [72,75]`。
   提供：按节下标找章;当前章(用 `facts.ts` 里“当前所在、未完成的节”那套判断，拿到节下标再找章);章的标题 = 首节标题 → 末节标题(运行时拼)。
2. **隐藏道具**:游戏文件里找“调查某格得到道具”的点(壶、柜子、看不见的宝箱等：实体挂的脚本里有给道具的指令，或不显示的宝箱实体)。导出到每张图的 `hiddenItems: [{cell, item, script}]`(game-files.mts + knowledge),物品名用三语名里的中文。开没开过：能用宝箱标记/剧情标记判断就判断，不能就 `null`。回报里写：全 FF5 找到多少个、用什么规则认的、抽 3 个和攻略对照的结果。
3. **整章事实** `chapter-facts.ts`:`buildChapterFacts(chapter)` → `ChapterFactsData`:
   - 每节调用现有的段计划事实(`facts.ts`,需要的话只把现有函数导出),标出 `done`;
   - `hiddenItems`:本章各图的隐藏道具;
   - `shops`:本章各图(含经过的城镇)的全部商店、全部货品和价格、柜台站位(任务 144 已有店员位置的关联);
   - `encounters`:本章每张有遇敌的图：怪物名、图鉴编号、本档登记了没有、能学的青魔法、经验/金币/ABP(从 `Data/Master` 的怪物表取;取不到为 null)。
   - 另给一个 `chapterGuideText(chapter)`:按顺序返回本章每节攻略的完整原文(只在运行时读 `.deps`,给模型读;不进代码和测试)。
   - 中文文字版(给模型看):按节列出，后面附隐藏道具、商店、遇敌三张表;控制长度(一章十几到几十张图)。
4. 真实数据核对(不进测试):第 2 章(下标 4–7)的事实里，宝箱、隐藏道具、商店、遇敌各多少;文字版多长(字数)。

## 测试

自编小游戏数据：章节表查找、当前章判断、隐藏道具从自编脚本里认出来、商店货品价格、遇敌表经验金币、文字版包含各部分。`npm run check` 全过。

## 回报

不超过 25 行：改了哪些文件、隐藏道具的认法和数量、第 2 章事实的统计和文字版长度、`chapter-types.ts` 缺什么字段、拿不准的地方、`npm run check` 结尾。

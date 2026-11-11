# 任务 137:段计划——给模型的事实、交计划的工具格式、计划检查、存盘

工作目录 `dsh/`。只许新建 `src/engine/plan/facts.ts`、`src/engine/plan/validate.ts`、`src/engine/plan/tools.ts`、`src/engine/plan/store.ts` 和对应的 `test/plan-*.test.ts`;可以读(不改)`src/engine/stage/`、`src/engine/route/`、`src/engine/knowledge/`、`src/engine/gambit.ts`、`src/engine/tactics.ts`。**不改** `src/engine/plan/types.ts`(Claude 写的共用类型，任务 138、139 也在用;类型不够用就在回报里提)。**不碰** `src/engine/game.ts`、`src/plugin/`、`src/engine/prompt.ts`(任务 138、139),不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。测试数据自己编，不放攻略和游戏原文。

## 起因(11-11,用户定的方向)

用户的原话:“我要求的是让玩的 AI 生成一套详细的规则，包括走路，开箱路径规划，打怪，刷怪图鉴和青魔法，以及打 boss 的动作计划，之后就不要让 AI 来执行了。”
新结构:**模型每段出一份完整计划(`SegmentPlan`,见 `src/engine/plan/types.ts`),代码全程执行，不叫模型;只有出例外时把 `SegmentReport` 交回模型改计划。** 本任务做“规划”这一半里不依赖 Game 的部分。

## 做法

1. **事实(`facts.ts`)**:`segmentFacts(input)` 为路线书的某一节整理给模型看的事实(纯函数，输入是已加载的路线书节、知识模块、本档状态、队伍状态;用 `stage/route-book*.ts` 已有的导出),输出:
   - 结构化:`SegmentFactsData`(在本文件里定义):这一节的地图和连通、站点草稿(由路线书站点转成 `PlanStation[]`,沿用任务 117/126/133/136 的转换规则：已开的宝箱不列、回复/存档可选、`book` 来源)、怪物(弱点/吸收/状态招式/青魔法/会不会错过)、首领资料(HP、弱点、抗性、攻略说明的要点)、商店(这节附近能买什么)、队伍(职业、等级、HP/MP、技能、背包要点)、本档图鉴/青魔法还缺什么;
   - 文本:给模型的中文说明，控制在合理长度(超过时省略细节并写明“完整见 …”);
   - `draftPlan`:一份可以直接执行的保守草稿(站点 = 路线书草稿;战斗表、首领表空着),模型在它上面改。
2. **检查(`validate.ts`)**:`validatePlan(plan, facts)` 返回 `{ ok, problems: string[](中文), fixed?: SegmentPlan }`:
   - 结构：字段齐全、枚举合法、`version === 1`;
   - 站点：地图属于这一节(或通往它的路上),`to` 拼写合法，`choose` 只出现在 `choose` 站，`until` 只在 `grind`;
   - 刷怪：`until.bestiary` 的怪在这节地图遇得到;`until.blueMagic` 有人能学(有青魔导士)且教的怪在这里;
   - 准备：职业名、道具名存在(用知识模块的三语名对);买的东西在这节附近的商店有卖;
   - 战斗/首领表：每张表用现有规则检查(`gambit.ts`/策略 2.0 的检查)能解析，有问题列出;
   - `turnBack.when` 能被解析(先支持几种：`party.lowest_hp_pct < N`、`party.dead >= N`、`item.<名> < N`、`party.mp_pct < N`;不认识的报问题);
   - 能自动修正的小问题(比如回复站没写 optional)放进 `fixed`。
3. **工具格式(`tools.ts`)**:导出两个工具的定义(名字、中文说明、参数 JSON schema),**不注册**(任务 139 接线):`plan_facts`(参数：节名可选，默认当前节;返回事实文本 + 草稿 JSON)、`submit_plan`(参数：整份 `SegmentPlan`;schema 要能通过 `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema`)。再导出两个处理函数(输入是端口对象，不依赖 Game):`handlePlanFacts(ports, args)`、`handleSubmitPlan(ports, args)`(检查 → 不通过就返回问题清单让模型改;通过就存盘并返回“计划已收下，可以 execute_plan”)。
4. **存盘(`store.ts`)**:当前计划和历史(每节最多保留 5 版)存 `.deps/ds/segment-plan-<game>.json`(路径由调用方给);读写异步，坏文件给中文错误不崩。

## 测试

- 用编的小路线书节/知识/队伍：事实文本包含站点、怪物弱点、首领、商店;草稿能通过检查;各类错误计划各报出对应问题;`turnBack` 解析;工具 schema 通过 `assertSupportedJsonSchema`;存盘读写和坏文件。
- 真实数据测试(文件不在就跳过):为「Wind Shrine」生成事实和草稿，草稿通过检查，事实文本列出翼龙和 4 个宝箱里还没开的。
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑)。

## 回报

不超过 20 行：事实里有什么、草稿怎么来、检查的项目、两个工具的参数、真实数据上风之神殿的事实长度、`npm run check` 结尾、类型不够用的地方。

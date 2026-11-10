# 任务 114:把 Steam 攻略的每一节拆成有先后的步骤(路线书的原料)

工作目录 `dsh/`。只许新建 `src/engine/stage/guide-steps.ts` 和 `test/guide-steps.test.ts`。**不改** `src/engine/stage/guide-types.ts`(Claude 写好的共用类型，任务 115 同时在用;觉得类型不够用就在回报里提，不要自己改),不碰别的文件，不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11,用户定的方向)

用户要“长时间规划 + 无延迟高速执行(寻路、开箱、战斗)+ 青魔法、图鉴、宝箱收集有保证 + 完整路径看得见”。现在每一步都要模型想一次，开场 23 次坐标 `go`。第一步是做“路线书”:按攻略的顺序把一整段要做的事列出来，代码执行、用户先审。本任务把攻略拆成结构化的步骤;任务 115 把步骤对上地图、拼成路线书。

## 数据

- 攻略缓存在开发机 `../.deps/knowledge/ff5/guide.json`(不进版本库;读它的测试在文件不在时跳过)。`walkthrough` 是 77 节 `{ title, text, shops, treasures }`,`text` 是一行一句的英文。
- 已有的解析(任务 93)在 `src/engine/knowledge/` 里，看一下 `treasures` 字段是怎么来的，能复用就复用，不要改那边的文件。

`text` 的写法(以「Wind Shrine」一节为例):
- **小节标题**单独一行:`Overworld`、`Wind Shrine - 1F`、`Tule`、`Greenhorn's Club`、`Tule - Pub`。判断依据：短、没有句号、不是表格里的格子;后面的步骤都归到这个小节下，直到下一个标题。
- **宝箱 / 隐藏道具**:句子里带 `[6/225]`(宝箱)或 `{3/46}`(隐藏道具)。一句里可能写了几样东西、只带一个总编号(`Search the pot for a Potion, the barrel for a Phoenix Down, and the box for a Tent. {8/46}` 是 6–8 三个)——拆成几步，编号往回推;拆不清的照原样一步，`item` 为 null。
- **怪物表**:`BESTIARY: X` 一行，然后 `ID`、`MONSTER`、`HP`、`MP`、`GIL`、`EXP` 六个列名各占一行，再是每只怪六行(`005`、`Killer Bee`、`20`、`0`、`20`、`15`);某只怪后面紧跟一行 `BM: Goblin Punch` 就是它的青魔法。
- **首领块**:首领名一行，然后 `ID` `HP` `MP` `ATK` `DEF` `EVA` `M.DEF` `MAG` `WEAKNESS` `RESIST.` `ABSORBS` `CANCELS` 十二个列名各一行，再十二个值各一行(`229`、`250`、…、`None`、`Mini, Toad, Petrify`、`None`、`None`);`None` 算空。
- 其余句子按关键词归类(`GuideStepKind`):talk(Speak/answer/talk)、switch(switch/lever/push/secret passage)、save(save/consecrated circle)、heal(healing point/restore your party)、cutscene(cutscene/scene)、shop、piano、move(Head/Go/Take/Return/Exit/Enter…),都不像就 note。关键词表写成常量，便于以后补。

## 做法

- 导出 `parseGuideSection(section: { title: string; text: string }, order: number): GuideSection` 和 `parseWalkthrough(walkthrough: unknown): GuideSection[]`(外部数据先当 `unknown`,检查后再收窄)。
- 类型全部用 `src/engine/stage/guide-types.ts` 里的。
- 纯函数，不读文件、不碰网络;读文件由调用方做。

## 测试

- 用自己写的短文本(照上面的格式编)测:小节标题切分、宝箱/隐藏道具编号、一句多物拆分、怪物表含 BM、首领块的 HP/弱点/抗性、归类;不要把攻略原文大段抄进测试(攻略有版权，测试数据要进公开仓库)。
- 一条读真实缓存的测试(文件不在就 `t.skip`):77 节都能解析;「Wind Shrine」有 4 个宝箱(6–9)、首领 Wing Raptor HP 250;「Tule」的隐藏道具编号连续、没有重号;全攻略宝箱编号去重后的数量写进回报(攻略说一共 225 个，隐藏道具 44/46 个，对不上就照实写)。
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑，回报写清)。

## 回报

不超过 20 行：导出了什么、标题怎么判断、一句多物怎么拆、真实攻略上宝箱/隐藏道具编号各解析出多少个(和 225、46 比)、归不了类(note)的句子占多少、`npm run check` 结尾。

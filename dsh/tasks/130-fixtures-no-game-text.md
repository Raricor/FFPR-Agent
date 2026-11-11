# 任务 130:测试数据里不能有攻略原文和游戏原文

工作目录 `dsh/`。只许改 `test/` 下的文件(含 `test/fixtures/`)。不碰 `src/`,不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因

本仓库是公开的。攻略(Steam)和游戏数据有版权，只能放在本机 `../.deps/`。任务单一直写“测试数据自己编，不要从里面拷”,但现在有两处违反:
1. `test/fixtures/stage/route-book-3-sections.json`(任务 124 加的回归对比):用真实数据生成的路线书，里面有大量攻略原文和游戏名字。
2. `test/fixtures/game-files/`(任务 120)里有从游戏文件截出来的内容，比如 `ev_e_0021.json` 的 `ゾックの家`,`system_*.txt` 的真实文字键和译名;`test/fixtures/knowledge-files/` 也检查一遍。

## 做法

1. 删掉 `route-book-3-sections.json`;那条回归测试改成：真实数据在(`../.deps/knowledge/ff5/guide.json` 等存在)时，现场生成 3 节路线书，和 `../.deps/tests/route-book-3-sections.json`(第一次运行时写入，之后比对;这个文件在 `.deps/` 里不进版本库)比对;不在就 `t.skip`。
2. `test/fixtures/game-files/`、`test/fixtures/knowledge-files/`:把所有真实的名字、文字、键值换成编的(比如 `宝箱A`、`测试村`、`MSG_ITEM_NAME_901`、英文 `Test Potion`),结构保持一样，测试断言跟着改。检查所有新文件里不再出现日文游戏名、攻略句子。
3. 全仓 `test/` 里用 `grep` 查一遍常见的游戏/攻略原文(如 `ゾック`、`フェニックス`、`Phoenix Down`、`Head north`、`Wind Shrine` 一类整句),确认只剩真实数据测试里“读 `.deps` 后断言”的少量名字(断言里的物品名、地名可以留，但不要整段原文)。
4. `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑)。

## 回报

不超过 10 行：改了哪些文件、还留下了哪些真实名字(断言里的)及理由、`npm run check` 结尾。

# 任务 116:地图记录里的宝箱存下物品编号、旗标、隐藏、中文名

工作目录 `dsh/`。只许改 `src/engine/game.ts`(只改记录宝箱那一段，以及必要时 `src/engine/atlas.ts` 的注释/类型)和 `test/` 下相关测试。不碰 `src/engine/stage/`(任务 115 同时在改),不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11 审路线书)

路线书把攻略的宝箱和地图记录的宝箱配对时，地图记录里只有格子和日文实体名(`フェニックスのお`、`150ギル`,还被截断),图尔村 10 个全配错。桥插件 0.13.6 起读宝箱实体就给了 `content`(物品编号)、`num`、`flag`(宝箱旗标)、`hidden`(隐藏道具)、`contentName`(当前语言，中文),`game.ts` 里调 `atlas.visit` 前只取了 `cell` 和 `name`(`const chests = (found.get("TresureBox") ?? []).map(...)` 那段)。

## 做法

1. 记录宝箱时一并存 `content`、`num`、`flag`、`hidden`、`contentName`(桥插件没给的字段就不写，旧桥插件照常工作)。**不存 `opened`**(那是本档进度，不属于地图记录)。
2. `atlas.ts` 里 `visit` 的文档注释更新宝箱的字段说明。
3. 已有的地图记录不迁移：下次进这张图 `look_around`/进图记录时自然覆盖。
4. 看一下地图记录的其他读者(完成度、知识模块合并、`look_around` 的输出)会不会因为多了字段出问题;不需要改它们。

## 测试

- 假桥插件的宝箱实体带这些字段 → 地图记录里有;不带 → 只有 `cell`、`name`,不报错;`opened` 不进地图记录。
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑)。

## 回报

不超过 8 行：改了哪里、测试、`npm run check` 结尾。

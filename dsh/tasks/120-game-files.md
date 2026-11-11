# 任务 120:从游戏文件导出整作的地图数据和三语物品名(离线，不连游戏)

工作目录 `dsh/`。只许新建 `src/engine/knowledge/game-files.ts`(纯解析)、`scripts/game-files.mts`(命令行)、`test/game-files.test.ts` 和 `test/fixtures/game-files/` 下的小数据。不改已有文件(任务 117/118/119 同时在改 `game.ts`、`route/`、`stage/`、`client/`、`panel.ts`);接进知识模块、路线书、寻路是之后的任务。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11)

路线书配宝箱时，地图记录里只有日文实体名，攻略是英文，游戏导出是中文，三者对不上(图尔村 10 个全配错);没去过的图连宝箱坐标都没有(主数据宝箱表没有地图和格子)。用户把游戏目录给了开发机，Claude 用 UnityPy 把资源包里的文本资源原样拆到了 `../.deps/ff5/files/`(**游戏公司的数据，只放 `.deps/`,不进版本库;测试数据要自己编，不要从里面拷**):

- `Res/Map/<包>/<子图>/`:每张图一组 Tiled 格式 JSON——`entity_default.json`(实体)、`collision.json`、`damage.json`、`tilemap.json`、`ev_e_*.json`(剧情事件的触发物件)、`sc_*.json`(事件脚本),有的还有 `hidden_passage`、`sub_collision`、`encount`、`attribute`、`transportation`、`route_instruction`;一共 641 张子图。
- `Data/Master/*.csv`:主数据(`map.csv` 有地图编号和资源名 `Map_20010`、`Map_20011_1`;`content.csv` 是物品编号 → 文字键 `MSG_ITEM_NAME_03`;`item.csv`、`armor.csv`、`weapon.csv`、`area.csv` 等)。
- `Data/Message/system_<lang>.txt`(以及 `story_mes_*`、`story_cha_*`、`etc_text_*`):`键<TAB>文字`,12 种语言，要用 `ja`、`en`、`zhc`;文字里带 `<IC_BAG>` 这类图标标记，去掉(仓库里已有清洗函数就用)。

Claude 已核对过的事实(写进测试):
- 宝箱是 `object_type == 7` 且有 `content_id` 的物件;**格子 = (x ÷ 16, y ÷ 16 − 1)**(带 `gid` 的物件以左下角定位)。图尔村 `Map_20010`:`フェニックスのお` x480 y224 → (30,13),`content_id` 4,`flag_id` 0;`150ギル` x720 y592 → (45,36),`content_id` 1、`content_num` 150。地图记录 `../.deps/ds/atlas-ff5.json` 的 "30" 里这 5 个宝箱的格子完全一致。
- `content.csv`:`4,MSG_ITEM_NAME_03,…` → `system_en.txt` 里 `MSG_ITEM_NAME_03	<IC_BAG>Phoenix Down`,`zhc` 是 `不死鸟之尾`,`ja` 是 `フェニックスの尾`;`1,MSG_SYSTEM_139` 是 Gil/金币/ギル。
- 全作宝箱物件 278 个、不同 `flag_id` 253 个(同一宝箱在一张图的不同剧情版本里会出现多次)。

## 做法

1. `game-files.ts`(纯函数，输入是已经读好的字符串/对象):
   - 解析 `map.csv` → 地图编号 ↔ 资源名(包名、子图名);
   - 解析一张子图：宝箱/隐藏道具(格子、`content_id`、`content_num`、`flag_id`、日文物件名;隐藏道具怎么区分：看物件属性或主数据宝箱表的 `TreasureType`,查清楚写进注释)、出口(`MoveArea`、去世界地图的物件等：目标地图和落点在哪个属性里，查清楚;矩形物件不带 `gid` 时 y 是左上角，换算规则不同，要对照地图记录核对)、剧情事件触发物件(`ev_e_*` 里的物件：名字如 `sc_e_0021:…`、格子或矩形、脚本编号)、NPC、存档点/回复点(找对应的物件名或属性);碰撞(`collision.json` 的图层数据，宽高、每格的值;和 `../.deps/ds/collision-ff5/*.json` 里同一张图核对含义)、`damage`、`hidden_passage`;
   - 物品名：`content_id` → 文字键 → `{ ja, en, zhc }`(去掉图标标记)。
2. `scripts/game-files.mts`:读 `../.deps/ff5/files/`,写 `../.deps/knowledge/ff5/files/maps/<地图编号>.json`(每张图一份)、`items.json`(物品编号 → 类型、三语名)、`summary.json`(张数、宝箱数、出口数、解析不了的物件统计);终端打印汇总。路径从 `src/engine/paths.ts` 的 `DEPS` 算。
3. **核对**:脚本最后拿结果和地图记录(`atlas-ff5.json`,151 张去过的图)、碰撞缓存(`collision-ff5/`,44 张)逐图比：宝箱格子、出口格子和目标图、碰撞每格是否一致;把不一致的列出来(写进 `summary.json` 并打印前 20 条)。不一致多半是换算规则错了，先修规则。

## 测试

- 自己编的小 Tiled JSON / CSV / 文字表：宝箱格子换算、`content_id` → 三语名、图标标记去掉、矩形物件换算、出口目标、碰撞读出;
- 一条读真实文件的测试(`../.deps/ff5/files` 不在就跳过):图尔村 5 个宝箱的格子和物品英文名(Phoenix Down、Leather Shoes、Tent、Potion、Gil×150)、风之神殿 4 层 `Map_30041_7` (28,17) `content_id` 136;
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑)。

## 回报

不超过 25 行：解析出了什么(每类一句，含隐藏道具、出口、事件、存档点怎么认)、坐标换算规则、和地图记录/碰撞缓存的核对结果(一致多少、不一致多少、原因)、全作汇总数字、`npm run check` 结尾、拿不准的地方。

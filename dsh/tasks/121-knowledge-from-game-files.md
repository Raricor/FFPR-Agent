# 任务 121:知识模块改用游戏文件——遇敌精确到图、宝箱位置、三语物品名、存档/回复点

工作目录 `dsh/`。可以改 `src/engine/knowledge/`(含任务 120 新建的 `game-files.ts`)、`test/` 下知识模块相关测试和 `test/fixtures/` 里知识模块的小数据。**不碰** `src/engine/regions.ts`、`src/engine/skills/`、`src/engine/atlas.ts`(任务 123 同时在改)、`src/engine/stage/`、`src/engine/route/`(之后的任务 122)。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。游戏数据只在 `../.deps/`,测试数据自己编。

## 起因(11-11)

1. **遇敌挂错了地方**:路线书说洞窟(191–194)有黑火、能学 Dark Spark。Claude 用游戏文件核对：洞窟的遇敌是 `map.csv` 每张图的 `monster_set_id`(192 → 91,193/194 → 92)→ `monster_set.csv`(每组 10 个 `monster_setN` + `_rate`)→ `monster_party.csv`(`monster1..9`)→ `monster.csv`。91 = 钢蝠/恶魔蟹,92 = 套索妖/钢蝠，**没有黑火**。黑火在 bridge 导出的 `encounters.json` 里是 `scope: "area"`、`areaId` 10 和 65 的行——那是**遇敌区**编号(`encount_area.csv`:按 `encount_area_grid_number` 网格、`foot01..32_monster_set` 按脚下地形),不是地图的 `area_id`。任务 93 把两者当成一回事，怪物的出没地点、“错过就没了”、刷怪建议、青魔法窗口都受影响。
2. 任务 120 已把游戏文件整理成 `../.deps/knowledge/ff5/files/`:`maps/<地图编号>.json`(宝箱含 `contentId`/`flag`/隐藏、出口、事件、NPC、存档点、回复点、碰撞、伤害、暗道)、`items.json`(物品编号 → 三语名)、`summary.json`;原始 CSV 在 `../.deps/ff5/files/Data/Master/`(`map.csv`、`monster_set.csv`、`monster_party.csv`、`monster.csv`、`encount_area.csv`、`encount_area_grid.csv`、`treasure_box.csv`、`content.csv`…),文字在 `../.deps/ff5/files/Data/Message/`。

## 做法

1. **遇敌重算**(新来源，记为 `files`):
   - 地下城：每张图 `monster_set_id` → 组 → 怪，带权重;
   - 世界地图：`encount_area_grid.csv` 把世界地图格子分到遇敌区，`encount_area.csv` 按脚下地形(foot 类型怎么从地块读出来，查 `tilemap`/`attribute`,查不清就先按“这个遇敌区可能出现的全部怪”给出，并标注不按地形细分)给出组;
   - 结果：每只怪 → 出现在哪些地图(世界地图记遇敌区编号)、权重。`monstersIn`、`blueMagicSources`、`missablesAfter` 等查询改用它;旧的 `encounters.json` 解释错误的那部分不再用(保留文件读取，标注已被 `files` 取代)。
2. **宝箱**:`chestsIn` 的位置和内容以游戏文件为准(地图编号、格子、`contentId`、`flag`、隐藏、三语名);攻略的宝箱按**英文物品名**对上 `items.json` 的 `en` 名，再对到具体宝箱;地图记录里的日文名只当补充。去掉 `knowledge-real.test.ts` 那条已过时的断言(火力船每个宝箱都要有攻略来源)改成新事实下的断言(比如火力船的宝箱都有游戏文件来源，攻略能对上的数量写清)。
3. **物品三语名**:知识模块提供 `contentId → { ja, en, zhc }` 和按任一语言名反查。
4. **存档点、回复点**:从游戏文件取(地图编号 + 格子),供阶段事实单和路线书用。
5. 加载：`loadKnowledge` 默认读 `../.deps/knowledge/ff5/files/`,文件不在时照旧(其他五作、测试)。

## 测试

- 小数据：地下城 `monster_set_id` → 怪;遇敌区不再被当成地图地区;攻略英文名对上宝箱;三语名反查;存档点/回复点;
- 真实数据测试(文件不在就跳过):洞窟 192–194 的怪是钢蝠、恶魔蟹、套索妖，没有黑火;黑火出现在金字塔(地区 65 的图);图尔村 5 个宝箱对上攻略的 Phoenix Down、Leather Shoes、Tent、Potion、150 Gil;
- `npm run check` 全过(真实目录里 `knowledge-real` 也要过)。

## 回报

不超过 20 行：遇敌怎么算(地下城/世界地图)、哪些查询换了来源、攻略宝箱对上的比例(全作)、世界地图按地形细分做没做成、`npm run check` 结尾、拿不准的地方。

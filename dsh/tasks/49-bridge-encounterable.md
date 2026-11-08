# 任务 49:桥插件读出“这张图现在能遇到哪些怪”(0.13.7)

范围:
- 只改 `bridge/`:`src/GameState.Encounters.cs`(需要的话可以新开一个 `GameState.*.cs`)、`src/Version.cs`、`README.md`;
- 不改 `../dsh/`、`../agent/`、`../deploy/`;不碰 git;不连笔记本。
- **沙箱里跑不了 dotnet**,写完不用编译，我来编。编译报错我贴回来，你用同一个会话接着改。
- 反编译的游戏类在 `../.deps/ff5/decompiled/`(只读，`Last.Map/*.cs` 等)。读不到就在回报里说，我把要用的类贴给你，不要猜接口。

## 起因

dsh 的“每张图都要完成”(任务 45)要知道这张图会遇到哪些怪，好让 AI 把它们刷进图鉴。现在的 `encounters` 只给**玩家脚下这一格**的遇敌组(`GetCurrentEncountMonsterset`),11-04 实测出了这些问题:

- 站在不遇敌的格子上(入口、楼梯口)、骑着陆行鸟时，返回的是空。dsh 拿到空，就退回去用图鉴的“出没地点”，把整个区域的怪都算进来，包括首领和后期才出现的怪(风之神殿 1 层要刷首领“巨翼猛禽”;泰空陨石地要刷第三世界才有的“精金龟”)。
- 世界地图上 `regions` 是空数组(11-05 在 (153,89) 骑陆行鸟时实测)。
- 剧情会用 `SaveMapManager.SetEncountEnable(false)` 关掉一张图的遇敌(开场的泰空陨石地全图不遇敌)，现在的回复里看不出来。

## 要做的:`encounters` 回复加三个字段，原有字段一个都不改

1. `enabled`(bool,读不到为 null):这张图现在开没开遇敌，也就是剧情脚本控制的那个开关。从 `SaveMapManager.Instance.SaveData.EncountEnable`(`Last.Map.SaveMapData`)读。
2. `vehicle`(读不到为 null):`{ "id": 交通工具编号, "encounter": bool }`,当前交通工具会不会遇敌(`TransportationInfo.EncountFlag`)。只是给人看的信息，不参与 1 和 3。
3. `map`:`{ "scope": "map" | "area", "grids": [格子号…], "parties": [...] }`,这张图**在任何格子上**可能滚出的全部遇敌队伍，按队伍 `id` 去重。每个队伍的格式和现有 `parties` 一样(`id`、`rate`、`notEscape`、`monsters` 带 `book`),复用 `AppendParties`。
   - 迷宫和城镇(`scope: "map"`):整张图所有遇敌格子号的并集。可能的路子(以反编译为准，你来选):
     - `MapAssetData.GetEncountGridDataList()` 的 `EncountGridData.Cells` / `UniqueGridNumber`,挑出不同的格子号;
     - 每个格子号挑一个代表格子，调用游戏自己的 `MapAttribute.GetCurrentCellEncountTable(cellPos)` 或 `AttributeEncount.GetCurrentEncountTable`,拿到 `EncountTable` → MonsterSet → 队伍。
   - 世界地图(`scope: "area"`):只取玩家所在的那一个遇敌区域(区域号就是玩家这一格的格子号)，把这个区域里**各种地形**的表都并起来。不要并整个世界。
   - 只读：不改任何游戏数据，不触发遇敌。每个格子号最多查一次;整张图的查询要能在一帧里做完，或者算一次缓存到换地图为止。
   - 哪一步读不到，就让那一部分为空，并在 `map.error` 里写一句英文原因。不要抛出去，不要影响原有字段。

版本号改成 0.13.7;`README.md` 版本记录加一行，`encounters` 那一行补上三个新字段。

## 回报

不超过 20 行：改了哪些文件;`enabled`、`vehicle`、`map` 分别从哪个类的哪个成员读;迷宫和世界地图各怎么并的;拿不准、要我在真机上核对的地方。

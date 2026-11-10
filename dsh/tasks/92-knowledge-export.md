# 任务 92(桥插件 0.14.5):只读的整作导出查询(给知识模块用)

工作目录 `bridge/`。只改 `bridge/src/`、`bridge/README.md`、`src/Version.cs`。不碰 `../dsh/`(任务 93 在改)、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**、不装插件(Claude 来装、来导),**不用 docker、不绕开沙箱**(编不了就在回报里说明，Claude 在外面编)。桥插件**只读**游戏状态，不改游戏数据和存档。

反编译代码在 `../.deps/ff5/decompiled/`;已有的读法尽量复用：怪物(`GameState.Monsters.cs`)、怪物招式和青魔法(任务 90 的 `GameState.BlueMagic.cs`、`monstermoves`)、遇敌(`GameState.Encounters.cs`)、宝箱(`GameState.Achievements.cs` 的 `Treasure()`,读主数据 `TreasureBox`)、商店。

## 起因

用户 11-10:把游戏知识(怪物图鉴、宝箱、商店……)做成独立的知识模块，先做 FF5。知识模块(任务 93)要一次把整作的静态数据导出成文件，离线查询(笔记本不在也能规划)。

## 做法

1. 新查询 `export`:参数 `table`(表名)、`offset`、`limit`(默认 200,上限 500);回复 `{table, total, offset, rows: [...], build: <游戏 build 号或 null>}`。分页是为了不让一次回复太大。
2. 表和每行的字段**严格照下面的格式**(和任务 93 共用;读不到的写 `null`,不要省略键):
   - `maps`:`{id, name, areaId, areaName, areaType}`(主数据 `Map`、区域 / GPS 区域)
   - `monsters`:`{id, name, bookId, level, hp, mp, weak: [属性], absorb: [属性], nullify: [属性], statusImmune: [状态], drops: [{itemId, name, rate}], steal: [{itemId, name, rate}], boss: bool|null, scriptId, moves: [{abilityId, name, blueMagic: bool|null, conditions: [状态], rate: number|null}] | null}`(`moves` 复用 `monstermoves`;脚本没载入读不到时 `moves: null`)
   - `encounters`:`{scope: "map"|"area", mapId: number|null, areaId: number|null, groupId, weight: number|null, monsterIds: [id]}`(遇敌主数据，覆盖整作，不只当前图)
   - `treasures`:`{id, areaId, mapId: number|null, cell: [x, y]|null, hidden: bool, contentId, contentName, count: number|null, flag}`(主数据 `TreasureBox`;查清它有没有地图号和格子字段，没有就写 null 并在回报里说明)
   - `shops`:`{id, mapId: number|null, areaName, kind, products: [{itemId, name, price}]}`
   - `items`:`{id, name, kind, price: number|null, cures: [状态], restores: {hp?: number, mp?: number} | null}`(道具、武器、防具都在;`cures`/`restores` 读不到写空数组 / null)
   - `magic`:`{id, name, school, mp: number|null, cures: [状态]}`(白、黑、时空、召唤、青魔法……,`school` 用中文或游戏的枚举名，写明)
   - 状态名用游戏的取名，名字为空时用 `ConditionType` 枚举名兜底(做法照 `GameState.Party.cs`)。
3. 只读主数据(`MasterManager` 这类),**不加载地图、不改任何状态**。地图的碰撞和实体不在这个任务里(要等任务 80 的真机实验)。
4. 游戏 build 号读得到就给，读不到写 null。
5. README 写清 `export` 的参数、每张表的字段和来源类;推断的字段标“推断，待真机核对”。版本号 0.14.5,更新记录写一条。
6. 编译只编 FF5 一次:`dotnet build -p:Game=ff5`(FF5 专有的部分包在 FF5 条件编译里，其他五作不受影响)。

## 回报

不超过 30 行：每张表用了哪些主数据类和字段(文件名)、读不到的字段、`dotnet build` 结尾输出(或者为什么编不了)、要真机核对的地方。

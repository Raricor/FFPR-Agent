# 桥插件(FfprBridge)

BepInEx 6 IL2CPP 插件，运行在游戏进程里，**只读**游戏状态（设计方案 §5），从不改游戏数据和存档。当前版本 0.14.6。

- 所有挂钩都是 postfix，只读参数和返回值，不改参数、不改返回值，也不改任何游戏对象。
- 调用游戏的地方只有取值函数和纯查询。
- **唯一的例外是按键**(0.9.0 起，用户 10-27 同意):在游戏的输入系统里加一个虚拟手柄，按键都从它进去，见「虚拟手柄」。为此还把输入系统的后台行为改成 `IgnoreFocus`。只送按键，不碰别的。
- 单例一律读它的静态字段，不调用可能顺手创建实例的访问器。

它做五件事：

- 每秒采样一次游戏状态;位置和主状态一变就推送。
- 记录对话、选项、系统消息、成就、图鉴、换地图和存档事件。
- 把以上内容写进 `BepInEx/ffpr/probe-<启动时间>.jsonl`，同时推送给 WebSocket 客户端。
- 在查询通道上回答查询(见「查询通道」)。
- 0.5.0 起，在局域网连接上替开发机按键(见「局域网连接」)。0.9.0 起按键走虚拟手柄，游戏在后台、最小化时也能玩。
- 0.14.6(实验性，仅 FF5):新增三个只读地图数据查询 `mapinfo` / `mappackage` / `mapasset`。`mapinfo` 只读 `MapManager` 的包名和已载入列表、当前 `Map` 主数据行；`mappackage` 用 `MapPackageLoader` 异步加载一张图的资源清单；`mapasset` 再用 `ResourceManager` 读其中一个文本资源并分页返回。全程不调 `RequestLoadMap`、不切换地图、不实例化 `MapModel`/实体。
- 0.14.5:新增仅 FF5 的 `export` 整作静态数据查询：`maps` / `monsters` / `encounters` / `treasures` / `shops` / `items` / `magic`，按 `offset` / `limit` 分页，只读 `MasterManager`；`treasures` 的 `mapId` / `cell` / `contentId` / `contentName` 和部分数值字段读不到时为 null。
- 0.14.4:新增仅 FF5 的 `bluemagic`(已学会的青魔法 + 主数据里的全部青魔法和学法)和 `monstermoves`(`ids` 里每只怪的 AI 招式、能否学成青魔法、附带状态);`battle.hit` 的状态名为空时改用 `ConditionType` 枚举名，不再丢状态；`gameover.autosave` 改从 `SaveContentController`/`SaveContentView` 的实际行读取，并在必要时退回 `SaveSlotData`。
- 0.14.3(仅 FF5):`sample` 和 `pos` 新增 `timer`(`active` / `seconds` / `paused`)，读卡纳克城逃脱那个画面上的倒计时；开始、重开和结束时推 `timer.start` / `timer.end`。`sample` 和新的 `gameover` 查询新增 `gameover`(`open` / `prompt` / `cursor` / `autosave`)，能认出「读取」自动保存的继续框和「返回标题画面」确认框；这时 `pos.state` 仍是 `Event`，要看 `gameover.open`。
- 0.14.2:新增 `config` 查询(只读，游戏线程上答):从 `ConfigSaveData` 读自动战斗保持、ATB 模式、战斗/消息速度、自动冲刺、重装备、光标记忆等设置，能对上枚举文字的给 `battleMode`；`battleAuto` 是当前战斗的自动战斗开关(`BattleStatusControl.isAutoMode`，不在战斗时为 null)。`battle.act` 新增 `auto`：这一招是不是游戏自动选的(FF5 `BattleActData.isAuto`，FF6 `IsAutoBattleAct`，FF1-FF4 没有该字段，写 null)。
- 0.14.1:修 `walkpath` 拐角。虚拟手柄改成游戏线程一帧最多发一个完整状态事件，同一帧的按/放不再互相覆盖，`stop` 和走路结束会把全部已知按钮写成松开，旧方向键不会卡住;整数格读数先在 `from` 上看到到达帧(`moving` false)、之后 `moving` 又变 true 时换出拐角方向(`mode=step`)，没看到到达帧就等读数跳到拐角格再换(`mode=flip`)，小数读数仍按 `turnLead`(`mode=lead`);`turns` 加 `mode` / `arriveFrame` / `stopFrame` / `moving` / `raw` 诊断。
- 0.14.0:`walkpath` 命令:一次收下整条格子路线，在游戏线程上逐帧按住虚拟手柄方向键连续走完，拐角提前换键不停顿;回复带停下的原因、`index`、`steps`、`pos`、`next` 和每个拐角的 `turns`(真机标定用)。`walkpath` 可带只用于显示的 `goal`/`label`;新增 `walk` 查询和 `walk.start` / `walk.progress` / `walk.end` 推送，笔记本和网页都能显示规划和走到哪一段。`cells` 新增可选的 `at`，可以任意格子为中心读窗口，便于开发机拼整张地图寻路。
- 0.13.8:迷宫/城镇的 `encounters.map.parties` 改成用 `FieldController.GetEncountInfo` 逐格扫整张图(多层每层扫)，按地图号缓存、换地图作废；世界地图的 `region` 改成按 `EncountGridData` 的格子号找当前区域，边界为 0 时 `start`/`end` 给 null；新增 `encountgrid` 查询(最多 64 格，返回每格的遇敌格子号)；迷宫 `map.debug` 是 `cellsScanned`/`layers`/`setIds`。
- 0.13.7:`encounters` 多了 `enabled`(剧情脚本控制的遇敌开关，读不到为 null)、`vehicle`(`{id, encounter}`，当前交通工具，读不到为 null)和 `map`(`scope` 是 `map`/`area`、`grids` 是整张图或当前区域的遇敌格子号、`parties` 是按队伍 id 去重的全部遇敌组，带 `error`);原有字段不变。
- 0.13.6:`entities` 的宝箱多了 `opened`(按存档旗标)、`hidden`/`treasureType`(主数据 TreasureType，2 是隐藏道具)和 `contentName`;`pos` 多了 `area`/`areaType`/`areaText`;`encounters` 多了世界地图的 `region`(当前区域)和 `regions`(每个区域的格子范围和遇敌组);`battle.hit` 的敌人目标多了 `book`(图鉴编号)。
- 0.13.5:`entities` 支持 `kind: "All"`，列出地图模型里所有分组的所有实体（不只当前活动组），未知种类也带类名和通用字段；`TimeSwitchingGimmickArea`/`SlidingFloorGimmickArea`/`DamageFloorGimmickArea` 带区域、开关秒数、方向和落点 link；`TileAnimRegion` 带动画 tile 的 `isTrigger`。
- 0.13.4:`entities` 补地图机关字段：`ToLayer` 的 `layer`(0 Bottom / 1 Ground / 2 Upper)和 `changeLayer`(`ToBottom` / `ToGround` / `ToUpper`);`OpenTrigger` 的 `linkObjectId`(联动 `TileAnimRegion` 的实体 id)、`script`、`isAlreadyHit`、`size`;`PointIn` 的 `linkObjectId`、`titleId`、`titleType`;`TileAnimRegion` 的 `isReverse`、`isPlaying`;`Event` 的 `script`、`linkObjectId`、`actionId`/`actionName`、`gimmick`。这些都是游戏里现成的字段，不改任何状态。
- 0.13.3:删掉 0.13.2 里挂到 `BattleAiExecute.SetTextAsset` 的 postfix(11-03 FF5 启动约 10 秒后原生崩溃，只有这个钩子能复现);预载脚本改成 `monsterai` 查询时扫描已载入的 `BattleAiExecute.textAsset` 和同名 `TextAsset`，不挂加载流程。其余 0.13.2 的文本键/能力名/Act/table/shop cursor 都保留。
- 0.13.2:`shop` 回复新增 `cursor`(光标在 `rows` 里的序号，买/卖列表通用;读不到为 null)，卖出列表不再只靠 `focus`;文本键再查一次 `MessageManager` 文本表(先 `GetMessage`、再 `GetMessageDictionary`)，`MSG_CMD_NAME_01` 这类键能变回「攻击」;怪物招式改查 `Content.MesIdBattle`(`MSG_MON_ATK_*`)，`"None"` 不再当名字，查不到给 `name`=null + `nameKey`;`Act` 列出全部能力并带 `rate`、`table`。
- 0.13.1:怪物 AI 脚本改为缓存游戏自己取到的 `TextAsset`(挂钩 `InstantiateManager.GetEnemyAIScript`、`BattleAiExecute` / `EventCommand` 的 uniqueId 版本和 `BattleAiSelectController.GetBattleAI`)，战斗结束后也能查;新增 `battle.ai` 事件;能力名改用游戏自己的 `ContentUtitlity.GetAbilityName`，查不到中文时给原始文本键;`monsterai` 只在传 `ids` 时用它，不再多返回一只怪。
- 0.13.0:战斗出招事件 `battle.act`(一招开始时:出招方、指令、能力、目标、反击)和 `battle.hit`(每个目标的效果:伤害/回复、落空、状态);`battle` / `sample` 里加 `atb`(`wait` / `active`)和战斗速度;FF5 的 `monsterai` 查询导出怪物 AI 脚本原文和能力名。`counter`/`counterCount` 按作品给值：FF5 两者都有，FF6 没有 `counterCount`，FF1-FF4 两者都没有，缺的写 null。0.13.0 的挂钩失败会计数，放在 `bridge` 查询的 `hookErrors` 里。
- 0.12.0:新的 `bridge` 查询(作品、版本、进程、端口、局域网、客户端、挂钩、最近 100 条按键、最近 50 条警告),给笔记本上托盘里的桥插件小程序用;按键命令可以带可选的 `from`,说明这次按键是谁按的。
- 0.11.0:一个包，六作装完全一样的文件。`FfprBridge.dll` 只当加载器，按进程名认出作品后加载 `games/FfprBridge.<作品>.dll`；版本号只在 `src/Version.cs` 一处；编译和安装改用 `build.sh` / `deploy.sh`。游戏启动后窗口最小化，不抢前台。
- 0.9.0 / 0.9.1:虚拟手柄按键(`"via": "game"`、`hold`);本机 `/command`(要令牌);0.9.1 删掉了调试用的查询。
- 0.10.0:默认端口按作品分开(FF5 仍是 47800,其余 4780N),Steam 能同时开几作，各作的桥插件互不占端口;按键只进自己那一作。六作都能编(`dotnet build -p:Game=ffN`)。FF5 专有的部分(职业、魔法窗口、战斗技能列表、职业熟练)只在 FF5 里编进去;各作没有的字段不报：总金钱(FF1–FF3)、胜场(只有 FF5)、AR 战斗(FF2–FF4)、装备栏能否选(FF1–FF3)。
- 0.8.1–0.8.3:修好读战斗目标光标。FF5 的光标组件挂在一个选目标时也不活动的对象上，改成按状态机判断;`Active()` 不再永久缓存第一个找到的实例。
- 0.8.0:`encounters`,当前位置的遇敌表。
- 0.7.6–0.7.9:`achievements`(成就主数据、账号层、存档层、按地点的宝箱、图鉴登记和出没地点)、`monsters`(怪物资料)。
- 0.7.4 / 0.7.5:队伍每人带已学能力(`abilities`)和职业等级;`menu` 读得到换职业窗口。
- 0.6.2–0.6.4:战斗道具列表;战斗单位的状态异常;碰撞网格按原值传出(之前把楼梯的 3、5 也写成 1,船舶墓场的楼梯成了墙)。
- 0.6.0 / 0.6.1:队伍带职业名;战斗菜单读得到哪个窗口在接收按键、选目标的光标、画面上的魔法列表，供规则表执行。
- 0.5.1 起，端口被别的程序占着时每 5 秒重试一次，让出来以后不用重启游戏(10-20 笔记本上的 VS Code 转发占过 127.0.0.1:47800)。

源码:

| 文件 | 做什么 |
| --- | --- |
| `loader/Loader.cs` | 唯一的 BepInEx 插件：按进程名认出作品,加载 `games/FfprBridge.<作品>.dll`,调用它的 `Start` |
| `Plugin.cs` | 每作的入口 `Start(host)`：读配置、逐个打挂钩(一个失败不影响其他)、启动 WebSocket、挂上每帧回调 |
| `Version.cs` | 唯一的版本号,加载器和六份共用 |
| `Probe.cs` | 每帧：换地图检测、走路、处理查询;每秒：采样 |
| `Hooks.cs` | Harmony postfix 挂钩：对话、选项、系统消息、成就、Steam、图鉴、存档、战斗出招/命中 |
| `Requests.cs` | 查询的分派;换地图事件 `MapWatch` |
| `Outbox.cs` | 写探针文件;本机和局域网两个监听;WebSocket 广播与单播回复;记下每个客户端(远端、通道、连上的时间) |
| `BridgeInfo.cs` | `bridge` 查询的内容:版本、挂钩、挂钩错误计数、最近 100 条按键、最近 50 条来自本插件的警告 |
| `Link.cs` | 局域网连接的设置:监听地址、允许的客户端、令牌 |
| `Keyboard.cs` | 按键线程:`keys`、`hold`、`walkpath`、`status`、`stop`;默认走 SendInput(要前台),`"via": "game"` 交给 `GameInput` |
| `Walker.cs` | `walkpath`:命令线程等、游戏线程逐帧走;路线校验、拐角换键、冲过头回走、各种停下条件;`walk` 查询和 `walk.start` / `progress` / `end` 推送 |
| `GameInput.cs` | 虚拟手柄:按键对应的按钮、按住的期限、每帧一个完整状态事件(0.14.1)、全部松键 |
| `GameState.Achievements.cs` | 成就：主数据、账号层、存档层、宝箱按地点、图鉴 |
| `GameState.Monsters.cs` | 怪物资料：等级、HP、属性、状态免疫、掉落、偷窃 |
| `GameState.Encounters.cs` | 当前位置和整张图(世界地图是当前区域)的遇敌表 |
| `GameState.cs` | 采样的骨架、消息文本查询、公共小工具 |
| `GameState.Field.cs` | 地图和玩家：格子、地形、实体、碰撞、寻路 |
| `GameState.Party.cs` | 队伍和背包 |
| `GameState.Dialog.cs` | 对话框和选项 |
| `GameState.Battle.cs` | 战斗：敌我单位、战斗菜单、ATB 设置 |
| `GameState.Config.cs` | 游戏设置：`ConfigSaveData` 各字段、ATB 模式文字、当前战斗的自动战斗开关(0.14.2) |
| `GameState.Timer.cs` | FF5 画面上的倒计时：`sample` / `pos` 的 `timer`、`timer.start` / `timer.end` 推送(0.14.3) |
| `GameState.GameOver.cs` | FF5 游戏结束的两个选择框：`sample` 的 `gameover` 和 `gameover` 查询(0.14.3) |
| `GameState.BattleAct.cs` | 战斗出招：出招方、指令、能力、目标、是否自动、每个目标的结算 |
| `GameState.MonsterAi.cs` | FF5 怪物 AI 脚本查询(按需读，不每帧读) |
| `GameState.MonsterMoves.cs` | FF5 怪物招式：AI 脚本里的能力、青魔法判定、`ConditionGroup` 状态(0.14.4) |
| `GameState.BlueMagic.cs` | FF5 青魔法：主数据全部青魔法、已学会的、`Learning` 学法(0.14.4) |
| `GameState.Export.cs` | FF5 整作静态数据导出：`export` 查询的七张表(0.14.5) |
| `GameState.Maps.cs` | FF5 只读地图数据：`mapinfo` / `mappackage` / `mapasset` 的异步包清单和文本加载(0.14.6) |
| `GameState.Menus.cs` | 带光标的界面：商店、地图菜单(魔法、道具、装备)、存档列表 |

## 编译与安装(0.11.0 起)

插件要针对从笔记本取回的程序集编译。这些程序集必须和游戏当前的 build 一致，游戏更新后要重新取回。

```bash
uv run ffpr-laptop fetch-assemblies ff5   # 取回程序集到 .deps/ff5
bash bridge/build.sh                      # 编加载器和六份,拼成 bridge/bin/package/FfprBridge
bash bridge/deploy.sh                     # 编译并装到笔记本上所有装了的作品(游戏需已退出)
bash bridge/deploy.sh ff1 ff5             # 只装这几作
uv run ffpr-laptop probe-logs ff5         # 取回探针日志到 .deps/ff5/probe
uv run ffpr-probe ff5                     # 汇总最新的一份日志
```

`deploy.sh` 会跳过没装的作品和正在运行的游戏，每作打印一行结果。六作的包完全一样：

```
FfprBridge/
  FfprBridge.dll              加载器(BepInEx 插件,GUID 仍是 ffpr.agent.bridge)
  version.txt                 这一包的版本号
  games/FfprBridge.ff1.dll    每作一份
  …
  games/FfprBridge.ff6.dll
```

加载器不引用任何游戏的程序集。启动时用 `Paths.ProcessName` 对照进程名（`FINAL FANTASY`、`FINAL FANTASY II`……`FINAL FANTASY VI`，忽略大小写，整个名字相等才算）认出作品，再加载 `games/FfprBridge.<作品>.dll`，调用它的 `FfprBridge.Plugin.Start`。认不出进程或找不到文件时只记一条日志就返回，不让异常冒出去。所以六个 `plugins/FfprBridge/` 装同样的文件，不会再出现某一作装成旧版的问题。

只想编一作：`dotnet build bridge -c Release -p:Game=ff5`，产物在 `bridge/bin/ff5/Release/FfprBridge.ff5.dll`。

配置文件 `BepInEx/config/ffpr.agent.bridge.cfg` 在首次运行后生成，有三项：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `Port` | FF5 47800,FFN 4780N(FF1 47801 … FF6 47806,0.10.0 起) | 填 0 关闭 WebSocket。各作端口不同，几作可以同时开(10-28 实测 FF4、FF5、FF6 同时开，各自 60 帧) |
| `SampleIntervalSeconds` | 1 | 采样间隔，单位秒 |
| `TrackMessageLookups` | 开 | 是否记录消息 ID 查询 |

## 记录格式

每行一个 JSON 对象。所有记录都带 `seq`、`t`(UTC 时间)、`frame`、`type` 四个字段。

| type | 什么时候写 | 主要字段 |
| --- | --- | --- |
| `hello` | 启动时 | 插件版本、游戏名、游戏版本、Unity 版本 |
| `sample` | 每秒 | 见下表 |
| `dialog.play` / `dialog.close` | 对话框显示 / 关闭 | 主状态(用来推测对话类别)、说话人、各行文本、配上的消息 ID、这次对话之前查询过的消息 ID |
| `choice.open` | 出现选项时 | 选项类型(二选一 / 多选)、默认项、各选项文本 |
| `sysmsg` | 系统消息，如得到道具 | 消息 ID 和文本 |
| `achievement.unlock` | 游戏调用 Steam 解锁成就时 | Steam API 名 |
| `achievement.steamProgress` | 游戏向 Steam 报告成就进度时 | API 名和数值 |
| `achievement.progress` | 游戏内成就进度变化时 | 类别、数值、条件，以及变化后的进度 |
| `bestiary.register` | 图鉴登记怪物时 | 怪物 ID、数量 |
| `steam.setAchievement` / `steam.setProgress` | 游戏调用 Steam 时(0.3.0 起，同一内容只记一次) | API 名和数值 |
| `map.change` | 换地图时(0.3.0 起) | 离开的地图和格子、到达的地图和格子 |
| `pos.change` | 位置记录一变就写,每 4 帧检查一次(0.5.0 起) | 和查询 `pos` 相同:地图、格子、朝向、是否在走、主状态、对话 / 战斗标志、存档次数；FF5 0.14.3 起还有 `timer` |
| `save.write` | 存档写完时(0.4.0 起) | 存档位、结果 |
| `timer.start` / `timer.end` | FF5 画面上的倒计时出现 / 消失时(0.14.3 起，每 4 帧检查一次) | `start`：剩余 `seconds`、`paused`、总时长 `required`；`end`：`reason`(`finished` 到点 / `cleared` 提前移除 / `restarted` 换了一个) |
| `battle.act` | 一招开始执行时(0.13.0 起) | 出招方 `actor`、`command`、`abilities`、`items`、`targets`、`act`、`use`、`counter`、`auto`(0.14.2);见下 |
| `battle.hit` | 一招里每个目标的结算完成时(0.13.0 起) | `act`(同一招的简短摘要)、`target`、`value`、`hit`、`hitCount`、`miss`、`heal`、`conditions` |
| `battle.ai` | 游戏第一次取到怪物 AI 脚本时(0.13.1 起) | `monster`(怪物编号，未知时 null)、`scriptId`、`scriptName`、`length` |

`sample` 包含以下几部分：

| 部分 | 内容 |
| --- | --- |
| `scene` | 场景名，以及主游戏状态(Player、Message、Event、Battle、Menu、Shop 等) |
| `user` | 地图 ID、区域、地点、金钱、累计金钱、步数、战斗次数、击杀数、开过的宝箱数、存档次数、Boost 设置 |
| `party` | 队伍成员：职业、等级、HP、MP、经验值 |
| `field` | 玩家坐标，有本地、世界、实体、格子四种，还有移动状态 |
| `dialog` / `choice` | 窗口当前状态 |
| `timer` | 仅 FF5(0.14.3)：画面上的倒计时，`active` / `seconds` / `paused` |
| `gameover` | 仅 FF5(0.14.3；`autosave` 0.14.4 修)：游戏结束的选择框，`open` / `prompt` / `cursor` / `autosave` |
| `battle` | 是否在战斗中;0.13.0 起 FF4-FF6 有 `atb`(`wait` / `active`)、`battleSpeed`(设置里的档位)和 `atbSpeed`(当前战斗用的倍率);FF1-FF3 是回合制，这三项为 null |

某一部分读不出来时，那一部分写成 `{"error": ...}`，其余部分照常写入。

## 查询通道

0.2.1 起，连 `ws://127.0.0.1:47800/query` 的客户端只收到自己请求的回复，不收广播。请求是 `{"id": 1, "op": "..."}`,在游戏线程里回答，每帧最多 8 个。和采样一样只读。

| op | 返回 | 起始版本 |
| --- | --- | --- |
| `pos` | 地图、主状态、格子、朝向、是否在走、对话 / 战斗标志、存档次数；0.13.6 起还有 `area`(GpsAreaId)、`areaType`(0 是世界地图)、`areaText`；FF5 0.14.3 起还有 `timer` | 0.2 |
| `cells` (`r`, `at`) | 格子地形码;0.14.0 起可选 `at`(`[x, y]`)指定读取窗口的中心，缺省是玩家；回复里 `center` 仍是玩家的格子，`at` 是这次读的中心，`origin` 是窗口左上角 | 0.2 |
| `walk` | 当前或最后一条 `walkpath`:seq、active、map、path、goal、label、index、steps、cell、segment、turns、startedAt、endedAt、reason;一条都没走过为 null | 0.14.0 |
| `config` | 游戏当前设置：`isKeepAutoBattle`、`battleModeIndex` 和 `battleMode`(wait / active)、`battleSpeedIndex`、`battleMessageSpeedIndex`、`messageSpeed`、`isAutoDash`、`reequipIndex`、`isCursorMemory`、`battleModeButton`(原始值)和 `battleModeButtonName`；`battleAuto` 是当前战斗的自动战斗开关，不在战斗时为 null。读不到时 `config` 为 null，顶层带 `error` | 0.14.2 |
| `gameover` | 仅 FF5：游戏结束的选择框，`open`、`prompt`(`continue` / `to-title` / null)、`cursor`(0 是 / 1 否 / null)、`autosave`(自动保存那行的 `map` / `label` / `time`，没有为 null；0.14.4 修读法) | 0.14.3 / 0.14.4 |
| `sample` | 立即采样一次完整状态 | 0.2 |
| `entities` (`kind`, `max`) | 入口(含目的地)、宝箱(含内容)、NPC、事件，以及所在格子；0.13.4 起换层格带目标层、门带联动和触发状态、PointIn 带 link/title、事件带脚本和动作；0.13.5 起 `kind: "All"` 列出所有分组/未识别实体，gimmick 实体带区域和落点 link；0.13.6 起宝箱带 `opened`、`hidden`、`treasureType`、`contentName` | 0.2.1 |
| `route` (`to`) | 游戏自己的寻路结果(实测不可靠，改用 `collision` 自己寻路) | 0.2.x |
| `collision` | 室内碰撞网格，每层一组字符串 | 0.2.5 |
| `items` | 道具和贵重物品 | 0.3.0 |
| `saveui` | 存读档列表：是否打开、光标、各存档位 | 0.3.0 |
| `battlemenu` | 行动角色、指令和光标、打开的魔法 / 能力列表和光标;0.6.0 起加 `menuState`、`commandState`、选目标的 `target`(state、cursor)和双方单位;0.6.1 起加 `abilityState` 和画面上的魔法 `shown` | 0.4.0 |
| `shop` | 商店指令和光标、商品和价格、列表光标、数量窗口;0.5.2 起加 `state`(按键作用在哪一步);0.13.2 起加 `cursor`(光标在 `rows` 里的序号，读不到为 null) | 0.4.0 |
| `shot` | 把这一帧存成 PNG(`BepInEx\ffpr\shots`,一小时前的自动删),回复里是文件路径;游戏最小化也能截，不抢焦点 | 0.10.0 |
| `textinput` | 屏幕上的文字输入框(起名框):文字、哪个正在输入 | 0.10.0 |
| `title` | 标题画面的菜单：指令(`defaultColor` 为假是灰掉的)、光标 | 0.10.0 |
| `menu` | 地图菜单：指令和光标、当前子菜单、选人光标;魔法、道具、装备窗口的列表、光标和对象;0.7.5 起有换职业窗口 `job` | 0.4.1 |
| `bestiary` | 图鉴主数据：每项的编号、怪物、名字 | 0.7.1 |
| `achievements` | `defs`(成就主数据，三个平台各一套)、`account`(账号层，和 Steam 同步)、`save`(存档层计数、宝箱按地点 `treasure`、队员职业等级)、`bestiary`(每个编号登记了没有、出没地点);没读档时顶层另有 `treasure`(主数据里每个地点的宝箱总数，0.10.0 起) | 0.7.6 |
| `monsters` | 每个图鉴编号的怪物资料：等级、HP、MP、经验、金钱、首领、属性(`type` 1 弱 / 3 无效 / 4 吸收)、状态免疫、掉落、偷窃。静态数据，取一次就够 | 0.7.9 |
| `encounters` | 当前位置的遇敌组：每种队形的概率(千分比)、能不能逃、几只什么怪。世界地图上随区域和脚下地形变；0.13.6 起 `region` 是当前区域，`regions` 是加载地图模型里每个区域(格子范围和它自己的遇敌表)；0.13.7 起 `enabled` 是剧情控制的遇敌开关，`vehicle` 是当前交通工具，`map` 是整张图(世界地图按格子号找当前区域，再并该区域所有地形)能滚出的全部队伍，按 id 去重；0.13.8 起迷宫/城镇逐格扫整张图(多层每层扫)，世界地图 `region` 也按格子号找 | 0.8.0 |
| `encountgrid` (`cells`: [[x,y], …], 最多 64) | 每格的遇敌格子号(读不到为 null) | 0.13.8 |
| `bridge` | 这一包和运行时:作品、版本、进程、启动时间、端口、局域网、客户端、挂钩、最近 100 条按键、最近 50 条警告;0.13.0 起有 `hookErrors` | 0.12.0 |
| `monsterai` (`id` / `ids`) | FF5 怪物 AI 脚本:脚本名、原文(截断)、能认出的能力名;不给编号就是当前战斗的敌人 | 0.13.0 |
| `monstermoves` (`ids`) | FF5 每只怪的 AI 招式：`abilityId`、名字、`blueMagic`、附带状态 `conditions`、招式的 `rate`；不给 `ids` 就是当前战斗的敌人 | 0.14.4 |
| `bluemagic` | FF5 青魔法：`learned`(已学会)和 `all`(主数据全部青魔法 + `learnedBy` 学法) | 0.14.4 |
| `export` (`table`, `offset`, `limit`) | FF5 整作静态数据的一页：`table` 是七张表之一，`limit` 默认 200、上限 500；回复 `export: {table, total, offset, rows, build}` | 0.14.5 |
| `mapinfo` | FF5 实验性：`MapManager` 的 `AssetPackageName`、当前 `Map` 主数据行、已载入的包/模型列表；不启动加载 | 0.14.6 |
| `mappackage` (`map`, `timeoutMs`) | FF5 实验性：只读加载这张图的包清单，回复资源名/类型和包内地图名；异步，默认 5 秒超时，超时带 `timeout: true` | 0.14.6 |
| `mapasset` (`map`, `asset`, `offset`, `limit`, `timeoutMs`) | FF5 实验性：只读加载这张图的一个文本资源并按字符分页；`limit` 默认 20000、上限 60000，异步，超时带 `timeout: true` | 0.14.6 |

### `bridge` 查询(0.12.0)

本机的 `/query` 和局域网的 `/v1/query` 都能用。请求是 `{"id": 1, "op": "bridge"}`,回复:

```json
{"ok": true, "bridge": {
  "game": "ff5", "version": "0.12.0", "process": "FINAL FANTASY V",
  "startedAt": "ISO 时间", "port": 47800,
  "lan": {"enabled": true, "listen": "192.168.1.20"},
  "clients": [{"remote": "192.168.1.10:51234", "channel": "stream", "since": "ISO 时间"}],
  "hooks": {"ok": ["MessageLookup", "..."], "failed": [{"name": "…", "error": "…"}]},
  "hookErrors": {"BattleHit": 3},
  "keys": [{"at": "ISO 时间", "from": "FF5 玩家", "remote": "192.168.1.10:51240",
            "via": "game", "keys": ["Enter"], "ok": true, "error": null}],
  "warnings": [{"at": "ISO 时间", "level": "Warning", "text": "…"}]
}}
```

- `game` 是编译时定下的作品(`ff1` … `ff6`);`process` 是 `Paths.ProcessName`。
- `clients` 是本机和局域网连接的总表,`channel` 是 `stream` / `query` / `command`,断开就删掉。
- `hooks` 是 `Plugin.Start` 挂钩的结果;失败的只记名字和错误消息。
- `hookErrors` 是运行时挂钩里被吞掉的异常次数，按挂钩名计数(0.13.0)。只记次数，不再刷日志。
- `keys` 每个 `keys` 命令记一条,最多最近 100 条,按时间先后。命令里可选的 `from` 去掉首尾空白、
  最多 32 个字,没有就是 null;`remote` 是发命令那个客户端的地址;`via` 是 `game` 或 `sendinput`。
- `warnings` 是桥插件自己记的 Warning / Error / Fatal,最多最近 50 条。用
  `BepInEx.Logging.Logger.Listeners` 加的监听器只收本插件的日志,不改各处 `Logger.LogWarning`。

这些都只是托管对象,不碰 IL2CPP;几个线程都会读写,`BridgeInfo` 用一把锁保护。

`menu` 的魔法窗口里,`abilityIndex` 从列表顶端数,`abilityCursor` 从可见的第一行数;两者在列表滚动后不同。`menu` 已在 10-20 实测：主菜单、选人光标、魔法种类都读得对;队伍还没学魔法时，各魔法种类的 `enabled` 都是 false。

战斗里的魔法列表是一张每行 3 格的表，按魔法顺序列出该系全部格子，没学会的留空;`abilities` 是全部格子,`abilityCursor` 是在其中的序号，学会的名字看 `shown`(空格子会留着上次画的字，按 ID 过滤)。指令菜单按右切到「防御」(`commandState` = Defence),按左切到「换列」(Change);几个人同时等指令时，按右可能是换人(10-20 加拉夫)。

`shop` 的商品列表在选指令时也显示在屏幕上,`listCursor` 一直读得到，所以要看 `state`:`SelectCommand` 时按键作用在指令上,`SelectProduct` 时作用在列表上。`cursor` 是光标在过滤后的 `rows` 里的序号;卖出列表的 `focus` 可能全是 false，dsh 的 `sell` 应改用 `cursor`。

### `config` 查询(0.14.2)

请求是 `{"id": 1, "op": "config"}`，本机 `/query` 和局域网 `/v1/query` 都能用。它只读 `UserDataManager.instance.configSaveData`，在游戏线程上回答：

```json
{"ok": true, "config": {
  "isKeepAutoBattle": false, "battleModeIndex": 0, "battleMode": "wait",
  "battleSpeedIndex": 2, "battleMessageSpeedIndex": 3, "messageSpeed": 3,
  "isAutoDash": 1, "reequipIndex": 0, "isCursorMemory": true,
  "battleModeButton": 2, "battleModeButtonName": "right",
  "battleAuto": null
}}
```

`battleMode` 用游戏自己的 `BattleUtility.GetBattleModeByConfigValue` 映射，绝不按数字猜；映射不了就不写这个键。`battleAuto` 是**当前这场战斗**的自动战斗开关，取自 `BattlePlugManager.BattleStatusControl.isAutoMode`；不在战斗时为 null，`isKeepAutoBattle` 只是“跨战斗保持”的设置。读不到设置时回复里 `config` 为 null，顶层 `error` 说明原因。

### 倒计时和游戏结束(0.14.3,仅 FF5)

卡纳克城逃脱的 10 分钟倒计时在地图左上角和战斗右上角显示的是游戏自己的 `GrobalTimer`。`sample` 和 `pos` 里都有 `timer`：

```json
"timer": {"active": true, "seconds": 487.25, "paused": false}
```

- `active`：画面上有倒计时时为 true。判定用 `GrobalTimer.IsDisplayUI` 且计时器还没 `isFinished`；这是推断，待真机核对。
- `seconds`：剩余秒数（保留两位小数，不小于 0）；不在倒计时时 null。
- `paused`：游戏计时器暂停时为 true（例如部分菜单/选择时）；不在倒计时时 null。

`timer.start` 在倒计时出现（或重开）时推送，带 `seconds`、`paused`、`required`（总时长）。`timer.end` 在它消失时推送，`reason` 是 `finished`（到点）、`cleared`（提前移除：离开地图、读档等）或 `restarted`（换了一个计时器）。

游戏结束（全灭或倒计时到点）后，`sample` 里的 `gameover` 和直接查询 `{"id":1,"op":"gameover"}` 给出同一个对象：

```json
"gameover": {
  "open": true,
  "prompt": "continue",
  "cursor": 0,
  "autosave": {"map": "卡纳克城 1 层", "label": "自动保存", "time": "2026/11/10 1:48"}
}
```

- `prompt`：`continue` 是「读取」窗口（自动保存栏 +「要从最新的保存数据开始吗？」）；`to-title` 是「返回标题画面。可以吗？」；没认出时为 null。
- `cursor`：0 是“是”，1 是“否”，读不到 null。两个框的默认光标不同（继续框默认“是”，返回标题框默认“否”），以这个字段为准。
- `autosave`：`continue` 窗口上那一行自动保存；`map` / `label` / `time` 是画面上的文字（`map` 会拼上楼层，`time` 是自动保存下面的存档时间，不是右边的游戏时间），没开这个窗口或读不到时 null。0.14.4 起直接从 `GameOverLoadPopup.saveContentController` 的 `SaveContentView` 读 `areaNameText`/`floorNameText`/`slotNameText`/`timeStampDate`/`timeStampTime`，不再因为 `SaveContentController.IsExistData` 为 false 就提前返回；画面上读不到时退回 `SlotData`/`GameOverPopupController.saveData` 的 `CurrentArea`/`CurrentLocation`/`TimeStamp`，`map` 优先用游戏自己的 `GetLocationTextBySaveData`。**这条退回链是推断，待真机核对。**
- 这两个框打开时，游戏自己的 `pos.state` 仍是 `Event`，`dialog` 里还留着游戏结束前的最后一句台词，`saveui.open` / `title.open` 都是 false。所以要看 `gameover.open` / `gameover.prompt`，不要靠 `dialog` 或 `state` 判断。

### 战斗事件(0.13.0)

`battle.act` 挂在 `Last.Battle.BattleActExection.InitPrepareState` 的 postfix 上。它是状态机进入“准备一招”的第一步，此时 `InStagingBattleActData` 里还留着完整的指令、能力表和目标。字段：

```json
{"type": "battle.act",
 "actor": {"side": "enemy", "name": "巨翼猛禽", "id": 123},
 "command": {"id": 1, "name": "攻击"},
 "abilities": [{"id": 12, "name": "火球"}],
 "items": null,
 "targets": [{"side": "player", "name": "巴兹", "id": 1, "hp": 320, "maxHp": 400}],
 "act": "Normal", "use": "Ability", "targetType": "SingleEnemy",
 "auto": false, "counter": false, "counterCount": 0}
```

`side` 是 `enemy`(敌)或 `player`(我)。敌人的 `id` 和战斗数据里 `enemies[].id` 是同一个怪物编号;我方的 `id` 是角色编号。`counter` 为真表示这一招是反击。`auto` 是 0.14.2 加的：这一招是不是游戏替玩家自动选的；FF5 读 `BattleActData.isAuto`，FF6 读 `IsAutoBattleAct`，FF1-FF4 的 `BattleActData` 没有这个字段，写 null。各作 `BattleActData` 的字段不同：FF5 有 `isCounter` 和 `counterCount`;FF6 只有 `isCounter`，所以 `counterCount` 写 null;FF1-FF4 两者都没有，`counter` 和 `counterCount` 都写 null。`act` 是 `Normal` / `Interrupt` / `Event` 等 `BattleActData.ActType`，`use` 是 `Ability` / `Item` / `Non`。

`battle.hit` 挂在 `Last.Battle.BattleActLog.AddLog`。游戏在“一招对每个目标都算完”以后调用它，参数里正好有 `Dictionary<BattleUnitData, ICalcResult>`;每个目标推一条：

```json
{"type": "battle.hit",
 "act": {"actor": {"side": "enemy", "name": "巨翼猛禽", "id": 123},
         "command": {"id": 1, "name": "攻击"}, "abilities": null, "counter": false},
 "target": {"side": "player", "name": "巴兹", "id": 1, "hp": 280, "maxHp": 400},
 "value": 40, "hit": "Hit", "hitCount": 1, "miss": false, "heal": false,
 "conditions": [{"name": "中毒", "change": "add"}]}
```

`hit` 是游戏的 `HitType`(`Hit`、`Critical`、`Miss`、`Recovery`、`MPHit` 等);`value` 为正值，伤害还是回复看 `hit` / `heal`。`act.counter` 在 FF1-FF4 为 null，其余同 `battle.act`。`battle.ai` 每个脚本只推一次，用来在开发机留档；脚本正文不进事件，查询 `monsterai` 才读。`conditions` 来自这一目标的结算结果;`change` 在 `HitType` 为 `RecoveryCondition` 时写 `remove`，其余写 `add`，这是从命中类型推断的，还没在真机逐条核对。没有状态时 `conditions` 为 null。0.14.4 起，`Condition.MesIdName` 为空时用 `ConditionType` 枚举名兜底（和 `party[].status` 一样），不再把黑暗、中毒、石化这些空名字的状态丢掉。

### `monsterai` 查询(0.13.0,仅 FF5)

```json
{"id": 1, "op": "monsterai", "ids": [123, 124]}
```

传 `ids` 时只返回列表里的怪物，不会再捎带 `id`;不给 `id` / `ids` 时用当前战斗里的全部敌人。回复：

```json
{"ok": true, "monsterai": [{
  "monster": 123, "name": "巨翼猛禽", "scriptId": 7, "scriptName": "sc_ai_123",
  "source": "cache",
  "scriptLength": 8123, "truncated": true,
  "script": "{\"Mnemonics\":[ ... 前 4000 字 ...",
  "scriptFormat": "json",
  "abilities": [
    {"id": 381, "name": "火焰吐息", "opcode": "Act", "rate": 65, "table": 0},
    {"id": 540, "name": "烟雾", "opcode": "Act", "rate": 35, "table": 0}
  ]
}]}
```

- `scriptId` 是 `Monster.ScriptId`;`scriptName` 是 `MonsterAiScript.ScriptName`。
- `script` 是 `TextAsset.text` 原文，最多 4000 字;`scriptLength` 是总长度，`truncated` 表示截断了。
- `source` 说明从哪读到的:`cache`(0.13.1 起按怪物编号存;0.13.3 起也会在查询时扫描已载入的 `BattleAiExecute.textAsset`/`TextAsset`)、当前战斗的 `InstantiateManager`、`BattleAiExecute.textAsset`、预览用的 `BattleAiSelectController`，或已载入的同名 `TextAsset`。读不到时 `error` 会写“脚本没有载入；游戏还没取过这只怪的 AI 脚本”。
- `scriptFormat` 是 `json`(能解析出 `Mnemonics`)、`json (no recognized opcodes)` 或 `text`(按行猜的)。
- `abilities` 只列“能确定是能力编号”的项:用游戏自己的 `BattleAI.k...AbilityId` 常量决定第几个操作数是能力 ID。`Act` 这一条会按位置把 `iValues` 和 `rValues` 全配对列出，所以 `Act [381, 540] rValues [65, 35]` 会得到两项，各带 `rate`;`StartTable…EndTable` 之间的项带 `table`(0、1…)，同一组是一次抽签。认不出的 opcode 不列，不猜。
- 名字:先用 `ContentUtitlity.GetAbilityName`，再查 `GetMesIdAbilityName` / `GetMesIdBattle`，最后遍历 `Content` 的 `MesIdBattle`(`MSG_MON_ATK_*`)和 `MesIdName`。`"None"` 视为没有名字;文本键也查不到中文时，`name` 为 null，另带 `nameKey`(原始键);`name` 有中文时不再带 `nameKey`。`name` 和 `nameKey` 都是 null 才表示游戏连键都没给。字段没弄清的脚本格式:游戏用 `Format`(`SystemFlag` / `Segments` / `ScriptLocal` / `Mnemonics` / `Animations`)表示一份脚本，桥读了 `Mnemonics[].operands` 的 `iValues`/`rValues` 和 `StartTable`/`EndTable`;条件、跳转和标签的完整语义还没弄清。

### `bluemagic` 查询(0.14.4,仅 FF5)

```json
{"id": 1, "op": "bluemagic"}
```

回复：

```json
{"ok": true, "bluemagic": {
  "learned": [{"id": 392, "name": "闪光"}],
  "all": [
    {"id": 392, "name": "闪光", "learnedBy": "怪物施放（青魔法师带「学习」）"}
  ]
}}
```

- `all` 是 `Ability` 主数据里 `TypeId == AbilityType.BlueMagic`(504) 的全部青魔法，按 id 排序；名字用游戏自己的 `ContentUtitlity.GetAbilityName` / `Content` 解析。`learnedBy` 先找 `Learning` 主数据里 `ContentId` 对得上的行，按 `LearningType` 写“Lv… / 职业… Lv… / 剧情 / 装备 / 魔法石”；没有对应行时写 FF5 的规则「怪物施放（青魔法师带「学习」）」。**`Learning` 的 `Value1` / `Value2` / `JobId` 语义是推断，待真机核对。**
- `learned` 是队伍里每个 `OwnedCharacterData.OwnedAbilityList` 中 `Ability.TypeId == 504` 的项，按 id 排序。读不到 `UserDataManager`、`OwnedCharacterList` 或所有角色的能力表时写 `null`；读到了但一个都没学写 `[]`。**没有用 `OwnedMagicList`**：它是 `Magic`（白/黑魔法）的集合，不是已学青魔法。
- 字段来源：`Last.Management.UserDataManager.OwnedCharacterList`、`Last.Data.User.OwnedCharacterData.OwnedAbilityList`、`Last.Data.Master.Ability`、`Last.Data.Master.Learning`。

### `monstermoves` 查询(0.14.4,仅 FF5)

```json
{"id": 1, "op": "monstermoves", "ids": [41, 42]}
```

传 `ids` 时只查这些怪物；不给 `ids` 时用当前战斗里的全部敌人。回复：

```json
{"ok": true, "monstermoves": [{
  "id": 41, "name": "船员尘埃",
  "scriptId": 41, "scriptName": "sc_ai_041_CrewDust", "source": "cache",
  "moves": [
    {"abilityId": 392, "name": "闪光", "blueMagic": true,
     "conditions": ["黑暗"], "rate": 65}
  ]
}]}
```

- `moves` 来自 `Monster.ScriptId` → AI 脚本，解析器和 `monsterai` 是同一份（`Act` / `StartTable` / `LoopAct` 等，认不出的 opcode 不列）；同一只怪同一个 `abilityId` 只留一条，`rate` 取第一次读到的。`rate` 是脚本里的权重/百分比，不是独立概率。
- `blueMagic`：先用 `BlueMagicData.BlueMagicLearningAbilityIds`（`usedAbilityId` → 可学成的青魔法 id），再退回 `Ability.TypeId == 504`。这招教的是另一个 id 时另带 `blueMagicId`。读不到青魔法主数据时为 `false`，不是猜的。
- `conditions`：`Ability.ConditionGroupId` → `GroupMasterUtility.GetConditionMasters`（内部是 `ConditionGroup.GroupId` → `ConditionId` → `Condition`）。名字用 `Condition.MesIdName`，空时用 `ConditionType` 枚举名兜底。没有状态组或查不到时是空数组；**法术类的状态走 `Magic.FunctionGroupId` 函数组，这条链还没解开，所以法术类状态可能缺**。整条链路是推断，待真机核对。
- 读不到脚本时 `moves` 为 null，另带 `error`（和 `monsterai` 的“脚本没有载入”同一原因）。`source` 同 `monsterai`。
- 字段来源：`Last.Data.Master.Monster.ScriptId`、`MonsterAiScript`、`Last.Data.Master.Ability.ConditionGroupId`、`Last.Data.Master.ConditionGroup`、`Last.Data.Master.Condition`、`Last.Systems.GroupMasterUtility`、`Serial.FF5.Management.BlueMagicData.BlueMagicLearningAbilityIds`。

### `export` 查询(0.14.5,仅 FF5)

把整作的静态数据分页导出，给离线知识模块用(任务 93)。只读主数据，不加载地图、不读存档、不改任何状态。

```json
{"id": 1, "op": "export", "table": "monsters", "offset": 0, "limit": 200}
```

回复：

```json
{"ok": true, "export": {
  "table": "monsters", "total": 512, "offset": 0, "build": "1.2.0",
  "rows": [
    {"id": 1, "name": "哥布林", "bookId": 1, "level": 1, "hp": 4, "mp": 0,
     "weak": [], "absorb": [], "nullify": [], "statusImmune": [],
     "drops": [{"itemId": 1, "name": "药水", "rate": 30}],
     "steal": [{"itemId": 1, "name": "药水", "rate": null}],
     "boss": false, "scriptId": 1,
     "moves": [{"abilityId": 1, "name": "攻击", "blueMagic": false,
                "conditions": [], "rate": 100}]}
  ]
}}
```

`limit` 默认 200、上限 500；`offset` 负数按 0。`total` 是整张表的行数，`rows` 只是这一页。`build` 读 `UnityEngine.Application.version`，读不到为 null。主数据没载入或表名不认识时 `ok` 为 false、顶层带 `error`。`monsters` 的 `moves` 只给这一页的怪物读 AI 脚本；脚本没载入时 `moves` 为 null(不是空数组)。为了和任务 93 的行类型一致，`maps.areaType`、`monsters.scriptId`、`treasures.flag` 写成字符串(原始数值转成文本，读不到为 null)。

| table | 每行字段 | 主数据来源 |
| --- | --- | --- |
| `maps` | `{id, name, areaId, areaName, areaType}` | `Map.Id` / `MapName` / `MapTitle` / `AreaId`，`Area.AreaName` / `MapType` |
| `monsters` | `{id, name, bookId, level, hp, mp, weak, absorb, nullify, statusImmune, drops, steal, boss, scriptId, moves}` | `Monster` 的 `Id` / `MesIdName` / `Lv` / `Hp` / `Mp` / `ResistanceAttribute` / `ResistanceCondition` / `Boss` / `ScriptId` / `DropRate` / `DropContentId1..8` / `StealContentId1..4`；`AttributeGroup` 的 `GroupId` / `AttributeId` / `TypeId` / `MesIdName`；`ConditionGroup` + `Condition`；`PictureBook` + `PictureBookGroup` 给 `bookId`；`moves` 复用 `monstermoves` |
| `encounters` | `{scope, mapId, areaId, groupId, weight, monsterIds}` | `Map.MonsterSetId` → `MonsterSet.MonsterSet1..16` + `MonsterSetNRate` → `MonsterParty.Monster1..9`；世界地图的 `EncountArea.Foot01..32MonsterSet` |
| `treasures` | `{id, areaId, mapId, cell, hidden, contentId, contentName, count, flag}` | `TreasureBox.Id` / `GpsAreaId` / `TreasureType` / `Count` / `Flag`；`hidden` 是 `TreasureType == 2` |
| `shops` | `{id, mapId, areaName, kind, products: [{itemId, name, price}]}` | `ProductGroup.Id` / `MesIdName`、`Product.GroupId` / `ContentId` / `Coefficient`、`Content`、`ShopSign.GpsAreaId` / `SignType`、`Map.AreaId`、`Area.AreaName`；价格取 `Item` / `Weapon` / `Armor` / `Ability` / `Magic` 的 `Buy` |
| `items` | `{id, name, kind, price, cures, restores}` | `Content`(只取 `TypeId` 为 Item / Weapon / Armor)、`Item` / `Weapon` / `Armor` 的 `Buy`，`Item.StandardValue` / `MenuFunctionGroupId` / `BattleFunctionGroupId`、`FunctionGroup` + `Function` |
| `magic` | `{id, name, school, mp, cures}` | `Ability.TypeId` 为 White(1) / Black(2) / TimeMagic(501) / Summon(9) / BlueMagic(504)；名字用游戏自己的 `ContentUtitlity.GetAbilityName`；`mp` 是 `Ability.UseValue`；`cures` 走 `FunctionGroup`/`Function` |

- 属性名用 `AttributeGroup.MesIdName`，为空时用 `AttributeType` 枚举名；`weak` 含 `TypeId == 1` 和 `DoubleWeak(401)`，`nullify` 是 `Invalid(3)`，`absorb` 是 `Absorption(4)` 和 `AbsorptionWeakPhysics(403)`。
- 状态名用 `Condition.MesIdName`，为空时按 `GameState.Party.cs` 的做法用 `ConditionType` 枚举名兜底。`cures` 里 `RecoveryCondition` / `RecoveryConditionMulti` / `UserRecoveryCondition` 的 `FunctionNValue1..3` 当作状态 id 或状态组 id 两种都试。
- **`treasures` 的 `mapId`、`cell`、`contentId`、`contentName` 一定是 null**：`TreasureBox` 只有 `Id` / `Flag` / `GpsAreaId` / `TreasureType` / `Count`，地图号、格子和内容在加载后的地图实体 `PropertyTresureBox` 上，这个查询按任务要求不加载地图。**待真机核对**:`contentId`/格子后续只能从地图实体补。
- **推断，待真机核对**:`monsters.drops[].rate` 用 `Monster.DropRate`(所有掉落槽共用)，每槽的 `DropContentIdNValue` 当作数量而没有导出；`steal[].rate` 没有对应字段所以是 null。`items[].restores.hp` 来自 `Item.StandardValue` + `Recovery`，`restores.mp` 来自 `RecoveryEx`，哪种道具走哪条函数是推断。`shops` 用 `ShopSign.Id == ProductGroup.Id` 关联地点和种类，`Product.Coefficient` 当作百分比折价，`mapId` 取同一 `AreaId` 的第一张地图；这些都要真机核对。`magic` 用 `Ability` 而不是较小的 `Magic` 主数据，是为了包含召唤和青魔法。
- 字段来源：`Last.Data.Master.Map`、`Area`、`Monster`、`AttributeGroup`、`ConditionGroup`、`Condition`、`PictureBook`、`PictureBookGroup`、`MonsterSet`、`MonsterParty`、`EncountArea`、`TreasureBox`、`ProductGroup`、`Product`、`Content`、`ShopSign`、`Item`、`Weapon`、`Armor`、`FunctionGroup`、`Function`、`Ability`；`MasterManager.GetList<T>()` / `GetData<T>()`。

### 地图数据查询(0.14.6,仅 FF5,实验性)

这三个查询是任务 80 调查报告里“按需只读加载任意地图”的三步实验，**只读**：不切换地图、不改存档、不创建 `MapModel`、不实例化实体，也不调用 `MapManager.RequestLoadMap` / `ChangeMap` / `CreateMapModel` / `SetMapModelData` / `CreateMapEntity` / `MapColliderCreator.CreateMapColliders`。它们读取的是游戏自己的 `TextAsset`，所以格式和当前 build 一致；**但包组名、包名和 `GetMap` 的键仍是推断，必须先跑 `mapinfo` 再跑 `mappackage`，不要把它们当已核实的事实。**

#### `mapinfo`(诊断，不加载)

```json
{"id": 1, "op": "mapinfo"}
```

回复（读不到的部分为 null，`loaded.error` 表示当前没有可读的 `MapManager`）：

```json
{"ok": true, "mapinfo": {
  "assetPackageName": "…", "residentScriptGroupName": "…", "residentScriptCategoryName": "…",
  "masterState": "Complete", "currentMapId": 23,
  "map": {"id": 23, "mapName": "…", "mapNameText": "…", "assetName": "…", "mapTitle": "…",
          "scriptId": 0, "bgmId": 0, "loopType": 0, "areaId": 0, "floor": 0,
          "saveAvailability": 0, "movingAvailability": 0},
  "loaded": {
    "packageList": [{"key": "…", "assetGroupName": "…", "assetPackageName": "…",
                     "name": "…", "packageGroupName": "…", "mapCount": 1,
                     "maps": ["…"]}],
    "packageLoadComplete": ["…"], "mapLoad": ["…"], "mapLoadComplete": ["…"],
    "mapModels": [{"key": "…", "id": 23, "areaId": 0, "mapName": "…", "assetMapName": "…"}],
    "currentModel": {"key": "current", "id": 23, "…": "…"}
  }
}}
```

`packageList` 是 `MapManager.packageList`，`packageLoadComplete` / `mapLoad` / `mapLoadComplete` 是另外三个字典的 key，`mapModels` 是 `mapModelList`。每个列表最多 200 项，地图名最多 200 个；这里只读已有缓存，**不会为了让列表完整而启动加载**。

#### `mappackage`(第一步：包清单)

```json
{"id": 2, "op": "mappackage", "map": 23}
```

- `map`：`Last.Data.Master.Map` 的主键，必填。
- `timeoutMs`：可选，默认 5000，范围 100–30000。到点还没加载完就回复已有部分，`timeout: true`。
- 加载在游戏线程上每帧推进（`MapPackageLoader.UpdateLoad()`），**请求不会立刻回复**；客户端应该等这一条回复，不要重复发同一个请求。
- 同一时间只允许一个 `mappackage` / `mapasset` 加载。第二个请求立即失败，`ok: false`、顶层 `error` 以 `忙:` 开头；客户端稍后重试。

回复主体：

```json
{"ok": true, "mappackage": {
  "map": {"id": 23, "mapName": "…", "assetName": "…", "mapTitle": "…"},
  "group": "…", "packageName": "…", "source": "MapPackageLoader",
  "timeout": false, "elapsedMs": 12,
  "package": {"name": "…", "assetGroupName": "…", "mapCount": 1, "maps": ["…"], "textureCount": 3},
  "mapNames": ["…"],
  "mapData": {"name": "…", "tilemap": "…", "collision": "…", "attribute": "…",
              "transportation": "…", "encount": "…", "hiddenPassage": "…", "damage": "…",
              "subCollision": "…", "entityDefault": "…", "entityCount": 0,
              "scriptCount": 0, "encountOthersCount": 0, "routeInstructionCount": 0},
  "resources": [
    {"name": "collision", "field": "collision", "kind": "text", "asset": "…", "present": true},
    {"name": "entity", "field": "entity", "index": 0, "kind": "text",
     "asset": "…", "inline": false},
    {"name": "entity_default", "field": "entity_default", "kind": "text",
     "asset": "…", "present": true}
  ]
}}
```

`resources[].name` 就是 `mapasset` 的 `asset` 参数。标量资源名是 `tilemap` / `collision` / `attribute` / `transportation` / `encount` / `hidden_passage` / `damage` / `sub_collision` / `entity_default`；数组资源（`entity` / `script` / `encount_others` / `route_instruction`）按元素给 `name`、`asset` 和 `inline`（不返回内联正文，只给 `inlineLength`）。如果 `timeout: true`，`package` / `resources` 可能为空或不完整，用 `elapsedMs` 判断。

优先复用 `MapManager.packageList` 里已经加载的包（`source: "packageList"`，不创建加载器）；没有才新建 `MapPackageLoader`（`source: "MapPackageLoader"`）。包名先按 `Map.AssetName`，为空时退回 `Map.MapName`；如果真机上 `AssetName` 不是包名，`mapinfo` 的 `packageList.maps` 可以拿来对照，再按实际 key 调整。

#### `mapasset`(第二步：单个文本资源)

```json
{"id": 3, "op": "mapasset", "map": 23, "asset": "collision", "offset": 0, "limit": 20000}
```

- `map` / `asset`：必填。`asset` 用 `mappackage.resources[].name`，例如 `collision`、`entity_default`、某个 `entity[]` 元素的名字，或清单给的 `entity[0]` 这种下标。
- `offset`：可选，默认 0，负数按 0；按字符（不是字节）分页。
- `limit`：可选，默认 20000，上限 60000；超过按 60000，小于 1 按 1。
- `timeoutMs`：可选，默认 5000，范围 100–30000。
- 异步，和 `mappackage` 一样排队/报忙；加载完才回复，超时返回已有部分和 `timeout: true`。

回复主体：

```json
{"ok": true, "mapasset": {
  "map": {"id": 23, "mapName": "…"},
  "asset": "collision", "group": "…", "packageName": "…",
  "assetName": "…", "source": "TextAsset", "loaded": true,
  "timeout": false, "elapsedMs": 20,
  "total": 123456, "offset": 0, "limit": 20000, "length": 20000,
  "text": "…", "truncated": true, "nextOffset": 20000
}}
```

`source` 是 `inline`（资源在包清单里内联，直接返回）、`TextAsset`（走 `ResourceManager` 请求）或 `cache`（请求前就已经加载）。`nextOffset` 为 null 表示读完；`total` 是完整正文长度。内联资源不需要 `ResourceManager`，也不会占用额外资源。

#### 释放、内存和风险

- 包清单加载器是本插件自己 new 的 `MapPackageLoader`，结束时调它的 `Dispose()`；复用 `MapManager.packageList` 时不拥有、不释放。
- 文本 `TextAsset` 不调用 `ResourceManager.DestroyAsset`：它可能和当前地图共用同一份 Addressables 资源，销毁会把正在玩的地图弄坏（任务 80 报告也建议不要对共享资源调 `DestroyAsset`）。因此**读过的地图文本可能留在 `ResourceManager` 的缓存里**，直到游戏自己清理；这是本实验已知的内存代价。
- 绝对不调用的方法：`RequestLoadMap`、`ChangeMap`、`CreateMapModel`、`SetMapModelData`、`CreateMapEntity`、`CreateGroupEntity`、`ResettingEntities`、`SetMapColliderEnabled`、`ClearMap*`、`DestroyInsitance`、`LoadFieldEntityAssets`、`MapColliderCreator.CreateMapColliders`。`GameState.Maps.cs` 只出现 `MapPackageLoader.LoadAsset` / `UpdateLoad` / `IsCompleted` / `Dispose`、`MapPackageData.Package`、`AssetMapPackage.GetMap`、`ResourceManager.RequestLoadAssetBundle` / `CheckLoadAssetCompleted` / `GetAssetData`。
- 推断，待真机核对：`MapManager.AssetPackageName` 是包组名；`Map.AssetName` 是包名、`Map.MapName` 是包内键；`AssetPackageElement.asset` / `GetAssetName` 是资源地址；`inline` 非空时正文就在清单里。如果 `LoadAsset` 在非进图上下文不可用、或包名假设错了，`mappackage` 会给出 `error`，先回到 `mapinfo` 看 `packageList`。
- 加载会和游戏自己的 Addressables 请求共用 `ResourceManager`，理论上可能竞争；三个查询都在游戏线程上推进，并有超时，异常只回 `ok: false`，不向游戏线程抛。建议先在已去过的室内图跑，再找没去过的图；每次只发一个加载请求，观察 `map.change` 不出现、玩家位置/战斗/对话不变。

### 脚本格式(0.13.2，按船员尘埃 sc_ai_041_CrewDust 的例子)

`monsterai` 的 `script` 是 JSON。`Mnemonics` 是一条条指令，按顺序执行;`label` 是跳转目标(可能是日文，如「混乱時ジャンプ先」)。常见的：

| mnemonic | 意思 |
| --- | --- |
| `StartTable` / `EndTable` | 一次随机抽签开始 / 结束;中间的 `Act` 是一组候选 |
| `Act` | 按 `iValues` 和同位置的 `rValues` 抽一招;`iValues` 是能力编号，`rValues` 是权重/百分比(如 `[381,540]` + `[65,35]` 表示 65% 用 381、35% 用 540) |
| `IsMyCondition` / `IsOnlyAlive` / `IsCheckHp` | 条件判断，后面常跟跳转目标 |
| `JumpBattleAI` | 跳到另一个标签 |
| `FinalAttackAct` / `CounterAct*` | 最后攻击 / 反击类动作 |
| `LoopAct` | 循环出招，`iValues` 里是多组能力和次数 |

目前只解析了 `Act` 的能力编号和概率，以及 `StartTable` 的分组;条件、跳转和标签的完整语义还没弄清，README 里只写确定的部分。

## 局域网连接(0.5.0 起)

开发机不经过 SSH,直接连游戏里的桥(分层控制方案 §5)。

- **开关**:`C:\ffpr\bridge.json` 存在且有效时才开，由开发机的 `ffpr-laptop link` 写入。内容是 `{"listen": "<笔记本局域网地址>", "allow": ["<开发机所在主机>"], "token": "<令牌>"}`。没有这个文件，就和以前一样只听 `127.0.0.1`。
- **鉴权**:不在 `allow` 里的地址直接断开;每个请求都要带 `Authorization: Bearer <令牌>`,否则返回 401。令牌在开发机的 `secrets.env`(`BRIDGE_TOKEN`)。
- **防火墙**:需要你用管理员身份运行一次 `deploy/laptop/allow-bridge-lan.ps1 -RemoteAddress <开发机地址>`。规则绑定游戏程序、只放行开发机所在主机。
- 本机的 `127.0.0.1` 监听不变，试玩助手照旧用。0.9.0 起本机也有 `/command`,但必须带同一个令牌(试玩助手从 `bridge.json` 读),没令牌的程序按不了键。

| 路径 | 方式 | 内容 |
| --- | --- | --- |
| `GET /v1/health` | HTTP | 帧号、订阅数、丢弃数、`hello` |
| `/v1/stream` | WebSocket | 先发 `hello`,之后是写进探针文件的每一条记录 |
| `/v1/query` | WebSocket | 和「查询通道」一样的请求-应答 |
| `/v1/command` | WebSocket | 按键:`{"id": 1, "op": "keys", "keys": ["Down*3", "Enter", "Up:600"], "gap": 120, "from": "FF5 玩家"}`;整条路线 `walkpath`(见下);`status`(前台、锁屏);`stop`(取消正在按的和排队的) |

按键的写法和试玩助手一样。不带 `via` 时走 SendInput:每按一个键前都检查游戏自己的窗口(`UnityWndClass`)是否在前台，不在就停下，报 `not_focused` 或 `locked`。按住的键无论如何都会松开。

### 虚拟手柄(0.9.0 起)

- `keys` 带 `"via": "game"`,或者用 `hold`(`{"op": "hold", "key": "Down", "down": true, "ms": 1500}`),按的是游戏输入系统里的虚拟手柄，不需要游戏在前台，也不占用真实键盘。
- 为什么是手柄：游戏的输入动作只绑了手柄，键盘走的是另一条路(10-27 实测)。往窗口发键盘消息、往输入系统的键盘设备写键，游戏都没反应。
- 对应:Enter → 南键(确认)、Backspace → 东键(取消)、Tab → 北键(菜单)、方向键 → 十字键。别的键报 `no_game_button`。
- 0.10.0 加了手柄的其他按钮:`PadWest`(西键，如 FF3 起名的「随机输入」)、`PadStart`(Start,关第一次进地图时的操作提示)、`PadSelect`、`PadL1`、`PadR1`。
- 0.10.0 加了 `TextEnter`:给正在输入的文字框(起名框)按 Enter,保留框里的名字。起名框只认真键盘，手柄键、往窗口发键盘消息都没用(10-28 实测);这是游戏里那个输入框自己的提交，等于按下 Enter 键，只用在起名框上。
- 0.14.1 起，游戏线程一帧最多发一个完整的虚拟手柄状态事件:所有已知按钮的位都按“想要的状态”写，同一帧里按/放不会互相覆盖;按住一个键时重复的按下不会变成新的事件。`stop` 和 `walkpath` 结束时把全部已知按钮写成松开，包括已经不在按住表里的旧键。
- `hold` 按住的键最多 `ms` 毫秒(上限 5 秒)就自动松开，要继续按就再发一次;`stop` 松开全部。客户端中途断掉，人物也不会一直走下去;0.14.0 起 `walkpath` 还会在命令线程上每 20 毫秒看一次连接，断开就立刻松键并回 `closed`。
- `status` 回复里有 `gameButtons: true`,客户端据此不再要求前台。

### `walkpath`(0.14.0;0.14.1 修拐角)

一次把整条格子路线交给桥插件，由游戏线程逐帧按住方向键走完，不再每段开一次 SSH、人站着等。命令线程排队、等它走完才回复，和 `keys`、`hold` 一样一次只做一条：

```json
{"id": 1, "op": "walkpath", "path": [[12, 8], [13, 8], [13, 9]],
 "goal": [12, 15], "label": "go → 地图 30「图尔村」 第 2 跳",
 "timeoutMs": 60000, "blockedMs": 800, "turnLead": 0.6}
```

- `path`:格子列表，坐标和 `pos` 的 `cell` 同一套(x 向右、y 向下)。相邻两格必须四方向相邻(曼哈顿距离 1)，否则回 `bad_path`，一下也不按。玩家在某格上就从那一格接着走(通常是第 0 格);不在 `path` 上回 `off_path`，不动。
- `goal`(可选，`[x, y]`)和 `label`(可选，最多 80 字，超长截断)只用来显示，不影响怎么走。`goal` 是这次移动的目标格，可能不是 `path` 的最后一格(目标在视野外、路线在跳跃前截断等)。
- `timeoutMs` 默认 60000、上限 300000;`blockedMs` 默认 800;`turnLead` 默认 0.6 格，只在格子读数带小数时用，见下。
- 回复在普通命令回复上加了这些字段：

```json
{"ok": false, "reason": "battle", "index": 7, "steps": 7, "pos": {}, "next": null,
 "turns": [{"cell": [13, 8], "at": [13, 8], "frame": 123456, "ok": true,
            "mode": "step", "arriveFrame": 123470, "stopFrame": 123473,
            "moving": true, "raw": [312.4, 128.6]}]}
```

  - `ok`:走到最后一格才是 `true`。
  - `reason`:`arrived` / `battle` / `dialog` / `state:<MainState>` / `map_changed` / `blocked` / `off_path` / `timeout` / `stopped` / `closed` / `no_player` / `bad_path`。
  - `index`:停下时玩家在 `path` 里的下标，不在 `path` 上为 -1;`steps`:这次走了几格;`pos`:停下时的 `GameState.Position()`;`next`:只有 `blocked` 时是走不过去的那一格。
  - `turns`:每个拐角一条，最多 64 条。`at` 是换键那一帧转换后的格子坐标(和 `ConvertWorldPositionToCellPosition` 一致);`ok` 为 `false` 表示冲过了这个拐角、回走过一格;`mode` 是 `step`(在 `from` 见过到达帧后换键)、`flip`(没见到到达帧，读数跳到拐角格才换)或 `lead`(小数读数用 `turnLead`);`frame` 是换键帧;`arriveFrame` 是读数跳到拐角格的帧(没到为 null);`stopFrame` 是在拐角格上 `moving` 变 false 的帧(没停就不写);`moving` 是换键时是否在走;`raw` 是换键时 `player.transform.localPosition` 的 x/y。真机标定用，以后可以删。
- 走路:每帧读玩家的格子坐标、`IsMoving`、`MainState`、对话 / 战斗标志和地图号，按住朝下一格的方向键(x+1 Right、x-1 Left、y+1 Down、y-1 Up)。键用 `GameInput.Hold` 每帧续按、250 毫秒自动过期，桥插件自己出问题也会松键;只按虚拟手柄方向键，不写游戏数据。
- 拐角不停，按读数自动选三种模式:
  - **整数读数 + 见过到达帧**(`step`):读数先跳到 `from` 时人还在上一步的尾巴上，不算出发;等到 `from` 上出现 `moving` false(到达)，之后 `moving` 又变 true，才在这一帧换成出拐角的方向键。这一步已经出发，换键不改变它;到达拐角那一帧游戏读到的就是新方向。
  - **整数读数 + 没见到到达帧**(`flip`，比如同一帧到达又出发):退回原来的做法，读数一跳到拐角格就换成下一段的方向键。
  - **小数读数**(`lead`，室内图或别的作品):离拐角格中心还剩 `turnLead` 格以内、并且已经离开上一格中心时换成下一段的方向键。
- 冲过头:不在 `path` 上但和 `path` 上某格相邻，就走回那一格接着走，`turns` 里这个拐角记 `ok: false`;离 `path` 超过 1 格停下回 `off_path`。
- 停下的条件:走到最后一格 `arrived`;战斗 / 对话打开的同一帧先松键再回 `battle` / `dialog`;`MainState` 不是 `Player`/`Transport` 回 `state:<名字>`(机关 `Gimmick` 先松键等 5 秒，回到 `Player`/`Transport` 就接着走);地图号变了 `map_changed`;按着方向键超过 `blockedMs` 位置没动 `blocked`(`moving` 为 true 时不算没动);超时 `timeout`;收到 `stop` 回 `stopped`;发命令的连接断开回 `closed`。一开始就在战斗、对话等状态里，直接按对应原因回复，不按键。
- 命令线程等待时每 20 毫秒看一次连接状态;开发机取消工具调用会关掉连接，这时一定停。游戏线程卡住（读不到玩家）时，命令线程最多再等 500 毫秒就回一个没有 `pos` 的结果，方向键由 250 毫秒的期限松开。

### `walk` 查询和 `walk.*` 推送(0.14.0)

`walk` 是只读查询(`/query`、`/v1/query`)，在游戏线程上答，返回当前或最后一条 `walkpath`：

```json
{"walk": {
  "seq": 12, "active": true, "map": 30,
  "path": [[5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [9, 9]],
  "goal": [12, 15], "label": "go → 地图 30「图尔村」 第 2 跳",
  "index": 3, "steps": 3, "cell": [8, 8],
  "segment": {"n": 1, "of": 2, "from": [5, 8], "to": [9, 8]},
  "turns": [{"cell": [9, 8], "at": [8.42, 8.01], "frame": 123456, "ok": true,
             "mode": "lead", "arriveFrame": 123470, "stopFrame": 123473,
             "moving": true, "raw": [312.4, 128.6]}],
  "startedAt": "2026-11-05T05:12:03.1200000Z", "endedAt": null, "reason": null}}
```

- `seq` 是桥插件启动以来第几条 `walkpath`(从 1 起)。走完以后最后一条留着，`active` 变 false，`endedAt`、`reason` 和命令回复里的 `reason` 一样;一条都没走过时回 `{"walk": null}`。
- `segment` 把 `path` 按拐角切成直线段，`n` 是现在这一步(`index` → `index+1`)所在的段(从 1 数)，`of` 是总段数，`from`/`to` 是这一段的两端;走完后 `n` 等于最后一段，没有可用的段时为 null。
- `cell` 是玩家现在的格子(取整，读不到为 null);`turns` 和命令回复里的一样。

推送(本机推送和 `/v1/stream` 都有;`walkSeq` 是 walkpath 的序号，和查询里的 `seq` 相同;公共头里的 `seq` 仍是推送流自己的全局序号，客户端靠它去重):

- `walk.start`:`{walkSeq, map, path, goal, label}`，开始走的那一帧发。
- `walk.progress`:`{walkSeq, index, steps, cell, segment: {n, of}}`，`index` 变了就发;同一条 `walkpath` 的两次 progress 至少隔 100 毫秒，变化先记成待发，结束时补发最后一次再发 `walk.end`。
- `walk.end`:`{walkSeq, reason, index, steps, cell}`，停下时发，和命令回复同一帧。

开发机上可以不连笔记本测试这部分:`tools/link_harness` 把 `Outbox.cs`、`Link.cs` 编进一个小程序，用替身代替游戏,`tools/tests/test_link_harness.py` 用真实的客户端连它。

## 已知的游戏类(FF5 build 20265087,游戏版本 1.2.0)

| 用途 | 类 |
| --- | --- |
| 场景与主状态 | `Last.Management.SceneManager`、`SubSceneManagerMainGame.GetCurrentState()` |
| 用户数据与计数器 | `Last.Management.UserDataManager.instance` |
| Boost 设置 | `UserDataManager.CheatSettingsData` |
| 地图与玩家 | `FieldMap.fieldController.player`(`Last.Entity.Field.FieldPlayer`) |
| 对话 | `Last.Message.MessageWindowManager` |
| 选项 | `Last.Message.MessageSelectWindowManager`、`Last.Management.MessageChoiceWindowManager` |
| 消息文本 | `Last.Management.MessageManager.GetMessage(key)` |
| 成就 | `Last.Management.AchievementManager`(游戏内进度)、`SteamSDKManager.SetAchievment`(Steam 解锁) |
| 图鉴 | `Last.Management.PictureBookSaveManager`。图鉴存在单独的文件里，不跟随存档 |
| 战斗 | `Last.Battle.BattlePlugManager.instance` |
| 战斗出招 | `Last.Battle.BattleActExection`(`InStagingBattleActData`)、`Last.Battle.BattleActData` |
| 命中结算 | `Last.Battle.BattleActLog.AddLog`、`Last.Systems.ICalcResult` |
| 怪物 AI | `Last.Data.Master.Monster.ScriptId`、`Last.Data.Master.MonsterAiScript`、`Last.Battle.InstantiateManager.GetEnemyAIScript`(FF5) |
| 战斗设置 | `Last.Management.SystemConfig.ATBBattleType`、`Last.Data.User.Config.BattleSpeed`(FF4-FF6) |
| 游戏设置(0.14.2) | `Last.Management.UserDataManager.configSaveData`(`ConfigSaveData`)、`Last.Battle.BattleUtility.GetBattleModeByConfigValue` |
| 自动战斗状态(0.14.2) | `Last.Battle.BattlePlugManager.BattleStatusControl.isAutoMode`；界面上的 Auto 按钮在 `Last.UI.KeyInput.BattleMenuView.AutoButtonParent`(触屏是 `Last.UI.Touch.BattleMenuView.AutoButton` / `InactiveAutoButton`) |
| 战斗菜单 | `Last.UI.KeyInput.BattleCommandSelectController`、`Serial.FF5.UI.KeyInput.BattleQuantityAbilityInfomationController` |
| 商店 | `Last.UI.KeyInput.ShopController`、`ShopCommandMenuController`、`ShopTradeWindowController` |
| 存读档列表 | `Last.UI.KeyInput.SaveListController`(显示顺序 `[21, 22, 1..20]`) |
| 倒计时(0.14.3,仅 FF5) | `Last.Management.TimerInstanceManager.instance.GrobalTimer`(`GrobalTimer.Timer`；`Last.Timer.Timer.requiredSec` / `elapsedSec` / `RemainingSeconds` / `isPause` / `isFinished`) |
| 游戏结束(0.14.3,仅 FF5) | `Last.UI.KeyInput.GameOverPopupController`(`stateMachine`、`view.loadPopup`、`commonPopup`、`saveData`)、`GameOverLoadPopup`、`GameOverSelectPopup`、`CommonPopup` |
| 自动保存行(0.14.4,仅 FF5) | `GameOverLoadPopup.saveContentController`(`SaveContentController.view`、`SlotData`、`slotName`、`GetLocationTextBySaveData`)、`Last.UI.KeyInput.SaveContentView`(`areaNameText`/`floorNameText`/`slotNameText`/`timeStampDate`/`timeStampTime`)、`SaveSlotData.CurrentArea`/`CurrentLocation`/`TimeStamp` |
| 青魔法(0.14.4,仅 FF5) | `Last.Data.Master.Ability.TypeId == 504`、`Last.Data.User.OwnedCharacterData.OwnedAbilityList`、`Last.Management.UserDataManager.OwnedCharacterList`、`Last.Data.Master.Learning`、`Serial.FF5.Management.BlueMagicData.BlueMagicLearningAbilityIds`、`Serial.ProviderManager.instance.BlueMagicProvider` |
| 怪物招式状态(0.14.4,仅 FF5) | `Last.Data.Master.Ability.ConditionGroupId`、`Last.Data.Master.ConditionGroup`、`Last.Data.Master.Condition`、`Last.Systems.GroupMasterUtility.GetConditionMasters` |
| 整作导出(0.14.5,仅 FF5) | `Last.Data.Master.MasterManager.GetList<T>()` / `GetData<T>()`；`Map`、`Area`、`Monster`、`AttributeGroup`、`ConditionGroup`、`Condition`、`PictureBook`、`PictureBookGroup`、`MonsterSet`、`MonsterParty`、`EncountArea`、`TreasureBox`、`ProductGroup`、`Product`、`Content`、`ShopSign`、`Item`、`Weapon`、`Armor`、`FunctionGroup`、`Function`、`Ability`；`UnityEngine.Application.version` |
| 地图数据(0.14.6,仅 FF5,实验性) | `Last.Map.MapManager`(`AssetPackageName`、`packageList`、`packageLoadCompleteList`、`mapLoadList`、`mapLoadCompleteList`、`mapModelList`、`currentMapModel`)、`MapPackageLoader`(`LoadAsset` / `UpdateLoad` / `IsCompleted` / `Dispose`)、`MapPackageData.Package`、`AssetMapPackage`(`name` / `asset_group_name` / `map` / `GetMap`)、`AssetMapPackageData`、`AssetPackageElement`；`Last.Management.ResourceManager.RequestLoadAssetBundle<TextAsset>` / `CheckLoadAssetCompleted` / `GetAssetData<TextAsset>`；`Last.Data.Master.Map` |
| 地图菜单 | `Last.UI.KeyInput.MainMenuController`;魔法 `Serial.FF5.UI.KeyInput.AbilityWindowController`;道具 `ItemWindowController`;装备 `EquipmentWindowController` |

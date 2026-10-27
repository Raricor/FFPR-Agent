# 桥插件(FfprBridge)

BepInEx 6 IL2CPP 插件，运行在游戏进程里，**只读**游戏状态（设计方案 §5），从不改游戏数据和存档。当前版本 0.9.1。

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
- 0.9.0 / 0.9.1:虚拟手柄按键(`"via": "game"`、`hold`);本机 `/command`(要令牌);0.9.1 删掉了调试用的查询。
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
| `Plugin.cs` | 入口：读配置、逐个打挂钩(一个失败不影响其他)、启动 WebSocket、挂上每帧回调 |
| `Probe.cs` | 每帧：换地图检测、处理查询;每秒：采样 |
| `Hooks.cs` | Harmony postfix 挂钩：对话、选项、系统消息、成就、Steam、图鉴、存档 |
| `Requests.cs` | 查询的分派;换地图事件 `MapWatch` |
| `Outbox.cs` | 写探针文件;本机和局域网两个监听;WebSocket 广播与单播回复 |
| `Link.cs` | 局域网连接的设置:监听地址、允许的客户端、令牌 |
| `Keyboard.cs` | 按键线程:`keys`、`hold`、`status`、`stop`;默认走 SendInput(要前台),`"via": "game"` 交给 `GameInput` |
| `GameInput.cs` | 虚拟手柄：按键对应的按钮、按住的期限、在游戏线程上发出状态事件 |
| `GameState.Achievements.cs` | 成就：主数据、账号层、存档层、宝箱按地点、图鉴 |
| `GameState.Monsters.cs` | 怪物资料：等级、HP、属性、状态免疫、掉落、偷窃 |
| `GameState.Encounters.cs` | 当前位置的遇敌表 |
| `GameState.cs` | 采样的骨架、消息文本查询、公共小工具 |
| `GameState.Field.cs` | 地图和玩家：格子、地形、实体、碰撞、寻路 |
| `GameState.Party.cs` | 队伍和背包 |
| `GameState.Dialog.cs` | 对话框和选项 |
| `GameState.Battle.cs` | 战斗：敌我单位、战斗菜单 |
| `GameState.Menus.cs` | 带光标的界面：商店、地图菜单(魔法、道具、装备)、存档列表 |

## 编译与安装

插件要针对从笔记本取回的程序集编译。这些程序集必须和游戏当前的 build 一致，游戏更新后要重新取回。

```bash
uv run ffpr-laptop fetch-assemblies ff5   # 取回程序集到 .deps/ff5
uv run ffpr-laptop install-plugin ff5     # 编译,然后装进 BepInEx/plugins/FfprBridge(游戏需已退出)
uv run ffpr-pilot restart --slot 3        # 或者一步到位：退出游戏、编译安装、启动、等标题画面、读档
uv run ffpr-laptop probe-logs ff5         # 取回探针日志到 .deps/ff5/probe
uv run ffpr-probe ff5                     # 汇总最新的一份日志
```

只想编译：`dotnet build bridge -c Release -p:Game=ff5`，产物在 `bridge/bin/ff5/Release/FfprBridge.dll`。

配置文件 `BepInEx/config/ffpr.agent.bridge.cfg` 在首次运行后生成，有三项：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `Port` | 47800 | 填 0 关闭 WebSocket |
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
| `pos.change` | 位置记录一变就写,每 4 帧检查一次(0.5.0 起) | 和查询 `pos` 相同:地图、格子、朝向、是否在走、主状态、对话 / 战斗标志、存档次数 |
| `save.write` | 存档写完时(0.4.0 起) | 存档位、结果 |

`sample` 包含以下几部分：

| 部分 | 内容 |
| --- | --- |
| `scene` | 场景名，以及主游戏状态(Player、Message、Event、Battle、Menu、Shop 等) |
| `user` | 地图 ID、区域、地点、金钱、累计金钱、步数、战斗次数、击杀数、开过的宝箱数、存档次数、Boost 设置 |
| `party` | 队伍成员：职业、等级、HP、MP、经验值 |
| `field` | 玩家坐标，有本地、世界、实体、格子四种，还有移动状态 |
| `dialog` / `choice` | 窗口当前状态 |
| `battle` | 是否在战斗中 |

某一部分读不出来时，那一部分写成 `{"error": ...}`，其余部分照常写入。

## 查询通道

0.2.1 起，连 `ws://127.0.0.1:47800/query` 的客户端只收到自己请求的回复，不收广播。请求是 `{"id": 1, "op": "..."}`,在游戏线程里回答，每帧最多 8 个。和采样一样只读。

| op | 返回 | 起始版本 |
| --- | --- | --- |
| `pos` | 地图、主状态、格子、朝向、是否在走、对话 / 战斗标志、存档次数 | 0.2 |
| `cells` (`r`) | 玩家周围格子的地形码 | 0.2 |
| `sample` | 立即采样一次完整状态 | 0.2 |
| `entities` (`kind`, `max`) | 入口(含目的地)、宝箱(含内容)、NPC、事件，以及所在格子 | 0.2.1 |
| `route` (`to`) | 游戏自己的寻路结果(实测不可靠，改用 `collision` 自己寻路) | 0.2.x |
| `collision` | 室内碰撞网格，每层一组字符串 | 0.2.5 |
| `items` | 道具和贵重物品 | 0.3.0 |
| `saveui` | 存读档列表：是否打开、光标、各存档位 | 0.3.0 |
| `battlemenu` | 行动角色、指令和光标、打开的魔法 / 能力列表和光标;0.6.0 起加 `menuState`、`commandState`、选目标的 `target`(state、cursor)和双方单位;0.6.1 起加 `abilityState` 和画面上的魔法 `shown` | 0.4.0 |
| `shop` | 商店指令和光标、商品和价格、列表光标、数量窗口;0.5.2 起加 `state`(按键作用在哪一步) | 0.4.0 |
| `menu` | 地图菜单：指令和光标、当前子菜单、选人光标;魔法、道具、装备窗口的列表、光标和对象;0.7.5 起有换职业窗口 `job` | 0.4.1 |
| `bestiary` | 图鉴主数据：每项的编号、怪物、名字 | 0.7.1 |
| `achievements` | `defs`(成就主数据，三个平台各一套)、`account`(账号层，和 Steam 同步)、`save`(存档层计数、宝箱按地点 `treasure`、队员职业等级)、`bestiary`(每个编号登记了没有、出没地点) | 0.7.6 |
| `monsters` | 每个图鉴编号的怪物资料：等级、HP、MP、经验、金钱、首领、属性(`type` 1 弱 / 3 无效 / 4 吸收)、状态免疫、掉落、偷窃。静态数据，取一次就够 | 0.7.9 |
| `encounters` | 当前位置的遇敌组：每种队形的概率(千分比)、能不能逃、几只什么怪。世界地图上随区域和脚下地形变 | 0.8.0 |

`menu` 的魔法窗口里,`abilityIndex` 从列表顶端数,`abilityCursor` 从可见的第一行数;两者在列表滚动后不同。`menu` 已在 10-20 实测：主菜单、选人光标、魔法种类都读得对;队伍还没学魔法时，各魔法种类的 `enabled` 都是 false。

战斗里的魔法列表是一张每行 3 格的表，按魔法顺序列出该系全部格子，没学会的留空;`abilities` 是全部格子,`abilityCursor` 是在其中的序号，学会的名字看 `shown`(空格子会留着上次画的字，按 ID 过滤)。指令菜单按右切到「防御」(`commandState` = Defence),按左切到「换列」(Change);几个人同时等指令时，按右可能是换人(10-20 加拉夫)。

`shop` 的商品列表在选指令时也显示在屏幕上,`listCursor` 一直读得到，所以要看 `state`:`SelectCommand` 时按键作用在指令上,`SelectProduct` 时作用在列表上。

## 局域网连接(0.5.0 起)

开发机不经过 SSH,直接连游戏里的桥(分层控制方案 §5)。

- **开关**:`C:\ffpr\bridge.json` 存在且有效时才开，由开发机的 `ffpr-laptop link` 写入。内容是 `{"listen": "<笔记本局域网地址>", "allow": ["<开发机所在主机>"], "token": "<令牌>"}`。没有这个文件，就和以前一样只听 `127.0.0.1`。
- **鉴权**:不在 `allow` 里的地址直接断开;每个请求都要带 `Authorization: Bearer <令牌>`,否则返回 401。令牌在开发机的 `secrets.env`(`BRIDGE_TOKEN`)。
- **防火墙**:需要你用管理员身份运行一次 `deploy/laptop/allow-bridge-lan.ps1`。规则绑定游戏程序、只放行开发机所在主机。
- 本机的 `127.0.0.1` 监听不变，试玩助手照旧用。0.9.0 起本机也有 `/command`,但必须带同一个令牌(试玩助手从 `bridge.json` 读),没令牌的程序按不了键。

| 路径 | 方式 | 内容 |
| --- | --- | --- |
| `GET /v1/health` | HTTP | 帧号、订阅数、丢弃数、`hello` |
| `/v1/stream` | WebSocket | 先发 `hello`,之后是写进探针文件的每一条记录 |
| `/v1/query` | WebSocket | 和「查询通道」一样的请求-应答 |
| `/v1/command` | WebSocket | 按键:`{"id": 1, "op": "keys", "keys": ["Down*3", "Enter", "Up:600"], "gap": 120}`;`status`(前台、锁屏);`stop`(取消正在按的和排队的) |

按键的写法和试玩助手一样。不带 `via` 时走 SendInput:每按一个键前都检查游戏自己的窗口(`UnityWndClass`)是否在前台，不在就停下，报 `not_focused` 或 `locked`。按住的键无论如何都会松开。

### 虚拟手柄(0.9.0 起)

- `keys` 带 `"via": "game"`,或者用 `hold`(`{"op": "hold", "key": "Down", "down": true, "ms": 1500}`),按的是游戏输入系统里的虚拟手柄，不需要游戏在前台，也不占用真实键盘。
- 为什么是手柄：游戏的输入动作只绑了手柄，键盘走的是另一条路(10-27 实测)。往窗口发键盘消息、往输入系统的键盘设备写键，游戏都没反应。
- 对应:Enter → 南键(确认)、Backspace → 东键(取消)、Tab → 北键(菜单)、方向键 → 十字键。别的键报 `no_game_button`。
- `hold` 按住的键最多 `ms` 毫秒(上限 5 秒)就自动松开，要继续按就再发一次;`stop` 松开全部。客户端中途断掉，人物也不会一直走下去。
- `status` 回复里有 `gameButtons: true`,客户端据此不再要求前台。

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
| 战斗菜单 | `Last.UI.KeyInput.BattleCommandSelectController`、`Serial.FF5.UI.KeyInput.BattleQuantityAbilityInfomationController` |
| 商店 | `Last.UI.KeyInput.ShopController`、`ShopCommandMenuController`、`ShopTradeWindowController` |
| 存读档列表 | `Last.UI.KeyInput.SaveListController`(显示顺序 `[21, 22, 1..20]`) |
| 地图菜单 | `Last.UI.KeyInput.MainMenuController`;魔法 `Serial.FF5.UI.KeyInput.AbilityWindowController`;道具 `ItemWindowController`;装备 `EquipmentWindowController` |

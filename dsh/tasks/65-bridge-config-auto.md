# 任务 65:桥插件读游戏设置，出招事件带“是不是自动战斗”(0.14.2)

范围:
- 只改 `bridge/`:`src/Requests.cs`(新查询)、`src/GameState*.cs`(读设置)、`src/Hooks.cs`(出招事件)、`src/Version.cs`(0.14.2)、`README.md`;
- 不改 `../dsh/`、`../agent/`、`../deploy/`;不碰 git;不连笔记本。
- 沙箱里跑不了 dotnet,写完我来编，报错贴回同一个会话。
- 反编译的游戏类在 `../.deps/ff5/decompiled/`(只读，只有接口外壳)。只读，不许改任何设置、不许写存档。

## 起因(11-08 真机)

旧档上两场没人操作的随机战都自己打赢了;`flee.py` 按住 L1+R1 42 秒没逃掉，最后也是打赢的。怀疑游戏的“自动战斗”开着，或者某个键会切换它。它开着的话，我们的战术表执行器发的指令可能被自动选招盖掉，以前的战斗记录也要重新看。桥插件现在读不到这些设置。

## 要做的

1. **新查询 `config`**(`/query`、`/v1/query` 都有，只读，游戏线程上答):读游戏当前的设置，FF5 至少这些(`ConfigSaveData` 里的字段，经游戏现成的单例或用户数据取到，怎么取你从反编译里找):
   - `IsKeepAutoBattle`(自动战斗跨战斗保持)、`BattleModeIndex`(ATB 主动/等待)、`BattleSpeedIndex`、`BattleMessageSpeedIndex`、`MessageSpeed`、`IsAutoDash`、`ReequipIndex`、`IsCursorMemory`、`BattleModeButton`;
   - 下标能对上游戏菜单里的文字就一起给(比如 `battleMode: "wait"`),对不上就只给原始数字，不要猜。
   - 其他五作有同名字段就照读，没有的字段不写;读不到整体回 `{"config": null, "error": "…"}`。
2. **战斗中自动战斗现在开没开**:在战斗相关的类里找当前自动战斗的状态(`ConfigSaveData.IsKeepAutoBattle` 只是“保持”;战斗里可能另有开关，`Last.UI.KeyInput.BattleInfomationController.ShowKeyIconAutoBattle`、`Last.Battle.ActSelectAuto` 可以作线索)。找得到就放进 `config` 的 `battleAuto`(不在战斗时为 null);找不到在回报里说清看了哪些类。
3. **出招事件带 `auto`**:`BattleActStart` 钩子发的出招事件，加上 `BattleActData.isAuto`(字段名 `auto`)。这样每一招是不是自动选的直接看得出。
4. **哪个键切换自动战斗**:从反编译的按键/输入相关类里找自动战斗绑在哪个动作、哪个手柄键上(我们虚拟手柄会按 `PadL1`、`PadR1`、`PadSelect`、`PadStart`、`PadWest`、十字键和南/东/北键)。只在回报里写结论和依据，不改代码。
5. `README.md`:查询表加 `config`;战斗事件一节加 `auto`;版本记录加 0.14.2。

## 回报

300 字以内：读到了哪些字段、从哪个类取的;战斗中自动战斗的状态找到没有;切换键的结论和依据。

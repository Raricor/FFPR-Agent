# 任务 12:换职业(待办 13、28)

先读 `dsh/CLAUDE.md`。这次要改两处：桥插件(C#,`bridge/`)和 TS 版(`dsh/`)。Python 版不动。

## 起因

- 沃尔斯塔以后有 11 种职业。战术官已经在建议「加拉夫改时魔法师(重力)」,但没有换职业的工具。
- 魔法是全队共用的(任务 11 的真机数据):队伍已经有重力、魔法剑，只是现在没人的职业能用。

## 1. 桥插件：读出职业窗口(`bridge/src/GameState.Menus.cs`)

- 游戏的类:`Serial.FF5.UI.KeyInput.JobChangeWindowController`,基类 `Serial.Template.UI.KeyInput.JobChangeWindowBaseController`。反编译的源码在 `/root/data/mediaflow/FFPR-Agent/.deps/ff5/decompiled/`,只读。看过的属性有:
  - `targets`(`List<OwnedCharacterData>`)、`targetCursor`;
  - `RawIndex`、`ColmIndex`、`maxColumnCount`、`maxRowCount`、`enableJobCount`;
  - `job`(当前选中的 `Job`)、`content`(`JobContentController`)、`view`、`popup`(`JobChangePopup`)。
- 照 `MagicMenu`、`ItemMenu` 的写法，在 `menu` 查询里加一个 `job` 对象:
  - `state`(状态机);
  - 正在选谁(人名、光标);
  - **职业网格**:按画面顺序的每一格，写职业 id、名字、能不能选;
  - 网格光标(行、列);
  - 确认弹窗开没开、弹窗光标。
  - 网格内容从哪个属性读，要在反编译源码里查清，回报里写出处。
- 同时在 `party` 每人的数据里加上 `jobLevel`(当前职业的等级),有的话。`OwnedCharacterData` 里应该有职业数据列表，查清楚。
- 用 `Active(ref _jobMenu)` 的方式找窗口，和其他窗口一样。
- 版本号改成 0.7.5(`bridge/src/Plugin.cs`)。
- 编译：在 `/root/data/mediaflow/FFPR-Agent` 下运行 `~/.dotnet/dotnet build bridge -c Release -p:Game=ff5 -nologo -v:q`,要 0 错误。
- **不要装进游戏**(Claude 来装，要重启游戏)。

## 2. 技能 `changeJob(pilot, member, job)`(`dsh/src/engine/skills/menu.ts`)

- 照 `cast`、`useItem` 来写：地图菜单 → 职业 → 选人 → 在网格里走到这个职业(按网格的行列算上下左右)→ 确认 → 弹窗选「是」→ 退出。
- 换职业会卸下装备，所以换完紧接着调现有的 `optimizeEquipment`(最强装备)。
- 结果文字比如「加拉夫 换成了时魔法师,已重新装备最强」。
- 职业没解锁、名字对不上、已经是这个职业时，说清楚。

## 3. 工具 `change_job`(`dsh/src/engine/prompt.ts` 的 `TOOLS`、`game.ts`)

- 参数 `member`、`job`。中文说明：换职业会卸下装备，工具会自动换上最强的;魔法是全队共用的，换了职业就能放那一类魔法。
- `SYSTEM_PROMPT` 补一句(只加不改);`TACTICIAN_PROMPT` 补一句：可以在 `ask_up` 里建议换职业，写清楚谁换成什么、为什么。

## 测试

- 桥插件：编译通过即可(没有 C# 测试)。
- TS:用 `fake-pilot` 按你在桥插件里写的 `job` 回复形状，测正常换、目标在网格另一行、已经是这个职业、没解锁。

## 回报

不超过 40 行：改了哪些文件、两边的编译和 `npm run check` 结尾、网格从哪个属性读(出处)、拿不准的地方。dsh 那边不要编译 TS,不要重启网页。

# 任务 37:桥插件 0.13.0:出招事件、战斗设置、怪物 AI 脚本

开始前先读 `bridge/README.md`。逆向资料在 `.deps/ff5/decompiled/`(FF5 的 Il2Cpp 反编译结果，其他作品在各自的 `.deps/ffN/decompiled/`,有的话)。

范围:
- 只改 `bridge/src/`、`bridge/README.md`;
- 版本号改成 0.13.0(只在 `bridge/src/Version.cs`);
- 不改 `dsh/`、`deploy/`、`agent/`,不改 `CHANGELOG.md`(Claude 来改);
- 不碰 git。
- **不运行 `bridge/build.sh`**(会改掉版本库里的 `bridge/loader/bin`、`obj`),**不运行 `bridge/deploy.sh`、`uv run ffpr-*`**,不连笔记本。笔记本上正在玩 FF5。
- **重型检查要排队**：另外几个任务在同时跑。编译一律写成 `flock /tmp/ffpr-heavy.lock dotnet build bridge -c Release -p:Game=ff5`(`dotnet` 在 `~/.dotnet`,写法照 `bridge/build.sh` 里的 `dotnet()`)。

## 起因

- 现在桥插件读得到敌我单位的 HP、MP、状态、编号，**读不到谁出了什么招**。
  - 敌人放了什么魔法、我们是不是被反击了，代码和战术官都不知道;
  - 用户要的“魔法对策”(敌人放魔法就上魔法护盾、谁被沉默就用回音草)，现在没法写。
- 11-03 风之神殿：巨翼猛禽合上翅膀以后会反击物理攻击，我们是从 HP 不掉、探针日志里倒推出来的。
- 战术官写表时不知道敌人会用什么招。游戏里每只怪有 AI 脚本，现在没导出。
- FF5 的 ATB 要设成“等待”(用户 11-03 定的)，要能读出现在是哪种。

## 要做的

### 1. 出招事件(六作都要)

- 游戏里有这些类：`Last.Battle.BattleActData`(`AttackUnitData`、目标单位、`Command`、`abilityList`、行动类型，含反击)、`BattleActExection`、`BattleActLog` / `BattleActLogData`、`CounterActAction`、`CounterModule`。先读反编译代码，找到“一招开始执行”和“效果落到每个目标上”的地方。
- 用只读的 Harmony Postfix,写法照 `Hooks.cs` 现有的挂钩，推事件，写法照 `Emit.Event("dialog.play", …)`(同时进探针日志和局域网的推送流):
  - **`battle.act`**,一招开始时推:
    - 出招方：敌 / 我，名字，编号(敌人是怪物编号，和战斗数据里 `enemies[].id` 一致);
    - 指令名、能力名(魔法、技能、道具的中文名，用游戏自己的文本);
    - 目标列表：敌 / 我、名字、编号;
    - 是不是反击。
  - **`battle.hit`**(如果能在每个目标的效果上挂到):目标，伤害或回复的数值，落空，加上或去掉的状态。挂不到就在回报里说清楚，只做 `battle.act`。
- **只读**：不改任何游戏数据，Postfix 里出错要吞掉并计数，不能影响战斗。
- 推得太频繁的话(比如每帧)要去重，一招只推一次。

### 2. 战斗设置

- 在 `battle` 查询(或者 sample 的 `battle`)里加 `atb`:`"wait"` 或 `"active"`,能读到的话再加战斗速度。从游戏的设置类里读(先在反编译代码里找 config / option 相关的类)。

### 3. 怪物 AI 脚本(先做 FF5)

- 怪物表 `Monster` 有 `ScriptId`;`Last.Data.Master.MonsterAiScript` 有 `Id`、`ScriptName`;战斗时由 `Last.Battle.AI.BattleAiSelectController.GetBattleAI()` 读出一个 `TextAsset`。
- 新查询 **`monsterai`**,参数是怪物编号(一个或几个，不给就是当前战斗里的全部敌人)，返回:
  - `scriptId`、`scriptName`;
  - **脚本原文**(太长就截断，并标出总长度);
  - **招式名**：尽量从原文里认出引用的能力编号，查能力表换成中文名。认不出来就留空，不要猜。
- 只在被查询时读，不要每帧读。
- 格式要是看得懂，在 README 里写一段说明(哪些字段是什么意思);看不懂就照实写“还没弄清”。

### 4. 文档

- `bridge/README.md`:版本历史加 0.13.0 一行;事件表加 `battle.act`(和 `battle.hit`);查询表加 `monsterai`、`atb`。

## 检查

- `flock /tmp/ffpr-heavy.lock dotnet build bridge -c Release -p:Game=ff5`:0 警告 0 错误;
- 再编一个别的作品(`-p:Game=ff6`):FF5 专有的部分要照现有的做法隔开，别的作品也要能编过。
- 没法在开发机上跑游戏，真机由 Claude 装上以后验收。回报里写清楚：Claude 该怎么在真机上看到这几样东西(打一场仗看哪个事件、查什么)。

## 回报

不超过 30 行:
- 改了哪些文件;
- 挂在哪几个方法上，为什么选它们;
- `battle.act` / `battle.hit` 的字段示例;
- `monsterai` 的返回示例，脚本格式弄清了多少;
- 两次编译的结尾输出;
- 拿不准的地方。

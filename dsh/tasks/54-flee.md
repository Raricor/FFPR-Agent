# 任务 54:逃跑

范围:
- `src/engine/strategy/`(新动作)、`src/engine/skills/battle.ts`(执行逃跑)、`src/engine/skills/move.ts`(走路时遇敌的处理，只加逃跑这条路)、`src/engine/game.ts`(`walk_to`/`go_to`/`travel_to`/`explore` 的新参数)、`src/engine/prompt.ts`(玩家和战术官提示词里的说明)、`src/plugin/tools.ts`(如果参数要登记)、`test/`;
- 不改 `nav.ts`、`completion.ts`、`encounters.ts`、`src/client/`;
- 不改 `package.json`、`tasks/`、`lib/`、`../bridge/`、`../agent/`、`../deploy/`;
- 不碰 git;不 build;不运行 `scripts/web.sh`、`ask.mjs`;**不连笔记本**(AI 玩家正在用它玩)。
- 检查:`flock /tmp/ffpr-heavy.lock npm run check`。

## 起因(11-05,第三档)

- 沃尔斯城地下 1 层(64 号图)的随机战全是“小妖魔”(Lv20、HP 666、吸收全属性、挨打反击)，队伍 Lv11 打不动。插件没有逃跑，于是一直打到全灭。AI 玩家的原话:“插件的自动战斗**没有「逃跑」选项**,所以每走一步就全灭一次。”
- 这是老待办 9(“逃跑：按键接口加同时按住两个键，规则表接上逃跑条件”)。

## 游戏和桥插件的事实

- FF5 像素重制版：战斗中**同时按住 L1 + R1**,一会儿后全队逃走。首领战和 `notEscape` 的遇敌组逃不了。
  - `encounters` 的队伍带 `notEscape`;战斗采样有 `boss`。
- 桥插件的虚拟手柄能按住键:`pilot.send("hold", { key: "PadL1", down: true, ms: 3000, via: "game" })`,最多 5 秒，要继续按就再发一次;`{"op": "stop"}` 全部松开。
  - 按键名 `PadL1`、`PadR1` 见 `bridge/src/GameInput.cs`。
  - 现有代码里有没有包 `hold` 的函数，先查 `src/engine/`(pilot / link)，有就复用。
- 逃跑在真机上**还没验证过**(11-05 我试的那次画面其实已经是游戏结束，不作数)。按住多久、按住时要不要先关掉指令菜单，代码里写成可调的(`Config` 或常量加注释)，我上真机再调。

## 要做的

1. **策略语言加动作“逃跑”**(`do: "逃跑"`):
   - 解析、检查(`checkStrategy`)都认它，战术官和玩家都能写。
   - 执行：同时按住 L1、R1,每 2–3 秒续一次，直到战斗结束或超时(默认 20 秒)。逃掉了，战斗结果记 `fled`(或现有结果里最接近的，新加一个值也行，各处跟着改)。
   - 首领战或 `notEscape` 时，“逃跑”这条规则当成不成立，跳过，并在记录里写一句“这场逃不了”。
2. **走路时一律逃跑**:`walk_to`、`go_to`、`travel_to`、`explore` 加可选参数 `flee: true`。路上遇到随机战一律先逃跑，逃不了才照规则表打。工具说明里写清楚用途：穿过打不过的区域。
3. **提示词**:
   - 玩家:`flee` 参数的用法;打不过的随机战可以逃。
   - 战术官：可以写“逃跑”规则，例如 `{if: "enemy.any(level >= 20)", do: "逃跑"}`。条件用现有的表达式，有没有 `level` 属性先查，没有就换成现有的写法。
   - 只写用法，不写具体地图或怪物的攻略。
4. 结果文字：逃掉了写“逃跑成功(用了 N 秒)”,逃不了写原因。

## 测试(假 pilot)

- 规则表里“逃跑”:发出了按住 L1、R1 的命令并续按;战斗结束后结果是逃跑。
- 首领战 / `notEscape`:不按，跳过这条，按下一条打。
- `walk_to` 带 `flee: true`:路上遇敌先逃;不带时照旧按规则表打。
- 解析、检查都认“逃跑”。
- 原有测试照样过。

`npm run check` 全过，测试数不能比现在少(现在是 663 个)。

## 回报

不超过 20 行：改了哪些文件;按住的时长和续按间隔放在哪里调;一次模拟的结果原文;`npm run check` 结尾;拿不准的地方。

# 任务 58:一个“去某地”的工具 `go`,替掉 `walk_to`、`go_to`、`travel_to`

范围:
- `src/engine/`:`prompt.ts`、`game.ts`、`skills/travel.ts`、`skills/move.ts`、`skills/grind.ts`、`view.ts`(只改给模型看的字样);
- `src/plugin/`:`tools.ts`、`config.ts`,以及把配置传给引擎的 `player.ts`(只加传参);
- `test/`、`test/fixtures/prompt/*`;
- 不改 `src/engine/strategy/`、`skills/battle.ts` 的逻辑(注释里的工具名可以跟着改)、`src/client/`、`nav.ts`、`link-pilot.ts`、`world-grid.ts`、`atlas*.ts`;
- 不改 `package.json`、`tasks/`、`lib/`、`../agent/`、`../bridge/`、`../deploy/`;
- 不碰 git;不 build;不运行 `scripts/web.sh`、`ask.mjs`;**不连笔记本**。
- 检查:`flock /tmp/ffpr-heavy.lock npm run check`。

## 起因

- 用户 11-05 定的方向:**AI 只说去哪，怎么走全交给代码**,不要输出一串 `walk_to`,浪费思考。
- 11-04 晚到 11-05 早上这一档，1202 次工具调用里 `walk_to` 有 527 次:
  - 195 次只是为了走进下一张图;
  - 114 次猜的坐标走不到，又换个相邻坐标再试。
- 已经做完的(都在代码里，先读):
  - 任务 56:`navigate` 一次发整条路线，世界地图拼整张图寻路，战斗不占 `legs`;
  - 任务 57:“去过”按存档算(`atlas-save.ts`);`travel_to` 能经过世界地图(步行、骑飞龙)。
- 现在移动有三个工具，分工靠模型记:
  - `walk_to`:本图坐标;
  - `go_to`:世界地图坐标，带 `by_ship`;
  - `travel_to`:去别的地图。
  这次合成一个。

## 要做的

### 1. 新工具 `go`

参数:
- `to`(必填)。可以是:
  - **地图**:地图号(整数，或 `"地图 62"` 这样的字样)，或者地图名的一部分。
    - 按地图记录里的名字找;世界地图出口记的名字(如 `4:トゥールの村`)也算。
    - 对上多张就列出来让模型挑，不走、不猜。
    - 走法用 `travel.ts` 的 `travel_to` 那一套：每离开一张图过 `guardLeave`,可以经过世界地图。
    - 当前图有出口通往它、但它还不在地图记录里(从没进过)：这一跳也要能走，直接走进那个出口。现在 `mapPath` 跳过记录里没有的图，最后一跳要放开。
  - **坐标**:`[x, y]` 或 `"x,y"`,在当前地图上走过去。行为和现在的 `walk_to`/`go_to` 一样:
    - 世界地图上坐船时走海路(自动判断是不是在船上，不用模型填 `by_ship`;判断不了就留一个可选的 `by_ship`);
    - 骑飞龙去入口用 `flyIn`;
    - 完成度检查(`guardLeave`、剧情 / 首领事件格)照旧。
- `leave_incomplete`、`flee`:和现在一样。

结果:
- 格式沿用现在 `walk_to`/`travel_to` 的结果，后面照旧附完成度和当前状态。
- **用坐标、而这一格其实是有名字的地方时**(某张图的出口、世界地图上的入口)，结果末尾加一行:`(这一格是去地图 N「名字」的出口，下次可以写 go(to=N))`。

### 2. 去掉 `walk_to`、`go_to`、`travel_to`

- 从工具列表、`tools.ts` 的超时表、`game.ts` 的处理表里删掉。超时按三者里最长的(900 秒)给 `go`。
- 所有给模型看的文字里，提到这三个工具的地方都改成 `go`。包括:
  - 提示词;
  - 战术官提示词;
  - `view.ts` 的 `RIDES`;
  - `travel.ts` 的停止说明;
  - `guardLeave` 的说明;
  - `grind` 的提示等。
  用 `grep -rn 'walk_to\|go_to\|travel_to' src/` 找全，注释里的可以顺手改。
- `explore` 加 `leave_incomplete`(待办里的老问题：本图没完成时 `explore` 只能停下)，规则和 `go` 一样。

### 3. 提示词(`prompt.ts`)

只写工具怎么用，不写任何游戏攻略:
- 移动只说去哪：去别的地图写地图名或地图号(`go(to="图尔村")`),代码会自己排路线，经过世界地图也行;
- 迷宫里找没去过的地方用 `explore`;
- 宝箱、NPC、调查用 `interact`,它会自己走过去;
- 坐标只用在没有名字的地方，比如隐藏道具格、剧情触发格;**不要用坐标一段一段地挪**,走不到时先看 `look_around` / `terrain`,不要换个相邻坐标再试。

### 4. 走路的参数进 `Config`

- 任务 56 在 `move.ts` 里留了三个常量:`WALKPATH_TIMEOUT_MS`(现在是基数，实际超时按路线长度算，见 `walkpathTimeout`)、`WALKPATH_BLOCKED_MS`、`WALKPATH_TURN_LEAD`。
- 把它们放进插件的 `Config`(`walkpathTimeoutMs`、`walkpathBlockedMs`、`walkpathTurnLead`,默认值不变)，经 `player.ts` → `GameOptions` → `MoveState` 传下去。`move.ts`、`grind.ts` 从 `MoveState` 读，没有就用默认值。
- 真机标定拐弯时要改 `turnLead`,改配置就行，不用改代码。

## 测试(假 pilot,不连笔记本)

- `go(to="图尔村")`:按地图名走两跳到达;名字对上两张图：列出来、不走。
- `go(to=62)` 和 `go(to="地图 62")` 一样。
- 当前图的出口通往一张记录里没有的图：`go(to=那张图)` 走进那个出口。
- `go(to=[12, 8])` 和 `go(to="12,8")`:在本图走过去，结果和原来 `walk_to` 一样。
- 坐标正好是出口格：结果末尾有那一行提示。
- 世界地图上坐着船、给坐标：按海路走。
- 没完成就离开：不带 `leave_incomplete` 拒绝，带了放行并记欠账(地图和坐标两种都测)。
- `explore` 带 `leave_incomplete`:本图没完成也放行、记欠账。
- 工具列表里没有 `walk_to`、`go_to`、`travel_to`;`src/` 里给模型看的字符串不再提它们(写一个测试扫提示词和工具说明)。
- `Config` 改了 `walkpathTurnLead`,发出去的 `walkpath` 带的是新值。
- 原有测试全过(改名带来的改动除外)，测试数不能比现在少(现在是 701 个)。

## 回报

不超过 30 行:
- 改了哪些文件;
- `go` 的三次模拟结果原文：地图名、坐标、坐标落在出口上;
- 新的提示词里讲移动的那几句原文;
- `npm run check` 结尾;
- 拿不准的地方。

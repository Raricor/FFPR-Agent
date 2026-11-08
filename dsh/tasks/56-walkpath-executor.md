# 任务 56:一次发整条路线，连续地走(配合桥插件 0.14.0 的 `walkpath`)

范围:
- `src/engine/skills/move.ts`、`src/engine/link-pilot.ts`、`src/engine/skills/grind.ts`(**只改它单步走路的那一处**);可以新开 `src/engine/world-grid.ts`(名字你定);`test/`;
- 不改 `game.ts`、`skills/travel.ts`、`atlas.ts`、`prompt.ts`、`nav.ts`、`src/plugin/`:任务 57 同时在改其中几个。`nav.ts` 非改不可时，回报里写清改了什么、为什么;
- 不改 `src/engine/strategy/`、`skills/battle.ts`、`src/client/`、`package.json`、`tasks/`、`lib/`、`../agent/`、`../bridge/`、`../deploy/`;
- 不碰 git;不 build;不运行 `scripts/web.sh`、`ask.mjs`;**不连笔记本**。
- 检查:`flock /tmp/ffpr-heavy.lock npm run check`。

## 起因

11-04 晚到 11-05 早上这一档的数据(`.deps/pilot/timing.jsonl` 和 AI 玩家的会话):
- `navigate` 把路线按拐角(`corners`)切段，每段 `walkLeg` 发一条 `walk` 给笔记本上的试玩助手。`walk` 不在 `LINK_OPS` 里，每段都是一个 SSH 来回。
- 一共 4527 段，每段中位 1.06 秒，其中 SSH 来回约 0.7 秒，人站着不动。
- 没遇敌、没被挡的 289 次 `walk_to`:室内平均每段 3 格，世界地图 2.4 格，折合每格 0.42–0.48 秒。画面上就是走两三格停一下。
- 用户 11-05 定的分工:AI 只说去哪;**开发机算路线**;桥插件一次收下整条路线，在游戏里逐帧连续走完。桥插件那边是任务 55,在做。

## 桥插件 0.14.0 的新命令(按这个格式写，测试用假桥插件)

走命令通道(`link.command`),和 `keys`、`hold` 一样:

```json
{"op": "walkpath", "path": [[12, 8], [13, 8], [13, 9]], "timeoutMs": 60000, "blockedMs": 800, "turnLead": 0.6}
```

- `path`:逐格、四方向相邻，第 0 格是玩家现在的格子。不相邻回 `bad_path`;玩家不在 `path` 上回 `off_path`。
- 走完或停下才回复:

```json
{"ok": false, "reason": "battle", "index": 7, "steps": 7, "pos": {}, "next": null, "turns": []}
```

  - `reason`:`arrived` | `battle` | `dialog` | `state:<MainState>` | `map_changed` | `blocked` | `off_path` | `timeout` | `stopped` | `closed` | `no_player` | `bad_path`。
  - `index`:停下时所在格子在 `path` 里的下标，不在 `path` 上为 -1。
  - `pos`:和 `pos` 查询一样。
  - `next`:只在 `blocked` 时有，是走不过去的那一格。
- 桥插件遇到 `Gimmick`(开门)时自己会等 5 秒;发命令的连接一断，它就停下松键。
- 旧桥插件回 `未知的 op:walkpath`。
- `cells` 加了可选的 `at: [x, y]`:以那一格为中心读窗口，回复里多一个 `at`。旧桥插件没有这个字段，会忽略 `at`、照旧以玩家为中心。

## 要做的

### 1. `link-pilot.ts`:新的 pilot 操作 `walkpath`

- 放进 `LINK_OPS`,转成 `link.command("walkpath", …)`,等待时间是 `timeoutMs` 再加 5 秒。
- 没有 SSH 版本。局域网连不上，或者桥插件回“未知的 op”时，返回一个调用方认得出的结果(例如 `{ ok: false, error: "walkpath_unsupported" }`),让调用方退回旧走法。
  - 在这个连接上记住“不支持”,不要每次都试;桥插件重连后再试一次。
- 计时照常写进 `TIMING`,操作名就叫 `walkpath`。我要拿它和以前的 `walk` 比。
- 工具调用被取消时，命令要跟着失败，不能吞掉。连接关掉以后桥插件自己会停。

### 2. `move.ts`:`navigate` 一次发整条路线

- 规划照旧:`plannedRoute`,室内先试游戏自己的路线(`gameRoute`)。
- 发出去之前，把路线展开成逐格、四方向相邻的格子列表。
  - 游戏的路线只给拐点时，两点之间补上中间的格子;两点既不同行也不同列时，这条路线不用，改用我们自己的规划。
  - 路线里有不相邻的跳跃(传送带、落下、跳石这类 `moves`):只发到跳跃前那一格，剩下的交给下一次规划。
- 有 `walkpath` 时一次发整条，按回复处理:

| 回复 | 处理 |
| --- | --- |
| `arrived` | 和现在到达时一样：看一下是不是进了别的图(`enteredAfterArriving`),报楼层 |
| `battle` | 和 `walkLeg` 一样用 `regular` 打(带 `flee`),然后从现在的位置重新规划、接着走 |
| `state:FieldHelp` | `dismissFieldHelp`,接着走 |
| `state:Gimmick` | 桥插件已经等过 5 秒;照现在的做法 `wait` 一次再接着走 |
| `map_changed`,或 `pos.state` 是 `ChangeMap`/`FieldReady` | 和现在一样：等一下，报“进入了地图 N,现在在 …” |
| `blocked` | 把 `path[index] → next` 这一步记进 `cut`,调用 `state.link(…, "走不过去")`,重新规划 |
| `off_path` | 重新规划 |
| `dialog`、其他 `state:*` | 停下，照现在的格式报告(`停在 [x, y]:"interrupted:…"`),不要改字样 |
| `timeout`、`stopped`、`closed` | 停下，照实报告 |

- 每次停下后照旧跑 `afterWalk`(传送带、落下点、换层的记录)。
- 现在的 `legs` 数的是重新规划的次数。**路上的战斗不算一次**,不然世界地图上长路打几场就用完了。总循环次数另设一个上限，防止死循环。
- 不支持 `walkpath` 时(旧桥插件、局域网断了),退回现在的 `corners` + `walkLeg`。这条路要留着，并且有测试。
- `say` 每次规划只写一行“(x, y) → (x, y):N 格”,不按拐角写。
- `openAt`、`board`、`land`、`flyIn` 都调用 `navigate`,不用另外改。

### 3. 世界地图上全图寻路(`world-grid.ts`)

- 现在世界地图上 `plannedRoute` 只读玩家周围 `r=24` 的窗口。目标在窗口外时，先走到窗口里离目标最近的格子再看。被山、海挡住时会走进死胡同，而且每 24 格停一次。
- 桥插件有 `cells.at` 时，把世界地图的地形按地图号存在 `MoveState` 里。只放内存，不写文件;`MoveState` 是每作一份，不用加作品参数。
  - 按需读窗口还是一次读完，你来定。一次规划最多读 40 个窗口。
  - 每次规划照旧读玩家周围的窗口，覆盖缓存里的那一块：剧情可能改地形。
- 规划用拼起来的整张图，其余规则照旧:`terrainRule`、`withoutEntrances`、`cut`、飞行时都能过。
- 目标在已知范围外，或者桥插件是旧的(回复里没有 `at`):用现在的窗口做法。

### 4. `grind.ts` 的单步

- `pilot.send("walk", { to })` 那一处，有 `walkpath` 时改发 `[脚下, 目标]` 的路线;目标不相邻就用现有规划补全。
- 不支持时照旧。别的地方不动。

### 5. 数值

- `timeoutMs`、`blockedMs`、`turnLead` 先写成 `move.ts` 里的常量，注明“任务 58 接进 Config”。这次不改 `src/plugin/`。

## 测试(假 pilot、假局域网连接，不连笔记本)

- 有 3 个拐角的路线：只发了 1 条 `walkpath`,`path` 是逐格的;结果“到达”。
- 第 5 格遇敌：调用战斗，从新位置重新规划，发第 2 条;`legs` 没少。
- `blocked`(带 `next`):这一步进了 `cut`,新路线绕开它。
- `off_path`:重新规划。
- `map_changed`:结果是“进入了地图 N”。
- `state:Event`:停下，结果里有 `interrupted:state:Event`。
- 旧桥插件(“未知的 op”):退回逐段 `walk`;同一连接上第二次 `navigate` 不再试 `walkpath`。
- 游戏路线只有拐点：展开成逐格;有斜着的两点：改用我们的规划。
- 路线里有传送带跳跃：只发到跳跃前。
- 工具调用被取消：命令失败、往上抛。
- 世界地图：目标在 60 格外，中间隔着一道山脉，用拼起来的地形绕过去，一次发完;旧桥插件(没有 `at`):用窗口做法。
- `grind` 的单步发的是 `walkpath`;不支持时照旧发 `walk`。
- 原有测试全过，测试数不能比现在少(现在是 668 个)。

## 回报

不超过 30 行:
- 改了哪些文件;
- 一次模拟 `walk_to` 的 `say` 原文(带一场路上的战斗);
- 世界地图的窗口是怎么读的、一次规划读几个;
- `npm run check` 结尾;
- 拿不准的地方。

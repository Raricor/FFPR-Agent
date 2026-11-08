# 任务 55:桥插件按整条路线连续走路(`walkpath` 命令,0.14.0)

范围:
- 只改 `bridge/`:新文件 `src/Walker.cs`;`src/Keyboard.cs`(命令通道加 `walkpath`)、`src/Probe.cs`(每帧调用走路)、`src/GameState.Field.cs`(读小数坐标;`cells` 加 `at`)、`src/Requests.cs`(`cells` 的参数)、`src/Version.cs`、`README.md`;
- 不改 `../dsh/`、`../agent/`、`../deploy/`;不碰 git;不连笔记本。
- **沙箱里跑不了 dotnet**,写完不用编译，我来编。编译报错我贴回来，你用同一个会话接着改。
- 反编译的游戏类在 `../.deps/ff5/decompiled/`(只读)。那里只有接口外壳，没有方法体：游戏“什么时候读按键、移动是不是逐格锁定”看不出来，要真机标定。读不到的接口在回报里说，我贴给你，不要猜。

## 起因

11-04 晚到 11-05 早上这一档的数据:
- dsh 的 `navigate` 把一条路线按拐角切成很多段，每段让笔记本上的试玩助手(`deploy/laptop/pilot-agent.ps1` 的 `Invoke-Walk`)走一次，每次是一个 SSH 来回。
- 一共 4527 段，每段中位 1.06 秒，其中 SSH 来回约 0.7 秒，这段时间人站着不动。平均每段不到 3 格，折合每格 0.42–0.48 秒;18% 的走路平均每段不到 1.5 格。画面上就是走两三格停一下。
- 用户 11-05 定的分工:AI 只说去哪;开发机算路线;**桥插件一次收下整条路线，在游戏里逐帧连续走完**,只在需要开发机处理时停下。

## 要做的

### 1. 命令通道加 `walkpath`

请求:

```json
{"id": 1, "op": "walkpath", "path": [[12, 8], [13, 8], [13, 9]], "timeoutMs": 60000, "blockedMs": 800, "turnLead": 0.6}
```

- `path`:格子列表，坐标和 `pos` 的 `cell` 同一套(x 向右,y 向下)。相邻两格必须四方向相邻(曼哈顿距离 1),否则回 `bad_path`,一下也不按。
  - 玩家在 `path` 里某一格上：从那一格接着走(通常是第 0 格)。
  - 玩家不在 `path` 上：回 `off_path`,不动。
- `timeoutMs` 默认 60000,上限 300000;`blockedMs` 默认 800;`turnLead` 默认 0.6,含义见第 2 节。
- 和 `keys`、`hold` 一样在命令线程上排队，一次只做一条;**命令线程等走完才回复**。
- 回复(在现有命令回复格式上加字段):

```json
{"ok": false, "reason": "battle", "index": 7, "steps": 7, "pos": {}, "next": null, "turns": []}
```

  - `ok`:走到了最后一格才是 true。
  - `reason`:`arrived` | `battle` | `dialog` | `state:<MainState>` | `map_changed` | `blocked` | `off_path` | `timeout` | `stopped` | `closed` | `no_player` | `bad_path`。
  - `index`:停下时玩家所在格子在 `path` 里的下标，不在 `path` 上为 -1。
  - `steps`:这次走了几格。
  - `pos`:停下时 `GameState.Position()` 的内容，和 `pos` 查询一样。
  - `next`:只在 `blocked` 时有，是走不过去的那一格。
  - `turns`:每个拐角一条 `{"cell": [x, y], "at": [小数 x, 小数 y], "frame": 帧号, "ok": true/false}`,最多 64 条。真机标定拐弯时机用。

### 2. 走路在游戏线程上逐帧做(`Walker.cs`)

- 在 `Probe.Update` 里、`GameInput.Drain()` 之前调用，这样同一帧换的键当帧就交给游戏。
- 命令线程把路线交给 `Walker`,自己等它结束。两边之间的状态要线程安全。
- 每帧读这些:
  - 玩家的小数坐标：`PlayerCell` 用的 `ConvertWorldPositionToCellPosition`,不取整;
  - `IsMoving`、`MainState()`、对话开没开、`BattlePlugManager` 的 `isBattle`、地图号。
- 按住朝下一格的方向键:x+1 是 Right,x-1 是 Left,y+1 是 Down,y-1 是 Up(和 `pilot-agent.ps1` 一致)。
  - 用 `GameInput.Hold` 每帧续按，时限设短一些(例如 250 毫秒)。这样桥插件自己出了问题，键也会自己松开。
- **拐角不停**:在走向拐角那一格的途中，换成下一段的方向键，人到拐角时游戏直接转弯。
  - 何时换：离拐角格中心还剩 `turnLead` 格以内、并且已经离开上一格中心时。
  - 移动要是不是逐格锁定的(中途换键会斜着走、提前拐)，在回报里说，我们真机再定。
- **冲过头**:
  - 玩家冲过拐角 1 格(不在 `path` 上，但和 `path` 上某格相邻)：自己走回那一格，接着走，在 `turns` 里记 `ok: false`;
  - 离 `path` 超过 1 格：停下，回 `off_path`。
- **停下的条件**。停下时先松开所有方向键，再回复:
  - 走到最后一格:`arrived`。
  - 战斗开始或对话打开:`battle` / `dialog`。**发现的那一帧就松键**,方向键不能漏进战斗菜单或对话选项。
  - `MainState` 不是 `Player`/`Transport`:`state:<名字>`。
    - 例外是 `Gimmick`(开门这类机关):先松键等着，5 秒内回到 `Player`/`Transport` 就接着走，等不到才停。
  - 地图号变了:`map_changed`。
  - 按着方向键超过 `blockedMs` 位置都没变:`blocked`,带上 `next`。
  - 超过 `timeoutMs`:`timeout`。
  - 收到 `stop`:`stopped`。
  - **发这条命令的连接断开**:`closed`。开发机的工具调用被取消时会关掉连接，这时一定要停。命令线程等待时要定期看这个连接的状态。
  - 一开始就不在地图上走路的状态(战斗中、对话中等)：直接按上面对应的 `reason` 回复，不按键。
- 只按虚拟手柄的方向键，不写任何游戏数据。

### 3. `cells` 加可选的 `at`

```json
{"op": "cells", "r": 24, "at": [120, 80]}
```

- 以 `at` 为中心读;不传时照旧以玩家为中心。
- 回复的 `center` 仍然是玩家的格子，另加 `at` 字段;`origin` 是这次读的窗口的左上角。
- 用途：开发机把整张世界地图拼起来，做全图寻路。地图外的格子照旧是 null。
- 半径上限还是 24。

### 4. 其他

- 版本改成 0.14.0;`README.md` 命令通道的说明加上 `walkpath`,查询表的 `cells` 补上 `at`,版本记录加一行。
- `keys`、`hold`、`stop`、`status` 的行为不变。

## 回报

不超过 25 行:
- 改了哪些文件;
- 小数坐标、`IsMoving` 从哪读;
- 拐角换键的判断怎么写的;
- 连接断开怎么发现的;
- 拿不准、要我在真机上核对的地方。

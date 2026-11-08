# 任务 59:桥插件公开“正在走的路线”(`walk` 查询和 `walk.*` 推送，仍是 0.14.0)

接着任务 55 的会话做，`Walker.cs` 是你写的。

范围:
- 只改 `bridge/`:`src/Walker.cs`、`src/Requests.cs`、`src/Keyboard.cs`(如需要)、`README.md`;
- 版本号不变(0.14.0 还没装到笔记本);
- 不改 `../dsh/`、`../deploy/`、`../agent/`;不碰 git;不连笔记本。
- 沙箱里跑不了 dotnet,我来编译。

## 起因

用户 11-05 要求：走路时显示规划的路线，以及现在在走哪一段。两边都要显示:
- 笔记本上的“FFPR 桥插件”小程序(任务 60);
- dsh 网页的总控卡片(任务 61)。

路线由桥插件执行，它最清楚走到了哪一格，所以由它统一提供。

## 要做的(格式定死，任务 60、61 按这个写)

### 1. `walkpath` 命令多两个可选字段

- `goal`:`[x, y]`,这次移动的目标格。可能不是 `path` 的最后一格，比如目标在视野外，或者路线在跳跃前截断了。
- `label`:字符串，最多 80 字，说明这段路是干什么的，例如 `go → 地图 30「图尔村」 第 2 跳`。超长截断。
- 两个都只用来显示，不影响怎么走。

### 2. 只读查询 `walk`(走查询通道 `/query`、`/v1/query`,在游戏线程上答)

```json
{"op": "walk"}
→ {"walk": {
    "seq": 12,
    "active": true,
    "map": 30,
    "path": [[5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [9, 9]],
    "goal": [12, 15],
    "label": "go → 地图 30「图尔村」 第 2 跳",
    "index": 3,
    "steps": 3,
    "cell": [8, 8],
    "segment": {"n": 1, "of": 2, "from": [5, 8], "to": [9, 8]},
    "turns": [{"cell": [9, 8], "at": [8.42, 8.01], "frame": 123456, "ok": true}],
    "startedAt": "2026-11-05T05:12:03.120Z",
    "endedAt": null,
    "reason": null
  }}
```

- `seq`:桥插件启动以来第几条 `walkpath`,从 1 开始。
- 走完以后，最后一条照样留着:`active` 变 false,`endedAt`、`reason` 填上，和命令回复里的 `reason` 一样。
- 桥插件启动以来一条都没走过时，回 `{"walk": null}`。
- `segment`:把 `path` 按拐角切成直线段，`n` 是现在这一步(`index` → `index+1`)所在的段(从 1 数)，`of` 是总段数，`from`/`to` 是这一段的两端。走完后 `n` 等于最后一段。
- `cell`:玩家现在的格子(取整);读不到为 null。
- `turns`:和命令回复里的一样。

### 3. 推送(`/v1/stream` 和本机推送，在游戏线程上 `Emit.Event`)

- `walk.start`:`{seq, map, path, goal, label}`,开始走的那一帧发。
- `walk.progress`:`{seq, index, steps, cell, segment: {n, of}}`,`index` 变了就发;同一条 `walkpath` 两次之间至少隔 100 毫秒，最后一次变化不能丢。
- `walk.end`:`{seq, reason, index, steps, cell}`,停下时发，和命令回复同一帧。

### 4. `README.md`

在 `walkpath` 那节补上 `goal`/`label`、`walk` 查询、三种推送;查询表加一行 `walk`。

## 回报

不超过 15 行：改了哪些文件、`segment` 怎么算的、`walk.progress` 的节流怎么写的。

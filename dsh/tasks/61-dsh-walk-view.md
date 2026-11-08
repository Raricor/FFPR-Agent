# 任务 61:dsh 网页总控卡片里显示走路的路线和进度

范围:
- `src/engine/skills/move.ts`(发 `walkpath` 时带上 `goal`、`label`;记下这次规划的底图)、`src/engine/skills/travel.ts`(每一跳更新 `label`)、`src/engine/game.ts`(各工具设 `label`;保存走路状态)、`src/engine/events.ts`(收 `walk.*` 推送)，可以新开 `src/engine/walk-view.ts`;
- `src/plugin/`:新路由(放 `panel.ts` 或新文件);`src/client/index.ts`(总控卡片里加“走路”一块);
- `test/`;
- 不改 `nav.ts`、`link-pilot.ts`、`world-grid.ts`、`atlas*.ts`、`src/engine/strategy/`、`skills/battle.ts`;
- 不改 `package.json`、`tasks/`、`lib/`、`../bridge/`、`../deploy/`、`../agent/`;
- 不碰 git;不 build;不运行 `scripts/web.sh`、`ask.mjs`;**不连笔记本**。
- 检查:`flock /tmp/ffpr-heavy.lock npm run check`。

## 起因

- 用户 11-05 要求：走路时显示规划的路线，以及现在在走哪一段。笔记本小程序(任务 60)和 dsh 网页都要显示，这个任务做网页这边。
- 用户出门时在网页上看，所以网页这边不能依赖小程序。
- 现状(任务 56、58 之后):AI 用 `go(to=…)`;`navigate` 规划一条逐格路线，一次发给桥插件的 `walkpath`。桥插件逐帧走，停下才回复。

## 桥插件 0.14.0 这边(任务 59 在做，按这个格式写，测试用假数据)

**`walkpath` 命令多两个可选字段**(只用来显示，不影响怎么走):
- `goal: [x, y]`:这次移动的目标;
- `label`:最多 80 字，这段路是干什么的。

**推送**(经 `/v1/stream`,`events.ts` 已经在收这个流):

```json
{"type": "walk.start", "seq": 12, "map": 30, "path": [[5, 8], [6, 8]], "goal": [12, 15], "label": "go → 地图 30「图尔村」 第 2 跳"}
{"type": "walk.progress", "seq": 12, "index": 3, "steps": 3, "cell": [8, 8], "segment": {"n": 1, "of": 2}}
{"type": "walk.end", "seq": 12, "reason": "arrived", "index": 5, "steps": 5, "cell": [9, 9]}
```

- `walk.progress` 在格子变化时发，至少隔 100 毫秒。
- `reason` 和 `walkpath` 回复里的一样:`arrived`、`battle`、`dialog`、`state:*`、`map_changed`、`blocked`、`off_path`、`timeout`、`stopped`、`closed`、`bad_path`、`no_player`。
- 旧桥插件没有这些推送：网页这边就只显示开发机自己知道的部分，见下。

## 要做的

### 1. `label`

由 `Game` 的工具处理设一个基本说明，放在 `MoveState` 上，`navigate` 发 `walkpath` 时带上:
- `go → 地图 N「名字」`;
- `go → (x, y)`;
- `explore`;
- `grind(刷怪)`;
- `interact (x, y)`;
- 上下飞龙等。

`travel.ts` 每走一跳，在后面补上 ` 第 k 跳`。`goal` 就是 `navigate` 的 `goal`。

### 2. 底图

每次发 `walkpath` 时，把这次规划用的格子按路线和目标的包围盒外扩 3 格裁下来，记成“走路视图”。按游戏分开，一作一份，存在内存里就行。

```ts
{
  game, seq: number | null, map, label, goal, path,
  origin: [x, y],
  rows: string[],        // 一格一个字符
  index, steps, cell,
  segment: { n, of, from, to },
  startedAt, endedAt, reason,
}
```

- `rows` 的字符:`.` 能走，`#` 墙或不能走，`~` 海，`^` 山，`"` 平原和草地，空格是不知道。
  - 室内用规划时的碰撞网格(当前层);
  - 世界地图用拼起来的地形码(16 海;19、27 山;3、4 平原和草地)。
- `segment` 按 `path` 的直线段算，和桥插件同一个算法：从 1 数，`index` → `index+1` 那一步所在的段。

更新的来源:
- 有桥插件推送时，按 `walk.start`/`progress`/`end` 更新;`seq` 对不上的推送不要。
- 没有推送(旧桥插件、局域网退回逐段走)时：发出去时 `index = 0`,收到回复后用回复里的 `index`、`reason` 更新;逐段走法每段结束更新一次。

### 3. 路由和网页

- `GET /api/ffpr/walk?game=ffN`:返回上面那份走路视图，没有就 `null`。
- 总控卡片(`src/client/index.ts`)里加一块“走路”:
  - 用 SVG 画底图格子和路线;
  - 画法和小程序一样：走过的点线、**正在走的那一段**强调色粗线、还没走的虚线、人是实心圆、目标是空心圆环;
  - 旁边几行文字:`label`、第 n/of 段(起点→终点)、已走 / 总格数、已用时间、状态(走着写“正在走”,停了写原因的中文:到达、遇敌、对话、剧情(`state:Event`)、换图、被挡住、偏离路线、超时、停止、连接断开……)。
- 正在走时每 500 毫秒刷新，停了以后每 3 秒;卡片不在页面上时不刷新。
- 前端的规矩照 `CLAUDE.md`:一个文件，不 `import`,要显示的中文由服务端算好，前端只排版。
- 配色跟着现有卡片走，不另起一套。

## 测试(假 pilot、假推送，不连笔记本)

- `go(to="图尔村")` 两跳：发出去的 `walkpath` 带 `label`(`… 第 1 跳`、`… 第 2 跳`)和 `goal`。
- 走路视图:`rows` 里墙和地板的字符对;包围盒外扩 3 格;世界地图的海、山字符对。
- `walk.start` → `progress` → `end`:视图的 `index`、`segment`、`reason` 跟着变;`seq` 不对的推送被忽略。
- 没有推送时：用 `walkpath` 回复更新。
- 分段：一条 L 形路线是 2 段，走到拐角之后 `n` 变成 2。
- 路由:`game` 参数、没有视图时回 `null`。
- 原有测试全过，测试数不能比现在少(现在是 715 个)。

## 回报

不超过 25 行：改了哪些文件、路由返回的一个例子(截短)、网页这一块怎么画的(几行说明)、`npm run check` 结尾、拿不准的地方。

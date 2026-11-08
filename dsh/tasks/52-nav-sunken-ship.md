# 任务 52:船舶墓场沉没船 5(216 号图)走不出去

范围:
- `src/engine/nav.ts`;非改不可时 `src/engine/skills/move.ts`(回报里说明);`test/`(新测试放 `test/nav-*.test.ts`);
- 不改 `game.ts`、`completion.ts`、`encounters.ts`、`skills/travel.ts`、`src/plugin/`、`src/client/`;
- 不改 `package.json`、`tasks/`、`lib/`、`../bridge/`、`../agent/`、`../deploy/`;
- 不碰 git;不 build;不运行 `scripts/web.sh`、`ask.mjs`;不连笔记本。
- 检查:`flock /tmp/ffpr-heavy.lock npm run check`。

## 起因(11-05,第三档)

AI 玩家在 216 号图(船舶墓场·沉没船 5)拿完宝箱后出不去，它的原话:“回出口要经过半墙格的换层楼梯 (3,14),`walk_to` 的寻路不认这种半墙格，怎么绕都过不去。”这一轮它就停下了。

我从真机抓了这张图的数据：**`test/fixtures/nav/map216-sunken-ship.json`**。格式和 `map261-firepowered-ship.json` 一样，有 `pos`、`cells`、`cells24`、`entities`(`kind: "All"`)、`collision`、`routes`(游戏自己的寻路结果)。

要点:
- 玩家在第 0 层 (6,12)(`collision.searchLayer = 0`)。
- 出口 `GotoMap「沈没船4」` 在 (7,14),在第 1 层(第 1 层 (7,14) 能走，第 0 层是墙)。
- 换层格:`ToLayer` (3,14) 目标层 1;`ToLayer` (3,15) 目标层 0。
- 第 0 层第 14 行是 `1113511111111`:(3,14) 是 3(`HALF_RIGHT`),(4,14) 是 5(`HALF_LEFT`)。
- 游戏自己的寻路(`routes`):
  - 到 (3,14):`used: "theirs"`,8 格，走得到;
  - 到 (3,17):`used: "theirs"`,9 格;
  - 到 (7,14):`used: "simple"`(不能用)，因为出口在另一层。
- 按碰撞数据推出来的路:第 0 层 (6,12) → (4,12) → (4,13) → (4,14) → (4,15) → (3,15) → (3,14)(换到第 1 层)→ 第 1 层 (3,13) → (3,12) → … → (7,12) → (7,13) → (7,14)。以游戏的 `routes` 到 (3,14) 那一段为准，我推的这条只作参考。

## 要做的

1. 用这份数据写测试，复现“从 (6,12) 第 0 层走到 (7,14) 规划不出路”(或者规划出的路走不通)。先把测试写出来、确认它失败，再改。
2. 找出原因并修好。可能的方向(你来查，别只按我猜的改):
   - 半墙格 3/5 的方向，竖着进出时被当成了不通;
   - 换层格 (3,14) 进出的方向、目标层，和任务 43/44 的处理对不上;
   - 跨层规划时，目标在另一层的情况没处理好。
3. 修完后，从 (6,12) 第 0 层到 (7,14) 能规划出一条路，并且和游戏到 (3,14) 的那一段一致或兼容。
4. `map261-firepowered-ship.json` 和其他寻路测试照样过。

`npm run check` 全过，测试数不能比现在少(现在是 652 个)。

## 回报

不超过 20 行：原因是什么(一两句);改了哪些文件;规划出的路(格子序列，带层);`npm run check` 结尾;拿不准的地方。

# 任务 63:`walkpath` 遇敌时停在 `state:Event`,要当成战斗处理

范围:
- 只改 `dsh/src/engine/skills/move.ts`、`dsh/src/engine/skills/grind.ts`(如果同样的问题也在那里)和对应的 `dsh/test/`;
- 不改 `../bridge/`、`../agent/`、`../deploy/`;不碰 git;不连笔记本(测试用假桥插件或替身)。

## 起因(11-08 真机，桥插件 0.14.1)

世界地图上一条 `walkpath` 走到第 19 格时遇敌，回复是:
- `reason: "state:Event"`,`pos.state` 是 `Event`,`battle` 是 false;
- 1.5 秒后 `pos.state` 才变成 `Battle`、`battle` 变 true。

也就是说，随机遇敌开始时游戏先有一段 `MainState = Event` 的过渡，桥插件在那一帧就停下了。

`navigate` 的 `walkpath` 分支里，只有 `reason === "battle"`、`current.battle`、`current.state === "Battle"` 才进战斗处理(`regular(...)`,然后接着走);`state:Event` 落到

```ts
if (reason === "dialog" || reason.startsWith("state:")) {
  return [false, `停在 …:interrupted:state:Event`];
}
```

AI 玩家因此收到“被剧情打断”,而战斗已经开始、没人操作，要等它下一次调工具。

## 要做的

1. `walkpath` 回 `state:Event`(以及 `dialog`)时，先别返回：每 200 毫秒读一次 `pos`,最多等 2.5 秒(数值进 `Config`,和别的 `walkpath*` 参数放一起):
   - 变成战斗(`battle` 为 true 或 `state === "Battle"`):走和 `reason === "battle"` 完全一样的处理(打完 `say` 一句、`afterWalk`、接着走，不占 `legs`);
   - 回到 `Player`/`Transport` 且不在对话：当成短暂的过场，`continue` 重新规划接着走;
   - 一直是 `Event` 或对话开着：照原来那样返回 `interrupted:…`,让 AI 翻剧情。
2. 看一下 `grind` 里用 `walkpath` 单步走的那条路(任务 56 把回复换成了旧 `walk` 的格式)有没有同样的问题：遇敌被当成剧情打断、或者被当成“走不过去”。有就按同样的办法改。
3. 测试：用假桥插件造三种情况各一个测试(`state:Event` 之后变 `Battle`;`state:Event` 之后回 `Player`;一直 `Event`),断言分别进了战斗处理、接着走、返回 interrupted。

## 回报

`npm run check` 的结尾输出，加 20 行以内的说明：改了哪些函数、`grind` 有没有同样的问题。

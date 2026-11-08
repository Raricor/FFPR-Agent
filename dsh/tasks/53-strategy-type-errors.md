# 任务 53:策略表里的类型错误不能让整场战斗、所有工具都挂掉

范围:
- `src/engine/strategy/`(`expr.ts`、`strategy.ts`、`execute.ts`);需要接住异常的地方可以改 `src/engine/skills/battle.ts`(只加 try/catch 和记录，不改出招逻辑);`test/`;
- 不改 `game.ts`、`nav.ts`、`completion.ts`、`encounters.ts`、`skills/travel.ts`、`src/plugin/`、`src/client/`;
- 不改 `package.json`、`tasks/`、`lib/`、`../bridge/`、`../agent/`、`../deploy/`;
- 不碰 git;不 build;不运行 `scripts/web.sh`、`ask.mjs`;不连笔记本。
- 检查:`flock /tmp/ffpr-heavy.lock npm run check`。

## 起因(11-05,第三档，沃尔斯城地下 1 层，64 号图)

- AI 玩家报告:“工具现在每次调用都报同一个内部错误(`不能拿单位和数字比大小`),桥接层已经卡在异常状态，我这边没法再操作游戏了。”它就停下了，游戏停在一场战斗里。
- 原因：战术官给 64 号图写的表(`.deps/ds/tactics-ff5.json` 的 `"64".tables[0]`)里，阶段条件是
  `ally.count(not alive) >= 2 or ally.lowest(hp_pct) < 30`。
  - `ally.lowest(hp_pct)` 返回的是一个人(单位)，不是数。`expr.ts` 的 `asNumber` 抛 `StrategyFailure("不能拿单位和数字比大小")`。
  - 这张表通过了写表时的检查(`parseStrategy` / `checkStrategy`),没被打回。
  - 打仗时一算就抛错，异常一路冒到工具那一层。之后每次调用工具都先处理这场战斗，于是每次都报同一个错。
- 解析器其实已经知道类型:`lowest`/`highest`/`first` 的结果类型是 `unit`,`count` 是 `number`(`ValueKind`)。

## 要做的

1. **写表时就拦下来(静态检查)**:
   - `<`、`>`、`<=`、`>=` 两边必须是数。一边能确定是 `unit`、`set`、`all`、`battle`,就是解析错误。
   - 错误信息要写清楚位置，并给出正确写法，例如:“`ally.lowest(hp_pct)` 是一个人，不是数;要比他的 HP 比例写 `ally.lowest(hp_pct).hp_pct < 30`,或者 `ally.any(hp_pct < 30)`”。
   - 写之前先核对：单位后面接 `.hp_pct` 这种写法现在支不支持。不支持就加上(只读单位的数值属性)。战术官的提示词里如果有语法说明，看看要不要补一句;提示词不在本任务的目录里，就在回报里告诉我。
   - 战术官交回的表要过这个检查，不过就和别的检查错误一样打回重写(看现有流程，应该不用改 `game.ts`)。
2. **打仗时出错只跳过这一条(运行时兜底)**:
   - 阶段的 `when`、对策的 `on`、规则的 `if` 求值时抛 `StrategyFailure`,就当成“不成立”,接着看下一条。
   - 每条出错的规则在这场战斗里只记一次(记进战斗记录现有的缺口 / 问题列表里，写明哪条、什么错)。
   - 任何情况下 `StrategyFailure` 都不能冒出战斗执行器。别的异常照旧往上抛，不要一网打尽。
3. **磁盘上已经有的坏表**:读表时(`strategyFor` 或执行器拿表的地方)对每张表跑一遍新的静态检查。不过的表就不用了，换下一套或兜底，并记一句原因。不要改写文件里的表。

## 测试

- `ally.lowest(hp_pct) < 30` 解析失败，错误信息里有正确写法;`ally.lowest(hp_pct).hp_pct < 30` 能解析，结果正确。
- 64 号图那张表原样交给 `checkStrategy`:报错，不通过。
- 运行时：一条规则的 `if` 抛 `StrategyFailure`,这场战斗照样打完，按下一条规则或兜底出招，记录里有这条错误(只记一次)。
- `.deps/ds/tactics-ff5.json` 里现有的表：用新检查过一遍，列出哪些不过(只是诊断用，写在回报里)。
- 原有的策略、执行器、首领战测试照样过。

`npm run check` 全过，测试数不能比现在少(现在是 656 个)。

## 回报

不超过 20 行：改了哪些文件;单位后接属性原来支不支持;真实战术文件里有几张表不过新检查、各是什么错;`npm run check` 结尾;拿不准的地方。

# 任务 68:刷图鉴按“遇到的概率”和“以后还会不会出现”定预算

范围:
- 改 `src/engine/skills/grind.ts`、`src/engine/completion.ts`、`src/engine/encounters.ts`、`src/engine/game.ts`(`refreshCompletion`、`guardLeave`、完成度那一行)、`src/engine/bestiary.ts`(需要的话)、`src/plugin/config.ts`(新配置)、`src/engine/prompt.ts`(只改 `grind` 的说明，如果需要)和对应测试;
- 不改 `../bridge/`、`../agent/`、`../deploy/`;不碰 git;不连笔记本(测试用假桥插件)。
- 这次只有你一个 dsh 任务，可以跑整套 `npm run check`;沙箱里跑不了就说，我来跑。

## 起因(用户 11-09 提的，附 11-09 真机数据)

风之神殿 2 层(地图 203)缺“风形魔”。桥插件 `encounters.map.parties` 读到 4 组，权重加起来 1000:

| 组 | rate | 怪 |
| --- | --- | --- |
| 14 | 350 | 黑哥布林×2 |
| 15 | 350 | 白蛇 |
| 16 | 230 | 黑哥布林、白蛇 |
| 17 | 70 | 黑哥布林、**风形魔**、白蛇 |

风形魔只在 7% 的战斗里出现，平均 14 场一次。AI 先刷 10 分钟打了 26 场没碰到，又接着刷 12 分钟。完成度检查不让它离开，它只能硬刷或自己写理由。

用户的规则：**这只怪以后还会出现，就刷一阵、没遇到就记欠账交给以后;以后不会再出现，就一直刷。** 我和用户定的细化:
- “刷一阵”按概率定，不是固定次数;
- “一直刷”要有安全上限(11-05 出过数据错把后期的怪算进这张图的事)，到了上限停下交给 AI 决定。

## 已有的东西

- 概率：桥插件 `encounters` 回复里 `map.parties[].rate`(本图所有格子遇敌组的并集，世界地图是当前区域)，还有 `monsterSet`/`debug.setIds`。一张图可能有好几套遇敌表(不同区域);在 `grind` 站的地方能读到脚下那一套就用那一套，读不到就用并集里该怪所在各套的最大值。`rate` 当成同一套里各组的权重，概率 = 含这只怪的组的权重和 / 这一套的权重总和。读不到 `rate` 就当“概率未知”,照现在的做法(只看 `max_minutes`)。
- 会不会错过：各作 profile 的 `bestiaryMissables`(FF5 在 `src/engine/profiles/ff5.ts`,来自 Steam 的错过物品攻略，带期限和 `past` 剧情旗标),判断用 `bestiary.ts` 的 `monsterStatus`。返回 `限时:…` 的算“会错过”;没有规则的算“以后还会出现”;返回 `不可再获得` 的已经错过，不要求刷。
- 欠账:`Backlog`(`completion.ts`),`guardLeave` 现在只在 AI 写了 `leave_incomplete` 时记。

## 要做的

1. **每只缺的怪算出概率和类别**(放进完成度状态，测试能直接查):`chance`(0–1 或 null)、`expectedBattles`(1/chance,向上取整)、`missable`(期限文字或 null)。
2. **`grind(until_bestiary)` 自己定预算**(AI 给的 `max_minutes` 只当上限):
   - 以后还会出现的：刷到 `clamp(expectedBattles, 3, Config.bestiaryDeferBattles)` 场(默认上限 15)还没遇到，就停下，并自动记一条欠账，理由写成“低概率(7%),刷了 N 场没遇到;以后还会出现，留到以后补”。停下的说明里告诉 AI 可以直接离开。
   - 会错过的：一直刷到登记为止，但到 `max(5 × expectedBattles, …)` 场或 `Config.bestiaryMissableMinutes`(默认 40 分钟)就停，说明写清“这只怪会错过(期限：…),刷了 N 场(平均 E 场一次)还没遇到，可能是数据有误;要接着刷就再调 grind”。不自动记欠账，交给 AI 决定。
   - 概率未知：照现在的做法。
   - 一次 `grind` 里同时缺几只时，按各自的预算分别判断：以后还会出现的那几只用完预算就放弃(记欠账)，会错过的继续刷;全部放弃或全部登记就停。
3. **完成度和离开检查**:
   - 已经按第 2 条记了欠账的怪，`guardLeave` 不再拦(这张图别的没完成项照旧拦);
   - 完成度那一行给每只缺的怪带上概率和类别，比如“还缺 1 种：风形魔(7%,以后还会出现)”、“还缺：XX(2%,限时：打倒隆卡遗迹首领前)”;
   - 回来补齐后欠账照旧自动销掉(`resolveComplete`)。
4. 两个新配置进 `Config`(`bestiaryDeferBattles`、`bestiaryMissableMinutes`)。
5. 测试(假桥插件):① 上面风之神殿的 4 组数据，风形魔 7%,以后还会出现 → 15 场以内停下、记一条欠账、之后离开不拦;② 同样的数据但把风形魔放进一条假的 `bestiaryMissables` → 不在 15 场停，到上限才停、不记欠账;③ 一只 35% 的怪 → 预算是 3 场;④ 读不到 `rate` → 行为和现在一样。

## 回报

20 行以内：改了哪些函数、预算怎么算的、`npm run check` 的结尾(或沙箱跑不了的说明)。

任务 62 的更正(我后来又在真机上量了一次，任务单里有一处说错了，请按这里改):

1. **读数不是“到达那一帧才变”,是走到半路跳一整格。** 往下走的采样:帧 36163 出发(`moving` true、读数 72),帧 36171 读数已经是 73(`moving` 仍 true),帧 36174 才是 `moving` false(到达),帧 36175 又出发。`turns` 里的 `at` 是 `Math.Round(exact, 2)`,两次都是整数，说明世界地图上 `exact` 本身就是整格跳的，不是小数取整。城镇里(卡纳克城，地图 95)也一样：一个拐角的路线，`at` 是 [23,38],拐弯后照样被卡住的“上”拖偏。所以 FF5 里 `lead` 模式多半用不上，主要靠第 2、3 条。

2. 所以“读数是 `from`、`moving` 为 true”**也会出现在上一步的尾巴上**(读数已经跳到 `from`、人还没到)。任务单里的备用条件“读数变成 `from` 后已经过了 2 帧以上”是错的，会提前一格拐弯，删掉。只用这一条：在 `from` 上**见过到达那一帧**(`moving` false),之后 `moving` 又变 true,才算这一步是从 `from` 出发、可以换键。

3. 没见到到达帧的情况(比如游戏在同一帧到达又出发),退回原来的做法：读数一变成拐角格就换键。从上面的数据看，读数跳格比到达早约 3 帧，修好卡键以后这个做法本身可能就来得及。两种情况都在 `turns` 里用 `mode` 分开记(`step` = 按到达帧换的，`flip` = 读数跳到拐角格才换的，`lead` = 小数坐标按 `turnLead` 换的)，我真机上看哪种冲过头。

4. `arriveFrame` 请记成“读数跳到拐角格的帧”,另加一个 `stopFrame` = 在拐角格上 `moving` 变 false 的帧(没停就不写)。

README 里 `walkpath` 的拐角说明照这个写。回报照旧 300 字以内。

另外两处(我审查你第一轮的改动时看到的):

5. `Walker.Normal` 里 `state.SawStillAtFrom || state.FromFrames >= 2` 就是上面第 2 条说的错：`FromFrames` 从读数变成 `from` 开始数，读数比到达早约 3 帧跳格，所以会在上一步还没走完时就换键。去掉 `FromFrames >= 2` 这个分支，按第 2、3 条改。

6. `GameInput.Drain` 第 1 步到期松键：`foreach` 读到的值过期后再 `HeldUntil.TryRemove(key, out _)`,命令线程恰好在这之间续按(`hold` 走命令线程，比如逃跑续按 L1/R1),会把刚续上的条目删掉，这个键接着被置成按下却再也没有到期时间，一直按着。改成只在值没变时才删(`TryRemove(new KeyValuePair<string, long>(key, value))` 或 `ICollection<KeyValuePair>.Remove`),没删成就当没到期。

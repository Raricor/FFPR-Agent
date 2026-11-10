# 任务 87:路线执行器——按排好的路线一口气走完，只在决策点交回 AI

工作目录 `dsh/`。**只许新建**`src/engine/route/` 下的新文件(比如 `execute.ts`、`state.ts`)和 `test/route-execute*.test.ts`;`src/engine/route/` 里任务 79 的现有文件(`analyze.ts` 等)只读不改。**不改** `src/engine/game.ts`、`src/engine/prompt.ts`、`src/plugin/` 等任何现有文件——另一个任务 86 正在改 `game.ts`;把执行器接成 AI 的工具，等 86 合并后另做。不碰 git,不连真的笔记本。

## 起因

用户 11-05、11-10 多次要求：AI 只说去哪，路线由代码规划，长时间一口气执行;现在 AI 每张图、每个宝箱都单独调一次工具(`go` 到坐标 → `advance_story` → `interact` → …),看着很慢。11-10 卡纳克城限时逃脱就是一个宝箱一个宝箱地点，倒计时到点游戏结束。

任务 79 已经有了**路线分析器**(`src/engine/route/analyze.ts`:`analyzeRoute(input, world)` 输入起点和路标，输出排好顺序的 `RoutePlan`,走不到的路标单列)。缺的是**执行**。

## 做法

做一个和游戏引擎解耦的执行器：游戏动作全部通过注入的接口(下面叫 ports)完成，执行器本身只管顺序、偏离、停止和记录，这样能用替身完整测试，之后接线只要实现 ports。

```ts
interface RoutePorts {
  position(): Promise<{ map: number; cell: Cell } | null>;
  goTo(stop: Waypoint): Promise<{ ok: boolean; text: string }>;      // 走到路标(内部用 go 的现有实现)
  act(stop: Waypoint): Promise<{ ok: boolean; done: boolean; text: string; decision?: string }>;
  // act:chest 开箱、save 存档、grind 刷、story 翻剧情;inn/shop/boss/explore 这类要 AI 决定的，返回 decision
  replan(from: { map: number; cell: Cell }, rest: Waypoint[]): Promise<RoutePlan>; // 调 analyzeRoute
}
executeRoute(plan, ports, options): Promise<RouteRunResult>
```

1. **按顺序执行**每个路标：先 `goTo`,再 `act`;每完成一个就把进度写盘(路线、已完成的路标、当前序号),文件路径由调用方给;另给 `resumeRoute(file, ports)` 从文件接着走。
2. **偏离**:每步之后读 `position()`,不在预期位置(被传送带/陷阱带走、战斗后被剧情移走、掉到别的图)就对剩下的路标调 `replan`,从当前位置重新排，再接着走。不是走回旧路线。
3. **什么时候停下交回 AI**(返回结果里写清原因):
   - 路标需要决定(首领、剧情选择、没有采购单的商店、`explore` 这种没去过的地方);
   - 剩下的路标重排后全都走不到;
   - 同一个路标连续失败 2 次;
   - 一次执行的重排次数到上限(默认 5);
   - 时间预算用完(调用方给，默认 15 分钟);
   - `AbortSignal` 被取消。
   - 全部完成也返回。
4. **结果文字**:每个路标一行(到了、做了什么、用了多久);偏离和重排各一行;最后一行写停下的原因和下一步建议交给 AI 决定的事。30 行以内。
5. 数值(重排上限、同一路标失败次数、时间预算)做成选项，默认值写成模块常量，注释写出处，之后接 `Config`。

## 测试

全用替身 ports:
- 3–4 个路标顺序走完，进度文件逐步更新;从文件中途恢复能接着走;
- 第 2 个路标后位置变了(被带走) → 调 `replan`,按新顺序走完;
- 首领路标 → 走到门口停下，原因是“首领，交给 AI”;
- 重排后都走不到 → 停下，列出走不到的路标;
- 同一路标连续失败 2 次 → 停下;
- 取消信号 → 立即停下，进度已写盘;
- `npm run check` 全部通过。

## 回报

不超过 30 行：新建了哪些文件、接口最后的样子、各种停下的情况、`npm run check` 结尾、之后接成工具时 `game.ts` 要提供哪些 ports(列出来)。

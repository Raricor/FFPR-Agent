# 任务 79:路线分析器(独立模块，算法)

工作目录 `dsh/`。**只许新建**`src/engine/route/` 下的文件、`test/route*.test.ts`、`test/fixtures/route/` 下的文件(夹具已经放好，见下)。现有文件一律不改;如果非要把现有的某个纯函数加上 `export` 才能用，可以只加这个关键字，回报里写明。不碰 `src/plugin/`、`../bridge/`、`../deploy/`、`../agent/`,不碰 git,不连真的笔记本。

## 起因

用户 11-10 定的方向：游戏按「阶段」走(一个副本 → 城镇/世界地图 → 下一个副本)。每一段由代码先排好一条**路线**:依次去哪里、开哪些宝箱、在哪里刷图鉴、在哪里存档、最后打首领。之后由代码按路线执行，AI 只在决策点被叫到。

现在 AI 是一张图一张图地临时决定(新局里 `go` 585 次，60% 是同图坐标;跨图的 73% 只走 1 跳)。跨图寻路已经有了(任务 75,`src/engine/skills/travel.ts` 的 `mapPath`,按「地图 + 连通块」建图;`src/engine/regions.ts` 的 `RegionIndex`/`CollisionStore`)。缺的是**多个路标的排序**。

这个任务只做「分析」:输入路标，输出排好的路线。不执行、不接工具、不接提示词——之后由别的任务并进「阶段层」。

## 做法

### 接口(名字可以改，意思不变)

```ts
type WaypointKind = "chest" | "grind" | "shop" | "inn" | "save" | "boss" | "move" | "story";
interface Waypoint {
  id: string;
  kind: WaypointKind;
  map: number;
  cell: Cell | null;          // null:这张图里哪一格都行(比如 grind 的区域)
  label: string;              // 中文，给人看
  after?: string[];           // 必须排在这些路标之后
  minutes?: number;           // 在这里要花的时间(grind 的预算等),默认 0
}
interface RouteInput {
  start: { map: number; cell: Cell };
  end?: { map: number; cell: Cell | null } | null;   // 不给就停在最后一个路标
  waypoints: Waypoint[];
}
analyzeRoute(input, world): RoutePlan   // world:地图记录 + 碰撞(RegionIndex)或一个距离函数
```

`RoutePlan`:
- `legs`:按顺序，每段写到哪个路标、经过的地图序列、跳数、估计走的格数和分钟;
- `unreachable`:按地图记录走不到的路标和原因(比如“这一块没有记过能进来的入口”),这些将来交给 AI 去探索;
- `total`:总格数、总分钟;
- `describe(plan)`:中文文字，30 行以内，给阶段官和 AI 看。

### 算法

1. **两两距离**:对起点、每个路标、终点，两两用现有的 `mapPath`(或同一套「地图 + 连通块」规则)算。
   - 图是**有向的**:掉下去、传送带、单向电梯这类边只能单向走，距离天然不对称，不要做成对称矩阵;
   - 同一张图里，用碰撞缓存估计格数;没有碰撞缓存的图按每跳一个常数估(进 `Config` 不行的话先做成模块常量，写注释);
   - 走不到的放进 `unreachable`,不参与排序。
2. **排序**:带先后约束(`after`)的最短路线。
   - 路标 ≤ 13 个用精确的动态规划(Held–Karp,状态里带约束);
   - 更多时先用最近邻、再做 2-opt,约束不满足的交换不做;
   - 有 `boss` 时，最后一个 `save` 要排在它前面(没有 `save` 路标就在 `unreachable` 旁边记一条提醒,不要自己造存档点)。
3. 时间估计：格数 × 每格秒数(新局实测约 0.22 秒)+ 每跳的切图时间 + 路标自己的 `minutes`。常数写在模块顶部，注释写出处。

## 测试

- **合成小图**:3–5 张图的手写地图记录，验证:有向边让 A→B 和 B→A 不同;`after` 被遵守;精确解不比最近邻差;走不到的路标进 `unreachable`;boss 前有 save。
- **真实夹具**:`test/fixtures/route/fire-ship/` 里有火力船一带(250–265、634–638)真实的地图记录 `atlas.json` 和碰撞缓存 `collision/<地图>.json`(格式和 `.deps/ds/atlas-ff5.json`、`.deps/ds/collision-ff5/` 一样，11-10 从真机数据里截出来的)。用它跑一个场景：起点 253 (5,16),路标为 261 (13,27) 的宝箱、261 (7,8) 的宝箱、265 的一个格子。不要断言具体顺序，断言：每段的地图序列和单独调 `mapPath` 的结果一致;走不到的有原因;总分钟是有限数。
- `npm run check` 全部通过。

## 回报

不超过 30 行：新建了哪些文件、接口最后的样子、真实夹具场景的 `describe` 输出(原文贴出来)、`npm run check` 结尾、拿不准的地方。

# 任务 115:路线书——把攻略步骤对上地图，拼成一整段的执行清单和收集清单

工作目录 `dsh/`。只许新建 `src/engine/stage/route-book.ts`、`src/engine/stage/route-book-render.ts`、`test/route-book.test.ts`(需要的话再加 `test/fixtures/route-book/` 下的小数据)。**不改** `src/engine/stage/guide-types.ts`(Claude 写的共用类型),不碰 `src/engine/stage/guide-steps.ts`(任务 114 同时在写，本任务**不 import 它**:输入直接是 `GuideSection[]`),不改别的已有文件。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11,用户定的方向)

用户要“长时间规划 + 无延迟高速执行 + 青魔法、图鉴、宝箱收集有保证 + 完整路径看得见”,并且要先看到规划、能审。现在每一步都要模型想一次(开场 23 次坐标 `go`)。做法分三步:**① 路线书(本任务 + 114)** → 用户审 → ② 代码按路线书一口气执行 → ③ 每段的验收数字。本任务只做 ①:纯计算 + 渲染，不按键、不接工具。

## 输入

```ts
buildRouteBook(input: {
  sections: readonly GuideSection[];        // 任务 114 的产物(guide-types.ts),按攻略顺序
  fromSection: string;                      // 从哪一节开始(含),如 "Prologue"
  toSection: string;                        // 到哪一节结束(含),如 "Wind Shrine"
  knowledge: Knowledge;                     // src/engine/knowledge 的 loadKnowledge 结果
  atlas: Atlas;                             // 地图记录：出口、宝箱、links
  visitOrder: readonly string[];            // 以前几档“首次到达「地区名」”的先后(地区名，可重复)
  save: {                                   // 本档进度，缺的字段当“不知道”
    readonly bestiary: ReadonlySet<number> | null;      // 已登记的图鉴号
    readonly blueMagic: readonly string[] | null;       // 已学会的青魔法
    readonly jobs: readonly string[] | null;            // 队伍现有职业(看有没有青魔导士)
    readonly openedChests: ReadonlySet<string> | null;  // "map:x,y"
  };
}): RouteBook
renderRouteBook(book: RouteBook): string    // 中文 Markdown,给用户审
```

开发机上的真数据(不进版本库，测试只在文件存在时用):`../.deps/ds/atlas-ff5.json`、`../.deps/knowledge/ff5/`(`guide.json`、`static/maps.json` 有每张图的 `areaName`、`static/encounters.json` 有 `mapId`/`areaId` → `monsterIds`、`static/monsters.json` 有 `bookId`)、`../.deps/ds/activity-ff5.jsonl`(`kind: "event"`、`text` 以「地点 首次到达「…」」开头的行就是到达先后)。

## 1. 小节对上地图(每张图都要写“依据”)

按这个顺序，一张图可以有几条依据:
1. **怪物编号**:小节下的怪物表 `GuideMonster.id` 是游戏图鉴号 → `monsters.bookId` → 遇敌表里出现这些怪的 `mapId`(或 `areaId` 下的所有图)。依据写「怪物 008、010 在这张图遇得到」。
2. **楼层**:小节标题里的 `2F`/`B3`/`1F` 对上地图名里的「２层」「地下３层」(全角数字);依据写「楼层 2F ↔ ２层」。
3. **同一地区连起来**:和已对上的图同一个 `areaName`、并且地图记录里有出口相连的图，并进来;依据写「和 203 同属风之神殿，出口相连」。
4. **没有怪的小节(城镇、酒馆、店)**:按 `visitOrder`,夹在前后两个已对上的地区之间的那个地区，它的图(`areaName` 相同)归这一节;小节标题(`Tule - Pub`、`Greenhorn's Club`)再按地图记录里这个地区的出口关系细分，分不清就整块归这一节。依据写「按以前几档的到达先后，在海盗据点之后、风之神殿之前」。
- 一张图都对不上的小节标题，照样列出，标「没对上地图」。不猜。

## 2. 每一段的站点(执行顺序)

- 一段 = 一个 `GuideSection`。站点就是它的 `steps`,**保持攻略的顺序**(攻略写的就是人走的顺路);每一站补上地图和坐标:
  - 宝箱、隐藏道具：在这一站所属的图里，用地图记录的宝箱(`atlas` 里的 `chests`,有 `cell` 和日文名)按顺序对:攻略这一小节第 k 个宝箱 ↔ 地图记录这张图里还没用过的宝箱，能用名字对就用名字(知识模块的 `chestsIn` 有合并过的名字，看能不能用),对不上就按顺序，并标「按顺序对上，没核对名字」;
  - 存档点、回复点、首领：用知识模块和地图记录里已有的点(看 `stage/facts.ts` 怎么取 `savePoints`/`recoveryPoints`、`bossMapIds`);
  - 走路、剧情、机关这些：写地图，坐标没有就留空(执行时现场找),原文保留。
- **对不上的照实列出来**:攻略说这一小节有 n 个宝箱、地图记录只有 m 个(风之神殿：攻略 4 个，地图记录 3 个，4 层那个以前几档都漏了)→ 写「攻略 4 个，地图记录 3 个：4F 那个到了现场找」。
- 本档已开过的宝箱(`openedChests`)标「已开」。

## 3. 每一段的收集清单

- **宝箱 / 隐藏道具**:编号、东西、图和坐标、已开没开;本段合计 x/y。
- **图鉴**:这一段遇得到的怪(攻略怪物表 ∪ 遇敌表),本档登记了没有，会不会错过(知识模块 `missablesAfter` 或怪的出没范围：只在这一段出现的标「错过就没了」);首领单列。
- **青魔法**:攻略 `BM:` 和知识模块 `blueMagicSources` 合起来：哪只怪教、本档学了没有、队里有没有青魔导士;没有就写「现在没人能学;这只怪以后还出现在 …/只在这里」。
- **刷怪建议**(只给依据，不替模型决定):本段有“错过就没了”的怪或青魔法时，写在哪张图刷、遇敌表里那只怪的出现权重。

## 4. 渲染(给用户审)

`renderRouteBook` 出中文 Markdown,每段一节：标题(攻略节名 + 中文地区名)、地图和依据表、站点表(序号 / 图 / 坐标 / 做什么 / 攻略原文 / 依据)、收集清单表、对不上的地方。最前面一张总表：每段的站点数、宝箱 x/y、图鉴缺几种、青魔法缺几个、对不上几处。

## 测试

- 用手写的小 `GuideSection` + 小 atlas + 小知识数据测：四条对齐依据各一个用例;没对上的小节标出来;宝箱按名字/按顺序对上、数量对不上时的说明;已开的标记;图鉴“错过就没了”;没青魔导士时的青魔法说明;渲染里有总表和每段的表。
- 一条读真实数据的测试(文件不在就 `t.skip`):这时还没有任务 114 的解析器，就用你在测试里手写的「Wind Shrine」一节的 `GuideSection`(照攻略结构，几句话即可，不要大段抄原文),对上真实 atlas:应对上 202–207,宝箱「攻略 4、地图记录 3」。
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑，回报写清)。

## 回报

不超过 25 行：导出的函数和 `RouteBook` 的形状、四条对齐依据各怎么实现、宝箱怎么配对、真实数据上风之神殿对上了哪些图、`npm run check` 结尾、拿不准的地方。

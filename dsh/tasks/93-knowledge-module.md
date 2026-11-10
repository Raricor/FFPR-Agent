# 任务 93:知识模块 `src/engine/knowledge/`(FF5 先做)

工作目录 `dsh/`。**只许新建** `src/engine/knowledge/` 下的文件、`test/knowledge*.test.ts`、`test/fixtures/knowledge/`;现有文件只读不改(旧模块以后逐个迁)。不碰 `../bridge/`(另一个任务 92 在改)、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**(沙箱里 `npm` 跑不起来就照以前的办法拷到 `/tmp` 跑)。

## 起因

用户 11-10:把怪物图鉴、宝箱、商店这些游戏知识单独做成 knowledge 模块，先做 FF5,做稳后其他五作一次迁移;**Steam 攻略也是主要来源**(质量不错),不只是补充。

阶段层(这一段的怪、状态威胁、青魔法、宝箱、会错过的东西)、路线分析器(路标)、战术官事实单、完成度检查、网页面板要的都是同一批知识，现在散在 14 个文件约 6300 行里(`bestiary.ts`、`bestiary-save.ts`、`achievements.ts`、`encounters.ts`、`coverage.ts`、`completion.ts`、`dossier.ts`、`elements.ts`、`atlas.ts`、`atlas-save.ts`、`regions.ts`、`guide/kb.ts`、`guide/ludo.ts`、`guide/steam.ts`),而且三种性质不同的东西混在一起。

## 三层知识

| 层 | 例子 | 来源标记 |
| --- | --- | --- |
| 游戏数据(每档一样，按作品和游戏 build 号) | 地图、怪物(含招式、附带状态、能否学成青魔法)、遇敌表、宝箱(位置/区域、内容、旗标)、商店、道具/装备/魔法 | `master`(桥插件导出)、`guide`(攻略) |
| 本档进度 | 开过的宝箱、图鉴登记、已学青魔法、本档去过的图 | `save` |
| 走出来的记录 | 落点、传送带/掉落/电梯、“走不过去”(带次数)、遇到的怪、战斗记录 | `observed` |

**来源规则**(用户定的):游戏数据和攻略都是主要来源。数值类(HP、价格、遇敌权重、宝箱内容)以 `master` 为准;走法、顺序、打法、错过提醒、首领说明以 `guide` 为准;两边都有的互相印证，对不上的**标出来**(`conflicts`),不悄悄挑一个。每条事实带 `sources`。

## 导出文件格式(和任务 92 共用，桥插件按这个导)

开发机把桥插件的导出存成 `.deps/knowledge/ff5/static/<表名>.json`,每个文件:

```json
{ "game": "ff5", "build": "<游戏 build 号或 null>", "bridge": "0.14.5", "exportedAt": "ISO 时间",
  "table": "<表名>", "rows": [ ... ] }
```

表和行(字段读不到写 `null`,不要省略键):
- `maps`:`{id, name, areaId, areaName, areaType}`
- `monsters`:`{id, name, bookId, level, hp, mp, weak: [属性], absorb: [属性], nullify: [属性], statusImmune: [状态], drops: [{itemId, name, rate}], steal: [{itemId, name, rate}], boss: bool|null, scriptId, moves: [{abilityId, name, blueMagic: bool|null, conditions: [状态], rate: number|null}] | null}`
- `encounters`:`{scope: "map"|"area", mapId: number|null, areaId: number|null, groupId, weight: number|null, monsterIds: [id]}`
- `treasures`:`{id, areaId, mapId: number|null, cell: [x, y]|null, hidden: bool, contentId, contentName, count: number|null, flag}`
- `shops`:`{id, mapId: number|null, areaName, kind, products: [{itemId, name, price}]}`
- `items`:`{id, name, kind, price: number|null, cures: [状态], restores: {hp?: number, mp?: number} | null}`
- `magic`:`{id, name, school, mp: number|null, cures: [状态]}`

## 做法

1. `types.ts`:上面的行类型、来源标记、合并后的事实类型(`{value, sources, conflicts?}`)。
2. `load.ts`:读 `.deps/knowledge/ff5/static/*.json`(没有就当空，不报错);读攻略(复用 `guide/kb.ts` 的 `Guide`,不改它);读地图记录 / 碰撞缓存 / 本档进度(复用现有类，只读)。
3. `merge.ts`:按 id / 图鉴号 / 名字把 `master` 和 `guide` 对上(怪物用图鉴号最稳，宝箱用攻略的累计编号和区域 + 内容名),数值以 `master` 为准，说明以 `guide` 为准，不一致记进 `conflicts`。
4. `query.ts`(纯函数，给一个已加载好的知识对象):
   - `monstersIn({mapIds?, areaIds?})`:会遇到的怪(遇敌表),带每只的弱点、招式、附带状态;
   - `statusThreats(monsters)`:按状态汇总谁会放、多常见(遇敌权重 × 招式概率，读不到的标未知);
   - `blueMagicSources({learned})`:还没学的青魔法各由哪些怪放、在哪出现;
   - `chestsIn({mapIds?, areaIds?, opened?})`:宝箱，带开没开;
   - `shopsNear(区域)`、`itemsThatCure(状态)`;
   - `missablesAfter(剧情点)`:先只接现有的“会错过”数据(只读复用 `achievements`/`bestiary` 里已有的时限信息);
   - 每个结果都带来源。
5. `index.ts`:导出加载和查询。
6. 一份简短的 `README` 注释(模块顶部文档注释即可):三层、来源规则、文件格式、以后怎么接六作。

## 测试

- 合成的小导出文件(`test/fixtures/knowledge/`,自己编的数据，不放真实游戏数据)+ 小段合成攻略：加载、合并、冲突标记、每个查询;
- 没有导出文件时只靠攻略和地图记录也能回答(来源只有 `guide`/`observed`);
- `npm run check` 全部通过。

## 回报

不超过 30 行：新建了哪些文件、对上 `master` 和 `guide` 的规则、查询接口、`npm run check` 结尾、拿不准的地方。

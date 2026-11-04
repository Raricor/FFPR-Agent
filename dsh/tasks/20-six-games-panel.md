# 任务 20:成就、图鉴、宝箱面板支持六作

先读 `dsh/CLAUDE.md` 和 `dsh/tasks/13`–`18`。只改 TS(引擎、服务端、前端)。桥插件和 Python 版不动。

## 起因

用户要 FF1、FF2、FF3、FF4、FF6 的宝箱信息、怪物图鉴也和 FF5 一样能看。

- 五作的 Steam 成就结构和 FF5 一样：宝箱、图鉴、击杀、全地点;FF3、FF4、FF6 还有「全部隐藏道具」。
- 桥插件的 `achievements`、`monsters`、`encounters` 用的都是六作共用的 `Last.*` 引擎类(Claude 已把 FF5 专有的部分改成按作品条件编译)。
- 所以数据都能拿到，要改的是引擎和面板里写死 FF5 的地方。

## 现在写死 FF5 的地方

- `src/engine/achievements.ts`:
  - `ACHIEVEMENTS`(FF5 的 Steam 清单);
  - `SEALED_WEAPONS_AREA`;
  - `ONE_TIME_PLACES` 和 `OneTimePlace`;
  - 标题「FF5 成就 · 当前存档」。
- `src/engine/bestiary.ts`:`BESTIARY_MISSABLES`、`ELEMENTS`(属性编号对名字)。
- `src/client/index.ts`:标签名「FF5 成就」「FF5 策略」,以及两个面板的标题。

## 1. 每作一份资料(`src/engine/profiles/`,新目录)

```ts
export interface GameProfile {
  readonly key: string;                                  // "ff6"
  readonly achievements: readonly AchievementInfo[];     // Steam 中文清单
  readonly oneTimePlaces: readonly OneTimePlace[];       // 宝箱的「不可回收」
  readonly bestiaryMissables: readonly MissableRule[];   // 图鉴的「不可再获得」
  /** 「全部在某个地点」的成就，如 FF5 的封印武器：地点号和宝箱种类 */
  readonly areaGoals: readonly { api: string; area: number; kind: "chest" | "hidden" }[];
}
```

- `ff1.ts` … `ff6.ts` 各一份，`index.ts` 里有 `profileFor(key)`(不认识的作品抛错)。
- **FF5**:把现在 `achievements.ts`、`bestiary.ts` 里的 FF5 资料原样搬过来。
  - `areaGoals` 写 `[{ api: "get_sealed_weapon", area: 55, kind: "hidden" }]`;
  - 行为一点不变，现有的 FF5 测试全部照过。
- **其他五作**:
  - `achievements` 照 `tasks/20-steam-achievements/<key>.json` 写成常量(和 FF5 一样，不运行时读文件);
  - 另外三项先是空数组。注释写明：等真机取到地点号、对过攻略再补(Claude 来补)。
- `OneTimePlace`、`MissableRule` 这些类型挪到 `profiles/types.ts`,别的模块从那里引。

## 2. 引擎按资料工作

- `achievementView`、`formatAchievements`、`progressRows`、`tacticsView`、`monsterStatus` 这些，都改成接收 `GameProfile`(或者它的那几项),不再直接引 FF5 的常量。
- 标题「FF5 成就 · 当前存档」改成「<作品> 成就 · 当前存档」,作品名用 `games.ts` 的 `label`(FF6)。
- 封印武器那条规则改成通用的 `areaGoals`:成就的 `api` 对上，就按那个地点、那种宝箱的已开数 / 总数算。
- 一作没有隐藏道具(FF1、FF2)时，宝箱表的「隐藏」一列和表头的隐藏道具都不出现。现在的数据里就看得出来：没有 type 2 的行。

## 3. 属性名从游戏数据里认(`bestiary.ts`)

- 桥插件 `monsters` 回复里，弱点那几行的属性带名字，是一句话，比如「对冰属性抵抗力低」「对毒抵抗力低」。
- 新函数 `elementNames(monsters)`:扫一遍所有怪物的属性行，用 `/^对(.+?)(?:属性)?抵抗力低$/` 取出名字，得到编号 → 名字。
- 显示时先用这张表;没有的编号用 FF5 的旧表兜底(注释写明 FF5 真机核对过);再没有就写「属性 N」。
- `MonsterAttribute` 重新带上 `name`(任务 16 之后被删了，现在要用)。

## 4. 认出当前是哪一作(`src/plugin/`)

- 桥插件的健康检查(`BridgeLink.health`)回复里有 `hello.product`,是游戏名(FINAL FANTASY VI)。按 `games.ts` 的 `title` 对上作品。
- `/ach` 和两个面板路由每次都先这样认作品。
  - 认不出就用插件配置的 `game`;
  - 连不上桥插件的情况照现在的处理。
- 写成一个函数，命令和路由共用，比如 `currentGame(engine, signal)`。

## 5. 策略页(`tactics-view.ts`、`panel.ts`)

只有 FF5 有 AI 玩家和规则表(插件配置的 `game`)。

- 当前作品**不是**配置的 `game` 时:
  - 不显示规则表、最近的战斗、战术官、首领战、其他地图;
  - 只显示 `status`、遇敌表、敌人(只有特性，没有推演的第一招);
  - 加一句「这一作还没有 AI 玩家，没有战斗策略」。
- `TacticsPanelView` 加 `title`:「FF5 策略」「FF6 策略」。

## 6. 前端(`src/client/index.ts`)

- 标签名改成「FFPR 成就」「FFPR 策略」,guide 里的说明也去掉 FF5。
- 两个面板的大标题都用服务端给的 `title`。
- 打开过的标签照旧认 `kind`,自动打开的 `localStorage` 键不改。

## 测试

- **FF5**:现有测试全过，输出一字不差。
- **profiles**:六作都能取到;成就数是 24/28/31/30/39/37,和 `games.ts` 的 `achievementCount` 一致。
- **FF6 一份手写回复**:
  - 标题是「FF6 成就 · 当前存档」;
  - 37 个成就都列出来;
  - 宝箱 / 图鉴照常算。
- **FF1**:没有 type 2 宝箱时，不出现隐藏道具一列。
- **`elementNames`**:从句子里认名字;「对毒抵抗力低」这种不带「属性」的也认;没有句子时用兜底。
- **`currentGame`**:`hello.product` 对上作品;认不出时用配置。
- **策略页**:非 FF5 时只有遇敌表和敌人特性。

## 回报

不超过 40 行：改了哪些文件、`npm run build` 和 `npm run check` 的结尾、拿不准的地方。不要重启网页。

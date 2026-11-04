# 任务 24:dsh 网页里的六作总控页(状态加日志)

开始前先读 `dsh/CLAUDE.md` 和 `tasks/21-six-players.md`。

范围:
- 只改 `dsh/`:`src`、`test`;`lib/client.js` 由 `npm run build` 产出。
- 另一个任务正同时在改 `../bridge/` 和 `../deploy/`,不要碰它们。
- 不碰 git,不重启网页，不往 profile 里装东西。

## 起因

六作同时玩的时候，有两个问题:

- 用户要开 12 个会话窗口(六个玩家、六个战术官),才看得到各作在干什么。
- 右侧栏的成就 / 策略页只服务 FF5。10-28 为了避开路由重名,`src/index.ts` 只让 FF5 注册了路由。

用户要的是：一个图形界面，同时看六作的情况，并且记录日志。界面放在 dsh 网页里。

## 1. 六个引擎登记在一处(新建 `src/plugin/registry.ts`)

- 一张表 `Map<string, PlayerEngine>`,键是作品(ff1 … ff6)。
  - 这张表挂在 `globalThis[Symbol.for("@local/ffpr-dsh/engines")]` 上，不用普通的模块级变量。
  - 原因：根条目和六个玩家预设即使拿到的是同一个模块的不同实例(热重载、加载器隔离等),也要看到同一张表。
  - 这是唯一一处允许几作共享的状态。在文件开头的注释里写明这一点和上面的原因。
- 玩家的 `apply()` 在 `startEngine` 之后登记，卸载时(`ctx.effect` 的清理函数)撤销。
  - 撤销时只删自己登记的那个引擎。同一作重新加载时，新引擎已经把旧的覆盖了，不能删掉新的。
- 导出 `engineFor(game)` 和 `engines()`。

## 2. 路由只注册一次，用 `?game=` 区分作品(`src/index.ts`、`src/plugin/panel.ts`)

**谁注册路由:**
- 改由根条目注册，也就是 `role: panel` 的 `ffpr-panel`。它在宿主里只加载一次，不会重名。
- 现在根条目在 `if (config.role === "panel") return;` 这里直接返回。改成先注册路由再返回，仍然不启动引擎。
- 玩家的 `apply()` 不再注册路由。

**`GET /api/ffpr/achievements?game=ffN` 和 `GET /api/ffpr/tactics?game=ffN`:**
- 不带 `game` 时当作 ff5,和旧网页兼容。
- 认不出的作品，回 `{ok: false, error}`。
- 这一作的玩家没加载(表里没有它),回 `{ok: false, error: "FFN 玩家没有加载"}`。策略页照现在的做法回 `downView`,把这句话放进 `status`。

**缓存和命令:**
- `MonsterCache`、`BestiaryAreaCache` 已经按作品分了 key(10-28),所以六作共用一份。动手前先确认一下确实如此。
- `/ach` 命令仍然只由 FF5 的玩家注册，因为命令名在全局必须唯一。`index.ts` 里那段注释要相应改写。

## 3. 活动日志(新建 `src/engine/activity.ts`)

每作一份，记四种(`kind`):

| kind | 什么时候记 | text 的例子 |
| --- | --- | --- |
| `tool` | 玩家的一次工具调用结束时 | `walk_to {"x":13,"y":11} → 到了 (13,11)(4.2 秒)` |
| `error` | 工具出错时 | `fight 出错:连不上桥插件` |
| `event` | KeyEvents 产出新的关键事件时(和给模型的「重要事件」同一来源) | `队伍 莱昂哈特 离队`、`剧情 希尔妲:敏武，还有救吗?` |
| `link` | 桥插件连上或断开时 | `连上桥插件`、`桥插件断开:…` |

**一条日志:**
- 形状是 `{ at: ISO 时间, game, kind, text }`。
- `text` 只有一行，最多 200 个字;超长就截断，末尾加「…」。
- 工具结果只取第一行。
- 文字要先过一遍 `redact.ts`,不让令牌之类的东西进日志。

**存放:**
- 内存里每作留最近 500 条。
- 同时追加写进 `.deps/ds/activity-<game>.jsonl`:
  - 异步写，按顺序写;
  - 写失败只记一次 warn,不能影响玩游戏。
- 启动时异步读回文件的最后 500 条，这样网页重启后历史还在。
- 文件超过 5 MB 时，在启动时把它改名为 `.1`。只留一份旧文件。

**四种日志各从哪里来:**
- **`tool` / `error`**:来自工具边界，也就是 `src/plugin/tools.ts` 里统一捕获错误的地方。参数只记 JSON 的前 120 个字。
- **`event`**:给 `KeyEvents` 加一个监听口，每当 Builder 产出新条目、或已有条目变长时回调。
  - 只记 `WINDOWS[2]`(战术层)里的那些类型。
  - 监听口**不能**影响 `news()` 交给模型的内容。
- **`link`**:Watcher 连上(收到第一条记录)和出错断开时各记一次;状态没变就不重复记。

**怎么取到:** 日志对象挂在引擎上，供 overview 路由读。放在 `PlayerEngine` 上的哪个字段由你定。

## 4. 总控数据(新路由 `GET /api/ffpr/overview`)

**不查桥插件。** 只读每个引擎手里已有的东西:
- `KeyEvents` 缓存的最新 sample(`sample` / 新鲜度判断，见 `events.ts` 233 行附近);
- 活动日志;
- 正在跑的工具。

所以轮询它不会和玩家抢桥插件的锁。

**回复的形状:**

```
{ ok: true, at, games: GameCard[6], log: ActivityEntry[] }
```

`games` 按 ff1 … ff6 排列，六作都有，没加载的也有。

**`GameCard`:** 所有文字都由服务端算好。

| 字段 | 内容 |
| --- | --- |
| `game` | 作品 key |
| `title` | 例如「FF5 · 最终幻想V」 |
| `loaded` | 这一作的玩家预设加载了没有 |
| `link` | `"up"` 或 `"down"` |
| `linkText` | `link` 为 down 时才有:「连不上桥插件，游戏可能没开」,或者 Watcher 的错误 |
| `status` | 一句话，例如「标题画面」「在地图上」「战斗中」「对话中」「菜单」 |
| `place` | 地名，写法和策略页的 `placeName` 一样 |
| `party` | `[{name, hp, maxHp}]`,最多 5 人 |
| `busy` | 正在跑的工具名和开始时间;没有就是 null |
| `last` | 最近一条活动的 text 和时间 |
| `saveSlot` | 这一作的存档位 |

- `status` 按 sample 里的主状态(`scene.state`)翻译。翻译表放在引擎里;表里没有的状态原样显示。

**`log`:**
- 六作合并，新的在前。
- 参数 `since`(ISO 时间):只回比它新的。
- 参数 `limit`:默认 200,最多 500。
- 参数 `game`:只回这一作的。

## 5. 网页上的「FFPR 总控」全局页(`src/client/index.ts`)

**入口:**
- 在左侧栏加一个入口，用 `sidebar.panellist` 槽，和「定时任务」「插件」一样。
- 在 `main` 槽里注册一个全局页，用 `ctx.layout.selectPanel` 那一套。
- 接口照 `dsh-client-ui-layout`、`dsh-client-ui-sidebar` 的 README。拿不准的地方，去看 `dsh-client-ui-schedule/lib/client.js` 里 `PANEL_ID = "schedules"` 那一段是怎么注册的。
- 图标用一段内联 SVG,画一个手柄。
- 用到的接口类型补进 `globals.d.ts`,只声明用到的那几个。

**页面从上到下三块:**

1. **标题行**:左边「六作总控」;右边「更新于 HH:MM:SS」和一个「暂停刷新」开关。
2. **六张卡片**:用 CSS grid 排,`repeat(auto-fill, minmax(260px, 1fr))`。每张卡片:
   - 作品名，加一个状态点:
     - 绿：连上了，在玩;
     - 灰：游戏没开;
     - 橙：战斗中;
     - 红：最近一条活动是报错。
   - `status` 和 `place`。
   - 队伍每人一行：名字、`HP 当前/最大`、一条细的血条。
   - 有 `busy` 时显示「正在 walk_to(12 秒)」;没有就显示 `last`,加上多久以前(「3 分钟前」)。
   - 玩家没加载的作品，卡片变淡，写「这一作的玩家没有加载」。
   - 点一下卡片，下面的日志只看这一作;再点一下取消。
3. **日志**:
   - 每行是「时间 · 作品 · 种类 · 文字」。
   - 上面有两排筛选:
     - 作品：全部、FF1 … FF6;
     - 种类(可以多选):AI 操作(tool)、事件、连接、报错。
   - 最多显示 300 行，新的在上面。

**刷新和外观:**
- 每 3 秒拉一次 overview,带上 `since`,只拉新日志。页面不可见时(`document.visibilityState`)不拉。
- 颜色用 dsh 的主题变量(看现有面板用的是哪些),深色和浅色主题都要看得清。
- 筛选条件记在 localStorage 里，读写都包 try/catch。

## 6. 右侧栏的成就页和策略页可以选作品

- 两个页的顶上各加一排小按钮(FF1 … FF6),选哪一作，请求就带上对应的 `?game=`。
- 选中的作品记在 localStorage 里，默认 FF5。

## 测试

- **registry**:登记、覆盖;撤销时只删自己登记的那个。
- **路由**:
  - `?game=ff3` 用 FF3 的引擎;
  - 不带 game 时用 ff5;
  - 没加载的作品回错误;
  - 认不出的作品回错误。
- **activity**:
  - 截断、redact、500 条上限;
  - 写文件、读回(用临时目录);
  - `since`、`game`、`limit` 三种过滤;
  - 超过 5 MB 时改名。
- **KeyEvents 监听口**:挂了监听和没挂监听，`news()` 的结果一样。
- **Watcher**:连上、断开各记一次，状态不变时不重复记。
- **overview**:
  - 六张卡片的顺序;
  - 没加载的作品;
  - link down 的作品;
  - 有 busy 的作品;
  - status 的翻译。
- **工具边界**:成功、出错各记一条日志。
- FF5 现有的测试全部通过。

## 回报

不超过 40 行，写这三样:

- 改了哪些文件;
- `npm run check` 和 `npm run build` 结尾的输出;
- 拿不准的地方，尤其是 dsh 前端接口。

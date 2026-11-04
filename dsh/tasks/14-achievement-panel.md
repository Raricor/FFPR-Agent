# 任务 14:成就进度做成右侧栏的常驻面板

先读 `dsh/CLAUDE.md`(这次新加了「前端」一节)和 `dsh/tasks/13-achievements.md`。这次改三处：桥插件(C#)、TS 服务端、TS 前端。Python 版不动。

## 起因

用户想把 `/ach` 的内容常驻在 dsh 网页的右侧栏，不用每次输命令。

## 已查清的 dsh 接口(都在 `/root/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下)

- **服务端路由**:`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`。
  - 类型在 `dsh-client-connection/lib/types/rpc.d.ts`(`ConnectionFetchRoute`、`HostConnectionFetch`)。
  - `path` 是 `/api` 下的绝对路径。登录 cookie 的校验由 dsh 做，没登录的请求到不了 `fetch`。
  - 用法可以看 `dsh-api-session-controller/lib/index.js` 里的 `ctx.connection.fetch.register`。
- **前端插件的声明**:`dsh-client-modules/README.md`。
  - `package.json` 里写 `dsh.client`(`platform: "web"`、`inject`),并导出 `./client`。
  - 浏览器包的格式就是 `window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports; } })`。
  - 现成的例子:`dsh-experimental-session-inspector/package.json` 和它的 `lib/client.js` 末尾(`registerInspectorTab`、`apply`、`inject`)。
- **右侧栏**:`dsh-client-ui-sidebar-right/README.md` 的 Extension seats 和 `ctx.sidebarRight` 两节，类型在 `lib/types/client/`。
  - 注册标签类型:`ctx.sidebarRightTabs.register({ id, kind, title, guide })`。
  - 注册内容组件:`ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: id }, View))`,照 inspector 写。
  - `ctx.sidebarRight.mounted`:屏幕上的会话，可以 `getSnapshot()`、`subscribe()`。
  - `ctx.sidebarRight.openTabs`:各会话已打开的标签(`sessionId`、`kind`)。
  - `ctx.sidebarRight.openTab(kind)`:打开标签并展开右侧栏。会话的布局还没建好时会抛异常。

## 1. 桥插件：去掉没用的 `magicTypes`

- `GameState.Achievements.cs` 删掉 `magicTypes` 和 `MagicTypes()`。
  - 10-27 真机发现 `OwnedMagicList` 不是已学魔法的列表，这项没用。
  - 它每次都要遍历一千多行技能主数据，面板每 30 秒查一次，不划算。
- 版本号改成 0.7.7。编译要 0 错误，不要装进游戏。
- TS 那边的 `magicTypes` 解析和类型一起删掉。

## 2. 引擎：把表格内容做成结构化的(`src/engine/achievements.ts`)

- 新函数 `achievementView(data): AchievementView`,把现在 `formatAchievements` 拼出来的东西变成数据:
  - `title`、`summary`(两行：游戏时间和存档次数;本档达成、Steam 已解锁);
  - `rows`:每个成就的 `name`、`description`、`save`(就是现在「本档」那格的文字)、`done`、`steam`;
  - `notes`;
  - `treasure`:`header`、`warning`(错过宝箱那句，没有就不给)、`places`(每个地点的 `name`、`chests`、`hidden`、`lost` 文字);读不到时只给一句 `message`。
- `formatAchievements` 改成由 `achievementView` 生成 Markdown,输出和现在**一字不差**。现有测试不改，全部要过。
- 前端不做任何计算，所以文字(「21 / 112」「✓」「限时:…」)都在这里算好。

## 3. 服务端：路由 `GET /api/ffpr/achievements`(`src/plugin/panel.ts`,新文件)

- 和 `/ach` 共用一个读取函数：放在 `commands.ts` 里，叫 `readAchievementView(engine, signal, pilotFor)`,返回 `{ ok: true, view } | { ok: false, error }`。
  - `/ach` 改成用它，行为不变(已有测试要过)。
- 路由返回 JSON:`{ ok: true, view, at }` 或 `{ ok: false, error, at }`。`at` 是 ISO 时间。
  - 连不上桥插件时 `error` 是「连不上桥插件，游戏可能没开」,HTTP 状态照样 200(前端照常显示)。
  - `Cache-Control: no-store`。
  - 请求的 `signal` 一路传到桥插件查询。
- **`connection` 是可选注入**:只有网页才有它，没有时不注册路由，也不报错。cordis 可选注入的写法去 `cordis` 包的 README 或类型里查清楚，回报里写出处。
- 只在玩家这一侧装，挂在插件的 `ctx` 上(`ctx.effect`)。

## 4. 前端：右侧栏面板(`src/client/index.ts`、`src/client/globals.d.ts`,新文件)

### 写法

- 遵守 CLAUDE.md 的「前端」一节：一个文件，没有 `import`。
  - 用 `require("react")` 取 React,用 `createElement` 写，不用 JSX。
  - `globals.d.ts` 只声明用到的东西:`require`、`exports`、React 的 `createElement`、`useState`、`useEffect`、`useRef`,以及 `ctx` 上用到的几个服务的形状。
- 导出：照 inspector,`exports.inject = [...]`、`exports.apply = apply`。
  - `inject` 是 `slots`、`sidebarRightTabs`、`sidebarRight`。
  - `package.json` 的 `dsh.client.inject` 写 `@deepseek-ai/dsh-client-ui-sidebar-right`。

### 标签类型

- `id: "@local/ffpr-dsh"`(包名),`kind: "ffpr-achievements"`,`title: () => "FF5 成就"`。
- `guide` 一项:`{ id: "open", order: 70, title: () => "FF5 成就", description: () => "当前存档的成就和宝箱进度" }`。

### 面板内容

- 每 30 秒取一次 `api/ffpr/achievements`(相对路径：网页可能挂在子路径下),页面隐藏时(`document.visibilityState`)不取。
- 有「刷新」按钮;面板卸载时 abort 正在进行的请求。
- 版面要适合窄栏(三四百像素宽):
  - 上面：标题、`summary` 两行、「更新于 HH:MM:SS」;出错时显示 `error`,下面保留上一次的内容。
  - **成就**:三列 `成就 | 本档 | Steam`,描述放在名字的 `title` 提示里。
    - 有一个「只看未完成」的勾选框，状态存 `localStorage`(包 try/catch)。
  - `notes`。
  - **宝箱(按地点)**:`header`、`warning`,四列 `地点 | 宝箱 | 隐藏 | 不可回收`。
- 样式用行内 style:
  - 字号 12–13px,表格 100% 宽;
  - 文字颜色继承;边框用半透明灰，深浅主题都能看;
  - 已达成的行稍微淡一点;「已错过」用醒目一点的颜色。

### 常驻：每个会话自动打开一次

- 订阅 `sidebarRight.mounted`。屏幕上换到一个会话 S 时，如果同时满足下面两条，就 `openTab("ffpr-achievements")`:
  - `localStorage` 里没有 `ffpr-dsh.achievements.opened.<S>`;
  - `openTabs` 里也没有 S 的这种标签。
- 成功后写上这个键。这样用户关掉以后不会被反复打开。
- `openTab` 抛异常(布局还没建好)时，隔 200ms 重试，最多 3 次;都失败就算了，不报错。
- 订阅挂在 `ctx.effect` 里，卸载时退订。

### 构建

- `tsconfig.client.json`:
  - 只包含 `src/client`;`lib` 加 `dom`,`types: []`;
  - 输出到 `build/client/`(加进 `.gitignore`,如果有的话;没有就在回报里提一句)。
- `tsconfig.json` 把 `src/client` 排除出去。
- `scripts/bundle-client.mjs`:读编译结果，套上外壳写成 `lib/client.js`,`id` 取自 `package.json` 的 `name`。
  - 外壳照 inspector:`var module = { exports: {} }; var exports = module.exports; … return module.exports;`。
- `package.json`:
  - `build` 依次跑服务端 tsc、前端 tsc、打包脚本;`typecheck` 两份 tsconfig 都查;
  - `exports` 加 `"./client": "./lib/client.js"`;
  - `dsh` 加 `client`。
- `eslint.config.js`:`src/client` 用浏览器全局，并且照样禁止 `import`。

## 测试

- **`achievementView`**:结构正确;`formatAchievements` 的现有测试全过。
- **路由**:用替身的 `ctx.connection.fetch`(记下注册的路由)和 fake-pilot,测三种情况：成功返回 view;连不上返回 `ok: false`;没有 `connection` 时不注册。
- **打包脚本**:用一小段 JS 跑一遍，检查输出里有 `window.__ModuleLoader__.load`、正确的 `id` 和 `return module.exports`。
  - 把包装逻辑写成能导出的函数，脚本和测试共用。
- 前端组件不写单元测试，真机由 Claude 看。

## 回报

不超过 40 行，写清楚:
- 改了哪些文件;
- 桥插件编译、`npm run build`、`npm run check` 的结尾;
- 可选注入的写法和出处;
- 拿不准的地方。

这次**可以**跑 `npm run build`(要验证打包);不要重启网页，不要装插件。

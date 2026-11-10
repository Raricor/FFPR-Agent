# 任务 118:网页侧栏加「路线书」块——当前段、每一站状态、收集和验收数字

工作目录 `dsh/`。可以改 `src/client/index.ts`、`src/client/globals.d.ts`(只在要用新的前端服务时)、`src/plugin/panel.ts`(以及它用的服务端路由所在文件)、`test/`。**只读** `src/engine/stage/book-progress-types.ts`、`src/engine/stage/route-book.ts` 的类型(不改;任务 117、119 同时在改 `src/engine/` 别的文件)。不碰 `src/engine/game.ts`、`src/engine/route/`,不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。前端规矩见 `dsh/CLAUDE.md`「前端」一节(一个文件、不写 import/export、文字由服务端算好)。

## 起因(11-11)

用户要“完整路径显示出来”,并且要能看见“我怎么知道”。路线书(任务 115)的产物在 `../.deps/ds/routebook-<game>.json`;执行器(任务 117)每走完一站写 `../.deps/ds/routebook-progress-<game>.json`(格式：`BookProgress`,见 `book-progress-types.ts`)。

## 做法

1. 服务端：读这两个文件(不存在就显示「还没有路线书」/「还没开始执行」),算出要显示的中文文字和行，交给前端;读文件用异步、出错写中文说明，不让面板整个挂掉。
2. 侧栏新增「路线书」块(在现有面板里找合适的位置，照现有块的样式):
   - 标题行：当前段(攻略节名 + 中文地区名)、开始时间、进行中/已完成;
   - 验收数字一行：工具 N(go a、route b)、交回 h、宝箱 o/t、图鉴还缺 m、青魔法还缺 k、用时 x 分;
   - 站点表：序号、图、坐标、做什么、状态(待做/进行中/完成/交回/跳过,当前站高亮),只显示当前段;
   - 折叠的「全书总表」:路线书 `totals` 那张表;
   - 刷新：跟现有块一样的节奏(看 `panel.ts` 现在怎么刷新)。
3. 两个文件路径从 Config 取(任务 117 会加进度文件的 Config 项;本任务先按 `../.deps/ds/` 下的默认名读，并在回报里写清，等 117 合并后我来接 Config)。

## 测试

- 服务端：两个文件都在 / 只有路线书 / 都没有 / 文件坏了，各出什么文字;当前站高亮的判断;
- `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑),`npm run build` 能产出 `lib/client.js`。

## 回报

不超过 15 行：改了哪些文件、块放在哪、数据怎么流(哪个路由、刷新节奏)、`npm run check` 结尾。

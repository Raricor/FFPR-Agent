# 任务 124:运行时生成路线书卡死整个 dsh——加缓存、建索引、限范围、让出事件循环

工作目录 `dsh/`。可以改 `src/engine/stage/route-book.ts`、`route-book-load.ts`、`book-plan.ts`、`src/engine/knowledge/`(只为给 `areaKeys`/攻略地名匹配加缓存，不改结果)、`src/plugin/config.ts`(只加本任务的 Config 项)、`test/`。不碰 `src/engine/skills/`、`src/engine/route/`(任务 125 同时在改),不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11 03:00 真机)

模型调 `plan_stage {to: 194}` 后，阶段官 3 次都在 16 秒内答完，但工具一直不返回;dsh 网页进程 CPU 100%、HTTP 5 秒不响应，空算了 8 分钟以上，整个 dsh 被堵死，只能 `kill -9`。Claude 用调试器抓到的调用栈:

```
guide/kb.js areasFor ← knowledge/merge.js areaKeys ← stage/route-book.js matchesAnyKey ← laterMention
← returnCheck ← missedBestiary ← buildRevisit ← insertRevisit ← buildRouteBook ← route-book-load.js loadRouteBook
```

命令行 `scripts/routebook.mts` 只算 3 节，运行时 `loadRouteBook` 算整本攻略(77 节);“回头补图鉴/学青魔法”对每只怪、每个后面的节、每一步反复调 `areaKeys`(没有缓存),组合爆炸。单元测试数据只有几节，没测出来。

## 做法

1. **缓存**:`areaKeys`、攻略地名匹配(`areasFor`)按输入缓存(同一个知识模块实例内);结果不变。
2. **索引代替反复扫描**:`laterMention` / `returnCheck` 需要的“某张图/某个地区在第几节以后还会出现、能不能回去”,在 `buildRouteBook` 开头一次性建好索引(地区/地图 → 出现的节序列表),之后查表。
3. **运行时只算需要的范围**:`loadRouteBook` 只构建“当前节到往后 N 节”(Config,默认 4),回头补/回头学的判断仍然看整本(用第 2 条的索引，便宜)。
4. **不堵事件循环**:构建过程中每处理完一节 `await` 让出一次(如 `setImmediate`);整体超过时间预算(Config,默认 5 秒)就停下，用已经构建好的部分，并在活动日志写一行警告;`plan_stage`/`route {}` 照常继续(没有路线书时退回原来的阶段官路线)。
5. **性能测试**:真实数据(文件不在就跳过)整本 77 节构建在 3 秒内完成(写明本机测得多少);合成数据(比如 80 节 × 每节 30 步 × 20 只怪)构建在 1 秒内;第 1–3 条的结果和改之前一致(对比现有 3 节路线书的 JSON)。
6. `npm run check` 全过(沙箱里跑不了就拷到 `/tmp` 跑)。

## 回报

不超过 15 行：卡在哪(确认调用栈)、加了哪些缓存/索引、真实数据整本构建用时(改前/改后)、新 Config 项、`npm run check` 结尾。

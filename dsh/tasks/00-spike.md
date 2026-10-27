# 任务 00:小样(方案 §10.3 第 0 步)

先读 `CLAUDE.md`,所有规矩照它。这个任务只写代码和测试;装进 dsh、连真的笔记本由 Claude 做。

## 目的

用最少的代码验证 dsh 这一侧能不能做到方案里假设的事:

1. 原生工具：带自己的时限，模型能调用;
2. 每一步更新的提示词段(笔记);
3. 步前把关：桥插件连不上时不调模型;
4. 唤醒：连上以后自动接着走。

做不到的就如实报告，不要绕过去。

## 要写的东西

### 引擎(`src/engine/`,不 import dsh)

1. **`env.ts`**:
   - `parseEnvFile(text)`,照搬 `../common/src/ffpr_common/secrets.py` 的 `parse_env_file`,行为一模一样(空行、`#` 注释、没有 `=` 的行、成对引号);
   - `readEnvFile(path)`:异步读文件，返回解析结果;文件不存在返回空表。
2. **`lock.ts`**:一个小的异步锁，一次只放一个调用进去，后来的排队。桥插件和以后的引擎都用它。
3. **`bridge.ts`**:`BridgeLink`,照 `../agent/src/ffpr_agent/bridge.py` 移植其中的 `health` 和 `query`(`command`、`stream` 这次不做)。
   - `health(signal)`:`GET /v1/health`,带 `Authorization: Bearer <token>`,连接时限 2 秒;不是 200 就抛 `LinkError`。
   - `query(op, fields, signal)`:`/v1/query` 上的 WebSocket,开着复用;
     - 新连上先收一条 hello;
     - 发 `{"id", "op", ...fields}`;
     - 只认 `type == "reply"` 且 `re == id` 的回复，其他跳过;
     - 时限 5 秒;
     - 失败(断线、超时)重连一次再试，还不行抛 `LinkError`。
     - 消息文字照 Python 版:「连不上 …」「/v1/query pos 失败:…」。
   - 请求用 `lock.ts` 串行。
   - 用 Node 24 自带的 `WebSocket`,它支持 `new WebSocket(url, { headers })`(已验证)。如果 `@types/node` 的类型不认这个参数，写一个带注释的小包装，不要用 `any`。
   - `BridgeLink.load({ secretsFile, laptopEnv, url? })`:
     - token 来自 secrets 的 `BRIDGE_TOKEN`,没有就返回 `undefined`(Python 版返回 None);
     - 地址优先 `url` 参数，其次 laptop.env 的 `BRIDGE_URL`,再次 `http://<LAPTOP_HOST>:47800`。
   - token 不进任何错误消息和日志。
4. **`notes.ts`**:`loadNotes(path)`,照 `../agent/src/ffpr_agent/ds/game.py` 的 `load_notes`:
   - JSON 字符串数组，只留最后 40 条(`MAX_NOTES`);
   - 文件不存在返回空数组。

### 胶水(`src/plugin/` 和 `src/index.ts`)

5. **`Config`**(schemastery,`@deepseek-ai/schemastery`),字段和默认值:

   | 字段 | 默认值 |
   | --- | --- |
   | `secretsFile` | `~/.config/ffpr-agent/secrets.env`(展开 `~`) |
   | `laptopEnv` | `/root/data/mediaflow/FFPR-Agent/agent/laptop.env` |
   | `bridgeUrl` | 不设(给假桥插件和以后换地址用) |
   | `notesFile` | `/root/data/mediaflow/FFPR-Agent/.deps/ds/notes-ff5.json` |
   | `checkEveryMs` | 60000(连不上时多久查一次) |

6. **工具 `where_am_i`**(`@deepseek-ai/dsh-tools` 的 `defineTool`):
   - 描述用中文:「看自己在哪张地图、哪个格子、现在是什么状态」;
   - 没有参数，`timeoutMs: 15000`;
   - 调 `query("pos")`。回复里的 `pos` 有 `map`、`state`、`cell`([x, y] 或 null)、`dir`、`moving`、`dialog`、`battle`、`saves`。
   - 渲染成一行中文，比如「地图 238,格子 (12, 7),状态 Field,朝下」;战斗中、对话中要写出来。渲染函数单独导出，有测试。
   - 出错时抛 `Error`,消息中文;确认 dsh 会把它变成给模型的错误结果，而不是让会话崩掉(看 `dsh-tools` 的 README 和类型)。
7. **笔记提示词段**:每一步都用笔记文件的最新内容，格式照 Python 版 `loop.py`:「你记下的:\n1. …\n2. …」;没有笔记就不出这一段。
   - 先查 `ctx.systemPrompt.section()`(`dsh-system-prompt` 的 README 和类型)支不支持每步重新取值。
   - 支持就用它;不支持就改用有文档的动态机制(比如 pre-step 里加一条消息，参考 `dsh-time-context` 的 `lib/index.js`),并在回报里说明为什么。
8. **步前把关**(`agent/pre-step`):
   - 每步前查一次桥插件 `health`,5 秒内的结果可以复用;
   - 连不上就返回 `{ kind: "reject" }`,并用 dsh 的日志记一条中文原因;连得上就 `return next()`。
   - 被拒以后，按 `checkEveryMs` 定时再查;连上了就 `agent.followup()` 唤醒(先查清它的参数和语义:`dsh-agent` 的类型和 README)。
   - 定时器挂在 effect 上，智能体销毁、插件卸载时都要清掉。
   - **把判断逻辑写成和 dsh 无关的小类**(注入健康检查函数和时钟),单独测试;dsh 的接线只是薄薄一层。
9. **`src/index.ts`**:导出 `name`、`inject`、`Config`、`apply`。`apply` 里接上 6–8。

### 测试(`test/`)

- `fake-bridge.ts`:在 127.0.0.1 随机端口起一个假桥插件(`node:http` 加 devDependency 里的 `ws`):
  - `/v1/health` 要求正确的 Bearer,否则 401;
  - `/v1/query` 先发 hello,再按请求回复;
  - 能设定回复内容，能模拟先回一条别的 `re`,能主动断开连接;
  - 能停止和重新启动(给把关和唤醒的测试用)。
- 要覆盖:
  - `parseEnvFile` 的各种行;
  - `health` 成功、401、连不上;
  - `query` 正常、跳过别的回复、断线后重连一次成功、两个并发请求排队;
  - `loadNotes` 截到 40 条;
  - `where_am_i` 的渲染;
  - 把关类：连不上 → 拒绝，定时查到连上 → 唤醒一次，销毁后不再查。
- 单元测试不读真的 `secrets.env`,不连 192.168.8.230。

## 不做

- 不装进 dsh profile,不改 `~/.dsh`,不起 dsh 网页;
- 不连真的笔记本;
- 不改 `../agent/`、`../bridge/`、`../common/`;
- 不加新依赖;
- 不碰 git。

## 回报(不超过 30 行)

1. 改了哪些文件;
2. `npm run check` 的结尾输出;
3. 四个问题的答案，带出处(包名和文件):
   - `section()` 能不能每步更新，你用了哪种办法;
   - `agent.followup()` 的参数和语义;
   - pre-step 拒绝以后，这一轮会怎样(结束、挂起，还是别的);
   - 工具抛错以后模型看到什么;
4. 拿不准的地方。

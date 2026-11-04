# 任务 01:小样的审查意见

接着任务 00 做。规矩照 `CLAUDE.md`。

## 必须改

### 1. 步前把关：不拒绝，等着

**为什么。** 你查到的:pre-step 拒绝以后，这一轮已经领取的消息会被丢掉，不重放。那么游戏没开时用户发的指令就丢了。Python 版的 `wait_until_ready` 是等，不丢目标。

**改成:**

- 在 `agent/pre-step` 里**等到桥插件连上**,再 `return next()`:
  - 每 `checkEveryMs` 查一次;
  - 等待能被 `signal` 中断(用户停掉这一轮),中断后立刻结束，不再查;
  - 查不上时用 logger 记一条中文原因：第一次 `warn`,之后 `info`;
  - 不设等待上限。
- 5 秒内的健康结果可以复用，这条保留。
- **删掉**:`reject`、`followup`、`WAKE_TEXT`、`waitingAgent`、`agent/disposed` 监听、定时器状态机。
- `HealthGate` 换成一个小函数或小类，比如 `waitUntilHealthy(check, { everyMs, sleep, now, log }, signal)`;`sleep` 和 `now` 可以注入，方便测试。
- 先查 `dsh-agent-loop`(README 和 `lib/index.js`)有没有给 pre-step 设时限，回报里写出处。

**测试:**

- 连不上时一直等;
- 连上以后放行;
- 中断时立刻结束，不再查;
- 5 秒内复用结果。

### 2. 笔记：放进提示词的动态部分，不要每步追加消息

**为什么。** 每步往历史里追加一整份笔记，历史会一直变长(21 条笔记约 1000 字，每步一份)。

**改成:**

- 用 `ctx.systemPrompt.context({ name: "ffpr:notes", order, text: () => cached, required: true })`。
  这是 `dsh-system-prompt` 的 `PromptContext`,类型注释写的是「Dynamic model context materialized as a durable user-role snapshot」。`required: true` 让它在 `includeRuntimeContext: false` 下也保留。
- 先确认两点，回报里写出处:
  - (a)人设是 `complete: true` 时,context 还在不在;
  - (b)内容没变时，会不会重复写进历史。
- 任何一点不成立，就改用提示词变量：人设里写 `{{ffpr_notes}}`,插件调用 `ctx.systemPrompt.variable("ffpr_notes", () => cached)`。人设的文字在 `cordis.patch.yml`,可以改。
- provider 是同步的。笔记缓存在内存里，在 pre-step 里异步读文件刷新，然后再 `next()`。
  查清 pre-step 和 context 取值谁先谁后(`dsh-agent-loop`),确保这一步用的是刚读到的笔记。
- 删掉 `notes-prompt.ts` 里的快照消息和 `declare module`;`apply` 里不用先读一次。

### 3. `health` 不进查询锁

- Python 版的 `health` 不加锁。以后 `story` 这类命令会占着锁好几分钟，把关时查健康不能排在它后面。
- 只有 `/v1/query`(以后还有 `/v1/command`)需要串行。
- 加一个测试：一个查询卡住时,`health` 照样返回。

## 应该改

4. **重复的小函数集中放。** `describeError` 有五份,`isMissingFile` 有两份。集中到 `src/engine/errors.ts`。
5. **`env.ts` 太重。** 这两个文件都是 ASCII 配置。
   - 按 `/\r\n|\r|\n/` 切行，用 `trim()`;保留 BOM 处理和引号规则;删掉 Python 空白字符表和 `splitlines` 的模拟。
   - 对照测试保留：注释、空行、没有等号、引号、CRLF、BOM。
   - `parseEnvFile` 加一句文档注释：规则和 Python 版一致。
6. **不要只为躲 lint 的包装函数。** `isAborted()`、`isDisposed()`、`isWaiting()` 只是为了躲 `no-unnecessary-condition`,不要这样写。await 之后状态确实可能变时：
   - 用 `signal.throwIfAborted()`;
   - 或者就地写 `// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- <为什么>`。
7. **`where-am-i.ts` 不要转导出** position 的东西;测试直接从 engine 导入。

## 不用改

- bridge:重连、跳过旧回复、错误消息、token 不外泄，都好。
- position 的解析和渲染、fake-bridge、测试命名，都好。

## 回报

格式同任务 00,外加第 1、2 条要求查的出处。不超过 30 行。

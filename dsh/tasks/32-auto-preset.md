# 任务 32:新会话自动换成笔记本上开着的那一作

范围:
- 只改 `src/` 和 `test/`;
- 不改 `package.json`、`package-lock.json`、`cordis.patch.yml`、`scripts/`、`tasks/`、`lib/`、`../agent/`、`../deploy/`;
- 不碰 git;不运行 `npm run build`;
- **不运行 `scripts/web.sh`、`scripts/ask.mjs`,也不运行任何会连笔记本的东西。** 笔记本开着、在局域网上。测试一律用假 ssh、假的检测结果、假的 `agentPresets`。

## 起因

- 用户 11-02 定的：一次只开一作；新建会话时，按笔记本上开着的作品，自动用那一作的玩家预设。
- 任务 31 已经做了两件事:
  - 共享的检测结果(`src/plugin/detect.ts`);
  - 每轮第一步发现作品不对时，给模型一条说明，让它请用户换会话。
- 本任务把“请用户换会话”变成自动换。

## dsh 的接口(先读，再动手)

装好的 `@deepseek-ai/dsh-agent-preset-registry`(`node_modules/@deepseek-ai/` 下):
- `lib/types/index.d.ts` 的 `AgentPresetRegistry.select(agent, agentPreset)`:**会话第一轮开始之前**换预设;已经是这个预设就什么都不做;
- `README.zh.md`(会话日志保存 preset ID 和空白会话的切换记录;Host 拒绝切换时客户端会提示)。

`@deepseek-ai/dsh-agent` 的 `lib/types/runtime-types.d.ts`:
- `agent/created` 是 serial 事件，载荷里有 `source`(新建、恢复、清空、压缩);
- `lib/types/index.d.ts` 写着：新建 Agent 时，要等所有 serial 的 `agent/created` 监听结束，才放行排队的工作(用户的第一条消息)。

只用这些有文档的接口。哪一条行不通，就停下来回报，不要绕到没文档的内部接口上去。

## 要做的

1. 玩家预设(`role: player`)的插件，在 `agent/created` 里:
   - 只处理**新建**的会话。恢复、清空、压缩来的不管;子智能体、战术官也不管。
   - 读检测结果。可以等一次 SSH,但最多等 `autoPresetWaitMs`:放进 `Config`,默认 3000。超时就当作没查到，不换。
   - 正好开着一作，而且不是本预设的作品：调用 `select(agent, 那一作的玩家预设 id)`。
     - 预设 id 的对应关系:FF5 是 `ffpr`,其他是 `ffpr-ffN`(见 `cordis.patch.yml`)。写成一处常量或函数，并加测试，保证和 `cordis.patch.yml` 一致。
   - 其他情况都不换，交给任务 31 的说明处理：没开、开着两作、检测失败、超时、已经是本作。
   - 换了，或者换失败，都记一条 info/warn 日志：从哪一作换到哪一作，或者失败的原因。
   - 不抛到 dsh:这个监听出错，会让建会话整个回滚。
2. 要特别确认：**在 `agent/created` 的监听里直接 `await select(...)` 会不会自己等自己。**
   - `select` 要重建这个 Agent 的组合，而当前监听正属于旧组合。
   - 从文档和类型看不出来，就在回报里写清楚你的判断和依据。不要靠 `setTimeout` 之类的猜测去绕。
3. 拿 `agentPresets` 服务：加进插件的 `inject`(写清出自 `@deepseek-ai/dsh-agent-preset-registry`)。
   - 拿不到时，这项功能不生效，记一条 warn,插件照常加载。

## 测试

假 `agentPresets`(记录 `select` 的调用)、假检测结果，不连真机。至少覆盖:
- 新建会话、开着 FF3、预设是 FF5 → `select(agent, "ffpr-ff3")` 被调用一次;
- 已经是本作、没开、开着两作、检测失败、检测超时 → 都不调用;
- 恢复的会话不调用;
- `select` 抛错：只记日志，监听正常返回;
- 预设 id 对照：六作和 `cordis.patch.yml` 里的 id 一致(测试里读这个文件)。

`npm run check` 全过，测试数不能比任务 31 做完时少。

## 回报

不超过 20 行:
- 改了哪些文件;
- 第 2 条的判断和依据;
- `npm run check` 的结尾输出;
- 拿不准的地方。

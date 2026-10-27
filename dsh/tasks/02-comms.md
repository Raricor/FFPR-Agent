# 任务 02:笔记本连接层

先读 `CLAUDE.md` 和 `tasks/port-rules.md`。和任务 03、04 同时进行。

## 你负责(只写这些文件和它们的测试)

| TS 文件 | 从 Python 移植 |
| --- | --- |
| `src/engine/games.ts` | `common/src/ffpr_common/games.py`(全部) |
| `src/engine/secrets.ts` | `common/src/ffpr_common/secrets.py`。`parse_env_file` 已经在 `env.ts`,复用;`Secrets`(环境变量优先、缺了报 `MissingSecret`)、`store`、权限过宽时警告 |
| `src/engine/redact.ts` | `common/src/ffpr_common/redact.py`。`Redactor` 照搬;logging 的 Filter 改成一个 `redactingLogger(logger, redactor)` 包装 |
| `src/engine/laptop.ts` | `agent/src/ffpr_agent/laptop.py`(全部，包括 deploy、install_plugin、fetch_probe_logs、secure_root_script、dotnet) |
| `src/engine/bridge.ts` | 在现有文件上补 `command()`(`/v1/command`,和 query 用同一把锁，单独的 socket)和 `stream()`(`/v1/stream`,`AsyncIterable<Json>`,调用方 break 或 signal 中断时关掉) |
| `src/engine/link-pilot.ts` | `agent/src/ffpr_agent/pilot.py`:<br>- `createPilot(laptop, link, signal)` 实现 `src/engine/pilot.ts` 的 `Pilot` 接口：`LINK_OPS` 走局域网，`LinkError` 后休息 30 秒走 SSH,`through_link` 的结果形状、`send_ssh`、`query`、计时记录(异步追加到 `DEPS/pilot/timing.jsonl`,失败不影响游戏操作);<br>- 另外导出 `startAgent`、`agentRunning`、`ensureAgent`、`fetchShot` |
| `src/engine/state-script.ts` | `agent/src/ffpr_agent/view.py` 里的 `state_script` 和 `parse_state`(SSH 读状态那条路;view 的其余部分归任务 03) |
| `test/fake-bridge.ts` | 扩展现有的假桥插件：加 `/v1/command` 和 `/v1/stream` |

## 要点

- **SSH 和 scp 都用 `child_process.spawn`(异步)**,参数照 `Laptop.ssh()`、`scp()`、`_options()`,包括 ControlMaster、IdentitiesOnly。`runPs` 照 `run_ps`:
  - 脚本 base64 编码后 `-EncodedCommand`;
  - 前面加 `PS_PRELUDE`;
  - 失败时用 `decode_clixml` 把错误解出来;
  - `check` 和 `capture` 的语义照搬。
- **ssh 的可执行文件可替换**(`Laptop` 里多一个 `sshCommand`,默认 `"ssh"`),测试里指向 `test/` 下一个假的 ssh 脚本：记下参数和 stdin,按预设输出。**单元测试不连 192.168.8.230。**
- `Laptop.load` 读 `agent/laptop.env`(用 `env.ts`),默认值和报错照搬。
- `run_in_session`、`launch` 照搬(计划任务 `FFPR-Agent-Session`)。
- 计时记录和 `fetchShot` 的路径用 `paths.ts` 的 `DEPS`。
- **`createPilot` 绑定一个 `signal`**:所有调用、`sleep`、子进程都随它中断(中断时杀掉 ssh 子进程)。`now()` 用 `performance.now()`。
- `FFPR_LINK=off` 环境变量的开关照搬。

## 对照测试

- `decode_clixml`、`encode_ps`、`ps_quote`、`session_request`、`secure_root_script` 的输出，`Laptop` 的 ssh/scp 参数，`through_link` 对各种回复的映射，`parse_state` 对真实输出的解析，`state_script` 生成的脚本：都导出对照数据。
- 移植 `agent/tests/test_laptop.py`(6 个)和 `common/tests/test_common.py`(9 个)。

## 回报

照 `tasks/port-rules.md` 的格式。

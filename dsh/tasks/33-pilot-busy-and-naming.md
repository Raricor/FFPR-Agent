# 任务 33:试玩助手忙着时不再重复启动；取消能停下笔记本上的长命令;剧情里的起名框

开始前先读 `dsh/CLAUDE.md`。

范围:
- 只改这些:`dsh/src/engine/`(主要是 `link-pilot.ts`、`game.ts`)、`dsh/test/`、`deploy/laptop/pilot-agent.ps1`;
- 不改 `dsh/src/plugin/`:另一个任务刚改完那里;
- 不改 `dsh/package.json`、`dsh/tasks/`、`dsh/lib/`、`agent/`、`bridge/`;
- 不碰 git;不运行 `npm run build`。
- **不运行 `dsh/scripts/web.sh`、`dsh/scripts/ask.mjs`、`uv run ffpr-*`,不运行任何会连笔记本的东西。** 笔记本开着，AI 正在上面玩 FF5,误连就是真连上了，还会打断它。测试用 `dsh/test/fake-ssh.mjs` 和假桥插件。
- `pilot-agent.ps1` 必须保持 UTF-8 带 BOM,只能用 Windows PowerShell 5.1 的语法。

## 起因(11-02 真机)

试玩助手(`deploy/laptop/pilot-agent.ps1`)在笔记本上按顺序处理命令文件 `<id>.cmd.json`。翻剧情、走路这些长命令在笔记本本地跑，可能跑好几分钟。

1. **取消一轮，笔记本上的长命令不会停。**
   - 用户取消了一轮，当时 `advance_story` 正在跑。FF5 的翻剧情是试玩助手的 `story` 命令，超时 600 秒。
   - 开发机这边的 SSH 被掐掉了，可试玩助手还在跑那条命令。后面的命令全在它后面排队。
2. **试玩助手忙着，就被当成没在运行，又启动了一个。**
   - 下一轮开始时，`ensureAgent` → `agentRunning` 发 `status`,10 秒没回，就得到「等待试玩助手超时」。`agentRunning` 把它和「试玩助手没有运行」一样，当成不在运行，接着 `startAgent`:删掉 `agent.json`,再启动第二个试玩助手。
   - 两个试玩助手抢同一个目录里的命令。新的那个也等不到回复，60 秒后报「等待试玩助手超时」，这一轮直接出错。连着两轮都是这样。
3. **剧情事件里弹出的起名框，翻剧情认不出来。**
   - FF5 新游戏，巴兹的起名框是在剧情事件**里面**弹出来的，画面状态一直是 `Event`,不会变成 `ChangeName`。
   - `Invoke-Story` 只在 `ChangeName` 时停下，于是空等到 600 秒超时。10-29 也出过一次 `timeout(624.7 秒)`。
   - 这时桥插件单独查 `textinput`,回的是 `{"open": true, "fields": [{"name": "InputField", "text": "巴兹", "focused": true}]}`。照 `screens.ts` 的 `nameFocusedField` 先按 `TextEnter`、再按 `Enter`,名字就确认了。sample 里的 `textinput` 字段是空的，必须单独查。

## 要做的

### A. 忙着 ≠ 没在运行

- `agentRunning`/`ensureAgent` 要分清三种情况:
  - 没有 `agent.json`:没在运行;
  - 有 `agent.json`,但里面 `pid` 的进程已经不在了：没在运行(残留的文件);
  - 有 `agent.json`,进程也在：在运行，**可能正忙**。
- 只有前两种才启动新的试玩助手。第三种不启动。
  - 要是 `status` 没回，说明它在忙。按 B 的办法让它停下，再等它回复(给一个上限，放常量，注释写清为什么取这个值);
  - 还是不回，就报一句中文错误，说试玩助手正忙、没有回应。不要启动第二个。
- 判断进程在不在，用一次 `runPs`:读 `agent.json` 的 `pid`,再 `Get-Process -Id`。SSH 账号看得到桌面会话里的进程，11-02 实测过。
- `pilot-agent.ps1` 自己也防重复：启动时拿一个按作品区分的命名 Mutex(`Local\FfprPilot-<作品>`)。拿不到就说明这一作已经有一个在跑，直接退出，不要覆盖 `agent.json`。

### B. 取消能停下长命令

- 开发机这边：一条 pilot 命令的 signal 被取消时，在命令目录里写一个 `<id>.abort` 标记文件。
  - 写这个文件要用一次单独的 `runPs`,并且用自己的短超时：原来那条 SSH 已经被掐掉了。
  - 写失败只记日志，不要盖住原来的取消。
- `pilot-agent.ps1`:
  - 会跑很久的循环，每一圈都看一下有没有自己 id 的 `.abort`。至少包括 `Invoke-Story` 和 `Wait-Free`;其他循环超过几秒的，也一起加上，回报里列出来;
  - 看到标记就停，返回 `@{ ok = $false; error = 'aborted' }`,然后删掉标记;
  - 主循环处理完一条命令后，把这条命令残留的 `.abort` 也删掉。
- 结果：取消之后，试玩助手最多几百毫秒就空出来，下一轮不用等。

### C. 剧情事件里的起名框

- `Invoke-Story`:不在对话、不在已列出的状态时，如果画面停在 `Event` 超过约 1.5 秒，就向桥插件查一次 `textinput`。
  - 有带焦点的输入框就停下，返回 `stop = 'textinput'`;
  - 查询要节流，不要每 200 毫秒查一次。
  - 怎么向桥插件发查询，照 `pilot-agent.ps1` 里现有的写法。
- `game.ts` 的 `pilotAdvanceStory`:把 `textinput` 和 `state:ChangeName` 同样对待。下一圈调 `nameFocusedField` 起名，再接着翻。

## 测试

- A:假 ssh 分别答「没有 agent.json」「有 agent.json 但进程不在」「进程在、`status` 超时」。只有前两种会调用启动;第三种会写 `.abort`,不会启动第二个。
- B:pilot 命令的 signal 取消后，假 ssh 收到一条写 `.abort` 的命令;写失败时，原来的取消照样抛出。
- C:`pilotAdvanceStory` 收到 `stop: 'textinput'` 后会调用起名，再翻一次。
- `pilot-agent.ps1` 没法在开发机上跑，用 `python3 tools/check_ps_scripts.py deploy/laptop` 检查 BOM 和语法(在仓库根运行)。沙箱不让读的话，照它的做法自己检查，回报里说明怎么跑的。

`cd dsh && npm run check` 全过，测试数不能比现在少(现在是 490 个)。

## 回报

不超过 25 行:
- 改了哪些文件;
- A 的三种判断各自怎么做;
- B 里加了 abort 检查的循环有哪些;
- C 的节流间隔;
- `npm run check` 和 PowerShell 检查的结尾输出;
- 拿不准的地方。

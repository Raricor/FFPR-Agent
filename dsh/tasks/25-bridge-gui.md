# 任务 25:笔记本上的桥插件小程序(桥插件 0.12.0)

开始前先读四份文件:`dsh/CLAUDE.md`、`bridge/README.md`、`deploy/laptop/README.md`、`dsh/tasks/23-one-bridge-package.md`。

范围:
- 改 `bridge/` 和 `deploy/laptop/`;
- `dsh/` 里只改 `src/engine/link-pilot.ts` 和它的测试;
- 不改 `agent/`,不碰 git;
- 不连笔记本，不跑 ssh 或 scp,装和测由 Claude 来做。

## 起因

六作现在同时在笔记本后台运行，用户坐在笔记本前时，想看到六个桥插件各自的情况。用户选定的形式：笔记本托盘里的一个 Windows 小程序。要有四样:

- **状态**:版本、端口、谁连着、运行多久、挂钩成功和失败各几个;
- **桥插件日志**:每作 BepInEx 日志的最近几百行，报错标红;
- **操作按钮**:后台启动或关闭某一作、截一张图、一键装新版桥插件;
- **按键记录**:最近按了哪些键，是谁按的(AI 玩家还是试玩助手)。

## 1. 桥插件 0.12.0:新查询 `bridge`

`bridge/src/Version.cs` 改成 `0.12.0`。

**查询**:在本机的 `/query` 和局域网的 `/v1/query` 上都能用，规矩和其他查询一样。请求是 `{"id": 1, "op": "bridge"}`,回复:

```json
{"ok": true, "bridge": {
  "game": "ff5", "version": "0.12.0", "process": "FINAL FANTASY V",
  "startedAt": "ISO 时间", "port": 47800,
  "lan": {"enabled": true, "listen": "192.168.8.230"},
  "clients": [{"remote": "192.168.8.229:51234", "channel": "stream", "since": "ISO 时间"}],
  "hooks": {"ok": ["MessageLookup", "..."], "failed": [{"name": "…", "error": "…"}]},
  "keys": [{"at": "ISO 时间", "from": "FF5 玩家", "remote": "192.168.8.229:51240",
            "via": "game", "keys": ["Enter"], "ok": true, "error": null}],
  "warnings": [{"at": "ISO 时间", "level": "Warning", "text": "…"}]
}}
```

各字段的来源:
- **`game`**:每作编译时就知道(和 `DefaultPort` 一样用 `#if`),加一个常量 `GameKey`。`process` 取 `Paths.ProcessName`。
- **`clients`**:`Outbox` 现在只有 `List<WebSocket>`。另外记下每个客户端的远端地址、通道(stream / query / command)、连上的时间，断开时删掉。
- **`hooks`**:由 `Plugin.Start` 挂钩时记下。
- **`keys`**:每个按键命令记一条，最多留最近 100 条。
  - 命令里可以带一个可选字段 `from`:去掉首尾空白，最多 32 个字;没有就是 null。
  - `remote` 是发命令那个客户端的地址。
  - `ok`、`error` 是这次按键的结果。
- **`warnings`**:桥插件自己记下的 Warning、Error、Fatal 日志，最多留最近 50 条。
  - 用 `BepInEx.Logging.Logger.Listeners` 加一个监听器，只收来源是本插件的日志。
  - 不要去改各处 `Logger.LogWarning` 的调用。

**线程**:这些数据都是普通的托管对象，不碰 IL2CPP 对象。几个线程都会读写，用锁保护。

## 2. 按键带上「谁按的」

- `dsh/src/engine/link-pilot.ts`:发 `keys` 命令时加上 `from: "<作品标签> 玩家"`,例如 `"FF3 玩家"`。作品取 `createPilot` 的 `game` 选项。加一个测试，确认命令里带了 `from`。
- `deploy/laptop/pilot-agent.ps1`:`Invoke-Keys` 发的命令加上 `from = '试玩助手'`。
- 旧版桥插件会忽略不认识的字段，所以新旧可以混用。

## 3. 小程序(新建 `deploy/laptop/bridge-gui.ps1`、`deploy/laptop/BridgeGui.cs`)

### 怎么跑起来

- **`bridge-gui.ps1` 是启动器**:
  1. 用 `FfprCommon.psm1` 的 `Find-GameDir` 找到装了的每一作，读每作 `BepInEx/config/ffpr.agent.bridge.cfg` 里的 `Port`。没写就用默认端口:FF5 47800,FFN 4780N。
  2. 用 `Add-Type -Path BridgeGui.cs -ReferencedAssemblies …` 编译界面代码，引用 `System.Windows.Forms`、`System.Drawing`、`System.Web.Extensions`。
  3. 调用 `[FfprBridgeGui.App]::Run(...)`,把作品、目录、端口和 `deploy/laptop` 的路径传进去。
- **为什么不打包成 exe**:公司电脑上没签名的 exe 可能被拦。`Add-Type` 这条路已经在这台笔记本上验证过(`pilot-agent.ps1` 就是这样用的),而且不用另装 .NET 运行时。
- **只能写 C# 5**:Windows PowerShell 5.1 的 `Add-Type` 用的是 .NET Framework 自带的编译器，只认 C# 5。下面这些都不能用:
  - `$"..."` 字符串插值、`?.`、`nameof`;
  - 用 `=>` 写的成员;
  - 自动属性初始化、`out var`、元组、模式匹配、`using static`。
- **JSON** 用 `System.Web.Script.Serialization.JavaScriptSerializer`,**WebSocket** 用 `System.Net.WebSockets.ClientWebSocket`。
- **只开一个**:用一个命名 Mutex。已经开着时，再启动只是把那个窗口调出来。
- **桌面快捷方式**:新建 `deploy/laptop/new-gui-shortcut.ps1`,在桌面放一个「FFPR 桥插件」快捷方式，目标是:

  ```
  powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\ffpr\deploy\laptop\bridge-gui.ps1
  ```

  用户在自己的桌面账号里运行一次。

### 刷新

- 后台线程每 2 秒刷新一次:
  - 进程在不在(按每作 exe 的进程名);
  - 向 `ws://127.0.0.1:<端口>/query` 发 `bridge` 查询，每次最多等 1.5 秒。
- 界面线程从不等待：结果用 `BeginInvoke` 送回界面。
- 本机 `/query` 不需要令牌。小程序**只发查询，从不发按键**。

### 界面(文字都用中文)

**窗口**:标题「FFPR 桥插件」,约 960×640。

**上方：六作列表**(ListView,Details 模式，整行选中),一作一行，列如下:

| 列 | 内容 |
| --- | --- |
| 作品 | `FF5 · 最终幻想V` |
| 游戏 | 运行中 / 没开 |
| 桥插件 | `0.12.0`;连不上;回复里没有 `bridge` 时显示「旧版」 |
| 端口 | 端口号 |
| 连接 | `2 个(192.168.8.229)` |
| 挂钩 | `12/12`;有失败的写成 `11/12 有失败` |
| 运行 | `1 时 23 分` |
| 最近按键 | `12 秒前 · FF5 玩家` |

- 没开的作品整行灰色。
- 有挂钩失败、或者最近 5 分钟里有 warnings 的作品整行红色。

**中间：按钮**,作用于选中的那一作:

- **「后台启动」**:
  - 在后台运行新脚本 `deploy/laptop/launch-game.ps1 -Game ffN`。它和 `run-in-session.ps1` 处理 Steam URL 的那段做的事一样：启动、等窗口、最小化、再盯 20 秒。
  - 这段逻辑抽到 `FfprCommon.psm1` 里，写成函数 `Start-GameInBackground`,两个脚本共用，不复制。
  - 跑完在状态栏显示结果。
- **「关闭游戏」**:
  - 先确认:「关闭 FFN?没存档的进度会丢失。」
  - 确认后先 `CloseMainWindow`,10 秒后还在就 `Kill`。
- **「截图」**:向桥插件发 `shot` 查询，回复里有图片路径。在「截图」页显示这张图。
- **「安装桥插件 0.12.0」**:
  - 按钮上的版本号读自 `C:\ffpr\staging\bridge\FfprBridge\version.txt`;没有这个包就把按钮置灰。
  - 点了以后对全部作品运行 `install-bridge.ps1`(它会跳过正在运行的作品),把输出显示在一个对话框里。

**下方：选中那一作的四个页签:**

- **「日志」**:
  - 显示 `BepInEx/LogOutput.log` 的最后 300 行。
  - 读文件时用 `FileShare.ReadWrite`(游戏正开着它);文件大小或修改时间没变就不重读。
  - Warning 行用橙色,Error、Fatal 行用红色。
  - 用户往上翻的时候，不要自动滚到底。
- **「按键」**:列出 `keys`:时间、谁(`from`;没有就显示 `remote`)、方式(`via`)、按键、结果。
- **「截图」**:PictureBox,缩放适应窗口。
  - 读图片用 `FileShare.ReadWrite` 的 FileStream,读进内存后马上关掉文件;
  - 换图时释放旧的那张。
- **「状态」**:挂钩成功、失败的清单，客户端清单,warnings 清单。

**托盘:**
- NotifyIcon,菜单有「显示」「退出」;双击图标打开窗口。
- 点窗口的关闭按钮只是缩到托盘。第一次缩到托盘时弹一个气泡提示「还在托盘里运行」。
- 「退出」才真的退出。

### 编译检查(开发机)

小程序在开发机上跑不起来，但要能在开发机上检查它能不能编译:

- 新建 `deploy/laptop/gui-check/BridgeGui.check.csproj`:
  - net48,`LangVersion` 设为 5,`TreatWarningsAsErrors`;
  - 用 `<Compile Include="../BridgeGui.cs" />` 引进源文件;
  - 引用 `System.Windows.Forms`、`System.Drawing`、`System.Web.Extensions`;
  - 加上 NuGet 包 `Microsoft.NETFramework.ReferenceAssemblies`,在 Linux 上编 net48 要用它。
- 再写一个 `deploy/laptop/gui-check/check.sh` 来跑编译，并把 NuGet 的目录都设到仓库的 `.deps/nuget/` 下:
  - `NUGET_PACKAGES=.deps/nuget/packages`;
  - `NUGET_HTTP_CACHE_PATH=.deps/nuget/http`;
  - `DOTNET_CLI_HOME=.deps/nuget/home`。

  原因是沙箱只许写 `-C` 目录。下载需要联网;如果在沙箱里下载失败，照实回报，由 Claude 来跑。
- `bin/`、`obj/` 不要进 git:在 `gui-check/` 里加一个 `.gitignore`。

## 4. 文档

- **`bridge/README.md`**:加 `bridge` 查询那一行、`from` 字段，以及 0.12.0 的一段说明。
- **`deploy/laptop/README.md`**:脚本表里加 `bridge-gui.ps1`、`launch-game.ps1`、`new-gui-shortcut.ps1`;另外写一小节「桥插件小程序」,说明怎么建快捷方式、界面上有什么。

## 验收(你自己跑)

- `bash bridge/build.sh` 成功。
- `bash deploy/laptop/gui-check/check.sh` 编译通过，0 警告。如果下载失败，照实说明。
- 所有改过和新建的 `.ps1` / `.psm1` 用 pwsh 解析都没有错误，文件开头都有 BOM。
- `cd dsh && npm run check` 全过。

## 回报

不超过 30 行，写这四样:

- 改了哪些文件;
- `build.sh`、`check.sh` 和 `npm run check` 的结尾输出;
- C# 5 的限制在哪里绕了路;
- 拿不准的地方。

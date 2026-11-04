# 任务 23:桥插件一个包装进六作，游戏留在后台

开始前先读三份文件：仓库根的 `CLAUDE.md`、`bridge/README.md`、`deploy/laptop/README.md`。

范围:
- 只改 `bridge/` 和 `deploy/laptop/`。
- 不改 `dsh/`(另一个任务正同时在改)和 `agent/`。
- 不碰 git。
- 不连笔记本，不跑 ssh 或 scp(装和测由 Claude 来做)。

## 起因

用户要把六作的桥插件统一起来。现在的问题:

- 每作要单独编译一份(`-p:Game=ffN`,代码里用 `#if FFN` 区分);
- 装的时候要对上作品，出过错：10-28 FF2、FF4 里装的还是旧版。

这次要做到四件事:

- 一个包，六作装完全一样的文件，插件启动时自己认出是哪一作;
- 一条命令编译;
- 一条命令装到笔记本上所有装了的作品;
- 只有一个版本号。

另外，游戏启动时窗口不要弹到前台，用户在笔记本上还要做别的事。

## 做法：小加载器加每作一份

为什么不编成一个 DLL:

- 桥插件编译时，引用的是每作自己的互操作程序集(`.deps/ffN/interop/Assembly-CSharp.dll`)。
- 这里面有每作独有的类(`Serial.FF5.*` 等),各作缺的成员也不一样。
- 编成一个 DLL,就引用不到其他作品的类。以后给 FF4 读战斗魔法这类作品专属的功能就没法写了。

所以这样做:

- 源码仍然只有一份，`#if` 照旧，编出六份;
- 再加一个加载器，它不引用任何游戏的程序集。

六作的 `BepInEx/plugins/FfprBridge/` 内容完全一样:

```
FfprBridge/
  FfprBridge.dll              加载器(BepInEx 插件，GUID 仍是 ffpr.agent.bridge)
  games/FfprBridge.ff1.dll    每作一份
  …
  games/FfprBridge.ff6.dll
```

## 1. 加载器(新建 `bridge/loader/`)

**`FfprBridge.Loader.csproj`**:
- AssemblyName 是 `FfprBridge`,目标 net6.0。
- 只引用 BepInEx 核心:`BepInEx.Core`、`BepInEx.Unity.IL2CPP`,从 `.deps/ff5/core` 取。六作装的是同一版 BepInEx(be.697)。
- 不引用任何 interop 程序集。
- `TreatWarningsAsErrors`、`Nullable` 等属性和现在的 `FfprBridge.csproj` 一样。

**`Loader.cs`**:

```csharp
[BepInPlugin(Guid, "FFPR Agent Bridge", BridgeVersion.Value)]
public sealed class Loader : BasePlugin
```

`Load()` 依次做:

1. 用 `Paths.ProcessName` 认出作品，对照下表，忽略大小写，整个名字相等才算。
   - 认不出就记 `LogWarning("不认识的游戏进程 {名字},桥插件不启动")`,然后返回。
2. 找 `<加载器所在目录>/games/FfprBridge.<作品>.dll`。没有这个文件就 `LogError`,然后返回。
3. 用 `Assembly.LoadFrom` 加载它，取类型 `FfprBridge.Plugin`,调用它的静态方法 `Start(BasePlugin host)`,把加载器自己传进去。
4. 出错时(反射找不到类型或方法，`Start` 抛异常)记 `LogError`,写清是哪一步出的错，不让异常冒出去。
   - 遇到 `TargetInvocationException` 时，记里面那个异常的消息和堆栈。

加载成功时记 `LogInfo("认出 {作品}({进程名}),加载 {文件名}")`。

| 进程名 | 作品 |
| --- | --- |
| `FINAL FANTASY` | ff1 |
| `FINAL FANTASY II` | ff2 |
| `FINAL FANTASY III` | ff3 |
| `FINAL FANTASY IV` | ff4 |
| `FINAL FANTASY V` | ff5 |
| `FINAL FANTASY VI` | ff6 |

Claude 会在真机上核对这些进程名。

## 2. 每作一份(`bridge/FfprBridge.csproj`、`bridge/src/Plugin.cs`)

**csproj**:
- AssemblyName 改成 `FfprBridge.$(Game)`,产物是 `bin/$(Game)/Release/FfprBridge.$(Game).dll`。
- 其余不变:`#if`、`DefaultPort` 都照旧。
- 要排除 `loader/**`。SDK 默认会把子目录里的 `.cs` 全编进来。

**`Plugin` 不再是 BepInEx 插件**:
- 去掉 `[BepInPlugin]` 和 `: BasePlugin`,改成 `public static class Plugin`。
- `Load()` 改成 `public static void Start(BasePlugin host)`。里面原来用的 `Log`、`Config`,换成 `host.Log`、`host.Config`。
- 配置文件仍然是 `BepInEx/config/ffpr.agent.bridge.cfg`,因为文件名跟着 GUID 走。所以六作现有的端口设置不用动。
- 其他文件里用到 `Plugin.Logger`、`Plugin.Outbox`、`Plugin.Guid` 等的地方，不需要改。

**版本号**:
- 放进两边共用的新文件 `bridge/src/Version.cs`:

  ```csharp
  internal static class BridgeVersion { public const string Value = "0.11.0"; }
  ```

- 加载器的 csproj 用 `<Compile Include="..\src\Version.cs" />` 把它引进来。
- `Plugin.Version` 保留，值等于 `BridgeVersion.Value`。

启动日志「FFPR Agent Bridge {Version} 已启动」一字不改，`deploy/laptop/wait-title.ps1` 要靠它判断启动成功。

## 3. 一条命令编译(新建 `bridge/build.sh`)

依次做:

1. 编译加载器。
2. 按 ff1 到 ff6 各编一份:`dotnet build bridge -c Release -p:Game=ffN`。
   - 哪一作缺 `.deps/ffN/interop/Assembly-CSharp.dll`,就报错退出。六作现在都有。
3. 先清空 `bridge/bin/package/FfprBridge/`,再把产物拼成上面那样的包。
4. 最后打印一行：版本号和包里的文件。

另外:
- `dotnet` 不在 PATH 里时，用 `~/.dotnet/dotnet`,照 `dsh/src/engine/laptop.ts` 里的 `dotnet()` 那样做(包括设置 `DOTNET_ROOT`)。
- 脚本开头写 `set -euo pipefail`。

## 4. 一条命令装到笔记本

### 开发机端:`bridge/deploy.sh [ffN ...]`(新建)

不写作品就装全部。依次做:

1. 跑 `build.sh`。
2. 从 `agent/laptop.env` 读 `LAPTOP_HOST`、`LAPTOP_USER`、`LAPTOP_KEY`。
   - `LAPTOP_KEY` 没写时用 `~/.ssh/ffpr_laptop_ed25519`。
   - ssh 和 scp 的选项照搬 `dsh/src/engine/laptop.ts` 里的那组(`BatchMode` 等)。
3. 用 scp 传三样东西到笔记本:
   - 包，传到 `C:/ffpr/staging/bridge/`;
   - `deploy/laptop/install-bridge.ps1` 和 `FfprCommon.psm1`,传到 `C:/ffpr/deploy/laptop/`。
4. 通过 ssh 运行下面这条命令，把输出原样打印出来，并带上它的退出码:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\install-bridge.ps1 -Games …
   ```

### 笔记本端:`deploy/laptop/install-bridge.ps1 [-Games ff1,ff2,…]`(新建，UTF-8 带 BOM)

对每个作品依次处理:

- 用 `FfprCommon.psm1` 的 `Find-GameDir` 找游戏目录。没装就跳过，并输出一行说明。
- 游戏正在运行(`Test-GameRunning`)就跳过，因为文件被占用。
- 安装：先清空 `BepInEx\plugins\FfprBridge\`,再把整个包复制进去。旧的单个 `FfprBridge.dll` 会被加载器替换掉。

每作输出一行结果，例如:

- `ff5 已装 0.11.0`
- `ff1 没装这一作`
- `ff6 正在运行，没装`

只要有一作没装上(正在运行或复制失败),退出码就不是 0。没装这一作不算失败。

两个脚本都不要真的运行，开发机连笔记本由 Claude 来做。用 `bash -n` 检查 `.sh` 的语法;用 pwsh 解析 `.ps1`,确认没有语法错误:

```bash
pwsh -NoProfile -Command '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("<文件>",[ref]$null,[ref]$e); $e'
```

## 5. 游戏窗口不弹到前台(`deploy/laptop/run-in-session.ps1`、`FfprCommon.psm1`)

`run-in-session.ps1` 用 `steam://rungameid/<AppId>` 启动游戏时:

- 从 URL 里取 AppId,用 `FfprCommon.psm1` 里现成的 `$script:AppIds` 反查是哪一作，再用 `Find-GameDir` 和 `Get-GameExe` 得到进程名。认不出是哪一作时，照现在的做法：启动完就返回。
- 启动前，先记下当前的前台窗口。
- 等这一作的游戏窗口出现，最多等 120 秒。游戏窗口指属于该进程、窗口类是 `UnityWndClass` 的那个窗口。
- 窗口一出现，就调用 `ShowWindow(h, 7)`(SW_SHOWMINNOACTIVE:最小化，并且不抢焦点),然后用 `SetForegroundWindow` 把焦点还给启动前的那个窗口。
- 状态文件里加一个字段 `minimized`,值为 true 或 false。
  - 120 秒内没等到窗口时，仍然写 `started`,同时写 `minimized: false` 和 `note: "120 秒内没等到游戏窗口"`。
- `request.json` 新增一个可选字段 `foreground`。它为 true 时不做上面这些，因为 FF6 开新游戏目前还需要前台。

找窗口、藏窗口的代码放进 `FfprCommon.psm1`,写成两个函数:`Find-GameWindow`、`Hide-GameWindow`。
- user32 的声明可以参考 `pilot-agent.ps1` 里现成的那段。
- `Add-Type` 的类名不要和 pilot-agent 里的 `FfprInput` 重名。

## 6. 文档

**`bridge/README.md`**:
- 编译和安装改成 `build.sh` / `deploy.sh`;
- 写明包的样子，以及加载器怎么认出作品;
- 加一段 0.11.0 的说明;
- 删掉 `ffpr-laptop install-plugin` 那几行。Python 版已经冻结，它装的是旧的单文件。

**`deploy/laptop/README.md`**:
- 脚本表里加上 `install-bridge.ps1`;
- `run-in-session.ps1` 那行加一句：游戏启动后会最小化，不抢焦点。

## 验收(你自己跑)

- `bash bridge/build.sh` 成功，包里有 7 个 DLL(加载器 1 个，每作 1 个)。
- `grep -rn "BepInPlugin" bridge/src` 没有结果，只有 `bridge/loader/` 里有。
- `bash -n bridge/deploy.sh bridge/build.sh` 通过。
- 两个 `.ps1` 用 pwsh 解析没有错误，文件开头有 BOM。

## 回报

不超过 30 行，写这三样:

- 改了哪些文件;
- `build.sh` 结尾的输出;
- 拿不准的地方。

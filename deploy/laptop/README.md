# 笔记本端脚本

这些脚本运行在专用的 Windows 笔记本上。开通 SSH 以后,开发机会用 `ffpr-laptop deploy` 把本目录同步到笔记本的 `C:\ffpr\deploy\laptop`,之后基本不需要你手动操作。`bridge/deploy.sh` 也会单独把 `install-bridge.ps1` 和 `FfprCommon.psm1` 传过去。

| 脚本 | 作用 | 谁来运行 |
| --- | --- | --- |
| `setup-ssh.ps1` | 开启 OpenSSH 服务器,加入开发机公钥(现在这台笔记本是你手动配好的,没有用它) | 你,管理员权限 |
| `register-session-task.ps1` | 注册计划任务,让开发机能在你的桌面上启动游戏;任务动作用 `conhost.exe --headless`,不弹窗口 | 你,管理员权限,首次和更新脚本后 |
| `install-bepinex.ps1` | 备份游戏目录,然后安装 BepInEx | 开发机通过 SSH 运行 |
| `uninstall-bepinex.ps1` | 移除 BepInEx,恢复原版 | 需要时运行 |
| `collect-assemblies.ps1` | 把逆向需要的文件放到 `C:\ffpr\staging` | 开发机通过 SSH 运行 |
| `run-in-session.ps1` | 计划任务实际执行的脚本。启动普通子程序时不建控制台窗口；用 Steam URL 启动游戏后，等游戏窗口出现就留着，不再最小化。一次只开一作：别的作品开着时状态是 `refused`（带 `running` 和 `note`），要启动的这一作已经开着时带 `already` 和 `note` | 计划任务自动运行 |
| `pilot-agent.ps1` | 试玩助手:在你的桌面上替开发机按键、截图,只在游戏位于前台时按键;也在本地走格子、打普通战斗、翻剧情 | 开发机用 `ffpr-pilot start`(或 `restart`)启动 |
| `allow-bridge-lan.ps1` | 加防火墙规则:只允许开发机所在主机连游戏里桥插件的局域网端口(分层控制方案 §5.3)。要用 `-RemoteAddress` 给出开发机所在主机的地址(不写死在脚本里);不带 `-Game` 就给装了的每一作各加一条，端口是那一作的(FF5 47800,FFN 4780N);`-Game ffN` 只加一作 | 你,管理员权限，端口变了再运行一次 |
| `install-bridge.ps1` | 把一个桥插件包装进每一作已安装的游戏；没装的作品和正在运行的游戏跳过，每作打印一行 | `bridge/deploy.sh` 通过 SSH 运行 |
| `wait-title.ps1` | 等游戏带着指定版本的桥插件到达标题画面,再列出 BepInEx 日志里桥插件的几行 | `ffpr-pilot restart` 自动运行 |
| `FfprCommon.psm1` | 公共函数(找 Steam 库、找游戏目录、查正在运行的作品、找游戏窗口等) | 被其他脚本引入 |
| `bridge-gui.ps1` | 桥插件小程序:找出六作的目录(没装的留空)和端口、编译 `BridgeGui.cs`,打开那个托盘窗口(0.12.0) | 你的桌面账号,从桌面快捷方式启动 |
| `BridgeGui.cs` | 小程序的界面代码(只能写 C# 5,`Add-Type` 现场编译);只发 `bridge`、`shot` 查询,从不发按键 | 被 `bridge-gui.ps1` 编译 |
| `launch-game.ps1` | 启动一作：先看有没有别的作品开着；Steam 没开就先等它登录（最多 90 秒），锁屏或 Steam 对话框立刻停下说明；再用 Steam URL 启动并等窗口出现（不最小化），窗口 120 秒没出现会补发一次请求，窗口太小时提醒；小程序「启动」按钮调用它 | 小程序(也可手动) |
| `new-gui-shortcut.ps1` | 在桌面放一个「FFPR 桥插件」快捷方式；用 `conhost.exe --headless` 启动，不弹窗口 | 你，在你的桌面账号里运行一次 |

所有 `.ps1`、`.psm1` 都保存为带 BOM 的 UTF-8。修改时请保持这个编码,否则 Windows PowerShell 5.1 会把中文读成乱码。

## 不弹窗口(2026-10-29)

Windows 11 的默认终端是 Windows Terminal，它不认 `powershell.exe -WindowStyle Hidden`。所以以前
计划任务每触发一次就闪一个窗口（最近一小时 13 次），`run-in-session.ps1` 用 `Start-Process`
启动的试玩助手和小程序启动器也各留一个一直开着的窗口。

现在改成：

- `run-in-session.ps1` 启动普通子程序时用 `ProcessStartInfo`（`UseShellExecute = $false`、
  `CreateNoWindow = $true`），不建控制台；`wait` 模式仍然把标准输出、错误写到 `<id>.out.log`、
  `<id>.err.log`。确实需要窗口的程序，在 `request.json` 里加 `"visible": true` 就退回原来的
  `Start-Process`。
- 计划任务的动作改成 `conhost.exe --headless "<powershell.exe>" -NoProfile ...`：PowerShell
  有控制台但没有窗口，Windows Terminal 也不会接手。系统里没有 `conhost.exe`，或版本低于
  build 17763（Windows 10 1809）时，脚本会退回原来的动作并提示。
- 桌面快捷方式的目标也改成 `conhost.exe --headless`，图标仍用 PowerShell 的。

已经注册过任务、建过快捷方式的机器不会自动更新，需要你重新运行一次：

```powershell
# 在「以管理员身份运行」的 PowerShell 里
powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\register-session-task.ps1
```

```powershell
# 在你自己的桌面账号里
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\new-gui-shortcut.ps1
```

## 桥插件小程序(0.12.0)

在笔记本托盘里看桥插件的情况,不用 SSH、不用开发机。窗口按游戏运行情况自动切换,不用重开。

**建快捷方式**(在你自己的桌面账号里运行一次):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\new-gui-shortcut.ps1
```

桌面上会出现「FFPR 桥插件」,目标是:

```
conhost.exe --headless "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\bridge-gui.ps1
```

旧系统没有 `conhost --headless` 时会退回 `powershell.exe ... -WindowStyle Hidden`(可能闪一下窗口)。

不用 exe,是因为公司电脑上没签名的 exe 可能被拦;`Add-Type` 在这台笔记本上已经验证过,也不用另装
.NET 运行时。双击快捷方式打开;已经开着时只会把那个窗口调出来(命名 Mutex)。

**界面上有什么:**

- **一作都没开**:上方是六作列表,每行是作品名、装没装、桥插件版本(读
  `BepInEx\plugins\FfprBridge\version.txt`;没装桥插件写「没装」)。选中一作点「启动」,运行
  `launch-game.ps1`;「安装桥插件 0.12.0」对装了的作品运行 `install-bridge.ps1`。下方显示
  「没有游戏在运行」。
- **开着一作**:列表收起,上方一块只显示这一作:作品名、桥插件版本(连不上 / 旧版)、端口、连接数和对端
  地址、挂钩成功/总数、运行时长、最近一次按键是谁按的。按钮是「关闭游戏」(先确认,再 `CloseMainWindow`,
  10 秒还在就 `Kill`)、「截图」(向桥插件发 `shot`,在「截图」页显示)、「安装桥插件 0.12.0」。下方四个
  页签固定跟着这一作:「日志」是 `BepInEx/LogOutput.log` 的最后 300 行(Warning 橙色,Error/Fatal 红色;
  往上翻时不自动滚到底);「按键」是 `bridge` 查询里的 `keys`(时间、谁、方式、按键、结果);「截图」缩放
  显示最近一张;「状态」是挂钩、客户端和 warnings 的清单。
- **同时开着两作以上**(启动脚本已经禁止,正常不会发生):上方一行红字
  「同时开着 FFx、FFy,一次只开一作」,每个开着的作品一行,各带一个「关闭游戏」。

一次只开一作:启动某一作前会先看另外五作,有别的作品开着就拒绝启动并说明是哪一作,不会替你关掉它
(那一作没存档的进度会丢)。「安装桥插件 0.12.0」的版本号读自
`C:\ffpr\staging\bridge\FfprBridge\version.txt`,没有这个包就置灰。

后台线程每 2 秒刷新一次(进程在不在,以及在 `ws://127.0.0.1:<端口>/query` 上问一次 `bridge`,最多等
1.5 秒),结果用 `BeginInvoke` 送回界面;游戏开了或关了,窗口自己在上面两种状态之间切换。小程序只发查询,
从不发按键。点窗口的关闭按钮只是缩到托盘,第一次会弹一个「还在托盘里运行」的气泡;托盘菜单的「退出」才
真的退出。

托盘图标的提示文字:开着一作时是「FFPR 桥插件 · FF5 · 连着」(连不上时写「连不上」),没开时是
「FFPR 桥插件 · 没有游戏在运行」。

开发机上跑不了界面,但可以检查它能不能编译(和笔记本一样只认 C# 5):

```bash
bash deploy/laptop/gui-check/check.sh
```

## 现在的连接方式(2026-10-19 配好)

| 项目 | 设置 |
| --- | --- |
| 地址 | 家里局域网 `192.168.1.20`,只在笔记本在家时连接 |
| SSH 账号 | 本地普通账号 `ffpr`,只允许专用密钥 `ffpr-agent@devbox` 登录 |
| 桌面账号 | `DOMAIN\user`:游戏、Steam 都在这个账号的桌面上运行 |
| 防火墙 | 规则 `FFPR-Agent-SSH-LAN`:只放行开发机所在主机 `192.168.1.10` 的 22 端口 |
| 工作目录 | `C:\ffpr`,只对 SYSTEM、管理员、`ffpr` 和 `user` 开放 |

不直接用域账号登录 SSH,是因为在家连不上域控时,域账号的密钥登录会在认证后被断开。

这台笔记本有两个限制,脚本已经按它们写好:

- 执行策略是 AllSigned,所以所有脚本都用 `-ExecutionPolicy Bypass` 运行,不修改策略本身。
- `ffpr` 通过 SSH 登录时用不了 WMI/CIM,所以开发机用 `schtasks.exe` 触发计划任务,不用 `Start-ScheduledTask`。

## 注册计划任务(你来做,首次和这次 10-29 更新后)

`ffpr` 是普通账号,不能替你注册任务。请在「以管理员身份运行」的 Windows PowerShell 里执行:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\register-session-task.ps1
```

它会注册 `FFPR-Agent-Session` 任务。这个任务以你的身份、普通权限,在你的桌面上运行;`ffpr` 只获得启动它的权限,不能修改或删除它。之后开发机运行 `uv run ffpr-laptop launch ff5`,游戏就会出现在你的桌面上。已经注册过也要在这次更新后重新运行一次,任务的动作才会换成不弹窗口的写法。

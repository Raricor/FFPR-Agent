# 笔记本端脚本

这些脚本运行在专用的 Windows 笔记本上。开通 SSH 以后,开发机会用 `ffpr-laptop deploy` 把本目录同步到笔记本的 `C:\ffpr\deploy\laptop`,之后基本不需要你手动操作。

| 脚本 | 作用 | 谁来运行 |
| --- | --- | --- |
| `setup-ssh.ps1` | 开启 OpenSSH 服务器,加入开发机公钥(现在这台笔记本是你手动配好的,没有用它) | 你,管理员权限 |
| `register-session-task.ps1` | 注册计划任务,让开发机能在你的桌面上启动游戏 | 你,管理员权限,只运行一次 |
| `install-bepinex.ps1` | 备份游戏目录,然后安装 BepInEx | 开发机通过 SSH 运行 |
| `uninstall-bepinex.ps1` | 移除 BepInEx,恢复原版 | 需要时运行 |
| `collect-assemblies.ps1` | 把逆向需要的文件放到 `C:\ffpr\staging` | 开发机通过 SSH 运行 |
| `run-in-session.ps1` | 计划任务实际执行的脚本 | 计划任务自动运行 |
| `pilot-agent.ps1` | 试玩助手:在你的桌面上替开发机按键、截图,只在游戏位于前台时按键;也在本地走格子、打普通战斗、翻剧情 | 开发机用 `ffpr-pilot start`(或 `restart`)启动 |
| `allow-bridge-lan.ps1` | 加一条防火墙规则:只允许开发机所在主机连游戏里桥插件的局域网端口(分层控制方案 §5.3) | 你,管理员权限,只运行一次 |
| `wait-title.ps1` | 等游戏带着指定版本的桥插件到达标题画面,再列出 BepInEx 日志里桥插件的几行 | `ffpr-pilot restart` 自动运行 |
| `FfprCommon.psm1` | 公共函数(找 Steam 库、找游戏目录等) | 被其他脚本引入 |

所有 `.ps1`、`.psm1` 都保存为带 BOM 的 UTF-8。修改时请保持这个编码,否则 Windows PowerShell 5.1 会把中文读成乱码。

## 现在的连接方式(2026-10-19 配好)

| 项目 | 设置 |
| --- | --- |
| 地址 | 家里局域网 `192.168.8.230`,只在笔记本在家时连接 |
| SSH 账号 | 本地普通账号 `ffpr`,只允许专用密钥 `ffpr-agent@devbox` 登录 |
| 桌面账号 | `MIFEITECH\yangwt`:游戏、Steam 都在这个账号的桌面上运行 |
| 防火墙 | 规则 `FFPR-Agent-SSH-LAN`:只放行开发机所在主机 `192.168.8.229` 的 22 端口 |
| 工作目录 | `C:\ffpr`,只对 SYSTEM、管理员、`ffpr` 和 `yangwt` 开放 |

不直接用域账号登录 SSH,是因为在家连不上域控时,域账号的密钥登录会在认证后被断开。

这台笔记本有两个限制,脚本已经按它们写好:

- 执行策略是 AllSigned,所以所有脚本都用 `-ExecutionPolicy Bypass` 运行,不修改策略本身。
- `ffpr` 通过 SSH 登录时用不了 WMI/CIM,所以开发机用 `schtasks.exe` 触发计划任务,不用 `Start-ScheduledTask`。

## 注册计划任务(你来做,只做一次)

`ffpr` 是普通账号,不能替你注册任务。请在「以管理员身份运行」的 Windows PowerShell 里执行:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\register-session-task.ps1
```

它会注册 `FFPR-Agent-Session` 任务。这个任务以你的身份、普通权限,在你的桌面上运行;`ffpr` 只获得启动它的权限,不能修改或删除它。之后开发机运行 `uv run ffpr-laptop launch ff5`,游戏就会出现在你的桌面上。

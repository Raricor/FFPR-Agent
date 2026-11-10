# 任务 108:启动游戏更稳——先等 Steam 登录;认出锁屏和 Steam 弹窗;启动后查窗口大小

工作目录：仓库根(`FFPR-Agent/`)。只许改 `deploy/laptop/`(PowerShell 脚本)、`agent/src/ffpr_agent/laptop.py`、`agent/tests/`。不碰 `dsh/`(另一个任务 109 在改)、`bridge/`,不碰 git,**不连笔记本**(测试用现有的假 ssh / 替身，不许连真机),**不用 docker、不绕开沙箱**。PowerShell 改完跑 `make check-scripts`(有 `pwsh` 就用;沙箱里跑不了就在回报里说明，Claude 在外面跑)。

## 起因(待办 60、17、61)

1. **Steam 没开时启动游戏会丢请求**(11-04、11-08 两次):`steam://rungameid/<AppId>` 在 Steam 冷启动时发出去，游戏没起来，启动脚本等 120 秒报“没等到游戏窗口”。11-09 Claude 的手动做法：先在用户桌面会话里单独启动 `steam.exe`,轮询 `C:\Program Files (x86)\Steam\logs\connection_log.txt`,等出现比启动时间新的 `Logged On` 行(例：`[2026-11-09 22:45:50] [Logged On, 4, 7] ...`),再请求 `steam://rungameid`,一次就起来了。注意笔记本时间可能和开发机差一个时区，比较时用日志里的时间和笔记本当地时间。
2. **重启脚本看不清笔记本的状态**:锁屏时(`LogonUI` 进程在跑)应直接说“笔记本锁屏了”;Steam 卡在对话框时(Steam 日志里有 `waiting for user response`,比如“云同步失败”)应直接说出来，不要等满 120 秒超时。
3. **游戏窗口缩成 320×240**(11-04):多半是在最小化状态下退出、记下了小窗口，启动后不会自己恢复。启动后查一下客户区尺寸(可以参考仓库外 `.deps/tmp/winrect.ps1` 的做法：在用户桌面会话里 `EnumWindows` 找 `UnityWndClass` 窗口、`GetClientRect`),太小(宽 < 800)就在结果里提醒。

## 做法

1. `launch-game.ps1`(和它用的 `FfprCommon.psm1` 函数):
   - Steam 进程不在 → 先启动 `steam.exe`,等 `connection_log.txt` 出现比启动时刻新的 `Logged On`(上限 90 秒,`$SteamLoginTimeout` 参数);
   - 等待中发现 `LogonUI` → 立刻停，报“笔记本锁屏了，等用户解锁”(不要尝试解锁);
   - 发现 Steam 日志新出现 `waiting for user response` → 立刻停，报“Steam 在等用户点对话框”;
   - 登录后再请求 `steam://rungameid`;游戏窗口没出现时，超时前补发一次请求;
   - 窗口出现后查客户区尺寸，太小就在输出里写一行提醒(不改窗口)。
2. `laptop.py` 的 `launch`:把脚本的这些新结果(锁屏、Steam 对话框、窗口太小、补发过一次)按原来的输出风格转成中文一句。
3. 不改游戏设置，不动存档，不解锁。

## 测试

- Python 测试用现有的假 ssh 模拟脚本的几种输出：正常、锁屏、Steam 对话框、窗口太小、补发后成功;
- `make check` 全过(Python:ruff、pytest、PowerShell 脚本检查);沙箱里跑不了的部分照实说明。

## 回报

不超过 20 行：改了哪些文件、等 Steam 登录的判断方法、三种情况的输出原文、`make check` 结尾(或为什么跑不了)。

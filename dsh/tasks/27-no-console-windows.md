# 任务 27:笔记本上不再弹 PowerShell 窗口

范围:
- 只改 `deploy/laptop/` 下的四个文件:`run-in-session.ps1`、`register-session-task.ps1`、`new-gui-shortcut.ps1`、`README.md`;
- 不碰 git;
- 不连笔记本，不跑 ssh 或 scp。

## 写 PowerShell 的规矩(这个目录的)

- 文件存成带 BOM 的 UTF-8,否则 Windows PowerShell 5.1 会把中文读成乱码。保持现有 BOM。
- 代码要能在 Windows PowerShell 5.1 上跑，不用 PowerShell 7 才有的语法。
- 不用 WMI/CIM。
- 注释用英文，给人看的提示用中文。规矩来自实际出过的问题时，注释里写日期和经过。

## 起因

用户反映 10-29:笔记本上开了很多 Windows PowerShell 窗口，而且经常弹框。

- 笔记本是 Windows 11(build 26300),默认终端是 Windows Terminal。它不认 `powershell.exe -WindowStyle Hidden`,窗口照样显示。
- **一直开着的窗口**:`run-in-session.ps1` 用 `Start-Process` 启动的程序(六作的试玩助手 `pilot-agent.ps1`、小程序启动器)各开一个窗口。
- **频繁弹框**:计划任务 `FFPR-Agent-Session` 的动作是 `powershell.exe -WindowStyle Hidden -File run-in-session.ps1`,开发机每触发一次就闪一个窗口(最近一小时 13 次)。
- `BridgeGui.cs` 启动子进程时已经用了 `CreateNoWindow`,不用改。

## 要改的

### 1. `run-in-session.ps1`:子进程不建控制台

- 非 URL 的启动(现在 `$proc = Start-Process @params` 那段),改用 `System.Diagnostics.ProcessStartInfo`:
  - `UseShellExecute = $false`、`CreateNoWindow = $true`;
  - 参数照旧用 `ConvertTo-CommandLine` 拼好，`WorkingDirectory` 照旧。
- **`wait` 模式**:照旧把标准输出、错误写进 `<id>.out.log`、`<id>.err.log`,状态里照旧有 `pid`、`exit_code`。
  - 用 `RedirectStandardOutput/Error`,而且必须异步读(`ReadToEndAsync` 或事件),否则缓冲区满了会卡死。
  - 进程结束后再写文件。
- request.json 新增可选字段 `visible`:为 true 时照旧用 `Start-Process`,留给以后确实要窗口的程序。
- Steam URL 那段不动(它不开控制台)。

### 2. `register-session-task.ps1`:计划任务本身不弹窗

- 动作改成用 conhost 的无窗口模式运行:

  ```
  "%SystemRoot%\System32\conhost.exe" --headless "<powershell.exe 的完整路径>" -NoProfile -ExecutionPolicy Bypass -File "<run-in-session.ps1>"
  ```

  这样 PowerShell 有控制台但没有窗口，Windows Terminal 也不会接手。注释写明原因和日期。
- 系统里没有 `conhost.exe`,或者系统版本低于 build 17763(没有 `--headless`)时，退回现在的动作，并输出一句提示。
- 其余照旧：任务名、权限、只让 `ffpr` 能运行它。
- 用户要用管理员身份重新运行一次这个脚本，在 README 里写明。

### 3. `new-gui-shortcut.ps1`:快捷方式也不弹窗

- 目标改成 `conhost.exe`,参数是 `--headless "<powershell.exe>" -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\bridge-gui.ps1`。
- 图标仍用 powershell.exe 的。
- 和第 2 条一样，没有 conhost 时退回现在的写法。

### 4. `README.md`

- 写一小节「不弹窗口」:为什么会弹(Windows 11 的 Windows Terminal),改了什么，用户要重新运行一次 `register-session-task.ps1`(管理员)和 `new-gui-shortcut.ps1`。

## 验收(你自己跑)

- 三个 `.ps1` 用 pwsh 解析都没有错误:

  ```bash
  pwsh -NoProfile -Command '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("<文件>",[ref]$null,[ref]$e); $e'
  ```

- 文件开头都有 BOM(`head -c 3 <文件> | xxd` 是 `efbbbf`)。
- 在开发机的 pwsh 里，用一个假的 request.json 测 `run-in-session.ps1` 的 `wait` 模式能不能拿到输出和退出码。
  - 子进程用 `pwsh -c "Write-Output hi; exit 3"`,路径设到临时目录;
  - 开发机是 Linux,`CreateNoWindow` 不起作用，但逻辑能测。
  - 如果脚本里写死的路径让这个测试跑不起来，就说明原因，不要硬改脚本去迁就测试。

## 回报

不超过 15 行：改了哪些文件、怎么测的、拿不准的地方。

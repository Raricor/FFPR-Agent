# 任务 30:游戏不再最小化，一次只开一作

范围:
- 只改 `deploy/laptop/` 里的这些文件:`FfprCommon.psm1`、`launch-game.ps1`、`run-in-session.ps1`、`BridgeGui.cs`、`README.md`;
- 不改 `dsh/`、`agent/`、`bridge/`,不改仓库根的 `README.md` 和 `CHANGELOG.md`(Claude 来改);
- 不碰 git。
- 不连笔记本：不运行 `ssh`、`scp`、`bridge/deploy.sh`、`uv run ffpr-*`,也不运行 `dsh/scripts/` 里的脚本。笔记本现在开着，误连就是真连上了。

## 起因

用户 11-02 定了两件事:

1. **游戏启动后不再最小化。** 0.11.0 起，用 Steam URL 启动游戏时，等窗口出现就最小化、把焦点还回去，再盯 20 秒，游戏自己弹出来就再最小化。那是为了六作同时在后台跑。现在不这样了：窗口出现后就留着，不最小化，也不再盯。
2. **一次最多开一作。** 启动某一作之前，先看六作里有没有别的开着:
   - 别的作品开着：不启动，回一句中文说明开着的是哪一作。**不要替用户关**，那一作没存档的进度会丢;
   - 要启动的这一作已经开着：不重复启动，回一句「已经开着」。

启动游戏有两条路，都走 `FfprCommon.psm1` 的 `Start-GameInBackground`:
- 笔记本上小程序的「后台启动」按钮 → `launch-game.ps1`;
- 开发机写 `request.json`,计划任务跑 `run-in-session.ps1`。

所以检查和行为都放在 `FfprCommon.psm1` 里，两条路不各写一份。

## 要改的

1. **`FfprCommon.psm1`**
   - 新函数 `Get-RunningGames`:返回正在运行的作品键(`ff1`…`ff6`)的数组，按 `ff1`→`ff6` 排序。
     - 用已有的 `Find-GameDir` 和 `Test-GameRunning`;
     - 没装的作品(`Find-GameDir` 抛错)当作没开，不报错。
   - `Start-GameInBackground` 改名为 `Start-Game`,不再有 `-Foreground` 参数，做这几步:
     1. `Get-RunningGames`;
     2. 有别的作品开着：返回 `@{ state = 'refused'; running = @(...); note = 'FF3 还开着，一次只开一作，先关掉它' }`。
        - 开着两作以上时，`note` 里把它们都列出来;
        - 作品名用大写(`FF3`)。
     3. 这一作已经开着：返回 `@{ state = 'started'; already = $true; note = 'FF5 已经开着' }`,不再调 Steam。
     4. 否则用 `steam://rungameid/<AppId>` 启动，等窗口出现(最多 120 秒，和现在一样)：
        - 等到窗口：返回 `@{ state = 'started' }`;
        - 没等到：返回 `@{ state = 'started'; note = '120 秒内没等到游戏窗口' }`。
        - **还是要等窗口出现才返回。** 10-29 出过问题：启动脚本提前返回，接着启动的下一个请求被计划任务忽略了。
   - 不再最小化：
     - 删掉 `Hide-GameWindow` 和那段 20 秒的盯窗口循环;
     - 启动前取前台窗口、启动后 `SetForegroundWindow` 还回去的那段也删掉，让游戏窗口正常出现在前面;
     - `FfprWindow` 类里不再用到的 P/Invoke 一并删掉。`Find-GameWindow` 还要用，留着。
   - 更新函数上方的英文注释：写明 11-02 用户定的这两条和原因。

2. **`run-in-session.ps1`**
   - 改调 `Start-Game`;
   - 请求里的 `foreground` 字段不再有用，读到了就忽略，不报错;
   - 顶部的中文说明改成新的行为:
     - 不再最小化;
     - 状态文件的 `state` 可能是 `refused`,带 `running` 和 `note`;
     - 去掉 `minimized`、`rehidden` 的说法。

3. **`launch-game.ps1`**
   - 改调 `Start-Game`;
   - 输出一行中文结果(小程序把它显示在状态栏):
     - `refused`:输出 `note`,**退出码 1**;
     - 已经开着：输出 `note`,退出码 0;
     - 新启动：输出「FF5 已启动」,有 `note` 就接在后面，退出码 0。
   - 顶部的 `.SYNOPSIS`、`.DESCRIPTION` 改成新的行为。

4. **`BridgeGui.cs`**
   - 按钮文字「后台启动」改成「启动」，状态栏的「正在后台启动 …」改成「正在启动 …」;
   - 其他不动。
   - 注意：这个文件在笔记本上由 Windows PowerShell 5.1 的 `Add-Type` 编译，只能用 C# 5 的语法。

5. **`deploy/laptop/README.md`**
   - 表格里 `run-in-session.ps1`、`FfprCommon.psm1`、`launch-game.ps1` 三行，改成新的行为;
   - 小程序按钮那一段(「后台启动」)也改掉;
   - 补一句：一次只开一作，别的作品开着时启动会被拒绝。

所有 `.ps1`、`.psm1` 都必须保持 **UTF-8 带 BOM**,改完确认 BOM 还在。

## 检查

- `python3 ../../tools/check_ps_scripts.py .`(在 `deploy/laptop/` 下运行，等于仓库根的 `make check-scripts`):要全过。它检查 BOM,有 `pwsh` 时还解析语法。
  - 沙箱不让读 `tools/` 的话，就照它的做法自己检查(BOM + `pwsh` 的 `Parser]::ParseFile`),回报里说明怎么跑的。
- **不要**运行 `gui-check/check.sh`(要 `dotnet build`,和别的任务的检查同时跑会把开发机卡住)。`BridgeGui.cs` 的 C# 5 编译检查由 Claude 来跑。
- `grep -rn "Start-GameInBackground\|Hide-GameWindow\|minimized\|rehidden" .`(在 `deploy/laptop/` 下):不能再有结果。`BridgeGui.cs` 里窗口本身的 `FormWindowState.Minimized` 不算。

## 回报

不超过 20 行:
- 改了哪些文件;
- `Start-Game` 返回的几种状态，各贴一行示例;
- 上面两项检查的结尾输出;
- 拿不准的地方。

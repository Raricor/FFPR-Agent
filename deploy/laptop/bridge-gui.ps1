# 桥插件小程序(0.12.0)：托盘里的一个 Windows 小程序，看六作桥插件的状态、日志和按键记录。
#
# 由桌面快捷方式「FFPR 桥插件」启动（见 new-gui-shortcut.ps1）。为什么不用 exe：公司电脑上
# 没签名的 exe 可能被拦，Add-Type 这条路在笔记本上已经验证过（pilot-agent.ps1 也这样用），
# 而且不用另装 .NET 运行时。
#
# 这个脚本只做启动准备：
#   1. 找出装了的每一作，读它的 Port（没写就用默认端口）；
#   2. 用 Add-Type 编译 BridgeGui.cs，界面代码只能写 C# 5（Windows PowerShell 5.1 的编译器）；
#   3. 把作品、目录、端口和本目录交给 [FfprBridgeGui.App]::Run。
#
# 只开一个：App 里用命名 Mutex；已经开着时，再启动只是把那个窗口调出来。
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
Import-Module (Join-Path $here 'FfprCommon.psm1') -Force

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# 10-29 review: Windows PowerShell 5.1 does not load System.Web.Extensions by default, and the
# [JavaScriptSerializer] type literal below would fail without it.
Add-Type -AssemblyName System.Web.Extensions

$games = @('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')
$titles = @{
    ff1 = 'FF1 · 最终幻想'
    ff2 = 'FF2 · 最终幻想II'
    ff3 = 'FF3 · 最终幻想III'
    ff4 = 'FF4 · 最终幻想IV'
    ff5 = 'FF5 · 最终幻想V'
    ff6 = 'FF6 · 最终幻想VI'
}
# The executable names the bridge loader recognises; used when the install has no exe to read.
$processNames = @{
    ff1 = 'FINAL FANTASY'
    ff2 = 'FINAL FANTASY II'
    ff3 = 'FINAL FANTASY III'
    ff4 = 'FINAL FANTASY IV'
    ff5 = 'FINAL FANTASY V'
    ff6 = 'FINAL FANTASY VI'
}

$gameKeys = New-Object System.Collections.Generic.List[string]
$gameTitles = New-Object System.Collections.Generic.List[string]
$gameDirs = New-Object System.Collections.Generic.List[string]
$gamePorts = New-Object System.Collections.Generic.List[int]
$gameProcesses = New-Object System.Collections.Generic.List[string]

foreach ($game in $games) {
    try { $dir = Find-GameDir $game } catch { continue }

    # FF5 keeps 47800; FFN uses 4780N. BepInEx's config file wins when it exists.
    $port = if ($game -eq 'ff5') { 47800 } else { 47800 + [int]$game.Substring(2) }
    try {
        $config = Join-Path $dir 'BepInEx\config\ffpr.agent.bridge.cfg'
        if (Test-Path $config) {
            $text = Get-Content $config -Raw -Encoding UTF8
            $match = [regex]::Match($text, '(?im)^\s*Port\s*=\s*(\d+)')
            if ($match.Success) { $port = [int]$match.Groups[1].Value }
        }
    } catch {
        # A broken or locked config must not keep the window from opening; use the default port.
    }

    $process = $processNames[$game]
    try {
        $exe = Get-GameExe $dir
        if ($exe) { $process = $exe.BaseName }
    } catch {
        # Keep the known name from the table above.
    }

    $gameKeys.Add($game)
    $gameTitles.Add($titles[$game])
    $gameDirs.Add($dir)
    $gamePorts.Add($port)
    $gameProcesses.Add($process)
}

if ($gameKeys.Count -eq 0) {
    [void][System.Windows.Forms.MessageBox]::Show('六作都还没装。', 'FFPR 桥插件')
    return
}

# Add-Type compiles BridgeGui.cs with the .NET Framework compiler (C# 5), the same way
# pilot-agent.ps1 compiles its input helper. Check first so a second run in one session is quiet.
if (-not ('FfprBridgeGui.App' -as [type])) {
    # Full paths, not bare names: the in-box compiler then needs no probing of its own.
    $references = @(
        [System.Uri].Assembly.Location
        [System.Linq.Enumerable].Assembly.Location
        [System.Windows.Forms.Form].Assembly.Location
        [System.Drawing.Bitmap].Assembly.Location
        [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
    )
    Add-Type -Path (Join-Path $here 'BridgeGui.cs') -ReferencedAssemblies $references
}

[FfprBridgeGui.App]::Run(
    $gameKeys.ToArray(),
    $gameTitles.ToArray(),
    $gameDirs.ToArray(),
    $gamePorts.ToArray(),
    $gameProcesses.ToArray(),
    $here
)

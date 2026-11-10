<#
.SYNOPSIS
    启动一作：等窗口出现，不最小化（桥插件小程序的「启动」按钮）。

.DESCRIPTION
    和计划任务用的 run-in-session.ps1 处理 Steam URL 的那一段是同一个函数
    （FfprCommon.psm1 的 Start-Game），两边不会各写一份。

    一次最多开一作：别的作品开着时不启动，也不替用户关（没存档的进度会丢），
    输出开着的是哪一作，退出码 1。要启动的这一作已经开着时不重复启动，
    输出「已经开着」，退出码 0。

    否则先确认 Steam 已经登录（Steam 没开就先启动它，等 connection_log.txt 出现新的
    Logged On，最多 $SteamLoginTimeout 秒），再用 steam://rungameid/<AppId> 交给 Steam
    启动，等窗口出现（最多 120 秒）；一直没出现会在超时前补发一次请求。窗口出现后就留在
    前面，不最小化。等待期间锁屏或 Steam 弹出对话框会立刻停下并说明，不会等满 120 秒。

    窗口出现后读客户区尺寸；宽 < 800 时在结果里提醒（不改窗口）。

    输出一行中文结果，桥插件小程序把它显示在状态栏。退出码 0 表示游戏已经在运行或
    已经把启动请求交给 Steam（窗口没等到也算，结果里会说明）；启动本身出错或被拒绝
    才返回 1。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\launch-game.ps1 -Game ff5
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')]
    [string]$Game,
    # Steam 冷启动时等它登录的上限（秒）。
    [ValidateRange(1, 600)]
    [int]$SteamLoginTimeout = 90
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force
# The tray app reads this output as UTF-8 (BridgeGui.cs).
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$label = $Game.ToUpper()
try {
    $result = Start-Game $Game -SteamLoginTimeout $SteamLoginTimeout
} catch {
    "$label 启动失败：$($_.Exception.Message)"
    exit 1
}
if ($result['state'] -eq 'refused') {
    $result['note']
    exit 1
}
if ($result['state'] -eq 'error') {
    if ($result.ContainsKey('note')) { $result['note'] } else { "$label 启动失败" }
    exit 1
}
if ($result.ContainsKey('already') -and $result['already']) {
    $result['note']
    exit 0
}
$message = "$label 已启动"
if ($result.ContainsKey('note')) {
    $message = "$message，$($result['note'])"
}
$message
exit 0

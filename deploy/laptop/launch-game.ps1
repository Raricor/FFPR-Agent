<#
.SYNOPSIS
    在后台启动一作：启动、等窗口出现、最小化，再看 20 秒（桥插件小程序的「后台启动」）。

.DESCRIPTION
    和计划任务用的 run-in-session.ps1 处理 Steam URL 的那一段是同一个函数
    （FfprCommon.psm1 的 Start-GameInBackground），两边不会各写一份。

    steam://rungameid/<AppId> 交给 Steam 启动；窗口出现后最小化且不抢焦点，
    游戏初始化时若自己又把窗口激活，就再最小化一次。

    输出一行中文结果，桥插件小程序把它显示在状态栏。退出码 0 表示已经把启动请求交给
    Steam（窗口没等到也算，结果里会说明）；启动本身出错才返回 1。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\launch-game.ps1 -Game ff5
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')]
    [string]$Game
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force
# The tray app reads this output as UTF-8 (BridgeGui.cs).
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$label = $Game.ToUpper()
try {
    $result = Start-GameInBackground $Game
} catch {
    "$label 启动失败：$($_.Exception.Message)"
    exit 1
}
if (-not $result['minimized']) {
    if ($result.ContainsKey('note')) {
        "$label 已启动，但$($result['note'])"
    } else {
        "$label 已启动（留在前台）"
    }
    exit 0
}
$extra = ''
if ($result['rehidden'] -gt 0) {
    $extra = "，游戏又激活窗口 $($result['rehidden']) 次，都最小化了"
}
"$label 已启动，窗口已最小化$extra"
exit 0

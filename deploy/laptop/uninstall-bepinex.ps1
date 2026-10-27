<#
.SYNOPSIS
    从一作 PR 里移除 BepInEx,恢复成原版。

.DESCRIPTION
    按 install-bepinex.ps1 记下的压缩包,删掉它们放进游戏目录的顶层文件和文件夹,
    再删掉 BepInEx 运行时生成的整个 BepInEx 文件夹。
    如果装过替换游戏原文件的补丁(例如 UnityPlayer 补丁),删完后请在 Steam 里对这一作
    「验证游戏文件的完整性」,把原文件恢复回来。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')][string]$Game
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem

$gameDir = Find-GameDir $Game
if (Test-GameRunning $gameDir) { throw '游戏正在运行,请先退出游戏' }
$recordPath = Join-Path (Get-FfprRoot) "work\$Game\install.json"
if (-not (Test-Path $recordPath)) { throw "没有找到安装记录:$recordPath" }
$record = Get-Content $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json

$topLevel = New-Object System.Collections.Generic.HashSet[string]
foreach ($zip in $record.packages) {
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($entry in $archive.Entries) {
            [void]$topLevel.Add(($entry.FullName -split '[\\/]')[0])
        }
    } finally {
        $archive.Dispose()
    }
}
[void]$topLevel.Add('BepInEx')

foreach ($name in $topLevel) {
    if (-not $name) { continue }
    $path = Join-Path $gameDir $name
    if (Test-Path $path) {
        Write-Host "删除 $path"
        Remove-Item -Path $path -Recurse -Force
    }
}
Remove-Item -Path $recordPath
Write-Host '已移除。如果装过替换原文件的补丁,请在 Steam 里验证这一作的游戏文件完整性。'

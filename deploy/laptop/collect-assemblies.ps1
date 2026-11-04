<#
.SYNOPSIS
    把逆向分析需要的文件集中到 C:\ffpr\staging\<作品>,供开发机用 scp 取走。

.DESCRIPTION
    收集:BepInEx 生成的互操作程序集、BepInEx 核心库(编译插件时作为引用)、
    GameAssembly.dll、global-metadata.dat、BepInEx 日志,以及一份清单。
    如果还没有互操作程序集,说明 BepInEx 装好以后还没启动过游戏。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')][string]$Game
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force

$gameDir = Find-GameDir $Game
$exe = Get-GameExe $gameDir
if (-not $exe) { throw "在 $gameDir 里找不到游戏程序" }
$dataDir = Join-Path $gameDir "$($exe.BaseName)_Data"

$stage = Join-Path (Get-FfprRoot) "staging\$Game"
if (Test-Path $stage) { Remove-Item -Path $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$items = @(
    @{ From = 'BepInEx\interop'; To = 'interop'; Required = $true },
    @{ From = 'BepInEx\core'; To = 'core'; Required = $true },
    @{ From = 'GameAssembly.dll'; To = 'GameAssembly.dll'; Required = $true },
    @{ From = "$($exe.BaseName)_Data\il2cpp_data\Metadata\global-metadata.dat"; To = 'global-metadata.dat'; Required = $true },
    @{ From = 'BepInEx\LogOutput.log'; To = 'LogOutput.log'; Required = $false }
)
$missing = @()
foreach ($item in $items) {
    $source = Join-Path $gameDir $item.From
    if (Test-Path $source) {
        Copy-Item -Path $source -Destination (Join-Path $stage $item.To) -Recurse
    } elseif ($item.Required) {
        $missing += $item.From
    }
}

$manifest = [ordered]@{
    game     = $Game
    build    = Get-GameBuildId $Game
    exe      = $exe.Name
    dataDir  = $dataDir
    missing  = $missing
    time     = (Get-Date).ToString('o')
}
Write-Utf8NoBom (Join-Path $stage 'manifest.json') ($manifest | ConvertTo-Json)

if ($missing) {
    Write-Warning "缺少:$($missing -join ', ')。如果缺的是 interop,请先启动一次游戏。"
    exit 2
}
Write-Host $stage

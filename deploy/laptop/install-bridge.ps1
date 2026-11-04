# 把桥插件包装进笔记本上已经装了的每一作(0.11.0 起,六作装的是同一份文件)。
# 包由开发机的 bridge/deploy.sh 传到 C:\ffpr\staging\bridge\FfprBridge。
#
#   install-bridge.ps1                  六作都试
#   install-bridge.ps1 -Games ff1,ff5   只装这两作
#
# 每作输出一行。游戏正在运行(文件被占用)或复制失败算没装上,退出码为 1;
# 这一作没装则跳过,不算失败。
param(
    [string[]]$Games = @('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force

$package = Join-Path (Get-FfprRoot) 'staging\bridge\FfprBridge'
if (-not (Test-Path $package)) {
    throw "找不到桥插件包:$package(先运行 bridge/deploy.sh)"
}
$loader = Join-Path $package 'FfprBridge.dll'
if (-not (Test-Path $loader)) {
    throw "桥插件包里没有 FfprBridge.dll:$package"
}
$versionFile = Join-Path $package 'version.txt'
$version = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw -Encoding UTF8).Trim() } else { '未知版本' }

$failed = $false
foreach ($name in $Games) {
    # Also accept -Games 'ff1,ff2' arriving as one string.
    foreach ($game in ($name -split ',')) {
        $game = $game.Trim().ToLower()
        if (-not $game) { continue }
        try {
            $null = Get-FfprAppId $game
        } catch {
            "$game 不是已知的作品"
            $failed = $true
            continue
        }

        try {
            $dir = Find-GameDir $game
        } catch {
            "$game 没装这一作"
            continue
        }
        if (Test-GameRunning $dir) {
            "$game 正在运行，没装"
            $failed = $true
            continue
        }

        $dll = Join-Path $package "games\FfprBridge.$game.dll"
        if (-not (Test-Path $dll)) {
            "$game 包里没有这一作的 DLL，没装"
            $failed = $true
            continue
        }

        $dest = Join-Path $dir 'BepInEx\plugins\FfprBridge'
        try {
            # Replace the whole folder: 0.11.0's loader takes the place of the old single
            # FfprBridge.dll.
            if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
            New-Item -ItemType Directory -Force $dest | Out-Null
            Copy-Item (Join-Path $package '*') $dest -Recurse -Force
            "$game 已装 $version"
        } catch {
            "$game 复制失败:$($_.Exception.Message)"
            $failed = $true
        }
    }
}

if ($failed) { exit 1 }

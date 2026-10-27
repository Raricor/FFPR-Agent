<#
.SYNOPSIS
    给一作 PR 安装 BepInEx 6 IL2CPP。安装前先完整备份游戏目录。

.DESCRIPTION
    步骤:确认游戏没在运行 → 检查空间并备份到 C:\ffpr\backup → 下载或使用本地的 BepInEx 包 →
    解压到游戏目录 → 按顺序叠加额外的包(例如社区的 UnityPlayer 补丁)→ 记录安装信息。

    装完以后请启动一次游戏,等标题画面出现后再退出。首次启动时 BepInEx 会生成互操作程序集,
    可能要几分钟,期间会多出一个控制台窗口,属于正常现象。

.PARAMETER Game
    ff1 到 ff6。

.PARAMETER BepInExZip
    本地 BepInEx 压缩包。不给就从 BepInExUrl 下载。

.PARAMETER BepInExUrl
    默认是 6.0.0-pre.2 的 win-x64 IL2CPP 包。社区在 PR 1.2.x 上用哪个版本,P0b 会实测确认。

.PARAMETER ExtraZip
    在 BepInEx 之后依次解压到游戏目录的额外压缩包,可以给多个。

.PARAMETER SkipBackup
    跳过备份。只在已经备份过同一个 build 时使用。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')][string]$Game,
    [string]$BepInExZip = '',
    [string]$BepInExUrl = 'https://github.com/BepInEx/BepInEx/releases/download/v6.0.0-pre.2/BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip',
    [string[]]$ExtraZip = @(),
    [switch]$SkipBackup
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force

$gameDir = Find-GameDir $Game
$build = Get-GameBuildId $Game
if (Test-GameRunning $gameDir) { throw '游戏正在运行,请先退出游戏' }
Write-Host "游戏目录:$gameDir(build $build)"

$root = Get-FfprRoot
$work = Join-Path $root "work\$Game"
New-Item -ItemType Directory -Force -Path $work | Out-Null

$backup = ''
if (-not $SkipBackup) {
    $size = (Get-ChildItem -Path $gameDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    # Not Get-PSDrive: it reports 0 free when WMI is denied, as it is to ffpr over SSH.
    $free = ([IO.DriveInfo]::new($root.Substring(0, 1))).AvailableFreeSpace
    if ($free -lt $size * 1.2) {
        throw ('{0} 盘空间不够备份,需要约 {1:N1} GB' -f $root.Substring(0, 1), ($size * 1.2 / 1GB))
    }
    if (Test-Path (Join-Path $gameDir 'BepInEx')) {
        Write-Warning '游戏目录里已经有 BepInEx,备份里也会包含它'
    }
    $backup = Join-Path $root ("backup\{0}-build{1}-{2}" -f $Game, $build, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Write-Host ('备份 {0:N1} GB 到 {1} ...' -f ($size / 1GB), $backup)
    robocopy.exe $gameDir $backup /E /NFL /NDL /NJH /NJS /NP | Out-Null
    # robocopy uses exit codes 0-7 for success.
    if ($LASTEXITCODE -ge 8) { throw "备份失败,robocopy 退出码 $LASTEXITCODE" }
}

if (-not $BepInExZip) {
    $BepInExZip = Join-Path $work ([IO.Path]::GetFileName(([uri]$BepInExUrl).AbsolutePath))
    if (-not (Test-Path $BepInExZip)) {
        Write-Host "下载 $BepInExUrl ..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $BepInExUrl -OutFile $BepInExZip -UseBasicParsing
    }
}

$packages = @($BepInExZip) + $ExtraZip
foreach ($zip in $packages) {
    if (-not (Test-Path $zip)) { throw "找不到压缩包:$zip" }
    Write-Host "解压 $zip ..."
    Expand-Archive -Path $zip -DestinationPath $gameDir -Force
}

$record = [ordered]@{
    game     = $Game
    build    = $build
    gameDir  = $gameDir
    packages = @($packages | ForEach-Object { [IO.Path]::GetFullPath($_) })
    backup   = $backup
    time     = (Get-Date).ToString('o')
}
Write-Utf8NoBom (Join-Path $work 'install.json') ($record | ConvertTo-Json)

Write-Host ''
Write-Host '安装完成。下一步:启动一次游戏,等标题画面出现后退出。'
Write-Host '首次启动会生成互操作程序集,可能需要几分钟。'

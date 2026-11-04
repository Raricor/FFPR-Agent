# FFPR-Agent 笔记本端的公共函数。其他脚本用 Import-Module 引入。
# 注意:本文件必须保存为带 BOM 的 UTF-8,否则 Windows PowerShell 5.1 会把中文读成乱码。
Set-StrictMode -Version Latest

# Working root for staging, backups and session requests. ASCII and space-free on purpose,
# so scp paths from the dev box never need quoting.
$script:FfprRoot = 'C:\ffpr'

$script:AppIds = [ordered]@{
    ff1 = 1173770; ff2 = 1173780; ff3 = 1173790
    ff4 = 1173800; ff5 = 1173810; ff6 = 1173820
}

function Get-FfprRoot { $script:FfprRoot }

function Get-FfprAppId([string]$Game) {
    $key = $Game.ToLower()
    if (-not $script:AppIds.Contains($key)) {
        throw "未知的作品 '$Game',可选:$($script:AppIds.Keys -join ', ')"
    }
    $script:AppIds[$key]
}

# Reverse lookup for run-in-session.ps1: steam://rungameid/<AppId> -> ffN, or $null.
function Get-GameByAppId([int]$AppId) {
    foreach ($key in $script:AppIds.Keys) {
        if ($script:AppIds[$key] -eq $AppId) { return $key }
    }
    $null
}

function Get-SteamRoot {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction SilentlyContinue
    if ($reg -and $reg.SteamPath) { return ($reg.SteamPath -replace '/', '\') }
    $fallback = Join-Path ${env:ProgramFiles(x86)} 'Steam'
    if (Test-Path $fallback) { return $fallback }
    throw '找不到 Steam 的安装目录'
}

function Get-SteamLibraries {
    $root = Get-SteamRoot
    $libs = @($root)
    $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        # Paths in the VDF escape backslashes: "D:\\SteamLibrary".
        foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"')) {
            $libs += ($m.Groups[1].Value -replace '\\\\', '\')
        }
    }
    $libs | Select-Object -Unique
}

function Get-GameManifest([string]$Game) {
    $appId = Get-FfprAppId $Game
    foreach ($lib in Get-SteamLibraries) {
        $path = Join-Path $lib "steamapps\appmanifest_$appId.acf"
        if (Test-Path $path) {
            return [pscustomobject]@{ Library = $lib; Text = (Get-Content $path -Raw) }
        }
    }
    throw "找不到 $Game(App ID $appId)的安装信息,请确认它已经在 Steam 里安装"
}

function Get-ManifestValue([string]$Text, [string]$Name) {
    $m = [regex]::Match($Text, "`"$Name`"\s+`"([^`"]*)`"")
    if ($m.Success) { $m.Groups[1].Value } else { '' }
}

function Find-GameDir([string]$Game) {
    $manifest = Get-GameManifest $Game
    $installDir = Get-ManifestValue $manifest.Text 'installdir'
    $dir = Join-Path $manifest.Library "steamapps\common\$installDir"
    if (-not (Test-Path $dir)) { throw "$Game 的安装目录不存在:$dir" }
    $dir
}

function Get-GameBuildId([string]$Game) {
    Get-ManifestValue (Get-GameManifest $Game).Text 'buildid'
}

function Get-GameExe([string]$GameDir) {
    Get-ChildItem -Path $GameDir -Filter '*.exe' |
        Where-Object { $_.Name -notlike 'UnityCrashHandler*' } |
        Select-Object -First 1
}

function Test-GameRunning([string]$GameDir) {
    $exe = Get-GameExe $GameDir
    [bool]($exe -and (Get-Process -Name $exe.BaseName -ErrorAction SilentlyContinue))
}

# Window helpers for run-in-session.ps1. Since 2026-11-02 the launch no longer hides the window;
# these helpers only find the game's Unity window so Start-Game can wait for it to appear. The
# class name must not collide with pilot-agent.ps1's FfprInput, which is loaded in the same
# session when the pilot runs.
if (-not ('FfprWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FfprWindow {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);

    // The game's own window. MainWindowHandle is not enough: BepInEx's console belongs to the
    // same process and can be the "main" window.
    public static IntPtr FindUnityWindow(uint pid) {
        IntPtr h = IntPtr.Zero;
        while ((h = FindWindowEx(IntPtr.Zero, h, "UnityWndClass", null)) != IntPtr.Zero) {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == pid) return h;
        }
        return IntPtr.Zero;
    }
}
'@
}

# The game window of any process with this name, or $null if it has not appeared yet.
function Find-GameWindow([string]$ProcessName) {
    foreach ($p in @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)) {
        $hwnd = [FfprWindow]::FindUnityWindow([uint32]$p.Id)
        if ($hwnd -ne [IntPtr]::Zero) { return $hwnd }
    }
    $null
}

# Installed games whose process is running, as ff1..ff6 in order. A game whose install directory
# cannot be found (not installed) counts as not running instead of failing the whole check.
function Get-RunningGames {
    $running = @()
    foreach ($key in $script:AppIds.Keys) {
        try { $dir = Find-GameDir $key } catch { continue }
        if (Test-GameRunning $dir) { $running += $key }
    }
    $running
}

# 2026-11-02, the user's two rules for launching a game:
#   1. Do not minimise the game window. 0.11.0 waited for the window and then minimised it so six
#      games could run in the background; that is no longer wanted, so the window stays where it
#      appears and the focus is no longer handed back.
#   2. At most one game at a time. If another game is running, refuse and say which one -- never
#      close it for the user, because that would lose unsaved progress. If the requested game is
#      already running, do not ask Steam to start it again.
# Still wait for the window before returning (max 120 s): on 10-29 a launch that returned early
# made the next game's schtasks /run get ignored. launch-game.ps1 and run-in-session.ps1 both call
# this, so the two launch paths cannot drift apart. Returns the status fields run-in-session.ps1
# writes.
function Start-Game {
    param(
        [Parameter(Mandatory = $true)][string]$Game
    )
    $key = $Game.ToLower()
    $appId = Get-FfprAppId $key
    $running = @(Get-RunningGames)
    $others = @($running | Where-Object { $_ -ne $key })
    if ($others.Count -gt 0) {
        $names = @($others | ForEach-Object { $_.ToUpper() }) -join '、'
        $them = if ($others.Count -gt 1) { '它们' } else { '它' }
        return @{
            state = 'refused'
            running = @($running)
            note = "$names 还开着，一次只开一作，先关掉$them"
        }
    }
    if ($running -contains $key) {
        return @{ state = 'started'; already = $true; note = "$($key.ToUpper()) 已经开着" }
    }

    $exe = $null
    try { $exe = (Get-GameExe (Find-GameDir $key)).BaseName } catch { $exe = $null }
    Start-Process -FilePath "steam://rungameid/$appId"
    # Unknown game directory: Start-Process has handed off, but there is no process name to watch.
    if (-not $exe) { return @{ state = 'started' } }

    $deadline = (Get-Date).AddSeconds(120)
    $hwnd = $null
    while ($null -eq $hwnd -and (Get-Date) -lt $deadline) {
        $hwnd = Find-GameWindow $exe
        if ($null -eq $hwnd) { Start-Sleep -Milliseconds 500 }
    }
    if ($null -eq $hwnd) {
        return @{ state = 'started'; note = '120 秒内没等到游戏窗口' }
    }
    @{ state = 'started' }
}

# Start-Process in Windows PowerShell 5.1 joins -ArgumentList with spaces and no quoting, so
# 'FINAL FANTASY V.exe' arrives as three arguments. Build the command line ourselves, following
# the CommandLineToArgvW rules: quote when needed, escape quotes and the backslashes before them.
function ConvertTo-CommandLine([string[]]$Arguments) {
    $quoted = foreach ($a in $Arguments) {
        if ($a -and $a -notmatch '[\s"]') { $a; continue }
        '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
    }
    $quoted -join ' '
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

Export-ModuleMember -Function *

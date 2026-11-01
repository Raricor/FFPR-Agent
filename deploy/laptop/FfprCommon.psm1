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

# Window helpers for run-in-session.ps1 (0.11.0): a launched game should go to the background
# instead of covering the desktop. The class name must not collide with pilot-agent.ps1's
# FfprInput, which is loaded in the same session when the pilot runs.
if (-not ('FfprWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FfprWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
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

# SW_SHOWMINNOACTIVE (7): minimise without activating the window, so focus stays where it was.
function Hide-GameWindow([IntPtr]$Window) {
    [void][FfprWindow]::ShowWindow($Window, 7)
}

# 0.11.0: launch a game through its Steam URL and put its window in the background -- wait for
# the window, minimise it without activating it, and watch for 20 s because Unity activates the
# window again while initialising (10-29: a launch that returned early made the next game's
# schtasks /run get ignored). launch-game.ps1 and run-in-session.ps1 both call this, so the two
# cannot drift apart. Returns the status fields run-in-session.ps1 writes.
function Start-GameInBackground {
    param(
        [Parameter(Mandatory = $true)][string]$Game,
        [switch]$Foreground
    )
    $appId = Get-FfprAppId $Game
    $exe = $null
    if (-not $Foreground) {
        try { $exe = (Get-GameExe (Find-GameDir $Game)).BaseName } catch { $exe = $null }
    }
    $before = [FfprWindow]::GetForegroundWindow()
    Start-Process -FilePath "steam://rungameid/$appId"
    # Unknown game directory, or the caller wants the window in front: start it and return.
    if (-not $exe) { return @{ state = 'started'; minimized = $false } }

    $deadline = (Get-Date).AddSeconds(120)
    $hwnd = $null
    while ($null -eq $hwnd -and (Get-Date) -lt $deadline) {
        $hwnd = Find-GameWindow $exe
        if ($null -eq $hwnd) { Start-Sleep -Milliseconds 500 }
    }
    if ($null -eq $hwnd) {
        return @{ state = 'started'; minimized = $false; note = '120 秒内没等到游戏窗口' }
    }
    Hide-GameWindow $hwnd
    # Give the focus back to whatever was in front before the launch.
    if ($before -ne [IntPtr]::Zero) { [void][FfprWindow]::SetForegroundWindow($before) }
    $rehidden = 0
    $watchUntil = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $watchUntil) {
        Start-Sleep -Milliseconds 500
        if (-not [FfprWindow]::IsIconic($hwnd)) {
            Hide-GameWindow $hwnd
            $rehidden++
        }
    }
    return @{ state = 'started'; minimized = $true; rehidden = $rehidden }
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

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

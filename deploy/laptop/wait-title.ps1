# Wait until the game reaches its title screen with the expected bridge version, then print
# the bridge's lines from BepInEx's log (failed hooks show up there). Used by ffpr-pilot restart.
#
#   wait-title.ps1 -Game ff5 -Version 0.4.1 -After probe-20261020-011314.jsonl
#
# -After is the newest probe file before the game was started: older files also contain a title
# screen, so only a newer file counts.
param(
    [Parameter(Mandatory = $true)][string]$Game,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$After = '',
    [int]$TimeoutSeconds = 120
)

Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force
$bepinex = Join-Path (Find-GameDir $Game) 'BepInEx'

# The game keeps both files open for writing; read them with ReadWrite sharing.
function Read-Shared([string]$Path) {
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try { (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Close() }
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$found = $null
while (-not $found -and (Get-Date) -lt $deadline) {
    $file = Get-ChildItem (Join-Path $bepinex 'ffpr') -Filter 'probe-*.jsonl' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -gt $After } | Sort-Object Name | Select-Object -Last 1
    if ($file) {
        $text = Read-Shared $file.FullName
        if ($text.Contains("""plugin"":""$Version""") -and $text.Contains('"name":"Title"')) {
            $found = $file
        }
    }
    if (-not $found) { Start-Sleep -Seconds 2 }
}

$log = Join-Path $bepinex 'LogOutput.log'
if (Test-Path $log) {
    (Read-Shared $log) -split "`r?`n" |
        Where-Object { $_ -match 'FFPR Agent Bridge|挂钩 .*失败|Error' } | Select-Object -Last 5
}
if (-not $found) { throw "$TimeoutSeconds 秒内没有看到桥插件 $Version 到达标题画面" }
"到达标题画面,探针文件 $($found.Name)"

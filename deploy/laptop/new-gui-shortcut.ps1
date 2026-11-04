# 在桌面放一个「FFPR 桥插件」快捷方式(0.12.0)。
#
# 请在笔记本上、你自己的桌面账号里运行一次(游戏和 Steam 都在这个账号的桌面上)：
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\new-gui-shortcut.ps1
#
# 2026-10-29: the shortcut runs bridge-gui.ps1 through `conhost.exe --headless` so no console
# window appears. Staying script-only avoids the block on unsigned exe files on this machine.
$ErrorActionPreference = 'Stop'

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { throw '找不到桌面目录' }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$bridge = 'C:\ffpr\deploy\laptop\bridge-gui.ps1'

# 2026-10-29: same reason as register-session-task.ps1 -- Windows 11's Windows Terminal ignores
# -WindowStyle Hidden. A conhost.exe --headless shortcut has no window; the icon stays PowerShell's.
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$build = 0
try {
    $build = [int](Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' `
        -Name CurrentBuildNumber -ErrorAction Stop).CurrentBuildNumber
} catch {
    $build = [Environment]::OSVersion.Version.Build
}
if ((Test-Path $conhost) -and ($build -ge 17763)) {
    $target = $conhost
    $arguments = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -File $bridge"
} else {
    $target = $ps
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $bridge"
    Write-Host '这台系统没有 conhost.exe 或版本低于 Windows 10 1809(build 17763),快捷方式仍用原来的写法,打开时可能会闪一下窗口。'
}

$path = Join-Path $desktop 'FFPR 桥插件.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($path)
$link.TargetPath = $target
$link.Arguments = $arguments
$link.WorkingDirectory = 'C:\ffpr\deploy\laptop'
$link.IconLocation = "$ps,0"
$link.Description = 'FFPR 桥插件'
$link.Save()

"已创建 $path"

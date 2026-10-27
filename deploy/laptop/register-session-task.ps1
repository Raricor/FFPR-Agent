<#
.SYNOPSIS
    注册一个「只在你登录时运行」的计划任务,让开发机能通过 SSH 在你的桌面上启动程序。

.DESCRIPTION
    开发机用本地普通账号 ffpr 登录 SSH,它启动的程序不在你的桌面会话里,游戏窗口不会出现。
    这个计划任务以你的身份、在你的桌面会话里运行 run-in-session.ps1:开发机先写好请求文件,
    再用 schtasks /run 触发它。

    由你本人在「以管理员身份运行」的 PowerShell 里执行一次(修改任务权限需要管理员):

        powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\register-session-task.ps1

    任务以普通权限运行,不会提权。-AllowUser 指定的账号只获得「读取和启动」这个任务的权限,
    不能修改或删除它。可以重复执行。
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$TaskName = 'FFPR-Agent-Session',
    [string]$AllowUser = 'ffpr'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force

$runner = Join-Path $PSScriptRoot 'run-in-session.ps1'
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
    -Settings $settings -Force | Out-Null

# Let $AllowUser start the task: GENERIC_READ | GENERIC_EXECUTE on its DACL, nothing more.
$sid = ([Security.Principal.NTAccount]$AllowUser).Translate([Security.Principal.SecurityIdentifier])
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$task = $service.GetFolder('\').GetTask($TaskName)
$dacl = New-Object Security.AccessControl.RawSecurityDescriptor ($task.GetSecurityDescriptor(4))
if (-not @($dacl.DiscretionaryAcl | Where-Object { $_.SecurityIdentifier -eq $sid })) {
    $readExecute = -1610612736  # 0xA0000000
    $ace = New-Object Security.AccessControl.CommonAce 'None', 'AccessAllowed', $readExecute, $sid, $false, $null
    $dacl.DiscretionaryAcl.InsertAce($dacl.DiscretionaryAcl.Count, $ace)
    $task.SetSecurityDescriptor($dacl.GetSddlForm('Access'), 0)
}

New-Item -ItemType Directory -Force -Path (Join-Path (Get-FfprRoot) 'session') | Out-Null
Write-Host "已注册计划任务 $TaskName,并允许 $AllowUser 启动它"

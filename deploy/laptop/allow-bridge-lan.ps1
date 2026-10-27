# 允许开发机从局域网直连桥插件(分层控制方案 §5.3)。需要管理员权限,只运行一次:
#
#   powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\allow-bridge-lan.ps1
#
# 规则绑定游戏程序本身,并且只放行开发机所在主机的地址。绑定程序是为了不让 Windows 在游戏
# 第一次监听局域网时弹出「是否允许访问」:那个弹窗如果被取消,会生成一条优先于放行规则的阻止规则。
param(
    [ValidateSet('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')][string]$Game = 'ff5',
    [string]$RemoteAddress = '192.168.8.229',
    [int]$Port = 47800
)
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')
if (-not $admin) { throw '请在「以管理员身份运行」的 PowerShell 里执行' }

Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force
$exe = Get-GameExe (Find-GameDir $Game)
$name = "FFPR-Agent-Bridge-LAN-$Game"
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -RemoteAddress $RemoteAddress -Program $exe.FullName -Profile Any | Out-Null
"已添加防火墙规则 ${name}:只允许 $RemoteAddress 访问 $($exe.Name) 的 TCP $Port"

# 允许开发机从局域网直连桥插件(分层控制方案 §5.3)。需要管理员权限。不带参数就给装了的每一作各加一条:
#
#   powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\allow-bridge-lan.ps1
#   powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\allow-bridge-lan.ps1 -Game ff6
#
# 规则绑定游戏程序本身,并且只放行开发机所在主机的地址。绑定程序是为了不让 Windows 在游戏
# 第一次监听局域网时弹出「是否允许访问」:那个弹窗如果被取消,会生成一条优先于放行规则的阻止规则。
# 再运行一次会先删掉同名的旧规则,所以端口变了重跑就行。
param(
    [ValidateSet('all', 'ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')][string]$Game = 'all',
    [string]$RemoteAddress = '192.168.8.229',
    # 0 means the game's own bridge port (bridge 0.10.0): 47800 for FF5, 4780N for FFN.
    [int]$Port = 0
)
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')
if (-not $admin) { throw '请在「以管理员身份运行」的 PowerShell 里执行' }
if ($Game -eq 'all' -and $Port -ne 0) { throw '-Port 只能和单独一作(-Game ffN)一起用' }

Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force

function Add-BridgeRule([string]$Key, [int]$RulePort) {
    if ($RulePort -eq 0) { $RulePort = if ($Key -eq 'ff5') { 47800 } else { 47800 + [int]$Key.Substring(2) } }
    $exe = Get-GameExe (Find-GameDir $Key)
    $name = "FFPR-Agent-Bridge-LAN-$Key"
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $RulePort `
        -RemoteAddress $RemoteAddress -Program $exe.FullName -Profile Any | Out-Null
    "已添加防火墙规则 ${name}:只允许 $RemoteAddress 访问 $($exe.Name) 的 TCP $RulePort"
}

if ($Game -ne 'all') {
    Add-BridgeRule $Game $Port
    return
}
foreach ($key in 'ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6') {
    try {
        Add-BridgeRule $key 0
    } catch {
        # A game that is not installed has no program to bind; the others still get their rule.
        "跳过 ${key}:$($_.Exception.Message)"
    }
}

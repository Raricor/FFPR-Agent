<#
.SYNOPSIS
    在笔记本上开启 OpenSSH 服务器,让开发机可以用密钥登录。

.DESCRIPTION
    请在「以管理员身份运行」的 PowerShell 里执行:
        powershell -ExecutionPolicy Bypass -File .\setup-ssh.ps1

    做五件事:
    1. 安装 OpenSSH 服务器,设为开机自动启动并启动它;
    2. 只在「专用网络」(家里的局域网)放行 22 端口,并关闭 Windows 自带的、对所有网络放行的规则;
    3. 把 SSH 登录后的默认 shell 设为 Windows PowerShell;
    4. 把开发机的公钥加入授权列表;
    5. 打印本机的局域网 IP、用户名和网络类型,请把它们告诉我。

    脚本可以重复运行,结果不变。

.PARAMETER PublicKeyFile
    开发机的公钥文件,默认是同目录下的 devbox.pub。

.PARAMETER AllowFrom
    可选。只允许这个地址连接 22 端口,例如开发机的局域网 IP。
#>
[CmdletBinding()]
param(
    [string]$PublicKeyFile = (Join-Path $PSScriptRoot 'devbox.pub'),
    [string]$AllowFrom = ''
)
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal $identity
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请用「以管理员身份运行」打开 PowerShell 后再执行本脚本'
}
$publicKey = (Get-Content $PublicKeyFile -Raw).Trim()
if ($publicKey -notmatch '^ssh-ed25519 ') { throw "公钥文件格式不对:$PublicKeyFile" }

Write-Host '1/5 安装并启动 OpenSSH 服务器 ...'
$cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*' | Select-Object -First 1
if (-not $cap) { throw '这台 Windows 不提供 OpenSSH 服务器组件' }
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd

Write-Host '2/5 配置防火墙(只放行专用网络)...'
$builtin = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($builtin) { $builtin | Disable-NetFirewallRule }
Get-NetFirewallRule -Name 'FFPR-Agent-SSH' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$rule = @{
    Name = 'FFPR-Agent-SSH'; DisplayName = 'FFPR-Agent SSH(仅专用网络)'
    Direction = 'Inbound'; Protocol = 'TCP'; LocalPort = 22; Action = 'Allow'; Profile = 'Private'
}
if ($AllowFrom) { $rule.RemoteAddress = $AllowFrom }
New-NetFirewallRule @rule | Out-Null

Write-Host '3/5 设置默认 shell 为 Windows PowerShell ...'
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
$shell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $shell `
    -PropertyType String -Force | Out-Null

Write-Host '4/5 加入开发机的公钥 ...'
function Add-KeyLine([string]$Path) {
    $dir = Split-Path $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $existing = if (Test-Path $Path) { Get-Content $Path } else { @() }
    if ($existing -notcontains $publicKey) {
        # authorized_keys must be plain ASCII without a BOM.
        [IO.File]::AppendAllText($Path, $publicKey + "`n", [Text.Encoding]::ASCII)
    }
}
# sshd reads administrators_authorized_keys for members of the Administrators group and the
# per-user file otherwise. Writing both covers either kind of account.
$adminKeys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
Add-KeyLine $adminKeys
# Only SYSTEM and Administrators may access it, or sshd ignores the file. SIDs avoid
# depending on localized group names.
icacls.exe $adminKeys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
Add-KeyLine (Join-Path $env:USERPROFILE '.ssh\authorized_keys')
Restart-Service -Name sshd

Write-Host '5/5 本机信息(请告诉我):'
$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
Write-Host "  用户名:$env:USERNAME"
Write-Host "  局域网 IP:$($ips -join ', ')"
foreach ($p in Get-NetConnectionProfile) {
    Write-Host "  网络「$($p.Name)」的类型:$($p.NetworkCategory)"
    if ($p.NetworkCategory -ne 'Private') {
        Write-Warning "网络「$($p.Name)」不是专用网络,22 端口在这个网络上不会放行。如果这是家里的网络,请在 Windows 设置里把它改成专用网络。"
    }
}
Write-Host '完成。'

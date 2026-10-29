<#
.SYNOPSIS
    试玩助手：常驻在你的桌面会话里，替开发机给游戏按键、截图(P0b 试玩用)。

.DESCRIPTION
    由开发机通过计划任务 FFPR-Agent-Session 启动。工作方式：
    1. 开发机把命令写成 C:\ffpr\session\pilot\<id>.cmd.json(FF5;其他作品是 session\pilot-<作品>,每作一个助手);
    2. 这里执行命令，把结果写回 <id>.result.json。

    只给游戏窗口按键：每按一个键之前，都检查当前前台窗口是不是游戏;不是就停下并报 not_focused,
    绝不会把按键送进别的窗口。

    闲置超过 IdleMinutes 分钟会自动退出，也可以发 quit 命令让它退出。

    按键写法:
      Enter             按一下
      Down*3            连按 3 下
      Up:600            按住 600 毫秒(走路用)
      Right:400*2       按住 400 毫秒，重复 2 次

    walk 命令会一边按住方向键，一边向桥插件查询坐标，到达目标格子就松手;被挡住时换另一个方向，
    出现对话或战斗就立刻停下。
#>
[CmdletBinding()]
param(
    [ValidateSet('ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6')][string]$Game = 'ff5',
    [int]$IdleMinutes = 30,
    # 0 means the game's own bridge port (bridge 0.10.0): 47800 for FF5, 4780N for FFN.
    [int]$BridgePort = 0,
    # The LAN link's settings; its token also opens the bridge's local key channel (0.9.0).
    [string]$LinkFile = 'C:\ffpr\bridge.json',
    # Ask Windows to keep the display on while the agent runs. Off by default: whether the
    # laptop may stay unlocked unattended is your (or your IT's) call.
    [switch]$KeepAwake
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FfprInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion u; }
    public struct RECT { public int Left, Top, Right, Bottom; }
    public struct POINT { public int X, Y; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
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

    // Scan codes rather than virtual keys: games reading raw input see scan codes.
    public static bool Key(ushort vk, bool up, bool extended) {
        uint flags = 0x0008u | (up ? 0x0002u : 0u) | (extended ? 0x0001u : 0u);
        var input = new INPUT { type = 1 };
        input.u.ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)MapVirtualKey(vk, 0), dwFlags = flags };
        return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static uint ForegroundPid() {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
}
'@
[void][FfprInput]::SetProcessDPIAware()

# Virtual-key code and whether it is an extended key (needs the E0 prefix).
$KeyCodes = @{
    Up = 0x26, $true; Down = 0x28, $true; Left = 0x25, $true; Right = 0x27, $true
    Enter = 0x0D, $false; Space = 0x20, $false; Backspace = 0x08, $false; Escape = 0x1B, $false
    Tab = 0x09, $false; Shift = 0xA0, $false; Ctrl = 0xA2, $false; Alt = 0xA4, $false
    PageUp = 0x21, $true; PageDown = 0x22, $true; Home = 0x24, $true; End = 0x23, $true
    Insert = 0x2D, $true; Delete = 0x2E, $true
}
foreach ($c in [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') { $KeyCodes["$c"] = [int][char]$c, $false }
foreach ($n in 1..12) { $KeyCodes["F$n"] = (0x6F + $n), $false }

$exeName = (Get-GameExe (Find-GameDir $Game)).BaseName
# 10-28: one agent per game, so six can run at once. FF5 keeps the old folder (the Python
# player and the dsh FF5 player both use it).
$dir = Join-Path (Get-FfprRoot) $(if ($Game -eq 'ff5') { 'session\pilot' } else { "session\pilot-$Game" })
if ($BridgePort -eq 0) { $BridgePort = if ($Game -eq 'ff5') { 47800 } else { 47800 + [int]$Game.Substring(2) } }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Get-GameWindow {
    foreach ($p in @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)) {
        $hwnd = [FfprInput]::FindUnityWindow([uint32]$p.Id)
        if ($hwnd -ne [IntPtr]::Zero) { return @{ pid = [uint32]$p.Id; hwnd = $hwnd } }
    }
    $null
}

# The game window itself must be in front: its console shares the process, so comparing
# process ids would send keys into the console.
function Test-Focused($window) {
    $window -and ([FfprInput]::GetForegroundWindow() -eq $window.hwnd)
}

function Get-ForegroundName {
    $id = [FfprInput]::ForegroundPid()
    if (-not $id) { return '' }
    (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName
}

# Why keys cannot be sent: the lock screen (nothing can be done until you unlock) or some
# other window in front.
function Get-FocusError {
    if ((Get-ForegroundName) -in 'LockApp', 'LogonUI') { 'locked' } else { 'not_focused' }
}

# --- Game buttons: the bridge's virtual gamepad (0.9.0), else SendInput -------------------------
# 10-27: the game can be played in the background. SendInput feeds the global keyboard, so the
# game had to be in front and fought whoever was typing; the bridge presses a virtual gamepad
# inside the game instead, over its local /command with the LAN link's token.

function Get-LinkToken {
    if ($null -eq $script:LinkToken) {
        $script:LinkToken = ''
        try { $script:LinkToken = [string](Get-Content -Raw $LinkFile | ConvertFrom-Json).token } catch { }
    }
    $script:LinkToken
}

function Connect-Command {
    if ($script:Command -and $script:Command.State -eq 'Open') { return $script:Command }
    $token = Get-LinkToken
    if (-not $token) { throw 'no_link_token' }
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.Options.SetRequestHeader('Authorization', "Bearer $token")
    if (-not $ws.ConnectAsync([uri]"ws://127.0.0.1:$BridgePort/command", [Threading.CancellationToken]::None).Wait(3000)) {
        throw 'bridge_unreachable'
    }
    $script:Command = $ws
    $ws
}

# One command on /command; the reply carries the command's id in "re", like a query's.
function Invoke-Command([hashtable]$Fields) {
    $id = ++$script:BridgeId
    $body = @{ id = $id } + $Fields | ConvertTo-Json -Compress -Depth 5
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    try {
        $ws = Connect-Command
        $segment = New-Object 'ArraySegment[byte]' -ArgumentList (, $bytes)
        [void]$ws.SendAsync($segment, 'Text', $true, [Threading.CancellationToken]::None).Wait(2000)
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            $reply = Receive-Message $ws 60000 | ConvertFrom-Json
            if ($reply.re -eq $id) { return $reply }
        }
        throw 'bridge_timeout'
    } catch {
        if ($script:Command) { $script:Command.Dispose(); $script:Command = $null }
        throw
    }
}

# Whether the bridge presses the game's virtual gamepad; asked once, on first use.
function Test-GameButtons {
    if ($null -eq $script:GameButtons) {
        $script:GameButtons = $false
        try { $script:GameButtons = [bool](Invoke-Command @{ op = 'hold'; key = 'Enter'; down = $false; ms = 50 }).ok } catch { }
    }
    $script:GameButtons
}

# Why buttons cannot be pressed now, or $null. The virtual gamepad needs no focus; SendInput
# needs the game's own window in front.
function Get-ButtonBlocker($window) {
    if (Test-GameButtons) { return $null }
    if (Test-Focused $window) { return $null }
    Get-FocusError
}

# Holds a button down or lets it go. A held game button lets go by itself after $Ms unless
# held again, so a walker that dies mid-walk cannot leave the party walking.
function Set-Button([string]$Name, [bool]$Down, [int]$Ms = 1500) {
    if (Test-GameButtons) {
        $r = Invoke-Command @{ op = 'hold'; key = $Name; down = $Down; ms = $Ms }
        if (-not $r.ok) { throw "button_failed:$($r.error)" }
        return
    }
    $code = $KeyCodes[$Name]
    [void][FfprInput]::Key([uint16]$code[0], (-not $Down), $code[1])
}

function Press-Button([string]$Name, [int]$HoldMs) {
    Set-Button $Name $true
    try { Start-Sleep -Milliseconds $HoldMs } finally { Set-Button $Name $false }
}

function Get-Status {
    $w = Get-GameWindow
    $fg = Get-ForegroundName
    $s = [ordered]@{ ok = $true; game = $Game; running = [bool]$w; focused = [bool](Test-Focused $w)
        locked = $fg -in 'LockApp', 'LogonUI'; foreground = $fg }
    if ($w) {
        $r = New-Object FfprInput+RECT
        [void][FfprInput]::GetClientRect($w.hwnd, [ref]$r)
        $s.client = @(($r.Right - $r.Left), ($r.Bottom - $r.Top))
        $s.minimized = [FfprInput]::IsIconic($w.hwnd)
    }
    $s
}

function Invoke-Keys($keys, [int]$Gap) {
    $w = Get-GameWindow
    if (-not $w) { return @{ ok = $false; error = 'game_not_running' } }
    if (Test-GameButtons) {
        $r = Invoke-Command @{ op = 'keys'; keys = @($keys); gap = $Gap; via = 'game' }
        $out = @{ ok = [bool]$r.ok; sent = $r.sent }
        if (-not $r.ok) { $out.error = $r.error }
        return $out
    }
    $sent = 0
    foreach ($spec in $keys) {
        if ($spec -notmatch '^(?<name>[A-Za-z0-9]+)(:(?<hold>\d+))?(\*(?<times>\d+))?$') {
            return @{ ok = $false; error = "bad_key:$spec"; sent = $sent }
        }
        $name = $Matches.name
        $hold = if ($Matches.hold) { [int]$Matches.hold } else { 70 }
        $times = if ($Matches.times) { [int]$Matches.times } else { 1 }
        $code = $KeyCodes[$name]
        if (-not $code) { return @{ ok = $false; error = "unknown_key:$name"; sent = $sent } }
        for ($i = 0; $i -lt $times; $i++) {
            if (-not (Test-Focused $w)) { return @{ ok = $false; error = (Get-FocusError); sent = $sent } }
            [void][FfprInput]::Key([uint16]$code[0], $false, $code[1])
            Start-Sleep -Milliseconds $hold
            [void][FfprInput]::Key([uint16]$code[0], $true, $code[1])
            $sent++
            Start-Sleep -Milliseconds $Gap
        }
    }
    @{ ok = $true; sent = $sent }
}

function Save-Shot([string]$Id, [int]$MaxWidth) {
    $w = Get-GameWindow
    if (-not $w) { return @{ ok = $false; error = 'game_not_running' } }
    $r = New-Object FfprInput+RECT
    [void][FfprInput]::GetClientRect($w.hwnd, [ref]$r)
    $origin = New-Object FfprInput+POINT
    [void][FfprInput]::ClientToScreen($w.hwnd, [ref]$origin)
    $width = $r.Right - $r.Left; $height = $r.Bottom - $r.Top
    if ($width -le 0 -or $height -le 0) { return @{ ok = $false; error = 'window_minimized' } }
    $full = New-Object Drawing.Bitmap $width, $height
    $g = [Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($origin.X, $origin.Y, 0, 0, $full.Size)
    $g.Dispose()
    $image = $full
    if ($MaxWidth -gt 0 -and $width -gt $MaxWidth) {
        $scaledHeight = [int]($height * $MaxWidth / $width)
        $image = New-Object Drawing.Bitmap $MaxWidth, $scaledHeight
        $g = [Drawing.Graphics]::FromImage($image)
        $g.InterpolationMode = 'HighQualityBicubic'
        $g.DrawImage($full, 0, 0, $MaxWidth, $scaledHeight)
        $g.Dispose()
        $full.Dispose()
    }
    $path = Join-Path $dir "$Id.png"
    $image.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    $size = @($image.Width, $image.Height)
    $image.Dispose()
    # The dev box copies each shot right away; keep only the newest few here.
    Get-ChildItem -Path $dir -Filter '*.png' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 |
        Remove-Item -Force
    @{ ok = $true; shot = $path; size = $size; focused = [bool](Test-Focused $w) }
}

# --- Bridge queries over its loopback WebSocket ---------------------------------------------

$script:Bridge = $null
$script:BridgeId = 0
$script:Buffer = New-Object byte[] 65536

function Connect-Bridge {
    if ($script:Bridge -and $script:Bridge.State -eq 'Open') { return $script:Bridge }
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    # /query: bridge 0.2.1+ sends this connection replies only, no broadcast samples.
    if (-not $ws.ConnectAsync([uri]"ws://127.0.0.1:$BridgePort/query", [Threading.CancellationToken]::None).Wait(3000)) {
        throw 'bridge_unreachable'
    }
    $script:Bridge = $ws
    $ws
}

function Receive-Message($ws, [int]$TimeoutMs) {
    $stream = New-Object IO.MemoryStream
    do {
        $segment = New-Object 'ArraySegment[byte]' -ArgumentList (, $script:Buffer)
        $task = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None)
        if (-not $task.Wait($TimeoutMs)) { throw 'bridge_timeout' }
        $stream.Write($script:Buffer, 0, $task.Result.Count)
    } while (-not $task.Result.EndOfMessage)
    [Text.Encoding]::UTF8.GetString($stream.ToArray())
}

# Sends one query and returns its reply. Older bridges also broadcast samples to this
# connection and drop it when it falls behind, so a failed query reconnects and retries once.
function Invoke-Bridge([string]$Op, [hashtable]$Fields = @{}) {
    try { return Invoke-BridgeOnce $Op $Fields } catch { return Invoke-BridgeOnce $Op $Fields }
}

function Invoke-BridgeOnce([string]$Op, [hashtable]$Fields) {
    $id = ++$script:BridgeId
    $body = @{ id = $id; op = $Op } + $Fields | ConvertTo-Json -Compress -Depth 10
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    try {
        $ws = Connect-Bridge
        $segment = New-Object 'ArraySegment[byte]' -ArgumentList (, $bytes)
        [void]$ws.SendAsync($segment, 'Text', $true, [Threading.CancellationToken]::None).Wait(2000)
        $deadline = (Get-Date).AddSeconds(3)
        while ((Get-Date) -lt $deadline) {
            $message = Receive-Message $ws 3000
            if ($message.Contains('"type":"reply"')) {
                $reply = $message | ConvertFrom-Json
                if ($reply.re -eq $id) {
                    if (-not $reply.ok) { throw "bridge_error:$($reply.error)" }
                    return $reply
                }
            }
        }
        throw 'bridge_timeout'
    } catch {
        if ($script:Bridge) { $script:Bridge.Dispose(); $script:Bridge = $null }
        throw
    }
}

function Get-Position { (Invoke-Bridge 'pos').pos }

# What stops a walk: anything other than free movement on a map.
function Get-Interruption($pos) {
    if ($pos.battle) { return 'battle' }
    if ($pos.dialog) { return 'dialog' }
    if ($pos.state -notin 'Player', 'Transport') { return "state:$($pos.state)" }
    $null
}

$Directions = @{ Right = @(1, 0); Left = @(-1, 0); Down = @(0, 1); Up = @(0, -1) }

function Invoke-Walk([int]$X, [int]$Y, [int]$TimeoutMs) {
    $w = Get-GameWindow
    if (-not $w) { return @{ ok = $false; error = 'game_not_running' } }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $blocked = @{}
    $steps = 0
    while ((Get-Date) -lt $deadline) {
        $pos = Get-Position
        if (-not $pos.cell) { return @{ ok = $false; error = 'no_player'; pos = $pos } }
        $why = Get-Interruption $pos
        if ($why) { return @{ ok = $false; error = "interrupted:$why"; pos = $pos; steps = $steps } }
        $dx = $X - $pos.cell[0]; $dy = $Y - $pos.cell[1]
        if ($dx -eq 0 -and $dy -eq 0) { return @{ ok = $true; pos = $pos; steps = $steps } }

        # Try the axis with more distance to cover first; skip axes that just hit a wall.
        $candidates = @()
        if ($dx -ne 0) { $candidates += @{ key = $(if ($dx -gt 0) { 'Right' } else { 'Left' }); left = [Math]::Abs($dx) } }
        if ($dy -ne 0) { $candidates += @{ key = $(if ($dy -gt 0) { 'Down' } else { 'Up' }); left = [Math]::Abs($dy) } }
        $choice = $candidates | Where-Object { -not $blocked[$_.key] } | Sort-Object { - $_.left } | Select-Object -First 1
        if (-not $choice) { return @{ ok = $false; error = 'blocked'; pos = $pos; steps = $steps; tried = @($blocked.Keys) } }

        $key = $choice.key
        $axis = if ($key -in 'Left', 'Right') { 0 } else { 1 }
        $goal = if ($axis -eq 0) { $X } else { $Y }
        $sign = $Directions[$key][$axis]
        $blocker = Get-ButtonBlocker $w
        if ($blocker) { return @{ ok = $false; error = $blocker; steps = $steps } }
        $start = $pos.cell[$axis]
        $lastCell = $start
        $lastProgress = Get-Date
        $stop = $null
        Set-Button $key $true
        $renewed = Get-Date
        try {
            while ($true) {
                Start-Sleep -Milliseconds 25
                $pos = Get-Position
                $why = Get-Interruption $pos
                if ($why) { $stop = "interrupted:$why"; break }
                $blocker = Get-ButtonBlocker $w
                if ($blocker) { $stop = $blocker; break }
                if (((Get-Date) - $renewed).TotalMilliseconds -gt 400) { Set-Button $key $true; $renewed = Get-Date }
                if (-not $pos.cell) { break }
                $now = $pos.cell[$axis]
                if ($now -ne $lastCell) { $lastCell = $now; $lastProgress = Get-Date }
                if (($goal - $now) * $sign -le 0) { break }
                if (((Get-Date) - $lastProgress).TotalMilliseconds -gt 800) { $blocked[$key] = $true; break }
                if ((Get-Date) -gt $deadline) { break }
            }
        } finally {
            Set-Button $key $false
        }
        # Let the step in progress finish before deciding what to do next.
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 25
            $pos = Get-Position
            if (-not $pos.moving) { break }
        }
        if ($stop) { return @{ ok = $false; error = $stop; pos = $pos; steps = $steps } }
        if ($pos.cell -and $pos.cell[$axis] -ne $start) {
            $steps += [Math]::Abs($pos.cell[$axis] - $start)
            # Progress on one axis may have opened the other one.
            foreach ($k in @($blocked.Keys)) { if ($k -ne $key) { $blocked.Remove($k) } }
        }
    }
    @{ ok = $false; error = 'timeout'; pos = (Get-Position); steps = $steps }
}

# Routine battles run here, next to the game, with no round trip to the dev box: while the
# battle lasts, press Enter every EveryMs. On a command menu that is "attack the first
# target"; on the result screens it turns the page. Stops as soon as the player is back on
# the map, so the Enter never reaches the field.
function Invoke-Battle([int]$TimeoutMs, [int]$EveryMs) {
    $w = Get-GameWindow
    if (-not $w) { return @{ ok = $false; error = 'game_not_running' } }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $presses = 0
    $started = Get-Date
    while ((Get-Date) -lt $deadline) {
        $pos = Get-Position
        if (-not ($pos.battle -or $pos.state -eq 'Battle')) {
            $seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
            return @{ ok = $true; presses = $presses; seconds = $seconds; pos = $pos }
        }
        $blocker = Get-ButtonBlocker $w
        if ($blocker) { return @{ ok = $false; error = $blocker; presses = $presses } }
        Press-Button 'Enter' 60
        $presses++
        Start-Sleep -Milliseconds $EveryMs
    }
    @{ ok = $false; error = 'timeout'; presses = $presses; pos = (Get-Position) }
}

# Back out of shops and menus: Backspace until the player can move again.
function Invoke-Leave {
    $w = Get-GameWindow
    if (-not $w) { return @{ ok = $false; error = 'game_not_running' } }
    for ($i = 0; $i -lt 8; $i++) {
        $pos = Get-Position
        if ($pos.state -eq 'Player') { return @{ ok = $true; presses = $i; pos = $pos } }
        $blocker = Get-ButtonBlocker $w
        if ($blocker) { return @{ ok = $false; error = $blocker; pos = $pos } }
        Press-Button 'Backspace' 70
        Start-Sleep -Milliseconds 450
    }
    @{ ok = $false; error = 'still_in_menu'; pos = (Get-Position) }
}

function Wait-Free([int]$TimeoutMs) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $pos = Get-Position
        if (-not (Get-Interruption $pos)) { return @{ ok = $true; pos = $pos } }
        Start-Sleep -Milliseconds 200
    }
    @{ ok = $false; error = 'timeout'; pos = (Get-Position) }
}

# --- Story paging, driven by the probe file (works with every bridge version) -------------

$probeDir = Join-Path (Find-GameDir $Game) 'BepInEx\ffpr'

# The newest "sample" record in the newest probe file.
function Get-LastSample {
    $file = Get-ChildItem -Path $probeDir -Filter 'probe-*.jsonl' | Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $file) { return $null }
    $fs = [IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite')
    try {
        $start = [Math]::Max(0, $fs.Length - 32768)
        [void]$fs.Seek($start, 'Begin')
        $buf = New-Object byte[] ($fs.Length - $start)
        [void]$fs.Read($buf, 0, $buf.Length)
    } finally { $fs.Close() }
    $lines = [Text.Encoding]::UTF8.GetString($buf) -split "`n"
    for ($i = $lines.Count - 1; $i -ge 1; $i--) {
        if ($lines[$i].Contains('"type":"sample"')) {
            try { return $lines[$i] | ConvertFrom-Json } catch { }
        }
    }
    $null
}

# Pages through dialog at reading speed until the player is free, a choice appears or a battle
# starts. Choices are never answered here.
function Invoke-Story([int]$PageMs, [int]$TimeoutMs) {
    $w = Get-GameWindow
    if (-not $w) { return @{ ok = $false; error = 'game_not_running' } }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $pages = 0
    $pageKey = $null; $pageSince = Get-Date; $lastPress = [datetime]::MinValue
    $freeSince = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        $s = Get-LastSample
        if (-not $s) { continue }
        foreach ($kind in 'select', 'multiple') {
            $c = $s.choice.$kind
            if ($c -and $c.open) { return @{ ok = $true; stop = 'choice'; kind = $kind; options = $c.options; pages = $pages } }
        }
        if ($s.battle -and $s.battle.active) { return @{ ok = $true; stop = 'battle'; pages = $pages } }
        if ($s.dialog -and $s.dialog.open) {
            $freeSince = $null
            $key = "$($s.dialog.page)|$($s.dialog.lines -join '/')"
            if ($key -ne $pageKey) { $pageKey = $key; $pageSince = Get-Date }
            $sincePage = ((Get-Date) - $pageSince).TotalMilliseconds
            $sincePress = ((Get-Date) - $lastPress).TotalMilliseconds
            # Read for PageMs; if Enter only finished the typewriter, press again a bit later.
            if ($sincePage -ge $PageMs -and $sincePress -ge [Math]::Max(1500, $PageMs / 2)) {
                $blocker = Get-ButtonBlocker $w
                if ($blocker) { return @{ ok = $false; error = $blocker; pages = $pages } }
                Press-Button 'Enter' 70
                $lastPress = Get-Date
                $pages++
            }
            continue
        }
        # Shop and menu screens are not dialogs; hand them back instead of waiting them out.
        if ($s.scene.state -in 'Shop', 'Menu', 'ChangeName') {
            return @{ ok = $true; stop = "state:$($s.scene.state)"; pages = $pages }
        }
        if ($s.scene.state -eq 'Player') {
            if (-not $freeSince) { $freeSince = Get-Date }
            if (((Get-Date) - $freeSince).TotalMilliseconds -ge 2000) {
                return @{ ok = $true; stop = 'free'; pages = $pages; map = $s.user.mapId; cell = $s.field.cell }
            }
        } else {
            $freeSince = $null
        }
    }
    @{ ok = $false; error = 'timeout'; pages = $pages }
}

function Invoke-PilotCommand($cmd, [string]$Id) {
    switch ($cmd.op) {
        'status' { return Get-Status }
        'focus' {
            $w = Get-GameWindow
            if (-not $w) { return @{ ok = $false; error = 'game_not_running' } }
            if ([FfprInput]::IsIconic($w.hwnd)) { [void][FfprInput]::ShowWindow($w.hwnd, 9) }
            [void][FfprInput]::SetForegroundWindow($w.hwnd)
            Start-Sleep -Milliseconds 200
            return Get-Status
        }
        'keys' {
            $gap = if ($cmd.gap) { [int]$cmd.gap } else { 120 }
            $result = Invoke-Keys @($cmd.keys) $gap
            if ($result.ok -and $cmd.shot) {
                if ($cmd.wait) { Start-Sleep -Milliseconds ([int]$cmd.wait) }
                $shot = Save-Shot $Id ([int]$cmd.maxWidth)
                foreach ($k in $shot.Keys) { if ($k -ne 'ok') { $result[$k] = $shot[$k] } }
            }
            return $result
        }
        'shot' { return Save-Shot $Id ([int]$cmd.maxWidth) }
        'pos' { return @{ ok = $true; pos = (Get-Position) } }
        'route' {
            $fields = @{ to = @([int]$cmd.to[0], [int]$cmd.to[1]) }
            if ($null -ne $cmd.collision) { $fields.collision = [bool]$cmd.collision }
            return @{ ok = $true; route = (Invoke-Bridge 'route' $fields).route }
        }
        'collision' { return @{ ok = $true; collision = (Invoke-Bridge 'collision').collision } }
        'bridge' {
            # Any bridge query: {"op": "bridge", "q": "items", ...fields}; returns the reply.
            $fields = @{}
            foreach ($prop in $cmd.PSObject.Properties) {
                if ($prop.Name -notin 'op', 'q') { $fields[$prop.Name] = $prop.Value }
            }
            return @{ ok = $true; reply = (Invoke-Bridge ([string]$cmd.q) $fields) }
        }
        'entities' {
            $fields = @{ max = $(if ($cmd.max) { [int]$cmd.max } else { 200 }) }
            if ($cmd.kind) { $fields.kind = [string]$cmd.kind }
            return @{ ok = $true; entities = (Invoke-Bridge 'entities' $fields).entities }
        }
        'cells' {
            $r = if ($cmd.r) { [int]$cmd.r } else { 8 }
            return @{ ok = $true; cells = (Invoke-Bridge 'cells' @{ r = $r }).cells }
        }
        'walk' {
            $timeout = if ($cmd.timeout) { [int]$cmd.timeout } else { 15000 }
            return Invoke-Walk ([int]$cmd.to[0]) ([int]$cmd.to[1]) $timeout
        }
        'story' {
            $page = if ($cmd.pageMs) { [int]$cmd.pageMs } else { 3000 }
            $timeout = if ($cmd.timeout) { [int]$cmd.timeout } else { 600000 }
            return Invoke-Story $page $timeout
        }
        'leave' { return Invoke-Leave }
        'battle' {
            $timeout = if ($cmd.timeout) { [int]$cmd.timeout } else { 180000 }
            $every = if ($cmd.every) { [int]$cmd.every } else { 300 }
            return Invoke-Battle $timeout $every
        }
        'wait' {
            $timeout = if ($cmd.timeout) { [int]$cmd.timeout } else { 60000 }
            return Wait-Free $timeout
        }
        'quit' { return @{ ok = $true; quitting = $true } }
        default { return @{ ok = $false; error = "unknown_op:$($cmd.op)" } }
    }
}

Write-Utf8NoBom (Join-Path $dir 'agent.json') (@{ pid = $PID; game = $Game; started = (Get-Date).ToString('o') } |
    ConvertTo-Json -Compress)
if ($KeepAwake) {
    # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, for as long as this process runs.
    [void][FfprInput]::SetThreadExecutionState(0x80000003)
}
$lastActive = Get-Date
while (((Get-Date) - $lastActive).TotalMinutes -lt $IdleMinutes) {
    $pending = @(Get-ChildItem -Path $dir -Filter '*.cmd.json' | Sort-Object Name)
    if (-not $pending) {
        Start-Sleep -Milliseconds 40
        continue
    }
    foreach ($f in $pending) {
        $lastActive = Get-Date
        $id = $f.Name -replace '\.cmd\.json$', ''
        $cmd = $null
        try {
            $cmd = Get-Content -Path $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            $result = Invoke-PilotCommand $cmd $id
        } catch {
            $result = @{ ok = $false; error = $_.Exception.Message }
        }
        Remove-Item -Path $f.FullName -Force
        $result.id = $id
        $result.time = (Get-Date).ToString('o')
        $tmp = Join-Path $dir "$id.result.tmp"
        Write-Utf8NoBom $tmp ($result | ConvertTo-Json -Compress -Depth 10)
        Move-Item -Path $tmp -Destination (Join-Path $dir "$id.result.json") -Force
        if ($cmd -and $cmd.op -eq 'quit') {
            Remove-Item -Path (Join-Path $dir 'agent.json') -Force -ErrorAction SilentlyContinue
            exit 0
        }
    }
}
Remove-Item -Path (Join-Path $dir 'agent.json') -Force -ErrorAction SilentlyContinue

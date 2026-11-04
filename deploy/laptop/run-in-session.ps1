# 由计划任务 FFPR-Agent-Session 在你的桌面会话里运行。
# 读取开发机写好的 C:\ffpr\session\request.json,执行其中的程序,把状态写到 <id>.status.json。
#
# request.json 的字段:
#   id          本次请求的编号,开发机据此找到状态文件
#   file        要启动的程序、脚本或 URL(例如 steam://rungameid/1173810)
#   args        参数数组,可选
#   cwd         工作目录,可选
#   wait        为 true 时等程序结束,记录退出码和输出
#   visible     为 true 时用 Start-Process 启动并保留窗口(确实要窗口的程序),可选
#
# 2026-11-02 起,用 Steam URL 启动游戏时不再最小化窗口,窗口出现后就留在前台。
# 一次最多开一作:别的作品开着时状态文件的 state 是 refused,带 running(正在运行的
# 作品键)和 note(给用户看的中文说明);要启动的这一作已经开着时 state 是 started,
# 带 already 和 note。foreground 字段不再有用,读到也忽略。
#
# 2026-10-29: Windows 11's default terminal is Windows Terminal, which ignores
# `powershell.exe -WindowStyle Hidden`. Every child program started with Start-Process opened a
# console window and left it there. Non-URL launches now go through ProcessStartInfo with
# CreateNoWindow; `visible: true` keeps the old Start-Process path for programs that need one.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FfprCommon.psm1') -Force

$dir = Join-Path (Get-FfprRoot) 'session'
$req = Get-Content (Join-Path $dir 'request.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$statusPath = Join-Path $dir "$($req.id).status.json"

function Save-Status([hashtable]$Status) {
    $Status.id = $req.id
    $Status.time = (Get-Date).ToString('o')
    Write-Utf8NoBom $statusPath ($Status | ConvertTo-Json -Compress)
}

Save-Status @{ state = 'running' }
try {
    # URL launches (steam://...) hand off to an already running program; there is no process
    # to track, and -PassThru behaves inconsistently for them on Windows PowerShell 5.1.
    if ($req.file -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        # steam://rungameid/<AppId>: AppId -> game. The launch rules live in FfprCommon.psm1
        # (Start-Game, 0.12.0), shared with launch-game.ps1.
        $game = $null
        if ($req.file -match 'rungameid/(\d+)') {
            $game = Get-GameByAppId ([int]$matches[1])
        }
        if ($game) {
            Save-Status (Start-Game $game)
            return
        }
        # Not one of the six games: start it and return, as before.
        Start-Process -FilePath $req.file
        Save-Status @{ state = 'started' }
        return
    }
    $wait = [bool]($req.PSObject.Properties['wait'] -and $req.wait)
    $visible = [bool]($req.PSObject.Properties['visible'] -and $req.visible)
    $outLog = Join-Path $dir "$($req.id).out.log"
    $errLog = Join-Path $dir "$($req.id).err.log"

    # Escape hatch: a program that genuinely needs a window keeps the old behaviour.
    if ($visible) {
        $params = @{ FilePath = $req.file; PassThru = $true }
        if ($req.PSObject.Properties['args'] -and $req.args) {
            $params.ArgumentList = ConvertTo-CommandLine @($req.args)
        }
        if ($req.PSObject.Properties['cwd'] -and $req.cwd) { $params.WorkingDirectory = $req.cwd }
        if ($wait) {
            $params.RedirectStandardOutput = $outLog
            $params.RedirectStandardError = $errLog
        }
        $proc = Start-Process @params
        # Windows PowerShell 5.1 reports ExitCode as null unless the handle was opened before exit.
        $null = $proc.Handle
        if ($wait) {
            $proc.WaitForExit()
            Save-Status @{ state = 'done'; pid = $proc.Id; exit_code = $proc.ExitCode }
        } else {
            Save-Status @{ state = 'started'; pid = $proc.Id }
        }
        return
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $req.file
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($req.PSObject.Properties['args'] -and $req.args) {
        $psi.Arguments = ConvertTo-CommandLine @($req.args)
    }
    if ($req.PSObject.Properties['cwd'] -and $req.cwd) { $psi.WorkingDirectory = $req.cwd }
    if ($wait) {
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
    }
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    if (-not $proc.Start()) { throw "启动失败:$($req.file)" }
    if ($wait) {
        # Drain both pipes concurrently. Reading one stream to the end before touching the
        # other deadlocks once the unread pipe's buffer fills (2026-10-29).
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $proc.WaitForExit()
        # .Result also waits for the async reads to finish before the files are written.
        $stdout = $outTask.Result
        $stderr = $errTask.Result
        Write-Utf8NoBom $outLog $stdout
        Write-Utf8NoBom $errLog $stderr
        Save-Status @{ state = 'done'; pid = $proc.Id; exit_code = $proc.ExitCode }
    } else {
        Save-Status @{ state = 'started'; pid = $proc.Id }
    }
} catch {
    Save-Status @{ state = 'error'; error = $_.Exception.Message }
}

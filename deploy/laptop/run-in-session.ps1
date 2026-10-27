# 由计划任务 FFPR-Agent-Session 在你的桌面会话里运行。
# 读取开发机写好的 C:\ffpr\session\request.json,执行其中的程序,把状态写到 <id>.status.json。
#
# request.json 的字段:
#   id    本次请求的编号,开发机据此找到状态文件
#   file  要启动的程序、脚本或 URL(例如 steam://rungameid/1173810)
#   args  参数数组,可选
#   cwd   工作目录,可选
#   wait  为 true 时等程序结束,记录退出码和输出
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
        Start-Process -FilePath $req.file
        Save-Status @{ state = 'started' }
        return
    }
    $params = @{ FilePath = $req.file; PassThru = $true }
    if ($req.PSObject.Properties['args'] -and $req.args) {
        $params.ArgumentList = ConvertTo-CommandLine @($req.args)
    }
    if ($req.PSObject.Properties['cwd'] -and $req.cwd) { $params.WorkingDirectory = $req.cwd }
    $wait = [bool]($req.PSObject.Properties['wait'] -and $req.wait)
    if ($wait) {
        $params.RedirectStandardOutput = Join-Path $dir "$($req.id).out.log"
        $params.RedirectStandardError = Join-Path $dir "$($req.id).err.log"
        $params.WindowStyle = 'Hidden'
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
} catch {
    Save-Status @{ state = 'error'; error = $_.Exception.Message }
}

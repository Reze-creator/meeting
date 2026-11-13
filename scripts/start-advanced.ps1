# 一条命令启动本机进阶演示：隐藏媒体服务窗口，应用保持前台，退出时清理本脚本的子进程。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectRoot 'bin\livekit\livekit-server.exe'
$mediaProcess = $null
$previousVariables = @{}
foreach ($key in @('LIVEKIT_URL', 'LIVEKIT_INTERNAL_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')) {
    $previousVariables[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath $executable)) { & (Join-Path $PSScriptRoot 'install-livekit.ps1') }
    $probe = [Net.Sockets.TcpClient]::new()
    try { $alreadyRunning = $probe.ConnectAsync('127.0.0.1', 7880).Wait(300) -and $probe.Connected }
    catch { $alreadyRunning = $false }
    finally { $probe.Dispose() }
    if ($alreadyRunning) { throw '7880 端口正在使用。若已启动自己的 LiveKit，请按 docs/进阶档.md 配置后运行 start.ps1。' }
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'data') | Out-Null
    $mediaProcess = Start-Process -FilePath $executable -ArgumentList @('--config', 'deploy/livekit.local.yaml') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'data\livekit.stdout.log') -RedirectStandardError (Join-Path $projectRoot 'data\livekit.stderr.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $mediaProcess.Refresh()
        if ($mediaProcess.HasExited) { throw 'LiveKit 启动失败，请查看 data/livekit.stderr.log' }
        try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:7880' -TimeoutSec 1; $ready = $true; break }
        catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $ready) { throw 'LiveKit 未在预期时间内启动，请检查端口和日志' }
    $env:LIVEKIT_URL = 'ws://127.0.0.1:7880'
    $env:LIVEKIT_INTERNAL_URL = 'http://127.0.0.1:7880'
    $env:LIVEKIT_API_KEY = 'devkey'
    $env:LIVEKIT_API_SECRET = 'secret'
    & (Join-Path $PSScriptRoot 'start.ps1')
} finally {
    if ($mediaProcess) {
        $mediaProcess.Refresh()
        if (-not $mediaProcess.HasExited) { Stop-Process -Id $mediaProcess.Id }
    }
    foreach ($key in $previousVariables.Keys) { [Environment]::SetEnvironmentVariable($key, $previousVariables[$key], 'Process') }
    Pop-Location
}

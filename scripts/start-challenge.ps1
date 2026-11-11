# 完整本机演示：本地 STT + LiveKit + Go/React。所有子进程退出时由本脚本清理。
param([string]$Model = 'small')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sttProcess = $null
$previousURL, $previousModel = $env:STT_BASE_URL, $env:WHISPER_MODEL
Push-Location -LiteralPath $projectRoot
try {
    $probe = [Net.Sockets.TcpClient]::new()
    try { $occupied = $probe.ConnectAsync('127.0.0.1',8091).Wait(300) -and $probe.Connected }
    catch { $occupied = $false }
    finally { $probe.Dispose() }
    if ($occupied) { throw '8091 已被占用；已有 STT 时请按 docs/挑战档.md 分步启动。' }
    $python = Join-Path $projectRoot '.venv-stt\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) {
        python -m venv .venv-stt
        if ($LASTEXITCODE -ne 0) { throw '需要 Python 3.11–3.13 环境' }
    }
    & $python -m pip install -r services/stt/requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'STT 依赖安装失败' }
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'data') | Out-Null
    $env:WHISPER_MODEL = $Model
    $env:STT_BASE_URL = 'http://127.0.0.1:8091/v1'
    $sttProcess = Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','services.stt.app:app','--host','127.0.0.1','--port','8091','--no-access-log') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'data\stt.stdout.log') -RedirectStandardError (Join-Path $projectRoot 'data\stt.stderr.log')
    Write-Host '正在准备本地 STT 模型。首次下载可能耗时数分钟，日志位于 data/stt.stderr.log。'
    $ready = $false
    for ($attempt=0; $attempt -lt 600; $attempt++) {
        $sttProcess.Refresh()
        if ($sttProcess.HasExited) { throw 'STT 启动失败，请查看 data/stt.stderr.log' }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 1
            if ($health.ready) { $ready=$true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'STT 模型未就绪；请检查模型下载网络，或用 start-stt.ps1 单独排查' }
    & (Join-Path $PSScriptRoot 'start-advanced.ps1')
} finally {
    if ($sttProcess) { $sttProcess.Refresh(); if (-not $sttProcess.HasExited) { Stop-Process -Id $sttProcess.Id } }
    $env:STT_BASE_URL, $env:WHISPER_MODEL = $previousURL, $previousModel
    Pop-Location
}

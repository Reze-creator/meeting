# 本地 CPU 语音识别，不需要云端 STT 密钥。首次加载模型需要网络和磁盘空间。
param([string]$Model = 'small', [int]$Port = 8091)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $python = Join-Path $projectRoot '.venv-stt\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) {
        python -m venv .venv-stt
        if ($LASTEXITCODE -ne 0) { throw '请先安装 Python 3.11–3.13，并确认 python 命令可用' }
    }
    & $python -m pip install -r services/stt/requirements.txt
    if ($LASTEXITCODE -ne 0) { throw '本地 STT 依赖安装失败' }
    $previousModel = $env:WHISPER_MODEL
    try {
        $env:WHISPER_MODEL = $Model
        & $python -m uvicorn services.stt.app:app --host 127.0.0.1 --port $Port --no-access-log
        if ($LASTEXITCODE -ne 0) { throw 'STT 服务退出，请检查模型下载和端口' }
    } finally { $env:WHISPER_MODEL = $previousModel }
} finally { Pop-Location }

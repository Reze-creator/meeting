# 本机开发专用：仅绑定 loopback。正式部署应使用独立随机密钥、HTTPS 与正确的公网 ICE 地址。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectRoot 'bin\livekit\livekit-server.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw '请先运行 .\scripts\install-livekit.ps1' }
Push-Location -LiteralPath $projectRoot
try {
    & $executable --config deploy/livekit.local.yaml
    if ($LASTEXITCODE -ne 0) { throw 'LiveKit 服务退出异常' }
} finally { Pop-Location }

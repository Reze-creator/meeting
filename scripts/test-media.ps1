# 先启动本机 LiveKit，再执行不使用真实设备的 WebRTC 集成测试。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previous = $env:LIVEKIT_TEST_URL
Push-Location -LiteralPath $projectRoot
try {
    if (-not $env:LIVEKIT_TEST_URL) { $env:LIVEKIT_TEST_URL = 'http://127.0.0.1:7880' }
    go test -tags integration ./internal/media -run TestLiveKitRealMediaAndModeration -count=1 -timeout=90s
    if ($LASTEXITCODE -ne 0) { throw '真实 SFU 媒体集成测试失败' }
} finally { $env:LIVEKIT_TEST_URL = $previous; Pop-Location }

# 执行三档常规质量检查；真实媒体/模型测试由 test-media.ps1、test-intelligence.ps1 单独执行。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    go test ./... -count=1
    if ($LASTEXITCODE -ne 0) { throw 'Go 测试失败' }
    go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go 静态检查失败' }
    Push-Location -LiteralPath (Join-Path $projectRoot 'web')
    try {
        foreach ($taskName in @('format:check', 'lint', 'build')) {
            npm.cmd run $taskName
            if ($LASTEXITCODE -ne 0) { throw "前端检查失败：$taskName" }
        }
    } finally { Pop-Location }
} finally { Pop-Location }

# 执行基础档的自动化质量检查；任一检查失败时立即退出。
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
        foreach ($taskName in @('format:check', 'lint', 'test', 'build')) {
            npm.cmd run $taskName
            if ($LASTEXITCODE -ne 0) { throw "前端检查失败：$taskName" }
        }
    } finally { Pop-Location }
} finally { Pop-Location }

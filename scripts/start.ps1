# 从项目根目录启动生产构建；保持前台运行以便 Ctrl+C 正常关闭房间和数据库。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    go mod download
    if ($LASTEXITCODE -ne 0) { throw 'Go 依赖安装失败' }
    Push-Location -LiteralPath (Join-Path $projectRoot 'web')
    try {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw '前端依赖安装失败' }
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
    } finally { Pop-Location }
    go run ./cmd/server
    if ($LASTEXITCODE -ne 0) { throw '服务启动失败' }
} finally { Pop-Location }

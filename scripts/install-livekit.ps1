# 固定版本并校验官方 SHA256 清单；只安装到项目 bin，不修改 PATH 或系统配置。
param([string]$Version = '1.13.11')
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw '版本号格式应为 x.y.z' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $projectRoot 'bin\livekit'
$architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$assetName = "livekit_${Version}_windows_${architecture}.zip"
$releaseUrl = "https://github.com/livekit/livekit/releases/download/v$Version"
$temporaryRoot = Join-Path $projectRoot ('bin\livekit-download-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
try {
    $archivePath = Join-Path $temporaryRoot $assetName
    Invoke-WebRequest -Uri "$releaseUrl/$assetName" -OutFile $archivePath
    $checksums = (Invoke-WebRequest -Uri "$releaseUrl/checksums.txt").Content
    if ($checksums -is [byte[]]) { $checksums = [System.Text.Encoding]::UTF8.GetString($checksums) }
    $line = $checksums -split "`n" | Where-Object { $_.Trim().EndsWith($assetName) }
    if (@($line).Count -ne 1) { throw '官方清单未找到唯一的安装包校验值' }
    $expected = ($line.Trim() -split '\s+')[0]
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($expected -ne $actual) { throw 'LiveKit 安装包 SHA256 校验失败' }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $destination -Force
    Write-Host "LiveKit $Version 已安装至 $destination"
} finally {
    # 临时目录是本脚本在 bin 中创建的唯一 GUID 路径，校验后再清理。
    $resolvedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'bin')) + [IO.Path]::DirectorySeparatorChar
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
    if ($resolvedTemporary.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
}

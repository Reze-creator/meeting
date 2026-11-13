# 直接使用实际 PowerShell 引擎解析脚本，防止中文编码或新语法破坏 Windows 5.1 兼容性。
$ErrorActionPreference = 'Stop'
$scriptDirectory = $PSScriptRoot
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell)) { throw '未找到 Windows PowerShell 5.1，无法执行兼容性检查' }
$previousRoot = $env:COMEET_SCRIPT_TEST_ROOT
try {
    $env:COMEET_SCRIPT_TEST_ROOT = $scriptDirectory
    # EncodedCommand 使用 UTF-16LE，避免外层 shell 的代码页影响检查命令本身。
    $source = @'
$ProgressPreference = 'SilentlyContinue'
$failed = $false
Get-ChildItem -LiteralPath $env:COMEET_SCRIPT_TEST_ROOT -Filter '*.ps1' | ForEach-Object {
    $bytes = [IO.File]::ReadAllBytes($_.FullName)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) {
        Write-Output ('Missing UTF-8 BOM: ' + $_.Name)
        $failed = $true
    }
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in $parseErrors) {
        Write-Output ($_.Name + ': ' + $parseError.Message)
        $failed = $true
    }
}
if ($failed) { exit 1 }
Write-Output 'Windows PowerShell 5.1: all scripts parsed successfully (UTF-8 BOM).'
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
    & $windowsPowerShell -NoProfile -NonInteractive -EncodedCommand $encoded
    if ($LASTEXITCODE -ne 0) { throw 'PowerShell 脚本兼容性检查失败' }
} finally { $env:COMEET_SCRIPT_TEST_ROOT = $previousRoot }

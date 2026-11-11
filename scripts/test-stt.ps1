# 使用 Windows TTS 生成中文测试语音，仅向指定本机 STT 发送合成测试资料。
param([string]$BaseURL = 'http://127.0.0.1:8091/v1')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path $projectRoot ('data\stt-smoke-' + [guid]::NewGuid().ToString('N') + '.wav')
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $scratch) | Out-Null
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $voice.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
    $voice.SetOutputToWaveFile($scratch, $format)
    $voice.Speak('我们决定周五验收项目，小王负责补充测试。')
    $voice.SetOutputToNull()
    & (Join-Path $projectRoot '.venv-stt\Scripts\python.exe') (Join-Path $projectRoot 'services\stt\smoke_test.py') --url $BaseURL --wav $scratch --language zh
    if ($LASTEXITCODE -ne 0) { throw '真实 STT 测试失败' }
} finally {
    $voice.Dispose()
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch }
}

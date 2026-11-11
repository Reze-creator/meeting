# 固定合成会议资料调用真实本地 STT 与 DeepSeek，不读取用户会议，也不采集麦克风。
# 本脚本的 DeepSeek 请求会产生少量模型调用费用。
param([string]$STTBaseURL = 'http://127.0.0.1:8091/v1')
$ErrorActionPreference = 'Stop'
if (-not $env:DEEPSEEK_API_KEY) { throw '请先在当前终端设置 DEEPSEEK_API_KEY（不要把密钥发到聊天或提交 Git）' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path $projectRoot ('data\intelligence-smoke-' + [guid]::NewGuid().ToString('N') + '.wav')
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $scratch) | Out-Null
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$previousWav, $previousURL = $env:COMEET_TEST_WAV, $env:COMEET_TEST_STT_URL
Push-Location -LiteralPath $projectRoot
try {
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $voice.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
    $voice.SetOutputToWaveFile($scratch, $format)
    $voice.Speak('我们决定周五验收项目，小王负责补充测试。')
    $voice.SetOutputToNull()
    # SAPI 可能生成额外 WAV 区块，规范为与浏览器相同的 44 字节 PCM 容器头。
    & (Join-Path $projectRoot '.venv-stt\Scripts\python.exe') -c 'import sys,wave; p=sys.argv[1]; r=wave.open(p,"rb"); frames=r.readframes(r.getnframes()); r.close(); w=wave.open(p,"wb"); w.setparams((1,2,16000,0,"NONE","not compressed")); w.writeframes(frames); w.close()' $scratch
    if ($LASTEXITCODE -ne 0) { throw '合成音频规范化失败' }
    $env:COMEET_TEST_WAV=$scratch
    $env:COMEET_TEST_STT_URL=$STTBaseURL
    go test -tags intelligence_integration ./internal/server -run TestRealSpeechToMinutesWorkflow -count=1 -v
    if ($LASTEXITCODE -ne 0) { throw '真实字幕与纪要集成测试失败' }
} finally {
    $env:COMEET_TEST_WAV=$previousWav
    $env:COMEET_TEST_STT_URL=$previousURL
    $voice.Dispose()
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch }
    Pop-Location
}

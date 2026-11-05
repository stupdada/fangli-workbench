param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$request = Get-Content -LiteralPath $RequestPath -Encoding UTF8 -Raw | ConvertFrom-Json
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | ForEach-Object { $_.VoiceInfo.Name })
    if ($request.operation -eq 'health') {
        @{ provider='windows-system-speech'; voices=$voices; defaultVoice='Microsoft Huihui Desktop' } | ConvertTo-Json -Compress
        exit 0
    }
    if ($request.voice -notin $voices) { throw '所选普通话音色不可用' }
    $synth.SelectVoice($request.voice)
    $synth.Rate = -1
    foreach ($segment in $request.segments) {
        $synth.SetOutputToWaveFile($segment.output)
        $synth.Speak([string]$segment.text)
        $synth.SetOutputToNull()
    }
    @{provider='windows-system-speech'; voice=$request.voice; actualTtsSegments=$request.segments.Count; rate=-1} | ConvertTo-Json -Compress
} finally { $synth.Dispose() }

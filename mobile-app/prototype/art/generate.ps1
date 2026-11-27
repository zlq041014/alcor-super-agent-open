#Requires -Version 5.1
# 按 manifest.json 调用本机 D:\apps\gpt-image\gen-image.ps1 生成原型美术素材。
# 凭据由 gen-image.ps1 自行从 D:\apps\key 读取；本脚本不读取、不输出任何 key。
param(
  [string[]] $Only = @(),
  [switch] $Force
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$gen = 'D:\apps\gpt-image\gen-image.ps1'
$rawDir = Join-Path $here 'raw'
$tmpDir = Join-Path $here 'raw\_tmp'
$log = Join-Path $here 'generation-log.jsonl'
New-Item -ItemType Directory -Force -Path $rawDir, $tmpDir | Out-Null

$m = Get-Content (Join-Path $here 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($it in $m.items) {
  if ($Only.Count -and $Only -notcontains $it.name) { continue }
  $out = Join-Path $rawDir "$($it.name).png"
  if ((Test-Path $out) -and -not $Force) { Write-Output "[SKIP] $($it.name)"; continue }
  $prompt = if ($it.full) { $it.prompt } else { "$($it.prompt) $($m.style)" }
  $ok = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
    $start = Get-Date
    $err = $null
    try {
      $saved = & $gen $prompt -Model $m.model -Quality high -OutDir $tmpDir -WarningAction SilentlyContinue 6>$null
      $file = @($saved | Where-Object { $_.Path })[0]
      if ($file) { Move-Item -Force $file.Path $out; $ok = $true }
    } catch { $err = ($_.Exception.Message -replace 'sk-\S+', 'sk-***') }
    $rec = [ordered]@{
      ts = (Get-Date).ToString('o'); name = $it.name; model = $m.model; attempt = $attempt; ok = $ok
      elapsedSec = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
      size = if ($ok) { $file.Size } else { $null }; error = $err
    }
    ($rec | ConvertTo-Json -Compress) | Add-Content -Path $log -Encoding UTF8
    Write-Output ("[{0}] {1} attempt {2} {3}s {4}" -f ($(if ($ok) { 'OK' } else { 'FAIL' })), $it.name, $attempt, $rec.elapsedSec, $err)
  }
}
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
Write-Output '[DONE]'

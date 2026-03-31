###############################################################################
# setup-whisper.ps1
#
# Chỉ tải về whisper.cpp binary + model về máy.
# Sau khi chạy xong, dùng start-whisper.ps1 để khởi động server.
#
# Usage:
#   .\setup-whisper.ps1                     # tải base model
#   .\setup-whisper.ps1 -ModelSize small    # tải small model
###############################################################################

param(
    [ValidateSet('tiny','tiny.en','base','base.en','small','small.en','medium','medium.en')]
    [string]$ModelSize = 'base'
)

$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $PSScriptRoot 'whisper-bin'
$ModelsDir  = Join-Path $PSScriptRoot 'whisper-models'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "    FAIL: $msg" -ForegroundColor Red; exit 1 }

# ──────────────────────────────────────────────────────────────────────────────
# 0. Verify whisper-server.exe already exists when -StartOnly
# ──────────────────────────────────────────────────────────────────────────────
$serverExe = Join-Path $InstallDir 'whisper-server.exe'

if (-not $StartOnly) {

  # ── 1. Fetch latest release metadata from GitHub ──────────────────────────
  Write-Step "Fetching latest whisper.cpp release info from GitHub…"
  try {
    $release = Invoke-RestMethod `
      -Uri 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest' `
      -Headers @{ 'User-Agent' = 'TransOverlay-Setup' }
  } catch {
    Write-Fail "GitHub API call failed: $_"
  }

  $tag = $release.tag_name
  Write-OK "Latest release: $tag"

  # Prefer whisper-blas-bin-x64.zip (OpenBLAS, better CPU perf), then plain x64
  $asset = $release.assets | Where-Object {
    $_.name -match 'blas' -and $_.name -match 'x64' -and $_.name -match '\.zip$' -and $_.name -notmatch 'cublas'
  } | Select-Object -First 1

  if (-not $asset) {
    # Plain CPU x64 build
    $asset = $release.assets | Where-Object {
      $_.name -match '^whisper-bin-x64\.zip$'
    } | Select-Object -First 1
  }

  if (-not $asset) {
    # Last resort: any x64 zip without cublas
    $asset = $release.assets | Where-Object {
      $_.name -match 'x64' -and $_.name -match '\.zip$' -and $_.name -notmatch 'cublas'
    } | Select-Object -First 1
  }

  if (-not $asset) {
    Write-Host "`nAvailable assets:" -ForegroundColor Yellow
    $release.assets | ForEach-Object { Write-Host "  $($_.name)" }
    Write-Fail "Could not find a Windows binary ZIP in the release. Download manually from: https://github.com/ggerganov/whisper.cpp/releases"
  }

  Write-OK "Asset: $($asset.name)  ($([math]::Round($asset.size/1MB,1)) MB)"

  # ── 2. Download + extract binary ─────────────────────────────────────────
  Write-Step "Downloading whisper.cpp binary…"
  $zipPath = Join-Path $env:TEMP 'whisper-bin.zip'

  Invoke-WebRequest `
    -Uri $asset.browser_download_url `
    -OutFile $zipPath `
    -UseBasicParsing

  Write-OK "Downloaded to $zipPath"

  Write-Step "Extracting to $InstallDir…"
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force

  # whisper-server.exe may be nested; find it
  $found = Get-ChildItem -Path $InstallDir -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
  if (-not $found) {
    Write-Host "`nFiles in extracted archive:" -ForegroundColor Yellow
    Get-ChildItem -Path $InstallDir -Recurse | ForEach-Object { Write-Host "  $($_.FullName)" }
    Write-Fail "whisper-server.exe not found in the downloaded archive."
  }

  # Move everything to $InstallDir root if nested (so-sánh path chuẩn hóa)
  $foundDir  = $found.DirectoryName.TrimEnd('\').ToLower()
  $targetDir = $InstallDir.TrimEnd('\').ToLower()
  if ($foundDir -ne $targetDir) {
    Get-ChildItem -Path $found.DirectoryName | Move-Item -Destination $InstallDir -Force
  }

  $serverExe = Join-Path $InstallDir 'whisper-server.exe'
  Write-OK "whisper-server.exe ready at $serverExe"

  # ── 3. Download model ─────────────────────────────────────────────────────
  Write-Step "Downloading model: ggml-${ModelSize}.bin from Hugging Face…"

  if (-not (Test-Path $ModelsDir)) { New-Item -ItemType Directory -Path $ModelsDir | Out-Null }

  $modelFile = Join-Path $ModelsDir "ggml-${ModelSize}.bin"

  if (Test-Path $modelFile) {
    Write-OK "Model already exists, skipping download: $modelFile"
  } else {
    $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${ModelSize}.bin"
    Write-Host "    URL: $modelUrl" -ForegroundColor DarkGray
    Write-Host "    (Dùng WebClient để xử lý đúng CDN redirect của HuggingFace)" -ForegroundColor DarkGray

    # Invoke-WebRequest -UseBasicParsing không xử lý đúng HuggingFace XetHub CDN
    # → dùng .NET WebClient thay thế để tải toàn bộ file
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add('User-Agent', 'Mozilla/5.0')
    $wc.DownloadFile($modelUrl, $modelFile)

    $sizeMB = [math]::Round((Get-Item $modelFile).Length / 1MB, 1)
    Write-OK "Model saved: $modelFile  (${sizeMB} MB)"
  }

}

# ── Tóm tắt ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Tải về hoàn tất!" -ForegroundColor Green
Write-Host "  Binary : $serverExe" -ForegroundColor Green
Write-Host "  Model  : $(Join-Path $ModelsDir "ggml-${ModelSize}.bin")" -ForegroundColor Green
Write-Host ""
Write-Host "  Để khởi động server, chạy:" -ForegroundColor Yellow
Write-Host "    .\start-whisper.ps1" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Green

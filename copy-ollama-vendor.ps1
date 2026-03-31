###############################################################################
# copy-ollama-vendor.ps1
#
# Sao chép ollama.exe vào vendor/ollama/ để đóng gói cùng installer.
# Chạy một lần trước khi build: npm run prepare-vendor
###############################################################################

$ErrorActionPreference = 'Stop'

$vendorDir = Join-Path $PSScriptRoot 'vendor\ollama'
$destExe   = Join-Path $vendorDir 'ollama.exe'

# --- Tìm ollama.exe trên máy --------------------------------------------------
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
    (Join-Path $env:LOCALAPPDATA 'Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles  'Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles  'Ollama\ollama app.exe'),
    (Get-Command ollama -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
)

$srcExe = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $srcExe = $c; break }
}

if (-not $srcExe) {
    Write-Error @"
❌  Không tìm thấy ollama.exe trên máy này.
    Hãy cài Ollama từ https://ollama.com/download rồi chạy lại script này.
"@
    exit 1
}

Write-Host "✔  Tìm thấy: $srcExe" -ForegroundColor Green

# --- Sao chép ----------------------------------------------------------------
if (-not (Test-Path $vendorDir)) {
    New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
}

Copy-Item -Path $srcExe -Destination $destExe -Force
$size = (Get-Item $destExe).Length / 1MB
Write-Host "✔  Đã sao chép → $destExe  ($([math]::Round($size,1)) MB)" -ForegroundColor Green
Write-Host ""
Write-Host "Bây giờ bạn có thể build:" -ForegroundColor Cyan
Write-Host "   npm run build" -ForegroundColor Cyan

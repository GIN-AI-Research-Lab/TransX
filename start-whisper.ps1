###############################################################################
# start-whisper.ps1
#
# Khởi động whisper-server HTTP tại localhost:8080
# Chạy script này trong một terminal riêng (giữ cửa sổ mở).
#
# Usage:
#   .\start-whisper.ps1                      # dùng model base, port 8080
#   .\start-whisper.ps1 -ModelSize small     # dùng model nhỏ hơn
#   .\start-whisper.ps1 -Port 9090           # đổi port
#   .\start-whisper.ps1 -Language vi         # tiếng Việt (bỏ qua auto-detect)
###############################################################################

param(
    [ValidateSet('tiny','tiny.en','base','base.en','small','small.en','medium','medium.en')]
    [string]$ModelSize = 'base',

    [int]$Port = 8080,

    [string]$Language = '',       # để trống = auto-detect

    [switch]$Vad                  # bật Voice Activity Detection
)

$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $PSScriptRoot 'whisper-bin'
$ModelsDir  = Join-Path $PSScriptRoot 'whisper-models'

$serverExe = Join-Path $InstallDir 'whisper-server.exe'
$modelFile = Join-Path $ModelsDir "ggml-${ModelSize}.bin"

# ── Kiểm tra file tồn tại ────────────────────────────────────────────────────
if (-not (Test-Path $serverExe)) {
    Write-Host "LỖOI: Không tìm thấy whisper-server.exe" -ForegroundColor Red
    Write-Host "      Hãy chạy .\setup-whisper.ps1 trước." -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path $modelFile)) {
    Write-Host "LỖOI: Không tìm thấy model: $modelFile" -ForegroundColor Red
    Write-Host "      Hãy chạy .\setup-whisper.ps1 -ModelSize $ModelSize trước." -ForegroundColor Yellow
    exit 1
}

# ── Xây dựng danh sách tham số ───────────────────────────────────────────────
$args_list = @(
    '-m',     $modelFile,
    '--host', '127.0.0.1',
    '--port', $Port
    # Không dùng --convert (cần ffmpeg phía server)
    # App đã convert audio sang WAV ở phía client (AudioCapture.js)
)

if ($Language -ne '') {
    $args_list += '-l', $Language
}
if ($Vad) {
    $args_list += '--vad'
}

# ── Hiển thị thông tin ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Whisper STT Server" -ForegroundColor Cyan
Write-Host "  Model  : ggml-${ModelSize}.bin ($([math]::Round((Get-Item $modelFile).Length/1MB,1)) MB)" -ForegroundColor Cyan
Write-Host "  Địa chỉ: http://127.0.0.1:${Port}/inference" -ForegroundColor Cyan
if ($Language -ne '') {
    Write-Host "  Ngôn ngữ: $Language" -ForegroundColor Cyan
} else {
    Write-Host "  Ngôn ngữ: auto-detect" -ForegroundColor Cyan
}
Write-Host "  Nhấn Ctrl+C để dừng." -ForegroundColor DarkGray
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Khởi động ────────────────────────────────────────────────────────────────
& $serverExe @args_list

# Trans Overlay

Real-time audio translation overlay for Windows — dịch hội thoại trực tiếp, hoàn toàn offline.

```
Mic / System Audio
      ↓  16 kHz PCM
  AudioBuffer  (silence detection, per-language tuning)
      ↓  audio chunk
  Whisper STT  (whisper.cpp, local — auto-selects small > base > tiny)
      ↓  transcript fragment
  SentenceAccumulator  (smart sentence boundary detection)
      ↓  complete sentence
  NLLB-200 Translator  (CTranslate2 INT8 → ONNX fallback)
      ↓  JP → EN → VI pivot  (or direct for EN/VI)
  Overlay UI  (always-on-top transparent window)
      ↓  (optional)
  TTS  (Web Speech API)  🔊
```

---

## Features

- **Always-on-top transparent overlay** — sits over any application
- **WASAPI audio capture** — microphone or system audio loopback
- **Local Whisper STT** — whisper.cpp server, auto-selects best model (`small > base > tiny`)
- **Local NLLB-200 translation** — CTranslate2 INT8 (~600 MB RAM), fallback to ONNX
- **Pivot translation** — JP/ZH/KO/TH/AR → English → target (better quality for low-resource pairs)
- **Context-aware translation** — previous sentence passed as context for coherent continuation
- **Per-language audio tuning** — AudioBuffer và SentenceAccumulator tự điều chỉnh theo source language
- **Smart sentence detection** — gom mảnh transcript thành câu hoàn chỉnh trước khi dịch
- **Web Speech API TTS** — đọc bản dịch thành tiếng (Microsoft Edge voices)
- **Hot-swap language** — đổi ngôn ngữ trong khi đang chạy, không cần restart
- **Click-through mode** — overlay trở nên trong suốt với chuột
- **Global hotkey** — bắt đầu/dừng từ bất kỳ đâu (mặc định: `Ctrl+Shift+T`)
- **System tray** — thu nhỏ xuống tray, click phải để điều khiển
- **No cloud** — mọi thứ chạy cục bộ

---

## Prerequisites

| Thành phần | Mục đích | Ghi chú |
|-----------|---------|---------|
| **Node.js 18+** | Runtime | https://nodejs.org |
| **whisper.cpp** binary | Speech-to-text | Tải từ GitHub Releases (xem bên dưới) |
| **Visual C++ Redistributable** | ctranslate2.dll | https://aka.ms/vs/17/release/vc_redist.x64.exe |

> ffmpeg và Ollama **không cần** — pipeline dùng whisper.cpp + NLLB local.

---

## Setup (lần đầu)

### 1 — Clone & install dependencies

```powershell
git clone <repo-url>
cd TransX
npm install
```

### 2 — Tải whisper.cpp binary

Tải `whisper-bin-x64.zip` từ [whisper.cpp Releases](https://github.com/ggml-org/whisper.cpp/releases/latest), giải nén vào `whisper-bin/`:

```
whisper-bin/
  whisper-server.exe
  whisper.dll
  ggml.dll
  ggml-base.dll
  ...
```

### 3 — Tải Whisper model

App tự chọn model tốt nhất theo thứ tự: **small → base → tiny**.

```powershell
$base = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
New-Item -ItemType Directory -Path whisper-models -Force

# Tối thiểu (chỉ cần 1):
Invoke-WebRequest "$base/ggml-tiny.bin"  -OutFile whisper-models/ggml-tiny.bin   #  75 MB

# Khuyến nghị cho tiếng Nhật:
Invoke-WebRequest "$base/ggml-base.bin"  -OutFile whisper-models/ggml-base.bin   # 141 MB
Invoke-WebRequest "$base/ggml-small.bin" -OutFile whisper-models/ggml-small.bin  # 464 MB
```

| Model | Size | JP WER | Tốc độ |
|-------|------|--------|--------|
| tiny | 75 MB | ~30% | Nhanh nhất |
| base | 141 MB | ~20% | Nhanh |
| **small** *(khuyến nghị JP)* | 464 MB | **~12%** | Vừa |

### 4 — Setup Python embed + CTranslate2

```powershell
# Bước 4a: Tải Python 3.11 embed + cài ctranslate2 (~140 MB)
npm run setup:python

# Bước 4b: Convert NLLB-200 → CT2 INT8 (download ~1.2 GB, mất 5–15 phút)
npm run setup:ct2
```

Kết quả: `python-embed/` (~140 MB) và `nllb-ct2-model/model.bin` (~594 MB).

### 5 — Chạy app

```powershell
npm start
```

---

## Cấu trúc dự án

```
TransX/
├── main.js                    # Electron main process
├── preload.js                 # Context bridge (IPC)
├── config.js                  # Config load/save → %USERPROFILE%\.trans-overlay\
├── nllb-ct2-server.py         # CTranslate2 HTTP server (port 8081)
│
├── renderer/
│   ├── index.html             # Overlay UI (always-on-top window)
│   ├── renderer.js            # UI logic, IPC handlers
│   ├── audioCapture.js        # Web Audio API capture
│   ├── pcm-worklet.js         # AudioWorklet: Float32→Int16, chunking
│   └── styles.css
│
├── src/
│   ├── pipeline/
│   │   └── Pipeline.js        # Core engine: audio → STT → accumulate → translate
│   ├── audio/
│   │   └── AudioBuffer.js     # Silence detection, per-language presets
│   ├── ai/
│   │   ├── NLLBClient.js      # HTTP client for CT2 server
│   │   ├── NLLBTranslator.js  # ONNX fallback (worker threads)
│   │   ├── nllb-worker.js     # Worker thread: Xenova/transformers ONNX inference
│   │   └── WhisperClient.js   # PCM→WAV, POST to whisper.cpp
│   └── services/
│       └── ServiceManager.js  # Spawn/manage whisper-server.exe + nllb-ct2-server.py
│
├── scripts/
│   ├── setup-python-embed.js  # Download Python 3.11 embed + pip + ctranslate2
│   ├── setup-nllb-ct2.py      # Convert NLLB ONNX → CTranslate2 INT8
│   └── download-nllb-model.js # Download NLLB ONNX từ HuggingFace
│
├── whisper-bin/               # whisper-server.exe + DLLs  (không commit)
├── whisper-models/            # ggml-*.bin                 (không commit)
├── nllb-models/               # NLLB ONNX model (fallback) (không commit)
├── nllb-ct2-model/            # CTranslate2 INT8 model     (không commit)
└── python-embed/              # Embedded Python 3.11       (không commit)
```

---

## Pipeline hoạt động như thế nào

### 1. Audio → Chunks (AudioBuffer)

Web Audio API capture PCM 16 kHz → `pcm-worklet.js` mix mono, Float32→Int16 → IPC `audio:sendChunk` → `AudioBuffer`.

Flush chunk khi:
- **Silence**: RMS < `silenceRMS` trong `silenceMs` liên tiếp (sau khi có ≥ `minSpeechMs` speech)
- **Hard cap**: buffer đạt `chunkMaxMs`

**Per-language presets** (tự động áp dụng khi đổi source language):

| Tham số | Japanese | English / Vietnamese |
|---------|----------|---------------------|
| `chunkMaxMs` | 10 000 ms | 8 000 ms |
| `silenceMs` | 600 ms | 1 000 ms |
| `minSpeechMs` | 300 ms | 400 ms |
| `maxWaitMs` (Accumulator) | 4 000 ms | 2 500 ms |
| `maxChars` (Accumulator) | 300 | 200 |

*JP silence ngắn hơn vì clause pause ~300–500 ms; buffer lớn hơn vì câu SOV dài hơn (verb cuối câu).*

### 2. STT — Whisper

`WhisperClient` wrap PCM → WAV, POST `/inference` đến `whisper-server.exe` (localhost:8080).

`initial_prompt` theo ngôn ngữ để Whisper xuất đúng dấu câu:
- EN: `"Welcome. Okay. So,"`
- JP: `"こちらこそ。はい。そこで、"`
- VI: `"Vâng. Ok. Vậy,"`

Kết quả lọc qua `_isNoise()` để loại hallucinations (`[music]`, `字幕`, `thank you for watching`, ...).

### 3. Gom câu — SentenceAccumulator

Whisper trả về từng đoạn ngắn. Accumulator gom lại cho đến khi phát hiện ranh giới câu hoàn chỉnh:

| Ngôn ngữ | Flush ngay | Flush delay |
|----------|-----------|-------------|
| Japanese | `。！？` | `、` / `，` sau ≥ 40 ký tự |
| English/VI | `!` `?` `.` (trừ `Mr.` `Dr.` ...) | — |
| Tất cả | Vượt `maxChars` | Timeout `maxWaitMs` từ chunk cuối |

### 4. Dịch — NLLB-200 CTranslate2

**Backend:** CT2 server (HTTP, ~600 MB RAM) → ONNX fallback (~1.5 GB RAM).

**Pivot translation** cho JP/ZH/KO/TH/AR → non-English:
```
Japanese → [JP→EN, beam=6, no context] → English → [EN→VI, beam=4, EN context] → Vietnamese
```

**Context:** Sliding window 5 câu. Mỗi câu mới nhận 60 ký tự cuối câu trước làm context (Latin source only — CJK bị tắt để tránh tokenizer nhầm ranh giới).

---

## Usage

| Thao tác | Cách làm |
|---------|---------|
| Bắt đầu/dừng dịch | Click **▶** trên overlay hoặc `Ctrl+Shift+T` |
| Di chuyển overlay | Kéo từ thanh tiêu đề |
| Resize overlay | Kéo từ góc/cạnh cửa sổ |
| Click-through | Click **📌** |
| Ẩn overlay | Click **−** → thu xuống tray |
| Mở lại | Click vào tray icon |
| Settings | Click **⚙** |
| Đổi ngôn ngữ (hot-swap) | Settings → đổi Source/Target → Save (không cần restart) |
| Xóa lịch sử | Click **🗑** |

---

## Configuration

Lưu tại `%USERPROFILE%\.trans-overlay\config.json`. Xóa file để reset về defaults.

### Audio

| Key | Default | Mô tả |
|-----|---------|-------|
| `audioSource` | `"microphone"` | `"microphone"` \| `"system"` \| `"both"` |
| `silenceRMS` | `200` | Ngưỡng RMS xác định im lặng. Tăng nếu nhiều noise |
| `chunkMaxMs` | `8000` | Hard cap (ms) — bị override bởi per-language preset |
| `silenceMs` | `1200` | Silence trigger (ms) — bị override bởi per-language preset |
| `minSpeechMs` | `500` | Speech tối thiểu trước khi silence flush kích hoạt |

### Translation

| Key | Default | Mô tả |
|-----|---------|-------|
| `translateEnabled` | `true` | Bật/tắt dịch |
| `sourceLanguage` | `"English"` | Ngôn ngữ nói — tự động set Whisper lang + audio presets |
| `targetLanguage` | `"Vietnamese"` | Ngôn ngữ dịch ra |
| `nllbEndpoint` | `"http://127.0.0.1:8081"` | CT2 server |
| `nllbTimeout` | `15000` | Timeout mỗi request (ms) |

### Overlay

| Key | Default | Mô tả |
|-----|---------|-------|
| `overlayOpacity` | `1` | Độ trong suốt (0–1) |
| `overlayFontSize` | `16` | Cỡ chữ (px) |
| `overlayBg` | `"rgba(8,8,8,0.82)"` | Màu nền |

### App

| Key | Default | Mô tả |
|-----|---------|-------|
| `hotkey` | `"Ctrl+Shift+T"` | Global hotkey |
| `startMinimized` | `false` | Khởi động thu nhỏ xuống tray |
| `maxHistoryItems` | `50` | Số segment lưu lịch sử |

---

## NPM Scripts

| Script | Mô tả |
|--------|-------|
| `npm start` | Chạy app |
| `npm run dev` | Chạy + mở DevTools |
| `npm run setup:python` | Tải Python 3.11 embed + cài ctranslate2 |
| `npm run setup:ct2` | Convert NLLB ONNX → CTranslate2 INT8 (chạy 1 lần) |
| `npm run setup:all` | `setup:python` + `setup:ct2` |
| `npm run download-model` | Tải NLLB-200 600M ONNX từ HuggingFace |
| `npm run download-model-fast` | Tải NLLB-200 distilled 600M (nhanh hơn) |
| `npm run build` | Build Windows installer (NSIS + portable) |
| `npm run build:portable` | Build portable `.exe` |

---

## NLLB-CT2 Server API

Server chạy tại `http://127.0.0.1:8081`.

```
GET  /            → 200 "nllb-ct2-server OK"

POST /translate
{
  "text":        "Hello world",       // bắt buộc
  "src_lang":    "eng_Latn",          // bắt buộc — flores+ code
  "tgt_lang":    "vie_Latn",          // bắt buộc
  "context_src": "Good morning.",     // tùy chọn — câu trước (Latin source only)
  "beam_size":   4                    // tùy chọn — mặc định 4, pivot JP→EN dùng 6
}
← { "text": "Xin chào thế giới" }
```

**Flores+ language codes:**

| Ngôn ngữ | Code | | Ngôn ngữ | Code |
|----------|------|-|----------|------|
| English | `eng_Latn` | | Vietnamese | `vie_Latn` |
| Japanese | `jpn_Jpan` | | Korean | `kor_Hang` |
| Chinese (Simplified) | `zho_Hans` | | Thai | `tha_Thai` |
| French | `fra_Latn` | | Arabic | `arb_Arab` |
| German | `deu_Latn` | | Spanish | `spa_Latn` |
| Russian | `rus_Cyrl` | | | |

---

## Troubleshooting

| Vấn đề | Giải pháp |
|--------|----------|
| `[whisper] exe not found` | Copy `whisper-server.exe` vào `whisper-bin/` — xem Setup bước 2 |
| `CT2 server not available — using ONNX fallback` | Chạy `npm run setup:all` |
| `ctranslate2.dll not found` | Cài Visual C++ Redistributable: https://aka.ms/vs/17/release/vc_redist.x64.exe |
| Dịch JP→VI không chính xác | Tải `ggml-small.bin` vào `whisper-models/` để nhận dạng JP tốt hơn |
| Whisper không nhận tiếng nói | Kiểm tra `silenceRMS` — tăng lên nếu bị cut sớm do noise nền |

---

## License

MIT



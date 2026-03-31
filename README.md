# Trans Overlay

Real-time audio translation overlay for Windows.

```
System Audio / Mic  →  16kHz PCM  →  Whisper STT  →  Local LLM Translation  →  Overlay UI
                                                             ↓ (optional)
                                                      TTS (Web Speech API)  →  🔊
```

---

## Features

- **Always-on-top transparent overlay** — sits over any application
- **WASAPI audio capture** — microphone or system audio loopback via ffmpeg
- **Local Whisper STT** — whisper.cpp server or faster-whisper-server
- **Local LLM translation** — Ollama or any OpenAI-compatible endpoint
- **Web Speech API TTS** — reads translated text aloud (Microsoft Edge voices on Windows)
- **Click-through mode** — overlay becomes non-interactive, passes clicks through
- **Global hotkey** — start/stop from anywhere (default: `Ctrl+Shift+T`)
- **System tray** — minimize to tray, right-click for quick controls
- **No cloud** — everything runs locally

---

## Prerequisites

| Tool | Purpose | Download |
|------|---------|---------|
| **Node.js 18+** | Runtime | https://nodejs.org |
| **ffmpeg** (on PATH) | Audio capture | https://ffmpeg.org/download.html |
| **whisper.cpp** `whisper-server` | Speech-to-text | https://github.com/ggerganov/whisper.cpp |
| **Ollama** | Translation LLM | https://ollama.ai |

### Install ffmpeg (easiest via winget)

```powershell
winget install ffmpeg
```

Verify: `ffmpeg -version`

---

## Setup

### 1 — Clone & install

```powershell
cd "f:\Project Ai\Trans"
npm install
```

### 2 — Start whisper.cpp server

Download a model from [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp):

```powershell
# Download
curl -Lo ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# Start server (default port 8080)
whisper-server.exe -m ggml-base.en.bin --host 127.0.0.1 --port 8080
```

**Alternative — faster-whisper-server** (Python):
```bash
pip install faster-whisper-server
uvicorn faster_whisper_server.main:app --port 8080
```

### 3 — Start Ollama

```powershell
# Install Ollama, then:
ollama serve

# Pull a translation model (pick one):
ollama pull llama3.2          # fast, good quality
ollama pull mistral           # older but lighter
ollama pull qwen2.5:7b        # excellent for CJK / Vietnamese
```

### 4 — Run the app

```powershell
npm start
```

---

## Usage

| Action | How |
|--------|-----|
| Start/Stop translation | Click **▶** on overlay or press `Ctrl+Shift+T` |
| Move overlay | Drag from the top bar |
| Resize overlay | Drag from window edges |
| Click-through mode | Click 📌 — overlay becomes transparent to mouse |
| Open Settings | Click ⚙ on overlay or tray → Settings |
| Hide to tray | Click **—** or tray icon |

---

## Settings

Open Settings (⚙) to configure:

### Audio
- **Source**: Microphone, System Audio (loopback), or Both
- **Device names**: Leave blank for system default.  
  To list WASAPI devices, run:
  ```powershell
  ffmpeg -list_devices true -f wasapi -i dummy 2>&1
  ```

### Whisper STT
- **Endpoint**: URL of your running whisper server (`http://localhost:8080`)
- **Language**: Set to a specific language code to speed up transcription, or leave as `auto`

### Translation
- **Backend**: `Ollama` or `OpenAI-compatible` (LM Studio, llama-server, etc.)
- **Model**: e.g. `llama3.2`, `mistral`, `qwen2.5`
- **Target language**: e.g. `Vietnamese`, `English`, `Japanese`

### TTS
- Uses the Web Speech API (built into Electron / Chromium)
- On Windows the **Microsoft Edge** voices are available — install language packs via Windows Settings → Time & Language → Speech

---

## Architecture

```
main.js                     Electron main process
│
├── src/pipeline/Pipeline.js     Orchestrates the full pipeline
│   ├── src/audio/AudioCapture.js    ffmpeg WASAPI → PCM chunks
│   ├── src/audio/AudioBuffer.js     VAD + silence detection → flush
│   ├── src/ai/WhisperClient.js      PCM → WAV → HTTP → transcript
│   └── src/ai/TranslatorClient.js   transcript → LLM → translation
│
├── renderer/index.html         Overlay window (transparent, always-on-top)
│   ├── renderer/renderer.js
│   └── renderer/styles.css
│
├── renderer/settings.html      Settings window
│   └── renderer/settings.js
│
└── preload.js                  Secure IPC bridge (contextBridge)
```

---

## Building a distributable

```powershell
npm run build            # NSIS installer + portable .exe
npm run build:portable   # portable only
```

Output goes to `dist/`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | Add ffmpeg to PATH, restart terminal |
| `Whisper HTTP 404` | Wrong endpoint; check whisper-server is running |
| `Ollama HTTP 404` | Model not pulled; run `ollama pull <model>` |
| No audio captured | Verify device name with `ffmpeg -list_devices true -f wasapi -i dummy` |
| System audio loopback not working | Enable "Stereo Mix" in Windows Sound settings, or use the WASAPI loopback device name |
| TTS no sound | Open Settings → TTS, pick a voice and click Test |

---

## Config file

Saved at `%USERPROFILE%\.trans-overlay\config.json`. Delete to reset to defaults.

---

## License

MIT

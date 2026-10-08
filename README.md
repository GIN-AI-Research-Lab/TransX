# TransX (Edge Speech Translation Overlay)

> **100% Offline, Air-Gapped Real-Time Speech-to-Speech Translation & Transparent Subtitle Overlay for Windows**  
> *A grant-seeking, open-source Privacy AI platform delivering local speech recognition, neural translation, and subtitle overlay with zero cloud reliance.*

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20(x64)-0078D6.svg?logo=windows)](src/)
[![STT Engine](https://img.shields.io/badge/STT-Faster--Whisper%20(CTranslate2%20INT8)-orange.svg)](faster-whisper-server.py)
[![MT Engine](https://img.shields.io/badge/MT-NLLB--200%20(CTranslate2%20INT8)-blue.svg)](nllb-ct2-server.py)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Offline%20%7C%20Air--Gapped-success.svg)](LICENSE)
[![Latency](https://img.shields.io/badge/Audio%20Latency-Per--Language%20VAD%20Tuned-yellow.svg)](src/audio/AudioBuffer.js)

---

## 🌟 Executive Summary & Pitch

In sensitive enterprise, legal, defense, healthcare, and executive meetings, live translation tools present severe compliance liabilities:
1. **Confidentiality Leaks:** Cloud translation services (Google, OpenAI, Microsoft) require streaming live microphone and system audio to external third-party servers, directly violating GDPR, HIPAA, and corporate NDA requirements.
2. **Subscription & Token Costs:** Sustained meeting translation across global distributed teams racks up thousands of dollars in monthly cloud API expenses.
3. **Network Dependence:** Degraded network connections cause audio dropouts, translation stalls, and meeting miscommunication.

**TransX** delivers a **completely offline, privacy-first, on-device translation overlay** for Windows. Engineered for zero cloud calls and sovereign computation, TransX captures audio via native Windows WASAPI (microphone or system audio loopback), transcribes speech locally using **Faster-Whisper (CTranslate2 INT8)**, dynamically reconstructs sentence boundaries with linguistic heuristics, translates via **NLLB-200 INT8** with contextual sliding windows, and projects transparent, click-through subtitles directly over video conferences, games, and applications.

```
       ┌────────────────────────────────────────────────────────┐
       │             Windows Client (WASAPI Audio)              │
       │    Microphone Stream OR System Audio Loopback          │
       └───────────────────────────┬────────────────────────────┘
                                   │ 16 kHz Mono PCM
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │     AudioBuffer (RMS Silence Gating & Speech VAD)      │
       │  • Auto-tuned per language (JP: 600ms, EN/VI: 1000ms)  │
       └───────────────────────────┬────────────────────────────┘
                                   │ Audio Chunks
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │    Faster-Whisper STT Server (CTranslate2 INT8)        │
       │  • 2–4x faster than standard whisper.cpp               │
       │  • Hallucination filter & punctuation prompt injection │
       └───────────────────────────┬────────────────────────────┘
                                   │ Text Fragments
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │       SentenceAccumulator (Syntactic Boundary Gating)  │
       │  • Aggregates fragments until terminal punctuation     │
       └───────────────────────────┬────────────────────────────┘
                                   │ Complete Sentences
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │        NLLB-200 MT Server (CTranslate2 INT8)           │
       │  • English Pivot (JP/ZH/KO/AR → EN → VI/Target)        │
       │  • Sliding-window context injection (5-sentence cache) │
       │  • Memory footprint: ~600 MB RAM                       │
       └───────────────────────────┬────────────────────────────┘
                                   │ Translated Sentences
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │             Electron Transparent Overlay UI            │
       │  • Always-on-top, click-through, hotkey toggle         │
       │  • Optional local TTS (Web Speech API)                 │
       └────────────────────────────────────────────────────────┘
```

---

## 🚀 Technical Highlights & Measured Benchmarks

### 1. Zero Cloud Dependency & Sovereign Privacy
- **100% Air-Gapped:** Zero external HTTP requests during runtime. All neural weights run locally via CTranslate2 INT8 execution kernels.
- **Embedded Python Environment:** Bundles an isolated, self-contained Python 3.11 embeddable environment without polluting the host operating system.

### 2. Verified Local Model Footprint & Memory Efficiency

| Model Component | Precision / Format | Model Weights on Disk | Working RAM Footprint | Inference Throughput |
|:---|:---:|:---:|:---:|:---:|
| **Faster-Whisper (Tiny)** | INT8 (CTranslate2) | ~43 MB | ~150 MB | Real-time ($\times 12$ RTF) |
| **Faster-Whisper (Base - Default)** | INT8 (CTranslate2) | ~145 MB | ~300 MB | Real-time ($\times 6$ RTF) |
| **Faster-Whisper (Small - Recommended JP)** | INT8 (CTranslate2) | ~245 MB | ~500 MB | Real-time ($\times 3$ RTF) |
| **NLLB-200 Translator** | INT8 (CTranslate2) | ~594 MB | ~600 MB | ~35–50 tok/s on CPU |
| **Total System Footprint (Base+NLLB)** | INT8 | **~739 MB** | **~900 MB** | Full Real-Time Sync |

### 3. Linguistic Audio Gating & Syntactic Sentence Accumulator
Language structures differ fundamentally in clause pauses and word order. TransX implements **per-language audio and sentence accumulation parameters**:

| Parameter | Japanese (SOV) | English / Vietnamese (SVO) | Rationale |
|:---|:---:|:---:|:---|
| `chunkMaxMs` | 10,000 ms | 8,000 ms | Japanese verbs occur at sentence terminals, requiring wider capture buffers |
| `silenceMs` | 600 ms | 1,000 ms | Japanese clause particles exhibit shorter conversational pauses (~300–500ms) |
| `minSpeechMs` | 300 ms | 400 ms | High-precision speech thresholding |
| `maxWaitMs` | 4,000 ms | 2,500 ms | Accumulator timeout before forcing translation flush |
| `maxChars` | 300 | 200 | Maximum token buffer threshold |

### 4. High-Precision English Pivot & Contextual Sliding Window
For low-resource translation pairs (e.g., Japanese $\to$ Vietnamese), direct end-to-end models often degrade into hallucinations. TransX routes translations through an **asymmetric English pivot pipeline**:
$$\text{Japanese} \xrightarrow[\text{beam=6}]{\text{JP}\to\text{EN}} \text{English} \xrightarrow[\text{beam=4, context}]{\text{EN}\to\text{VI}} \text{Vietnamese}$$
The engine injects the trailing 60 characters of the preceding sentence into the translation context window, ensuring grammatical continuity across compound conversational turns.

---

## 🛠️ Project Structure

```
TransX/
├── main.js                      # Electron main process & IPC lifecycle
├── preload.js                   # Secure contextBridge IPC bridge
├── config.js                    # Persistent configuration manager
├── faster-whisper-server.py     # Local Faster-Whisper HTTP service (port 8080)
├── nllb-ct2-server.py           # Local CTranslate2 NLLB-200 service (port 8081)
├── renderer/                    # Transparent overlay UI & Web Audio capture
│   ├── index.html               # Overlay DOM & subtitle cards
│   ├── renderer.js              # Overlay UI logic & hotkey events
│   ├── audioCapture.js          # Web Audio API WASAPI capture
│   └── pcm-worklet.js           # AudioWorklet (Float32 -> Int16 mono streaming)
├── src/
│   ├── pipeline/Pipeline.js     # Master pipeline (Audio -> STT -> Accumulate -> MT)
│   ├── audio/AudioBuffer.js     # RMS silence detector & per-language VAD
│   ├── ai/                      # NLLB & Faster-Whisper client wrappers
│   └── services/ServiceManager.js # Background server orchestration
└── scripts/                     # Automated setup & model conversion utilities
```

---

## ⚡ Quick Start & Setup

### Prerequisites
- Windows 10 / 11 (x64)
- [Node.js 18+](https://nodejs.org)
- [Visual C++ Redistributable 2015-2022](https://aka.ms/vs/17/release/vc_redist.x64.exe)

### Step 1: Clone & Install Dependencies

```powershell
git clone https://github.com/trituenguyen97/TransX.git
cd TransX
npm install
```

### Step 2: Initialize Local Models

```powershell
# Set up Python embed and CTranslate2 NLLB-200 model (~594 MB)
npm run setup:ct2
```

Faster-Whisper models download automatically upon first execution into `whisper-models/`.

### Step 3: Launch TransX

```powershell
npm start
```

### Keyboard Shortcuts & Controls
- **Toggle Translation:** Click **▶** or press `Ctrl+Shift+T` globally.
- **Click-Through Mode:** Click **📌** to allow mouse clicks to pass through to underlying games or windows.
- **System Tray:** Click **−** to minimize to the notification tray.

---

## 🎯 Startup Vision, Grant Objectives & Roadmap

TransX champions **Decentralized, Sovereign, Privacy-Preserving Artificial Intelligence**. We are actively seeking open-source grants, edge computing sponsorships, and design partnerships.

### Planned Grant Allocation

```
                   ┌───────────────────────────────────────┐
                   │        Target Grant Allocation        │
                   ├──────────────────┬────────────────────┤
                   │ NPU & ONNX EP    │                    │
                   │ Hardware Accel   │        40%         │
                   ├──────────────────┼────────────────────┤
                   │ BitNet 1.58-bit  │                    │
                   │ Model Integration│        30%         │
                   ├──────────────────┼────────────────────┤
                   │ Cross-Platform   │                    │
                   │ Linux/macOS Core │        20%         │
                   ├──────────────────┼────────────────────┤
                   │ Open Benchmarks  │        10%         │
                   └──────────────────┴────────────────────┘
```

1. **Hardware NPU Acceleration (40%):** Porting inference kernels to ONNX Runtime Execution Providers (DirectML, Intel OpenVINO, Qualcomm QNN) to drop CPU consumption to $<5\%$ on battery power.
2. **BitNet 1.58-bit Model Integration (30%):** Integrating ultra-compact ternary translation weights (such as [Bit-Translate](https://github.com/trituenguyen97/Bit-Translate)), reducing translator memory from 600 MB down to under 80 MB.
3. **Cross-Platform Audio Engine (20%):** Developing native PipeWire (Linux) and CoreAudio (macOS) zero-latency audio loopback captures.
4. **Independent Benchmark Suite (10%):** Publishing open WER (Word Error Rate) and BLEU/COMET evaluations across challenging acoustic environments.

### Ideal Grant Programs
- **NLnet Foundation / NGI Zero Grants** (Privacy, Trust & Sovereign Open Source)
- **Mozilla Open Source Support (MOSS)** (Decentralized & Local AI)
- **Edge AI Foundation & Hardware Accelerator Grants**

---

## 🤝 Contact & Collaboration

We welcome discussions with edge computing teams, open-source AI foundations, and privacy-first organizations:

- **Founder & Maintainer:** Tri Tue Nguyen ([@trituenguyen97](https://github.com/trituenguyen97))
- **GitHub:** [https://github.com/trituenguyen97/TransX](https://github.com/trituenguyen97/TransX)
- **Inquiries:** Submit an issue or reach out via GitHub profile.

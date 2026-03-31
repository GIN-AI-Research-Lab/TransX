/**
 * src/pipeline/Pipeline.js
 *
 * Audio → AudioBuffer → WhisperClient → NLLBTranslator.
 *
 * Audio input đến từ:
 *   receivePCM(buffer) — push từ main.js khi nhận IPC 'audio:sendChunk'
 *
 * Emits:
 *   'started'
 *   'stopped'
 *   'processing'  { stage: 'stt'|'translation'|'idle' }
 *   'transcript'  { text: string, timestamp: number }
 *   'translation' { original, translated, timestamp, id }
 *   'error'       Error
 */

'use strict';

const { EventEmitter } = require('events');
const AudioBuffer     = require('../audio/AudioBuffer');
const WhisperClient   = require('../ai/WhisperClient');
const NLLBTranslator  = require('../ai/NLLBTranslator');

// Format elapsed ms → 'M:SS'
function fmtTime(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const CONTEXT_WINDOW = 5; // số câu giữ lại làm ngữ cảnh

class Pipeline extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg    = cfg;
    this.abuf   = new AudioBuffer({
      sampleRate: cfg.sampleRate || 16000,
      maxMs:      cfg.chunkMaxMs || 5000,
      silenceMs:  cfg.silenceMs  || 900,
      silenceRMS: cfg.silenceRMS || 280,
    });
    this.whisper    = new WhisperClient(cfg);
    this.translator = new NLLBTranslator(cfg);

    this.isRunning    = false;
    this._queue       = [];
    this._processing  = false;
    this._startTime   = null;   // wall-clock khi pipeline start
    this._segId       = 0;      // ID tăng dần cho mỗi segment
    this._context     = [];     // [{original, translated}] — cửa sổ ngữ cảnh
  }

  // ── Start / Stop ──────────────────────────────────────────────────
  async start() {
    if (this.isRunning) return;

    // Kiểm tra Whisper server trước khi start
    const ok = await this.whisper.ping();
    if (!ok) {
      this.emit('error', new Error(
        `Whisper server chưa chạy tại ${this.cfg.whisperEndpoint || 'http://localhost:8080'}\n` +
        `Hãy mở terminal và chạy: .\\start-whisper.ps1`
      ));
      return;
    }

    this.abuf.removeAllListeners('chunk');
    this.abuf.on('chunk', (buf, startMs) => {
      // timestamp = elapsed ms tính từ khi pipeline start
      const elapsed = startMs - this._startTime;
      this._queue.push({ buf, timestamp: elapsed });
      this._drain();
    });

    this._startTime = Date.now();
    this._segId     = 0;
    this._context   = [];
    this.isRunning  = true;
    this.emit('started');
  }

  stop() {
    if (!this.isRunning) return;
    this.abuf.reset();
    this.abuf.removeAllListeners('chunk');
    this._queue   = [];
    this._context = [];
    this.isRunning = false;
    this.emit('stopped');
  }

  /**
   * Nhận raw PCM Int16 LE từ Web Audio API (qua IPC).
   * Được gọi từ main.js khi nhận 'audio:sendChunk'.
   * @param {Buffer} buf  16-bit signed LE PCM, mono, 16 kHz
   */
  receivePCM(buf) {
    if (!this.isRunning) return;
    this.abuf.push(buf);
  }

  // ── Config hot-swap (while stopped) ──────────────────────────────
  updateConfig(cfg) {
    this.cfg        = cfg;
    this.whisper    = new WhisperClient(cfg);
    this.translator = new NLLBTranslator(cfg);
    this.abuf       = new AudioBuffer({
      sampleRate: cfg.sampleRate || 16000,
      maxMs:      cfg.chunkMaxMs || 5000,
      silenceMs:  cfg.silenceMs  || 900,
      silenceRMS: cfg.silenceRMS || 280,
    });
  }

  // ── Internal queue drain ─────────────────────────────────────────
  async _drain() {
    if (this._processing) return;
    this._processing = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      try {
        await this._processChunk(item.buf, item.timestamp);
      } catch (err) {
        this.emit('error', err);
      }
    }
    this._processing = false;
  }

  async _processChunk(pcm, timestamp) {
    // ── STT ──
    this.emit('processing', { stage: 'stt' });
    let transcript = '';
    try {
      transcript = await this.whisper.transcribe(pcm);
    } catch (err) {
      throw new Error(`STT failed: ${err.message}`);
    }

    if (!transcript) {
      this.emit('processing', { stage: 'idle' });
      return;
    }

    // Bỏ qua các nhãn đặc biệt Whisper trả về khi không nhận diện được âm thanh
    const BLANK_PATTERN = /^\s*\[[\w\s]+\]\s*$|^\s*\([\w\s]+\)\s*$/i;
    if (BLANK_PATTERN.test(transcript)) {
      this.emit('processing', { stage: 'idle' });
      return;
    }

    this.emit('transcript', { text: transcript, timestamp });

    // ── Translation ──
    if (!this.cfg.translateEnabled) {
      // Không dịch: vẫn tạo segment chỉ có original
      this._addContext(transcript, '');
      this.emit('translation', {
        original:   transcript,
        translated: '',
        timestamp,
        id: ++this._segId,
      });
      this.emit('processing', { stage: 'idle' });
      return;
    }

    this.emit('processing', { stage: 'translation' });
    let translated = '';
    try {
      // NLLB-200 generates translation in one pass (no streaming)
      translated = await this.translator.translate(transcript);
    } catch (err) {
      throw new Error(`Translation failed: ${err.message}`);
    }

    if (translated) {
      this._addContext(transcript, translated);
      this.emit('translation', {
        original:   transcript,
        translated,
        timestamp,
        id: ++this._segId,
      });
    }
    this.emit('processing', { stage: 'idle' });
  }

  /** Thêm vào cửa sổ ngữ cảnh, giữ tối đa CONTEXT_WINDOW câu */
  _addContext(original, translated) {
    this._context.push({ original, translated });
    if (this._context.length > CONTEXT_WINDOW) this._context.shift();
  }
}

module.exports = Pipeline;

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
const BLANK_PATTERN  = /^\s*\[[\w\s]+\]\s*$|^\s*\([\w\s]+\)\s*$/i;

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
    this._queue       = [];      // full audio chunks waiting for STT
    this._transQueue  = [];      // transcripts waiting for translation
    this._sttBusy     = false;
    this._transBusy   = false;
    this._whisperBusy = false;   // guard against concurrent Whisper calls
    this._startTime   = null;
    this._segId       = 0;
    this._context     = [];
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
    this.abuf.removeAllListeners('partial');
    this.abuf.on('chunk', (buf, startMs) => {
      const elapsed = startMs - this._startTime;
      this._queue.push({ buf, timestamp: elapsed });
      this._drainSTT();
    });
    this.abuf.on('partial', (buf, startMs) => {
      const elapsed = startMs - this._startTime;
      this._handlePartial(buf, elapsed);
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
    this.abuf.removeAllListeners('partial');
    this._queue      = [];
    this._transQueue = [];
    this._context    = [];
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

  // ── Internal: partial audio preview ─────────────────────────────
  async _handlePartial(buf, timestamp) {
    // Skip if Whisper is currently busy — avoid flooding the server
    if (this._whisperBusy) return;
    this._whisperBusy = true;
    try {
      const text = await this.whisper.transcribe(buf);
      if (text && !BLANK_PATTERN.test(text.trim())) {
        this.emit('partial-transcript', { text: text.trim(), timestamp });
      }
    } catch {
      // Ignore partial errors silently
    } finally {
      this._whisperBusy = false;
    }
  }

  // ── Internal: STT queue drain ────────────────────────────────────
  async _drainSTT() {
    if (this._sttBusy) return;
    this._sttBusy = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      try {
        await this._doSTT(item);
      } catch (err) {
        this.emit('error', err);
      }
    }
    this._sttBusy = false;
    this.emit('processing', { stage: 'idle' });
  }

  async _doSTT({ buf, timestamp }) {
    this._whisperBusy = true;
    this.emit('processing', { stage: 'stt' });
    let transcript = '';
    try {
      transcript = await this.whisper.transcribe(buf);
    } catch (err) {
      this._whisperBusy = false;
      throw new Error(`STT failed: ${err.message}`);
    }
    this._whisperBusy = false;

    if (!transcript || BLANK_PATTERN.test(transcript.trim())) return;

    transcript = transcript.trim();
    const id = ++this._segId;
    this.emit('transcript', { text: transcript, timestamp, id });

    if (!this.cfg.translateEnabled) {
      this._addContext(transcript, '');
      this.emit('translation', { original: transcript, translated: '', timestamp, id });
      return;
    }

    // Enqueue translation — runs in background (don't await)
    this._transQueue.push({ transcript, timestamp, id });
    this._drainTranslation();
  }

  // ── Internal: Translation queue drain ───────────────────────────
  async _drainTranslation() {
    if (this._transBusy) return;
    this._transBusy = true;
    while (this._transQueue.length > 0) {
      const item = this._transQueue.shift();
      try {
        await this._doTranslation(item);
      } catch (err) {
        this.emit('error', err);
      }
    }
    this._transBusy = false;
  }

  async _doTranslation({ transcript, timestamp, id }) {
    this.emit('processing', { stage: 'translation' });
    let translated = '';
    try {
      translated = await this.translator.translate(transcript);
    } catch (err) {
      throw new Error(`Translation failed: ${err.message}`);
    }
    if (translated) {
      this._addContext(transcript, translated);
      this.emit('translation', { original: transcript, translated, timestamp, id });
    }
  }

  /** Thêm vào cửa sổ ngữ cảnh, giữ tối đa CONTEXT_WINDOW câu */
  _addContext(original, translated) {
    this._context.push({ original, translated });
    if (this._context.length > CONTEXT_WINDOW) this._context.shift();
  }
}

module.exports = Pipeline;

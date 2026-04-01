/**
 * src/audio/AudioBuffer.js
 *
 * Accumulates raw 16-bit signed LE PCM and emits 'chunk' events
 * based on two strategies:
 *
 *   1. Hard cap  — flush when buffer reaches maxMs of audio.
 *   2. Silence   — flush after silenceMs of quiet audio once we have
 *                  a minimum amount of speech content.
 *
 * Emits:
 *   'chunk'  Buffer  — PCM buffer ready to send to Whisper
 */

'use strict';

const { EventEmitter } = require('events');

class AudioBuffer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=16000]
   * @param {number} [opts.maxMs=5000]       hard cap in ms
   * @param {number} [opts.silenceMs=900]    silence window in ms
   * @param {number} [opts.silenceRMS=280]   RMS below which = silence
   * @param {number} [opts.minSpeechMs=300]  min speech before silence flush
   */
  constructor(opts = {}) {
    super();
    this.sampleRate   = opts.sampleRate   || 16000;
    this.maxMs        = opts.maxMs        || 5000;
    this.silenceMs    = opts.silenceMs    || 900;
    this.silenceRMS   = opts.silenceRMS   || 280;
    this.minSpeechMs  = opts.minSpeechMs  || 300;

    this._buf         = Buffer.alloc(0);
    this._silenceTimer = null;
    this._chunkStartMs = null;  // wall-clock khi chunk bắt đầu tích lũy
  }

  // ── Helpers ───────────────────────────────────────────────────────
  get _bytesPerMs() {
    return (this.sampleRate * 2) / 1000;   // 16-bit = 2 bytes/sample
  }
  get _maxBytes() {
    return Math.floor(this._bytesPerMs * this.maxMs);
  }
  get _minSpeechBytes() {
    return Math.floor(this._bytesPerMs * this.minSpeechMs);
  }

  /** Compute RMS of a PCM Buffer (16-bit signed LE). */
  _rms(buf) {
    if (buf.length < 2) return 0;
    let sum = 0;
    const len = Math.floor(buf.length / 2);
    for (let i = 0; i < len; i++) {
      const s = buf.readInt16LE(i * 2);
      sum += s * s;
    }
    return Math.sqrt(sum / len);
  }

  // ── Public API ────────────────────────────────────────────────────
  push(chunk) {    // Ghi nhớ thời điểm bắt đầu chunk mới
    if (this._buf.length === 0) {
      this._chunkStartMs = Date.now();
      this.emit('started', this._chunkStartMs);  // notify pipeline audio incoming
    }
    this._buf = Buffer.concat([this._buf, chunk]);

    const isSilent = this._rms(chunk) < this.silenceRMS;

    if (!isSilent) {
      // Cancel pending silence flush — we heard activity
      this._clearTimer();
    }

    // Hard cap flush
    if (this._buf.length >= this._maxBytes) {
      this._flush();
      return;
    }

    // Silence-based flush (only after we have enough speech content)
    if (isSilent && this._buf.length >= this._minSpeechBytes) {
      if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => {
          this._silenceTimer = null;
          this._flush();
        }, this.silenceMs);
      }
    }
  }

  _flush() {
    this._clearTimer();
    if (this._buf.length >= this._minSpeechBytes) {
      // Emit (buf, startMs) — startMs dùng để hiển thị mốc thời gian
      this.emit('chunk', Buffer.from(this._buf), this._chunkStartMs || Date.now());
    }
    this._buf = Buffer.alloc(0);
    this._chunkStartMs = null;
  }

  _clearTimer() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
  }

  reset() {
    this._clearTimer();
    this._buf = Buffer.alloc(0);
    this._chunkStartMs = null;
  }
}

module.exports = AudioBuffer;

/**
 * src/pipeline/Pipeline.js
 *
 * Audio → AudioBuffer → WhisperClient → NLLBTranslator.
 *
 * Audio input đến từ:
 *   receivePCM(buffer) — push từ main.js khi nhận IPC 'audio:sendChunk'
 *
 * Real-time strategy:
 *   1. AudioBuffer gửi 'snapshot' mỗi ~1.5s (buffer copy, không flush)
 *      → Pipeline gửi Whisper → emit 'partial' (text hiển thị lập tức)
 *   2. AudioBuffer gửi 'chunk' khi phát hiện khoảng lặng hoặc hard cap
 *      → Pipeline gửi Whisper → emit 'transcript' (text cuối cùng)
 *      → Sau 500ms → dịch → emit 'translation'
 *
 * Kết quả: user thấy text gần như real-time, bản dịch xuất hiện sau ~0.5s.
 *
 * Emits:
 *   'started'
 *   'stopped'
 *   'processing'  { stage: 'stt'|'translation'|'idle' }
 *   'listening'   { timestamp }
 *   'partial'     { text: string, timestamp: number }
 *   'transcript'  { text: string, timestamp: number, id: number }
 *   'translation' { original, translated, timestamp, id }
 *   'error'       Error
 */

'use strict';

const { EventEmitter } = require('events');
const AudioBuffer     = require('../audio/AudioBuffer');
const WhisperClient   = require('../ai/WhisperClient');
const NLLBTranslator  = require('../ai/NLLBTranslator');
const NLLBClient      = require('../ai/NLLBClient');

// Format elapsed ms → 'M:SS'
function fmtTime(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Match bất kỳ chuỗi nằm trong [...] hoặc (...) — bao gồm cả Unicode/tiếng Nhật
const BLANK_PATTERN  = /^\s*\[[^\[\]]+\]\s*$|^\s*\([^()]+\)\s*$/;

// Whisper hallucination phrases — produced when audio has no real speech
// (music, silence, noise). Expand this list as needed.
const HALLUCINATION_EXACT = new Set([
  // Japanese
  '音楽', '(音楽)', '[音楽]', '字幕', 'ご視聴ありがとうございました', 'ご覧ありがとうございました',
  'ご視聴ありがとうございました。', '字幕制作', '反調',
  // English
  'thank you for watching', 'thanks for watching', 'subtitles by', '[music]', '[ music ]',
  '(music)', '[applause]', '(applause)', '[laughter]', '(laughter)',
  '[silence]', '(silence)', '[noise]', '', ' ',
]);

// Minimum meaningful character count (short = likely hallucination)
const MIN_CHARS = 2;

function _isNoise(text) {
  const t = text.trim();
  if (!t || t.length < MIN_CHARS) return true;
  if (BLANK_PATTERN.test(t)) return true;
  if (HALLUCINATION_EXACT.has(t.toLowerCase()) || HALLUCINATION_EXACT.has(t)) return true;
  return false;
}

// Map sourceLanguage display name → Whisper ISO language code
const WHISPER_LANG = {
  'English':    'en',
  'Japanese':   'ja',
  'Vietnamese': 'vi',
};
function _srcToWhisperLang(src) {
  return WHISPER_LANG[src] || 'auto';
}

// initial_prompt gợi ý Whisper xuất dấu câu đúng
// Lưu ý: dùng như "văn bản trước đó" — phải ngẫn gọn và ngữ nhiên, không phải là hướng dẫn
const WHISPER_PROMPTS = {
  'en': 'Welcome. Okay. So,',     // conditioning: English với dấu câu tự nhiên
  'ja': 'こちらこそ。はい。そこで、',  // conditioning: Japanese với kana + dấu 。、
  'vi': 'Vâng. Ok. Vậy,',          // conditioning: Vietnamese
};
function _srcToInitialPrompt(src) {
  const lang = _srcToWhisperLang(src);
  return WHISPER_PROMPTS[lang] || '';
}

// ── Per-language presets for AudioBuffer ────────────────────────────────────────
// Near-realtime: ngắn chunk, flush nhanh → gửi Whisper sớm nhất có thể
const LANG_PRESETS = {
  ja: {
    chunkMaxMs:  5000,    // flush tối đa 5s (từ 10s)
    silenceMs:   400,     // pause 400ms = flush (từ 600ms)
    minSpeechMs: 250,     // chấp nhận utterance ngắn
  },
  en: {
    chunkMaxMs:  5000,
    silenceMs:   600,     // EN pause tự nhiên ~0.5–0.8s (từ 1000ms)
    minSpeechMs: 300,
  },
  vi: {
    chunkMaxMs:  5000,
    silenceMs:   600,
    minSpeechMs: 300,
  },
};
const DEFAULT_PRESET = LANG_PRESETS.en;

function _getLangPreset(sourceLanguage) {
  const lang = _srcToWhisperLang(sourceLanguage);
  return LANG_PRESETS[lang] || DEFAULT_PRESET;
}

class Pipeline extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg    = cfg;
    const preset = _getLangPreset(cfg.sourceLanguage);
    this.abuf   = new AudioBuffer({
      sampleRate:  cfg.sampleRate || 16000,
      maxMs:       preset.chunkMaxMs,
      silenceMs:   preset.silenceMs,
      silenceRMS:  cfg.silenceRMS || 200,
      minSpeechMs: preset.minSpeechMs,
    });
    this.whisper    = new WhisperClient({
      ...cfg,
      whisperLanguage:    _srcToWhisperLang(cfg.sourceLanguage),
      whisperInitialPrompt: _srcToInitialPrompt(cfg.sourceLanguage),
    });
    // _nllbOnnx is created lazily in start() only when CT2 is unavailable.
    // This avoids loading the ~1.5 GB ONNX worker when CT2 runs fine.
    this._nllbOnnx  = null;
    this._nllbCt2   = new NLLBClient(cfg);
    this.translator = null;

    this.isRunning    = false;
    this._queue       = [];      // full audio chunks waiting for STT
    this._transQueue  = [];      // transcripts waiting for translation
    this._sttBusy     = false;
    this._transBusy   = false;
    this._whisperBusy = false;   // guard against concurrent Whisper calls
    this._partialBusy = false;   // guard against concurrent partial STT
    this._startTime   = null;
    this._segId       = 0;
    this._epoch       = 0;       // tăng mỗi lần stop() — discard kết quả cũ
    this._recentTexts = [];      // dedup: last N complete transcripts
    this._lastPartialText = '';  // track last partial to avoid duplicate emit
  }

  // ── Start / Stop ──────────────────────────────────────────────────
  async start() {
    if (this.isRunning) return;

    // Kiểm tra Whisper server trước khi start
    const ok = await this.whisper.ping();
    if (!ok) {
      this.emit('error', new Error(
        `Faster-Whisper server chưa chạy tại ${this.cfg.whisperEndpoint || 'http://localhost:8080'}\n` +
        `Hãy chờ server khởi động hoàn tất.`
      ));
      return;
    }

    // Chọn translator: CT2 nếu server đang chạy, fallback ONNX (lazy init)
    const ct2ok = await this._nllbCt2.ping();
    if (ct2ok) {
      this.translator = this._nllbCt2;
      console.log('[pipeline] translator: CTranslate2 (CT2)');
    } else {
      // Only use ONNX fallback if model files are present locally
      const svcMgr = require('../services/ServiceManager');
      const fs     = require('fs');
      const path   = require('path');
      const onnxConfig = path.join(svcMgr.nllbModelDir, 'nllb-200-distilled-600M', 'config.json');
      if (!fs.existsSync(onnxConfig)) {
        this.emit('error', new Error(
          'CT2 translation server chưa sẵn sàng.\n' +
          'Vui lòng chờ vài giây rồi thử lại bắt đầu dịch.'
        ));
        this.isRunning = false;
        return;
      }
      if (!this._nllbOnnx) this._nllbOnnx = new NLLBTranslator(this.cfg);
      this.translator = this._nllbOnnx;
      console.log('[pipeline] translator: ONNX (CT2 not available)');
    }

    this.abuf.removeAllListeners('chunk');
    this.abuf.removeAllListeners('started');
    this.abuf.removeAllListeners('snapshot');
    this.abuf.on('started', (startMs) => {
      this._lastPartialText = '';
      // Notify renderer to show '...' listening bubble
      this.emit('listening', { timestamp: startMs - this._startTime });
    });
    this.abuf.on('snapshot', (buf, startMs) => {
      // Interim STT — send snapshot to Whisper for real-time text display
      const elapsed = startMs - this._startTime;
      this._doPartialSTT(buf, elapsed);
    });
    this.abuf.on('chunk', (buf, startMs) => {
      const elapsed = startMs - this._startTime;
      this._queue.push({ buf, timestamp: elapsed });
      this._drainSTT();
    });

    this._startTime = Date.now();
    this._segId    = 0;
    this.isRunning = true;
    this.emit('started');
  }

  stop() {
    if (!this.isRunning) return;
    // Tăng epoch — mọi STT/translation đang chờ sẽ bị discard khi hoàn thành
    this._epoch++;
    // Dừng audio input ngay
    this.abuf.reset();
    this.abuf.removeAllListeners('chunk');
    this.abuf.removeAllListeners('partial');
    this.abuf.removeAllListeners('snapshot');
    // Xóa toàn bộ hàng đợi: cả audio chưa STT lẫn transcript chưa dịch
    this._queue      = [];
    this._transQueue = [];
    this._recentTexts = [];
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
    const preset    = _getLangPreset(cfg.sourceLanguage);
    this.whisper    = new WhisperClient({
      ...cfg,
      whisperLanguage:      _srcToWhisperLang(cfg.sourceLanguage),
      whisperInitialPrompt: _srcToInitialPrompt(cfg.sourceLanguage),
    });
    this._nllbOnnx  = null; // reset lazy — will re-init in start() if CT2 unavailable
    this._nllbCt2   = new NLLBClient(cfg);
    this.translator = null;
    this.abuf       = new AudioBuffer({
      sampleRate:  cfg.sampleRate || 16000,
      maxMs:       preset.chunkMaxMs,
      silenceMs:   preset.silenceMs,
      silenceRMS:  cfg.silenceRMS || 200,
      minSpeechMs: preset.minSpeechMs,
    });
  }

  // ── Language hot-swap (while running) ───────────────────────
  updateLanguages(cfg) {
    const lang   = _srcToWhisperLang(cfg.sourceLanguage);
    const preset = _getLangPreset(cfg.sourceLanguage);
    this.whisper.language       = lang;
    this.whisper.initialPrompt  = _srcToInitialPrompt(cfg.sourceLanguage);
    if (this._nllbOnnx) this._nllbOnnx.updateLanguage(cfg);
    this._nllbCt2.updateLanguage(cfg);
    // Update AudioBuffer timing for the new source language
    this.abuf.maxMs      = preset.chunkMaxMs;
    this.abuf.silenceMs  = preset.silenceMs;
    this.abuf.minSpeechMs = preset.minSpeechMs;
  }

  // ── Internal: partial/interim STT (snapshot, non-blocking) ─────────
  async _doPartialSTT(buf, timestamp) {
    // Skip if a final STT or another partial is already running
    if (this._partialBusy || this._whisperBusy) return;
    this._partialBusy = true;
    const epoch = this._epoch;
    try {
      const text = await this.whisper.transcribe(buf);
      if (this._epoch !== epoch) return;
      const t = (text || '').trim();
      if (!t || _isNoise(t)) return;
      // Only emit if text changed from last partial
      if (t !== this._lastPartialText) {
        this._lastPartialText = t;
        this.emit('partial', { text: t, timestamp });
      }
    } catch {
      // Ignore partial STT errors — final chunk will retry
    } finally {
      this._partialBusy = false;
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
    const epoch = this._epoch;
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

    // Bỏ qua nếu stop() đã được gọi trong lúc chờ Whisper
    if (this._epoch !== epoch) return;

    if (!transcript || _isNoise(transcript.trim())) return;

    transcript = transcript.trim();

    // Repetition dedup: reject nhanh nếu đúng text này vừa xuất hiện
    if (this._recentTexts.includes(transcript)) return;
    this._recentTexts.push(transcript);
    if (this._recentTexts.length > 5) this._recentTexts.shift();

    // Reset partial tracking — final text replaces any partial
    this._lastPartialText = '';

    // Emit final transcript immediately (replaces partial in UI)
    const id = ++this._segId;
    this.emit('transcript', { text: transcript, timestamp, id });
    if (!this.cfg.translateEnabled) {
      this.emit('translation', { original: transcript, translated: '', timestamp, id });
      return;
    }
    // Delay translation 500ms so user sees transcript first
    const currentEpoch = this._epoch;
    setTimeout(() => {
      if (this._epoch !== currentEpoch) return;
      this._transQueue.push({ transcript, timestamp, id, epoch: currentEpoch });
      this._drainTranslation();
    }, 500);
  }

  // ── Internal: Translation queue drain ───────────────────────────
  async _drainTranslation() {
    if (this._transBusy) return;
    this._transBusy = true;
    while (this._transQueue.length > 0) {
      // Lấy tất cả câu đang chờ và dispatch đồng thời — worker pool sẽ xử lý song song
      const batch = this._transQueue.splice(0);
      await Promise.all(
        batch.map(item => this._doTranslation(item).catch(err => this.emit('error', err)))
      );
    }
    this._transBusy = false;
  }

  async _doTranslation({ transcript, timestamp, id, epoch }) {
    if (this._epoch !== epoch) return;
    this.emit('processing', { stage: 'translation' });
    let translated = '';
    try {
      if (this._shouldPivot()) {
        // Pivot: source → English → target
        const pivotEnglish = await this.translator.translateRaw(
          transcript, this.translator.srcCode, 'eng_Latn', '', 4,
        );
        if (!pivotEnglish || this._epoch !== epoch) return;
        translated = await this.translator.translateRaw(
          pivotEnglish, 'eng_Latn', this.translator.tgtCode,
        );
      } else {
        translated = await this.translator.translateRaw(
          transcript, this.translator.srcCode, this.translator.tgtCode,
        );
      }
    } catch (err) {
      throw new Error(`Translation failed: ${err.message}`);
    }
    if (this._epoch !== epoch) return;
    if (translated) {
      this.emit('translation', { original: transcript, translated, timestamp, id });
    }
  }

  /** Tự động dùng pivot khi nguồn là CJK/Arabic và đích không phải English */
  _shouldPivot() {
    if (!this.translator) return false;
    const PIVOT_SOURCES = new Set(['jpn_Jpan', 'zho_Hans', 'kor_Hang', 'tha_Thai', 'arb_Arab']);
    return PIVOT_SOURCES.has(this.translator.srcCode) && this.translator.tgtCode !== 'eng_Latn';
  }

}

module.exports = Pipeline;

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
const NLLBClient      = require('../ai/NLLBClient');

// Format elapsed ms → 'M:SS'
function fmtTime(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const CONTEXT_WINDOW = 5; // số câu giữ lại làm ngữ cảnh
// Match bất kỳ chuỗi nằm trong [...] hoặc (...) — bao gồm cả Unicode/tiếng Nhật
const BLANK_PATTERN  = /^\s*\[[^\[\]]+\]\s*$|^\s*\([^()]+\)\s*$/;

// ── Sentence-level accumulator ────────────────────────────────────────────
/**
 * Gom các mảnh transcript từ Whisper cho đến khi phát hiện dấu câu kết thúc
 * (. ! ? 。 ！ ？) hoặc hết timeout, rồi mới gửi đi dịch.
 *
 * Điều này giải quyết vấn đề AudioBuffer cắt âm thanh theo khoảng lặng
 * (pause giữa vế câu) thay vì theo ranh giới câu thật sự.
 */
class SentenceAccumulator {
  /**
   * @param {object} opts
   * @param {number}   [opts.maxWaitMs=3000]  ms tối đa chờ câu hoàn chỉnh
   * @param {number}   [opts.maxChars=200]    flush ngay nếu text quá dài
   * @param {string}   [opts.language='']     ISO lang để điều chỉnh clause detection
   * @param {Function} opts.onFlush           callback(text, timestamp, epoch)
   */
  constructor({ maxWaitMs = 3000, maxChars = 200, language = '', onFlush } = {}) {
    this._parts      = [];
    this._firstTs    = null;
    this._firstEpoch = null;
    this._timer      = null;
    this._maxWaitMs  = maxWaitMs;
    this._maxChars   = maxChars;
    this._language   = language;  // 'ja', 'en', 'vi', ...
    this._onFlush    = onFlush;
  }

  push(text, timestamp, epoch) {
    if (this._parts.length === 0) {
      this._firstTs    = timestamp;
      this._firstEpoch = epoch;
    }
    this._parts.push(text);
    const joined = this._joined();

    // Flush ngay nếu phát hiện câu hoàn chỉnh hoặc text quá dài
    if (this._isSentenceEnd(joined) || joined.length >= this._maxChars) {
      this._doFlush();
      return;
    }

    // Reset timer mỗi lần nhận thêm text mới — chờ thêm maxWaitMs
    // từ chunk cuối cùng (thay vì từ chunk đầu tiên)
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._doFlush();
    }, this._maxWaitMs);
  }

  _joined() {
    if (this._parts.length === 0) return '';
    // Tiếng Nhật không cần khoảng trắng giữa các từ/vế
    const hasJapanese = /[\u3040-\u30ff\u4e00-\u9fff]/.test(this._parts[0]);
    return hasJapanese
      ? this._parts.join('').trim()
      : this._parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  _isSentenceEnd(text) {
    const t = text.trim();
    if (!t) return false;

    if (this._language === 'ja') {
      // 。！？ = definite sentence end
      if (/[。！？]\s*$/.test(t)) return true;
      // 、or ，= clause boundary — only flush after substantial text (≥ 40 chars)
      // Short clauses like "今日は、" should accumulate more context for accurate translation
      if (/[\u3001\uff0c]\s*$/.test(t) && t.length >= 40) return true;
      return false;
    }

    // English / Vietnamese / default
    if (/[!?]\s*$/.test(t)) return true;
    // Period — but skip common abbreviations
    if (/\.\s*$/.test(t)) {
      if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Jr|Sr|vs|etc)\b\.\s*$/i.test(t)) return false;
      return true;
    }
    return false;
  }

  _doFlush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const text  = this._joined();
    const ts    = this._firstTs;
    const epoch = this._firstEpoch;
    this._parts      = [];
    this._firstTs    = null;
    this._firstEpoch = null;
    if (text && this._onFlush) this._onFlush(text, ts, epoch);
  }

  /** Flush ngay lập tức bất kể trạng thái — dùng khi stop() */
  forceFlush() {
    if (this._parts.length > 0) this._doFlush();
  }

  reset() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._parts      = [];
    this._firstTs    = null;
    this._firstEpoch = null;
  }
}

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

// ── Per-language presets for AudioBuffer and SentenceAccumulator ──────────
// Tuned for natural speech patterns of each language
const LANG_PRESETS = {
  ja: {
    // Japanese: SOV structure — verb comes at end, sentences are long
    // Speakers pause briefly (300-500ms) between clauses but need full sentence for meaning
    chunkMaxMs:  10000,   // JP sentences can be very long, wait for full thought
    silenceMs:   600,     // JP natural clause pauses are short (~300-500ms)
    minSpeechMs: 300,     // short utterances like はい are valid
    maxWaitMs:   4000,    // wait longer for verb at end of sentence
    maxChars:    300,     // JP sentences can be longer before forced flush
  },
  en: {
    // English: SVO structure — meaning is clear earlier in sentence
    // Speakers pause ~0.5-1s between sentences, shorter within
    chunkMaxMs:  8000,    // EN sentences are moderate length
    silenceMs:   1000,    // EN natural sentence pauses ~0.7-1.2s
    minSpeechMs: 400,     // filter very short noise bursts
    maxWaitMs:   2500,    // EN sentences resolve faster
    maxChars:    200,     // standard flush threshold
  },
  vi: {
    // Vietnamese: SVO like English, tonal with clear pauses
    chunkMaxMs:  8000,
    silenceMs:   1000,
    minSpeechMs: 400,
    maxWaitMs:   2500,
    maxChars:    200,
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
    this._startTime   = null;
    this._segId       = 0;
    this._epoch       = 0;       // tăng mỗi lần stop() — discard kết quả cũ
    this._context     = [];
    this._recentTexts = [];      // dedup: last N complete transcripts

    // Gom mảnh transcript thành câu hoàn chỉnh trước khi dịch
    this._sentAccum = new SentenceAccumulator({
      maxWaitMs: preset.maxWaitMs,
      maxChars:  preset.maxChars,
      language:  _srcToWhisperLang(cfg.sourceLanguage),
      onFlush: (text, timestamp, epoch) => {
        if (this._epoch !== epoch) return; // đã stop() rồi — bỏ qua
        const id = ++this._segId;
        this.emit('transcript', { text, timestamp, id });
        if (!this.cfg.translateEnabled) {
          this._addContext(text, '');
          this.emit('translation', { original: text, translated: '', timestamp, id });
          return;
        }
        this._transQueue.push({ transcript: text, timestamp, id, epoch: this._epoch });
        this._drainTranslation();
      },
    });
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

    this._sentAccum.reset();
    this.abuf.removeAllListeners('chunk');
    this.abuf.removeAllListeners('started');
    this.abuf.on('started', (startMs) => {
      // Notify renderer to show '...' listening bubble
      this.emit('listening', { timestamp: startMs - this._startTime });
    });
    this.abuf.on('chunk', (buf, startMs) => {
      const elapsed = startMs - this._startTime;
      this._queue.push({ buf, timestamp: elapsed });
      this._drainSTT();
    });

    this._startTime = Date.now();
    this._segId     = 0;
    this._context   = [];
    this.isRunning  = true;
    this.emit('started');
  }

  stop() {
    if (!this.isRunning) return;
    // Tăng epoch — mọi STT/translation đang chờ sẽ bị discard khi hoàn thành
    this._epoch++;
    // Flush và reset sentence accumulator — không để câu dở dang
    this._sentAccum.forceFlush();
    this._sentAccum.reset();
    // Dừng audio input ngay
    this.abuf.reset();
    this.abuf.removeAllListeners('chunk');
    this.abuf.removeAllListeners('partial');
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
    // Update SentenceAccumulator for new language
    this._sentAccum._language  = _srcToWhisperLang(cfg.sourceLanguage);
    this._sentAccum._maxWaitMs = preset.maxWaitMs;
    this._sentAccum._maxChars  = preset.maxChars;
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
    // Update SentenceAccumulator rules
    this._sentAccum._language  = lang;
    this._sentAccum._maxWaitMs = preset.maxWaitMs;
    this._sentAccum._maxChars  = preset.maxChars;
  }

  // ── Internal: partial audio preview ───────────────────────
  // (removed — no longer sending audio to Whisper mid-chunk)

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

    // Đưa mảnh transcript vào SentenceAccumulator.
    // Accumulator sẽ gom lại và chỉ emit 'transcript' + enqueue dịch
    // khi phát hiện dấu câu kết thúc hoặc hết timeout.
    this._sentAccum.push(transcript, timestamp, this._epoch);
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
    let pivotEnglish = '';
    try {
      const ctx = this._getTranslationContext();
      if (this._shouldPivot()) {
        // Pivot: source → English → target
        // Bước 1 (CJK→EN): beam cao hơn + không truyền context (CJK context làm model nhầm)
        pivotEnglish = await this.translator.translateRaw(
          transcript, this.translator.srcCode, 'eng_Latn', '', 6,
        );
        if (!pivotEnglish || this._epoch !== epoch) return;
        // Bước 2 (EN→VI): truyền English context câu trước — Latin với Latin hoạt động tốt
        translated = await this.translator.translateRaw(
          pivotEnglish, 'eng_Latn', this.translator.tgtCode, ctx.pivotEnglish,
        );
      } else {
        translated = await this.translator.translateRaw(
          transcript, this.translator.srcCode, this.translator.tgtCode, ctx.original,
        );
      }
    } catch (err) {
      throw new Error(`Translation failed: ${err.message}`);
    }
    if (this._epoch !== epoch) return;
    if (translated) {
      this._addContext(transcript, translated, pivotEnglish);
      this.emit('translation', { original: transcript, translated, timestamp, id });
    }
  }

  /** Get last translation pair as context */
  _getTranslationContext() {
    const last = this._context.length > 0 ? this._context[this._context.length - 1] : null;
    return {
      original:     last?.original     || '',
      translated:   last?.translated   || '',
      pivotEnglish: last?.pivotEnglish || '',
    };
  }

  /** Tự động dùng pivot khi nguồn là CJK/Arabic và đích không phải English */
  _shouldPivot() {
    if (!this.translator) return false;
    const PIVOT_SOURCES = new Set(['jpn_Jpan', 'zho_Hans', 'kor_Hang', 'tha_Thai', 'arb_Arab']);
    return PIVOT_SOURCES.has(this.translator.srcCode) && this.translator.tgtCode !== 'eng_Latn';
  }

  /** Thêm vào cửa sổ ngữ cảnh, giữ tối đa CONTEXT_WINDOW câu */
  _addContext(original, translated, pivotEnglish) {
    this._context.push({ original, translated, pivotEnglish: pivotEnglish || '' });
    if (this._context.length > CONTEXT_WINDOW) this._context.shift();
  }
}

module.exports = Pipeline;

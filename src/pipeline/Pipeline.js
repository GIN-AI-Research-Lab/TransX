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
const NLLBClient      = require('../ai/NLLBClient');

// Format elapsed ms → 'M:SS'
function fmtTime(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Match bất kỳ chuỗi nằm trong [...] hoặc (...) — bao gồm cả Unicode/tiếng Nhật
const BLANK_PATTERN  = /^\s*\[[^\[\]]+\]\s*$|^\s*\([^()]+\)\s*$/;

/**
 * Normalize text for dedup comparison:
 *   - lowercase
 *   - strip trailing punctuation (dấu câu cuối không quan trọng khi so sánh)
 *   - collapse whitespace
 * Note: giữ nguyên chữ hoa giữa câu để proper noun khớp đúng
 */
function _normForDedup(text) {
  return text
    .replace(/[.!?,;:。、．！？…]+$/g, '')  // strip trailing punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Detect repetition: same short word/phrase repeated 3+ times
// Matches patterns like "はい。はい。はい" or "yes yes yes" or "ok ok ok ok"
// Catches 2+ repetitions (not just 3+)
const REPETITION_PATTERN = /^(.{1,12})[.。、,\s]+\1([.。、,\s]+\1)*[.。、,\s]*$/;

// Whisper hallucination phrases — produced when audio has no real speech
// (music, silence, noise). Expand this list as needed.
const HALLUCINATION_EXACT = new Set([
  // Japanese — filler sounds & common hallucinations
  '音楽', '(音楽)', '[音楽]', '字幕', 'ご視聴ありがとうございました', 'ご覧ありがとうございました',
  'ご視聴ありがとうございました。', '字幕制作', '反調',
  'はい', 'はい。', 'うん', 'うん。', 'えー', 'えーと', 'あー',
  'さあ', 'さあ。', 'さあ、', 'ほら', 'ほら。', 'ほら、', 'ねえ', 'ねえ。',
  'あのう', 'あのう、', 'あの', 'まあ', 'まあ。', 'ようし',
  'なるほど', 'なるほど。',
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
  // Detect repetitive text like "はい。はい。はい。はい"
  if (REPETITION_PATTERN.test(t)) return true;
  return false;
}

// ── Aizuchi bypass cache (Point 3) ─────────────────────────────────────────
// Quick-lookup for common Japanese fillers/acknowledgments — bypasses NLLB entirely.
// Keys are trimmed text exactly as Whisper would output them.
const AIZUCHI_CACHE = new Map([
  // Consent / acknowledgment
  ['はい、そうです', 'Vâng, đúng vậy'],        ['はい、そうです。', 'Vâng, đúng vậy'],
  ['そうですね', 'Vậy nhỉ'],              ['そうですね。', 'Vậy nhỉ'],
  ['そうですよね', 'Đúng vậy nhỉ'],           ['そうですよね。', 'Đúng vậy nhỉ'],
  ['そうですか', 'Vậy à'],               ['そうですか。', 'Vậy à'],
  ['そうか', 'Vậy à'],                   ['そうか。', 'Vậy à'],
  ['そうだね', 'Hmm, đúng vậy'],           ['そうだな', 'Hmm, đúng vậy nhỉ'],
  // Comprehension
  ['なるほどです', 'Ra là vậy'],            ['なるほどですね', 'Ra là vậy nhỉ'],
  ['わかりました', 'Hiểu rồi'],             ['わかりました。', 'Hiểu rồi'],
  ['わかった', 'Hiểu rồi'],                  ['わかった。', 'Hiểu rồi'],
  ['わかりました。ありがとうございます。', 'Hiểu rồi, cảm ơn bạn'],
  // Gratitude
  ['ありがとうございます', 'Cảm ơn bạn'],  ['ありがとうございます。', 'Cảm ơn bạn'],
  ['ありがとう', 'Cảm ơn'],               ['ありがとう。', 'Cảm ơn'],
  ['どうもありがとう', 'Thật sự cảm ơn'],  ['どうもありがとう。', 'Thật sự cảm ơn'],
  // Apology / courtesy
  ['すみません', 'Xin lỗi'],               ['すみません。', 'Xin lỗi'],
  ['失礼しました', 'Xin lỗi đã phải phền'],     ['失礼しました。', 'Xin lỗi đã phải phền'],
  ['ごめんなさい', 'Xin lỗi'],           ['ごめんなさい。', 'Xin lỗi'],
  // Wait / pause
  ['ちょっと待って', 'Đợi chút'],         ['ちょっと待って。', 'Đợi chút'],
  ['少し待ってください', 'Xin chờ một chút'],
  ['ちょっと待ってください', 'Xin chờ một chút'],
  // Negation
  ['いいえ', 'Không'],                    ['いいえ。', 'Không'],
  ['いいえ、違います', 'Không, không phải vậy'],  ['違います', 'Không phải vậy'],
  // Greeting / closing
  ['おはようございます', 'Xin chào buổi sáng'],   ['こんにちは', 'Xin chào'],
  ['こんのちは。', 'Chào buổi chiều'],       ['さようなら', 'Tạm biệt'],
  ['さようなら。', 'Tạm biệt'],              ['またね', 'Hẹn gặp lại'],
]);

// ── English filler / greeting bypass cache ────────────────────────────────────
// Instant-lookup for common EN conversational phrases — bypasses NLLB.
// Keys are normalized to lowercase with trailing punctuation stripped.
const EN_FILLER_CACHE = new Map([
  // Acknowledgment / agreement
  ['yeah', 'Vâng'], ['yep', 'Vâng'], ['yup', 'Vâng'],
  ['yes', 'Vâng'], ['no', 'Không'], ['nope', 'Không'],
  ['okay', 'Được'], ['ok', 'Được'], ['alright', 'Được rồi'],
  ['right', 'Đúng rồi'], ['sure', 'Chắc chắn'], ['of course', 'Dĩ nhiên'],
  ['absolutely', 'Tất nhiên'], ['exactly', 'Chính xác'], ['correct', 'Đúng'],
  ['got it', 'Hiểu rồi'], ['i see', 'Tôi hiểu'], ['i understand', 'Tôi hiểu'],
  ['understood', 'Đã hiểu'], ['i know', 'Tôi biết'], ['not really', 'Không hẳn'],
  ['i think so', 'Tôi nghĩ vậy'], ["i don't think so", 'Tôi không nghĩ vậy'],
  // Greetings
  ['hello', 'Xin chào'], ['hi', 'Chào'], ['hey', 'Này'],
  ['good morning', 'Chào buổi sáng'], ['good afternoon', 'Chào buổi chiều'],
  ['good evening', 'Chào buổi tối'], ['good night', 'Chúc ngủ ngon'],
  ['nice to meet you', 'Rất vui được gặp bạn'],
  ['how are you', 'Bạn khỏe không'], ["how's it going", 'Mọi thứ thế nào rồi'],
  // Farewells
  ['bye', 'Tạm biệt'], ['goodbye', 'Tạm biệt'], ['see you', 'Hẹn gặp lại'],
  ['see you later', 'Hẹn gặp lại sau'], ['take care', 'Bảo trọng'],
  ['bye bye', 'Tạm biệt nhé'], ['farewell', 'Tạm biệt'],
  // Thanks
  ['thank you', 'Cảm ơn'], ['thanks', 'Cảm ơn'],
  ['thank you very much', 'Cảm ơn rất nhiều'],
  ['thank you so much', 'Cảm ơn bạn rất nhiều'],
  ['thanks a lot', 'Cảm ơn nhiều lắm'], ['many thanks', 'Cảm ơn nhiều'],
  ['thank you for watching', ''],  // Whisper hallucination — suppress
  ['thanks for watching', ''],     // Whisper hallucination — suppress
  ['please like and subscribe', ''], // Whisper hallucination — suppress
  // Apology / courtesy
  ['sorry', 'Xin lỗi'], ["i'm sorry", 'Xin lỗi'], ['excuse me', 'Xin lỗi'],
  ['pardon', 'Xin lỗi'], ['pardon me', 'Xin lỗi'], ['my bad', 'Lỗi của tôi'],
  ['no worries', 'Không sao đâu'], ['no problem', 'Không sao'],
  ["that's okay", 'Không sao đâu'], ["you're welcome", 'Không có gì'],
  ['not at all', 'Không có gì đâu'], ['never mind', 'Thôi kệ'],
  // Positive reactions
  ['great', 'Tuyệt vời'], ['nice', 'Tuyệt'], ['awesome', 'Tuyệt vời'],
  ['perfect', 'Hoàn hảo'], ['excellent', 'Xuất sắc'], ['wonderful', 'Tuyệt vời'],
  ['good', 'Tốt'], ['good job', 'Làm tốt lắm'], ['well done', 'Làm tốt lắm'],
  ['great job', 'Làm tốt lắm'], ['amazing', 'Thật tuyệt'], ['fantastic', 'Tuyệt'],
  ['brilliant', 'Xuất sắc'], ['superb', 'Tuyệt vời'],
  // Wait / pause
  ['wait', 'Đợi đã'], ['hold on', 'Giữ máy'], ['one moment', 'Một chút'],
  ['just a moment', 'Chỉ một chút thôi'], ['just a second', 'Một giây thôi'],
  ['wait a minute', 'Đợi một chút'], ['wait a moment', 'Đợi một chút'],
  // Uncertainty / negation
  ["i don't know", 'Tôi không biết'], ["i'm not sure", 'Tôi không chắc'],
  ['maybe', 'Có thể'], ['perhaps', 'Có thể'], ['possibly', 'Có thể'],
  ['of course not', 'Tất nhiên là không'], ['no way', 'Không thể nào'],
  // Other common
  ['please', 'Xin mời'], ['welcome', 'Chào mừng'], ['cheers', 'Chúc mừng'],
  ['congratulations', 'Xin chúc mừng'], ['congrats', 'Chúc mừng'],
]);

/** Lookup EN filler cache: case-insensitive, strips trailing punctuation */
function _lookupEnFiller(text) {
  const key = text.trim().replace(/[.!?,]+$/, '').toLowerCase();
  const val = EN_FILLER_CACHE.get(key);
  // undefined = not in cache; '' = suppress hallucination; string = translation
  return val;
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
  'en': 'Right, so basically, I mean,',  // conditioning: conversational EN với dấu câu tự nhiên
  'ja': 'こちらこそ。はい。そこで、',  // conditioning: Japanese với kana + dấu 。、
  'vi': 'Vâng. Ok. Vậy,',          // conditioning: Vietnamese
};
function _srcToInitialPrompt(src) {
  const lang = _srcToWhisperLang(src);
  return WHISPER_PROMPTS[lang] || '';
}

// ── Per-language presets for AudioBuffer ────────────────────────────────────────
// Timing được căn chỉnh theo đặc điểm ngôn ngữ:
//   silenceMs : khoảng lặng tối thiểu để xác định câu kết thúc
//               Quá ngắn → flush giữa câu (speaker đang nghĩ) → câu bị cắt
//               Quá dài  → delay hiển thị
//   chunkMaxMs: hard cap khi không phát hiện khoảng lặng (nói liên tục)
const LANG_PRESETS = {
  ja: {
    chunkMaxMs:  8000,    // JP đã xác nhận chạy tốt — KHÔNG thay đổi
    silenceMs:   400,     // pause 400ms — JP utterance ngắn, flush nhanh
    minSpeechMs: 250,
    snapshotMs:  800,     // sliding window nhanh cho streaming JP
  },
  en: {
    chunkMaxMs:  9000,    // EN câu dài (complex sentences) — hard cap dài tương đương JP
    silenceMs:   600,     // EN đọc trái→phải (SVO): nửa câu đã đủ nghĩa để dịch
                          // → flush tại các khoảng nghỉ tự nhiên như JP, không cần đợi dài
    minSpeechMs: 250,     // giống JP: chấp nhận utterance ngắn ("OK", "Got it")
    snapshotMs:  900,     // giống JP: partial text hiển thị nhanh
  },
  vi: {
    chunkMaxMs:  7000,
    silenceMs:   700,     // VI monosyllabic → pause ngắn hơn EN
    minSpeechMs: 300,
    snapshotMs:  1500,
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
      snapshotMs:  preset.snapshotMs,
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
    this._draftBusy = false;     // guard against concurrent draft translations

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
    this._recentTexts   = [];    // dedup: last N complete transcripts
    this._contextWindow = [];    // (Point 1) last 2 JP transcripts → Whisper initial_prompt
    this._transContext  = [];    // (Point 4) last 3 JP transcripts → NLLB context_src
    this._lastPartialText = '';  // track last partial to avoid duplicate emit
  }

  // ── Start / Stop ──────────────────────────────────────────────────
  async start(userContext) {
    if (this.isRunning) return;

    // Store user context for initial prompt enrichment
    this._userContext = (userContext || '').trim();
    if (this._userContext) {
      // Append user context to whisper initial prompt for better accuracy
      const basePrompt = _srcToInitialPrompt(this.cfg.sourceLanguage);
      this.whisper.initialPrompt = basePrompt
        ? `${basePrompt} ${this._userContext}`
        : this._userContext;
      console.log(`[pipeline] context: "${this._userContext}"`);
    }

    // Kiểm tra Whisper server trước khi start
    const ok = await this.whisper.ping();
    if (!ok) {
      this.emit('error', new Error(
        `Faster-Whisper server chưa chạy tại ${this.cfg.whisperEndpoint || 'http://localhost:8080'}\n` +
        `Hãy chờ server khởi động hoàn tất.`
      ));
      return;
    }

    // Translator: CT2 server only (dùng faster-whisper + nllb-ct2-model)
    const ct2ok = await this._nllbCt2.ping();
    if (!ct2ok) {
      this.emit('error', new Error(
        'NLLB CT2 translation server chưa sẵn sàng.\n' +
        'Server đang khởi động — vui lòng chờ vài giây rồi thử lại.'
      ));
      this.isRunning = false;
      return;
    }
    this.translator = this._nllbCt2;
    console.log('[pipeline] translator: CTranslate2 (CT2)');

    if (this._isJaSource()) {
      console.log('[pipeline] Japanese: NLLB-CT2 direct JP→VI (no EN pivot)');
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
    this._queue         = [];
    this._transQueue    = [];
    this._recentTexts   = [];
    this._contextWindow = [];
    this._transContext  = [];
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
      snapshotMs:  preset.snapshotMs,
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
    this.abuf.maxMs       = preset.chunkMaxMs;
    this.abuf.silenceMs   = preset.silenceMs;
    this.abuf.minSpeechMs = preset.minSpeechMs;
    this.abuf.snapshotMs  = preset.snapshotMs;
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
        // Japanese: start draft NLLB translation concurrently on partial text
        if (this._isJaSource() && t.length >= 3) {
          this._startDraftTranslation(t, timestamp);
        }
        // English: start draft translation on partial when 3+ words available
        if (this._isEnSource() && t.split(/\s+/).length >= 3) {
          this._startDraftTranslation(t, timestamp);
        }
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
      // Point 1: inject sliding context window into Whisper initial_prompt
      // JP: Zero Anaphora — Whisper remembers subject/topic from prior sentences
      // EN: Proper noun / term continuity — last sentence helps decode names & terms
      if ((this._isJaSource() || this._isEnSource()) && this._contextWindow.length > 0) {
        const base = _srcToInitialPrompt(this.cfg.sourceLanguage);
        const ctx  = this._contextWindow.slice(-2).join(' ');
        const user = this._userContext || '';
        // Combine: base conditioning + user context + recent sentences (max 224 chars)
        const combined = [base, user, ctx].filter(Boolean).join(' ');
        this.whisper.initialPrompt = combined.slice(0, 224);
      }
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

    // Repetition dedup — tách riêng JP và EN:
    //
    // JP: chỉ so sánh exact-normalized (strip dấu câu cuối + lowercase).
    //     KHÔNG dùng "contained" check vì JP không có khoảng trắng giữa từ →
    //     câu JP ngắn hợp lệ rất dễ là substring của câu dài trước → bị suppress sai.
    //     Ví dụ: "お元気ですか" nằm trong "山田さんはお元気ですか？" nhưng là 2 utterance khác nhau.
    //
    // EN: dùng thêm "contained" check để bắt trường hợp Whisper re-transcribe cùng audio
    //     thành fragment ngắn hơn (EN có spaces nên substring check an toàn hơn).
    const normNew = _normForDedup(transcript);
    const isDup = this._recentTexts.some(r => {
      const normR = _normForDedup(r);
      if (normNew === normR) return true;
      // EN only: fragment đã nằm trong recent text → re-transcription của cùng audio
      if (this._isEnSource() &&
          normNew.length > 0 && normR.includes(normNew) &&
          normNew.length / normR.length < 0.75) return true;
      return false;
    });
    if (isDup) return;
    this._recentTexts.push(transcript);
    if (this._recentTexts.length > 8) this._recentTexts.shift();

    // Reset partial tracking — final text replaces any partial
    this._lastPartialText = '';

    // Point 1: update Whisper context window with confirmed transcript (JP + EN)
    if (this._isJaSource() || this._isEnSource()) {
      this._contextWindow.push(transcript);
      if (this._contextWindow.length > 2) this._contextWindow.shift();
    }

    // Emit final transcript immediately (replaces partial in UI)
    const id = ++this._segId;
    this.emit('transcript', { text: transcript, timestamp, id });
    if (!this.cfg.translateEnabled) {
      this.emit('translation', { original: transcript, translated: '', timestamp, id });
      return;
    }

    // Japanese / English: translate immediately — both benefit from zero-delay dispatch.
    // JP: verb-final structure → rush to translate once sentence boundary detected.
    // EN: SVO structure → meaning is front-loaded, translation can start at once.
    if (this._isJaSource() || this._isEnSource()) {
      this._transQueue.push({ transcript, timestamp, id, epoch: this._epoch });
      this._drainTranslation();
      return;
    }

    // Other (less tested) languages: small delay for stability
    const currentEpoch = this._epoch;
    setTimeout(() => {
      if (this._epoch !== currentEpoch) return;
      this._transQueue.push({ transcript, timestamp, id, epoch: currentEpoch });
      this._drainTranslation();
    }, 300);
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

    // Point 3: Aizuchi bypass cache — instant translation without NLLB (JP)
    if (this._isJaSource()) {
      const cached = AIZUCHI_CACHE.get(transcript);
      if (cached) {
        this.emit('translation', { original: transcript, translated: cached, timestamp, id });
        return;
      }
    }
    // EN filler bypass — common conversational phrases skip NLLB entirely
    if (this._isEnSource()) {
      const cached = _lookupEnFiller(transcript);
      if (cached !== undefined) {
        // cached === '' means suppress (Whisper hallucination like "Thanks for watching")
        if (cached) {
          this.emit('translation', { original: transcript, translated: cached, timestamp, id });
        }
        return;
      }
    }

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
        // JP: sliding context — NLLB server xu ly rieng cho CJK
        // EN: KHONG dung context_src — prepend cau truoc gay ra lap lai output
        const ctxSrc = this._isJaSource() && this._transContext.length > 0
          ? this._transContext[this._transContext.length - 1]
          : '';
        if (this._isEnSource()) {
          // Progressive translation: emit moi nhom ngay khi xong (draft: true)
          // thay vi doi tat ca → user thay ban dich som hon ~400ms/nhom
          const parts = this._splitEnglishSentences(transcript);
          if (parts.length > 1) {
            let accumulated = '';
            for (let i = 0; i < parts.length; i++) {
              if (this._epoch !== epoch) return;
              const r = await this.translator.translateRaw(
                parts[i], this.translator.srcCode, this.translator.tgtCode, '',
              );
              if (!r) continue;
              accumulated = accumulated ? accumulated + ' ' + r.trim() : r.trim();
              if (_isNoise(accumulated) || REPETITION_PATTERN.test(accumulated)) continue;
              const isFinal = (i === parts.length - 1);
              this.emit('translation', {
                original: transcript, translated: accumulated,
                timestamp, id,
                ...(isFinal ? {} : { draft: true }),
              });
            }
            return; // da emit o tren, bo qua emit cuoi ham
          } else {
            translated = await this.translator.translateRaw(
              transcript, this.translator.srcCode, this.translator.tgtCode, '',
            );
          }
        } else {
          translated = await this.translator.translateRaw(
            transcript, this.translator.srcCode, this.translator.tgtCode, ctxSrc,
          );
        }
      }
    } catch (err) {
      throw new Error(`Translation failed: ${err.message}`);
    }
    if (this._epoch !== epoch) return;
    if (translated) {
      const tr = translated.trim();
      // Filter repetitive translation output (e.g. NLLB hallucination "đây rồi, đây rồi")
      if (!_isNoise(tr) && !REPETITION_PATTERN.test(tr)) {
        // Point 4: update translation context window (JP only — EN khong dung context)
        if (this._isJaSource()) {
          this._transContext.push(transcript);
          if (this._transContext.length > 3) this._transContext.shift();
        }
        this.emit('translation', { original: transcript, translated: tr, timestamp, id });
      }
    }
  }

  /** Tự động dùng pivot khi nguồn là CJK/Arabic và đích không phải English */
  _shouldPivot() {
    if (!this.translator) return false;
    // Japanese: dịch thẳng JP→VI, không cần pivot qua EN
    if (this._isJaSource()) return false;
    const PIVOT_SOURCES = new Set(['zho_Hans', 'kor_Hang', 'tha_Thai', 'arb_Arab']);
    return PIVOT_SOURCES.has(this.translator.srcCode) && this.translator.tgtCode !== 'eng_Latn';
  }

  // ── Sentence splitting helper ───────────────────────────────────────────

  /**
   * Split English text thành các phần để dịch với NLLB.
   *
   * Chiến lược: tách tại dấu . ! ? — mỗi câu độc lập cho kết quả NLLB tốt nhất.
   * Sau đó ghép thành nhóm tối đa 2 câu liên mạch để giảm số lần gọi server
   * trong khi vẫn giữ context ngắn cho model.
   *
   * Ví dụ: "I went to the store. I bought some milk. Then I came home."
   *   → ["I went to the store. I bought some milk.", "Then I came home."]
   *
   * @param  {string}   text
   * @returns {string[]} Mảng các đoạn cần dịch (mỗi đoạn ≤ 2 câu)
   */
  _splitEnglishSentences(text) {
    if (!text || text.length < 30) return [text];

    // Tách tại dấu câu kết thúc có theo sau chữ hoa hoặc cuối chuỗi
    const sentences = text
      .split(/(?<=[.!?])\s+(?=[A-Z"'\u201C])/)
      .map(s => s.trim())
      .filter(Boolean);

    if (sentences.length <= 1) return [text];

    // Ghép thành nhóm 2 câu: [s1+s2, s3+s4, ...]
    const groups = [];
    for (let i = 0; i < sentences.length; i += 2) {
      if (i + 1 < sentences.length) {
        groups.push(sentences[i] + ' ' + sentences[i + 1]);
      } else {
        groups.push(sentences[i]);
      }
    }
    return groups;
  }

  // ── Language source helpers ──────────────────────────────────────────────

  /** Check if current source language is Japanese */
  _isJaSource() {
    return _srcToWhisperLang(this.cfg.sourceLanguage) === 'ja';
  }

  /** Check if current source language is English */
  _isEnSource() {
    return _srcToWhisperLang(this.cfg.sourceLanguage) === 'en';
  }

  /**
   * Draft translation on partial Japanese text using NLLB-CT2.
   * Fires-and-forgets; skips if a draft is already in-flight.
   */
  _startDraftTranslation(text, timestamp) {
    if (this._draftBusy || !this.translator) return;
    this._draftBusy = true;
    const epoch = this._epoch;
    this.translator.translateRaw(
      text, this.translator.srcCode, this.translator.tgtCode,
    ).then((translated) => {
      if (this._epoch !== epoch || !translated) return;
      this.emit('draft-translation', { text: translated.trim(), timestamp });
    }).catch(() => {
      // Draft failed — ignore silently, final translation will handle it
    }).finally(() => {
      this._draftBusy = false;
    });
  }

}

module.exports = Pipeline;

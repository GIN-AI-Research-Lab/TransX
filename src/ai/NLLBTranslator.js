/**
 * src/ai/NLLBTranslator.js
 *
 * In-process translation using NLLB-200 distilled 600M (quantized ONNX).
 * Uses @xenova/transformers — no Ollama, no external service, no internet at runtime.
 *
 * Model files must exist at: <root>/nllb-models/nllb-200-distilled-600M/
 * Run `npm run download-model` once to populate the model files.
 *
 * Drop-in replacement for TranslatorClient — same .translate() signature.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── NLLB-200 flores+ language codes ──────────────────────────────────────────
// Maps display names (used in config) → NLLB flores+ BCP-47 codes
const LANG_CODE = {
  'auto':       'eng_Latn',  // default when source language is unknown
  'English':    'eng_Latn',
  'Vietnamese': 'vie_Latn',
  'Chinese':    'zho_Hans',
  'Japanese':   'jpn_Jpan',
  'Korean':     'kor_Hang',
  'French':     'fra_Latn',
  'German':     'deu_Latn',
  'Spanish':    'spa_Latn',
  'Russian':    'rus_Cyrl',
  'Thai':       'tha_Thai',
  'Arabic':     'arb_Arab',
  'Portuguese': 'por_Latn',
  'Italian':    'ita_Latn',
  'Dutch':      'nld_Latn',
  'Polish':     'pol_Latn',
  'Turkish':    'tur_Latn',
  'Hindi':      'hin_Deva',
  'Indonesian': 'ind_Latn',
};

function toLangCode(name) {
  if (!name || name === 'auto') return 'eng_Latn';
  const code = LANG_CODE[name];
  if (code) return code;
  // Accept raw flores+ codes (e.g. 'vie_Latn')
  if (/^[a-z]{3}_[A-Z][a-z]{3}$/.test(name)) return name;
  return 'eng_Latn';
}

// ── Singleton pipeline (shared across all NLLBTranslator instances) ───────────
let _pipe        = null;
let _pipePromise = null;

/**
 * Lazily initialise (and cache) the @xenova/transformers translation pipeline.
 * @param {string} modelDir  Absolute path that contains nllb-200-distilled-600M/
 * @returns {Promise<object>}
 */
async function loadPipeline(modelDir) {
  if (_pipe) return _pipe;
  if (_pipePromise) return _pipePromise;

  _pipePromise = (async () => {
    // @xenova/transformers là ES Module — phải dùng dynamic import(), không dùng require()
    // sharp đã được chặn bằng Module._load hook ở đầu main.js
    const { pipeline, env } = await import('@xenova/transformers');

    // Point library to local model directory — disable any remote fetching
    env.localModelPath    = modelDir;
    env.allowRemoteModels = false;
    env.useBrowserCache   = false;

    console.log('[nllb] Loading model from:', path.join(modelDir, 'nllb-200-distilled-600M'));

    const pipe = await pipeline('translation', 'nllb-200-distilled-600M', {
      quantized: true,
    });

    _pipe = pipe;
    console.log('[nllb] Model ready.');
    return _pipe;
  })();

  // If init fails, allow retry next call
  _pipePromise.catch(() => { _pipePromise = null; });

  return _pipePromise;
}

// ── NLLBTranslator ────────────────────────────────────────────────────────────
class NLLBTranslator {
  /**
   * @param {object} cfg
   * @param {string} [cfg.sourceLanguage]  display name or 'auto'  (default 'auto' → English)
   * @param {string} [cfg.targetLanguage]  display name             (default 'Vietnamese')
   */
  constructor(cfg = {}) {
    this.srcCode = toLangCode(cfg.sourceLanguage || 'auto');
    this.tgtCode = toLangCode(cfg.targetLanguage || 'Vietnamese');

    // Resolve model root directory (works in both dev and packaged builds)
    const { app } = require('electron');
    const appRoot = app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..', '..');

    this._modelDir  = path.join(appRoot, 'nllb-models');
    this._modelPath = path.join(this._modelDir, 'nllb-200-distilled-600M');

    // Begin loading eagerly so first translation has less latency
    this._ready = loadPipeline(this._modelDir);
  }

  /**
   * Translate a single sentence with NLLB-200.
   * Signature matches TranslatorClient.translate() for drop-in compatibility.
   *
   * @param {string}   text
   * @param {Array}    [context]   ignored — NLLB is a dedicated translation model
   * @param {Function} [onPartial] ignored — NLLB generates the full output in one pass
   * @returns {Promise<string>}
   */
  async translate(text, context = [], onPartial = null) {
    const t = text.trim();
    if (!t) return '';

    // Skip Whisper noise/hallucination labels like [BLANK_AUDIO], (music), etc.
    if (/^\s*[\[(][\w\s_]+[\])]\s*$/i.test(t)) return '';

    const pipe = await this._ready;
    const out  = await pipe(t, {
      src_lang:       this.srcCode,
      tgt_lang:       this.tgtCode,
      max_new_tokens: 256,
    });

    return out?.[0]?.translation_text?.trim() ?? '';
  }

  /**
   * Cập nhật ngôn ngữ ngườn/đích ngay cả khi đang dịch (hot-swap).
   * Pipeline sử dụng được khi config thay đổi lúc đang running.
   * @param {object} cfg
   */
  updateLanguage(cfg) {
    this.srcCode = toLangCode(cfg.sourceLanguage || 'auto');
    this.tgtCode = toLangCode(cfg.targetLanguage || 'Vietnamese');
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  /**
   * Kiểm tra các file model NLLB tối thiểu có tồn tại trên disk chưa.
   * @param {string} modelDir  Đường dẫn tuyệt đối đến thư mục nllb-models/
   * @returns {boolean}
   */
  static modelExists(modelDir) {
    const required = [
      path.join(modelDir, 'nllb-200-distilled-600M', 'config.json'),
      path.join(modelDir, 'nllb-200-distilled-600M', 'onnx', 'encoder_model_quantized.onnx'),
      path.join(modelDir, 'nllb-200-distilled-600M', 'onnx', 'decoder_model_merged_quantized.onnx'),
    ];
    return required.every(f => fs.existsSync(f));
  }

  /**
   * Pre-warm the pipeline (start loading in background without blocking).
   * Call at app startup to reduce first-translation latency.
   * @param {string} modelDir
   */
  static prewarm(modelDir) {
    loadPipeline(modelDir).catch(e => console.warn('[nllb] prewarm error:', e.message));
  }
}

module.exports = NLLBTranslator;

/**
 * src/ai/NLLBTranslator.js
 *
 * Wraps a Worker Thread that runs NLLB-200 ONNX inference.
 * The heavy ONNX work runs in nllb-worker.js so the Electron main
 * thread (Node.js event loop) is never blocked.
 *
 * Model files must exist at: <root>/nllb-models/nllb-200-distilled-600M/
 * Run `npm run download-model` once to populate the model files.
 */

'use strict';

const path             = require('path');
const fs               = require('fs');
const { Worker }       = require('worker_threads');

// ── NLLB-200 flores+ language codes ──────────────────────────────────────────
const LANG_CODE = {
  'auto':       'eng_Latn',
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
  if (/^[a-z]{3}_[A-Z][a-z]{3}$/.test(name)) return name;
  return 'eng_Latn';
}

// ── Worker Pool (2 workers, round-robin) ─────────────────────────────────────
const POOL_SIZE   = 2;
const WORKER_PATH = path.join(__dirname, 'nllb-worker.js');

// Model preference order: fastest first
const MODELS_BY_SPEED = [
  'nllb-200-distilled-200M',  // ~3x faster than 600M, prefer when available
  'nllb-200-distilled-600M',  // fallback
];

function _pickModel(modelDir) {
  for (const name of MODELS_BY_SPEED) {
    if (fs.existsSync(path.join(modelDir, name, 'config.json'))) return name;
  }
  return MODELS_BY_SPEED[MODELS_BY_SPEED.length - 1];
}

let _pool        = [];   // [{ worker, pending: Map<id,{resolve,reject}> }]
let _rr          = 0;    // round-robin counter
let _nextId      = 0;    // monotonic message id
let _poolPromise = null; // singleton init promise

function _getPool(modelDir) {
  if (_poolPromise) return _poolPromise;

  const modelName = _pickModel(modelDir);
  console.log(`[nllb] Using model: ${modelName}`);

  _poolPromise = Promise.all(
    Array.from({ length: POOL_SIZE }, (_, i) =>
      new Promise((resolve, reject) => {
        const entry = { worker: null, pending: new Map() };
        const w = new Worker(WORKER_PATH, { workerData: { modelDir, modelName } });

        w.on('message', (msg) => {
          if (msg.type === 'ready') {
            entry.worker = w;
            resolve(entry);
            return;
          }
          if (msg.type === 'init-error') {
            reject(new Error(msg.message));
            return;
          }
          if (msg.type === 'result' || msg.type === 'error') {
            const cb = entry.pending.get(msg.id);
            if (!cb) return;
            entry.pending.delete(msg.id);
            if (msg.type === 'error') cb.reject(new Error(msg.message));
            else cb.resolve(msg.text);
          }
        });

        w.on('error', (err) => {
          for (const [, cb] of entry.pending) cb.reject(err);
          entry.pending.clear();
          reject(err);
        });

        w.on('exit', (code) => {
          if (code !== 0) console.error(`[nllb-worker-${i}] Exited with code ${code}`);
        });
      })
    )
  ).then((entries) => {
    _pool = entries;
    console.log(`[nllb] Worker pool ready (${POOL_SIZE} workers).`);
  });

  _poolPromise.catch(() => {
    _poolPromise = null;
    _pool        = [];
  });

  return _poolPromise;
}

// ── NLLBTranslator ────────────────────────────────────────────────────────────
class NLLBTranslator {
  constructor(cfg = {}) {
    this.srcCode = toLangCode(cfg.sourceLanguage || 'auto');
    this.tgtCode = toLangCode(cfg.targetLanguage || 'Vietnamese');

    const { app } = require('electron');
    const appRoot = app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..', '..');

    this._modelDir = path.join(appRoot, 'nllb-models');

    // Start workers eagerly to reduce first-translation latency
    this._ready = _getPool(this._modelDir);
  }

  async translate(text) {
    const t = text.trim();
    if (!t) return '';
    if (/^\s*[\[(][\w\s_]+[\])]\s*$/i.test(t)) return '';

    await this._ready; // chờ pool sẵn sàng
    const id = ++_nextId;
    // Round-robin: phân phối đều cho 2 worker
    const entry = _pool[_rr++ % _pool.length];

    return new Promise((resolve, reject) => {
      entry.pending.set(id, { resolve, reject });
      entry.worker.postMessage({ type: 'translate', id, text: t, srcCode: this.srcCode, tgtCode: this.tgtCode });
    });
  }

  updateLanguage(cfg) {
    this.srcCode = toLangCode(cfg.sourceLanguage || 'auto');
    this.tgtCode = toLangCode(cfg.targetLanguage || 'Vietnamese');
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  static modelExists(modelDir) {
    return MODELS_BY_SPEED.some(name => {
      const base = path.join(modelDir, name);
      return fs.existsSync(path.join(base, 'config.json')) &&
             fs.existsSync(path.join(base, 'onnx', 'encoder_model_quantized.onnx')) &&
             fs.existsSync(path.join(base, 'onnx', 'decoder_model_merged_quantized.onnx'));
    });
  }

  static prewarm(modelDir) {
    _getPool(modelDir).catch(e => console.warn('[nllb] prewarm error:', e.message));
  }
}

module.exports = NLLBTranslator;


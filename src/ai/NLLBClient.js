/**
 * src/ai/NLLBClient.js
 *
 * HTTP client for nllb-ct2-server.py (CTranslate2 INT8).
 * Same interface as NLLBTranslator so Pipeline can swap transparently.
 *
 * POST /translate  { text, src_lang, tgt_lang } → { text }
 */

'use strict';

const http = require('http');

// flores+ language codes (same map as NLLBTranslator)
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
};

function toLangCode(name) {
  if (!name || name === 'auto') return 'eng_Latn';
  return LANG_CODE[name] || 'eng_Latn';
}

class NLLBClient {
  /**
   * @param {object} cfg
   * @param {string} [cfg.nllbEndpoint]    default 'http://127.0.0.1:8081'
   * @param {number} [cfg.nllbTimeout]     ms, default 15000
   * @param {string} [cfg.sourceLanguage]
   * @param {string} [cfg.targetLanguage]
   */
  constructor(cfg = {}) {
    const ep      = cfg.nllbEndpoint || 'http://127.0.0.1:8081';
    const u       = new URL(ep);
    this._host    = u.hostname.replace('localhost', '127.0.0.1');
    this._port    = parseInt(u.port, 10) || 8081;
    this._timeout = cfg.nllbTimeout || 15000;
    this.srcCode  = toLangCode(cfg.sourceLanguage);
    this.tgtCode  = toLangCode(cfg.targetLanguage);
  }

  // ── Health check ────────────────────────────────────────────────────────
  ping() {
    return new Promise((resolve) => {
      const req = http.get(
        { host: this._host, port: this._port, path: '/', timeout: 3000 },
        (res) => { resolve(res.statusCode < 500); },
      );
      req.on('error',   () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // ── Translate ────────────────────────────────────────────────────────────
  translate(text) {
    return this.translateRaw(text, this.srcCode, this.tgtCode);
  }

  translateRaw(text, srcCode, tgtCode, contextSrc, beamSize) {
    const body = { text, src_lang: srcCode, tgt_lang: tgtCode };
    if (contextSrc) body.context_src = contextSrc;
    if (beamSize && beamSize !== 4) body.beam_size = beamSize;
    return this._postTranslate(body);
  }

  _postTranslate(body) {
    const t = (body.text || '').trim();
    if (!t) return Promise.resolve('');
    body.text = t;

    const data = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host:    this._host,
          port:    this._port,
          path:    '/translate',
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: this._timeout,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(raw);
              if (j.error) reject(new Error(`[nllb-ct2] ${j.error}`));
              else resolve(j.text || '');
            } catch (e) {
              reject(e);
            }
          });
        },
      );

      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('[nllb-ct2] request timeout')); });
      req.write(data);
      req.end();
    });
  }

  // ── Language hot-swap ─────────────────────────────────────────────────────
  updateLanguage(cfg) {
    this.srcCode = toLangCode(cfg.sourceLanguage);
    this.tgtCode = toLangCode(cfg.targetLanguage);
  }
}

module.exports = NLLBClient;

/**
 * src/services/ServiceManager.js
 *
 * Manages the whisper-server.exe child process (whisper.cpp, CPU).
 * Always uses the `tiny` model — fastest, ~75 MB, real-time on any CPU.
 * Whisper language is derived automatically from cfg.sourceLanguage.
 */

'use strict';

const { app }   = require('electron');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

const MAX_RESTARTS  = 5;
const RESTART_DELAY = 3000;

// Maps full-name sourceLanguage → Whisper ISO code
const SOURCE_LANG_MAP = {
  English:    'en',
  Japanese:   'ja',
  Vietnamese: 'vi',
  Chinese:    'zh',
  Korean:     'ko',
  French:     'fr',
  German:     'de',
};

function sourceLangToWhisperLang(sourceLang) {
  return SOURCE_LANG_MAP[sourceLang] || null;
}

class ServiceManager {
  constructor() {
    this._whisperProc  = null;
    this._nllbProc     = null;
    this._restartCount = 0;
    this._nllbRestarts = 0;
    this._stopping     = false;
  }

  get _root() {
    return app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..', '..');
  }

  get whisperExe() { return path.join(this._root, 'whisper-bin', 'whisper-server.exe'); }
  get nllbModelDir() { return path.join(this._root, 'nllb-models'); }
  get nllbCt2ServerScript() { return path.join(this._root, 'nllb-ct2-server.py'); }

  /** Prefers bundled Python (python-embed/python.exe), falls back to system Python. */
  get _pythonExe() {
    const embedded = path.join(this._root, 'python-embed', 'python.exe');
    return fs.existsSync(embedded) ? embedded : 'python';
  }

  get _modelFile() {
    const tiny = path.join(this._root, 'whisper-models', 'ggml-tiny.bin');
    const base = path.join(this._root, 'whisper-models', 'ggml-base.bin');
    if (fs.existsSync(tiny)) return tiny;
    if (fs.existsSync(base)) return base;
    return null;
  }

  _portFromEndpoint(endpoint = 'http://127.0.0.1:8080') {
    try { return parseInt(new URL(endpoint).port, 10) || 8080; }
    catch { return 8080; }
  }

  startWhisper(cfg = {}) {
    if (this._whisperProc) return Promise.resolve();
    this._stopping = false;

    if (!fs.existsSync(this.whisperExe)) {
      console.warn('[whisper] exe not found:', this.whisperExe);
      return Promise.resolve();
    }

    const modelFile = this._modelFile;
    if (!modelFile) {
      console.error('[whisper] no model file found in whisper-models/');
      return Promise.resolve();
    }

    const port     = this._portFromEndpoint(cfg.whisperEndpoint);
    const language = sourceLangToWhisperLang(cfg.sourceLanguage);
    return this._spawn(port, modelFile, language);
  }

  _spawn(port, modelFile, language) {
    return new Promise((resolve) => {
      const args = ['-m', modelFile, '--host', '127.0.0.1', '--port', String(port)];
      if (language) args.push('-l', language);

      console.log('[whisper] spawning:', path.basename(modelFile), 'port', port, language ? `lang=${language}` : '');

      const proc = spawn(
        this.whisperExe, args,
        { stdio: 'pipe', cwd: path.dirname(this.whisperExe) },
      );
      this._whisperProc = proc;

      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      const onData = (d) => {
        const line = d.toString().trim();
        if (line) console.log('[whisper]', line);
        if (/listen/i.test(line)) { this._restartCount = 0; done(); }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => { console.error('[whisper] error:', e.message); done(); });
      proc.on('exit', (code) => {
        this._whisperProc = null;
        console.log('[whisper] exited', code);
        if (!this._stopping && this._restartCount < MAX_RESTARTS) {
          this._restartCount++;
          setTimeout(() => {
            if (!this._stopping) this._spawn(port, modelFile, language).catch(() => {});
          }, RESTART_DELAY);
        }
      });

      setTimeout(done, 10000);
    });
  }

  stopAll() {
    this._stopping = true;
    if (this._whisperProc) {
      try { this._whisperProc.kill(); } catch { /* ignore */ }
      this._whisperProc = null;
    }
    if (this._nllbProc) {
      try { this._nllbProc.kill(); } catch { /* ignore */ }
      this._nllbProc = null;
    }
  }

  get whisperRunning() { return this._whisperProc !== null; }
  get nllbRunning()    { return this._nllbProc    !== null; }

  // ── NLLB CTranslate2 server ──────────────────────────────────────
  /**
   * Start the Python CTranslate2 NLLB server if:
   *   - nllb-ct2-server.py exists
   *   - Python is available
   *   - nllb-ct2-model/model.bin exists (run scripts/setup-nllb-ct2.py first)
   * Silently skips and falls back to ONNX if any condition is not met.
   */
  startNLLB(cfg = {}) {
    if (this._nllbProc) return Promise.resolve();

    const script   = this.nllbCt2ServerScript;
    const ct2Model = path.join(this._root, 'nllb-ct2-model', 'model.bin');

    if (!fs.existsSync(script) || !fs.existsSync(ct2Model)) {
      console.log('[nllb-ct2] CT2 server not available — using ONNX fallback');
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const port = this._portFromNllbEndpoint(cfg.nllbEndpoint);
      const args = [script, '--host', '127.0.0.1', '--port', String(port)];

      console.log('[nllb-ct2] spawning Python CT2 server on port', port);
      const proc = spawn(this._pythonExe, args, { stdio: 'pipe', shell: false });
      this._nllbProc = proc;

      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      const onData = (d) => {
        const line = d.toString().trim();
        if (line) console.log('[nllb-ct2]', line);
        if (/listening/i.test(line) || /ready/i.test(line)) done();
        if (/missing|not found|error/i.test(line) && !resolved) done(); // fail fast
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (e) => {
        console.warn('[nllb-ct2] spawn error:', e.message, '(Python not installed?)'); done();
      });
      proc.on('exit', (code) => {
        this._nllbProc = null;
        console.log('[nllb-ct2] exited', code);
        if (!this._stopping && code !== 0 && this._nllbRestarts < 3) {
          this._nllbRestarts++;
          setTimeout(() => {
            if (!this._stopping) this.startNLLB(cfg).catch(() => {});
          }, RESTART_DELAY);
        }
      });

      setTimeout(done, 30000); // CT2 model load can take up to 30s
    });
  }

  _portFromNllbEndpoint(endpoint = 'http://127.0.0.1:8081') {
    try { return parseInt(new URL(endpoint).port, 10) || 8081; }
    catch { return 8081; }
  }
}

const instance = new ServiceManager();
instance.sourceLangToWhisperLang = sourceLangToWhisperLang;
module.exports = instance;
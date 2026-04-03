/**
 * src/services/ServiceManager.js
 *
 * Manages the faster-whisper Python server (CTranslate2 backend).
 * Uses embedded Python + faster-whisper for 2-4x speedup over whisper.cpp.
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

  get whisperServerScript() { return path.join(this._root, 'faster-whisper-server.py'); }
  get nllbCt2ServerScript() { return path.join(this._root, 'nllb-ct2-server.py'); }

  /** Prefers bundled Python (python-embed/python.exe), falls back to system Python. */
  get _pythonExe() {
    const embedded = path.join(this._root, 'python-embed', 'python.exe');
    return fs.existsSync(embedded) ? embedded : 'python';
  }

  /** Return the whisper model size name based on what's available locally or config. */
  _whisperModelSize(cfg) {
    return cfg.whisperModel || 'base';
  }

  _portFromEndpoint(endpoint = 'http://127.0.0.1:8080') {
    try { return parseInt(new URL(endpoint).port, 10) || 8080; }
    catch { return 8080; }
  }

  startWhisper(cfg = {}) {
    if (this._whisperProc) return Promise.resolve();
    this._stopping = false;

    const script = this.whisperServerScript;
    if (!fs.existsSync(script)) {
      console.warn('[faster-whisper] server script not found:', script);
      return Promise.resolve();
    }

    const port      = this._portFromEndpoint(cfg.whisperEndpoint);
    const modelSize = this._whisperModelSize(cfg);
    const language  = sourceLangToWhisperLang(cfg.sourceLanguage);
    return this._spawnWhisper(port, modelSize, language);
  }

  _spawnWhisper(port, modelSize, language) {
    return new Promise((resolve, reject) => {
      const script = this.whisperServerScript;
      const args = [
        script,
        '--host', '127.0.0.1',
        '--port', String(port),
        '--model', modelSize,
        '--device', 'cpu',
        '--compute-type', 'int8',
        '--cpu-threads', '4',
      ];
      if (language) args.push('--language', language);

      console.log('[faster-whisper] spawning: model=%s port=%d lang=%s', modelSize, port, language || 'auto');

      const proc = spawn(
        this._pythonExe, args,
        { stdio: 'pipe', shell: false },
      );
      this._whisperProc = proc;

      let resolved = false;
      const done = (err) => {
        if (!resolved) {
          resolved = true;
          if (err) reject(err); else resolve();
        }
      };

      const onData = (d) => {
        const line = d.toString().trim();
        if (line) console.log('[faster-whisper]', line);
        if (/listening/i.test(line)) { this._restartCount = 0; done(null); }
        if (!resolved && /missing|not found|sys\.exit/i.test(line)) {
          done(new Error('[faster-whisper] ' + line));
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => {
        console.error('[faster-whisper] error:', e.message);
        done(e);
      });
      proc.on('exit', (code) => {
        this._whisperProc = null;
        console.log('[faster-whisper] exited', code);
        if (!resolved) done(new Error('[faster-whisper] process exited with code ' + code));
        if (!this._stopping && this._restartCount < MAX_RESTARTS) {
          this._restartCount++;
          setTimeout(() => {
            if (!this._stopping) this._spawnWhisper(port, modelSize, language).catch(() => {});
          }, RESTART_DELAY);
        }
      });

      // Model load can take up to 120s on first run — reject on timeout
      setTimeout(() => done(new Error('[faster-whisper] timeout waiting for server to start')), 120000);
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
   * Start the Python CTranslate2 NLLB server.
   * Requires: nllb-ct2-server.py + python-embed + nllb-ct2-model/model.bin
   * All three are guaranteed by scripts/setup-check.js (runs before npm start).
   */
  startNLLB(cfg = {}) {
    if (this._nllbProc) return Promise.resolve();

    const script   = this.nllbCt2ServerScript;
    const ct2Model = path.join(this._root, 'nllb-ct2-model', 'model.bin');

    if (!fs.existsSync(script) || !fs.existsSync(ct2Model)) {
      console.warn('[nllb-ct2] server script or model not found — translation unavailable');
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
        // Wait for "Listening" — at this point the HTTP server has actually bound the port
        if (/listening/i.test(line)) done();
        // Fail fast only when Python prints an explicit error (sys.exit / import error)
        if (!resolved && /^\[nllb-ct2\].*(missing|not found|MISSING|sys\.exit)/i.test(line)) done();
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

      setTimeout(done, 60000); // CT2 model load can take 30–60s on first run
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
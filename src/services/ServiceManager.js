/**
 * src/services/ServiceManager.js
 *
 * Manages the whisper-server child process.
 * Translation is handled in-process by NLLBTranslator (no Ollama needed).
 *
 * Path resolution:
 *  - Packaged: binaries are in process.resourcesPath  (electron-builder extraResources)
 *  - Dev:      binaries are in project root (whisper-bin/, whisper-models/)
 */

'use strict';

const { app }   = require('electron');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

class ServiceManager {
  constructor() {
    this._whisperProc = null;
  }

  // ── Path helpers ──────────────────────────────────────────────────────────
  get _root() {
    return app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..', '..');
  }

  get whisperExe()   { return path.join(this._root, 'whisper-bin',    'whisper-server.exe'); }
  get whisperModel() { return path.join(this._root, 'whisper-models', 'ggml-base.bin'); }
  get nllbModelDir() { return path.join(this._root, 'nllb-models'); }

  // ── Whisper STT server ────────────────────────────────────────────────────
  startWhisper(port = 8080) {
    if (this._whisperProc) return Promise.resolve();

    if (!fs.existsSync(this.whisperExe)) {
      console.warn('[whisper] exe not found:', this.whisperExe);
      return Promise.resolve(); // user may run it manually
    }

    return new Promise((resolve) => {
      const proc = spawn(
        this.whisperExe,
        ['-m', this.whisperModel, '--host', '127.0.0.1', '--port', String(port)],
        { stdio: 'pipe', cwd: path.dirname(this.whisperExe) },
      );
      this._whisperProc = proc;

      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      const onData = (d) => { if (/listen/i.test(d.toString())) done(); };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { console.log('[whisper]', d.toString().trim()); onData(d); });
      proc.on('error', (e) => { console.error('[whisper] spawn error:', e.message); done(); });
      proc.on('exit',  (c) => { this._whisperProc = null; console.log('[whisper] exit', c); });

      // Assume ready after 8 s even if no "listening" log line appears
      setTimeout(done, 8000);
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  stopAll() {
    if (this._whisperProc) {
      try { this._whisperProc.kill(); } catch { /* ignore */ }
      this._whisperProc = null;
    }
  }
}

module.exports = new ServiceManager(); // singleton

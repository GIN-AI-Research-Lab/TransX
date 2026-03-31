/**
 * src/audio/AudioCapture.js
 *
 * Captures audio via ffmpeg (must be on PATH).
 *
 * Sources supported on Windows:
 *  - 'microphone' → WASAPI capture device
 *  - 'system'     → WASAPI loopback of a render device
 *  - 'both'       → two ffmpeg processes merged with amix
 *
 * Emits:
 *  'data'    Buffer  — raw 16-bit signed LE PCM, mono, 16 kHz
 *  'error'   Error
 *  'stopped' code
 */

'use strict';

const { spawn }      = require('child_process');
const { EventEmitter } = require('events');

class AudioCapture extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.sampleRate   = cfg.sampleRate          || 16000;
    this.inputDevice  = cfg.audioInputDevice    || '';
    this.outputDevice = cfg.audioOutputDevice   || '';
    this._procs       = [];
    this.isRunning    = false;
  }

  // ── Device listing ────────────────────────────────────────────────
  listDevices() {
    return new Promise((resolve) => {
      const proc = spawn('ffmpeg', [
        '-hide_banner',
        '-list_devices', 'true',
        '-f', 'wasapi',
        '-i', 'dummy',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      proc.stderr.on('data', (d) => { out += d.toString(); });
      proc.stdout.on('data', (d) => { out += d.toString(); });

      proc.on('close', () => {
        const capture = [];
        const render  = [];
        let section   = null;

        for (const line of out.split('\n')) {
          if (/capture devices/i.test(line))  { section = 'capture'; continue; }
          if (/render devices/i.test(line))   { section = 'render';  continue; }
          const m = line.match(/"([^"]+)"/);
          if (m) {
            if (section === 'capture') capture.push(m[1]);
            if (section === 'render')  render.push(m[1]);
          }
        }
        resolve({ capture, render });
      });

      proc.on('error', () => resolve({ capture: [], render: [] }));
    });
  }

  // ── Build ffmpeg args for a single source ────────────────────────
  _argsFor(source, device) {
    const base = ['-hide_banner', '-loglevel', 'error'];

    if (source === 'system') {
      // WASAPI loopback: captures what the speakers are playing
      base.push(
        '-f', 'wasapi',
        '-loopback', '1',
        '-i', device || 'default',
      );
    } else {
      // Microphone: WASAPI capture device
      base.push(
        '-f', 'wasapi',
        '-i', device || 'default',
      );
    }

    // Output: mono 16-bit LE PCM at target sample rate → stdout
    base.push(
      '-ar', String(this.sampleRate),
      '-ac', '1',
      '-f',  's16le',
      'pipe:1',
    );
    return base;
  }

  // ── Start ─────────────────────────────────────────────────────────
  start(source = 'microphone') {
    if (this.isRunning) return;
    this.isRunning = true;

    if (source === 'both') {
      this._startBoth();
    } else {
      const device = source === 'system' ? this.outputDevice : this.inputDevice;
      this._startOne(source, device);
    }
  }

  _startOne(source, device) {
    const args = this._argsFor(source, device);
    const proc = spawn('ffmpeg', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._procs.push(proc);

    proc.stdout.on('data', (chunk) => this.emit('data', chunk));
    proc.stderr.on('data', (d) => {
      const msg = d.toString();
      if (/error|failed|invalid/i.test(msg)) {
        this.emit('error', new Error(`[ffmpeg] ${msg.trim()}`));
      }
    });
    proc.on('close',  (code) => { this.isRunning = false; this.emit('stopped', code); });
    proc.on('error',  (err)  => { this.isRunning = false; this.emit('error', err); });
  }

  /** For 'both' mode: run two ffmpeg processes; interleave chunks. */
  _startBoth() {
    // mic
    const micArgs = this._argsFor('microphone', this.inputDevice);
    const micProc = spawn('ffmpeg', micArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // system
    const sysArgs = this._argsFor('system', this.outputDevice);
    const sysProc = spawn('ffmpeg', sysArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._procs.push(micProc, sysProc);

    const fwd = (chunk) => this.emit('data', chunk);
    micProc.stdout.on('data', fwd);
    sysProc.stdout.on('data', fwd);

    let stopped = 0;
    const onClose = (code) => {
      stopped++;
      if (stopped >= 2) { this.isRunning = false; this.emit('stopped', code); }
    };
    micProc.on('close', onClose);
    sysProc.on('close', onClose);

    const onErr = (err) => { this.isRunning = false; this.emit('error', err); };
    micProc.on('error', onErr);
    sysProc.on('error', onErr);
  }

  // ── Stop ──────────────────────────────────────────────────────────
  stop() {
    this._procs.forEach((p) => {
      try { p.kill('SIGTERM'); } catch { /* already dead */ }
    });
    this._procs  = [];
    this.isRunning = false;
  }
}

module.exports = AudioCapture;

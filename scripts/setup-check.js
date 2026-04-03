'use strict';
/**
 * scripts/setup-check.js — Pre-start auto-setup (runs via "prestart" npm hook)
 *
 * Verifies and installs ALL required components before Electron starts:
 *   1. python-embed/python.exe        → auto-runs setup-python-embed.js if missing
 *   2. faster-whisper Python package  → auto-installs via pip if missing
 *   3. Whisper model (CT2 int8 base)  → auto-downloads ~140 MB if missing
 *   4. nllb-ct2-model/model.bin       → auto-converts from HuggingFace (~1.2 GB) if missing
 *
 * Fast-path: all components exist → exits in < 200ms with no output.
 * First run on a fresh clone: fully automated, no manual steps needed.
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const PYTHON_EXE    = path.join(ROOT, 'python-embed', 'python.exe');
const FW_MODULE     = path.join(ROOT, 'python-embed', 'Lib', 'site-packages', 'faster_whisper');
const WHISPER_CACHE = path.join(ROOT, 'whisper-models', 'models--Systran--faster-whisper-base');
const NLLB_BIN      = path.join(ROOT, 'nllb-ct2-model', 'model.bin');
const NLLB_SP       = path.join(ROOT, 'nllb-ct2-model', 'sentencepiece.bpe.model');

let didSetup = false;

function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) {
    console.error('[setup] spawn error:', r.error.message);
    process.exit(1);
  }
  return r.status ?? 1;
}

function step(msg) {
  didSetup = true;
  console.log('\n' + '═'.repeat(60));
  console.log('  [setup] ' + msg);
  console.log('═'.repeat(60));
}

// ── 1. python-embed ────────────────────────────────────────────────────────────
if (!fs.existsSync(PYTHON_EXE)) {
  step('python-embed not found — installing embedded Python 3.11 (one-time, ~2 min)...');
  if (run('node', [path.join(__dirname, 'setup-python-embed.js')]) !== 0) {
    console.error('\n[setup] ERROR: setup-python-embed.js failed.');
    console.error('[setup] Run manually: npm run setup:python');
    process.exit(1);
  }
}

// ── 2. faster-whisper package ──────────────────────────────────────────────────
if (!fs.existsSync(FW_MODULE)) {
  step('faster-whisper not installed — installing via pip...');
  const env = { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };
  if (run(PYTHON_EXE, [
    '-m', 'pip', 'install', 'faster-whisper',
    '--no-warn-script-location', '--disable-pip-version-check',
  ], { env }) !== 0) {
    console.error('\n[setup] ERROR: pip install faster-whisper failed.');
    process.exit(1);
  }
}

// ── 3. Whisper model (Systran/faster-whisper-base, CTranslate2 int8 ~140 MB) ───
if (!fs.existsSync(WHISPER_CACHE)) {
  step('Whisper model not found — downloading Systran/faster-whisper-base (~140 MB, one-time)...');

  const whisperModelsDir = path.join(ROOT, 'whisper-models').replace(/\\/g, '\\\\');
  const dlScript = [
    'import os, sys, warnings',
    "os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'",
    'warnings.filterwarnings("ignore")',
    "sys.stdout.reconfigure(encoding='utf-8', errors='replace')",
    'from faster_whisper import WhisperModel',
    `dl_root = r'${whisperModelsDir}'`,
    'os.makedirs(dl_root, exist_ok=True)',
    "print('[setup] Downloading faster-whisper-base (CTranslate2 int8)...', flush=True)",
    "m = WhisperModel('Systran/faster-whisper-base', device='cpu', compute_type='int8', download_root=dl_root)",
    "del m",
    "print('[setup] Whisper model ready.', flush=True)",
  ].join('\n');

  const env = { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };
  if (run(PYTHON_EXE, ['-c', dlScript], { env }) !== 0) {
    console.error('\n[setup] ERROR: Whisper model download failed. Check internet connection.');
    process.exit(1);
  }
}

// ── 4. NLLB CT2 model (facebook/nllb-200-distilled-600M → INT8 ~600 MB) ────────
if (!fs.existsSync(NLLB_BIN) || !fs.existsSync(NLLB_SP)) {
  step('NLLB CT2 model not found — starting one-time conversion...');
  console.log('[setup] Downloads ~1.2 GB of model weights + converts to CTranslate2 INT8.');
  console.log('[setup] Estimated time: 5-15 minutes. Please wait — this only runs ONCE.\n');

  if (run(PYTHON_EXE, ['-X', 'utf8', path.join(__dirname, 'setup-nllb-ct2.py')]) !== 0) {
    console.error('\n[setup] ERROR: NLLB CT2 conversion failed.');
    console.error('[setup] Run manually: npm run setup:ct2');
    process.exit(1);
  }
}

// ── All good ───────────────────────────────────────────────────────────────────
if (didSetup) {
  console.log('\n[setup] ✓ All components ready. Starting app...\n');
}

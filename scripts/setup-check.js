'use strict';
/**
 * scripts/setup-check.js — Pre-start auto-setup (runs via "prestart" npm hook)
 *
 * Verifies and installs ALL required components before Electron starts:
 *   1. python-embed/python.exe             → auto-runs setup-python-embed.js if missing
 *   2. sherpa-onnx Python package          → auto-installs via pip if missing
 *   3. Zipformer-30M-RNNT-6000h int8 model → auto-downloads + quantizes (~140 MB) if missing
 *   4. nllb-ct2-model/model.bin            → auto-converts from HuggingFace (~1.2 GB) if missing
 *
 * Fast-path: all components exist → exits in < 200ms with no output.
 * First run on a fresh clone: fully automated, no manual steps needed.
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const ROOT               = path.join(__dirname, '..');
const PYTHON_EXE         = path.join(ROOT, 'python-embed', 'python.exe');
const SHERPA_ONNX_MODULE = path.join(ROOT, 'python-embed', 'Lib', 'site-packages', 'sherpa_onnx');
const ZIPFORMER_MODEL    = path.join(ROOT, 'zipformer-model', '.setup_done');
const NLLB_BIN           = path.join(ROOT, 'nllb-ct2-model', 'model.bin');
const NLLB_SP            = path.join(ROOT, 'nllb-ct2-model', 'sentencepiece.bpe.model');

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

// ── 2. sherpa-onnx package (required by zipformer-server.py) ──────────────────
// Installed automatically by setup-zipformer.py if missing.
// We do a quick import-check here so setup-zipformer.py can skip that step.
if (!fs.existsSync(SHERPA_ONNX_MODULE)) {
  step('sherpa-onnx not installed — installing via pip (required by Zipformer-RNNT server)...');
  const env = { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };
  if (run(PYTHON_EXE, [
    '-m', 'pip', 'install', 'sherpa-onnx',
    '--no-warn-script-location', '--disable-pip-version-check',
  ], { env }) !== 0) {
    console.error('\n[setup] ERROR: pip install sherpa-onnx failed.');
    process.exit(1);
  }
}

// ── 3. Zipformer-30M-RNNT-6000h model (int8, ~35 MB) ──────────────────────────
// setup-zipformer.py: downloads float32 model (~140 MB), quantizes → int8 (~35 MB),
// then removes float32 source files.
if (!fs.existsSync(ZIPFORMER_MODEL)) {
  step('Zipformer multilingual model not found — downloading pre-quantized int8 (~180 MB, one-time)...');
  console.log('[setup] Repo: csukuangfj/sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10');
  console.log('[setup] Languages: Arabic, English, Indonesian, Japanese, Russian, Thai, Vietnamese, Chinese');
  console.log('[setup] Estimated time: 2-5 minutes. This only runs ONCE.\n');

  const env = { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };
  if (run(PYTHON_EXE, ['-X', 'utf8', path.join(__dirname, 'setup-zipformer.py')], { env }) !== 0) {
    console.error('\n[setup] ERROR: Zipformer model setup failed.');
    console.error('[setup] Run manually: python-embed\\python.exe scripts\\setup-zipformer.py');
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

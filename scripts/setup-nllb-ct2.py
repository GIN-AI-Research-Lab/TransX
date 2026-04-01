#!/usr/bin/env python3
"""
scripts/setup-nllb-ct2.py

One-time setup: download facebook/nllb-200-distilled-600M from HuggingFace
and convert to CTranslate2 INT8 format.

Result : nllb-ct2-model/  (~600 MB on disk, ~600 MB RAM when loaded)
Runtime: 5-15 min on first run (download ~1.2 GB PyTorch weights + convert)

Usage (auto-handled by npm run setup:ct2):
    python-embed\python.exe -X utf8 scripts\setup-nllb-ct2.py
"""

import os
import sys
import subprocess

# Force UTF-8 output on Windows (avoids CP1252 UnicodeEncodeError)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(ROOT, 'nllb-ct2-model')
MODEL_BIN  = os.path.join(OUTPUT_DIR, 'model.bin')


def pip_install(*packages, index_url=None):
    args = [
        sys.executable, '-m', 'pip', 'install', *packages,
        '--no-warn-script-location',
        '--disable-pip-version-check',
        '-q',
    ]
    if index_url:
        args += ['--index-url', index_url]
    return subprocess.call(args)


def can_import(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def main():
    # ── Already done? ──────────────────────────────────────────────────────
    if os.path.exists(MODEL_BIN):
        size_mb = os.path.getsize(MODEL_BIN) / 1_048_576
        print(f'[OK] CT2 model already exists at {OUTPUT_DIR}  ({size_mb:.0f} MB)')
        print('     Delete the directory and re-run to reconvert.')
        sys.exit(0)

    print('=' * 60)
    print('  NLLB-200 -> CTranslate2 INT8 conversion')
    print('  Model : facebook/nllb-200-distilled-600M')
    print('  Output:', OUTPUT_DIR)
    print('=' * 60)
    print()

    # ── Step 1: Ensure ctranslate2 + sentencepiece ─────────────────────────
    if not can_import('ctranslate2'):
        print('[1/3] Installing ctranslate2 + sentencepiece ...')
        if pip_install('ctranslate2', 'sentencepiece') != 0:
            print('ERROR: Could not install ctranslate2')
            sys.exit(1)
    else:
        print('[1/3] ctranslate2 OK')

    # ── Step 2: Ensure transformers ────────────────────────────────────────
    if not can_import('transformers'):
        print('[2/3] Installing transformers ...')
        if pip_install('transformers', 'accelerate') != 0:
            print('ERROR: Could not install transformers')
            sys.exit(1)
    else:
        print('[2/3] transformers OK')

    # ── Step 3: Ensure torch (CPU-only, ~370 MB) ───────────────────────────
    if not can_import('torch'):
        print('[3/3] Installing torch CPU (~370 MB) ...')
        if pip_install('torch', index_url='https://download.pytorch.org/whl/cpu') != 0:
            print('ERROR: Could not install torch')
            sys.exit(1)
    else:
        print('[3/3] torch OK')

    print()
    print('Downloading model weights from HuggingFace (~1.2 GB) and converting ...')
    print('This may take 5-15 minutes on first run.\n')

    # ── Step 4: Convert in a FRESH subprocess ─────────────────────────────
    # Run conversion in a new process so torch/ctranslate2/transformers are
    # all imported cleanly — avoids "name 'torch' is not defined" when
    # ctranslate2 was already cached before torch was installed.
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    convert_script = (
        'import ctranslate2\n'
        f'output_dir = r"{OUTPUT_DIR}"\n'
        'print("[convert] Starting TransformersConverter ...", flush=True)\n'
        'c = ctranslate2.converters.TransformersConverter(\n'
        '    "facebook/nllb-200-distilled-600M",\n'
        '    low_cpu_mem_usage=True,\n'
        ')\n'
        'print("[convert] Converting to INT8 ...", flush=True)\n'
        'c.convert(output_dir, quantization="int8", force=True)\n'
        'print("[convert] Done.", flush=True)\n'
    )

    ret = subprocess.call(
        [sys.executable, '-X', 'utf8', '-c', convert_script],
        cwd=ROOT,
    )

    if ret != 0:
        print('\nERROR: Conversion subprocess failed (see output above).')
        sys.exit(1)

    # ── Copy sentencepiece tokenizer into ct2 dir (self-contained bundle) ─
    import shutil
    sp_src = os.path.join(ROOT, 'nllb-models', 'nllb-200-distilled-600M', 'sentencepiece.bpe.model')
    sp_dst = os.path.join(OUTPUT_DIR, 'sentencepiece.bpe.model')
    if os.path.exists(sp_src):
        shutil.copy2(sp_src, sp_dst)
        print('[copy] sentencepiece.bpe.model -> nllb-ct2-model/')
    else:
        print('WARN: sentencepiece.bpe.model not found in nllb-models/, tokenizer not copied.')

    # ── Summary ────────────────────────────────────────────────────────────
    size_mb = sum(
        os.path.getsize(os.path.join(OUTPUT_DIR, f))
        for f in os.listdir(OUTPUT_DIR)
        if os.path.isfile(os.path.join(OUTPUT_DIR, f))
    ) / 1_048_576

    print(f'\n[DONE]  Model saved to {OUTPUT_DIR}  ({size_mb:.0f} MB)')
    print()
    print('Next step:  npm run build:portable')


if __name__ == '__main__':
    main()

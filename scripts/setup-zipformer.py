#!/usr/bin/env python3
"""
scripts/setup-zipformer.py
──────────────────────────────────────────────────────────────────────────────
One-time setup: download Zipformer streaming multilingual model from HuggingFace.

Source HuggingFace repo : csukuangfj/sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10
Output directory        : <root>/zipformer-model/

Supported languages: Arabic, English, Indonesian, Japanese, Russian, Thai,
                     Vietnamese, Chinese  (auto-detected from audio).

Downloaded files (preferred int8 where available):
  encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx  (~179 MB, int8)
  decoder-epoch-75-avg-11-chunk-16-left-128.onnx       (~2 MB,  float32)
  joiner-epoch-75-avg-11-chunk-16-left-128.int8.onnx   (~0.2 MB, int8)
  tokens.txt
  bpe.model

Note: No local quantization needed — int8 files are downloaded directly.
      The decoder has no int8 version in this repo, so float32 is used.
      (Decoder is tiny ~2 MB, float32 overhead is negligible.)

Requirements (already in python-embed):
  huggingface_hub  (bundled)
  sherpa-onnx      (installed by previous setup step)
"""

import sys
import os
import shutil
import subprocess

# Force UTF-8 output on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

ROOT    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "zipformer-model")

HF_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10"

# Files to download from the repo — prefer int8 where repo provides it.
# Exact names confirmed by listing the repo contents.
FILES_TO_DOWNLOAD = [
    # (hf_filename,  canonical_local_name)
    ("encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx", "encoder.int8.onnx"),
    ("decoder-epoch-75-avg-11-chunk-16-left-128.onnx",      "decoder.onnx"),      # float32 only
    ("joiner-epoch-75-avg-11-chunk-16-left-128.int8.onnx",  "joiner.int8.onnx"),
    ("tokens.txt",                                          "tokens.txt"),
    ("bpe.model",                                           "bpe.model"),
]

# Files the server strictly requires (bpe.model is optional)
REQUIRED_CANONICAL = ["encoder.int8.onnx", "decoder.onnx",
                      "joiner.int8.onnx",  "tokens.txt"]

# Old English-only model files to remove on first run of the new model
OLD_FILES_TO_CLEAN = [
    "encoder.int8.onnx", "decoder.int8.onnx", "decoder.onnx",
    "joiner.int8.onnx",  "tokens.txt", "bpe.model",
]


def _pip_install(package):
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", package,
         "--no-warn-script-location", "--disable-pip-version-check"],
        capture_output=False,
    )
    return r.returncode == 0


def _read_done_marker(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    done_marker = os.path.join(OUT_DIR, ".setup_done")

    # ── Fast-path: same repo, all files present ─────────────────────────
    if _read_done_marker(done_marker) == HF_REPO:
        if all(os.path.exists(os.path.join(OUT_DIR, f)) for f in REQUIRED_CANONICAL):
            print("[setup-zipformer] Multilingual streaming model already ready — nothing to do.",
                  flush=True)
            return

    # ── Repo changed or files missing: clean up old files ───────────────
    old_content = _read_done_marker(done_marker)
    if old_content and old_content != HF_REPO:
        print("[setup-zipformer] Switching model repository — removing old files ...", flush=True)
        for fname in OLD_FILES_TO_CLEAN:
            fp = os.path.join(OUT_DIR, fname)
            if os.path.exists(fp):
                os.remove(fp)
                print(f"[setup-zipformer]   Removed {fname}", flush=True)
        os.remove(done_marker)

    # ── Step 1: Ensure sherpa-onnx is installed ─────────────────────────
    try:
        import sherpa_onnx  # noqa: F401
        print("[setup-zipformer] sherpa-onnx already installed.", flush=True)
    except ImportError:
        print("[setup-zipformer] Installing sherpa-onnx ...", flush=True)
        if not _pip_install("sherpa-onnx"):
            print("[setup-zipformer] ERROR: failed to install sherpa-onnx.", flush=True)
            sys.exit(1)
        print("[setup-zipformer] sherpa-onnx installed.", flush=True)

    # ── Step 2: Download model files ────────────────────────────────────
    print(f"\n[setup-zipformer] Downloading multilingual streaming Zipformer (int8) ...",
          flush=True)
    print(f"[setup-zipformer] Repo : {HF_REPO}", flush=True)
    print(f"[setup-zipformer] Languages: ar en id ja ru th vi zh (auto-detected from audio)",
          flush=True)
    print(f"[setup-zipformer] Total download: ~180 MB  (one-time)\n", flush=True)

    from huggingface_hub import hf_hub_download

    for hf_name, canonical_name in FILES_TO_DOWNLOAD:
        dst = os.path.join(OUT_DIR, canonical_name)
        if os.path.exists(dst):
            size_mb = os.path.getsize(dst) / 1024 / 1024
            print(f"[setup-zipformer]   {canonical_name} — on disk ({size_mb:.1f} MB), skip.",
                  flush=True)
            continue

        print(f"[setup-zipformer]   Downloading {hf_name} ...", flush=True)
        try:
            cached = hf_hub_download(
                repo_id=HF_REPO,
                filename=hf_name,
                local_dir=OUT_DIR,
            )
            cached = os.path.normpath(cached)
            dst_norm = os.path.normpath(dst)
            if cached != dst_norm:
                shutil.copy2(cached, dst)
                # Remove HF cache subdir copy if it's outside OUT_DIR root level
                if os.path.dirname(cached) != os.path.normpath(OUT_DIR):
                    try:
                        os.remove(cached)
                    except OSError:
                        pass
        except Exception as e:
            print(f"[setup-zipformer] ERROR downloading {hf_name}: {e}", flush=True)
            sys.exit(1)

        size_mb = os.path.getsize(dst) / 1024 / 1024
        print(f"[setup-zipformer]   {canonical_name}  ({size_mb:.1f} MB) ✓", flush=True)

    # ── Step 3: Clean up any HF hub snapshot dirs that hf_hub_download creates
    for noise_dir in [".cache", ".huggingface"]:
        p = os.path.join(OUT_DIR, noise_dir)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)

    # ── Done ───────────────────────────────────────────────────────────
    with open(done_marker, 'w') as f:
        f.write(HF_REPO + "\n")

    total_mb = sum(
        os.path.getsize(os.path.join(OUT_DIR, f)) / 1024 / 1024
        for f in REQUIRED_CANONICAL
        if os.path.exists(os.path.join(OUT_DIR, f))
    )
    print(f"\n[setup-zipformer] ✓ Done. Model size: {total_mb:.1f} MB (in {OUT_DIR})",
          flush=True)
    print("[setup-zipformer] Streaming multilingual Zipformer ready.", flush=True)


if __name__ == "__main__":
    main()

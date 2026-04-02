#!/usr/bin/env python3
"""
nllb-ct2-server.py — CTranslate2 NLLB-200 INT8 translation HTTP server

RAM  : ~600 MB  (vs ~1 GB ONNX, vs 2.4 GB FP32)
Speed: 2–3x faster than ONNX on CPU

Requirements (install once):
    pip install ctranslate2 sentencepiece

Setup model (run once before starting):
    python scripts/setup-nllb-ct2.py

API:
    GET  /         → 200 "nllb-ct2-server OK"
    POST /translate → {
                        "text":        "...",
                        "src_lang":    "eng_Latn",
                        "tgt_lang":    "vie_Latn",
                        "context_src": "previous sentence (optional, Latin src only)",
                        "beam_size":   4
                      }
                   ← {"text":"..."}
"""

import sys
import json
import os
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler

# Force UTF-8 stdout/stderr — prevents garbled output on Windows (CP1252 default)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


def main():
    parser = argparse.ArgumentParser(description="CTranslate2 NLLB-200 HTTP server")
    parser.add_argument("--host",  default="127.0.0.1")
    parser.add_argument("--port",  type=int, default=8081)
    args = parser.parse_args()

    # ── Check dependencies ─────────────────────────────────────────────────
    try:
        import ctranslate2
        import sentencepiece as spm
    except ImportError as e:
        print(f"[nllb-ct2] MISSING dependency: {e}", flush=True)
        print("[nllb-ct2] Install: pip install ctranslate2 sentencepiece", flush=True)
        sys.exit(1)

    # ── Find model files ───────────────────────────────────────────────────
    root_dir   = os.path.dirname(os.path.abspath(__file__))
    ct2_dir    = os.path.join(root_dir, "nllb-ct2-model")

    # Tokenizer: look in ct2 dir first (bundled build), fallback to nllb-models (dev)
    sp_path = os.path.join(ct2_dir, "sentencepiece.bpe.model")
    if not os.path.exists(sp_path):
        sp_path = os.path.join(root_dir, "nllb-models",
                               "nllb-200-distilled-600M", "sentencepiece.bpe.model")

    if not os.path.exists(os.path.join(ct2_dir, "model.bin")):
        print(f"[nllb-ct2] CT2 model not found at: {ct2_dir}", flush=True)
        print("[nllb-ct2] Run setup first:  python scripts/setup-nllb-ct2.py", flush=True)
        sys.exit(1)

    if not os.path.exists(sp_path):
        print(f"[nllb-ct2] Tokenizer not found: {sp_path}", flush=True)
        sys.exit(1)

    # ── Load model ─────────────────────────────────────────────────────────
    print(f"[nllb-ct2] Loading model from {ct2_dir}...", flush=True)
    translator = ctranslate2.Translator(
        ct2_dir,
        device="cpu",
        inter_threads=1,   # 1 thread pool → đảm bảo memory thấp
        intra_threads=2,   # 2 threads per request → cân bằng tốt với Whisper
    )

    sp = spm.SentencePieceProcessor()
    sp.Load(sp_path)
    print("[nllb-ct2] Model ready.", flush=True)

    # ── Translation function ───────────────────────────────────────────────
    # CJK language codes — context prepend không có hiệu quả vì tokenizer
    # nhập 2 câu liền nhau không có dấu phân cách ngôn ngữ rõ ràng
    CJK_LANGS = {"jpn_Jpan", "zho_Hans", "zho_Hant", "kor_Hang"}

    def do_translate(text: str, src_lang: str, tgt_lang: str,
                     context_src: str = "", beam_size: int = 4) -> str:
        # Context chỉ hiệu quả với Latin source (EN, VI, FR, ...)
        # CJK: tắt context — ghép 2 câu Nhật/Trung liền làm model nhầm
        if context_src and src_lang not in CJK_LANGS:
            ctx = context_src[-60:] if len(context_src) > 60 else context_src
            full_text = ctx + " " + text
        else:
            full_text = text

        tokens = sp.Encode(full_text, out_type=str)
        # NLLB max input = 512 tokens — truncate nếu cần
        if len(tokens) > 500:
            tokens = tokens[-500:]
        input_tokens = [src_lang] + tokens + ["</s>"]
        result = translator.translate_batch(
            [input_tokens],
            target_prefix=[[tgt_lang]],
            max_decoding_length=256,
            beam_size=beam_size,
        )
        output_tokens = result[0].hypotheses[0][1:]  # skip leading tgt_lang token
        return sp.Decode(output_tokens)

    # ── HTTP handler ───────────────────────────────────────────────────────
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass  # suppress per-request logs

        def _send_json(self, status: int, data: dict):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type",   "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"nllb-ct2-server OK")

        def do_POST(self):
            if self.path != "/translate":
                self.send_response(404)
                self.end_headers()
                return

            n    = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n))

            text     = body.get("text", "").strip()
            src_lang = body.get("src_lang", "eng_Latn")
            tgt_lang = body.get("tgt_lang", "vie_Latn")
            context_src = body.get("context_src", "").strip()
            beam_size   = int(body.get("beam_size", 4))

            if not text:
                self._send_json(200, {"text": ""})
                return

            try:
                translated = do_translate(text, src_lang, tgt_lang, context_src, beam_size)
                self._send_json(200, {"text": translated})
            except Exception as e:
                self._send_json(500, {"error": str(e)})

    # ── Start server ───────────────────────────────────────────────────────
    print(f"[nllb-ct2] Listening on {args.host}:{args.port}", flush=True)
    server = HTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

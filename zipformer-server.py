#!/usr/bin/env python3
"""
zipformer-server.py — Streaming multilingual Zipformer HTTP server

Uses sherpa-onnx + streaming Zipformer (ar/en/id/ja/ru/th/vi/zh, 2025-02-10).
Supports Japanese, English, Vietnamese (and more) with auto language detection.

Model directory: <root>/zipformer-model/
Required files (produced by scripts/setup-zipformer.py):
  encoder.int8.onnx   (~179 MB, int8)
  decoder.onnx        (~2 MB, float32 — no int8 version in this repo)
  joiner.int8.onnx    (~0.2 MB, int8)
  tokens.txt

API (OpenAI-compatible — identical interface to faster-whisper-server):
    GET  /                        → 200 "zipformer-server OK"
    POST /inference               → multipart (alias)
    POST /v1/audio/transcriptions → multipart (OpenAI-compatible)

    Request fields:
        file            : audio file (WAV, 16-bit LE mono 16 kHz, required)
        language        : accepted but ignored — model auto-detects from audio
        initial_prompt  : accepted but ignored (RNNT has no prompt mechanism)
        response_format : "json" (default)

    Response: {"text": "transcribed text"}
"""

import sys
import os
import glob
import json
import argparse
import io
import wave
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler

# Force UTF-8 stdout/stderr on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


# ── Multipart parser (no cgi dependency) ──────────────────────────────────────
def parse_multipart(handler):
    content_type = handler.headers.get('Content-Type', '')
    if 'multipart/form-data' not in content_type:
        return {}, {}

    boundary = None
    for part in content_type.split(';'):
        part = part.strip()
        if part.startswith('boundary='):
            boundary = part[len('boundary='):]
            break
    if not boundary:
        return {}, {}

    content_length = int(handler.headers.get('Content-Length', 0))
    body = handler.rfile.read(content_length)

    delimiter = b'--' + boundary.encode('utf-8')
    fields = {}
    files  = {}

    for part in body.split(delimiter):
        part = part.strip(b'\r\n')
        if not part or part in (b'--', b'--\r\n'):
            continue
        header_end = part.find(b'\r\n\r\n')
        if header_end < 0:
            continue
        header_data = part[:header_end].decode('utf-8', errors='replace')
        body_data   = part[header_end + 4:]
        if body_data.endswith(b'\r\n'):
            body_data = body_data[:-2]

        name = filename = None
        for line in header_data.split('\r\n'):
            if 'Content-Disposition' in line:
                for item in line.split(';'):
                    item = item.strip()
                    if item.startswith('name='):
                        name = item[5:].strip('"')
                    elif item.startswith('filename='):
                        filename = item[9:].strip('"')
        if not name:
            continue
        if filename:
            files[name] = body_data
        else:
            fields[name] = body_data.decode('utf-8', errors='replace')

    return fields, files


def _find_model_file(model_dir, pattern_int8, pattern_f32=None):
    """Find model ONNX file: prefer int8, fall back to float32."""
    hits = glob.glob(os.path.join(model_dir, pattern_int8))
    if hits:
        return hits[0]
    if pattern_f32:
        hits = glob.glob(os.path.join(model_dir, pattern_f32))
        if hits:
            return hits[0]
    return None


def main():
    parser = argparse.ArgumentParser(
        description="Streaming multilingual Zipformer HTTP server")
    parser.add_argument("--host",        default="127.0.0.1")
    parser.add_argument("--port",        type=int, default=8080)
    parser.add_argument("--model-dir",   default=None,
                        help="Model directory (default: <root>/zipformer-model)")
    parser.add_argument("--num-threads", type=int, default=4,
                        help="ORT inference threads (default: 4)")
    args = parser.parse_args()

    # ── Check sherpa-onnx dependency ───────────────────────────────────
    try:
        import sherpa_onnx
    except ImportError as e:
        print(f"[zipformer] MISSING dependency: {e}", flush=True)
        print("[zipformer] Run: python scripts/setup-zipformer.py", flush=True)
        sys.exit(1)

    # ── Resolve model directory ────────────────────────────────────────
    root_dir  = os.path.dirname(os.path.abspath(__file__))
    model_dir = args.model_dir or os.path.join(root_dir, "zipformer-model")

    # Dynamic file discovery: prefer int8 over float32
    encoder_path = _find_model_file(model_dir, "encoder*.int8.onnx", "encoder*.onnx")
    decoder_path = _find_model_file(model_dir, "decoder*.int8.onnx", "decoder*.onnx")
    joiner_path  = _find_model_file(model_dir, "joiner*.int8.onnx",  "joiner*.onnx")
    tokens_path  = os.path.join(model_dir, "tokens.txt")

    missing = []
    if not encoder_path:               missing.append("encoder*.onnx")
    if not decoder_path:               missing.append("decoder*.onnx")
    if not joiner_path:                missing.append("joiner*.onnx")
    if not os.path.exists(tokens_path): missing.append("tokens.txt")
    if missing:
        print(f"[zipformer] Model files missing in '{model_dir}': {missing}", flush=True)
        print("[zipformer] Run: python scripts/setup-zipformer.py", flush=True)
        sys.exit(1)

    # ── Load streaming model ───────────────────────────────────────────
    print(f"[zipformer] Loading streaming multilingual Zipformer from: {model_dir}",
          flush=True)
    print(f"[zipformer]   encoder : {os.path.basename(encoder_path)}", flush=True)
    print(f"[zipformer]   decoder : {os.path.basename(decoder_path)}", flush=True)
    print(f"[zipformer]   joiner  : {os.path.basename(joiner_path)}", flush=True)

    # OnlineRecognizer.from_transducer — 'tokens' is the first positional param
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=tokens_path,
        encoder=encoder_path,
        decoder=decoder_path,
        joiner=joiner_path,
        num_threads=args.num_threads,
        sample_rate=16000,
        feature_dim=80,
        decoding_method="greedy_search",
        # Disable endpoint detection — we process complete audio chunks
        enable_endpoint_detection=False,
        provider="cpu",
        debug=False,
    )

    print("[zipformer] Model ready.", flush=True)

    # ── Transcription function ─────────────────────────────────────────
    def do_transcribe(audio_bytes):
        """
        Decode a complete WAV buffer using the streaming Zipformer RNNT.
        Language is automatically detected from audio — no language param needed.
        Supports: Arabic, English, Indonesian, Japanese, Russian, Thai, Vietnamese, Chinese.
        """
        try:
            with wave.open(io.BytesIO(audio_bytes), 'rb') as wf:
                if wf.getsampwidth() != 2:
                    raise ValueError(
                        f"Expected 16-bit PCM, got {wf.getsampwidth() * 8}-bit")
                if wf.getnchannels() != 1:
                    raise ValueError(
                        f"Expected mono, got {wf.getnchannels()} channels")
                sample_rate = wf.getframerate()
                raw_pcm     = wf.readframes(wf.getnframes())
        except wave.Error as e:
            raise ValueError(f"Invalid WAV data: {e}")

        samples = (np.frombuffer(raw_pcm, dtype=np.int16)
                     .astype(np.float32) / 32768.0)

        # ── Streaming decode of a complete audio chunk ─────────────────
        # 1. Feed all samples into the stream
        # 2. Feed ~0.5s tail padding to flush the encoder look-ahead context
        # 3. Mark input_finished() so the decoder drains remaining frames
        # 4. Drain with decode_stream() until is_ready() returns False
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)

        tail_pad = np.zeros(int(0.5 * sample_rate), dtype=np.float32)
        stream.accept_waveform(sample_rate, tail_pad)
        stream.input_finished()

        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)

        return recognizer.get_result(stream).strip()

    # ── HTTP handler ───────────────────────────────────────────────────
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass  # suppress per-request access logs

        def _send_json(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"zipformer-server OK")

        def do_POST(self):
            if self.path not in ("/inference", "/v1/audio/transcriptions"):
                self.send_response(404)
                self.end_headers()
                return

            try:
                fields, files = parse_multipart(self)
                audio_data = files.get("file")
                if not audio_data:
                    self._send_json(400, {"error": "No audio file provided"})
                    return

                # language and initial_prompt are ignored — model auto-detects language

                text = do_transcribe(audio_data)
                self._send_json(200, {"text": text})

            except Exception as e:
                print(f"[zipformer] Error: {e}", flush=True)
                self._send_json(500, {"error": str(e)})

    # ── Start HTTP server ──────────────────────────────────────────────
    print(f"[zipformer] Listening on {args.host}:{args.port}", flush=True)
    server = HTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

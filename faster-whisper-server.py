#!/usr/bin/env python3
"""
faster-whisper-server.py — Faster-Whisper HTTP server for speech-to-text

Uses CTranslate2 backend via faster-whisper for 2-4x speedup over whisper.cpp
while using less memory (INT8 quantization).

Model auto-download: model is downloaded on first run to whisper-models/faster-whisper-<size>/

API (OpenAI-compatible):
    GET  /                        → 200 "faster-whisper-server OK"
    POST /inference               → multipart (alias, same as below)
    POST /v1/audio/transcriptions → multipart (OpenAI-compatible)

    Request fields:
        file            : audio file (WAV, required)
        language        : ISO 639-1 code or empty for auto-detect
        initial_prompt  : text prompt to condition the model
        temperature     : float (default 0)
        response_format : "json" (default)

    Response: {"text": "transcribed text"}
"""

import sys
import os
import json
import argparse
import io
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler

# Force UTF-8 stdout/stderr on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


def parse_multipart(handler):
    """Parse multipart/form-data without the deprecated cgi module."""
    content_type = handler.headers.get('Content-Type', '')
    if 'multipart/form-data' not in content_type:
        return {}, {}

    # Extract boundary from Content-Type header
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

    boundary_bytes = boundary.encode('utf-8')
    delimiter = b'--' + boundary_bytes
    end_delimiter = delimiter + b'--'

    fields = {}
    files = {}

    parts = body.split(delimiter)
    for part in parts:
        part = part.strip(b'\r\n')
        if not part or part == b'--' or part == b'--\r\n':
            continue

        # Split headers from body
        header_end = part.find(b'\r\n\r\n')
        if header_end < 0:
            continue
        header_data = part[:header_end].decode('utf-8', errors='replace')
        body_data = part[header_end + 4:]
        # Remove trailing \r\n
        if body_data.endswith(b'\r\n'):
            body_data = body_data[:-2]

        # Parse Content-Disposition
        name = None
        filename = None
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


def main():
    parser = argparse.ArgumentParser(description="Faster-Whisper HTTP server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--model", default="base",
                        help="Model size: tiny, base, small, medium, large-v3")
    parser.add_argument("--language", default=None,
                        help="Default language (ISO code). None = auto-detect")
    parser.add_argument("--device", default="cpu", help="cpu or cuda")
    parser.add_argument("--compute-type", default="int8",
                        help="int8, float16, float32")
    args = parser.parse_args()

    # ── Check dependencies ─────────────────────────────────────────────
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(f"[faster-whisper] MISSING dependency: {e}", flush=True)
        print("[faster-whisper] Install: pip install faster-whisper", flush=True)
        sys.exit(1)

    # ── Resolve model path ─────────────────────────────────────────────
    root_dir = os.path.dirname(os.path.abspath(__file__))
    model_dir = os.path.join(root_dir, "whisper-models", f"faster-whisper-{args.model}")

    # Use local model if available, otherwise download from HuggingFace
    if os.path.isdir(model_dir) and os.path.exists(os.path.join(model_dir, "model.bin")):
        model_path = model_dir
        print(f"[faster-whisper] Using local model: {model_dir}", flush=True)
    else:
        # Download to whisper-models/ on first run
        model_path = f"Systran/faster-whisper-{args.model}"
        print(f"[faster-whisper] Will download model: {model_path}", flush=True)
        print(f"[faster-whisper] Cache dir: {model_dir}", flush=True)

    # ── Load model ─────────────────────────────────────────────────────
    print(f"[faster-whisper] Loading model '{args.model}' (device={args.device}, "
          f"compute_type={args.compute_type})...", flush=True)

    model = WhisperModel(
        model_path,
        device=args.device,
        compute_type=args.compute_type,
        download_root=os.path.join(root_dir, "whisper-models"),
        cpu_threads=2,
    )
    print("[faster-whisper] Model ready.", flush=True)

    default_language = args.language

    # ── Transcription function ─────────────────────────────────────────
    def do_transcribe(audio_bytes, language=None, initial_prompt=None, temperature=0.0):
        """Transcribe audio bytes (WAV format) and return text."""
        # Write to temp file — faster-whisper needs a file path or numpy array
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            lang = language or default_language or None
            # Use beam_size=5 for accuracy, or 1 for speed
            segments, info = model.transcribe(
                tmp_path,
                language=lang,
                initial_prompt=initial_prompt or None,
                temperature=temperature,
                beam_size=5,
                best_of=1,
                vad_filter=True,
                vad_parameters=dict(
                    min_silence_duration_ms=500,
                    speech_pad_ms=200,
                ),
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
            )
            # Collect all segment texts
            texts = []
            for seg in segments:
                texts.append(seg.text.strip())
            return " ".join(texts).strip()
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    # ── HTTP handler ───────────────────────────────────────────────────
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass  # suppress per-request logs

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
            self.wfile.write(b"faster-whisper-server OK")

        def do_POST(self):
            # Accept both paths for flexibility
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

                language = fields.get("language", "").strip() or None
                if language == "auto":
                    language = None
                initial_prompt = fields.get("initial_prompt", "").strip() or None

                try:
                    temperature = float(fields.get("temperature", "0"))
                except (ValueError, TypeError):
                    temperature = 0.0

                text = do_transcribe(audio_data, language, initial_prompt, temperature)
                self._send_json(200, {"text": text})

            except Exception as e:
                print(f"[faster-whisper] Error: {e}", flush=True)
                self._send_json(500, {"error": str(e)})

    # ── Start server ───────────────────────────────────────────────────
    print(f"[faster-whisper] Listening on {args.host}:{args.port}", flush=True)
    server = HTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

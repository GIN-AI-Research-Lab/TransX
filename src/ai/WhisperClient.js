/**
 * src/ai/WhisperClient.js
 *
 * Sends a PCM buffer to a running whisper.cpp HTTP server
 * (default: http://localhost:8080/inference).
 *
 * Compatible with:
 *  - whisper.cpp  `whisper-server`  (POST /inference, multipart)
 *  - faster-whisper-server          (POST /v1/audio/transcriptions, multipart)
 *
 * Uses Node 18+ built-in fetch + FormData + Blob — no extra deps.
 */

'use strict';

class WhisperClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.whisperEndpoint  e.g. "http://localhost:8080"
   * @param {string} cfg.whisperLanguage       ISO code or "auto"
   * @param {string} cfg.whisperInitialPrompt  gợi ý cho model tạo dấu câu đúng
   * @param {number} cfg.sampleRate
   * @param {number} cfg.whisperTimeout        ms
   */
  constructor(cfg = {}) {
    // Đổi localhost → 127.0.0.1 để tránh Node.js 18+ resolve IPv6 trước IPv4
    this.endpoint  = (cfg.whisperEndpoint || 'http://127.0.0.1:8080')
      .replace(/\/$/, '')
      .replace(/\/\/localhost\b/i, '//127.0.0.1');
    this.language      = cfg.whisperLanguage || 'auto';
    this.initialPrompt = cfg.whisperInitialPrompt || '';
    this.sampleRate    = cfg.sampleRate || 16000;
    this.timeout       = cfg.whisperTimeout || 30000;
  }

  // ── PCM → WAV ─────────────────────────────────────────────────────
  /**
   * Wrap raw 16-bit LE mono PCM in a minimal RIFF/WAV header.
   * Returns a Buffer.
   */
  _pcmToWav(pcm) {
    const sampleRate  = this.sampleRate;
    const channels    = 1;
    const bitDepth    = 16;
    const byteRate    = sampleRate * channels * (bitDepth / 8);
    const blockAlign  = channels * (bitDepth / 8);
    const dataSize    = pcm.length;
    const headerSize  = 44;

    const wav = Buffer.alloc(headerSize + dataSize);
    let o = 0;

    // RIFF
    wav.write('RIFF', o, 'ascii');          o += 4;
    wav.writeUInt32LE(36 + dataSize, o);    o += 4;
    wav.write('WAVE', o, 'ascii');          o += 4;
    // fmt
    wav.write('fmt ', o, 'ascii');          o += 4;
    wav.writeUInt32LE(16, o);               o += 4;   // chunk size
    wav.writeUInt16LE(1, o);                o += 2;   // PCM
    wav.writeUInt16LE(channels, o);         o += 2;
    wav.writeUInt32LE(sampleRate, o);       o += 4;
    wav.writeUInt32LE(byteRate, o);         o += 4;
    wav.writeUInt16LE(blockAlign, o);       o += 2;
    wav.writeUInt16LE(bitDepth, o);         o += 2;
    // data
    wav.write('data', o, 'ascii');          o += 4;
    wav.writeUInt32LE(dataSize, o);         o += 4;
    pcm.copy(wav, o);

    return wav;
  }

  // ── Health check ─────────────────────────────────────────────────
  /**
   * Kiểm tra server có đang chạy không.
   * Tự đổi localhost → 127.0.0.1 để tránh Node.js 18+ resolve IPv6.
   * @returns {Promise<boolean>}
   */
  async ping() {
    // Electron Node.js 18+ resolve 'localhost' → ::1 (IPv6) trước 127.0.0.1
    // whisper-server chỉ bind IPv4 → phải dùng 127.0.0.1 trực tiếp
    const url = this.endpoint.replace(/\/\/localhost\b/i, '//127.0.0.1');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok || r.status < 500;
    } catch {
      return false;
    }
  }

  // ── Transcribe ────────────────────────────────────────────────────
  /**
   * Transcribe a PCM Buffer.
   * @param {Buffer} pcmBuffer  raw 16-bit LE mono PCM at this.sampleRate
   * @returns {Promise<string>}
   */
  async transcribe(pcmBuffer) {
    const wav  = this._pcmToWav(pcmBuffer);
    const blob = new Blob([wav], { type: 'audio/wav' });

    const form = new FormData();
    form.append('file', blob, 'audio.wav');
    if (this.language && this.language !== 'auto') {
      form.append('language', this.language);
    }
    if (this.initialPrompt) {
      form.append('initial_prompt', this.initialPrompt);
    }
    // temperature=0: output định thức, giảm hallucination (quan trọng cho tiếng Nhật)
    form.append('temperature', '0');
    // faster-whisper-server uses 'response_format'
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Try whisper.cpp server endpoint first; fall back to OpenAI-compat
      let url = `${this.endpoint}/inference`;

      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          body:   form,
          signal: controller.signal,
        });
      } catch (fetchErr) {
        // Ph\u00e2n lo\u1ea1i l\u1ed7i r\u00f5 h\u01a1n
        const code = fetchErr.cause?.code || fetchErr.code || '';
        if (
          code === 'ECONNREFUSED' ||
          code === 'ENOTFOUND' ||
          fetchErr.message?.includes('ECONNREFUSED') ||
          fetchErr.message?.includes('fetch failed')
        ) {
          throw new Error(
            `Kh\u00f4ng k\u1ebft n\u1ed1i \u0111\u01b0\u1ee3c Whisper server t\u1ea1i ${this.endpoint}\n` +
            `H\u00e3y ch\u1ea1y: .\\start-whisper.ps1`
          );
        }
        throw fetchErr;
      }

      if (!resp.ok) {
        // Try OpenAI-compatible endpoint
        if (resp.status === 404) {
          const resp2 = await fetch(`${this.endpoint}/v1/audio/transcriptions`, {
            method: 'POST',
            body:   form,
            signal: controller.signal,
          });
          if (!resp2.ok) throw new Error(`Whisper HTTP ${resp2.status}`);
          const j2 = await resp2.json();
          return (j2.text || '').trim();
        }
        throw new Error(`Whisper HTTP ${resp.status}`);
      }

      const json = await resp.json();
      // whisper.cpp returns { text: "..." }
      // faster-whisper returns { text: "..." } as well
      return (json.text || '').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WhisperClient;

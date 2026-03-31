/**
 * src/ai/TranslatorClient.js
 *
 * Sends transcribed text to a local LLM for translation.
 *
 * Supports:
 *  - 'ollama'  → POST /api/generate  (http://localhost:11434)
 *  - 'openai'  → POST /v1/chat/completions  (any OpenAI-compatible server,
 *                e.g. LM Studio, llama-server, OpenRouter, etc.)
 *
 * Uses Node 18+ built-in fetch — no extra deps.
 */

'use strict';

class TranslatorClient {
  /**
   * @param {object} cfg
   * @param {'ollama'|'openai'} cfg.translatorType
   * @param {string} cfg.translatorEndpoint
   * @param {string} cfg.translatorModel
   * @param {string} cfg.sourceLanguage   "auto" or ISO code
   * @param {string} cfg.targetLanguage   e.g. "Vietnamese"
   * @param {number} cfg.translatorTimeout ms
   */
  constructor(cfg = {}) {
    this.type     = cfg.translatorType     || 'ollama';
    // Đổi localhost → 127.0.0.1 để tránh Node.js 18+ resolve IPv6
    this.endpoint = (cfg.translatorEndpoint || 'http://127.0.0.1:11434')
      .replace(/\/$/, '')
      .replace(/\/\/localhost\b/i, '//127.0.0.1');
    this.model    = cfg.translatorModel    || 'llama3.2';
    this.source   = cfg.sourceLanguage     || 'auto';
    this.target   = cfg.targetLanguage     || 'Vietnamese';
    this.timeout  = cfg.translatorTimeout  || 30000;
  }

  // ── Prompt ────────────────────────────────────────────────────────
  /**
   * Xây dựng prompt dịch có ngữ cảnh hội thoại.
   * @param {string} text  - câu cần dịch
   * @param {Array<{original:string,translated:string}>} context - lịch sử
   */
  _buildPrompt(text, context = []) {
    // Keep prompt minimal — fewer input tokens = faster Ollama inference
    let ctx = '';
    if (context.length > 0) {
      ctx = context.map(({ original, translated }) =>
        translated
          ? `Q: ${original}\nA: ${translated}`
          : `Q: ${original}`
      ).join('\n') + '\n';
    }
    return `Translate to ${this.target}. Output ONLY the translation, nothing else.\n${ctx}Q: ${text}\nA:`;
  }

  // ── Public ────────────────────────────────────────────────────────
  /**
   * @param {string} text
   * @param {Array<{original:string,translated:string}>} [context=[]]
   * @returns {Promise<string>}
   */
  /**
   * @param {string} text
   * @param {Array<{original:string,translated:string}>} [context=[]]
   * @param {((partial:string)=>void)|null} [onPartial] — called with accumulated text as tokens stream in
   * @returns {Promise<string>}
   */
  async translate(text, context = [], onPartial = null) {
    const t = text.trim();
    if (!t) return '';

    // Bỏ qua nhãn Whisper như [BLANK_AUDIO], (silence), v.v.
    if (/^\s*[\[(][\w\s_]+[\])]\s*$/i.test(t)) return '';

    const prompt     = this._buildPrompt(t, context);
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeout);

    try {
      return this.type === 'ollama'
        ? await this._ollama(prompt, controller.signal, onPartial)
        : await this._openai(prompt, controller.signal, onPartial);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Ollama — streaming NDJSON ────────────────────────────────────
  async _ollama(prompt, signal, onPartial) {
    const resp = await fetch(`${this.endpoint}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:  this.model,
        prompt,
        stream: true,
        options: { temperature: 0.1, num_predict: 150, num_ctx: 512 },
      }),
      signal,
    });

    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);

    let full = '';
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending   = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop(); // keep last incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.response) {
            full += json.response;
            onPartial?.(full.trim());
          }
          if (json.done) return full.trim();
        } catch { /* ignore malformed */ }
      }
    }
    return full.trim();
  }

  // ── OpenAI-compatible — streaming SSE ────────────────────────────
  async _openai(prompt, signal, onPartial) {
    const resp = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens:  150,
        stream:      true,
      }),
      signal,
    });

    if (!resp.ok) throw new Error(`OpenAI-compat HTTP ${resp.status}`);

    let full    = '';
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending   = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return full.trim();
        try {
          const json  = JSON.parse(data);
          const token = json.choices?.[0]?.delta?.content;
          if (token) {
            full += token;
            onPartial?.(full.trim());
          }
        } catch { /* ignore malformed */ }
      }
    }
    return full.trim();
  }
}

module.exports = TranslatorClient;

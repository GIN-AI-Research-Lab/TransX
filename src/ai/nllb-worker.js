'use strict';
/**
 * src/ai/nllb-worker.js
 *
 * Runs inside a worker_threads Worker — keeps ONNX inference OFF the main
 * thread so Electron stays responsive while NLLB-200 translates.
 *
 * Protocol (parentPort messages):
 *   main → worker:  { type: 'translate', id, text, srcCode, tgtCode }
 *   worker → main:  { type: 'ready' }
 *                   { type: 'result',  id, text }
 *                   { type: 'error',   id, message }
 *                   { type: 'init-error', message }
 */

const { workerData, parentPort } = require('worker_threads');

let _pipe = null;

async function init() {
  // @xenova/transformers is ESM — must use dynamic import() even in CJS worker
  const { pipeline, env } = await import('@xenova/transformers');

  env.localModelPath    = workerData.modelDir;
  env.allowRemoteModels = false;
  env.useBrowserCache   = false;

  const modelName = workerData.modelName || 'nllb-200-distilled-600M';
  console.log(`[nllb-worker] Loading model: ${modelName}`);
  _pipe = await pipeline('translation', modelName, {
    quantized: true,
    session_options: {
      intra_op_num_threads: 1,
      inter_op_num_threads: 1,
    },
  });
  console.log('[nllb-worker] Model ready.');
  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', async (msg) => {
  if (msg.type !== 'translate') return;
  const { id, text, srcCode, tgtCode } = msg;
  try {
    // Tiếng Nhật (CJK) ísă tiếng/ký tự hơn Latin: mỗi ký tự ~ 1 token, nhưng
    // output (Việt) nhiều ký tự hơn → nhân hệ số cao hơn.
    // Latin: 1 chữ ~0.3 token (đã sub-word) → nhân 0.5 là đủ.
    const isJapanese = /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    const ratio      = isJapanese ? 3.0 : 0.5;
    const maxTokens  = Math.min(150, Math.max(32, Math.ceil(text.length * ratio) + 16));
    const out = await _pipe(text, {
      src_lang:       srcCode,
      tgt_lang:       tgtCode,
      max_new_tokens: maxTokens,
      num_beams:      1,   // greedy — nhanh nhất
    });
    parentPort.postMessage({
      type: 'result',
      id,
      text: out?.[0]?.translation_text?.trim() ?? '',
    });
  } catch (e) {
    parentPort.postMessage({ type: 'error', id, message: e.message });
  }
});

init().catch((e) => {
  console.error('[nllb-worker] Init error:', e.message);
  parentPort.postMessage({ type: 'init-error', message: e.message });
});

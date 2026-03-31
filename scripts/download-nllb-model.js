#!/usr/bin/env node
/**
 * scripts/download-nllb-model.js
 *
 * Downloads the quantized NLLB-200 distilled 600M ONNX model from HuggingFace Hub
 * and stores it under nllb-models/nllb-200-distilled-600M/.
 *
 * This script is run ONCE by the developer before packaging the app:
 *   npm run download-model
 *
 * Total download size: ~560 MB
 * Files saved at: nllb-models/nllb-200-distilled-600M/
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const MODEL_REPO = 'Xenova/nllb-200-distilled-600M';
const HF_BASE    = `https://huggingface.co/${MODEL_REPO}/resolve/main`;
const OUT_DIR    = path.join(__dirname, '..', 'nllb-models', 'nllb-200-distilled-600M');

// Files to download (quantized ONNX + tokenizer assets)
const FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'sentencepiece.bpe.model',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n < 1024)       return `${n} B`;
  if (n < 1048576)    return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Download a URL to a local file, following redirects, showing progress.
 * Uses a .tmp file to avoid partially-written output on failure.
 */
function downloadFile(srcUrl, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const tmp  = destPath + '.tmp';
    const out  = fs.createWriteStream(tmp);
    let downloaded = 0;
    let total      = 0;

    function attempt(url) {
      const parsed = new URL(url);
      const mod    = parsed.protocol === 'https:' ? https : http;

      mod.get(url, { headers: { 'User-Agent': 'nllb-model-downloader/1.0' } }, (res) => {
        // Follow redirects — location có thể là relative path
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (!loc) { reject(new Error(`Redirect không có location header`)); return; }
          // Xây URL đầy đủ nếu location là relative
          const next = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.host}${loc}`;
          attempt(next);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        total = parseInt(res.headers['content-length'] || '0', 10);

        res.on('data', (chunk) => {
          out.write(chunk);
          downloaded += chunk.length;
          const bar  = total > 0 ? ` ${((downloaded / total) * 100).toFixed(1)}%` : '';
          process.stdout.write(`\r    ${fmtBytes(downloaded)}${bar}   `);
        });

        res.on('end', () => {
          out.end(() => {
            process.stdout.write('\n');
            fs.renameSync(tmp, destPath);
            resolve();
          });
        });

        res.on('error', reject);
      }).on('error', reject);
    }

    attempt(srcUrl);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   NLLB-200 Model Downloader              ║');
  console.log('║   facebook/nllb-200-distilled-600M       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\nOutput: ${OUT_DIR}\n`);

  for (const file of FILES) {
    const dest = path.join(OUT_DIR, file);

    if (fs.existsSync(dest)) {
      const size = fs.statSync(dest).size;
      console.log(`  ✓  ${file.padEnd(46)} (${fmtBytes(size)}, already exists)`);
      continue;
    }

    console.log(`  ↓  ${file}`);
    try {
      await downloadFile(`${HF_BASE}/${file}`, dest);
      const size = fs.statSync(dest).size;
      console.log(`  ✓  ${file.padEnd(46)} (${fmtBytes(size)})`);
    } catch (err) {
      console.error(`\n  ✗  Failed to download ${file}`);
      console.error(`     ${err.message}`);
      // Clean up temp file if it exists
      try { fs.unlinkSync(dest + '.tmp'); } catch { /* ignore */ }
      process.exit(1);
    }
  }

  console.log('\n✅  All files downloaded successfully!');
  console.log(`   Model ready at: ${OUT_DIR}`);
  console.log('\nYou can now build the app: npm run build');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

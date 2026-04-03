#!/usr/bin/env node
/**
 * scripts/setup-python-embed.js
 *
 * Downloads Python 3.11 embeddable (Windows x64) and installs ctranslate2 +
 * sentencepiece inside it. The resulting python-embed/ folder is bundled into
 * the app via extraResources — end users never need to install Python.
 *
 * Run once before building:
 *   node scripts/setup-python-embed.js
 *
 * Then convert the NLLB model:
 *   python-embed\python.exe scripts\setup-nllb-ct2.py
 *
 * Then build:
 *   npm run build:portable
 */

'use strict';

const https     = require('https');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { spawnSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const EMBED_DIR = path.join(ROOT, 'python-embed');

// Python 3.11.9 embeddable for Windows x64 (~8 MB zip)
const PYTHON_VER = '3.11.9';
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VER}/python-${PYTHON_VER}-embed-amd64.zip`;
const PIP_URL    = 'https://bootstrap.pypa.io/get-pip.py';

// ── Helpers ────────────────────────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);

    const get = (u) => {
      const req = proto.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          req.destroy();
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode} từ ${u}`));
          return;
        }

        const total    = parseInt(res.headers['content-length'] || '0', 10);
        let  received  = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const pct = (received / total * 100).toFixed(0);
            process.stdout.write(
              `\r  ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB  (${pct}%)   `,
            );
          }
        });

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      });
      req.on('error', (e) => { file.close(); reject(e); });
    };

    get(url);
  });
}

function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Command failed (exit ${r.status}): ${exe} ${args.join(' ')}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== setup-python-embed ===\n');

  const pythonExe = path.join(EMBED_DIR, 'python.exe');

  // ── Step 1: Download + extract Python embeddable ──────────────────────────
  if (fs.existsSync(pythonExe)) {
    console.log('[1/4] python.exe already present — skipping download.');
  } else {
    console.log(`[1/4] Downloading Python ${PYTHON_VER} embeddable (Windows x64)…`);
    const zipPath = path.join(os.tmpdir(), 'python-embed.zip');
    await download(PYTHON_URL, zipPath);

    console.log('  Extracting…');
    fs.mkdirSync(EMBED_DIR, { recursive: true });

    run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${EMBED_DIR}" -Force`,
    ]);
    fs.unlinkSync(zipPath);
    console.log('[1/4] Done.\n');
  }

  // ── Step 2: Enable site-packages (patch ._pth file) ──────────────────────
  const pthFiles = fs.readdirSync(EMBED_DIR).filter((f) => f.endsWith('._pth'));
  if (pthFiles.length === 0) throw new Error('._pth file not found in python-embed/');

  const pthFile = path.join(EMBED_DIR, pthFiles[0]);
  let   pth     = fs.readFileSync(pthFile, 'utf-8');

  if (pth.includes('#import site')) {
    pth = pth.replace('#import site', 'import site');
    fs.writeFileSync(pthFile, pth, 'utf-8');
    console.log(`[2/4] Patched ${pthFiles[0]} → site-packages enabled.\n`);
  } else {
    console.log('[2/4] site-packages already enabled.\n');
  }

  // ── Step 3: Install pip ───────────────────────────────────────────────────
  const pipModule = path.join(EMBED_DIR, 'Lib', 'site-packages', 'pip');
  if (fs.existsSync(pipModule)) {
    console.log('[3/4] pip already installed — skipping.\n');
  } else {
    console.log('[3/4] Installing pip…');
    const getPipPath = path.join(os.tmpdir(), 'get-pip.py');
    await download(PIP_URL, getPipPath);

    run(pythonExe, [getPipPath, '--no-warn-script-location'], { cwd: EMBED_DIR });
    fs.unlinkSync(getPipPath);
    console.log('[3/4] pip installed.\n');
  }

  // ── Step 4: Install ctranslate2 + sentencepiece + faster-whisper ─────────
  const ct2Module = path.join(EMBED_DIR, 'Lib', 'site-packages', 'ctranslate2');
  if (fs.existsSync(ct2Module)) {
    console.log('[4/4] ctranslate2 already installed — skipping.\n');
  } else {
    console.log('[4/4] Installing ctranslate2 + sentencepiece (có thể mất vài phút)…');
    run(pythonExe, [
      '-m', 'pip', 'install', 'ctranslate2', 'sentencepiece',
      '--no-warn-script-location',
      '--disable-pip-version-check',
    ], { cwd: ROOT });
    console.log('[4/4] Done.\n');
  }

  // ── Step 5: Install faster-whisper ───────────────────────────────────────
  const fwModule = path.join(EMBED_DIR, 'Lib', 'site-packages', 'faster_whisper');
  if (fs.existsSync(fwModule)) {
    console.log('[5/5] faster-whisper already installed — skipping.\n');
  } else {
    console.log('[5/5] Installing faster-whisper (có thể mất vài phút)…');
    run(pythonExe, [
      '-m', 'pip', 'install', 'faster-whisper',
      '--no-warn-script-location',
      '--disable-pip-version-check',
    ], { cwd: ROOT });
    console.log('[5/5] Done.\n');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const sizeMB = getFolderSizeMB(EMBED_DIR);
  console.log(`✓  python-embed/ sẵn sàng  (${sizeMB} MB)\n`);
  console.log('Bước tiếp theo — convert model NLLB (chỉ chạy 1 lần, ~5–10 phút):');
  console.log('  npm run setup:ct2\n');
  console.log('Sau đó build:');
  console.log('  npm run build:portable\n');
}

function getFolderSizeMB(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, f.name);
    if (f.isDirectory()) total += getFolderSizeMB(fp) * 1e6;
    else total += fs.statSync(fp).size;
  }
  return (total / 1e6).toFixed(0);
}

main().catch((e) => {
  console.error('\n[ERROR]', e.message);
  process.exit(1);
});

'use strict';
/**
 * Pre-populates the electron-builder winCodeSign tool cache to avoid a Windows
 * symlink-permission failure, then spawns electron-builder with the correct
 * ELECTRON_BUILDER_CACHE environment variable pointing to our pre-built cache.
 *
 * Background:
 *   winCodeSign-2.6.0.7z contains two macOS symlinks (darwin/10.12/lib/*.dylib).
 *   7za.exe cannot create symlinks on Windows without SeCreateSymbolicLinkPrivilege
 *   (requires Developer Mode or Admin). It exits with code 2; app-builder treats
 *   that as failure and retries forever.
 *
 * Fix:
 *   1. Download the archive with Node.js https.
 *   2. Extract with 7za, tolerating exit code 2 (only the two symlinks fail).
 *   3. Create empty placeholder files for the two missing macOS symlinks.
 *   4. Set process.env.ELECTRON_BUILDER_CACHE to our absolute cache path.
 *   5. Spawn electron-builder — app-builder finds the pre-existing directory and
 *      returns immediately (exit 0) without attempting any download.
 *
 * Usage:  node scripts/prepare-build-cache.js [electron-builder args...]
 */

const { spawnSync } = require('child_process');
const https         = require('https');
const fs            = require('fs');
const path          = require('path');

const ROOT       = path.resolve(__dirname, '..');
const CACHE_BASE = path.join(ROOT, '.build-cache');
const TOOL_DIR   = path.join(CACHE_BASE, 'winCodeSign', 'winCodeSign-2.6.0');
const DL_URL     = 'https://github.com/electron-userland/electron-builder-binaries' +
                   '/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';
const ARCHIVE    = path.join(CACHE_BASE, 'winCodeSign-2.6.0.7z');
const ZA7        = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

// macOS symlinks that 7za cannot create on Windows without Developer Mode enabled
const STUBS = [
  path.join(TOOL_DIR, 'darwin', '10.12', 'lib', 'libcrypto.dylib'),
  path.join(TOOL_DIR, 'darwin', '10.12', 'lib', 'libssl.dylib'),
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp  = dest + '.tmp';
    const file = fs.createWriteStream(tmp);
    function get(target) {
      https.get(target, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close(); return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let rcvd = 0;
        res.on('data', (c) => {
          rcvd += c.length;
          if (total) process.stdout.write('\r[cache] Downloading winCodeSign... ' + Math.round(rcvd / total * 100) + '%');
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          fs.renameSync(tmp, dest);
          process.stdout.write('\n');
          resolve();
        }));
      }).on('error', reject);
    }
    get(url);
  });
}

async function ensureCache() {
  if (fs.existsSync(TOOL_DIR)) {
    console.log('[cache] winCodeSign cache present — skipping setup.');
    return;
  }
  console.log('[cache] Setting up winCodeSign build cache...');
  fs.mkdirSync(TOOL_DIR, { recursive: true });

  if (!fs.existsSync(ARCHIVE)) {
    await download(DL_URL, ARCHIVE);
  }

  console.log('[cache] Extracting (exit 2 = macOS symlink warnings, not a real error)…');
  const r = spawnSync(ZA7, ['x', '-y', ARCHIVE, '-o' + TOOL_DIR], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0 && r.status !== 2) {
    process.stderr.write('[cache] ERROR: extraction failed (exit ' + r.status + ')\n');
    process.stderr.write(r.stderr || r.stdout || '');
    process.exit(1);
  }

  for (const stub of STUBS) {
    if (!fs.existsSync(stub)) {
      fs.mkdirSync(path.dirname(stub), { recursive: true });
      fs.writeFileSync(stub, '');
    }
  }
  console.log('[cache] winCodeSign cache ready at ' + TOOL_DIR);
}

(async () => {
  try {
    await ensureCache();
  } catch (e) {
    console.warn('[cache] Cache setup failed:', e.message, '— electron-builder will attempt its own download.');
  }

  process.env.ELECTRON_BUILDER_CACHE = CACHE_BASE;

  const args   = process.argv.slice(2);
  const ebBin  = path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd');
  console.log('[build] electron-builder ' + args.join(' '));

  const result = spawnSync(ebBin, args, { stdio: 'inherit', shell: false, env: process.env });
  process.exit(result.status != null ? result.status : 1);
})();

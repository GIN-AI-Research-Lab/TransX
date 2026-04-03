'use strict';
/**
 * scripts/pack-zip.js
 *
 * Zips dist/win-unpacked/ → dist/Trans Overlay <version>.zip
 *
 * Run automatically after `npm run build:zip`.
 * The resulting .zip is the true portable distribution:
 *   - User unzips once to any folder
 *   - Runs "Trans Overlay.exe" directly — no extraction, no install
 *   - Starts in ~1s instead of 60s+
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PKG         = require(path.join(ROOT, 'package.json'));
const UNPACKED    = path.join(ROOT, 'dist', 'win-unpacked');
const DIST        = path.join(ROOT, 'dist');
const OUT_ZIP     = path.join(DIST, `Trans Overlay ${PKG.version}.zip`);

if (!fs.existsSync(UNPACKED)) {
  console.error('[pack-zip] ERROR: dist/win-unpacked not found. Run npm run build first.');
  process.exit(1);
}

// Remove old zip if present
if (fs.existsSync(OUT_ZIP)) fs.unlinkSync(OUT_ZIP);

console.log(`[pack-zip] Zipping win-unpacked → ${path.basename(OUT_ZIP)} ...`);

// Use PowerShell's Compress-Archive (built-in on Windows, no extra deps)
const ps = `Compress-Archive -Path "${UNPACKED}\\*" -DestinationPath "${OUT_ZIP}" -Force`;
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  stdio: 'inherit',
  shell: false,
});

const sizeMB = (fs.statSync(OUT_ZIP).size / 1_048_576).toFixed(0);
console.log(`[pack-zip] Done: dist/${path.basename(OUT_ZIP)}  (${sizeMB} MB)`);
console.log('[pack-zip] Distribution: unzip → run "Trans Overlay.exe" directly — instant start.');

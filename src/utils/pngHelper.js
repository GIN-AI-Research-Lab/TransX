/**
 * src/utils/pngHelper.js
 *
 * Pure Node.js (no external deps) minimal PNG generator.
 * Used to create programmatic tray icons without needing asset files.
 *
 * Uses built-in zlib for DEFLATE compression.
 */

'use strict';

const zlib = require('zlib');

// ── CRC-32 (PNG uses CRC-32 for chunk integrity) ──────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ─────────────────────────────────────────────
function buildChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const crcInput  = Buffer.concat([typeBytes, data]);
  const checksum  = crc32(crcInput);

  const out = Buffer.alloc(4 + 4 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(checksum, 8 + data.length);
  return out;
}

/**
 * Generate a solid-color PNG buffer.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} r  0-255
 * @param {number} g  0-255
 * @param {number} b  0-255
 * @param {number} [a=255]  alpha 0-255
 * @returns {Buffer}  valid PNG file bytes
 */
function createSolidPNG(width, height, r, g, b, a = 255) {
  const channels   = 4;        // RGBA
  const colorType  = 6;        // RGBA
  const rowSize    = 1 + width * channels;   // 1 filter byte + pixels

  // Build raw image data (filter byte 0 = None per row)
  const raw = Buffer.alloc(rowSize * height, 0);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const i = y * rowSize + 1 + x * channels;
      raw[i]     = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });

  // IHDR data (13 bytes)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;          // bit depth
  ihdr[9]  = colorType;  // RGBA
  ihdr[10] = 0;          // compression: deflate
  ihdr[11] = 0;          // filter: adaptive
  ihdr[12] = 0;          // interlace: none

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic

  return Buffer.concat([
    sig,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', compressed),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { createSolidPNG };

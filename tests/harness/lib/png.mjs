// png.mjs — minimal pure-JS RGBA PNG writer.
//
// Why hand-roll a PNG encoder instead of pulling in pngjs or sharp?
// The repo is strictly no-deps (no package.json, no node_modules) and
// staying that way keeps agent setup trivial. PNG's spec is small
// enough that a compliant writer fits in ~80 lines.
//
// Compression: uses zlib's deflate via node:zlib — that's a Node builtin,
// not an npm dep, so we're still within the "no package.json" rule.
//
// Output: 8-bit RGBA (colour type 6). Handles arbitrary widths/heights.

import { deflateSync } from 'node:zlib';

// CRC-32 table (IEEE polynomial 0xEDB88320).
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = u32(data.length);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  return Buffer.concat([lenBuf, typeBuf, data, u32(crc)]);
}

// width, height, rgba: Uint8Array of length width*height*4 in row-major order.
// Returns a Buffer containing a complete PNG file.
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: rgba length ${rgba.length} !== ${width}*${height}*4 (${width * height * 4})`);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression: deflate
  ihdr[11] = 0;  // filter method: 0
  ihdr[12] = 0;  // interlace: none

  // IDAT — every scanline prefixed with filter byte 0 (none).
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Perceptual hash: 8×8 mean-downsampled greyscale, median-thresholded.
// Returns a 16-char hex string. Two images with the same hash are a
// strong signal they're visually similar. Crucially, it's robust to
// small pixel-level rendering differences (1-pixel jitter, anti-aliasing
// at scaling boundaries) that a byte-level compare would flag.
export function phash(width, height, rgba) {
  const blockW = width / 8;
  const blockH = height / 8;
  const vals = new Float64Array(64);
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(bx * blockW), x1 = Math.ceil((bx + 1) * blockW);
      const y0 = Math.floor(by * blockH), y1 = Math.ceil((by + 1) * blockH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          // Rec. 709 luma — matches what human eyes care about.
          sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
          count++;
        }
      }
      vals[by * 8 + bx] = count > 0 ? sum / count : 0;
    }
  }
  // Median threshold.
  const sorted = [...vals].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  let bits = 0n;
  for (let i = 0; i < 64; i++) {
    if (vals[i] > median) bits |= 1n << BigInt(i);
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(hash1, hash2) {
  let a = BigInt('0x' + hash1);
  let b = BigInt('0x' + hash2);
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

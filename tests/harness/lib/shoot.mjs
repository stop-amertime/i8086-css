// shoot.mjs — grab a screenshot from the calcite-debugger at the current tick.
//
// Two source paths:
//   A. Render directly from 8086 memory via /memory. Fast, no browser,
//      works headless. Handles text mode, mode 13h (VGA 320×200 palette),
//      and CGA 320×200×4. This is the primary path.
//   B. Drive the web player through Playwright and take a Chrome
//      screenshot. Slower and depends on Playwright being installed,
//      but shows what Chrome actually renders — useful when the suspicion
//      is that the calcite-produced framebuffer is right but Chrome's CSS
//      evaluation diverges. Opt-in.
//
// Detection: BDA 0x449 holds the current video mode. Text modes 0x00-0x03
// render from 0xB8000 (mode 0/1 are 40-col, 2/3 are 80-col). Mode 0x04/0x06
// are CGA graphics at 0xB8000. Mode 0x13 is VGA 320×200 palette at 0xA0000.
// The DAC palette for mode 0x13 lives out-of-band at 0x100000 (DAC_LINEAR).
//
// Output: RGBA framebuffer + PNG bytes + perceptual hash. Caller decides
// whether to write to disk.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phash, encodePng } from './png.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_DOS_ROOT = resolve(__dirname, '..', '..', '..');

const DAC_LINEAR = 0x100000;
const DAC_BYTES = 768;

// Standard VGA text-attribute RGB triples (0-0xFF, not 0-0x3F 6-bit).
// Matches what corduroy's splash / DOS CLS / kernel output relies on.
const TEXT_PALETTE = [
  [0x00, 0x00, 0x00], // 0 black
  [0x00, 0x00, 0xAA], // 1 blue
  [0x00, 0xAA, 0x00], // 2 green
  [0x00, 0xAA, 0xAA], // 3 cyan
  [0xAA, 0x00, 0x00], // 4 red
  [0xAA, 0x00, 0xAA], // 5 magenta
  [0xAA, 0x55, 0x00], // 6 brown
  [0xAA, 0xAA, 0xAA], // 7 light gray
  [0x55, 0x55, 0x55], // 8 dark gray
  [0x55, 0x55, 0xFF], // 9 light blue
  [0x55, 0xFF, 0x55], // 10 light green
  [0x55, 0xFF, 0xFF], // 11 light cyan
  [0xFF, 0x55, 0x55], // 12 light red
  [0xFF, 0x55, 0xFF], // 13 light magenta
  [0xFF, 0xFF, 0x55], // 14 yellow
  [0xFF, 0xFF, 0xFF], // 15 white
];

// 8×8 CGA-style glyph bitmap: 256 chars × 8 rows = 2048 bytes at
// bios/corduroy/cga-8x8.bin. The same font the corduroy splash uses.
// 8 rows tall keeps text rendering fast; real VGA would be 16-row, but
// this is fine for phash-based screenshot comparisons.
const FONT_WIDTH = 8;
const FONT_HEIGHT = 8;
let FONT_BYTES = null;
function buildFont() {
  if (FONT_BYTES) return FONT_BYTES;
  const path = resolve(CSS_DOS_ROOT, 'bios', 'corduroy', 'cga-8x8.bin');
  FONT_BYTES = new Uint8Array(readFileSync(path));
  if (FONT_BYTES.length !== 256 * FONT_HEIGHT) {
    throw new Error(`cga-8x8.bin size ${FONT_BYTES.length} !== 2048 — font file is wrong shape`);
  }
  return FONT_BYTES;
}
function fontRow(ch, row) {
  const font = buildFont();
  return font[(ch & 0xFF) * FONT_HEIGHT + row] & 0xFF;
}

// Derive the current video mode and a sensible render strategy from BDA.
export async function detectVideoMode(dbg) {
  const r = await dbg.memory(0x449, 2);
  const mode = r.bytes[0] & 0xFF;
  return { mode, bdaBytes: r.bytes };
}

// Main entrypoint. Takes a debugger client, returns a screenshot object.
export async function shoot(dbg, { mode: modeOverride = null } = {}) {
  const info = modeOverride != null
    ? { mode: modeOverride }
    : await detectVideoMode(dbg);
  const { mode } = info;

  if (mode === 0x03 || mode === 0x02 || mode === 0x07) {
    return shootText80(dbg, { mode });
  }
  if (mode === 0x00 || mode === 0x01) {
    return shootText40(dbg, { mode });
  }
  if (mode === 0x13) {
    return shootMode13(dbg);
  }
  if (mode === 0x04 || mode === 0x05) {
    return shootCgaGfx(dbg, { mode });
  }
  if (mode === 0x06) {
    return shootCgaHires(dbg);
  }
  // Unknown — dump the common framebuffer regions so the caller at least
  // sees *something*, and flag the mode.
  return shootUnknown(dbg, mode);
}

// --- Text modes ---------------------------------------------------------

async function shootText80(dbg, { mode }) {
  return shootText(dbg, { mode, cols: 80, rows: 25, base: 0xB8000 });
}

async function shootText40(dbg, { mode }) {
  return shootText(dbg, { mode, cols: 40, rows: 25, base: 0xB8000 });
}

async function shootText(dbg, { mode, cols, rows, base }) {
  const len = cols * rows * 2;
  const mem = await dbg.memory(base, len);
  const bytes = mem.bytes;

  // Build a text-only render (also useful as a return value: most tests
  // care about "did 'A:\>' show up" more than pixel exactness).
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      const off = (y * cols + x) * 2;
      const ch = bytes[off] & 0xFF;
      s += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : ch === 0 ? ' ' : '·';
    }
    lines.push(s.replace(/ +$/, ''));
  }
  const text = lines.join('\n');

  // Pixel render: cols × FONT_WIDTH by rows × FONT_HEIGHT. Colour cells
  // via attribute byte. No blink, no cursor.
  buildFont(); // prime the font cache so fontRow doesn't allocate mid-loop.
  const w = cols * FONT_WIDTH;
  const h = rows * FONT_HEIGHT;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const off = (y * cols + x) * 2;
      const ch = bytes[off] & 0xFF;
      const attr = bytes[off + 1] & 0xFF;
      const fg = TEXT_PALETTE[attr & 0x0F];
      const bg = TEXT_PALETTE[(attr >> 4) & 0x07];
      for (let py = 0; py < FONT_HEIGHT; py++) {
        const row = fontRow(ch, py);
        for (let px = 0; px < FONT_WIDTH; px++) {
          const lit = (row >> (7 - px)) & 1;
          const colour = lit ? fg : bg;
          const idx = ((y * FONT_HEIGHT + py) * w + (x * FONT_WIDTH + px)) * 4;
          rgba[idx] = colour[0];
          rgba[idx + 1] = colour[1];
          rgba[idx + 2] = colour[2];
          rgba[idx + 3] = 0xFF;
        }
      }
    }
  }

  const png = encodePng(w, h, rgba);
  return {
    mode,
    kind: 'text',
    width: w,
    height: h,
    text,
    rgba,
    png,
    phash: phash(w, h, rgba),
  };
}

// --- Mode 13h (VGA 320×200 palette) -----------------------------------

async function shootMode13(dbg) {
  const frame = await dbg.memory(0xA0000, 320 * 200);
  const dac = await dbg.memory(DAC_LINEAR, DAC_BYTES);
  const fb = frame.bytes;
  const pal = dac.bytes;

  const rgba = new Uint8Array(320 * 200 * 4);
  for (let i = 0; i < 320 * 200; i++) {
    const c = fb[i] & 0xFF;
    // DAC entries are 6-bit (0..63) — scale to 0..255 by multiplying by 4
    // plus the remainder bit to fill the full range.
    const r6 = pal[c * 3 + 0] & 0x3F;
    const g6 = pal[c * 3 + 1] & 0x3F;
    const b6 = pal[c * 3 + 2] & 0x3F;
    rgba[i * 4 + 0] = (r6 << 2) | (r6 >> 4);
    rgba[i * 4 + 1] = (g6 << 2) | (g6 >> 4);
    rgba[i * 4 + 2] = (b6 << 2) | (b6 >> 4);
    rgba[i * 4 + 3] = 0xFF;
  }

  const png = encodePng(320, 200, rgba);
  return {
    mode: 0x13,
    kind: 'mode13',
    width: 320,
    height: 200,
    rgba,
    png,
    phash: phash(320, 200, rgba),
    paletteFirst16: Array.from(pal.slice(0, 48)),
  };
}

// --- CGA graphics modes ------------------------------------------------

// CGA 320×200×4 (interleaved even/odd lines at B8000/BA000).
async function shootCgaGfx(dbg, { mode }) {
  const even = await dbg.memory(0xB8000, 0x2000);
  const odd  = await dbg.memory(0xBA000, 0x2000);
  const pEven = even.bytes, pOdd = odd.bytes;

  // Palette 1 (cyan/magenta/white) is the common one; palette 0
  // (green/red/brown) is rarer. Default assumption is palette 1 — it's
  // what DOS 4DOS/EDIT/QBasic use. Mode 5 = palette 1 low-intensity.
  const CGA = [
    [0x00, 0x00, 0x00],  // 0 background (usually black)
    [0x00, 0xFF, 0xFF],  // 1 cyan
    [0xFF, 0x00, 0xFF],  // 2 magenta
    [0xFF, 0xFF, 0xFF],  // 3 white
  ];
  const rgba = new Uint8Array(320 * 200 * 4);
  for (let row = 0; row < 200; row++) {
    const src = row % 2 === 0 ? pEven : pOdd;
    const srcRow = (row >> 1) * 80;
    for (let col = 0; col < 320; col++) {
      const byte = src[srcRow + (col >> 2)] & 0xFF;
      const shift = 6 - ((col & 3) * 2);
      const idx = (byte >> shift) & 3;
      const c = CGA[idx];
      const off = (row * 320 + col) * 4;
      rgba[off] = c[0];
      rgba[off + 1] = c[1];
      rgba[off + 2] = c[2];
      rgba[off + 3] = 0xFF;
    }
  }
  const png = encodePng(320, 200, rgba);
  return { mode, kind: 'cga320', width: 320, height: 200, rgba, png, phash: phash(320, 200, rgba) };
}

// CGA mode 6: 640×200×2 (monochrome).
async function shootCgaHires(dbg) {
  const even = await dbg.memory(0xB8000, 0x2000);
  const odd  = await dbg.memory(0xBA000, 0x2000);
  const pEven = even.bytes, pOdd = odd.bytes;
  const rgba = new Uint8Array(640 * 200 * 4);
  for (let row = 0; row < 200; row++) {
    const src = row % 2 === 0 ? pEven : pOdd;
    const srcRow = (row >> 1) * 80;
    for (let col = 0; col < 640; col++) {
      const byte = src[srcRow + (col >> 3)] & 0xFF;
      const shift = 7 - (col & 7);
      const lit = (byte >> shift) & 1;
      const off = (row * 640 + col) * 4;
      rgba[off] = rgba[off + 1] = rgba[off + 2] = lit ? 0xFF : 0x00;
      rgba[off + 3] = 0xFF;
    }
  }
  const png = encodePng(640, 200, rgba);
  return { mode: 0x06, kind: 'cga640', width: 640, height: 200, rgba, png, phash: phash(640, 200, rgba) };
}

async function shootUnknown(dbg, mode) {
  // For unknown modes, grab 32KB at 0xA0000 and 8KB at 0xB8000 and return
  // both as annotations so the caller can at least eyeball what's there.
  const a0000 = await dbg.memory(0xA0000, 32 * 1024);
  const b8000 = await dbg.memory(0xB8000, 8 * 1024);
  return {
    mode,
    kind: 'unknown',
    width: 0,
    height: 0,
    rgba: null,
    png: null,
    phash: null,
    note: `unknown video mode ${mode.toString(16)} — no renderer; dumping common framebuffer regions`,
    dumpA0000Hex: a0000.hex,
    dumpB8000Hex: b8000.hex,
  };
}

// Optional: Chrome-rendered screenshot via Playwright. We don't import
// playwright at module scope — it's optional. Callers that want it
// must `await import('playwright')` themselves or pass `playwright`
// as an arg.
export async function shootChrome({ playwright, cabinetPath, playerUrl, width = 640, height = 400 }) {
  if (!playwright) {
    throw new Error('shootChrome requires playwright — pass it in as `playwright`');
  }
  const browser = await playwright.chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.goto(playerUrl);
    // Wait for the <img> to have a natural-size > 0, meaning the bridge
    // is streaming frames. Timeout is generous since Chrome needs a few
    // seconds to parse a 150 MB cabinet and start computing.
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('img');
      return [...imgs].some(i => i.naturalWidth > 0);
    }, { timeout: 60_000 });
    const buf = await page.screenshot({ type: 'png' });
    return { png: buf, width, height };
  } finally {
    await browser.close();
  }
}

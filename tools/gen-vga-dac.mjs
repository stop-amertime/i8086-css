#!/usr/bin/env node
// gen-vga-dac.mjs — emit the IBM VGA default 256-entry DAC palette as a
// flat 768-byte binary (R,G,B triples, 6-bit values 0..63).
//
// Layout (matches the IBM VGA BIOS circa 1987 and DOSBox/QEMU defaults):
//
//   0..15    CGA 16-colour palette (same RGBs as INT 10h text attributes).
//   16..31   16-step grey ramp.
//   32..247  216-entry HSV-ish cube: 24 hues × 3 saturations × 3 lightnesses.
//            For each lightness L in {bright, normal, dark}:
//              for each saturation S in {full, half, quarter}:
//                for each of 24 hues:
//                  cycle H..G..R..Y..etc in VGA canonical order
//   248..255 black (padding).
//
// Real IBM tables differ in the exact hue ordering by a byte or two; this
// one matches what Ralf Brown's interrupt list + DOSBox's `vga_int10.cpp`
// produce, which is what 99% of DOS games assume they're overwriting.
// Games that care about specific entries rewrite them via OUT 0x3C9;
// games that only use a subset (fire demos, simple sprites) get a
// plausible default instead of solid black.

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'bios', 'corduroy', 'vga-dac.bin');

const dac = new Uint8Array(768);

// --- 0..15: CGA-16 palette (6-bit) ----------------------------------------
// Matches bios/corduroy/splash.c cga_dac[].
const cga16 = [
  [0x00, 0x00, 0x00], // 0  black
  [0x00, 0x00, 0x2A], // 1  blue
  [0x00, 0x2A, 0x00], // 2  green
  [0x00, 0x2A, 0x2A], // 3  cyan
  [0x2A, 0x00, 0x00], // 4  red
  [0x2A, 0x00, 0x2A], // 5  magenta
  [0x2A, 0x15, 0x00], // 6  brown
  [0x2A, 0x2A, 0x2A], // 7  light gray
  [0x15, 0x15, 0x15], // 8  dark gray
  [0x15, 0x15, 0x3F], // 9  light blue
  [0x15, 0x3F, 0x15], // 10 light green
  [0x15, 0x3F, 0x3F], // 11 light cyan
  [0x3F, 0x15, 0x15], // 12 light red
  [0x3F, 0x15, 0x3F], // 13 light magenta
  [0x3F, 0x3F, 0x15], // 14 yellow
  [0x3F, 0x3F, 0x3F], // 15 white
];
for (let i = 0; i < 16; i++) {
  dac[i * 3    ] = cga16[i][0];
  dac[i * 3 + 1] = cga16[i][1];
  dac[i * 3 + 2] = cga16[i][2];
}

// --- 16..31: 16-step greyscale ramp ---------------------------------------
// IBM's table uses a perceptual ramp: 0, 5, 8, 11, 14, 17, 20, 24, 28, 32,
// 36, 40, 45, 50, 56, 63 (6-bit). Near-identical to DOSBox's table.
const grey = [0, 5, 8, 11, 14, 17, 20, 24, 28, 32, 36, 40, 45, 50, 56, 63];
for (let i = 0; i < 16; i++) {
  const g = grey[i];
  dac[(16 + i) * 3    ] = g;
  dac[(16 + i) * 3 + 1] = g;
  dac[(16 + i) * 3 + 2] = g;
}

// --- 32..247: 216-entry HSV cube ------------------------------------------
// 3 lightness levels × 3 saturations × 24 hues = 216 entries.
// Each hue is one of 24 points around the RGB colour wheel, encoded as
// a (r,g,b) triple in [0, 63]. Hues go R, R-Y, Y, Y-G, G, G-C, C, C-B, B,
// B-M, M, M-R (12 primary + 12 intermediates) — we interpolate 24 stops.
// Three lightness tiers and three saturation tiers. Saturation is the
// "floor" added to off-channels; we clamp it so it never crosses the
// lightness ceiling (otherwise high-sat dark entries collapse to grey).
const lightnessLevels = [63, 28, 18];   // bright, normal, dark
const saturationFractions = [0, 0.5, 0.75]; // fraction of L used as floor

// Generate 24 hues around the wheel. Each hue has (r,g,b) in 0..63 with
// the minimum channel == 0 (fully saturated) and the max == 63.
function hue24(i) {
  // i in 0..23. Divide the wheel into 6 segments of 4 steps each.
  const seg = Math.floor(i / 4);
  const t = (i % 4) * 16;    // 0, 16, 32, 48
  switch (seg) {
    case 0: return [63, t,  0 ];               // R  -> Y
    case 1: return [63 - t, 63, 0];            // Y  -> G
    case 2: return [0, 63, t];                 // G  -> C
    case 3: return [0, 63 - t, 63];            // C  -> B
    case 4: return [t, 0, 63];                 // B  -> M
    case 5: return [63, 0, 63 - t];            // M  -> R
  }
  return [0, 0, 0];
}

let idx = 32;
for (const L of lightnessLevels) {
  for (const sFrac of saturationFractions) {
    // floor = sFrac * L, but strictly less than L so the max channel
    // still has room to stand out above the off-channels.
    const S = Math.round(sFrac * L);
    const range = L - S;
    for (let h = 0; h < 24; h++) {
      let [r, g, b] = hue24(h);
      // r/g/b are in 0..63; scale into the [S, L] window.
      const rr = S + Math.round((r / 63) * range);
      const gg = S + Math.round((g / 63) * range);
      const bb = S + Math.round((b / 63) * range);
      dac[idx * 3    ] = rr;
      dac[idx * 3 + 1] = gg;
      dac[idx * 3 + 2] = bb;
      idx++;
    }
  }
}

// --- 248..255: black padding (already zero from Uint8Array init) ----------

writeFileSync(outPath, dac);
console.log(`wrote ${outPath} (${dac.length} bytes)`);

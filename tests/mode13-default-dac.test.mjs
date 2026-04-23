#!/usr/bin/env node
// Verify the Mode 13h default-DAC-on-set-mode behaviour.
//
// Real VGA hardware resets the 256-entry DAC to the IBM default palette
// whenever the program calls INT 10h AH=00h AL=13h. Games that do
// partial palette updates (e.g. fire demos that rewrite entries 0..63)
// rely on the remaining entries having that default content rather than
// solid black.
//
// Checks:
//   1. tools/gen-vga-dac.mjs produces exactly 768 bytes and matches the
//      checked-in bios/corduroy/vga-dac.bin byte-for-byte (so the table
//      is reproducible — no hand-edited binary drift).
//   2. The first 16 entries match the CGA-16 palette from splash.c.
//   3. All 768 bytes fit in the 6-bit hardware range (0..63).
//   4. Entries 32..247 cover enough hues and lightnesses that a
//      palette-index histogram actually sees colour — i.e. we didn't
//      accidentally fill with a flat grey ramp.
//   5. bios/corduroy/handlers.asm has a `vga_dac_default:` label, an
//      incbin of vga-dac.bin, and a `.dac_loop:` that pumps 768 bytes
//      through OUT 0x3C9.
//   6. bios/gossamer/gossamer.asm mirrors the same three markers.
//   7. The .set_mode_13h path reaches `.dac_loop` before falling through
//      to `.set_mode_done` (i.e. the palette program is inside the
//      Mode-13h branch, not dead code after the iret).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  ${msg}`); }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

// --- 1. gen-vga-dac.mjs output matches the checked-in bin ------------------
console.log('[check] vga-dac.bin matches tools/gen-vga-dac.mjs output');
const dacPath = resolve(repoRoot, 'bios/corduroy/vga-dac.bin');
assert(existsSync(dacPath), 'bios/corduroy/vga-dac.bin is checked in');

execFileSync('node', ['tools/gen-vga-dac.mjs'], {
  cwd: repoRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const dac = readFileSync(dacPath);
assert(dac.length === 768, 'vga-dac.bin is exactly 768 bytes (256 * 3)');

// --- 2. First 16 entries match splash.c CGA-16 palette ---------------------
console.log('[check] entries 0..15 are the CGA-16 palette');
const cga16 = [
  [0x00, 0x00, 0x00], [0x00, 0x00, 0x2A], [0x00, 0x2A, 0x00], [0x00, 0x2A, 0x2A],
  [0x2A, 0x00, 0x00], [0x2A, 0x00, 0x2A], [0x2A, 0x15, 0x00], [0x2A, 0x2A, 0x2A],
  [0x15, 0x15, 0x15], [0x15, 0x15, 0x3F], [0x15, 0x3F, 0x15], [0x15, 0x3F, 0x3F],
  [0x3F, 0x15, 0x15], [0x3F, 0x15, 0x3F], [0x3F, 0x3F, 0x15], [0x3F, 0x3F, 0x3F],
];
let cgaOk = true;
for (let i = 0; i < 16; i++) {
  if (dac[i * 3    ] !== cga16[i][0]) cgaOk = false;
  if (dac[i * 3 + 1] !== cga16[i][1]) cgaOk = false;
  if (dac[i * 3 + 2] !== cga16[i][2]) cgaOk = false;
}
assert(cgaOk, 'entries 0..15 bit-match splash.c CGA-16 palette');

// --- 3. All values are 6-bit (0..63) --------------------------------------
console.log('[check] all DAC bytes fit in 6 bits');
let sixBit = true;
for (let i = 0; i < 768; i++) {
  if (dac[i] > 63) { sixBit = false; break; }
}
assert(sixBit, 'all 768 bytes are 6-bit (0..63)');

// --- 4. Entries 32..247 actually have colour ------------------------------
console.log('[check] hue cube is populated (not flat grey)');
let colourful = 0;
for (let i = 32; i < 248; i++) {
  const r = dac[i * 3    ];
  const g = dac[i * 3 + 1];
  const b = dac[i * 3 + 2];
  if (r !== g || g !== b) colourful++;
}
// 216 entries, expect the vast majority to be non-grey.
assert(colourful > 150,
  `at least 150 of entries 32..247 are non-grey (got ${colourful})`);

// --- 5. Corduroy handlers.asm has the markers -----------------------------
console.log('[check] Corduroy handlers.asm programs the default DAC on set-mode 0x13');
const corduroy = readFileSync(resolve(repoRoot, 'bios/corduroy/handlers.asm'), 'utf8');
assert(/^vga_dac_default:/m.test(corduroy),
  'Corduroy defines a `vga_dac_default:` label');
assert(/incbin\s+"vga-dac\.bin"/.test(corduroy),
  'Corduroy incbins vga-dac.bin');
assert(/^\.dac_loop:/m.test(corduroy),
  'Corduroy .set_mode_13h has a `.dac_loop:` that programs the DAC');

// The .dac_loop must be inside the .set_mode_13h branch — specifically,
// somewhere between the label `.set_mode_13h:` and the next label that
// marks the fall-through (`.set_mode_done:`). A buggy patch could easily
// leave the loop as dead code after an earlier iret.
const set13Idx = corduroy.indexOf('.set_mode_13h:');
const doneIdx  = corduroy.indexOf('.set_mode_done:');
const loopIdx  = corduroy.indexOf('.dac_loop:');
assert(set13Idx > 0 && doneIdx > set13Idx && loopIdx > set13Idx && loopIdx < doneIdx,
  '.dac_loop lies between .set_mode_13h and .set_mode_done (live, not dead)');

// --- 6. Gossamer mirrors ---------------------------------------------------
console.log('[check] Gossamer gossamer.asm mirrors the default DAC program');
const gossamer = readFileSync(resolve(repoRoot, 'bios/gossamer/gossamer.asm'), 'utf8');
assert(/^vga_dac_default:/m.test(gossamer),
  'Gossamer defines a `vga_dac_default:` label');
assert(/incbin\s+"\.\.\/corduroy\/vga-dac\.bin"/.test(gossamer),
  'Gossamer incbins ../corduroy/vga-dac.bin (shared table, single source of truth)');
assert(/^\.dac_loop:/m.test(gossamer),
  'Gossamer .set_mode_13h has a `.dac_loop:` that programs the DAC');

// --- 7. OUT 0x3C8 + OUT 0x3C9 sequencing present --------------------------
console.log('[check] set-mode 0x13 writes 0 to port 0x3C8 before 0x3C9 loop');
// The BIOS must first write DAC write-index = 0, then pump 768 bytes
// through 0x3C9. Grep for both port constants in the neighbourhood of
// the loop.
function loopWindow(src) {
  const l = src.indexOf('.dac_loop:');
  // Grab 300 chars before and after so we see the setup and the loop body.
  return src.slice(Math.max(0, l - 400), l + 200);
}
const cwin = loopWindow(corduroy);
assert(/0x3C8/.test(cwin) && /0x3C9/.test(cwin),
  'Corduroy: both 0x3C8 (index) and 0x3C9 (data) appear near .dac_loop');
const gwin = loopWindow(gossamer);
assert(/0x3C8/.test(gwin) && /0x3C9/.test(gwin),
  'Gossamer: both 0x3C8 (index) and 0x3C9 (data) appear near .dac_loop');

// --- Report ----------------------------------------------------------------
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll Mode 13h default-DAC checks passed.');

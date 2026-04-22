#!/usr/bin/env node
// Verify the CGA 0x04 end-to-end pipeline:
//
//  1. Cart manifest's `memory.cgaGfx: true` is honoured — the 16 KB CGA
//     aperture at 0xB8000-0xBC000 ends up in the emitted CSS.
//  2. Kiln emits port 0x3D9 (CGA palette mode register) write dispatch
//     on OUT opcodes 0xE6 / 0xEE, shadowing AL to linear 0x04F3.
//  3. The shadow byte address (0x04F3 = 1267) is inside the writable zone.
//  4. The JS-side decoder in calcite/web/video-modes.mjs packs bits the
//     way real CGA mode 0x04 does (2bpp MSB-first, scanline-interleaved
//     with planes at 0x0000 and 0x2000).
//
// These checks catch regressions at the CSS/kiln layer without needing
// a browser — the decoder itself runs in Node and the CSS is grep-tested.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cartDir  = resolve(repoRoot, 'carts/cga4-stripes');
const outDir   = resolve(repoRoot, 'tmp');
const outCss   = resolve(outDir, 'cga4-stripes.test.css');

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  ${msg}`); }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

// --- Build the cart --------------------------------------------------------
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
console.log('[build] carts/cga4-stripes → tmp/cga4-stripes.test.css');
execFileSync('node', ['builder/build.mjs', cartDir, '-o', outCss], {
  cwd: repoRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const css = readFileSync(outCss, 'utf8');

// --- Port 0x3D9 decode -----------------------------------------------------
console.log('[check] port 0x3D9 decode emitted by kiln');
// 985 = 0x3D9, 1267 = 0x04F3 (the BDA intra-app shadow for the palette reg).
assert(/style\(--q1:\s*985\).*1267/.test(css),
  'OUT imm8 form writes palette byte to linear 0x04F3 (1267)');
assert(/style\(--__1DX:\s*985\).*1267/.test(css),
  'OUT DX form writes palette byte to linear 0x04F3 (1267)');

// --- Writable shadow present at 0x04F3 -------------------------------------
console.log('[check] shadow @property exists at linear 0x04F3');
assert(/^@property --m1267 /m.test(css),
  '@property --m1267 declared (palette reg shadow is writable memory)');

// --- CGA aperture zone spans 0xB8000 .. 0xBC000 ----------------------------
console.log('[check] CGA aperture covered by @property declarations');
// 0xB8000 = 753664, 0xBBFFF = 770047. Spot-check both ends are present and
// that 0xBC000 (770048) is NOT — aperture is [start, end).
assert(/^@property --m753664 /m.test(css),
  '--m753664 (0xB8000) declared — aperture low bound present');
assert(/^@property --m770047 /m.test(css),
  '--m770047 (0xBBFFF) declared — aperture high bound present');
assert(!/^@property --m770048 /m.test(css),
  '--m770048 (0xBC000) NOT declared — aperture is half-open');

// --- BIOS stores mode byte + shadows raw requested mode --------------------
// handlers.asm (Corduroy) and gossamer.asm both accept 0x04 and store the
// mode byte to BDA 0x0449 (73), and Corduroy also shadows the raw request
// to linear 0x04F2 (1266). Smoke-grep the Corduroy source, not the CSS —
// the BIOS is linked into the CSS as ROM, not as instructions we can easily
// spot by string match.
console.log('[check] BIOS handlers accept mode 0x04');
const corduroy = readFileSync(resolve(repoRoot, 'bios/corduroy/handlers.asm'), 'utf8');
const gossamer = readFileSync(resolve(repoRoot, 'bios/gossamer/gossamer.asm'), 'utf8');
assert(/cmp al, 0x04/.test(corduroy),
  'Corduroy set_mode has a `cmp al, 0x04` branch (accepts mode 0x04)');
assert(/\[0x04F2\], al/.test(corduroy),
  'Corduroy set_mode shadows raw requested mode to linear 0x04F2');
assert(/cmp al, 0x04/.test(gossamer),
  'Gossamer set_mode has a `cmp al, 0x04` branch (accepts mode 0x04)');

// --- JS decoder packing ----------------------------------------------------
// Boot the decoder against a hand-built VRAM image and verify four expected
// bands come out of the palette-1 + intensity bank.
console.log('[check] JS decoder produces the expected 4 bands');
const videoModesPath = resolve(repoRoot, '..', 'calcite/web/video-modes.mjs');
const mod = await import(pathToFileURL(videoModesPath).href);
const { decodeCga4, pickMode, MODE_TABLE } = mod;

const modeInfo = pickMode(0x04);
assert(modeInfo && modeInfo.kind === 'cga4',
  'MODE_TABLE[0x04] is kind=cga4');
assert(modeInfo && modeInfo.width === 320 && modeInfo.height === 200,
  'MODE_TABLE[0x04] geometry is 320x200');
assert(modeInfo && modeInfo.vramAddr === 0xB8000,
  'MODE_TABLE[0x04] reads from 0xB8000');

// Build a 16 KB VRAM image the cart writes: four horizontal bands of
// colour indices 0..3. (Plane 0 at 0x0000 = even scanlines; plane 1 at
// 0x2000 = odd scanlines.)
const vram = new Uint8Array(0x4000);
for (let y = 0; y < 200; y++) {
  const c = Math.floor(y / 50);
  const plane = y & 1;
  const row = y >> 1;
  const byte = (c | (c << 2) | (c << 4) | (c << 6)) & 0xFF;
  const base = plane * 0x2000 + row * 80;
  for (let i = 0; i < 80; i++) vram[base + i] = byte;
}

// Palette register 0x30 = palette 1 + intensity + bg=0. Expected colours:
//   colour 0 = black, 1 = bright cyan, 2 = bright magenta, 3 = white.
const outRGBA = new Uint8Array(320 * 200 * 4);
decodeCga4(vram, 0x30, outRGBA);

function sample(y) {
  const off = (y * 320 + 160) * 4;
  return [outRGBA[off], outRGBA[off + 1], outRGBA[off + 2]];
}
function eq(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }

assert(eq(sample( 25), [  0,   0,   0]), 'band 0 (y=25)  → black');
assert(eq(sample( 75), [ 85, 255, 255]), 'band 1 (y=75)  → bright cyan');
assert(eq(sample(125), [255,  85, 255]), 'band 2 (y=125) → bright magenta');
assert(eq(sample(175), [255, 255, 255]), 'band 3 (y=175) → white');

// Band boundaries: the scanline interleave is easy to get wrong. If plane
// routing is off by one, y=49/50 or y=99/100 slip by a row.
assert(eq(sample( 49), [  0,   0,   0]), 'last row of band 0 still black');
assert(eq(sample( 50), [ 85, 255, 255]), 'first row of band 1 bright cyan');
assert(eq(sample( 99), [ 85, 255, 255]), 'last row of band 1 still bright cyan');
assert(eq(sample(100), [255,  85, 255]), 'first row of band 2 bright magenta');

// --- Report ----------------------------------------------------------------
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll CGA 0x04 checks passed.');

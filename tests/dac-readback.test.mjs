#!/usr/bin/env node
// Verify the VGA DAC read-back path: OUT 0x3C7 sets the read index, and
// three successive IN 0x3C9 reads pull R/G/B from the DAC shadow at
// linear DAC_LINEAR. After the third read, dacReadIndex increments by 1.
//
// This path matters for palette-fade effects that re-derive their target
// palette from the live DAC, screensavers blending against the previous
// program's palette, or any program that wants to dump the DAC state.
//
// Checks:
//   1. The kiln emit declares --dacReadIndex and --dacReadSubIndex.
//   2. OUT 0x3C7 (both imm and DX forms) loads AL into dacReadIndex and
//      resets dacReadSubIndex to 0.
//   3. IN AL, 0x3C9 reads through --readMem(calc(DAC_LINEAR + ...))
//      and advances dacReadSubIndex / dacReadIndex on wrap.
//   4. IN AL, 0x3C8 returns dacWriteIndex (the "where am I" helper).
//   5. IN AL, 0x3C7 returns 0 (DAC state register: ready for either
//      read or write — we don't distinguish).
//   6. JS-simulated state machine: 12 successive IN 0x3C9 reads starting
//      at read-index 5 touch the DAC slots in the expected order.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir   = resolve(repoRoot, 'tmp');
const outCss   = resolve(outDir, 'dac-readback.test.css');

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  ${msg}`); }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

// --- Build any cart so we can grep the emitted CSS --------------------------
// (Port decode emission is cart-agnostic; any hack build will do.)
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
console.log('[build] carts/cga4-stripes → tmp/dac-readback.test.css');
execFileSync('node', ['builder/build.mjs', 'carts/cga4-stripes', '-o', outCss], {
  cwd: repoRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const css = readFileSync(outCss, 'utf8');

// --- 1. --dacReadIndex and --dacReadSubIndex are declared ------------------
console.log('[check] DAC read-side state vars declared');
assert(/^@property --dacReadIndex /m.test(css),
  '--dacReadIndex declared via @property');
assert(/^@property --dacReadSubIndex /m.test(css),
  '--dacReadSubIndex declared via @property');

// --- 2. OUT 0x3C7 sets the read index & resets read sub-index --------------
console.log('[check] OUT 0x3C7 loads AL into dacReadIndex');
assert(/OUT 0x3C7: set DAC read index/.test(css),
  'OUT 0x3C7 imm form has a comment tag in the CSS (emitted by misc.mjs)');
assert(/OUT DX=0x3C7: set DAC read index/.test(css),
  'OUT DX=0x3C7 form emitted');
assert(/OUT 0x3C7\/0x3C8: reset DAC read sub-index/.test(css),
  'OUT 0x3C7 resets dacReadSubIndex (imm form)');
assert(/OUT DX=0x3C7\/0x3C8: reset DAC read sub-index/.test(css),
  'OUT 0x3C7 resets dacReadSubIndex (DX form)');

// --- 3. IN AL, 0x3C9 reads through --readMem on the DAC shadow -------------
console.log('[check] IN 0x3C9 reads DAC bytes via --readMem(DAC_LINEAR + ...)');
assert(/--readMem\(calc\(1048576 \+ var\(--__1dacReadIndex\) \* 3 \+ var\(--__1dacReadSubIndex\)\)\)/.test(css),
  'IN 0x3C9 path uses --readMem(calc(0x100000 + readIndex*3 + readSubIndex))');
assert(/IN AL, imm8 \(0x21=picMask, 0x60=kbdPort60, 0x3DA=vgaStatus1, 0x3C7\/8\/9=DAC\)/.test(css),
  'IN AL, imm8 is tagged as routing 0x3C7/8/9 through the DAC path');
assert(/IN AL, 0x3C9: advance DAC read sub-index/.test(css),
  'IN AL, imm8 advances dacReadSubIndex on port 0x3C9');
assert(/IN AL, DX=0x3C9: advance DAC read sub-index/.test(css),
  'IN AL, DX advances dacReadSubIndex on port 0x3C9');
assert(/IN AL, 0x3C9: DAC read cursor auto-advance on wrap/.test(css),
  'IN AL, imm8 bumps dacReadIndex on wrap');
assert(/IN AL, DX=0x3C9: DAC read cursor auto-advance on wrap/.test(css),
  'IN AL, DX bumps dacReadIndex on wrap');

// --- 4. IN AL, 0x3C8 returns dacWriteIndex ---------------------------------
console.log('[check] IN 0x3C8 returns the current write index');
assert(/style\(--q1: 968\): var\(--__1dacWriteIndex\)/.test(css),
  'IN AL, imm8 port 0x3C8 returns --dacWriteIndex');
assert(/style\(--__1DX: 968\): var\(--__1dacWriteIndex\)/.test(css),
  'IN AL, DX port 0x3C8 returns --dacWriteIndex');

// --- 5. IN AL, 0x3C7 returns 0 (DAC state — we don't distinguish) ----------
console.log('[check] IN 0x3C7 returns 0 (ready/unused)');
assert(/style\(--q1: 967\): 0/.test(css),
  'IN AL, imm8 port 0x3C7 returns 0');
assert(/style\(--__1DX: 967\): 0/.test(css),
  'IN AL, DX port 0x3C7 returns 0');

// --- 6. JS state-machine simulation ----------------------------------------
// Mirror the CSS logic in JS and check the touched DAC slot sequence for
// 12 successive IN 0x3C9 reads starting at read-index 5 (reset by OUT
// 0x3C7, AL=5).
console.log('[check] JS-simulated sub-index machine touches DAC slots in order');

const DAC_LINEAR = 0x100000;

// Fake DAC filled with: dac[i*3+0]=i, dac[i*3+1]=i+1, dac[i*3+2]=i+2
// so the values we'd read back are decodable.
const dac = new Uint8Array(768);
for (let i = 0; i < 256; i++) {
  dac[i * 3    ] = (i      ) & 0x3F;
  dac[i * 3 + 1] = (i + 1  ) & 0x3F;
  dac[i * 3 + 2] = (i + 2  ) & 0x3F;
}

function simulate(startIndex, reads) {
  let rIdx = startIndex;   // updated on sub-index wrap (before advancing sub)
  let rSub = 0;            // updated on IN 0x3C9
  const addrs = [];
  const bytes = [];
  for (let i = 0; i < reads; i++) {
    const addr = DAC_LINEAR + rIdx * 3 + rSub;
    addrs.push(addr);
    bytes.push(dac[rIdx * 3 + rSub]);
    // Replicate the CSS logic: the CSS increments dacReadIndex when
    // sub-index was 2 *before* this advance; and increments sub-index
    // 0→1→2 and wraps to 0 on 2.
    if (rSub === 2) { rIdx = (rIdx + 1) & 0xFF; rSub = 0; }
    else            { rSub += 1; }
  }
  return { addrs, bytes };
}

// 12 reads starting at index 5 → touches indices 5,6,7,8.
const { addrs, bytes } = simulate(5, 12);
const expectedIdx = [5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8];
const expectedSub = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2];
let orderOk = true;
for (let i = 0; i < 12; i++) {
  const addr = DAC_LINEAR + expectedIdx[i] * 3 + expectedSub[i];
  if (addrs[i] !== addr) { orderOk = false; break; }
}
assert(orderOk, '12-read sequence from index=5 touches 5R,5G,5B,6R,...,8B');

// Expected bytes for those touches (R=i, G=i+1, B=i+2).
const expectedBytes = [
  5, 6, 7,    // entry 5
  6, 7, 8,    // entry 6
  7, 8, 9,    // entry 7
  8, 9, 10,   // entry 8
];
let bytesOk = true;
for (let i = 0; i < 12; i++) {
  if (bytes[i] !== expectedBytes[i]) { bytesOk = false; break; }
}
assert(bytesOk, '12-read sequence returns the programmed R,G,B triples');

// --- Report ----------------------------------------------------------------
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll DAC read-back checks passed.');

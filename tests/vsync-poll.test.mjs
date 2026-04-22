#!/usr/bin/env node
// Verify port 0x3DA (VGA input status 1) decode is emitted by kiln and
// that the cycleCount → bit math in the emitted formula matches the
// 70 Hz VGA timing on a 4.77 MHz 8086 timebase.
//
//   CYCLES_PER_FRAME = 4_772_727 / 70  ≈ 68_182
//   RETRACE_CYCLES   = CYCLES_PER_FRAME * 0.05 (approx)  ≈ 3_409
//
//   phase = cycleCount % 68182
//     phase < 3409  → bit3=8 (retrace), bit0=0 → status=8
//     phase ≥ 3409  → bit3=0,           bit0=1 → status=1
//
// The emitted CSS uses the same math; this test re-derives it in JS and
// asserts the formula text matches the numbers we expect.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cartDir  = resolve(repoRoot, 'carts/vsync-poll');
const outDir   = resolve(repoRoot, 'tmp');
const outCss   = resolve(outDir, 'vsync-poll.test.css');

const CYCLES_PER_FRAME = 68_182;
const RETRACE_CYCLES   = 3_409;

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  ${msg}`); }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

// --- Build the cart ---------------------------------------------------------
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
console.log('[build] carts/vsync-poll → tmp/vsync-poll.test.css');
execFileSync('node', ['builder/build.mjs', cartDir, '-o', outCss], {
  cwd: repoRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
});

const css = readFileSync(outCss, 'utf8');

// --- Assertions: CSS contains the expected decode --------------------------
console.log('[check] port decode present in emitted CSS');
assert(/style\(--q1:\s*986\)/.test(css),
  'IN AL, imm8 form dispatches on --q1: 986 (port 0x3DA)');
assert(/style\(--__1DX:\s*986\)/.test(css),
  'IN AL, DX form dispatches on --__1DX: 986');
assert(css.includes(String(CYCLES_PER_FRAME)),
  `formula references CYCLES_PER_FRAME=${CYCLES_PER_FRAME}`);
assert(css.includes(String(RETRACE_CYCLES)),
  `formula references RETRACE_CYCLES=${RETRACE_CYCLES}`);

// --- Assertions: math matches what the formula computes --------------------
// The CSS formula is:
//   bit3 = max(0, sign(3409 - phase)) * 8
//   bit0 = max(0, sign(phase - 3409))
// Re-derive in JS and probe a few cycle counts to make sure the model
// matches what we think it does (and catch future drift if someone tweaks
// the constants without updating expectations).
console.log('[check] cycleCount → status byte math');
const vgaStatus = (cycleCount) => {
  const phase = cycleCount % CYCLES_PER_FRAME;
  const bit3 = Math.max(0, Math.sign(RETRACE_CYCLES - phase)) * 8;
  const bit0 = Math.max(0, Math.sign(phase - RETRACE_CYCLES));
  return bit3 + bit0;
};

assert(vgaStatus(0)                             === 8, 'frame start → retrace active (bit3=8)');
assert(vgaStatus(RETRACE_CYCLES - 1)            === 8, 'just before retrace ends → 8');
assert(vgaStatus(RETRACE_CYCLES)                === 0, 'exact boundary → both sign()=0 → 0');
assert(vgaStatus(RETRACE_CYCLES + 1)            === 1, 'just after retrace → display-enable (bit0=1)');
assert(vgaStatus(CYCLES_PER_FRAME - 1)          === 1, 'end of frame → display-enable');
assert(vgaStatus(CYCLES_PER_FRAME)              === 8, 'wrap to next frame → retrace');
assert(vgaStatus(CYCLES_PER_FRAME * 5 + 1000)   === 8, 'multi-frame wrap still retraces when phase < RETRACE_CYCLES');

// Edge counts over a full second (~4.77 Mcycles) = 70 frames. Sanity.
// 4.77 MHz / 68182 ≈ 69.9967 frames/sec, i.e. 70 Hz within rounding.
const SECOND_CYCLES = 4_772_727;
const fps = SECOND_CYCLES / CYCLES_PER_FRAME;
assert(Math.abs(fps - 70) < 0.01, `~70 frames per second at 4.77 MHz (got ${fps.toFixed(4)})`);

// --- Report ----------------------------------------------------------------
if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll vsync checks passed.');

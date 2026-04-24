// baseline.mjs — record + verify golden baselines for a cart.
//
// A baseline is a frozen record of "what this cart's state looks like at
// these specific ticks." Per-cart directory: tests/harness/baselines/<cart>/
//   baseline.json     metadata + tick list
//   tick-N.png        screenshot at tick N
//   tick-N.state.json register + flag snapshot at tick N
//
// Record:
//   await recordBaseline({ cssPath, ticks: [0, 50000, 100000, 500000] })
// Verify:
//   const diffs = await verifyBaseline({ cssPath })
//   diffs === [] means the cart reproduces tick-for-tick
//
// Baselines are how agents answer "did my change break anything?" without
// manually eyeballing screenshots. Any divergence from baseline is
// reported with:
//   - per-tick phash Hamming distance (0 = identical; >4 = visibly different)
//   - register-level register-key-value diff list
//   - text-mode buffer diff (if applicable)

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DebuggerClient } from './debugger-client.mjs';
import { shoot } from './shoot.mjs';
import { timedRun } from './timed-run.mjs';
import { hammingDistance } from './png.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_ROOT = resolve(__dirname, '..', 'baselines');

function cartDirFor(cssPath) {
  return resolve(BASELINES_ROOT, basename(cssPath).replace(/\.css$/, ''));
}

function hashRegs(regs) {
  // Stable hash of the 14-register set (excluding derived CSS-only flags).
  const keys = ['AX','BX','CX','DX','SI','DI','BP','SP','CS','DS','ES','SS','IP','FLAGS'];
  const payload = keys.map(k => `${k}=${regs[k] | 0}`).join(',');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function hashText(text) {
  if (text == null) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Reassemble calcite's composite FLAGS from the individual --_cf etc fields.
function flagsFromCalcite(r) {
  if (typeof r.flags === 'number' && r.flags !== 0) return r.flags;
  return (r._cf ? 1 : 0)
       | 2
       | (r._pf ? (1 << 2) : 0)
       | (r._af ? (1 << 4) : 0)
       | (r._zf ? (1 << 6) : 0)
       | (r._sf ? (1 << 7) : 0)
       | (r._tf ? (1 << 8) : 0)
       | (r._ifFlag ? (1 << 9) : 0)
       | (r._df ? (1 << 10) : 0)
       | (r._of ? (1 << 11) : 0);
}

async function captureAtTick(dbg, tick) {
  await dbg.seek(tick);
  const state = await dbg.state();
  const regs = state.registers ?? {};
  const compactRegs = {
    AX: regs.AX | 0, BX: regs.BX | 0, CX: regs.CX | 0, DX: regs.DX | 0,
    SI: regs.SI | 0, DI: regs.DI | 0, BP: regs.BP | 0, SP: regs.SP | 0,
    CS: regs.CS | 0, DS: regs.DS | 0, ES: regs.ES | 0, SS: regs.SS | 0,
    IP: regs.IP | 0, FLAGS: flagsFromCalcite(regs),
  };
  const shot = await shoot(dbg);
  return {
    tick,
    mode: shot.mode,
    phash: shot.phash,
    textHash: hashText(shot.text ?? null),
    regHash: hashRegs(compactRegs),
    regs: compactRegs,
    text: shot.text ?? null,
    shotKind: shot.kind,
    pngBytes: shot.png,
    paletteFirst16: shot.paletteFirst16 ?? null,
  };
}

export async function recordBaseline({ cssPath, ticks, out = null, session = 'baseline' }) {
  const outDir = out ?? cartDirFor(cssPath);
  mkdirSync(outDir, { recursive: true });
  const dbg = await DebuggerClient.spawnChild({ cssPath, session });
  try {
    const captures = [];
    for (const t of ticks) {
      const c = await captureAtTick(dbg, t);
      captures.push(c);
      if (c.pngBytes) writeFileSync(resolve(outDir, `tick-${t}.png`), c.pngBytes);
      writeFileSync(resolve(outDir, `tick-${t}.state.json`), JSON.stringify({
        tick: t, mode: c.mode, regs: c.regs, text: c.text,
      }, null, 2));
    }
    const manifest = {
      recordedAt: new Date().toISOString(),
      cabinet: resolve(cssPath),
      ticks: captures.map(c => ({
        tick: c.tick,
        mode: c.mode,
        phash: c.phash,
        textHash: c.textHash,
        regHash: c.regHash,
        shotKind: c.shotKind,
      })),
    };
    writeFileSync(resolve(outDir, 'baseline.json'), JSON.stringify(manifest, null, 2));
    return { outDir, manifest };
  } finally {
    await dbg.close();
  }
}

export async function verifyBaseline({ cssPath, dir = null, maxPhashDistance = 4, session = 'baseline-verify' }) {
  const baseDir = dir ?? cartDirFor(cssPath);
  const manifestPath = resolve(baseDir, 'baseline.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`no baseline at ${manifestPath} — record one first with recordBaseline()`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dbg = await DebuggerClient.spawnChild({ cssPath, session });
  try {
    const results = [];
    for (const entry of manifest.ticks) {
      const c = await captureAtTick(dbg, entry.tick);
      const phashDiff = (c.phash && entry.phash) ? hammingDistance(c.phash, entry.phash) : null;
      const r = {
        tick: entry.tick,
        mode: { expected: entry.mode, actual: c.mode, match: entry.mode === c.mode },
        phash: { expected: entry.phash, actual: c.phash, distance: phashDiff, match: phashDiff !== null && phashDiff <= maxPhashDistance },
        regHash: { expected: entry.regHash, actual: c.regHash, match: entry.regHash === c.regHash },
        textHash: { expected: entry.textHash, actual: c.textHash, match: entry.textHash === c.textHash },
      };
      r.anyFail = !r.mode.match || !r.phash.match || !r.regHash.match || !r.textHash.match;
      // Include actual regs when failed, so agents can see what changed.
      if (r.anyFail) {
        r.regs = c.regs;
        // Also include expected regs — read from the tick-N.state.json sidecar.
        const side = resolve(baseDir, `tick-${entry.tick}.state.json`);
        if (existsSync(side)) {
          try { r.expectedRegs = JSON.parse(readFileSync(side, 'utf8')).regs; } catch { /* ignore */ }
        }
      }
      results.push(r);
    }
    return { manifest, results, ok: results.every(r => !r.anyFail) };
  } finally {
    await dbg.close();
  }
}

// Opinionated helper: record a baseline by first running the cart to
// "program entered" (or a given tick list) so the captured state includes
// actual running-program milestones rather than just boot-BIOS chatter.
export async function recordCartMilestones({ cssPath, milestones = null, wallMs = 120_000, session = 'baseline-rec' }) {
  // Sensible defaults: tick 0 (boot), +50k (BIOS phase), +100k (kernel load),
  // +500k (should be running program by now for small carts).
  const defaultMilestones = [0, 50_000, 100_000, 500_000];
  const ticks = milestones ?? defaultMilestones;
  return recordBaseline({ cssPath, ticks, session });
}

#!/usr/bin/env node
// Find first divergence between ref-machine and calcite-cli, fast.
//
// Both engines run the same cabinet. Ref runs in-process via js8086 (~2M
// instr/s). Calcite runs as a child process with `--dump-ticks` listing
// the sample points; output reports ALL standard regs at each tick. We
// align tick numbers and bisect to the first instruction where any reg
// differs.
//
// Note: calcite-cli reports state at "tick N" = after N CSS evaluations.
// Ref reports after N x86 instructions. Both engines treat REP as one tick
// (per the V4 calcite contract), so tick N == instr N as long as no IRQ
// inserts a frame outside the 1:1 mapping. This tool checks the mapping.
//
// Usage: node tests/harness/diverge.mjs <cabinet>.css [--from=N] [--to=N] [--step=N]

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadCabinetSidecars, createRefMachine } from './lib/ref-machine.mjs';

const args = process.argv.slice(2);
const cssPath = args.find(a => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const eq = a.indexOf('=');
  return eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), true];
}));
if (!cssPath) {
  console.error('usage: diverge.mjs <cabinet>.css [--from=N] [--to=N] [--step=N]');
  process.exit(2);
}
const from = parseInt(flags.from ?? '0', 10);
const to = parseInt(flags.to ?? '500000', 10);
const step = parseInt(flags.step ?? '50000', 10);

const sc = loadCabinetSidecars(cssPath);
const ref = createRefMachine(sc, {
  initialCS: sc.meta.bios.entrySegment,
  initialIP: sc.meta.bios.entryOffset,
});

// Build the list of sample ticks.
const samples = [];
for (let t = Math.max(from, step); t <= to; t += step) samples.push(t);

// Run calcite first (slow path: spawn child with --dump-ticks).
const calciteRepo = process.env.CALCITE_REPO
  ? resolve(process.env.CALCITE_REPO)
  : resolve(process.cwd(), '..', 'calcite');
const calciteCli = resolve(calciteRepo, 'target', 'release', 'calcite-cli.exe');
const dumpTicksArg = samples.join(',');
process.stderr.write(`[diverge] spawning calcite-cli for ${samples.length} samples (${samples[0]}..${samples[samples.length-1]})\n`);
const calcStart = performance.now();
const calc = await new Promise((resolveProm, rejectProm) => {
  const p = spawn(calciteCli, [
    '-i', cssPath,
    '--dump-ticks', dumpTicksArg,
    '--speed', '0',
    '--screen-interval', '0',
    '--sample-cells=0',
  ]);
  let out = '';
  p.stdout.on('data', d => { out += d.toString(); });
  p.on('close', code => {
    if (code !== 0 && code !== null) rejectProm(new Error(`calcite-cli exited ${code}`));
    else resolveProm(out);
  });
});
process.stderr.write(`[diverge] calcite done in ${((performance.now()-calcStart)/1000).toFixed(1)}s\n`);

// Parse calcite output. Each sample line is:
// tick AX CX DX BX SP BP SI DI IP CS DS ES SS flags cycleCount mc0...
const calcRows = new Map();
for (const line of calc.split('\n')) {
  const m = line.match(/^(\d+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+) ([\d-]+)/);
  if (m) {
    // CLI column order: AX BX CX DX SP BP SI DI IP CS DS ES SS flags cycleCount
    calcRows.set(parseInt(m[1], 10), {
      AX: +m[2], BX: +m[3], CX: +m[4], DX: +m[5], SP: +m[6], BP: +m[7], SI: +m[8], DI: +m[9],
      IP: +m[10], CS: +m[11], DS: +m[12], ES: +m[13], SS: +m[14], flags: +m[15],
    });
  }
}
process.stderr.write(`[diverge] parsed ${calcRows.size} calcite rows\n`);

// Run ref to each sample point and compare.
const refStart = performance.now();
let last = 0;
let firstMismatch = null;
const summary = [];
for (const tick of samples) {
  while (last < tick) { ref.step(); last++; }
  const r = ref.regs();
  const c = calcRows.get(tick);
  if (!c) {
    process.stderr.write(`[diverge] MISSING calcite row for tick ${tick}\n`);
    continue;
  }
  const diffs = [];
  // ref uses FLAGS (uppercase), calcite uses flags (lowercase) — normalise.
  const refNorm = { ...r, flags: r.FLAGS };
  for (const k of ['AX','CX','DX','BX','SP','BP','SI','DI','IP','CS','DS','ES','SS','flags']) {
    if ((refNorm[k] & 0xFFFF) !== (c[k] & 0xFFFF)) diffs.push(k);
  }
  summary.push({ tick, diffs: diffs.length, regs: diffs.length ? { ref: r, calc: c, diffs } : null });
  if (diffs.length && !firstMismatch) firstMismatch = tick;
}
process.stderr.write(`[diverge] ref done in ${((performance.now()-refStart)/1000).toFixed(1)}s\n`);

console.log(JSON.stringify({
  ok: true,
  cabinet: cssPath,
  samples: summary.map(s => ({ tick: s.tick, mismatchedRegs: s.diffs })),
  firstMismatch,
  detail: summary.find(s => s.tick === firstMismatch)?.regs ?? null,
}, null, 2));

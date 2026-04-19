#!/usr/bin/env node
// Benchmark runner. For each scenario:
//   1. Assemble cart .asm -> .com if present + newer than .com
//   2. Build cabinet via builder/build.mjs
//   3. Invoke calcite-bench with fixed flags
//   4. Parse output, append row to bench/results.md
//
// Usage:
//   node bench/run.mjs                     # run all scenarios
//   node bench/run.mjs rogue int-heavy     # subset by name
//   node bench/run.mjs --note "pre-gating" # label this run in results.md

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CALCITE = resolve(REPO, '..', 'calcite');
const NASM = process.env.NASM || 'C:\\Users\\AdmT9N0CX01V65438A\\AppData\\Local\\bin\\NASM\\nasm.exe';
const RESULTS_FILE = resolve(__dirname, 'results.md');
const BUILD_DIR = resolve(__dirname, 'build');

// ---- Scenarios ----
// Each scenario has:
//   name:         short id, used on CLI and in results.md
//   cart:         folder to feed to builder/build.mjs (absolute or repo-relative)
//   benchArgs:    flags to pass to calcite-bench after `-i <cabinet>`
//   note:         description
const SCENARIOS = [
  {
    name: 'rogue-menu-idle',
    cart: 'bench/carts/rogue',
    // Per user: rogue reaches menu-idle at roughly 1M ticks.
    // Measurement window 50k is short enough to stay inside the idle loop.
    benchArgs: ['-n', '50000', '--warmup', '1000000'],
    note: 'Rogue, idle at main menu (post-boot steady state)',
  },
  {
    name: 'int-heavy',
    cart: 'bench/carts/int-heavy',
    benchArgs: ['-n', '100000', '--warmup', '1000'],
    note: 'Tight INT 1Ah AH=1 loop. Stresses the 6-byte INT push path.',
  },
  {
    name: 'mov-heavy',
    cart: 'bench/carts/mov-heavy',
    benchArgs: ['-n', '100000', '--warmup', '1000'],
    note: 'Tight reg-reg MOV loop. Control — should be unaffected by slot gating.',
  },
];

// ---- CLI parsing ----
const args = process.argv.slice(2);
let runNote = '';
const wanted = new Set();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--note') { runNote = args[++i] || ''; continue; }
  wanted.add(args[i]);
}

// ---- Helpers ----
function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
  } catch (e) {
    console.error(`FAILED: ${cmd}`);
    if (e.stdout) console.error('stdout:', e.stdout);
    if (e.stderr) console.error('stderr:', e.stderr);
    throw e;
  }
}

function mtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

function assembleCarts(cartDir) {
  // If the cart has a .asm whose matching .com is missing or stale, NASM it.
  // Only touches files at the top of the cart folder.
  const entries = sh(`dir /b "${cartDir}"`, { shell: 'cmd.exe' }).trim().split(/\r?\n/);
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.asm')) continue;
    const asm = join(cartDir, f);
    const com = asm.replace(/\.asm$/i, '.com');
    if (mtime(asm) > mtime(com)) {
      console.log(`  nasm ${f}`);
      sh(`"${NASM}" -f bin -o "${com}" "${asm}"`);
    }
  }
}

function buildCabinet(scenario) {
  const cartDir = resolve(REPO, scenario.cart);
  if (!existsSync(cartDir)) {
    if (scenario.optional) { console.log(`  [skip] cart missing: ${cartDir}`); return null; }
    throw new Error(`Cart not found: ${cartDir}`);
  }
  assembleCarts(cartDir);
  mkdirSync(BUILD_DIR, { recursive: true });
  const cabinet = join(BUILD_DIR, `${scenario.name}.css`);
  console.log(`  build ${scenario.cart} -> ${cabinet}`);
  sh(`node "${resolve(REPO, 'builder', 'build.mjs')}" "${cartDir}" -o "${cabinet}"`);
  return cabinet;
}

function runBench(cabinet, benchArgs) {
  const args = ['run', '--release', '--quiet', '--bin', 'calcite-bench', '--',
                '-i', cabinet, ...benchArgs];
  console.log(`  bench ${benchArgs.join(' ')}`);
  const res = spawnSync('cargo', args, { cwd: CALCITE, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error('stdout:', res.stdout);
    console.error('stderr:', res.stderr);
    throw new Error(`calcite-bench exited ${res.status}`);
  }
  return res.stdout;
}

function parseBench(out) {
  // calcite-bench prints a single pipe-separated summary line, e.g.:
  //   10000 ticks | 27922 cycles | 1.09 MHz (22.9% of 4.77 MHz) | 390718 ticks/s | 2.6us/tick
  // plus an optional --halt line before it. Grab the summary and tear it apart.
  const line = out.split(/\r?\n/).find(l => / ticks\/s /.test(l)) || '';
  const get = (re) => { const m = line.match(re); return m ? m[1] : null; };
  return {
    ticks: get(/^\s*(\d+)\s+ticks/),
    cycles: get(/\|\s*(\d+)\s+cycles/),
    mhz: get(/\|\s*([\d.]+)\s+MHz/),
    pctOf8086: get(/\(([\d.]+)%\s+of/),
    ticksPerSec: get(/\|\s*(\d+)\s+ticks\/s/),
    usPerTick: get(/\|\s*([\d.]+)us\/tick/),
  };
}

function gitInfo() {
  const hash = sh('git rev-parse --short HEAD').trim();
  const dirty = sh('git status --porcelain').trim().length > 0 ? '-dirty' : '';
  return hash + dirty;
}

function fileSize(p) {
  try {
    const bytes = statSync(p).size;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  } catch { return '?'; }
}

function appendResults(rows) {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const commit = gitInfo();
  const header = existsSync(RESULTS_FILE)
    ? ''
    : '# Benchmark results\n\n' +
      'Append-only log. Each run appends a block; rows are individual scenarios.\n' +
      'Compare by eye: find the commit before your change, find the commit after, diff the numbers.\n\n';
  let block = `## ${ts} — ${commit}`;
  if (runNote) block += ` — ${runNote}`;
  block += '\n\n';
  block += '| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |\n';
  block += '|---|---|---|---|---|---|\n';
  for (const r of rows) {
    const mhz = r.mhz ? `${r.mhz} (${r.pctOf8086 ?? '?'}%)` : '?';
    block += `| ${r.scenario} | ${r.ticks ?? '?'} | ${r.ticksPerSec ?? '?'} | ${r.usPerTick ?? '?'} | ${mhz} | ${r.cabinetSize ?? '?'} |\n`;
  }
  block += '\n';
  if (header) writeFileSync(RESULTS_FILE, header);
  appendFileSync(RESULTS_FILE, block);
  console.log(`\nAppended to ${RESULTS_FILE}`);
}

// ---- Main ----
console.log(`Bench run — ${gitInfo()}${runNote ? ` — ${runNote}` : ''}`);

const rows = [];
for (const scenario of SCENARIOS) {
  if (wanted.size && !wanted.has(scenario.name)) continue;
  console.log(`\n[${scenario.name}]`);
  const cabinet = buildCabinet(scenario);
  if (!cabinet) continue;
  const out = runBench(cabinet, scenario.benchArgs);
  const parsed = parseBench(out);
  console.log(`  -> ticks/s=${parsed.ticksPerSec}  us/tick=${parsed.usPerTick}`);
  rows.push({ scenario: scenario.name, cabinetSize: fileSize(cabinet), ...parsed });
}

if (rows.length === 0) {
  console.log('No scenarios ran.');
  process.exit(1);
}

appendResults(rows);

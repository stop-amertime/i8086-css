#!/usr/bin/env node
// run.mjs — agent-facing preset test runner.
//
// Every preset is a short spec of "what to run, what to compare, what
// passes." The runner prints a compact summary to stderr and writes a
// detailed JSON report to tests/harness/results/<timestamp>.json (plus
// updates a `latest.json` symlink for easy-to-find recent results).
//
// Presets:
//
//   smoke       Fast check all reference carts: build each, run 30s, verify
//               the cabinet reaches mode 13 or a known boot milestone.
//   conformance Run fulldiff on every cart for 5000 instructions; pass =
//               no divergence. This is the "is calcite honest?" test.
//   visual      Record or verify per-cart screenshot baselines.
//   bisect      Given two cabinets, cabinet-diff them at sample ticks.
//   full        smoke + conformance + visual in sequence.
//
// Exit codes:
//   0 — all tests passed
//   1 — harness error (daemon wouldn't start, cabinet missing)
//   2 — test failures (divergence / baseline mismatch)
//
// Agents: parse the JSON report at tests/harness/results/latest.json to
// see what passed/failed. Grep exit code for quick yes/no.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, symlinkSync, unlinkSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(__dirname);
const REPO_ROOT = resolve(__dirname, '..', '..');

const USAGE = `run.mjs — CSS-DOS test preset runner

Usage:
  node tests/harness/run.mjs <preset> [flags...]

Presets:
  smoke         Build + run every reference cart (15s each), assert it reaches
                some tick count. Fastest, widest coverage.
  conformance   Run fulldiff on every reference cart for --max-ticks=N
                instructions. Pass = no divergence against JS reference.
  visual        --mode=verify: check each cart's screenshots against a
                recorded baseline. --mode=record: create new baselines.
  full          smoke + conformance + visual(verify), in sequence.

Flags:
  --max-ticks=N   conformance: instructions to diff per cart (default 5000)
  --mode=verify|record   visual: use recorded baselines or overwrite them

Output:
  - Compact pass/fail summary on stderr.
  - Full JSON report at tests/harness/results/<preset>-<timestamp>.json
    and a mirror at tests/harness/results/latest.json.
  - Exit code 0 on pass, 2 on test failure, 1 on harness error.
`;

const argv = process.argv.slice(2);
const preset = argv[0];
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? true;
  } else positional.push(a);
}

if (!preset || preset === '--help' || preset === '-h') {
  process.stderr.write(USAGE);
  process.exit(preset ? 0 : 2);
}

function log(msg) { process.stderr.write(`[run] ${msg}\n`); }

// Spawn a child and collect its single-line JSON result from stdout.
// Rejects on exit code ≠ 0 AND no valid JSON — accepts the "ok:false"
// JSON result (exit code 3 from pipeline) as a normal test-failure.
function runPipeline(subcommand, ...rest) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      join(HARNESS_ROOT, 'pipeline.mjs'),
      subcommand, ...rest,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => {
      // Pick the last JSON line from stdout — pipeline.mjs is supposed
      // to emit exactly one but be defensive.
      const lines = out.trim().split('\n').filter(Boolean);
      const last = lines.at(-1) ?? '';
      let parsed = null;
      try { parsed = JSON.parse(last); } catch { /* ignore */ }
      if (parsed == null) {
        reject(new Error(`pipeline ${subcommand} produced no JSON: exit=${code}\nstderr: ${err.slice(-400)}`));
        return;
      }
      resolvePromise({ exitCode: code, result: parsed, stderr: err });
    });
    child.on('error', reject);
  });
}

// Cart paths we can smoke-test. Only carts that actually exist in carts/.
const REFERENCE_CARTS = [
  'carts/dos-smoke',
  'carts/hello-text',
  'carts/cga4-stripes',
  'carts/cga5-mono',
  'carts/cga6-hires',
  'carts/zork1',
  'carts/montezuma',
];

function existingCarts(list) {
  // --only=name1,name2 restricts to the named basenames.
  const only = flags.only ? new Set(flags.only.split(',')) : null;
  return list
    .filter(c => existsSync(resolve(REPO_ROOT, c)))
    .filter(c => only == null || only.has(basename(c)));
}

// --- smoke preset -------------------------------------------------------

async function runSmoke() {
  const carts = existingCarts(REFERENCE_CARTS);
  log(`smoke: ${carts.length} carts`);
  const results = [];
  for (const cart of carts) {
    const cartName = basename(cart);
    log(`  ${cartName}...`);
    const out = join(HARNESS_ROOT, 'cache', `${cartName}.css`);
    try {
      const build = await runPipeline('build', cart, `--out=${out}`);
      if (!build.result.ok) {
        results.push({ cart, ok: false, stage: 'build', error: build.result.error });
        continue;
      }
      const run = await runPipeline('run', out, '--wall-ms=15000', '--max-ticks=150000');
      results.push({
        cart,
        ok: build.result.ok && run.result.ok,
        buildMs: build.result.buildMs,
        runTicks: run.result.run?.endTick ?? 0,
        runReason: run.result.run?.reason ?? null,
      });
    } catch (err) {
      results.push({ cart, ok: false, error: String(err?.message ?? err) });
    }
  }
  return { preset: 'smoke', carts: results, allOk: results.every(r => r.ok) };
}

// --- conformance preset -------------------------------------------------

async function runConformance() {
  const carts = existingCarts(REFERENCE_CARTS);
  log(`conformance: fulldiff on ${carts.length} carts`);
  const maxTicks = Number.parseInt(flags['max-ticks'] ?? '5000', 10);
  const results = [];
  for (const cart of carts) {
    const cartName = basename(cart);
    log(`  ${cartName}...`);
    const cabinet = join(HARNESS_ROOT, 'cache', `${cartName}.css`);
    if (!existsSync(cabinet)) {
      log(`    (building cabinet first)`);
      const b = await runPipeline('build', cart, `--out=${cabinet}`);
      if (!b.result.ok) {
        results.push({ cart, ok: false, stage: 'build', error: b.result.error });
        continue;
      }
    }
    try {
      const r = await runPipeline('fulldiff', cabinet, `--max-ticks=${maxTicks}`);
      // The fulldiff script has its own JSON format.
      const res = r.result;
      const divergedAt = res.divergedAt ?? null;
      results.push({
        cart,
        ok: divergedAt == null,
        ticksChecked: res.instrChecked,
        wallMs: res.wallMs,
        divergedAt,
        firstDiff: res.divergences?.[0] ?? null,
      });
    } catch (err) {
      results.push({ cart, ok: false, error: String(err?.message ?? err) });
    }
  }
  return { preset: 'conformance', carts: results, allOk: results.every(r => r.ok) };
}

// --- visual preset ------------------------------------------------------

async function runVisual() {
  const mode = flags.mode ?? 'verify';
  if (mode !== 'verify' && mode !== 'record') {
    throw new Error(`visual: --mode must be 'verify' or 'record' (got '${mode}')`);
  }
  const carts = existingCarts(REFERENCE_CARTS);
  log(`visual (${mode}): ${carts.length} carts`);
  const results = [];
  for (const cart of carts) {
    const cartName = basename(cart);
    log(`  ${cartName}...`);
    const cabinet = join(HARNESS_ROOT, 'cache', `${cartName}.css`);
    if (!existsSync(cabinet)) {
      const b = await runPipeline('build', cart, `--out=${cabinet}`);
      if (!b.result.ok) {
        results.push({ cart, ok: false, stage: 'build', error: b.result.error });
        continue;
      }
    }
    const sub = mode === 'record' ? 'baseline-record' : 'baseline-verify';
    try {
      const r = await runPipeline(sub, cabinet);
      results.push({ cart, ok: r.result.ok, verdict: r.result });
    } catch (err) {
      results.push({ cart, ok: false, error: String(err?.message ?? err) });
    }
  }
  return { preset: 'visual', mode, carts: results, allOk: results.every(r => r.ok) };
}

// --- full preset --------------------------------------------------------

async function runFull() {
  const smoke = await runSmoke();
  const conf = await runConformance();
  const visual = await runVisual();
  return { preset: 'full', smoke, conformance: conf, visual, allOk: smoke.allOk && conf.allOk && visual.allOk };
}

// --- Report writer ------------------------------------------------------

function writeReport(report) {
  const resultsDir = join(HARNESS_ROOT, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(resultsDir, `${report.preset}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  // "latest" is a copy not a symlink — Windows often forbids symlinks
  // without admin privileges, and agents need predictable read.
  const latest = join(resultsDir, 'latest.json');
  try { copyFileSync(path, latest); } catch { /* non-fatal */ }
  return path;
}

// --- Main ---------------------------------------------------------------

async function main() {
  const t0 = performance.now();
  let report;
  try {
    switch (preset) {
      case 'smoke':        report = await runSmoke();        break;
      case 'conformance':  report = await runConformance();  break;
      case 'visual':       report = await runVisual();       break;
      case 'full':         report = await runFull();         break;
      default:
        process.stderr.write(`unknown preset: ${preset}\n${USAGE}`);
        process.exit(2);
    }
  } catch (err) {
    const errReport = { preset, allOk: false, error: String(err?.message ?? err), stack: err?.stack };
    writeReport(errReport);
    process.stderr.write(`[run] FATAL: ${err?.message ?? err}\n`);
    process.exit(1);
  }
  report.wallMs = Math.round(performance.now() - t0);
  const path = writeReport(report);
  log(`wrote ${path}`);

  // Compact stderr summary.
  summarise(report);
  process.exit(report.allOk ? 0 : 2);
}

function summarise(report) {
  const line = (msg) => process.stderr.write(msg + '\n');
  line('');
  line(`=== ${report.preset}: ${report.allOk ? 'PASS' : 'FAIL'} (${report.wallMs} ms) ===`);
  const printCarts = (carts, label) => {
    if (!carts || !carts.length) return;
    line(`${label}:`);
    for (const c of carts) {
      const name = basename(c.cart ?? '');
      const status = c.ok ? 'PASS' : 'FAIL';
      let detail = '';
      if (c.buildMs) detail += ` build=${c.buildMs}ms`;
      if (c.runTicks != null) detail += ` ticks=${c.runTicks}`;
      if (c.divergedAt != null) detail += ` diverged@${c.divergedAt}`;
      if (c.error) detail += ` error="${c.error.slice(0, 80)}"`;
      line(`  [${status}] ${name}${detail}`);
    }
  };
  if (report.preset === 'full') {
    printCarts(report.smoke?.carts, 'smoke');
    printCarts(report.conformance?.carts, 'conformance');
    printCarts(report.visual?.carts, 'visual');
  } else {
    printCarts(report.carts, report.preset);
  }
}

main();

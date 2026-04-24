#!/usr/bin/env node
// pipeline.mjs — single unified entrypoint for the agentic test harness.
//
// Subcommands:
//
//   build <cart>            Build a cart → cabinet, with timing. Emits sidecar
//                           .bios.bin / .disk.bin / .kernel.bin / .meta.json
//                           alongside the .css.
//
//   load <cabinet>          Open a cabinet in the running calcite-debugger.
//                           Requires the debugger daemon to be up (see the
//                           daemon start instructions below). Prints parse +
//                           compile timings.
//
//   run <cabinet> [opts]    Load and run. Budgets: --wall-ms, --max-ticks,
//                           --stall-rate, --until-cs, --until-tick. Prints
//                           final state + reason for stopping.
//
//   shoot <cabinet> [opts]  Load, optionally run to tick N, take a screenshot.
//                           Writes PNG to --out or prints path.
//
//   diff <cabinet> [opts]   Load and compare-paths (compiled vs interpreted)
//                           at a tick. Quick "is calcite self-consistent?" test.
//
//   full <cart>             build → load → run-to-entry → shoot → report.
//                           The all-in-one "does this cart work?" command.
//
//   inspect <cabinet>       Print the harness header meta block. No daemon.
//
// Every subcommand prints two things:
//   1. Human-readable progress lines to stderr.
//   2. A structured JSON result to stdout, one line, on exit.
//
// So `... pipeline.mjs run foo.css | jq .reason` works cleanly.
// stdout is reserved for the result JSON; nothing else writes to it.
//
// Timing: every subcommand measures wall-clock end-to-end + per-phase
// breakdowns. Agents can read the JSON and see where time went instead of
// guessing.
//
// Failure: subcommands exit non-zero on any error. The stdout JSON still
// parses — it has `{ok: false, error: "..."}` — so automation doesn't crash
// trying to parse a half-dump.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { DebuggerClient } from './lib/debugger-client.mjs';
import { readCabinetFromPath, readCabinetMeta, normalizeMeta } from './lib/cabinet-header.mjs';
import { timedRun, predicates } from './lib/timed-run.mjs';
import { shoot } from './lib/shoot.mjs';
import { recordBaseline, verifyBaseline } from './lib/baseline.mjs';
import { triageDivergence, runCompareAtTick } from './lib/oracles.mjs';
import { cabinetDiff } from './lib/cabinet-diff.mjs';
import { runScript, loadScriptFromFile } from './lib/script-runner.mjs';
import { computeCoverage } from './lib/coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(__dirname);
const REPO_ROOT = resolve(__dirname, '..', '..');

function log(msg) { process.stderr.write(`[pipeline] ${msg}\n`); }

function die(code, result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(code);
}

function ok(result) {
  die(0, { ok: true, ...result });
}

function fail(error, extra = {}) {
  die(1, { ok: false, error: String(error?.message ?? error), ...extra });
}

// Parse --key=value and --key value args. Positional args are collected
// in `.args` in order.
function parseArgs(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function flagInt(flags, name, defaultValue) {
  if (flags[name] == null) return defaultValue;
  const n = Number.parseInt(flags[name], 10);
  if (!Number.isFinite(n)) throw new Error(`--${name}: not a number (${flags[name]})`);
  return n;
}

function flagFloat(flags, name, defaultValue) {
  if (flags[name] == null) return defaultValue;
  const n = Number.parseFloat(flags[name]);
  if (!Number.isFinite(n)) throw new Error(`--${name}: not a number (${flags[name]})`);
  return n;
}

// --- Subcommand: build --------------------------------------------------

async function cmdBuild({ args, flags }) {
  const [cartPath] = args;
  if (!cartPath) fail('build: cart path required');
  const outPath = flags.out ?? join(HARNESS_ROOT, 'cache', `${basename(cartPath)}.css`);
  mkdirSync(dirname(outPath), { recursive: true });

  const t0 = performance.now();
  log(`build ${cartPath} -> ${outPath}`);
  const child = spawn(process.execPath, [
    resolve(REPO_ROOT, 'builder', 'build.mjs'),
    cartPath,
    '-o', outPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const stdoutLines = [];
  const stderrLines = [];
  child.stdout.on('data', d => { const s = d.toString(); stdoutLines.push(s); if (flags.verbose) process.stderr.write(s); });
  child.stderr.on('data', d => { const s = d.toString(); stderrLines.push(s); if (flags.verbose) process.stderr.write(s); });

  const code = await new Promise(r => child.on('close', r));
  const buildMs = performance.now() - t0;

  if (code !== 0) {
    return fail(`build failed with exit code ${code}`, {
      stdout: stdoutLines.join(''),
      stderr: stderrLines.join(''),
      buildMs,
    });
  }

  const size = statSync(outPath).size;
  const meta = readCabinetMeta(outPath);
  ok({
    cabinet: outPath,
    buildMs: Math.round(buildMs),
    cabinetBytes: size,
    meta,
  });
}

// --- Subcommand: inspect ------------------------------------------------

async function cmdInspect({ args }) {
  const [cssPath] = args;
  if (!cssPath) fail('inspect: cabinet path required');
  const r = readCabinetFromPath(cssPath);
  ok({ meta: r.meta, normalized: r.normalized });
}

// --- Subcommand: load ---------------------------------------------------

// How the harness acquires a DebuggerClient:
//   - Default: spawn a child `calcite-debugger -i <css> --session <s>`.
//     Self-contained; child dies with the harness. Best for one-shot
//     tests so there's never an orphan daemon after a failed run.
//   - --daemon flag: connect to an already-running daemon on --port.
//     Reuses its state, faster when you're iterating. Harness does NOT
//     close the daemon on exit.
//
// The --session name defaults to the cabinet basename so successive
// `run` calls against the same cabinet target the same server-side
// session (with --daemon) or don't interfere (with a fresh child).
async function acquireDebugger({ cssPath, flags, requireCabinet = true }) {
  const useDaemon = !!flags.daemon;
  const session = flags.session ?? (cssPath ? basename(cssPath).replace(/\.css$/, '') : `pipeline-${Date.now()}`);

  if (useDaemon) {
    const port = flagInt(flags, 'port', null);
    if (port == null) throw new Error('--daemon requires --port');
    const dbg = await DebuggerClient.connectTcp({ host: flags.host ?? '127.0.0.1', port, session });
    // Verify the session exists on the daemon, or open it.
    if (cssPath) {
      const info = await dbg.info();
      const existing = info?.sessions?.[session];
      const absPath = resolve(cssPath);
      if (!existing) {
        log(`opening session ${session} on daemon with ${absPath}`);
        await dbg.open(absPath, session);
      } else if (existing.css_file && resolve(existing.css_file) !== absPath) {
        log(`reopening session ${session} (current: ${existing.css_file}, requested: ${absPath})`);
        await dbg.open(absPath, session);
      }
    }
    return dbg;
  }

  if (requireCabinet && !cssPath) throw new Error('cabinet path required (or use --daemon + --session to reuse an existing session)');
  return DebuggerClient.spawnChild({ cssPath: cssPath ? resolve(cssPath) : null, session });
}

async function cmdLoad({ args, flags }) {
  const [cssPath] = args;
  if (!cssPath) fail('load: cabinet path required');
  const t0 = performance.now();
  const dbg = await acquireDebugger({ cssPath, flags });
  try {
    const info = await dbg.info();
    const ms = performance.now() - t0;
    ok({ cabinet: resolve(cssPath), session: dbg.session, loadMs: Math.round(ms), info });
  } finally {
    await dbg.close();
  }
}

// --- Subcommand: run ----------------------------------------------------

function predicateFromFlags(flags) {
  if (flags['until-cs'] != null) {
    const cs = parseInt(flags['until-cs'], flags['until-cs'].toString().startsWith('0x') ? 16 : 10);
    return predicates.csEquals(cs);
  }
  if (flags['until-tick'] != null) {
    return predicates.afterTick(flagInt(flags, 'until-tick'));
  }
  if (flags['until-program-entered']) {
    return predicates.programEntered;
  }
  return null;
}

async function cmdRun({ args, flags }) {
  const [cssPath] = args;
  const dbg = await acquireDebugger({ cssPath, flags });
  try {
    const result = await timedRun(dbg, {
      wallMs: flagInt(flags, 'wall-ms', 30_000),
      maxTicks: flagInt(flags, 'max-ticks', 10_000_000),
      stallTicksPerSec: flagFloat(flags, 'stall-rate', null),
      stallSeconds: flagInt(flags, 'stall-seconds', 5),
      chunkTicks: flagInt(flags, 'chunk-ticks', 5000),
      predicate: predicateFromFlags(flags),
      onProgress: ({ elapsedMs, tick, ticksPerSec }) => {
        log(`t=${(elapsedMs / 1000).toFixed(1)}s tick=${tick} rate=${ticksPerSec.toFixed(0)}/s`);
      },
    });
    ok({ run: result });
  } finally {
    await dbg.close();
  }
}

// --- Subcommand: shoot --------------------------------------------------

async function cmdShoot({ args, flags }) {
  const [cssPath] = args;
  const dbg = await acquireDebugger({ cssPath, flags });
  try {
    if (flags.tick != null) await dbg.seek(flagInt(flags, 'tick'));

    const shot = await shoot(dbg, {
      mode: flags.mode != null ? parseInt(flags.mode, flags.mode.toString().startsWith('0x') ? 16 : 10) : null,
    });

    const outPath = flags.out ?? join(HARNESS_ROOT, 'results', `shot-${Date.now()}.png`);
    if (shot.png) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, shot.png);
    }

    const { rgba: _rgba, png: _png, ...light } = shot;
    ok({ shot: { ...light, outPath: shot.png ? outPath : null } });
  } finally {
    await dbg.close();
  }
}

// --- Subcommand: diff ---------------------------------------------------

async function cmdDiff({ args, flags }) {
  const [cssPath] = args;
  const dbg = await acquireDebugger({ cssPath, flags });
  try {
    if (flags.tick != null) await dbg.seek(flagInt(flags, 'tick'));
    const diff = await dbg.comparePaths();
    ok({ diff });
  } finally {
    await dbg.close();
  }
}

// --- Subcommand: full ---------------------------------------------------

async function cmdFull({ args, flags }) {
  const [cartPath] = args;
  if (!cartPath) fail('full: cart path required');
  const session = flags.session ?? `full-${basename(cartPath)}`;
  const outDir = flags.out ?? join(HARNESS_ROOT, 'results', `${session}-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });

  const cssPath = join(outDir, `${basename(cartPath)}.css`);

  // Phase 1: build.
  log(`[1/4] build ${cartPath}`);
  const t0 = performance.now();
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, [
      resolve(REPO_ROOT, 'builder', 'build.mjs'),
      cartPath, '-o', cssPath,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', c => c === 0 ? res() : rej(new Error(`build exit ${c}`)));
  });
  const buildMs = performance.now() - t0;

  // Phase 2-4: own a child debugger. For `full` we always use a fresh
  // child — it's the "one-shot check, nothing left behind" command.
  log(`[2/4] load ${cssPath}`);
  const t1 = performance.now();
  const dbg = await DebuggerClient.spawnChild({ cssPath, session });
  const loadMs = performance.now() - t1;

  try {
    log(`[3/4] run to program entry`);
    const run = await timedRun(dbg, {
      wallMs: flagInt(flags, 'wall-ms', 60_000),
      maxTicks: flagInt(flags, 'max-ticks', 30_000_000),
      predicate: predicates.programEntered,
      onProgress: ({ elapsedMs, tick, ticksPerSec }) => {
        log(`  t=${(elapsedMs / 1000).toFixed(1)}s tick=${tick} rate=${ticksPerSec.toFixed(0)}/s`);
      },
    });

    log(`[4/4] screenshot at tick ${run.endTick}`);
    const shot = await shoot(dbg);
    const shotPath = join(outDir, `shot-${run.endTick}.png`);
    if (shot.png) writeFileSync(shotPath, shot.png);

    const { rgba: _r, png: _p, ...shotLight } = shot;
    ok({
      cartPath,
      outDir,
      cabinet: cssPath,
      build: { ms: Math.round(buildMs) },
      load: { ms: Math.round(loadMs) },
      run,
      shot: { ...shotLight, path: shot.png ? shotPath : null },
    });
  } finally {
    await dbg.close();
  }
}

// --- Subcommand: baseline ----------------------------------------------

async function cmdBaselineRecord({ args, flags }) {
  const [cssPath] = args;
  if (!cssPath) fail('baseline-record: cabinet path required');
  const ticksArg = flags.ticks ?? '0,50000,100000,500000';
  const ticks = ticksArg.split(',').map(s => Number.parseInt(s.trim(), 10));
  const { outDir, manifest } = await recordBaseline({ cssPath, ticks, out: flags.out });
  ok({ outDir, manifest });
}

async function cmdBaselineVerify({ args, flags }) {
  const [cssPath] = args;
  if (!cssPath) fail('baseline-verify: cabinet path required');
  const { manifest, results, ok: allOk } = await verifyBaseline({
    cssPath,
    dir: flags.dir,
    maxPhashDistance: flagInt(flags, 'phash-distance', 4),
  });
  const failed = results.filter(r => r.anyFail);
  // Report is more useful than ok-or-not — always provide both.
  die(allOk ? 0 : 3, {
    ok: allOk,
    cabinet: resolve(cssPath),
    baselineAt: manifest.recordedAt,
    ticksChecked: results.length,
    failedTicks: failed.map(r => r.tick),
    results,
  });
}

// --- Subcommand: triage -------------------------------------------------

async function cmdTriage({ args, flags }) {
  const [cssPath] = args;
  if (!cssPath) fail('triage: cabinet path required');
  const maxTicks = flagInt(flags, 'max-ticks', 10_000);
  const result = await triageDivergence({ cssPath, maxTicks });
  ok(result);
}

async function cmdCoverage({ args, flags }) {
  const [cssPath] = args;
  if (!cssPath) fail('coverage: cabinet path required');
  const result = computeCoverage({
    cssPath,
    maxTicks: flagInt(flags, 'max-ticks', 100_000),
  });
  ok(result);
}

async function cmdScript({ args, flags }) {
  const [cssPath, scriptPath] = args;
  if (!cssPath || !scriptPath) fail('script: cabinet + script.json paths required');
  const script = loadScriptFromFile(scriptPath);
  const scriptName = basename(scriptPath).replace(/\.json$/, '');
  const outDir = flags.out ?? join(HARNESS_ROOT, 'results', `script-${scriptName}-${Date.now()}`);
  const dbg = await acquireDebugger({ cssPath, flags });
  try {
    const result = await runScript({ dbg, script, outDir, scriptName });
    ok({ outDir, ...result });
  } finally {
    await dbg.close();
  }
}

async function cmdCabinetDiff({ args, flags }) {
  const [a, b] = args;
  if (!a || !b) fail('cabinet-diff: two cabinet paths required');
  const sampleTicks = flags.ticks
    ? flags.ticks.split(',').map(s => Number.parseInt(s.trim(), 10))
    : undefined;
  const result = await cabinetDiff({ cabinetA: a, cabinetB: b, sampleTicks });
  die(result.allOk ? 0 : 3, { ok: result.allOk, ...result });
}

async function cmdConsistency({ args, flags }) {
  const [cssPath] = args;
  if (!cssPath) fail('consistency: cabinet path required');
  const tick = flagInt(flags, 'tick', 0);
  const result = await runCompareAtTick(cssPath, tick);
  ok(result);
}

// --- Main ---------------------------------------------------------------

async function main() {
  const [, , sub, ...rest] = process.argv;
  const { args, flags } = parseArgs(rest);
  try {
    switch (sub) {
      case 'build':    await cmdBuild({ args, flags });    break;
      case 'inspect':  await cmdInspect({ args, flags });  break;
      case 'load':     await cmdLoad({ args, flags });     break;
      case 'run':      await cmdRun({ args, flags });      break;
      case 'shoot':    await cmdShoot({ args, flags });    break;
      case 'diff':     await cmdDiff({ args, flags });     break;
      case 'full':     await cmdFull({ args, flags });     break;
      case 'baseline-record':  await cmdBaselineRecord({ args, flags });  break;
      case 'baseline-verify':  await cmdBaselineVerify({ args, flags });  break;
      case 'triage':           await cmdTriage({ args, flags });           break;
      case 'consistency':      await cmdConsistency({ args, flags });      break;
      case 'cabinet-diff':     await cmdCabinetDiff({ args, flags });      break;
      case 'script':           await cmdScript({ args, flags });           break;
      case 'coverage':         await cmdCoverage({ args, flags });         break;
      case 'fulldiff': {
        // Delegate to the sibling script so its arg parser stays canonical.
        const child = spawn(process.execPath, [
          resolve(HARNESS_ROOT, 'fulldiff.mjs'),
          ...rest,
        ], { stdio: 'inherit' });
        child.on('close', c => process.exit(c ?? 0));
        break;
      }
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        process.stderr.write(USAGE);
        process.exit(sub == null ? 2 : 0);
        break;
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`);
        process.exit(2);
    }
  } catch (err) {
    fail(err);
  }
}

const USAGE = `pipeline.mjs — CSS-DOS agentic test harness

Usage:
  node tests/harness/pipeline.mjs <subcommand> [args...] [flags...]

Subcommands:
  build <cart>            Build cart → cabinet + sidecars.
  inspect <cabinet>       Print cabinet meta (no daemon needed).
  load <cabinet>          Open cabinet in daemon, print info.
  run <cabinet>           Run forward with budgets.
    Flags: --wall-ms=N --max-ticks=N --stall-rate=F --stall-seconds=N
           --until-cs=0xXXXX --until-tick=N --until-program-entered
  shoot <cabinet>         Screenshot at current/specified tick.
    Flags: --tick=N --mode=0xXX --out=path
  diff <cabinet>          Compile vs interp path diff at current tick.
  full <cart>             Build + load + run + shot all in one.
  fulldiff <cabinet>      Delegate to fulldiff.mjs — streaming calcite-vs-ref
                          divergence finder. Flags: --max-ticks=N --skip=N --stop-at=all
  triage <cabinet>        Run fulldiff and emit verdict + next-steps.
  consistency <cabinet> --tick=N
                          Compiled vs interp at a single tick (caveat: limited
                          after seek; see docs).
  cabinet-diff A B        Compare two cabinets at sample ticks.
    Flags: --ticks=0,10000,...
  baseline-record <cabinet>  Freeze register/screen state at sample ticks.
    Flags: --ticks=0,10000,... --out=path
  baseline-verify <cabinet>  Compare current cabinet to its baseline.
  coverage <cabinet>      Per-opcode hit counts in the first --max-ticks=N insns.
  script <cabinet> <script.json>
                          Run a keyboard/wait/shoot script against the cabinet.

Common flags:
  --daemon                Connect to a running daemon (default: spawn a
                          one-shot child calcite-debugger per command).
  --host=127.0.0.1        Daemon host (only with --daemon).
  --port=3334             Daemon TCP port (only with --daemon).
  --session=NAME          MCP session name; defaults to cabinet basename.
  --verbose               Forward child-process output to stderr.

All subcommands print a single line of JSON to stdout on exit,
{"ok": true, ...} on success or {"ok": false, "error": "..."} on failure.

Default mode (no --daemon): the harness spawns its own calcite-debugger
child per command, loads the cabinet, does its work, and terminates.
Self-contained — no orphan processes, but pays the parse+compile cost
each time (usually 1-10s).

Daemon mode (--daemon --port=PORT): reuse the user's long-running
  daemon (see ../calcite/start-debugger-daemon.bat). Parse+compile
  cost paid once, subsequent calls are instant. Harness never closes
  the daemon on exit.
`;

main();

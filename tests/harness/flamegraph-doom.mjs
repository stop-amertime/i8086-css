#!/usr/bin/env node
// flamegraph-doom.mjs — capture CPU profile + tracing JSON for the web
// player during doom8088 LOAD and INGAME phases.
//
// What it does. Drives Playwright + headless Chrome at /player/bench.html.
// Attaches a CDP session to BOTH the page main-thread context and the
// bridge worker (where calcite-wasm runs). For each phase:
//   1. boot the page (cabinet compiles, engine starts at reset)
//   2. send `restore-in` to drop the engine onto the chosen snapshot
//   3. start V8 sampling profiler + tracing on both targets
//   4. run the workload (wait for GS_LEVEL, or hold LEFT for N seconds)
//   5. stop, save .cpuprofile + trace.json under tmp/flamegraph/<phase>/
//   6. parse the cpuprofile, print top-N functions by self-time
//
// Phases:
//   load    snapshot=stage_loading.snap, halt on _g_gamestate==GS_LEVEL
//   ingame  snapshot=stage_ingame.snap,  hold LEFT arrow for --window-ms
//
// Snapshot files come from `bench-doom-stages.mjs --capture-snapshots=DIR`.
// They are tied to the exact cabinet build; if `restore-in` returns
// `phash mismatch` we bail early with a recapture hint.
//
// Usage:
//   node tests/harness/flamegraph-doom.mjs                 # both phases
//   node tests/harness/flamegraph-doom.mjs --phase=load
//   node tests/harness/flamegraph-doom.mjs --phase=ingame --window-ms=30000
//   node tests/harness/flamegraph-doom.mjs --snap-dir=tmp/snapshots-fresh
//   node tests/harness/flamegraph-doom.mjs --headed
//
// Output:
//   tmp/flamegraph/<phase>/main.cpuprofile     ← load in DevTools → Performance
//   tmp/flamegraph/<phase>/worker.cpuprofile
//   tmp/flamegraph/<phase>/main.trace.json     ← chrome://tracing or perfetto
//   tmp/flamegraph/<phase>/worker.trace.json
//   tmp/flamegraph/<phase>/summary.json        ← top sites + headline numbers

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    if (!a.startsWith('--')) return [];
    const [k, v] = a.slice(2).split('=');
    return [[k, v ?? true]];
  }),
);
const PHASE     = args.phase ?? 'both';      // load | ingame | both
const SNAP_DIR  = args['snap-dir'] ?? 'tmp/doom-snapshots-pj';
const OUT_DIR   = args['out-dir']  ?? 'tmp/flamegraph';
const WINDOW_MS = parseInt(args['window-ms'] ?? '60000', 10);
const HEADED    = args.headed ? true : false;
const PORT      = args.port ?? '5173';
const CART      = args.cart ?? 'doom8088-load';
const TOP_N     = parseInt(args['top-n'] ?? '30', 10);
// Wall budget for each phase: load is ~90s of work, ingame is WINDOW_MS;
// add a generous safety margin for compile+restore.
const LOAD_BUDGET_MS   = parseInt(args['load-budget-ms']   ?? '300000', 10);
const INGAME_BUDGET_MS = WINDOW_MS + 120000;

// Doom8088 globals (re-derive on cabinet rebuild — see bench-doom-stages.mjs).
const ADDR_GAMESTATE = 0x3a3c4;
const GS_LEVEL = 0;

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  const fallback = process.platform === 'win32'
    ? 'C:/Users/AdmT9N0CX01V65438A/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright'
    : null;
  if (!fallback) throw new Error('playwright not found');
  ({ chromium } = require(fallback));
}

// ---------- helpers ----------

function readSnap(name) {
  const path = resolve(SNAP_DIR, `${name}.snap`);
  if (!existsSync(path)) {
    throw new Error(`snapshot missing: ${path}\n` +
      `  recapture with: node tests/harness/bench-doom-stages.mjs --capture-snapshots=${SNAP_DIR}`);
  }
  return readFileSync(path);
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }

// Walk the V8 cpuprofile node tree and produce top-N by self-time.
// cpuprofile shape: { nodes:[{id, callFrame:{functionName, url}, hitCount, children}],
//                     samples:[nodeId,...], timeDeltas:[us,...], startTime, endTime }
// hitCount is per-sample-tick; samples[] is the actual sample list. Self
// time = sum of timeDeltas where samples[i] === node.id.
function topByCpuProfileSelfTime(profile, topN) {
  const { nodes, samples, timeDeltas } = profile;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const selfUs = new Map();  // id → microseconds
  // timeDeltas[i] is the gap between sample i-1 and sample i.
  // Convention: charge the delta to samples[i] (the node observed at end
  // of the interval). First sample (i=0) gets timeDeltas[0] anyway.
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = timeDeltas[i] ?? 0;
    selfUs.set(id, (selfUs.get(id) ?? 0) + dt);
  }
  const totalUs = profile.endTime - profile.startTime;
  const rows = [...selfUs.entries()].map(([id, us]) => {
    const n = byId.get(id);
    const cf = n?.callFrame ?? {};
    return {
      id,
      fn: cf.functionName || '(anonymous)',
      url: cf.url || '',
      line: cf.lineNumber,
      selfUs: us,
      pct: us / totalUs,
    };
  }).sort((a, b) => b.selfUs - a.selfUs).slice(0, topN);
  return { rows, totalUs };
}

// Aggregate self-time by URL — collapses thousands of tiny "anonymous
// closure inside calcite-bridge.js" rows into one bucket per source file,
// which is the real "where does time go" question for the worker thread.
function topByUrl(profile, topN) {
  const { nodes, samples, timeDeltas } = profile;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const totalUs = profile.endTime - profile.startTime;
  const buckets = new Map(); // url → us
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = timeDeltas[i] ?? 0;
    const n = byId.get(id);
    let url = n?.callFrame?.url || '(no url)';
    // Bucket native VM frames separately by functionName so wasm vs GC
    // vs runtime stays visible.
    if (!url || url === '') {
      const fn = n?.callFrame?.functionName ?? '';
      if (fn === '(garbage collector)' || fn === '(idle)' || fn === '(program)' || fn === '(root)') {
        url = `[${fn}]`;
      } else if (fn.startsWith('wasm-') || /\.wasm/.test(fn)) {
        url = '[wasm]';
      } else {
        url = `[native:${fn || '?'}]`;
      }
    }
    // Trim long blob: URLs to a recognisable suffix.
    if (url.startsWith('blob:')) url = 'blob:' + url.split('/').pop();
    buckets.set(url, (buckets.get(url) ?? 0) + dt);
  }
  const rows = [...buckets.entries()].map(([url, us]) => ({
    url, selfUs: us, pct: us / totalUs,
  })).sort((a, b) => b.selfUs - a.selfUs).slice(0, topN);
  return { rows, totalUs };
}

function formatTopRows(rows, totalUs, label) {
  const lines = [`  ${label}  (total ${(totalUs / 1000).toFixed(0)} ms)`];
  for (const r of rows) {
    const fn = (r.fn || r.url || '').slice(0, 70);
    const ms = (r.selfUs / 1000).toFixed(1).padStart(8);
    const pct = (r.pct * 100).toFixed(1).padStart(5);
    lines.push(`    ${pct}%  ${ms} ms  ${fn}`);
  }
  return lines.join('\n');
}

// Send `restore-in` to the bridge worker via the page. We need a
// MessageChannel inside the page (Playwright's page.evaluate gives us
// that) and the snapshot bytes have to cross from Node → page → worker.
// Page evaluate args go through structured-clone, so a Uint8Array
// transfers fine; we then ArrayBuffer-transfer to the worker.
async function pageRestoreSnapshot(page, bytes) {
  const result = await page.evaluate(async (snapBytes) => {
    const w = window.__bridgeWorker;
    if (!w) return { ok: false, err: 'bridge worker not ready' };
    return await new Promise((resolve) => {
      const mc = new MessageChannel();
      const timer = setTimeout(() => resolve({ ok: false, err: 'restore timeout' }), 10000);
      mc.port1.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data);
      };
      // Copy into a fresh ArrayBuffer that we can transfer (Uint8Array
      // crossing structured-clone has its own buffer; transferring it
      // detaches it on the page side, which is fine).
      const ab = new ArrayBuffer(snapBytes.length);
      new Uint8Array(ab).set(snapBytes);
      try {
        w.postMessage({ type: 'restore-in', bytes: ab }, [mc.port2, ab]);
      } catch (e) {
        clearTimeout(timer);
        resolve({ ok: false, err: 'post failed: ' + e.message });
      }
    });
  }, Array.from(bytes)); // page.evaluate doesn't reliably forward Uint8Array;
  // it goes through JSON for fn args in some Playwright versions. Array<number>
  // is safe and the page-side rebuilds it.
  return result;
}

async function pagePeekMem(page, addr, len) {
  return await page.evaluate(async ({ addr, len }) => {
    const w = window.__bridgeWorker;
    if (!w) return null;
    return await new Promise((resolve) => {
      const mc = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 2000);
      mc.port1.onmessage = (ev) => {
        clearTimeout(timer);
        const r = ev.data;
        if (r && r.ok) resolve(Array.from(new Uint8Array(r.bytes)));
        else resolve(null);
      };
      try {
        w.postMessage({ type: 'peek-mem', addr, len }, [mc.port2]);
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }, { addr, len });
}

async function pageGetBridgeStats(page) {
  return await page.evaluate(() => globalThis.__lastBridgeStats || null);
}

// Listen on cssdos-bridge-stats inside the page, mirror to a global so we
// can read tick/cycle counts during/after the run.
async function installBridgeStatsListener(page) {
  await page.evaluate(() => {
    if (globalThis.__bridgeStatsListenerInstalled) return;
    globalThis.__bridgeStatsListenerInstalled = true;
    globalThis.__lastBridgeStats = null;
    globalThis.__compileDone = null;
    const ch = new BroadcastChannel('cssdos-bridge-stats');
    ch.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'compile-done') globalThis.__compileDone = d;
      if (d.type === 'bridge-stats') globalThis.__lastBridgeStats = d;
    };
  });
}

async function waitForCompileDone(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cd = await page.evaluate(() => globalThis.__compileDone);
    if (cd) return cd;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`compile-done not seen within ${timeoutMs}ms`);
}

async function waitForBridgeReady(page, timeoutMs) {
  // Compile-done fires before the engine actually starts ticking. Wait
  // for the first bridge-stats packet so we know the tick loop is alive.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await pageGetBridgeStats(page);
    if (s && s.ticks > 0) return s;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`bridge tick loop not running within ${timeoutMs}ms`);
}

// Send a key via the SW /_kbd shim (same path bench-doom-stages.mjs uses).
// 0x1C0D = Enter, 0x4B00 = LEFT (scancode 0x4B in AH, AL=0).
async function sendKey(page, code, why) {
  await page.evaluate(async ({ code, why }) => {
    const f = document.getElementById('frame');
    if (!f || !f.contentWindow) return false;
    try {
      await f.contentWindow.fetch(`/_kbd?key=0x${code.toString(16)}`, { method: 'GET' });
      return true;
    } catch { return false; }
  }, { code, why });
}

// ---------- profiling: attach CDP to page + worker, start/stop ----------

// Per-target V8 sampling profiler. Works on Page and Worker targets.
// Returns { stop(): Promise<cpuprofile> }.
async function startCpuProfile(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); // 100us = 10kHz
  await cdp.send('Profiler.start');
  return {
    async stop() {
      const r = await cdp.send('Profiler.stop');
      await cdp.send('Profiler.disable');
      return r.profile;
    },
  };
}

// Browser-wide tracing. Tracing.start only exists on the browser-level
// CDP target — Worker targets reject it. Categories cover V8 sampling
// (cpu_profiler), user timing marks, and devtools timeline events; that
// gives GC, paint, layout, and JS-stack samples in one trace, viewable in
// chrome://tracing or perfetto.dev.
async function startTracing(cdp) {
  const tracingDone = new Promise((resolve, reject) => {
    cdp.once('Tracing.tracingComplete', async (ev) => {
      try {
        if (!ev.stream) { resolve(null); return; }
        const chunks = [];
        while (true) {
          const r = await cdp.send('IO.read', { handle: ev.stream, size: 1 << 20 });
          if (r.data) chunks.push(r.data);
          if (r.eof) break;
        }
        await cdp.send('IO.close', { handle: ev.stream });
        resolve(chunks.join(''));
      } catch (e) { reject(e); }
    });
  });
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    traceConfig: {
      recordMode: 'recordContinuously',
      includedCategories: [
        'v8',
        'v8.execute',
        'disabled-by-default-v8.cpu_profiler',
        'blink.user_timing',
        'devtools.timeline',
        'toplevel',
      ],
    },
  });
  return {
    async stop() {
      await cdp.send('Tracing.end');
      return await tracingDone;
    },
  };
}

// Raw-CDP client over WebSocket. Playwright's CDPSession can attach to a
// Page but in this version refuses Worker objects. We bypass Playwright
// for the worker by talking directly to Chrome's --remote-debugging-port
// /json endpoint, which surfaces the worker as its own target with a
// `webSocketDebuggerUrl` we can open a vanilla WS against.
class RawCdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.callbacks = new Map();
    this.listeners = new Map();
    this.onceListeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      if (msg.id != null) {
        const cb = this.callbacks.get(msg.id);
        if (cb) {
          this.callbacks.delete(msg.id);
          if (msg.error) cb.reject(new Error(`CDP ${cb.method}: ${msg.error.message}`));
          else cb.resolve(msg.result);
        }
        return;
      }
      // Event
      const fns = this.listeners.get(msg.method) || [];
      for (const fn of fns) { try { fn(msg.params); } catch {} }
      const onceFns = this.onceListeners.get(msg.method) || [];
      this.onceListeners.delete(msg.method);
      for (const fn of onceFns) { try { fn(msg.params); } catch {} }
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', resolve);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.callbacks.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  once(method, fn) {
    if (!this.onceListeners.has(method)) this.onceListeners.set(method, []);
    this.onceListeners.get(method).push(fn);
  }
  close() { try { this.ws.close(); } catch {} }
}

async function openRawCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))), { once: true });
  });
  return new RawCdp(ws);
}

async function findWorkerTarget(debugPort, urlMatcher, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json`);
      const list = await r.json();
      const t = list.find(x =>
        (x.type === 'worker' || x.type === 'service_worker' || x.type === 'shared_worker' || x.type === 'other') &&
        urlMatcher.test(x.url || ''));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`worker target matching ${urlMatcher} not found within ${timeoutMs}ms (port ${debugPort})`);
}

// ---------- per-phase runner ----------

async function runPhase({ phase, snapshotName, halt, browser, outDir }) {
  const phaseDir = ensureDir(resolve(outDir, phase));
  process.stderr.write(`\n=== phase: ${phase} ===\n`);
  process.stderr.write(`  snapshot: ${SNAP_DIR}/${snapshotName}.snap\n`);
  process.stderr.write(`  output:   ${phaseDir}\n`);

  const snapBytes = readSnap(snapshotName);
  process.stderr.write(`  snap bytes: ${snapBytes.length}\n`);

  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('ERROR') || (t.includes('error') && !t.includes('errored'))) {
      process.stderr.write(`[page] ${t}\n`);
    }
  });
  page.on('pageerror', err => process.stderr.write(`[pageerr] ${err.message}\n`));

  const url = `http://localhost:${PORT}/player/bench.html?cart=${encodeURIComponent(CART)}&n=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await installBridgeStatsListener(page);

  process.stderr.write(`  waiting for compile-done...\n`);
  const cd = await waitForCompileDone(page, 120000);
  process.stderr.write(`  compile-done: ${Math.round(cd.compileMs)} ms, cabinet ${cd.cabinetBytes} bytes\n`);

  process.stderr.write(`  waiting for tick loop...\n`);
  await waitForBridgeReady(page, 30000);

  // Restore the snapshot. The bridge processes restore-in between batches.
  process.stderr.write(`  sending restore-in...\n`);
  const r = await pageRestoreSnapshot(page, snapBytes);
  if (!r.ok) {
    await ctx.close();
    throw new Error(`restore failed: ${r.err}\n` +
      `  (snapshots are tied to the exact cabinet build; recapture if the cabinet has changed)`);
  }
  process.stderr.write(`  restore: ok\n`);

  // Verify we landed where expected. For load: usergame should be 1,
  // gamestate should be 3. For ingame: gamestate should be 0.
  const gsBytes = await pagePeekMem(page, ADDR_GAMESTATE, 1);
  process.stderr.write(`  post-restore _g_gamestate=${gsBytes ? gsBytes[0] : '?'}\n`);

  // Attach profilers.
  process.stderr.write(`  attaching CDP to page main thread...\n`);
  const mainCdp = await ctx.newCDPSession(page);
  process.stderr.write(`  finding bridge worker via /json (port ${DEBUG_PORT})...\n`);
  const target = await findWorkerTarget(DEBUG_PORT, /calcite-bridge\.js/, 15000);
  process.stderr.write(`  worker target: ${target.url}\n`);
  const workerCdp = await openRawCdp(target.webSocketDebuggerUrl);

  process.stderr.write(`  starting profilers...\n`);
  const mainProf = await startCpuProfile(mainCdp);
  const workerProf = await startCpuProfile(workerCdp);
  // Browser-wide tracing — attached on the page CDP, captures both
  // threads' timeline events (GC, paint, V8 compile, etc.).
  const tracing = await startTracing(mainCdp);

  // For ingame, start holding LEFT. We do this by spamming the LEFT
  // scancode at a low rate (every 200ms — DOOM ticks at ~35Hz so a few
  // per cycle is fine; key state is edge-triggered through INT 16h).
  let leftInterval = null;
  if (phase === 'ingame') {
    process.stderr.write(`  holding LEFT for ${WINDOW_MS} ms...\n`);
    // Send one immediately then keep tapping. DOOM's input layer holds
    // the last pressed direction until a release scancode arrives, but
    // the bench sends discrete edges via /_kbd; rapid taps approximate hold.
    await sendKey(page, 0x4B00, 'left-initial');
    leftInterval = setInterval(() => {
      sendKey(page, 0x4B00, 'left').catch(() => {});
    }, 200);
  }

  const startWall = Date.now();
  // Wait for a bridge-stats packet that reflects the post-restore tick
  // count. The bridge emits stats at ~1Hz; the packet arriving moments
  // after restore will report the snapshot's restored tick value, which
  // is what we want as the baseline. Without this wait, startStats is
  // either pre-restore (delta starts at +4.7M) or null.
  let startStats = null;
  {
    const sBefore = await pageGetBridgeStats(page);
    const beforeAt = sBefore?.ticks ?? -1;
    const dl = Date.now() + 5000;
    while (Date.now() < dl) {
      const s = await pageGetBridgeStats(page);
      if (s && s.ticks !== beforeAt) { startStats = s; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!startStats) startStats = await pageGetBridgeStats(page) || { ticks: 0, cycles: 0 };
  }

  const budget = phase === 'load' ? LOAD_BUDGET_MS : INGAME_BUDGET_MS;
  const deadline = startWall + budget;
  let halted = false, haltReason = '';
  while (Date.now() < deadline) {
    if (phase === 'load') {
      const gs = await pagePeekMem(page, ADDR_GAMESTATE, 1);
      if (gs && gs[0] === GS_LEVEL) { halted = true; haltReason = 'GS_LEVEL reached'; break; }
    } else {
      if (Date.now() - startWall >= WINDOW_MS) { halted = true; haltReason = 'window elapsed'; break; }
    }
    // Status line
    const s = await pageGetBridgeStats(page);
    if (s) {
      const wall = ((Date.now() - startWall) / 1000).toFixed(1);
      const dt = s.ticks - startStats.ticks;
      const dc = s.cycles - startStats.cycles;
      process.stderr.write(`\r  t=${wall}s  Δticks=${dt.toLocaleString()}  Δcycles=${dc.toLocaleString()}  ` +
        `(tps=${(dt / Math.max(0.001, (Date.now()-startWall)/1000)).toFixed(0)})`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stderr.write('\n');

  if (leftInterval) clearInterval(leftInterval);

  const wallMs = Date.now() - startWall;
  const endStats = (await pageGetBridgeStats(page)) || startStats;
  const dTicks = endStats.ticks - startStats.ticks;
  const dCycles = endStats.cycles - startStats.cycles;
  process.stderr.write(`  ${haltReason || 'budget exhausted'} after ${(wallMs/1000).toFixed(1)} s\n`);
  process.stderr.write(`  Δticks=${dTicks.toLocaleString()}  Δcycles=${dCycles.toLocaleString()}\n`);

  process.stderr.write(`  stopping profilers...\n`);
  const mainCpu = await mainProf.stop();
  const workerCpu = await workerProf.stop();
  const traceJson = await tracing.stop();

  // Save artifacts.
  const mainCpuPath = resolve(phaseDir, 'main.cpuprofile');
  const workerCpuPath = resolve(phaseDir, 'worker.cpuprofile');
  const tracePath = resolve(phaseDir, 'trace.json');
  writeFileSync(mainCpuPath, JSON.stringify(mainCpu));
  writeFileSync(workerCpuPath, JSON.stringify(workerCpu));
  if (traceJson) writeFileSync(tracePath, traceJson);
  process.stderr.write(`  wrote ${mainCpuPath}\n`);
  process.stderr.write(`  wrote ${workerCpuPath}\n`);
  if (traceJson) process.stderr.write(`  wrote ${tracePath}\n`);

  // In-band report — top by URL bucket (the actually useful view) and top
  // by individual function. Worker is what matters most.
  const workerByUrl = topByUrl(workerCpu, TOP_N);
  const workerByFn  = topByCpuProfileSelfTime(workerCpu, TOP_N);
  const mainByUrl   = topByUrl(mainCpu, TOP_N);
  const mainByFn    = topByCpuProfileSelfTime(mainCpu, TOP_N);

  process.stdout.write('\n');
  process.stdout.write(`### ${phase} — WORKER (calcite-wasm + bridge)\n`);
  process.stdout.write(formatTopRows(workerByUrl.rows, workerByUrl.totalUs, 'top by URL bucket') + '\n\n');
  process.stdout.write(formatTopRows(workerByFn.rows, workerByFn.totalUs, 'top by function (self time)') + '\n\n');
  process.stdout.write(`### ${phase} — MAIN THREAD (page, render, peek-mem)\n`);
  process.stdout.write(formatTopRows(mainByUrl.rows, mainByUrl.totalUs, 'top by URL bucket') + '\n\n');
  process.stdout.write(formatTopRows(mainByFn.rows, mainByFn.totalUs, 'top by function (self time)') + '\n\n');

  const summary = {
    phase,
    snapshot: snapshotName,
    wallMs,
    halted, haltReason,
    deltaTicks: dTicks,
    deltaCycles: dCycles,
    ticksPerSec: dTicks / (wallMs / 1000),
    cyclesPerSec: dCycles / (wallMs / 1000),
    artifacts: {
      mainCpuprofile: mainCpuPath,
      workerCpuprofile: workerCpuPath,
      trace: traceJson ? tracePath : null,
    },
    worker: {
      totalUs: workerByUrl.totalUs,
      topByUrl: workerByUrl.rows,
      topByFn: workerByFn.rows,
    },
    main: {
      totalUs: mainByUrl.totalUs,
      topByUrl: mainByUrl.rows,
      topByFn: mainByFn.rows,
    },
  };
  writeFileSync(resolve(phaseDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`  wrote ${resolve(phaseDir, 'summary.json')}\n`);

  try { workerCdp.close(); } catch {}
  await ctx.close();
  return summary;
}

// ---------- main ----------

// Pick a stable debug port. Chrome opens an HTTP /json endpoint here that
// lists every target including Workers, with webSocketDebuggerUrl. The
// /json endpoint is always on 127.0.0.1.
const DEBUG_PORT = parseInt(args['debug-port'] ?? '9332', 10);
const launchOpts = {
  headless: !HEADED,
  args: [`--remote-debugging-port=${DEBUG_PORT}`],
};
const sysChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
try {
  const fs = require('node:fs');
  if (fs.existsSync(sysChrome)) launchOpts.executablePath = sysChrome;
} catch {}

const browser = await chromium.launch(launchOpts);
ensureDir(OUT_DIR);

const phases = PHASE === 'both' ? ['load', 'ingame'] : [PHASE];
const results = [];
try {
  for (const p of phases) {
    if (p === 'load') {
      results.push(await runPhase({
        phase: 'load',
        snapshotName: 'stage_loading',
        browser,
        outDir: OUT_DIR,
      }));
    } else if (p === 'ingame') {
      results.push(await runPhase({
        phase: 'ingame',
        snapshotName: 'stage_ingame',
        browser,
        outDir: OUT_DIR,
      }));
    } else {
      throw new Error(`unknown phase: ${p}`);
    }
  }
} finally {
  await browser.close();
}

process.stdout.write('\n=== headlines ===\n');
for (const r of results) {
  process.stdout.write(`  ${r.phase}: ${(r.wallMs/1000).toFixed(1)}s  ` +
    `tps=${r.ticksPerSec.toFixed(0)}  cps=${r.cyclesPerSec.toFixed(0)}  ${r.haltReason}\n`);
}

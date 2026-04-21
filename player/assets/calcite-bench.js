// player/assets/calcite-bench.js
// Loaded by calcite.html only when `?bench=1`. Records per-frame <img>
// load timestamps and per-second bridge stats on a BroadcastChannel,
// stops when cycleCount crosses TARGET_CYCLES, computes summary.
//
// Measurement convention (decided 2026-04-21): timer starts at first
// 'bridge-stats' message (not page load). We're measuring the CPU +
// encode + stream loop in steady state, not one-time WASM compile.

const TARGET_CYCLES = 23_000_000; // Zork1 `>` prompt stabilisation
const IDLE_PHASE_MS = 6_000; // after reaching target, measure this much idle
const STATS_TIMEOUT_MS = 120_000; // hard ceiling; abort if we stall

const img = document.getElementById('calcite-screen');
const hud = document.createElement('div');
hud.style.cssText = [
  'position:fixed', 'top:4px', 'right:4px', 'background:#000',
  'color:#0f0', 'font:12px monospace', 'padding:6px 8px',
  'z-index:9999', 'white-space:pre', 'border:1px solid #0f0',
  'max-width:360px',
].join(';');
hud.textContent = 'bench: waiting for first bridge-stats...';
document.body.appendChild(hud);

// Per-frame arrivals. <img> fires 'load' for each multipart part.
// We use this as the "frame-arrived-on-page" timestamp — the moment
// the decoder finished with the part.
const frameArrivals = []; // {ms: wallMs, since start}
let benchStartMs = null;
let targetReachedMs = null;  // when we hit TARGET_CYCLES (start of idle phase)
let idlePhaseStartSample = null; // bridge sample at start of idle phase
let lastBridgeStats = null;
const bridgeSamples = []; // per-second bridge stats

img.addEventListener('load', () => {
  if (benchStartMs == null) return; // not started yet
  const t = performance.now() - benchStartMs;
  frameArrivals.push(t);
});

const ch = new BroadcastChannel('cssdos-bridge-stats');
ch.onmessage = (ev) => {
  const d = ev.data;
  if (!d || d.type !== 'bridge-stats') return;
  if (benchStartMs == null) {
    // First stats message marks t=0 for our measurement. We don't want
    // to include build/compile/first-tick time.
    benchStartMs = performance.now();
  }
  const sinceStart = performance.now() - benchStartMs;
  lastBridgeStats = d;
  bridgeSamples.push({
    ms: sinceStart,
    cycles: d.cycles,
    framesEncoded: d.framesEncoded,
    framesSkipped: d.framesSkipped || 0,
    encodeMs: d.lastEncodeMs,
    frameBytes: d.lastFrameBytes,
    batchCount: d.batchCount,
    batchMsEma: d.batchMsEma,
    tickOnlyMsEma: d.tickOnlyMsEma,
    emitMsEma: d.emitMsEma,
    fpsWindow: d.fpsWindow,
    skipWindow: d.skipWindow || 0,
  });
  updateHud(d, sinceStart);
  if (d.cycles >= TARGET_CYCLES && targetReachedMs == null) {
    targetReachedMs = sinceStart;
    idlePhaseStartSample = bridgeSamples[bridgeSamples.length - 1];
  }
  if (targetReachedMs != null && sinceStart - targetReachedMs >= IDLE_PHASE_MS) {
    finish('target + idle-phase complete');
  }
};

function updateHud(s, sinceStart) {
  hud.textContent = [
    `bench (target ${TARGET_CYCLES.toLocaleString()} cyc)`,
    `t=${(sinceStart/1000).toFixed(1)}s`,
    `cycles=${s.cycles.toLocaleString()} (${(100*s.cycles/TARGET_CYCLES).toFixed(0)}%)`,
    `bridge frames=${s.framesEncoded}  last-enc=${s.lastEncodeMs.toFixed(1)}ms`,
    `batch=${s.batchCount} (${s.batchMsEma.toFixed(1)}ms)`,
    `img frames received=${frameArrivals.length}`,
  ].join('\n');
}

setTimeout(() => { if (benchStartMs != null && lastBridgeStats && lastBridgeStats.cycles < TARGET_CYCLES) finish('timeout'); }, STATS_TIMEOUT_MS);

function finish(reason) {
  if (window.__benchResult) return; // already finished
  const totalMs = performance.now() - benchStartMs;
  // Inter-frame intervals (img arrivals) — choppiness signal.
  const iv = [];
  for (let i = 1; i < frameArrivals.length; i++) iv.push(frameArrivals[i] - frameArrivals[i-1]);
  const mean = iv.reduce((a,b)=>a+b,0) / (iv.length||1);
  const variance = iv.reduce((a,b)=>a + (b-mean)*(b-mean), 0) / (iv.length||1);
  const stddev = Math.sqrt(variance);
  // Sort for percentiles.
  const sorted = iv.slice().sort((a,b)=>a-b);
  const p = (q) => sorted.length ? sorted[Math.max(0, Math.min(sorted.length-1, Math.floor(q*sorted.length)))] : 0;
  // Steady-state cycles/sec: derivative over last 3 samples.
  const tail = bridgeSamples.slice(-3);
  const cps = tail.length >= 2
    ? (tail[tail.length-1].cycles - tail[0].cycles) * 1000 / (tail[tail.length-1].ms - tail[0].ms)
    : 0;

  // Idle-phase (post-target) cycles/sec — measured between target and
  // end. This is the number that matters for "is Zork smooth at the
  // prompt?" — different question than "how fast does it boot?".
  let idleCps = 0, idleEncodedPerSec = 0, idleSkippedPerSec = 0;
  if (idlePhaseStartSample && lastBridgeStats) {
    const dtMs = (performance.now() - benchStartMs) - idlePhaseStartSample.ms;
    if (dtMs > 100) {
      idleCps = (lastBridgeStats.cycles - idlePhaseStartSample.cycles) * 1000 / dtMs;
      idleEncodedPerSec = (lastBridgeStats.framesEncoded - idlePhaseStartSample.framesEncoded) * 1000 / dtMs;
      idleSkippedPerSec = ((lastBridgeStats.framesSkipped || 0) - idlePhaseStartSample.framesSkipped) * 1000 / dtMs;
    }
  }

  const result = {
    reason,
    targetCycles: TARGET_CYCLES,
    finalCycles: lastBridgeStats ? lastBridgeStats.cycles : 0,
    totalMs,
    toTargetMs: targetReachedMs || totalMs, // time for boot phase alone
    idlePhaseMs: targetReachedMs ? (totalMs - targetReachedMs) : 0,
    avgFps: frameArrivals.length > 0 ? frameArrivals.length * 1000 / totalMs : 0,
    bridgeFramesEncoded: lastBridgeStats ? lastBridgeStats.framesEncoded : 0,
    bridgeFramesSkipped: lastBridgeStats ? (lastBridgeStats.framesSkipped || 0) : 0,
    imgFramesReceived: frameArrivals.length,
    steadyCyclesPerSec: cps,
    pctOf8086: cps / 4_772_727 * 100,
    // Idle-phase: free-CPU speed once the screen stops moving. Dedup's
    // theoretical win lives here; boot-phase cycles/sec is a red herring
    // because boot has animated splash/scroll that defeats dedup.
    idleCyclesPerSec: idleCps,
    idlePctOf8086: idleCps / 4_772_727 * 100,
    idleEncodedPerSec,
    idleSkippedPerSec,
    steadyBatch: lastBridgeStats ? lastBridgeStats.batchCount : 0,
    steadyBatchMs: lastBridgeStats ? lastBridgeStats.batchMsEma : 0,
    lastEncodeMs: lastBridgeStats ? lastBridgeStats.lastEncodeMs : 0,
    lastFrameBytes: lastBridgeStats ? lastBridgeStats.lastFrameBytes : 0,
    // Choppiness / timing consistency on the <img> side.
    interFrameMs: { mean, stddev, p50: p(0.5), p90: p(0.9), p99: p(0.99), max: sorted[sorted.length-1] || 0 },
    bridgeSamples,
  };
  window.__benchResult = result;
  hud.textContent = 'DONE (' + reason + ')\n' + JSON.stringify({
    totalMs: +totalMs.toFixed(0),
    avgFps: +result.avgFps.toFixed(1),
    cps: +cps.toFixed(0),
    pct8086: +result.pctOf8086.toFixed(1),
    stddev: +stddev.toFixed(1),
    p99: +result.interFrameMs.p99.toFixed(1),
  }, null, 2);
  // Signal to parent (if iframe) and to Playwright via window-level flag.
  try { window.parent && window.parent.postMessage({ type:'bench-result', result }, '*'); } catch {}
}

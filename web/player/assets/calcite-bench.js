// player/assets/calcite-bench.js
// Loaded by calcite.html only when `?bench=1`. Subscribes to the
// 'cssdos-bridge-stats' BroadcastChannel and records per-second samples.
// Stops when cycleCount crosses TARGET_CYCLES + IDLE_PHASE_MS has elapsed,
// then computes a summary and posts it to the parent page.
//
// Measurement convention (decided 2026-04-21): timer starts at the first
// 'bridge-stats' message (not page load). We're measuring the CPU +
// stream loop in steady state, not one-time WASM compile.

// Defaults are tuned for Zork1's boot-stabilisation test. Override via
// URL params for heavier carts (e.g., doom8088 needs ~410M cycles to
// reach in-game and a much longer stall ceiling).
const _q = new URLSearchParams(location.search);
const TARGET_CYCLES = parseInt(_q.get('targetCycles') ?? '23000000', 10);
const IDLE_PHASE_MS = parseInt(_q.get('idlePhaseMs') ?? '6000', 10);
const STATS_TIMEOUT_MS = parseInt(_q.get('statsTimeoutMs') ?? '120000', 10);

const hud = document.createElement('div');
hud.style.cssText = [
  'position:fixed', 'top:4px', 'right:4px', 'background:#000',
  'color:#0f0', 'font:12px monospace', 'padding:6px 8px',
  'z-index:9999', 'white-space:pre', 'border:1px solid #0f0',
  'max-width:360px',
].join(';');
hud.textContent = 'bench: waiting for first bridge-stats...';
document.body.appendChild(hud);

let benchStartMs = null;
let targetReachedMs = null;
let idlePhaseStartSample = null;
let lastBridgeStats = null;
const bridgeSamples = [];

const ch = new BroadcastChannel('cssdos-bridge-stats');
ch.onmessage = (ev) => {
  const d = ev.data;
  if (!d || d.type !== 'bridge-stats') return;
  if (benchStartMs == null) benchStartMs = performance.now();
  const sinceStart = performance.now() - benchStartMs;
  lastBridgeStats = d;
  bridgeSamples.push({
    ms: sinceStart,
    cycles: d.cycles,
    framesEncoded: d.framesEncoded,
    frameBytes: d.lastFrameBytes,
    batchCount: d.batchCount,
    batchMsEma: d.batchMsEma,
    fpsWindow: d.fpsWindow,
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
    `bridge frames=${s.framesEncoded} fps=${s.fpsWindow}`,
    `batch=${s.batchCount} (${s.batchMsEma.toFixed(1)}ms)`,
  ].join('\n');
}

setTimeout(() => {
  if (benchStartMs != null && lastBridgeStats && lastBridgeStats.cycles < TARGET_CYCLES) {
    finish('timeout');
  }
}, STATS_TIMEOUT_MS);

function finish(reason) {
  if (window.__benchResult) return;
  const totalMs = performance.now() - benchStartMs;
  // Steady-state cycles/sec: derivative over last 3 samples.
  const tail = bridgeSamples.slice(-3);
  const cps = tail.length >= 2
    ? (tail[tail.length-1].cycles - tail[0].cycles) * 1000 / (tail[tail.length-1].ms - tail[0].ms)
    : 0;

  // Idle-phase (post-target) cycles/sec. Separate from boot-phase because
  // the two phases answer different questions ("how fast does it boot?"
  // vs "how smooth is interaction?").
  let idleCps = 0, idleEncodedPerSec = 0;
  if (idlePhaseStartSample && lastBridgeStats) {
    const dtMs = (performance.now() - benchStartMs) - idlePhaseStartSample.ms;
    if (dtMs > 100) {
      idleCps = (lastBridgeStats.cycles - idlePhaseStartSample.cycles) * 1000 / dtMs;
      idleEncodedPerSec = (lastBridgeStats.framesEncoded - idlePhaseStartSample.framesEncoded) * 1000 / dtMs;
    }
  }

  const result = {
    reason,
    targetCycles: TARGET_CYCLES,
    finalCycles: lastBridgeStats ? lastBridgeStats.cycles : 0,
    totalMs,
    toTargetMs: targetReachedMs || totalMs,
    idlePhaseMs: targetReachedMs ? (totalMs - targetReachedMs) : 0,
    bridgeFramesEncoded: lastBridgeStats ? lastBridgeStats.framesEncoded : 0,
    steadyCyclesPerSec: cps,
    pctOf8086: cps / 4_772_727 * 100,
    idleCyclesPerSec: idleCps,
    idlePctOf8086: idleCps / 4_772_727 * 100,
    idleEncodedPerSec,
    steadyBatch: lastBridgeStats ? lastBridgeStats.batchCount : 0,
    steadyBatchMs: lastBridgeStats ? lastBridgeStats.batchMsEma : 0,
    lastFrameBytes: lastBridgeStats ? lastBridgeStats.lastFrameBytes : 0,
    bridgeSamples,
  };
  window.__benchResult = result;
  hud.textContent = 'DONE (' + reason + ')\n' + JSON.stringify({
    totalMs: +totalMs.toFixed(0),
    cps: +cps.toFixed(0),
    pct8086: +result.pctOf8086.toFixed(1),
    idlePct: +result.idlePctOf8086.toFixed(1),
    idleFps: +result.idleEncodedPerSec.toFixed(1),
  }, null, 2);
  try { window.parent && window.parent.postMessage({ type:'bench-result', result }, '*'); } catch {}
}

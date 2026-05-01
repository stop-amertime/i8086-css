// player/calcite-img-bench.js
// Mirrors calcite-worker.js's shape exactly: classic worker (no module
// type — but we use dynamic import inside for the WASM), init via
// postMessage({type:'init', css}), tick via postMessage({type:'tick',
// count}), one tick per event-loop turn. No tight for-loop.

const BENCH_VERSION = 'bench-v2-pull-style';

let engine = null;
let wasmModule = null;
let tickTimings = [];

async function loadWasm() {
  const wasm = await import('/calcite/pkg/calcite_wasm.js');
  await wasm.default();
  return wasm;
}

self.onmessage = async function (event) {
  const { type, ...data } = event.data;
  try {
    switch (type) {
      case 'init': {
        if (!wasmModule) wasmModule = await loadWasm();
        engine = new wasmModule.CalciteEngine(data.css);
        self.postMessage({ type: 'log', msg: `[${BENCH_VERSION}] init: engine built` });
        tickTimings = [];
        self.postMessage({ type: 'ready' });
        break;
      }
      case 'tick': {
        const t0 = performance.now();
        engine.tick_batch(data.count || 50000);
        const dt = (performance.now() - t0) | 0;
        tickTimings.push(dt);
        if (tickTimings.length === 10) {
          const totalMs = tickTimings.reduce((a,b)=>a+b, 0);
          const cyc = engine.get_state_var('cycleCount') >>> 0;
          const hz = cyc / (totalMs / 1000);
          self.postMessage({ type: 'log',
            msg: `[${BENCH_VERSION}] 50k × 10: ${tickTimings.join(', ')} ms | cycleCount=${cyc} | ${(hz/1e6).toFixed(2)} MHz simulated` });
          tickTimings = [];
        }
        self.postMessage({ type: 'tick-result', dt });
        break;
      }
    }
  } catch (e) {
    self.postMessage({ type: 'log', msg: 'bench threw: ' + (e.message || e) });
  }
};

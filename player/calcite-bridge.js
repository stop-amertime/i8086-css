// player/calcite-bridge.js
// The calcite bridge: a dedicated worker spawned by build.html (and
// split.html) on page load. Hosts the calcite WASM engine against the
// cached cabinet, encodes each frame as JPEG, and ships the bytes over
// a MessagePort to the service worker, which fans them out into any
// active /_stream/fb multipart responses.
//
// This is the "output device" side of /player/calcite.html: when that
// page opens its <img> fetches /_stream/fb and the SW starts piping
// frames it's been getting from us.
//
// Lifetime: tied to the page that spawned the bridge. Close that tab
// and this worker dies; the runner freezes on its last frame.

// Classic worker — loaded via dynamic import inside boot() so the
// calcite-worker.js path is mirrored exactly. Module-type workers
// appeared to tick ~7x slower than classic on this machine (Chrome
// 147, 2026-04-21) despite loading the same WASM artifact. Until we
// understand why, ape what's known to be fast.
let initCalcite, CalciteEngine;

let engine = null;
let videoRegions = { text: null, gfx: null };
let fontAtlas = null;
let swPort = null;
let cachedCss = null;     // the cabinet CSS, read once at boot
let running = false;      // tick loop gate — true only while a viewer is watching

// JPEG encoder — OffscreenCanvas whose size tracks the active video mode.
let encCanvas = null;
let encCtx = null;
let encWidth = 0;
let encHeight = 0;
let encImageData = null;

// Frame pacing. We don't want to encode faster than the SW can push or
// the browser can decode. Cap at 60 fps wall-clock; one outstanding
// encode at a time; skip frames whose checksum matches the previous.
const MIN_FRAME_MS = 1000 / 60;
let lastFrameMs = 0;
let encodeInFlight = false;
let lastChecksum = -1;

// Calcite batch sizing — mirrors grid.html so the feel matches.
// Batch pacing — mirrors calcite.html's adapter. Start small (200
// cycles) and let the EMA grow batchCount until each tick hits
// ~TARGET_MS. For dense cabinets the steady state is a few thousand
// cycles per batch; for sparse ones it walks up to MAX. Hardcoding a
// large MIN starves the adapter and forces hundreds of milliseconds
// per batch on any cabinet calcite finds expensive.
const TARGET_MS = 14;
const EMA_ALPHA = 0.3;
const MIN_BATCH = 50;
const MAX_BATCH = 50000;
let batchCount = 200;
let batchMsEma = TARGET_MS;

// VGA 16-color palette for text-mode rasterisation (matches
// calcite-worker.js). Duplicated here to keep this worker self-contained.
const VGA_PALETTE_U32 = new Uint32Array([
  0xFF000000, 0xFFAA0000, 0xFF00AA00, 0xFFAAAA00,
  0xFF0000AA, 0xFFAA00AA, 0xFF0055AA, 0xFFAAAAAA,
  0xFF555555, 0xFFFF5555, 0xFF55FF55, 0xFFFFFF55,
  0xFF5555FF, 0xFFFF55FF, 0xFF55FFFF, 0xFFFFFFFF,
]);

const CYCLES_PER_FRAME = 68182; // 70 Hz at 4.77 MHz 8086 timebase

// ---------- Bootstrap ----------

// Canary — bump this when you change this file so you can confirm the
// browser is actually serving the new version. Shows up in every status
// line so it's impossible to miss in the console.
const BRIDGE_VERSION = 'v12-renamed';

async function boot() {
  postStatus(`bridge boot ${BRIDGE_VERSION}`);
  // 1. Load WASM — dynamic import from the same path calcite-worker.js
  //    uses, so any module-caching the browser does applies here too.
  const mod = await import('/calcite/pkg/calcite_wasm.js');
  initCalcite = mod.default;
  CalciteEngine = mod.CalciteEngine;
  await initCalcite();
  // 2. Fetch cabinet from SW cache. Keep the raw CSS so we can rebuild
  //    the engine from scratch every time a viewer connects.
  const r = await fetch('/cabinet.css');
  if (!r.ok) throw new Error(`cabinet fetch failed: ${r.status}`);
  cachedCss = await r.text();
  if (!cachedCss || cachedCss.trim().length === 0) {
    postStatus('No cabinet cached yet. Build one on this page, reopen the viewer after.');
    return;
  }
  // 3. Try to grab the VGA font for text modes.
  try {
    const fr = await fetch('/player/fonts/vga-8x16.bin');
    if (fr.ok) {
      const buf = new Uint8Array(await fr.arrayBuffer());
      if (buf.length === 4096) fontAtlas = buf;
    }
  } catch {}
  postStatus('Calcite bridge ready (waiting for viewer to connect)');
}


// Fresh machine. Called on every viewer connection — tears down the
// previous engine and builds a new one from the cabinet CSS. The CPU
// starts at the reset vector; BIOS splash plays; boot proceeds.
function resetMachine() {
  if (!cachedCss) return;
  // Drop the old engine. WASM-owned memory will be freed when GC runs;
  // the wasm-bindgen generated class has a `.free()` method if we need
  // to be aggressive about it.
  if (engine && typeof engine.free === 'function') {
    try { engine.free(); } catch {}
  }
  engine = new CalciteEngine(cachedCss);
  const videoJson = engine.detect_video();
  const parsed = JSON.parse(videoJson) || {};
  videoRegions = {
    text: parsed.text || null,
    gfx: parsed.gfx || null,
  };
  if (!videoRegions.text && !videoRegions.gfx) {
    videoRegions.text = { addr: 0xB8000, size: 4000, width: 80, height: 25 };
  }
  // Reset pacing + dedup state so the first frame after a restart
  // actually gets sent even if it happens to hash the same as the
  // last frame of the previous run.
  lastChecksum = -1;
  lastFrameMs = 0;
  encodeInFlight = false;
  batchCount = MIN_BATCH;
  batchMsEma = TARGET_MS;
  postStatus('machine reset; running');
  startStatsInterval();
}

function postStatus(msg) {
  // Status updates go to the tab that spawned us (build.html)
  // for debugging; they aren't surfaced to the calcite.html runner.
  self.postMessage({ type: 'status', message: msg });
}

// ---------- Tick loop ----------

function tickLoop() {
  if (!running || !engine) return;
  const batchStart = performance.now();
  try {
    engine.tick_batch(batchCount);
  } catch (e) {
    postStatus('engine error: ' + (e.message || String(e)));
    running = false;
    return;
  }
  const batchDt = performance.now() - batchStart;
  batchMsEma = batchMsEma * (1 - EMA_ALPHA) + batchDt * EMA_ALPHA;
  const ratio = Math.max(0.5, Math.min(2.0, TARGET_MS / batchMsEma));
  batchCount = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(batchCount * ratio)));

  maybeEmitFrame();

  // Yield back to the event loop so SW-port messages (kbd input) get
  // drained promptly. We use MessageChannel here rather than
  // setTimeout because build.html is a background tab while the
  // user watches calcite.html in the foreground, and Chrome
  // throttles setTimeout in background-tab-owned workers to ~1 Hz.
  // MessageChannel posts are macrotasks that are not subject to that
  // throttle, so the tick loop runs at full speed regardless of
  // which tab is in front.
  tickChannel.port1.postMessage(0);
}

const tickChannel = new MessageChannel();
tickChannel.port2.onmessage = () => tickLoop();

// ---------- Framebuffer extraction + encode ----------

function ensureEncoder(w, h) {
  if (encWidth === w && encHeight === h && encCanvas) return;
  encWidth = w;
  encHeight = h;
  encCanvas = new OffscreenCanvas(w, h);
  encCtx = encCanvas.getContext('2d');
  encImageData = encCtx.createImageData(w, h);
}

function maybeEmitFrame() {
  if (!swPort) return;
  if (encodeInFlight) return;
  const now = performance.now();
  if (now - lastFrameMs < MIN_FRAME_MS) return;

  const mode = engine.get_video_mode();
  const isGfxMode = mode === 0x13;

  let rgba = null;
  let w = 0, h = 0;
  if (isGfxMode && videoRegions.gfx) {
    const g = videoRegions.gfx;
    rgba = engine.read_framebuffer_rgba(g.addr, g.width, g.height);
    w = g.width; h = g.height;
  } else if (!isGfxMode && videoRegions.text && fontAtlas) {
    const t = videoRegions.text;
    w = t.width * 8;
    h = t.height * 16;
    const vram = engine.read_memory_range(t.addr, t.width * t.height * 2);
    rgba = new Uint8Array(w * h * 4);
    const cycles = engine.get_state_var('cycleCount') >>> 0;
    const bda = engine.read_memory_range(0x0450, 2);
    rasteriseText(vram, t.width, t.height, rgba, {
      cycleCount: cycles,
      cursorCol: bda[0],
      cursorRow: bda[1],
      cursorEnabled: true,
      blinkMode: true,
    });
  } else {
    return;
  }

  // No checksum-dedup. Encode and ship every frame. Rationale: if
  // the screen didn't change, we don't care about low fps — nothing
  // would move anyway. And checksum-ing the whole framebuffer every
  // tick is itself non-trivial work we'd rather not pay.

  // Encode.
  ensureEncoder(w, h);
  encImageData.data.set(rgba);
  encCtx.putImageData(encImageData, 0, 0);
  encodeInFlight = true;
  lastFrameMs = now;
  const encStart = performance.now();
  encCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    .then(async (blob) => {
      const encMs = performance.now() - encStart;
      const buf = await blob.arrayBuffer();
      frameCount++;
      totalEncodeMs += encMs;
      lastEncodeMs = encMs;
      lastFrameBytes = buf.byteLength;
      if (swPort) {
        swPort.postMessage({ type: 'frame', bytes: buf, width: w, height: h }, [buf]);
      }
    })
    .catch((e) => { postStatus('encode error: ' + e.message); })
    .finally(() => { encodeInFlight = false; });
}

let frameCount = 0;
let lastReportFrames = 0;
let totalEncodeMs = 0;
let lastEncodeMs = 0;
let lastFrameBytes = 0;
let statsIntervalId = null;
function startStatsInterval() {
  if (statsIntervalId) return;
  statsIntervalId = setInterval(() => {
    const delta = frameCount - lastReportFrames;
    lastReportFrames = frameCount;
    postStatus(
      `[${BRIDGE_VERSION}] ${delta} fps | total ${frameCount} | enc ${lastEncodeMs.toFixed(1)}ms ` +
      `| size ${(lastFrameBytes/1024).toFixed(1)}KB ` +
      `| batch ${batchMsEma.toFixed(1)}ms (${batchCount} cyc) ` +
      `| mode=0x${engine ? engine.get_video_mode().toString(16) : '?'}`
    );
  }, 1000);
}

// ---------- Text rasteriser (identical to calcite-worker.js) ----------

function rasteriseText(buf, cols, rows, outRGBA, opts) {
  const pxW = cols * 8;
  const out32 = new Uint32Array(outRGBA.buffer, outRGBA.byteOffset, (outRGBA.byteLength / 4) | 0);
  const frame = Math.floor((opts?.cycleCount || 0) / CYCLES_PER_FRAME);
  const attrBlinkOn  = (frame & 16) === 0;
  const cursorBlinkOn = (frame & 8) === 0;
  const blinkMode = opts?.blinkMode !== false;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const off = (cy * cols + cx) * 2;
      const ch = buf[off];
      const attr = buf[off + 1];
      let fgIdx = attr & 0x0F;
      let bgIdx = (attr >> 4) & 0x0F;
      if (blinkMode && (attr & 0x80)) {
        bgIdx &= 0x07;
        if (!attrBlinkOn) fgIdx = bgIdx;
      }
      const fg = VGA_PALETTE_U32[fgIdx];
      const bg = VGA_PALETTE_U32[bgIdx];
      const glyphBase = ch * 16;
      const pxX = cx * 8;
      for (let gy = 0; gy < 16; gy++) {
        const row = fontAtlas[glyphBase + gy];
        const outRow = (cy * 16 + gy) * pxW + pxX;
        out32[outRow + 0] = (row & 0x80) ? fg : bg;
        out32[outRow + 1] = (row & 0x40) ? fg : bg;
        out32[outRow + 2] = (row & 0x20) ? fg : bg;
        out32[outRow + 3] = (row & 0x10) ? fg : bg;
        out32[outRow + 4] = (row & 0x08) ? fg : bg;
        out32[outRow + 5] = (row & 0x04) ? fg : bg;
        out32[outRow + 6] = (row & 0x02) ? fg : bg;
        out32[outRow + 7] = (row & 0x01) ? fg : bg;
      }
    }
  }
  if (opts?.cursorEnabled && cursorBlinkOn
      && opts.cursorRow >= 0 && opts.cursorRow < rows
      && opts.cursorCol >= 0 && opts.cursorCol < cols) {
    const cx = opts.cursorCol, cy = opts.cursorRow;
    const attr = buf[(cy * cols + cx) * 2 + 1];
    const cursorColor = VGA_PALETTE_U32[attr & 0x0F];
    const startScan = 13, endScan = 14;
    const pxX = cx * 8;
    for (let gy = startScan; gy <= endScan; gy++) {
      const outRow = (cy * 16 + gy) * pxW + pxX;
      for (let k = 0; k < 8; k++) out32[outRow + k] = cursorColor;
    }
  }
}

// ---------- Main-thread messages ----------

self.onmessage = (ev) => {
  const d = ev.data;
  if (!d || !d.type) return;
  if (d.type === 'sw-port' && ev.ports && ev.ports[0]) {
    swPort = ev.ports[0];
    swPort.onmessage = (m) => {
      const mm = m.data;
      if (!mm || !mm.type) return;
      if (mm.type === 'kbd' && engine) {
        engine.set_keyboard(mm.key | 0);
      } else if (mm.type === 'viewer-connected') {
        // New viewer opened the stream. Re-fetch the cabinet (in case
        // a newer one was built since we last loaded), reset the
        // machine, and start running — they want to watch it boot.
        (async () => {
          try {
            const r = await fetch('/cabinet.css');
            if (r.ok) {
              const css = await r.text();
              if (css && css.trim().length > 0) cachedCss = css;
              postStatus('[fetch] cabinet bytes=' + (cachedCss?.length || 0));
            }
          } catch {}
          resetMachine();
          if (engine) {
            running = true;
            tickLoop();
          } else {
            postStatus('no cabinet to run; build one on this page and reopen the viewer');
          }
        })();
      } else if (mm.type === 'viewer-disconnected') {
        // No one watching — stop spinning the CPU. The engine is kept
        // around so a fast reconnect doesn't have to rebuild it, but
        // the next viewer-connected will reset it anyway.
        running = false;
      }
    };
  }
};

boot().catch((e) => postStatus('boot failed: ' + (e.message || String(e))));

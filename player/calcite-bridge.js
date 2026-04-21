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
// Per-phase EMAs — tick = engine.tick_batch time only; emit = everything
// after (read VRAM + rasterise text + build BMP + postMessage).
let tickOnlyMsEma = 0;
let emitMsEma = 0;

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
const BRIDGE_VERSION = 'v19-instr';

// Frame codec. Each convertToBlob call reads this, so you can swap
// codecs live in devtools without reloading. Trade-offs:
//   jpeg@0.85  — default before v13. Fast (~5ms/640x400), small, but
//                visible chroma-subsampling smearing on text/pixel art.
//   webp@0.95  — similar encode cost, much milder artifacts. Default.
//   webp@1     — lossless WebP. Perfect pixels, ~15–25ms/frame.
//   png        — lossless, slowest (~30–80ms/frame). Sharpest possible.
//
// Switch live: self.__frameCodec = { type:'image/png' }; etc.
let frameCodec = { type: 'image/webp', quality: 0.95 };
// Expose on the worker scope so it's inspectable and swappable from
// the page via `__calciteBridge.postMessage(...)` pattern, or from
// devtools after attaching to this worker.
Object.defineProperty(self, '__frameCodec', {
  get() { return frameCodec; },
  set(v) {
    if (v && typeof v === 'object' && typeof v.type === 'string') {
      frameCodec = v;
      postStatus(`codec → ${v.type}${v.quality != null ? '@' + v.quality : ''}`);
    }
  },
});

async function boot() {
  postStatus(`bridge boot ${BRIDGE_VERSION}`);
  // 1. Load WASM — dynamic import from the same path calcite-worker.js
  //    uses, so any module-caching the browser does applies here too.
  const mod = await import('/calcite/pkg/calcite_wasm.js');
  initCalcite = mod.default;
  CalciteEngine = mod.CalciteEngine;
  await initCalcite();
  // 2. Try to grab the VGA font for text modes. (Before cabinet
  //    compile so it overlaps with any in-flight build.)
  try {
    const fr = await fetch('/player/fonts/vga-8x16.bin');
    if (fr.ok) {
      const buf = new Uint8Array(await fr.arrayBuffer());
      if (buf.length === 4096) fontAtlas = buf;
    }
  } catch {}
  // 3. Listen for cabinet-ready broadcasts from the builder. Fires
  //    whenever storage.saveCabinet() lands a new cabinet in cache.
  //    On fire we fetch the bytes and compile. This keeps the bridge
  //    passive until there's actually something to run.
  try {
    const bc = new BroadcastChannel('cssdos-cabinet');
    bc.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'cabinet-ready') {
        compileCabinet().catch((e) => postStatus('compile error: ' + (e.message || e)));
      }
    };
  } catch {}
  // 4. If a cabinet is ALREADY in cache (page reload, second visit),
  //    compile it now without waiting for a fresh build.
  try {
    const r = await fetch('/cabinet.css');
    if (r.ok) {
      const css = await r.text();
      if (css && css.trim().length > 0 && !css.startsWith('/* CSS-DOS: no cabinet')) {
        cachedCss = css;
        await compileCabinet();
        return;
      }
    }
  } catch {}
  postStatus('waiting for a cabinet to be built...');
}

// Parse + compile cached CSS into a CalciteEngine. Idempotent on
// cabinet content — if the bytes match what we've already compiled
// (same cachedCss string), no-op. Called from boot() on initial load
// and from the cabinet-ready broadcast listener.
async function compileCabinet() {
  // Re-read the cache so we always compile the freshest bytes.
  const r = await fetch('/cabinet.css');
  if (!r.ok) { postStatus('cabinet fetch failed: ' + r.status); return; }
  const css = await r.text();
  if (!css || css.trim().length === 0 || css.startsWith('/* CSS-DOS: no cabinet')) {
    postStatus('cabinet fetch returned empty placeholder');
    return;
  }
  if (engine && css === cachedCss) {
    // Already compiled this exact cabinet. Still refresh videoRegions
    // in case we missed a detect_video() invalidation; cheap.
    return;
  }
  cachedCss = css;
  if (engine && typeof engine.free === 'function') {
    try { engine.free(); } catch {}
  }
  engine = null;
  postStatus('compiling cabinet (' + (css.length / 1024 / 1024).toFixed(1) + ' MB)...');
  const t0 = performance.now();
  engine = new CalciteEngine(css);
  const compileMs = performance.now() - t0;
  const videoJson = engine.detect_video();
  const parsed = JSON.parse(videoJson) || {};
  videoRegions = {
    text: parsed.text || null,
    gfx: parsed.gfx || null,
  };
  if (!videoRegions.text && !videoRegions.gfx) {
    videoRegions.text = { addr: 0xB8000, size: 4000, width: 80, height: 25 };
  }
  postStatus(`cabinet compiled in ${(compileMs / 1000).toFixed(1)}s (ready)`);
}


// Reset the machine to its power-on state. Called on every viewer
// connection — the engine is already compiled (in boot() or a
// previous viewer-connect), so this only resets runtime state via
// engine.reset(). Cheap. The CPU restarts at the reset vector;
// BIOS splash plays; boot proceeds.
function resetMachine() {
  if (!engine) {
    // No engine yet — the cabinet either hasn't been fetched, or a
    // newer cabinet has since been built. (Re)compile now.
    if (!cachedCss) return;
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
  } else if (typeof engine.reset === 'function') {
    // Fast path — state-only reset, no recompile.
    engine.reset();
  } else {
    // Old WASM without reset(). Fall back to rebuild.
    if (typeof engine.free === 'function') {
      try { engine.free(); } catch {}
    }
    engine = new CalciteEngine(cachedCss);
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
  const tickEnd = performance.now();
  const batchDt = tickEnd - batchStart;
  batchMsEma = batchMsEma * (1 - EMA_ALPHA) + batchDt * EMA_ALPHA;
  const ratio = Math.max(0.5, Math.min(2.0, TARGET_MS / batchMsEma));
  batchCount = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(batchCount * ratio)));

  // Per-batch profiling. Tick time is "useful" work; emit time is "render
  // overhead". If emit >> tick, splitting to two workers is high-value.
  // We track an EMA of each so the stats line shows steady-state split.
  tickOnlyMsEma = tickOnlyMsEma * (1 - EMA_ALPHA) + batchDt * EMA_ALPHA;
  const emitStart = tickEnd;
  maybeEmitFrame();
  const emitDt = performance.now() - emitStart;
  emitMsEma = emitMsEma * (1 - EMA_ALPHA) + emitDt * EMA_ALPHA;

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

// ---------- Framebuffer extraction + BMP emit ----------
//
// No OffscreenCanvas, no convertToBlob. We build a BMP frame in-memory
// by writing a BITMAPV4HEADER (top-down via negative height, BI_BITFIELDS
// with RGBA channel masks) directly over the RGBA bytes. Chrome decodes
// this natively in <img>. The only per-frame work is a single Uint8Array
// allocation + one .set() of the pixels.
//
// Why not JPEG/WebP: encoding cost (~20-30 ms) was dominating the pipeline.
// BMP costs ~0 ms to "encode"; the trade is wire size (~512 KB/frame for
// 320x200 gfx, ~2 MB for 640x400 text-through-font). The SW→<img> path
// is entirely in-process so wire size is cheap.
//
// Header layout (122 bytes total):
//   [0..14)   BITMAPFILEHEADER      "BM" + file size + pixel offset
//   [14..122) BITMAPV4HEADER       size, geometry, bitfield masks, colourspace

const BMP_HEADER_SIZE = 14 + 108; // fileheader + V4
let bmpCachedHeader = null;
let bmpCachedGeom = { w: 0, h: 0 };

function buildBmpHeader(w, h) {
  if (bmpCachedHeader && bmpCachedGeom.w === w && bmpCachedGeom.h === h) {
    return bmpCachedHeader;
  }
  const pixelBytes = w * h * 4;
  const fileSize = BMP_HEADER_SIZE + pixelBytes;
  const buf = new ArrayBuffer(BMP_HEADER_SIZE);
  const dv = new DataView(buf);
  // BITMAPFILEHEADER
  dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);         // 'BM'
  dv.setUint32(2, fileSize, true);                     // bfSize
  dv.setUint32(6, 0, true);                            // reserved
  dv.setUint32(10, BMP_HEADER_SIZE, true);             // bfOffBits
  // BITMAPV4HEADER
  dv.setUint32(14, 108, true);                         // biSize
  dv.setInt32(18, w, true);                            // biWidth
  dv.setInt32(22, -h, true);                           // biHeight (negative = top-down)
  dv.setUint16(26, 1, true);                           // biPlanes
  dv.setUint16(28, 32, true);                          // biBitCount
  dv.setUint32(30, 3, true);                           // biCompression = BI_BITFIELDS
  dv.setUint32(34, pixelBytes, true);                  // biSizeImage
  dv.setInt32(38, 2835, true);                         // biXPelsPerMeter (72 dpi)
  dv.setInt32(42, 2835, true);                         // biYPelsPerMeter
  dv.setUint32(46, 0, true);                           // biClrUsed
  dv.setUint32(50, 0, true);                           // biClrImportant
  // Channel masks: little-endian RGBA-in-memory ⇒ byte 0 = R, byte 1 = G, etc.
  dv.setUint32(54, 0x000000FF, true);                  // R mask
  dv.setUint32(58, 0x0000FF00, true);                  // G mask
  dv.setUint32(62, 0x00FF0000, true);                  // B mask
  dv.setUint32(66, 0xFF000000, true);                  // A mask
  dv.setUint32(70, 0x57696E20, true);                  // CSType = 'Win ' (sRGB)
  // Remaining 36 bytes of BITMAPV4HEADER (endpoints + gammas) zeroed by default.
  bmpCachedHeader = new Uint8Array(buf);
  bmpCachedGeom = { w, h };
  return bmpCachedHeader;
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

  // Assemble BMP: header + RGBA pixels in one buffer. We own `rgba` for
  // text mode (we just allocated it); for gfx mode it's a wasm-memory
  // view we must copy out of. Single combined allocation is cleaner.
  const header = buildBmpHeader(w, h);
  const pixelBytes = w * h * 4;
  const fileBytes = new Uint8Array(BMP_HEADER_SIZE + pixelBytes);
  fileBytes.set(header, 0);
  fileBytes.set(rgba, BMP_HEADER_SIZE);

  encodeInFlight = true;
  lastFrameMs = now;
  const encStart = performance.now();
  // No async encode — just the assembly cost above. Measured anyway
  // so the stats line keeps its meaning.
  lastEncodeMs = performance.now() - encStart;
  frameCount++;
  lastFrameBytes = fileBytes.byteLength;
  if (swPort) {
    // Transfer the underlying ArrayBuffer so the SW owns it after post.
    const buf = fileBytes.buffer;
    swPort.postMessage({ type: 'frame', bytes: buf, width: w, height: h, mime: 'image/bmp' }, [buf]);
  }
  encodeInFlight = false;
}

let frameCount = 0;
let lastReportFrames = 0;
let totalEncodeMs = 0;
let lastEncodeMs = 0;
let lastFrameBytes = 0;
let statsIntervalId = null;

// Bench-stats channel. Anyone on the same origin can subscribe — the bench
// page uses this to sample cycles/frames/encodeMs at 1 Hz.
let benchChannel = null;
try { benchChannel = new BroadcastChannel('cssdos-bridge-stats'); } catch {}
const bridgeStartMs = performance.now();

function startStatsInterval() {
  if (statsIntervalId) return;
  statsIntervalId = setInterval(() => {
    const delta = frameCount - lastReportFrames;
    lastReportFrames = frameCount;
    const cycles = engine ? (engine.get_state_var('cycleCount') >>> 0) : 0;
    postStatus(
      `[${BRIDGE_VERSION}] ${delta} fps | total frames ${frameCount} | cycles ${cycles.toLocaleString()} ` +
      `| tick ${tickOnlyMsEma.toFixed(1)}ms emit ${emitMsEma.toFixed(1)}ms ` +
      `| size ${(lastFrameBytes/1024).toFixed(0)}KB ` +
      `| batch ${batchMsEma.toFixed(1)}ms (${batchCount} cyc) ` +
      `| mode=0x${engine ? engine.get_video_mode().toString(16) : '?'}`
    );
    if (benchChannel) {
      try {
        benchChannel.postMessage({
          type: 'bridge-stats',
          wallMs: performance.now() - bridgeStartMs,
          cycles,
          framesEncoded: frameCount,
          lastEncodeMs,
          lastFrameBytes,
          batchCount,
          batchMsEma,
          tickOnlyMsEma,
          emitMsEma,
          fpsWindow: delta,
          videoMode: engine ? engine.get_video_mode() : null,
        });
      } catch {}
    }
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
  if (d.type === 'set-codec') {
    // Let the page swap codecs at runtime without reloading. Called via
    // window.__calciteBridge.postMessage({type:'set-codec', codec: {...}}).
    self.__frameCodec = d.codec;
    return;
  }
  if (d.type === 'sw-port' && ev.ports && ev.ports[0]) {
    swPort = ev.ports[0];
    swPort.onmessage = (m) => {
      const mm = m.data;
      if (!mm || !mm.type) return;
      if (mm.type === 'kbd' && engine) {
        engine.set_keyboard(mm.key | 0);
      } else if (mm.type === 'viewer-connected') {
        // New viewer opened the stream. The engine is (usually) already
        // compiled — compileCabinet() ran on boot if a cabinet was
        // cached, or ran via the cabinet-ready broadcast if one got
        // built since. Fast path here: engine.reset(), start running.
        // If no engine yet the user is watching before a cabinet's
        // been built; we can't show anything.
        (async () => {
          // Defensive re-fetch: if a newer cabinet landed between the
          // broadcast and this message, recompile. Usually no-op.
          await compileCabinet().catch(() => {});
          resetMachine();
          if (engine) {
            running = true;
            tickLoop();
          } else {
            postStatus('no cabinet to run; build one first');
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

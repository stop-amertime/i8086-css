// player/calcite-bridge.js
// The calcite bridge: a dedicated module worker spawned by build.html
// (and split.html) on page load. Hosts the calcite WASM engine against
// the cached cabinet, assembles each frame as a BMP, and ships the
// bytes over a MessagePort to the service worker, which fans them out
// into any active /_stream/fb multipart responses.
//
// This is the "output device" side of /player/calcite.html: when that
// page opens its <img> fetches /_stream/fb 
//
// Lifetime: tied to the page that spawned the bridge. Close that tab
// and this worker dies; the runner freezes on its last frame.
//
// The video-mode decoder/rasteriser module `video-modes.mjs` lives in
// the sibling calcite repo (next to calcite-worker.js, which imports it
// via `./video-modes.mjs`). CSS-DOS reaches it via the dev-server alias
// `/calcite/` → `../calcite/web/` declared in web/scripts/dev.mjs. If
// that alias is absent the import fails at boot with 404 — not a silent
// breakage. The wasm module is reached the same way at `/calcite/pkg/`.

import { pickMode, decodeCga4, rasteriseText } from '/calcite/video-modes.mjs';

let initCalcite, CalciteEngine;

let engine = null;
let fontAtlas = null;
let swPort = null;
let cachedCss = null;     // the cabinet CSS, read once at boot
let running = false;      // tick loop gate — true only while a viewer is watching


// Batch pacing — start small (200 cycles) and let the EMA grow
// batchCount until each tick hits ~TARGET_MS. For dense cabinets the
// steady state is a few thousand cycles per batch; for sparse ones it
// walks up to MAX. Hardcoding a large MIN starves the adapter and forces
// hundreds of milliseconds per batch on any cabinet calcite finds expensive.
const TARGET_MS = 14;
const EMA_ALPHA = 0.3;
const MIN_BATCH = 50;
const MAX_BATCH = 50000;
let batchCount = 200;
let batchMsEma = TARGET_MS;

// ---------- Bootstrap ----------

// Canary — bump this when you change this file so you can confirm the
// browser is actually serving the new version. Shows up in every status
// line so it's impossible to miss in the console.
const BRIDGE_VERSION = 'v24';

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
    // Already compiled this exact cabinet.
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
  // Reset pacing so the adapter relearns for the new run.
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

// ---------- Framebuffer extraction + BMP emit ----------
//
// No OffscreenCanvas, no convertToBlob. We build a BMP frame in-memory
// by writing a BITMAPV4HEADER (top-down via negative height, BI_BITFIELDS
// with RGBA channel masks) directly over the RGBA bytes. Chrome decodes
// this natively in <img>. The only per-frame work is a single Uint8Array
// allocation + one .set() of the pixels.
//
// Why not JPEG/WebP: encoding cost (~20-30 ms) was dominating the pipeline.
// BMP costs ~0 ms to "encode"; the trade is wire size (~256 KB/frame for
// 320x200, ~2 MB for 640x400 text-through-font). The SW→<img> path is
// entirely in-process so wire size is cheap.
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

  const modeByte = engine.get_video_mode();
  const mode = pickMode(modeByte);
  if (!mode) return;       // unsupported mode — nothing to render
  const w = mode.width, h = mode.height;
  let rgba = null;
  if (mode.kind === 'mode13') {
    rgba = engine.read_framebuffer_rgba(mode.vramAddr, w, h);
  } else if (mode.kind === 'cga4') {
    const vram = engine.read_memory_range(mode.vramAddr, 0x4000);
    const palReg = engine.read_memory_range(0x04F3, 1)[0] | 0;
    rgba = new Uint8Array(w * h * 4);
    decodeCga4(vram, palReg, rgba);
  } else if (mode.kind === 'text' && fontAtlas) {
    const vram = engine.read_memory_range(mode.vramAddr, mode.textCols * mode.textRows * 2);
    rgba = new Uint8Array(w * h * 4);
    const cycles = engine.get_state_var('cycleCount') >>> 0;
    const bda = engine.read_memory_range(0x0450, 2);
    rasteriseText(vram, mode.textCols, mode.textRows, rgba, fontAtlas, {
      cycleCount: cycles,
      cursorCol: bda[0],
      cursorRow: bda[1],
      cursorEnabled: true,
      blinkMode: true,
    });
  } else {
    return;
  }

  // Assemble BMP: header + RGBA pixels in one buffer. For text mode we
  // own `rgba` (just allocated); for gfx mode it's a wasm-memory view
  // we must copy out of. Single combined allocation is cleaner.
  const header = buildBmpHeader(w, h);
  const pixelBytes = w * h * 4;
  const fileBytes = new Uint8Array(BMP_HEADER_SIZE + pixelBytes);
  fileBytes.set(header, 0);
  fileBytes.set(rgba, BMP_HEADER_SIZE);

  frameCount++;
  lastFrameBytes = fileBytes.byteLength;
  // Transfer the underlying ArrayBuffer so the SW owns it after post.
  const buf = fileBytes.buffer;
  swPort.postMessage({ type: 'frame', bytes: buf, width: w, height: h, mime: 'image/bmp' }, [buf]);
}

let frameCount = 0;
let lastReportFrames = 0;
let lastFrameBytes = 0;
let statsIntervalId = null;

// Bench-stats channel. Anyone on the same origin can subscribe to
// 'cssdos-bridge-stats' for 1 Hz samples of cycles/frames/batch — the
// bench page uses this. Publishing it unconditionally is cheap (no
// listeners = no-op postMessage).
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
      `[${BRIDGE_VERSION}] ${delta} fps | cycles ${cycles.toLocaleString()} ` +
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
          lastFrameBytes,
          batchCount,
          batchMsEma,
          fpsWindow: delta,
          videoMode: engine ? engine.get_video_mode() : null,
        });
      } catch {}
    }
  }, 1000);
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

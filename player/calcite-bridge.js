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

import { pickMode, decodeCga4, decodeCga2, rasteriseText, modeName } from '/calcite/video-modes.mjs';

// Silence the calcite WASM's info/log/debug chatter (it emits a handful of
// lines per parse/compile + periodic informational logs). We keep warn/error
// so genuine problems still surface. Done at module top so it applies before
// the WASM init below can fire any of its startup messages.
{
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.debug = noop;
}

let initCalcite, CalciteEngine;

let engine = null;
let fontAtlas = null;
let swPort = null;
let running = false;      // tick loop gate — true only while a viewer is watching

// Lazy-mode holding pen: when the build tab posts a 'cabinet-blob-lazy'
// we stash the Blob here and defer parse/compile until the first viewer
// connects. Cleared after it's consumed. In eager mode this stays null.
let pendingLazyBlob = null;


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
const BRIDGE_VERSION = 'v28-lazy-toggle';

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
  postStatus('waiting for a cabinet to be built...');
}

// Parse + compile raw cabinet bytes into a CalciteEngine. The ArrayBuffer
// comes from awaiting `blob.arrayBuffer()` on the Blob that build.js posts
// to us — all off the main thread, no SW round-trip, no JS-string
// intermediate.
async function compileCabinetBytes(arrayBuffer) {
  if (engine && typeof engine.free === 'function') {
    try { engine.free(); } catch {}
  }
  engine = null;
  const bytes = new Uint8Array(arrayBuffer);
  postStatus('compiling cabinet (' + (bytes.length / 1024 / 1024).toFixed(1) + ' MB)...');
  const t0 = performance.now();
  engine = CalciteEngine.new_from_bytes(bytes);
  const compileMs = performance.now() - t0;
  postStatus(`cabinet compiled in ${(compileMs / 1000).toFixed(1)}s (ready)`);
}


// Reset the machine to its power-on state. Called on every viewer
// connection — the engine is already compiled, so this only resets
// runtime state via engine.reset(). Cheap. The CPU restarts at the
// reset vector; BIOS splash plays; boot proceeds.
function resetMachine() {
  if (!engine) return;
  engine.reset();
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

// Debug ring buffer — accumulates short one-line summaries from
// maybeEmitFrame and flushes them at ~1 Hz via postStatus so you can
// see exactly what the bridge decided each frame without flooding.
let _dbgLast = '';
let _dbgSame = 0;
function dbgFrame(line) {
  if (line === _dbgLast) { _dbgSame++; return; }
  if (_dbgSame > 0) postStatus(`  (repeated ${_dbgSame}x) ${_dbgLast}`);
  _dbgSame = 0;
  _dbgLast = line;
  postStatus(line);
}

// Mode-history log. Whenever the active mode, the last-requested mode
// (0x04F2 shadow, written by corduroy on every INT 10h AH=00h), or the
// CGA palette register (0x04F3 shadow) changes, emit a one-line trace
// with the current cycle count. Lets us see exactly what video state the
// guest program is driving without wiring a full tracer.
let _lastActiveMode = -1;
let _lastReqMode = -1;
let _lastPalReg = -1;
function traceVideoState(activeMode, reqMode, palReg) {
  const cycles = engine.get_state_var('cycleCount') >>> 0;
  if (activeMode !== _lastActiveMode) {
    const name = modeName(activeMode);
    postStatus(`[video @cyc ${cycles.toLocaleString()}] active mode → 0x${activeMode.toString(16).padStart(2,'0')} (${name})`);
    _lastActiveMode = activeMode;
  }
  if (reqMode !== _lastReqMode && reqMode !== 0) {
    const name = modeName(reqMode);
    const remapped = reqMode !== activeMode ? ` — REMAPPED (active=0x${activeMode.toString(16)})` : '';
    postStatus(`[video @cyc ${cycles.toLocaleString()}] requested → 0x${reqMode.toString(16).padStart(2,'0')} (${name})${remapped}`);
    _lastReqMode = reqMode;
  }
  if (palReg !== _lastPalReg) {
    const bg = palReg & 0x0F;
    const intensity = (palReg >> 4) & 1;
    const palSet = (palReg >> 5) & 1;
    postStatus(`[video @cyc ${cycles.toLocaleString()}] pal-reg 0x04F3 → 0x${palReg.toString(16).padStart(2,'0')} (bg=${bg} intensity=${intensity} palette=${palSet})`);
    _lastPalReg = palReg;
  }
}

function maybeEmitFrame() {
  if (!swPort) return;

  const modeByte = engine.get_video_mode();
  const reqMode = engine.get_requested_video_mode ? engine.get_requested_video_mode() : 0;
  const palReg = engine.read_memory_range(0x04F3, 1)[0] | 0;
  traceVideoState(modeByte, reqMode, palReg);

  const mode = pickMode(modeByte);
  if (!mode) {
    dbgFrame(`frame: mode=0x${modeByte.toString(16)} pickMode=null — skipping`);
    return;
  }
  const w = mode.width, h = mode.height;
  let rgba = null;
  if (mode.kind === 'mode13') {
    rgba = engine.read_framebuffer_rgba(mode.vramAddr, w, h);
    dbgFrame(`frame: mode=0x${modeByte.toString(16)} kind=mode13 ${w}x${h} @0x${mode.vramAddr.toString(16)} rgba[0..4]=${[rgba[0],rgba[1],rgba[2],rgba[3]].join(',')}`);
  } else if (mode.kind === 'cga4') {
    const vram = engine.read_memory_range(mode.vramAddr, 0x4000);
    rgba = new Uint8Array(w * h * 4);
    decodeCga4(vram, palReg, rgba, { mono: !!mode.mono });
    // Count non-zero bytes to tell a "blank VRAM" frame from a "decoder
    // is eating pixels" frame. Also sample a few offsets so we can see
    // whether the game is writing even-plane (0..0x1FFF) vs odd-plane
    // (0x2000..0x3FFF) vs both.
    let nzEven = 0, nzOdd = 0;
    for (let i = 0; i < 0x2000; i++) if (vram[i]) nzEven++;
    for (let i = 0x2000; i < 0x4000; i++) if (vram[i]) nzOdd++;
    dbgFrame(`frame: mode=0x${modeByte.toString(16)} kind=cga4 pal=0x${palReg.toString(16)} nz-even=${nzEven} nz-odd=${nzOdd} vram[0..4]=${Array.from(vram.slice(0,4)).join(',')}`);
  } else if (mode.kind === 'cga2') {
    // CGA 640x200x2 (hires mono): same 16 KB aperture and even/odd plane
    // split as mode 0x04, but 1 bpp and 640 pixels wide.
    const vram = engine.read_memory_range(mode.vramAddr, 0x4000);
    rgba = new Uint8Array(w * h * 4);
    decodeCga2(vram, palReg, rgba);
    dbgFrame(`frame: mode=0x${modeByte.toString(16)} kind=cga2 pal=0x${palReg.toString(16)} vram[0..4]=${Array.from(vram.slice(0,4)).join(',')}`);
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
    // Count non-zero, non-space chars in text VRAM so we can tell if
    // the kernel has written anything.
    let nonEmpty = 0;
    for (let i = 0; i < vram.length; i += 2) {
      if (vram[i] !== 0 && vram[i] !== 0x20) nonEmpty++;
    }
    // First row as ASCII (non-printables → '.').
    let row0 = '';
    for (let c = 0; c < mode.textCols && c < 40; c++) {
      const ch = vram[c * 2];
      row0 += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : '.';
    }
    dbgFrame(`frame: mode=0x${modeByte.toString(16)} kind=text ${mode.textCols}x${mode.textRows} chars=${nonEmpty} row0="${row0}"`);
  } else if (mode.kind === 'text' && !fontAtlas) {
    dbgFrame(`frame: mode=0x${modeByte.toString(16)} kind=text — SKIPPED (no fontAtlas)`);
    return;
  } else {
    dbgFrame(`frame: mode=0x${modeByte.toString(16)} kind=${mode.kind} — unhandled, skipping`);
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
  if (d.type === 'cabinet-blob' && d.blob) {
    // Eager: compile NOW, in the background, off the main thread.
    pendingLazyBlob = null;
    (async () => {
      try {
        const buf = await d.blob.arrayBuffer();
        await compileCabinetBytes(buf);
      } catch (e) {
        postStatus('compile error: ' + (e.message || e));
      }
    })();
    return;
  }
  if (d.type === 'cabinet-blob-lazy' && d.blob) {
    // Lazy: hold the blob; compile on first viewer-connect. Drop any
    // previously-compiled engine so the next viewer sees the new cabinet.
    pendingLazyBlob = d.blob;
    if (engine && typeof engine.free === 'function') {
      try { engine.free(); } catch {}
    }
    engine = null;
    postStatus('cabinet received (lazy); will compile when player opens');
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
        // New viewer opened the stream. Two entry paths:
        //  - Eager-mode build: the engine is already compiled. We just
        //    reset runtime state and start ticking — Play is instant.
        //  - Lazy-mode build: we're still holding the blob. Compile it
        //    now (the player tab shows "compiling..." until we're done).
        //  - No cabinet at all: nothing to show.
        (async () => {
          if (!engine && pendingLazyBlob) {
            try {
              const blob = pendingLazyBlob;
              pendingLazyBlob = null;
              const buf = await blob.arrayBuffer();
              await compileCabinetBytes(buf);
            } catch (e) {
              postStatus('compile error: ' + (e.message || e));
              return;
            }
          }
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

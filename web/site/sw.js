// web/site/sw.js
// Service worker for the CSS-DOS web version.
//
// Two jobs:
//
// 1. /cabinet.css — serve from Cache Storage. The browser-side builder
//    writes into this cache; the player reads a fixed URL.
//
// 2. /_stream/fb and /_kbd — the calcite-bridge pipeline. When a page
//    registers a MessagePort with us ({type:'register-calcite-bridge'}),
//    we route /_stream/fb fetches into a multipart/x-mixed-replace
//    response whose body is fed by BMP frames that arrive over the
//    port, and we forward /_kbd?key=... submissions to the bridge.
//    This lets player/calcite.html be a pure HTML+CSS runner: the
//    <img src="/_stream/fb"> pulls a live stream with no page-side JS.
//
// The cache name must match web/browser-builder/storage.mjs.

const CACHE_NAME = 'cssdos-cabinets-v2';
const LEGACY_CACHE_NAMES = ['cssdos-cabinets-v1'];
const CABINET_URL = '/cabinet.css';
const STREAM_URL = '/_stream/fb';
const KBD_URL = '/_kbd';

// The single bridge MessagePort. Only one tab can be the bridge at a
// time; if a second registers, it replaces the first. The previous
// bridge's streams will then starve (fine — its frames stop arriving).
let bridgePort = null;

// Active stream responses. Each entry is a ReadableStream default
// controller that we push multipart parts into. When a frame arrives
// from the bridge we fan it out to every active controller.
const streamControllers = new Set();

// Multipart boundary — must match the Content-Type header below.
const BOUNDARY = 'cssdoscalciteframe';
const ENC = new TextEncoder();

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await Promise.all(
      LEGACY_CACHE_NAMES.map((name) => caches.delete(name).catch(() => false))
    );
    await self.clients.claim();
  })());
});

// Messages from any client page. The bridge tab sends us a MessagePort
// at registration; subsequent frames flow over that port.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;
  if (data.type === 'register-calcite-bridge' && event.ports && event.ports[0]) {
    if (bridgePort) {
      try { bridgePort.close(); } catch {}
    }
    bridgePort = event.ports[0];
    bridgePort.onmessage = handleBridgeMessage;
    bridgePort.postMessage({ type: 'sw-ready' });
  }
});

function handleBridgeMessage(ev) {
  const m = ev.data;
  if (!m || !m.type) return;
  if (m.type === 'frame' && m.bytes) {
    broadcastFrame(m.bytes, m.mime || 'image/bmp');
  }
}

function broadcastFrame(frameBuffer, mime) {
  if (streamControllers.size === 0) return;
  const bytes = new Uint8Array(frameBuffer);
  const header = ENC.encode(
    `--${BOUNDARY}\r\n` +
    `Content-Type: ${mime}\r\n` +
    `Content-Length: ${bytes.byteLength}\r\n\r\n`
  );
  const trailer = ENC.encode(`\r\n`);
  for (const controller of streamControllers) {
    try {
      controller.enqueue(header);
      controller.enqueue(bytes);
      controller.enqueue(trailer);
    } catch (e) {
      // Controller closed underneath us (client disconnected).
      streamControllers.delete(controller);
    }
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === CABINET_URL) {
    event.respondWith(handleCabinet());
    return;
  }
  if (url.pathname === STREAM_URL) {
    event.respondWith(handleStream());
    return;
  }
  if (url.pathname === KBD_URL) {
    event.respondWith(handleKbd(url));
    return;
  }
});

async function handleCabinet() {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(CABINET_URL);
  if (hit) return hit;
  return new Response('/* CSS-DOS: no cabinet in cache */\n', {
    status: 200,
    headers: { 'Content-Type': 'text/css' },
  });
}

function handleStream() {
  let streamController = null;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      // Opening preamble — Firefox likes a leading boundary before the
      // first part. Chrome accepts either way.
      controller.enqueue(ENC.encode(`--${BOUNDARY}\r\n`));
      streamControllers.add(controller);
      // New viewer connected — tell the bridge to reset the cabinet
      // and start running from scratch. Each /_stream/fb fetch is
      // treated as "restart the machine, I want to watch it boot".
      if (bridgePort) {
        bridgePort.postMessage({ type: 'viewer-connected' });
      }
    },
    cancel() {
      // Client closed the img connection (navigation, tab close).
      // Remove the controller immediately and let the bridge know
      // there's no one watching so it can pause.
      if (streamController) streamControllers.delete(streamController);
      if (streamControllers.size === 0 && bridgePort) {
        bridgePort.postMessage({ type: 'viewer-disconnected' });
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store',
      // The dev server sets COEP: require-corp for SAB. SW-constructed
      // responses must explicitly carry a CORP header or they get
      // rejected by the embedder's COEP check.
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}

function handleKbd(url) {
  // /_kbd?class=kb-X — pulse the (active, kb-X) pseudo-class edge
  // through calcite. The cabinet's own
  // `&:has(#kb-X:active) { --keyboard: V }` rule produces the value
  // via calcite's input-edge recogniser; the host only flips the gate.
  const klass = url.searchParams.get('class');
  if (klass && bridgePort) {
    bridgePort.postMessage({ type: 'kbd-active', selector: klass });
  }
  // 204 No Content — the target iframe won't re-render, page stays put.
  return new Response(null, {
    status: 204,
    headers: { 'Cross-Origin-Resource-Policy': 'same-origin' },
  });
}

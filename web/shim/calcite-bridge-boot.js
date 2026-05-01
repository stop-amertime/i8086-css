// web/shim/calcite-bridge-boot.js
// Loaded by build.html (and split.html). Spawns the calcite-bridge
// worker, which hosts the calcite WASM engine + a JPEG encoder, and
// hands a MessagePort to the service worker so the worker's frames
// fan out into any active /_stream/fb responses the SW serves.
// The /player/calcite.html runner is pure HTML+CSS — its <img>
// fetches /_stream/fb from the SW, which pumps frames from the
// bridge worker spawned here.
//
// Lifetime: bridge worker lives as long as this tab stays open.
// Close this tab and the runner in the other tab freezes.

(async function bootCalciteBridge() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    const bridge = new Worker('/shim/calcite-bridge.js', { type: 'module' });
    bridge.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.type === 'status') {
        console.log('[calcite-bridge]', d.message);
      }
    });
    bridge.addEventListener('error', (ev) => {
      console.error('[calcite-bridge error]', ev.message || ev);
    });

    const ch = new MessageChannel();
    bridge.postMessage({ type: 'sw-port' }, [ch.port1]);
    const sw = navigator.serviceWorker.controller || reg.active;
    if (sw) {
      sw.postMessage({ type: 'register-calcite-bridge' }, [ch.port2]);
    } else {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        navigator.serviceWorker.controller?.postMessage(
          { type: 'register-calcite-bridge' }, [ch.port2]
        );
      }, { once: true });
    }
    window.__calciteBridge = bridge;
    console.log('[calcite-bridge] worker spawned, SW port registered');
  } catch (e) {
    console.error('[calcite-bridge] boot failed:', e);
  }
})();

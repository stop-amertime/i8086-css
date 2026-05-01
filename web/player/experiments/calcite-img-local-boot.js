// player/calcite-img-local-boot.js
// Same-tab bootstrap for calcite-img.html. Registers the service
// worker and spawns the calcite driver in this page's process.
// No coupling to build-simple.html's pipeline — keeps the driver
// from competing with other workers for CPU.

(async function () {
  if (!('serviceWorker' in navigator)) {
    console.warn('[calcite-img] no service worker support');
    return;
  }
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    // First load after SW registration: the <img>'s request for
    // /_stream/fb already went to the network before the SW could
    // claim this page. Reload once so the second load is SW-
    // controlled and the img request gets intercepted.
    if (!navigator.serviceWorker.controller) {
      console.log('[calcite-img] no SW controller yet, reloading once');
      location.reload();
      return;
    }

    const driver = new Worker('/player/calcite-img-driver.js', { type: 'module' });
    driver.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.type === 'status') {
        console.log('[calcite-img driver]', d.message);
      }
    });
    driver.addEventListener('error', (ev) => {
      console.error('[calcite-img driver error]', ev.message || ev);
    });

    const ch = new MessageChannel();
    driver.postMessage({ type: 'sw-port' }, [ch.port1]);
    const sw = navigator.serviceWorker.controller;
    if (sw) {
      sw.postMessage({ type: 'register-calcite-driver' }, [ch.port2]);
    } else {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        navigator.serviceWorker.controller?.postMessage(
          { type: 'register-calcite-driver' }, [ch.port2]
        );
      }, { once: true });
    }

    // The driver pauses until it sees 'viewer-connected' over its
    // sw-port. Normally the SW sends that when an <img src="/_stream/fb">
    // fetch arrives. If the SW isn't yet controlling this page (first
    // load before SW claim, or cross-origin-isolation race) the fetch
    // never reaches the SW and the driver hangs. Send viewer-connected
    // directly over a second MessagePort as a backup so the machine
    // starts regardless of SW state. This port also delivers kbd
    // events that the SW forwards.
    //
    // Note: this is same-tab architecture, so we can just punt the
    // signal straight at the driver — no hop through the SW needed.
    // We still create and hand over the SW port above for multipart
    // streaming + /_kbd routing; this second port just kicks the
    // driver into motion.
    const kick = new MessageChannel();
    driver.postMessage({ type: 'sw-port' }, [kick.port1]);
    kick.port2.postMessage({ type: 'viewer-connected' });
    window.__calciteImgDriver = driver;
    console.log('[calcite-img] local driver spawned');
  } catch (e) {
    console.error('[calcite-img] local boot failed:', e);
  }
})();

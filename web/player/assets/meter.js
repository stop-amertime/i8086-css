// player/assets/meter.js
// Samples --__1cycleCount once a second and displays effective 8086 Hz
// in a small fixed badge top-right.
(function(){
  const cpu = document.querySelector('.cpu');
  if (!cpu) return;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:4px;right:4px;background:#000;color:#0f0;padding:4px 8px;font:12px/1.2 monospace;z-index:99;border:1px solid #0f0';
  el.textContent = '— Hz';
  document.body.appendChild(el);
  function read() {
    return parseInt(getComputedStyle(cpu).getPropertyValue('--__1cycleCount') || '0', 10);
  }
  let last = read();
  let lastT = performance.now();
  setInterval(() => {
    const now = read();
    const t = performance.now();
    const dc = now - last;
    const dt = t - lastT;
    last = now; lastT = t;
    const hz = dt > 0 ? dc * 1000 / dt : 0;
    if (hz >= 1e6) el.textContent = (hz / 1e6).toFixed(2) + ' MHz';
    else if (hz >= 1e3) el.textContent = (hz / 1e3).toFixed(1) + ' KHz';
    else el.textContent = Math.round(hz) + ' Hz';
  }, 1000);
})();

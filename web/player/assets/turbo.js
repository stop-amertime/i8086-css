// player/assets/turbo.js
// Optional accelerator: overrides --clock manually via rAF so ticks
// happen as fast as Chrome computes them, rather than at the CSS
// animation's 400ms tick rate. No functional change vs. pure-CSS mode
// — just much faster.
(function(){
  const clock = document.querySelector('.clock');
  const cpu = document.querySelector('.cpu');
  if (!clock || !cpu) return;
  let t = 0;
  function step() {
    for (let i = 0; i < 4; i++) {
      clock.style.setProperty('--clock', t, 'important');
      t = (t + 1) % 4;
      // Touch a computed var to force style recalc.
      getComputedStyle(cpu).getPropertyValue('--__1IP');
    }
    const halt = parseInt(getComputedStyle(cpu).getPropertyValue('--__1halt') || '0', 10);
    if (halt) return;
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
})();

// Execution engine: clock, double-buffer, store/execute keyframes, HTML wrapper.
// Based on legacy/base_template.css pattern.

// The 14 CPU registers, in the order used by the 8086.
// Each has: name, initial value, debug-visible
export const REGISTERS = [
  { name: 'AX', init: 0, debug: true },
  { name: 'CX', init: 0, debug: true },
  { name: 'DX', init: 0, debug: true },
  { name: 'BX', init: 0, debug: true },
  { name: 'SP', init: 0, debug: true }, // set dynamically based on memSize
  { name: 'BP', init: 0, debug: true },
  { name: 'SI', init: 0, debug: true },
  { name: 'DI', init: 0, debug: true },
  { name: 'CS', init: 0, debug: true },
  { name: 'DS', init: 0, debug: true },
  { name: 'ES', init: 0, debug: true },
  { name: 'SS', init: 0, debug: true },
  { name: 'IP', init: 0x100, debug: true }, // .COM entry point
  { name: 'flags', init: 0x0002, debug: true }, // bit 1 always set on 8086
];

// Extra state variables that participate in the double-buffer cycle
export const STATE_VARS = [
  { name: 'halt', init: 0, debug: true },
];

/**
 * Emit @property declarations for all double-buffered variables.
 */
export function emitPropertyDecls(opts) {
  const all = getAllVars(opts);
  const lines = [];
  lines.push(`@property --clock {
  syntax: '<integer>';
  inherits: true;
  initial-value: 0;
}`);
  for (const v of all) {
    lines.push(`@property --${v.name} {
  syntax: '<integer>';
  inherits: true;
  initial-value: ${v.init};
}`);
  }
  return lines.join('\n\n');
}

/**
 * Emit the .cpu rule's __1 variable reads (read from double-buffer).
 * --__1AX: var(--__2AX, <init>);
 */
export function emitBufferReads(opts) {
  const all = getAllVars(opts);
  return all.map(v =>
    `  --__1${v.name}: var(--__2${v.name}, ${v.init});`
  ).join('\n');
}

/**
 * Emit convenience aliases for 8-bit register halves.
 */
export function emitRegisterAliases() {
  return [
    '  --AL: --lowerBytes(var(--__1AX), 8);',
    '  --CL: --lowerBytes(var(--__1CX), 8);',
    '  --DL: --lowerBytes(var(--__1DX), 8);',
    '  --BL: --lowerBytes(var(--__1BX), 8);',
    '  --AH: --rightShift(var(--__1AX), 8);',
    '  --CH: --rightShift(var(--__1CX), 8);',
    '  --DH: --rightShift(var(--__1DX), 8);',
    '  --BH: --rightShift(var(--__1BX), 8);',
  ].join('\n');
}

/**
 * Emit the store keyframe (clock phase 1): copy __0 → __2
 */
export function emitStoreKeyframe(opts) {
  const all = getAllVars(opts);
  const lines = all.map(v =>
    `    --__2${v.name}: var(--__0${v.name}, ${v.init});`
  );
  return `@keyframes store {
  0%, 100% {
${lines.join('\n')}
  }
}`;
}

/**
 * Emit the execute keyframe (clock phase 3): copy computed → __0
 */
export function emitExecuteKeyframe(opts) {
  const all = getAllVars(opts);
  const lines = all.map(v =>
    `    --__0${v.name}: var(--${v.name});`
  );
  return `@keyframes execute {
  0%, 100% {
${lines.join('\n')}
  }
}`;
}

/**
 * Emit the clock animation keyframes.
 */
export function emitClockKeyframes() {
  return `@keyframes anim-play {
  0% { --clock: 0 }
  25% { --clock: 1 }
  50% { --clock: 2 }
  75% { --clock: 3 }
}`;
}

/**
 * Emit the .clock and .cpu base rules (animation setup).
 */
export function emitClockAndCpuBase() {
  return `.clock {
  animation: anim-play 400ms steps(4, jump-end) infinite;
  --clock: 0;
}

.cpu {
  animation: store 1ms infinite, execute 1ms infinite;
  animation-play-state: paused, paused;
  @container style(--clock: 1) { animation-play-state: running, paused }
  @container style(--clock: 3) { animation-play-state: paused, running }`;
  // Note: this is opened and closed by emit-css.mjs since the .cpu rule
  // contains all the computed properties.
}

/**
 * Emit debug display (::before and ::after pseudo-elements).
 */
export function emitDebugDisplay(opts) {
  const all = getAllVars(opts).filter(v => v.debug);
  const counters = all.map(v => `${v.name} var(--${v.name})`).join(' ');
  const content = all.map(v => `"\\a --${v.name}: " counter(${v.name})`).join(' ');
  return `
.cpu::after {
  white-space: pre;
  counter-reset: ${counters};
  content: ${content};
}`;
}

/**
 * Emit the HTML wrapper with JS clock driver for testing.
 */
export function emitHTML(cssContent) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>i8086-css</title>
<style>
${cssContent}
</style>
</head>
<body>
<div class="clock" style="container-type:inline-size">
  <div class="cpu"></div>
</div>
<script>
// Optional JS clock driver — CSS works without this, but JS makes it faster.
let clock = 0;

function tickInstruction() {
  for (let i = 0; i < 4; i++) {
    document.querySelector(".clock").style = \`--clock:\${clock}!important\`;
    clock = (clock + 1) % 4;
    getComputedStyle(document.querySelector(".cpu")).getPropertyValue("--__1IP");
  }
}

function animate() {
  tickInstruction();
  const ip = parseInt(getComputedStyle(document.querySelector(".cpu")).getPropertyValue("--__1IP"));
  const halt = parseInt(getComputedStyle(document.querySelector(".cpu")).getPropertyValue("--__1halt"));
  if (halt === 1 || ip === 0) {
    // Read final register state
    const cpu = document.querySelector(".cpu");
    const cs = getComputedStyle(cpu);
    const regs = ['AX','BX','CX','DX','SP','BP','SI','DI','CS','DS','ES','SS','IP','flags'];
    const state = {};
    for (const r of regs) state[r] = parseInt(cs.getPropertyValue('--__1' + r));
    console.log('HALT', JSON.stringify(state));
    return;
  }
  requestAnimationFrame(animate);
}

document.querySelector(".clock").style = "--clock:0!important";
animate();
</script>
</body>
</html>`;
}

// --- Internal ---

function getAllVars(opts) {
  const regs = REGISTERS.map(r => ({ ...r }));
  // Set SP initial value based on memory size
  const spReg = regs.find(r => r.name === 'SP');
  spReg.init = (opts.memSize || 0x600) - 0x8;
  // Set IP to program entry
  const ipReg = regs.find(r => r.name === 'IP');
  ipReg.init = opts.programOffset || 0x100;
  return [...regs, ...STATE_VARS];
}

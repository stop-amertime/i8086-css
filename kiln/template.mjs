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
  { name: 'cycleCount', init: 0, debug: false },
  { name: '_tfPending', init: 0, debug: false },

  // PIC (i8259) state — see transpiler/src/patterns/misc.mjs emitIO().
  // picMask: IMR. Bit set = IRQ masked. Init 0xFF (all masked) matches real
  // BIOS POST before the OS unmasks IRQ 0/1.
  // picPending: IRR. Bit set = IRQ requested, not yet acknowledged.
  // picInService: ISR. Bit set = IRQ currently being serviced (cleared by EOI).
  { name: 'picMask', init: 0xFF, debug: false },
  { name: 'picPending', init: 0, debug: false },
  { name: 'picInService', init: 0, debug: false },

  // PIT (i8253) channel 0 state — see transpiler/src/patterns/misc.mjs emitIO().
  // pitMode: counting mode (0..5 from control word bits 3-1).
  // pitReload: 16-bit reload latch, loaded by OUT 0x40 lo/hi sequence.
  // pitCounter: running countdown; reloads from pitReload on zero crossing.
  // pitWriteState: lo/hi toggle for OUT 0x40 (0 = lo byte next, 1 = hi byte next).
  { name: 'pitMode', init: 0, debug: false },
  { name: 'pitReload', init: 0, debug: false },
  { name: 'pitCounter', init: 0, debug: false },
  { name: 'pitWriteState', init: 0, debug: false },

  // Previous-tick snapshot of --keyboard, used to detect press edges for IRQ 1.
  // --keyboard is driven externally by :active button rules; its double-buffered
  // snapshot lets us compare this tick's value against last tick's.
  { name: 'prevKeyboard', init: 0, debug: false },
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
  lines.push(`@property --keyboard {
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
export function emitClockAndCpuBase(opts = {}) {
  // In HTML mode, the JS driver controls the clock — no CSS animation.
  const clockAnimation = opts.htmlMode
    ? ''
    : '  animation: anim-play 400ms steps(4, jump-end) infinite;\n';
  return `.clock {
${clockAnimation}  --clock: 0;
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

// HTML wrapping used to live here. It moved out of Kiln and into
// `player/index.html`, a static file that loads cabinets via
// `?cabinet=path/to/cabinet.css`. Kiln emits pure CSS; the player loads it.

// --- Internal ---

function getAllVars(opts) {
  const regs = REGISTERS.map(r => ({ ...r }));
  // Set SP initial value based on memory size (must match reference emulator)
  const spReg = regs.find(r => r.name === 'SP');
  spReg.init = ((opts.memSize || 0x600) - 0x8) & 0xFFFF;
  // Set IP to program entry (or BIOS init for DOS boot)
  const ipReg = regs.find(r => r.name === 'IP');
  ipReg.init = opts.initialIP != null ? opts.initialIP : (opts.programOffset || 0x100);
  // Set CS (0 for .COM, 0xF000 for DOS BIOS boot)
  const csReg = regs.find(r => r.name === 'CS');
  if (opts.initialCS != null) csReg.init = opts.initialCS;
  // Apply any additional initial register overrides
  if (opts.initialRegs) {
    for (const [name, val] of Object.entries(opts.initialRegs)) {
      const reg = regs.find(r => r.name === name);
      if (reg) reg.init = val;
    }
  }
  return [...regs, ...STATE_VARS];
}

// --- Keyboard key definitions ---
const KEYBOARD_KEYS = [
  { label: '0', scancode: 0x0B, ascii: 0x30 },
  { label: '1', scancode: 0x02, ascii: 0x31 },
  { label: '2', scancode: 0x03, ascii: 0x32 },
  { label: '3', scancode: 0x04, ascii: 0x33 },
  { label: '4', scancode: 0x05, ascii: 0x34 },
  { label: '5', scancode: 0x06, ascii: 0x35 },
  { label: '6', scancode: 0x07, ascii: 0x36 },
  { label: '7', scancode: 0x08, ascii: 0x37 },
  { label: '8', scancode: 0x09, ascii: 0x38 },
  { label: '9', scancode: 0x0A, ascii: 0x39 },
  { label: 'Q', scancode: 0x10, ascii: 0x71 },
  { label: 'W', scancode: 0x11, ascii: 0x77 },
  { label: 'E', scancode: 0x12, ascii: 0x65 },
  { label: 'R', scancode: 0x13, ascii: 0x72 },
  { label: 'T', scancode: 0x14, ascii: 0x74 },
  { label: 'Y', scancode: 0x15, ascii: 0x79 },
  { label: 'U', scancode: 0x16, ascii: 0x75 },
  { label: 'I', scancode: 0x17, ascii: 0x69 },
  { label: 'O', scancode: 0x18, ascii: 0x6F },
  { label: 'P', scancode: 0x19, ascii: 0x70 },
  { label: 'A', scancode: 0x1E, ascii: 0x61 },
  { label: 'S', scancode: 0x1F, ascii: 0x73 },
  { label: 'D', scancode: 0x20, ascii: 0x64 },
  { label: 'F', scancode: 0x21, ascii: 0x66 },
  { label: 'G', scancode: 0x22, ascii: 0x67 },
  { label: 'H', scancode: 0x23, ascii: 0x68 },
  { label: 'J', scancode: 0x24, ascii: 0x6A },
  { label: 'K', scancode: 0x25, ascii: 0x6B },
  { label: 'L', scancode: 0x26, ascii: 0x6C },
  { label: '\u21B5', scancode: 0x1C, ascii: 0x0D },
  { label: 'Z', scancode: 0x2C, ascii: 0x7A },
  { label: 'X', scancode: 0x2D, ascii: 0x78 },
  { label: 'C', scancode: 0x2E, ascii: 0x63 },
  { label: 'V', scancode: 0x2F, ascii: 0x76 },
  { label: 'B', scancode: 0x30, ascii: 0x62 },
  { label: 'N', scancode: 0x31, ascii: 0x6E },
  { label: 'M', scancode: 0x32, ascii: 0x6D },
  { label: '\u2423', scancode: 0x39, ascii: 0x20 },
  { label: 'Esc', scancode: 0x01, ascii: 0x1B },
  { label: '\u2190', scancode: 0x4B, ascii: 0x00 }, // ←
  { label: '\u2193', scancode: 0x50, ascii: 0x00 }, // ↓
  { label: '\u2191', scancode: 0x48, ascii: 0x00 }, // ↑
  { label: '\u2192', scancode: 0x4D, ascii: 0x00 }, // →
  { label: 'Tab',   scancode: 0x0F, ascii: 0x09 },
  { label: 'Bksp',  scancode: 0x0E, ascii: 0x08 },
];

/**
 * Emit CSS rules that map :active button presses to --keyboard values.
 */
export function emitKeyboardRules() {
  const lines = ['.cpu {'];
  for (let i = 0; i < KEYBOARD_KEYS.length; i++) {
    const key = KEYBOARD_KEYS[i];
    const value = (key.scancode << 8) | key.ascii;
    lines.push(`  &:has(key-board button:nth-child(${i + 1}):active) { --keyboard: ${value}; } /* ${key.label} */`);
  }
  lines.push('}');
  return lines.join('\n');
}

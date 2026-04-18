#!/usr/bin/env node
// ARCHIVED — 2026-04-18.
// Reference 8086 emulator for the microcode-BIOS DOS path (V3 era).
// Superseded by conformance/ref-muslin.mjs when V4 went back to an
// assembly BIOS. Not used by any current tool. Kept as a reference.
//
// Reference 8086 emulator for DOS boot testing.
// Loads the same memory layout as generate-dos.mjs:
//   - KERNEL.SYS at 0060:0000 (linear 0x600)
//   - Disk image at D000:0000 (linear 0xD0000)
//   - BIOS at F000:0000 (linear 0xF0000) = init stub + D6 microcode stubs
//   - CS:IP starts at F000:0000 (init stub sets up IVT, BDA, splash, then jumps to kernel)
//
// Usage: node tools/ref-emu-dos.mjs <ticks> [--json]

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PIC, PIT, KeyboardController } from './peripherals.mjs';
import { createBiosHandlers } from './lib/bios-handlers.mjs';
import { buildBiosRom } from '../transpiler/src/patterns/bios.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Load the 8086 CPU core
const js8086Path = resolve(__dirname, 'js8086.js');
const js8086Source = readFileSync(js8086Path, 'utf-8');
const evalSource = js8086Source.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 0;');
const Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();

// --- CLI ---
const args = process.argv.slice(2);
const maxTicks = parseInt(args[0]) || 10000;
const jsonMode = args.includes('--json');

// --- Constants (must match generate-dos.mjs) ---
const KERNEL_LINEAR = 0x600;
const DISK_LINEAR   = 0xD0000;
const BIOS_LINEAR   = 0xF0000;

// --- Assemble init stub ---
const NASM = resolve('C:\\Users\\AdmT9N0CX01V65438A\\AppData\\Local\\bin\\NASM\\nasm.exe');
const initAsmPath = resolve(projectRoot, 'bios', 'init.asm');
const initBinPath = resolve(projectRoot, 'bios', 'init.bin');
execSync(`"${NASM}" -f bin -o "${initBinPath}" "${initAsmPath}"`, { stdio: 'pipe' });

// --- Load binaries ---
const initBin = readFileSync(initBinPath);
const kernelBin = readFileSync(resolve(projectRoot, 'dos', 'bin', 'kernel.sys'));
const diskBin = readFileSync(resolve(projectRoot, 'dos', 'disk.img'));

// Build BIOS ROM: init stub + D6 microcode stubs
const { romBytes: biosRomBytes } = buildBiosRom();
const biosBytes = [...initBin, ...biosRomBytes];

console.error(`BIOS: ${biosBytes.length} bytes (init stub: ${initBin.length}, microcode stubs: ${biosRomBytes.length})`);
console.error(`Kernel: ${kernelBin.length} bytes`);
console.error(`Disk: ${diskBin.length} bytes`);

// --- Setup 1MB memory ---
const memory = new Uint8Array(1024 * 1024);

// KERNEL.SYS at 0060:0000 (linear 0x600)
for (let i = 0; i < kernelBin.length; i++) {
  memory[KERNEL_LINEAR + i] = kernelBin[i];
}

// Disk image at D000:0000 (linear 0xD0000)
for (let i = 0; i < diskBin.length && DISK_LINEAR + i < memory.length; i++) {
  memory[DISK_LINEAR + i] = diskBin[i];
}

// BIOS ROM at F000:0000 (init stub + D6 stubs)
for (let i = 0; i < biosBytes.length; i++) {
  memory[BIOS_LINEAR + i] = biosBytes[i];
}

// IVT is NOT pre-populated — the init stub sets it up at runtime

// --- Peripherals ---
const pic = new PIC();
const pit = new PIT(pic);
const kbd = new KeyboardController(pic);
let int_handler = null;

// Create CPU with peripheral and int_handler support
const cpu = Intel8086(
  (addr, val) => { memory[addr & 0xFFFFF] = val & 0xFF; },
  (addr) => memory[addr & 0xFFFFF],
  pic, pit, (type) => int_handler ? int_handler(type) : false,
);
cpu.reset();
cpu.setRegs({
  cs: 0xF000,
  ip: 0x0000,   // start at init stub entry point
  ss: 0,
  sp: 0xFFF8,
  ds: 0,
  es: 0,
  ah: 0, al: 0,
  bh: 0, bl: 0,
  ch: 0, cl: 0,
  dh: 0, dl: 0,
});

// Wire up BIOS handlers (D6 opcode dispatch)
int_handler = createBiosHandlers(memory, pic, kbd, () => cpu.getRegs(), (regs) => cpu.setRegs(regs));

// Helper: get register state
function getState() {
  const r = cpu.getRegs();
  return {
    AX: (r.ah << 8) | r.al,
    CX: (r.ch << 8) | r.cl,
    DX: (r.dh << 8) | r.dl,
    BX: (r.bh << 8) | r.bl,
    SP: r.sp,
    BP: r.bp,
    SI: r.si,
    DI: r.di,
    IP: r.ip,
    ES: r.es,
    CS: r.cs,
    SS: r.ss,
    DS: r.ds,
    FLAGS: r.flags,
  };
}

// Run
const snapshots = [];
let sameIPCount = 0;
let lastFlatIP = -1;

for (let tick = 0; tick < maxTicks; tick++) {
  // Snapshot BEFORE step (matches CSS convention: tick N shows state at start of tick)
  const state = getState();

  if (jsonMode) {
    snapshots.push({ tick, ...state });
  } else if (tick < 50 || tick % 1000 === 0) {
    console.error(
      `t${tick}: CS=${state.CS.toString(16)}:${state.IP.toString(16)} ` +
      `AX=${state.AX.toString(16)} CX=${state.CX.toString(16)} ` +
      `DS=${state.DS.toString(16)} SP=${state.SP.toString(16)} FL=${state.FLAGS.toString(16)}`
    );
  }

  cpu.step();

  // Halt detection: same flat IP for 3+ ticks
  const flatIP = state.CS * 16 + state.IP;
  if (flatIP === lastFlatIP) {
    sameIPCount++;
    if (sameIPCount >= 3) {
      console.error(`Halted at tick ${tick}, CS:IP=${state.CS.toString(16)}:${state.IP.toString(16)}`);
      if (jsonMode) snapshots.push({ tick: tick + 1, ...getState() });
      break;
    }
  } else {
    sameIPCount = 0;
  }
  lastFlatIP = flatIP;
}

if (jsonMode) {
  console.log(JSON.stringify(snapshots));
}

// Dump VGA screen
console.error('\n--- VGA Screen ---');
for (let row = 0; row < 25; row++) {
  let line = '';
  for (let col = 0; col < 80; col++) {
    const addr = 0xB8000 + (row * 80 + col) * 2;
    const ch = memory[addr];
    line += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : ' ';
  }
  console.error(line.trimEnd());
}

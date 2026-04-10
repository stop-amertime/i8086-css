#!/usr/bin/env node
// Reference 8086 emulator for DOS boot testing.
// Loads the same memory layout as generate-dos.mjs:
//   - KERNEL.SYS at 0060:0000 (linear 0x600)
//   - Disk image at D000:0000 (linear 0xD0000)
//   - BIOS at F000:0000 (linear 0xF0000)
//   - CS:IP starts at F000:bios_init
//
// Usage: node tools/ref-emu-dos.mjs <ticks> [--json]

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

// --- Load binaries ---
const biosPath = resolve(projectRoot, 'build', 'gossamer-dos.bin');
const kernelPath = resolve(projectRoot, 'dos', 'bin', 'kernel.sys');
const diskPath = resolve(projectRoot, 'dos', 'disk.img');

const biosBin = readFileSync(biosPath);
const kernelBin = readFileSync(kernelPath);
const diskBin = readFileSync(diskPath);

// Get bios_init offset from listing
const lstPath = resolve(projectRoot, 'build', 'gossamer-dos.lst');
let biosInitOffset = 0x37C; // default
try {
  const lst = readFileSync(lstPath, 'utf-8');
  const lines = lst.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('bios_init:')) {
      const m = lines[i + 1]?.match(/([0-9A-Fa-f]{8})/);
      if (m) biosInitOffset = parseInt(m[1], 16);
      break;
    }
  }
} catch {}

console.error(`BIOS: ${biosBin.length} bytes, init at 0x${biosInitOffset.toString(16)}`);
console.error(`Kernel: ${kernelBin.length} bytes`);
console.error(`Disk: ${diskBin.length} bytes`);

// --- Setup 1MB memory ---
const memory = new Uint8Array(1024 * 1024);

// KERNEL.SYS at 0060:0000 (linear 0x600)
for (let i = 0; i < kernelBin.length; i++) {
  memory[0x600 + i] = kernelBin[i];
}

// Disk image at D000:0000 (linear 0xD0000)
for (let i = 0; i < diskBin.length && 0xD0000 + i < memory.length; i++) {
  memory[0xD0000 + i] = diskBin[i];
}

// BIOS at F000:0000 (linear 0xF0000)
for (let i = 0; i < biosBin.length; i++) {
  memory[0xF0000 + i] = biosBin[i];
}

// IVT is NOT pre-populated — the BIOS init code sets it up at runtime

// Memory callbacks
function m_read(addr) {
  return memory[addr & 0xFFFFF];
}
function m_write(addr, val) {
  memory[addr & 0xFFFFF] = val & 0xFF;
}

// Create CPU
const cpu = Intel8086(m_write, m_read);
cpu.reset();
cpu.setRegs({
  cs: 0xF000,
  ip: biosInitOffset,
  ss: 0,
  sp: 0xFFF8,  // matches CSS (memSize=0x100000, SP = memSize - 8 mod 65536)
  ds: 0,
  es: 0,
  ah: 0, al: 0,
  bh: 0, bl: 0,
  ch: 0, cl: 0,
  dh: 0, dl: 0,
});

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

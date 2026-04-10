#!/usr/bin/env node
// Reference 8086 emulator for conformance testing against calcite.
// Uses emu8's js8086.js CPU core.
//
// Usage: node tools/ref-emu.mjs <program.com> <gossamer.bin> <ticks> [--json]
//
// Outputs register state after each instruction (tick) in a format
// that can be compared against calcite's verbose output.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadIvtHandlers, writeIvtTo } from './lib/bios-symbols.mjs';

// Load the 8086 CPU core
const __dirname = dirname(fileURLToPath(import.meta.url));
const js8086Path = resolve(__dirname, 'js8086.js');

// We need to load it as a module. The file uses 'use strict' and defines
// Intel8086 as a function. Let's just import it by evaluating.
const js8086Source = readFileSync(js8086Path, 'utf-8');

// The file defines Intel8086 as a plain function at top level.
// Wrap it so we can extract it.
const evalSource = js8086Source.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 0;');
const Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();

// --- Setup ---
const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage: node ref-emu.mjs <program.com> <gossamer.bin> <ticks> [--json]');
  process.exit(1);
}

const comPath = resolve(args[0]);
const biosPath = resolve(args[1]);
const maxTicks = parseInt(args[2]);
const jsonMode = args.includes('--json');

const comBin = readFileSync(comPath);
const biosBin = readFileSync(biosPath);

// 1MB flat memory
const memory = new Uint8Array(1024 * 1024);

// Load .COM file at 0000:0100
for (let i = 0; i < comBin.length; i++) {
  memory[0x100 + i] = comBin[i];
}

// Load BIOS at F000:0000 (linear 0xF0000)
const BIOS_BASE = 0xF0000;
for (let i = 0; i < biosBin.length; i++) {
  memory[BIOS_BASE + i] = biosBin[i];
}

// Set up IVT entries. The hack path skips bios_init, so we write the IVT
// from outside the emulator — reading handler offsets from gossamer.lst
// so we never drift from the BIOS binary. The .lst is assumed to live
// next to the .bin argument (build/gossamer.bin → build/gossamer.lst).
const BIOS_SEG = 0xF000;
const biosLstPath = biosPath.replace(/\.bin$/, '.lst');
const handlers = loadIvtHandlers(biosLstPath);
writeIvtTo(memory, handlers, BIOS_SEG);

// Memory read/write callbacks
function m_read(addr) {
  addr = addr & 0xFFFFF;  // 20-bit address space
  return memory[addr];
}

function m_write(addr, val) {
  addr = addr & 0xFFFFF;
  memory[addr] = val & 0xFF;
}

// Create CPU
const cpu = Intel8086(m_write, m_read);

// Set initial registers (matching CSS-DOS .COM setup)
cpu.reset();
cpu.setRegs({
  cs: 0,
  ip: 0x0100,
  ss: 0,
  sp: 0x05F8,  // 1528
  ds: 0,
  es: 0,
  ah: 0, al: 0,
  bh: 0, bl: 0,
  ch: 0, cl: 0,
  dh: 0, dl: 0,
});

// Helper: get registers in calcite-compatible format
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
    IP: r.cs * 16 + r.ip,  // flat IP like calcite uses
    ES: r.es,
    CS: r.cs,
    SS: r.ss,
    DS: r.ds,
    FLAGS: r.flags,
  };
}

// Run
const snapshots = [];
let lastIP = -1;
for (let tick = 0; tick < maxTicks; tick++) {
  cpu.step();
  const state = getState();

  // Detect halt (IP not changing = infinite loop like jmp $)
  if (state.IP === lastIP) {
    console.error(`Halted at tick ${tick}, IP=0x${state.IP.toString(16)}`);
    break;
  }
  lastIP = state.IP;

  if (jsonMode) {
    snapshots.push({ tick, ...state });
  } else {
    console.log(
      `Tick ${tick}: AX=${state.AX} CX=${state.CX} DX=${state.DX} BX=${state.BX} ` +
      `SP=${state.SP} BP=${state.BP} SI=${state.SI} DI=${state.DI} ` +
      `IP=${state.IP} ES=${state.ES} CS=${state.CS} SS=${state.SS} DS=${state.DS} flags=${state.FLAGS}`
    );
  }
}

if (jsonMode) {
  console.log(JSON.stringify(snapshots));
}

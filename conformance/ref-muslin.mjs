#!/usr/bin/env node
// ref-asm-bios.mjs — Run JS 8086 emulator with the assembly BIOS.
// No INT interception — the assembly BIOS handles everything via IVT.
// For comparing against calcite/CSS execution.
//
// Usage: node tools/ref-asm-bios.mjs [--ticks=N] [--vga] [--watch=0xADDR]

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v ?? 'true'];
  })
);

const maxTicks = parseInt(flags.ticks || '200000');
const showVga = flags.vga === 'true';
const watchAddr = flags.watch ? parseInt(flags.watch) : -1;
const traceFrom = parseInt(flags['trace-from'] || '-1');

// --- Load JS 8086 ---
const js8086Source = readFileSync(resolve(projectRoot, 'tools', 'js8086.js'), 'utf-8');
const evalSource = js8086Source.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 0;');
const Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();

// --- Assemble BIOS ---
const NASM = resolve('C:\\Users\\AdmT9N0CX01V65438A\\AppData\\Local\\bin\\NASM\\nasm.exe');
const biosAsmPath = resolve(projectRoot, 'bios', 'css-emu-bios.asm');
const biosBinPath = resolve(projectRoot, 'bios', 'css-emu-bios.bin');
const biosLstPath = resolve(projectRoot, 'bios', 'css-emu-bios.lst');
execSync(`"${NASM}" -f bin -o "${biosBinPath}" "${biosAsmPath}" -l "${biosLstPath}"`, { stdio: 'pipe' });
const biosBytes = readFileSync(biosBinPath);

// Find bios_init offset from listing
const listing = readFileSync(biosLstPath, 'utf-8');
let biosInitOffset = null;
for (const line of listing.split('\n')) {
  if (line.includes('bios_init:')) {
    const next = listing.split('\n')[listing.split('\n').indexOf(line) + 1];
    if (next) {
      const m = next.match(/^\s*\d+\s+([0-9A-Fa-f]{4,})/);
      if (m) biosInitOffset = parseInt(m[1], 16);
    }
    break;
  }
}
console.error(`BIOS: ${biosBytes.length} bytes, entry at F000:${biosInitOffset.toString(16).padStart(4,'0')}`);

// --- Load kernel and disk ---
const kernelBin = readFileSync(resolve(projectRoot, 'dos', 'bin', 'kernel.sys'));
const diskBin = readFileSync(resolve(projectRoot, 'dos', 'disk.img'));

// --- Setup 1MB memory ---
const memory = new Uint8Array(1024 * 1024);

// Kernel at 0060:0000
for (let i = 0; i < kernelBin.length; i++) memory[0x600 + i] = kernelBin[i];
// Disk at D000:0000
for (let i = 0; i < diskBin.length && 0xD0000 + i < memory.length; i++) memory[0xD0000 + i] = diskBin[i];
// BIOS ROM at F000:0000
for (let i = 0; i < biosBytes.length; i++) memory[0xF0000 + i] = biosBytes[i];

// --- NO IVT/BDA setup — the assembly BIOS init code does all of this ---

// --- PIC/PIT from peripherals.mjs ---
import { pathToFileURL } from 'url';
const { PIC, PIT, KeyboardController } = await import(pathToFileURL(resolve(projectRoot, 'tools', 'peripherals.mjs')).href);
const pic = new PIC();
const pit = new PIT(pic);
const kbd = new KeyboardController(pic);

// --- CPU ---
let currentTick = 0;
const cpu = Intel8086(
  (addr, val) => {
    const a = addr & 0xFFFFF;
    memory[a] = val & 0xFF;
    if (watchAddr >= 0 && a >= watchAddr && a < watchAddr + 4) {
      const r = cpu.getRegs();
      const w0 = memory[watchAddr] | (memory[watchAddr+1] << 8);
      const w1 = memory[watchAddr+2] | (memory[watchAddr+3] << 8);
      console.error(`[T${currentTick}] WATCH 0x${watchAddr.toString(16)}: byte[${a-watchAddr}]=0x${(val&0xFF).toString(16).padStart(2,'0')} -> ${w1.toString(16).padStart(4,'0')}:${w0.toString(16).padStart(4,'0')} from ${r.cs.toString(16).padStart(4,'0')}:${r.ip.toString(16).padStart(4,'0')}`);
    }
  },
  (addr) => memory[addr & 0xFFFFF],
  pic, pit,
  (type) => false,  // No INT interception — all handled by IVT
);

cpu.reset();
cpu.setRegs({
  cs: 0xF000, ip: biosInitOffset,
  ss: 0, sp: 0,
  ds: 0, es: 0,
  ah: 0, al: 0, bh: 0, bl: 0, ch: 0, cl: 0, dh: 0, dl: 0,
});

function hex(v, w = 4) { return v.toString(16).toUpperCase().padStart(w, '0'); }

// --- Run ---
let lastIP = -1;
let sameCount = 0;

for (currentTick = 0; currentTick < maxTicks; currentTick++) {
  const r = cpu.getRegs();
  const flat = r.cs * 16 + r.ip;

  if (traceFrom >= 0 && currentTick >= traceFrom) {
    console.log(`T${currentTick}: ${hex(r.cs)}:${hex(r.ip)} AX=${hex((r.ah<<8)|r.al)} CX=${hex((r.ch<<8)|r.cl)} DX=${hex((r.dh<<8)|r.dl)} BX=${hex((r.bh<<8)|r.bl)} SP=${hex(r.sp)} SI=${hex(r.si)} DI=${hex(r.di)} DS=${hex(r.ds)} ES=${hex(r.es)} SS=${hex(r.ss)} FL=${hex(r.flags)}`);
  }

  // Halt detection
  if (flat === lastIP) {
    sameCount++;
    if (sameCount > 500) {
      console.error(`Halted at T${currentTick}: ${hex(r.cs)}:${hex(r.ip)} (looping)`);
      break;
    }
  } else {
    sameCount = 0;
  }
  lastIP = flat;

  cpu.step();
}

// Final state
const r = cpu.getRegs();
console.error(`Final T${currentTick}: CS:IP=${hex(r.cs)}:${hex(r.ip)} SS:SP=${hex(r.ss)}:${hex(r.sp)} DS=${hex(r.ds)} ES=${hex(r.es)}`);

if (showVga) {
  console.error('\n--- VGA Screen ---');
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      const ch = memory[0xB8000 + (row * 80 + col) * 2];
      line += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : ' ';
    }
    const trimmed = line.trimEnd();
    if (trimmed) console.error(trimmed);
  }
}

// Check SS:0x1000
const ss = r.ss;
const target = ss * 16 + 0x1000;
const b = [memory[target], memory[target+1], memory[target+2], memory[target+3]];
console.error(`SS:0x1000 (0x${target.toString(16)}): ${b.map(x => x.toString(16).padStart(2,'0')).join(' ')}`);

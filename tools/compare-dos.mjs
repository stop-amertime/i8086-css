#!/usr/bin/env node
//
// ====================================================================
// BROKEN — DO NOT USE. Imports ../transpiler/src/patterns/bios.mjs which
// was deleted in the builder/Kiln rewrite. Use
//
//   node tests/harness/fulldiff.mjs <cabinet.css>
//
// for DOS-path divergence detection. See tests/harness/README.md.
// ====================================================================
//
// DOS-path conformance comparison: reference 8086 emulator vs calcite.
//
// Uses the calcite debugger's /tick and /state endpoints to step calcite
// without dumping a giant trace. For each ref instruction retirement,
// advances calcite until IP matches, then compares registers.
//
// Usage:
//   node tools/compare-dos.mjs <program.css> [--ticks=N]
//
// Run generate-dos.mjs first to create the CSS and dos/disk.img.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { PIC, PIT, KeyboardController } from './peripherals.mjs';
import { createBiosHandlers } from './lib/bios-handlers.mjs';
import { buildBiosRom } from '../transpiler/src/patterns/bios.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v ?? 'true'];
  })
);

if (positional.length < 1) {
  console.error('Usage: node tools/compare-dos.mjs <program.css> [--ticks=N]');
  process.exit(1);
}

const cssPath = resolve(positional[0]);
const maxTicks = parseInt(flags.ticks || '5000');
const PORT = 3333;

// --- Constants (must match generate-dos.mjs) ---
const KERNEL_LINEAR = 0x600;
const DISK_LINEAR   = 0xD0000;
const BIOS_LINEAR   = 0xF0000;
const BIOS_SEG      = 0xF000;
const BDA_BASE      = 0x0400;

// --- HTTP helpers ---
async function post(path, body) {
  const r = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
  });
  return r.json();
}
async function get(path) { return (await fetch(`http://localhost:${PORT}${path}`)).json(); }

// --- Start debugger ---
console.error('Starting calcite debugger...');
const debuggerBin = resolve(projectRoot, '..', 'calcite', 'target', 'release',
  process.platform === 'win32' ? 'calcite-debugger.exe' : 'calcite-debugger');
const dbg = spawn(debuggerBin, ['--input', cssPath], { stdio: ['ignore', 'pipe', 'pipe'] });

await new Promise((ok, fail) => {
  let buf = '';
  dbg.stderr.on('data', d => { buf += d; if (buf.includes('listening')) ok(); });
  dbg.on('error', fail);
  dbg.on('exit', c => { if (!buf.includes('listening')) fail(new Error(`exit ${c}`)); });
  setTimeout(() => fail(new Error('timeout')), 60000);
});
console.error('Debugger ready.');

async function shutdown() { try { await post('/shutdown', {}); } catch {} dbg.kill(); }

// --- Helper: get calcite state efficiently ---
async function calState() {
  const s = await get('/state');
  const r = s.registers;
  return { tick: s.tick, ...r, flatIP: r.CS * 16 + r.IP };
}

// --- Helper: advance calcite to a flatIP with uOp=0 ---
// Uses exponential batch sizes to avoid 200k individual HTTP calls.
async function advanceToFlatIP(targetIP, maxSteps = 500000, debug = false) {
  // Check current state first (might already be there)
  let s = await calState();
  if (s.flatIP === targetIP && s.uOp === 0) return s;

  let stepped = 0;
  let batchSize = 1;
  while (stepped < maxSteps) {
    await post('/tick', { count: batchSize });
    stepped += batchSize;
    s = await calState();
    if (debug && stepped <= 20) {
      console.error(`    advance: stepped ${stepped}, tick ${s.tick}, flat=0x${s.flatIP.toString(16)} uOp=${s.uOp}`);
    }
    if (s.flatIP === targetIP && s.uOp === 0) return s;
    // Grow batch size for large REP loops
    if (batchSize < 1000) batchSize = Math.min(batchSize * 2, 1000);
  }
  return null; // couldn't find
}

// --- Load reference emulator + memory ---
const js8086Source = readFileSync(resolve(__dirname, 'js8086.js'), 'utf-8');
const evalSource = js8086Source.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 0;');
const Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();

const memory = new Uint8Array(1024 * 1024);

const kernelBin = readFileSync(resolve(projectRoot, 'dos', 'bin', 'kernel.sys'));
for (let i = 0; i < kernelBin.length; i++) memory[KERNEL_LINEAR + i] = kernelBin[i];

const diskBin = readFileSync(resolve(projectRoot, 'dos', 'disk.img'));
for (let i = 0; i < diskBin.length; i++) memory[DISK_LINEAR + i] = diskBin[i];

const { handlers: biosRomHandlers, romBytes: biosRomBytes } = buildBiosRom();
const biosBytes = [0xCF, ...biosRomBytes];
for (const k of Object.keys(biosRomHandlers)) biosRomHandlers[k] += 1;
for (let i = 0; i < biosBytes.length; i++) memory[BIOS_LINEAR + i] = biosBytes[i];

// IVT
for (let i = 0; i < 256; i++) {
  memory[i*4]=0; memory[i*4+1]=0; memory[i*4+2]=BIOS_SEG&0xFF; memory[i*4+3]=(BIOS_SEG>>8)&0xFF;
}
for (const [n, off] of Object.entries(biosRomHandlers)) {
  const b = parseInt(n)*4;
  memory[b]=off&0xFF; memory[b+1]=(off>>8)&0xFF; memory[b+2]=BIOS_SEG&0xFF; memory[b+3]=(BIOS_SEG>>8)&0xFF;
}

// BDA
memory[BDA_BASE+0x10]=0x21; memory[BDA_BASE+0x11]=0x00;
memory[BDA_BASE+0x13]=640&0xFF; memory[BDA_BASE+0x14]=(640>>8)&0xFF;
memory[BDA_BASE+0x1A]=0x1E; memory[BDA_BASE+0x1B]=0x00;
memory[BDA_BASE+0x1C]=0x1E; memory[BDA_BASE+0x1D]=0x00;
memory[BDA_BASE+0x80]=0x1E; memory[BDA_BASE+0x81]=0x00;
memory[BDA_BASE+0x82]=0x3E; memory[BDA_BASE+0x83]=0x00;
memory[BDA_BASE+0x49]=0x03; memory[BDA_BASE+0x4A]=80;
memory[BDA_BASE+0x4C]=0x00; memory[BDA_BASE+0x4D]=0x10;
memory[BDA_BASE+0x60]=0x07; memory[BDA_BASE+0x61]=0x06;
memory[BDA_BASE+0x63]=0xD4; memory[BDA_BASE+0x64]=0x03;
memory[BDA_BASE+0x84]=24; memory[BDA_BASE+0x85]=16;

// Peripherals + CPU
const pic = new PIC();
const pit = new PIT(pic);
const kbd = new KeyboardController(pic);
let int_handler = null;

const cpu = Intel8086(
  (addr, val) => { memory[addr & 0xFFFFF] = val & 0xFF; },
  (addr) => memory[addr & 0xFFFFF],
  pic, pit, (type) => int_handler ? int_handler(type) : false,
);
cpu.reset();
cpu.setRegs({ cs: 0x0060, ip: 0x0000, ss: 0x0030, sp: 0x0100, ds: 0, es: 0, bh: 0, bl: 0 });
int_handler = createBiosHandlers(memory, pic, kbd, () => cpu.getRegs(), (regs) => cpu.setRegs(regs));

function refState() {
  const r = cpu.getRegs();
  return {
    AX: (r.ah << 8) | r.al, CX: (r.ch << 8) | r.cl,
    DX: (r.dh << 8) | r.dl, BX: (r.bh << 8) | r.bl,
    SP: r.sp, BP: r.bp, SI: r.si, DI: r.di,
    IP: r.ip, CS: r.cs, ES: r.es, SS: r.ss, DS: r.ds, FLAGS: r.flags,
    flatIP: r.cs * 16 + r.ip,
  };
}

// --- Comparison loop ---
const REG_NAMES = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI', 'CS', 'SS', 'DS', 'ES'];
let matchCount = 0;
let lastRefIP = -1;
let sameIPCount = 0;

console.error(`Comparing up to ${maxTicks} ref instructions...`);

for (let t = 0; t < maxTicks; t++) {
  cpu.step();
  const ref = refState();

  // Halt detection
  if (ref.flatIP === lastRefIP) {
    sameIPCount++;
    if (ref.flatIP >= BIOS_LINEAR || sameIPCount > 200) {
      console.error(`\nRef halted at tick ${t}, IP=0x${ref.flatIP.toString(16)}`);
      break;
    }
  } else { sameIPCount = 0; }
  lastRefIP = ref.flatIP;

  // Skip repeated-IP (blocking handlers)
  if (sameIPCount > 0 && ref.flatIP < BIOS_LINEAR) continue;
  // Skip BIOS ROM execution
  if (ref.flatIP >= BIOS_LINEAR) continue;

  // Advance calcite to matching IP
  if (matchCount < 20) {
    const pre = await calState();
    console.error(`  ref ${t}: want 0x${ref.flatIP.toString(16)}, cal at tick ${pre.tick} flat=0x${pre.flatIP.toString(16)} uOp=${pre.uOp}`);
  }
  const cal = await advanceToFlatIP(ref.flatIP, 500000, matchCount < 10);
  if (!cal) {
    const s = await calState();
    console.log(`\nFAILED TO ALIGN at ref tick ${t}:`);
    console.log(`  Expected flatIP=0x${ref.flatIP.toString(16)}`);
    console.log(`  Calcite at tick ${s.tick}: CS=0x${s.CS.toString(16)} IP=0x${s.IP.toString(16)} uOp=${s.uOp}`);
    await shutdown();
    process.exit(1);
  }

  // Compare registers
  const diffs = [];
  for (const reg of REG_NAMES) {
    if (ref[reg] !== cal[reg]) diffs.push({ reg, ref: ref[reg], cal: cal[reg] });
  }
  // Compare flat IP
  if (ref.flatIP !== cal.flatIP) diffs.push({ reg: 'IP(flat)', ref: ref.flatIP, cal: cal.flatIP });

  if (diffs.length > 0) {
    console.log(`\nFIRST DIVERGENCE at ref tick ${t} (calcite tick ${cal.tick}):`);
    console.log(`  REF: AX=${ref.AX} CX=${ref.CX} DX=${ref.DX} BX=${ref.BX} SP=${ref.SP} SI=${ref.SI} DI=${ref.DI} CS=0x${ref.CS.toString(16)} IP=0x${ref.IP.toString(16)} FLAGS=0x${ref.FLAGS.toString(16)}`);
    console.log(`  CAL: AX=${cal.AX} CX=${cal.CX} DX=${cal.DX} BX=${cal.BX} SP=${cal.SP} SI=${cal.SI} DI=${cal.DI} CS=0x${cal.CS.toString(16)} IP=0x${cal.IP.toString(16)} flags=0x${cal.flags.toString(16)}`);
    console.log(`Divergent registers:`);
    for (const d of diffs) console.log(`  ${d.reg}: ref=${d.ref} (0x${d.ref.toString(16)})  calcite=${d.cal} (0x${d.cal.toString(16)})`);
    const bytes = [];
    for (let i = 0; i < 8; i++) bytes.push(memory[ref.flatIP + i]);
    console.log(`Bytes at IP: ${bytes.map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
    await shutdown();
    process.exit(1);
  }

  matchCount++;
  if (matchCount % 100 === 0) {
    process.stderr.write(`  ${matchCount} matched (calcite tick ${cal.tick})\r`);
  }
}

console.error('');
console.log(`\n${'='.repeat(60)}`);
console.log(`CONFORMANCE REPORT (DOS path)`);
console.log(`${'='.repeat(60)}`);
console.log(`Instructions matched: ${matchCount}`);
console.log(`RESULT: ALL ${matchCount} INSTRUCTIONS MATCH`);
console.log(`${'='.repeat(60)}`);

await shutdown();

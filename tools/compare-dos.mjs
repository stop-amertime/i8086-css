#!/usr/bin/env node
// Conformance comparison for DOS boot: reference emulator vs Calcite
//
// Usage: node tools/compare-dos.mjs [--ticks=N]
//
// Loads the same memory image as generate-dos.mjs, runs the JS reference
// emulator and Calcite side by side, and reports the first divergence with
// full context including memory values at the divergent instruction.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// --- Parse args ---
const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v ?? 'true'];
  })
);
const maxTicks = parseInt(flags.ticks || '10000');

// --- Paths ---
const biosPath = resolve(projectRoot, 'build', 'gossamer-dos.bin');
const biosLstPath = resolve(projectRoot, 'build', 'gossamer-dos.lst');
const kernelPath = resolve(projectRoot, 'dos', 'bin', 'kernel.sys');
const diskPath = resolve(projectRoot, 'dos', 'disk.img');
const cssPath = resolve(projectRoot, flags.css || 'shell-dos.css'); // --css=file.css to override

// --- Load binaries ---
const biosBin = readFileSync(biosPath);
const kernelBin = readFileSync(kernelPath);
const diskBin = readFileSync(diskPath);

// Get bios_init offset
let biosInitOffset = 0x37C;
try {
  const lst = readFileSync(biosLstPath, 'utf-8');
  for (const line of lst.split('\n')) {
    if (line.includes('bios_init:')) {
      const idx = lst.split('\n').indexOf(line);
      const m = lst.split('\n')[idx + 1]?.match(/([0-9A-Fa-f]{8})/);
      if (m) biosInitOffset = parseInt(m[1], 16);
      break;
    }
  }
} catch {}

// --- Set up reference emulator ---
const js8086Source = readFileSync(resolve(__dirname, 'js8086.js'), 'utf-8');
const evalSource = js8086Source.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 0;');
const Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();

const memory = new Uint8Array(1024 * 1024);
for (let i = 0; i < kernelBin.length; i++) memory[0x600 + i] = kernelBin[i];
for (let i = 0; i < diskBin.length && 0xD0000 + i < memory.length; i++) memory[0xD0000 + i] = diskBin[i];
for (let i = 0; i < biosBin.length; i++) memory[0xF0000 + i] = biosBin[i];

const cpu = Intel8086(
  (addr, val) => { memory[addr & 0xFFFFF] = val & 0xFF; },
  (addr) => memory[addr & 0xFFFFF],
);
cpu.reset();
cpu.setRegs({
  cs: 0xF000, ip: biosInitOffset,
  ss: 0, sp: 0xFFF8, ds: 0, es: 0,
  ah: 0, al: 0, bh: 0, bl: 0, ch: 0, cl: 0, dh: 0, dl: 0,
});

function refState() {
  const r = cpu.getRegs();
  return {
    AX: (r.ah << 8) | r.al, CX: (r.ch << 8) | r.cl,
    DX: (r.dh << 8) | r.dl, BX: (r.bh << 8) | r.bl,
    SP: r.sp, BP: r.bp, SI: r.si, DI: r.di,
    IP: r.ip, ES: r.es, CS: r.cs, SS: r.ss, DS: r.ds, FLAGS: r.flags,
  };
}

// --- Generate reference trace ---
console.error(`Running reference emulator (${maxTicks} ticks)...`);
const refTrace = [];
for (let t = 0; t < maxTicks; t++) {
  const st = refState(); // snapshot BEFORE step
  refTrace.push({ tick: t, ...st });
  cpu.step();
}
console.error(`Reference: ${refTrace.length} ticks`);

// --- Run Calcite ---
console.error(`Running Calcite...`);
const calciteBin = resolve(projectRoot, '..', 'calcite', 'target', 'release', 'calcite-cli.exe');
// Run enough ticks to cover REP expansions (10x ref ticks, capped at 1M)
const calciteTicks = Math.min(maxTicks * 10, 1000000);
const calciteCmd = `"${calciteBin}" --input "${cssPath}" --ticks ${calciteTicks} --trace-json --halt 0x0504`;

let calciteOutput;
try {
  calciteOutput = execSync(calciteCmd, { encoding: 'utf-8', maxBuffer: 500 * 1024 * 1024 });
} catch (e) {
  calciteOutput = e.stdout || '';
  if (e.stderr) console.error('Calcite stderr:', e.stderr.slice(0, 500));
}

let calciteTrace = [];
for (const line of calciteOutput.split('\n')) {
  if (!line.startsWith('[')) continue;
  try {
    const arr = JSON.parse(line);
    if (Array.isArray(arr)) { calciteTrace = arr; break; }
  } catch {}
}
console.error(`Calcite: ${calciteTrace.length} ticks`);

// --- Compare ---
// CSS trace: tick 0 = state AFTER first instruction.
// Ref trace: tick 0 = state BEFORE first instruction.
// So ref[i+1] should match css[i] (both show state after instruction i executes).

const REG_NAMES = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI', 'CS', 'DS', 'ES', 'SS'];

let ci = 0; // calcite cursor
let matchCount = 0;
let firstDiv = null;

for (let ri = 1; ri < refTrace.length && ci < calciteTrace.length; ri++) {
  const ref = refTrace[ri];
  const cal = calciteTrace[ci];

  // Compare flat IP
  const refFlat = ref.CS * 16 + ref.IP;
  const calFlat = cal.CS * 16 + cal.IP;

  // If IPs don't match, try to advance calcite (REP expansion)
  if (refFlat !== calFlat) {
    let found = false;
    for (let j = ci + 1; j < Math.min(ci + 50000, calciteTrace.length); j++) {
      const c = calciteTrace[j];
      if (c.CS * 16 + c.IP === refFlat) {
        ci = j;
        found = true;
        break;
      }
    }
    if (!found) {
      firstDiv = { ri, ci, ref, cal, reason: 'IP mismatch — could not resync' };
      break;
    }
  }

  // IPs match — compare registers
  const calNow = calciteTrace[ci];
  const diffs = [];
  for (const reg of REG_NAMES) {
    if (ref[reg] !== calNow[reg]) diffs.push({ reg, ref: ref[reg], cal: calNow[reg] });
  }
  // Compare flat IP
  const calNowFlat = calNow.CS * 16 + calNow.IP;
  if (refFlat !== calNowFlat) diffs.push({ reg: 'IP(flat)', ref: refFlat, cal: calNowFlat });

  if (diffs.length > 0) {
    firstDiv = { ri, ci, ref, cal: calNow, diffs };
    break;
  }

  matchCount++;
  ci++;
}

// --- Report ---
console.log(`\n${'═'.repeat(70)}`);
console.log(`  DOS CONFORMANCE: ref emulator vs Calcite`);
console.log(`${'═'.repeat(70)}`);
console.log(`  Ref ticks: ${refTrace.length}  Calcite ticks: ${calciteTrace.length}`);
console.log(`  Matching instructions: ${matchCount}`);

if (!firstDiv) {
  console.log(`\n  ✓ ALL ${matchCount} INSTRUCTIONS MATCH`);
} else {
  const d = firstDiv;
  console.log(`\n  DIVERGENCE at ref tick ${d.ri}, calcite tick ${d.ci}`);
  if (d.reason) console.log(`  ${d.reason}`);
  console.log(`${'─'.repeat(70)}`);

  // Context: 5 ref ticks before divergence
  console.log('\n  Reference emulator trace:');
  for (let i = Math.max(1, d.ri - 5); i <= Math.min(d.ri + 2, refTrace.length - 1); i++) {
    const r = refTrace[i];
    const marker = i === d.ri ? ' >>>' : '    ';
    const flat = r.CS * 16 + r.IP;
    console.log(`${marker} t${i}: ${r.CS.toString(16)}:${r.IP.toString(16)} (0x${flat.toString(16)}) AX=${r.AX.toString(16)} CX=${r.CX.toString(16)} DX=${r.DX.toString(16)} BX=${r.BX.toString(16)} SP=${r.SP.toString(16)} DS=${r.DS.toString(16)} FL=${r.FLAGS.toString(16)}`);
  }

  console.log('\n  Calcite trace:');
  for (let i = Math.max(0, d.ci - 5); i <= Math.min(d.ci + 2, calciteTrace.length - 1); i++) {
    const c = calciteTrace[i];
    const marker = i === d.ci ? ' >>>' : '    ';
    const flat = c.CS * 16 + c.IP;
    console.log(`${marker} t${i}: ${c.CS.toString(16)}:${c.IP.toString(16)} (0x${flat.toString(16)}) AX=${c.AX.toString(16)} CX=${c.CX.toString(16)} DX=${c.DX.toString(16)} BX=${c.BX.toString(16)} SP=${c.SP.toString(16)} DS=${c.DS.toString(16)} FL=${c.FLAGS.toString(16)}`);
  }

  if (d.diffs) {
    console.log('\n  Divergent registers:');
    for (const { reg, ref: rv, cal: cv } of d.diffs) {
      console.log(`    ${reg}: ref=0x${rv.toString(16)} (${rv})  calcite=0x${cv.toString(16)} (${cv})`);
    }
  }

  // Instruction bytes at the point of divergence
  const prevRef = refTrace[d.ri - 1];
  if (prevRef) {
    const flat = prevRef.CS * 16 + prevRef.IP;
    const bytes = [];
    for (let b = 0; b < 8; b++) bytes.push(memory[flat + b].toString(16).padStart(2, '0'));
    console.log(`\n  Instruction that caused divergence:`);
    console.log(`    At ${prevRef.CS.toString(16)}:${prevRef.IP.toString(16)} (linear 0x${flat.toString(16)}): ${bytes.join(' ')}`);

    // If it's an INT instruction, show IVT values
    if (memory[flat] === 0xCD) {
      const intNum = memory[flat + 1];
      const ivtAddr = intNum * 4;
      const handlerIP = memory[ivtAddr] | (memory[ivtAddr + 1] << 8);
      const handlerCS = memory[ivtAddr + 2] | (memory[ivtAddr + 3] << 8);
      console.log(`    INT 0x${intNum.toString(16)} → IVT[0x${ivtAddr.toString(16)}]: CS:IP = ${handlerCS.toString(16)}:${handlerIP.toString(16)}`);
      console.log(`    IVT bytes: ${memory[ivtAddr].toString(16)} ${memory[ivtAddr+1].toString(16)} ${memory[ivtAddr+2].toString(16)} ${memory[ivtAddr+3].toString(16)}`);
    }
  }
}

console.log(`\n${'═'.repeat(70)}`);

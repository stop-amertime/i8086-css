#!/usr/bin/env node
// Conformance comparison: reference 8086 emulator vs calcite
//
// Usage: node tools/compare.mjs <program.com> <gossamer.bin> <program.css> [--ticks=N] [--dump-slots]
//
// Runs both emulators, finds the first tick where registers diverge,
// and outputs a diagnostic report.
//
// The reference emulator executes REP-prefixed string ops as a single step
// (CX→0 in one tick), while the CSS executes one iteration per tick.
// The comparison aligns traces by IP to handle this difference.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Parse args ---
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v ?? 'true'];
  })
);

if (positional.length < 3) {
  console.error('Usage: node tools/compare.mjs <program.com> <gossamer.bin> <program.css> [--ticks=N] [--dump-slots]');
  process.exit(1);
}

const comPath = resolve(positional[0]);
const biosPath = resolve(positional[1]);
const cssPath = resolve(positional[2]);
const maxTicks = parseInt(flags.ticks || '500');
const calciteTicks = parseInt(flags['calcite-ticks'] || String(maxTicks * 10));
const dumpSlots = 'dump-slots' in flags;

// --- Load reference emulator ---
const js8086Source = readFileSync(resolve(__dirname, 'js8086.js'), 'utf-8');
const evalSource = js8086Source.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 0;');
const Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();

const comBin = readFileSync(comPath);
const biosBin = readFileSync(biosPath);

// 1MB flat memory
const memory = new Uint8Array(1024 * 1024);

// Load .COM at 0000:0100
for (let i = 0; i < comBin.length; i++) memory[0x100 + i] = comBin[i];

// Load BIOS at F000:0000
const BIOS_BASE = 0xF0000;
for (let i = 0; i < biosBin.length; i++) memory[BIOS_BASE + i] = biosBin[i];

// IVT
const BIOS_SEG = 0xF000;
const handlers = {
  0x10: 0x0000, 0x16: 0x0155, 0x1A: 0x0190,
  0x20: 0x023D, 0x21: 0x01A9,
};
for (const [intNum, off] of Object.entries(handlers)) {
  const addr = parseInt(intNum) * 4;
  memory[addr] = off & 0xFF;
  memory[addr + 1] = (off >> 8) & 0xFF;
  memory[addr + 2] = BIOS_SEG & 0xFF;
  memory[addr + 3] = (BIOS_SEG >> 8) & 0xFF;
}

const cpu = Intel8086(
  (addr, val) => { memory[addr & 0xFFFFF] = val & 0xFF; },
  (addr) => memory[addr & 0xFFFFF],
);
cpu.reset();
cpu.setRegs({ cs: 0, ip: 0x0100, ss: 0, sp: 0x05F8, ds: 0, es: 0 });

function refState() {
  const r = cpu.getRegs();
  return {
    AX: (r.ah << 8) | r.al, CX: (r.ch << 8) | r.cl,
    DX: (r.dh << 8) | r.dl, BX: (r.bh << 8) | r.bl,
    SP: r.sp, BP: r.bp, SI: r.si, DI: r.di,
    IP: r.cs * 16 + r.ip,
    ES: r.es, CS: r.cs, SS: r.ss, DS: r.ds, FLAGS: r.flags,
  };
}

// --- Generate reference trace ---
console.error(`Running reference emulator for ${maxTicks} ticks...`);
const refTrace = [];
let lastRefIP = -1;
for (let t = 0; t < maxTicks; t++) {
  cpu.step();
  const st = refState();
  refTrace.push({ tick: t, ...st });
  if (st.IP === lastRefIP) {
    console.error(`Ref halted at tick ${t}, IP=0x${st.IP.toString(16)}`);
    break;
  }
  lastRefIP = st.IP;
}
writeFileSync(resolve(__dirname, '..', 'ref-trace.json'), JSON.stringify(refTrace));
console.error(`Reference trace saved (${refTrace.length} ticks)`);

// --- Run calcite and capture trace ---
console.error(`Running calcite for ${calciteTicks} ticks...`);

// Find calcite binary
const calciteBin = resolve(__dirname, '..', '..', 'calcite', 'target', 'release', 'calcite-cli.exe');
const calciteCmd = [
  calciteBin,
  '--input', cssPath,
  '--ticks', String(calciteTicks),
  '--trace-json',
  '--halt', '0x2110',
].join(' ');

let calciteOutput;
try {
  calciteOutput = execSync(calciteCmd, {
    encoding: 'utf-8',
    maxBuffer: 200 * 1024 * 1024,
  });
} catch (e) {
  calciteOutput = e.stdout || '';
  if (e.stderr) console.error('calcite stderr:', e.stderr.slice(0, 500));
}

// Parse calcite JSON trace (last non-empty line is the JSON array)
const calciteTrace = [];
const lines = calciteOutput.trim().split('\n');
for (let i = lines.length - 1; i >= 0; i--) {
  try {
    const arr = JSON.parse(lines[i]);
    if (Array.isArray(arr)) {
      calciteTrace.push(...arr);
      break;
    }
  } catch {}
}

console.error(`Calcite trace parsed (${calciteTrace.length} ticks)`);

// --- Compare with IP-aligned cursors ---
// The ref emulator does REP as one tick, calcite does N ticks.
// We compare at instruction boundaries: when ref advances to a new IP,
// we advance calcite until it reaches the same IP (or close enough).

const REG_NAMES = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI', 'IP', 'ES', 'CS', 'SS', 'DS'];

// Normalise IP: ref uses flat (CS*16+IP), calcite uses just IP.
// When CS != 0 (BIOS), ref IP includes the CS base. We need to handle this.
function normaliseIP(state) {
  // If the state has both CS and IP, calcite IP is already the offset within segment,
  // but ref IP is CS*16+IP. For comparison, use CS and IP-within-segment.
  // Actually, calcite stores IP as the flat address within CS:
  // calcite's IP = offset, and CS is separate. ref IP = CS*16 + offset.
  // So normalised IP = CS*16 + IP for calcite, and just IP for ref.
  if (state.CS !== undefined && state.CS > 0) {
    return state.CS * 16 + state.IP;
  }
  return state.IP;
}

let firstDivergence = null;
let matchCount = 0;
let totalCompared = 0;
let repSkips = 0;

let ci = 0; // calcite cursor

for (let ri = 0; ri < refTrace.length && ci < calciteTrace.length; ri++) {
  const ref = refTrace[ri];
  const cal = calciteTrace[ci];
  const refIP = ref.IP;
  const calIP = normaliseIP(cal);

  // If IPs don't match, the calcite trace may be mid-REP.
  // Advance calcite cursor until IP matches ref IP, or we run out.
  if (refIP !== calIP) {
    let found = false;
    const searchLimit = ci + 500; // don't search forever
    for (let j = ci + 1; j < calciteTrace.length && j < searchLimit; j++) {
      const candidate = calciteTrace[j];
      const candIP = normaliseIP(candidate);
      if (candIP === refIP) {
        const skipped = j - ci;
        repSkips += skipped;
        ci = j;
        found = true;
        break;
      }
    }
    if (!found) {
      // Can't find matching IP — report divergence
      firstDivergence = {
        refTick: ri, calTick: ci,
        diffs: [{ reg: 'IP', ref: refIP, cal: calIP }],
        ref, cal,
        reason: `IP mismatch: ref=0x${refIP.toString(16)} cal=0x${calIP.toString(16)} (could not resync)`,
      };
      break;
    }
  }

  // Now IPs match. Compare registers.
  const calNow = calciteTrace[ci];
  const diffs = [];
  for (const reg of REG_NAMES) {
    let rv = ref[reg], cv = calNow[reg];
    // Normalise IP for comparison (flat vs segmented)
    if (reg === 'IP') {
      rv = ref.IP;
      cv = normaliseIP(calNow);
    }
    if (rv !== cv) {
      diffs.push({ reg, ref: rv, cal: cv });
    }
  }

  if (diffs.length > 0) {
    firstDivergence = {
      refTick: ri, calTick: ci,
      diffs, ref, cal: calNow,
    };
    break;
  }
  matchCount++;
  totalCompared++;
  ci++;
}

// --- Report ---
console.log(`\n${'='.repeat(60)}`);
console.log(`CONFORMANCE REPORT: ${positional[0]}`);
console.log(`${'='.repeat(60)}`);
console.log(`Ref ticks: ${refTrace.length}  Calcite ticks: ${calciteTrace.length}`);
console.log(`Instructions compared: ${totalCompared}`);
console.log(`Matching: ${matchCount}`);
if (repSkips > 0) {
  console.log(`REP tick skips: ${repSkips} (calcite ticks for multi-iteration REP ops)`);
}

if (!firstDivergence) {
  console.log(`\nRESULT: ALL ${matchCount} INSTRUCTIONS MATCH`);
} else {
  const d = firstDivergence;
  console.log(`\nFIRST DIVERGENCE at ref tick ${d.refTick}, calcite tick ${d.calTick}:`);
  if (d.reason) console.log(`  ${d.reason}`);
  console.log(`${'─'.repeat(40)}`);

  // Show context: 3 ref ticks before
  const contextStart = Math.max(0, d.refTick - 3);
  for (let i = contextStart; i <= d.refTick; i++) {
    const r = refTrace[i];
    const marker = i === d.refTick ? '>>>' : '   ';
    console.log(`${marker} Ref tick ${i}:`);
    console.log(`     REF: AX=${r.AX} CX=${r.CX} DX=${r.DX} BX=${r.BX} SP=${r.SP} BP=${r.BP} SI=${r.SI} DI=${r.DI} IP=0x${r.IP.toString(16)} CS=${r.CS} FLAGS=0x${r.FLAGS.toString(16)}`);
  }
  console.log(`     CAL: AX=${d.cal.AX} CX=${d.cal.CX} DX=${d.cal.DX} BX=${d.cal.BX} SP=${d.cal.SP} BP=${d.cal.BP} SI=${d.cal.SI} DI=${d.cal.DI} IP=0x${normaliseIP(d.cal).toString(16)} CS=${d.cal.CS} FLAGS=0x${(d.cal.FLAGS||0).toString(16)}`);

  console.log(`\nDivergent registers:`);
  for (const { reg, ref: rv, cal: cv } of d.diffs) {
    console.log(`  ${reg}: ref=${rv} (0x${rv.toString(16)})  calcite=${cv} (0x${cv.toString(16)})`);
  }

  // What instruction is at the divergent IP?
  const prevRef = d.refTick > 0 ? refTrace[d.refTick - 1] : null;
  if (prevRef) {
    const ip = prevRef.IP;
    const biosOff = ip >= BIOS_BASE ? ip - BIOS_BASE : null;
    console.log(`\nInstruction context:`);
    console.log(`  Previous IP: 0x${ip.toString(16)}${biosOff !== null ? ` = BIOS+0x${biosOff.toString(16)}` : ''}`);
    if (ip < 0x100 + comBin.length && ip >= 0x100) {
      const off = ip - 0x100;
      const bytes = Array.from(comBin.slice(off, off + 6)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`  Bytes at IP: ${bytes} (.COM+0x${off.toString(16)})`);
    } else if (biosOff !== null && biosOff < biosBin.length) {
      const bytes = Array.from(biosBin.slice(biosOff, biosOff + 6)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`  Bytes at IP: ${bytes} (BIOS+0x${biosOff.toString(16)})`);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);

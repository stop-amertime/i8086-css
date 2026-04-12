#!/usr/bin/env node
// JS→CSS transpiler for CSS-DOS
// Generates a CSS file containing a complete 8086 CPU from a .COM binary.
//
// Usage: node transpiler/generate-hacky.mjs program.com -o program.css [--mem SIZE] [--html]
//
// This is the "hack path": raw .COM loader with no DOS, a minimal BIOS, and
// an explicitly non-canonical memory layout. For a real DOS/PC machine that
// matches real hardware layout, use generate-dos.mjs. See CLAUDE.md.
//
// --mem SIZE controls the conventional memory area (IVT + BDA + program + stack).
// Default: program size + 4KB stack headroom, minimum 0x600 (1536).
// VGA text RAM (0xB8000) and BIOS ROM (0xF0000) are always included.

import { readFileSync, createWriteStream, statSync } from 'fs';
import { resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { emitCSS } from './src/emit-css.mjs';
import { comMemoryZones, buildIVTData } from './src/memory.mjs';
import { loadIvtHandlers } from '../tools/lib/bios-symbols.mjs';
import { buildBiosRom } from './src/patterns/bios.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CLI argument parsing ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node generate-hacky.mjs <program.com> [-o output.css] [--mem SIZE] [--data ADDR FILE ...] [--html] [--graphics]');
  process.exit(1);
}

let inputFile = null;
let outputFile = null;
let memOverride = null;
let htmlMode = false;
let graphics = false;
const embeddedData = []; // [{addr, bytes}]

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-o' && i + 1 < args.length) {
    outputFile = args[++i];
  } else if (arg === '--mem' && i + 1 < args.length) {
    memOverride = parseInt(args[++i]);
  } else if (arg === '--data' && i + 2 < args.length) {
    const addr = parseInt(args[++i]);
    const file = args[++i];
    const bytes = readFileSync(resolve(file));
    embeddedData.push({ addr, bytes: [...bytes] });
  } else if (arg === '--html') {
    htmlMode = true;
  } else if (arg === '--graphics') {
    graphics = true;
  } else if (!inputFile) {
    inputFile = arg;
  }
}

if (!inputFile) {
  console.error('Error: no input file specified');
  process.exit(1);
}

// Read input binary
const programBytes = [...readFileSync(resolve(inputFile))];
const programOffset = 0x100; // .COM files load at offset 0x100

// Read BIOS
const biosPath = resolve(__dirname, '..', 'build', 'gossamer.bin');
const biosLstPath = resolve(__dirname, '..', 'build', 'gossamer.lst');
let biosBytes;
let biosHandlers = null;
try {
  biosBytes = [...readFileSync(biosPath)];
  // The listing is the source of truth for handler offsets. Any time the
  // BIOS is rebuilt, offsets shift — reading them fresh means we never
  // drift. See tools/lib/bios-symbols.mjs.
  biosHandlers = loadIvtHandlers(biosLstPath);
} catch (e) {
  console.error(`Warning: could not load BIOS from ${biosPath}: ${e.message}`);
  biosBytes = [];
}

// Compute conventional memory size
// Default 0x600 (1536) matches ref-emu SP=0x5F8 for .COM conformance testing.
// Use --mem to increase for programs that need more stack/heap.
const programEnd = programOffset + programBytes.length;
const defaultMem = Math.max(0x600, programEnd + 0x100);
const memBytes = memOverride != null ? memOverride : defaultMem;

// Pre-populate IVT with BIOS handler vectors. The hack path doesn't run
// bios_init, so we write the IVT from outside — using offsets freshly
// parsed from gossamer.lst. This is the TEST-HARNESS way of doing it;
// the DOS path (generate-dos.mjs) lets bios_init own the IVT like a
// real PC. See CLAUDE.md ("What CSS-DOS is").
if (biosHandlers) {
  embeddedData.push(buildIVTData(biosHandlers));
}

// Phase 5 BIOS microcode: append ROM stubs after gossamer.bin.
// Each BIOS-handled interrupt gets a 3-byte stub [0xD6, routineID, 0xCF]
// placed right after the gossamer binary in the BIOS region (0xF0000+).
// IVT entries for these interrupts are overridden to point to the new stubs.
const { handlers: biosRomHandlers, romBytes: biosRomBytes } = buildBiosRom();
const biosRomOffset = biosBytes.length; // offset within BIOS region
for (let i = 0; i < biosRomBytes.length; i++) {
  biosBytes.push(biosRomBytes[i]);
}
// Override IVT entries for BIOS-handled interrupts to point to the new ROM.
// We build a dense byte array covering only the IVT slots we need to override,
// then push it as an embeddedData entry AFTER the gossamer IVT so it wins.
const BIOS_SEG = 0xF000;
for (const [intNum, stubOffset] of Object.entries(biosRomHandlers)) {
  const ivtAddr = parseInt(intNum) * 4;
  const handlerOffset = biosRomOffset + stubOffset;
  // Push a 4-byte embeddedData entry for each overridden IVT slot
  embeddedData.push({
    addr: ivtAddr,
    bytes: [
      handlerOffset & 0xFF,
      (handlerOffset >> 8) & 0xFF,
      BIOS_SEG & 0xFF,
      (BIOS_SEG >> 8) & 0xFF,
    ],
  });
}

// Build memory zones
const memoryZones = comMemoryZones(programBytes, programOffset, memBytes, graphics);

// Derive output filename from input if not specified
if (!outputFile) {
  const base = basename(inputFile, extname(inputFile));
  outputFile = base + (htmlMode ? '.html' : '.css');
}

// Report memory layout
const totalAddresses = memoryZones.reduce((sum, [s, e]) => sum + (e - s), 0);
console.log(`Memory zones: ${memoryZones.map(([s,e]) => `0x${s.toString(16)}-0x${e.toString(16)} (${e-s})`).join(', ')}`);
console.log(`Total addresses: ${totalAddresses} (${(totalAddresses / 1024).toFixed(1)} KB)`);

// Generate CSS — stream to file
const outPath = resolve(outputFile);
const ws = createWriteStream(outPath, { encoding: 'utf-8' });

emitCSS({
  programBytes,
  biosBytes,
  memoryZones,
  embeddedData,
  htmlMode,
  programOffset,
}, ws);

ws.end(() => {
  const size = statSync(outPath).size;
  console.log(`Generated ${outputFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
});

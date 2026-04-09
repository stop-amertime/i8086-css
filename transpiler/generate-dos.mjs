#!/usr/bin/env node
// DOS boot mode for CSS-DOS
//
// Generates a CSS file that boots DOS, which then loads and runs
// the target program via its real DOS kernel.
//
// Usage: node transpiler/generate-dos.mjs program.com -o program.css [--html]
//
// This script:
// 1. Builds a FAT12 disk image containing KERNEL.SYS, CONFIG.SYS, and the program
// 2. Assembles the DOS BIOS (gossamer-dos.asm)
// 3. Calls the transpiler with the kernel, disk image, and BIOS embedded in memory

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { emitCSS } from './src/emit-css.mjs';
import { dosMemoryZones } from './src/memory.mjs';
import { createWriteStream, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// --- Paths ---
const NASM = 'C:/Users/AdmT9N0CX01V65438A/AppData/Local/bin/NASM/nasm.exe';
const BIOS_ASM = resolve(projectRoot, 'gossamer-dos.asm');
const BIOS_BIN = resolve(projectRoot, 'gossamer-dos.bin');
const BIOS_LST = resolve(projectRoot, 'gossamer-dos.lst');
const KERNEL_SYS = resolve(projectRoot, 'dos', 'bin', 'kernel.sys');
const MKFAT12 = resolve(projectRoot, 'tools', 'mkfat12.mjs');
const CONFIG_SYS = resolve(projectRoot, 'dos', 'config.sys');

// --- Memory layout ---
const KERNEL_LINEAR = 0x600;     // 0060:0000 — where DOS kernel expects to be loaded
const DISK_LINEAR = 0xD0000;     // D000:0000 — memory-resident disk image
const BIOS_LINEAR = 0xF0000;     // F000:0000 — BIOS ROM

// --- CLI argument parsing ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node generate-dos.mjs <program.com> [-o output] [--html] [--data NAME PATH] ...');
  process.exit(1);
}

let inputFile = null;
let outputFile = null;
let htmlMode = false;
let memOverride = null;
const dataFiles = []; // [{name, path}] — companion files to include on disk

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' && i + 1 < args.length) {
    outputFile = args[++i];
  } else if (args[i] === '--html') {
    htmlMode = true;
  } else if (args[i] === '--mem' && i + 1 < args.length) {
    memOverride = parseInt(args[++i]);
  } else if (args[i] === '--data' && i + 2 < args.length) {
    const name = args[++i];
    const path = args[++i];
    dataFiles.push({ name, path });
  } else if (!inputFile) {
    inputFile = args[i];
  }
}

if (!inputFile) {
  console.error('Error: no input file specified');
  process.exit(1);
}

const programName = basename(inputFile).toUpperCase();
const programName83 = programName.length <= 12 ? programName : programName.substring(0, 12);

// --- Step 1: Assemble BIOS ---
console.log('Assembling BIOS...');
try {
  execSync(`"${NASM}" -f bin -o "${BIOS_BIN}" "${BIOS_ASM}" -l "${BIOS_LST}"`, {
    stdio: 'pipe',
  });
} catch (e) {
  console.error('NASM failed:', e.stderr?.toString());
  process.exit(1);
}
const biosBytes = [...readFileSync(BIOS_BIN)];
console.log(`  BIOS: ${biosBytes.length} bytes`);

// --- Step 2: Get bios_init offset from listing ---
const listing = readFileSync(BIOS_LST, 'utf-8');
let biosInitOffset = null;
const lines = listing.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('bios_init:')) {
    // Next line has the offset
    const match = lines[i + 1]?.match(/([0-9A-Fa-f]{8})/);
    if (match) {
      biosInitOffset = parseInt(match[1], 16);
    }
    break;
  }
}
if (biosInitOffset === null) {
  console.error('Error: could not find bios_init offset in listing');
  process.exit(1);
}
console.log(`  bios_init offset: 0x${biosInitOffset.toString(16)}`);

// --- Step 3: Build disk image ---
console.log('Building FAT12 disk image...');
const diskImgPath = resolve(projectRoot, 'dos', 'disk.img');

// Write a CONFIG.SYS that runs the program
const configContent = `SHELL=\\${programName83}\n`;
writeFileSync(CONFIG_SYS, configContent);

let mkfatCmd = `node "${MKFAT12}" -o "${diskImgPath}" --file KERNEL.SYS "${KERNEL_SYS}" --file CONFIG.SYS "${CONFIG_SYS}" --file ${programName83} "${resolve(inputFile)}"`;
for (const df of dataFiles) {
  const name83 = df.name.toUpperCase();
  mkfatCmd += ` --file ${name83} "${resolve(df.path)}"`;
}
try {
  const out = execSync(mkfatCmd, { stdio: 'pipe' });
  console.log(out.toString().trim());
} catch (e) {
  console.error('mkfat12 failed:', e.stderr?.toString());
  process.exit(1);
}
if (dataFiles.length > 0) {
  console.log(`  Companion files: ${dataFiles.map(f => f.name).join(', ')}`);
}
const diskBytes = [...readFileSync(diskImgPath)];
console.log(`  Disk image: ${diskBytes.length} bytes`);

// --- Step 4: Read kernel ---
const kernelBytes = [...readFileSync(KERNEL_SYS)];
console.log(`  Kernel: ${kernelBytes.length} bytes`);

// --- Step 5: Derive output filename ---
if (!outputFile) {
  const base = basename(inputFile, extname(inputFile));
  outputFile = base + '-dos' + (htmlMode ? '.html' : '.css');
}

// --- Step 6: Generate CSS ---
console.log('Generating CSS...');

// DOS conventional memory size. The kernel relocates its own code and data
// structures to the top of conventional memory (up to 0xA0000 = 640KB),
// so we always need the full 640KB. Use --mem to override if needed.
const defaultMem = 0xA0000;
const memBytes = memOverride != null ? memOverride : defaultMem;

const embData = [{ addr: DISK_LINEAR, bytes: diskBytes }];
const memoryZones = dosMemoryZones(kernelBytes, KERNEL_LINEAR, memBytes, embData);

const totalAddresses = memoryZones.reduce((sum, [s, e]) => sum + (e - s), 0);
console.log(`Memory zones: ${memoryZones.map(([s,e]) => `0x${s.toString(16)}-0x${e.toString(16)} (${e-s})`).join(', ')}`);
console.log(`Total addresses: ${totalAddresses} (${(totalAddresses / 1024).toFixed(1)} KB)`);

const outPath = resolve(outputFile);
const ws = createWriteStream(outPath, { encoding: 'utf-8' });

emitCSS({
  programBytes: kernelBytes,
  biosBytes,
  memoryZones,
  embeddedData: embData,
  htmlMode,
  programOffset: KERNEL_LINEAR,  // kernel loaded at 0x600
  initialCS: 0xF000,
  initialIP: biosInitOffset,
}, ws);

ws.end(() => {
  const size = statSync(outPath).size;
  console.log(`Generated ${outputFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
});

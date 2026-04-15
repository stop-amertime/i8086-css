#!/usr/bin/env node
// DOS boot mode for CSS-DOS — C BIOS variant.
//
// Same as generate-dos.mjs but builds the BIOS from C sources
// (bios/entry.asm + bios/bios_init.c + bios/handlers.asm → bios.bin
// via bios/build.mjs) instead of assembling bios/css-emu-bios.asm.
// The C BIOS adds a Mode 13h splash screen with the CSS-DOS logo.
//
// Use this when you want the pretty boot. The plain ASM BIOS
// (generate-dos.mjs) is smaller and doesn't need OpenWatcom.
//
// Usage: node transpiler/generate-dos-c.mjs program.com -o program.css [options]
//
// Options:
//   -o FILE         Output CSS (or HTML with --html)
//   --html          Emit an HTML file wrapping the CSS
//   --mem BYTES     Conventional memory size (default 0xA0000 = 640KB)
//   --data NAME PATH  Copy a companion file onto the disk image
//   --no-gfx        Omit the VGA Mode 13h framebuffer (0xA0000-0xAFA00).
//   --no-text-vga   Omit the VGA text buffer (0xB8000-0xB8FA0).
//
// BIOS handlers are microcode (transpiler/src/patterns/bios.mjs).
// The init stub (bios/init.asm) runs as real x86 at F000:0000 to set up
// the IVT, BDA, and splash screen, then jumps to the DOS kernel.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';
import { emitCSS } from './src/emit-css.mjs';
import { dosMemoryZones } from './src/memory.mjs';
import { createWriteStream, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// --- Paths ---
const KERNEL_SYS = resolve(projectRoot, 'dos', 'bin', 'kernel.sys');
const MKFAT12 = resolve(projectRoot, 'tools', 'mkfat12.mjs');
const CONFIG_SYS = resolve(projectRoot, 'dos', 'config.sys');

// --- Memory layout ---
const KERNEL_LINEAR = 0x600;     // 0060:0000 — where DOS kernel expects to be loaded
const DISK_LINEAR = 0xD0000;     // D000:0000 — memory-resident disk image
const BIOS_LINEAR = 0xF0000;     // F000:0000 — BIOS ROM
const BIOS_SEG = 0xF000;
const BDA_SEG = 0x0040;
const BDA_BASE = 0x0400;

// --- CLI argument parsing ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node generate-dos.mjs <program.com> [-o output] [--html] [--mem N] [--data NAME PATH] [--no-gfx] [--no-text-vga]');
  process.exit(1);
}

let inputFile = null;
let outputFile = null;
let htmlMode = false;
let memOverride = null;
const prune = { gfx: false, textVga: false };
const dataFiles = []; // [{name, path}] — companion files to include on disk

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' && i + 1 < args.length) {
    outputFile = args[++i];
  } else if (args[i] === '--html') {
    htmlMode = true;
  } else if (args[i] === '--mem' && i + 1 < args.length) {
    memOverride = parseInt(args[++i]);
  } else if (args[i] === '--no-gfx') {
    prune.gfx = true;
  } else if (args[i] === '--no-text-vga') {
    prune.textVga = true;
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

// --- Step 1: Build BIOS ROM (C-based: entry.asm + bios_init.c + handlers.asm → bios.bin) ---
console.log('Building BIOS ROM...');
const biosBuildScript = resolve(projectRoot, 'bios', 'build.mjs');
execFileSync('node', [biosBuildScript], { stdio: 'inherit' });
const biosBinPath = resolve(projectRoot, 'bios', 'build', 'bios.bin');
const biosBytes = [...readFileSync(biosBinPath)];
console.log(`  BIOS ROM: ${biosBytes.length} bytes (from ${biosBinPath})`);

// --- Step 2: Build disk image ---
console.log('Building FAT12 disk image...');
const diskImgPath = resolve(projectRoot, 'dos', 'disk.img');

const COMMAND_COM = resolve(projectRoot, 'dos', 'bin', 'command.com');
const isShellMode = programName83 === 'SHELL.COM';
const shellProgram = isShellMode ? 'COMMAND.COM' : programName83;
const configContent = `SHELL=\\${shellProgram}\n`;
writeFileSync(CONFIG_SYS, configContent);

let mkfatCmd = `node "${MKFAT12}" -o "${diskImgPath}" --file KERNEL.SYS "${KERNEL_SYS}" --file CONFIG.SYS "${CONFIG_SYS}"`;
if (isShellMode) {
  mkfatCmd += ` --file COMMAND.COM "${COMMAND_COM}"`;
} else {
  mkfatCmd += ` --file ${programName83} "${resolve(inputFile)}"`;
}
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

// --- Step 3: Read kernel ---
const kernelBytes = [...readFileSync(KERNEL_SYS)];
console.log(`  Kernel: ${kernelBytes.length} bytes`);

// --- Step 4: Embedded data (disk only — IVT/BDA/splash done by init stub) ---
const embData = [];
embData.push({ addr: DISK_LINEAR, bytes: diskBytes });

const defaultMem = 0xA0000;
const memBytes = memOverride != null ? memOverride : defaultMem;

// --- Step 5: Derive output filename ---
if (!outputFile) {
  const base = basename(inputFile, extname(inputFile));
  outputFile = base + '-dos' + (htmlMode ? '.html' : '.css');
}

// --- Step 6: Generate CSS ---
console.log('Generating CSS...');

const memoryZones = dosMemoryZones(kernelBytes, KERNEL_LINEAR, memBytes, embData, prune);
if (prune.gfx)     console.log('  Pruned: VGA Mode 13h framebuffer (0xA0000-0xAFA00)');
if (prune.textVga) console.log('  Pruned: VGA text buffer (0xB8000-0xB8FA0)');

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
  initialCS: 0xF000,             // start at BIOS init stub
  initialIP: 0x0000,
  initialRegs: {},               // hardware reset state — init stub sets everything
}, ws);

ws.end(() => {
  const size = statSync(outPath).size;
  console.log(`Generated ${outputFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
});

#!/usr/bin/env node
// DOS boot mode for CSS-DOS
//
// Generates a CSS file that boots DOS, which then loads and runs
// the target program via its real DOS kernel.
//
// Usage: node transpiler/generate-dos.mjs program.com -o program.css [options]
//
// Options:
//   -o FILE         Output CSS (or HTML with --html)
//   --html          Emit an HTML file wrapping the CSS
//   --mem BYTES     Conventional memory size (default 0xA0000 = 640KB)
//   --data NAME PATH  Copy a companion file onto the disk image
//   --no-gfx        Omit the VGA Mode 13h framebuffer (0xA0000-0xAFA00).
//   --no-text-vga   Omit the VGA text buffer (0xB8000-0xB8FA0).
//
// BIOS handlers are microcode (transpiler/src/patterns/bios.mjs), not
// gossamer-dos.asm. The generator does the work of bios_init: populating
// the IVT, initializing the BDA, and booting the kernel directly.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { emitCSS } from './src/emit-css.mjs';
import { dosMemoryZones } from './src/memory.mjs';
import { createWriteStream, statSync } from 'fs';
import { buildBiosRom, IVT_ENTRIES, BIOS_OPCODE } from './src/patterns/bios.mjs';

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

// --- Step 1: Build microcode BIOS ROM ---
console.log('Building microcode BIOS ROM...');
const { handlers: biosRomHandlers, romBytes: biosRomBytes } = buildBiosRom();

// The BIOS ROM is just the microcode stubs. We also need an IRET byte (0xCF)
// for the dummy/default handler vectors. The buildBiosRom stubs already end
// with 0xCF, so we can point dummy vectors at any stub's IRET byte.
// We'll add a single IRET byte at the start of the ROM for dummy vectors.
const biosBytes = [0xCF, ...biosRomBytes]; // byte 0 = IRET for dummy handler
const dummyHandlerOffset = 0; // offset 0 in BIOS ROM = the IRET byte
const romStubBase = 1; // stubs shifted by 1 because of the leading IRET

// Adjust handler offsets to account for the leading IRET byte
for (const intNum of Object.keys(biosRomHandlers)) {
  biosRomHandlers[intNum] += romStubBase;
}

console.log(`  BIOS ROM: ${biosBytes.length} bytes (microcode stubs)`);

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

// --- Step 4: Build IVT and BDA as embedded data ---
console.log('Building IVT and BDA...');
const embData = [];

// Disk image at 0xD0000
embData.push({ addr: DISK_LINEAR, bytes: diskBytes });

// IVT: 256 entries, each 4 bytes (offset:segment).
// Default all to the dummy IRET handler, then override with microcode stubs.
const ivt = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) {
  // Point at the IRET byte at offset 0 in BIOS ROM
  ivt[i * 4 + 0] = dummyHandlerOffset & 0xFF;
  ivt[i * 4 + 1] = (dummyHandlerOffset >> 8) & 0xFF;
  ivt[i * 4 + 2] = BIOS_SEG & 0xFF;
  ivt[i * 4 + 3] = (BIOS_SEG >> 8) & 0xFF;
}
// Override with microcode handler stubs
for (const [intNum, stubOffset] of Object.entries(biosRomHandlers)) {
  const idx = parseInt(intNum);
  ivt[idx * 4 + 0] = stubOffset & 0xFF;
  ivt[idx * 4 + 1] = (stubOffset >> 8) & 0xFF;
  ivt[idx * 4 + 2] = BIOS_SEG & 0xFF;
  ivt[idx * 4 + 3] = (BIOS_SEG >> 8) & 0xFF;
}
embData.push({ addr: 0, bytes: [...ivt] });

// BDA: initialize fields that the kernel and BIOS handlers depend on.
// Matches gossamer-dos.asm bios_init exactly.
const bda = new Uint8Array(256); // BDA is 0x400-0x4FF (256 bytes)

// Equipment list: floppy present + 80x25 color = 0x0021
bda[0x10] = 0x21; bda[0x11] = 0x00;

// Memory size: 640 KiB
bda[0x13] = 640 & 0xFF; bda[0x14] = (640 >> 8) & 0xFF;

// Keyboard buffer
bda[0x1A] = 0x1E; bda[0x1B] = 0x00;  // head = 0x001E
bda[0x1C] = 0x1E; bda[0x1D] = 0x00;  // tail = 0x001E (empty)
bda[0x80] = 0x1E; bda[0x81] = 0x00;  // buffer start = 0x001E
bda[0x82] = 0x3E; bda[0x83] = 0x00;  // buffer end = 0x003E

// Keyboard flags
bda[0x17] = 0; bda[0x18] = 0; bda[0x19] = 0;

// Video mode and parameters
bda[0x49] = 0x03;  // mode 3 = 80x25 text
bda[0x4A] = 80; bda[0x4B] = 0;  // columns
bda[0x4C] = 0x00; bda[0x4D] = 0x10;  // page size = 0x1000
bda[0x4E] = 0x00; bda[0x4F] = 0x00;  // page offset = 0
bda[0x50] = 0; bda[0x51] = 0;  // cursor pos page 0 (col, row)
bda[0x52] = 0; bda[0x53] = 0;  // cursor pos page 1
bda[0x54] = 0; bda[0x55] = 0;  // cursor pos page 2
bda[0x56] = 0; bda[0x57] = 0;  // cursor pos page 3
bda[0x60] = 0x07; bda[0x61] = 0x06;  // cursor shape (start=6, end=7)
bda[0x62] = 0;  // active page 0
bda[0x63] = 0xD4; bda[0x64] = 0x03;  // CRT port = 0x03D4
bda[0x84] = 24;  // rows minus 1
bda[0x85] = 16; bda[0x86] = 0;  // char height

// Timer
bda[0x6C] = 0; bda[0x6D] = 0; bda[0x6E] = 0; bda[0x6F] = 0;
bda[0x70] = 0;

// Floppy state
bda[0x3E] = 0; bda[0x3F] = 0; bda[0x40] = 0; bda[0x41] = 0;

// Warm boot flag
bda[0x72] = 0; bda[0x73] = 0;

embData.push({ addr: BDA_BASE, bytes: [...bda] });

// --- Step 5: Derive output filename ---
if (!outputFile) {
  const base = basename(inputFile, extname(inputFile));
  outputFile = base + '-dos' + (htmlMode ? '.html' : '.css');
}

// --- Step 6: Generate CSS ---
console.log('Generating CSS...');

const defaultMem = 0xA0000;
const memBytes = memOverride != null ? memOverride : defaultMem;

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
  biosBytes: [...biosBytes],
  memoryZones,
  embeddedData: embData,
  htmlMode,
  programOffset: KERNEL_LINEAR,  // kernel loaded at 0x600
  initialCS: 0x0060,             // kernel segment
  initialIP: 0x0000,             // kernel entry point
  initialRegs: {
    DS: 0,                       // bios_init left DS=0 after IVT setup
    BX: 0,                       // BL=0 = boot drive A:
    SS: 0x0030,                  // bios_init set SS:SP = 0030:0100
    SP: 0x0100,                  // (linear 0x0400, just below BDA)
  },
}, ws);

ws.end(() => {
  const size = statSync(outPath).size;
  console.log(`Generated ${outputFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
});

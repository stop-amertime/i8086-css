#!/usr/bin/env node
// JS→CSS transpiler for i8086-css
// Generates a CSS file containing a complete 8086 CPU from a .COM binary.
//
// Usage: node transpiler/generate.mjs program.com -o program.css [--mem SIZE] [--html]

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { emitCSS } from './src/emit-css.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CLI argument parsing ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node generate.mjs <program.com> [-o output.css] [--mem SIZE] [--data ADDR FILE ...] [--html]');
  process.exit(1);
}

let inputFile = null;
let outputFile = null;
let memSize = 0x600; // 1536 bytes default
let htmlMode = false;
const embeddedData = []; // [{addr, bytes}]

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-o' && i + 1 < args.length) {
    outputFile = args[++i];
  } else if (arg === '--mem' && i + 1 < args.length) {
    memSize = parseInt(args[++i]);
  } else if (arg === '--data' && i + 2 < args.length) {
    const addr = parseInt(args[++i]);
    const file = args[++i];
    const bytes = readFileSync(resolve(file));
    embeddedData.push({ addr, bytes: [...bytes] });
  } else if (arg === '--html') {
    htmlMode = true;
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

// Read BIOS
const biosPath = resolve(__dirname, '..', 'bios.bin');
let biosBytes;
try {
  biosBytes = [...readFileSync(biosPath)];
} catch {
  console.error(`Warning: bios.bin not found at ${biosPath}, proceeding without BIOS`);
  biosBytes = [];
}

// Derive output filename from input if not specified
if (!outputFile) {
  const base = basename(inputFile, extname(inputFile));
  outputFile = base + (htmlMode ? '.html' : '.css');
}

// Generate CSS
const css = emitCSS({
  programBytes,
  biosBytes,
  memSize,
  embeddedData,
  htmlMode,
  programOffset: 0x100, // .COM files load at offset 0x100
});

writeFileSync(resolve(outputFile), css, 'utf-8');
console.log(`Generated ${outputFile} (${(css.length / 1024).toFixed(1)} KB)`);

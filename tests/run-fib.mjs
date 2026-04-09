#!/usr/bin/env node
// Run fib.com through reference emulator and print text output from video memory.
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const js8086Source = readFileSync(resolve(root, 'tools/js8086.js'), 'utf-8');
const evalSource = js8086Source.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 0;');
const Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();

const comBin = readFileSync(resolve(root, 'examples/fib.com'));
const biosBin = readFileSync(resolve(root, 'gossamer.bin'));

const memory = new Uint8Array(1024 * 1024);
for (let i = 0; i < comBin.length; i++) memory[0x100 + i] = comBin[i];
for (let i = 0; i < biosBin.length; i++) memory[0xF0000 + i] = biosBin[i];

const handlers = { 0x10: 0x0000, 0x16: 0x0155, 0x1A: 0x0190, 0x20: 0x0232, 0x21: 0x01A9 };
for (const [intNum, off] of Object.entries(handlers)) {
  const a = parseInt(intNum) * 4;
  memory[a] = off & 0xFF; memory[a+1] = (off >> 8) & 0xFF;
  memory[a+2] = 0x00; memory[a+3] = 0xF0;
}

const cpu = Intel8086(
  (addr, val) => { memory[addr & 0xFFFFF] = val & 0xFF; },
  (addr) => memory[addr & 0xFFFFF]
);
cpu.reset();
cpu.setRegs({ cs: 0, ip: 0x100, ss: 0, sp: 0x5F8, ds: 0, es: 0, ah: 0, al: 0, bh: 0, bl: 0, ch: 0, cl: 0, dh: 0, dl: 0 });

const maxTicks = parseInt(process.argv[2] || '50000');
for (let i = 0; i < maxTicks; i++) cpu.step();

// Read video memory at B800:0000 (linear 0xB8000)
// Text mode: char byte + attribute byte pairs, 80 columns x 25 rows
let output = '';
for (let row = 0; row < 25; row++) {
  let line = '';
  for (let col = 0; col < 80; col++) {
    const ch = memory[0xB8000 + (row * 80 + col) * 2];
    line += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' ';
  }
  // Trim trailing spaces
  line = line.trimEnd();
  if (line.length > 0 || output.length > 0) output += line + '\n';
}

console.log(output.trimEnd());

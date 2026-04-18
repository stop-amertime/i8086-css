#!/usr/bin/env node
// Runs NASM on each BIOS flavour we ship. Writes binary output and
// per-flavour metadata (entry offset, size, source hash) to web/prebake/.
//
// Usage: node web/scripts/prebake.mjs

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const prebakeDir = resolve(__dirname, '..', 'prebake');
const NASM = process.env.NASM || 'C:\\Users\\AdmT9N0CX01V65438A\\AppData\\Local\\bin\\NASM\\nasm.exe';

mkdirSync(prebakeDir, { recursive: true });

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function findSymbol(listing, symbol) {
  const lines = listing.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`${symbol}:`)) {
      const m = lines[i + 1]?.match(/([0-9A-Fa-f]{8})/);
      if (m) return parseInt(m[1], 16);
    }
  }
  return null;
}

function bakeMuslin() {
  const asm = resolve(repoRoot, 'bios', 'muslin', 'muslin.asm');
  const bin = join(prebakeDir, 'muslin.bin');
  const lst = join(prebakeDir, 'muslin.lst');
  execSync(`"${NASM}" -f bin -o "${bin}" "${asm}" -l "${lst}"`, { stdio: 'pipe' });
  const bytes = readFileSync(bin);
  const listing = readFileSync(lst, 'utf8');
  // Remove intermediate listing file — not a deliverable
  try { unlinkSync(lst); } catch {}
  const entryOffset = findSymbol(listing, 'bios_init');
  if (entryOffset == null) throw new Error('muslin: could not find bios_init in listing');
  const sourceHash = sha256(readFileSync(asm));
  writeFileSync(join(prebakeDir, 'muslin.meta.json'), JSON.stringify({
    flavor: 'muslin',
    entrySegment: 0xF000,
    entryOffset,
    sizeBytes: bytes.length,
    sourceHash,
  }, null, 2));
  console.log(`muslin.bin: ${bytes.length} bytes, entry=0x${entryOffset.toString(16)}`);
}

function bakeGossamer() {
  // Gossamer ships as a checked-in .bin — just copy.
  const src = resolve(repoRoot, 'bios', 'gossamer', 'gossamer.bin');
  const dst = join(prebakeDir, 'gossamer.bin');
  const bytes = readFileSync(src);
  writeFileSync(dst, bytes);
  writeFileSync(join(prebakeDir, 'gossamer.meta.json'), JSON.stringify({
    flavor: 'gossamer',
    entrySegment: null,
    entryOffset: null,
    sizeBytes: bytes.length,
    sourceHash: sha256(bytes),
  }, null, 2));
  console.log(`gossamer.bin: ${bytes.length} bytes (copied)`);
}

function writeManifest() {
  const manifest = {
    generated: new Date().toISOString(),
    bioses: [
      { flavor: 'muslin', binary: 'muslin.bin', meta: 'muslin.meta.json' },
      { flavor: 'gossamer', binary: 'gossamer.bin', meta: 'gossamer.meta.json' },
    ],
  };
  writeFileSync(join(prebakeDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

bakeMuslin();
bakeGossamer();
writeManifest();
console.log('prebake done:', prebakeDir);

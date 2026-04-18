// Stage 1 — build the BIOS.
//
// Input:  { flavor: "gossamer" | "muslin" | "corduroy", cacheDir }
// Output: { bytes, entrySegment, entryOffset, meta }

import { readFileSync, existsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

// NOTE: NASM path is Windows-specific here. Override via NASM env var.
const NASM = process.env.NASM || resolve('C:\\Users\\AdmT9N0CX01V65438A\\AppData\\Local\\bin\\NASM\\nasm.exe');

export function buildBios({ flavor }) {
  if (flavor === 'gossamer')  return buildGossamer();
  if (flavor === 'muslin')    return buildMuslin();
  if (flavor === 'corduroy')  return buildCorduroy();
  throw new Error(`unknown bios flavor: ${flavor}`);
}

function buildGossamer() {
  // Gossamer ships pre-built as a .bin checked into bios/gossamer/.
  const bin = resolve(repoRoot, 'bios', 'gossamer', 'gossamer.bin');
  if (!existsSync(bin)) {
    throw new Error(`gossamer.bin not found at ${bin}`);
  }
  const bytes = [...readFileSync(bin)];
  // IVT vectors inside gossamer are set by the transpiler's IVT seeder,
  // not by an entry stub — the hack path boots directly into the .COM.
  return {
    bytes,
    entrySegment: null,
    entryOffset: null,
    meta: { flavor: 'gossamer', source: 'bios/gossamer/gossamer.bin', sizeBytes: bytes.length },
  };
}

function buildMuslin() {
  const asm = resolve(repoRoot, 'bios', 'muslin', 'muslin.asm');
  const bin = resolve(repoRoot, 'bios', 'muslin', 'muslin.bin');
  const lst = resolve(repoRoot, 'bios', 'muslin', 'muslin.lst');

  execSync(`"${NASM}" -f bin -o "${bin}" "${asm}" -l "${lst}"`, { stdio: 'pipe' });
  const bytes = [...readFileSync(bin)];
  const entryOffset = findSymbolInListing(readFileSync(lst, 'utf8'), 'bios_init');
  if (entryOffset == null) {
    throw new Error('Muslin: could not find bios_init offset in listing');
  }

  return {
    bytes,
    entrySegment: 0xF000,
    entryOffset,
    meta: { flavor: 'muslin', source: 'bios/muslin/muslin.asm', sizeBytes: bytes.length, entryOffset },
  };
}

function buildCorduroy() {
  const buildScript = resolve(repoRoot, 'bios', 'corduroy', 'build.mjs');
  execFileSync('node', [buildScript], { stdio: 'inherit' });
  // The Corduroy build script emits bios.bin under bios/corduroy/build/.
  const bin = resolve(repoRoot, 'bios', 'corduroy', 'build', 'bios.bin');
  const bytes = [...readFileSync(bin)];
  // Corduroy's entry.asm sits at offset 0 and jumps to bios_init itself.
  return {
    bytes,
    entrySegment: 0xF000,
    entryOffset: 0x0000,
    meta: { flavor: 'corduroy', source: 'bios/corduroy/ (multiple)', sizeBytes: bytes.length },
  };
}

function findSymbolInListing(listing, symbol) {
  const lines = listing.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`${symbol}:`)) {
      const m = lines[i + 1]?.match(/([0-9A-Fa-f]{8})/);
      if (m) return parseInt(m[1], 16);
    }
  }
  return null;
}

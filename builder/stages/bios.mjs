// Stage 1 — build the BIOS.
//
// Input:  { flavor: "gossamer" | "muslin" | "corduroy", cacheDir }
// Output: { bytes, entrySegment, entryOffset, meta }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const prebakeDir = resolve(repoRoot, 'web', 'prebake');

// Mirror the built BIOS into web/prebake/ so the browser builder picks
// up changes without requiring a separate `node web/scripts/prebake.mjs`
// run. Any BIOS source edit that propagates to node builds now also
// propagates to the browser on the next rebuild. The prebake.mjs script
// remains the canonical cold-start way to regenerate all three flavours
// in one go; this is the incremental path.
function refreshPrebake(flavor, bytes, entrySegment, entryOffset, version) {
  if (!existsSync(prebakeDir)) mkdirSync(prebakeDir, { recursive: true });
  const buf = Buffer.from(bytes);
  writeFileSync(join(prebakeDir, `${flavor}.bin`), buf);
  writeFileSync(join(prebakeDir, `${flavor}.meta.json`), JSON.stringify({
    flavor,
    version: version ?? null,
    entrySegment,
    entryOffset,
    sizeBytes: buf.length,
    sourceHash: createHash('sha256').update(buf).digest('hex'),
  }, null, 2));
}

// Read a flavor's VERSION file if it has one. Returns null for flavors
// that aren't versioned yet (gossamer, muslin — add their own VERSION
// files when they grow real changelogs).
function readFlavorVersion(flavor) {
  const vPath = resolve(repoRoot, 'bios', flavor, 'VERSION');
  if (!existsSync(vPath)) return null;
  return readFileSync(vPath, 'utf8').trim();
}

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
  const version = readFlavorVersion('gossamer');
  // IVT vectors inside gossamer are set by the transpiler's IVT seeder,
  // not by an entry stub — the hack path boots directly into the .COM.
  refreshPrebake('gossamer', bytes, null, null, version);
  return {
    bytes,
    entrySegment: null,
    entryOffset: null,
    meta: { flavor: 'gossamer', version, source: 'bios/gossamer/gossamer.bin', sizeBytes: bytes.length },
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
  const version = readFlavorVersion('muslin');
  refreshPrebake('muslin', bytes, 0xF000, entryOffset, version);

  return {
    bytes,
    entrySegment: 0xF000,
    entryOffset,
    meta: { flavor: 'muslin', version, source: 'bios/muslin/muslin.asm', sizeBytes: bytes.length, entryOffset },
  };
}

function buildCorduroy() {
  const buildScript = resolve(repoRoot, 'bios', 'corduroy', 'build.mjs');
  execFileSync('node', [buildScript], { stdio: 'inherit' });
  // The Corduroy build script emits bios.bin under bios/corduroy/build/.
  const bin = resolve(repoRoot, 'bios', 'corduroy', 'build', 'bios.bin');
  const bytes = [...readFileSync(bin)];
  const version = readFlavorVersion('corduroy');
  // Corduroy's entry.asm sits at offset 0 and jumps to bios_init itself.
  refreshPrebake('corduroy', bytes, 0xF000, 0x0000, version);
  return {
    bytes,
    entrySegment: 0xF000,
    entryOffset: 0x0000,
    meta: { flavor: 'corduroy', version, source: 'bios/corduroy/ (multiple)', sizeBytes: bytes.length },
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

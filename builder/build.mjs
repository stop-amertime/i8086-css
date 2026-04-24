#!/usr/bin/env node
// CSS-DOS builder — orchestrates the four stages to turn a cart into a cabinet.
//
//   cart (folder or zip) → build.mjs → cabinet (.css)
//
// Pipeline:
//   1. resolveCart       — find the cart, parse program.json, discover files
//   2. resolveManifest   — merge preset + manifest, validate, fill defaults
//   3. buildBios         — Gossamer / Muslin / Corduroy
//   4. buildFloppy       — FAT12 image (DOS carts only)
//   5. runKiln           — emit CSS to output stream
//
// Usage:
//   node builder/build.mjs <cart-path> [-o output.css] [--cache-dir path]
//
// See docs/cart-format.md for the full cart schema.

import { createWriteStream, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createHash } from 'node:crypto';

import { resolveCart } from './lib/cart.mjs';
import { resolveManifest } from './lib/config.mjs';
import {
  resolveMemorySize,
  autofitDosMem,
  autofitHackMem,
  DOS_MAX_MEM,
} from './lib/sizes.mjs';
import { buildBios } from './stages/bios.mjs';
import { buildFloppy } from './stages/floppy.mjs';
import { runKiln } from './stages/kiln.mjs';
import { buildHarnessHeader } from '../tests/harness/lib/cabinet-header.mjs';

function resolveDosMemBytes(manifest, floppy) {
  let autofitBytes = DOS_MAX_MEM;
  const autorun = manifest.boot?.autorun;
  if (autorun && floppy?.layout) {
    const prog = floppy.layout.find(f => f.name === autorun.toUpperCase());
    if (prog?.size != null) autofitBytes = autofitDosMem(prog.size);
  }
  return resolveMemorySize(manifest.memory?.conventional ?? 'autofit', { autofitBytes });
}

function resolveHackMemBytes(manifest, programBytes) {
  const autofitBytes = autofitHackMem(programBytes.length);
  return resolveMemorySize(manifest.memory?.conventional ?? 'autofit', { autofitBytes });
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// Load preset JSON files once at startup so resolveManifest() receives plain
// objects rather than doing I/O itself (keeping config.mjs browser-safe).
const PRESETS_DIR = join(__dirname, 'presets');
const PRESET_NAMES = ['dos-muslin', 'dos-corduroy', 'hack'];
const PRESETS = Object.fromEntries(
  PRESET_NAMES.map(name => [
    name,
    JSON.parse(readFileSync(join(PRESETS_DIR, `${name}.json`), 'utf8')),
  ])
);

function parseArgs(argv) {
  const args = { input: null, output: null, cacheDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' && i + 1 < argv.length) args.output = argv[++i];
    else if (a === '--cache-dir' && i + 1 < argv.length) args.cacheDir = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (!a.startsWith('-') && args.input == null) args.input = a;
    else {
      console.error(`unknown argument: ${a}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!args.input) {
    console.error(USAGE);
    process.exit(2);
  }
  return args;
}

const USAGE = `Usage: node builder/build.mjs <cart> [-o output.css] [--cache-dir path]

  <cart>            Path to a cart folder or .zip.
  -o output.css     Output path. Default: out/<cartname>.css.
  --cache-dir path  Scratch dir for intermediate artifacts. Default: tmp.

Environment:
  NASM              Path to NASM (muslin/corduroy need it).

Examples:
  node builder/build.mjs carts/bootle
  node builder/build.mjs mygame.zip -o mygame.css
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[cart]   resolving ${args.input}`);
  const cart = resolveCart(args.input);

  console.log(`[cart]   "${cart.name}" (${cart.files.length} file${cart.files.length === 1 ? '' : 's'})`);

  const manifest = resolveManifest(cart.manifest, cart.files, PRESETS);
  console.log(`[cart]   preset: ${manifest.preset}, bios: ${manifest.bios}`);

  const cacheDir = args.cacheDir
    ? resolve(args.cacheDir)
    : join(tmpdir(), `cssdos-build-${process.pid}`);
  mkdirSync(cacheDir, { recursive: true });

  console.log(`[bios]   building ${manifest.bios}...`);
  const bios = buildBios({ flavor: manifest.bios, cacheDir });
  console.log(`[bios]   ${bios.meta.sizeBytes} bytes (${bios.meta.source})`);

  let floppy = null;
  if (manifest.disk) {
    console.log('[floppy] assembling FAT12 image...');
    floppy = buildFloppy({ cart, manifest, cacheDir });
    console.log(`[floppy] ${floppy.bytes.length} bytes, ${floppy.layout.length} files`);
  }

  // Output path. Default lands in ./out/ so cabinets don't clutter the repo root
  // and the .gitignore can be scoped to one directory.
  const outputPath = args.output ?? join('out', `${cart.name}.css`);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  const outStream = createWriteStream(resolve(outputPath), { encoding: 'utf-8' });

  // Load the bytes that Kiln needs. DOS carts need the kernel binary;
  // hack carts need the .COM program. Both are read here so kiln.mjs
  // stays free of any Node fs calls (browser-safe).
  let kernelBytes = null;
  let programBytes = null;
  if (manifest.preset === 'hack') {
    const raw = manifest.boot?.raw;
    if (!raw) throw new Error('hack cart missing boot.raw');
    programBytes = [...readFileSync(resolve(cart.root, raw))];
  } else {
    kernelBytes = [...readFileSync(resolve(repoRoot, 'dos', 'bin', 'kernel.sys'))];
  }

  // Resolve final memBytes using the same path kiln will use, so the
  // harness header records the exact conventional-memory size the cabinet
  // was built with. Ref emulators and the screenshot tool use this.
  const memBytes = manifest.preset === 'hack'
    ? resolveHackMemBytes(manifest, programBytes)
    : resolveDosMemBytes(manifest, floppy);

  const harnessMeta = {
    builtAt: new Date().toISOString(),
    cartName: cart.name,
    preset: manifest.preset,
    bios: {
      flavor: bios.meta.flavor,
      version: bios.meta.version ?? null,
      sizeBytes: bios.meta.sizeBytes,
      sourceHash: sha256(bios.bytes),
      entrySegment: bios.entrySegment,
      entryOffset: bios.entryOffset,
    },
    memory: {
      conventional: manifest.memory?.conventional ?? 'autofit',
      conventionalBytes: memBytes,
      gfx: manifest.memory?.gfx ?? null,
      textVga: manifest.memory?.textVga ?? null,
      cgaGfx: manifest.memory?.cgaGfx ?? null,
    },
    disk: floppy ? {
      mode: manifest.disk?.mode ?? null,
      size: manifest.disk?.size ?? null,
      writable: manifest.disk?.writable ?? null,
      sizeBytes: floppy.bytes.length,
      sha256: sha256(floppy.bytes),
      layout: floppy.layout,
    } : null,
    program: programBytes ? {
      name: manifest.boot?.raw ?? null,
      sizeBytes: programBytes.length,
      sha256: sha256(programBytes),
    } : null,
    kernel: kernelBytes ? {
      sizeBytes: kernelBytes.length,
      sha256: sha256(kernelBytes),
    } : null,
  };

  const humanHeader = buildCabinetHeader({ cart, manifest, bios, floppy });
  const harnessHeader = buildHarnessHeader(harnessMeta);
  // Machine-readable block sits right after the human comment. Both are
  // inside the first 64 KB which is what cabinet-header.mjs scans.
  const header = `${humanHeader}\n${harnessHeader}`;

  console.log(`[kiln]   emitting CSS to ${outputPath}...`);
  runKiln({ bios, floppy, manifest, kernelBytes, programBytes, output: outStream, header });

  await new Promise(done => outStream.end(done));
  const size = statSync(resolve(outputPath)).size;
  console.log(`[done]   ${outputPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);

  // Sidecar binaries. The cabinet is the authoritative artifact for
  // Chrome/calcite; the sidecars exist so the reference emulator and
  // other debug tools can reconstruct the same 1 MB memory image
  // *without* re-running the builder or re-parsing 150 MB of CSS.
  //   <cabinet>.bios.bin      — raw BIOS bytes that ended up in the cabinet
  //                             (after patchBiosMemSize / patchBiosStackSeg
  //                              for corduroy). This is the BIOS the CSS
  //                              contains, not the pristine pre-patch one.
  //   <cabinet>.disk.bin      — floppy image (FAT12), DOS preset only
  //   <cabinet>.program.bin   — .COM bytes, hack preset only
  //   <cabinet>.meta.json     — same payload as the harness-header JSON,
  //                             in case a reader doesn't want to scrape
  //                             the cabinet.
  const cabinetBase = resolve(outputPath).replace(/\.css$/, '');
  // Post-runKiln: corduroy's bios.bytes has been mutated by
  // patchBiosMemSize / patchBiosStackSeg — those are the bytes that ended
  // up in the cabinet, so those are what the ref emulator should see.
  writeFileSync(`${cabinetBase}.bios.bin`, Buffer.from(bios.bytes));
  if (floppy) writeFileSync(`${cabinetBase}.disk.bin`, Buffer.from(floppy.bytes));
  if (programBytes) writeFileSync(`${cabinetBase}.program.bin`, Buffer.from(programBytes));
  if (kernelBytes) writeFileSync(`${cabinetBase}.kernel.bin`, Buffer.from(kernelBytes));
  writeFileSync(`${cabinetBase}.meta.json`, JSON.stringify(harnessMeta, null, 2));
}

function buildCabinetHeader({ cart, manifest, bios, floppy }) {
  const lines = [];
  lines.push('/* CSS-DOS cabinet');
  lines.push(' *');
  lines.push(` * Built from: ${cart.name}`);
  lines.push(` * Built at:   ${new Date().toISOString()}`);
  lines.push(' *');
  lines.push(' * Resolved manifest:');
  for (const ln of JSON.stringify(manifest, null, 2).split('\n')) {
    lines.push(` *   ${ln}`);
  }
  lines.push(' *');
  if (floppy) {
    lines.push(' * Disk layout:');
    for (const f of floppy.layout) {
      const sz = f.size != null ? String(f.size).padStart(7) : '       ';
      lines.push(` *   ${f.name.padEnd(12)} ${sz} bytes  (${f.source})`);
    }
    lines.push(' *');
  }
  const vTag = bios.meta.version ? ` v${bios.meta.version}` : ' (unversioned)';
  lines.push(` * BIOS: ${titleCase(bios.meta.flavor)}${vTag}, ${bios.meta.sizeBytes} bytes (${bios.meta.source})`);
  lines.push(' */');
  return lines.join('\n');
}

function titleCase(s) { return s[0].toUpperCase() + s.slice(1); }

main().catch(err => {
  console.error(err.message || err);
  if (err.stack && !err.errors) console.error(err.stack);
  process.exit(1);
});

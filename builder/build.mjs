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

import { createWriteStream, statSync, mkdirSync } from 'node:fs';
import { basename, extname, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { resolveCart } from './lib/cart.mjs';
import { resolveManifest } from './lib/config.mjs';
import { buildBios } from './stages/bios.mjs';
import { buildFloppy } from './stages/floppy.mjs';
import { runKiln } from './stages/kiln.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

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
  -o output.css     Output path. Default: <cartname>.css in cwd.
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

  const manifest = resolveManifest(cart.manifest, cart.files);
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

  // Output path
  const outputPath = args.output ?? `${cart.name}.css`;
  const outStream = createWriteStream(resolve(outputPath), { encoding: 'utf-8' });

  const header = buildCabinetHeader({ cart, manifest, bios, floppy });

  console.log(`[kiln]   emitting CSS to ${outputPath}...`);
  runKiln({ bios, floppy, manifest, cart, output: outStream, header });

  await new Promise(done => outStream.end(done));
  const size = statSync(resolve(outputPath)).size;
  console.log(`[done]   ${outputPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
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
  lines.push(` * BIOS: ${titleCase(bios.meta.flavor)} BIOS, ${bios.meta.sizeBytes} bytes (${bios.meta.source})`);
  lines.push(' */');
  return lines.join('\n');
}

function titleCase(s) { return s[0].toUpperCase() + s.slice(1); }

main().catch(err => {
  console.error(err.message || err);
  if (err.stack && !err.errors) console.error(err.stack);
  process.exit(1);
});

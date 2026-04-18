// Stage 2 — build the floppy image from the cart's resolved manifest.
//
// Input:  { cart, manifest, cacheDir }
// Output: { bytes, layout: [{name, size, source}] }
//
// DOS carts get a FAT12 image containing KERNEL.SYS, CONFIG.SYS (synthesized),
// the autorun program, any data files, and optionally COMMAND.COM.
// Hack carts skip this stage entirely.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFat12Image } from '../../tools/mkfat12.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const KERNEL_SYS  = resolve(repoRoot, 'dos', 'bin', 'kernel.sys');
const COMMAND_COM = resolve(repoRoot, 'dos', 'bin', 'command.com');

export function buildFloppy({ cart, manifest, cacheDir }) {
  if (!manifest.disk) {
    return null; // hack carts have no floppy
  }

  mkdirSync(cacheDir, { recursive: true });

  // Synthesize CONFIG.SYS from boot.autorun.
  const autorun = manifest.boot?.autorun ?? null;
  const args = manifest.boot?.args ?? '';
  const shellTarget = autorun ?? 'COMMAND.COM';
  const configContent = args
    ? `SHELL=\\${shellTarget} ${args}\n`
    : `SHELL=\\${shellTarget}\n`;
  const configPath = join(cacheDir, 'CONFIG.SYS');
  writeFileSync(configPath, configContent);

  // Assemble the file list: KERNEL.SYS + CONFIG.SYS + cart files + (COMMAND.COM?).
  const layout = [
    { name: 'KERNEL.SYS', source: 'dos/bin/kernel.sys',   path: KERNEL_SYS },
    { name: 'CONFIG.SYS', source: `synthesized: ${configContent.trimEnd()}`, path: configPath },
  ];

  for (const f of manifest.disk.files ?? []) {
    layout.push({
      name: f.name.toUpperCase(),
      source: f.source,
      path: resolve(cart.root, f.source),
    });
  }

  if (autorun == null) {
    layout.push({ name: 'COMMAND.COM', source: 'dos/bin/command.com', path: COMMAND_COM });
  }

  // Build the FAT12 image in-process (no execSync shell-out).
  const fatFiles = layout.map(f => ({
    name: f.name,
    bytes: readFileSync(f.path),
  }));
  const imgBytes = buildFat12Image(fatFiles);
  const bytes = [...imgBytes];

  // Annotate sizes post-hoc.
  for (const f of layout) {
    if (existsSync(f.path)) {
      f.size = readFileSync(f.path).length;
    }
  }

  return { bytes, layout };
}

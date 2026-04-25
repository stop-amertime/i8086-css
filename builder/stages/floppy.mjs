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
import { resolveFloppySize } from '../lib/sizes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const KERNEL_SYS  = resolve(repoRoot, 'dos', 'bin', 'kernel.sys');
const COMMAND_COM = resolve(repoRoot, 'dos', 'bin', 'command.com');
const ANSI_SYS    = resolve(repoRoot, 'dos', 'bin', 'ansi.sys');

export function buildFloppy({ cart, manifest, cacheDir }) {
  if (!manifest.disk) {
    return null; // hack carts have no floppy
  }

  mkdirSync(cacheDir, { recursive: true });

  // Synthesize CONFIG.SYS from boot.autorun.
  const autorun = manifest.boot?.autorun ?? null;
  const args = manifest.boot?.args ?? '';
  const shellTarget = autorun ?? 'COMMAND.COM';
  // SWITCHES=/F skips the ~2s F5/F8 startup delay — we don't need it in the emulator.
  // DEVICE=\ANSI.SYS loads NANSI (a GPLv2 DOS ANSI driver shipped in dos/bin/).
  // Programs that emit terminal escapes (Zork via FROTZ, SVARCOM's colored prompt,
  // any BBS-era software) rely on an ANSI driver being present. Without it the
  // escape bytes go straight to VRAM as literal text. NANSI is ~5 KB resident —
  // negligible given our default memory sizing.
  const shellLine = args
    ? `SHELL=\\${shellTarget} ${args}\n`
    : `SHELL=\\${shellTarget}\n`;
  const configContent = `SWITCHES=/F\nDEVICE=\\ANSI.SYS\n${shellLine}`;
  const configPath = join(cacheDir, 'CONFIG.SYS');
  writeFileSync(configPath, configContent);

  // Assemble the file list: KERNEL.SYS + ANSI.SYS + CONFIG.SYS + COMMAND.COM
  // + cart files. ANSI.SYS must be on the disk before CONFIG.SYS loads it,
  // but file order within the FAT image doesn't matter — files are located
  // by name, not position.
  //
  // COMMAND.COM is always included (even when autorun is set), so:
  //   - users can set SHELL=\COMMAND.COM explicitly via boot.autorun
  //     (e.g. to drop to a prompt and run a program with custom flags)
  //   - autorun batch files / programs can shell out or EXIT back to DOS
  //   - Ctrl-C from a hung autorun program lands somewhere sane
  // It's ~30 KB on a disk that's typically 1-3 MB; not worth the asymmetry.
  const layout = [
    { name: 'KERNEL.SYS',  source: 'dos/bin/kernel.sys',   path: KERNEL_SYS },
    { name: 'ANSI.SYS',    source: 'dos/bin/ansi.sys',     path: ANSI_SYS },
    { name: 'COMMAND.COM', source: 'dos/bin/command.com',  path: COMMAND_COM },
    { name: 'CONFIG.SYS',  source: `synthesized: ${configContent.trimEnd()}`, path: configPath },
  ];

  for (const f of manifest.disk.files ?? []) {
    layout.push({
      name: f.name.toUpperCase(),
      source: f.source,
      path: resolve(cart.root, f.source),
    });
  }

  // Build the FAT12 image in-process (no execSync shell-out). Resolve
  // geometry first: autofit picks a standard floppy if content fits,
  // fabricates a bigger geometry otherwise. The BIOS reads this geometry
  // at runtime (patched in by the kiln stage), so the BPB and BIOS stay
  // in lockstep — programs that call INT 13h AH=08h get the same CHS
  // the disk is actually laid out with.
  const fatFiles = layout.map(f => ({
    name: f.name,
    bytes: readFileSync(f.path),
  }));
  const contentBytes = fatFiles.reduce((n, f) => n + f.bytes.length, 0);
  const { bytes: diskBytes, geometry } = resolveFloppySize(
    manifest.disk?.size ?? 'autofit',
    { autofitBytes: contentBytes },
  );
  const totalSectors = diskBytes / 512;
  const bytes = buildFat12Image(fatFiles, { ...geometry, totalSectors });

  // Annotate sizes post-hoc.
  for (const f of layout) {
    if (existsSync(f.path)) {
      f.size = readFileSync(f.path).length;
    }
  }

  return { bytes, layout, geometry: { ...geometry, totalSectors } };
}

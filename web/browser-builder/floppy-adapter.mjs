// Composes a FAT12 floppy for the browser DOS path.
// Input:  { kernelBytes, commandBytes, programName, programBytes,
//           programFiles?, autorun?, args? }
// Output: { bytes: Uint8Array, layout: [{name, size, source}] }
//
// Hack carts never call this (no floppy). DOS carts always do.

import { buildFat12Image } from '../../tools/mkfat12.mjs';
import { resolveFloppySize } from '../../builder/lib/sizes.mjs';

/**
 * Build a FAT12 floppy image in the browser (or Node test environment).
 *
 * @param {object} opts
 * @param {Uint8Array} opts.kernelBytes      dos/bin/kernel.sys
 * @param {Uint8Array} opts.commandBytes     dos/bin/command.com
 * @param {Uint8Array} opts.ansiBytes        dos/bin/ansi.sys (NANSI, GPLv2)
 * @param {string}     opts.programName      Filename on disk (e.g. "BCD.COM")
 * @param {Uint8Array} opts.programBytes     The .COM/.EXE to put on disk
 * @param {Array}      [opts.programFiles]   Extra {name, bytes, source} entries
 *                                           from manifest.disk.files (not yet
 *                                           supported in browser v1 — ignored).
 * @param {string|null} [opts.autorun]       SHELL= target. null → COMMAND.COM
 *                                           (drop to DOS prompt). COMMAND.COM
 *                                           is always added to the disk image
 *                                           regardless, so autorun programs can
 *                                           shell out / EXIT back to a prompt.
 * @param {string}     [opts.args]           Optional args appended to SHELL= line.
 * @param {string|number} [opts.sizeRequest] Manifest disk.size — 'autofit',
 *                                           a preset string like '720K', or a
 *                                           number of bytes. Defaults to 'autofit'.
 * @returns {{ bytes: Uint8Array, layout: [{name, size, source}], geometry: {cyls, heads, spt, totalSectors} }}
 */
export function buildFloppyInBrowser({
  kernelBytes,
  commandBytes,
  ansiBytes,
  programName,
  programBytes,
  programFiles = [],
  autorun = null,
  args = '',
  sizeRequest = 'autofit',
}) {
  if (!(kernelBytes instanceof Uint8Array)) {
    throw new Error('buildFloppyInBrowser: kernelBytes must be Uint8Array');
  }
  if (!(commandBytes instanceof Uint8Array)) {
    throw new Error('buildFloppyInBrowser: commandBytes must be Uint8Array');
  }
  if (!(ansiBytes instanceof Uint8Array)) {
    throw new Error('buildFloppyInBrowser: ansiBytes must be Uint8Array');
  }

  // Synthesize CONFIG.SYS (mirror builder/stages/floppy.mjs logic). The
  // DEVICE=\ANSI.SYS line loads NANSI so programs that emit terminal
  // escapes (Zork+FROTZ, SVARCOM colored prompt) render correctly
  // instead of dumping raw ESC sequences to VRAM.
  const shellTarget = autorun ?? 'COMMAND.COM';
  // SWITCHES=/F skips the ~2s F5/F8 startup delay — we don't need it in the emulator.
  const shellLine = args
    ? `SHELL=\\${shellTarget} ${args}\n`
    : `SHELL=\\${shellTarget}\n`;
  const configContent = `SWITCHES=/F\nDEVICE=\\ANSI.SYS\n${shellLine}`;
  const configBytes = new TextEncoder().encode(configContent);

  const layout = [
    { name: 'KERNEL.SYS', bytes: kernelBytes, source: 'dos/bin/kernel.sys' },
    { name: 'ANSI.SYS',   bytes: ansiBytes,   source: 'dos/bin/ansi.sys' },
    { name: 'CONFIG.SYS', bytes: configBytes, source: `synthesized: ${configContent.trimEnd()}` },
  ];

  // The user's program.
  const progName = (programName || 'PROG.COM').toUpperCase();
  layout.push({ name: progName, bytes: programBytes, source: 'user upload' });

  // Any extra data files from the cart (browser v1: passed in as programFiles).
  for (const f of programFiles) {
    layout.push({
      name: f.name.toUpperCase(),
      bytes: f.bytes,
      source: f.source ?? 'user upload',
    });
  }

  // COMMAND.COM is always included so autorun programs can shell out / EXIT
  // back to a prompt, and so users can set SHELL=\COMMAND.COM explicitly.
  // Skip only if the cart already supplied its own COMMAND.COM (above).
  const alreadyHasCommandCom = layout.some(f => f.name === 'COMMAND.COM');
  if (!alreadyHasCommandCom) {
    layout.push({ name: 'COMMAND.COM', bytes: commandBytes, source: 'dos/bin/command.com' });
  }

  // Resolve disk geometry the same way builder/stages/floppy.mjs does:
  // autofit picks a standard floppy when content fits, fabricates a larger
  // geometry otherwise. The BIOS is patched with this geometry in kiln.mjs,
  // so BPB and BIOS stay in lockstep.
  const contentBytes = layout.reduce((n, f) => n + f.bytes.length, 0);
  const { bytes: diskBytes, geometry } = resolveFloppySize(sizeRequest, {
    autofitBytes: contentBytes,
  });
  const totalSectors = diskBytes / 512;

  const imgBytes = buildFat12Image(
    layout.map(f => ({ name: f.name, bytes: f.bytes })),
    { ...geometry, totalSectors },
  );

  return {
    bytes: imgBytes,
    layout: layout.map(f => ({ name: f.name, size: f.bytes.length, source: f.source })),
    geometry: { ...geometry, totalSectors },
  };
}

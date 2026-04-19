// Composes a FAT12 floppy for the browser DOS path.
// Input:  { kernelBytes, commandBytes, programName, programBytes,
//           programFiles?, autorun?, args? }
// Output: { bytes: Uint8Array, layout: [{name, size, source}] }
//
// Hack carts never call this (no floppy). DOS carts always do.

import { buildFat12Image } from '../../tools/mkfat12.mjs';

/**
 * Build a FAT12 floppy image in the browser (or Node test environment).
 *
 * @param {object} opts
 * @param {Uint8Array} opts.kernelBytes      dos/bin/kernel.sys
 * @param {Uint8Array} opts.commandBytes     dos/bin/command.com
 * @param {string}     opts.programName      Filename on disk (e.g. "BCD.COM")
 * @param {Uint8Array} opts.programBytes     The .COM/.EXE to put on disk
 * @param {Array}      [opts.programFiles]   Extra {name, bytes, source} entries
 *                                           from manifest.disk.files (not yet
 *                                           supported in browser v1 — ignored).
 * @param {string|null} [opts.autorun]       If non-null, use this as SHELL= target
 *                                           (and omit COMMAND.COM from disk).
 * @param {string}     [opts.args]           Optional args appended to SHELL= line.
 * @returns {{ bytes: Uint8Array, layout: [{name, size, source}] }}
 */
export function buildFloppyInBrowser({
  kernelBytes,
  commandBytes,
  programName,
  programBytes,
  programFiles = [],
  autorun = null,
  args = '',
}) {
  if (!(kernelBytes instanceof Uint8Array)) {
    throw new Error('buildFloppyInBrowser: kernelBytes must be Uint8Array');
  }
  if (!(commandBytes instanceof Uint8Array)) {
    throw new Error('buildFloppyInBrowser: commandBytes must be Uint8Array');
  }

  // Synthesize CONFIG.SYS (mirror builder/stages/floppy.mjs logic).
  const shellTarget = autorun ?? 'COMMAND.COM';
  // SWITCHES=/F skips the ~2s F5/F8 startup delay — we don't need it in the emulator.
  const shellLine = args
    ? `SHELL=\\${shellTarget} ${args}\n`
    : `SHELL=\\${shellTarget}\n`;
  const configContent = `SWITCHES=/F\n${shellLine}`;
  const configBytes = new TextEncoder().encode(configContent);

  const layout = [
    { name: 'KERNEL.SYS', bytes: kernelBytes, source: 'dos/bin/kernel.sys' },
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

  // Include COMMAND.COM if nothing else will run, OR if the user explicitly
  // asked to SHELL to it. Skip only when a real program is the autorun target
  // AND the cart doesn't already supply its own COMMAND.COM.
  const wantsCommandCom =
    autorun == null ||
    autorun.toUpperCase() === 'COMMAND.COM';
  const alreadyHasCommandCom = layout.some(f => f.name === 'COMMAND.COM');
  if (wantsCommandCom && !alreadyHasCommandCom) {
    layout.push({ name: 'COMMAND.COM', bytes: commandBytes, source: 'dos/bin/command.com' });
  }

  const imgBytes = buildFat12Image(
    layout.map(f => ({ name: f.name, bytes: f.bytes })),
  );

  return {
    bytes: imgBytes,
    layout: layout.map(f => ({ name: f.name, size: f.bytes.length, source: f.source })),
  };
}

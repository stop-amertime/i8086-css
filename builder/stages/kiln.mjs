// Stage 3 — invoke Kiln (the transpiler) to emit CSS.
//
// Input:  { bios, floppy (nullable for hack), manifest, cart, output, header }
// Output: writes CSS to `output` (a WriteStream).

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitCSS } from '../../kiln/emit-css.mjs';
import { comMemoryZones, dosMemoryZones, buildIVTData } from '../../kiln/memory.mjs';
import { resolveMemorySize } from '../lib/sizes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const KERNEL_LINEAR = 0x600; // DOS kernel load address

export function runKiln({ bios, floppy, manifest, cart, output, header }) {
  const isHack = manifest.preset === 'hack';
  return isHack
    ? runKilnHack({ bios, manifest, cart, output, header })
    : runKilnDos({ bios, floppy, manifest, cart, output, header });
}

function runKilnDos({ bios, floppy, manifest, cart, output, header }) {
  const kernelBytes = [...readFileSync(resolve(repoRoot, 'dos', 'bin', 'kernel.sys'))];

  const memBytes = resolveMemorySize(manifest.memory?.conventional ?? '640K');
  const prune = {
    gfx:     manifest.memory?.gfx === false,
    textVga: manifest.memory?.textVga === false,
  };

  // embeddedData is reserved for legacy "embedded disk" mode; with
  // the default rom-disk path, disk bytes come in via opts.diskBytes.
  const embData = [];
  const memoryZones = dosMemoryZones(kernelBytes, KERNEL_LINEAR, memBytes, embData, prune);

  emitCSS({
    programBytes:  kernelBytes,
    biosBytes:     bios.bytes,
    memoryZones,
    embeddedData:  embData,
    diskBytes:     floppy.bytes,
    programOffset: KERNEL_LINEAR,
    initialCS:     bios.entrySegment,
    initialIP:     bios.entryOffset,
    initialRegs:   { SP: 0 },
    header,
  }, output);
}

function runKilnHack({ bios, manifest, cart, output, header }) {
  const raw = manifest.boot?.raw;
  if (!raw) throw new Error('hack cart missing boot.raw');
  const programBytes = [...readFileSync(resolve(cart.root, raw))];
  const programOffset = 0x100;

  const autofitBytes = Math.max(0x600, programOffset + programBytes.length + 0x100);
  const memBytes = resolveMemorySize(manifest.memory?.conventional ?? 'autofit', { autofitBytes });

  const embeddedData = [buildIVTData()];
  const memoryZones = comMemoryZones(programBytes, programOffset, memBytes);

  emitCSS({
    programBytes,
    biosBytes:     bios.bytes,
    memoryZones,
    embeddedData,
    programOffset,
    header,
  }, output);
}

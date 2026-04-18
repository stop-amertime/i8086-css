// Stage 3 — invoke Kiln (the transpiler) to emit CSS.
//
// Input:  { bios, floppy (nullable for hack), manifest, kernelBytes,
//           programBytes, output, header }
//
//   kernelBytes   — DOS branch only: contents of dos/bin/kernel.sys as an
//                   Array<number>. The caller (builder/build.mjs on Node;
//                   web/browser-builder/main.mjs in the browser) loads these.
//   programBytes  — hack branch only: contents of the .COM file named in
//                   manifest.boot.raw as an Array<number>. Same ownership.
//
// Output: writes CSS to `output` (any object with a .write(string) method).

import { emitCSS } from '../../kiln/emit-css.mjs';
import { comMemoryZones, dosMemoryZones, buildIVTData } from '../../kiln/memory.mjs';
import { resolveMemorySize } from '../lib/sizes.mjs';

const KERNEL_LINEAR = 0x600; // DOS kernel load address

export function runKiln({ bios, floppy, manifest, kernelBytes, programBytes, output, header }) {
  const isHack = manifest.preset === 'hack';
  return isHack
    ? runKilnHack({ bios, manifest, programBytes, output, header })
    : runKilnDos({ bios, floppy, manifest, kernelBytes, output, header });
}

function runKilnDos({ bios, floppy, manifest, kernelBytes, output, header }) {
  if (!kernelBytes) throw new Error('runKilnDos: kernelBytes is required');
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

function runKilnHack({ bios, manifest, programBytes, output, header }) {
  if (!programBytes) throw new Error('hack cart missing programBytes');
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

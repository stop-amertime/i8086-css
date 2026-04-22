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

// Patch the corduroy BIOS's `conventional_mem_kb` variable in-place, so
// install_bda writes the actual configured size into BDA. The kernel
// calls INT 12h (which corduroy's handler serves from the BDA value) to
// find the top of conventional memory and relocate its BIOS code there.
// If this lies — e.g. install_bda says 640 but actual RAM is 240 KB —
// the relocation lands in unmapped memory and boot dies silently.
// The variable is initialized to 0xBEEF in bios_init.c as a signature
// so we can find and replace it here without parsing a link map.
function patchBiosMemSize(biosBytes, memBytes) {
  const kb = Math.floor(memBytes / 1024);
  let found = -1;
  for (let i = 0; i + 1 < biosBytes.length; i++) {
    if (biosBytes[i] === 0xEF && biosBytes[i + 1] === 0xBE) {
      if (found !== -1) {
        throw new Error(`BIOS patch: signature 0xBEEF appears multiple times in bios.bin (offsets ${found}, ${i}). Pick a different signature.`);
      }
      found = i;
    }
  }
  if (found === -1) {
    throw new Error('BIOS patch: signature 0xBEEF not found in bios.bin. Is conventional_mem_kb still initialized to 0xBEEF?');
  }
  biosBytes[found]     = kb & 0xFF;
  biosBytes[found + 1] = (kb >> 8) & 0xFF;
}

// Patch the corduroy BIOS entry stub's hardcoded stack segment. entry.asm
// loads `mov ax, 0xBEEE` then `mov ss, ax; mov sp, 0xFFFE`; we rewrite the
// 0xBEEE immediate to `(memBytes - 0x10000) / 16` so the stack lives in a
// 64 KB window ending just before the configured memory top. Without this,
// the hardcoded 0x9000:FFFE stack falls outside autofit RAM and every
// push/ret corrupts the return chain — boot dies silently inside
// install_ivt's C prologue.
function patchBiosStackSeg(biosBytes, memBytes) {
  if (memBytes < 0x10000) {
    throw new Error(`BIOS patch: memBytes (${memBytes}) is below the 64 KB stack window. Increase memory.conventional.`);
  }
  const stackSeg = (memBytes - 0x10000) >> 4;
  let found = -1;
  for (let i = 0; i + 1 < biosBytes.length; i++) {
    if (biosBytes[i] === 0xEE && biosBytes[i + 1] === 0xBE) {
      if (found !== -1) {
        throw new Error(`BIOS patch: signature 0xBEEE appears multiple times in bios.bin (offsets ${found}, ${i}). Pick a different signature.`);
      }
      found = i;
    }
  }
  if (found === -1) {
    throw new Error('BIOS patch: signature 0xBEEE not found in bios.bin. Is entry.asm still loading `mov ax, 0xBEEE` before `mov ss, ax`?');
  }
  biosBytes[found]     = stackSeg & 0xFF;
  biosBytes[found + 1] = (stackSeg >> 8) & 0xFF;
}

// DOS conventional memory layout assumed by autofit:
//
//   0x00000 - 0x00600   IVT + BDA (1.5 KB, always)
//   0x00600 - 0x1A000   kernel image + decompressed code (~105 KB)
//   0x1A000 - ...       TPA: loaded program + stack + DOS heap
//   top ~104 KB         DOS kernel high area (relocated at boot via INT 12h)
//
// The caller-visible memBytes is the total conventional-zone size. Corduroy's
// install_bda writes memBytes/1024 into BDA 0x413 (patched in by
// patchBiosMemSize below) so INT 12h returns the real top and the kernel
// relocates into valid RAM rather than into the unmapped gap between the
// autofit top and 0xA0000.
const DOS_TPA_BASE     = 0x1A000; // kernel image + decompressed code
const DOS_HIGH_AREA    = 0x1A000; // kernel high area at the top
const DOS_STACK_BUDGET = 0x10000; // 64 KB stack + heap headroom
const DOS_MIN_MEM      = 0x20000; // 128 KB floor
const DOS_MAX_MEM      = 0xA0000; // 640 KB cap
const DOS_MEM_ALIGN    = 0x4000;  // 16 KB granularity

function autofitDosMem(programSize) {
  const raw = DOS_TPA_BASE + programSize + DOS_STACK_BUDGET + DOS_HIGH_AREA;
  const aligned = Math.ceil(raw / DOS_MEM_ALIGN) * DOS_MEM_ALIGN;
  return Math.min(DOS_MAX_MEM, Math.max(DOS_MIN_MEM, aligned));
}

function runKilnDos({ bios, floppy, manifest, kernelBytes, output, header }) {
  if (!kernelBytes) throw new Error('runKilnDos: kernelBytes is required');

  let autofitBytes = DOS_MAX_MEM;
  const autorun = manifest.boot?.autorun;
  if (autorun && floppy?.layout) {
    const prog = floppy.layout.find(f => f.name === autorun.toUpperCase());
    if (prog?.size != null) autofitBytes = autofitDosMem(prog.size);
  }
  const memBytes = resolveMemorySize(manifest.memory?.conventional ?? 'autofit', { autofitBytes });
  if (bios.meta?.flavor === 'corduroy') {
    patchBiosMemSize(bios.bytes, memBytes);
    patchBiosStackSeg(bios.bytes, memBytes);
  }
  const prune = {
    gfx:     manifest.memory?.gfx === false,
    textVga: manifest.memory?.textVga === false,
    cgaGfx:  manifest.memory?.cgaGfx !== true,
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

  const prune = {
    gfx:     manifest.memory?.gfx !== true,     // opt-in for hack carts
    cgaGfx:  manifest.memory?.cgaGfx !== true,  // opt-in for hack carts
  };

  const embeddedData = [buildIVTData()];
  const memoryZones = comMemoryZones(programBytes, programOffset, memBytes, prune);

  emitCSS({
    programBytes,
    biosBytes:     bios.bytes,
    memoryZones,
    embeddedData,
    programOffset,
    header,
  }, output);
}

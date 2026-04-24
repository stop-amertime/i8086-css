// Size preset parsing. Strings are presets ("640K", "1440K", "autofit"),
// numbers are exact bytes.

const MEMORY_PRESETS = {
  '4K':   4 * 1024,
  '64K':  64 * 1024,
  '128K': 128 * 1024,
  '256K': 256 * 1024,
  '512K': 512 * 1024,
  '640K': 640 * 1024,
};

const FLOPPY_PRESETS = {
  '360K':  360 * 1024,
  '720K':  720 * 1024,
  '1200K': 1200 * 1024,
  '1440K': 1440 * 1024,
  '2880K': 2880 * 1024,
};

export function resolveMemorySize(value, { autofitBytes } = {}) {
  if (typeof value === 'number') return value;
  if (value === 'autofit') {
    if (autofitBytes == null) {
      throw new Error("memory.conventional: 'autofit' requires a context-provided size");
    }
    return autofitBytes;
  }
  if (MEMORY_PRESETS[value] != null) return MEMORY_PRESETS[value];
  throw new Error(`memory.conventional: unknown value ${JSON.stringify(value)}`);
}

// DOS autofit constants — shared by build.mjs (for harness-header memory
// resolution) and stages/kiln.mjs (the canonical consumer). Kept here so
// the two paths can't drift.
//
// DOS layout assumed:
//   0x00000 - 0x00600   IVT + BDA (1.5 KB, always)
//   0x00600 - 0x1A000   kernel image + decompressed code (~105 KB)
//   0x1A000 - ...       TPA: loaded program + stack + DOS heap
//   top ~104 KB         DOS kernel high area (relocated at boot via INT 12h)
export const DOS_TPA_BASE     = 0x1A000;   // kernel image + decompressed code
export const DOS_HIGH_AREA    = 0x1A000;   // kernel high area at the top
export const DOS_STACK_BUDGET = 0x10000;   // 64 KB stack + heap headroom
export const DOS_MIN_MEM      = 0x20000;   // 128 KB floor
export const DOS_MAX_MEM      = 0xA0000;   // 640 KB cap
export const DOS_MEM_ALIGN    = 0x4000;    // 16 KB granularity

export function autofitDosMem(programSize) {
  const raw = DOS_TPA_BASE + programSize + DOS_STACK_BUDGET + DOS_HIGH_AREA;
  const aligned = Math.ceil(raw / DOS_MEM_ALIGN) * DOS_MEM_ALIGN;
  return Math.min(DOS_MAX_MEM, Math.max(DOS_MIN_MEM, aligned));
}

// Autofit for hack-preset .COM carts. Fits program + 256 bytes of headroom.
export function autofitHackMem(programSize) {
  return Math.max(0x600, 0x100 + programSize + 0x100);
}

export function resolveFloppySize(value, { autofitBytes } = {}) {
  if (typeof value === 'number') return value;
  if (value === 'autofit') {
    if (autofitBytes == null) return FLOPPY_PRESETS['1440K'];
    // Round up to next preset that fits.
    const presets = Object.values(FLOPPY_PRESETS).sort((a, b) => a - b);
    for (const p of presets) if (p >= autofitBytes) return p;
    return autofitBytes;
  }
  if (FLOPPY_PRESETS[value] != null) return FLOPPY_PRESETS[value];
  throw new Error(`disk.size: unknown value ${JSON.stringify(value)}`);
}

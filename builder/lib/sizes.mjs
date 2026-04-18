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

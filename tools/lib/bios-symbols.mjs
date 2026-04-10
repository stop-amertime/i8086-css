// Parse a NASM listing (.lst) file and extract label offsets.
//
// This is the single source of truth for "where in the BIOS binary does
// symbol X live". Anyone who needs to know a BIOS handler offset — the
// transpiler building an IVT, a test harness populating one, a debugger
// looking up an address — reads it from here. Offsets are a BIOS
// implementation detail, not a contract; they change every time the BIOS
// is rebuilt. Hardcoding them anywhere else is a drift bug waiting to happen.
//
// NASM listing format (what we rely on):
//
//      440                                  ; ============================================================
//      441                                  ; INT 20h — Halt
//      442                                  ; ============================================================
//      443                                  int20h_handler:
//      444                                      ; Signal halt: write 1 to halt flag at DS:0x2110
//      445 00000259 1E                          push ds
//
// Labels sit on their own line ending in `:`. The offset is taken from
// the next line that has an 8-hex-digit address column — usually the
// line immediately below, but we skip blank lines and comment-only lines
// defensively.

import { readFileSync } from 'fs';

/**
 * Parse a NASM listing file and return a map of { symbolName: byteOffset }.
 *
 * Only top-level labels are captured (labels starting in column 34 with no
 * leading `.`). Local labels like `.dispatch_other` are ignored — they
 * aren't meaningful outside the handler they live in.
 */
export function parseBiosSymbols(lstPath) {
  const text = readFileSync(lstPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const symbols = {};

  // Column layout: "%5d %-32s source"
  //   - cols 1-5   : line number
  //   - cols 7-14  : 8-hex-digit address (if any)
  //   - cols 16+   : hex bytes or source text
  // Labels appear as source text with no leading dot: `int10h_handler:`
  const labelRe = /^\s*\d+\s+([A-Za-z_][A-Za-z0-9_]*):\s*$/;
  const addressRe = /^\s*\d+\s+([0-9A-Fa-f]{8})\s/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const name = m[1];

    // Look ahead for the first line with an address column. Skip blank
    // lines, comments, and other label-only lines (back-to-back labels
    // all share the same offset).
    for (let j = i + 1; j < lines.length; j++) {
      const am = lines[j].match(addressRe);
      if (am) {
        if (!(name in symbols)) {
          symbols[name] = parseInt(am[1], 16);
        }
        break;
      }
      // If we hit another label before finding an address, the current
      // label aliases whatever comes next — keep scanning.
      if (labelRe.test(lines[j])) continue;
    }
  }
  return symbols;
}

/**
 * Build the default IVT handler map for a BIOS .lst — the subset of
 * symbols that the canonical IVT points at. Throws if a required handler
 * is missing (which means the BIOS source was edited without updating
 * this list, or the label was renamed).
 *
 * Returns `{ 0x10: <offset>, 0x16: <offset>, ... }` keyed by interrupt
 * number, matching what buildIVTData used to hardcode.
 */
export function loadIvtHandlers(lstPath) {
  const symbols = parseBiosSymbols(lstPath);
  const required = {
    0x10: 'int10h_handler',
    0x16: 'int16h_handler',
    0x1A: 'int1ah_handler',
    0x20: 'int20h_handler',
    0x21: 'int21h_handler',
  };
  const result = {};
  const missing = [];
  for (const [intNum, symName] of Object.entries(required)) {
    if (symName in symbols) {
      result[parseInt(intNum)] = symbols[symName];
    } else {
      missing.push(symName);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `BIOS listing ${lstPath} is missing required symbols: ${missing.join(', ')}. ` +
      `Either the BIOS source was changed without updating loadIvtHandlers, or the .lst is stale.`
    );
  }
  return result;
}

/**
 * Populate an IVT (4 bytes per entry: IP_lo, IP_hi, CS_lo, CS_hi) in the
 * given memory buffer from a handler map and BIOS segment. Used by test
 * harnesses that bypass bios_init — see the "test harness shortcut"
 * headers on ref-emu.mjs and compare.mjs for why.
 */
export function writeIvtTo(memory, handlers, biosSeg) {
  for (const [intNum, offset] of Object.entries(handlers)) {
    const addr = parseInt(intNum) * 4;
    memory[addr]     =  offset        & 0xFF;
    memory[addr + 1] = (offset >> 8)  & 0xFF;
    memory[addr + 2] =  biosSeg       & 0xFF;
    memory[addr + 3] = (biosSeg >> 8) & 0xFF;
  }
}

// cabinet-header.mjs — parse + write the cabinet header comment.
//
// Every .css cabinet begins with a C-style comment. The current human-
// readable form holds a "Resolved manifest:" JSON block and free-form
// notes. We want two things from it:
//   - Reliable machine-readable access to the manifest (bios, disk, memory)
//     without re-scraping the free-form text.
//   - Enough extra info that downstream tooling (ref emulator, screenshot
//     renderer) can reproduce the build's memory map.
//
// To get that without breaking the existing format, we add an optional
// second comment block immediately after the header:
//
//   /*!HARNESS v1 {json}!*/
//
// The `!HARNESS v1 ... !*/` sentinel form keeps the payload a single
// self-contained comment so any CSS tooling still ignores it, but is
// quick to extract with a regex. Cabinets without the harness block
// still work — we fall back to parsing the human header's JSON indent.

import { readFileSync, openSync, readSync, closeSync } from 'node:fs';

const HARNESS_HEADER_VERSION = 1;
const HARNESS_TAG = `!HARNESS v${HARNESS_HEADER_VERSION} `;

// Read only the first N bytes of a (possibly gigantic) cabinet. Cabinets
// are tens to hundreds of MB — never read the whole file just to get the
// header. 64 KB is plenty for the comment block.
export function readCabinetHeader(cssPath, { maxBytes = 64 * 1024 } = {}) {
  const fd = openSync(cssPath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

// Extract the machine-readable harness header if present. Returns null
// if the cabinet was built without one (older builds or future carts that
// skip the step).
export function parseHarnessHeader(headerText) {
  const m = headerText.match(/\/\*(!HARNESS v\d+) ([\s\S]*?)!\*\//);
  if (!m) return null;
  const version = Number.parseInt(m[1].replace('!HARNESS v', ''), 10);
  const body = m[2].trim();
  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(`harness header JSON parse failed: ${err.message}`);
  }
  return { version, ...json };
}

// Fallback: parse the human header's "Resolved manifest:" block.
// Best-effort. Returns null if the shape doesn't match what build.mjs
// currently emits.
export function parseHumanHeader(headerText) {
  const start = headerText.indexOf('Resolved manifest:');
  if (start < 0) return null;
  // Each line is " *   <text>" — strip the leading ` *   ` (3 spaces)
  // from the lines after "Resolved manifest:".
  const after = headerText.slice(start);
  const lines = after.split('\n');
  const jsonLines = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    // Stop at the closing-brace or at the first line that doesn't look
    // like it's part of the manifest indent.
    const stripped = raw.replace(/^ \*(?: {3})?/, '');
    if (stripped.startsWith('Disk layout:') || stripped.startsWith('BIOS:') ||
        stripped.trim() === '' || raw.trim() === '*/') {
      // closing brace is usually on the line directly before
      break;
    }
    jsonLines.push(stripped);
  }
  const jsonText = jsonLines.join('\n').trim();
  try {
    return { source: 'human', manifest: JSON.parse(jsonText) };
  } catch {
    return null;
  }
}

// Unified view. Caller wants: bios flavor, disk present?, memory size,
// cart name, preset. Always returns something usable.
export function readCabinetMeta(cssPath) {
  const text = readCabinetHeader(cssPath);
  const harness = parseHarnessHeader(text);
  if (harness) {
    return { source: 'harness', ...harness };
  }
  const human = parseHumanHeader(text);
  if (human) return human;
  throw new Error(`cannot parse cabinet header from ${cssPath} (neither harness nor human manifest block found in first 64 KB)`);
}

// Build the harness-header comment string. Stays self-contained — the
// whole thing is one /* ... */ so there's no risk of confusing any
// CSS tokenizer. The payload is JSON, so keys can be added later
// without breaking older readers (they just ignore what they don't know).
export function buildHarnessHeader(meta) {
  const body = JSON.stringify({
    builtAt: meta.builtAt ?? new Date().toISOString(),
    cartName: meta.cartName ?? null,
    preset: meta.preset ?? null,
    bios: meta.bios ?? null,              // { flavor, version, sizeBytes, sourceHash, entrySegment, entryOffset }
    memory: meta.memory ?? null,          // { conventional, gfx, textVga, autofit }
    disk: meta.disk ?? null,              // { mode, size, writable, files: [...] }
    program: meta.program ?? null,        // { name, sizeBytes, sha256 } (hack only)
    kernel: meta.kernel ?? null,          // { sha256 } (dos only)
    harness: { version: HARNESS_HEADER_VERSION },
  });
  return `/*${HARNESS_TAG}${body}!*/`;
}

// Convenience: read meta, return a normalized shape whether the cabinet
// has a harness block or only the human header.
export function normalizeMeta(meta) {
  // harness form carries a top-level `bios`, `disk`, `memory`. human form
  // nests everything under `manifest`.
  if (meta.source === 'harness') {
    return {
      source: 'harness',
      biosFlavor: meta.bios?.flavor ?? null,
      biosSizeBytes: meta.bios?.sizeBytes ?? null,
      biosEntrySegment: meta.bios?.entrySegment ?? null,
      biosEntryOffset: meta.bios?.entryOffset ?? null,
      preset: meta.preset ?? null,
      hasDisk: meta.disk != null,
      memoryBytes: meta.memory?.conventionalBytes ?? null,
      cartName: meta.cartName ?? null,
    };
  }
  const m = meta.manifest ?? {};
  return {
    source: 'human',
    biosFlavor: m.bios ?? null,
    biosSizeBytes: null,
    biosEntrySegment: null,
    biosEntryOffset: null,
    preset: m.preset ?? (m.bios === 'gossamer' ? 'hack' : 'dos-' + (m.bios ?? '?')),
    hasDisk: m.disk != null,
    memoryBytes: parseMemoryField(m.memory?.conventional ?? null),
    cartName: null,
  };
}

function parseMemoryField(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const m = s.match(/^(\d+)\s*([KMkmG])?$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  const mult = m[2] ? { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024, k: 1024, m: 1024 * 1024 }[m[2]] : 1;
  return n * mult;
}

// Utility for the harness to re-read a cabinet off disk once the build
// lands. Not used in the hot path; just a convenience.
export function readCabinetFromPath(cssPath) {
  const text = readFileSync(cssPath, 'utf8');
  const meta = readCabinetMeta(cssPath);
  return { text, meta, normalized: normalizeMeta(meta) };
}

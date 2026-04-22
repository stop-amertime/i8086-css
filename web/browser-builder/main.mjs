// Browser-side build orchestrator. Replaces builder/build.mjs for the
// browser path. Shares kiln/, builder/lib/sizes.mjs, tools/mkfat12.mjs,
// and builder/stages/kiln.mjs with the Node path.
//
// Supports: hack (.com direct), dos-muslin, and dos-corduroy.
//
// Uses resolveManifest + preset JSONs (fetched from /presets/*) so the
// resolved manifest is byte-identical to what builder/build.mjs produces.

import { runKiln } from '../../builder/stages/kiln.mjs';
import { resolveManifest } from '../../builder/lib/config.mjs';
import { loadPrebakedBios } from './prebake-loader.mjs';
import { buildFloppyInBrowser } from './floppy-adapter.mjs';
import { BlobWriter } from './blob-writer.mjs';

const SUPPORTED_PRESETS = new Set(['hack', 'dos-muslin', 'dos-corduroy']);
const ALL_PRESET_NAMES = ['dos-muslin', 'dos-corduroy', 'hack'];

// Fetch and parse a JSON resource.
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// Fetch raw bytes as Uint8Array.
async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Load all preset JSON files from /presets/*.json so resolveManifest can
 * merge them. Matches what builder/build.mjs does at startup.
 * Module-level cache so repeated buildCabinetInBrowser calls skip the fetches.
 */
let _presetsCache = null;
async function loadPresets() {
  if (_presetsCache) return _presetsCache;
  const entries = await Promise.all(
    ALL_PRESET_NAMES.map(async name => [name, await fetchJSON(`/presets/${name}.json`)]),
  );
  _presetsCache = Object.fromEntries(entries);
  return _presetsCache;
}

/**
 * Build a CSS cabinet in the browser from a .COM/.EXE program OR a folder of files.
 *
 * Two input shapes:
 *   1. Single program: pass `programBytes` + optional `programName`.
 *   2. Folder / multi-file: pass `files: [{ name, bytes }]`. If `autorun` is set,
 *      that's the SHELL= target. Otherwise COMMAND.COM is dropped in and the
 *      user gets a DOS prompt.
 *
 * @param {object}   opts
 * @param {string}   opts.preset          'hack', 'dos-muslin', or 'dos-corduroy'
 * @param {Uint8Array} [opts.programBytes]  Raw program bytes (single-file mode)
 * @param {string}   [opts.programName]   Filename for single-file mode
 * @param {Array}    [opts.files]         Multi-file mode: [{ name, bytes }]
 * @param {string}   [opts.bios]          Override BIOS flavor
 * @param {string}   [opts.autorun]       SHELL= target (DOS). Null = COMMAND.COM.
 * @param {string}   [opts.args]          Extra args for SHELL= line (DOS path only)
 * @param {object}   [opts.manifest]      Extra manifest fields (merged on top of preset)
 * @param {Function} [opts.onProgress]    Called with {stage, message} at each stage
 * @returns {Promise<Blob>}               The CSS cabinet as a Blob
 */
export async function buildCabinetInBrowser({
  preset,
  programBytes = null,
  programName = 'PROG.COM',
  files = null,
  bios: biosFlavorOverride = null,
  autorun = null,
  args = '',
  manifest: extraManifest = {},
  onProgress = () => {},
}) {
  if (!SUPPORTED_PRESETS.has(preset)) {
    throw new Error(
      `browser builder v1 supports: ${[...SUPPORTED_PRESETS].join(', ')}. got "${preset}"`,
    );
  }

  // Normalise inputs into a single `cartFileList` of {name, bytes, ext}.
  // Single-file mode folds into a 1-entry list.
  let cartFileList;
  if (files && files.length) {
    cartFileList = files.map(f => {
      const n = f.name.toUpperCase();
      const dot = n.lastIndexOf('.');
      return {
        name: n,
        bytes: f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes),
        ext: dot >= 0 ? n.slice(dot).toLowerCase() : '',
      };
    });
  } else if (programBytes) {
    const n = programName.toUpperCase();
    const dot = n.lastIndexOf('.');
    cartFileList = [{
      name: n,
      bytes: programBytes instanceof Uint8Array ? programBytes : new Uint8Array(programBytes),
      ext: dot >= 0 ? n.slice(dot).toLowerCase() : '',
    }];
  } else {
    throw new Error('buildCabinetInBrowser: provide either programBytes or files');
  }

  // For hack preset, there must be exactly one .COM.
  if (preset === 'hack') {
    const coms = cartFileList.filter(f => f.ext === '.com');
    if (coms.length !== 1) {
      throw new Error(`hack preset requires exactly one .COM file; got ${coms.length}`);
    }
  }

  // "Primary" program (first runnable) — used for display name and the
  // hack path's programBytes.
  const runnables = cartFileList.filter(f => f.ext === '.com' || f.ext === '.exe');
  const primary = runnables[0] ?? cartFileList[0];
  const progName = primary.name;
  const progExt = primary.ext;
  const progArr = primary.bytes;

  // Load preset JSONs so resolveManifest can deep-merge them.
  onProgress({ stage: 'presets', message: 'Loading preset configuration...' });
  const presets = await loadPresets();

  // Construct the raw manifest the same way builder/build.mjs does:
  //   CLI overrides → rawManifest → resolveManifest(rawManifest, files, presets, { bare })
  // We're always treating the input as a "bare" single-file cart.
  const rawManifest = { preset, ...extraManifest };
  if (biosFlavorOverride) rawManifest.bios = biosFlavorOverride;
  // Always set boot.autorun explicitly (even to null) so resolveManifest's
  // auto-infer doesn't silently pick the game .com when the user asked for
  // the COMMAND.COM prompt.
  rawManifest.boot = {
    ...(rawManifest.boot ?? {}),
    autorun: autorun ? autorun.toUpperCase() : null,
  };
  if (args) {
    rawManifest.boot = { ...(rawManifest.boot ?? {}), args };
  }

  // Construct the files list (same shape as cart.mjs::discoverFiles produces).
  const cartFiles = cartFileList.map(f => ({ name: f.name, source: f.name, ext: f.ext }));

  // resolveManifest fills in boot.raw (hack) or boot.autorun + disk.files (DOS).
  const manifest = resolveManifest(rawManifest, cartFiles, presets, { bare: true });

  // Default BIOS is already baked into the preset and resolved by resolveManifest.
  const biosFlavor = manifest.bios;

  onProgress({ stage: 'bios', message: `Loading ${biosFlavor} BIOS...` });
  const bios = await loadPrebakedBios(biosFlavor);

  const writer = new BlobWriter();

  if (preset === 'hack') {
    // Hack path: program bytes go directly to Kiln as number[].
    const header = buildHeader({ preset, biosFlavor, biosVersion: bios.meta?.version ?? null, programName: progName });
    onProgress({ stage: 'kiln', message: 'Transpiling to CSS...' });
    runKiln({
      bios,
      floppy: null,
      manifest,
      kernelBytes: null,
      programBytes: [...progArr],
      output: writer,
      header,
    });
  } else {
    // DOS path: fetch kernel + command.com + ansi.sys, assemble FAT12 floppy,
    // run Kiln. ansi.sys is NANSI (GPLv2), loaded by DEVICE=\ANSI.SYS in the
    // synthesized CONFIG.SYS so programs emitting terminal escapes work.
    onProgress({ stage: 'dos', message: 'Loading DOS kernel, command.com, and ansi.sys...' });
    const [kernelArr, commandArr, ansiArr] = await Promise.all([
      fetchBytes('/assets/dos/kernel.sys'),
      fetchBytes('/assets/dos/command.com'),
      fetchBytes('/assets/dos/ansi.sys'),
    ]);

    onProgress({ stage: 'floppy', message: 'Assembling FAT12 floppy image...' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const floppyAutorun = manifest.boot?.autorun ?? null;
    const floppyArgs = manifest.boot?.args ?? '';

    // Everything except the primary program goes in as extra disk files.
    const extraFiles = cartFileList
      .filter(f => f !== primary)
      .map(f => ({ name: f.name, bytes: f.bytes, source: 'user upload' }));

    const floppy = buildFloppyInBrowser({
      kernelBytes: kernelArr,
      commandBytes: commandArr,
      ansiBytes: ansiArr,
      programName: progName,
      programBytes: progArr,
      programFiles: extraFiles,
      autorun: floppyAutorun,
      args: floppyArgs,
    });

    // Build header after floppy so floppyLayout is available.
    const header = buildHeader({ preset, biosFlavor, biosVersion: bios.meta?.version ?? null, programName: progName, floppyLayout: floppy.layout });

    onProgress({ stage: 'kiln', message: 'Transpiling to CSS...' });
    await new Promise(resolve => setTimeout(resolve, 0));
    // kernelBytes must be number[] to match what builder/build.mjs passes.
    const kernelBytes = [...kernelArr];

    runKiln({
      bios,
      floppy,                // { bytes: Uint8Array, layout: [...] } — matches floppy.mjs output
      manifest,
      kernelBytes,
      programBytes: null,    // DOS branch; Kiln uses kernelBytes, not programBytes
      output: writer,
      header,
    });
  }

  onProgress({ stage: 'done', message: `Cabinet ready: ${writer.bytesWritten} bytes` });
  return writer.finish();
}

// 16-row half-block rendering of icons/css-dos-logo-32x32.png. Hand-touched
// from the auto-converted version; canonical source is
// icons/css-dos-asciiart-5.txt. Each line is padded to exactly 32 columns.
const LOGO_LINES = [
  '  \u2584\u2584\u2580\u2580\u2580\u2580\u2584\u2584 \u2584\u2584\u2580\u2580\u2580\u2580\u2580\u2584\u2584 \u2584\u2584\u2580\u2580\u2580\u2580\u2580\u2584\u2584  ',
  ' \u2588  \u2584\u2580\u2580\u2584  \u2588  \u2584\u2580\u2580\u2580\u2584  \u2588  \u2584\u2580\u2580\u2580\u2584  \u2588 ',
  ' \u2588  \u2588  \u2580\u2580\u2580\u2588  \u2580\u2584\u2584\u2584\u2580\u2580\u2580\u2588  \u2580\u2584\u2584\u2584\u2580\u2580\u2580\u2580 ',
  ' \u2588  \u2588      \u2580\u2580\u2584\u2584\u2584 \u2580\u2580\u2584 \u2580\u2580\u2584\u2584\u2584 \u2580\u2580\u2584  ',
  ' \u2588  \u2588  \u2588\u2580\u2580\u2584\u2580\u2580\u2584  \u2580\u2584  \u2588\u2580\u2580\u2584  \u2580\u2584  \u2588 ',
  ' \u2580\u2584  \u2580\u2580  \u2584\u2580\u2584 \u2580\u2580\u2580\u2580  \u2584\u2580\u2584 \u2580\u2580\u2580\u2580  \u2584\u2580 ',
  ' \u2584\u2588\u2588\u2584\u2584\u2584\u2584\u2588\u2588\u2584\u2580\u2588\u2584\u2584\u2584\u2584\u2584\u2588\u2580\u2584\u2588\u2588\u2584\u2584\u2584\u2584\u2584\u2588\u2580  ',
  ' \u2588\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2584\u2580\u2584\u2580\u2584\u2580\u2584\u2588\u2580\u2591\u2591\u2591\u2591\u2591\u2591\u2592\u2592\u2580\u2584  ',
  ' \u2588\u2593\u2593\u2593\u2588\u2580\u2580\u2588\u2580\u2584\u2580\u2584\u2593\u2593\u2588\u2580\u2588\u2591\u2591\u2591\u2584\u2588\u2588\u2588\u2580\u2584\u2592\u2592\u2588  ',
  ' \u2588\u2593\u2593\u2593\u2588  \u2588\u2580\u2584\u2588\u2593\u2593\u2593\u2588 \u2588\u2584\u2591\u2588\u2580\u2584\u2580\u2588\u2584\u2584\u2580\u2580\u2580  ',
  ' \u2588\u2593\u2593\u2593\u2588  \u2588\u2580\u2584\u2588\u2593\u2593\u2593\u2588  \u2580\u2588\u2588\u2580\u2584\u2580\u2588\u2591\u2592\u2580\u2580\u2584  ',
  ' \u2588\u2593\u2593\u2593\u2588  \u2588\u2580\u2584\u2588\u2593\u2593\u2593\u2588  \u2584\u2580\u2584\u2580\u2584\u2588\u2588\u2584\u2591\u2591\u2592\u2592\u2588 ',
  ' \u2588\u2593\u2593\u2593\u2588\u2584\u2584\u2584\u2588\u2588\u2593\u2593\u2593\u2588\u2588\u2584\u2588\u2584\u2580\u2584\u2580\u2584\u2588\u2584\u2584\u2580\u2591\u2592\u2592\u2588 ',
  ' \u2588\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2588\u2588\u2580\u2584\u2580\u2584\u2580\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2592\u2592\u2588\u2588 ',
  ' \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2580  ',
  '                                ',
];

// Tagline shown next to the logo. Kept narrow so the left box doesn't
// outrun the logo's width by much.
const TAGLINE = [
  'CSS-DOS',
  'An 80s PC in stylesheets.',
  '',
  'A complete VM: every',
  'register, flag, instruction',
  'decode and byte of memory',
  'is a CSS custom property',
  'driven by calc().',
  '',
];

// Format a Date as "YYYY-MM-DD HH:MM" -- human-readable, no ms.
function formatBuildTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Build a " key  value"-style row, padded to `width` chars.
function pad(s, width) { return s.length >= width ? s : s + ' '.repeat(width - s.length); }
function padRight(s, width) { return s.length >= width ? s : ' '.repeat(width - s.length) + s; }

// -----------------------------------------------------------------------
// Stacked layout (original): one box with the logo + meta on top, floppy
// contents appended below via a horizontal separator. Kept as a fallback.
// Not currently wired in; swap the export at the bottom of buildHeader to
// switch back.
// -----------------------------------------------------------------------
function buildHeaderStacked({ preset, biosFlavor, biosVersion, programName, floppyLayout = null }) {
  const biosTag = biosVersion ? `${biosFlavor} v${biosVersion}` : biosFlavor;
  const meta = [
    ['Built',   formatBuildTime(new Date())],
    ['Preset',  preset],
    ['BIOS',    biosTag],
    ['Autorun', programName],
  ];
  const rightCol = [...TAGLINE];
  while (rightCol.length < 8) rightCol.push('');
  for (const [k, v] of meta) rightCol.push(`${pad(k, 8)} ${v}`);
  while (rightCol.length < LOGO_LINES.length) rightCol.push('');

  const LOGO_W = 32, GAP = 2;
  const rightW = Math.max(...rightCol.map(s => s.length));
  const inner = LOGO_W + GAP + rightW;

  const top    = '/* \u2554' + '\u2550'.repeat(inner + 2) + '\u2557';
  const sep    = '   \u2560' + '\u2550'.repeat(inner + 2) + '\u2563';
  const bottom = '   \u255A' + '\u2550'.repeat(inner + 2) + '\u255D */';

  const lines = [top];
  for (let i = 0; i < LOGO_LINES.length; i++) {
    const left = LOGO_LINES[i].padEnd(LOGO_W);
    const right = rightCol[i].padEnd(rightW);
    lines.push(`   \u2551 ${left}${' '.repeat(GAP)}${right} \u2551`);
  }
  if (floppyLayout && floppyLayout.length) {
    lines.push(sep);
    const title = 'Floppy contents:';
    lines.push(`   \u2551 ${title.padEnd(inner)} \u2551`);
    const nameW = Math.max(...floppyLayout.map(f => f.name.length));
    for (const f of floppyLayout) {
      const sizeStr = `${f.size.toLocaleString('en-US')} bytes`;
      const row = `  ${pad(f.name, nameW)}   ${padRight(sizeStr, inner - nameW - 5)}`;
      lines.push(`   \u2551 ${row.padEnd(inner)} \u2551`);
    }
  }
  lines.push(bottom);
  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Side-by-side layout (active): two boxes on the same rows. Left box holds
// the logo + tagline + meta. Right box holds the floppy contents. Both
// boxes are padded to the height of the taller one so their top/bottom
// borders line up. Right box width is just wide enough for its widest row.
// -----------------------------------------------------------------------
function buildHeader({ preset, biosFlavor, biosVersion, programName, floppyLayout = null }) {
  const biosTag = biosVersion ? `${biosFlavor} v${biosVersion}` : biosFlavor;

  // ----- Left box content (logo | tagline+meta) -----
  const meta = [
    ['Built',   formatBuildTime(new Date())],
    ['Preset',  preset],
    ['BIOS',    biosTag],
    ['Autorun', programName],
  ];
  const leftRight = [...TAGLINE];
  while (leftRight.length < 8) leftRight.push('');
  for (const [k, v] of meta) leftRight.push(`${pad(k, 8)} ${v}`);
  while (leftRight.length < LOGO_LINES.length) leftRight.push('');

  const LOGO_W = 32, GAP = 2;
  const leftRightW = Math.max(...leftRight.map(s => s.length));
  const leftInner = LOGO_W + GAP + leftRightW;      // chars inside left box
  const leftContentRows = LOGO_LINES.length;

  // ----- Right box content (floppy listing) -----
  const floppy = floppyLayout && floppyLayout.length ? floppyLayout : [];
  const nameW = floppy.length ? Math.max(...floppy.map(f => f.name.length)) : 0;
  const sizes = floppy.map(f => `${f.size.toLocaleString('en-US')} bytes`);
  const sizeW = sizes.length ? Math.max(...sizes.map(s => s.length)) : 0;

  // Each floppy row is "  <name padded to nameW>   <size right-aligned to sizeW>"
  // = 2 + nameW + 3 + sizeW = nameW + sizeW + 5 chars.
  const floppyRowW = nameW + sizeW + 5;
  const floppyTitle = 'Floppy contains:';
  const rightInner = Math.max(floppyTitle.length, floppyRowW);
  // Rows: title + blank + one row per file.
  const rightContentRows = floppy.length ? 2 + floppy.length : 0;

  // ----- Shared height -----
  const contentRows = Math.max(leftContentRows, rightContentRows);

  // ----- Borders -----
  const hasRight = floppy.length > 0;

  // When joined, the two boxes share a ║ wall. Top/bottom use ╦/╩ to connect
  // the divider to the outer borders; unjoined (hasRight=false) just uses
  // ╔/╗ and ╚/╝.
  const topBorder = hasRight
    ? '\u2554' + '\u2550'.repeat(leftInner + 2) + '\u2566' + '\u2550'.repeat(rightInner + 2) + '\u2557'
    : '\u2554' + '\u2550'.repeat(leftInner + 2) + '\u2557';
  const botBorder = hasRight
    ? '\u255A' + '\u2550'.repeat(leftInner + 2) + '\u2569' + '\u2550'.repeat(rightInner + 2) + '\u255D'
    : '\u255A' + '\u2550'.repeat(leftInner + 2) + '\u255D';

  const out = [];
  out.push(`/* ${topBorder}`);

  for (let i = 0; i < contentRows; i++) {
    // Left-box cell for this row.
    let leftInside;
    if (i < leftContentRows) {
      const l = LOGO_LINES[i].padEnd(LOGO_W);
      const r = leftRight[i].padEnd(leftRightW);
      leftInside = `${l}${' '.repeat(GAP)}${r}`;
    } else {
      leftInside = ' '.repeat(leftInner);
    }

    // Right-box cell for this row.
    //   row 0   = title
    //   row 1   = blank spacer
    //   row 2+  = files
    let rightInside = null;
    if (hasRight) {
      if (i === 0) {
        rightInside = floppyTitle;
      } else if (i === 1) {
        rightInside = '';
      } else {
        const fi = i - 2;
        if (fi < floppy.length) {
          rightInside = `  ${pad(floppy[fi].name, nameW)}   ${padRight(sizes[fi], sizeW)}`;
        } else {
          rightInside = '';
        }
      }
    }

    if (hasRight) {
      out.push(`   \u2551 ${leftInside} \u2551 ${rightInside.padEnd(rightInner)} \u2551`);
    } else {
      out.push(`   \u2551 ${leftInside} \u2551`);
    }
  }

  out.push(`   ${botBorder} */`);

  return out.join('\n');
}

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
  if (autorun) {
    rawManifest.boot = { ...(rawManifest.boot ?? {}), autorun: autorun.toUpperCase() };
  }
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
    const header = buildHeader({ preset, biosFlavor, programName: progName });
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
    // DOS path: fetch kernel + command.com, assemble FAT12 floppy, run Kiln.
    onProgress({ stage: 'dos', message: 'Loading DOS kernel and command.com...' });
    const [kernelArr, commandArr] = await Promise.all([
      fetchBytes('/assets/dos/kernel.sys'),
      fetchBytes('/assets/dos/command.com'),
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
      programName: progName,
      programBytes: progArr,
      programFiles: extraFiles,
      autorun: floppyAutorun,
      args: floppyArgs,
    });

    // Build header after floppy so floppyLayout is available.
    const header = buildHeader({ preset, biosFlavor, programName: progName, floppyLayout: floppy.layout });

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

function buildHeader({ preset, biosFlavor, programName, floppyLayout = null }) {
  const lines = [
    '/* CSS-DOS cabinet (built in browser)',
    ` * Preset:   ${preset}`,
    ` * BIOS:     ${biosFlavor}`,
    ` * Program:  ${programName}`,
    ` * Built:    ${new Date().toISOString()}`,
  ];
  if (floppyLayout) {
    lines.push(' * Floppy layout:');
    for (const f of floppyLayout) {
      lines.push(` *   ${f.name.padEnd(12)} ${String(f.size).padStart(7)} bytes  (${f.source})`);
    }
  }
  lines.push(' */');
  return lines.join('\n');
}

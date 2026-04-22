// web/site/assets/build.js
// Build UI logic: file picker → preset → build → save to cache → play/download.
// Also drives the paginated source viewer.

import { buildCabinetInBrowser } from '/browser-builder/main.mjs';
import { saveCabinet, purgeCabinets } from '/browser-builder/storage.mjs';

// Cabinets are ephemeral — evict on tab unload so nothing persists across
// browser sessions. `pagehide` fires for both close and bfcache transitions;
// the purge itself is fire-and-forget (Cache Storage handles the abort).
window.addEventListener('pagehide', () => { purgeCabinets(); });

const $ = (id) => document.getElementById(id);

// ── File / folder picker ─────────────────────────────────────────────────────
// Track which input was last used so Build knows which source to read.
// Picking from one clears the other so we never have both active.

let activeSource = null; // 'file' | 'folder' | null

// For folder uploads, derive the on-floppy name from webkitRelativePath.
// We strip the user-picked folder (first segment) and keep ONE level of
// subdirectory — mkfat12 supports DATA\FILE.DAT but not deeper nesting.
// Deeper paths are flattened into the first subdir to avoid silent data loss.
function relativeCartName(file) {
  const rel = file.webkitRelativePath || file.name;
  const parts = rel.split('/').filter(Boolean);
  // Drop the top-level folder name the user picked.
  const inside = parts.length > 1 ? parts.slice(1) : parts;
  if (inside.length === 1) return inside[0];
  // Keep first subdir, flatten the rest into its basename.
  return inside[0] + '\\' + inside[inside.length - 1];
}

function runnableNames() {
  // Returns an array of uppercase filenames (.com/.exe) from the active input.
  const out = [];
  if (activeSource === 'file') {
    const f = $('com-file').files[0];
    if (f) out.push(f.name.toUpperCase());
  } else if (activeSource === 'folder') {
    for (const f of $('dir-file').files || []) {
      const n = f.name.toUpperCase();
      if (n.endsWith('.COM') || n.endsWith('.EXE')) out.push(n);
    }
  }
  return out;
}

function refreshAutorunDropdown() {
  const sel = $('autorun');
  const preset = $('preset').value;
  const runnables = runnableNames();
  const isDos = preset !== 'hack';

  // Hack preset: autorun is driven by the single .com — hide the picker.
  // DOS presets always show the picker (COMMAND.COM is available even
  // without user uploads, since the builder fetches it from /assets/dos/).
  $('autorun-row').hidden = !isDos;
  // Video row: only shown for DOS presets. Hack gets text-only (matches
  // the hack preset's memory defaults and the fact that hack.json has
  // always been text-only — no per-build override exposed). Reset the
  // boxes to the current preset's defaults each time the preset changes.
  const videoRow = $('video-row');
  if (videoRow) {
    videoRow.hidden = !isDos;
    $('mem-textVga').checked = true;
    $('mem-gfx').checked = isDos;
    $('mem-cgaGfx').checked = false;
  }

  // Preserve the user's current choice if it's still valid.
  const previous = sel.value;
  sel.innerHTML = '';

  // Ordered list: user-uploaded runnables first (most specific = most
  // likely the user's actual target), then COMMAND.COM as the fallback.
  // Deduplicate in case the user uploaded their own COMMAND.COM.
  const seen = new Set();
  const ordered = [];
  for (const n of runnables) {
    if (!seen.has(n)) { seen.add(n); ordered.push(n); }
  }
  if (isDos && !seen.has('COMMAND.COM')) ordered.push('COMMAND.COM');

  for (const n of ordered) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }

  // Prefer the first user-runnable (e.g. ROGUE.COM) over a stale
  // COMMAND.COM selection. Only preserve the previous pick if it was a
  // real user choice — i.e. not the fallback.
  const firstUserRunnable = ordered.find(n => n !== 'COMMAND.COM');
  if (firstUserRunnable) {
    if (previous && previous !== 'COMMAND.COM' && [...sel.options].some(o => o.value === previous)) {
      sel.value = previous;
    } else {
      sel.value = firstUserRunnable;
    }
  } else if (ordered.length > 0) {
    // No user files uploaded — COMMAND.COM is the only option.
    sel.value = ordered[0];
  }
}

$('com-file').addEventListener('change', () => {
  const file = $('com-file').files[0];
  if (!file) return;
  $('dir-file').value = '';
  activeSource = 'file';
  $('file-name').textContent = file.name;
  $('start').disabled = false;
  refreshAutorunDropdown();
});

$('dir-file').addEventListener('change', () => {
  const files = $('dir-file').files;
  if (!files || files.length === 0) return;
  $('com-file').value = '';
  activeSource = 'folder';
  $('file-name').textContent = `${files.length} file${files.length === 1 ? '' : 's'} from folder`;
  $('start').disabled = false;
  refreshAutorunDropdown();
});

$('preset').addEventListener('change', refreshAutorunDropdown);
refreshAutorunDropdown();

// Split-mode reload button.
const splitReload = document.getElementById('split-reload');
if (splitReload) {
  splitReload.addEventListener('click', () => {
    const frame = document.getElementById('split-frame');
    frame.src = '/player/calcite.html?t=' + Date.now();
  });
}

// ── Build button ──────────────────────────────────────────────────────────────

$('start').addEventListener('click', async () => {
  // Collect files from whichever input was used.
  let cartFiles = []; // [{ name, bytes }]
  if (activeSource === 'file') {
    const f = $('com-file').files[0];
    if (!f) { alert('Pick a file or folder first.'); return; }
    cartFiles = [{ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }];
  } else if (activeSource === 'folder') {
    const list = $('dir-file').files;
    if (!list || list.length === 0) { alert('Pick a file or folder first.'); return; }
    cartFiles = await Promise.all(
      [...list].map(async f => ({
        name: relativeCartName(f),
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    );
  } else {
    alert('Pick a file or folder first.');
    return;
  }

  // Disable build button while running.
  $('start').disabled = true;

  // Evict any cabinet left over from a previous build before we start — if
  // this build fails partway the player tab must not pick up stale bytes.
  await purgeCabinets();

  // Show progress section, clear old state.
  $('progress').hidden = false;
  $('result').hidden = true;
  $('source-viewer').hidden = true;
  const stages = $('stages');
  stages.innerHTML = '';
  $('log').textContent = '';

  const preset = $('preset').value;
  const autorun = $('autorun').value || null;
  const memorySel = $('memory').value;
  // Empty = auto-fit (let the preset's "autofit" default win); otherwise
  // the dropdown value is a preset string the sizes.mjs resolver understands.
  // Video checkboxes: on DOS presets, override memory.{textVga,gfx,cgaGfx}.
  // On hack preset the row is hidden and we leave the preset's defaults
  // (text-only) alone.
  const isDos = preset !== 'hack';
  const memoryOverride = {};
  if (memorySel) memoryOverride.conventional = memorySel;
  if (isDos) {
    memoryOverride.textVga = $('mem-textVga').checked;
    memoryOverride.gfx     = $('mem-gfx').checked;
    memoryOverride.cgaGfx  = $('mem-cgaGfx').checked;
  }
  const extraManifest = Object.keys(memoryOverride).length
    ? { memory: memoryOverride }
    : {};

  let blob;
  try {
    blob = await buildCabinetInBrowser({
      preset,
      files: cartFiles,
      autorun,
      manifest: extraManifest,
      onProgress: ({ stage, message }) => {
        // Add a stage <li> to the ordered list.
        const li = document.createElement('li');
        li.textContent = message;
        // Mark the previous item done, this one in-progress.
        const prev = stages.querySelector('li.in-progress');
        if (prev) {
          prev.classList.remove('in-progress');
          prev.classList.add('done');
        }
        if (stage !== 'done') li.classList.add('in-progress');
        else li.classList.add('done');
        stages.appendChild(li);
        // Also append to raw log.
        $('log').textContent += message + '\n';
      },
    });

    // Save to Cache Storage so /player/calcite.html can load it via the
    // service worker. Cache Storage is the cross-tab hop from build→play.
    await saveCabinet(blob);
  } catch (err) {
    const li = document.createElement('li');
    li.textContent = 'Error: ' + err.message;
    li.classList.add('stage-error');
    stages.appendChild(li);
    $('log').textContent += 'Error: ' + err.message + '\n';
    // Re-enable Build so the user can retry.
    $('start').disabled = false;
    return;
  }

  // Show result section.
  $('result').hidden = false;
  $('size').textContent = `Cabinet: ${(blob.size / 1024 / 1024).toFixed(1)} MB`;

  // Download link: revoke old blob URL to avoid memory leak on rebuild.
  if (window._prevBlobUrl) URL.revokeObjectURL(window._prevBlobUrl);
  window._prevBlobUrl = URL.createObjectURL(blob);
  const dl = $('download');
  dl.href = window._prevBlobUrl;

  // Wire up paginated source viewer.
  setupSourceViewer(blob);

  // Split mode (?split=1): (re)load the calcite player iframe so it
  // picks up the freshly-cached /cabinet.css.
  if (document.body.classList.contains('split')) {
    const frame = document.getElementById('split-frame');
    frame.src = '/player/calcite.html?t=' + Date.now();
  }

  // Re-enable build button (allow rebuild).
  $('start').disabled = false;
});

// ── Paginated source viewer ───────────────────────────────────────────────────
// Slices the Blob into PAGE_SIZE-byte pages and displays one page at a time.
// blob.slice() is zero-copy; only one page materialises into JS memory at once.

const PAGE_SIZE = 50 * 1024;

function setupSourceViewer(blob) {
  const pre = $('source-pre');
  const code = $('source-code');
  const pageNumEl = $('page-num');
  const pageTotalEl = $('page-total');
  const pageBytesEl = $('page-bytes');
  const jump = $('page-jump');

  const pageCount = Math.max(1, Math.ceil(blob.size / PAGE_SIZE));
  let currentPage = 1;

  pageTotalEl.textContent = pageCount;
  jump.max = pageCount;
  $('source-viewer').hidden = false;

  async function render(page) {
    const clamped = Math.max(1, Math.min(pageCount, page));
    currentPage = clamped;
    const start = (clamped - 1) * PAGE_SIZE;
    const end = Math.min(blob.size, start + PAGE_SIZE);
    const text = await blob.slice(start, end).text();
    code.textContent = text;
    // Prism.highlightElement replaces the <code>'s textContent with spans.
    // Safe to call every page change -- it's fast on 50 KB chunks.
    if (window.Prism) window.Prism.highlightElement(code);
    pageNumEl.textContent = clamped;
    jump.value = clamped;
    pageBytesEl.textContent = `bytes ${start.toLocaleString()}–${(end - 1).toLocaleString()}`;
  }

  // Re-wire listeners (remove old ones by cloning the buttons).
  const prevBtn = $('page-prev');
  const nextBtn = $('page-next');
  const prevClone = prevBtn.cloneNode(true);
  const nextClone = nextBtn.cloneNode(true);
  prevBtn.replaceWith(prevClone);
  nextBtn.replaceWith(nextClone);
  const jumpClone = jump.cloneNode(true);
  jump.replaceWith(jumpClone);

  prevClone.addEventListener('click', () => render(currentPage - 1));
  nextClone.addEventListener('click', () => render(currentPage + 1));
  jumpClone.addEventListener('change', () => render(parseInt(jumpClone.value, 10) || 1));

  render(1);
}

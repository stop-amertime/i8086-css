// web/site/assets/build.js
// Build UI logic: file picker → preset → build → save to cache → play/download.
// Also drives the paginated source viewer.

import { buildCabinetInBrowser } from '/browser-builder/main.mjs';
import { saveCabinet } from '/browser-builder/storage.mjs';

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

  // Preserve the user's current choice if it's still valid.
  const previous = sel.value;
  sel.innerHTML = '';
  // Default: no autorun → boot straight to COMMAND.COM prompt (autorun=null).
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '(none — drop to COMMAND.COM prompt)';
  sel.appendChild(defaultOpt);

  // Always offer COMMAND.COM on DOS presets. floppy-adapter supplies the
  // bytes from dos/bin/command.com when the cart doesn't include its own.
  const names = new Set(runnables);
  if (isDos) names.add('COMMAND.COM');

  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }

  if ([...sel.options].some(o => o.value === previous)) {
    sel.value = previous;
  } else {
    // Default to "drop to prompt" — COMMAND.COM as SHELL= target is opt-in.
    sel.value = '';
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
  const extraManifest = memorySel
    ? { memory: { conventional: memorySel } }
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

    // Save to Cache Storage so /play.html can load it via the service worker.
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
    pre.textContent = text;
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

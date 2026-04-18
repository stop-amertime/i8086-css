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

  // Hack preset: autorun is driven by the single .com — hide the picker.
  $('autorun-row').hidden = preset === 'hack' || runnables.length === 0;

  // Preserve the user's current choice if it's still valid.
  const previous = sel.value;
  sel.innerHTML = '';
  // COMMAND.COM is always offered — if the cart doesn't include it, the
  // floppy builder falls back to dos/bin/command.com. Selecting it drops
  // the user at a DOS prompt instead of auto-running a program.
  const cmdOpt = document.createElement('option');
  cmdOpt.value = 'COMMAND.COM';
  cmdOpt.textContent = 'COMMAND.COM (DOS prompt)';
  sel.appendChild(cmdOpt);
  for (const n of runnables) {
    if (n === 'COMMAND.COM') continue; // avoid a duplicate
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }

  // Default: single-file mode → autorun that one; else preserve previous or COMMAND.COM.
  if ([...sel.options].some(o => o.value === previous)) {
    sel.value = previous;
  } else if (activeSource === 'file' && runnables.length === 1) {
    sel.value = runnables[0];
  } else {
    sel.value = 'COMMAND.COM';
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
        name: f.name,  // basename only; subfolder paths are flattened
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
  // COMMAND.COM is the "drop to DOS prompt" option — pass null so the floppy
  // builder's default branch (add COMMAND.COM + SHELL=\COMMAND.COM) fires.
  // Any other value is a specific SHELL= target.
  const autorunSel = $('autorun').value;
  const autorun = (autorunSel === '' || autorunSel === 'COMMAND.COM') ? null : autorunSel;

  let blob;
  try {
    blob = await buildCabinetInBrowser({
      preset,
      files: cartFiles,
      autorun,
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

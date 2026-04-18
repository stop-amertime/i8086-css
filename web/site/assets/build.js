// web/site/assets/build.js
// Build UI logic: file picker → preset → build → save to cache → play/download.
// Also drives the paginated source viewer.

import { buildCabinetInBrowser } from '/browser-builder/main.mjs';
import { saveCabinet } from '/browser-builder/storage.mjs';

const $ = (id) => document.getElementById(id);

// ── File picker: enable Build button when a file is selected ─────────────────

$('com-file').addEventListener('change', () => {
  const file = $('com-file').files[0];
  $('file-name').textContent = file ? file.name : 'No file selected';
  $('start').disabled = !file;
});

// ── Build button ──────────────────────────────────────────────────────────────

$('start').addEventListener('click', async () => {
  const file = $('com-file').files[0];
  if (!file) { alert('Pick a .com file first.'); return; }

  // Disable build button while running.
  $('start').disabled = true;

  // Show progress section, clear old state.
  $('progress').hidden = false;
  $('result').hidden = true;
  $('source-viewer').hidden = true;
  const stages = $('stages');
  stages.innerHTML = '';
  $('log').textContent = '';

  const bytes = new Uint8Array(await file.arrayBuffer());
  const preset = $('preset').value;
  const autorun = file.name.toUpperCase();

  let blob;
  try {
    blob = await buildCabinetInBrowser({
      preset,
      programBytes: bytes,
      programName: file.name,
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

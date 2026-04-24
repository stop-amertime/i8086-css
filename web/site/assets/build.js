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

  // Wire up paginated source viewer. Prism highlights page 1 synchronously
  // on the main thread (~50 KB chunk). We run it BEFORE handing cabinet
  // bytes to the bridge worker so the user sees the source immediately,
  // while the parse/compile happens in the background.
  setupSourceViewer(blob);

  // Let the browser paint the result + the highlighted source page before
  // we kick off the background parse/compile. Prefer requestAnimationFrame
  // (waits for an actual composited frame), but fall back to a short
  // setTimeout so a backgrounded tab — where rAF is throttled to ~0 Hz —
  // still progresses. Whichever fires first unblocks us.
  await new Promise((resolve) => {
    let done = false;
    const once = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(once));
    setTimeout(once, 100);
  });

  // Hand the cabinet blob directly to the bridge worker. Blobs are
  // structured-cloned by reference (no byte copy), so this costs ~0 on
  // the main thread. The worker does the `arrayBuffer()` materialisation
  // itself — off the main thread, where the compile was already going to
  // run. This replaces the old broadcast→SW-fetch→text() round-trip,
  // which materialised the whole cabinet as a JS string.
  //
  // Two modes:
  //   - eager  (checkbox on): bridge compiles NOW, in the background, so
  //       clicking Play is instant. Cost is renderer-process memory/GC
  //       pressure for the compile window, which can make the build tab
  //       feel sluggish. Fine when the user intends to play next.
  //   - lazy   (checkbox off): bridge just holds the blob and compiles
  //       on viewer-connect. Build tab stays snappy; Play button pays
  //       the compile wait.
  const eager = $('eager-compile').checked;
  try {
    if (window.__calciteBridge) {
      window.__calciteBridge.postMessage({
        type: eager ? 'cabinet-blob' : 'cabinet-blob-lazy',
        blob,
      });
    }
  } catch (e) {
    console.warn('[build] failed to post cabinet blob to bridge:', e);
  }

  // Save to Cache Storage so /player/calcite.html can load it via the
  // service worker on a cold page load. The bridge already has the
  // bytes; this is just for the player's later fetch.
  saveCabinet(blob).catch((e) =>
    console.warn('[build] saveCabinet failed:', e)
  );

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
// Cabinets are 100+ MB. Prism on a single 50KB page can still lock the main
// thread for seconds because cabinet CSS has pathologically long lines
// (packed-cell dispatch tables). So we paginate by LINE COUNT, not bytes.
//
// To avoid scanning the whole blob upfront (which would itself stall the
// tab), page offsets are discovered lazily: page 1 starts at byte 0; the
// start of page N is found by streaming forward from the last known
// offset, counting newlines, and caching the result. Navigation to page N
// walks just enough bytes to find page N's start.
//
// Total page count starts as an upper bound (blob.size / avg bytes per
// page, clamped to ≥ pages discovered so far) and narrows as we index
// further. When EOF is hit during a forward scan, the exact count is
// locked in.

const LINES_PER_PAGE = 200;

async function setupSourceViewer(blob) {
  const code = $('source-code');
  const pageNumEl = $('page-num');
  const pageTotalEl = $('page-total');
  const pageBytesEl = $('page-bytes');
  const jump = $('page-jump');
  const prevBtn = $('page-prev');
  const nextBtn = $('page-next');

  $('source-viewer').hidden = false;

  // pageStarts[i] = byte offset of page (i+1)'s first character.
  // Always at least [0]; extended lazily. If exactPageCount is set,
  // pageStarts has length = exactPageCount + 1 with a trailing sentinel
  // equal to blob.size (so page i spans [pageStarts[i], pageStarts[i+1])).
  const pageStarts = [0];
  let exactPageCount = null;
  let currentPage = 1;

  // Rough upper-bound estimate for the total page count until we've
  // scanned the full file. Assumes ~avg line length of 40 bytes; we
  // always show at least (pages discovered so far).
  function estimateTotalPages() {
    if (exactPageCount != null) return exactPageCount;
    const est = Math.max(1, Math.ceil(blob.size / (LINES_PER_PAGE * 40)));
    return Math.max(est, pageStarts.length);
  }

  // Extend pageStarts until it contains at least (targetPage+1) entries
  // or we hit EOF. Streams in 256KB chunks from the last known offset.
  async function ensurePage(targetPage) {
    if (targetPage < pageStarts.length) return;
    if (exactPageCount != null) return;

    const CHUNK = 256 * 1024;
    let offset = pageStarts[pageStarts.length - 1];
    // We're looking for the START of page (pageStarts.length + 1), i.e.
    // the byte after the LINES_PER_PAGE-th newline counting from `offset`.
    let linesSinceLastMark = 0;

    while (pageStarts.length <= targetPage && offset < blob.size) {
      const end = Math.min(offset + CHUNK, blob.size);
      const slice = blob.slice(offset, end);
      const buf = new Uint8Array(await slice.arrayBuffer());
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0A) {
          linesSinceLastMark++;
          if (linesSinceLastMark === LINES_PER_PAGE) {
            pageStarts.push(offset + i + 1);
            linesSinceLastMark = 0;
            if (pageStarts.length > targetPage) break;
          }
        }
      }
      offset = end;
    }

    if (offset >= blob.size) {
      // EOF: lock in the exact page count. The last page may be short.
      exactPageCount = pageStarts.length;
      pageStarts.push(blob.size); // trailing sentinel
    }
  }

  async function renderPage(n) {
    await ensurePage(n);
    if (exactPageCount != null && n > exactPageCount) n = exactPageCount;
    currentPage = n;

    const startByte = pageStarts[n - 1];
    // End byte: if we know the next page's start, use it; else slice to
    // EOF (last page, still indexing).
    const endByte = pageStarts[n] != null ? pageStarts[n] : blob.size;
    const slice = blob.slice(startByte, endByte);
    const text = await slice.text();

    code.textContent = text;
    if (window.Prism) window.Prism.highlightElement(code);
    $('source-pre').scrollTop = 0;
    window.scrollTo({ top: $('source-viewer').offsetTop });

    const total = estimateTotalPages();
    pageNumEl.textContent = String(n);
    pageTotalEl.textContent = exactPageCount != null ? String(total) : `~${total}`;
    jump.value = n;
    jump.max = total;
    pageBytesEl.textContent =
      `${(endByte - startByte).toLocaleString()} bytes · lines ` +
      `${((n - 1) * LINES_PER_PAGE + 1).toLocaleString()}–` +
      `${((n - 1) * LINES_PER_PAGE + text.split('\n').length).toLocaleString()}`;

    prevBtn.disabled = n <= 1;
    nextBtn.disabled = exactPageCount != null && n >= exactPageCount;
  }

  prevBtn.onclick = () => { if (currentPage > 1) renderPage(currentPage - 1); };
  nextBtn.onclick = () => {
    if (exactPageCount == null || currentPage < exactPageCount) {
      renderPage(currentPage + 1);
    }
  };
  jump.onchange = () => {
    const v = Math.max(1, parseInt(jump.value, 10) || 1);
    renderPage(v);
  };

  await renderPage(1);
}

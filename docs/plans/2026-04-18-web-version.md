# Web version — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the in-browser CSS-DOS frontend described in `docs/web.md`: a static site where users upload a `.com`, watch the cabinet get built in their browser, and play it in a JavaScript-free player page.

**Architecture:** New top-level `web/` folder for everything cloud-specific. `web/browser-builder/main.mjs` replaces `builder/build.mjs` for the browser path; `kiln/`, `builder/lib/`, and `tools/mkfat12.mjs` are shared source, accessed through thin adapters that replace Node-only APIs (`fs`, `Buffer`, `child_process`) with browser equivalents (`fetch`, `Uint8Array`, nothing). NASM is run offline and its outputs are committed as `.bin` files under `web/prebake/`. Assembled cabinets live in the browser's Cache Storage; a service worker serves them to the JS-free player page under a fixed URL.

**Tech Stack:**
- Vanilla JS modules (`.mjs`), no bundler for v1 (Vite as optional dev server).
- Browser APIs: File, Blob, Cache Storage, IndexedDB, service worker, `URL.createObjectURL`.
- Existing code: `kiln/`, `builder/lib/`, `tools/mkfat12.mjs`.
- No test framework in the repo; tests are standalone `node --test` scripts using Node's built-in test runner.
- Deployment target: Vercel (static files only, gzip on).

**Scope — this plan covers v1 only.** Items marked "deferred" in `docs/web.md` are listed as Phase 2 at the bottom without task-level detail.

---

## File structure

### New files (v1)

```
web/
├── README.md                           ← local dev + deploy
├── site/
│   ├── index.html                      ← landing + gallery
│   ├── build.html                      ← upload + build narrator
│   ├── play.html                       ← JS-free player (copy of player/play.html)
│   ├── turbo.html                      ← JS-free + turbo script
│   ├── meter.html                      ← JS-free + meter script
│   ├── turbo-meter.html                ← both
│   ├── assets/
│   │   ├── site.css                    ← shared page styles (Win95 look)
│   │   ├── player.css                  ← player-page layout (keyboard grid etc.)
│   │   └── turbo.js                    ← ~15 LoC clock-accelerator
│   │   └── meter.js                    ← ~15 LoC speed meter
│   ├── sw.js                           ← service worker
│   └── prebake/                        ← symlink/copy of ../prebake at deploy
├── browser-builder/
│   ├── main.mjs                        ← orchestrator (replaces builder/build.mjs in browser)
│   ├── kiln-adapter.mjs                ← wraps kiln/emit-css for Blob-streaming output
│   ├── floppy-adapter.mjs              ← wraps tools/mkfat12.mjs for browser
│   ├── prebake-loader.mjs              ← fetch('/prebake/muslin.bin') → Uint8Array
│   ├── blob-writer.mjs                 ← writeStream-shaped object that accumulates into a Blob
│   └── storage.mjs                     ← Cache Storage wrapper, get/put cabinet
├── prebake/
│   ├── muslin.bin                      ← committed NASM output
│   ├── muslin.meta.json                ← {entryOffset, sizeBytes, sourceHash}
│   ├── gossamer.bin                    ← copied from bios/gossamer/
│   └── manifest.json                   ← catalog of available BIOSes
├── scripts/
│   ├── prebake.mjs                     ← runs NASM, refreshes prebake/
│   ├── dev.mjs                         ← local dev server
│   └── sync-player.mjs                 ← copies player/*.html → site/*.html
├── tests/
│   ├── blob-writer.test.mjs
│   ├── prebake-loader.test.mjs
│   ├── storage.test.mjs                ← skipped in Node; runs in browser only
│   └── browser-build.test.mjs          ← smoke test: tiny .com → cabinet Blob
└── vercel.json                         ← { "headers": [...gzip...], "cleanUrls": true }

player/
├── play.html                           ← JS-free (rewrite of current index.html)
├── turbo.html                          ← + assets/turbo.js
├── meter.html                          ← + assets/meter.js
└── turbo-meter.html                    ← both
```

### Files modified

- **`kiln/template.mjs`** — remove the `htmlMode` branch on line 154 so cabinets always ship with the CSS clock enabled.
- **`kiln/emit-css.mjs`** — audit for Node-only APIs. Reads `bios-symbols.mjs` (fs), maybe `Buffer`. Replace with `Uint8Array` and pass-in arguments (do not add runtime env branches).
- **`tools/mkfat12.mjs`** — audit; likely uses `fs` for I/O. Needs a browser-callable export that takes file bytes as input and returns `Uint8Array`, instead of reading/writing paths.
- **`player/README.md`** — updated to describe the three variants.
- **`docs/INDEX.md`** — add row for `docs/web.md` under a new "Web version" section.
- **`CLAUDE.md`** — mention `web/` in Quick orientation.
- **`CHANGELOG.md`** — entry.
- **`docs/logbook/LOGBOOK.md`** — session entry.

---

## Phase 1: v1 — foundation and audits

### Task 1: Remove `htmlMode` from Kiln

**Files:**
- Modify: `kiln/template.mjs:152-168`
- Test: `web/tests/kiln-clock-animation.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `web/tests/kiln-clock-animation.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitClockAndCpuBase } from '../../kiln/template.mjs';

test('emitClockAndCpuBase always includes anim-play animation', () => {
  const out = emitClockAndCpuBase();
  assert.match(out, /animation: anim-play 400ms steps\(4, jump-end\) infinite;/);
});

test('emitClockAndCpuBase ignores htmlMode option (removed)', () => {
  const out = emitClockAndCpuBase({ htmlMode: true });
  assert.match(out, /animation: anim-play 400ms steps\(4, jump-end\) infinite;/);
});
```

- [ ] **Step 2: Run test — should fail**

Run: `node --test web/tests/kiln-clock-animation.test.mjs`
Expected: The second test fails — `htmlMode: true` currently suppresses the animation.

- [ ] **Step 3: Remove `htmlMode` branch**

Replace `emitClockAndCpuBase` in `kiln/template.mjs` (currently lines 152-168):

```js
export function emitClockAndCpuBase() {
  return `.clock {
  animation: anim-play 400ms steps(4, jump-end) infinite;
  --clock: 0;
}

.cpu {
  animation: store 1ms infinite, execute 1ms infinite;
  animation-play-state: paused, paused;
  @container style(--clock: 1) { animation-play-state: running, paused }
  @container style(--clock: 3) { animation-play-state: paused, running }`;
}
```

- [ ] **Step 4: Remove any remaining `htmlMode` references**

Run: `grep -rn "htmlMode" kiln/ builder/ | grep -v legacy/` — expected output: none.

If any non-legacy references remain, remove them. Do not touch `legacy/v3/`.

- [ ] **Step 5: Run tests again — should pass**

Run: `node --test web/tests/kiln-clock-animation.test.mjs`
Expected: both tests pass.

- [ ] **Step 6: Verify a real cart still builds**

Run: `node builder/build.mjs carts/rogue -o /tmp/rogue.css`
Expected: builds with no errors; output CSS contains `animation: anim-play 400ms steps(4, jump-end) infinite;`.

- [ ] **Step 7: Commit**

```bash
git add kiln/template.mjs web/tests/kiln-clock-animation.test.mjs
git commit -m "kiln: always emit CSS clock animation, remove htmlMode"
```

---

### Task 2: Audit Kiln + tools for Node-only APIs

**Files:**
- Create: `docs/plans/2026-04-18-web-version-audit.md` (audit notes, deleted at end of Phase 1)

- [ ] **Step 1: Grep for Node API usage across shared code**

Run each and record results:

```bash
grep -rn "from 'node:" kiln/ builder/lib/ tools/mkfat12.mjs
grep -rn "require(" kiln/ builder/lib/ tools/mkfat12.mjs
grep -rn "Buffer\." kiln/ builder/lib/ tools/mkfat12.mjs
grep -rn "process\." kiln/ builder/lib/ tools/mkfat12.mjs
grep -rn "__dirname\|__filename\|import.meta.url" kiln/ builder/lib/ tools/mkfat12.mjs
```

- [ ] **Step 2: Write audit notes**

Create `docs/plans/2026-04-18-web-version-audit.md` with one entry per Node-only call site:

```
### kiln/foo.mjs:NN
Call: readFileSync(path.join(...))
Purpose: loads the BIOS bytes
Fix: take bytes as argument, move file-read into adapter.
```

Repeat for every match. Categorise each as either:
- **A. Move to adapter** — the function currently does I/O but doesn't need to; refactor to take/return bytes.
- **B. Shim** — small utilities (`Buffer.from` → `new Uint8Array`, `path.join` → string template). Apply globally.
- **C. Leave in Node-only code** — things only `builder/build.mjs` calls, not Kiln itself. No action needed.

- [ ] **Step 3: Commit audit notes**

```bash
git add docs/plans/2026-04-18-web-version-audit.md
git commit -m "plan: audit Kiln and shared code for Node APIs"
```

---

### Task 3: Refactor Kiln to take bytes in, writeStream out

**Files:**
- Modify: any `kiln/*.mjs` file flagged category A in Task 2.
- Verify: `emitCSS(opts, writeStream)` signature unchanged — it already takes a duck-typed writer.

- [ ] **Step 1: Write the failing test**

Create `web/tests/kiln-no-fs.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

test('Kiln source files do not import node: modules', () => {
  const files = [
    'kiln/emit-css.mjs',
    'kiln/memory.mjs',
    'kiln/template.mjs',
    'kiln/decode.mjs',
    'kiln/css-lib.mjs',
    'kiln/cycle-counts.mjs',
    // patterns/*.mjs — add all via glob in real version
  ];
  for (const f of files) {
    const src = readFileSync(resolve(repoRoot, f), 'utf8');
    assert.ok(
      !/from ['"]node:/.test(src),
      `${f} imports a node: module — move I/O out of Kiln`
    );
  }
});
```

- [ ] **Step 2: Run test, see failures**

Run: `node --test web/tests/kiln-no-fs.test.mjs`
Expected: each file that imports `node:fs` or similar shows up as a failure.

- [ ] **Step 3: For each flagged file, move I/O to callers**

For category-A call sites from Task 2, change the function signature to accept bytes instead of reading from disk. The single caller in `builder/stages/kiln.mjs` continues to do the `readFileSync` and pass bytes in. Do not add runtime env branching.

Example pattern:

```js
// Before (in kiln/foo.mjs):
import { readFileSync } from 'node:fs';
export function emitFoo(optsWithPath) {
  const bytes = readFileSync(optsWithPath.path);
  // ...
}

// After:
export function emitFoo(optsWithBytes) {
  const bytes = optsWithBytes.bytes; // Uint8Array or number[]
  // ...
}

// Caller (builder/stages/kiln.mjs) — update to read the file itself:
const bytes = [...readFileSync(p)];
emitFoo({ bytes });
```

- [ ] **Step 4: Replace `Buffer` with `Uint8Array`**

Category B from audit. `Buffer.from(x)` → `new Uint8Array(x)`. `Buffer.concat([a,b])` → manual concat via `new Uint8Array(a.length + b.length)` + `set`. Keep the same byte arrays semantically.

- [ ] **Step 5: Run the no-fs test — should pass**

Run: `node --test web/tests/kiln-no-fs.test.mjs`
Expected: pass.

- [ ] **Step 6: Smoke test — real build still works**

Run: `node builder/build.mjs carts/rogue -o /tmp/rogue-audited.css`
Expected: builds.

Diff against a pre-change build to verify output is identical:

```bash
# Before Task 3, save /tmp/rogue-pre.css.
diff -q /tmp/rogue-pre.css /tmp/rogue-audited.css
```

Expected: files are byte-identical. Kiln's output must not change from this refactor.

- [ ] **Step 7: Commit**

```bash
git add kiln/ builder/stages/kiln.mjs web/tests/kiln-no-fs.test.mjs
git commit -m "kiln: move file I/O into callers, make core browser-safe"
```

---

### Task 4: Refactor mkfat12 for browser use

**Files:**
- Modify: `tools/mkfat12.mjs`
- Test: `web/tests/mkfat12.test.mjs`

- [ ] **Step 1: Read the existing mkfat12 implementation**

```bash
cat tools/mkfat12.mjs
```

Note the current entry points: CLI (`node tools/mkfat12.mjs -o out.img --file NAME path ...`) and whatever the builder imports (`buildFloppy` in `builder/stages/floppy.mjs` shells out via `execSync`).

- [ ] **Step 2: Write the failing test**

Create `web/tests/mkfat12.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFat12Image } from '../../tools/mkfat12.mjs';

test('buildFat12Image returns a Uint8Array of a FAT12 floppy', () => {
  const files = [
    { name: 'HELLO.TXT', bytes: new TextEncoder().encode('hi!\n') },
  ];
  const img = buildFat12Image(files);
  assert.ok(img instanceof Uint8Array);
  // FAT12 1.44MB floppy is 1474560 bytes.
  assert.equal(img.length, 1474560);
  // Boot sector signature 0x55AA at offset 510.
  assert.equal(img[510], 0x55);
  assert.equal(img[511], 0xAA);
});
```

- [ ] **Step 3: Run test — likely fails (function not exported)**

Run: `node --test web/tests/mkfat12.test.mjs`
Expected: FAIL — `buildFat12Image` not exported from `tools/mkfat12.mjs`.

- [ ] **Step 4: Export `buildFat12Image` from mkfat12**

Refactor `tools/mkfat12.mjs` to split the logic:

- Pure function `buildFat12Image(files)` taking `[{name: string, bytes: Uint8Array}, ...]` and returning `Uint8Array`. No `fs` calls.
- CLI wrapper at the bottom that does the file I/O and calls `buildFat12Image`.
- `buildFloppy` in `builder/stages/floppy.mjs` updated to import `buildFat12Image` directly and skip the `execSync` shell-out.

- [ ] **Step 5: Run test — should pass**

Run: `node --test web/tests/mkfat12.test.mjs`
Expected: pass.

- [ ] **Step 6: Smoke test the builder still works**

Run: `node builder/build.mjs carts/rogue -o /tmp/rogue-fat.css`
Expected: builds; diff against earlier smoke build is byte-identical.

- [ ] **Step 7: Commit**

```bash
git add tools/mkfat12.mjs builder/stages/floppy.mjs web/tests/mkfat12.test.mjs
git commit -m "mkfat12: export buildFat12Image for in-process use"
```

---

### Task 5: Blob-writer (the stream-shaped output object)

**Files:**
- Create: `web/browser-builder/blob-writer.mjs`
- Create: `web/tests/blob-writer.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// web/tests/blob-writer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobWriter } from '../browser-builder/blob-writer.mjs';

test('BlobWriter accumulates chunks and produces a Blob', async () => {
  const w = new BlobWriter();
  w.write('hello ');
  w.write('world');
  const blob = w.finish();
  assert.equal(blob.size, 11);
  assert.equal(await blob.text(), 'hello world');
});

test('BlobWriter handles thousands of chunks without blowing up', async () => {
  const w = new BlobWriter();
  for (let i = 0; i < 10000; i++) w.write('x');
  const blob = w.finish();
  assert.equal(blob.size, 10000);
});

test('BlobWriter reports bytesWritten', () => {
  const w = new BlobWriter();
  w.write('abc');
  assert.equal(w.bytesWritten, 3);
  w.write('de');
  assert.equal(w.bytesWritten, 5);
});
```

- [ ] **Step 2: Run — fails (module doesn't exist)**

Run: `node --test web/tests/blob-writer.test.mjs`
Expected: FAIL (import error).

- [ ] **Step 3: Implement BlobWriter**

`web/browser-builder/blob-writer.mjs`:

```js
// A writeStream-shaped object that Kiln can write into. Accumulates
// string chunks into an array; on finish() builds a single Blob.
// The Blob constructor handles the underlying bytes natively — no
// intermediate string concat, so this scales to GB-sized cabinets
// without OOMing.
export class BlobWriter {
  constructor() {
    this.chunks = [];
    this.bytesWritten = 0;
  }

  write(str) {
    this.chunks.push(str);
    this.bytesWritten += str.length;
    return true;
  }

  finish({ type = 'text/css' } = {}) {
    const blob = new Blob(this.chunks, { type });
    this.chunks = null; // release for GC
    return blob;
  }
}
```

- [ ] **Step 4: Run — pass**

Run: `node --test web/tests/blob-writer.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/browser-builder/blob-writer.mjs web/tests/blob-writer.test.mjs
git commit -m "web: BlobWriter for browser-side Kiln output"
```

---

### Task 6: Prebake script and committed artifacts

**Files:**
- Create: `web/scripts/prebake.mjs`
- Create: `web/prebake/muslin.bin`, `web/prebake/muslin.meta.json`, `web/prebake/gossamer.bin`, `web/prebake/manifest.json`
- Test: `web/tests/prebake.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// web/tests/prebake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prebakeDir = resolve(__dirname, '..', 'prebake');

test('prebake manifest lists at least muslin', () => {
  const manifest = JSON.parse(readFileSync(resolve(prebakeDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.bioses.some(b => b.flavor === 'muslin'));
});

test('muslin.bin and muslin.meta.json exist', () => {
  assert.ok(statSync(resolve(prebakeDir, 'muslin.bin')).isFile());
  const meta = JSON.parse(readFileSync(resolve(prebakeDir, 'muslin.meta.json'), 'utf8'));
  assert.equal(typeof meta.entryOffset, 'number');
  assert.equal(typeof meta.sizeBytes, 'number');
  assert.equal(typeof meta.sourceHash, 'string');
});
```

- [ ] **Step 2: Run — fails (files missing)**

Run: `node --test web/tests/prebake.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the prebake script**

`web/scripts/prebake.mjs`:

```js
#!/usr/bin/env node
// Runs NASM on each BIOS flavour we ship. Writes binary output and
// per-flavour metadata (entry offset, size, source hash) to web/prebake/.
//
// Usage: node web/scripts/prebake.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const prebakeDir = resolve(__dirname, '..', 'prebake');
const NASM = process.env.NASM || 'C:\\Users\\AdmT9N0CX01V65438A\\AppData\\Local\\bin\\NASM\\nasm.exe';

mkdirSync(prebakeDir, { recursive: true });

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function findSymbol(listing, symbol) {
  const lines = listing.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`${symbol}:`)) {
      const m = lines[i + 1]?.match(/([0-9A-Fa-f]{8})/);
      if (m) return parseInt(m[1], 16);
    }
  }
  return null;
}

function bakeMuslin() {
  const asm = resolve(repoRoot, 'bios', 'muslin', 'muslin.asm');
  const bin = join(prebakeDir, 'muslin.bin');
  const lst = join(prebakeDir, 'muslin.lst');
  execSync(`"${NASM}" -f bin -o "${bin}" "${asm}" -l "${lst}"`, { stdio: 'pipe' });
  const bytes = readFileSync(bin);
  const listing = readFileSync(lst, 'utf8');
  const entryOffset = findSymbol(listing, 'bios_init');
  if (entryOffset == null) throw new Error('muslin: could not find bios_init in listing');
  const sourceHash = sha256(readFileSync(asm));
  writeFileSync(join(prebakeDir, 'muslin.meta.json'), JSON.stringify({
    flavor: 'muslin',
    entrySegment: 0xF000,
    entryOffset,
    sizeBytes: bytes.length,
    sourceHash,
  }, null, 2));
  console.log(`muslin.bin: ${bytes.length} bytes, entry=0x${entryOffset.toString(16)}`);
}

function bakeGossamer() {
  // Gossamer ships as a checked-in .bin — just copy.
  const src = resolve(repoRoot, 'bios', 'gossamer', 'gossamer.bin');
  const dst = join(prebakeDir, 'gossamer.bin');
  const bytes = readFileSync(src);
  writeFileSync(dst, bytes);
  writeFileSync(join(prebakeDir, 'gossamer.meta.json'), JSON.stringify({
    flavor: 'gossamer',
    entrySegment: null,
    entryOffset: null,
    sizeBytes: bytes.length,
    sourceHash: sha256(bytes),
  }, null, 2));
  console.log(`gossamer.bin: ${bytes.length} bytes (copied)`);
}

function writeManifest() {
  const manifest = {
    generated: new Date().toISOString(),
    bioses: [
      { flavor: 'muslin', binary: 'muslin.bin', meta: 'muslin.meta.json' },
      { flavor: 'gossamer', binary: 'gossamer.bin', meta: 'gossamer.meta.json' },
    ],
  };
  writeFileSync(join(prebakeDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

bakeMuslin();
bakeGossamer();
writeManifest();
console.log('prebake done:', prebakeDir);
```

- [ ] **Step 4: Run the prebake**

Run: `node web/scripts/prebake.mjs`
Expected: creates `muslin.bin`, `muslin.meta.json`, `gossamer.bin`, `gossamer.meta.json`, `manifest.json` in `web/prebake/`.

- [ ] **Step 5: Run the test**

Run: `node --test web/tests/prebake.test.mjs`
Expected: pass.

- [ ] **Step 6: Commit the script AND the generated artifacts**

Per the design decision in `docs/web.md` ("committed artifacts: sloppy but pragmatic").

```bash
git add web/scripts/prebake.mjs web/prebake/ web/tests/prebake.test.mjs
git commit -m "web: prebake NASM outputs, commit as static artifacts"
```

---

### Task 7: Prebake loader (browser-side)

**Files:**
- Create: `web/browser-builder/prebake-loader.mjs`
- Test: `web/tests/prebake-loader.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// web/tests/prebake-loader.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrebakedBios } from '../browser-builder/prebake-loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prebakeDir = resolve(__dirname, '..', 'prebake');

// Stub global fetch() to read from local filesystem.
globalThis.fetch = async (url) => {
  // url is like '/prebake/muslin.bin'; strip leading /
  const rel = url.replace(/^\//, '');
  const path = resolve(prebakeDir, '..', rel);
  const bytes = readFileSync(path);
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
};

test('loadPrebakedBios returns bytes + entry info for muslin', async () => {
  const bios = await loadPrebakedBios('muslin');
  assert.ok(bios.bytes instanceof Uint8Array);
  assert.equal(bios.meta.flavor, 'muslin');
  assert.equal(bios.meta.entrySegment, 0xF000);
  assert.equal(typeof bios.meta.entryOffset, 'number');
});

test('loadPrebakedBios throws for unknown flavor', async () => {
  await assert.rejects(loadPrebakedBios('hoagie'), /unknown bios flavor/i);
});
```

- [ ] **Step 2: Run — fails**

Run: `node --test web/tests/prebake-loader.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement loader**

`web/browser-builder/prebake-loader.mjs`:

```js
// Fetches pre-baked BIOS bytes + metadata from /prebake/*.bin.
// Returns the same shape that builder/stages/bios.mjs::buildBios returns,
// so Kiln can consume either interchangeably.

const KNOWN_FLAVORS = new Set(['muslin', 'gossamer', 'corduroy']);

export async function loadPrebakedBios(flavor, { baseUrl = '/prebake' } = {}) {
  if (!KNOWN_FLAVORS.has(flavor)) {
    throw new Error(`unknown bios flavor: ${flavor}`);
  }
  const binRes = await fetch(`${baseUrl}/${flavor}.bin`);
  if (!binRes.ok) throw new Error(`failed to fetch ${flavor}.bin: ${binRes.status}`);
  const bytes = new Uint8Array(await binRes.arrayBuffer());

  const metaRes = await fetch(`${baseUrl}/${flavor}.meta.json`);
  if (!metaRes.ok) throw new Error(`failed to fetch ${flavor}.meta.json: ${metaRes.status}`);
  const meta = await metaRes.json();

  return {
    bytes: [...bytes], // Kiln's memory layer expects number[] (check during audit)
    entrySegment: meta.entrySegment,
    entryOffset: meta.entryOffset,
    meta,
  };
}

export async function loadPrebakeManifest({ baseUrl = '/prebake' } = {}) {
  const res = await fetch(`${baseUrl}/manifest.json`);
  if (!res.ok) throw new Error(`failed to fetch manifest: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run — pass**

Run: `node --test web/tests/prebake-loader.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/browser-builder/prebake-loader.mjs web/tests/prebake-loader.test.mjs
git commit -m "web: prebake-loader fetches BIOS artifacts for browser builder"
```

---

### Task 8: Browser builder orchestrator (hack path first)

**Files:**
- Create: `web/browser-builder/main.mjs`
- Create: `web/browser-builder/floppy-adapter.mjs`
- Test: `web/tests/browser-build.test.mjs`

The hack path (.com + gossamer BIOS, no floppy) is the simplest end-to-end. Starting here proves the pipeline before adding DOS/FAT12 complexity.

- [ ] **Step 1: Write the failing integration test**

```js
// web/tests/browser-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCabinetInBrowser } from '../browser-builder/main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

// Same fetch stub as prebake-loader test (extract to shared helper).
import './helpers/fetch-stub.mjs';

test('builds a hack cart (bcd.com) into a Blob', async () => {
  const comBytes = new Uint8Array(readFileSync(resolve(repoRoot, 'tests', 'bcd.com')));
  const blob = await buildCabinetInBrowser({
    preset: 'hack',
    bios: 'gossamer',
    programBytes: comBytes,
    programName: 'bcd.com',
  });
  assert.ok(blob instanceof Blob);
  assert.ok(blob.size > 1_000_000, `cabinet suspiciously small: ${blob.size}`);
  const text = await blob.text();
  assert.match(text, /animation: anim-play 400ms/);
  assert.match(text, /--readMem/);
});
```

Also create `web/tests/helpers/fetch-stub.mjs` that installs the filesystem-backed `fetch` (extracted from Task 7's test).

- [ ] **Step 2: Run — fails**

Run: `node --test web/tests/browser-build.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement floppy-adapter (stub for hack path)**

`web/browser-builder/floppy-adapter.mjs`:

```js
// Wraps tools/mkfat12.mjs::buildFat12Image for the browser path.
// For hack carts, returns null (no floppy).
import { buildFat12Image } from '../../tools/mkfat12.mjs';

export function buildFloppyInBrowser({ preset, manifest, cart }) {
  if (preset === 'hack' || !manifest.disk) return null;
  const files = manifest.disk.files.map(f => ({
    name: f.name.toUpperCase(),
    bytes: f.bytes,
  }));
  const bytes = buildFat12Image(files);
  return { bytes: [...bytes], layout: files.map(f => ({ name: f.name, size: f.bytes.length, source: 'user' })) };
}
```

- [ ] **Step 4: Implement main.mjs (hack path only)**

`web/browser-builder/main.mjs`:

```js
// Browser-side orchestrator. Replaces builder/build.mjs for the browser path.
// Shares kiln/, builder/lib/config.mjs, builder/lib/sizes.mjs, tools/mkfat12.mjs
// with the Node path.

import { emitCSS } from '../../kiln/emit-css.mjs';
import { comMemoryZones, dosMemoryZones, buildIVTData } from '../../kiln/memory.mjs';
import { resolveMemorySize } from '../../builder/lib/sizes.mjs';
import { loadPrebakedBios } from './prebake-loader.mjs';
import { buildFloppyInBrowser } from './floppy-adapter.mjs';
import { BlobWriter } from './blob-writer.mjs';

export async function buildCabinetInBrowser({
  preset,
  bios: biosFlavor,
  programBytes,
  programName,
  manifest: userManifest = {},
  onProgress = () => {},
}) {
  onProgress({ stage: 'bios', message: `Loading ${biosFlavor} BIOS...` });
  const bios = await loadPrebakedBios(biosFlavor);

  onProgress({ stage: 'floppy', message: 'Preparing floppy image...' });
  // Hack path only for now.
  if (preset !== 'hack') throw new Error('browser builder v1 only supports hack preset');

  const programOffset = 0x100;
  const programArr = [...programBytes];
  const autofitBytes = Math.max(0x600, programOffset + programArr.length + 0x100);
  const memBytes = resolveMemorySize(
    userManifest.memory?.conventional ?? 'autofit',
    { autofitBytes },
  );
  const memoryZones = comMemoryZones(programArr, programOffset, memBytes);
  const embeddedData = [buildIVTData()];

  const header = `/* CSS-DOS cabinet (built in browser)\n * Program: ${programName}\n * BIOS: ${biosFlavor}\n * Built: ${new Date().toISOString()}\n */`;

  onProgress({ stage: 'kiln', message: 'Transpiling to CSS...' });
  const writer = new BlobWriter();
  emitCSS({
    programBytes: programArr,
    biosBytes: bios.bytes,
    memoryZones,
    embeddedData,
    programOffset,
    header,
  }, writer);

  onProgress({ stage: 'done', message: `Cabinet ready: ${writer.bytesWritten} bytes` });
  return writer.finish();
}
```

- [ ] **Step 5: Run the test — should pass**

Run: `node --test web/tests/browser-build.test.mjs`
Expected: pass. Blob is > 1 MB and contains recognisable CSS.

- [ ] **Step 6: Save the cabinet from the test and verify it matches a Node build**

Add to the test a comparison against the Node-built equivalent:

```js
test('browser-built hack cabinet is byte-identical to Node build', async () => {
  // Build via Node: node builder/build.mjs tests/bcd.com -o /tmp/bcd-node.css
  // (pre-run manually once, pin a reference hash)
  // ... diff ...
});
```

If not byte-identical, it must be because of the header timestamp — strip the header block from both before comparing.

- [ ] **Step 7: Commit**

```bash
git add web/browser-builder/main.mjs web/browser-builder/floppy-adapter.mjs \
        web/tests/browser-build.test.mjs web/tests/helpers/
git commit -m "web: browser builder v1 (hack path only)"
```

---

### Task 9: Browser builder — DOS path

**Files:**
- Modify: `web/browser-builder/main.mjs`
- Modify: `web/tests/browser-build.test.mjs` (add DOS case)

- [ ] **Step 1: Write failing test for DOS path**

Append to `browser-build.test.mjs`:

```js
test('builds a DOS cart (bootle) into a Blob', async () => {
  // tests/bcd.com is hack; we need a tiny .com that boots under DOS.
  // Use carts/bootle/bootle.com (program), and have the browser builder
  // pull KERNEL.SYS + COMMAND.COM from /assets/dos/ (fetch).
  const comBytes = new Uint8Array(readFileSync(resolve(repoRoot, 'carts', 'bootle', 'bootle.com')));
  const blob = await buildCabinetInBrowser({
    preset: 'dos-muslin',
    bios: 'muslin',
    programBytes: comBytes,
    programName: 'BOOTLE.COM',
    autorun: 'BOOTLE.COM',
  });
  assert.ok(blob instanceof Blob);
  assert.ok(blob.size > 100_000_000, `cabinet small: ${blob.size}`);
});
```

- [ ] **Step 2: Decide where kernel.sys and command.com are fetched from**

Two options:
- **A.** Ship `dos/bin/kernel.sys` and `dos/bin/command.com` as static assets under `/assets/dos/`. Builder fetches them. Simple.
- **B.** User uploads them too. Awful UX.

Pick **A**. Add copy step to `web/scripts/sync-player.mjs` later.

- [ ] **Step 3: Extend main.mjs for DOS path**

Add DOS branch:

```js
if (preset.startsWith('dos-')) {
  const kernelRes = await fetch('/assets/dos/kernel.sys');
  const kernelBytes = [...new Uint8Array(await kernelRes.arrayBuffer())];

  const commandRes = await fetch('/assets/dos/command.com');
  const commandBytes = [...new Uint8Array(await commandRes.arrayBuffer())];

  const autorun = options.autorun ?? programName.toUpperCase();
  const configContent = `SHELL=\\${autorun}\n`;

  const floppy = buildFloppyInBrowser({
    preset, manifest: {
      disk: { files: [
        { name: 'KERNEL.SYS', bytes: new Uint8Array(kernelBytes) },
        { name: 'CONFIG.SYS', bytes: new TextEncoder().encode(configContent) },
        { name: autorun, bytes: programBytes },
        { name: 'COMMAND.COM', bytes: new Uint8Array(commandBytes) },
      ] },
    }, cart: null,
  });

  const KERNEL_LINEAR = 0x600;
  const memBytes = resolveMemorySize(userManifest.memory?.conventional ?? '640K');
  const prune = { gfx: userManifest.memory?.gfx === false, textVga: userManifest.memory?.textVga === false };
  const memoryZones = dosMemoryZones(kernelBytes, KERNEL_LINEAR, memBytes, [], prune);

  emitCSS({
    programBytes: kernelBytes, biosBytes: bios.bytes,
    memoryZones, embeddedData: [], diskBytes: floppy.bytes,
    programOffset: KERNEL_LINEAR,
    initialCS: bios.entrySegment, initialIP: bios.entryOffset,
    initialRegs: { SP: 0 }, header,
  }, writer);
}
```

- [ ] **Step 4: Copy DOS binaries to site/assets/**

Add to `web/scripts/sync-player.mjs` (or a new script):

```js
// Copy dos/bin/{kernel.sys,command.com} → web/site/assets/dos/
```

Run it manually for now.

- [ ] **Step 5: Run test**

Run: `node --test web/tests/browser-build.test.mjs`
Expected: pass. Cabinet is large (~450 MB).

This may take tens of seconds. That's expected.

- [ ] **Step 6: Commit**

```bash
git add web/browser-builder/main.mjs web/tests/browser-build.test.mjs web/scripts/
git commit -m "web: browser builder supports DOS preset with fetched kernel/command"
```

---

### Task 10: Cache Storage wrapper

**Files:**
- Create: `web/browser-builder/storage.mjs`
- Create: `web/tests/storage.test.mjs` (skipped in Node; runs via browser test page)

- [ ] **Step 1: Implement storage module**

```js
// web/browser-builder/storage.mjs
const CACHE_NAME = 'cssdos-cabinets-v1';
const CURRENT_URL = '/cabinet.css';

export async function saveCabinet(blob, url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  const response = new Response(blob, {
    headers: { 'Content-Type': 'text/css', 'Content-Length': String(blob.size) },
  });
  await cache.put(url, response);
  return url;
}

export async function hasCabinet(url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  return hit != null;
}

export async function getCabinet(url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(url);
}

export async function deleteCabinet(url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  return cache.delete(url);
}
```

- [ ] **Step 2: Write a browser-based test page**

Create `web/tests/storage-browser-test.html`:

```html
<!DOCTYPE html>
<title>storage.mjs manual test</title>
<script type="module">
import { saveCabinet, hasCabinet, getCabinet, deleteCabinet } from '../browser-builder/storage.mjs';

const results = document.body;
function log(msg, pass) {
  const p = document.createElement('p');
  p.textContent = (pass ? 'PASS: ' : 'FAIL: ') + msg;
  p.style.color = pass ? 'green' : 'red';
  results.appendChild(p);
}

async function run() {
  await deleteCabinet();
  log('initial hasCabinet is false', !(await hasCabinet()));
  const b = new Blob(['.foo { color: red; }'], { type: 'text/css' });
  await saveCabinet(b);
  log('after save, hasCabinet is true', await hasCabinet());
  const r = await getCabinet();
  log('retrieved response is ok', r && r.ok);
  const text = await r.text();
  log('retrieved content matches', text === '.foo { color: red; }');
  await deleteCabinet();
  log('after delete, hasCabinet is false', !(await hasCabinet()));
}
run();
</script>
```

Run via the dev server (Task 14): open `localhost:XXXX/tests/storage-browser-test.html`, visually confirm all PASS.

- [ ] **Step 3: Commit**

```bash
git add web/browser-builder/storage.mjs web/tests/storage-browser-test.html
git commit -m "web: Cache Storage wrapper for assembled cabinets"
```

---

### Task 11: Service worker

**Files:**
- Create: `web/site/sw.js`
- Modify: registration snippet in `web/site/index.html`, `web/site/build.html`

- [ ] **Step 1: Implement sw.js**

```js
// web/site/sw.js
// Intercepts /cabinet.css and serves it from Cache Storage.
// Everything else passes through to the network.

const CACHE_NAME = 'cssdos-cabinets-v1';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only intercept same-origin requests to /cabinet.css
  if (url.origin === self.location.origin && url.pathname === '/cabinet.css') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const hit = await cache.match('/cabinet.css');
        if (hit) return hit;
        return new Response('/* no cabinet in cache */', {
          status: 404, headers: { 'Content-Type': 'text/css' },
        });
      }),
    );
  }
  // else: no event.respondWith — default network fetch.
});
```

- [ ] **Step 2: Register SW from index.html and build.html**

In the `<head>`:

```html
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' });
  }
</script>
```

- [ ] **Step 3: Manual test**

- Open `/build.html`, run a build that calls `saveCabinet` (Task 12 wires this; until then, simulate with devtools console).
- Navigate to `/play.html`.
- Open DevTools Network: should see `cabinet.css` served "from ServiceWorker".
- View source of `play.html`: should have no `<script>` tag.

- [ ] **Step 4: Commit**

```bash
git add web/site/sw.js web/site/index.html web/site/build.html
git commit -m "web: service worker serves cabinets from Cache Storage"
```

---

### Task 12: Build UI (build.html)

**Files:**
- Create: `web/site/build.html`
- Create: `web/site/assets/build.js`
- Create: `web/site/assets/site.css`

- [ ] **Step 1: HTML skeleton**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CSS-DOS · build</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <header><h1>CSS-DOS builder</h1></header>
  <main>
    <section id="upload">
      <h2>1. Pick your program</h2>
      <input type="file" id="com-file" accept=".com">
      <label>Preset:
        <select id="preset">
          <option value="hack">hack (.com direct)</option>
          <option value="dos-muslin">DOS + Muslin BIOS</option>
        </select>
      </label>
      <button id="start">Build cabinet</button>
    </section>
    <section id="progress" hidden>
      <h2>2. Assembling your cabinet</h2>
      <ol id="stages"></ol>
      <pre id="log"></pre>
    </section>
    <section id="result" hidden>
      <h2>3. Your cabinet is ready</h2>
      <p id="size"></p>
      <a id="play-link" href="/play.html">Play (JS-free)</a>
      <a id="turbo-link" href="/turbo.html">Play (turbo)</a>
      <a id="download" download="cabinet.css">Download .css</a>
    </section>
  </main>
  <script>
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' });
  </script>
  <script type="module" src="/assets/build.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement build.js**

```js
// web/site/assets/build.js
import { buildCabinetInBrowser } from '/browser-builder/main.mjs';
import { saveCabinet } from '/browser-builder/storage.mjs';

const $ = (id) => document.getElementById(id);

$('start').addEventListener('click', async () => {
  const file = $('com-file').files[0];
  if (!file) { alert('pick a .com first'); return; }

  $('progress').hidden = false;
  const stages = $('stages');
  stages.innerHTML = '';
  const log = $('log');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const preset = $('preset').value;

  const blob = await buildCabinetInBrowser({
    preset,
    bios: preset === 'hack' ? 'gossamer' : 'muslin',
    programBytes: bytes,
    programName: file.name,
    autorun: file.name.toUpperCase(),
    onProgress: ({ stage, message }) => {
      const li = document.createElement('li');
      li.textContent = message;
      stages.appendChild(li);
      log.textContent += message + '\n';
    },
  });

  await saveCabinet(blob);

  $('result').hidden = false;
  $('size').textContent = `${(blob.size / 1024 / 1024).toFixed(1)} MB`;
  $('download').href = URL.createObjectURL(blob);
});
```

- [ ] **Step 3: site.css**

DOS-beige / Win95 look. Copied / adapted from `calcite/web/index.html` (lines 57-275). Buttons, panels, group boxes.

- [ ] **Step 4: Manual test via dev server (Task 14)**

Open `localhost:XXXX/build.html`, pick `tests/bcd.com`, preset=hack, click Build. Watch progress. On finish, click "Play (JS-free)". Cabinet runs.

- [ ] **Step 5: Commit**

```bash
git add web/site/build.html web/site/assets/build.js web/site/assets/site.css
git commit -m "web: build.html — pick program, build, save to cache, play"
```

---

### Task 13: Player HTML pages

**Files:**
- Create: `player/play.html` (replaces current `player/index.html`)
- Create: `player/turbo.html`
- Create: `player/meter.html`
- Create: `player/turbo-meter.html`
- Create: `player/assets/player.css`
- Create: `player/assets/turbo.js`
- Create: `player/assets/meter.js`
- Delete: `player/index.html` (old JS-driven version — replaced by play.html)
- Modify: `player/README.md`

- [ ] **Step 1: play.html (JS-free)**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CSS-DOS player</title>
  <link rel="stylesheet" href="/assets/player.css">
  <link rel="stylesheet" href="/cabinet.css">
</head>
<body>
  <div class="clock">
    <div class="cpu">
      <div class="screen"></div>
      <key-board>
        <!-- 45 buttons in KEYBOARD_KEYS order from kiln/template.mjs -->
        <button>0</button><button>1</button><button>2</button><button>3</button><button>4</button>
        <button>5</button><button>6</button><button>7</button><button>8</button><button>9</button>
        <button>Q</button><button>W</button><button>E</button><button>R</button><button>T</button>
        <button>Y</button><button>U</button><button>I</button><button>O</button><button>P</button>
        <button>A</button><button>S</button><button>D</button><button>F</button><button>G</button>
        <button>H</button><button>J</button><button>K</button><button>L</button>
        <button class="kb-enter">&#8629;</button>
        <button>Z</button><button>X</button><button>C</button><button>V</button><button>B</button>
        <button>N</button><button>M</button>
        <button class="kb-space">&#9251;</button>
        <button>Esc</button>
        <button class="kb-arrow kb-left">&#8592;</button>
        <button class="kb-arrow kb-down">&#8595;</button>
        <button class="kb-arrow kb-up">&#8593;</button>
        <button class="kb-arrow kb-right">&#8594;</button>
        <button>Tab</button><button>Bksp</button>
      </key-board>
    </div>
  </div>
</body>
</html>
```

Verify button count matches `KEYBOARD_KEYS.length` in `kiln/template.mjs`. As of writing that's 45 — if it differs, adjust.

- [ ] **Step 2: player.css (keyboard grid from calcite/web)**

Use CSS Grid with `grid-column` / `grid-row` on specific `nth-child(N)` selectors to reproduce calcite's layout WITHOUT nesting divs. Something like:

```css
key-board {
  display: grid;
  grid-template-columns: repeat(13, 1fr);
  grid-template-rows: repeat(5, 34px);
  gap: 2px;
  max-width: 720px;
}
key-board > button {
  background: #c0c0c0;
  border-top: 2px solid #fff;
  border-left: 2px solid #fff;
  border-right: 2px solid #808080;
  border-bottom: 2px solid #808080;
  font: 13px monospace;
}
key-board > button:active {
  border-top-color: #808080;
  border-left-color: #808080;
  border-right-color: #fff;
  border-bottom-color: #fff;
}
/* nth-child positioning: main block in columns 1-10, right stack in 11-13. */
key-board > button:nth-child(n+1):nth-child(-n+10) { /* digits */ grid-row: 1; }
/* ... repeat for each row — see calcite/web/index.html:158-238 for the pattern ... */
key-board > .kb-enter { background: #d8c898; }
key-board > .kb-space { grid-column: 1 / span 10; }
```

Exact grid positions determined during implementation by reading `KEYBOARD_KEYS` from `kiln/template.mjs` and assigning a `grid-area` per index.

- [ ] **Step 3: Verify keyboard still drives --keyboard**

Open `play.html` with a cabinet loaded. In devtools, click buttons, check computed `--keyboard` value changes.

- [ ] **Step 4: turbo.html**

Copy play.html, add right before `</body>`:

```html
<script src="/assets/turbo.js"></script>
```

- [ ] **Step 5: Implement turbo.js**

```js
// ~15 lines. Accelerate the clock via rAF.
(function() {
  const clock = document.querySelector('.clock');
  const cpu = document.querySelector('.cpu');
  let tick = 0;
  function step() {
    for (let i = 0; i < 4; i++) {
      clock.style.setProperty('--clock', tick, 'important');
      tick = (tick + 1) % 4;
      getComputedStyle(cpu).getPropertyValue('--__1IP');
    }
    const halt = parseInt(getComputedStyle(cpu).getPropertyValue('--__1halt') || '0');
    if (halt) return;
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
})();
```

- [ ] **Step 6: meter.html + meter.js**

```js
// ~15 lines. Sample cycleCount twice per second, display Hz.
(function() {
  const cpu = document.querySelector('.cpu');
  const el = document.createElement('div');
  el.style = 'position:fixed;top:4px;right:4px;background:#000;color:#0f0;padding:4px;font:12px monospace;';
  document.body.appendChild(el);
  let last = parseInt(getComputedStyle(cpu).getPropertyValue('--__1cycleCount') || '0');
  let lastT = performance.now();
  setInterval(() => {
    const now = parseInt(getComputedStyle(cpu).getPropertyValue('--__1cycleCount') || '0');
    const t = performance.now();
    const hz = (now - last) * 1000 / (t - lastT);
    last = now; lastT = t;
    if (hz >= 1e6) el.textContent = (hz/1e6).toFixed(2) + ' MHz';
    else if (hz >= 1e3) el.textContent = (hz/1e3).toFixed(1) + ' KHz';
    else el.textContent = Math.round(hz) + ' Hz';
  }, 1000);
})();
```

meter.html = play.html + `<script src="/assets/meter.js"></script>`.

- [ ] **Step 7: turbo-meter.html**

play.html + both scripts.

- [ ] **Step 8: Delete old index.html**

```bash
git rm player/index.html
```

- [ ] **Step 9: Update player/README.md**

Describe the four variants; link back to `docs/web.md`.

- [ ] **Step 10: Commit**

```bash
git add player/ -A
git commit -m "player: four HTML variants (play, turbo, meter, turbo-meter)"
```

---

### Task 14: Dev server

**Files:**
- Create: `web/scripts/dev.mjs`

- [ ] **Step 1: Implement a minimal HTTP server**

```js
#!/usr/bin/env node
// Serves web/site/ with:
// - /prebake/* aliased to web/prebake/
// - /browser-builder/* aliased to web/browser-builder/
// - /kiln/, /builder/, /tools/ aliased to their repo counterparts
// - /assets/dos/ aliased to dos/bin/
// - gzip on .css
// - no caching (for dev)

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const siteRoot = resolve(__dirname, '..', 'site');

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.json': 'application/json',
  '.bin':  'application/octet-stream',
};

const ALIASES = [
  ['/prebake/',         resolve(__dirname, '..', 'prebake')],
  ['/browser-builder/', resolve(__dirname, '..', 'browser-builder')],
  ['/kiln/',            resolve(repoRoot, 'kiln')],
  ['/builder/',         resolve(repoRoot, 'builder')],
  ['/tools/',           resolve(repoRoot, 'tools')],
  ['/assets/dos/',      resolve(repoRoot, 'dos', 'bin')],
  ['/tests/',           resolve(__dirname, '..', 'tests')],
];

function resolvePath(urlPath) {
  for (const [prefix, dir] of ALIASES) {
    if (urlPath.startsWith(prefix)) {
      return join(dir, urlPath.slice(prefix.length));
    }
  }
  return join(siteRoot, urlPath === '/' ? '/index.html' : urlPath);
}

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file;
  try { file = resolvePath(path); statSync(file); } catch { res.statusCode = 404; return res.end('not found'); }
  const ext = extname(file);
  const type = MIME[ext] ?? 'application/octet-stream';
  const bytes = readFileSync(file);

  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  const shouldGzip = acceptsGzip && (ext === '.css' || ext === '.mjs' || ext === '.js');

  const body = shouldGzip ? gzipSync(bytes) : bytes;
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    ...(shouldGzip && { 'Content-Encoding': 'gzip' }),
  });
  res.end(body);
});

const port = Number(process.env.PORT) || 5173;
server.listen(port, () => console.log(`web dev server: http://localhost:${port}/`));
```

- [ ] **Step 2: Run it**

```bash
node web/scripts/dev.mjs
```

Open `http://localhost:5173/`. Should see the landing page (stub for now).

- [ ] **Step 3: Commit**

```bash
git add web/scripts/dev.mjs
git commit -m "web: dev server with path aliases and gzip"
```

---

### Task 15: Landing page + gallery (minimal)

**Files:**
- Create: `web/site/index.html`
- Create: `web/site/assets/landing.js`

- [ ] **Step 1: Minimal landing page**

```html
<!DOCTYPE html>
<title>CSS-DOS</title>
<link rel="stylesheet" href="/assets/site.css">
<main>
  <h1>CSS-DOS</h1>
  <p>A complete Intel 8086 PC implemented in pure CSS. The CSS runs in Chrome — no JavaScript, no WebAssembly.</p>
  <p><a href="/build.html">Build your own cabinet from a .com file</a></p>
  <h2>Examples</h2>
  <ul id="gallery"><!-- populated by landing.js --></ul>
  <script>
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' });
  </script>
  <script type="module" src="/assets/landing.js"></script>
</main>
```

- [ ] **Step 2: Gallery loader**

```js
// web/site/assets/landing.js — loads pre-built cabinets from /gallery/manifest.json
const res = await fetch('/gallery/manifest.json');
if (res.ok) {
  const { cabinets } = await res.json();
  const ul = document.getElementById('gallery');
  for (const c of cabinets) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/gallery-load.html?name=${encodeURIComponent(c.name)}`;
    a.textContent = `${c.name} (${c.size})`;
    li.appendChild(a);
    ul.appendChild(li);
  }
}
```

- [ ] **Step 3: Gallery loader page (stub)**

`web/site/gallery-load.html` — fetches the named cabinet from `/gallery/`, writes to Cache Storage, redirects to `/play.html`. (Could also inline this into `landing.js` on click.)

For v1, ship the gallery empty or with one small cabinet (bcd) to prove the plumbing.

- [ ] **Step 4: Commit**

```bash
git add web/site/ -A
git commit -m "web: landing page + gallery loader (minimal)"
```

---

### Task 16: Deploy config + README

**Files:**
- Create: `web/vercel.json`
- Create: `web/README.md`

- [ ] **Step 1: vercel.json**

```json
{
  "cleanUrls": true,
  "headers": [
    {
      "source": "/(.*)\\.(css|mjs|js|json)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    },
    {
      "source": "/(play|turbo|meter|turbo-meter)\\.html",
      "headers": [{ "key": "Content-Security-Policy", "value": "script-src 'self'; style-src 'self' 'unsafe-inline'" }]
    }
  ]
}
```

Vercel gzips automatically; no config needed for that.

- [ ] **Step 2: web/README.md**

Explain: how to run locally (`node web/scripts/dev.mjs`), how to refresh prebakes (`node web/scripts/prebake.mjs`), how to deploy (push to Vercel). Link to `docs/web.md` for architecture.

- [ ] **Step 3: Commit**

```bash
git add web/vercel.json web/README.md
git commit -m "web: Vercel deploy config and README"
```

---

### Task 17: Integration test — deploy and load a real cabinet

**Files:**
- None (manual verification + logbook entry)

- [ ] **Step 1: Deploy to Vercel**

- Connect repo, deploy from branch.
- Deployment URL: something like `css-dos.vercel.app`.

- [ ] **Step 2: Golden-path manual test**

1. Open `css-dos.vercel.app/`
2. Click "Build your own cabinet".
3. Upload `tests/bcd.com`, preset = hack, click Build.
4. Wait for build (expect ~few seconds for bcd, up to a minute for larger programs).
5. Click "Play (JS-free)". Cabinet loads. View-source: no `<script>` on the player page.
6. Go back, Click "Play (turbo)". Faster ticking.

- [ ] **Step 3: If the 450 MB DOS cabinet test (Task 9) didn't pass in headless Node, retry it in a real browser here**

If Chrome OOMs or freezes on a real DOS cabinet: roll back to hack-only for v1, log this as a Phase 2 follow-up ("make the DOS path work over the wire").

- [ ] **Step 4: Update docs**

- Add logbook entry describing the deploy and what works / doesn't.
- Update `docs/web.md`'s "Deferred" section to remove the parse-time question (now answered by actual deploy).

- [ ] **Step 5: Commit docs**

```bash
git add docs/
git commit -m "logbook: web version v1 deployed to Vercel"
```

---

### Task 18: Wire docs and CLAUDE.md

**Files:**
- Modify: `docs/INDEX.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update docs/INDEX.md**

Add a "Web version" row under "Building and running":

```
| [`web.md`](web.md) | The in-browser frontend. Upload a .com, build in the browser, play in a JS-free page. |
```

- [ ] **Step 2: Update CLAUDE.md Quick orientation**

Add bullet:

```
- **Web version:** `web/` — in-browser builder + static site. See [`docs/web.md`](docs/web.md).
```

- [ ] **Step 3: Update CHANGELOG.md**

Add entry describing the web version.

- [ ] **Step 4: Commit**

```bash
git add docs/INDEX.md CLAUDE.md CHANGELOG.md
git commit -m "docs: link to web version from INDEX and CLAUDE"
```

---

### Task 19: Clean up audit plan

**Files:**
- Delete: `docs/plans/2026-04-18-web-version-audit.md`

- [ ] **Step 1: Confirm all audit items are resolved**

Read the audit doc. Every item should be either "done" or explicitly moved to Phase 2.

- [ ] **Step 2: Delete**

```bash
git rm docs/plans/2026-04-18-web-version-audit.md
git commit -m "plan: remove transient audit plan (resolved)"
```

---

## Phase 2 — deferred (no step-by-step)

From `docs/web.md`'s deferred list. Each becomes its own short plan when it's time.

- **Streaming Blob construction** — if Kiln's intermediate string accumulation causes browser OOM on large cabinets, refactor to stream into the BlobWriter at the per-line level. Kiln's `emit-css.mjs` already uses `writeStream.write(s + '\n\n')` so the transport is streamable; only opcode dispatch tables may accumulate. Investigate once.
- **Advanced config panel** on build.html — memory size, prune gfx / textVga, BIOS flavour, initial registers.
- **User library (IndexedDB)** — named builds, list them on landing page.
- **Download as .zip** — `play.html` + `cabinet.css` packaged for offline play. ~10 KB browser zip library.
- **Gallery content** — pick 5-10 cabinets, pre-build them, ship in `/gallery/`.
- **Corduroy BIOS** — prebake it like Muslin once its source stabilises (`bios/corduroy/build.mjs` is multi-step, needs its own prebake handler).
- **Calcite handoff** — "Open in calcite" button that hands the Blob to calcite's web frontend.
- **CI for prebakes** — fail PRs where `.asm` sources are modified without refreshing `web/prebake/` (verify via `sourceHash`).

---

## Self-review

Checked:

- **Spec coverage.** Every goal in `docs/web.md` is addressed:
  - JS-free player page (Task 13)
  - In-browser build (Tasks 5-9)
  - No backend (Tasks 10-11, 16)
  - Shared source (Tasks 3-4)
  - Repo layout (Tasks 1-18, laid out incrementally)
- **Clock animation.** Task 1.
- **Turbo / meter.** Task 13.
- **Keyboard.** Task 13.
- **Storage.** Tasks 10-11.
- **Pre-bake pipeline.** Tasks 6-7.
- **Docs.** Task 18, 19.
- **Deferred.** Phase 2 section.

- **Placeholders.** None intentionally; if the audit in Task 2 finds more Node-isms than anticipated, Task 3 may grow — that's an implementation-time observation, not a plan defect.
- **Type consistency.** `loadPrebakedBios` returns `{ bytes, entrySegment, entryOffset, meta }`, matching `buildBios`'s Node return type, so both callers into Kiln are interchangeable. `buildFat12Image(files)` takes `[{name, bytes}]` consistently in Tasks 4, 8, 9. `BlobWriter.write(str)` / `.finish()` / `.bytesWritten` used consistently.
- **Execution order.** Tasks 1-4 are independent of the browser; 5 is a pure new module; 6-7 set up prebakes; 8-9 wire the builder; 10-13 produce the user-facing site; 14-17 deploy and validate; 18-19 clean up.

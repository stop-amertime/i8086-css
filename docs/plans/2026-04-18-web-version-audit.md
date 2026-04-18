# Web-version Node API audit

> **Status:** Task 2 of Phase 1 (web-version plan). Delete this file when
> Phase 1 is complete.

Audit of Node-only API call sites in `kiln/`, `builder/lib/`, and
`tools/mkfat12.mjs`. The goal is to know what must change before these
files can run in a browser.

---

## Summary

| Category | Count | Meaning |
|---|---|---|
| A — move to adapter | 4 | I/O call sites inside shared code; refactor to accept bytes as argument |
| B — shim | 3 | Small Node builtins with direct browser equivalents; apply globally |
| C — leave alone | 25+ | Node-only orchestration code (`builder/build.mjs`, `builder/stages/`, `builder/lib/cart.mjs`) that is never imported by Kiln |
| Misc | 1 | `mkfat12.mjs` CLI wrapper (process.argv / process.exit); leave in Node or split |

**Kiln itself (`kiln/*.mjs`, `kiln/patterns/*.mjs`) is 100% clean** — zero
Node imports. All Node API usage lives in `builder/` and `tools/mkfat12.mjs`.

**Top 3 files with the most Node-isms:**

1. `builder/stages/floppy.mjs` — fs (read/write/exist/mkdir), child\_process
   (execSync to shell out to `mkfat12.mjs`), path, import.meta.url
2. `builder/stages/bios.mjs` — fs (read/exist), child\_process (execSync /
   execFileSync to run NASM), path, import.meta.url, process.env
3. `builder/lib/cart.mjs` — fs (read/readdir/stat/exist/mkdtemp),
   child\_process (execFileSync to run `tar`), path, os

---

## `kiln/` — all files

No Node API usage found in any file under `kiln/` or `kiln/patterns/`.
`emitCSS()` accepts a `writeStream`-shaped object (anything with a `.write()`
method); the Node `fs.WriteStream` is injected by the caller
(`builder/stages/kiln.mjs`), not created inside Kiln. No action needed for
the web port — Kiln's own code is already browser-compatible.

---

## `tools/mkfat12.mjs`

### tools/mkfat12.mjs:19
Call: `import { readFileSync, writeFileSync } from 'fs'`  
Purpose: reads each input file from disk; writes the finished disk image.  
Category: **A — move to adapter**  
Fix: extract the FAT12-building logic into a pure function
`buildFat12Image(files: Array<{name, data: Uint8Array}>) → Uint8Array`.
Move the file-read / file-write I/O into a thin Node CLI wrapper.
The browser adapter (`web/browser-builder/floppy-adapter.mjs`) calls the
pure function directly with in-memory byte arrays.

### tools/mkfat12.mjs:20
Call: `import { resolve } from 'path'`  
Purpose: used only to resolve input/output file paths from CLI arguments.  
Category: **C — leave in Node-only code** (after the A refactor above, path
resolution is only needed in the CLI wrapper, not in the pure function).

### tools/mkfat12.mjs:30, 47, 201, 227, 244, 256, 261
Calls: `process.argv.slice(2)`, `process.exit(1)` (×6)  
Purpose: CLI argument parsing and fatal-error exit — all in the script-level
top-of-file code that drives the CLI.  
Category: **C — leave in Node-only code** (these belong in the CLI wrapper,
not in the extracted pure function).

---

## `builder/lib/config.mjs`

### builder/lib/config.mjs:3-5
Calls: `import { readFileSync, existsSync } from 'node:fs'`; `import { dirname, join } from 'node:path'`; `import { fileURLToPath } from 'node:url'`  
Purpose: reads `builder/presets/*.json` files from disk to merge with a cart
manifest. `__dirname` is reconstructed from `import.meta.url` so the preset
directory can be located relative to the source file.  
Category: **A — move to adapter**  
Fix: pass the preset JSON objects as an argument (or a `loadPreset(name)`
callback) instead of reading files inside `resolveManifest()`. The caller
(`builder/build.mjs` on Node; `web/browser-builder/main.mjs` in the browser)
supplies the preset data — fetched from `web/prebake/` or bundled as a JSON
import. The `import.meta.url` + `path.join` idiom for locating sibling files
disappears entirely once presets are injected.

### builder/lib/config.mjs:7-8
Calls: `const __dirname = dirname(fileURLToPath(import.meta.url))`  
Purpose: locates `PRESETS_DIR` relative to the source file.  
Category: **B — shim** (see note below on `import.meta.url`).

---

## `builder/lib/cart.mjs`

All of this file is Node-only orchestration. It resolves filesystem paths,
stats files, reads directory listings, reads file bytes, and unzips archives
via `tar`. Nothing in `kiln/` imports it; only `builder/build.mjs` does.

Category: **C — leave in Node-only code** for all call sites.

### builder/lib/cart.mjs:9-12 (for the record)
```
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
```
The browser path has no concept of a cart folder — the user uploads individual
files via `<input type="file">`. A separate `web/browser-builder/cart-adapter.mjs`
will handle `FileList` → in-memory cart without touching this file.

### builder/lib/sizes.mjs
No Node APIs. Pure computation. Browser-safe as-is.

---

## `builder/stages/bios.mjs` — C

Category: **C — leave in Node-only code**  
Reason: this stage shells out to NASM and reads the assembled binary. In the
browser, BIOS binaries are pre-assembled and committed as `.bin` files under
`web/prebake/`. The browser uses `web/browser-builder/prebake-loader.mjs`
(a `fetch()` wrapper) instead of this stage.

Notable call sites (for completeness):
- `readFileSync` / `existsSync` — reads `gossamer.bin` and assembled BIOS `.bin` files
- `execSync` / `execFileSync` — runs NASM (`node:child_process`)
- `process.env.NASM` — reads NASM path from environment

---

## `builder/stages/floppy.mjs` — C (mostly) + A (indirectly)

Category: **C — leave in Node-only code** for the stage itself  
Reason: the floppy stage shells out to `tools/mkfat12.mjs` via `execSync`.
In the browser, this stage is replaced by `web/browser-builder/floppy-adapter.mjs`
which calls the extracted pure-function core of `mkfat12.mjs` directly in-process.

The indirect dependency on `mkfat12.mjs` means the **A** refactor of
`mkfat12.mjs` (pure function extraction) is a prerequisite.

Notable call sites:
- `readFileSync` / `writeFileSync` / `existsSync` / `mkdirSync` — reading cart files and writing the temp disk image
- `execSync` — shells out to `node tools/mkfat12.mjs`
- `path` + `import.meta.url` — locating repo root

---

## `builder/stages/kiln.mjs` — mixed (A + C)

This is the only builder stage that directly imports from `kiln/`. It does two
things: (1) reads binary files from disk using Node `fs`, (2) calls
`emitCSS()` from Kiln with the bytes and a `writeStream`.

### builder/stages/kiln.mjs:6-8
```
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
```
Purpose: reads `dos/bin/kernel.sys` and (for hack carts) the `.COM` file from
disk before calling into Kiln.  
Category: **A — move to adapter**  
Fix: `runKiln()` should accept `kernelBytes` and `programBytes` as pre-read
`Uint8Array` / plain arrays, not load them itself. The Node caller
(`builder/build.mjs`) reads the files and passes bytes in. The browser caller
(`web/browser-builder/main.mjs`) gets bytes from the uploaded files or from
`fetch()`.

After this refactor, `builder/stages/kiln.mjs` may be left as a thin Node-side
wrapper, or it can be turned into a pure function that Kiln's web adapter also
uses.

---

## Miscellaneous findings

### `import.meta.url` pattern (B — shim, apply globally)

`builder/lib/config.mjs` and `builder/stages/bios.mjs`, `floppy.mjs`,
`kiln.mjs` all use the idiom:

```js
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
```

This pattern is Node-specific (`fileURLToPath` is from `node:url`, and
`import.meta.url` behaves differently under bundlers). All four files use it
only to locate sibling files on disk — something that disappears once the I/O
is pushed to callers (category A). No special shim is needed; it vanishes as a
side-effect of the A fixes.

### `Buffer` — not present

No `Buffer.from`, `Buffer.alloc`, or `Buffer.concat` anywhere in the scanned
files. `mkfat12.mjs` uses `Uint8Array` directly (already browser-compatible).
No shim needed.

### `path.join` / `path.resolve` — B (shim, but only needed where it survives A)

`node:path` is imported in `builder/lib/cart.mjs` and all three builder
stages. After the A refactors (push I/O to callers), the only remaining
`path` usage will be in Node-only orchestrators — no browser shim required.
If any path manipulation survives into shared code, replace with string
template literals (e.g., `` `${dir}/${file}` ``).

---

## Action summary for Task 3

| # | File | What to do |
|---|---|---|
| 1 | `tools/mkfat12.mjs` | Extract `buildFat12Image(files)` pure function; leave CLI shell as Node wrapper |
| 2 | `builder/lib/config.mjs` | Add `presets` parameter to `resolveManifest()`; callers supply preset JSON |
| 3 | `builder/stages/kiln.mjs` | Add `kernelBytes` / `programBytes` parameters to `runKilnDos` / `runKilnHack`; remove `readFileSync` calls from the function |
| 4 | `kiln/` (all files) | No changes needed — already browser-compatible |
| 5 | `builder/lib/cart.mjs` | No changes needed — replaced entirely by browser-side `FileList` handling |
| 6 | `builder/stages/bios.mjs` | No changes needed — replaced by `prebake-loader.mjs` in browser |
| 7 | `builder/stages/floppy.mjs` | No changes needed — replaced by `floppy-adapter.mjs` in browser |

#!/usr/bin/env node
// Serves web/site/ with:
// - /prebake/* aliased to web/prebake/
// - /browser-builder/* aliased to web/browser-builder/
// - /kiln/, /builder/, /tools/ aliased to their repo counterparts
// - /assets/dos/ aliased to dos/bin/
// - /player/ aliased to the repo's player/
// - gzip on .css/.js/.mjs
// - no caching (for dev)

import { createServer } from 'node:http';
import { readFileSync, statSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const siteRoot = resolve(__dirname, '..', 'site');

// CALCITE_REPO: override path to the calcite sibling repo. Defaults to
// `../calcite` from the CSS-DOS repo root. Set this when running from a
// git worktree whose calcite lives somewhere other than the default
// sibling location (e.g. CSS-DOS/.claude/worktrees/3slot expects calcite
// at .../worktrees/calcite by default — set CALCITE_REPO to point at the
// real calcite worktree).
const calciteRoot = process.env.CALCITE_REPO
  ? resolve(process.env.CALCITE_REPO)
  : resolve(repoRoot, '..', 'calcite');

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.json': 'application/json',
  '.bin':  'application/octet-stream',
  '.wasm': 'application/wasm',
};

const ALIASES = [
  ['/prebake/',         resolve(__dirname, '..', 'prebake')],
  ['/browser-builder/', resolve(__dirname, '..', 'browser-builder')],
  ['/kiln/',            resolve(repoRoot, 'kiln')],
  ['/builder/',         resolve(repoRoot, 'builder')],
  ['/tools/',           resolve(repoRoot, 'tools')],
  ['/assets/dos/',      resolve(repoRoot, 'dos', 'bin')],
  ['/player/',          resolve(repoRoot, 'player')],
  ['/presets/',         resolve(repoRoot, 'builder', 'presets')],
  ['/calcite/',         resolve(calciteRoot, 'web')],
  ['/tests/',           resolve(__dirname, '..', 'tests')],
  ['/tmp/',             resolve(repoRoot, 'tmp')],
  ['/bench-assets/',    resolve(calciteRoot, 'programs')],
  ['/carts/',           resolve(repoRoot, 'carts')],
];

const cartsDir = resolve(repoRoot, 'carts');

const ALLOWED_ROOTS = [siteRoot, ...ALIASES.map(([, dir]) => dir)];

// --- Dev endpoints (/_status, /_reset, /_clear) --------------------------
//
// Purpose: kill the cache-layer gotchas. The player can be running against
// any of: a stale calcite WASM (pkg/calcite_wasm_bg.wasm), a stale prebaked
// BIOS binary (web/prebake/*.bin), a cached cabinet in Cache Storage, a
// registered service worker from a previous session, or the browser's HTTP
// module cache. When calcite and CSS-DOS evolve in lockstep this matters
// a lot — see VSYNC-PLAN session / the 2026-04-20 investigation.
//
// /_status  → JSON snapshot of what the server is currently serving
// /_reset   → wipe WASM + prebake, rebuild both from HEAD
// /_clear   → tiny HTML page that purges browser-side state and reloads
//
// The clearing of browser state is done on the client because there's no
// way to do it from the server; the page just runs the standard SW +
// Cache Storage unregister + nuke idiom.

const wasmPkgDir  = resolve(calciteRoot, 'web', 'pkg');
const prebakeDir  = resolve(repoRoot, 'web', 'prebake');
const calciteWasmCrate = resolve(calciteRoot, 'crates', 'calcite-wasm');

function gitHead(repoDir) {
  const r = spawnSync('git', ['-C', repoDir, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : `(git failed: ${r.stderr?.trim() || 'unknown'})`;
}

function fileInfo(path) {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  const hash = createHash('md5').update(readFileSync(path)).digest('hex').slice(0, 16);
  return { bytes: st.size, mtime: st.mtime.toISOString(), md5: hash };
}

function dirFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => !f.startsWith('.') && !f.endsWith('.d.ts'));
}

function statusSnapshot() {
  return {
    cssDosCommit: gitHead(repoRoot),
    calciteCommit: gitHead(calciteRoot),
    wasm: fileInfo(resolve(wasmPkgDir, 'calcite_wasm_bg.wasm')),
    wasmPkgFiles: dirFiles(wasmPkgDir),
    prebake: {
      corduroyBin: fileInfo(resolve(prebakeDir, 'corduroy.bin')),
      muslinBin:   fileInfo(resolve(prebakeDir, 'muslin.bin')),
      gossamerBin: fileInfo(resolve(prebakeDir, 'gossamer.bin')),
      manifest:    fileInfo(resolve(prebakeDir, 'manifest.json')),
    },
    serverStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

function wipeDir(dir, filter = () => true) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    if (!filter(name)) continue;
    try { unlinkSync(join(dir, name)); n++; } catch {}
  }
  return n;
}

function runStep(label, cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  const ms = Date.now() - started;
  return {
    label,
    ok: r.status === 0,
    exitCode: r.status,
    ms,
    stdoutTail: (r.stdout || '').split('\n').slice(-10).join('\n'),
    stderrTail: (r.stderr || '').split('\n').slice(-10).join('\n'),
  };
}

async function resetEverything() {
  const steps = [];
  // 1. Wipe calcite WASM pkg.
  const wasmDeleted = wipeDir(wasmPkgDir, () => true);
  steps.push({ label: 'wipe calcite/web/pkg', ok: true, filesDeleted: wasmDeleted });
  // 2. Wipe prebake bin + meta. Keep .gitignore.
  const prebakeDeleted = wipeDir(prebakeDir, n => n.endsWith('.bin') || n.endsWith('.json'));
  steps.push({ label: 'wipe web/prebake', ok: true, filesDeleted: prebakeDeleted });
  // 3. Rebuild WASM (release).
  steps.push(runStep(
    'wasm-pack build calcite-wasm',
    'wasm-pack',
    ['build', calciteWasmCrate, '--target', 'web', '--out-dir', wasmPkgDir, '--release'],
    { cwd: calciteRoot },
  ));
  // 4. Rebake BIOSes.
  steps.push(runStep(
    'prebake BIOSes',
    process.execPath,
    [resolve(repoRoot, 'web', 'scripts', 'prebake.mjs')],
    { cwd: repoRoot },
  ));
  return { startedAt: new Date().toISOString(), steps, status: statusSnapshot() };
}

const CLEAR_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>dev: clear browser caches</title>
<style>body{font-family:monospace;padding:24px;max-width:720px;margin:auto;line-height:1.5}h1{font-size:16px}.ok{color:#0a0}.err{color:#a00}pre{background:#eee;padding:8px;white-space:pre-wrap}</style></head>
<body><h1>Clearing browser caches…</h1><pre id="log">starting…\n</pre>
<script>
const log = document.getElementById('log');
const p = (s, ok) => { log.textContent += (ok === false ? '[FAIL] ' : '[ok]   ') + s + '\\n'; };
(async () => {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { await r.unregister(); p('unregister ' + (r.scope || '(no scope)')); }
      if (regs.length === 0) p('no service workers registered');
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      for (const k of keys) { await caches.delete(k); p('caches.delete ' + k); }
      if (keys.length === 0) p('no Cache Storage keys');
    }
    if ('indexedDB' in window) {
      try {
        const dbs = (await indexedDB.databases?.()) || [];
        for (const db of dbs) { if (db.name) { indexedDB.deleteDatabase(db.name); p('idb delete ' + db.name); } }
        if (dbs.length === 0) p('no IndexedDB dbs');
      } catch (e) { p('indexedDB: ' + e.message, false); }
    }
    localStorage.clear(); p('localStorage.clear()');
    sessionStorage.clear(); p('sessionStorage.clear()');
    p('done. reloading in 1.5s…');
    setTimeout(() => location.href = '/build.html', 1500);
  } catch (e) {
    p('fatal: ' + e.message, false);
  }
})();
</script></body></html>`;

// --- End dev endpoints ---------------------------------------------------

function resolvePath(urlPath) {
  for (const [prefix, dir] of ALIASES) {
    if (urlPath.startsWith(prefix)) {
      return join(dir, urlPath.slice(prefix.length));
    }
  }
  return join(siteRoot, urlPath === '/' ? '/index.html' : urlPath);
}

function isInsideAllowedRoot(file) {
  const abs = resolve(file);
  return ALLOWED_ROOTS.some(root => abs === root || abs.startsWith(root + sep));
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // Cross-origin isolation headers — required for SharedArrayBuffer
  // (and therefore for the planned SAB-based framebuffer path). Attached to
  // every response; no downside in dev.
  const COI_HEADERS = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  // Dev endpoints — don't hit the file server.
  if (path === '/_status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...COI_HEADERS });
    return res.end(JSON.stringify(statusSnapshot(), null, 2));
  }
  if (path === '/_reset') {
    const result = await resetEverything();
    const ok = result.steps.every(s => s.ok !== false);
    res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...COI_HEADERS });
    return res.end(JSON.stringify(result, null, 2));
  }
  if (path === '/_clear') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...COI_HEADERS });
    return res.end(CLEAR_PAGE);
  }
  // /_carts.json — directory listing of carts/, used by the build UI's
  // cart picker. Each entry: { name, files: [...], program }, where
  // `program` is the parsed program.json (or null), and `files` is the
  // flat list of relative paths inside the cart (no recursion deeper than
  // one subdir, matching what the browser builder accepts).
  if (path === '/_carts.json') {
    const out = [];
    let entries;
    try { entries = readdirSync(cartsDir, { withFileTypes: true }); }
    catch { entries = []; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = join(cartsDir, ent.name);
      const files = [];
      // One level deep — same as the browser builder's relativeCartName flatten.
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile()) {
          if (f.name === 'program.json') continue;
          files.push(f.name);
        } else if (f.isDirectory()) {
          for (const g of readdirSync(join(dir, f.name), { withFileTypes: true })) {
            if (g.isFile()) files.push(`${f.name}/${g.name}`);
          }
        }
      }
      let program = null;
      const pjPath = join(dir, 'program.json');
      if (existsSync(pjPath)) {
        try { program = JSON.parse(readFileSync(pjPath, 'utf8')); }
        catch { program = null; }
      }
      out.push({ name: ent.name, files, program });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...COI_HEADERS });
    return res.end(JSON.stringify(out));
  }

  let file = resolvePath(path);
  if (!isInsideAllowedRoot(file)) {
    res.statusCode = 404;
    return res.end('not found');
  }
  let st;
  try { st = statSync(file); } catch { res.statusCode = 404; return res.end('not found'); }
  if (st.isDirectory()) {
    file = join(file, 'index.html');
    try { st = statSync(file); } catch { res.statusCode = 404; return res.end('not found'); }
  }
  const ext = extname(file);
  const type = MIME[ext] ?? 'application/octet-stream';
  const bytes = readFileSync(file);

  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  const shouldGzip = acceptsGzip && (ext === '.css' || ext === '.mjs' || ext === '.js');

  const body = shouldGzip ? gzipSync(bytes) : bytes;
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    ...COI_HEADERS,
    ...(shouldGzip && { 'Content-Encoding': 'gzip' }),
  });
  res.end(body);
});

// One-shot CLI hooks. `node dev.mjs regen` runs regen and exits; lets
// dev.bat accept a subcommand without starting the server. More
// subcommands can be added here later if needed.
const argv = process.argv.slice(2);
if (argv[0] === 'regen') {
  await runRegen();
  process.exit(0);
}

const port = Number(process.env.PORT) || 5173;
server.listen(port, () => {
  console.log(`web dev server: http://localhost:${port}/`);
  console.log(`stdin commands: status | reset | clear | regen | help | quit`);
  startStdinRepl();
});

// --- stdin REPL ----------------------------------------------------------
// Type into the server terminal to inspect / reset state without polluting
// pages or having browser URLs. Useful because the gotcha we keep hitting
// is "is the WASM I'm serving actually the one I just rebuilt?" — one
// keystroke here answers that.

function printStatus() {
  const s = statusSnapshot();
  console.log('');
  console.log(`  CSS-DOS:  ${s.cssDosCommit}`);
  console.log(`  calcite:  ${s.calciteCommit}`);
  if (s.wasm) {
    console.log(`  WASM:     ${s.wasm.md5}  ${s.wasm.bytes}B  ${s.wasm.mtime}`);
  } else {
    console.log(`  WASM:     (missing — run 'reset')`);
  }
  const pb = s.prebake;
  for (const [name, info] of Object.entries(pb)) {
    const label = name.padEnd(12);
    if (info) {
      console.log(`  ${label} ${info.md5}  ${String(info.bytes).padStart(6)}B  ${info.mtime}`);
    } else {
      console.log(`  ${label} (missing)`);
    }
  }
  console.log(`  server up:   ${s.serverStartedAt}`);
  console.log('');
}

async function runReset() {
  console.log('[reset] starting…');
  const result = await resetEverything();
  for (const step of result.steps) {
    const status = step.ok === false ? 'FAIL' : 'ok';
    const extra = step.filesDeleted != null ? ` (${step.filesDeleted} files)` : step.ms != null ? ` (${step.ms}ms)` : '';
    console.log(`  [${status}] ${step.label}${extra}`);
    if (step.ok === false && step.stderrTail) {
      console.log(step.stderrTail.split('\n').map(l => '         ' + l).join('\n'));
    }
  }
  const clearUrl = `http://localhost:${port}/_clear`;
  // Auto-open the clear page so the browser purges caches + reloads to
  // /build.html without the user having to remember the URL. Best-effort:
  // if `start` (Windows) / `open` (macOS) / `xdg-open` (Linux) isn't
  // available, fall back to printing the URL.
  const openCmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  const opened = spawnSync(openCmd, [clearUrl], {
    shell: process.platform === 'win32',  // `start` is a cmd builtin
    stdio: 'ignore',
  });
  if (opened.error || opened.status !== 0) {
    console.log(`[reset] done. browser: open ${clearUrl} to purge browser caches + reload.`);
  } else {
    console.log(`[reset] done. opened ${clearUrl} in default browser.`);
  }
}

// Regenerate the autogen HTML pages:
//   - web/site/split.html from web/site/build.html (split-regen.mjs)
//   - player/raw.html from the pixel-grid template (raw-regen.mjs)
// Runs both in sequence and prints each script's stdout. Throws if
// either fails (anchor drift in split-regen, or IO error).
async function runRegen() {
  const scripts = [
    resolve(__dirname, 'split-regen.mjs'),
    resolve(__dirname, 'raw-regen.mjs'),
  ];
  for (const script of scripts) {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) {
      console.log(`[regen] ${script} exited ${r.status}`);
      return;
    }
  }
  console.log('[regen] done');
}

function startStdinRepl() {
  if (!process.stdin.isTTY) {
    // Non-interactive (piped / service manager) — skip the REPL.
    return;
  }
  process.stdin.setEncoding('utf8');
  process.stdout.write('> ');
  let buf = '';
  process.stdin.on('data', async chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      await handleCommand(line);
      process.stdout.write('> ');
    }
  });
}

async function handleCommand(line) {
  if (!line) return;
  const [cmd, ...rest] = line.split(/\s+/);
  switch (cmd) {
    case 'status': case 's':
      printStatus();
      break;
    case 'reset': case 'r':
      await runReset();
      break;
    case 'clear': case 'c':
      console.log(`open http://localhost:${port}/_clear in the browser to purge its caches + reload.`);
      break;
    case 'regen': case 'g':
      await runRegen();
      break;
    case 'help': case '?': case 'h':
      console.log('commands:');
      console.log('  status | s   show git HEADs, WASM + prebake mtimes/md5s');
      console.log('  reset  | r   wipe + rebuild calcite WASM, rebake BIOSes');
      console.log('  clear  | c   print URL to open for browser-side cache purge');
      console.log('  regen  | g   regenerate split.html and raw.html from their sources');
      console.log('  help   | ?   this help');
      console.log('  quit   | q   exit server');
      break;
    case 'quit': case 'q': case 'exit':
      console.log('bye');
      process.exit(0);
      break;
    default:
      console.log(`unknown command: ${cmd} (type 'help')`);
  }
}

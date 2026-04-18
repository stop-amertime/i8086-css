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
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname, join, sep } from 'node:path';
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
  ['/calcite/',         resolve(repoRoot, '..', 'calcite', 'web')],
  ['/tests/',           resolve(__dirname, '..', 'tests')],
];

const ALLOWED_ROOTS = [siteRoot, ...ALIASES.map(([, dir]) => dir)];

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

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
    ...(shouldGzip && { 'Content-Encoding': 'gzip' }),
  });
  res.end(body);
});

const port = Number(process.env.PORT) || 5173;
server.listen(port, () => console.log(`web dev server: http://localhost:${port}/`));

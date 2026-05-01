#!/usr/bin/env node
// OLD DEPRECATED Tiny static server for the player. Serves two roots:
//
//   /           → CSS-DOS/player/   (the player HTML + CSS)
//   /cabinets/  → CSS-DOS/..         (anywhere under the parent of CSS-DOS,
//                                     so ../calcite/output/foo.css can be
//                                     reached as /cabinets/calcite/output/foo.css)
//
// Usage:  node player/serve.mjs [--port 8765]
//
// Open the printed URL, e.g.:
//   http://localhost:8765/?cabinet=/cabinets/calcite/output/bootle-ctest.css
//
// Intentionally minimal — no auth, no caching tricks, no WASM. A separate
// server exists in calcite/ with more features.

import { createServer } from 'node:http';
import { readFileSync, statSync, createReadStream, existsSync } from 'node:fs';
import { resolve, dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const playerRoot = resolve(__dirname);
const srcRoot = resolve(__dirname, '..', '..'); // parent of CSS-DOS/

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? parseInt(process.argv[i + 1]) : 8765;
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function serveFile(res, path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return send(res, 404, `not found: ${path}`);
  }
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  createReadStream(path).pipe(res);
}

function safeResolve(base, rel) {
  const full = resolve(base, '.' + rel); // '.'+'/foo' → './foo' under base
  const normalized = normalize(full);
  if (!normalized.startsWith(base)) return null;
  return normalized;
}

const server = createServer((req, res) => {
  // Default path → the player
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  // /cabinets/* → absolute files under the parent of CSS-DOS/
  if (url.startsWith('/cabinets/')) {
    const rel = url.slice('/cabinets'.length); // keep leading '/'
    const full = safeResolve(srcRoot, rel);
    if (!full) return send(res, 403, 'forbidden');
    return serveFile(res, full);
  }

  // Everything else → under player/
  const full = safeResolve(playerRoot, url);
  if (!full) return send(res, 403, 'forbidden');
  serveFile(res, full);
});

server.listen(port, () => {
  console.log(`Player server on http://localhost:${port}/`);
  console.log(`  Example: http://localhost:${port}/?cabinet=/cabinets/calcite/output/bootle-ctest.css`);
  console.log(`  /cabinets/ is rooted at ${srcRoot}`);
});

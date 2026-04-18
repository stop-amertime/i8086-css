// Node-filesystem-backed globalThis.fetch stub for tests.
// Routes:
//   /prebake/*       → web/prebake/*
//   /assets/dos/*    → dos/bin/*
//   /presets/*       → builder/presets/*

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const webRoot = resolve(repoRoot, 'web');

const ROUTES = [
  ['/prebake/',    resolve(webRoot, 'prebake')],
  ['/assets/dos/', resolve(repoRoot, 'dos', 'bin')],
  ['/presets/',    resolve(repoRoot, 'builder', 'presets')],
];

globalThis.fetch = async (url) => {
  let filePath = null;
  for (const [prefix, root] of ROUTES) {
    if (url.startsWith(prefix)) {
      filePath = resolve(root, url.slice(prefix.length));
      break;
    }
  }
  if (!filePath) return { ok: false, status: 404, statusText: `no stub route for ${url}` };
  try {
    const bytes = readFileSync(filePath);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  } catch (e) {
    return { ok: false, status: 404, statusText: e.message };
  }
};

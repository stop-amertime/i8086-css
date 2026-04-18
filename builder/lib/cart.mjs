// Cart resolution: turn a folder or zip path into a canonical cart layout.
//
// A cart is:
//   { root: absolute path to the cart directory (or unzip temp dir),
//     name: display name,
//     files: [{ name, path, source }]  (discovered from folder contents),
//     manifest: program.json (parsed, or {}) }

import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export function resolveCart(inputPath) {
  const abs = resolve(inputPath);
  if (!existsSync(abs)) throw new Error(`cart not found: ${abs}`);

  const stat = statSync(abs);
  let root;
  let displayName;

  if (stat.isDirectory()) {
    root = abs;
    displayName = basename(abs);
  } else if (abs.toLowerCase().endsWith('.zip')) {
    root = unzipToTemp(abs);
    displayName = basename(abs, '.zip');
  } else {
    throw new Error(`cart must be a folder or a .zip: ${abs}`);
  }

  const manifestPath = join(root, 'program.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {};

  const files = discoverFiles(root);
  return { root, name: manifest.name || displayName, files, manifest };
}

function discoverFiles(root) {
  // Flat folder: every file except program.json. Subfolders ignored.
  const out = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'program.json') continue;
    const p = join(root, entry);
    if (!statSync(p).isFile()) continue;
    out.push({
      name: to83(entry),
      source: entry,
      path: p,
      size: statSync(p).size,
      ext: extname(entry).toLowerCase(),
    });
  }
  return out;
}

function to83(name) {
  // Uppercase, clip to 8.3 if needed. Real FAT12 8.3 conversion is more
  // complex (long-name handling); this is the simple case.
  const up = name.toUpperCase();
  const dot = up.lastIndexOf('.');
  if (dot < 0) return up.slice(0, 8);
  const stem = up.slice(0, dot).replace(/[^A-Z0-9_]/g, '').slice(0, 8);
  const ext = up.slice(dot + 1).replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return ext ? `${stem}.${ext}` : stem;
}

function unzipToTemp(zipPath) {
  const out = mkdtempSync(join(tmpdir(), 'cart-'));
  try {
    // Cross-platform unzip: use tar on Windows 10+ / macOS / Linux.
    execFileSync('tar', ['-xf', zipPath, '-C', out], { stdio: 'pipe' });
  } catch (_) {
    throw new Error(`failed to unzip ${zipPath} — install tar or unzip the cart manually and point the builder at the folder`);
  }
  return out;
}

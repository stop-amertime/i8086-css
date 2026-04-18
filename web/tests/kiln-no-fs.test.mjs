import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

function collectMjs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectMjs(full));
    else if (name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('Kiln source files do not import node: modules', () => {
  const kilnDir = resolve(repoRoot, 'kiln');
  const files = collectMjs(kilnDir);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(
      !/from\s+['"]node:/.test(src) && !/require\(['"]node:/.test(src),
      `${f.slice(repoRoot.length)} imports a node: module — move I/O out of Kiln`
    );
  }
});

test('builder/lib/config.mjs and builder/stages/kiln.mjs are browser-safe', () => {
  for (const f of ['builder/lib/config.mjs', 'builder/stages/kiln.mjs']) {
    const src = readFileSync(resolve(repoRoot, f), 'utf8');
    assert.ok(
      !/from\s+['"]node:/.test(src) && !/require\(['"]node:/.test(src),
      `${f} imports a node: module — move I/O to caller`
    );
  }
});

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrebakedBios } from '../browser-builder/prebake-loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '..');

// Stub global fetch() to read from local filesystem.
globalThis.fetch = async (url) => {
  // url is like '/prebake/muslin.bin'; strip leading /
  const rel = url.replace(/^\//, '');
  const path = resolve(webRoot, rel);
  const bytes = readFileSync(path);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
};

test('loadPrebakedBios returns bytes + entry info for muslin', async () => {
  const bios = await loadPrebakedBios('muslin');
  // bios.bytes is whatever Kiln accepts — number[] or Uint8Array. Task 3 confirmed Kiln takes a passthrough shape; match whatever buildBios (builder/stages/bios.mjs) returns today so the two are interchangeable.
  assert.ok(Array.isArray(bios.bytes) || bios.bytes instanceof Uint8Array);
  assert.ok(bios.bytes.length > 0);
  assert.equal(bios.entrySegment, 0xF000);
  assert.equal(typeof bios.entryOffset, 'number');
  assert.equal(bios.meta.flavor, 'muslin');
});

test('loadPrebakedBios works for gossamer (no entry point)', async () => {
  const bios = await loadPrebakedBios('gossamer');
  assert.ok(bios.bytes.length > 0);
  assert.equal(bios.entrySegment, null);
  assert.equal(bios.entryOffset, null);
  assert.equal(bios.meta.flavor, 'gossamer');
});

test('loadPrebakedBios throws for unknown flavor', async () => {
  await assert.rejects(loadPrebakedBios('hoagie'), /unknown bios flavor/i);
});

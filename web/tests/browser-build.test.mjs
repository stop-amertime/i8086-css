import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './helpers/fetch-stub.mjs';
import { buildCabinetInBrowser } from '../browser-builder/main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

test('hack: builds bcd.com into a Blob', async () => {
  const comBytes = new Uint8Array(readFileSync(resolve(repoRoot, 'tests', 'bcd.com')));
  const blob = await buildCabinetInBrowser({
    preset: 'hack',
    programBytes: comBytes,
    programName: 'BCD.COM',
  });
  assert.ok(blob instanceof Blob);
  assert.ok(blob.size > 100_000, `hack cabinet size suspicious: ${blob.size}`);
  const text = await blob.text();
  assert.match(text, /animation: anim-play 400ms/);
  assert.match(text, /--readMem/);
});

test('hack: progress callback fires', async () => {
  const calls = [];
  const comBytes = new Uint8Array(readFileSync(resolve(repoRoot, 'tests', 'bcd.com')));
  await buildCabinetInBrowser({
    preset: 'hack',
    programBytes: comBytes,
    programName: 'BCD.COM',
    onProgress: (ev) => calls.push(ev.stage),
  });
  assert.ok(calls.includes('bios'));
  assert.ok(calls.includes('kiln'));
  assert.ok(calls.includes('done'));
});

test('dos-muslin: builds a minimal DOS cart', async () => {
  const comBytes = new Uint8Array(readFileSync(resolve(repoRoot, 'tests', 'bcd.com')));
  const blob = await buildCabinetInBrowser({
    preset: 'dos-muslin',
    programBytes: comBytes,
    programName: 'BCD.COM',
  });
  assert.ok(blob instanceof Blob);
  assert.ok(blob.size > 100_000_000, `DOS cabinet size suspicious: ${blob.size}`);
  const text = await blob.text();
  assert.match(text, /animation: anim-play 400ms/);
});

test('rejects unsupported preset', async () => {
  await assert.rejects(
    buildCabinetInBrowser({
      preset: 'nonsense-preset',
      programBytes: new Uint8Array([0xC3]),
      programName: 'X.COM',
    }),
    /supports/i,
  );
});

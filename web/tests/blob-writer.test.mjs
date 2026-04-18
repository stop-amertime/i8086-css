import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobWriter } from '../browser-builder/blob-writer.mjs';

test('BlobWriter accumulates chunks and produces a Blob', async () => {
  const w = new BlobWriter();
  w.write('hello ');
  w.write('world');
  const blob = w.finish();
  assert.equal(blob.size, 11);
  assert.equal(await blob.text(), 'hello world');
});

test('BlobWriter handles thousands of chunks without blowing up', async () => {
  const w = new BlobWriter();
  for (let i = 0; i < 10000; i++) w.write('x');
  const blob = w.finish();
  assert.equal(blob.size, 10000);
});

test('BlobWriter reports bytesWritten', () => {
  const w = new BlobWriter();
  w.write('abc');
  assert.equal(w.bytesWritten, 3);
  w.write('de');
  assert.equal(w.bytesWritten, 5);
});

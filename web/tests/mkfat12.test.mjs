import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFat12Image } from '../../tools/mkfat12.mjs';

test('buildFat12Image returns a Uint8Array of a FAT12 floppy', () => {
  const files = [
    { name: 'HELLO.TXT', bytes: new TextEncoder().encode('hi!\n') },
  ];
  const img = buildFat12Image(files);
  assert.ok(img instanceof Uint8Array);
  // FAT12 image size depends on content (auto-sized geometry), not fixed 1.44MB.
  assert.ok(img.length > 0, 'image should be non-empty');
  assert.ok(img.length % 512 === 0, 'image size should be a multiple of 512');
  // Boot sector signature 0x55AA at offset 510.
  assert.equal(img[510], 0x55);
  assert.equal(img[511], 0xAA);
});

test('buildFat12Image preserves input file ordering (A+B vs B+A differ)', () => {
  const fileA = { name: 'AAA.TXT', bytes: new TextEncoder().encode('aaaa') };
  const fileB = { name: 'BBB.TXT', bytes: new TextEncoder().encode('bbbb') };

  const imgAB = buildFat12Image([fileA, fileB]);
  const imgBA = buildFat12Image([fileB, fileA]);

  // Images must differ: directory entries are in insertion order.
  assert.notDeepEqual(imgAB, imgBA, 'images with swapped file order should differ');
});

test('buildFat12Image throws on missing bytes', () => {
  assert.throws(
    () => buildFat12Image([{ name: 'BAD.TXT', bytes: null }]),
    /must be/i,
  );
});

test('buildFat12Image file bytes appear in the data region', () => {
  const content = new TextEncoder().encode('hi!\n');
  const files = [{ name: 'HELLO.TXT', bytes: content }];
  const img = buildFat12Image(files);

  // FAT12 data region starts after boot sector + FATs + root dir.
  // For a minimal image the data area begins well past offset 0x200.
  // Search the entire image for the content bytes.
  const needle = 'hi!\n';
  let found = false;
  for (let i = 512; i <= img.length - content.length; i++) {
    if (img[i] === content[0] && img[i + 1] === content[1] &&
        img[i + 2] === content[2] && img[i + 3] === content[3]) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'file bytes should appear in the image data region');
});

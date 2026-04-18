import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitClockAndCpuBase } from '../../kiln/template.mjs';

test('emitClockAndCpuBase always includes anim-play animation', () => {
  const out = emitClockAndCpuBase();
  assert.match(out, /animation: anim-play 400ms steps\(4, jump-end\) infinite;/);
});

test('emitClockAndCpuBase ignores htmlMode option (removed)', () => {
  const out = emitClockAndCpuBase({ htmlMode: true });
  assert.match(out, /animation: anim-play 400ms steps\(4, jump-end\) infinite;/);
});

// Framebuffer diff between PACK=1 and PACK=2 at tick 140000.
import { DebuggerClient } from './lib/debugger-client.mjs';

const CABINET_P1 = 'C:/Users/AdmT9N0CX01V65438A/AppData/Local/Temp/pack-diff/zork-p1.css';
const CABINET_P2 = 'C:/Users/AdmT9N0CX01V65438A/AppData/Local/Temp/pack-diff/zork-p2.css';
const TARGET_TICK = 140000;

async function probe(cabinet, label) {
  console.error(`[${label}] spawning debugger for ${cabinet}`);
  const dbg = await DebuggerClient.spawnChild({
    cssPath: cabinet,
    session: `fb-${label}`,
    initTimeoutMs: 120_000,
  });
  try {
    console.error(`[${label}] seeking to tick ${TARGET_TICK}...`);
    await dbg.seek(TARGET_TICK);
    const fbStart = await dbg.memory(0xA0000, 256);
    const fbMid = await dbg.memory(0xA0000 + 100 * 320 + 160, 64);
    const fbLate = await dbg.memory(0xA0000 + 150 * 320, 64);
    return { label, fbStart, fbMid, fbLate };
  } finally {
    await dbg.close();
  }
}

function toBytes(v) {
  if (v == null) return [];
  if (typeof v === 'string') {
    return v.replace(/\s+/g, '').match(/.{1,2}/g)?.map(h => parseInt(h, 16)) ?? [];
  }
  if (Array.isArray(v)) return v.every(x => typeof x === 'number') ? v : v.map(toBytes).flat();
  if (v.bytes) return toBytes(v.bytes);
  if (v.data) return toBytes(v.data);
  if (v.content?.[0]?.text) {
    try {
      const parsed = JSON.parse(v.content[0].text);
      return toBytes(parsed);
    } catch { return toBytes(v.content[0].text); }
  }
  if (v.memory) return toBytes(v.memory);
  if (v.hex) return toBytes(v.hex);
  return [];
}

function hex(bytes, n = 64) {
  return bytes.slice(0, n).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
function countNonZero(bytes) { return bytes.filter(b => b !== 0).length; }
function histogram(bytes) {
  const h = new Map();
  for (const b of bytes) h.set(b, (h.get(b) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

const p1 = await probe(CABINET_P1, 'P1');
const p2 = await probe(CABINET_P2, 'P2');

console.log('\n=== RAW SHAPES ===');
console.log('P1.fbStart keys:', Object.keys(p1.fbStart ?? {}));
console.log('P1.fbStart raw:', JSON.stringify(p1.fbStart).slice(0, 200));

for (const region of ['fbStart', 'fbMid', 'fbLate']) {
  const b1 = toBytes(p1[region]);
  const b2 = toBytes(p2[region]);
  console.log(`\n=== ${region} ===`);
  console.log(`P1 (${b1.length} bytes, ${countNonZero(b1)} non-zero): ${hex(b1)}`);
  console.log(`P2 (${b2.length} bytes, ${countNonZero(b2)} non-zero): ${hex(b2)}`);
  console.log(`P1 histogram: ${JSON.stringify(histogram(b1))}`);
  console.log(`P2 histogram: ${JSON.stringify(histogram(b2))}`);
  const diffs = [];
  for (let i = 0; i < Math.min(b1.length, b2.length); i++) {
    if (b1[i] !== b2[i]) diffs.push({ i, p1: b1[i], p2: b2[i] });
  }
  console.log(`diffs: ${diffs.length} bytes differ`);
  if (diffs.length) console.log(`first 10 diffs: ${JSON.stringify(diffs.slice(0, 10))}`);
}
process.exit(0);

#!/usr/bin/env node
// resolve-cpuprofile.mjs — post-process a .cpuprofile, resolving
// `wasm-function[N]` callFrames against the `name` custom section of
// the wasm module, and re-emit a top-N report with collapsed indices.
//
// V8 cpuprofile shape: { nodes:[{id, callFrame:{functionName, url}, hitCount, children}],
//                        samples:[nodeId,...], timeDeltas:[us,...], startTime, endTime }
//
// Why this matters: V8 reports wasm functions by index (`wasm-function[23]`),
// and the same function can appear as multiple cpuprofile nodes due to
// different inlining/parent contexts. This tool reads the wasm `name`
// section and rewrites the functionName, then aggregates self-time by
// resolved name so the same Rust function isn't split across multiple
// rows.
//
// Usage:
//   node tests/harness/resolve-cpuprofile.mjs <profile.cpuprofile> --wasm=<.wasm> [--top=30] [--write]
//
// --write rewrites the cpuprofile in place with resolved functionNames
// (so loading it in Chrome DevTools shows real names too).

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const profilePath = args.find(a => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const eq = a.indexOf('=');
  return eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), true];
}));
if (!profilePath || !flags.wasm) {
  console.error('usage: resolve-cpuprofile.mjs <profile.cpuprofile> --wasm=<.wasm> [--top=30] [--write]');
  process.exit(2);
}
const TOP_N = parseInt(flags.top ?? '30', 10);
const WRITE = !!flags.write;

// ---------- wasm name-section parser ----------
// Spec: https://webassembly.github.io/spec/core/appendix/custom.html#name-section
// We need: module preamble (8 bytes), section 0 with name "name", and
// inside it subsection 1 = "function names" = vec<(funcidx, name)>.

function readU8(buf, off) { return [buf[off], off + 1]; }
function readU32Leb(buf, off) {
  let result = 0, shift = 0, byte = 0;
  do {
    byte = buf[off++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    if (shift > 35) throw new Error('leb128 too long');
  } while (byte & 0x80);
  return [result >>> 0, off];
}
function readBytes(buf, off, len) {
  return [buf.slice(off, off + len), off + len];
}
function readString(buf, off) {
  let len, str;
  [len, off] = readU32Leb(buf, off);
  [str, off] = readBytes(buf, off, len);
  return [Buffer.from(str).toString('utf8'), off];
}

function parseWasmFunctionNames(wasmBuf) {
  if (wasmBuf.readUInt32LE(0) !== 0x6d736100) throw new Error('not a wasm module');
  if (wasmBuf.readUInt32LE(4) !== 1) throw new Error('unsupported wasm version');
  let off = 8;
  const names = new Map(); // funcIdx → name
  while (off < wasmBuf.length) {
    let secId, secLen, secEnd;
    [secId, off] = readU8(wasmBuf, off);
    [secLen, off] = readU32Leb(wasmBuf, off);
    secEnd = off + secLen;
    if (secId === 0) {
      // Custom section
      let name;
      [name, off] = readString(wasmBuf, off);
      if (name === 'name') {
        // Parse name subsections.
        while (off < secEnd) {
          let subId, subLen, subEnd;
          [subId, off] = readU8(wasmBuf, off);
          [subLen, off] = readU32Leb(wasmBuf, off);
          subEnd = off + subLen;
          if (subId === 1) {
            // function names: vec<(funcidx, name)>
            let count;
            [count, off] = readU32Leb(wasmBuf, off);
            for (let i = 0; i < count; i++) {
              let fnIdx, fnName;
              [fnIdx, off] = readU32Leb(wasmBuf, off);
              [fnName, off] = readString(wasmBuf, off);
              names.set(fnIdx, fnName);
            }
          } else {
            off = subEnd;
          }
        }
      }
    }
    off = secEnd;
  }
  return names;
}

// ---------- demangle Rust ----------
// Lightweight demangler for legacy Rust mangling (`_ZN...E`) and the v0
// (`_R...`) scheme. We only need readable output, not perfect roundtrip.
function demangle(name) {
  // wasm-bindgen names are usually already readable.
  if (!name) return name;
  // Legacy Rust: _ZN5alloc6string6String9push_str17h<hash>E
  if (name.startsWith('_ZN') && name.endsWith('E')) {
    const inner = name.slice(3, -1);
    const parts = [];
    let i = 0;
    while (i < inner.length) {
      let lenStr = '';
      while (i < inner.length && inner[i] >= '0' && inner[i] <= '9') {
        lenStr += inner[i++];
      }
      if (!lenStr) break;
      const len = parseInt(lenStr, 10);
      const seg = inner.slice(i, i + len);
      i += len;
      // Skip 17-char hash segments (h<16 hex>).
      if (!/^h[0-9a-f]{16}$/.test(seg)) parts.push(seg);
    }
    return parts.join('::');
  }
  return name;
}

// ---------- main ----------
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const wasmBuf = readFileSync(flags.wasm);
const fnNames = parseWasmFunctionNames(wasmBuf);
process.stderr.write(`parsed ${fnNames.size} function names from ${flags.wasm}\n`);

// Rewrite callFrames with resolved names. Key the rewrite into a map
// keyed by canonical function identity (for wasm: the function index;
// for JS: url+functionName+lineNumber).
function canonicalKey(cf) {
  if (!cf) return '?';
  const fn = cf.functionName || '';
  const m = fn.match(/^wasm-function\[(\d+)\]$/);
  if (m) return `wasm:${m[1]}`;
  return `js:${cf.url || ''}|${fn}|${cf.lineNumber ?? ''}`;
}

let resolved = 0, missed = 0;
for (const node of profile.nodes) {
  const cf = node.callFrame;
  if (!cf) continue;
  const m = (cf.functionName || '').match(/^wasm-function\[(\d+)\]$/);
  if (m) {
    const idx = parseInt(m[1], 10);
    const name = fnNames.get(idx);
    if (name) {
      cf.functionName = `${demangle(name)} [wasm:${idx}]`;
      resolved++;
    } else {
      missed++;
    }
  }
}
process.stderr.write(`resolved ${resolved} wasm nodes, ${missed} missed\n`);

if (WRITE) {
  writeFileSync(profilePath, JSON.stringify(profile));
  process.stderr.write(`wrote resolved profile in place: ${profilePath}\n`);
}

// ---------- aggregate self-time by canonical key ----------
const { nodes, samples, timeDeltas } = profile;
const byId = new Map(nodes.map(n => [n.id, n]));
const totalUs = profile.endTime - profile.startTime;
const buckets = new Map(); // canonicalKey → { fn, url, selfUs }
for (let i = 0; i < samples.length; i++) {
  const id = samples[i];
  const dt = timeDeltas[i] ?? 0;
  const n = byId.get(id);
  const cf = n?.callFrame ?? {};
  const key = canonicalKey(cf);
  let row = buckets.get(key);
  if (!row) {
    row = { fn: cf.functionName || '(anonymous)', url: cf.url || '', selfUs: 0 };
    buckets.set(key, row);
  }
  row.selfUs += dt;
}

const rows = [...buckets.values()].sort((a, b) => b.selfUs - a.selfUs).slice(0, TOP_N);
console.log(`\n  top by collapsed function (self time)  total ${(totalUs / 1000).toFixed(0)} ms`);
for (const r of rows) {
  const fn = r.fn.slice(0, 90);
  const ms = (r.selfUs / 1000).toFixed(1).padStart(9);
  const pct = (r.selfUs / totalUs * 100).toFixed(2).padStart(6);
  console.log(`    ${pct}%  ${ms} ms  ${fn}`);
}

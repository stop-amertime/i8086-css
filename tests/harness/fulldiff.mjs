#!/usr/bin/env node
// fulldiff.mjs — find the first tick where calcite's register/flag state
// diverges from the JS reference emulator.
//
// Inputs:
//   <cabinet.css>    — built with the new builder (sidecar .bios.bin etc)
//   [--max-ticks=N]  — stop after this many ref-emulator steps (default 50k)
//   [--skip=N]       — skip the first N ticks in the diff (for debugging
//                      past known-good boot)
//   [--stop-at=all]  — by default stops at first divergence; 'all' keeps
//                      going and summarises up to 20 per-register diffs.
//
// Outputs:
//   stdout: JSON {ok, ticks, divergedAt?, divergence?, summary}
//   stderr: human-readable progress
//
// How it works:
//   1. Load the cabinet sidecars to stand up the ref-machine exactly as
//      calcite sees memory. Starts at bios.entrySegment:bios.entryOffset.
//   2. Spawn a child calcite-debugger -i <cabinet>.
//   3. Tick both in lockstep, one instruction at a time.
//   4. Compare the 13-register set (AX/BX/CX/DX/SI/DI/BP/SP/CS/DS/ES/SS/IP)
//      plus FLAGS (all 16 bits). Report first disagreement.
//
// REP instructions: the JS ref collapses an entire REP loop into a single
// step; calcite expands per iteration. We detect REP prefixes before each
// ref step; when one is active we skip forward in calcite by `CX before`
// ticks rather than one-by-one.
//
// Performance: calcite runs ~1500 ticks/s on this machine. Refs run much
// faster but we're bottlenecked by the HTTP round trip. Budget ~2 hours
// for a 1M-tick diff.

import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { DebuggerClient } from './lib/debugger-client.mjs';
import { loadCabinetSidecars, createRefMachine } from './lib/ref-machine.mjs';
import { disassembleAt } from './lib/opcode-names.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- args ---
const argv = process.argv.slice(2);
let cssPath = null;
const flags = { maxTicks: 50_000, skip: 0, stopAt: 'first', out: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (k === 'max-ticks')  flags.maxTicks = Number.parseInt(v, 10);
    else if (k === 'skip')  flags.skip = Number.parseInt(v, 10);
    else if (k === 'stop-at') flags.stopAt = v;
    else if (k === 'out')   flags.out = v;
    else { /* ignore */ }
  } else if (!cssPath) {
    cssPath = a;
  }
}
if (!cssPath) {
  process.stderr.write('usage: fulldiff.mjs <cabinet.css> [--max-ticks=N] [--skip=N] [--stop-at=all]\n');
  process.exit(2);
}

function log(msg) { process.stderr.write(`[fulldiff] ${msg}\n`); }

// --- REP detection: scan up to 4 prefix bytes ---
const STRING_OPS = new Set([0xA4, 0xA5, 0xA6, 0xA7, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF]);
const SEG_PREFIXES = new Set([0x26, 0x2E, 0x36, 0x3E]);
const REP_PREFIXES = new Set([0xF2, 0xF3]);

function detectRep(mem, cs, ip) {
  const base = (cs * 16 + ip) & 0xFFFFF;
  let off = 0;
  let hasRep = false;
  for (let i = 0; i < 4; i++) {
    const b = mem[(base + off) & 0xFFFFF];
    if (REP_PREFIXES.has(b)) { hasRep = true; off++; }
    else if (SEG_PREFIXES.has(b)) { off++; }
    else break;
    if (off > 3) break;
  }
  if (!hasRep) return null;
  const opcode = mem[(base + off) & 0xFFFFF];
  if (!STRING_OPS.has(opcode)) return null;
  return { opcode };
}

function hex(v, w = 4) { return v.toString(16).padStart(w, '0'); }
function flagBitNames(f) {
  const n = ['CF','','PF','','AF','','ZF','SF','TF','IF','DF','OF'];
  return n.map((name, i) => name && (f & (1 << i)) ? name : '').filter(Boolean).join('|') || '(none)';
}

// --- diff ---
const REGISTER_KEYS = ['AX','BX','CX','DX','SI','DI','BP','SP','CS','DS','ES','SS','IP','FLAGS'];

function regsMatch(a, b) {
  for (const k of REGISTER_KEYS) if ((a[k] | 0) !== (b[k] | 0)) return false;
  return true;
}

function regDiff(a, b) {
  const diffs = [];
  for (const k of REGISTER_KEYS) {
    const av = a[k] | 0, bv = b[k] | 0;
    if (av !== bv) {
      const d = { reg: k, ref: av, calcite: bv };
      if (k === 'FLAGS') {
        d.refBits = flagBitNames(av);
        d.calciteBits = flagBitNames(bv);
        d.diffBits = flagBitNames(av ^ bv);
      }
      diffs.push(d);
    }
  }
  return diffs;
}

// Calcite stores FLAGS decomposed as individual single-bit flags. We need
// to reassemble them. The debugger exposes them as the CSS property names
// `--_cf`, `--_pf`, `--_af`, etc.
function assembleCalciteFlags(regs) {
  // Direct assembled value if the emitter happens to expose `--flags`:
  if (typeof regs.flags === 'number') return regs.flags;
  const f =
    (regs._cf ? 1 : 0) |
    (1 << 1) | // bit 1 always set on 8086
    (regs._pf ? (1 << 2) : 0) |
    (regs._af ? (1 << 4) : 0) |
    (regs._zf ? (1 << 6) : 0) |
    (regs._sf ? (1 << 7) : 0) |
    (regs._tf ? (1 << 8) : 0) |
    (regs._ifFlag ? (1 << 9) : 0) |
    (regs._df ? (1 << 10) : 0) |
    (regs._of ? (1 << 11) : 0);
  return f;
}

function calciteRegsToStandard(state) {
  const r = state.registers ?? {};
  return {
    AX: r.AX | 0,
    BX: r.BX | 0,
    CX: r.CX | 0,
    DX: r.DX | 0,
    SI: r.SI | 0,
    DI: r.DI | 0,
    BP: r.BP | 0,
    SP: r.SP | 0,
    CS: r.CS | 0,
    DS: r.DS | 0,
    ES: r.ES | 0,
    SS: r.SS | 0,
    IP: r.IP | 0,
    FLAGS: assembleCalciteFlags(r),
  };
}

async function main() {
  log(`loading sidecars from ${cssPath}`);
  const sidecars = loadCabinetSidecars(cssPath);
  const entryCS = sidecars.meta.bios.entrySegment;
  const entryIP = sidecars.meta.bios.entryOffset;
  log(`entry ${hex(entryCS)}:${hex(entryIP)} (${sidecars.meta.preset})`);

  const ref = createRefMachine(sidecars, { initialCS: entryCS, initialIP: entryIP });

  log('spawning calcite-debugger');
  const dbg = await DebuggerClient.spawnChild({ cssPath, session: 'fulldiff' });
  try {
    const initial = await dbg.state();
    log(`calcite tick0 = ${initial.tick}`);

    // Align the ref machine with calcite's post-kiln starting state. Kiln
    // emits initial SP, SS, etc. directly into the CSS properties, which
    // means calcite begins in a state a real 8086 would only reach after
    // corduroy's entry stub ran. Feeding those values into the ref erases
    // a whole class of "just different starting state" false positives.
    const initialRegs = calciteRegsToStandard(initial);
    ref.applyRegs(initialRegs);
    log(`aligned ref CS=${hex(initialRegs.CS)} IP=${hex(initialRegs.IP)} SP=${hex(initialRegs.SP)} SS=${hex(initialRegs.SS)}`);

    // Turn on the ref's write log so we can cross-check memory writes
    // against calcite on each step. Cheap — a few entries per step on average.
    ref.beginWriteLog();

    const summary = [];
    let divergedAt = null;
    let instr = 0;
    let calciteTick = initial.tick;
    const t0 = performance.now();

    while (instr < flags.maxTicks) {
      // On V4 calcite, every 8086 instruction — including REP-prefixed
      // string ops regardless of CX — retires in exactly one calcite tick.
      // The ref emulator collapses REP to one step too, so the two are in
      // sync instruction-for-instruction. No special REP handling needed.
      const preR = ref.regs();
      const repInfo = detectRep(ref.mem, preR.CS, preR.IP);  // kept for report context
      ref.step();
      const postR = ref.regs();
      const writes = ref.drainWriteLog();
      await dbg.seek(calciteTick + 1);
      calciteTick += 1;

      instr++;

      if (instr < flags.skip) continue;

      const cs = await dbg.state();
      const calcR = calciteRegsToStandard(cs);
      // Check memory-write agreement. Only sample up to the first 8
      // write addresses per step to keep the cost bounded — a REP STOSW
      // that writes 64K would otherwise trigger 64K round trips.
      let memDivergence = null;
      if (writes.length > 0) {
        const sample = writes.slice(0, 8);
        // dedupe addresses (STOS writes touch consecutive bytes)
        const addrs = [...new Set(sample.map(w => w.addr))];
        // Read each addr once from calcite to see what it actually holds.
        // Run them serially via read_memory(addr, 1) — cheaper than
        // pulling a big block because most divergences cluster locally.
        for (const addr of addrs) {
          const r = await dbg.memory(addr, 1);
          const calcByte = (r.bytes?.[0] ?? 0) & 0xFF;
          const refByte = ref.mem[addr];
          if (calcByte !== refByte) {
            memDivergence = { addr, ref: refByte, calcite: calcByte };
            break;
          }
        }
      }

      if (!regsMatch(postR, calcR) || memDivergence) {
        const diffs = regDiff(postR, calcR);
        // Decode the instruction that just ran. preR.CS/IP is the ref's
        // state just before stepping, so disassembling there shows what
        // calcite and the ref disagreed on.
        const preLinear = ((preR.CS & 0xFFFF) * 16 + (preR.IP & 0xFFFF)) & 0xFFFFF;
        const instrInfo = disassembleAt(ref.mem, preLinear);
        const rec = {
          instr,
          refTick: instr,
          calciteTick,
          ref: postR,
          calcite: calcR,
          repInfo,
          diffs,
          preRef: preR,
          instruction: {
            linear: preLinear,
            atCS_IP: `${hex(preR.CS)}:${hex(preR.IP)}`,
            name: instrInfo.name,
            opcode: instrInfo.opcodeHex,
            bytes: instrInfo.bytesHex,
            prefixes: instrInfo.prefixesHex || null,
          },
          memDivergence,
          refWrites: writes.slice(0, 8),
        };
        summary.push(rec);
        if (divergedAt == null) divergedAt = instr;
        log(`DIVERGENCE at instr=${instr} (calcTick=${calciteTick}) ${rec.instruction.atCS_IP} ${rec.instruction.name} [${rec.instruction.bytes}]`);
        log(`  regs differ: ${diffs.map(d => d.reg).join(',')}`);
        if (flags.stopAt !== 'all') break;
        if (summary.length >= 20) break;
      }

      if (instr % 500 === 0) {
        const rate = instr / ((performance.now() - t0) / 1000);
        log(`instr=${instr} calcTick=${calciteTick} rate=${rate.toFixed(0)}/s`);
      }
    }

    const wallMs = performance.now() - t0;
    const result = {
      ok: true,
      cabinet: resolve(cssPath),
      instrChecked: instr,
      wallMs: Math.round(wallMs),
      divergedAt,
      divergences: summary,
    };
    if (flags.out) {
      mkdirSync(dirname(resolve(flags.out)), { recursive: true });
      writeFileSync(flags.out, JSON.stringify(result, null, 2));
      log(`wrote ${flags.out}`);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await dbg.close();
  }
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err), stack: err?.stack }) + '\n');
  process.exit(1);
});

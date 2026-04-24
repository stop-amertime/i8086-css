// cabinet-diff.mjs — compare two cabinets tick-by-tick.
//
// "I changed something in kiln, is the output functionally identical?"
// The test: build a cabinet before the change, save it. Make the change,
// build again. Run both through the harness at identical ticks and diff
// register/screen state.
//
// This is complementary to fulldiff: no reference emulator needed. You're
// comparing CALCITE EVAL of two CSS versions, which catches kiln output
// regressions directly. If cabinet-diff says "identical at all sample
// points," your kiln change is functionally neutral.
//
// Caveats:
//   - Framebuffer hashes are exact-match; phash Hamming distance falls
//     back if the exact hash differs. Usually same-build = same bytes.
//   - CSS input bytes differences alone don't imply behaviour differences
//     (re-ordered @property declarations produce the same execution).
//     That's why we sample state, not CSS text.
//   - `sampleTicks` of the form [0, 1000, 10000, 100000] usually suffices.
//     Going finer is fine but slow.

import { createHash } from 'node:crypto';
import { DebuggerClient } from './debugger-client.mjs';
import { shoot } from './shoot.mjs';
import { hammingDistance } from './png.mjs';

function hashRegs(regs) {
  const keys = ['AX','BX','CX','DX','SI','DI','BP','SP','CS','DS','ES','SS','IP'];
  const payload = keys.map(k => `${k}=${regs[k] | 0}`).join(',');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function captureSeries(cssPath, sampleTicks, session) {
  const dbg = await DebuggerClient.spawnChild({ cssPath, session });
  const out = [];
  try {
    for (const t of sampleTicks) {
      await dbg.seek(t);
      const state = await dbg.state();
      const shot = await shoot(dbg);
      out.push({
        tick: t,
        mode: shot.mode,
        phash: shot.phash,
        text: shot.text ?? null,
        regs: {
          AX: state.registers.AX | 0, BX: state.registers.BX | 0,
          CX: state.registers.CX | 0, DX: state.registers.DX | 0,
          SI: state.registers.SI | 0, DI: state.registers.DI | 0,
          BP: state.registers.BP | 0, SP: state.registers.SP | 0,
          CS: state.registers.CS | 0, DS: state.registers.DS | 0,
          ES: state.registers.ES | 0, SS: state.registers.SS | 0,
          IP: state.registers.IP | 0,
        },
        regHash: hashRegs(state.registers),
      });
    }
  } finally {
    await dbg.close();
  }
  return out;
}

export async function cabinetDiff({
  cabinetA,
  cabinetB,
  sampleTicks = [0, 10_000, 50_000, 100_000, 500_000],
  phashTolerance = 4,
} = {}) {
  const [a, b] = await Promise.all([
    captureSeries(cabinetA, sampleTicks, 'diff-a'),
    captureSeries(cabinetB, sampleTicks, 'diff-b'),
  ]);

  const perTick = [];
  for (let i = 0; i < a.length; i++) {
    const ea = a[i], eb = b[i];
    const regsMatch = ea.regHash === eb.regHash;
    const modeMatch = ea.mode === eb.mode;
    const phashMatch = ea.phash === eb.phash;
    const phashDistance = ea.phash && eb.phash ? hammingDistance(ea.phash, eb.phash) : null;
    const phashNear = phashDistance != null && phashDistance <= phashTolerance;
    const textMatch = (ea.text ?? null) === (eb.text ?? null);
    const ok = regsMatch && modeMatch && phashNear && textMatch;
    const rec = { tick: ea.tick, ok, regsMatch, modeMatch, phashMatch, phashDistance, textMatch };
    if (!regsMatch) rec.regDiff = Object.fromEntries(
      Object.keys(ea.regs).filter(k => ea.regs[k] !== eb.regs[k]).map(k => [k, { a: ea.regs[k], b: eb.regs[k] }])
    );
    if (!modeMatch) rec.modeDiff = { a: ea.mode, b: eb.mode };
    if (!phashMatch && !phashNear) rec.phashDiff = { a: ea.phash, b: eb.phash, distance: phashDistance };
    if (!textMatch) rec.textDiff = { a: (ea.text ?? '').slice(0, 120), b: (eb.text ?? '').slice(0, 120) };
    perTick.push(rec);
  }

  const allOk = perTick.every(r => r.ok);
  return { cabinetA, cabinetB, sampleTicks, allOk, perTick };
}

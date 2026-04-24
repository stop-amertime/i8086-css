// coverage.mjs — report which 8086 opcodes a cart actually exercises
// across a run.
//
// Why: "fulldiff passed 5000 instructions" is only reassuring if those
// 5000 instructions exercised the opcodes you're worried about. This
// tool runs the JS reference emulator (no calcite needed, no daemon
// needed, very fast — no cross-machine round trips) and tallies every
// opcode it hits. Output: a count per opcode + a list of never-touched
// opcodes.
//
// Usage:
//   node tests/harness/pipeline.mjs coverage <cabinet>.css --max-ticks=100000

import { loadCabinetSidecars, createRefMachine } from './ref-machine.mjs';
import { opcodeName } from './opcode-names.mjs';

export function computeCoverage({ cssPath, maxTicks = 100_000 }) {
  const sidecars = loadCabinetSidecars(cssPath);
  const ref = createRefMachine(sidecars, {
    initialCS: sidecars.meta.bios.entrySegment,
    initialIP: sidecars.meta.bios.entryOffset,
  });
  // Optional: align from calcite state at tick 0, but for coverage we
  // don't need to — close-enough initial state still exercises ~same
  // opcodes over the run. Keep the dep surface small.

  const counts = new Int32Array(256);
  for (let i = 0; i < maxTicks; i++) {
    const r = ref.regs();
    const linear = ((r.CS & 0xFFFF) * 16 + (r.IP & 0xFFFF)) & 0xFFFFF;
    // Find the primary opcode (skip up to 4 prefix bytes).
    let o = 0, b;
    for (; o < 4; o++) {
      b = ref.mem[(linear + o) & 0xFFFFF] & 0xFF;
      if (b === 0xF0 || b === 0xF2 || b === 0xF3 ||
          b === 0x26 || b === 0x2E || b === 0x36 || b === 0x3E) continue;
      break;
    }
    const op = ref.mem[(linear + o) & 0xFFFFF] & 0xFF;
    counts[op]++;
    ref.step();
  }

  const touched = [];
  const untouched = [];
  for (let op = 0; op < 256; op++) {
    const entry = {
      opcode: op,
      hex: op.toString(16).padStart(2, '0'),
      name: opcodeName(op),
      count: counts[op],
    };
    if (counts[op] > 0) touched.push(entry);
    else untouched.push(entry);
  }
  touched.sort((a, b) => b.count - a.count);
  return {
    cssPath,
    ticksExamined: maxTicks,
    distinctOpcodes: touched.length,
    top20: touched.slice(0, 20),
    touched,
    untouched,
  };
}

// oracles.mjs — unified register-snapshot-producing interface over every
// execution backend we can run a cabinet against.
//
// An oracle is anything that, given a tick number, tells us the 8086
// register state. Different oracles answer different questions:
//
//   calcite-compiled     : the bytecode fast-path. What real users see.
//   calcite-interpreted  : the Expr-tree reference, same tick input but
//                          slower and tree-walked. If it disagrees with
//                          compiled, the bug is in calcite's compile.rs.
//   calcite-cli-fresh    : a separate `calcite-cli --trace-json` run from
//                          tick 0. Catches bugs that only appear with
//                          cold state (incremental-eval corruption).
//   ref-js8086           : the JS reference emulator with real hardware
//                          semantics (PIC/PIT). Ground truth for what the
//                          CPU should do. Disagreement with *both* calcite
//                          paths means the CSS has a bug; calcite is
//                          correctly evaluating wrong CSS.
//   chrome-player        : Playwright drives the web player, we read the
//                          framebuffer. True CSS ground truth. Slow.
//                          Sparse — use for a handful of milestones, not
//                          tick-by-tick.
//
// Each oracle exposes the same small interface:
//
//   async open()              — prepare (spawn child, load cabinet, etc.)
//   async seekTo(tick)        — land the oracle at the given tick
//   async snapshot()          — return normalized register object
//   async close()             — free resources
//
// Oracles share the standardized 14-key register shape from fulldiff:
// { AX, BX, CX, DX, SI, DI, BP, SP, CS, DS, ES, SS, IP, FLAGS }.

import { DebuggerClient } from './debugger-client.mjs';
import { loadCabinetSidecars, createRefMachine } from './ref-machine.mjs';

// --- Register shape helpers ----------------------------------------------

const REG_KEYS = ['AX','BX','CX','DX','SI','DI','BP','SP','CS','DS','ES','SS','IP','FLAGS'];

export function regsEqual(a, b) {
  for (const k of REG_KEYS) if ((a[k] | 0) !== (b[k] | 0)) return false;
  return true;
}

export function regsDiff(a, b) {
  const diffs = [];
  for (const k of REG_KEYS) {
    const av = a[k] | 0, bv = b[k] | 0;
    if (av !== bv) diffs.push({ reg: k, a: av, b: bv });
  }
  return diffs;
}

function assembleFlags(r) {
  if (typeof r.flags === 'number' && r.flags !== 0) return r.flags;
  return (r._cf ? 1 : 0) | 2
       | (r._pf ? 4 : 0) | (r._af ? 0x10 : 0) | (r._zf ? 0x40 : 0)
       | (r._sf ? 0x80 : 0) | (r._tf ? 0x100 : 0) | (r._ifFlag ? 0x200 : 0)
       | (r._df ? 0x400 : 0) | (r._of ? 0x800 : 0);
}

function calciteRegsNormalise(regs) {
  return {
    AX: regs.AX | 0, BX: regs.BX | 0, CX: regs.CX | 0, DX: regs.DX | 0,
    SI: regs.SI | 0, DI: regs.DI | 0, BP: regs.BP | 0, SP: regs.SP | 0,
    CS: regs.CS | 0, DS: regs.DS | 0, ES: regs.ES | 0, SS: regs.SS | 0,
    IP: regs.IP | 0, FLAGS: assembleFlags(regs),
  };
}

// --- Calcite-compiled oracle ---------------------------------------------

export class CalciteCompiledOracle {
  constructor({ cssPath, session = 'oracle-compiled' }) {
    this.cssPath = cssPath;
    this.session = session;
    this.dbg = null;
  }
  get name() { return 'calcite-compiled'; }
  async open() {
    this.dbg = await DebuggerClient.spawnChild({ cssPath: this.cssPath, session: this.session });
  }
  async seekTo(tick) { await this.dbg.seek(tick); }
  async snapshot() {
    const state = await this.dbg.state();
    return { tick: state.tick, regs: calciteRegsNormalise(state.registers ?? {}) };
  }
  async close() { if (this.dbg) await this.dbg.close(); }
}

// --- Compiled-vs-interpreted at-tick consistency -------------------------
//
// This is NOT a stream oracle — it reports per-tick self-consistency using
// compare_paths. The interpreted path isn't advanced independently by the
// debugger, so a clean "interp session at tick N" isn't accessible. What
// we CAN do is: land on tick N via the compiled path, then ask the server
// to run one tick through the interpreter and report every property that
// disagrees. If compiled and interp disagree, there's a bytecode bug in
// whatever op retired during tick N.
//
// Use this when fulldiff says "calcite-vs-ref disagrees at tick N" — this
// tells you whether the N-th tick's computation was evaluated differently
// by the two calcite paths (pointing at compile.rs), or whether both paths
// agree and the bug is upstream of calcite (pointing at CSS / kiln).
// The canonical 8086 state vars (i.e. real registers + flags). `property_diffs`
// mixes in internal scaffolding (like `--_sAX`, `--_strSrcSeg`) that the
// interpreter doesn't pre-compute the same way the compiled pass does;
// those diffs are architectural, not bugs. For triage we only care about
// the state-var diffs — a disagreement there is always a real compile.rs
// vs interpreter bug.
const CANONICAL_STATE_VARS = new Set([
  'AX','BX','CX','DX','SI','DI','BP','SP','CS','DS','ES','SS','IP','FLAGS',
  'AH','AL','BH','BL','CH','CL','DH','DL','flags',
  '_cf','_pf','_af','_zf','_sf','_tf','_df','_of','_ifFlag',
]);

export async function runCompareAtTick(cssPath, tick, { session = 'consistency' } = {}) {
  const dbg = await DebuggerClient.spawnChild({ cssPath, session });
  try {
    await dbg.seek(tick);
    const cp = await dbg.comparePaths();
    // Filter register_diffs to canonical state vars only.
    const canonicalDiffs = (cp.register_diffs ?? []).filter(d =>
      CANONICAL_STATE_VARS.has(d.property) || CANONICAL_STATE_VARS.has(d.property.replace(/^--/, '')));
    return {
      tick: cp.tick,
      totalDiffs: cp.total_diffs,
      canonicalStateDiffs: canonicalDiffs,
      // Keep raw for inspection.
      registerDiffs: cp.register_diffs ?? [],
      propertyDiffs: cp.property_diffs ?? [],
      memoryDiffs: cp.memory_diffs ?? [],
      verdict: canonicalDiffs.length === 0
        ? 'self-consistent'     // compile.rs is fine for this tick
        : 'compiler-bug',       // compile.rs disagrees with interp on canonical regs
    };
  } finally {
    await dbg.close();
  }
}

// --- JS reference emulator oracle ----------------------------------------

export class RefMachineOracle {
  constructor({ cssPath }) {
    this.cssPath = cssPath;
    this.sidecars = null;
    this.machine = null;
    this.currentInstr = 0;
    this.lastSnapshot = null;
  }
  get name() { return 'ref-js8086'; }
  async open() {
    this.sidecars = loadCabinetSidecars(this.cssPath);
    this.machine = createRefMachine(this.sidecars, {
      initialCS: this.sidecars.meta.bios.entrySegment,
      initialIP: this.sidecars.meta.bios.entryOffset,
    });
    this.currentInstr = 0;
  }
  // "Tick" in the ref-machine context == one instruction, matching
  // calcite V4's single-cycle model. seekTo walks forward from current
  // position; seeking backward is unsupported (reopen to reset).
  async seekTo(tick) {
    if (tick < this.currentInstr) {
      // Have to start from scratch for back-seeks.
      this.machine = createRefMachine(this.sidecars, {
        initialCS: this.sidecars.meta.bios.entrySegment,
        initialIP: this.sidecars.meta.bios.entryOffset,
      });
      this.currentInstr = 0;
    }
    while (this.currentInstr < tick) {
      this.machine.step();
      this.currentInstr++;
    }
  }
  async snapshot() {
    return { tick: this.currentInstr, regs: this.machine.regs() };
  }
  // Convenience: align initial registers from a calcite snapshot so the
  // ref reflects kiln's pre-populated state (SP, SS, etc).
  alignWith(calciteRegs) {
    this.machine.applyRegs(calciteRegs);
  }
  async close() { /* nothing to close — GC handles it */ }
}

// --- Multi-oracle runner --------------------------------------------------

// Triage driver: run fulldiff-style calcite-vs-ref streaming and, if it
// finds a divergence, emit a clean report with the first-divergence tick
// plus enough context to act.
//
// Originally this tried to cross-check with compare_paths to classify
// "compiler bug" vs "CSS bug" — but compare_paths after a seek doesn't
// give reliable results (the interp path's intermediate scaffolding
// isn't evolved alongside compiled during seek). Until the debugger
// grows a real "run interp from 0 to N and snapshot" endpoint, that
// classification isn't trustworthy. So for now we just hand the agent
// the divergence point with clearly-actionable next steps.
export async function triageDivergence({
  cssPath,
  maxTicks = 10_000,
} = {}) {
  const { spawnSync } = await import('node:child_process');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, [
    resolve(__dirname, '..', 'fulldiff.mjs'),
    cssPath, `--max-ticks=${maxTicks}`,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    return { verdict: 'fulldiff-failed', stderr: r.stderr, stdout: r.stdout };
  }
  const stream = JSON.parse(r.stdout.trim().split('\n').at(-1));
  if (!stream.divergedAt) {
    return { verdict: 'no-divergence', ticksChecked: stream.instrChecked };
  }
  const div = stream.divergences[0];
  return {
    verdict: 'divergence-found',
    divergenceTick: stream.divergedAt,
    streamDivergence: div,
    nextSteps: [
      `1. Inspect the instruction at CS:IP = ${hexs(div.preRef.CS)}:${hexs(div.preRef.IP)} in the ref emulator just before divergence.`,
      `2. Look at the ref's CS:IP to find the opcode. The REF sees bytes at CS*16+IP in the cabinet's BIOS/kernel/disk sidecar.`,
      `3. If the diff is in decoding-related registers (opcode/mod/reg/rm), bug is in kiln emitter for that opcode.`,
      `4. If the diff is in a single arithmetic register (AX/BX/CX/DX + flags), bug is in the ALU / shift / string op path.`,
      `5. Run 'node tests/harness/pipeline.mjs shoot <cabinet> --tick=${stream.divergedAt}' to eyeball the video state at divergence.`,
    ],
  };
}

function hexs(v, w = 4) { return (v | 0).toString(16).padStart(w, '0'); }

// Pairwise first-divergence finder. Takes N oracles, advances them in
// lockstep up to maxTicks, reports the first tick at which any two
// disagree AND which pair disagreed AND on which registers.
//
// Every oracle is stepped to every sampled tick. If maxTicks is huge and
// you only care about a few sample points, use `sampleTicks` instead.
export async function findFirstDivergence({
  oracles,
  maxTicks = 5000,
  sampleTicks = null,     // array of ticks to check, overrides maxTicks loop
  onProgress = null,
  alignRefToCalcite = true,
}) {
  if (oracles.length < 2) throw new Error('findFirstDivergence needs at least 2 oracles');

  for (const o of oracles) await o.open();

  // Optional: align any ref oracle with calcite's starting regs. Kiln
  // pre-populates SP/SS from the cabinet header so the JS ref
  // otherwise diverges at tick 0.
  if (alignRefToCalcite) {
    const calcite = oracles.find(o => o.name.startsWith('calcite-'));
    const ref = oracles.find(o => o.name === 'ref-js8086');
    if (calcite && ref) {
      await calcite.seekTo(0);
      const s0 = await calcite.snapshot();
      ref.alignWith(s0.regs);
    }
  }

  const ticksToCheck = sampleTicks ?? (() => {
    const arr = [];
    for (let i = 1; i <= maxTicks; i++) arr.push(i);
    return arr;
  })();

  const summary = { checked: 0, divergedAt: null, pair: null, diffs: null };
  for (const tick of ticksToCheck) {
    for (const o of oracles) await o.seekTo(tick);
    const snaps = [];
    for (const o of oracles) snaps.push({ name: o.name, ...(await o.snapshot()) });
    summary.checked = tick;
    // pairwise compare
    for (let i = 0; i < snaps.length; i++) {
      for (let j = i + 1; j < snaps.length; j++) {
        if (!regsEqual(snaps[i].regs, snaps[j].regs)) {
          summary.divergedAt = tick;
          summary.pair = [snaps[i].name, snaps[j].name];
          summary.diffs = regsDiff(snaps[i].regs, snaps[j].regs);
          summary.snapshots = snaps;
          for (const o of oracles) await o.close();
          return summary;
        }
      }
    }
    if (onProgress && tick % 100 === 0) onProgress({ tick, snaps });
  }
  for (const o of oracles) await o.close();
  return summary;
}

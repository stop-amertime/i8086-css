// Top-level CSS generation orchestrator.
// Collects dispatch entries from all opcode emitters, assembles per-register
// dispatch tables, and combines with infrastructure (clock, memory, decode).

import { emitCSSLib } from './css-lib.mjs';
import { emitDecodeFunction, emitDecodeProperties } from './decode.mjs';
import {
  emitPropertyDecls, emitBufferReads, emitRegisterAliases,
  emitStoreKeyframe, emitExecuteKeyframe, emitClockKeyframes,
  emitClockAndCpuBase, emitDebugDisplay,
  emitKeyboardRules,
} from './template.mjs';
import { emitWriteSlotProperties, buildInitialMemory, buildAddressSet, NUM_WRITE_SLOTS,
         PACK_SIZE, buildCellSet, buildInitialMemoryPacked, cellIdxOf, cellOffOf } from './memory.mjs';
import { emitFlagFunctions } from './patterns/flags.mjs';

// Opcode emitters
import { emitMOV_RegImm16, emitMOV_RegImm8, emitMOV_RegRM, emitMOV_SegRM, emitMOV_AccMem, emitLEA, emitLES, emitLDS } from './patterns/mov.mjs';
import { emitAllALU } from './patterns/alu.mjs';
import { emitAllControl } from './patterns/control.mjs';
import { emitAllStack } from './patterns/stack.mjs';
import { emitAllMisc, emitPeripheralCompute, emitIRQCompute, pitCounterDefaultExpr, picPendingDefaultExpr } from './patterns/misc.mjs';
import { emitAllGroups } from './patterns/group.mjs';
import { emitAllShifts, emitShiftFlagFunctions, emitShiftByNFlagFunctions } from './patterns/shift.mjs';
import { emitAll186 } from './patterns/extended186.mjs';
import { emitCycleCounts } from './cycle-counts.mjs';

/**
 * Dispatch table builder. Collects per-register entries keyed by opcode.
 */
class DispatchTable {
  constructor() {
    // regEntries: Map<regName, Map<opcode, {expr, comment}>>
    this.regEntries = new Map();
    // memWrites: [{opcode, addrExpr, valExpr, comment}]
    // Each opcode can contribute to up to 3 write slots.
    this.memWritesByOpcode = new Map(); // opcode → [{addrExpr, valExpr, comment}]
  }

  addEntry(reg, opcode, expr, comment = '') {
    if (!this.regEntries.has(reg)) {
      this.regEntries.set(reg, new Map());
    }
    const regMap = this.regEntries.get(reg);
    if (regMap.has(opcode)) {
      // Multiple emitters writing the same register for same opcode
      // — this is an error in the emitter logic.
      throw new Error(`Duplicate dispatch entry: ${reg} opcode 0x${opcode.toString(16)} — existing: ${regMap.get(opcode).comment}, new: ${comment}`);
    }
    // For flags: ALU flag functions build flags from scratch but must preserve
    // TF/IF/DF (bits 8-10) from the previous tick. Instructions that DO modify
    // these bits (STI/CLI/CLD/STD/INT/IRET/POPF) already set them explicitly.
    // AF (bit 4) is computed by the flag functions themselves for ADD/SUB/etc.
    // TF|IF|DF (bits 8-10) preservation is handled at each call site or inside the
    // flag functions themselves (inc/dec). No automatic wrapper — it breaks mixed
    // dispatches that have both flag-computing and passthrough branches.
    regMap.set(opcode, { expr, comment });
  }

  /**
   * Emit --unknownOp: 1 if the current opcode has no IP dispatch entry, 0 otherwise.
   * Prefixes (0x26/0x2E/0x36/0x3E/0xF2/0xF3) are excluded — they're handled at decode level.
   */
  emitUnknownOpFlag() {
    const ipEntries = this.regEntries.get('IP');
    if (!ipEntries) return '  --unknownOp: 1;';
    const opcodes = [...ipEntries.keys()].sort((a, b) => a - b);
    const lines = ['  --unknownOp: if('];
    for (const op of opcodes) {
      lines.push(`    style(--opcode: ${op}): 0;`);
    }
    lines.push('  else: 1);');
    return lines.join('\n');
  }

  addMemWrite(opcode, addrExpr, valExpr, comment = '') {
    if (!this.memWritesByOpcode.has(opcode)) {
      this.memWritesByOpcode.set(opcode, []);
    }
    this.memWritesByOpcode.get(opcode).push({ addrExpr, valExpr, comment, width: 1 });
  }

  /**
   * Declare a 16-bit word write at runtime byte-address `addrExpr` with
   * value `wordValExpr` (the un-split word; lo lands at addrExpr, hi at
   * addrExpr+1). Allocates one width=2 slot, regardless of the surface
   * shape of valExpr — this is the explicit alternative to the regex-based
   * fusion in emitMemoryWriteSlots, used when the value/addr expressions
   * are structurally a top-level if(...) and don't pattern-match the
   * canonical --lowerBytes/--rightShift split.
   */
  addMemWriteWord(opcode, addrExpr, wordValExpr, comment = '') {
    if (!this.memWritesByOpcode.has(opcode)) {
      this.memWritesByOpcode.set(opcode, []);
    }
    this.memWritesByOpcode.get(opcode).push({ addrExpr, valExpr: wordValExpr, comment, width: 2 });
  }

  /**
   * Emit the dispatch table for one register as a CSS if() expression.
   * Returns the full property declaration for inside .cpu.
   *
   * For IP: wraps the entire dispatch in calc(... + var(--prefixLen)) so that
   * all instruction IP calculations automatically account for prefix bytes
   * (segment overrides, REP) without changing each individual emitter.
   */
  emitRegisterDispatch(reg, defaultExpr) {
    const entries = this.regEntries.get(reg);
    const hasEntries = entries && entries.size > 0;

    // Build the normal instruction dispatch.
    const wrapIP = (reg === 'IP');
    let normalExpr;
    if (!hasEntries) {
      // No dispatch entries -> the "normal path" is just the default.
      // We still wrap with TF/IRQ overrides below so interrupt delivery can
      // override registers that only have custom-default behavior (e.g.
      // picPending latches edges by default but clears --_irqBit on ack).
      // IP always has entries so prefixLen wrapping doesn't apply here.
      normalExpr = defaultExpr;
    } else {
      const dispatchLines = [];
      const sorted = [...entries.entries()].sort(([a], [b]) => a - b);
      for (const [opcode, { expr, comment }] of sorted) {
        const commentStr = comment ? ` /* ${comment} */` : '';
        dispatchLines.push(`    style(--opcode: ${opcode}): ${expr};${commentStr}`);
      }
      if (wrapIP) {
        normalExpr = `calc(if(\n${dispatchLines.join('\n')}\n  else: ${defaultExpr}) + var(--prefixLen))`;
      } else {
        normalExpr = `if(\n${dispatchLines.join('\n')}\n  else: ${defaultExpr})`;
      }
    }

    // TF (Trap Flag) override: when previous FLAGS had TF=1, fire INT 1 instead
    // of the normal instruction. INT 1: push FLAGS/CS/IP, clear TF+IF, jump to IVT[1].
    const TF_OVERRIDES = {
      'IP':    'var(--_tfIP)',
      'CS':    'var(--_tfCS)',
      'SP':    'calc(var(--__1SP) - 6)',
      'flags': '--and(var(--__1flags), 64767)',  // & 0xFCFF = clear TF+IF
    };

    // IRQ override: when --_irqActive fires (unmasked pending IRQ with IF set
    // and no in-service IRQ), deliver the interrupt instead of the instruction
    // fetched from memory. Identical push shape to TF/INT (FLAGS/CS/IP), but
    // the vector comes from --picVector (8 or 9 for IRQ 0 / IRQ 1) and retIP
    // is the current __1IP (no instruction consumed). cycleCount += 61 matches
    // the real 8086 hardware-interrupt cost. picPending clears the acknowledged
    // bit (while still latching any new edges); picInService sets it so that
    // lower-priority IRQs block until EOI.
    const IRQ_OVERRIDES = {
      'SP':       'calc(var(--__1SP) - 6)',
      'IP':       '--read2(calc(var(--picVector) * 4))',
      'CS':       '--read2(calc(var(--picVector) * 4 + 2))',
      'flags':    '--and(var(--__1flags), 64767)',
      'cycleCount': 'calc(var(--__1cycleCount) + 61)',
      'picPending': `--and(${/* edge-OR applied so concurrent edges don't get dropped */''}--or(--or(var(--__1picPending), var(--_pitFired)), calc(var(--_kbdEdge) * 2)), --not(var(--_irqBit)))`,
      'picInService': '--or(var(--__1picInService), var(--_irqBit))',
    };

    const tfExpr = TF_OVERRIDES[reg] || `var(--__1${reg})`;
    const irqExpr = IRQ_OVERRIDES[reg] || `var(--__1${reg})`;
    return `  --${reg}: if(style(--_tf: 1): ${tfExpr}; style(--_irqActive: 1): ${irqExpr}; else: ${normalExpr});`;
  }

  /**
   * Emit the 3 memory write slot properties (--memAddr0/Val0 through
   * --memAddr2/Val2). Width is supplied globally by --_writeWidth (see
   * emitWriteWidthGate), not per-slot.
   *
   * Each slot fuses an addr/addr+1 byte-write pair (lo + hi) into a single
   * 16-bit word slot when possible. The detection looks for the canonical
   * pair shape that addMemWrite call sites emit:
   *   addMemWrite(opcode, addr,     '--lowerBytes(X, 8)', 'lo')
   *   addMemWrite(opcode, addr + 1, '--rightShift(X, 8)', 'hi')
   * Both halves must reference the same value expression X. When both
   * conditions hold, the pair becomes one width=2 slot whose --memValN is
   * X (the un-split word). Otherwise each addMemWrite uses one width=1
   * slot whose --memValN is the byte expression.
   *
   * Worst case: INT pushes FLAGS/CS/IP = 3 word writes = 3 width-2 slots.
   *
   * Slot 0 is the outermost in the cell cascade so it wins on collisions.
   * For multi-slot opcodes the call order determines which slot carries
   * which pair — slot 0 first, then slot 1, then slot 2. Multi-pair
   * opcodes (like INT) whose pairs must all execute in one tick can rely
   * on the slot order matching call order.
   */
  emitMemoryWriteSlots() {
    // Phase 1: fuse adjacent (addr, lo) / (addr+1, hi) pairs into width=2 slots.
    // Each opcode's `writes` is the call-order list from addMemWrite /
    // addMemWriteWord. Writes already declared as width=2 (via
    // addMemWriteWord) bypass regex fusion. Width=1 writes are
    // pair-detected against their immediate successor; on match, the pair
    // collapses into one width=2 slot.
    const fusedByOpcode = new Map();
    for (const [opcode, writes] of this.memWritesByOpcode) {
      const fused = [];
      let i = 0;
      while (i < writes.length) {
        const cur = writes[i];
        if (cur.width === 2) {
          fused.push(cur);
          i += 1;
          continue;
        }
        const next = writes[i + 1];
        const pair = (next && next.width === 1) ? tryFuseWordPair(cur, next) : null;
        if (pair) {
          fused.push(pair);
          i += 2;
        } else {
          fused.push({ width: 1, addrExpr: cur.addrExpr, valExpr: cur.valExpr, comment: cur.comment });
          i += 1;
        }
      }
      if (fused.length > NUM_WRITE_SLOTS) {
        throw new Error(`Opcode 0x${opcode.toString(16)} uses ${fused.length} memory write slots after fusion (max ${NUM_WRITE_SLOTS})`);
      }
      fusedByOpcode.set(opcode, fused);
    }

    const slots = Array.from({ length: NUM_WRITE_SLOTS }, () => []);
    for (const [opcode, fused] of fusedByOpcode) {
      for (let i = 0; i < fused.length; i++) {
        slots[i].push({ opcode, ...fused[i] });
      }
    }
    // Stash per-slot {opcode, width} lists so emitSlotLiveGates / emitSlotWidthGates
    // can emit the corresponding dispatches.
    this._slotMeta = slots.map(entries => entries.map(e => ({ opcode: e.opcode, width: e.width })));

    // TF trap and IRQ delivery both push FLAGS/CS/IP — three word-aligned
    // pushes. Each lands in one width=2 slot. Stack is always even-aligned
    // (SP starts even, decrements by 2) so no straddle here.
    const ssBase = 'calc(var(--__1SS) * 16)';
    // Wrap SP-K to 16 bits — without this, IRQ/TF push at SP=0 lands one
    // segment too low (SS:0xFFFE != SS-1:0xFFFE). Same fix as PUSH/CALL/INT
    // in kiln/patterns/{stack,control,misc,group}.mjs.
    const sa = (k) => `calc(${ssBase} + --lowerBytes(calc(var(--__1SP) - ${k} + 65536), 16))`;
    const intAddr = [
      sa(2),   // slot 0: FLAGS at SP-2..SP-1
      sa(4),   // slot 1: CS at SP-4..SP-3
      sa(6),   // slot 2: IP at SP-6..SP-5
    ];
    const intVal = [
      `var(--__1flags)`,
      `var(--__1CS)`,
      `var(--__1IP)`,
    ];

    const lines = [];
    for (let slot = 0; slot < NUM_WRITE_SLOTS; slot++) {
      lines.push(`  --memAddr${slot}: if(`);
      lines.push(`    style(--_tf: 1): ${intAddr[slot]};`);
      lines.push(`    style(--_irqActive: 1): ${intAddr[slot]};`);
      for (const { opcode, addrExpr, comment } of slots[slot]) {
        lines.push(`    style(--opcode: ${opcode}): ${addrExpr}; /* ${comment || ''} */`);
      }
      lines.push(`  else: -1);`);

      lines.push(`  --memVal${slot}: if(`);
      lines.push(`    style(--_tf: 1): ${intVal[slot]};`);
      lines.push(`    style(--_irqActive: 1): ${intVal[slot]};`);
      for (const { opcode, valExpr, comment } of slots[slot]) {
        lines.push(`    style(--opcode: ${opcode}): ${valExpr}; /* ${comment || ''} */`);
      }
      lines.push(`  else: 0);`);
    }

    return lines.join('\n');
  }

  /**
   * Emit --_slot0Live through --_slot{N}Live: 1 on ticks where the slot is
   * used, 0 otherwise. Used to gate the per-byte memory write rules so
   * non-writing instructions skip all address checks.
   *
   * TF trap and hardware IRQ push the 3 FLAGS/CS/IP words, so they force
   * all three slots live.
   *
   * emitMemoryWriteSlots() must be called before this so _slotMeta is populated.
   */
  emitSlotLiveGates() {
    if (!this._slotMeta) {
      throw new Error('emitMemoryWriteSlots must be called before emitSlotLiveGates');
    }
    const lines = ['  /* Slot-live gates — skip per-byte memory write checks when no slot fires this tick */'];
    for (let slot = 0; slot < NUM_WRITE_SLOTS; slot++) {
      const meta = this._slotMeta[slot];
      const branches = [];
      // TF trap and IRQ delivery push FLAGS/CS/IP — all slots live.
      branches.push(`    style(--_tf: 1): 1;`);
      branches.push(`    style(--_irqActive: 1): 1;`);
      for (const { opcode } of meta) {
        branches.push(`    style(--opcode: ${opcode}): 1;`);
      }
      lines.push(`  --_slot${slot}Live: if(`);
      lines.push(branches.join('\n'));
      lines.push(`  else: 0);`);
    }
    return lines.join('\n');
  }

  /**
   * Emit --_slot{N}Width: per-tick 1 or 2 indicating whether this slot
   * writes a single byte or a (lo, hi) word pair. Default is 1 — only
   * opcodes that produced a fused pair set width to 2 for that slot.
   * TF trap and IRQ delivery use 3 word-aligned writes (width=2 on all slots).
   */
  /**
   * Emit a single global --_writeWidth gate.
   *
   * In practice no opcode the kiln currently emits *mixes* byte and word
   * writes within one tick — every opcode is either purely byte (STOSB,
   * single-byte MOV/XCHG, OUT to DAC, etc.) or purely word (PUSH, CALL,
   * INT, IRQ frame, word MOV/XCHG/POP). One per-tick width fits all
   * existing instructions, and saves N-1 width dispatches and N-1 slot
   * reads per tick compared to per-slot widths.
   *
   * If a future opcode wants to mix widths in a single tick, it must
   * either split across two ticks or this design needs to grow back to
   * per-slot widths. The kiln will throw if multi-width opcodes appear
   * (see check below).
   *
   * Width = 2 fires when ANY slot for the active opcode (or TF/IRQ) is
   * width=2. The splice path treats every active slot uniformly under
   * that width.
   */
  emitWriteWidthGate() {
    if (!this._slotMeta) {
      throw new Error('emitMemoryWriteSlots must be called before emitWriteWidthGate');
    }
    // Collect every opcode that has any width=2 slot. Cross-check that
    // it doesn't ALSO have a width=1 slot — that would mean the opcode
    // mixes widths in one tick, which the global-width design can't
    // express. (No kiln opcode does this today; the check is to fail
    // fast if a future emitter accidentally introduces one.)
    const widthByOpcode = new Map(); // opcode → Set<width>
    for (let slot = 0; slot < NUM_WRITE_SLOTS; slot++) {
      for (const { opcode, width } of this._slotMeta[slot]) {
        if (!widthByOpcode.has(opcode)) widthByOpcode.set(opcode, new Set());
        widthByOpcode.get(opcode).add(width);
      }
    }
    const wordOpcodes = [];
    for (const [opcode, widths] of widthByOpcode) {
      if (widths.has(1) && widths.has(2)) {
        // Diagnostic: dump per-slot widths for the offending opcode.
        const perSlot = [];
        for (let slot = 0; slot < NUM_WRITE_SLOTS; slot++) {
          for (const e of this._slotMeta[slot]) {
            if (e.opcode === opcode) perSlot.push(`slot${slot}=w${e.width}`);
          }
        }
        throw new Error(
          `Opcode 0x${opcode.toString(16)} mixes byte and word writes in one tick — ` +
          `${perSlot.join(', ')}. The global --_writeWidth design can't express this. ` +
          `Either split the opcode across ticks or restore per-slot widths.`
        );
      }
      if (widths.has(2)) wordOpcodes.push(opcode);
    }
    wordOpcodes.sort((a, b) => a - b);

    const lines = ['  /* Global write-width gate — 1=byte, 2=word (addr+1 carries hi byte). Shared across slots. */'];
    const branches = [];
    branches.push(`    style(--_tf: 1): 2;`);
    branches.push(`    style(--_irqActive: 1): 2;`);
    for (const op of wordOpcodes) {
      branches.push(`    style(--opcode: ${op}): 2;`);
    }
    lines.push(`  --_writeWidth: if(`);
    lines.push(branches.join('\n'));
    lines.push(`  else: 1);`);
    return lines.join('\n');
  }
}

/**
 * Try to fuse two consecutive memory writes into one width=2 slot.
 * Returns a fused descriptor `{width:2, addrExpr, valExpr, comment}` or null.
 *
 * Pair criteria — the canonical lo/hi shape addMemWrite call sites emit:
 *   lo: addrExpr=A,           valExpr='--lowerBytes(X, 8)'
 *   hi: addrExpr=A+1,         valExpr='--rightShift(X, 8)'
 * Also handles the dispatch-conditional shape:
 *   lo: 'if(style(--reg: 0): --lowerBytes(X0, 8); style(--reg: 1): --lowerBytes(X1, 8); ... else: 0)'
 *   hi: 'if(style(--reg: 0): --rightShift(X0, 8); style(--reg: 1): --rightShift(X1, 8); ... else: 0)'
 * — same dispatch keys, paired --lowerBytes/--rightShift over the same word X.
 *
 * The fused slot's value is X (or the dispatch over X-values, with
 * --lowerBytes/--rightShift wrappers stripped). The CSS write-side splits
 * the word back into lo at A and hi at A+1 either via --applySlot (packed)
 * or the per-byte write rule (unpacked).
 */
function tryFuseWordPair(lo, hi) {
  // Address criterion: hi.addrExpr must be the byte-after lo.addrExpr.
  if (!isAddrPlusOne(lo.addrExpr, hi.addrExpr)) return null;

  const wordVal = fuseWordVal(lo.valExpr, hi.valExpr);
  if (wordVal == null) return null;

  return {
    width: 2,
    addrExpr: lo.addrExpr,
    valExpr: wordVal,
    comment: lo.comment ? lo.comment.replace(/\s*lo\s*$/i, '').trim() : '',
  };
}

/**
 * Given paired lo/hi value expressions, return the fused un-split word
 * expression, or null if they don't match.
 *
 * Direct case:
 *   lo='--lowerBytes(X, 8)', hi='--rightShift(X, 8)' → returns X
 *
 * Dispatch case:
 *   lo='if(<branchKey>: --lowerBytes(Xn, 8); ... else: 0)'
 *   hi='if(<branchKey>: --rightShift(Xn, 8); ... else: 0)'
 *   → returns 'if(<branchKey>: Xn; ... else: 0)' if every branch pairs cleanly.
 */
function fuseWordVal(loVal, hiVal) {
  // Direct shape.
  const direct = matchLoHiPair(loVal, hiVal);
  if (direct != null) return direct;

  // Dispatch shape: parse both as `if(<branches>; else: 0)`.
  const loBr = parseIfBranches(loVal);
  const hiBr = parseIfBranches(hiVal);
  if (!loBr || !hiBr) return null;
  if (loBr.branches.length !== hiBr.branches.length) return null;
  if (loBr.fallback !== '0' || hiBr.fallback !== '0') return null;
  // Each pair of corresponding branches must share the same condition AND
  // pair as --lowerBytes/--rightShift over the same word.
  const fusedBranches = [];
  for (let i = 0; i < loBr.branches.length; i++) {
    const lb = loBr.branches[i];
    const hb = hiBr.branches[i];
    if (lb.cond !== hb.cond) return null;
    const word = matchLoHiPair(lb.body, hb.body);
    if (word == null) return null;
    fusedBranches.push({ cond: lb.cond, body: word });
  }
  return `if(${fusedBranches.map(b => `${b.cond}: ${b.body}`).join('; ')}; else: 0)`;
}

/**
 * Match the canonical (--lowerBytes(X, 8), --rightShift(X, 8)) pair.
 * Returns X if both expressions reference the same X, else null.
 */
function matchLoHiPair(loVal, hiVal) {
  const loMatch = /^--lowerBytes\((.+),\s*8\)$/.exec(loVal);
  const hiMatch = /^--rightShift\((.+),\s*8\)$/.exec(hiVal);
  if (!loMatch || !hiMatch) return null;
  // Allow the hi expression to be `--rightShift(--lowerBytes(X, 16), 8)` —
  // some pattern files (Group FF reg=0/1) double-wrap to keep the result
  // inside i32 even when X arithmetic could overflow. The lo form is
  // `--lowerBytes(X, 8)`; the matching hi keeps the same X.
  const hiX = hiMatch[1];
  const hiInnerMatch = /^--lowerBytes\((.+),\s*16\)$/.exec(hiX);
  const hiNormalised = hiInnerMatch ? hiInnerMatch[1] : hiX;
  if (loMatch[1] !== hiNormalised) return null;
  return loMatch[1];
}

/**
 * Parse an `if(<branches>; else: <fallback>)` expression into its parts.
 * Returns `{ branches: [{cond, body}], fallback }` or null if the shape
 * doesn't match.
 *
 * The parser is paren-counting (not regex) because branch bodies routinely
 * contain nested if(...) and calc(...) expressions.
 */
function parseIfBranches(expr) {
  const m = /^if\((.*)\)$/s.exec(expr);
  if (!m) return null;
  const inner = m[1];
  const parts = splitTopLevel(inner, ';');
  if (parts.length < 2) return null;
  // Last part is `else: <fallback>`.
  const last = parts[parts.length - 1].trim();
  const elseMatch = /^else:\s*(.+)$/s.exec(last);
  if (!elseMatch) return null;
  const fallback = elseMatch[1].trim();
  const branches = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i].trim();
    // Branch shape: `<cond>: <body>` where cond is `style(...)` or `style(...) and style(...)` etc.
    // Find the *outer* `:` separating cond from body.
    const colonIdx = findTopLevelColon(p);
    if (colonIdx < 0) return null;
    const cond = p.slice(0, colonIdx).trim();
    const body = p.slice(colonIdx + 1).trim();
    branches.push({ cond, body });
  }
  return { branches, fallback };
}

/**
 * Split `s` at top-level occurrences of `sep` (paren-counting).
 */
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === sep) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * Find the index of the first top-level `:` in `s` (paren-counting).
 */
function findTopLevelColon(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === ':') return i;
  }
  return -1;
}

/**
 * True iff `hi` is the byte-after-`lo` address expression. Recognises the
 * common shapes the pattern files use:
 *   stack: sa(K) and sa(K-1)              — lo at SP-K, hi at SP-(K-1)
 *   ea-based: var(--ea) and calc(var(--ea) + 1)
 *   ES:DI with offset: ...DI) and ...DI + 1)
 *   dispatch-conditional (Group 0xFF): if(<branchKey>: <addr>; ... else: -1)
 *     paired branch-by-branch with hi at addr+1, both fallback to -1.
 */
function isAddrPlusOne(loAddr, hiAddr) {
  if (loAddr === hiAddr) return false;

  if (isAddrPlusOneAtomic(loAddr, hiAddr)) return true;

  // Dispatch-conditional shape: both lo and hi are
  //   if(<branchKey>: <addrExpr>; ...; else: -1)
  // Each corresponding branch must satisfy isAddrPlusOneAtomic with hi at +1.
  // The fallback can be -1 (Group FF, INTO-with-OF) or some other invalidating
  // sentinel — both lo and hi must use the same fallback.
  const loBr = parseIfBranches(loAddr);
  const hiBr = parseIfBranches(hiAddr);
  if (loBr && hiBr
      && loBr.fallback === hiBr.fallback
      && loBr.branches.length === hiBr.branches.length) {
    for (let i = 0; i < loBr.branches.length; i++) {
      if (loBr.branches[i].cond !== hiBr.branches[i].cond) return false;
      if (!isAddrPlusOneAtomic(loBr.branches[i].body, hiBr.branches[i].body)) return false;
    }
    return true;
  }

  return false;
}

/**
 * isAddrPlusOne for non-dispatch atomic address expressions.
 */
function isAddrPlusOneAtomic(loAddr, hiAddr) {
  // -1 sentinel: dispatch-conditional inactive branch. When both lo and hi
  // resolve to -1 on the same dispatch key, neither byte writes — pairing
  // the branches as a (suppressed) word write is correct. Must come BEFORE
  // the equality short-circuit below: ('-1', '-1') is equal but still pairs.
  if (loAddr === '-1' && hiAddr === '-1') return true;
  if (loAddr === '-1' || hiAddr === '-1') return false;
  if (loAddr === hiAddr) return false;

  // Stack: sa(K) returns
  //   calc(var(--__1SS) * 16 + --lowerBytes(calc(var(--__1SP) - K + 65536), 16))
  // Pair shape: lo uses K, hi uses K-1 (one byte higher in memory).
  const stackPattern = /^calc\(var\(--__1SS\) \* 16 \+ --lowerBytes\(calc\(var\(--__1SP\) - (\d+) \+ 65536\), 16\)\)$/;
  const loStack = stackPattern.exec(loAddr);
  const hiStack = stackPattern.exec(hiAddr);
  if (loStack && hiStack && parseInt(loStack[1], 10) - 1 === parseInt(hiStack[1], 10)) {
    return true;
  }

  // INTO conditional pushes wrap each addr in `calc(${ofBit} * (${sa(K)}) + (1 - ${ofBit}) * (-1))`.
  // Same K vs K-1 relation; match by stripping the wrapper.
  const intoPattern = /^calc\((.+) \* \((.+)\) \+ \(1 - (.+)\) \* \(-1\)\)$/;
  const loInto = intoPattern.exec(loAddr);
  const hiInto = intoPattern.exec(hiAddr);
  if (loInto && hiInto
      && loInto[1] === hiInto[1]    // same OF gate
      && loInto[3] === hiInto[3]
      && stackPattern.test(loInto[2])
      && stackPattern.test(hiInto[2])) {
    const lk = stackPattern.exec(loInto[2]);
    const hk = stackPattern.exec(hiInto[2]);
    if (parseInt(lk[1], 10) - 1 === parseInt(hk[1], 10)) return true;
  }

  // ea-based mod!=3 form (MOV r/m16 imm16, XCHG r/m16, POP r/m16):
  //   lo: 'if(style(--mod: 3): -1; else: var(--ea))'
  //   hi: 'if(style(--mod: 3): -1; else: calc(var(--ea) + 1))'
  // Detect by checking the +1 form.
  const eaPair = /^if\(style\(--mod: 3\): -1; else: (.+)\)$/;
  const loEa = eaPair.exec(loAddr);
  const hiEa = eaPair.exec(hiAddr);
  if (loEa && hiEa && hiEa[1] === `calc(${loEa[1]} + 1)`) return true;

  // Generic +1 form (STOSW/MOVSW with rep guard):
  //   lo: <expr>
  //   hi: <same expr with the inner "+ var(--__1DI)" replaced by "+ var(--__1DI) + 1">
  // The pattern files build hi by adding " + 1" textually. Match by
  // checking if hi == lo with " + 1)" inserted before the final paren.
  // E.g. lo='calc(var(--__1ES) * 16 + var(--__1DI))'
  //      hi='calc(var(--__1ES) * 16 + var(--__1DI) + 1)'
  if (hiAddr.endsWith(' + 1)') && loAddr.endsWith(')')) {
    const loBase = loAddr.slice(0, -1);
    if (hiAddr === `${loBase} + 1)`) return true;
  }
  // Wrap-in-calc +1 form (Group FF mod!=3 INC/DEC/PUSH r/m16):
  //   lo: 'var(--ea)'
  //   hi: 'calc(var(--ea) + 1)'
  // Pair files write the hi address as `calc(${lo} + 1)` even when lo is
  // a bare var(...) reference, leaving lo un-wrapped. Match by checking
  // hi against that exact wrap.
  if (hiAddr === `calc(${loAddr} + 1)`) return true;
  return false;
}

/**
 * Main CSS generation entry point.
 * Writes to a writable stream to avoid V8 string size limits with 1MB memory.
 *
 * opts.memoryZones: array of [start, end) ranges specifying which addresses to emit.
 * opts.memSize: (legacy) if memoryZones is not provided, emits 0..memSize contiguously.
 */
export function emitCSS(opts, writeStream) {
  const { programBytes, biosBytes, memoryZones, embeddedData, programOffset,
          initialCS, initialIP, diskBytes, header } = opts;

  // Build sorted address array from zones (or fall back to legacy contiguous range)
  let addresses;
  if (memoryZones) {
    addresses = buildAddressSet(memoryZones);
  } else {
    const memSize = opts.memSize || 0x10000;
    addresses = [];
    for (let i = 0; i < memSize; i++) addresses.push(i);
  }

  const memOpts = { addresses, programBytes, biosBytes, embeddedData, programOffset, diskBytes };
  // templateOpts.memSize is used for SP init — derive from the top of the lowest zone
  // (conventional memory area, which is always zones[0] by convention)
  const convEnd = memoryZones ? memoryZones[0][1] : (opts.memSize || 0x10000);
  const templateOpts = { memSize: convEnd, programOffset, initialCS, initialIP };

  // Build dispatch table
  const dispatch = new DispatchTable();

  // Register all opcode emitters
  emitMOV_RegImm16(dispatch);
  emitMOV_RegImm8(dispatch);
  emitMOV_RegRM(dispatch);
  emitMOV_SegRM(dispatch);
  emitMOV_AccMem(dispatch);
  emitLEA(dispatch);
  emitLES(dispatch);
  emitLDS(dispatch);
  emitAllALU(dispatch);       // ADD/SUB/CMP/AND/OR/XOR/ADC/SBB/TEST/INC/DEC
  emitAllControl(dispatch);   // JMP/Jcc/CALL/RET/INT/IRET/LOOP
  emitAllStack(dispatch);     // PUSH/POP/PUSHF/POPF
  emitAllMisc(dispatch);      // HLT/NOP/LODSB/STOSB/MOV r/m imm/flag manip/CBW/CWD/XCHG
  emitAllGroups(dispatch);    // Group FE/F7/F6/80-83
  emitAllShifts(dispatch);    // SHL/SHR/SAR/ROL/ROR (D0-D1)
  emitAll186(dispatch);       // 80186+: PUSH imm, IMUL imm
  emitCycleCounts(dispatch);  // Per-instruction 8086 cycle costs

  const w = (s) => writeStream.write(s + '\n\n');

  // Optional cabinet header comment (the self-describing block the builder
  // prepends to every cabinet). Written verbatim at the top of the CSS.
  if (header) {
    writeStream.write(header);
    if (!header.endsWith('\n')) writeStream.write('\n');
    writeStream.write('\n');
  }

  // =====================================================================
  // THE INTERESTING PART — CPU logic, decode, functions, dispatch tables
  // =====================================================================

  // 1. Utility @functions
  w(emitCSSLib());

  // 2. Decode @functions
  w(emitDecodeFunction());

  // 3. Flag computation @functions
  w(emitFlagFunctions());
  w(emitShiftFlagFunctions());
  w(emitShiftByNFlagFunctions());

  // 4. Clock and CPU base
  w('/* ===== EXECUTION ENGINE ===== */');
  w(emitClockAndCpuBase({}));

  // 5. .cpu rule body — aliases, decode, dispatch, write rules
  writeStream.write('  /* Register aliases (8-bit halves) */\n');
  w(emitRegisterAliases());
  w(emitDecodeProperties());
  w(emitPeripheralCompute());
  w(emitIRQCompute());

  // Unknown opcode detection — sets --unknownOp=1 and --haltCode=opcode
  writeStream.write('  /* ===== UNKNOWN OPCODE FLAG ===== */\n');
  writeStream.write(dispatch.emitUnknownOpFlag() + '\n');
  writeStream.write('  --haltCode: calc(var(--unknownOp) * var(--opcode));\n\n');

  // Per-register dispatch tables — the heart of instruction execution
  writeStream.write('  /* ===== REGISTER DISPATCH TABLES ===== */\n');
  writeStream.write('  /* Each register\'s next value is selected by opcode via a\n');
  writeStream.write('     giant if(style(--instId: N)) dispatch. This is the CPU. */\n');
  const regOrder = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI',
                    'CS', 'DS', 'ES', 'SS', 'IP', 'flags', 'halt', 'cycleCount',
                    // PIC/PIT state — updated by OUT handlers in patterns/misc.mjs.
                    // Vars with no dispatch entries fall through to defaultExpr.
                    'picMask', 'picPending', 'picInService',
                    'pitMode', 'pitReload', 'pitCounter', 'pitWriteState',
                    // Keyboard-edge detection: snapshot current --keyboard.
                    'prevKeyboard',
                    // VGA DAC state machines — write side updated by OUT
                    // 0x3C8 / 0x3C9, read side updated by OUT 0x3C7 / IN 0x3C9.
                    // See kiln/patterns/misc.mjs emitIO() for protocol.
                    'dacWriteIndex', 'dacSubIndex',
                    'dacReadIndex', 'dacReadSubIndex'];
  // Custom defaults: the fall-through expression when no dispatch entry fires
  // for this opcode. pitCounter ticks every instruction; picPending latches
  // PIT+keyboard edges; prevKeyboard snapshots --keyboard. Everything else
  // just holds its __1 value.
  const customDefaults = {
    pitCounter: pitCounterDefaultExpr(),
    picPending: picPendingDefaultExpr(),
    prevKeyboard: 'var(--keyboard)',
  };
  for (const reg of regOrder) {
    const defaultExpr = customDefaults[reg] ?? `var(--__1${reg})`;
    writeStream.write(dispatch.emitRegisterDispatch(reg, defaultExpr) + '\n');
  }
  writeStream.write('\n');

  // Memory write slots
  writeStream.write('  /* ===== MEMORY WRITE SLOTS ===== */\n');
  writeStream.write(dispatch.emitMemoryWriteSlots() + '\n\n');
  writeStream.write(dispatch.emitSlotLiveGates() + '\n\n');
  writeStream.write(dispatch.emitWriteWidthGate() + '\n\n');

  // 6. Debug display
  w('}');
  w(emitDebugDisplay(templateOpts));

  // 7. Keyboard :active rules (separate .cpu block)
  w(emitKeyboardRules());

  // =====================================================================
  // THE BULK — @property declarations, memory, buffer reads, keyframes
  // (This is ~99% of the file by volume: one @property per memory byte,
  //  one buffer-read per byte, one write-rule per byte, etc.)
  // =====================================================================

  w('/* ===== PROPERTY DECLARATIONS ===== */');
  w(`/* Below: ${addresses.length} @property declarations (one per memory byte),\n` +
    '   followed by memory read/write rules and animation keyframes.\n' +
    '   The CPU logic above is a small fraction of this file. The rest is memory. */\n');
  w(emitPropertyDecls(templateOpts));
  // Memory properties — emit in chunks to avoid huge strings
  emitMemoryPropertiesStreaming(memOpts, writeStream);
  w(emitWriteSlotProperties());

  // readMem @function (large — one branch per memory byte)
  w('/* ===== MEMORY READ ===== */');
  emitReadMemStreaming(memOpts, writeStream);

  // Double-buffer reads (inside .cpu rule — reopen it)
  // We emit these as a second .cpu block; CSS merges duplicate selectors.
  writeStream.write('.cpu {\n');
  writeStream.write('  /* Double-buffer reads */\n');
  w(emitBufferReads(templateOpts));
  emitMemoryBufferReadsStreaming(memOpts, writeStream);
  writeStream.write('\n');

  // Per-byte memory write rules
  writeStream.write('  /* ===== MEMORY WRITE RULES ===== */\n');
  emitMemoryWriteRulesStreaming(memOpts, writeStream);

  // Close second .cpu block
  w('}');

  // Keyframes — store
  const storeKf = emitStoreKeyframe(templateOpts);
  const storeKfOpen = storeKf.replace('  }\n}', '');
  writeStream.write(storeKfOpen);
  emitMemoryStoreKeyframeStreaming(memOpts, writeStream);
  writeStream.write('  }\n}\n\n');

  // Execute keyframe
  const execKf = emitExecuteKeyframe(templateOpts);
  const execKfOpen = execKf.replace('  }\n}', '');
  writeStream.write(execKfOpen);
  emitMemoryExecuteKeyframeStreaming(memOpts, writeStream);
  writeStream.write('  }\n}\n\n');

  w(emitClockKeyframes());
}

// --- Streaming memory emitters (write directly, avoid building huge strings) ---

const CHUNK = 8192; // lines per write() call

function emitMemoryPropertiesStreaming(opts, ws) {
  const { addresses } = opts;
  if (PACK_SIZE === 1) {
    const initMem = buildInitialMemory(opts);
    let buf = '';
    let count = 0;
    for (const addr of addresses) {
      const init = initMem.get(addr) || 0;
      buf += `@property --m${addr} {\n  syntax: '<integer>';\n  inherits: true;\n  initial-value: ${init};\n}\n\n`;
      if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
    }
    if (buf) ws.write(buf);
    return;
  }
  // Packed: one @property per cell. `--mc{cellIdx}` holds PACK_SIZE bytes.
  const cells = buildCellSet(addresses);
  const cellInit = buildInitialMemoryPacked(opts);
  let buf = '';
  let count = 0;
  for (const idx of cells) {
    const init = cellInit.get(idx) || 0;
    buf += `@property --mc${idx} {\n  syntax: '<integer>';\n  inherits: true;\n  initial-value: ${init};\n}\n\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitReadMemStreaming(opts, ws) {
  const { addresses, biosBytes, diskBytes } = opts;
  ws.write(`@function --readMem(--at <integer>) returns <integer> {\n  result: if(\n`);
  let buf = '';
  let count = 0;
  // Writable memory region
  // Addresses 0x0500-0x0501 (1280-1281) bridge to --keyboard for BIOS INT 16h
  for (const addr of addresses) {
    if (addr === 0x0500) {
      buf += `    style(--at: 1280): --lowerBytes(var(--__1keyboard), 8);\n`;
    } else if (addr === 0x0501) {
      buf += `    style(--at: 1281): --rightShift(var(--__1keyboard), 8);\n`;
    } else if (PACK_SIZE === 1) {
      buf += `    style(--at: ${addr}): var(--__1m${addr});\n`;
    } else {
      const idx = cellIdxOf(addr);
      const off = cellOffOf(addr);
      // Inline byte extraction for fewer @function call frames. Chrome handles
      // either shape; flat arithmetic is friendlier to the pattern recogniser.
      // PACK_SIZE=2: off=0 = low byte, off=1 = high byte. Values fit in i32.
      let expr;
      if (off === 0) expr = `mod(var(--__1mc${idx}), 256)`;
      else expr = `round(down, var(--__1mc${idx}) / 256)`;
      buf += `    style(--at: ${addr}): ${expr};\n`;
    }
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  // BIOS region (read-only constants) — always included
  if (biosBytes && biosBytes.length > 0) {
    for (let i = 0; i < biosBytes.length; i++) {
      if (biosBytes[i] !== 0) {
        buf += `    style(--at: ${0xF0000 + i}): ${biosBytes[i]};\n`;
        if (buf.length > 8192) { ws.write(buf); buf = ''; }
      }
    }
  }
  // Rom-disk window: 0xD0000..0xD01FF (512 bytes). Each read is dispatched
  // to --readDiskByte(lba_word, offset). The LBA register is a normal
  // writable word at linear 0x4F0 composed here as low + high*256 — same
  // pattern as other 16-bit reads. The source changes with PACK_SIZE:
  //   pack=1: bytes 0x4F0/0x4F1 live in --__1m1264/__1m1265.
  //   pack=2: both bytes live in cell --__1mc632 (1264/2=632) as low/high
  //           halves — extract with mod/round-down-div, same shape as the
  //           read dispatch above.
  if (diskBytes) {
    const lbaLowExpr = PACK_SIZE === 1
      ? `var(--__1m1264)`
      : `mod(var(--__1mc${cellIdxOf(0x4F0)}), 256)`;
    const lbaHighExpr = PACK_SIZE === 1
      ? `var(--__1m1265)`
      : `round(down, var(--__1mc${cellIdxOf(0x4F1)}) / 256)`;
    for (let i = 0; i < 512; i++) {
      const addr = 0xD0000 + i;
      buf += `    style(--at: ${addr}): --readDiskByte(calc((${lbaLowExpr} + ${lbaHighExpr} * 256) * 512 + ${i}));\n`;
      if (buf.length > 8192) { ws.write(buf); buf = ''; }
    }
  }
  if (buf) ws.write(buf);
  ws.write(`  else: 0);\n}\n\n`);

  // Emit the --readDiskByte @function — one branch per non-zero disk byte.
  if (diskBytes) {
    emitReadDiskByteStreaming(diskBytes, ws);
  }
}

function emitReadDiskByteStreaming(diskBytes, ws) {
  // Sector-based dispatch: --lba selects a 512-byte sector, --off selects
  // the byte within. One branch per non-zero disk byte. Calcite flattens
  // this dispatch into a byte-array lookup.
  ws.write(`@function --readDiskByte(--idx <integer>) returns <integer> {\n  result: if(\n`);
  let buf = '';
  for (let idx = 0; idx < diskBytes.length; idx++) {
    const b = diskBytes[idx];
    if (b !== 0) {
      buf += `    style(--idx: ${idx}): ${b};\n`;
      if (buf.length > 8192) { ws.write(buf); buf = ''; }
    }
  }
  if (buf) ws.write(buf);
  ws.write(`  else: 0);\n}\n\n`);
}

function emitMemoryBufferReadsStreaming(opts, ws) {
  const { addresses } = opts;
  if (PACK_SIZE === 1) {
    const initMem = buildInitialMemory(opts);
    let buf = '';
    let count = 0;
    for (const addr of addresses) {
      const init = initMem.get(addr) || 0;
      buf += `  --__1m${addr}: var(--__2m${addr}, ${init});\n`;
      if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
    }
    if (buf) ws.write(buf);
    return;
  }
  const cells = buildCellSet(addresses);
  const cellInit = buildInitialMemoryPacked(opts);
  let buf = '';
  let count = 0;
  for (const idx of cells) {
    const init = cellInit.get(idx) || 0;
    buf += `  --__1mc${idx}: var(--__2mc${idx}, ${init});\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryWriteRulesStreaming(opts, ws) {
  // Each byte's write rule checks NUM_WRITE_SLOTS slots to see if the
  // current tick is writing to this address. Every slot is gated by
  // --_slotNLive (1 only when some opcode uses slot N or TF/IRQ is
  // pushing). The global --_writeWidth gate (1 = byte at memAddrN,
  // 2 = word with lo at memAddrN, hi at memAddrN+1) applies to every
  // active slot uniformly. Non-writing instructions set all gates to 0
  // so every branch rejects without touching --memAddrN.
  //
  // CSS `style(A) and style(B)` short-circuits on the first false operand,
  // so idle ticks pay one style-query per slot per byte. Calcite's
  // packed-broadcast-write recogniser peels each gate off and compiles
  // the whole shape to a gated address-table lookup, skipping the entire
  // table when the gate reads 0 — see
  // calcite/crates/calcite-core/src/pattern/packed_broadcast_write.rs.
  const { addresses } = opts;
  if (PACK_SIZE === 1) {
    // Per byte at address A, each slot can hit two ways:
    //   (1) memAddrN == A             : slot's lo half lands here.
    //                                    width=1 → val is byte; width=2 → val is word, take lo via --lowerBytes.
    //   (2) memAddrN == A-1, width=2  : slot's hi half lands here. Take hi via --rightShift.
    let buf = '';
    let count = 0;
    for (const addr of addresses) {
      const hold = `var(--__1m${addr})`;
      const branches = [];
      for (let i = 0; i < NUM_WRITE_SLOTS; i++) {
        // (1) lo/byte half at addr.
        branches.push(`    style(--_slot${i}Live: 1) and style(--memAddr${i}: ${addr}): if(style(--_writeWidth: 2): --lowerBytes(var(--memVal${i}), 8); else: var(--memVal${i}));`);
        // (2) hi half at addr (slot's pair is at addr-1..addr).
        branches.push(`    style(--_slot${i}Live: 1) and style(--memAddr${i}: ${addr - 1}) and style(--_writeWidth: 2): --rightShift(var(--memVal${i}), 8);`);
      }
      buf += `  --m${addr}: if(\n${branches.join('\n')}\n    else: ${hold});\n`;
      if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
    }
    if (buf) ws.write(buf);
    return;
  }
  // Packed: each cell's value is a NUM_WRITE_SLOTS-deep cascade of
  // --applySlot calls. Slot 0 is outermost (applied last) so it wins on
  // same-cell collisions — matching the legacy top-down byte-level
  // dispatch semantics. Every --applySlot short-circuits to its input
  // cell when --_slotNLive=0, so idle ticks pay NUM_WRITE_SLOTS style-query
  // gates per cell (down from 6 in the byte-slot scheme).
  //
  // applySlot args:
  //   cell       : previous-tick cell value (b0 | b1<<8)
  //   live       : --_slotNLive (1 if slot fires)
  //   loOff      : memAddrN - cellBase            (slot's lo/byte half offset within this cell)
  //   hiOff      : memAddrN + 1 - cellBase        (slot's hi half offset within this cell, only meaningful when width=2)
  //   val        : memValN — byte (width=1) or 16-bit word (width=2, lo at memAddrN, hi at memAddrN+1)
  //   width      : --_writeWidth (1 or 2; shared across all slots this tick)
  // applySlot handles aligned word writes (loOff=0, hiOff=1, width=2), the
  // straddle cases (loOff=1 → lo half lands here at off 1; hiOff=0 → hi half
  // lands here at off 0, both gated on width=2), and width=1 byte writes.
  const cells = buildCellSet(addresses);
  let buf = '';
  let count = 0;
  for (const idx of cells) {
    // Build the cascade inside-out: start with __1mcIDX, then slot N-1, ..., slot 0.
    // The `${idx} * ${PACK_SIZE}` arithmetic (rather than the pre-folded
    // `${cellBase(idx)}`) is deliberate: it keeps the per-cell digit run
    // equal to the cell index, so the parser fast-path classifies it as
    // an Addr hole (not a Free hole) and can template the whole run.
    let expr = `var(--__1mc${idx})`;
    for (let slot = NUM_WRITE_SLOTS - 1; slot >= 0; slot--) {
      expr = `--applySlot(${expr}, var(--_slot${slot}Live), calc(var(--memAddr${slot}) - ${idx} * ${PACK_SIZE}), calc(var(--memAddr${slot}) + 1 - ${idx} * ${PACK_SIZE}), var(--memVal${slot}), var(--_writeWidth))`;
    }
    buf += `  --mc${idx}: ${expr};\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryStoreKeyframeStreaming(opts, ws) {
  const { addresses } = opts;
  if (PACK_SIZE === 1) {
    const initMem = buildInitialMemory(opts);
    let buf = '';
    let count = 0;
    for (const addr of addresses) {
      const init = initMem.get(addr) || 0;
      buf += `    --__2m${addr}: var(--__0m${addr}, ${init});\n`;
      if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
    }
    if (buf) ws.write(buf);
    return;
  }
  const cells = buildCellSet(addresses);
  const cellInit = buildInitialMemoryPacked(opts);
  let buf = '';
  let count = 0;
  for (const idx of cells) {
    const init = cellInit.get(idx) || 0;
    buf += `    --__2mc${idx}: var(--__0mc${idx}, ${init});\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryExecuteKeyframeStreaming(opts, ws) {
  const { addresses } = opts;
  if (PACK_SIZE === 1) {
    let buf = '';
    let count = 0;
    for (const addr of addresses) {
      buf += `    --__0m${addr}: var(--m${addr});\n`;
      if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
    }
    if (buf) ws.write(buf);
    return;
  }
  const cells = buildCellSet(addresses);
  let buf = '';
  let count = 0;
  for (const idx of cells) {
    buf += `    --__0mc${idx}: var(--mc${idx});\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

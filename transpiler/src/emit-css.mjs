// Top-level CSS generation orchestrator.
// Collects dispatch entries from all opcode emitters, assembles per-register
// dispatch tables, and combines with infrastructure (clock, memory, decode).

import { emitCSSLib } from './css-lib.mjs';
import { emitDecodeFunction, emitDecodeProperties } from './decode.mjs';
import {
  emitPropertyDecls, emitBufferReads, emitRegisterAliases,
  emitStoreKeyframe, emitExecuteKeyframe, emitClockKeyframes,
  emitClockAndCpuBase, emitDebugDisplay, emitHTMLHeader, emitHTMLFooter,
} from './template.mjs';
import { emitWriteSlotProperties, buildInitialMemory, buildAddressSet } from './memory.mjs';
import { emitFlagFunctions } from './patterns/flags.mjs';

// Opcode emitters
import { emitMOV_RegImm16, emitMOV_RegImm8, emitMOV_RegRM, emitMOV_SegRM, emitMOV_AccMem, emitLEA, emitLES, emitLDS } from './patterns/mov.mjs';
import { emitAllALU } from './patterns/alu.mjs';
import { emitAllControl } from './patterns/control.mjs';
import { emitAllStack } from './patterns/stack.mjs';
import { emitAllMisc } from './patterns/misc.mjs';
import { emitAllGroups } from './patterns/group.mjs';
import { emitAllShifts, emitShiftFlagFunctions, emitShiftByNFlagFunctions } from './patterns/shift.mjs';
import { emitCycleCounts } from './cycle-counts.mjs';
import { emitIRQSentinel, emitPicVectorProperties, emitIRQFunctions } from './patterns/irq.mjs';
import { emitPitProperties } from './patterns/pit.mjs';
import { emitAllBiosHandlers } from './patterns/bios.mjs';

/**
 * Dispatch table builder. Collects per-register entries keyed by opcode.
 */
class DispatchTable {
  constructor() {
    // regEntries: Map<regName, Map<opcode, Map<uOp, {expr, comment}>>>
    this.regEntries = new Map();
    // memWrites: Map<opcode, Map<uOp, {addrExpr, valExpr, comment}>>
    this.memWritesByOpcode = new Map();
    // Track max uOp per opcode for the advance table
    this.maxUop = new Map(); // opcode → max uOp index
    // Custom uOp advance expressions (opcode → CSS expression)
    // When set, overrides the auto-generated advance for that opcode.
    this.customUopAdvance = new Map();
  }

  addEntry(reg, opcode, expr, comment = '', uOp = 0) {
    if (!this.regEntries.has(reg)) {
      this.regEntries.set(reg, new Map());
    }
    const regMap = this.regEntries.get(reg);
    if (!regMap.has(opcode)) {
      regMap.set(opcode, new Map());
    }
    const uOpMap = regMap.get(opcode);
    if (uOpMap.has(uOp)) {
      throw new Error(`Duplicate dispatch entry: ${reg} opcode 0x${opcode.toString(16)} uOp ${uOp} — existing: ${uOpMap.get(uOp).comment}, new: ${comment}`);
    }
    uOpMap.set(uOp, { expr, comment });
    // Track max uOp
    this.maxUop.set(opcode, Math.max(this.maxUop.get(opcode) || 0, uOp));
  }

  /**
   * Emit --unknownOp: 1 if the current opcode has no IP dispatch entry, 0 otherwise.
   * Prefixes (0x26/0x2E/0x36/0x3E/0xF2/0xF3) are excluded — they're handled at decode level.
   */
  emitUnknownOpFlag() {
    const ipEntries = this.regEntries.get('IP');
    if (!ipEntries) return '  --unknownOp: 1;';
    // Only check opcodes, not uOps — if the opcode has any IP entry, it's known
    const opcodes = [...ipEntries.keys()].sort((a, b) => a - b);
    const lines = ['  --unknownOp: if('];
    for (const op of opcodes) {
      lines.push(`    style(--opcode: ${op}): 0;`);
    }
    lines.push('  else: 1);');
    return lines.join('\n');
  }

  /**
   * Set a custom uOp advance expression for an opcode.
   * Used for instructions with conditional multi-cycle behavior (e.g., mod=3 vs memory).
   */
  setUopAdvance(opcode, expr) {
    this.customUopAdvance.set(opcode, expr);
  }

  addMemWrite(opcode, addrExpr, valExpr, comment = '', uOp = 0) {
    if (!this.memWritesByOpcode.has(opcode)) {
      this.memWritesByOpcode.set(opcode, new Map());
    }
    const uOpMap = this.memWritesByOpcode.get(opcode);
    if (uOpMap.has(uOp)) {
      throw new Error(`Duplicate memWrite: opcode 0x${opcode.toString(16)} uOp ${uOp} — existing: ${uOpMap.get(uOp).comment}, new: ${comment}`);
    }
    uOpMap.set(uOp, { addrExpr, valExpr, comment });
    // Track max uOp
    this.maxUop.set(opcode, Math.max(this.maxUop.get(opcode) || 0, uOp));
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
    if (!entries || entries.size === 0) {
      return `  --${reg}: ${defaultExpr};`;
    }

    // Build the instruction dispatch, with nested uOp dispatch for multi-cycle opcodes
    const wrapIP = (reg === 'IP');
    const dispatchLines = [];
    const sorted = [...entries.entries()].sort(([a], [b]) => a - b);
    for (const [opcode, uOpMap] of sorted) {
      const isMultiCycle = (this.maxUop.get(opcode) || 0) > 0;
      if (!isMultiCycle && uOpMap.size === 1 && uOpMap.has(0)) {
        // Single-cycle opcode: flat entry (same as v2)
        const { expr, comment } = uOpMap.get(0);
        const commentStr = comment ? ` /* ${comment} */` : '';
        dispatchLines.push(`    style(--opcode: ${opcode}): ${expr};${commentStr}`);
      } else {
        // Multi-cycle opcode: flat entries with 'and' composition.
        // style(--opcode: N) and style(--__1uOp: M): expr
        // When no uOp matches, the outer else (hold) fires — no inner else needed.
        const maxU = this.maxUop.get(opcode) || 0;
        const sortedUops = [...uOpMap.entries()].sort(([a], [b]) => a - b);
        const uOpSet = new Set(sortedUops.map(([u]) => u));
        for (const [uOp, { expr, comment }] of sortedUops) {
          const commentStr = comment ? ` /* ${comment} */` : '';
          dispatchLines.push(`    style(--opcode: ${opcode}) and style(--__1uOp: ${uOp}): ${expr};${commentStr}`);
        }
        // For IP: emit explicit hold entries for uOps without an IP expression.
        // The IP wrapper adds + var(--prefixLen) to the entire dispatch, so the
        // default fallthrough (var(--__1IP)) becomes IP + prefixLen — wrong for
        // mid-instruction holds on prefixed instructions (e.g., REP STOSW).
        // Emitting calc(var(--__1IP) - var(--prefixLen)) cancels the wrapper.
        if (wrapIP) {
          for (let u = 0; u <= maxU; u++) {
            if (!uOpSet.has(u)) {
              dispatchLines.push(`    style(--opcode: ${opcode}) and style(--__1uOp: ${u}): calc(var(--__1IP) - var(--prefixLen)); /* hold */`);
            }
          }
        }
      }
    }

    let normalExpr;
    if (wrapIP) {
      normalExpr = `calc(if(\n${dispatchLines.join('\n')}\n  else: ${defaultExpr}) + var(--prefixLen))`;
    } else {
      normalExpr = `if(\n${dispatchLines.join('\n')}\n  else: ${defaultExpr})`;
    }

    return `  --${reg}: ${normalExpr};`;
  }

  /**
   * Emit the single memory write slot (--memAddr, --memVal).
   * v3: one write per cycle, dispatched on (opcode, uOp).
   */
  emitMemoryWriteSlots() {
    const lines = [];

    // Collect all (opcode, uOp) → {addrExpr, valExpr} entries
    const addrLines = [];
    const valLines = [];
    const sortedOpcodes = [...this.memWritesByOpcode.entries()].sort(([a], [b]) => a - b);

    for (const [opcode, uOpMap] of sortedOpcodes) {
      if (uOpMap.size === 1 && uOpMap.has(0)) {
        // Single uOp: flat dispatch
        const { addrExpr, valExpr, comment } = uOpMap.get(0);
        addrLines.push(`    style(--opcode: ${opcode}): ${addrExpr}; /* ${comment || ''} */`);
        valLines.push(`    style(--opcode: ${opcode}): ${valExpr}; /* ${comment || ''} */`);
      } else {
        // Multi-uOp: flat entries with 'and' composition
        const sortedUops = [...uOpMap.entries()].sort(([a], [b]) => a - b);
        for (const [uOp, { addrExpr, valExpr, comment }] of sortedUops) {
          addrLines.push(`    style(--opcode: ${opcode}) and style(--__1uOp: ${uOp}): ${addrExpr}; /* ${comment || ''} */`);
          valLines.push(`    style(--opcode: ${opcode}) and style(--__1uOp: ${uOp}): ${valExpr}; /* ${comment || ''} */`);
        }
      }
    }

    lines.push(`  --memAddr: if(`);
    lines.push(addrLines.join('\n'));
    lines.push(`  else: -1);`);
    lines.push(`  --memVal: if(`);
    lines.push(valLines.join('\n'));
    lines.push(`  else: 0);`);

    return lines.join('\n');
  }

  /**
   * Emit the --uOp advance dispatch table.
   * For single-cycle instructions (maxUop=0): no entry needed (default is 0).
   * For multi-cycle: uOp N → N+1, last uOp → 0 (retire).
   */
  emitUopAdvance() {
    const lines = [];
    // Collect all opcodes that have either multi-uOp or custom advance
    const multiCycleOpcodes = new Map();
    for (const [opcode, max] of this.maxUop) {
      if (max > 0) multiCycleOpcodes.set(opcode, max);
    }
    for (const [opcode] of this.customUopAdvance) {
      if (!multiCycleOpcodes.has(opcode)) multiCycleOpcodes.set(opcode, 0);
    }

    if (multiCycleOpcodes.size === 0) {
      return '  --uOp: 0;';
    }

    const sorted = [...multiCycleOpcodes.entries()].sort(([a], [b]) => a - b);

    lines.push('  --uOp: if(');
    for (const [opcode, maxU] of sorted) {
      if (this.customUopAdvance.has(opcode)) {
        // Custom advance expression (e.g., conditional on --mod)
        lines.push(`    style(--opcode: ${opcode}): ${this.customUopAdvance.get(opcode)};`);
      } else {
        // Auto-generated advance chain: 0→1→...→N→0
        for (let u = 0; u < maxU; u++) {
          lines.push(`    style(--opcode: ${opcode}) and style(--__1uOp: ${u}): ${u + 1};`);
        }
        lines.push(`    style(--opcode: ${opcode}) and style(--__1uOp: ${maxU}): 0;`);
      }
    }
    lines.push('  else: 0);');

    return lines.join('\n');
  }
}

/**
 * Main CSS generation entry point.
 * Writes to a writable stream to avoid V8 string size limits with 1MB memory.
 *
 * opts.memoryZones: array of [start, end) ranges specifying which addresses to emit.
 * opts.memSize: (legacy) if memoryZones is not provided, emits 0..memSize contiguously.
 */
export function emitCSS(opts, writeStream) {
  const { programBytes, biosBytes, memoryZones, embeddedData, htmlMode, programOffset,
          initialCS, initialIP } = opts;

  // Build sorted address array from zones (or fall back to legacy contiguous range)
  let addresses;
  if (memoryZones) {
    addresses = buildAddressSet(memoryZones);
  } else {
    const memSize = opts.memSize || 0x10000;
    addresses = [];
    for (let i = 0; i < memSize; i++) addresses.push(i);
  }

  const memOpts = { addresses, programBytes, biosBytes, embeddedData, programOffset };
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
  emitCycleCounts(dispatch);  // Per-instruction 8086 cycle costs
  emitIRQSentinel(dispatch);  // Sentinel opcode 0xF1 for hardware IRQ delivery
  emitAllBiosHandlers(dispatch);  // BIOS opcode 0xD6 dispatch on routine ID

  const w = (s) => writeStream.write(s + '\n\n');

  if (htmlMode) {
    writeStream.write(emitHTMLHeader());
  }

  // =====================================================================
  // THE INTERESTING PART — CPU logic, decode, functions, dispatch tables
  // (Placed first so readers see the actual 8086 implementation up front,
  //  not millions of @property declarations.)
  // =====================================================================

  // 1. Utility @functions
  w('/* ===== CSS-DOS: An 8086 CPU in pure CSS ===== */');
  w('/* This file is a complete Intel 8086 processor implemented in CSS.\n' +
    '   Every register, every flag, every instruction decode, every byte of\n' +
    '   memory is a CSS custom property driven by calc().\n' +
    '   Open this file in Chrome and it runs. Slowly — but it runs. */\n');
  w(emitCSSLib());

  // 2. Decode @functions
  w(emitDecodeFunction());

  // 3. Flag computation @functions
  w(emitFlagFunctions());
  w(emitShiftFlagFunctions());
  w(emitShiftByNFlagFunctions());

  // 3b. IRQ helper @functions
  w(emitIRQFunctions());

  // 4. Clock and CPU base
  w('/* ===== EXECUTION ENGINE ===== */');
  w(emitClockAndCpuBase({ htmlMode }));

  // 5. .cpu rule body — aliases, decode, dispatch, write rules
  writeStream.write('  /* Register aliases (8-bit halves) */\n');
  w(emitRegisterAliases());
  w(emitDecodeProperties());

  // PIC vector computation (IRQ number → interrupt vector)
  writeStream.write('  /* ===== PIC / IRQ STATE ===== */\n');
  writeStream.write(emitPicVectorProperties() + '\n\n');

  // Keyboard state
  writeStream.write('  /* ===== KEYBOARD ===== */\n');
  writeStream.write('  --_kbdScancode: --rightShift(var(--keyboard), 8);\n');
  writeStream.write('  --_kbdAscii: --lowerBytes(var(--keyboard), 8);\n');
  // Edge detection: update kbdLast only at instruction boundaries
  writeStream.write('  --kbdLast: if(style(--__1uOp: 0): var(--keyboard); else: var(--__1kbdLast));\n');
  // _kbdChanged: 1 when keyboard differs from previous boundary, 0 otherwise
  writeStream.write('  --_kbdChanged: if(style(--__1uOp: 0): min(1, max(0, sign(calc(max(var(--keyboard), var(--__1kbdLast)) - min(var(--keyboard), var(--__1kbdLast)))))); else: 0);\n');
  writeStream.write('\n');

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
                    'picMask', 'picPending', 'picInService'];
  for (const reg of regOrder) {
    // picPending default: OR in PIT IRQ (bit 0) when PIT counter crosses zero.
    // --_pitFired is 0 or 1 (computed by PIT properties below).
    const defaultExpr = reg === 'picPending'
      ? `--or(--or(var(--__1picPending), var(--_pitFired)), calc(var(--_kbdChanged) * 2))`
      : `var(--__1${reg})`;
    writeStream.write(dispatch.emitRegisterDispatch(reg, defaultExpr) + '\n');
  }
  writeStream.write('\n');

  // irqActive — standalone computed property (not dispatch-driven)
  // Set to 1 at instruction boundaries when IF=1 and PIC has unmasked pending IRQ.
  // Stays 1 during sentinel μop sequence, resets to 0 on sentinel retirement.
  writeStream.write('  /* ===== IRQ ACTIVE ===== */\n');
  writeStream.write('  /* Checked in order: first match wins. */\n');
  writeStream.write(`  --irqActive: if(\n`);
  writeStream.write(`    style(--opcode: 241) and style(--__1uOp: 5): 0; /* IRQ sentinel retirement */\n`);
  writeStream.write(`    style(--opcode: 241): var(--__1irqActive); /* IRQ sentinel mid-sequence: hold */\n`);
  writeStream.write(`    style(--opcode: 214) and style(--__1uOp: 0): if(\n`);
  writeStream.write(`      style(--_irqEffective: 0): 0;\n`);
  writeStream.write(`      style(--_ifFlag: 0): 0;\n`);
  writeStream.write(`    else: 1); /* BIOS handler μop 0 hold: allow IRQ if pending+IF=1 */\n`);
  writeStream.write(`    style(--opcode: 214): 0; /* BIOS handler mid-sequence: no IRQ */\n`);
  writeStream.write(`    style(--_irqEffective: 0): 0; /* no unmasked pending IRQ */\n`);
  writeStream.write(`    style(--_ifFlag: 0): 0; /* IF=0: interrupts disabled */\n`);
  writeStream.write(`    style(--__1uOp: 0): 1; /* instruction boundary + IF=1 + IRQ pending */\n`);
  writeStream.write(`  else: 0); /* mid-instruction */\n\n`);

  // PIT (i8253) state — standalone computed properties
  writeStream.write('  /* ===== PIT TIMER ===== */\n');
  writeStream.write(emitPitProperties() + '\n\n');

  // μop advance dispatch
  writeStream.write('  /* ===== μOP ADVANCE ===== */\n');
  writeStream.write(dispatch.emitUopAdvance() + '\n\n');

  // Memory write slot (single addr/val pair per cycle)
  writeStream.write('  /* ===== MEMORY WRITE ===== */\n');
  writeStream.write(dispatch.emitMemoryWriteSlots() + '\n\n');

  // 6. Debug display
  w('}');
  w(emitDebugDisplay(templateOpts));

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

  if (htmlMode) {
    writeStream.write(emitHTMLFooter());
  }
}

// --- Streaming memory emitters (write directly, avoid building huge strings) ---

const CHUNK = 8192; // lines per write() call

function emitMemoryPropertiesStreaming(opts, ws) {
  const { addresses } = opts;
  const initMem = buildInitialMemory(opts);
  let buf = '';
  let count = 0;
  for (const addr of addresses) {
    const init = initMem.get(addr) || 0;
    buf += `@property --m${addr} {\n  syntax: '<integer>';\n  inherits: true;\n  initial-value: ${init};\n}\n\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitReadMemStreaming(opts, ws) {
  const { addresses, biosBytes } = opts;
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
    } else {
      buf += `    style(--at: ${addr}): var(--__1m${addr});\n`;
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
  if (buf) ws.write(buf);
  ws.write(`  else: 0);\n}\n\n`);
}

function emitMemoryBufferReadsStreaming(opts, ws) {
  const { addresses } = opts;
  const initMem = buildInitialMemory(opts);
  let buf = '';
  let count = 0;
  for (const addr of addresses) {
    const init = initMem.get(addr) || 0;
    buf += `  --__1m${addr}: var(--__2m${addr}, ${init});\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryWriteRulesStreaming(opts, ws) {
  const { addresses } = opts;
  let buf = '';
  let count = 0;
  for (const addr of addresses) {
    buf += `  --m${addr}: if(style(--memAddr: ${addr}): var(--memVal); else: var(--__1m${addr}));\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryStoreKeyframeStreaming(opts, ws) {
  const { addresses } = opts;
  const initMem = buildInitialMemory(opts);
  let buf = '';
  let count = 0;
  for (const addr of addresses) {
    const init = initMem.get(addr) || 0;
    buf += `    --__2m${addr}: var(--__0m${addr}, ${init});\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryExecuteKeyframeStreaming(opts, ws) {
  const { addresses } = opts;
  let buf = '';
  let count = 0;
  for (const addr of addresses) {
    buf += `    --__0m${addr}: var(--m${addr});\n`;
    if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

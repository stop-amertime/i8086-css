// Top-level CSS generation orchestrator.
// Collects dispatch entries from all opcode emitters, assembles per-register
// dispatch tables, and combines with infrastructure (clock, memory, decode).

import { emitCSSLib } from './css-lib.mjs';
import { emitDecodeFunction, emitDecodeProperties } from './decode.mjs';
import {
  emitPropertyDecls, emitBufferReads, emitRegisterAliases,
  emitStoreKeyframe, emitExecuteKeyframe, emitClockKeyframes,
  emitClockAndCpuBase, emitDebugDisplay, emitHTMLHeader, emitHTMLFooter,
  emitKeyboardRules,
} from './template.mjs';
import { emitWriteSlotProperties, buildInitialMemory, buildAddressSet, NUM_WRITE_SLOTS } from './memory.mjs';
import { emitFlagFunctions } from './patterns/flags.mjs';

// Opcode emitters
import { emitMOV_RegImm16, emitMOV_RegImm8, emitMOV_RegRM, emitMOV_SegRM, emitMOV_AccMem, emitLEA, emitLES, emitLDS } from './patterns/mov.mjs';
import { emitAllALU } from './patterns/alu.mjs';
import { emitAllControl } from './patterns/control.mjs';
import { emitAllStack } from './patterns/stack.mjs';
import { emitAllMisc } from './patterns/misc.mjs';
import { emitAllGroups } from './patterns/group.mjs';
import { emitAllShifts, emitShiftFlagFunctions, emitShiftByNFlagFunctions } from './patterns/shift.mjs';

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
    this.memWritesByOpcode.get(opcode).push({ addrExpr, valExpr, comment });
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

    // Build the normal instruction dispatch
    const wrapIP = (reg === 'IP');
    const dispatchLines = [];
    const sorted = [...entries.entries()].sort(([a], [b]) => a - b);
    for (const [opcode, { expr, comment }] of sorted) {
      const commentStr = comment ? ` /* ${comment} */` : '';
      dispatchLines.push(`    style(--opcode: ${opcode}): ${expr};${commentStr}`);
    }

    let normalExpr;
    if (wrapIP) {
      normalExpr = `calc(if(\n${dispatchLines.join('\n')}\n  else: ${defaultExpr}) + var(--prefixLen))`;
    } else {
      normalExpr = `if(\n${dispatchLines.join('\n')}\n  else: ${defaultExpr})`;
    }

    // TF (Trap Flag) override: when previous FLAGS had TF=1, fire INT 1 instead
    // of the normal instruction. INT 1: push FLAGS/CS/IP, clear TF+IF, jump to IVT[1].
    const TF_OVERRIDES = {
      'IP':    'var(--_tfIP)',
      'CS':    'var(--_tfCS)',
      'SP':    'calc(var(--__1SP) - 6)',
      'flags': '--and(var(--__1flags), 64767)',  // & 0xFCFF = clear TF+IF
    };

    const tfExpr = TF_OVERRIDES[reg] || `var(--__1${reg})`;
    return `  --${reg}: if(style(--_tf: 1): ${tfExpr}; else: ${normalExpr});`;
  }

  /**
   * Emit the 6 memory write slot properties (--memAddr0/Val0 through --memAddr5/Val5).
   * Each slot aggregates across all opcodes that use it.
   * 6 slots needed: INT pushes 3 words = 6 byte writes.
   */
  emitMemoryWriteSlots() {
    const slots = Array.from({ length: NUM_WRITE_SLOTS }, () => []);

    for (const [opcode, writes] of this.memWritesByOpcode) {
      if (writes.length > NUM_WRITE_SLOTS) {
        throw new Error(`Opcode 0x${opcode.toString(16)} uses ${writes.length} memory write slots (max ${NUM_WRITE_SLOTS})`);
      }
      for (let i = 0; i < writes.length; i++) {
        slots[i].push({ opcode, ...writes[i] });
      }
    }

    // TF trap INT 1 memory writes: push FLAGS/CS/IP to stack (slots 0-5)
    const ssBase = 'calc(var(--__1SS) * 16)';
    const tfAddr = [
      `calc(${ssBase} + var(--__1SP) - 2)`,   // slot 0: FLAGS lo
      `calc(${ssBase} + var(--__1SP) - 1)`,   // slot 1: FLAGS hi
      `calc(${ssBase} + var(--__1SP) - 4)`,   // slot 2: CS lo
      `calc(${ssBase} + var(--__1SP) - 3)`,   // slot 3: CS hi
      `calc(${ssBase} + var(--__1SP) - 6)`,   // slot 4: IP lo
      `calc(${ssBase} + var(--__1SP) - 5)`,   // slot 5: IP hi
    ];
    const tfFlagsPush = `var(--__1flags)`;
    const tfVal = [
      `--lowerBytes(${tfFlagsPush}, 8)`,       // FLAGS lo
      `--rightShift(${tfFlagsPush}, 8)`,        // FLAGS hi
      `--lowerBytes(var(--__1CS), 8)`,          // CS lo
      `--rightShift(var(--__1CS), 8)`,          // CS hi
      `--lowerBytes(var(--__1IP), 8)`,          // IP lo
      `--rightShift(var(--__1IP), 8)`,          // IP hi
    ];

    const lines = [];
    for (let slot = 0; slot < NUM_WRITE_SLOTS; slot++) {
      const hasTF = slot < 6;  // TF only uses slots 0-5

      if (slots[slot].length === 0 && !hasTF) {
        // Unused slot — always inactive
        lines.push(`  --memAddr${slot}: -1;`);
        lines.push(`  --memVal${slot}: 0;`);
        continue;
      }

      if (slots[slot].length === 0) {
        // TF-only slot
        lines.push(`  --memAddr${slot}: if(style(--_tf: 1): ${tfAddr[slot]}; else: -1);`);
        lines.push(`  --memVal${slot}: if(style(--_tf: 1): ${tfVal[slot]}; else: 0);`);
        continue;
      }

      // Address dispatch
      lines.push(`  --memAddr${slot}: if(`);
      if (hasTF) {
        lines.push(`    style(--_tf: 1): ${tfAddr[slot]};`);
      }
      for (const { opcode, addrExpr, comment } of slots[slot]) {
        lines.push(`    style(--opcode: ${opcode}): ${addrExpr}; /* ${comment || ''} */`);
      }
      lines.push(`  else: -1);`);

      // Value dispatch
      lines.push(`  --memVal${slot}: if(`);
      if (hasTF) {
        lines.push(`    style(--_tf: 1): ${tfVal[slot]};`);
      }
      for (const { opcode, valExpr, comment } of slots[slot]) {
        lines.push(`    style(--opcode: ${opcode}): ${valExpr}; /* ${comment || ''} */`);
      }
      lines.push(`  else: 0);`);
    }

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

  // 4. Clock and CPU base
  w('/* ===== EXECUTION ENGINE ===== */');
  w(emitClockAndCpuBase({ htmlMode }));

  // 5. .cpu rule body — aliases, decode, dispatch, write rules
  writeStream.write('  /* Register aliases (8-bit halves) */\n');
  w(emitRegisterAliases());
  w(emitDecodeProperties());

  // Unknown opcode detection — sets --unknownOp=1 and --haltCode=opcode
  writeStream.write('  /* ===== UNKNOWN OPCODE FLAG ===== */\n');
  writeStream.write(dispatch.emitUnknownOpFlag() + '\n');
  writeStream.write('  --haltCode: calc(var(--unknownOp) * var(--opcode));\n\n');

  // Per-register dispatch tables — the heart of instruction execution
  writeStream.write('  /* ===== REGISTER DISPATCH TABLES ===== */\n');
  writeStream.write('  /* Each register\'s next value is selected by opcode via a\n');
  writeStream.write('     giant if(style(--instId: N)) dispatch. This is the CPU. */\n');
  const regOrder = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI',
                    'CS', 'DS', 'ES', 'SS', 'IP', 'flags', 'halt'];
  for (const reg of regOrder) {
    const defaultExpr = `var(--__1${reg})`;
    writeStream.write(dispatch.emitRegisterDispatch(reg, defaultExpr) + '\n');
  }
  writeStream.write('\n');

  // Memory write slots
  writeStream.write('  /* ===== MEMORY WRITE SLOTS ===== */\n');
  writeStream.write(dispatch.emitMemoryWriteSlots() + '\n\n');

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
    const slotLines = [];
    for (let i = 0; i < NUM_WRITE_SLOTS; i++) {
      slotLines.push(`    style(--memAddr${i}: ${addr}): var(--memVal${i});`);
    }
    buf += `  --m${addr}: if(\n${slotLines.join('\n')}\n  else: var(--__1m${addr}));\n`;
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

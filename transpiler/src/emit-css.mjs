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
import { emitWriteSlotProperties, buildInitialMemory } from './memory.mjs';
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
    regMap.set(opcode, { expr, comment });
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

    const lines = [];

    // For IP, wrap dispatch in calc(... + prefixLen) so every instruction
    // automatically advances past any prefix bytes.
    const wrapIP = (reg === 'IP');

    if (wrapIP) {
      lines.push(`  --${reg}: calc(if(`);
    } else {
      lines.push(`  --${reg}: if(`);
    }

    // Sort by opcode for readability
    const sorted = [...entries.entries()].sort(([a], [b]) => a - b);
    for (const [opcode, { expr, comment }] of sorted) {
      const hex = '0x' + opcode.toString(16).toUpperCase().padStart(2, '0');
      const commentStr = comment ? ` /* ${comment} */` : '';
      lines.push(`    style(--opcode: ${opcode}): ${expr};${commentStr}`);
    }

    if (wrapIP) {
      lines.push(`  else: ${defaultExpr}) + var(--prefixLen));`);
    } else {
      lines.push(`  else: ${defaultExpr});`);
    }
    return lines.join('\n');
  }

  /**
   * Emit the 6 memory write slot properties (--memAddr0/Val0 through --memAddr5/Val5).
   * Each slot aggregates across all opcodes that use it.
   * 6 slots needed: INT pushes 3 words = 6 byte writes.
   */
  emitMemoryWriteSlots() {
    const NUM_SLOTS = 6;
    const slots = Array.from({ length: NUM_SLOTS }, () => []);

    for (const [opcode, writes] of this.memWritesByOpcode) {
      if (writes.length > NUM_SLOTS) {
        throw new Error(`Opcode 0x${opcode.toString(16)} uses ${writes.length} memory write slots (max ${NUM_SLOTS})`);
      }
      for (let i = 0; i < writes.length; i++) {
        slots[i].push({ opcode, ...writes[i] });
      }
    }

    const lines = [];
    for (let slot = 0; slot < NUM_SLOTS; slot++) {
      if (slots[slot].length === 0) {
        lines.push(`  --memAddr${slot}: -1;`);
        lines.push(`  --memVal${slot}: 0;`);
        continue;
      }

      // Address dispatch
      lines.push(`  --memAddr${slot}: if(`);
      for (const { opcode, addrExpr, comment } of slots[slot]) {
        const hex = '0x' + opcode.toString(16).toUpperCase().padStart(2, '0');
        lines.push(`    style(--opcode: ${opcode}): ${addrExpr}; /* ${comment || hex} */`);
      }
      lines.push(`  else: -1);`);

      // Value dispatch
      lines.push(`  --memVal${slot}: if(`);
      for (const { opcode, valExpr, comment } of slots[slot]) {
        const hex = '0x' + opcode.toString(16).toUpperCase().padStart(2, '0');
        lines.push(`    style(--opcode: ${opcode}): ${valExpr}; /* ${comment || hex} */`);
      }
      lines.push(`  else: 0);`);
    }

    return lines.join('\n');
  }
}

/**
 * Main CSS generation entry point.
 * Writes to a writable stream to avoid V8 string size limits with 1MB memory.
 */
export function emitCSS(opts, writeStream) {
  const { programBytes, biosBytes, memSize, embeddedData, htmlMode, programOffset } = opts;

  const memOpts = { memSize, programBytes, biosBytes, embeddedData, programOffset };
  const templateOpts = { memSize, programOffset };

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

  // 1. @property declarations
  w('/* ===== PROPERTY DECLARATIONS ===== */');
  w(emitPropertyDecls(templateOpts));
  // Memory properties — emit in chunks to avoid huge strings
  emitMemoryPropertiesStreaming(memOpts, writeStream);
  w(emitWriteSlotProperties());

  // 2. Utility @functions
  w(emitCSSLib());

  // 3. Decode @functions
  w(emitDecodeFunction());

  // 4. Flag computation @functions
  w(emitFlagFunctions());
  w(emitShiftFlagFunctions());
  w(emitShiftByNFlagFunctions());

  // 5. readMem @function
  w('/* ===== MEMORY READ ===== */');
  emitReadMemStreaming(memOpts, writeStream);

  // 6. Clock and CPU base
  w('/* ===== EXECUTION ENGINE ===== */');
  w(emitClockAndCpuBase({ htmlMode }));

  // 7. .cpu rule body — buffer reads, aliases, decode, dispatch, write rules
  writeStream.write('  /* Double-buffer reads */\n');
  w(emitBufferReads(templateOpts));
  emitMemoryBufferReadsStreaming(memOpts, writeStream);
  writeStream.write('\n');
  writeStream.write('  /* Register aliases (8-bit halves) */\n');
  w(emitRegisterAliases());
  w(emitDecodeProperties());

  // Per-register dispatch tables
  writeStream.write('  /* ===== REGISTER DISPATCH TABLES ===== */\n');
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

  // Per-byte memory write rules
  writeStream.write('  /* ===== MEMORY WRITE RULES ===== */\n');
  emitMemoryWriteRulesStreaming(memOpts, writeStream);

  // Close .cpu rule
  w('}');

  // 8. Debug display
  w(emitDebugDisplay(templateOpts));

  // 9. Keyframes — store
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
  const { memSize } = opts;
  const initMem = buildInitialMemory(opts);
  let buf = '';
  for (let addr = 0; addr < memSize; addr++) {
    const init = initMem.get(addr) || 0;
    buf += `@property --m${addr} {\n  syntax: '<integer>';\n  inherits: true;\n  initial-value: ${init};\n}\n\n`;
    if (addr % CHUNK === CHUNK - 1) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitReadMemStreaming(opts, ws) {
  const { memSize, biosBytes } = opts;
  ws.write(`@function --readMem(--at <integer>) returns <integer> {\n  result: if(\n`);
  let buf = '';
  // Writable memory region
  for (let addr = 0; addr < memSize; addr++) {
    buf += `    style(--at: ${addr}): var(--__1m${addr});\n`;
    if (addr % CHUNK === CHUNK - 1) { ws.write(buf); buf = ''; }
  }
  // BIOS region (read-only constants) — always included regardless of memSize
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
  const { memSize } = opts;
  const initMem = buildInitialMemory(opts);
  let buf = '';
  for (let addr = 0; addr < memSize; addr++) {
    const init = initMem.get(addr) || 0;
    buf += `  --__1m${addr}: var(--__2m${addr}, ${init});\n`;
    if (addr % CHUNK === CHUNK - 1) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryWriteRulesStreaming(opts, ws) {
  const { memSize } = opts;
  let buf = '';
  for (let addr = 0; addr < memSize; addr++) {
    buf += `  --m${addr}: if(
    style(--memAddr0: ${addr}): var(--memVal0);
    style(--memAddr1: ${addr}): var(--memVal1);
    style(--memAddr2: ${addr}): var(--memVal2);
    style(--memAddr3: ${addr}): var(--memVal3);
    style(--memAddr4: ${addr}): var(--memVal4);
    style(--memAddr5: ${addr}): var(--memVal5);
  else: var(--__1m${addr}));\n`;
    if (addr % CHUNK === CHUNK - 1) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryStoreKeyframeStreaming(opts, ws) {
  const { memSize } = opts;
  const initMem = buildInitialMemory(opts);
  let buf = '';
  for (let addr = 0; addr < memSize; addr++) {
    const init = initMem.get(addr) || 0;
    buf += `    --__2m${addr}: var(--__0m${addr}, ${init});\n`;
    if (addr % CHUNK === CHUNK - 1) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

function emitMemoryExecuteKeyframeStreaming(opts, ws) {
  const { memSize } = opts;
  let buf = '';
  for (let addr = 0; addr < memSize; addr++) {
    buf += `    --__0m${addr}: var(--m${addr});\n`;
    if (addr % CHUNK === CHUNK - 1) { ws.write(buf); buf = ''; }
  }
  if (buf) ws.write(buf);
}

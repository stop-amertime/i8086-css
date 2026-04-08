// Top-level CSS generation orchestrator.
// Collects dispatch entries from all opcode emitters, assembles per-register
// dispatch tables, and combines with infrastructure (clock, memory, decode).

import { emitCSSLib } from './css-lib.mjs';
import { emitDecodeFunction, emitDecodeProperties } from './decode.mjs';
import {
  emitPropertyDecls, emitBufferReads, emitRegisterAliases,
  emitStoreKeyframe, emitExecuteKeyframe, emitClockKeyframes,
  emitClockAndCpuBase, emitDebugDisplay, emitHTML,
} from './template.mjs';
import {
  emitReadMem, emitMemoryProperties, emitMemoryWriteRules,
  emitMemoryBufferReads, emitMemoryStoreKeyframe,
  emitMemoryExecuteKeyframe, emitWriteSlotProperties,
} from './memory.mjs';
import { emitFlagFunctions } from './patterns/flags.mjs';

// Opcode emitters
import { emitMOV_RegImm16, emitMOV_RegImm8, emitMOV_RegRM } from './patterns/mov.mjs';
import { emitAllALU } from './patterns/alu.mjs';
import { emitAllControl } from './patterns/control.mjs';
import { emitAllStack } from './patterns/stack.mjs';
import { emitHLT, emitNOP } from './patterns/misc.mjs';

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
   */
  emitRegisterDispatch(reg, defaultExpr) {
    const entries = this.regEntries.get(reg);
    if (!entries || entries.size === 0) {
      return `  --${reg}: ${defaultExpr};`;
    }

    const lines = [];
    lines.push(`  --${reg}: if(`);

    // Sort by opcode for readability
    const sorted = [...entries.entries()].sort(([a], [b]) => a - b);
    for (const [opcode, { expr, comment }] of sorted) {
      const hex = '0x' + opcode.toString(16).toUpperCase().padStart(2, '0');
      const commentStr = comment ? ` /* ${comment} */` : '';
      lines.push(`    style(--opcode: ${opcode}): ${expr};${commentStr}`);
    }

    lines.push(`  else: ${defaultExpr});`);
    return lines.join('\n');
  }

  /**
   * Emit the 3 memory write slot properties (--memAddr0/Val0 through --memAddr2/Val2).
   * Each slot aggregates across all opcodes that use it.
   */
  emitMemoryWriteSlots() {
    // Collect all opcodes' memory writes, assign to slots 0, 1, 2
    const slots = [[], [], []]; // slot index → [{opcode, addrExpr, valExpr}]

    for (const [opcode, writes] of this.memWritesByOpcode) {
      if (writes.length > 3) {
        throw new Error(`Opcode 0x${opcode.toString(16)} uses ${writes.length} memory write slots (max 3)`);
      }
      for (let i = 0; i < writes.length; i++) {
        slots[i].push({ opcode, ...writes[i] });
      }
    }

    const lines = [];
    for (let slot = 0; slot < 3; slot++) {
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
 */
export function emitCSS(opts) {
  const { programBytes, biosBytes, memSize, embeddedData, htmlMode, programOffset } = opts;

  const memOpts = { memSize, programBytes, biosBytes, embeddedData, programOffset };
  const templateOpts = { memSize, programOffset };

  // Build dispatch table
  const dispatch = new DispatchTable();

  // Register all opcode emitters
  emitMOV_RegImm16(dispatch);
  emitMOV_RegImm8(dispatch);
  emitMOV_RegRM(dispatch);
  emitAllALU(dispatch);       // ADD/SUB/CMP/AND/OR/XOR/ADC/SBB/TEST/INC/DEC
  emitAllControl(dispatch);   // JMP/Jcc/CALL/RET
  emitAllStack(dispatch);     // PUSH/POP/PUSHF/POPF
  emitHLT(dispatch);
  emitNOP(dispatch);

  // Assemble CSS
  const sections = [];

  // 1. @property declarations
  sections.push('/* ===== PROPERTY DECLARATIONS ===== */');
  sections.push(emitPropertyDecls(templateOpts));
  sections.push(emitMemoryProperties(memOpts));
  sections.push(emitWriteSlotProperties());

  // 2. Utility @functions
  sections.push(emitCSSLib());

  // 3. Decode @functions
  sections.push(emitDecodeFunction());

  // 4. Flag computation @functions
  sections.push(emitFlagFunctions());

  // 5. readMem @function
  sections.push('/* ===== MEMORY READ ===== */');
  sections.push(emitReadMem(memOpts));

  // 6. Clock and CPU base
  sections.push('/* ===== EXECUTION ENGINE ===== */');
  sections.push(emitClockAndCpuBase());

  // 7. .cpu rule body — buffer reads, aliases, decode, dispatch, write rules
  const cpuBody = [];
  cpuBody.push('  /* Double-buffer reads */');
  cpuBody.push(emitBufferReads(templateOpts));
  cpuBody.push(emitMemoryBufferReads(memOpts));
  cpuBody.push('');
  cpuBody.push('  /* Register aliases (8-bit halves) */');
  cpuBody.push(emitRegisterAliases());
  cpuBody.push('');
  cpuBody.push(emitDecodeProperties());
  cpuBody.push('');

  // Per-register dispatch tables
  cpuBody.push('  /* ===== REGISTER DISPATCH TABLES ===== */');
  const regOrder = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI',
                    'CS', 'DS', 'ES', 'SS', 'IP', 'flags', 'halt'];
  for (const reg of regOrder) {
    const defaultExpr = `var(--__1${reg})`;
    cpuBody.push(dispatch.emitRegisterDispatch(reg, defaultExpr));
  }
  cpuBody.push('');

  // Memory write slots
  cpuBody.push('  /* ===== MEMORY WRITE SLOTS ===== */');
  cpuBody.push(dispatch.emitMemoryWriteSlots());
  cpuBody.push('');

  // Per-byte memory write rules
  cpuBody.push('  /* ===== MEMORY WRITE RULES ===== */');
  cpuBody.push(emitMemoryWriteRules(memOpts));

  sections.push(cpuBody.join('\n'));

  // Close .cpu rule
  sections.push('}');

  // 8. Debug display
  sections.push(emitDebugDisplay(templateOpts));

  // 9. Keyframes
  // Store keyframe needs both register and memory entries
  const storeKf = emitStoreKeyframe(templateOpts);
  const storeKfWithMem = storeKf.replace(
    '  }\n}',
    emitMemoryStoreKeyframe(memOpts) + '\n  }\n}'
  );
  sections.push(storeKfWithMem);

  const execKf = emitExecuteKeyframe(templateOpts);
  const execKfWithMem = execKf.replace(
    '  }\n}',
    emitMemoryExecuteKeyframe(memOpts) + '\n  }\n}'
  );
  sections.push(execKfWithMem);

  sections.push(emitClockKeyframes());

  const css = sections.join('\n\n');

  if (htmlMode) {
    return emitHTML(css);
  }
  return css;
}

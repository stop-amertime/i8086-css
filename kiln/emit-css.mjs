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
   * Emit the 6 memory write slot properties (--memAddr0/Val0 through --memAddr5/Val5).
   * Each slot aggregates across all opcodes that use it.
   * 6 slots needed: INT pushes 3 words = 6 byte writes.
   *
   * Also emits --_slot0Live through --_slot5Live: 1 on ticks that use each
   * slot, 0 otherwise. These gate the per-byte memory write rules so that
   * non-writing instructions skip all slot checks entirely (calcite's
   * broadcast-write recogniser peels the gate off and skips the whole
   * address table when the gate is 0 — see
   * calcite/crates/calcite-core/src/pattern/broadcast_write.rs).
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
    // Stash opcode lists per slot so emitSlotLiveGates can emit the
    // --_slotNLive dispatches alongside the --memAddrN/--memValN ones.
    this._slotOpcodes = slots.map(entries => entries.map(e => e.opcode));

    // TF trap and IRQ delivery both push FLAGS/CS/IP — identical 6-write
    // shape. intAddr/intVal expresses those pushes; both --_tf and --_irqActive
    // dispatch through the same expressions.
    const ssBase = 'calc(var(--__1SS) * 16)';
    const intAddr = [
      `calc(${ssBase} + var(--__1SP) - 2)`,   // slot 0: FLAGS lo
      `calc(${ssBase} + var(--__1SP) - 1)`,   // slot 1: FLAGS hi
      `calc(${ssBase} + var(--__1SP) - 4)`,   // slot 2: CS lo
      `calc(${ssBase} + var(--__1SP) - 3)`,   // slot 3: CS hi
      `calc(${ssBase} + var(--__1SP) - 6)`,   // slot 4: IP lo
      `calc(${ssBase} + var(--__1SP) - 5)`,   // slot 5: IP hi
    ];
    const flagsPush = `var(--__1flags)`;
    const intVal = [
      `--lowerBytes(${flagsPush}, 8)`,          // FLAGS lo
      `--rightShift(${flagsPush}, 8)`,          // FLAGS hi
      `--lowerBytes(var(--__1CS), 8)`,          // CS lo
      `--rightShift(var(--__1CS), 8)`,          // CS hi
      `--lowerBytes(var(--__1IP), 8)`,          // IP lo
      `--rightShift(var(--__1IP), 8)`,          // IP hi
    ];

    const lines = [];
    // All 6 slots carry TF/IRQ frame pushes (FLAGS/CS/IP = 6 bytes).
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
   * Emit --_slot0Live through --_slot5Live: 1 on ticks where the slot is used,
   * 0 otherwise. Used to gate the per-byte memory write rules so non-writing
   * instructions skip all address checks.
   *
   * Slots 0-5 are the only ones consulted by the per-byte write rule (6-7 exist
   * but are always inactive there). TF trap and hardware IRQ push the 6-byte
   * FLAGS/CS/IP frame, so they force all six slots live.
   *
   * emitMemoryWriteSlots() must be called before this so _slotOpcodes is populated.
   */
  emitSlotLiveGates() {
    if (!this._slotOpcodes) {
      throw new Error('emitMemoryWriteSlots must be called before emitSlotLiveGates');
    }
    const lines = ['  /* Slot-live gates — skip per-byte memory write checks when no slot fires this tick */'];
    for (let slot = 0; slot < NUM_WRITE_SLOTS; slot++) {
      const opcodes = this._slotOpcodes[slot];
      const branches = [];
      // TF trap and IRQ delivery push FLAGS/CS/IP — all slots live.
      branches.push(`    style(--_tf: 1): 1;`);
      branches.push(`    style(--_irqActive: 1): 1;`);
      for (const op of opcodes) {
        branches.push(`    style(--opcode: ${op}): 1;`);
      }
      lines.push(`  --_slot${slot}Live: if(`);
      lines.push(branches.join('\n'));
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
  // Each byte's write rule checks the 6 memory write slots to see if the
  // current tick is writing to this address. Every slot is gated by
  // --_slotNLive: a per-tick dispatch that's 1 only when some opcode uses
  // slot N (or TF/IRQ is pushing). Non-writing instructions set all six
  // gates to 0, so every branch rejects at its slotNLive check without
  // touching --memAddrN.
  //
  // CSS `style(A) and style(B)` short-circuits on the first false operand,
  // so idle ticks pay one style-query per slot per byte. Calcite's
  // broadcast-write recogniser (pattern/broadcast_write.rs) peels each
  // gate off and compiles the whole shape to a gated address-table lookup —
  // skipping the entire table when the gate reads 0.
  const { addresses } = opts;
  if (PACK_SIZE === 1) {
    let buf = '';
    let count = 0;
    for (const addr of addresses) {
      const hold = `var(--__1m${addr})`;
      buf +=
        `  --m${addr}: if(\n` +
        `    style(--_slot0Live: 1) and style(--memAddr0: ${addr}): var(--memVal0);\n` +
        `    style(--_slot1Live: 1) and style(--memAddr1: ${addr}): var(--memVal1);\n` +
        `    style(--_slot2Live: 1) and style(--memAddr2: ${addr}): var(--memVal2);\n` +
        `    style(--_slot3Live: 1) and style(--memAddr3: ${addr}): var(--memVal3);\n` +
        `    style(--_slot4Live: 1) and style(--memAddr4: ${addr}): var(--memVal4);\n` +
        `    style(--_slot5Live: 1) and style(--memAddr5: ${addr}): var(--memVal5);\n` +
        `    else: ${hold});\n`;
      if (++count % CHUNK === 0) { ws.write(buf); buf = ''; }
    }
    if (buf) ws.write(buf);
    return;
  }
  // Packed: each cell's value is a 6-level cascade of --applySlot calls.
  // Slot 0 is outermost (applied last) so it wins on same-cell collisions —
  // matching the legacy top-down byte-level dispatch semantics. Every
  // --applySlot short-circuits to its input cell when the corresponding
  // --_slotNLive is 0, so idle ticks pay 6 style-query gates per cell.
  const cells = buildCellSet(addresses);
  let buf = '';
  let count = 0;
  for (const idx of cells) {
    // Build the cascade inside-out: start with __1mcIDX, then slot5, slot4,
    // ..., slot0.  The `${idx} * ${PACK_SIZE}` arithmetic (rather than the
    // pre-folded `${cellBase(idx)}`) is deliberate: it keeps the per-cell
    // digit run equal to the cell index, so the parser fast-path classifies
    // it as an Addr hole (not a Free hole) and can template the whole run.
    let expr = `var(--__1mc${idx})`;
    for (let slot = NUM_WRITE_SLOTS - 1; slot >= 0; slot--) {
      expr = `--applySlot(${expr}, var(--_slot${slot}Live), calc(var(--memAddr${slot}) - ${idx} * ${PACK_SIZE}), var(--memVal${slot}))`;
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

#!/usr/bin/env node
/**
 * CLI wrapper for buildCss.ts — runs via Node without Vite.
 * Usage: node build-cli.mjs <input.com> [--mem 0x600] [--start 0] [-o output.css]
 */

import { readFileSync, writeFileSync } from 'fs';
import { basename, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ──
const args = process.argv.slice(2);
let inputFile = null;
let memSize = 0x600;
let startOffset = 0;
let outputFile = null;
let video = { segment: 0xB800, size: 4000 };  // always allocate VGA text mode
let noVideo = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mem' && args[i + 1]) {
    memSize = parseInt(args[++i], 16) || 0x600;
  } else if (args[i] === '--start' && args[i + 1]) {
    startOffset = parseInt(args[++i]) || 0;
  } else if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) {
    outputFile = args[++i];
  } else if (args[i] === '--video' && args[i + 1]) {
    // e.g. --video B800:4000  (segment:size)
    const parts = args[++i].split(':');
    video = {
      segment: parseInt(parts[0], 16),
      size: parseInt(parts[1]) || 4000,
    };
  } else if (args[i] === '--no-video') {
    noVideo = true;
  } else if (!inputFile) {
    inputFile = args[i];
  }
}
if (noVideo) video = null;

if (!inputFile) {
  console.error('Usage: node build-cli.mjs <input.com> [--mem 0x600] [--start N] [--video B800:4000] [-o output.css]');
  process.exit(1);
}

// ── Load dependencies that buildCss.ts imports via Vite ──
const instructionsJson = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'x86-instructions-rebane.json'), 'utf-8')
);
const templateCss = readFileSync(
  resolve(__dirname, '..', 'base_template.css'), 'utf-8'
);

// ── Inline the buildCss logic (copied from buildCss.ts, adapted for Node) ──

const CPU_CYCLE_MS = 1024;
const PROG_OFFSET = 0x100;
const SCREEN_RAM_POS = 0x300;
const EXTERNAL_FUNCTIONS_START = 0x2000;
const EXTERNAL_FUNCTIONS_END = 0x2010;
const EXTERNAL_IO_START = 0x2100;
const EXTERNAL_IO_END = 0x2110;

const EXTFUNS = {
  writeChar1: [0x2000, 2],
  writeChar4: [0x2002, 2],
  writeChar8: [0x2004, 2],
  readInput:  [0x2006, 0],
};

const ARGS_LIST = [
  null, "Ap", "Eb", "Ev", "Ew", "Gb", "Gv", "I0", "Ib", "Iv", "Iw",
  "Jb", "Jv", "Mp", "Ob", "Ov", "Sw",
  "AL", "CL", "DL", "BL", "AH", "CH", "DH", "BH",
  "eAX", "eCX", "eDX", "eBX", "eSP", "eBP", "eSI", "eDI",
  "ES", "CS", "SS", "DS", "1", "3", "M",
];

function buildCharset() {
  const raw =
    "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" +
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
    "X".repeat(141);
  const chars = [...raw];
  chars[0] = "";
  chars[0x0a] = "\\a ";
  chars[0x22] = '\\"';
  chars[0x5c] = "\\\\";
  chars[0x80] = "\u{1F434}";
  chars[0x81] = "\u2B1B";
  chars[0x82] = "\u{1F7E8}";
  chars[0x83] = "\u{1F7E9}";
  chars[0x84] = "\u2591";
  chars[0x85] = "\u2588";
  return chars;
}

function createChosenMemoryInt(name, i, render, chosen) {
  const prevLine = i > 0
    ? `style(--addrDestA:${i - 1}) and style(--isWordWrite:1):var(--addrValA2);`
    : "";
  return [name, `if(style(--addrDestA:${i}):var(--addrValA1);${prevLine}style(--addrDestB:${i}):var(--addrValB);else:var(--__1${name}))`, String(chosen), render];
}

function createEmptyInt(name, i, render) {
  return [name, `if(style(--addrDestA:${i}):var(--addrValA);style(--addrDestB:${i}):var(--addrValB);else:var(--__1${name}))`, "0", render];
}

function createSplitRegister(name, i, render) {
  const keyboardClause = name === "AX" ? `style(--__1IP:${0x2006}):var(--keyboard, 0);` : "";
  return [name,
    `if(${keyboardClause}` +
    `style(--addrDestA:${i}):var(--addrValA);style(--addrDestB:${i}):var(--addrValB);` +
    `style(--addrDestA:${i - 20}):calc(var(--addrValA) * 256 + --lowerBytes(var(--__1${name}), 8));` +
    `style(--addrDestB:${i - 20}):calc(var(--addrValB) * 256 + --lowerBytes(var(--__1${name}), 8));` +
    `style(--addrDestA:${i - 30}):calc(round(down, var(--__1${name}) / 256) * 256 + --lowerBytes(var(--addrValA), 8));` +
    `style(--addrDestB:${i - 30}):calc(round(down, var(--__1${name}) / 256) * 256 + --lowerBytes(var(--addrValB), 8));` +
    `else:var(--__1${name}))`, "0", render];
}

function buildCss(binary, options = {}) {
  const MEM_SIZE = options.memSize ?? 0x600;
  const embeddedData = options.embeddedData ?? [];
  const CODE_START = PROG_OFFSET + (options.startOffset ?? 0);
  const allInsts = instructionsJson;

  const variables = [["frame-count", "& + 1", "0", true]];

  variables.push(createSplitRegister("AX", -1, true));
  variables.push(createSplitRegister("CX", -2, true));
  variables.push(createSplitRegister("DX", -3, true));
  variables.push(createSplitRegister("BX", -4, true));
  variables.push(["SP", `if(style(--addrDestA:-5):var(--addrValA);style(--addrDestB:-5):var(--addrValB);else:calc(var(--__1SP) + var(--moveStack)))`, String(MEM_SIZE - 0x8), true]);
  variables.push(createEmptyInt("BP", -6, true));
  variables.push(["SI", `if(style(--addrDestA:-7):var(--addrValA);style(--addrDestB:-7):var(--addrValB);else:calc(var(--__1SI) + var(--moveSI)))`, "0", true]);
  variables.push(["DI", `if(style(--addrDestA:-8):var(--addrValA);style(--addrDestB:-8):var(--addrValB);else:calc(var(--__1DI) + var(--moveDI)))`, "0", true]);
  variables.push(["IP", `if(style(--addrDestA:-9):var(--addrValA);style(--addrDestB:-9):var(--addrValB);style(--addrJump:-1):calc(var(--__1IP) + var(--instLen));else:var(--addrJump))`, String(CODE_START), true]);
  variables.push(createEmptyInt("ES", -10, true));
  variables.push(["CS", `if(style(--addrDestA:-11):var(--addrValA);style(--addrDestB:-11):var(--addrValB);else:var(--jumpCS))`, "0", true]);
  variables.push(createEmptyInt("SS", -12, true));
  variables.push(createEmptyInt("DS", -13, true));
  variables.push(["flags", `if(style(--addrDestA:-14):var(--addrValA);style(--addrDestB:-14):var(--addrValB);else:var(--newFlags))`, "0", true]);

  const varOffset = variables.length;

  for (let i = 0; i < MEM_SIZE; i++) {
    variables.push(createChosenMemoryInt(`m${i}`, i, true, i < PROG_OFFSET ? 0x90 : 0));
  }
  variables[0 + varOffset][2] = String(0xCC);

  for (let i = EXTERNAL_FUNCTIONS_START; i < EXTERNAL_FUNCTIONS_END; i++) {
    const targetLoc = varOffset + i;
    if (targetLoc >= variables.length) {
      variables.push(createChosenMemoryInt(`m${i}`, i, true, 0xC3));
    } else {
      variables[targetLoc][2] = String(0xC3);
    }
  }

  for (let i = EXTERNAL_IO_START; i < EXTERNAL_IO_END; i++) {
    const targetLoc = varOffset + i;
    if (targetLoc >= variables.length) {
      variables.push(createChosenMemoryInt(`m${i}`, i, true, 0x00));
    } else {
      variables[targetLoc][2] = String(0x00);
    }
  }

  // Video memory region (e.g. B800h segment for text-mode VGA)
  const videoOpt = options.video;
  if (videoOpt) {
    const videoBase = videoOpt.segment * 16;
    for (let i = 0; i < videoOpt.size; i++) {
      // Even bytes = char (space 0x20), odd bytes = attr (grey-on-black 0x07)
      const initVal = (i % 2 === 0) ? 0x20 : 0x07;
      variables.push(createChosenMemoryInt(`v${i}`, videoBase + i, true, initVal));
    }
  }

  // ── BIOS integration ──
  // Load BIOS binary and place at segment F000:0000 (linear 0xF0000).
  // Set up IVT entries at 0x0000 to point to BIOS handlers.
  // Memory-mapped I/O ports for keyboard, timer, file state.
  const biosOpt = options.bios;
  if (biosOpt) {
    const biosBase = biosOpt.segment * 16;  // 0xF0000
    const biosBinary = biosOpt.binary;

    // BIOS code as read-only memory variables
    for (let i = 0; i < biosBinary.length; i++) {
      variables.push(createChosenMemoryInt(`bios${i}`, biosBase + i, false, biosBinary[i]));
    }

    // Set up IVT entries at address 0 (4 bytes each: IP_lo, IP_hi, CS_lo, CS_hi).
    // Handler offsets within the BIOS binary:
    const handlers = biosOpt.handlers || {
      0x10: 0x0000,  // INT 10h — Video
      0x16: 0x0174,  // INT 16h — Keyboard
      0x1A: 0x01B7,  // INT 1Ah — Timer
      0x20: 0x03C8,  // INT 20h — Program terminate
      0x21: 0x01D0,  // INT 21h — DOS
    };
    const biosSeg = biosOpt.segment;  // 0xF000

    for (const [intNum, handlerOff] of Object.entries(handlers)) {
      const ivtAddr = parseInt(intNum) * 4;
      // Write IVT entry: [IP_lo, IP_hi, CS_lo, CS_hi]
      const ipLo = handlerOff & 0xFF;
      const ipHi = (handlerOff >> 8) & 0xFF;
      const csLo = biosSeg & 0xFF;
      const csHi = (biosSeg >> 8) & 0xFF;
      // Set initial values in memory at IVT addresses
      variables[varOffset + ivtAddr][2] = String(ipLo);
      variables[varOffset + ivtAddr + 1][2] = String(ipHi);
      variables[varOffset + ivtAddr + 2][2] = String(csLo);
      variables[varOffset + ivtAddr + 3][2] = String(csHi);
    }

    // BDA: cursor position at 0x0450/0x0451 (initialized to 0 by default)
    // Already within MEM_SIZE, no extra allocation needed.

    // Memory-mapped I/O: keyboard at 0x0500, timer at 0x0502
    // These are regular memory cells but with special default values.
    // Keyboard (0x500-0x501): reads from --keyboard variable when not explicitly written
    const kbAddr = 0x0500;
    variables[varOffset + kbAddr] = ["m" + kbAddr,
      `if(style(--addrDestA:${kbAddr}):var(--addrValA1);` +
      `style(--addrDestB:${kbAddr}):var(--addrValB);` +
      `else:--lowerBytes(var(--keyboard, 0), 8))`,
      "0", false];
    variables[varOffset + kbAddr + 1] = ["m" + (kbAddr + 1),
      `if(style(--addrDestA:${kbAddr + 1}):var(--addrValA1);` +
      `style(--addrDestA:${kbAddr}) and style(--isWordWrite:1):var(--addrValA2);` +
      `style(--addrDestB:${kbAddr + 1}):var(--addrValB);` +
      `else:--rightShift(var(--keyboard, 0), 8))`,
      "0", false];

    // Timer (0x502-0x503): reads from frame-count
    const timerAddr = 0x0502;
    variables[varOffset + timerAddr] = ["m" + timerAddr,
      `if(style(--addrDestA:${timerAddr}):var(--addrValA1);` +
      `style(--addrDestB:${timerAddr}):var(--addrValB);` +
      `else:--lowerBytes(var(--__1frame-count), 8))`,
      "0", false];
    variables[varOffset + timerAddr + 1] = ["m" + (timerAddr + 1),
      `if(style(--addrDestA:${timerAddr + 1}):var(--addrValA1);` +
      `style(--addrDestA:${timerAddr}) and style(--isWordWrite:1):var(--addrValA2);` +
      `style(--addrDestB:${timerAddr + 1}):var(--addrValB);` +
      `else:--rightShift(var(--__1frame-count), 8))`,
      "0", false];
  }

  const programStart = PROG_OFFSET + varOffset;
  for (let i = 0; i < binary.length; i++) {
    variables[programStart + i][2] = String(binary[i]);
  }

  const variablesRw = [...variables.slice(0, programStart), ...variables.slice(programStart + binary.length)];
  const variablesRo = variables.slice(programStart, programStart + binary.length);

  const embeddedVars = [];
  for (const ed of embeddedData) {
    for (let offset = 0; offset < ed.data.length; offset++) {
      embeddedVars.push({ name: `d${ed.address + offset}`, addr: ed.address + offset, val: ed.data[offset] });
    }
  }

  // Initialize file I/O metadata at BIOS data area (0x0504-0x050A)
  // for programs that use embedded file data
  if (embeddedData.length > 0 && biosOpt) {
    const firstEmbed = embeddedData[0];
    const totalSize = embeddedData.reduce((acc, ed) => acc + ed.data.length, 0);
    // FILE_DATA_SEG (0x0504-0x0505): segment of embedded data (always 0 for flat model)
    variables[varOffset + 0x0504][2] = "0";
    variables[varOffset + 0x0505][2] = "0";
    // FILE_DATA_OFF (0x0506-0x0507): offset of embedded data
    variables[varOffset + 0x0506][2] = String(firstEmbed.address & 0xFF);
    variables[varOffset + 0x0507][2] = String((firstEmbed.address >> 8) & 0xFF);
    // FILE_DATA_SZ (0x0508-0x0509): total size of embedded data
    variables[varOffset + 0x0508][2] = String(totalSize & 0xFF);
    variables[varOffset + 0x0509][2] = String((totalSize >> 8) & 0xFF);
    // FILE_POS (0x050A-0x050B): current file position (starts at 0)
    variables[varOffset + 0x050A][2] = "0";
    variables[varOffset + 0x050B][2] = "0";
  }

  let TEMPL = templateCss;
  for (const [k, v] of Object.entries(EXTFUNS)) {
    TEMPL = TEMPL.replaceAll(`#${k}`, String(v[0]));
  }

  const charset = buildCharset();

  const vars1 = variables.map(v => `@property --${v[0]} {\n  syntax: "<integer>";\n  initial-value: ${v[2]};\n  inherits: true;\n}`).join("\n");
  const vars2a = variablesRw.map(v => `--__1${v[0]}: var(--__2${v[0]}, ${v[2]});`).join("\n") + "\n" + variablesRo.map(v => `--__1${v[0]}: ${v[2]};`).join("\n");
  const vars2b = variables.map(v => `--${v[0]}: calc(${v[1].replace(/&/g, `var(--__1${v[0]})`)});`).join("\n");
  const vars3 = variablesRw.map(v => `--__2${v[0]}: var(--__0${v[0]}, ${v[2]});`).join("\n");
  const vars4 = variablesRw.map(v => `--__0${v[0]}: var(--${v[0]});`).join("\n");
  const vars5 = variables.filter(v => v[3]).map(v => ` ${v[0]} var(--${v[0]})`).join(" ");
  const vars6 = variables.filter(v => v[3]).map(v => `"\\a --${v[0]}: " counter(${v[0]})`).join(" ");

  let readmem1 = `\nstyle(--at:-1): var(--__1AX);\nstyle(--at:-2): var(--__1CX);\nstyle(--at:-3): var(--__1DX);\nstyle(--at:-4): var(--__1BX);\nstyle(--at:-5): var(--__1SP);\nstyle(--at:-6): var(--__1BP);\nstyle(--at:-7): var(--__1SI);\nstyle(--at:-8): var(--__1DI);\nstyle(--at:-9): var(--__1IP);\nstyle(--at:-10):var(--__1ES);\nstyle(--at:-11):var(--__1CS);\nstyle(--at:-12):var(--__1SS);\nstyle(--at:-13):var(--__1DS);\nstyle(--at:-14):var(--__1flags);\nstyle(--at:-21):var(--AH);\nstyle(--at:-22):var(--CH);\nstyle(--at:-23):var(--DH);\nstyle(--at:-24):var(--BH);\nstyle(--at:-31):var(--AL);\nstyle(--at:-32):var(--CL);\nstyle(--at:-33):var(--DL);\nstyle(--at:-34):var(--BL);`;

  const memParts = [];
  for (let i = 0; i < MEM_SIZE; i++) memParts.push(`style(--at:${i}):var(--__1m${i})`);
  readmem1 += memParts.join(";");

  const extFunParts = [];
  for (let i = EXTERNAL_FUNCTIONS_START; i < EXTERNAL_FUNCTIONS_END; i++) extFunParts.push(`style(--at:${i}):var(--__1m${i})`);
  readmem1 += ";" + extFunParts.join(";");

  const extIoParts = [];
  for (let i = EXTERNAL_IO_START; i < EXTERNAL_IO_END; i++) extIoParts.push(`style(--at:${i}):var(--__1m${i})`);
  readmem1 += ";" + extIoParts.join(";");

  if (embeddedVars.length > 0) {
    readmem1 += ";" + embeddedVars.map(ev => `style(--at:${ev.addr}):${ev.val}`).join(";");
  }

  // Video memory readMem entries
  if (videoOpt) {
    const videoBase = videoOpt.segment * 16;
    const videoParts = [];
    for (let i = 0; i < videoOpt.size; i++) videoParts.push(`style(--at:${videoBase + i}):var(--__1v${i})`);
    readmem1 += ";" + videoParts.join(";");
  }

  // BIOS code readMem entries (read-only)
  if (biosOpt) {
    const biosBase = biosOpt.segment * 16;
    const biosParts = [];
    for (let i = 0; i < biosOpt.binary.length; i++) {
      biosParts.push(`style(--at:${biosBase + i}):var(--__1bios${i})`);
    }
    readmem1 += ";" + biosParts.join(";");
  }

  const instId1 = allInsts.map(v => `style(--inst0:${v.opcode})${v.group !== null ? ` and style(--modRm_reg:${v.group})` : ""}:${v.inst_id}`).join(";");
  const instStr1 = allInsts.map(v => `style(--instId:${v.inst_id}):'${v.name}'`).join(";");

  const instDest1Parts = [], instVal1Parts = [], instFlagfun1Parts = [];
  for (const v of allInsts) {
    const safeName = v.name.replace(/\./g, "_").replace(/:/g, "_");
    const dFun = `--D-${safeName}`;
    if (TEMPL.includes(dFun + "(")) instDest1Parts.push(`style(--instId:${v.inst_id}):${dFun}(var(--w))`);
    const vFun = `--V-${safeName}`;
    if (TEMPL.includes(vFun + "(")) instVal1Parts.push(`style(--instId:${v.inst_id}):${vFun}(var(--w))`);
    const fFun = `--F-${safeName}`;
    if (TEMPL.includes(fFun + "(")) instFlagfun1Parts.push(`style(--instId:${v.inst_id}):${fFun}(var(--baseFlags))`);
  }

  const instLen1 = allInsts.filter(v => v.length !== 1).map(v => `style(--instId:${v.inst_id}):${v.length}`).join(";");
  const instModrm1 = allInsts.filter(v => v.modrm).map(v => `style(--instId:${v.inst_id}):1`).join(";");
  const instMovestack1 = allInsts.filter(v => v.stack).map(v => `style(--instId:${v.inst_id}):${v.stack}`).join(";");
  const instArgs1 = allInsts.filter(v => v.arg1).map(v => `style(--instId:${v.inst_id}):${ARGS_LIST.indexOf(v.arg1)}`).join(";");
  const instArgs2 = allInsts.filter(v => v.arg2).map(v => `style(--instId:${v.inst_id}):${ARGS_LIST.indexOf(v.arg2)}`).join(";");
  const instFlags1 = allInsts.filter(v => v.flags).map(v => `style(--instId:${v.inst_id}):${v.flags}`).join(";");
  const charmap1 = charset.map((c, i) => `style(--i:${i}):"${c}"`).join(";");

  const MAX_STRING = 5;
  const readstr1Parts = [];
  for (let i = 1; i < MAX_STRING; i++) readstr1Parts.push(`--c${i}: --readMem(calc(var(--at) + ${i}));`);
  const readstr1 = readstr1Parts.join("\n");

  let readstr2 = "";
  for (let i = 0; i < MAX_STRING; i++) {
    let fullstr = "";
    for (let j = 0; j < i; j++) fullstr += `--i2char(var(--c${j})) `;
    if (i < MAX_STRING - 1) readstr2 += `style(--c${i}:0): ${fullstr};`;
    else readstr2 += `else:${fullstr}`;
  }

  const boxShadowParts = [];
  for (let x = 0; x < 128; x++) {
    for (let y = 0; y < 12; y++) {
      const memOff = x + y * 128;
      boxShadowParts.push(`${x * 8}px ${y * 8 + 8}px rgb(var(--m${memOff}), var(--m${memOff}), var(--m${memOff}))`);
    }
  }
  const boxShadowScrn = boxShadowParts.join(",");

  const totalEmbeddedSize = embeddedData.reduce((acc, ed) => acc + ed.data.length, 0);

  return TEMPL
    .replace("CPU_CYCLE_MS", String(CPU_CYCLE_MS))
    .replace("READMEM_1", readmem1)
    .replace("INST_STR1", instStr1)
    .replace("INST_ID1", instId1)
    .replace("INST_DEST1", instDest1Parts.join(";"))
    .replace("INST_VAL1", instVal1Parts.join(";"))
    .replace("INST_LEN1", instLen1)
    .replace("INST_MODRM1", instModrm1)
    .replace("INST_MOVESTACK1", instMovestack1)
    .replace("INST_ARGS1", instArgs1)
    .replace("INST_ARGS2", instArgs2)
    .replace("INST_FLAGS1", instFlags1)
    .replace("INST_FLAGFUN1", instFlagfun1Parts.join(";"))
    .replace("READSTR1", readstr1)
    .replace("READSTR2", readstr2)
    .replace("VARS_1", vars1)
    .replace("VARS_2a", vars2a)
    .replace("VARS_2b", vars2b)
    .replace("VARS_3", vars3)
    .replace("VARS_4", vars4)
    .replace("VARS_5", vars5)
    .replace("VARS_6", vars6)
    .replace("BOX_SHADOW_SCRN", boxShadowScrn)
    .replace("CHARMAP1", charmap1)
    .replace("SCREEN_CR", "")
    .replace("SCREEN_CC", "")
    .replace("SCREEN_RAM_POS", String(SCREEN_RAM_POS));
}

// ── Run ──
const binary = readFileSync(resolve(inputFile));

// Load BIOS binary if it exists
let biosOption = null;
const biosPath = resolve(__dirname, '..', 'gossamer.bin');
try {
  const biosBinary = readFileSync(biosPath);
  biosOption = {
    segment: 0xF000,
    binary: Array.from(biosBinary),
    handlers: {
      0x10: 0x0000,  // INT 10h — Video
      0x16: 0x0155,  // INT 16h — Keyboard
      0x1A: 0x0190,  // INT 1Ah — Timer
      0x20: 0x0232,  // INT 20h — Program terminate
      0x21: 0x01A9,  // INT 21h — DOS
    },
  };
  console.log(`BIOS: ${biosBinary.length} bytes loaded from ${biosPath}`);
} catch (e) {
  console.warn(`Warning: No BIOS binary found at ${biosPath} — INT instructions will crash`);
}

const t0 = performance.now();
const css = buildCss(binary, { memSize, startOffset, video, bios: biosOption });
const elapsed = (performance.now() - t0).toFixed(0);

if (!outputFile) {
  outputFile = basename(inputFile).replace(/\.[^.]+$/, '') + '.css';
}

writeFileSync(outputFile, css, 'utf-8');
const sizeKB = (css.length / 1024).toFixed(1);
console.log(`${basename(inputFile)} → ${outputFile} (${sizeKB} KB) in ${elapsed}ms`);

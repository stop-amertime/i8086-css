#!/usr/bin/env node
// Generate test .COM binaries for the "hard three" features:
// 1. Shift by CL (0xD2/0xD3)
// 2. REP prefix with string ops
// 3. Segment overrides
//
// Each test stores results in registers and halts via INT 20h.

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper: encode instruction bytes
function u16le(val) {
  return [val & 0xFF, (val >> 8) & 0xFF];
}

// ===== Test 1: Shift by CL =====
// Tests SHL, SHR, SAR, ROL, ROR with various CL values.
// Expected: specific register values after each shift.
function genShiftByCL() {
  const code = [
    // MOV AX, 0x1234
    0xB8, ...u16le(0x1234),
    // MOV CL, 4
    0xB1, 0x04,
    // SHL AX, CL (0xD3 /4) — AX = 0x1234 << 4 = 0x2340
    0xD3, 0xE0,  // D3 E0 = SHL AX, CL (mod=11, reg=4, rm=0)
    // Result: AX = 0x2340

    // MOV BX, AX (save result)
    0x89, 0xC3,  // MOV BX, AX

    // MOV AX, 0x8042
    0xB8, ...u16le(0x8042),
    // MOV CL, 3
    0xB1, 0x03,
    // SHR AX, CL (0xD3 /5) — AX = 0x8042 >> 3 = 0x1008
    0xD3, 0xE8,  // D3 E8 = SHR AX, CL (mod=11, reg=5, rm=0)
    // Result: AX = 0x1008

    // MOV DX, AX (save result)
    0x89, 0xC2,  // MOV DX, AX

    // MOV AX, 0xFF80  (negative in signed: -128)
    0xB8, ...u16le(0xFF80),
    // MOV CL, 2
    0xB1, 0x02,
    // SAR AX, CL (0xD3 /7) — AX = 0xFF80 >> 2 (arithmetic) = 0xFFE0
    0xD3, 0xF8,  // D3 F8 = SAR AX, CL (mod=11, reg=7, rm=0)
    // Result: AX = 0xFFE0

    // MOV SI, AX (save SAR result)
    0x89, 0xC6,  // MOV SI, AX

    // MOV AX, 0x1234
    0xB8, ...u16le(0x1234),
    // MOV CL, 4
    0xB1, 0x04,
    // ROL AX, CL (0xD3 /0) — AX = ROL(0x1234, 4) = 0x2341
    0xD3, 0xC0,  // D3 C0 = ROL AX, CL (mod=11, reg=0, rm=0)
    // Result: AX = 0x2341

    // MOV DI, AX (save ROL result)
    0x89, 0xC7,  // MOV DI, AX

    // MOV AX, 0x1234
    0xB8, ...u16le(0x1234),
    // MOV CL, 4
    0xB1, 0x04,
    // ROR AX, CL (0xD3 /1) — AX = ROR(0x1234, 4) = 0x4123
    0xD3, 0xC8,  // D3 C8 = ROR AX, CL (mod=11, reg=1, rm=0)
    // Result: AX = 0x4123

    // 8-bit shift: SHL AL, CL
    // MOV AL, 0x0F
    0xB0, 0x0F,
    // MOV CL, 2
    0xB1, 0x02,
    // SHL AL, CL (0xD2 /4) — AL = 0x0F << 2 = 0x3C
    0xD2, 0xE0,  // D2 E0 = SHL AL, CL (mod=11, reg=4, rm=0)
    // Result: AX low byte = 0x3C, high byte = 0x41 (from previous ROR high byte)

    // INT 20h — halt
    0xCD, 0x20,
  ];
  // Expected final state:
  // BX = 0x2340 (SHL 0x1234, 4)
  // DX = 0x1008 (SHR 0x8042, 3)
  // SI = 0xFFE0 (SAR 0xFF80, 2)
  // DI = 0x2341 (ROL 0x1234, 4)
  // AX = 0x413C (high from ROR, low from SHL AL)
  // CL = 2 (last set)
  return Buffer.from(code);
}

// ===== Test 2: REP STOSB =====
// Fill a memory region with a byte value using REP STOSB.
// Then read back to verify.
function genRepStosb() {
  const code = [
    // Set up: fill 5 bytes at ES:0x200 with 0x42
    // MOV AX, 0
    0xB8, ...u16le(0x0000),
    // MOV ES, AX
    0x8E, 0xC0,  // MOV ES, AX
    // MOV DI, 0x200
    0xBF, ...u16le(0x0200),
    // MOV CX, 5
    0xB9, ...u16le(0x0005),
    // MOV AL, 0x42
    0xB0, 0x42,
    // REP STOSB (0xF3 0xAA)
    0xF3, 0xAA,

    // Read back: AL should still be 0x42, DI should be 0x205, CX should be 0
    // Read first byte back into BL
    // MOV BX, [0x200]
    0x8B, 0x1E, ...u16le(0x0200),  // MOV BX, [0x0200]
    // Read last byte back into DX
    // MOV DX, [0x204]
    0x8B, 0x16, ...u16le(0x0204),  // MOV DX, [0x0204]

    // MOV SI, DI (save DI = should be 0x205)
    0x89, 0xFE,  // MOV SI, DI

    // INT 20h — halt
    0xCD, 0x20,
  ];
  // Expected final state:
  // CX = 0 (decremented from 5 to 0)
  // DI = 0x0205 (advanced from 0x200 by 5)
  // SI = 0x0205 (copy of DI)
  // AL = 0x42 (unchanged)
  // BX = 0x4242 (word read: [0x200]=0x42, [0x201]=0x42)
  // DX = 0x0042 (word read: [0x204]=0x42, [0x205]=0x00)
  return Buffer.from(code);
}

// Write out the test binaries
writeFileSync(resolve(__dirname, 'shift-cl.com'), genShiftByCL());
console.log('Generated shift-cl.com');

writeFileSync(resolve(__dirname, 'rep-stosb.com'), genRepStosb());
console.log('Generated rep-stosb.com');

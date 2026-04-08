// Miscellaneous instructions: HLT, NOP, etc.

/**
 * HLT (opcode 0xF4): halt execution.
 * Sets --halt to 1. IP does not advance.
 */
export function emitHLT(dispatch) {
  dispatch.addEntry('halt', 0xF4, `1`, `HLT`);
  // IP stays the same (halted)
  dispatch.addEntry('IP', 0xF4, `var(--__1IP)`, `HLT (IP unchanged)`);
}

/**
 * NOP (opcode 0x90): no operation.
 * IP advances by 1.
 */
export function emitNOP(dispatch) {
  dispatch.addEntry('IP', 0x90, `calc(var(--__1IP) + 1)`, `NOP`);
}

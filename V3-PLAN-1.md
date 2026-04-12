# v3: Cycle-Accurate Microcoded Execution Model

## What this document is

This is the implementation plan for CSS-DOS v3. It describes how the CPU execution model works, how instructions are encoded, how memory writes happen, and in what order things should be built. It is written to be read by someone who does not already know how v2 works — including an agent that is halfway through the rewrite and needs to understand the target architecture without reference to code that no longer exists.

## The problem v3 solves

CSS evaluates all properties simultaneously, once per tick. In an 8086, some instructions write multiple bytes to memory: PUSH writes 2 bytes, INT writes 6 bytes (pushing FLAGS, CS, and IP). CSS-DOS v2 handles this by providing 6 parallel memory write slots — each tick, up to 6 bytes can be written to memory simultaneously, each through its own address/value pair.

This works, but it causes structural problems:

- **BIOS handlers can't be expressed as CPU instructions.** A BIOS scroll routine needs to copy hundreds of bytes. 6 slots isn't enough. The BIOS has to live as precompiled assembly (Gossamer), separate from the CPU, with handler offsets duplicated across multiple files.
- **Debugging multi-write instructions is extremely difficult.** When something goes wrong during an INT or PUSH, you're looking at 6 address/value pairs all firing simultaneously. You can't tell which byte wrote incorrectly without reconstructing the full parallel state.
- **The TF (trap flag) override is a sprawling special case.** TF delivery is an INT 1, which needs 6 memory writes. To make it work, every register dispatch and all 6 memory slots are wrapped in a TF check. This doubles the surface area of the generated CSS for a feature almost nothing uses.
- **REP-prefixed string operations are a special case.** REP takes N ticks in CSS but 1 step in the reference emulator. The conformance tool has REP-specific alignment logic.
- **Generated CSS is large.** Each memory byte checks all 6 write slots every tick. For N bytes of memory, that's 6N dispatch cases in the memory write block — the single largest component of the generated file.

All of these are instances of the same underlying issue: some operations take multiple steps, and v2 tries to cram them into one tick.

## The core idea

On a real Intel 8086, instructions take a variable number of clock cycles to complete. Each cycle, the bus interface unit performs at most one bus transaction — one byte read or written. A microcode sequencer inside the CPU steps through micro-operations (μops), one per cycle, until the instruction is complete.

v3 models this directly. One CSS evaluation tick is one cycle. One cycle produces at most one memory byte write. Instructions that need multiple writes take multiple cycles. A new register, `--uOp`, tracks which micro-operation within the current instruction is being executed. When `--uOp` reaches the last step, the instruction retires: IP advances, `--uOp` resets to 0, and the next instruction begins.

This is not a new invention. It's how the hardware works. v3 implements the existing model instead of working around it.

## Terminology

| Term | Meaning |
|------|---------|
| **cycle** | One CSS evaluation step. One tick of the clock animation. Driven by the `--clock` keyframe. Was called "tick" in v2. |
| **instruction** | A sequence of one or more cycles producing one 8086 ISA effect. Bounded by IP advancing. |
| **μop** (`--uOp`) | One step within an instruction's cycle sequence. Tracked by the `--uOp` register. Starts at 0, advances each cycle, resets to 0 on retirement. |
| **retirement** | The cycle on which an instruction completes. IP advances past the instruction bytes. `--uOp` resets to 0 on the next cycle. |
| **routine** | A multi-cycle operation that is not a single 8086 instruction — typically a BIOS handler. Expressed using the same μop machinery as instructions. |

## How the execution engine works

### The double buffer

Every piece of CPU state is triple-buffered using CSS custom properties and animation keyframes. For a register like AX:

- `--AX` is the computed value for this cycle (the "write" side).
- `--__1AX` is the committed value from the previous cycle (the "read" side). All expressions read from `--__1*` properties.
- `--__2AX` and `--__0AX` are intermediate buffer stages used by the animation keyframes to move values between cycles.

The clock animation has 4 phases (`--clock: 0, 1, 2, 3`). Two keyframe animations run on the `.cpu` element:

- **Store** (fires on `--clock: 1`): copies `--__0X` → `--__2X` for every state variable.
- **Execute** (fires on `--clock: 3`): copies `--X` → `--__0X` for every state variable.

The effect is: each cycle, all `--__1*` properties hold the previous cycle's state (via `--__1X: var(--__2X, initial)`), all `--*` properties compute the new state as pure functions of `--__1*`, and the keyframes propagate the results forward.

This mechanism is unchanged from v2. v3 does not modify the double buffer, the clock animation, or the keyframe structure. The only change is what happens *within* a single cycle.

### The μop register

`--uOp` is a new state variable, double-buffered like everything else (`--__0uOp`, `--__1uOp`, `--__2uOp`, `--uOp`). Its initial value is 0.

Each cycle, `--uOp` is computed from a dispatch table keyed on `(--opcode, --__1uOp)`:

- For single-cycle instructions: no entry needed. The default value is 0, which means "already retired / ready for next instruction." The vast majority of 8086 opcodes are single-cycle in this model.
- For multi-cycle instructions: entries specify "if opcode X and current μop is N, next μop is N+1" for intermediate steps, and "if opcode X and current μop is the last one, next μop is 0" for retirement.
- For REP-prefixed instructions: the advance rule is conditional — if CX > 0, loop back to the start of the iteration sequence; if CX = 0, reset to 0 (retire).

### The cycle counter

`--cycleCount` is a new state variable, double-buffered. It tracks the total number of real 8086 clock cycles elapsed. On each instruction's retirement μop, `--cycleCount` increments by the real 8086 cycle count for that instruction (read from js8086.js's `clocks +=` values). During mid-instruction μops, it holds. The PIT timer is derived from this counter (see "Cycle counts").

### IP holds during multi-cycle instructions

In v2, IP advances every tick. In v3, IP only advances on retirement cycles. During mid-instruction cycles, IP holds at the instruction's start address.

This has a useful consequence: the decode pipeline (opcode fetch, ModR/M byte, EA computation) reads from `--__1IP`, which hasn't changed during mid-instruction cycles. So the decode pipeline naturally re-fetches the same opcode and operands on every cycle of a multi-cycle instruction. The μop index selects which micro-operation to perform, but the opcode and addressing mode are stable throughout. This means **the decode pipeline does not need to change**.

### One memory write per cycle

Each cycle, a single `(--memAddr, --memVal)` pair determines which byte of memory is written. If `--memAddr` is -1 (the sentinel), no write occurs. Each memory byte's update rule is:

```
--m42: if(style(--memAddr: 42): var(--memVal); else: var(--__1m42));
```

One check per byte per cycle. The byte whose address matches takes the new value; every other byte holds.

`--memAddr` and `--memVal` are computed from a dispatch on `(--opcode, --__1uOp)` — which instruction is this, and which cycle within it. Most cycles of most instructions do not write memory; those leave `--memAddr` at -1.

This replaces v2's 6 parallel write slots. The per-byte write rule was the largest single component of the generated CSS in v2 (N bytes × 6 slot checks = 6N dispatch cases). In v3 it is N cases — approximately a 6× reduction on the dominant component.

## Instruction encoding

Every opcode is expressed as a sequence of μops. The transpiler emits each μop as a set of dispatch entries keyed on `(--opcode, --__1uOp)`. Single-cycle instructions have only μop 0 entries, identical in structure to v2 — they just happen to specify `uOp=0` explicitly.

### Dispatch structure

Register dispatches in v2 are flat, keyed on `--opcode` alone:

```css
--AX: if(
  style(--opcode: 0x04): calc(...);
  style(--opcode: 0x05): calc(...);
  else: var(--__1AX));
```

In v3, opcodes with multiple μops use nested dispatch — outer on opcode, inner on `--__1uOp`:

```css
--SP: if(
  style(--opcode: 0x50): if(
    style(--__1uOp: 0): calc(var(--__1SP) - 2);
    else: var(--__1SP));
  style(--opcode: 0x51): ...
  else: var(--__1SP));
```

For opcodes with only μop 0 (the common case), the inner `if` is omitted and the entry stays flat, exactly as in v2. The dispatch emitter optimises this automatically.

This nested structure (opcode × μop) is identical in shape to how group opcodes already work (opcode × modrm.reg). It's a pattern the transpiler and Calcite both already handle.

### Example: PUSH AX (0x50) — 2 μops

| μop | Register effects | Memory write | IP |
|-----|-----------------|--------------|-----|
| 0 | SP ← SP - 2 | low byte of AX at SS:SP-2 | hold |
| 1 | (none) | high byte of AX at SS:SP-1 | advance |

μop 0 decrements SP and writes the low byte. μop 1 writes the high byte and retires the instruction (IP advances). On μop 1, `--__1SP` already reflects the decremented value from μop 0 (because μop 0's result was committed through the double buffer).

**Note on μop table notation:** addresses in all μop tables are shown relative to the pre-instruction SP value. The emitter must account for the double buffer state at each μop. For example, PUSH μop 1's write to "SS:SP-1" (relative to original SP) is emitted as `var(--__1SP) + 1`, because `--__1SP` on μop 1 is the already-decremented value (original SP - 2). The same adjustment applies to the INT table below and to any multi-μop instruction that modifies SP before later μops reference it.

### Example: INT N (0xCD) — 6 μops

| μop | Memory write | Other effects |
|-----|-------------|---------------|
| 0 | FLAGS low byte at SS:SP-2 | SP ← SP - 6, clear IF+TF in flags register |
| 1 | FLAGS high byte at SS:SP-1 | |
| 2 | CS low byte at SS:SP-4 | |
| 3 | CS high byte at SS:SP-3 | |
| 4 | IP low byte at SS:SP-6 | |
| 5 | IP high byte at SS:SP-5 | CS ← IVT[N×4+2..3], IP ← IVT[N×4..1] |

Six cycles, one byte write per cycle. IP and CS are loaded from the interrupt vector table on the retirement cycle (μop 5).

### Example: MOV [mem], AX — 2 μops

| μop | Memory write | IP |
|-----|-------------|-----|
| 0 | low byte (AL) at effective address | hold |
| 1 | high byte (AH) at effective address + 1 | advance |

### Example: simple register instructions

MOV AX, BX; ADD AX, CX; INC DX; all conditional jumps; NOP; CLC/STC; flag manipulation — these are all single-cycle instructions. They perform no memory writes (or at most one), so they need only μop 0, which advances IP and retires immediately. These are structurally identical to their v2 implementations. The vast majority of the 8086 ISA falls into this category.

### REP-prefixed string operations

REP already takes multiple CSS ticks in v2 — each iteration of the string operation is one tick, and IP re-executes from the prefix byte until CX reaches 0. v3 unifies this with the μop framework: REP's per-iteration ticks are μops, and the conditional loop-back is an instance of the μop advance rule being conditional on CX rather than unconditional.

**Byte-width string ops** (MOVSB, STOSB, LODSB, CMPSB, SCASB) write at most one byte per iteration, so each iteration remains one μop. For these, the change is primarily structural — the same behaviour expressed in the μop framework rather than the v2 `--_repActive` / `--_repContinue` machinery.

**Word-width string ops** (MOVSW, STOSW, CMPSW, SCASW) are a genuine structural change. In v2, each iteration writes two bytes simultaneously using two parallel memory write slots. In v3, each iteration becomes 2 μops: μop 0 writes the low byte, μop 1 writes the high byte, adjusts SI/DI, and decrements CX. REP MOVSW therefore takes 2×CX cycles instead of CX cycles.

The μop advance rule for word-width string ops under REP is a new conditional pattern: μop 0 → 1 unconditionally (always write the second byte); μop 1 → 0 if CX > 0 after decrement (loop back for next iteration); μop 1 → retire if CX = 0 (advance IP). REPE/REPNE variants (CMPSW, SCASW) add a further condition on ZF to the μop 1 → 0 transition.

## Memory model

Every writable byte has one `@property --m{N}`, double-buffered (`--__0m{N}`, `--__1m{N}`, `--__2m{N}`). This is unchanged from v2.

Memory is sparse: only addresses in the configured address set are emitted. Reads to unmapped addresses return 0; writes to unmapped addresses are silently dropped (no `--m{N}` property exists for `--memAddr` to match against).

The `--readMem` function is unchanged: a dispatch on address returning the `--__1m{N}` value for writable memory and constants for read-only regions (BIOS ROM).

### Address space layout

The 8086 has a 20-bit address bus, giving it a 1MB address space (0x00000–0xFFFFF). On a real PC, this is divided into conventional memory, video memory, adapter ROM space, and the BIOS ROM. CSS-DOS follows the same layout for the regions the CPU accesses via normal instructions:

| Range | Size | Contents |
|-------|------|----------|
| 0x00000–0x003FF | 1 KB | Interrupt Vector Table (IVT) |
| 0x00400–0x004FF | 256 B | BIOS Data Area (BDA) |
| 0x00500–0x9FFFF | ~640 KB | Conventional memory (program, stack, DOS kernel) |
| 0xB8000–0xB8F9F | ~4 KB | VGA text mode buffer (80×25×2 bytes) |
| 0xF0000–0xFFFFF | 64 KB | BIOS ROM (read-only constants in `--readMem`) |

**Data that is not CPU-addressable must not be placed inside the 1MB address space.** The disk image is the primary example. On a real PC, the disk sits behind a controller chip — the CPU talks to the controller via ports, and the data is never memory-mapped. In CSS-DOS, the BIOS INT 13h handler needs to read from the disk image and copy bytes into conventional memory. But the disk image itself should live at addresses *above* 0xFFFFF, outside the 8086's addressable range. No 8086 instruction can form an address above 0xFFFFF, so there is no risk of a program accidentally reading or writing the disk region. Only the BIOS handler's μop sequence (which is emitted by the generator and knows where the disk image is) references those high addresses.

This is important: **never lay memory regions over each other.** The disk image, any future ROM extensions, and any other non-CPU data must each occupy their own non-overlapping address range outside the 1MB CPU space. `--readMem` is a sparse dispatch — it includes whatever addresses exist, regardless of whether they fall inside or outside the 8086's natural range. Placing the disk image at, say, 0x100000+ is clean, collision-free, and costs nothing (sparse memory means only addresses that exist are emitted).

### Memory write properties

v2 emits 12 `@property` declarations for memory writes (6 address slots + 6 value slots). v3 emits 2: `--memAddr` and `--memVal`.

### Generated CSS structure

The generated CSS has the following structure:

1. **Utility `@function`s** — bitwise operations, shifts, sign extension. Unchanged from v2.
2. **Flag computation `@function`s** — `--addFlags`, `--subFlags`, etc. Unchanged from v2.
3. **Decode `@function` and properties** — opcode fetch, ModR/M, EA computation, operand reads. Unchanged from v2.
4. **Register dispatch tables** — per-register `if(style(--opcode: N))` dispatches. Same structure as v2, with nested `if(style(--__1uOp: N))` for multi-cycle opcodes.
5. **μop advance dispatch** — the `--uOp` register's update rule, keyed on `(--opcode, --__1uOp)`.
6. **Memory write dispatch** — `--memAddr` and `--memVal`, keyed on `(--opcode, --__1uOp)`.
7. **`@property` declarations** — one per memory byte, plus CPU registers and state variables.
8. **Memory read `@function`** — `--readMem(--at)` dispatch. Unchanged from v2.
9. **Per-byte memory write rules** — one single-check rule per byte. Reduced from 6 checks in v2.
10. **Double-buffer reads, keyframes** — unchanged from v2 structure, with `--uOp` added to the buffered variable set.

The memory block (items 7-9) is the bulk of the file by volume, as in v2, but with substantially fewer dispatch cases per byte.

## BIOS as microcode

Currently, the BIOS is a precompiled NASM binary (Gossamer) loaded at F000:0000. BIOS handlers are real 8086 code that the CPU executes instruction by instruction. This works but creates problems: BIOS bugs are hard to attribute (is it the BIOS assembly or the CPU implementation?), handler offsets must be duplicated across the assembler source, the transpiler, and the reference emulator, and the BIOS assembly is opaque to the conformance tooling.

v3 replaces this with BIOS routines expressed as microcode — the same μop machinery used by CPU instructions. A sentinel opcode (0xF1, which is undefined on a real 8086) signals entry into a BIOS routine. The byte following the sentinel is a routine ID.

### Routine IDs and subfunction dispatch

The IVT has one entry per interrupt number — INT 10h is one entry, INT 21h is one entry. When a program calls INT 10h with AH=0E (teletype output), the CPU jumps to the single address in IVT[0x10]. So the sentinel at that address always fires for INT 10h, regardless of which subfunction was requested.

This means the sentinel's μop sequence needs to dispatch on AH (or whatever register selects the subfunction) to decide what to do. Each interrupt number gets one routine ID, and the μop dispatch for that routine is keyed on `(sentinel opcode, routine ID, AH, μop index)`.

This is an extra dispatch dimension compared to normal instructions, but it's the same nested-if pattern already used for group opcodes (opcode × modrm.reg). An interrupt with 6 subfunctions has 6 branches in its AH dispatch, each leading to its own μop sequence.

### How it works

1. The interrupt vector table (IVT) is populated by the generator, pointing each interrupt vector at an address in the ROM region (F000:xxxx).
2. At that ROM address, the generator places two bytes: the sentinel opcode (0xF1) followed by a routine ID byte.
3. When the CPU executes an INT instruction, it pushes FLAGS/CS/IP and loads the new CS:IP from the IVT — this is normal INT behaviour, handled by INT's μop sequence.
4. The CPU fetches the sentinel opcode at the new CS:IP. The decode pipeline reads the routine ID as the operand byte (like an immediate).
5. The sentinel opcode's dispatch entries implement the BIOS routine as a μop sequence. Each μop performs one memory write (or register update), and the sequence retires when the routine's work is done.
6. On retirement, IP advances past the sentinel + routine ID, where an IRET instruction returns to the caller.

### JS reference, hand-written CSS emitters

The BIOS routines are authored twice: once as JavaScript handler functions consumed by the reference emulator, and once as hand-written μop emitter code in the transpiler. This is the same relationship CPU instructions have — the JS emulator is the source of truth for behaviour, the CSS emitters are written to match, and the conformance pipeline catches any discrepancy.

**JS side:** BIOS handlers are JS functions structured as a dispatch on interrupt number and subfunction (AH). The reference emulator calls them when INT fires, and they update registers and memory imperatively. This is straightforward sequential code.

**CSS side:** Each BIOS routine has a hand-written emitter function in the transpiler (alongside the CPU instruction emitters) that produces the μop dispatch entries for that routine — keyed on the sentinel opcode, routine ID, AH subfunction, and μop index. The emitter author references the JS handler to ensure behavioural parity.

Auto-transpiling the JS handlers into μop sequences was considered and rejected. Most handlers are trivial (INT 16h reads a property, INT 1Ah reads a counter), and the few that aren't (INT 13h copies a sector from disk to memory) involve variable-length loops that would require general-purpose JS→μop compilation machinery. The BIOS surface area is small enough (~6-8 routines) that hand-writing the emitters is less work than building that machinery, and the conformance pipeline provides the same correctness guarantee either way.

### What this replaces

- `gossamer.asm` and `gossamer.bin` are retired.
- BIOS handler offsets are no longer a cross-file concern. The IVT is populated by the generator; no external tool needs to know handler addresses.
- BIOS routines become visible in the conformance tooling — they're μop sequences like any instruction, and per-cycle dumps show exactly what the BIOS is doing.

## Hardware interrupts and peripheral chips

On a real PC, peripheral chips sit on the motherboard: the i8253 PIT (timer), the i8259 PIC (interrupt controller), and the keyboard controller. The CPU communicates with them via port I/O (IN/OUT instructions), and they communicate back via IRQ lines that trigger hardware interrupts.

CSS-DOS has no hardware. These chips are simulated as state — CSS custom properties on the CSS side, and pluggable JS objects on the reference emulator side. The reference emulator (js8086.js) already defines a peripheral interface with methods for port I/O, interrupt signalling, and per-instruction tick. The PIT, PIC, and keyboard controller are written as small JS objects conforming to this interface, then the same logic is reimplemented as CSS properties.

Both sides are conformance-tested through the existing pipeline. Peripheral state is deterministic: given the same sequence of port I/O and the same number of ticks, the PIT counter, pending IRQs, and scancode buffer must be identical in JS and CSS. Any discrepancy causes a register divergence (because IRQ injection pushes FLAGS/CS/IP and changes the instruction stream), which the comparison tool catches automatically.

**IRQ delivery** is baked into the instruction retirement path, matching the real 8086's microcode sequencer. No extra cycles are added when no IRQ is pending.

A new double-buffered boolean, `--irqActive`, is 0 during normal execution and 1 during an IRQ acknowledge sequence. The mechanism has four parts:

*Trigger:* The `--uOp` advance rule, when retiring an instruction (would normally set `--uOp` to 0), checks whether the PIC has a pending unmasked IRQ and IF=1. If so, it sets `--uOp` to 0 and `--irqActive` to 1.

*Opcode override:* `--opcode` checks `--irqActive` before reading from memory:

```
--opcode: if(
  style(--__1irqActive: 1): 0xF1;
  else: --readMem(var(--__1IP))
);
```

When `--irqActive` is 1, the dispatch sees the sentinel opcode and enters the same 6-μop push sequence as software INT. `--irqActive` is self-sustaining — it stays 1 while the IRQ μop sequence is in progress and resets to 0 when the sequence retires.

*Vector source:* The IRQ μop sequence is identical to software INT except on the final μop (μop 5), where CS and IP are loaded from the IVT. Software INT indexes the IVT via `--imm8`; the IRQ sequence indexes via `--picVector`, selected by checking `--irqActive`.

*PIC state update:* On μop 0 of the IRQ sequence, the acknowledged IRQ is moved from pending to in-service in the PIC's state properties. `--picVector` is derived from the in-service register (not pending), keeping it stable for the remainder of the sequence. The in-service bit remains set until the handler sends EOI via OUT to port 0x20.

**Port I/O** is handled by the CPU's IN and OUT instructions. These are normal opcodes with dispatch entries. IN from a port returns the corresponding CSS property value (e.g., port 0x40 reads the PIT counter, port 0x60 reads the keyboard scancode). OUT to a port writes to the corresponding property (e.g., port 0x43 configures the PIT, port 0x20 sends EOI to the PIC). Programs that talk to hardware directly (Doom reads the keyboard port and reprograms the PIT) and programs that go through BIOS handlers both end up reading and writing the same underlying properties, so they cannot get out of sync.

## Conformance testing

The reference emulator (`tools/js8086.js`) executes one 8086 instruction per call. Its trace is instruction-level: one entry per instruction retired.

The CSS emulator executes one cycle per animation step. Its trace is cycle-level: one entry per cycle, with most cycles being mid-instruction states for multi-cycle instructions.

The conformance comparison tool aligns traces at instruction retirement boundaries. For each instruction:

1. Advance the CSS emulator until the instruction retires (`--uOp` returns to 0 and IP has advanced).
2. Compare the CSS state at retirement against the reference emulator's post-instruction state.
3. If they match, advance the reference emulator by one instruction and repeat.
4. If they diverge, report the instruction, the CSS cycle count, and the register diffs.

For debugging, per-cycle dumps show fine-grained state within multi-cycle instructions (e.g., the progression of INT's stack pushes byte by byte). Per-retirement dumps show high-level program tracing.

## Cycle counts

Instructions in v3 take as many μops as they need for their actual work — memory writes and register updates. A PUSH takes 2 μops (two byte writes), an INT takes 6 μops (six byte writes), a MOV reg,reg takes 1. There are no padding μops.

However, the real 8086 cycle counts for these instructions are different: PUSH takes 15 cycles, INT takes 71, MOV reg,reg takes 2. These real cycle counts matter for peripheral timing — the PIT (timer chip) decrements in proportion to real CPU cycles, not in proportion to instructions retired or μops executed.

The solution is a `--cycleCount` property that advances by the real 8086 cycle count on each instruction's retirement μop. During mid-instruction μops, `--cycleCount` holds. On retirement, it jumps by the full cycle count for that instruction. The PIT counter is derived from `--cycleCount`.

This matches how js8086.js works: it accumulates real cycle counts via `clocks +=` statements throughout decode and execute, then ticks the PIT based on accumulated clocks between instructions. Interrupts are only checked between instructions on a real 8086 (never mid-instruction), so it doesn't matter that the PIT isn't updated during mid-instruction μops — nobody observes the counter until the next instruction boundary.

The cycle counts for each instruction can be read directly from js8086.js, which tracks them per addressing mode (e.g., memory operands cost more cycles than register operands). The transpiler emits the appropriate cycle count increment on each instruction's retirement μop.

**Runtime variation:** Most instructions have a fixed cycle count, but instructions with a ModR/M byte typically have two values — one for register operands, one for memory operands. In js8086.js, this appears as `clocks += mod == 0b11 ? 3 : 9` (or similar). The cycle count increment on the retirement μop is therefore a runtime expression, not a compile-time constant — but the variation is almost always a two-way branch on `--mod` (register vs memory), which is already available in the decode pipeline. No new dispatch dimensions are needed.

## What does not change from v2

v3 is a refactor of the execution semantics, not a ground-up rewrite. The following v2 infrastructure carries over directly:

- **Double-buffer mechanism.** The `--__0X` / `--__1X` / `--__2X` / `--X` pattern for every piece of state. Store and execute keyframes.
- **Clock animation.** `--clock: 0, 1, 2, 3` phases. `.cpu` rule with `animation-play-state` gated by `@container style(--clock: N)`.
- **Per-register dispatch tables.** Each CPU register has its own dispatch keyed on `--opcode`. The only change is that multi-cycle opcodes gain an inner dispatch on `--__1uOp`.
- **Decode pipeline.** Prefix detection, ModR/M, EA computation, operand reads. All of `decode.mjs` carries over unchanged.
- **Flag computation `@function`s.** The flag helpers are pure functions of their inputs. Unchanged.
- **Utility `@function`s.** `--xor`, `--and`, `--or`, `--not`, `--leftShift`, `--rightShift`, `--lowerBytes`, `--u2s1`, `--u2s2`, `--bit`, `--mergelow`, `--mergehigh`. Unchanged.
- **Memory read function.** `--readMem(--at)` dispatch. Reads are not affected by the write-slot refactor.
- **Transpiler architecture.** Hand-written emitters per opcode family. Catalog parser for completeness checking.
- **Address set and memory zones.** Sparse memory generation, memory zone configuration.
- **8-bit register aliases.** `--AL`, `--AH`, etc.

## Implementation phases

### Phase 1: μop infrastructure and slot collapse

Add the `--uOp` register and collapse memory write slots from 6 to 1. All single-cycle instructions continue to work. All multi-write instructions are temporarily broken (expected — fixed in Phase 2).

Changes:

- Add `--uOp` to `STATE_VARS`. Double-buffered like every other state variable.
- Extend `DispatchTable` to accept a μop dimension: `addEntry(reg, opcode, uOp, expr)`.
- Change `addMemWrite` to accept a μop: `addMemWrite(opcode, uOp, addrExpr, valExpr)`.
- Emit `--memAddr` and `--memVal` as 2D dispatches on `(--opcode, --__1uOp)`.
- Add the `--uOp` advance dispatch table, auto-generated from emitter entries.
- Make IP advance μop-aware: only fire on the retirement μop for each opcode.
- For opcodes with only μop 0 entries, emit flat dispatch (same as v2). For multi-μop opcodes, emit nested dispatch. The optimisation is automatic in the emitter.
- Replace 6 memory write slot `@property` declarations with 1 `--memAddr` + 1 `--memVal`.
- Replace per-byte 6-check write rules with single-check rules.
- Remove the TF (trap flag) wrapper from all register dispatches and memory write slots. TF is not used by any target program (DOS, Rogue, Doom). It will be reimplemented as a μop sequence if/when a program needs it.
- Remove `_tfPending` from STATE_VARS.
- Mechanically update all existing single-cycle emitters to pass `uOp=0`. No logic changes in any of them.

Validation: single-write test programs (fib, ALU-only tests, conditional jumps, MOV variants) pass cycle-by-cycle against the reference emulator. Multi-write instructions (PUSH, INT, CALL, etc.) are expected to fail — they only write their first byte.

### Phase 2: multi-cycle instructions

Rewrite each multi-write instruction as a μop sequence. Order is chosen to build confidence incrementally:

1. **PUSH reg / PUSH segreg / PUSHF** — 2 μops. Simplest multi-cycle case. Proves the μop machinery works end-to-end: μop 0 writes low byte, μop 1 writes high byte and retires.
2. **INT** — 6 μops. The most complex instruction. Exercises the full machinery. Unblocks all downstream testing (every DOS service call goes through INT).
3. **CALL near** — 2 μops. Push return address, jump.
4. **CALL far** — 4 μops. Push CS and IP, load new CS:IP.
5. **16-bit MOV to memory** — 2 μops. Write low byte, write high byte.
6. **IRET** — single-cycle, same as POP. It reads three words from the stack (IP, CS, FLAGS) via `--readMem`, which are all reads not writes. No μop sequence needed.
7. **REP-prefixed string operations** — unify with the μop framework, replacing the separate `--_repActive` / `--_repContinue` machinery. Byte-width ops (MOVSB, STOSB, etc.) remain one μop per iteration — primarily a structural rename. Word-width ops (MOVSW, STOSW, etc.) become 2 μops per iteration (one per byte write), introducing the conditional advance pattern described in "REP-prefixed string operations" above.

Also in Phase 2:

- Generalise the conformance comparison tool to align at retirement boundaries for all instructions, not just REP. This replaces the REP-specific alignment logic with a general rule: advance CSS until `--uOp` is 0.
- POP instructions do not need μop sequences — they read via `--readMem` (which is a single-cycle operation) and update SP. Single-cycle, same as v2. IRET is the same — three reads, no writes.
- Add `--cycleCount` to STATE_VARS. On each instruction's retirement μop, `--cycleCount` increments by the real 8086 cycle count for that instruction. The cycle counts are read from js8086.js's `clocks +=` values and vary by addressing mode (e.g., reg-reg vs reg-mem). The increment expression is emitted by each instruction's emitter alongside the IP advance.

Validation: fib, stack tests, INT tests, CALL/RET tests, REP string tests all pass at instruction-retirement level against the reference emulator.

### Phase 3: peripheral chips (JS reference)

On a real PC, peripheral chips (PIT timer, PIC interrupt controller, keyboard controller) sit on the motherboard and communicate with the CPU via port I/O (IN/OUT instructions) and IRQ lines. CSS-DOS has no hardware. These chips are simulated as state that lives in both the JS reference emulator and in CSS custom properties.

The reference emulator (js8086.js) already defines a pluggable peripheral interface. Its constructor takes `i8259` (PIC) and `i8253` (PIT) objects, each conforming to a simple interface:

- `isConnected(port)` — returns true if this peripheral handles the given I/O port
- `portIn(w, port)` — returns the value when the CPU reads from the port
- `portOut(w, port, val)` — handles the CPU writing to the port
- `hasInt()` — returns true if the peripheral has a pending interrupt
- `nextInt()` — returns the interrupt number to fire
- `tick()` — called once per instruction to advance the peripheral's internal state

js8086.js already calls these at the right points: it calls `pit.tick()` every instruction, checks `pic.hasInt()` when interrupts are enabled, and routes IN/OUT instructions through `portIn`/`portOut`. No modifications to js8086.js are needed.

This phase writes minimal implementations of these peripheral objects in JS and plugs them into the existing reference emulator:

**i8253 (PIT — Programmable Interval Timer):** Three 16-bit counters. Each counts down from a reload value. Channel 0 fires IRQ 0 (via the PIC) when it reaches zero. Programs configure it via OUT to ports 0x40-0x43 and read the counter via IN from port 0x40. DOS and the BIOS set channel 0 to a reload value of 65536, producing the standard ~18.2 Hz timer tick (IRQ every ~54.9ms). Games like Doom reprogram the frequency for faster timing. Only modes 2 (rate generator) and 3 (square wave) are needed for DOS and Doom.

**i8259 (PIC — Programmable Interrupt Controller):** Routes hardware IRQs to the CPU. Maintains a mask register (which IRQs are enabled), an in-service register (which IRQ is currently being handled), and a pending register. Programs send EOI (end of interrupt) via OUT to port 0x20. The PIC's `hasInt()` returns true when an unmasked IRQ is pending and no higher-priority IRQ is in service. `nextInt()` returns the interrupt vector number (IRQ 0 = INT 08h, IRQ 1 = INT 09h, etc.).

**Keyboard controller:** Scancodes are available at port 0x60. In CSS, the keyboard is physical on-screen buttons whose `:active` state feeds into a `--keyboard` property. The keyboard controller samples the active button state at a regular interval (the typematic rate), and each time it samples, if a key is pressed, it places the scancode at port 0x60 and fires IRQ 1 on the PIC. If the key is held down, the controller keeps sending the scancode at the repeat rate — same as a real keyboard controller's typematic behaviour. If nothing is pressed, it does nothing.

These are small objects — the PIT is roughly 50-60 lines, the PIC is similar, the keyboard controller is trivial. Writing them from scratch is preferable to extracting implementations from other emulators (PCjs, etc.), because: the interface is already defined by js8086.js so any external implementation would need adapting anyway; the logic is simple enough that the adaptation work exceeds the writing work; and every line needs to be understood because the same logic will be reimplemented in CSS.

Validation: conformance-tested the same way as CPU instructions. The peripheral state is deterministic — given the same port I/O sequence and the same number of ticks, the PIT counter, PIC state, and IRQ firing should be identical in JS and CSS. The existing conformance pipeline (reference emulator vs Calcite, compared at instruction retirement boundaries) covers this automatically, because IRQ injection affects CPU state (it pushes FLAGS/CS/IP and jumps to the handler) and any timing discrepancy between JS and CSS will show up as a register divergence.

### Phase 4: peripheral chips (CSS) and port I/O

Implement the same peripheral logic as CSS custom properties and wire the CPU's IN/OUT instructions to read/write them.

**CSS peripheral state:** The PIT counter is derived from `--cycleCount`, which advances by the real 8086 cycle count on each instruction retirement (see "Cycle counts"). The PIT decrements in proportion to `--cycleCount`, matching js8086.js's timing model — no tuning or speed adjustment needed. Conformance comes for free through the existing pipeline. The PIC's pending/mask/in-service state becomes CSS properties. The keyboard scancode is already `--keyboard`.

**IN/OUT instructions:** These are CPU opcodes like any other. The IN instruction's register dispatch returns a value selected by port number — port 0x40 returns `--pitCounter`, port 0x60 returns `--keyboard`, etc. The OUT instruction's dispatch writes to the corresponding properties — port 0x43 configures the PIT, port 0x20 sends EOI to the PIC.

**IRQ injection:** When the PIT counter hits zero and interrupts are enabled (IF=1), the next instruction retirement boundary triggers an IRQ-acknowledge μop sequence instead of fetching the next instruction. This sequence is functionally identical to INT — push FLAGS/CS/IP, clear IF, load handler from IVT — and uses the same μop machinery. The keyboard IRQ works the same way, triggered when the keyboard controller's sampling interval elapses and a key is pressed.

Both the IN/OUT port dispatches and the IRQ injection mechanism are conformance-tested against the JS reference. The JS peripherals fire IRQs at specific ticks; the CSS peripherals must fire at the same cycles. Any discrepancy shows up as a register divergence in the existing comparison pipeline.

### Phase 5: BIOS handlers

With the CPU execution model complete and peripheral chips working in both JS and CSS, the BIOS handlers can be written.

The DOS kernel (SvarDOS) handles most of INT 21h (file services, string output, etc.) internally as real 8086 code that the CPU executes. What the kernel calls down into the BIOS for is the hardware-facing layer:

- **INT 10h** — video output. Every character that reaches the screen goes through here.
- **INT 13h** — disk I/O. The kernel calls this to read/write sectors. Since there is no real disk, the BIOS handler copies bytes from the disk image (which lives outside the 8086's 1MB address space — see "Address space layout") into conventional memory.
- **INT 16h** — keyboard input. Reads from the keyboard property.
- **INT 1Ah** — timer tick count. Reads from the PIT counter property.
- **INT 11h** — equipment list (boot-time query, returns a constant).
- **INT 12h** — memory size (boot-time query, returns a constant).

Additionally, some programs (including Doom) talk to the hardware directly via IN/OUT rather than going through BIOS. This is already handled by the port I/O dispatches from Phase 4 — the BIOS handlers and the direct port access both read/write the same underlying CSS properties, so they cannot get out of sync.

**JS side:** BIOS handlers are JS functions passed to js8086.js via its existing `int_handler` hook. When INT fires, js8086.js calls `int_handler(type)` before executing the interrupt through the IVT. If the handler returns true, the interrupt is handled in JS without executing BIOS code. This is how Gossamer's behaviour is already injected — the change is that the handlers are rewritten as clean JS functions rather than being baked into an opaque NASM binary.

**CSS side:** BIOS handlers are μop sequences dispatched via the sentinel opcode (0xF1). The IVT points each interrupt vector at a ROM address containing the sentinel opcode followed by a routine ID byte. When the CPU fetches the sentinel, the dispatch entries for that routine ID execute the handler as a sequence of μops — memory writes, register updates — then retire. The sentinel approach is described in the "BIOS as microcode" section above.

The JS and CSS implementations of each BIOS handler are written and maintained separately. The surface area is small enough (roughly 6-8 routines, most of them trivial) that manual synchronisation is manageable, and the conformance pipeline catches any discrepancy automatically.

Validation: all existing test programs pass. SvarDOS boots to the same point it does today. Once parity is confirmed, `gossamer.asm` and `gossamer.bin` are retired.

### Deferred

- **TF (trap flag) trap delivery as a μop sequence.** Reintroduce when/if a program that uses single-step debugging is targeted.

## Relationship to Calcite

Calcite is a JIT compiler for CSS. It evaluates the same CSS that Chrome would, faster. Calcite has zero 8086 knowledge. The cardinal rule is unchanged: Chrome is the semantic oracle; Calcite must produce whatever Chrome would.

v3 does not require any Calcite changes. The generated CSS uses only patterns Calcite already recognises:

- **Flat dispatch tables** on integer keys (`if(style(--opcode: N): ...)`). Same as v2.
- **Nested dispatch** on `(opcode × uOp)`, expressed as nested `if()`. Structurally identical to v2's group opcode dispatch (`opcode × modrm.reg`).
- **Broadcast writes** to memory bytes. Structurally simpler than v2 (one slot check per byte instead of six).
- **Identity preservation** for unchanged state.

If Calcite performance improves as a result of the simpler memory block, that is welcome but not load-bearing.

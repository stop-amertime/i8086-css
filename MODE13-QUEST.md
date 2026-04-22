# Mode 13h Quest

**Quest:** Run a real Mode 13h program end-to-end in Chrome (via Calcite),
with correct colours, without hanging. Start from a tiny .COM fire/plasma
effect and work up to an actual single-.COM game.

**Non-goals (for this quest):** EGA, CGA graphics, Mode X, double
buffering, vertical retrace timing. Those are later quests with their own
plans. This one is about making the *one* mode we already half-support
actually work.

---

## Why this is worth doing

Mode 13h is the only graphics mode CSS-DOS advertises. Today it is half
real: the framebuffer zone at `0xA0000–0xAFA00` is writable, and
`INT 10h AH=00h AL=13h` clears it. But the palette ports are not
decoded, so every commercial Mode 13h program renders with whatever
default the player assumes. Our own [tests/mode13_gradient.asm](tests/mode13_gradient.asm)
only looks right because it happens to use palette indices 0–15, which
collide with the CGA-compatible low 16 entries of the default VGA DAC.

The distance between "kind of works on a smoke test" and "actually runs a
real program" is small and well-defined. This is the cheapest way to turn
Mode 13h from a demo into a real platform.

---

## Target program

**Principle:** pick the smallest, simplest thing that exercises real VGA
palette programming, then work up.

### Tier 1: canonical first target — a fire effect .COM

Sub-1KB demoscene fire effects are nearly ideal:

- Set Mode 13h via `INT 10h`.
- Program the palette via `OUT 0x3C8` + `OUT 0x3C9` (black → red →
  orange → yellow → white, ~64 entries).
- Loop: perturb a seed row at the bottom of the framebuffer, average
  upwards, write to `0xA0000`.
- Poll keyboard via `IN 0x60` or `INT 16h` to exit.

Pass criteria: recognisable fire on screen, correct orange/yellow/red
gradient (proves the DAC is working), doesn't hang.

**Sources to try (in order of preference):**

1. A public-domain fire .COM from a demoscene archive (pouet.net,
   hornet.org, scene.org). Pick one under 4KB that claims 8086/Mode 13h.
2. If none work out of the box, write our own minimal fire.asm — it's
   ~60 lines of NASM and we control every instruction.

Writing our own is the safest first step because we can be sure it uses
only 8086 instructions and hits exactly the ports we've decoded.

### Tier 2: a tiny real game

Once fire works, pick a single-.COM game. Candidates, all needing
verification they exist in single-.COM form and use only 8086:

- A **snake/nibbles** clone (many hobbyist ones from BBS era).
- **BOUNCE.COM** / ball-physics demos.
- Hugi / size-coding compo entries tagged "game" under 4KB.

Pass criteria: game is recognisable, responds to keys, palette is right.

### Tier 3 (aspirational, not in this quest)

An actual shareware Mode 13h game. Likely .EXE, likely 286+, likely
needs sound blaster ports, likely out of scope. Named here only so we
know where the road leads.

---

## What's missing today

Audited against the current Corduroy BIOS and the calcite player.

### Blocker 1 — palette ports ignored (the big one)

Ports `0x3C7` (DAC read index), `0x3C8` (DAC write index), `0x3C9`
(DAC data) are not decoded. All palette writes are no-ops. Every
commercial Mode 13h program re-programs the DAC on startup; most do it
continuously (fades, flashes). Without this, colours are always wrong.

**Fix shape:**
- State: `--dacWriteIndex` (byte), `--dacReadIndex` (byte), 768 bytes of
  palette storage (`--dac<0..767>`), plus a 2-bit sub-index so the
  sequence of three `OUT 0x3C9` writes goes R→G→B then advances the
  write index.
- Port decode: add `0x3C7/0x3C8/0x3C9` handlers alongside the existing
  `0x20/0x21/0x40–0x43/0x60` decoders.
- Player: when rendering the framebuffer, look up each pixel's RGB from
  `--dac*` instead of assuming the default VGA DAC.

### Blocker 2 — `0x3DA` (input status 1) ignored

Games poll this to sync to vertical retrace. A read returns 0 today.
A tight `in al, 0x3DA; test al, 8; jz ...` loop will either hang or
fall through instantly depending on which bit is polled.

**Fix shape:** toggle bit 3 (vertical retrace) based on `--cycleCount`.
A plausible cadence: retrace-high for ~5% of a 70 Hz "frame." Exact
numbers don't matter — games just need the bit to actually change state.
Alternatively, always return "in retrace" (bit 3 set). That unblocks
polls at the cost of bad behaviour in programs that time against it.
We can start with always-set and refine.

### Blocker 3 — `INT 10h AH=10h` (palette BIOS services) not handled

This is the BIOS wrapper around the DAC ports. Some programs use it
instead of (or alongside) direct port I/O. Once the DAC state exists,
AH=10h subfunctions `0x10/0x12/0x15/0x17` route into the same state.

### Not blockers (for this quest)

- CRTC ports `0x3D4/0x3D5` — only matters for double buffering. Plain
  Mode 13h games write directly to `0xA0000`.
- Vertical retrace *timing* beyond bit-3 toggling.
- VGA text-mode palette (attribute controller at `0x3C0`) — text mode
  already works without it for our purposes.
- `INT 10h AH=0Ch` (write pixel) / `AH=13h` (write string) — games
  don't use these for real rendering.

---

## Plan

### Phase 0 — pick and build the target

- [x] **Pick target.** Hans Wennborg's rewrite of Jare's 1993 firedemo
      ([hanshq.net/fire.html](https://www.hanshq.net/fire.html)).
      NASM source, ~450 bytes assembled, standard Mode 13h (no CRTC
      tricks), exercises only the DAC ports + `INT 10h/16h/1Ah/21h`.
      Does **not** poll `0x3DA`. Ideal clean DAC test.
- [x] **Stage it.** Lives at `../calcite/programs/fire/` (fire.asm +
      README). One small patch documented there: `shr ax, 6` was
      swapped for `mov cl, 6; shr ax, cl` because the immediate-count
      shift (`C1 /5`) is a 186 opcode not yet in our decode.
- [x] **Build to a .COM.** `nasm -f bin -o fire.com fire.asm` →
      442 bytes.
- [ ] **Build as a cabinet and run in Calcite.** Baseline: program runs,
      keyboard exits, colours will be wrong (expected until Phase 1).
      Screenshot for the record.

### Phase 1 — DAC ports

- [ ] Decode `0x3C8` write → set `--dacWriteIndex`, reset sub-index to 0.
- [ ] Decode `0x3C9` write → store the byte at
      `dac[dacWriteIndex*3 + subIndex]`. Advance sub-index; on wrap to
      0, increment `dacWriteIndex`.
- [ ] Decode `0x3C7` write (read index) and `0x3C9` read — symmetrical.
      Games occasionally read the DAC back.
- [ ] Player: expose the 768 DAC bytes to the worker; worker expands
      each framebuffer byte through the live palette when producing
      `gfxBytes`.
- [ ] Re-run `fire`. Colours should be right.

### Phase 2 — `0x3DA` vsync

- [ ] Decode `0x3DA` read → return a byte whose bit 3 toggles based on
      `--cycleCount`. Start with a fixed duty cycle; the exact cadence
      is a knob we can tune. Bit 0 ("display enable") can also be
      synthesised cheaply.
- [ ] Confirm fire still works (it probably doesn't poll `0x3DA`, so
      this is a non-regression check).
- [ ] Find or write a second test program that *does* poll `0x3DA` —
      e.g. a palette-flash demo — and confirm it no longer hangs.

### Phase 3 — `INT 10h AH=10h` BIOS palette services

- [ ] Add AH=10h dispatch to [bios/corduroy/handlers.asm](bios/corduroy/handlers.asm).
      Subfunctions to implement, minimum:
  - `AL=0x10` (set one DAC register) — maps to 3 DAC writes.
  - `AL=0x12` (set block of DAC registers) — loops over ES:DX.
  - `AL=0x17` (read block of DAC registers) — symmetrical.
- [ ] Write a test .COM that sets palette via INT 10h instead of
      direct ports, confirm it looks identical to the direct-port test.

### Phase 4 — run a real game

- [ ] Acquire or build the Tier-2 target (a small single-.COM Mode 13h
      game).
- [ ] Build as a cart. Fix whatever breaks. Each fix gets its own
      entry in the logbook.
- [ ] Pass criteria: game renders correctly, responds to input, runs
      for at least a minute without crash.

---

## Non-obvious things to watch for

- **Default VGA DAC as fallback.** Until Phase 1 lands, the player
  expands framebuffer bytes using *some* palette. It should be the
  real IBM default VGA DAC (256 entries, first 16 = CGA-compatible,
  16–31 = grayscale, 32–247 = 3×3×3 hue/saturation/luminance cube,
  248–255 = black). That's why our gradient smoke test "works" — it
  only uses the first 16 entries. If the current palette differs from
  IBM's spec it's still producing an image, just the wrong one. Worth
  auditing before Phase 1 so we know what we're changing from.
- **Six-bit DAC values.** The DAC stores 6-bit RGB (0–63), not 8-bit.
  Expand with `<<2 | >>4` when producing canvas RGBA. Programs that
  write > 63 to `0x3C9` are technically buggy; real hardware masks to
  6 bits. We should too.
- **Port sub-index wraparound.** Three writes to `0x3C9` advance the
  DAC index by 1. A program that writes 768 bytes after a single
  `OUT 0x3C8, 0` expects the entire palette updated. Get the
  sub-index state machine right or every third entry will be
  corrupted.
- **Fire effects often use `INT 1Ah AH=00h`** (read tick counter) for
  timing. That already works. They rarely use `0x3DA`. A fire .COM is
  a clean Phase-1 test that doesn't entangle Phase 2.
- **`INT 16h AH=01h`** (keyboard status, non-blocking) is already
  wired. Fire's exit condition should use it, not raw port `0x60`,
  to stay inside what we know works.
- **Don't add CRTC decoding opportunistically.** If a target game uses
  double buffering, stop and decide whether it's in scope. Page
  flipping is a whole sub-quest.

---

## Definition of done

- A Mode 13h .COM program renders with correct colours in the Calcite
  player.
- Palette fades/flashes visibly change colour.
- A game that polls `0x3DA` doesn't hang.
- The new ports and the AH=10h path are documented in
  [docs/bios-flavors.md](docs/bios-flavors.md) (corduroy section) and
  [docs/cart-format.md](docs/cart-format.md) if any new cart fields
  appear (they shouldn't — this is all runtime).
- A cart exists under `carts/` for at least one real Mode 13h program.
- Logbook has an entry per phase.

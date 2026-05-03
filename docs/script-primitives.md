# Script primitives (watch-spec grammar)

The bench harness and any other measurement code that wants to *react
to engine state at runtime* composes a small set of generic primitives
defined in calcite-core. This is the reference for the syntax.

The same grammar is exposed identically on:

- `calcite-cli --watch SPEC` (one flag per watch; repeatable)
- `engine.register_watch(SPEC)` in calcite-wasm

## Spec syntax

```
NAME:KIND:SPEC[:gate=NAME][:sample=VAR1,VAR2][:then=ACTION1+ACTION2+...]
```

- Field separator is `:`.
- `sample=` variables are `,`-separated.
- `then=` actions are `+`-separated (so an action can carry `,` and `:`
  in its own args — important for `dump=0xB8000,4000,C:\foo.bin`).
- Numbers are decimal or `0x`-prefixed.

## Kinds

| Kind     | SPEC                                 | Fires on                             |
|----------|--------------------------------------|--------------------------------------|
| `stride` | `every=N`                            | every Nth tick                       |
| `burst`  | `every=N,count=K`                    | K ticks in a row, every N ticks      |
| `at`     | `tick=T`                             | exactly tick T                       |
| `edge`   | `addr=A`                             | the byte at A changes                |
| `cond`   | `TEST1[,TEST2…][,repeat]`            | all tests true (see below)           |
| `halt`   | `addr=A`                             | byte at A becomes non-zero (halts)   |

### `cond` — predicate watches

A `cond` watch fires when **all** TESTs are true. Three test forms:

- `ADDR=VAL`     — byte at ADDR equals VAL
- `ADDR!=VAL`    — byte at ADDR does not equal VAL
- `pattern@BASE:STRIDE:WINDOW=NEEDLE` — NEEDLE bytes appear in the
  WINDOW-byte region starting at BASE, sampled every STRIDE bytes
  (use STRIDE=2 for char-only scans of text VRAM where attrs interleave)

Default behaviour: fire **once**, then disable. Add the literal token
`repeat` to the test list to switch to **sustain** mode — fires on
every gated poll while the predicate holds, stops re-firing when it
flips false, re-arms when it flips true again.

### `gate=NAME`

By default, `cond` and `edge` are checked every tick (expensive). Set
`gate=NAME` to point at another watch (typically a `stride`); the
gated watch is only evaluated on ticks where the gate fires.

```
poll:stride:every=50000
drdos:cond:0x449=0x03,pattern@0xb8000:2:4000=DR-DOS:gate=poll:then=emit
```

## Actions

| Action                                | Meaning                                          |
|---------------------------------------|--------------------------------------------------|
| `emit`                                | Append a measurement event for the host to drain |
| `halt`                                | Stop the engine                                  |
| `setvar=NAME,VALUE`                   | Write VALUE into engine variable NAME            |
| `setvar_pulse=NAME,VALUE,HOLD_TICKS`  | Write VALUE now, schedule write-of-0 HOLD_TICKS later (make/break edge pair) |
| `dump=ADDR,LEN[,PATH]`                | Dump LEN bytes of guest memory at ADDR to PATH   |
| `snapshot[=PATH]`                     | Save engine snapshot to PATH                     |

`PATH` supports `{tick}` and `{name}` template substitutions.
`setvar_pulse` skips re-firing while a release is pending or just
fired this poll, so a sustain-cond + pulse pair produces clean
make/break/make/break at 2× the gate stride.

## Examples

Detect Doom8088's title screen (mode 13h + game-state 3 + menu off):

```
title:cond:0x3ac62=0,0x3a3c4=3,0x449=0x13:gate=poll:then=emit
```

Spam Enter while the title screen is up (sustain + pulse):

```
title_tap:cond:0x3ac62=0,0x3a3c4=3,0x449=0x13,repeat:gate=poll:then=setvar_pulse=keyboard,0x1C0D,50000
```

Dump VRAM every 1M ticks for a flipbook diff:

```
flipbook:stride:every=1000000:then=dump=0xb8000,4000,vram_{tick}.bin
```

Halt the engine when level-load completes (gate skips per-tick checks):

```
poll:stride:every=50000
ingame:cond:0x3a5af=1,0x3a3c4=0:gate=poll:then=emit+halt
```

## Where this lives

- Parser: `../calcite/crates/calcite-core/src/script_spec.rs`
- Types + evaluation: `script.rs`, `script_eval.rs`
- Tests: `../calcite/crates/calcite-core/tests/script_primitives.rs`

The CSS-DOS-side bench profiles in `tests/bench/profiles/` are the
intended top-level consumer. Anything that knows about a *specific
cabinet's* addresses (Doom's `_g_gamestate`, BDA[0x449]) belongs in
the profile, not in calcite — calcite stays domain-agnostic per the
cardinal rule.

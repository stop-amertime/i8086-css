# Corduroy BIOS changelog

Semver-ish: bump MINOR for behavioural changes (new INT services,
different default BDA state, etc.), PATCH for internal fixes that don't
change what programs observe. MAJOR is reserved for layout breaks
(entry point moves, ABI changes).

Every bump must also change `VERSION` in this directory. The builder
stamps the version into the cabinet header so you can tell which BIOS
is baked into any given `.css`:

```
head -5 cabinet.css
```

## 0.2.0 — 2026-04-19

- INT 10h AH=00h accepts mode `0x01` (CGA 40×25 colour text) and
  normalises mode `0x00` (CGA 40×25 mono text) to `0x01`. Both share
  the B8000 buffer layout; only the column stride differs.
- Teletype output (INT 10h AH=0Eh) reads the active column count from
  `BDA[0x449]` at the start of each call: 80 columns for mode `0x03`,
  40 columns for mode `0x01`. Scroll-up is still hardcoded to 80
  columns; a program that scrolls in mode `0x01` will render wrong.

## 0.1.0 — 2026-04-18

- Initial numbered release. C-based DOS BIOS with INT 10h, 13h, 16h,
  1Ah services, real INT 09h keyboard handler, EOI on INT 08h/09h.
  Defaults: `BDA[0x449] = 0x03` (80×25 colour text), stack at the
  builder-patched `0xBEEE:0xFFFE`, 640 KB or autofit conventional.

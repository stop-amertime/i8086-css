# Performance Tricks Breakdown (CSS-DOS + Calcite)

_Date: 2026-04-28_

## Can Codex access GitHub issues / edit repo?

- **GitHub issues:** only if the environment has network access + credentials/token to your repo/org.
  In this session, direct clone access to `stop-amertime/calcite` via git returned a 403,
  so issue access/editing is currently not available from here.
- **Repo editing:** yes — local files in this repository are editable, and this document is the result.

---

## Current baseline (what the project already does well)

- CSS-DOS emits CSS-first semantics and keeps calcite domain-agnostic (no x86 logic in calcite).
- Kiln emits per-register dispatch tables and memory write slots with slot-live gating.
- Memory supports packed cells (`KILN_PACK=1|2`, default 2), reducing property count/size.
- Rom-disk reads are externalized through a dispatch function (`--readDiskByte`) so cabinet size is not bounded by direct in-address-space bytes.
- Bench history already explores gate shape and calcite peeler/fast-path effects with measurable outcomes.

---

## High-impact opportunities not yet fully exploited

## 1) Trace-tier execution in calcite (generic CSS traces)

**Idea:** add a tier above current compiled evaluation that records and fuses hot straight-line traces of resolved CSS dispatch.

**Why:** reduces per-tick branch overhead and repeated dispatch costs on hot loops.

**How (generic, non-x86):**
- Record hot transitions among expression blocks.
- Compile guarded traces (guard on dispatch keys / relevant vars).
- On guard miss, deopt back to baseline compiled path.

**Risk:** medium-high (correctness/deopt complexity).

---

## 2) Dispatch structure selection (dense table vs perfect hash vs hashmap)

**Idea:** instead of one general structure, choose per-dispatch representation:
- Dense integer ranges → flat array table.
- Stable sparse keys → minimal perfect hash.
- Irregular sparse keys → hashmap.

**Why:** lower cache-miss and pointer-chasing overhead than universal hashmap use.

**Risk:** medium.

---

## 3) Mixed packing factors by memory zone

**Idea:** move from global packing to zone-aware packing/representation.

Examples:
- Conventional RAM hot regions: pack2.
- Random-write-heavy regions: pack1.
- Read-mostly structures: internal packed vector representation.

**Why:** one global pack factor is rarely optimal across all memory access patterns.

**Risk:** medium (bookkeeping + codegen/runtime complexity).

---

## 4) Kiln canonicalization pass for calcite-friendly shapes

**Idea:** add a small IR normalization pass before final CSS emission so equivalent logic emits one canonical shape.

Normalize:
- gate ordering (`slotLive && addressMatch`),
- `if(...)` nesting forms,
- arithmetic/bitwise helper idioms.

**Why:** improves calcite pattern-recognition hit-rate and makes future fast-paths more robust.

**Risk:** low-medium.

---

## 5) Two-level memory-read dispatch (page + intra-page)

**Idea:** split reads into hierarchical selector:
1. page key (high bits),
2. compact local dispatch within page.

Optional per-page all-zero short-circuit.

**Why:** shrinks giant branch fanout and increases locality.

**Risk:** medium.

---

## 6) Dirty-dependency execution skipping

**Idea:** precompute dependency bitsets for expression clusters and skip re-evaluation when no upstream dependency changed.

**Why:** saves cycles in idle/low-activity ticks.

**Risk:** medium-high (depends on precise dependency graphing).

---

## 7) Write-combine store queue in calcite

**Idea:** per-tick micro write queue:
- coalesce repeated writes to same address,
- commit once with final priority semantics,
- batch contiguous commits.

**Why:** fewer memory commits and better cache behavior.

**Risk:** medium.

---

## 8) AOT compiled artifact cache by cabinet hash

**Idea:** cache parse+recognized+compiled calcite artifact keyed by cabinet hash + calcite version.

**Why:** removes repeated startup/compile overhead in dev workflows and repeated runs.

**Risk:** low.

---

## 9) Web renderer: tile-level damage tracking

**Idea:** in calcite web bridge/player experiments, track dirty tiles and repaint only changed regions.

**Why:** major paint savings on text/low-motion DOS workloads.

**Risk:** low-medium.

---

## 10) Dual memory representation (canonical + vectorized)

**Idea:** maintain synchronized canonical byte array + vector-friendly packed structure, choose faster path per operation family.

**Why:** reduce repeated extract/compose overhead while preserving canonical semantics.

**Risk:** high (synchronization complexity).

---

## Recommended sequence (fastest likely ROI)

1. Kiln canonicalization pass.
2. Dispatch structure selection.
3. AOT compiled artifact cache.
4. Write-combine queue.
5. Dirty-dependency skipping.
6. Trace-tier execution.

---

## Experiment matrix template (for each idea)

For each candidate, track:
- **Hypothesis:** expected bottleneck removed.
- **Microbench:** mov-heavy / int-heavy / rogue-menu-idle.
- **Macrobench:** DOS boot milestone throughput.
- **Correctness gate:** diff vs reference emulator + chrome parity constraints.
- **Rollback condition:** >X% perf regression or non-local complexity spike.

---

## Notes on constraints

- Preserve the project cardinal rule: CSS must remain valid and correct in Chrome; calcite optimizes generic CSS semantics only.
- Avoid optimizations that encode x86 semantics inside calcite.

# Benchmark results

Append-only log. Each run appends a block; rows are individual scenarios.
Compare by eye: find the commit before your change, find the commit after, diff the numbers.

## 2026-04-19T16:15:58Z — 03a0802-dirty

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| mov-heavy | 100000 | 421415 | 2.4 | 1.18 (24.7%) | 5.3MB |

## 2026-04-19T16:18:30Z — 03a0802-dirty — baseline, pre-gating

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 325294 | 3.1 | 38.17 (799.7%) | 377.3MB |
| int-heavy | 100000 | 341520 | 2.9 | 5.67 (118.7%) | 5.3MB |
| mov-heavy | 100000 | 421916 | 2.4 | 1.18 (24.7%) | 5.3MB |

## 2026-04-19T16:36:58Z — 03a0802-dirty — gating + calcite gated broadcast

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 313208 | 3.2 | 36.75 (770.0%) | 406.9MB |
| int-heavy | 100000 | 340481 | 2.9 | 5.65 (118.4%) | 5.7MB |
| mov-heavy | 100000 | 419399 | 2.4 | 1.17 (24.5%) | 5.7MB |

## 2026-04-19T23:48:52Z — d29a9a6-dirty — pre-and-experiment baseline

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 381311 | 2.6 | 97.63 (2045.6%) | 601.8MB |
| int-heavy | 100000 | 340869 | 2.9 | 5.66 (118.5%) | 9.1MB |
| mov-heavy | 100000 | 429637 | 2.3 | 1.20 (25.1%) | 9.1MB |

## 2026-04-19T23:54:49Z — d29a9a6-dirty — flat and() gate variant

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 329816 | 3.0 | 38.70 (810.8%) | 424.8MB |
| int-heavy | 100000 | 422469 | 2.4 | 6.47 (135.5%) | 6.5MB |
| mov-heavy | 100000 | 430478 | 2.3 | 1.20 (25.2%) | 6.5MB |

## 2026-04-19T23:55:20Z — d29a9a6-dirty — nested baseline (re-confirm after flat run)

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 387175 | 2.6 | 99.13 (2077.1%) | 601.8MB |
| int-heavy | 100000 | 356527 | 2.8 | 5.92 (124.0%) | 9.1MB |
| mov-heavy | 100000 | 423620 | 2.4 | 1.18 (24.8%) | 9.1MB |

## 2026-04-20T00:27:06Z — d29a9a6-dirty — flat and() + calcite peeler extended

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 317418 | 3.2 | 37.24 (780.4%) | 424.8MB |
| int-heavy | 100000 | 362365 | 2.8 | 5.55 (116.2%) | 6.5MB |
| mov-heavy | 100000 | 399368 | 2.5 | 1.12 (23.4%) | 6.5MB |

## 2026-04-20T00:28:59Z — d29a9a6-dirty — flat infix-and + calcite peeler

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 398412 | 2.5 | 102.01 (2137.4%) | 417.9MB |
| int-heavy | 100000 | 343330 | 2.9 | 5.70 (119.4%) | 6.4MB |
| mov-heavy | 100000 | 408782 | 2.4 | 1.14 (23.9%) | 6.4MB |

## 2026-04-20T00:30:10Z — d29a9a6-dirty — flat infix-and + calcite peeler + fast-path

| Scenario | Ticks | Ticks/sec | us/tick | MHz (% of 8086) | Cabinet |
|---|---|---|---|---|---|
| rogue-menu-idle | 50000 | 381164 | 2.6 | 97.59 (2044.8%) | 417.9MB |
| int-heavy | 100000 | 346641 | 2.9 | 5.75 (120.5%) | 6.4MB |
| mov-heavy | 100000 | 404635 | 2.5 | 1.13 (23.7%) | 6.4MB |


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


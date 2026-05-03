# Perf-iteration tooling

Tools for measurement-driven perf work. Read this when you're about
to optimise something; skip otherwise.

## Snapshots — skip the boot when iterating

Calcite `State::snapshot` / `State::restore` exposed as
`--snapshot-out` / `--restore` on calcite-cli, `engine.snapshot()` /
`engine.restore(bytes)` in calcite-wasm. Same-cabinet only.

Capture once at the moment you care about (e.g. just-reached-in-game),
then restore from it on every subsequent run. Each iteration becomes
seconds instead of a full boot.

Compose a `cond:…:then=emit+halt` watch (see
[`script-primitives.md`](script-primitives.md)) to freeze at a
specific moment, then `--snapshot-out` writes the state at halt.

**Invalidated by** any cabinet rebuild OR calcite parse /
slot-allocation change. phash mismatch after restore → recapture.

## Sample-CS-IP — find the hot segment

```sh
calcite-cli --sample-cs-ip=STRIDE,BURST,EVERY,PATH
```

Records CS:IP at mixed wide-and-bursty intervals (wide samples find
which segments matter; bursts characterise loop shape). Pairs with
`--restore` to skip boot and sample only the window you care about.

Analyse with `tests/harness/analyse-cs-ip-samples.mjs` — produces a
CS:IP heatmap + per-burst loop-shape report. The output answers
"what code is the engine spending its time in?" before you guess.

## Op-distribution profiling

```sh
calcite-bench --restore=PATH --profile --batch=0
```

Reports the runtime distribution of compiled-op kinds — useful for
spotting un-fused load+compare+branch chains, broken-down dispatch
recognition, and so on.

**Caveat:** `--batch=0 --profile` reports snapshot+change-detect at
~91% of time. Single-tick instrumentation artifact —
`run_batch` doesn't run either phase. Op-count distribution is real;
time-split isn't.

## Calcite worktrees

When you check CSS-DOS out into a worktree
(`.claude/worktrees/foo/`), the `../calcite` sibling assumption no
longer holds. Set `CALCITE_REPO=/abs/path/to/calcite/.../foo` to
point at the matching calcite worktree. `CALCITE_CLI_BIN` and
`CALCITE_DEBUGGER_BIN` override individual binaries. Honoured by
`web/scripts/dev.mjs`, `tests/bench/lib/artifacts.mjs`,
`tests/harness/lib/fast-shoot.mjs`,
`tests/harness/lib/debugger-client.mjs`.

## Where to start

- For the doom8088 perf mission specifically, see
  [`agent-briefs/doom-perf-mission.md`](agent-briefs/doom-perf-mission.md).
- For the bench harness that consumes these tools, see
  [`tests/bench/README.md`](../tests/bench/README.md).
- For calcite-side perf entries (recogniser fusion, fast-forward, etc.),
  see `../calcite/docs/log.md`.

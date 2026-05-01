# tests/bench

Performance benchmark harness. Replaces `bench-doom-stages.mjs`,
`bench-doom-stages-cli.mjs`, `bench-doom-load.mjs`,
`bench-doom-gameplay.mjs`, `bench-web.mjs`, and the old `bench/run.mjs`
with a single harness driving named profiles.

## What lives here

```
tests/bench/
  page/index.html       — page-side runner (full JS; calcite-wasm in worker)
  driver/run.mjs        — Node CLI; drives page (Playwright) or calcite-cli
  profiles/             — one .mjs file per named bench
    doom-loading.mjs
    doom-gameplay.mjs
    zork-steady.mjs
    ...
  lib/
    ensure-fresh.mjs    — staleness primitive (mtime check + rebuild)
    ensure-fresh.test.mjs — unit tests
    artifacts.mjs       — declarative manifest of every built artifact
  cache/                — built cabinets (gitignored, ephemeral)
```

## Running a bench

```sh
node tests/bench/driver/run.mjs doom-loading
node tests/bench/driver/run.mjs doom-loading --target=cli
node tests/bench/driver/run.mjs zork-steady --port=5174
node tests/bench/driver/run.mjs doom-loading --no-rebuild --out=tmp/result.json
```

The driver's first action is `ensureArtifact()` for every artifact the
profile declares (cabinet, calcite-wasm, prebakes). Stale artifacts get
rebuilt automatically; pass `--no-rebuild` to error instead. See
[`docs/rebuild-when.md`](../../docs/rebuild-when.md) for the artifact
graph.

## Adding a profile

A profile is a `.mjs` file under `profiles/` that exports two things:

```js
export const manifest = {
  target: 'web' | 'cli',
  cabinet: 'cabinet:doom8088',
  requires: ['cabinet:doom8088', 'wasm:calcite', 'prebake:corduroy'],
  wallCapMs: 600_000,
  reportShape: { /* documentation only */ },
};

export async function run(host) {
  // host: { log(msg, cls?), setMeta(obj), profileName }
  // Compose calcite-core script primitives via:
  //   (web)  engine.register_watch("name:cond:0x3a3c4=0:gate=poll:then=emit+halt")
  //   (cli)  driver translates to calcite-cli --watch flags
  // Drain measurements; return the final report.
}
```

The primitives (stride/burst/cond/edge/halt + emit/dump/snapshot
actions) are defined in calcite-core and exposed identically on
calcite-cli (`--watch`) and calcite-wasm (`engine.register_watch`).
See [`../../docs/rebuild-when.md`](../../docs/rebuild-when.md) and the
calcite-side `crates/calcite-core/src/script.rs`.

## Adding a built artifact

Edit `lib/artifacts.mjs`. One entry, four fields: `name`, `output`,
`inputs[]` (file globs + transitive artifact names), `rebuild`. Done —
ensureFresh now auto-rebuilds it.

Example:

```js
registerArtifact({
  name:    'cabinet:rogue',
  output:  'tests/bench/cache/rogue.css',
  inputs:  ['carts/rogue/**', 'kiln/**', 'builder/**', 'prebake:corduroy'],
  rebuild: 'node builder/build.mjs carts/rogue -o tests/bench/cache/rogue.css',
});
```

## What's NOT here

- The smoke test runner (`tests/harness/run.mjs smoke`) — that's
  conformance-shaped, not perf-shaped. Lives in tests/harness/.
- The conformance ref-machine path (`tests/harness/lib/ref-machine.mjs`)
  — same reason.
- Anything that wants the calcite debugger's MCP surface — that's
  `tests/harness/pipeline.mjs` territory.

The split: tests/harness/ does correctness (smoke / conformance /
divergence-finding), tests/bench/ does performance (timed profiles
against cabinets). Different jobs, different infrastructure.

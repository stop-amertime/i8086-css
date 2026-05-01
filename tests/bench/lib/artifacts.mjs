// artifacts.mjs — declarative manifest of every built artifact in CSS-DOS.
//
// The single source of truth that ensureFresh consults. Each entry says:
// "here's an artifact, here are its inputs, here's how to rebuild it."
// Consumers (bench harness, smoke runner, dev server) call
// `ensureArtifact(name)` and get back a fresh, ready-to-read absolute path.
//
// Adding a new artifact: add an entry here. The dependency is declared,
// the rebuild is automatic, and staleness is detected by mtime — no
// more "the agent forgot to run prebake.mjs after editing bios/corduroy/."
//
// Naming: `<scope>:<name>` where scope is one of `cabinet`, `prebake`,
// `wasm`, `cli`. Artifacts can declare other artifacts as inputs
// (transitive deps) — `cabinet:doom8088` depending on `prebake:corduroy`
// is the canonical example.

import { registerArtifact } from './ensure-fresh.mjs';

// --- Calcite WASM (used by the web bench / player) ---
registerArtifact({
  name:    'wasm:calcite',
  output:  '../calcite/web/pkg/calcite_wasm_bg.wasm',
  inputs:  [
    '../calcite/crates/calcite-core/src/**',
    '../calcite/crates/calcite-core/Cargo.toml',
    '../calcite/crates/calcite-wasm/src/**',
    '../calcite/crates/calcite-wasm/Cargo.toml',
    '../calcite/Cargo.toml',
  ],
  rebuild: 'wasm-pack build ../calcite/crates/calcite-wasm --target web --out-dir ../../web/pkg --release',
});

// --- Calcite native CLI (used by the CLI bench path) ---
//
// Build runs in the calcite directory directly (cd "$REPO/../calcite"
// && cargo build) — invoking cargo with --manifest-path from outside
// triggers a different build context that on Windows-bash produced
// link.exe argument-mangling errors. Running cargo from inside the
// calcite repo avoids it.
registerArtifact({
  name:    'cli:calcite',
  output:  '../calcite/target/release/calcite-cli.exe',
  inputs:  [
    '../calcite/crates/calcite-core/src/**',
    '../calcite/crates/calcite-core/Cargo.toml',
    '../calcite/crates/calcite-cli/src/**',
    '../calcite/crates/calcite-cli/Cargo.toml',
    '../calcite/Cargo.toml',
  ],
  rebuild: 'cd ../calcite && cargo build --release -p calcite-cli',
});

// --- BIOS prebake binaries (browser-side build path reads these) ---
registerArtifact({
  name:    'prebake:corduroy',
  output:  'web/prebake/corduroy.bin',
  inputs:  ['bios/corduroy/**', 'web/scripts/prebake.mjs'],
  rebuild: 'node web/scripts/prebake.mjs corduroy',
});
registerArtifact({
  name:    'prebake:gossamer',
  output:  'web/prebake/gossamer.bin',
  inputs:  ['bios/gossamer/**', 'web/scripts/prebake.mjs'],
  rebuild: 'node web/scripts/prebake.mjs gossamer',
});
registerArtifact({
  name:    'prebake:muslin',
  output:  'web/prebake/muslin.bin',
  inputs:  ['bios/muslin/**', 'web/scripts/prebake.mjs'],
  rebuild: 'node web/scripts/prebake.mjs muslin',
});

// --- Cabinets (built from carts; depend on cart files + kiln + builder
// + the BIOS prebake the cart's preset uses) ---
//
// Each cabinet lives in tests/bench/cache/, gitignored, ephemeral.
function cabinet(cartName, opts = {}) {
  const preset = opts.preset || 'corduroy';
  registerArtifact({
    name:    `cabinet:${cartName}`,
    output:  `tests/bench/cache/${cartName}.css`,
    inputs:  [
      `carts/${cartName}/**`,
      'kiln/**',
      'builder/**',
      `prebake:${preset}`,
    ],
    rebuild: `node builder/build.mjs carts/${cartName} -o tests/bench/cache/${cartName}.css`,
  });
}

cabinet('doom8088');
cabinet('zork1');
cabinet('montezuma');
cabinet('hello-text');

// Re-export the convenience helper so callers can do a single import.
export { ensureArtifact } from './ensure-fresh.mjs';

// tests/bench/profiles/compile-only.mjs — sanity profile: just compile,
// don't run. Verifies page → bridge → cabinet handoff works.

export const manifest = {
  target: 'web',
  cabinet: 'cabinet:doom8088',
  requires: ['cabinet:doom8088', 'wasm:calcite', 'prebake:corduroy'],
  wallCapMs: 120_000,
};

export async function run(host) {
  // The page already fetched the cabinet and posted it to the bridge,
  // and waited for compile-done before calling us. So just confirm and
  // exit.
  host.log('compile-only: bridge confirmed compile-done; exiting');
  if (!window.__bridgeWorker) throw new Error('no bridge');
  return {
    profileName: 'compile-only',
    note: 'bridge spawned, cabinet posted, compile-done observed',
  };
}

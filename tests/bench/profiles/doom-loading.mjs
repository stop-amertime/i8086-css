// tests/bench/profiles/doom-loading.mjs — doom8088 boot-to-loading bench.
//
// Replaces the old bench-doom-load / bench-doom-stages.mjs for the
// loading-window measurement. Drives the calcite bridge worker via
// MessageChannel (the same surface __bridgeWorker exposes) and
// composes calcite-core script primitives into stage detectors.
//
// Six stages, deterministic memory-readable signatures (no phash):
//   stage_text_drdos: BDA[0x449]=0x03 AND vram_text 0xB8000:2 contains "DR-DOS"
//   stage_text_doom:  BDA[0x449]=0x03 AND vram_text 0xB8000:2 contains "DOOM8088"
//   stage_title:      _g_menuactive==0 AND _g_gamestate==3 AND BDA[0x449]==0x13
//   stage_menu:       _g_menuactive==1
//   stage_loading:    _g_usergame==1 AND _g_gamestate==3
//   stage_ingame:     _g_gamestate==0
//
// All compose from the generic script primitives (cond, halt, stride,
// pattern@…) — no upstream-aware predicates in calcite. The doom8088
// addresses live HERE in the profile, where they belong (consumer side).

const ADDR_GAMESTATE  = 0x3a3c4;
const ADDR_MENUACTIVE = 0x3ac62;
const ADDR_USERGAME   = 0x3a5af;
const ADDR_BDA_MODE   = 0x449;
const ADDR_TEXT_VRAM  = 0xb8000;
const TEXT_VRAM_BYTES = 4000;

// Watch specs reused by both transports. Web composes via the bridge
// (see run() below); CLI passes them as --watch flags via the driver.
//
// Each predicate combines multiple memory tests; the boot path naturally
// progresses through them in order. The `ingame` predicate also requires
// `_g_usergame=1` so it doesn't false-fire on engine-zero memory at
// tick 0 (GS_LEVEL=0 matches a zero byte; usergame distinguishes
// "engine just started" from "level loaded").
// Doom8088 won't progress past title or main menu without keyboard
// input. The cabinet's `--keyboard` handler edge-detects make/break,
// so a single press isn't enough — we need press/release cycles.
// `pseudo_pulse=PSEUDO,SELECTOR,HOLD_TICKS` handles that on the
// pseudo-class input surface: flips the (PSEUDO, SELECTOR) edge active
// now, schedules a release HOLD_TICKS later. The cabinet's
// `&:has(#kb-enter:active) { --keyboard: 0x1C0D }` rule produces the
// scancode value through calcite's input-edge recogniser; the host
// only flips the gate.
//
// Both title-dismiss and menu-confirm need ENTER. We tap on every
// gated poll while the relevant screen is up (`,repeat` on the cond),
// holding each tap for 50K ticks (~1 batch at the 50K poll stride),
// so the make and break are spaced over consecutive polls.
const ENTER_SELECTOR = 'kb-enter';
const TAP_HOLD = 50_000;  // hold-then-release each tap over 50K ticks

const WATCH_SPECS = [
  'poll:stride:every=50000',
  // Text VRAM (char,attr) needles; stride=2.
  `text_drdos:cond:${ADDR_BDA_MODE}=0x03,pattern@${ADDR_TEXT_VRAM}:2:${TEXT_VRAM_BYTES}=DR-DOS:gate=poll:then=emit`,
  `text_doom:cond:${ADDR_BDA_MODE}=0x03,pattern@${ADDR_TEXT_VRAM}:2:${TEXT_VRAM_BYTES}=DOOM8088:gate=poll:then=emit`,
  // Title splash → emit once.
  `title:cond:${ADDR_MENUACTIVE}=0,${ADDR_GAMESTATE}=3,${ADDR_BDA_MODE}=0x13:gate=poll:then=emit`,
  // Title-tap: while title is up, pulse the kb-enter pseudo-class edge
  // on every poll. The pulse flips it active now, then queues the
  // release; consecutive polls re-arm (last-write-wins on the pending
  // release) so the key stays held until the next poll's release fires.
  `title_tap:cond:${ADDR_MENUACTIVE}=0,${ADDR_GAMESTATE}=3,${ADDR_BDA_MODE}=0x13,repeat:gate=poll:then=pseudo_pulse=active,${ENTER_SELECTOR},${TAP_HOLD}`,
  // Main menu → emit once.
  `menu:cond:${ADDR_MENUACTIVE}=1:gate=poll:then=emit`,
  // Menu-tap: same shape as title_tap.
  `menu_tap:cond:${ADDR_MENUACTIVE}=1,repeat:gate=poll:then=pseudo_pulse=active,${ENTER_SELECTOR},${TAP_HOLD}`,
  // Loading → emit once.
  `loading:cond:${ADDR_USERGAME}=1,${ADDR_GAMESTATE}=3:gate=poll:then=emit`,
  // ingame: usergame=1 (level-load fired) AND gamestate=0 (GS_LEVEL).
  // Without usergame this would trip on tick-0 zero memory.
  `ingame:cond:${ADDR_USERGAME}=1,${ADDR_GAMESTATE}=0:gate=poll:then=emit+halt`,
];

export const manifest = {
  target: 'web',
  cabinet: 'cabinet:doom8088',
  requires: ['cabinet:doom8088', 'wasm:calcite', 'prebake:corduroy'],
  wallCapMs: 600_000,
  cliWatches: WATCH_SPECS,
  cliMaxTicks: 80_000_000,
  reportShape: {
    runMsToInGame:    'number',
    ticksToInGame:    'number',
    cyclesToInGame:   'number',
    cabinetBytes:     'number',
    bootBuildMs:      'number',
    compileMs:        'number',
    stages:           'object',
  },
};

// Send a request to the bridge worker, await its reply via MessagePort.
// Mirror of bench.html's existing pattern.
function bridgeRequest(bridge, msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (m) => {
      ch.port1.close();
      const r = m.data;
      if (r && r.ok) resolve(r);
      else reject(new Error(r?.err ?? 'bridge request failed'));
    };
    bridge.postMessage(msg, [ch.port2, ...transfer]);
  });
}

export async function run(host) {
  host.log('doom-loading: waiting for bridge worker');

  // The bench page (page/index.html) doesn't yet spawn the bridge —
  // we need to. The simplest path: dynamic-import the existing
  // bench.html iframe pattern. For now, this profile *requires* the
  // outer harness to have spawned a bridge and exposed it.
  if (!window.__bridgeWorker) {
    throw new Error('no __bridgeWorker — page must spawn bridge first');
  }
  const bridge = window.__bridgeWorker;

  host.log(`registering ${WATCH_SPECS.length} watches`);
  for (const spec of WATCH_SPECS) {
    await bridgeRequest(bridge, { type: 'register-watch', spec });
  }
  // Set chunk-ticks so the bridge's tickLoop polls the watch registry.
  bridge.postMessage({ type: 'set-watch-chunk-ticks', chunkTicks: 50_000 });
  // Start the tick loop. The bench page didn't trigger
  // viewer-connected (no /_stream/fb fetch); use the bench-run entry.
  bridge.postMessage({ type: 'bench-run' });

  host.log('watches registered; running until ingame halt');

  // Drain measurement events on a sampling interval. The 'ingame'
  // watch halts the engine (`then=emit+halt`); poll until we see it.
  //
  // The watches above already drive Enter via `pseudo_pulse=active,kb-enter`
  // on every gated poll while title/menu screens are up — that handles
  // the in-game navigation autonomously. The driver-side sendKey calls
  // below are belt-and-braces nudges that go through the SW route,
  // which exercises the same set_pseudo_class_active host API. Useful
  // when the bench page is too laggy for the watch poll cadence to
  // catch every menu transition.
  function sendKey(selector) {
    fetch(`/_kbd?class=${selector}`, { mode: 'no-cors' }).catch(() => {});
  }
  const ENTER_SELECTOR = 'kb-enter';
  let titleSpammed = false;
  let menuSpammed = false;

  const stages = {};
  const t0 = performance.now();
  while (true) {
    if (performance.now() - t0 > manifest.wallCapMs) {
      throw new Error('wall-clock cap exceeded');
    }
    await new Promise(r => setTimeout(r, 500));
    const r = await bridgeRequest(bridge, { type: 'drain-measurements' });
    const events = JSON.parse(r.events);
    for (const ev of events) {
      if (!stages[ev.watch]) {
        stages[ev.watch] = {
          tick: ev.tick,
          wallMs: performance.now() - t0,
        };
        host.log(`stage ${ev.watch} tick=${ev.tick} wallMs=${stages[ev.watch].wallMs.toFixed(0)}`);
      }
    }
    // Title splash → press Enter once to dismiss into main menu.
    if (stages.title && !titleSpammed) {
      sendKey(ENTER_SELECTOR);
      titleSpammed = true;
    }
    // Main menu → spam Enter (skill prompt etc).
    if (stages.menu && !menuSpammed) {
      for (let i = 0; i < 3; i++) {
        setTimeout(() => sendKey(ENTER_SELECTOR), i * 200);
      }
      menuSpammed = true;
    }
    if (stages.ingame) break;
  }
  host.log('all stages reached');

  return {
    profileName: 'doom-loading',
    runMsToInGame: stages.ingame.wallMs,
    ticksToInGame: stages.ingame.tick,
    stages,
  };
}

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
const WATCH_SPECS = [
  'poll:stride:every=50000',
  // text_drdos / text_doom — text VRAM (char,attr) needles; stride=2.
  `text_drdos:cond:${ADDR_BDA_MODE}=0x03,pattern@${ADDR_TEXT_VRAM}:2:${TEXT_VRAM_BYTES}=DR-DOS:gate=poll:then=emit`,
  `text_doom:cond:${ADDR_BDA_MODE}=0x03,pattern@${ADDR_TEXT_VRAM}:2:${TEXT_VRAM_BYTES}=DOOM8088:gate=poll:then=emit`,
  // Mode-13h stages. BDA mode 0x13 distinguishes from text-mode boot.
  `title:cond:${ADDR_MENUACTIVE}=0,${ADDR_GAMESTATE}=3,${ADDR_BDA_MODE}=0x13:gate=poll:then=emit`,
  `menu:cond:${ADDR_MENUACTIVE}=1:gate=poll:then=emit`,
  `loading:cond:${ADDR_USERGAME}=1,${ADDR_GAMESTATE}=3:gate=poll:then=emit`,
  // ingame: usergame=1 (level-load fired) AND gamestate=0 (GS_LEVEL).
  // Without usergame, this would trip on tick 0's all-zero memory.
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
  // Send keyboard input as needed to navigate Doom's menus:
  //   - title screen → Enter (dismiss)
  //   - main menu → Enter (start "New Game")
  // The bench page doesn't have an open /_stream/fb so the SW's
  // /_kbd endpoint isn't wired up. Send directly to the bridge worker
  // — the bridge accepts {type:'kbd', key} on its sw-port channel.
  // Easier: post directly on the worker's main port; the worker's
  // viewer-side handler will see the key through the SW pipeline,
  // but we can also write to set-keyboard via a dedicated msg.
  //
  // Simplest: use the existing 'kbd' message via the SW MessagePort
  // we already gave the bridge. The bench page kept that as bridgeKbdPort.
  function sendKey(key) {
    // Route through the SW: the SW received our register-calcite-bridge
    // earlier; its /_kbd endpoint forwards to the same bridge port.
    fetch(`/_kbd?key=0x${key.toString(16)}`, { mode: 'no-cors' }).catch(() => {});
  }
  const ENTER = 0x1C0D;
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
      sendKey(ENTER);
      titleSpammed = true;
    }
    // Main menu → spam Enter (skill prompt etc).
    if (stages.menu && !menuSpammed) {
      for (let i = 0; i < 3; i++) {
        setTimeout(() => sendKey(ENTER), i * 200);
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

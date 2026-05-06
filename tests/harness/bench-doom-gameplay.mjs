#!/usr/bin/env node
// bench-doom-stages.mjs — measure doom8088 web load by stage transition.
//
// DETERMINISTIC stage detection. No phash, no fuzzy image matching. The
// signatures are program-semantic memory reads:
//
//   stage_text_drdos:   BDA[0x449]=0x03 AND VRAM 0xB8000 contains "DR-DOS"
//   stage_text_doom:    BDA[0x449]=0x03 AND VRAM 0xB8000 contains "DOOM8088"
//   stage_title:        _g_menuactive==0 AND _g_gamestate==GS_DEMOSCREEN(3)
//                       AND BDA[0x449]==0x13
//   stage_menu:         _g_menuactive==1
//   stage_loading:      _g_usergame==1 AND _g_gamestate==GS_DEMOSCREEN(3)
//                       — menu transition has fired (G_InitNew set
//                         _g_usergame=1) and level-load is in progress
//                         (G_DoLoadLevel hasn't yet flipped gamestate)
//   stage_ingame:       _g_gamestate==GS_LEVEL(0)
//
// `_g_gamestate` (0x3a3c4), `_g_menuactive` (0x3ac62), `_g_gameaction`
// (0x3ac5e), and `_g_usergame` (0x3a5af) are doom8088 globals. Their
// linear addresses were reverse-engineered against the current cabinet
// by dumping memory at known stages (title, mainmenu, loading-at-20M,
// ingame, ingame-steady) and finding the unique byte position whose
// values across the dumps match the expected program-state pattern.
//
// gameaction is *transient* — set by M_ChooseSkill, cleared by
// G_DoNewGame on the very next G_Ticker call, so by the time the bench
// peeks (250 ms later) it's already back to ga_nothing. We log when we
// catch it but don't gate stages on it.
//
// usergame, by contrast, latches once and stays — set in G_InitNew BEFORE
// G_DoLoadLevel runs, so it's true throughout the slow level-load
// window. That's the durable signal that "the menu transition fired"
// vs "Enter spam closed the menu but newgame never queued".
//
// If you rebuild doom8088 with different binary layout, regenerate the
// addresses via the procedure in docs/agent-briefs/doom-perf-mission.md.
//
// Menu chain (shareware DOOM, default skill cursor on Hurt me plenty):
//   title splash + mode 13h
//     → Enter (any) → main menu (NEW GAME / OPTIONS / LOAD / QUIT)
//     → Enter on NEW GAME → skill menu (auto-skips episode select
//                                      because shareware has only 1)
//     → Enter on Hurt me plenty (cursor lands here by default,
//                                via M_NewGame setting itemOn=2)
//                                → M_ChooseSkill → ga_newgame → game
//
// Two Enters total after the title-dismiss. Bench Enter-spams every
// 500 ms once stage_menu fires, and stops as soon as either ga != 0 is
// observed (transient — usually missed) or _g_usergame == 1 (durable).
//
// Reports for each stage: wallMs, calcite tick, calcite cycle. Plus
// compileMs (cabinet parse+compile time, separate from execution time)
// and bootBuildMs (in-browser cart build).
//
// Each stage has an expected wall budget; if a stage takes more than 2x
// its budget, the bench bails out with stageTimeout for that stage. The
// final JSON still contains everything reached so a perf regression is
// visible even if the bench gave up.
//
// Usage:
//   node tests/harness/bench-doom-stages.mjs
//   node tests/harness/bench-doom-stages.mjs --headed
//   node tests/harness/bench-doom-stages.mjs --json=bench-out.json
//   node tests/harness/bench-doom-stages.mjs --budget-mult=3

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    if (!a.startsWith('--')) return [];
    const [k, v] = a.slice(2).split('=');
    return [[k, v ?? true]];
  }),
);
// Default to the normal doom8088 cart (boots through menu, starts a new
// game). After stage_ingame fires, the bench spams LEFT arrow and
// measures ticks/cycles across WINDOW_MS more wall-time.
const CART = args.cart || 'doom8088-load';
// Wall-clock window (ms) over which we measure gameplay throughput AFTER
// stage_ingame has fired. Bench keeps the page open for WINDOW_MS more ms
// past ingame, then reports ticks/cycles deltas across the window — pure
// gameplay framerate, not boot-to-ingame.
const WINDOW_MS = parseInt(args['window-ms'] ?? '60000', 10);
const HEADED = args.headless ? false : true;
const JSON_OUT = args.json ?? null;
const BUDGET_MULT = parseFloat(args['budget-mult'] ?? '2.0');
// If set, save a snapshot at every stage transition into this directory
// so subsequent bench iterations can `--restore-from=PATH` and skip the
// upstream stages entirely.
const SNAPSHOT_DIR = args['capture-snapshots'] ?? null;
const PORT = args.port ?? '5173';
const URL = `http://localhost:${PORT}/player/bench.html?cart=${encodeURIComponent(CART)}&n=1`;

// Stage-specific wall budgets in ms (current observed numbers x BUDGET_MULT).
// These are "if we exceed this, something's broken". Update if calcite
// gets faster/slower at boot, but keep them realistic — the bail is a
// safety net, not the goal.
const STAGE_WALL_BUDGET_MS = {
  compile:           45_000,  // cart build + cabinet compile
  stage_text_drdos:  20_000,  // page-load → DR-DOS banner
  stage_text_doom:   30_000,  // → DOOM8088 init log
  stage_title:       60_000,  // → mode 13h title splash
  stage_menu:        15_000,  // → main menu (after Enter)
  stage_loading:    300_000,  // → _g_usergame=1 (menu transition fired) — 5min
  stage_ingame:    1_200_000,  // → _g_gamestate=GS_LEVEL (level loaded) — 20min
};

// Doom8088 global addresses (see preamble for derivation).
const ADDR_GAMESTATE   = 0x3a3c4;
const ADDR_MENUACTIVE  = 0x3ac62;
const ADDR_GAMEACTION  = 0x3ac5e;
const ADDR_USERGAME    = 0x3a5af;
const ADDR_BDA_MODE    = 0x449;
const ADDR_TEXT_VRAM   = 0xB8000;
const TEXT_VRAM_BYTES  = 4000;        // 80*25*2

// Game-state enum values (doomdef.h).
const GS_LEVEL = 0, GS_DEMOSCREEN = 3;
// Game-action enum values (d_event.h). 0 = nothing, 1 = loadlevel,
// 2 = newgame, etc. Anything > 0 means doom has accepted the menu
// selection and queued a game-state transition — we stop spamming
// Enter so we don't accidentally re-open the menu.
const GA_NOTHING = 0;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const fallback =
    process.platform === 'win32'
      ? 'C:/Users/AdmT9N0CX01V65438A/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright'
      : null;
  if (!fallback) throw new Error('playwright not found');
  ({ chromium } = require(fallback));
}

const launchOpts = { headless: !HEADED };
const sysChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
try {
  const fs = require('node:fs');
  if (fs.existsSync(sysChrome)) launchOpts.executablePath = sysChrome;
} catch {}

const browser = await chromium.launch(launchOpts);
let result;
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    const t = msg.text();
    // [stages] lines come through the page log+milestone path already.
    // [bridge] lines are extremely noisy (per-batch frame logs); only
    // surface explicit error/ERROR lines and ignore everything else.
    if (t.includes('ERROR') || (t.includes('error') && !t.includes('errored'))) {
      process.stderr.write(`[page-err] ${t}\n`);
    }
  });
  page.on('pageerror', (err) => {
    process.stderr.write(`[pageerror] ${err.message}\n`);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Inject the stage watcher. Lives in the page so it can talk to the
  // bridge worker (via window.__bridgeWorker, exposed by bench.html) and
  // listen on the cssdos-bridge-stats BroadcastChannel.
  await page.evaluate((cfg) => {
    const { ADDR_GAMESTATE, ADDR_MENUACTIVE, ADDR_GAMEACTION, ADDR_USERGAME,
            ADDR_BDA_MODE, ADDR_TEXT_VRAM,
            TEXT_VRAM_BYTES, GS_LEVEL, GS_DEMOSCREEN, GA_NOTHING,
            BUDGET_MULT, STAGE_WALL_BUDGET_MS, CAPTURE_SNAPSHOTS,
            WINDOW_MS } = cfg;
    const ORDER = ['stage_text_drdos', 'stage_text_doom',
                   'stage_title', 'stage_menu', 'stage_loading', 'stage_ingame'];

    globalThis.__stages = {
      pageStart: performance.now(),
      stages: {},                // name → { wallMs, ticks, cycles }
      log: [],
      latest: null,              // last bridge-stats packet
      compileMs: null,           // from compile-done event
      cabinetBytes: null,
      bootBuildMs: null,         // build → ready for run (excludes compile)
      bailed: null,              // { stage, reason } if we bailed
      done: false,
      // When CAPTURE_SNAPSHOTS is enabled, each stage transition pushes
      // a {name, length, bytes} entry here for Node to drain & write.
      // `bytes` is an Array<number> (page→Node JSON-serialisable). Cleared
      // by Node after consumption.
      snapshotsPending: [],
    };
    const S = globalThis.__stages;

    function captureSnapshot(name) {
      if (!CAPTURE_SNAPSHOTS) return;
      const w = window.__bridgeWorker;
      if (!w) return;
      const mc = new MessageChannel();
      mc.port1.onmessage = (ev) => {
        const r = ev.data;
        if (r && r.ok && r.bytes) {
          // ArrayBuffer → number[] for JSON-safe transport. ~600KB → ~6MB
          // of JSON; one-shot per stage, fine.
          const u8 = new Uint8Array(r.bytes);
          S.snapshotsPending.push({ name, bytes: Array.from(u8) });
          console.log(`[stages] snapshot[${name}] captured: ${u8.length} bytes`);
        } else {
          console.log(`[stages] snapshot[${name}] failed: ${r?.err || 'unknown'}`);
        }
      };
      try {
        w.postMessage({ type: 'snapshot-out' }, [mc.port2]);
      } catch (e) {
        console.log(`[stages] snapshot[${name}] post failed: ${e.message}`);
      }
    }

    const stamp = (name, extra = {}) => {
      if (S.stages[name]) return;
      const wallMs = performance.now() - S.pageStart;
      S.stages[name] = { wallMs, ...extra };
      const line = `[stages] ${name} reached t=${(wallMs/1000).toFixed(2)}s ` +
        Object.entries(extra).map(([k,v]) => `${k}=${v}`).join(' ');
      S.log.push({ wallMs, msg: line });
      console.log(line);
      captureSnapshot(name);
    };

    // Listen for compile-done + bridge-stats over the BroadcastChannel.
    const ch = new BroadcastChannel('cssdos-bridge-stats');
    ch.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'compile-done') {
        S.compileMs = d.compileMs;
        S.cabinetBytes = d.cabinetBytes;
        S.packedBroadcastPortCount = d.packedBroadcastPortCount ?? null;
        S.compiledOpCount = d.compiledOpCount ?? null;
        S.compiledSlotCount = d.compiledSlotCount ?? null;
        S.bootBuildMs = (performance.now() - S.pageStart) - d.compileMs;
        const wallMs = performance.now() - S.pageStart;
        const diag = (d.packedBroadcastPortCount != null)
          ? ` ports=${d.packedBroadcastPortCount} ops=${d.compiledOpCount} slots=${d.compiledSlotCount}`
          : '';
        S.log.push({ wallMs, msg: `[stages] compile-done compileMs=${Math.round(d.compileMs)} cabBytes=${d.cabinetBytes}${diag}` });
        console.log(`[stages] compile-done compileMs=${Math.round(d.compileMs)} cabBytes=${d.cabinetBytes}${diag}`);
        return;
      }
      if (d.type === 'bridge-stats') {
        S.latest = d;
      }
    };

    // peekMem: send a peek-mem request to the bridge worker via a fresh
    // MessageChannel and resolve with the bytes. Returns null if the
    // bridge isn't ready yet.
    function peekMem(addr, len) {
      const w = window.__bridgeWorker;
      if (!w) return Promise.resolve(null);
      return new Promise((resolve) => {
        const mc = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 1000);
        mc.port1.onmessage = (ev) => {
          clearTimeout(timer);
          const r = ev.data;
          if (r && r.ok) resolve(new Uint8Array(r.bytes));
          else resolve(null);
        };
        try {
          w.postMessage({ type: 'peek-mem', addr, len }, [mc.port2]);
        } catch {
          clearTimeout(timer);
          resolve(null);
        }
      });
    }

    function vramContains(vram, needle) {
      // Text VRAM is char,attr,char,attr — only even bytes are chars.
      // ASCII match against even-byte stream.
      const n = needle.length;
      const lim = (vram.length / 2) - n;
      for (let i = 0; i <= lim; i++) {
        let ok = true;
        for (let j = 0; j < n; j++) {
          if (vram[(i + j) * 2] !== needle.charCodeAt(j)) { ok = false; break; }
        }
        if (ok) return true;
      }
      return false;
    }

    // Send Enter via /_kbd (same path soft-keyboard taps use). Press is
    // ASCII 0x0D + scancode 0x1C => 0x1C0D.
    //
    // For one-off Enters (title-dismiss, first menu-spam) we log; the
    // ongoing menu-spam interval suppresses its own log noise — it's
    // visible via the status line counter `lastEnterCount`.
    function sendEnter(why, silent = false) {
      try {
        const f = document.getElementById('frame');
        if (!f || !f.contentWindow) {
          if (!silent) console.log(`[stages] sendEnter(${why}): iframe not ready`);
          return;
        }
        const wallS = ((performance.now() - S.pageStart)/1000).toFixed(1);
        const at = `t=${wallS}s gs=${S.lastGs} me=${S.lastMe} cyc=${(S.latest?.cycles ?? 0).toLocaleString()}`;
        f.contentWindow.fetch('/_kbd?class=kb-enter', { method: 'GET' })
          .then(() => {
            S.enterCount = (S.enterCount ?? 0) + 1;
            if (!silent) {
              const wallMs = performance.now() - S.pageStart;
              S.log.push({ wallMs, msg: `[stages] sent Enter (${why}) at ${at}` });
            }
          })
          .catch((e) => {
            if (!silent) console.log(`[stages] sendEnter(${why}) failed: ${e.message}`);
          });
      } catch (e) {
        if (!silent) console.log(`[stages] sendEnter(${why}) threw: ${e.message}`);
      }
    }

    // Per-stage budget tracking. The "start time" for stage N's budget is
    // the wallMs we entered stage N-1 (or page load for the first one).
    // If a stage's elapsed exceeds budget, we bail.
    function budgetCheck() {
      const now = performance.now() - S.pageStart;
      // Compile-phase budget: from page-load until compileMs is recorded.
      if (!S.compileMs) {
        if (now > STAGE_WALL_BUDGET_MS.compile * BUDGET_MULT) {
          S.bailed = { stage: 'compile', reason: `>${STAGE_WALL_BUDGET_MS.compile * BUDGET_MULT}ms compile, no progress`, atWallMs: now };
          S.done = true;
          return false;
        }
        // Compile not finished yet — execution hasn't started, so don't
        // budget-check downstream stages against page-load wall time.
        return true;
      }
      // For each stage in order, check if we're within budget for the
      // NEXT not-yet-reached stage. "Previous" for stage 1 is when
      // execution started (compile-end + boot-build).
      const compileEnd = S.compileMs + (S.bootBuildMs ?? 0);
      let prevReachedAt = compileEnd;
      for (const name of ORDER) {
        if (S.stages[name]) {
          prevReachedAt = S.stages[name].wallMs;
          continue;
        }
        const elapsed = now - prevReachedAt;
        const budget = STAGE_WALL_BUDGET_MS[name] * BUDGET_MULT;
        if (elapsed > budget) {
          S.bailed = { stage: name, reason: `${Math.round(elapsed)}ms since previous (budget ${Math.round(budget)}ms)`, atWallMs: now };
          S.done = true;
          return false;
        }
        return true;
      }
      return true;
    }

    let menuSpamId = null;
    let titleEnterSent = false;

    // ---------- Generic VRAM-change FPS sampler ----------
    //
    // Polls a sparse subsample of guest VRAM at ~SAMPLE_HZ Hz, hashes it,
    // and counts how many *distinct* hashes we see during the gameplay
    // window. Each distinct hash represents one new framebuffer state
    // produced by the cabinet — i.e. one actual frame that the game
    // committed to VRAM, regardless of whether the bridge painted it.
    //
    // Generic across cabinets: works for mode-13h (0xA0000 64KB) and
    // text-mode (0xB8000 4KB). Picks region by current BDA video mode.
    // Subsample stride keeps the read cost low (~256 bytes per poll).
    const VRAM_SAMPLE_HZ   = 60;     // poll rate; high enough not to alias
    const VRAM_SUBSAMPLE   = 256;    // bytes read per poll (sparse stride)
    const VRAM_GFX_BASE    = 0xA0000;
    const VRAM_GFX_LEN     = 64000;  // 320*200 mode 13h
    const VRAM_TEXT_BASE   = 0xB8000;
    const VRAM_TEXT_LEN    = 4000;   // 80*25*2
    let lastVramHash = null;
    let vramSamplerId = null;

    function fnv1aBytes(u8) {
      // 32-bit FNV-1a; cheap and good enough for "did anything change".
      let h = 0x811c9dc5 | 0;
      for (let i = 0; i < u8.length; i++) {
        h ^= u8[i];
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
      }
      return h >>> 0;
    }

    async function sampleVramHash() {
      // Pick base/len by BDA video mode. mode 0x13 = mode 13h graphics;
      // anything else (including 0x03 text) → text VRAM.
      const mode = S.lastMode ?? 0;
      const isGfx = mode === 0x13;
      const base = isGfx ? VRAM_GFX_BASE : VRAM_TEXT_BASE;
      const len  = isGfx ? VRAM_GFX_LEN  : VRAM_TEXT_LEN;
      // We want to detect ANY frame change, so we hash a sparse subsample
      // spread ACROSS the visible region — sampling only the first 256
      // bytes catches the top of the screen (sky band, mostly static).
      // Peek a centered region (covers HUD-free area where doom renders
      // walls/sprites and the column-drawer fires heavily). For mode 13h
      // (320x200), y=80 starts at offset 320*80 = 25600 = 0x6400; we read
      // 1024 bytes there which spans 3.2 visible scanlines.
      const off = isGfx ? Math.floor(len / 2) - 512 : 0;
      const readLen = isGfx ? 1024 : VRAM_SUBSAMPLE;
      const buf = await peekMem(base + off, Math.min(len - off, readLen));
      if (!buf) return null;
      return fnv1aBytes(buf);
    }

    function startVramSampler() {
      if (vramSamplerId) return;
      vramSamplerId = setInterval(async () => {
        if (S.done) {
          clearInterval(vramSamplerId);
          vramSamplerId = null;
          return;
        }
        const h = await sampleVramHash();
        if (h == null) return;
        if (lastVramHash !== null && h !== lastVramHash) {
          S.vramFrameChanges = (S.vramFrameChanges || 0) + 1;
          if (S.windowEntry && !S.windowExit) {
            S.windowVramFrameChanges = (S.windowVramFrameChanges || 0) + 1;
          }
        }
        lastVramHash = h;
      }, Math.round(1000 / VRAM_SAMPLE_HZ));
    }
    // Fire it up immediately — even pre-window samples let us see boot
    // animation framerate, useful for sanity checking.
    startVramSampler();

    // Sample interval: 250 ms wall. peek-mem cost is small (a few hundred
    // bytes). Stage transitions happen at ~seconds granularity, so this
    // is plenty fine. Avoids hammering the bridge unnecessarily.
    setInterval(async () => {
      if (S.done) return;
      if (!budgetCheck()) return;

      // Read mode + program globals + (only if needed) text VRAM
      // every tick. The latter is 4000 bytes; cheap enough.
      const mode_b   = await peekMem(ADDR_BDA_MODE, 1);
      if (!mode_b) return; // bridge not ready
      const mode = mode_b[0];

      const gs_b   = await peekMem(ADDR_GAMESTATE, 1);
      const me_b   = await peekMem(ADDR_MENUACTIVE, 1);
      const ga_b   = await peekMem(ADDR_GAMEACTION, 1);
      const ug_b   = await peekMem(ADDR_USERGAME, 1);
      const gs = gs_b ? gs_b[0] : null;
      const me = me_b ? me_b[0] : null;
      const ga = ga_b ? ga_b[0] : null;
      const ug = ug_b ? ug_b[0] : null;
      // Stash latest gs/me/ga/ug on S so the final summary can show
      // where the run got stuck if it bails.
      S.lastGs = gs;
      S.lastMe = me;
      S.lastGa = ga;
      S.lastUg = ug;
      S.lastMode = mode;
      // Track if we've ever seen ga != 0. ga is normally consumed
      // WITHIN A SINGLE GAME TICK by G_Ticker, so a 250 ms poll usually
      // misses the window. Logged when caught for diagnostics, but the
      // durable signal is _g_usergame (see below) — never gate on ga.
      if (ga != null && ga !== GA_NOTHING && S.firstGaSeenAt == null) {
        S.firstGaSeenAt = {
          wallMs: performance.now() - S.pageStart,
          ga, ticks: S.latest.ticks ?? null, cycles: S.latest.cycles ?? null,
        };
        S.log.push({
          wallMs: S.firstGaSeenAt.wallMs,
          msg: `[stages] gameaction=${ga} caught (transient: nothing=0 loadlevel=1 newgame=2) at cyc=${(S.latest.cycles ?? 0).toLocaleString()}`,
        });
      }
      // Durable: _g_usergame=1 latches when G_InitNew runs (i.e. menu
      // transition fired and level-load is starting). Stop pressing
      // Enter and log it.
      if (ug === 1 && S.firstUgSeenAt == null) {
        S.firstUgSeenAt = {
          wallMs: performance.now() - S.pageStart,
          ticks: S.latest.ticks ?? null, cycles: S.latest.cycles ?? null,
        };
        S.log.push({
          wallMs: S.firstUgSeenAt.wallMs,
          msg: `[stages] _g_usergame=1 (G_InitNew has run, level-load in progress) at cyc=${(S.latest.cycles ?? 0).toLocaleString()} — STOPPING menu spam`,
        });
        if (menuSpamId) {
          clearInterval(menuSpamId);
          menuSpamId = null;
        }
      }

      // Stages must reach in order. The unreached prerequisites of a
      // stage gate the test for that stage — this rules out false
      // positives at startup when all engine state is zero (gs=0 = LEVEL,
      // me=0 = inactive: looks like in-game already), and when the
      // memory hasn't been written yet (just-reset BSS).
      //
      // Until bridge-stats has arrived, also skip — we want every stage
      // stamp to carry a real ticks+cycles value.
      if (!S.latest) return;

      // Stage 1/2 — text-mode signatures. Read once we're in mode 0x03.
      if (mode === 0x03 &&
          (!S.stages.stage_text_drdos || !S.stages.stage_text_doom)) {
        const vram = await peekMem(ADDR_TEXT_VRAM, TEXT_VRAM_BYTES);
        if (vram) {
          if (!S.stages.stage_text_drdos && vramContains(vram, 'DR-DOS')) {
            stamp('stage_text_drdos', {
              ticks: S.latest.ticks ?? null,
              cycles: S.latest.cycles ?? null,
            });
          }
          if (!S.stages.stage_text_doom &&
              S.stages.stage_text_drdos &&
              vramContains(vram, 'DOOM8088')) {
            stamp('stage_text_doom', {
              ticks: S.latest.ticks ?? null,
              cycles: S.latest.cycles ?? null,
            });
          }
        }
      }

      // Stage 3 — mode 0x13 title splash. Gated on stage_text_doom so we
      // don't fire on freshly-reset memory where gamestate happens to be 3
      // (BSS init: actually 0, so this isn't the failure mode, but the
      // ordering guard is still right).
      if (!S.stages.stage_title &&
          S.stages.stage_text_doom &&
          mode === 0x13 && gs === GS_DEMOSCREEN && me === 0) {
        stamp('stage_title', {
          ticks: S.latest.ticks ?? null,
          cycles: S.latest.cycles ?? null,
        });
        // Press Enter to dismiss the title and bring up the main menu.
        // 1500ms gives the splash a moment to settle (DOOM's title-fade
        // animation needs to run before it accepts input).
        if (!titleEnterSent) {
          titleEnterSent = true;
          setTimeout(() => sendEnter('title-dismiss'), 1500);
        }
      }

      // Stage 4 — main menu visible.
      if (!S.stages.stage_menu &&
          S.stages.stage_title &&
          me === 1) {
        stamp('stage_menu', {
          ticks: S.latest.ticks ?? null,
          cycles: S.latest.cycles ?? null,
        });
        // Drive the menu chain: NEW GAME → skill → start. Shareware has
        // only one episode so DOOM auto-skips the episode menu. That's
        // 2 Enters total: select NEW GAME, then select skill.
        //
        // Rather than time the Enters precisely (DOOM's menu tick rate
        // is unpredictable on web — currently <1 fps), spam Enter every
        // 500ms until either gs goes to LEVEL (in-game) or the bench
        // bails. If a press lands on the wrong frame DOOM ignores it; a
        // later one will be processed. Worst case: a stray Enter on the
        // skill menu picks Nightmare, which opens a confirm dialog
        // expecting 'y'/'n' — but we default to itemOn=2 (Hurt me
        // plenty), and Nightmare is itemOn=4. The down-arrow needed to
        // reach Nightmare isn't sent, so spamming Enter just keeps
        // re-selecting Hurt-me-plenty → ChooseSkill(2) → game starts.
        if (!menuSpamId) {
          // First menu-spam press: log, with context. Subsequent ones:
          // silent, but the status-line shows `enters=N` from S.enterCount.
          sendEnter('menu-spam-first');
          menuSpamId = setInterval(() => {
            if (S.stages.stage_ingame || S.done) {
              clearInterval(menuSpamId);
              return;
            }
            sendEnter('menu-spam', /*silent=*/true);
          }, 500);
        }
      }

      // Stage 5 — level-load in progress. Doom8088's G_DoNewGame calls
      // G_InitNew (which sets _g_usergame=1) BEFORE G_DoLoadLevel runs
      // (which flips _g_gamestate to GS_LEVEL). On web this gap is
      // multi-minute (slow CSS evaluation of map-load loops), so it's a
      // real distinct stage worth measuring on its own.
      if (!S.stages.stage_loading &&
          S.stages.stage_menu &&
          ug === 1 && gs === GS_DEMOSCREEN) {
        stamp('stage_loading', {
          ticks: S.latest.ticks ?? null,
          cycles: S.latest.cycles ?? null,
        });
      }

      // Stage 6 — in-game. Gated on stage_menu so we don't false-fire
      // on the GS_LEVEL=0 default of zeroed BSS at machine reset.
      if (!S.stages.stage_ingame &&
          S.stages.stage_menu &&
          gs === GS_LEVEL && me === 0) {
        stamp('stage_ingame', {
          ticks: S.latest.ticks ?? null,
          cycles: S.latest.cycles ?? null,
        });
        // Begin the gameplay-throughput window. Spam LEFT-arrow so the
        // player keeps turning — keeps the renderer busy with the
        // column drawer (R_DrawColumn fires per visible vertical strip
        // per frame, so we want the view changing continuously).
        S.windowEntry = {
          wallMs: performance.now() - S.pageStart,
          ticks: S.latest.ticks ?? 0,
          cycles: S.latest.cycles ?? 0,
          // Bridge-emitted frame count at window entry. Bridge increments
          // frameCount inside maybeEmitFrame, exposed via bridge-stats
          // packets as `framesEncoded`. Diff at window-exit gives the
          // count of frames the bridge actually painted.
          framesEncoded: S.latest.framesEncoded ?? 0,
        };
        S.windowVramFrameChanges = 0;
        S.windowDeadline = performance.now() + WINDOW_MS;
        S.log.push({
          wallMs: S.windowEntry.wallMs,
          msg: `[stages] entered gameplay window — ${WINDOW_MS}ms holding LEFT, then exit`,
        });
        // LEFT-arrow extended scancode = 0x4B, ASCII = 0x00 → key word 0x4B00.
        // Spam every 100ms (mimics held key); doom processes keys per gametic.
        S.leftSpamId = setInterval(() => {
          if (S.done) {
            clearInterval(S.leftSpamId);
            return;
          }
          try {
            const f = document.getElementById('frame');
            if (!f || !f.contentWindow) return;
            f.contentWindow.fetch('/_kbd?class=kb-left', { method: 'GET' }).catch(() => {});
          } catch {}
        }, 100);
      } else if (S.stages.stage_ingame && S.windowEntry && !S.windowExit) {
        // In-window measurement. Wait until WINDOW_MS has elapsed,
        // then stamp the exit state and end the run.
        if (performance.now() >= S.windowDeadline) {
          const wallMs = performance.now() - S.pageStart;
          S.windowExit = {
            wallMs,
            ticks: S.latest.ticks ?? 0,
            cycles: S.latest.cycles ?? 0,
            framesEncoded: S.latest.framesEncoded ?? 0,
          };
          const dWall = wallMs - S.windowEntry.wallMs;
          const dTicks = S.windowExit.ticks - S.windowEntry.ticks;
          const dCycles = S.windowExit.cycles - S.windowEntry.cycles;
          const dFramesEncoded = S.windowExit.framesEncoded - S.windowEntry.framesEncoded;
          const dVramFrames = S.windowVramFrameChanges ?? 0;
          const ticksPerSec = dTicks / (dWall / 1000);
          const cyclesPerSec = dCycles / (dWall / 1000);
          // Wall-clock paint rate: how many frames the bridge actually
          // emitted to the page during the window (each one becomes a
          // BMP put-into-the-DOM, observable to the user).
          const paintFps = dFramesEncoded / (dWall / 1000);
          // VRAM-change rate: how many *distinct* framebuffer states the
          // cabinet committed to VRAM during the window. This is the
          // game's actual produced fps, regardless of whether the bridge
          // painted them or not. Generic — works for any cabinet.
          const vramFps = dVramFrames / (dWall / 1000);
          S.gameplayWindow = {
            wallMs: dWall,
            ticks: dTicks,
            cycles: dCycles,
            ticksPerSec,
            cyclesPerSec,
            // simulatedFps: cycles/sec divided by cycles per gametic at
            // native 4.77MHz (35 gametics/sec). Tells us "engine is
            // running at X× real-time".
            simulatedFps: cyclesPerSec / (4_770_000 / 35),
            // Also keep the old name for backwards compat.
            estimatedFps: cyclesPerSec / (4_770_000 / 35),
            // Frames the bridge painted (BMP emits visible to the user).
            framesEncoded: dFramesEncoded,
            paintFps,
            // Frames the cabinet wrote to VRAM (generic VRAM-hash-change).
            vramFrameChanges: dVramFrames,
            vramFps,
          };
          S.log.push({
            wallMs,
            msg: `[stages] window done: sim=${S.gameplayWindow.simulatedFps.toFixed(1)}fps vram=${vramFps.toFixed(1)}fps paint=${paintFps.toFixed(1)}fps (${dTicks.toLocaleString()} ticks, ${dCycles.toLocaleString()} cycles, ${dVramFrames} vram-changes, ${dFramesEncoded} bridge-paints in ${Math.round(dWall)}ms)`,
          });
          if (S.leftSpamId) clearInterval(S.leftSpamId);
          S.done = true;
        }
      }
    }, 250);
  }, {
    ADDR_GAMESTATE, ADDR_MENUACTIVE, ADDR_GAMEACTION, ADDR_USERGAME,
    ADDR_BDA_MODE, ADDR_TEXT_VRAM,
    TEXT_VRAM_BYTES, GS_LEVEL, GS_DEMOSCREEN, GA_NOTHING,
    BUDGET_MULT, STAGE_WALL_BUDGET_MS,
    CAPTURE_SNAPSHOTS: !!SNAPSHOT_DIR,
    WINDOW_MS,
  });

  if (SNAPSHOT_DIR) {
    try { mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch {}
  }

  // Outer loop: poll the page for done/progress, print stderr summaries.
  // The hard timeout = sum of all stage budgets * BUDGET_MULT, plus a
  // 30s grace.
  const totalBudget =
    Object.values(STAGE_WALL_BUDGET_MS).reduce((a,b) => a+b, 0) * BUDGET_MULT
    + 30_000;
  const hardDeadline = Date.now() + totalBudget;

  // Stage-stamps and snapshot saves are printed on their own lines (\n)
  // so they're never overwritten. Per-tick stats use a carriage-return
  // overwrite so the terminal shows ONE updating line for live progress.
  // We track the set of stages we've already milestone-printed and the
  // log lines we've already echoed so we don't repeat them.
  const printedStages = new Set();
  const printedLogIds = new Set(); // wallMs as id
  const isTTY = process.stderr.isTTY;
  const startMs = Date.now();
  let lastStatusLineLen = 0;
  function clearStatusLine() {
    if (isTTY && lastStatusLineLen > 0) {
      process.stderr.write('\r' + ' '.repeat(lastStatusLineLen) + '\r');
      lastStatusLineLen = 0;
    }
  }
  function milestone(line) {
    clearStatusLine();
    process.stderr.write(line + '\n');
  }
  function statusLine(line) {
    if (!isTTY) {
      // Non-TTY: print at most every 5s to avoid flooding logs.
      if (!statusLine._lastWrite || (Date.now() - statusLine._lastWrite) > 5000) {
        process.stderr.write(line + '\n');
        statusLine._lastWrite = Date.now();
      }
      return;
    }
    process.stderr.write('\r' + line);
    // Pad shorter lines so a previous longer line doesn't bleed through.
    if (lastStatusLineLen > line.length) {
      process.stderr.write(' '.repeat(lastStatusLineLen - line.length));
    }
    lastStatusLineLen = line.length;
  }

  while (Date.now() < hardDeadline) {
    const snap = await page.evaluate(() => {
      const S = globalThis.__stages;
      if (!S) return null;
      // Drain pending snapshots in this same call so they reach the Node
      // side promptly, and clear them on the page so memory doesn't grow.
      const pending = S.snapshotsPending;
      S.snapshotsPending = [];
      return {
        done: S.done,
        bailed: S.bailed,
        stages: S.stages,
        compileMs: S.compileMs,
        bootBuildMs: S.bootBuildMs,
        cabinetBytes: S.cabinetBytes,
        packedBroadcastPortCount: S.packedBroadcastPortCount ?? null,
        compiledOpCount: S.compiledOpCount ?? null,
        compiledSlotCount: S.compiledSlotCount ?? null,
        latest: S.latest,
        log: S.log,
        snapshots: pending,
        enterCount: S.enterCount ?? 0,
        lastGs: S.lastGs,
        lastMe: S.lastMe,
        lastGa: S.lastGa,
        lastUg: S.lastUg,
        firstGaSeenAt: S.firstGaSeenAt,
        firstUgSeenAt: S.firstUgSeenAt,
        vramFrameChanges: S.vramFrameChanges ?? 0,
        windowVramFrameChanges: S.windowVramFrameChanges ?? 0,
        windowEntry: S.windowEntry ?? null,
      };
    });

    // Save any snapshot bytes that came back this poll.
    if (snap?.snapshots && SNAPSHOT_DIR) {
      for (const s of snap.snapshots) {
        const path = resolve(SNAPSHOT_DIR, `${s.name}.snap`);
        const bytes = Buffer.from(s.bytes);
        writeFileSync(path, bytes);
        milestone(`[snap] saved ${s.name} → ${path} (${bytes.length} bytes)`);
      }
    }

    // Echo new log/milestone lines from the page (stage stamps, Enter sends).
    if (snap?.log) {
      for (const entry of snap.log) {
        const id = entry.wallMs;
        if (!printedLogIds.has(id)) {
          printedLogIds.add(id);
          milestone(entry.msg);
        }
      }
    }

    // Overwriting status line with current bridge stats.
    if (snap?.latest) {
      const d = snap.latest;
      const wallS = ((Date.now() - startMs) / 1000).toFixed(1);
      const stages = Object.keys(snap.stages).map(s => s.replace('stage_', '')).join(',') || '-';
      const compileNote = snap.compileMs ? `compile=${Math.round(snap.compileMs/1000)}s` : 'compile=…';
      const gs = snap.lastGs != null ? snap.lastGs : '?';
      const me = snap.lastMe != null ? snap.lastMe : '?';
      const ga = snap.lastGa != null ? snap.lastGa : '?';
      const ug = snap.lastUg != null ? snap.lastUg : '?';
      const enters = snap.enterCount ?? 0;
      const gaEvent = snap.firstGaSeenAt ? '✓' : '·';
      const ugEvent = snap.firstUgSeenAt ? '✓' : '·';
      // Track VRAM-fps and paint-fps deltas across the last 1s of the
      // status loop. Persist on outer scope (statusLine._fps) so the
      // delta is over a fixed wall window (1s) rather than total run.
      const nowMs = Date.now();
      if (!statusLine._fps) statusLine._fps = { lastMs: nowMs, lastVram: 0, lastPaint: 0 };
      const dtSec = (nowMs - statusLine._fps.lastMs) / 1000;
      let vramFps = 0, paintFps = 0;
      if (dtSec > 0.5) {
        vramFps = ((snap.vramFrameChanges ?? 0) - statusLine._fps.lastVram) / dtSec;
        paintFps = ((d.framesEncoded ?? 0) - statusLine._fps.lastPaint) / dtSec;
        statusLine._fps = {
          lastMs: nowMs,
          lastVram: snap.vramFrameChanges ?? 0,
          lastPaint: d.framesEncoded ?? 0,
        };
      } else {
        vramFps = statusLine._fps.cachedVram ?? 0;
        paintFps = statusLine._fps.cachedPaint ?? 0;
      }
      statusLine._fps.cachedVram = vramFps;
      statusLine._fps.cachedPaint = paintFps;
      statusLine(
        `t=${wallS}s ${compileNote} cyc=${(d.cycles ?? 0).toLocaleString()} ` +
        `vram=${vramFps.toFixed(1)}fps paint=${paintFps.toFixed(1)}fps ` +
        `ticks=${(d.ticks ?? 0).toLocaleString()} mode=0x${(d.videoMode ?? 0).toString(16)} ` +
        `gs=${gs} me=${me} ga=${ga}${gaEvent} ug=${ug}${ugEvent} enters=${enters} stages=${stages}`
      );
    }
    if (snap?.done) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  clearStatusLine();

  // Final read.
  result = await page.evaluate(() => {
    const S = globalThis.__stages;
    if (!S) return { error: 'no state captured' };
    return {
      stages: S.stages,
      compileMs: S.compileMs,
      bootBuildMs: S.bootBuildMs,
      cabinetBytes: S.cabinetBytes,
      bailed: S.bailed,
      done: S.done,
      latest: S.latest,
      lastGs: S.lastGs,
      lastMe: S.lastMe,
      lastGa: S.lastGa,
      lastUg: S.lastUg,
      lastMode: S.lastMode,
      firstGaSeenAt: S.firstGaSeenAt,
      firstUgSeenAt: S.firstUgSeenAt,
      windowEntry: S.windowEntry,
      windowExit: S.windowExit,
      gameplayWindow: S.gameplayWindow,
      log: S.log,
    };
  });

  // Pretty deltas: each stage's wallMs since previous, plus tick/cycle deltas.
  const ORDER = ['stage_text_drdos', 'stage_text_doom',
                 'stage_title', 'stage_menu', 'stage_loading', 'stage_ingame'];
  const deltas = {};
  let prev = { wallMs: (result.compileMs ?? 0) + (result.bootBuildMs ?? 0),
               ticks: 0, cycles: 0 };
  for (const name of ORDER) {
    const s = result.stages?.[name];
    if (!s) continue;
    deltas[name] = {
      wallMsAbs:    +s.wallMs.toFixed(0),
      wallMsDelta:  +(s.wallMs - prev.wallMs).toFixed(0),
      ticks:        s.ticks ?? null,
      ticksDelta:   s.ticks != null ? (s.ticks - prev.ticks) : null,
      cycles:       s.cycles ?? null,
      cyclesDelta:  s.cycles != null ? (s.cycles - prev.cycles) : null,
    };
    prev = { wallMs: s.wallMs, ticks: s.ticks ?? prev.ticks, cycles: s.cycles ?? prev.cycles };
  }

  const summary = {
    cart: CART,
    done: !!result.done,
    bailed: result.bailed,
    cabinetBytes: result.cabinetBytes,
    bootBuildMs:  result.bootBuildMs != null ? +result.bootBuildMs.toFixed(0) : null,
    compileMs:    result.compileMs   != null ? +result.compileMs.toFixed(0)   : null,
    packedBroadcastPortCount: result.packedBroadcastPortCount,
    compiledOpCount:           result.compiledOpCount,
    compiledSlotCount:         result.compiledSlotCount,
    finalState: { gs: result.lastGs, menuactive: result.lastMe,
                  gameaction: result.lastGa, usergame: result.lastUg,
                  mode: result.lastMode },
    firstGaSeenAt: result.firstGaSeenAt,
    firstUgSeenAt: result.firstUgSeenAt,
    stages: deltas,
    headline: {
      // Time from machine-running (post-compile) to first in-game frame.
      runMsToInGame: result.stages?.stage_ingame
        ? +(result.stages.stage_ingame.wallMs - (result.compileMs ?? 0) - (result.bootBuildMs ?? 0)).toFixed(0)
        : null,
      // Time from page-load to first in-game frame (full user-felt path).
      pageMsToInGame: result.stages?.stage_ingame
        ? +result.stages.stage_ingame.wallMs.toFixed(0)
        : null,
      ticksToInGame:  result.stages?.stage_ingame?.ticks  ?? null,
      cyclesToInGame: result.stages?.stage_ingame?.cycles ?? null,
    },
    gameplayWindow: result.gameplayWindow ?? null,
  };
  const out = JSON.stringify(summary, null, 2) + '\n';
  process.stdout.write(out);
  if (JSON_OUT) writeFileSync(JSON_OUT, out);
} finally {
  await browser.close();
}

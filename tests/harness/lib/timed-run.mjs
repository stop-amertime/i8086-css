// timed-run.mjs — run calcite-debugger forward under three orthogonal
// budgets, any one of which can terminate the run.
//
//   wallMs:          wall-clock ceiling. The #1 complaint from agents is
//                    "run_until stalled forever." The debugger's run_until
//                    has max_ticks but that only triggers when ticks are
//                    actually advancing. Wall-clock triggers unconditionally.
//   maxTicks:        tick ceiling. Pass-through to the debugger's own cap.
//   stallTicksPerSec: if observed tick rate drops below this floor for
//                    `stallSeconds` consecutive seconds, kill the run with
//                    reason "stalled". Catches "CPU is spinning on an HLT
//                    in a tight IRQ-disabled loop" — ticks move but real
//                    work doesn't, and the agent wants to know.
//   predicate:       JS-side check run every chunk. Return true to stop
//                    with reason "predicate". Gets the latest /state.
//
// Strategy: drive the debugger by /tick in CHUNK_TICKS bursts, checking
// all budgets between chunks. No run_until server job — we own the loop
// so cancellation is instant and wall-clock-precise.
//
// Trade-off: chunked /tick is a bit slower than a single server-side
// run_until because of HTTP round-trips. But even at 1000 chunks/s with
// CHUNK_TICKS=5000 that's 5M ticks/s ceiling, well above calcite's
// actual speed. Worth the wall-clock guarantee.

// Default chunk for `tick` calls — small, because `tick` returns a
// per-tick change log that the server caps (at the time of writing it
// rejects count > ~500 because the MCP result-size limit can't hold
// the whole log). For bulk forward motion the harness uses `seek`,
// which doesn't return the log.
const DEFAULT_CHUNK_TICKS = 400;

// For bulk `seek` advancement, how many ticks to leap per step. Bigger is
// faster (server replays from the nearest checkpoint) but leaves bigger
// holes between predicate checks. 5000 matches calcite's default
// checkpoint interval; smaller values give finer predicate granularity
// at the cost of more round-trips.
const DEFAULT_SEEK_STRIDE = 5000;

// `mode` controls how the harness advances the debugger:
//   'seek'  — advance via seek(endTick + stride). Fast, no per-tick log
//             returned, but predicate sees only "end of stride" states.
//             This is the DEFAULT because all our tests care about
//             reaching a goal, not inspecting every tick on the way.
//   'tick'  — advance via tick(chunkTicks). Returns per-tick change log;
//             useful for short debugging bursts where the caller wants
//             the log. Chunk size is bounded below the server's per-call
//             cap (~500).
export async function timedRun(dbg, {
  wallMs = 60_000,
  maxTicks = 10_000_000,
  stallTicksPerSec = null,
  stallSeconds = 5,
  predicate = null,
  chunkTicks = DEFAULT_CHUNK_TICKS,
  seekStride = DEFAULT_SEEK_STRIDE,
  mode = 'seek',
  onProgress = null,          // optional callback: ({elapsedMs, tick, ticksPerSec})
  progressEveryMs = 1000,
} = {}) {
  const t0 = Date.now();
  let lastProgressAt = t0;
  let lastStallCheckAt = t0;
  let lastStallCheckTick = null;
  let stallStartedAt = null;
  let startTick = null;
  let endTick = null;
  let endReason = null;
  let predicateValue = null;

  const initialState = await dbg.state();
  startTick = initialState.tick;
  endTick = startTick;

  while (true) {
    const elapsedMs = Date.now() - t0;

    // --- Budget checks before the next chunk ---
    if (elapsedMs >= wallMs) { endReason = 'wall'; break; }
    const ticksDone = endTick - startTick;
    if (ticksDone >= maxTicks) { endReason = 'maxTicks'; break; }

    // --- Advance one chunk ---
    const remaining = maxTicks - ticksDone;
    if (mode === 'seek') {
      const stride = Math.min(seekStride, Math.max(1, remaining));
      const targetTick = endTick + stride;
      // Seek replays from the nearest checkpoint — fast even for big jumps.
      // Generous timeout: corduroy boot replays can take tens of seconds
      // for a several-million-tick target.
      await dbg.seek(targetTick);
      endTick = targetTick;
    } else {
      const thisChunk = Math.min(chunkTicks, Math.max(1, remaining));
      const tickRes = await dbg.tick(thisChunk);
      endTick = tickRes.tick ?? (endTick + thisChunk);
    }

    // --- Stall detection ---
    if (stallTicksPerSec != null) {
      const now = Date.now();
      if (lastStallCheckTick == null) {
        lastStallCheckTick = endTick;
        lastStallCheckAt = now;
      } else if (now - lastStallCheckAt >= 1000) {
        const dt = (now - lastStallCheckAt) / 1000;
        const dTick = endTick - lastStallCheckTick;
        const rate = dTick / dt;
        if (rate < stallTicksPerSec) {
          if (stallStartedAt == null) stallStartedAt = now;
          if ((now - stallStartedAt) / 1000 >= stallSeconds) {
            endReason = 'stalled';
            break;
          }
        } else {
          stallStartedAt = null;
        }
        lastStallCheckTick = endTick;
        lastStallCheckAt = now;
      }
    }

    // --- Predicate ---
    if (predicate) {
      const state = await dbg.state();
      const v = predicate(state);
      if (v) {
        predicateValue = v;
        endReason = 'predicate';
        break;
      }
    }

    // --- Progress reporting ---
    if (onProgress && Date.now() - lastProgressAt >= progressEveryMs) {
      const now = Date.now();
      const dt = (now - lastProgressAt) / 1000;
      const rate = dt > 0 ? (endTick - startTick) / ((now - t0) / 1000) : 0;
      onProgress({ elapsedMs: now - t0, tick: endTick, ticksPerSec: rate });
      lastProgressAt = now;
    }
  }

  const totalMs = Date.now() - t0;
  const ticks = endTick - startTick;
  const finalState = await dbg.state();
  return {
    reason: endReason,
    startTick,
    endTick,
    ticks,
    wallMs: totalMs,
    ticksPerSec: totalMs > 0 ? (ticks * 1000) / totalMs : 0,
    predicateValue,
    finalState,
  };
}

// Helper: common predicates for "run until the program is really running"
// style waits.
export const predicates = {
  // Stop when CS leaves the BIOS (F000) AND the low IVT/BDA (<0x0100).
  // For a .COM loaded under corduroy+DOS, this lands in the program's
  // PSP+0x10 segment — i.e. real program code is executing.
  programEntered(state) {
    const cs = state.registers?.CS ?? 0;
    return cs < 0x0100 || cs >= 0xF000 ? false : { reason: 'programEntered', cs };
  },
  // Stop when CS matches a specific value.
  csEquals(target) {
    return (state) => {
      const cs = state.registers?.CS ?? 0;
      return cs === target ? { reason: 'csEquals', cs } : false;
    };
  },
  // Stop when a register matches a specific value (arithmetic comparison).
  registerEquals(name, value) {
    return (state) => {
      const v = state.registers?.[name];
      return v === value ? { reason: 'registerEquals', name, value: v } : false;
    };
  },
  // Stop when any of a set of ticks have passed — reuses maxTicks budget
  // but with a reason.
  afterTick(tick) {
    return (state) => state.tick >= tick ? { reason: 'afterTick', tick: state.tick } : false;
  },
};

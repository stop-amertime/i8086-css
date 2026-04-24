// script-runner.mjs — drive a cabinet through a sequence of keyboard
// events, waits, and screenshots. For testing interactive carts (Zork,
// Montezuma) where gameplay is only reachable via keystrokes.
//
// Script format — JSON array of steps:
//
//   [
//     { "wait": "until-tick", "tick": 200000 },
//     { "wait": "until-text-contains", "text": "It is pitch black",
//       "maxWallMs": 30000, "maxTicks": 500000 },
//     { "shoot": "before-move" },
//     { "type": "go north\\r" },
//     { "wait": "ms", "ms": 500 },
//     { "shoot": "after-move" }
//   ]
//
// Waits:
//   { wait: "ms", ms: N }                      — wall-clock pause
//   { wait: "ticks", ticks: N }                — advance by N ticks
//   { wait: "until-tick", tick: N }            — seek to tick N
//   { wait: "until-text-contains", text: "…", maxTicks, maxWallMs }
//                                              — run forward until the
//                                                text-mode buffer contains
//                                                the substring; budget-capped
//   { wait: "until-mode", mode: 0x13, maxTicks, maxWallMs } — wait until
//                                                video mode changes
//
// Actions:
//   { type: "string" }   — send each char as a BDA keyboard event. `\r`
//                          becomes 0x0D (Enter), `\n` → 0x0A, `\t` → 0x09.
//                          ESC: use the literal char or "\\x1B".
//   { key: N }           — push a specific raw scancode|ascii value
//                          directly into the BDA ring.
//   { shoot: "name" }    — screenshot at the current tick; written to
//                          results/<script-name>/<name>.png.
//
// Returns: full log of events + screenshot paths.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { shoot } from './shoot.mjs';

function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// ASCII → BDA ring-buffer value. Real hardware would also push a scancode
// in the high byte, but the DOS INT 16h code mostly cares about the ASCII
// byte — simple carts don't inspect scancode. For precision use a raw
// {key: N} step.
function asciiToBdaWord(c) {
  const b = c.charCodeAt(0) & 0xFF;
  return b;  // ASCII in low byte, scancode=0 in high. Good enough.
}

async function sendString(dbg, s) {
  const unescaped = s
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (const ch of unescaped) {
    await dbg.key(asciiToBdaWord(ch), 'bda');
    // small gap so the DOS input polling sees each key separately
    await sleepMs(2);
  }
}

async function waitUntilTextContainsImpl(dbg, { text, maxTicks = 1_000_000, maxWallMs = 30_000 }) {
  const t0 = performance.now();
  const stride = 5000;
  const start = (await dbg.state()).tick;
  let now = start;
  while (performance.now() - t0 < maxWallMs && now - start < maxTicks) {
    // Look at the text-mode buffer for substring.
    const mem = await dbg.memory(0xB8000, 80 * 25 * 2);
    let buf = '';
    for (let i = 0; i < mem.bytes.length; i += 2) {
      const b = mem.bytes[i] & 0xFF;
      buf += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : ' ';
    }
    if (buf.includes(text)) return { reason: 'text-found', tick: now, foundAt: buf.indexOf(text) };
    await dbg.seek(now + stride);
    now = (await dbg.state()).tick;
  }
  return { reason: 'timeout', tick: now };
}

async function waitUntilMode(dbg, { mode, maxTicks = 1_000_000, maxWallMs = 30_000 }) {
  const t0 = performance.now();
  const stride = 2000;
  const start = (await dbg.state()).tick;
  let now = start;
  while (performance.now() - t0 < maxWallMs && now - start < maxTicks) {
    const r = await dbg.memory(0x449, 1);
    if ((r.bytes[0] & 0xFF) === (mode & 0xFF)) return { reason: 'mode-matched', tick: now };
    await dbg.seek(now + stride);
    now = (await dbg.state()).tick;
  }
  return { reason: 'timeout', tick: now };
}

export async function runScript({ dbg, script, outDir, scriptName = 'script' }) {
  mkdirSync(outDir, { recursive: true });
  const log = [];
  for (const step of script) {
    const t0 = performance.now();
    if (step.wait === 'ms') {
      await sleepMs(step.ms);
      log.push({ step, ms: Math.round(performance.now() - t0) });
    } else if (step.wait === 'ticks') {
      const cur = (await dbg.state()).tick;
      await dbg.seek(cur + step.ticks);
      log.push({ step, tickAfter: cur + step.ticks });
    } else if (step.wait === 'until-tick') {
      await dbg.seek(step.tick);
      log.push({ step, tickAfter: step.tick });
    } else if (step.wait === 'until-text-contains') {
      const r = await waitUntilTextContainsImpl(dbg, step);
      log.push({ step, ...r, ms: Math.round(performance.now() - t0) });
      if (r.reason === 'timeout') {
        return { ok: false, log, reason: 'text-wait-timeout', text: step.text };
      }
    } else if (step.wait === 'until-mode') {
      const r = await waitUntilMode(dbg, step);
      log.push({ step, ...r, ms: Math.round(performance.now() - t0) });
      if (r.reason === 'timeout') return { ok: false, log, reason: 'mode-wait-timeout' };
    } else if (step.type != null) {
      await sendString(dbg, step.type);
      log.push({ step });
    } else if (step.key != null) {
      await dbg.key(step.key, 'bda');
      log.push({ step });
    } else if (step.shoot != null) {
      const shotName = `${scriptName}-${step.shoot}.png`;
      const shotPath = join(outDir, shotName);
      const shotResult = await shoot(dbg);
      if (shotResult.png) writeFileSync(shotPath, shotResult.png);
      const { rgba: _r, png: _p, ...lite } = shotResult;
      log.push({ step, shotPath, shot: lite });
    } else {
      log.push({ step, error: 'unrecognised step' });
      return { ok: false, log, reason: 'bad-step' };
    }
  }
  return { ok: true, log };
}

export function loadScriptFromFile(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text);
}

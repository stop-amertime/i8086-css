#!/usr/bin/env node
// web/scripts/raw-regen.mjs
// Generate player/raw.html — the "theoretical" (non-working)
// player. Writes 320×200 = 64,000 <i> pixel elements for the Mode 13h
// framebuffer, plus the .cpu/.screen/.kb-* scaffolding the cabinet
// CSS's selectors target, plus two <link rel="stylesheet"> tags (the
// player stylesheet and the cabinet itself). No JS.
//
// In principle Chrome loads the cabinet, evaluates its rules, and the
// machine runs entirely through CSS custom properties driving pixel
// elements. In practice Chrome crashes or hangs on the cabinet's
// size — that's the point. This page represents the spec-correct
// rendering path; calcite runs the same machine at playable speed.
//
// Run this whenever the scaffolding needs to change:
//   node web/scripts/raw-regen.mjs

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, '..', '..', 'player', 'raw.html');

const PIXEL_W = 320;
const PIXEL_H = 200;

// Flat list of pixel <i> elements. Each gets an id pN so cabinet
// selectors like `#p12345` can target a specific pixel.
function pixelGrid() {
  const parts = new Array(PIXEL_W * PIXEL_H);
  for (let i = 0; i < parts.length; i++) {
    parts[i] = `<i id=p${i}></i>`;
  }
  // 320 per row so editors don't choke, but with display:grid on the
  // parent this wraps correctly regardless of whitespace.
  const rows = [];
  for (let y = 0; y < PIXEL_H; y++) {
    rows.push(parts.slice(y * PIXEL_W, (y + 1) * PIXEL_W).join(''));
  }
  return rows.join('\n');
}

const KEYS = [
  ['1','2','3','4','5','6','7','8','9','0'],
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l','enter'],
  ['z','x','c','v','b','n','m','space'],
];

function keyboard() {
  const rows = KEYS.map(row =>
    row.map(k => {
      if (k === 'enter') return `<button id=kb-enter class=kb-wide>&#8629;</button>`;
      if (k === 'space') return `<button id=kb-space class=kb-space>&#9251;</button>`;
      return `<button id=kb-${k}>${k.toUpperCase()}</button>`;
    }).join('')
  ).join('\n          ');
  return `<key-board class="kb-layout">
        <div class="kb-main">
          ${rows}
        </div>
        <div class="kb-side">
          <div class="kb-mods">
            <button id=kb-esc>Esc</button><button id=kb-tab>Tab</button><button id=kb-bksp>Bksp</button>
          </div>
          <div class="kb-arrows">
            <button id=kb-up>&#8593;</button>
            <button id=kb-left>&#8592;</button><button id=kb-down>&#8595;</button><button id=kb-right>&#8594;</button>
          </div>
        </div>
      </key-board>`;
}

function html() {
  return `<!DOCTYPE html>
<!-- AUTOGEN by web/scripts/raw-regen.mjs. Do not edit. -->
<html>
<head>
  <meta charset="utf-8">
  <title>CSS-DOS · raw CSS</title>
  <!--
    The "theoretical" player. Loads /cabinet.css directly — no calcite,
    no bridge, no worker, no JS. In principle Chrome evaluates the
    cabinet and its rules drive the .cpu / .screen / #p0 .. #p63999
    pixels and .kb-* keys entirely through CSS custom properties.

    In practice Chrome crashes or hangs on the cabinet's millions of
    properties. This page exists to represent the spec-correct
    rendering path. calcite (in calcite.html and calcite-canvas.html)
    runs the same machine at playable speed.

    The pixel grid is ${PIXEL_W}×${PIXEL_H} = ${PIXEL_W * PIXEL_H} <i>
    elements, matching VGA Mode 13h.
  -->
  <link rel="stylesheet" href="assets/player.css">
  <link rel="stylesheet" href="/cabinet.css">
  <style>
    /* Minimal scaffolding so the page at least has pixel geometry
       even if cabinet CSS doesn't load or doesn't match. */
    .screen {
      display: grid;
      grid-template-columns: repeat(${PIXEL_W}, 1px);
      grid-auto-rows: 1px;
      width: ${PIXEL_W}px;
      height: ${PIXEL_H}px;
      image-rendering: pixelated;
      background: #000;
    }
    .screen > i { display: block; width: 1px; height: 1px; background: transparent; }
  </style>
</head>
<body>
  <div class="clock">
    <div class="cpu">
      <div class="screen">
${pixelGrid()}
      </div>
      ${keyboard()}
    </div>
  </div>
</body>
</html>
`;
}

writeFileSync(out, html());
console.log(`raw-regen: wrote ${out} (${html().length} bytes, ${PIXEL_W * PIXEL_H} pixels)`);

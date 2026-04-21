#!/usr/bin/env node
// web/scripts/split-regen.mjs
// Regenerate web/site/split.html from web/site/build.html so the two
// stay in sync. split.html is the same builder page with an iframe
// pane on the right that hosts /player/calcite.html, plus a bit of
// CSS to lay them out side-by-side.
//
// Run this whenever you edit build.html:
//   node web/scripts/split-regen.mjs
//
// The regen does three things to a copy of build.html:
//   1. Retitle.
//   2. Inject a <style> block into <head> for the split layout.
//   3. Replace the harmless stub #split-player div (which exists in
//      build.html so build.js doesn't blow up) with the real iframe.
//   4. Add `document.body.classList.add('split')` at boot.
//
// Every anchor we look for is checked explicitly; the script throws
// with a clear message if one's missing, so you notice when build.html
// drifts instead of producing a silently-wrong split.html.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteDir = resolve(__dirname, '..', 'site');
const buildPath = resolve(siteDir, 'build.html');
const splitPath = resolve(siteDir, 'split.html');

const SPLIT_STYLE = `  <style>
    /* Split layout: builder on the left, calcite player iframe on the
       right, both filling the viewport. */
    body.split {
      display: flex !important;
      flex-direction: row !important;
      align-items: stretch !important;
      gap: 8px;
      height: 100vh;
      width: 100vw;
      margin: 0;
      padding: 8px;
      overflow: hidden;
    }
    body.split > .window { flex: 0 0 560px; width: 560px; max-width: 560px; overflow: auto; align-self: stretch; }
    body.split > #split-player { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
    body.split > #split-player iframe { flex: 1 1 auto; width: 100%; border: 2px solid #808080; background: #000; }
    body.split > #split-player .split-bar { background: #c0c0c0; padding: 4px 8px; font: 12px 'DOS','Fixedsys',monospace; border: 2px solid #fff; border-bottom: none; }
  </style>
`;

const SPLIT_PLAYER_PANE = `  <!-- Split layout: calcite player iframe pane. Populated by build.js
       after a cabinet is built. -->
  <div id="split-player">
    <div class="split-bar">
      <span>calcite player</span>
      <button id="split-reload" class="btn" style="float:right; font-size:11px;">Reload</button>
    </div>
    <iframe id="split-frame" src="about:blank" title="calcite player"></iframe>
  </div>
`;

function mustReplace(s, from, to, label) {
  if (!s.includes(from)) {
    throw new Error(`split-regen: anchor missing: ${label}`);
  }
  return s.split(from).join(to);
}

function regen() {
  const src = readFileSync(buildPath, 'utf8');

  let out = mustReplace(
    src,
    '<title>CSS-DOS · build</title>',
    '<title>CSS-DOS · split</title>',
    '<title>',
  );

  // Inject split layout <style> right before </head>.
  out = mustReplace(
    out,
    '</head>',
    SPLIT_STYLE + '</head>',
    '</head>',
  );

  // Replace the harmless stub split-player block (present in build.html
  // only so build.js doesn't blow up when it queries #split-frame) with
  // the real iframe pane.
  const STUB_RE = /\n  <!-- build\.js references[\s\S]*?<\/div>\n/;
  if (!STUB_RE.test(out)) {
    throw new Error('split-regen: anchor missing: stub #split-player block');
  }
  out = out.replace(STUB_RE, '\n' + SPLIT_PLAYER_PANE);

  // Enable split mode at boot. Swap the whole inline boot <script>.
  const INLINE_SCRIPT_RE = /<script>\s*\n\s*if \('serviceWorker' in navigator\) \{\s*\n\s*navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\);\s*\n\s*\}\s*\n\s*\/\/ No split — just the builder\.\s*\n\s*<\/script>/;
  if (!INLINE_SCRIPT_RE.test(out)) {
    throw new Error('split-regen: anchor missing: inline boot <script> block');
  }
  out = out.replace(
    INLINE_SCRIPT_RE,
    `<script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' });
    }
    document.body.classList.add('split');
  </script>`,
  );

  // Autogen banner just after <!DOCTYPE html>.
  out = out.replace(
    '<!DOCTYPE html>',
    '<!DOCTYPE html>\n<!-- AUTOGEN from build.html by web/scripts/split-regen.mjs. Do not edit. -->',
  );

  writeFileSync(splitPath, out);
  console.log(`split-regen: wrote ${splitPath} (${out.length} bytes)`);
}

regen();

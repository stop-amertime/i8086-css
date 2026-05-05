// Playwright probe for the :active → custom-property propagation test.
//
// Loads active-input.html, verifies the readout reads 0 at rest, holds each
// key in turn via mouse-down/mouse-up, asserts the aggregated --keyboard
// computed-style value matches the expected scancode while held and reverts
// to 0 on release. Pure no-JS-on-page assertion: only Playwright's mouse
// events drive the buttons.
//
// Run: node web/player/experiments/active-input-probe.mjs
//
// Exits 0 on pass, non-zero with a printed failure summary otherwise.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const fallback =
    process.platform === 'win32'
      ? 'C:/Users/AdmT9N0CX01V65438A/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright'
      : null;
  if (!fallback) {
    console.error('playwright not found and no fallback configured');
    process.exit(2);
  }
  ({ chromium } = require(fallback));
}

const HEADED = process.argv.includes('--headed');
const launchOpts = { headless: !HEADED };
const sysChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
try {
  const fs = require('node:fs');
  if (fs.existsSync(sysChrome)) launchOpts.executablePath = sysChrome;
} catch {}

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(here, 'active-input.html').replace(/\\/g, '/');

const KEYS = [
  { selector: '.kb-1c0d', label: 'Enter', expected: 7181 },
  { selector: '.kb-1e61', label: 'A',     expected: 7777 },
  { selector: '.kb-3062', label: 'B',     expected: 12386 },
];

function fmt(v) { return v === null || v === undefined ? 'null' : String(v); }

const browser = await chromium.launch(launchOpts);
let exitCode = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    process.stderr.write(`[page:${msg.type()}] ${msg.text()}\n`);
  });
  page.on('pageerror', (err) => {
    process.stderr.write(`[pageerror] ${err.message}\n`);
  });
  await page.goto(pageUrl);

  // Read computed-style custom property value as a number. @property registers
  // it as <integer> so getComputedStyle returns a numeric string.
  async function readProp(name) {
    return await page.evaluate((n) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      return v === '' ? null : Number(v);
    }, name);
  }

  // Sanity: at rest, every property should be 0.
  const restChecks = [
    ['--keyboard', 0],
    ['--kb_1c0d',  0],
    ['--kb_1e61',  0],
    ['--kb_3062',  0],
  ];
  for (const [name, want] of restChecks) {
    const got = await readProp(name);
    if (got !== want) {
      console.error(`FAIL rest: ${name} = ${fmt(got)}, expected ${want}`);
      exitCode = 1;
    } else {
      console.log(`OK   rest: ${name} = ${got}`);
    }
  }

  // Hold each key, verify --keyboard matches expected, then release and
  // verify it reverts to 0.
  for (const k of KEYS) {
    const handle = await page.locator(k.selector).first();
    const box = await handle.boundingBox();
    if (!box) {
      console.error(`FAIL ${k.label}: bounding box missing for ${k.selector}`);
      exitCode = 1;
      continue;
    }
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Give Chrome a frame to update :active and reflow the @property values.
    await page.waitForTimeout(50);

    const heldKbd = await readProp('--keyboard');
    const heldRaw = await readProp(`--kb_${k.selector.replace('.kb-', '')}`);
    const holdOk = heldKbd === k.expected && heldRaw === k.expected;
    console.log(
      `${holdOk ? 'OK  ' : 'FAIL'} hold ${k.label}: --keyboard=${fmt(heldKbd)} ` +
      `--kb_${k.selector.replace('.kb-', '')}=${fmt(heldRaw)} expected=${k.expected}`
    );
    if (!holdOk) exitCode = 1;

    await page.mouse.up();
    await page.waitForTimeout(50);

    const releasedKbd = await readProp('--keyboard');
    const releaseOk = releasedKbd === 0;
    console.log(`${releaseOk ? 'OK  ' : 'FAIL'} release ${k.label}: --keyboard=${fmt(releasedKbd)} expected=0`);
    if (!releaseOk) exitCode = 1;
  }

  // Cross-key isolation: while holding A, --kb_1c0d / --kb_3062 must be 0.
  {
    const a = page.locator('.kb-1e61').first();
    const box = await a.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(50);
    const enter = await readProp('--kb_1c0d');
    const b     = await readProp('--kb_3062');
    const ok = enter === 0 && b === 0;
    console.log(`${ok ? 'OK  ' : 'FAIL'} isolation while A held: --kb_1c0d=${fmt(enter)} --kb_3062=${fmt(b)} (both expect 0)`);
    if (!ok) exitCode = 1;
    await page.mouse.up();
  }
} finally {
  await browser.close();
}

process.exit(exitCode);

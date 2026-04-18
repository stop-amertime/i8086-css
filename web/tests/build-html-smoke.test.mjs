import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, '..', 'site');

test('build.html has required structural elements', () => {
  const html = readFileSync(resolve(siteRoot, 'build.html'), 'utf8');
  // Upload section
  assert.match(html, /<input[^>]+type=["']file["'][^>]+id=["']com-file["']/);
  assert.match(html, /<select[^>]+id=["']preset["']/);
  assert.match(html, /<button[^>]+id=["']start["']/);
  // Progress section
  assert.match(html, /id=["']progress["']/);
  assert.match(html, /id=["']stages["']/);
  // Result section
  assert.match(html, /id=["']result["']/);
  assert.match(html, /id=["']play-link["']/);
  assert.match(html, /id=["']download["']/);
  // Source viewer
  assert.match(html, /id=["']source-viewer["']/);
  assert.match(html, /id=["']page-prev["']/);
  assert.match(html, /id=["']page-next["']/);
  assert.match(html, /id=["']page-jump["']/);
  assert.match(html, /id=["']source-pre["']/);
  // Service worker registered
  assert.match(html, /serviceWorker\.register/);
  // Module import of build.js
  assert.match(html, /<script[^>]+type=["']module["'][^>]+src=["'][^"']*build\.js/);
});

test('build.js uses expected imports and PAGE_SIZE', () => {
  const js = readFileSync(resolve(siteRoot, 'assets', 'build.js'), 'utf8');
  assert.match(js, /import\s*\{\s*buildCabinetInBrowser\s*\}\s*from\s*['"][^'"]+main\.mjs['"]/);
  assert.match(js, /import\s*\{\s*saveCabinet\s*\}\s*from\s*['"][^'"]+storage\.mjs['"]/);
  assert.match(js, /PAGE_SIZE\s*=\s*50\s*\*\s*1024/);
  assert.match(js, /blob\.slice\(/);
  assert.match(js, /URL\.createObjectURL/);
});

test('site.css has the fundamental button/panel classes', () => {
  const css = readFileSync(resolve(siteRoot, 'assets', 'site.css'), 'utf8');
  // DOS-beige palette somewhere
  assert.match(css, /#c0c0c0/i);
});

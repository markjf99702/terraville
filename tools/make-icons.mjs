// Renders the PNG app icons from the SVGs:  node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const rounded = await readFile(join(root, 'icon.svg'), 'utf8');
const square = await readFile(join(root, 'tools/icon-full-bleed.svg'), 'utf8');
const out = [
  ['icon-192.png', 192, rounded, true],
  ['icon-512.png', 512, rounded, true],
  ['icon-512-maskable.png', 512, square, false],
  ['icon-180.png', 180, square, false], // iOS rounds the corners itself
];

const browser = await pw.chromium.launch();
const page = await browser.newPage();
for (const [name, size, svg, clear] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: join(root, name), omitBackground: clear });
}
await browser.close();
console.log('icons written');

// Renders the README screenshots (docs/phone-*.png) and the link preview (og.png):  node tools/screenshots.mjs
// Plays the built index.html, so run npm run build first. Math.random is seeded and the map holds still (less motion),
// so the land and the cities come out the same each time; only the cars and the water's shimmer differ. Each picture is
// saved with a palette, which keeps og.png near 150 KB (with 256 colours the map's fine detail makes it nearly twice that).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const UPNG = require('upng-js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const SEED = 4;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const browser = await pw.chromium.launch();
await mkdir(join(root, 'docs'), { recursive: true });

async function open(opts) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript((seed) => {
    let a = seed; // mulberry32
    Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    // Frames draw on random numbers too, as many as the machine has time for: seed again just before a picture's land.
    window.__seed = (s) => { a = s; };
  }, SEED);
  await page.goto(base);
  await page.waitForFunction(() => !!window.__terraville && !document.querySelector('#title').hidden);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** A challenge city, opened and paused, with its opening dialog closed. */
async function challenge(page, id) {
  await page.evaluate((id) => {
    const g = window.__terraville;
    g.startScenario(id);
    g.ui.closeModal();
    g.setSpeed(0);
  }, id);
}

/** Save a screenshot with a palette of `colours`: the map's fine detail makes a full-colour PNG several times bigger. */
async function save(page, file, colours) {
  await page.waitForTimeout(800); // let the map sharpen
  const img = UPNG.decode(await page.screenshot());
  await writeFile(join(root, file), Buffer.from(UPNG.encode([UPNG.toRGBA8(img)[0]], img.width, img.height, colours)));
  if (process.env.COLOURS) for (const c of process.env.COLOURS.split(',')) await writeFile(join(process.env.TRY_DIR, `${file.replace(/\W/g, '_')}-${c}.png`), Buffer.from(UPNG.encode([UPNG.toRGBA8(img)[0]], img.width, img.height, +c)));
}

// Phone screenshots for the README: the title screen, a challenge city, and the terrain editor.
{
  const page = await open(PHONE);
  await page.evaluate((s) => {
    window.__seed(s);
    window.__terraville.showTitle();
  }, SEED);
  await save(page, 'docs/phone-title.png', 128);
  await challenge(page, 'gridlock');
  await save(page, 'docs/phone-city.png', 128);
  await page.goto(base);
  await page.waitForFunction(() => !document.querySelector('#title').hidden);
  await page.click('[data-act="editor"]');
  await page.waitForFunction(() => window.__terraville.mode === 'editor');
  // A coastline from a fixed seed, the Raise brush picked, the sliders open, and the opening tip gone.
  await page.evaluate(() => {
    const g = window.__terraville;
    g.ui.regen({ seed: 'reef-summit-97', style: 'coast' });
    g.ui.flushRegen();
    g.ui.syncEditorPanel();
    g.clearUndo();
    g.ui.syncUndo();
    g.ui.hideToast();
    g.setTool('raise');
    document.querySelector('#edHead').click();
    g.renderer.cam.zoom = 8;
    g.renderer.centerOn(g.world.w * 0.5, g.world.h * 0.6);
  });
  await save(page, 'docs/phone-editor.png', 128);
  await page.context().close();
}

// Link preview, 1200 x 630: Gridlock from above with the sign and a line over the dark side, as the title screen has them.
{
  const page = await open({ viewport: { width: 1200, height: 630 } });
  await challenge(page, 'gridlock');
  await page.evaluate(() => {
    const g = window.__terraville;
    for (const el of document.querySelectorAll('#map ~ *')) el.style.visibility = 'hidden';
    // The city fills the height, its middle a quarter of the way in from the left.
    const r = g.renderer;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of g.world.buildings.values()) {
      [x0, y0, x1, y1] = [Math.min(x0, b.x), Math.min(y0, b.y), Math.max(x1, b.x + b.size), Math.max(y1, b.y + b.size)];
    }
    r.cam.zoom = 630 / (y1 - y0 + 1);
    r.cam.x = (x0 + x1) / 2 + (600 - 330) / r.cam.zoom;
    r.cam.y = (y0 + y1) / 2;
    r.clampCamera({ l: 0, t: 0, r: 0, b: 0 }); // no margin past the map's edge
    const card = document.createElement('div');
    card.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:26px;padding:0 50px 0 712px;'
      + 'background:linear-gradient(90deg, rgba(8,12,10,0) 0%, rgba(8,12,10,0) 48%, rgba(8,12,10,0.62) 62%, rgba(8,12,10,0.84) 100%);visibility:visible';
    card.innerHTML = `<div class="bigsign" style="align-self:flex-start"><div class="name" style="font-size:58px">TERRAVILLE</div><div class="est">Est. 1900</div></div>
      <div style="font:700 27px/1.3 var(--font);color:#f2f5f3;max-width:380px">Shape a landscape, then grow a city on it.</div>
      <div style="font:400 17px/1.5 var(--font);color:#cfd9d2;max-width:440px;margin-top:-10px">A city builder in the spirit of the 1989 classic, with a terrain editor, challenges and disasters.</div>`;
    document.querySelector('#map').parentElement.appendChild(card);
  });
  await save(page, 'og.png', 64);
  await page.context().close();
}

await browser.close();
server.close();
console.log('screenshots written');

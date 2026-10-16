// Plays the built game (index.html) in Chromium:  node test/e2e.mjs  (needs Playwright; npm test runs it after the
// unit checks). Rebuild with npm run build first if you changed src/.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
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
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok  ', name);
  } catch (e) {
    console.log('FAIL', name);
    throw e;
  }
}

const browser = await pw.chromium.launch();

/** A fresh browser profile. The fonts come from Google; the checks don't need them. */
async function profile(opts = PHONE) {
  const ctx = await browser.newContext(opts);
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return ctx;
}

/** Open the game in `ctx` and wait for the title screen. */
async function open(ctx) {
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url()) && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(r.url())) problems.push('left the site: ' + r.url()); });
  await page.goto(base);
  await titleUp(page);
  return { page, problems };
}

const titleUp = (page) => page.waitForFunction(() => !!window.__terraville && !document.querySelector('#title').hidden, null, { timeout: 30000 });

/** Found a city on random land, with the clock stopped. */
async function found(page) {
  await page.click('[data-act="quick"]');
  await page.click('.modal footer .btn.primary');
  await page.waitForFunction(() => window.__terraville.mode === 'city');
  await page.evaluate(() => window.__terraville.setSpeed(0));
}

/** The page's current save as a city code, after `change` (a function's source) has edited it. */
function codeOf(page, change) {
  return page.evaluate((src) => {
    const file = window.__terraville.makeSaveFile();
    (0, eval)(src)(file);
    let bin = '';
    for (const b of new TextEncoder().encode(JSON.stringify(file))) bin += String.fromCharCode(b);
    return 'TV1j:' + btoa(bin);
  }, change);
}

/** Open a city code the way a person would: Open a saved city, paste, Open code. */
async function openCode(page, code) {
  await page.click('[data-act="open"]');
  await page.fill('#fPaste', code);
  await page.click('#fOpen');
}

try {
  await test('a shared city code is shown, never run', async () => {
    // Someone makes codes with markup where the city's name, tax rate, disasters switch and terrain settings go...
    const maker = await profile();
    const { page: a } = await open(maker);
    await a.click('[data-act="editor"]');
    await a.waitForFunction(() => window.__terraville.mode === 'editor');
    const terrainCode = await codeOf(a, `(f) => { f.terrain.water = '<img src=x onerror="document.title=1">'; }`);
    await a.goto(base);
    await titleUp(a);
    await found(a);
    const cityCode = await codeOf(a, `(f) => {
      const ran = ' onerror="document.title=1">';
      f.world.city.name = 'Harbour <img src=x' + ran;
      f.world.city.tax = '7"><img src=x' + ran;
      f.world.city.disasters = '"><img src=x' + ran;
    }`);
    await maker.close();

    // ...and someone else opens them. The game has no images, so an <img> means the code's markup became HTML.
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    const images = () => page.evaluate(() => document.querySelectorAll('img').length);
    await openCode(page, cityCode);
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(() => window.__terraville.setSpeed(0));
    assert.equal(await page.textContent('#signName'), 'Harbour <img src=x onerror="document.title=1">');

    await page.click('#topbar [data-act="charts"]');
    assert.match(await page.textContent('.modal .sub'), /^Harbour <img src=x onerror/);
    assert.equal(await images(), 0, 'the name became HTML in History');
    await page.keyboard.press('Escape');

    await page.click('#topbar [data-act="budget"]');
    assert.equal(await page.inputValue('#bTax'), '7');
    assert.match(await page.textContent('#bTaxNote'), /^At 7%, taxes bring in/);
    assert.equal(await images(), 0, 'the tax rate became HTML in Budget');
    await page.keyboard.press('Escape');

    await page.click('#topbar [data-act="disasters"]');
    assert.equal(await page.getAttribute('[role="menu"] [role="menuitemcheckbox"]', 'aria-pressed'), 'true');
    assert.equal(await images(), 0, 'the disasters switch became HTML in the Disasters menu');
    await page.keyboard.press('Escape');

    assert.equal(await page.evaluate(() => window.__terraville.saveCity()), true);
    await page.goto(base);
    await titleUp(page);
    assert.match(await page.textContent('[data-act="continue"]'), /^Continue Harbour <img src=x onerror/);
    await openCode(page, terrainCode);
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.match(await page.inputValue('#edWater'), /^\d+$/);
    assert.equal(await images(), 0, 'a terrain setting became HTML in the editor');

    await page.waitForTimeout(500); // long enough for a broken image to have reported its error
    assert.equal(await page.title(), 'Terraville', 'script from the code ran');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a damaged list of saves still opens on the title screen, with Continue', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    assert.equal(await page.evaluate(() => window.__terraville.saveCity()), true);
    const name = await page.evaluate(() => window.__terraville.world.city.name);
    const real = await page.evaluate(() => JSON.parse(localStorage.getItem('terraville.slots'))[0]);
    for (const list of [[null], [null, real], [real, null]]) {
      await page.evaluate((v) => localStorage.setItem('terraville.slots', JSON.stringify(v)), list);
      await page.goto(base);
      await titleUp(page);
      if (list.length > 1) assert.equal(await page.textContent('[data-act="continue"] span'), `Continue ${name}`);
    }
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a city is kept when the page reloads or closes before its next autosave', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    // A brand-new city, never autosaved, reloaded at once.
    await found(page);
    const name = await page.evaluate(() => window.__terraville.world.city.name);
    await page.reload();
    await titleUp(page);
    assert.equal(await page.textContent('[data-act="continue"] span'), `Continue ${name}`);
    // Play on, then close the tab: what changed since the last save comes back too.
    await page.click('[data-act="continue"]');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(0);
      Object.assign(g.world.city, { funds: 12345, tax: 11 });
    });
    await page.close();
    const { page: again, problems: later } = await open(ctx);
    await again.click('[data-act="continue"]');
    await again.waitForFunction(() => window.__terraville.mode === 'city');
    assert.deepEqual(await again.evaluate(() => [window.__terraville.world.city.funds, window.__terraville.world.city.tax]), [12345, 11]);
    assert.deepEqual([...problems, ...later], []);
    await ctx.close();
  });

  await test('a city in debt can still bulldoze, though it cannot build', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const after = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const free = (i) => !w.water[i] && !w.occ[i] && !w.net[i] && !w.rubble[i];
      const wooded = w.trees.findIndex((t, i) => t > 0 && free(i));
      const bare = w.trees.findIndex((t, i) => t === 0 && free(i));
      const use = (tool, i) => {
        const x = (i % w.w) + 0.5;
        const y = Math.floor(i / w.w) + 0.5;
        g.setTool(tool);
        g.pointerDown(x, y, 10, 10);
        g.pointerUp(x, y, 10, 10);
      };
      w.city.funds = -1000;
      use('road', bare);
      const refused = document.querySelector('#toast').textContent;
      use('bulldoze', wooded);
      return { road: w.net[bare], trees: w.trees[wooded], funds: w.city.funds, refused };
    });
    assert.deepEqual(after, {
      road: 0, trees: 0, funds: -1001, refused: 'Not enough money. That costs $10 and the city is $1,000 in debt.',
    });
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('says what it needs with JavaScript off', async () => {
    const ctx = await profile({ ...PHONE, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(base);
    assert.equal(await page.innerText('body'), 'Terraville needs JavaScript to draw the map and run the city.');
    await ctx.close();
  });

  await test('fits a phone and works offline once opened', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the title screen scrolls sideways on a phone');
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 30000 });
    await ctx.setOffline(true);
    await page.reload();
    await titleUp(page);
    await ctx.setOffline(false);
    assert.deepEqual(problems, []);
    await ctx.close();
  });
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${passed} passed`);

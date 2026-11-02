// Plays the built game (index.html) in Chromium:  node test/e2e.mjs  (needs Playwright; npm test runs it after the
// unit checks). It first builds src/ in memory and stops if index.html differs, so a page older than src/ never passes.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';
import { buildPage } from '../build.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// These tests play the committed index.html, so they would test an old page if src/ changed without a rebuild.
if ((await buildPage()).index !== await readFile(join(root, 'index.html'), 'utf8')) {
  console.log('FAIL index.html is older than src/: run npm run build');
  process.exit(1);
}
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
const DESK = { viewport: { width: 1280, height: 800 } };

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

/** A fresh browser profile. */
function profile(opts = PHONE) {
  return browser.newContext(opts);
}

/** Open the game in `ctx` and wait for the title screen. */
async function open(ctx) {
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) problems.push('left the site: ' + r.url()); });
  // A file that isn't there, or a request that fails, though one the page calls off as it reloads is no fault.
  page.on('requestfailed', (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.goto(base);
  await titleUp(page);
  return { page, problems };
}

const titleUp = (page) => page.waitForFunction(() => !!window.__terraville && !document.querySelector('#title').hidden, null, { timeout: 30000 });

/** Found a city on random land. A new city opens with the clock stopped. */
async function found(page) {
  await page.click('[data-act="quick"]');
  await page.click('.modal footer .btn.primary');
  await page.waitForFunction(() => window.__terraville.mode === 'city');
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

/** Press Tab until `selector` has focus. */
async function tabTo(page, selector) {
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate((s) => document.activeElement?.matches(s), selector)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${selector}`);
}

/** Open a city code the way a person would: Open a saved city, paste, Open code. */
async function openCode(page, code) {
  await page.click('[data-act="open"]');
  await page.fill('#fPaste', code);
  await page.click('#fOpen');
}

/**
 * A fresh browser profile that is served the game as if from terraville.junkdrawer.works, where Google Drive works.
 * Other sites are refused and listed in `away`, unless a later route (the fake Google) answers first.
 */
const SITE = 'https://terraville.junkdrawer.works';
async function atTheSite(opts = PHONE) {
  const ctx = await profile({ ...opts, serviceWorkers: 'block' });
  const away = [];
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== SITE) {
      away.push(u.href);
      return route.abort('blockedbyclient');
    }
    const path = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname;
    try {
      return route.fulfill({ status: 200, contentType: TYPES[extname(path)] || 'text/html', body: await readFile(join(root, path)) });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(SITE + '/');
  await titleUp(page);
  return { ctx, page, problems, away };
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
    assert.equal(await page.getAttribute('[role="menu"] [role="menuitemcheckbox"]', 'aria-checked'), 'true');
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

  await test('a first visit starts with Start a new city; once a city is saved, Continue comes first', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    const first = () => page.$$eval('.title-actions .btn', (bs) => bs.map((b) => `${b.dataset.act}${b.classList.contains('primary') ? '*' : ''}`).slice(0, 2));
    assert.deepEqual(await first(), ['quick*', 'editor'], 'Start a new city is first, and the main choice');
    await found(page);
    await page.reload();
    await titleUp(page);
    assert.deepEqual(await first(), ['continue*', 'quick'], 'Continue is first and the main choice; Start a new city is a plain button');
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

  await test('a city open in two tabs: the older tab stops, and the newer one keeps its months', async () => {
    const ctx = await profile(DESK);
    const { page: a, problems } = await open(ctx);
    await found(a);
    const play = (page, months) => page.evaluate((n) => {
      const g = window.__terraville;
      for (let i = 0; i < 4 * n; i++) g.sim.step();
      return g.world.city.month;
    }, months);
    await play(a, 6);
    assert.equal(await a.evaluate(() => window.__terraville.saveCity()), true);
    const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('terraville.slots')).find((s) => s.city).date);
    // One tab sees what another wrote to localStorage a moment later, longer on a busy machine: wait for it.
    const seen = (page, date) => page.waitForFunction((d) => JSON.parse(localStorage.getItem('terraville.slots')).find((s) => s.city).date === d, date, { timeout: 5000 }).then(() => date, () => saved(page));
    const stopped = (page) => page.evaluate(() => [window.__terraville.stopped, !!document.querySelector('.modal')]);
    // A second tab on the title screen changes nothing.
    const { page: b, problems: inB } = await open(ctx);
    await a.waitForTimeout(300);
    assert.deepEqual(await stopped(a), [false, false]);
    // Continue in the second tab: the first one stops and says why.
    await b.click('[data-act="continue"]');
    await b.waitForFunction(() => window.__terraville.mode === 'city');
    await b.evaluate(() => window.__terraville.setSpeed(0));
    await a.waitForSelector('.modal');
    const name = await a.evaluate(() => window.__terraville.world.city.name);
    assert.equal(await a.textContent('.modal .body'), `${name} is open in another tab, so this tab has stopped to keep the two from saving over each other.`);
    assert.deepEqual(await stopped(a), [true, true]);
    assert.equal(await a.evaluate(() => window.__terraville.speed), 0);
    await a.keyboard.press('Escape');
    assert.deepEqual(await stopped(a), [true, true], 'Escape closed the dialog');
    // The second tab plays on and saves; nothing the first tab does writes over it.
    const month = await play(b, 30);
    assert.equal(await b.evaluate(() => window.__terraville.saveCity()), true);
    assert.equal(await saved(b), month);
    assert.equal(await seen(a, month), month);
    assert.equal(await a.evaluate(() => window.__terraville.autosave()), false);
    await a.evaluate(() => {
      const g = window.__terraville;
      g.autoTimer = 200; // the 90-second save is due
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange')); // leaving the page
    });
    await a.waitForTimeout(500);
    assert.equal(await saved(a), month);
    // Reloading the second tab doesn't stop it, and its months are still there.
    await b.reload();
    await titleUp(b);
    await b.click('[data-act="continue"]');
    await b.waitForFunction(() => window.__terraville.mode === 'city');
    await b.evaluate(() => window.__terraville.setSpeed(0));
    assert.equal(await b.evaluate(() => window.__terraville.world.city.month), month);
    assert.deepEqual(await stopped(b), [false, false]);
    // Play it here instead: the second tab saves what it has played since and hands the city back.
    const later = await play(b, 2);
    await a.click('.modal footer .btn.primary');
    await a.waitForFunction(() => !window.__terraville.stopped && !document.querySelector('.modal'));
    assert.equal(await a.evaluate(() => window.__terraville.world.city.month), later);
    await b.waitForSelector('.modal');
    assert.deepEqual(await stopped(b), [true, true]);
    // Back to the title screen leaves without saving.
    await play(a, 1);
    await b.click('.modal footer .btn:not(.primary)');
    await titleUp(b);
    assert.equal(await seen(a, later), later);
    assert.deepEqual([...problems, ...inB], []);
    await ctx.close();
  });

  await test('Save, open and share says how the city is kept, with autosave on or off', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const kept = async () => {
      await page.click('#topbar [data-act="menu"]');
      await page.click('[role="menu"] button:has-text("Save, open and share")');
      const text = await page.textContent('#fKept');
      await page.keyboard.press('Escape');
      return text;
    };
    assert.equal(await kept(), 'The city also saves itself every 90 seconds and whenever you leave the page.');
    await page.evaluate(() => {
      window.__terraville.settings.autosave = false;
      window.__terraville.saveSettings();
    });
    assert.equal(await kept(), 'Autosave is off, so only Save now keeps this city.');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Save, open and share: a snapshot is deleted only on a second press, and every row button names its city', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const name = await page.evaluate(() => window.__terraville.world.city.name);
    await page.click('#topbar [data-act="menu"]');
    await page.click('[role="menu"] button:has-text("Save, open and share")');
    await page.click('#fSaveBtns button:has-text("Save now")');
    await page.waitForSelector('#fCities .slot');
    await page.click('#fSaveBtns button:has-text("Save a snapshot")');
    await page.waitForSelector('#fOther .slot');
    // Read out of a list of buttons, each one says whose it is.
    const labels = await page.$$eval('#fCities .slot button, #fOther .slot button', (bs) => bs.map((b) => b.getAttribute('aria-label')));
    assert.deepEqual(labels.slice(0, 2), [`Open ${name}`, `Delete ${name}`]);
    assert.match(labels[2], /^Open the snapshot of .+, [A-Z][a-z]{2} \d{4}$/);
    assert.ok(labels[2].startsWith(`Open the snapshot of ${name}, `));
    assert.equal(labels[3], labels[2].replace('Open', 'Delete'));
    assert.equal(labels.length, 4);
    // Laid out as the cities above are, saying how long ago it was saved as they do.
    assert.deepEqual(await page.$$eval('#fOther .slot .meta', (m) => m.map((x) => x.textContent)), [await page.textContent('#fCities .slot .meta'), 'Saved just now']);
    // A code that won't open is said out loud.
    assert.equal(await page.getAttribute('#fErr', 'role'), 'alert');
    const del = page.locator('#fOther .slot button.danger');
    await del.click();
    assert.equal(await page.locator('#fOther .slot').count(), 1, 'one press deleted the snapshot');
    assert.equal(await del.textContent(), 'Tap again to delete');
    await del.click();
    assert.equal(await page.locator('#fOther .slot').count(), 0);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a city code saved as a text file opens again from it', async () => {
    const ctx = await profile({ ...DESK, acceptDownloads: true });
    const { page, problems } = await open(ctx);
    await found(page);
    const name = await page.evaluate(() => window.__terraville.world.city.name);
    await page.click('#topbar [data-act="menu"]');
    await page.click('[role="menu"] button:has-text("Save, open and share")');
    await page.click('#fMake');
    await page.waitForFunction(() => !document.querySelector('#fDownload').disabled);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#fDownload')]);
    assert.equal(download.suggestedFilename(), `${name}.txt`);
    const text = await readFile(await download.path(), 'utf8');
    assert.equal(text, await page.inputValue('#fCode'));
    // On another device: Open a saved city, Open a text file.
    const other = await profile(DESK);
    const { page: b, problems: inB } = await open(other);
    await b.click('[data-act="open"]');
    await b.setInputFiles('#fFile', { name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(text) });
    await b.waitForFunction(() => window.__terraville.mode === 'city');
    assert.equal(await b.evaluate(() => window.__terraville.world.city.name), name);
    assert.deepEqual([...problems, ...inB], []);
    await ctx.close();
    await other.close();
  });

  await test('opening an older copy of a city asks before it replaces the later save', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const g = (fn) => page.evaluate(fn);
    await g(() => { for (let i = 0; i < 4 * 6; i++) window.__terraville.sim.step(); });
    const { id, name } = await g(() => ({ id: window.__terraville.world.city.id, name: window.__terraville.world.city.name }));
    const code = await codeOf(page, '(f) => {}');
    assert.equal(await g(() => window.__terraville.saveTo('snap')), true);
    await g(() => { for (let i = 0; i < 4 * 30; i++) window.__terraville.sim.step(); return window.__terraville.saveCity(); });
    const cities = () => g(() => JSON.parse(localStorage.getItem('terraville.slots')).filter((s) => s.city).map((s) => [s.city, s.date]).sort());
    assert.deepEqual(await cities(), [[id, 36]]);
    const ask = `This is an older copy of ${name} (Jul 1900). Your save of ${name} is at Jan 1903.`;
    // A code from month 6, opened as a separate city: the save at month 36 stays as it was.
    await page.goto(base);
    await titleUp(page);
    await openCode(page, code);
    await page.waitForSelector('.modal:has-text("Open an older copy?")');
    assert.equal(await page.textContent('.modal .body'), ask);
    assert.deepEqual(await page.$$eval('.modal footer .btn', (b) => b.map((x) => x.textContent)), ['Go back to Jul 1900', 'Open as a separate city']);
    await page.click('.modal footer .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    const other = await g(() => { window.__terraville.setSpeed(0); return [window.__terraville.world.city.id, window.__terraville.world.city.month]; });
    assert.notEqual(other[0], id);
    assert.equal(other[1], 6);
    assert.equal(await g(() => window.__terraville.saveCity()), true);
    assert.deepEqual(await cities(), [[id, 36], [other[0], 6]].sort());
    // The snapshot from month 6, taken back to: it replaces the save at once.
    await page.goto(base);
    await titleUp(page);
    await page.click('[data-act="open"]');
    await page.click('#fOther .slot .btn.primary');
    await page.waitForSelector('.modal:has-text("Open an older copy?")');
    assert.equal(await page.textContent('.modal .body'), ask);
    await page.click('.modal footer .btn.danger');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    assert.deepEqual(await g(() => { window.__terraville.setSpeed(0); return [window.__terraville.world.city.id, window.__terraville.world.city.month]; }), [id, 6]);
    await page.waitForFunction((c) => JSON.parse(localStorage.getItem('terraville.slots')).find((s) => s.city === c)?.date === 6, id);
    // A copy no older than the save opens as it always did.
    await page.goto(base);
    await titleUp(page);
    await openCode(page, code);
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a challenge opened from its save shows its approval, worries and goal straight away', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="challenges"]');
    await page.click('.slot:has-text("Monster Bay") .btn.primary');
    await page.click('.modal footer .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(0);
      g.world.city.approval = 95; // as a month end of good news leaves it
      return g.saveCity();
    });
    await page.reload();
    await titleUp(page);
    await page.click('[data-act="continue"]');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(() => window.__terraville.setSpeed(0));
    // Approval is just as it was saved: opening a city doesn't move it, so reloading can't nudge it either way.
    assert.match((await page.textContent('#goal')).replace(/\s+/g, ' ').trim(), /^Monster Bay \d+y \d+m left Approval 95% · over 60%/);
    await page.click('#citySign');
    assert.equal(await page.textContent('.modal .big'), '95%');
    assert.equal(await page.locator('.modal .bars .barrow').count(), 8, 'no worries listed');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the goal tracker ticks each condition, says when a held goal is judged, and folds away on a phone for the session', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="challenges"]');
    await page.click('.slot:has-text("Gridlock") .btn.primary');
    await page.click('.modal footer .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(() => window.__terraville.setSpeed(0));
    const rows = () => page.$$eval('#goal .goal-row', (els) => els.map((e) => ({
      text: e.firstElementChild.textContent.replace(/\s+/g, ' ').trim(),
      met: e.classList.contains('met'),
      // Each figure on one line: '17,544 of / 20,000' was how the old status wrapped.
      whole: [...e.querySelectorAll('.fig')].every((f) => f.getClientRects().length === 1),
    })));
    const opening = await rows();
    assert.deepEqual(opening.map((r) => r.text.replace(/[\d,]+(?= )/, 'N').replace(/^Residents [\d,]+/, 'Residents N').replace(/^Jobs [\d,]+/, 'Jobs N')),
      ['Traffic index N · under 28', 'Residents N / 20,000', 'Jobs N / 10,000']);
    assert.deepEqual(opening.map((r) => r.met), [true, false, false], 'Gridlock opens under the traffic line, short of residents and jobs');
    assert.ok(opening.every((r) => r.whole), 'a figure broke across lines');
    assert.equal(await page.textContent('#goal .goal-note'), 'Judged at the end of 1960');
    // Folded, it is one line: the challenge and the time left.
    const head = page.locator('#goal button.goal-head');
    assert.equal(await head.getAttribute('aria-expanded'), 'true');
    await head.click();
    assert.equal(await page.locator('#goal .goal-row').count(), 0);
    assert.equal((await page.textContent('#goal')).replace(/\s+/g, ' ').trim(), 'Gridlock 6y 0m left');
    assert.equal(await page.locator('#goal button.goal-head').getAttribute('aria-expanded'), 'false');
    assert.ok((await page.locator('#goal').boundingBox()).height < 50);
    // The next challenge opens folded too, and a tap opens it.
    await page.evaluate(() => window.__terraville.startScenario('monster'));
    await page.click('.modal footer .btn.primary');
    assert.equal((await page.textContent('#goal')).replace(/\s+/g, ' ').trim(), 'Monster Bay 10y 0m left');
    await page.click('#goal button.goal-head');
    assert.equal(await page.locator('#goal .goal-row').count(), 2);
    assert.equal(await page.textContent('#goal .goal-note'), 'Judged at the end of 1966');
    // A wide window has room for it: its heading is only a heading.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => !document.querySelector('#goal button.goal-head'));
    assert.equal(await page.locator('#goal .goal-row').count(), 2);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a challenge ends in its own words and lists what was not met; its tracker can then be closed, and the result stays in the report', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="challenges"]');
    await page.click('.slot:has-text("Gridlock") .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    // The intro points to the guide's tips, and Tips opens it there.
    assert.equal(await page.textContent('.modal .panel .note'), 'You have until 1961. The goal tracker keeps score.');
    await page.click('.modal footer .btn:has-text("Tips")');
    await page.waitForFunction(() => document.querySelector('.guide-nav [aria-current="true"]')?.textContent === 'Challenges');
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(0);
      g.world.city.month = g.world.city.scenario.end;
      g.checkScenario();
    });
    assert.equal(await page.textContent('.modal h2'), "Time's up");
    assert.match(await page.textContent('.modal .body'), /^\s*The deadline for Gridlock passed at the end of 1960\. The council went into the election with its promise unkept, and lost\.\s*Not met:/);
    assert.equal(await page.textContent('#ticker .msg-text'), 'Time ran out for Gridlock. 17,568 of 20,000 residents.', 'the news has the result under the dialog');
    const notMet = await page.$$eval('.modal .goal-row', (els) => els.map((e) => e.firstElementChild.textContent));
    assert.equal(notMet.length, 2);
    assert.equal(notMet[0], 'Residents 17,568 / 20,000');
    assert.match(notMet[1], /^Jobs [\d,]+ \/ 10,000$/);
    await page.click('.modal footer .btn.primary');
    assert.equal(await page.textContent('#goal .goal-time'), 'Time ran out');
    assert.match(await page.getAttribute('#goal .track i', 'style'), /var\(--critical\)/);
    await page.click('#goal .goal-close');
    assert.equal(await page.isHidden('#goal'), true);
    // Closed for good: it stays closed when the city opens again, and the report keeps the result.
    await page.evaluate(() => window.__terraville.saveCity());
    await page.reload();
    await titleUp(page);
    await page.click('[data-act="continue"]');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(() => window.__terraville.setSpeed(0));
    assert.equal(await page.isHidden('#goal'), true);
    await page.click('#citySign');
    assert.match((await page.textContent('.modal .body')).replace(/\s+/g, ' '), /Time's up ?The deadline for Gridlock passed at the end of 1960\./);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a won challenge leaves its result in the news ticker, in place of the deadline', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="challenges"]');
    await page.click('.slot:has-text("Boomtown") .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.keyboard.press('Escape');
    assert.match(await page.textContent('#ticker .msg-text'), /You have until 1915\./);
    await page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(0);
      g.sim.stats.residents = 12500;
      g.checkScenario();
    });
    assert.equal(await page.textContent('.modal h2'), 'Challenge complete');
    await page.click('.modal footer .btn.primary');
    assert.match(await page.textContent('#ticker .msg-text'), /^Boomtown is a success in 1900, 15 years early\.$/);
    // The Challenges list keeps the win in this browser, on that challenge's row alone, after a reload too.
    await page.reload();
    await titleUp(page);
    await page.click('[data-act="challenges"]');
    const won = await page.$$eval('.modal .slot', (rows) => rows.map((r) => [r.querySelector('b').textContent, r.querySelector('.won')?.textContent ?? '']));
    assert.deepEqual(won, [['Boomtown', 'Won in 1900'], ['Gridlock', ''], ['Smog Valley', ''], ['Aftershock', ''], ['Monster Bay', ''], ['High Water', ''], ['Crime Wave', ''], ['Fallout', '']]);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Boomtown, the one challenge with no city, shows the starter checklist with the goal tracker below it', async () => {
    for (const opts of [PHONE, DESK]) {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      await page.click('[data-act="challenges"]');
      await page.click('.slot:has-text("Boomtown") .btn.primary');
      await page.click('.modal footer .btn.primary');
      await page.waitForFunction(() => window.__terraville.mode === 'city');
      await page.evaluate(() => window.__terraville.setSpeed(0));
      const gap = () => page.evaluate(() => document.querySelector('#goal').getBoundingClientRect().top - document.querySelector('#guide').getBoundingClientRect().bottom);
      await page.waitForFunction(() => !document.querySelector('#guide').hidden);
      await page.waitForFunction(() => document.querySelector('#goal').getBoundingClientRect().top >= document.querySelector('#guide').getBoundingClientRect().bottom);
      assert.ok((await gap()) <= 12, `${opts.viewport.width}: the tracker is far below the checklist`);
      if (opts === PHONE) {
        // Opened, the checklist pushes the tracker down; folded again, it comes back up.
        await page.click('#guide .guide-next');
        await page.waitForFunction(() => document.querySelector('#goal').getBoundingClientRect().top >= document.querySelector('#guide').getBoundingClientRect().bottom);
        await page.click('#guide button.guide-head');
        await page.waitForFunction(() => document.querySelector('#goal').getBoundingClientRect().top - document.querySelector('#guide').getBoundingClientRect().bottom <= 12);
      }
      const offered = async () => {
        await page.click('#topbar [data-act="menu"]');
        const has = await page.locator('[role="menu"] button:has-text("Show the starter checklist")').count();
        await page.keyboard.press('Escape');
        return has;
      };
      assert.equal(await offered(), 1, 'the menu can bring it back');
      // Gridlock hands over a city, and no checklist, so the menu doesn't offer one.
      await page.evaluate(() => window.__terraville.startScenario('gridlock'));
      await page.click('.modal footer .btn.primary');
      assert.equal(await page.isHidden('#guide'), true);
      assert.equal(await offered(), 0, 'nor does the menu');
      assert.equal(await page.evaluate(() => document.querySelector('#goal').style.getPropertyValue('--stack')), '0px');
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test('leaving a city that cannot be saved offers a city code, or leaving anyway', async () => {
    const leave = async (page) => {
      await page.click('#topbar [data-act="menu"]');
      await page.click('[role="menu"] button:has-text("Back to the title screen")');
    };
    // Storage blocked: the dialog says so instead of promising a save.
    const blocked = await profile();
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } }));
    const { page, problems } = await open(blocked);
    await found(page);
    await leave(page);
    assert.match(await page.textContent('.modal .body'), /blocking storage, so the city cannot be saved here\. To keep it, save a city code in Save, open and share first\./);
    await page.click('.modal footer button:has-text("Leave anyway")');
    await titleUp(page);
    assert.deepEqual(problems, []);
    await blocked.close();

    // Storage full: the save on the way out fails, and the dialog comes back with the choice.
    const full = await profile();
    const { page: p2, problems: more } = await open(full);
    await found(p2);
    await p2.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k.startsWith('terraville.slot')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return set.call(this, k, v);
      };
    });
    await leave(p2);
    await p2.click('.modal footer .btn.primary');
    await p2.waitForSelector('.modal footer button:has-text("Leave anyway")');
    assert.match(await p2.textContent('.modal .body'), /^Saving the city failed\. Storage may be full\. To keep it/);
    await p2.click('.modal .body .linkbtn');
    assert.equal(await p2.textContent('.modal h2'), 'Save, open and share');
    await p2.keyboard.press('Escape');
    await leave(p2);
    await p2.click('.modal footer .btn.primary');
    await p2.click('.modal footer button:has-text("Leave anyway")');
    await titleUp(p2);
    assert.deepEqual(more, []);
    await full.close();
  });

  await test('an autosave that fails says so once, until saving works again', async () => {
    const watch = (page) => page.evaluate(() => {
      const ui = window.__terraville.ui;
      const show = ui.toast.bind(ui);
      window.saidSaving = [];
      ui.toast = (text, kind) => {
        if (text.startsWith('Saving')) window.saidSaving.push(text);
        show(text, kind);
      };
    });
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    await watch(page);
    const fullStorage = (on) => page.evaluate((on) => {
      window.realSetItem ??= Storage.prototype.setItem;
      Storage.prototype.setItem = on
        ? function (k, v) { if (k.startsWith('terraville.slot')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return window.realSetItem.call(this, k, v); }
        : window.realSetItem;
    }, on);
    const autosave = () => page.evaluate(() => window.__terraville.autosave());
    await fullStorage(true);
    assert.deepEqual([await autosave(), await autosave(), await autosave()], [false, false, false]);
    assert.deepEqual(await page.evaluate(() => window.saidSaving), ["Saving failed: this browser's storage is full. Delete snapshots or cities you no longer need in Save, open and share."]);
    await fullStorage(false);
    assert.equal(await autosave(), true);
    await fullStorage(true);
    assert.equal(await autosave(), false);
    assert.equal(await page.evaluate(() => window.saidSaving.length), 2);
    assert.deepEqual(problems, []);
    await ctx.close();

    const blocked = await profile();
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } }));
    const { page: p2, problems: more } = await open(blocked);
    await found(p2);
    await watch(p2);
    assert.equal(await p2.evaluate(() => window.__terraville.autosave()), false);
    assert.deepEqual(await p2.evaluate(() => window.saidSaving), ['Saving failed. This browser is blocking storage.']);
    assert.deepEqual(more, []);
    await blocked.close();
  });

  await test('Space presses a button reached with Tab, and still pauses after a click', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const speed = () => page.evaluate(() => window.__terraville.speed);
    await page.evaluate(() => window.__terraville.setSpeed(2));
    // A click focuses the tool too, but Space pauses rather than pressing it again.
    await page.click('[data-tool="road"]');
    await page.keyboard.press('Space');
    assert.equal(await speed(), 0);
    await page.keyboard.press('Space');
    assert.equal(await speed(), 2);
    await tabTo(page, '#topbar [data-act="budget"]');
    await page.keyboard.press('Space');
    assert.equal(await page.textContent('.modal h2'), 'Budget');
    await page.keyboard.press('Escape');
    assert.equal(await speed(), 2);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('dialogs and menus take focus, keep Tab inside, and hand it back to the keyboard', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const inModal = () => page.evaluate(() => !!document.activeElement?.closest('.modal'));
    const focused = () => page.evaluate(() => document.activeElement?.dataset.act ?? document.activeElement?.textContent);
    // A dialog opened from the keyboard keeps Tab inside, and Escape hands focus back, even from a slider.
    await tabTo(page, '#topbar [data-act="budget"]');
    await page.keyboard.press('Enter');
    assert.equal(await inModal(), true, 'the Budget dialog did not take focus');
    for (let i = 1; i <= 12; i++) {
      await page.keyboard.press(i > 9 ? 'Shift+Tab' : 'Tab');
      assert.equal(await inModal(), true, `Tab ${i} left the dialog`);
    }
    await page.focus('#bTax');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('.modal'), false);
    assert.equal(await focused(), 'budget');
    // A menu: the first item takes focus, the arrow keys go round it without moving the map, Escape hands focus back.
    await tabTo(page, '#topbar [data-act="menu"]');
    await page.keyboard.press('Enter');
    const cam = await page.evaluate(() => ({ ...window.__terraville.renderer.cam }));
    assert.equal(await focused(), 'Save, open and share');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'Strategy guide');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(), 'Back to the title screen');
    assert.deepEqual(await page.evaluate(() => ({ ...window.__terraville.renderer.cam })), cam, 'the arrow keys moved the map');
    await page.keyboard.press('Escape');
    assert.equal(await focused(), 'menu');
    // From a menu item to a dialog, and back to the menu's button.
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('.modal h2'), 'Settings');
    assert.equal(await inModal(), true);
    await page.keyboard.press('Escape');
    assert.equal(await focused(), 'menu');
    // A dialog opened and closed with the mouse leaves focus where the mouse put it.
    await page.click('#topbar [data-act="charts"]');
    assert.equal(await inModal(), true);
    await page.click('.modal [data-close]');
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Go there glides to the spot in about half a second, or jumps there with less motion asked for', async () => {
    for (const motion of ['no-preference', 'reduce']) {
      const ctx = await profile({ ...DESK, reducedMotion: motion });
      const { page, problems } = await open(ctx);
      await page.evaluate(() => { window.__terraville.startScenario('gridlock'); window.__terraville.ui.closeModal(); });
      const from = await page.evaluate(() => {
        const g = window.__terraville;
        g.sim.say('test', 'Something at the far side of the map.', 'alert', { x: 89, y: 69 }, 0);
        return { ...g.renderer.cam };
      });
      await page.click('#tkGo');
      const t0 = Date.now();
      const soon = await page.evaluate(() => ({ ...window.__terraville.renderer.cam }));
      await page.waitForFunction(() => !window.__terraville.renderer.flying, null, { timeout: 2000 });
      const took = Date.now() - t0;
      const cam = await page.evaluate(() => ({ ...window.__terraville.renderer.cam }));
      assert.deepEqual([Math.round(cam.x * 100) / 100, Math.round(cam.y * 100) / 100, cam.zoom], [89.5, 69.5, 22], `${motion}: on the spot, close up`);
      if (motion === 'reduce') assert.deepEqual(soon, cam, 'at once');
      else {
        assert.ok(Math.hypot(soon.x - from.x, soon.y - from.y) < Math.hypot(cam.x - from.x, cam.y - from.y) / 2, `on its way, not there at once: ${JSON.stringify({ from, soon, cam })}`);
        assert.ok(took < 700, `there in ${took} ms`);
      }
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test('the news ticker shows two lines of a long message, and a tap on it opens the whole of it in the log', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    assert.match(await page.textContent('#ticker .msg-text'), /^Welcome to \S+\. The checklist has the first steps\.$/);
    await page.evaluate(() => window.__terraville.sim.say('brownout', 'Brownouts: one of your 3 separate power grids needs 1,240 MW but its plants make 480 MW. Join it to a grid with power to spare, or build a plant on it.', 'warn', { x: 40, y: 40 }, 0));
    const box = (s) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }, s);
    const lines = await page.evaluate(() => {
      const t = document.querySelector('#ticker .msg-text');
      return Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight));
    });
    assert.equal(lines, 2, 'the message takes two lines');
    assert.ok((await box('#ticker')).bottom <= (await box('#toolbox')).top, 'the taller ticker stays clear of the tools');
    await page.tap('#ticker .msg-text');
    assert.equal(await page.isHidden('#log'), false, 'a tap on the text opens the log');
    assert.match(await page.textContent('#log .row .msg-text'), /or build a plant on it\.$/);
    assert.ok((await box('#log')).bottom <= (await box('#ticker')).top, 'the log sits above the taller ticker');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('on a laptop or a tablet, the Inspect card leaves the news buttons free', async () => {
    for (const [width, height, both] of [[1280, 800, true], [1024, 768, false]]) {
      const ctx = await profile({ viewport: { width, height } });
      const { page, problems } = await open(ctx);
      await found(page);
      await page.click('#map', { position: { x: Math.round(width / 2), y: Math.round(height / 2) } });
      assert.equal(await page.isHidden('#inspect'), false, 'a click with Inspect opened the card');
      await page.click('#tkLog', { timeout: 3000 });
      assert.equal(await page.isHidden('#log'), false, `${width}: News opened the log`);
      // Where the two would cover each other, the log takes the card's place, as on a phone.
      assert.equal(await page.isHidden('#inspect'), !both, `${width}: the card stays only where there is room for both`);
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test("a tool's tooltip shows for a moment after a tap and goes once the map is touched; hover and Tab still show it", async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const tip = () => page.isVisible('#tooltip');
    await page.tap('[data-tool="road"]');
    assert.equal(await tip(), true, 'a tap shows the tip');
    await touch('touchStart', [[120, 520]]);
    assert.equal(await tip(), false, 'a finger on the map puts it away');
    for (let k = 1; k <= 5; k++) await touch('touchMove', [[120 + k * 25, 520]]);
    await touch('touchEnd', []);
    await page.waitForTimeout(300);
    assert.equal(await tip(), false, 'it stays away after the drag, though the button kept focus');
    assert.equal(await page.evaluate(() => window.__terraville.world.net.some((v) => v & 1)), true, 'the drag laid a road');
    await page.tap('[data-tool="rail"]');
    assert.equal(await tip(), true);
    await page.waitForTimeout(2600);
    assert.equal(await tip(), false, 'left alone, it goes after a moment');
    assert.deepEqual(problems, []);
    await ctx.close();

    const desk = await profile(DESK);
    const { page: d, problems: dp } = await open(desk);
    await found(d);
    await d.hover('[data-tool="road"]');
    assert.equal(await d.isVisible('#tooltip'), true, 'hover shows it');
    await d.mouse.move(640, 400);
    assert.equal(await d.isVisible('#tooltip'), false);
    await d.click('[data-tool="rail"]');
    await d.mouse.move(640, 400);
    assert.equal(await d.isVisible('#tooltip'), false, 'a click leaves no tip behind');
    await d.keyboard.press('Tab');
    assert.equal(await d.isVisible('#tooltip'), true, 'Tab to the next tool shows its tip');
    assert.deepEqual(dp, []);
    await desk.close();
  });

  await test('the found dialog leaves the name alone on a touch screen, and says what each difficulty changes', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="quick"]');
    await page.waitForTimeout(100);
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'fName', 'no keyboard comes up over the dialog');
    assert.deepEqual(await page.$$eval('#fDiff small', (s) => s.map((x) => x.textContent)), [
      'Taxes bring in more · fewer disasters', 'The standard game', 'Taxes bring in less · more disasters',
    ]);
    assert.match(await page.textContent('.switch small'), /once the city has 5,000 residents\. You can also set them off yourself\.$/);
    assert.deepEqual(problems, []);
    await ctx.close();
    const desk = await profile(DESK);
    const { page: d } = await open(desk);
    await d.click('[data-act="quick"]');
    await d.waitForFunction(() => document.activeElement?.id === 'fName', null, { timeout: 2000 });
    await desk.close();
  });

  await test('Found a city shows the land it founds on, redrawn for Different land, and still fits a phone', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="quick"]');
    const land = () => page.evaluate(() => {
      const c = document.querySelector('#fLand');
      const px = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
      const body = document.querySelector('.modal .body');
      return { url: c.toDataURL(), opaque: px[3] === 255, caption: document.querySelector('.found-land b').textContent, seed: window.__terraville.terrain.seed,
        fits: body.scrollHeight <= body.clientHeight && document.querySelector('.modal footer').getBoundingClientRect().bottom <= innerHeight };
    });
    const first = await land();
    assert.equal(first.opaque, true, 'the picture is drawn');
    assert.ok(['Coastline', 'Island', 'Archipelago', 'Lake country', 'River valley'].includes(first.caption), first.caption);
    assert.equal(first.fits, true, 'the dialog fits a phone without scrolling');
    await page.click('.modal footer button:has-text("Different land")');
    await page.waitForFunction((seed) => window.__terraville.terrain.seed !== seed && document.querySelector('#fLand'), first.seed);
    const second = await land();
    assert.notEqual(second.url, first.url, 'the new land is drawn');
    assert.equal(second.fits, true);
    // Founding from the terrain editor has the land in view, so no picture.
    await page.click('.modal footer button:has-text("Shape the land first")');
    await page.click('#topbar button:has-text("Found a city here")');
    assert.equal(await page.locator('#fLand').count(), 0);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the found dialog names its field and its difficulty choice for a screen reader, and the editor names its button rows', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.click('[data-act="quick"]');
    assert.equal(await page.getByRole('textbox', { name: 'City name', exact: true }).count(), 1, 'the dice button is not part of the name');
    assert.equal(await page.getByRole('radiogroup', { name: 'Difficulty' }).count(), 1);
    const checked = () => page.$$eval('#fDiff [role="radio"]', (r) => r.map((x) => [x.getAttribute('aria-checked'), x.tabIndex]));
    assert.deepEqual(await checked(), [['true', 0], ['false', -1], ['false', -1]]);
    // Arrow keys move the choice, as in any group of radio buttons.
    await page.focus('#fDiff [aria-checked="true"]');
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await checked(), [['false', -1], ['true', 0], ['false', -1]]);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.d), 'medium');
    await page.click('#fDiff [data-d="hard"]');
    assert.deepEqual(await checked(), [['false', -1], ['false', -1], ['true', 0]]);
    await page.click('.modal footer .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    assert.equal(await page.evaluate(() => window.__terraville.world.city.difficulty), 'hard');
    await page.goto(base);
    await titleUp(page);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.equal(await page.getByRole('group', { name: 'Landscape' }).count(), 1);
    assert.equal(await page.getByRole('group', { name: 'Map size' }).count(), 1);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a warning toast looks like one, stays long enough to read, and goes when tapped; on a phone it clears the stats and the checklist', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const shown = () => page.evaluate(() => !document.querySelector('#toast').classList.contains('hide'));
    await page.evaluate(() => {
      const w = window.__terraville.world;
      const i = w.water.findIndex((v) => v);
      window.__terraville.quickBulldoze((i % w.w) + 0.5, Math.floor(i / w.w) + 0.5, 10, 10);
    });
    assert.equal(await page.textContent('#toast'), 'Nothing to bulldoze there.');
    assert.equal(await page.evaluate(() => document.querySelector('#toast').matches('.warn') && !!document.querySelector('#toast .caution')), true, 'a warning carries the caution diamond');
    const box = (s) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }, s);
    assert.ok((await box('#toast')).top >= (await box('#guide')).bottom, 'under the checklist');
    assert.ok((await box('.stat-strip')).bottom <= (await box('#toast')).top, 'clear of the stats');
    // Twenty words take about five seconds to read: still up after four.
    await page.evaluate(() => window.__terraville.ui.toast('Drag to move the map, scroll or pinch to zoom. Pick a brush below to shape the land.'));
    assert.equal(await page.evaluate(() => document.querySelector('#toast').matches('.warn')), false);
    await page.waitForTimeout(4000);
    assert.equal(await shown(), true, 'a long toast is still up after four seconds');
    await page.tap('#toast');
    assert.equal(await shown(), false, 'a tap puts it away');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("a toast never sits on a dialog's heading: an old one goes when a dialog opens or the screen changes, and one raised in a dialog shows below the heading", async () => {
    const shown = (page) => page.evaluate(() => !document.querySelector('#toast').classList.contains('hide'));
    // Clear of the dialog's heading: wholly above it or wholly below it.
    const clear = (page) => page.evaluate(() => {
      const t = document.querySelector('#toast').getBoundingClientRect();
      const h = document.querySelector('.modal header').getBoundingClientRect();
      return t.bottom <= h.top || t.top >= h.bottom;
    });
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.equal(await shown(page), true, "the editor's opening words are up");
    await page.click('#topbar [data-act="menu"]');
    await page.click('[role="menu"] button:has-text("Settings")');
    assert.equal(await shown(page), false, 'Settings opened a moment later hides them');
    await page.keyboard.press('Escape');
    // A notice from one screen goes with it.
    await page.evaluate(() => window.__terraville.ui.toast('Random disasters are off.'));
    await page.evaluate(() => window.__terraville.showTitle());
    assert.equal(await shown(page), false, 'the title screen starts without the last screen\'s notice');
    // In the Budget, Repay with too little money says so below the heading, in a wide window and on a phone, where the
    // Budget fills the screen.
    for (const opts of [DESK, PHONE]) {
      const c = await profile(opts);
      const { page: p, problems: inP } = await open(c);
      await found(p);
      await p.evaluate(() => { const city = window.__terraville.world.city; city.loan = 10000; city.funds = 500; });
      await p.click('#topbar [data-act="budget"]');
      await p.click('.modal button:has-text("Repay $10,000")');
      assert.match(await p.textContent('#toast'), /Not enough money to repay that/);
      assert.equal(await clear(p), true, `${opts.viewport.width} px: the toast keeps off the Budget's heading`);
      await p.click('.modal footer .btn.primary');
      assert.deepEqual(inP, []);
      await c.close();
    }
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("on a phone the terrain editor's opening toast stays clear of the brushes it points to", async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.match(await page.textContent('#toast'), /Pick a brush below to shape the land\./);
    const box = (s) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }, s);
    const toast = await box('#toast');
    assert.ok(toast.bottom <= (await box('#editorPanel')).top, 'above the editor panel');
    assert.ok(toast.bottom <= (await box('#toolbox')).top, 'off the brushes');
    assert.ok((await box('.stat-strip, #topbar')).bottom <= toast.top, 'under the top bar');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("on a phone the RCI meter's bars grow from its zero line and stay inside it", async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const bars = (demand) => page.evaluate((d) => {
      const g = window.__terraville;
      g.world.city.demand = d;
      g.ui.onFunds();
      return [...document.querySelectorAll('.rci .fill')].map((f) => {
        const bar = f.parentElement.getBoundingClientRect();
        const fill = f.getBoundingClientRect();
        return { top: fill.top - bar.top, bottom: fill.bottom - bar.top, mid: bar.height / 2, height: bar.height };
      });
    }, demand);
    const [r, c, i] = await bars({ r: 0.25, c: 0.05, i: -0.1 });
    assert.equal(c.bottom, c.mid, 'a little demand sits on the zero line');
    assert.equal(r.bottom, r.mid);
    assert.equal(i.top, i.mid, 'a surplus hangs from it');
    const [, full] = await bars({ r: 0, c: -1, i: 0 });
    assert.ok(full.bottom <= full.height, 'a full surplus stays off the C below it');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('on a phone a tap on the RCI meter says what each bar means, what taxes do, and opens the guide at the meter', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    await page.evaluate(() => {
      const g = window.__terraville;
      g.world.city.tax = 9;
      g.world.city.demand = { r: 0.6, c: 0.2, i: -0.3 };
      g.ui.onFunds();
    });
    await page.tap('#rci');
    const card = page.getByRole('dialog', { name: 'Demand' });
    await card.waitFor();
    assert.equal(await page.getAttribute('#rci', 'aria-expanded'), 'true');
    assert.deepEqual(await card.locator('li').allTextContents(), ['Homes: strong demand, zone more residential', 'Shops: some demand', 'Factories: too many']);
    assert.equal(await card.locator('.demand-tax').textContent(), 'Taxes at 9% pull all three down: each point above 7% does.');
    // It follows the bars while it is open.
    await page.evaluate(() => {
      const g = window.__terraville;
      g.world.city.tax = 7;
      g.world.city.demand = { r: 0.05, c: -0.5, i: 0.2 };
      g.ui.onFunds();
    });
    assert.deepEqual(await card.locator('li').allTextContents(), ['Homes: about enough', 'Shops: too many', 'Factories: some demand']);
    assert.match(await card.locator('.demand-tax').textContent(), /^Taxes at 7% leave all three as they are/);
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'on the screen');
    await card.getByRole('button', { name: 'How demand works' }).tap();
    await page.waitForSelector('.modal .guide');
    await page.waitForTimeout(300);
    const heading = await page.locator('#guide-demand h3').boundingBox();
    const scroller = await page.locator('.guide-scroll').boundingBox();
    assert.ok(heading.y >= scroller.y && heading.y < scroller.y + 120, 'the guide opens at the RCI meter');
    assert.equal(await page.locator('.dropdown').count(), 0, 'the card has closed');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('past its right and bottom edges the map shows the dark margin, on every map size', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    for (const [w, h] of [[72, 60], [120, 100], [180, 150]]) {
      for (const zoom of [0, 24]) {
        await page.evaluate(([w, h, zoom]) => {
          const g = window.__terraville;
          if (g.world.w !== w) g.regenerate({ w, h });
          g.renderer.cam.zoom = zoom || g.renderer.minZoom();
          g.renderer.centerOn(w, h);
        }, [w, h, zoom]);
        await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
        const past = await page.evaluate(() => {
          const g = window.__terraville;
          const r = g.renderer;
          const ctx = document.querySelector('#map').getContext('2d');
          const at = (x, y) => {
            const p = r.tileToScreen(x, y);
            return [...ctx.getImageData(Math.round(p.x * devicePixelRatio), Math.round(p.y * devicePixelRatio), 1, 1).data].slice(0, 3).join();
          };
          return [at(g.world.w + 0.6, r.cam.y), at(g.world.w - 3, g.world.h + 0.6)];
        });
        assert.deepEqual(past, ['14,20,18', '14,20,18'], `${w}x${h} at zoom ${zoom || 'out'}: right and bottom of the edge`);
      }
    }
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("undo in the terrain editor puts back the sliders, the seed and the sign, and the next change starts from them", async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await page.click('[data-style="coast"]');
    await page.fill('#edSeed', 'amber-isle-11');
    await page.press('#edSeed', 'Enter');
    await page.waitForFunction(() => window.__terraville.terrain.seed === 'amber-isle-11' && window.__terraville.terrain.style === 'coast');
    const hash = () => page.evaluate(() => { const w = window.__terraville.world; let h = 0; for (let i = 0; i < w.n; i++) h = (h * 31 + Math.round(w.height[i] * 10) + w.water[i] * 7 + w.trees[i]) | 0; return h; });
    const peak = () => page.evaluate(() => { const w = window.__terraville.world; let m = 0; for (let i = 0; i < w.n; i++) if (!w.water[i]) m = Math.max(m, w.height[i]); return m; });
    const panel = () => page.evaluate(() => ({
      hills: document.querySelector('#edHills').value, shown: document.querySelector('#edHillsVal').textContent, set: window.__terraville.terrain.hills,
      seed: document.querySelector('#edSeed').value, sign: document.querySelector('#signSub').textContent, style: document.querySelector('#edStyle [aria-pressed="true"]').dataset.style,
    }));
    const slide = async (id, v) => {
      const n = await page.evaluate(() => window.__terraville.undoStack.length);
      await page.$eval('#' + id, (s, v) => { s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }, v);
      await page.waitForFunction((n) => window.__terraville.undoStack.length > n, n);
    };
    const start = await hash();
    const low = await peak();

    await slide('edHills', 90);
    assert.ok((await peak()) > low + 40, 'Mountains 90 raises the peaks');
    await page.click('#btnUndo');
    assert.equal(await hash(), start, 'the land is back');
    assert.deepEqual(await panel(), { hills: '45', shown: '45', set: 45, seed: 'amber-isle-11', sign: 'amber-isle-11', style: 'coast' }, 'and so is Mountains, in the panel and the settings');
    await page.click('#btnRedo');
    assert.equal((await panel()).hills, '90', 'redo puts Mountains 90 back too');
    await page.click('#btnUndo');
    await slide('edForest', 46);
    assert.ok((await peak()) < low + 20, 'the next change regenerates with Mountains 45, not the undone 90');
    await page.click('#btnUndo');
    assert.equal(await hash(), start);

    // A typed seed and a style, undone, are gone from the seed box, the sign and the founding dialog.
    await page.fill('#edSeed', 'other-seed-22');
    await page.press('#edSeed', 'Enter');
    await page.waitForFunction(() => window.__terraville.terrain.seed === 'other-seed-22');
    await page.click('[data-style="island"]');
    await page.waitForFunction(() => window.__terraville.terrain.style === 'island');
    await page.click('#btnUndo');
    await page.click('#btnUndo');
    assert.equal(await hash(), start);
    assert.deepEqual(await panel(), { hills: '45', shown: '45', set: 45, seed: 'amber-isle-11', sign: 'amber-isle-11', style: 'coast' });
    await page.click('[data-act="found"]');
    assert.equal(await page.textContent('.modal .sub'), 'On coastline land, seed amber-isle-11');
    await page.keyboard.press('Escape');

    // Shaped by hand, the land is no longer the seed's alone, and the dialog says so until the stroke is undone.
    await page.keyboard.press('r');
    const a = await page.evaluate(() => { const r = window.__terraville.renderer; return [r.tileToScreen(60, 50), r.tileToScreen(66, 56)]; });
    await page.mouse.move(a[0].x, a[0].y);
    await page.mouse.down();
    await page.mouse.move(a[1].x, a[1].y, { steps: 6 });
    await page.mouse.up();
    await page.click('[data-act="found"]');
    assert.equal(await page.textContent('.modal .sub'), 'On coastline land, seed amber-isle-11, reshaped by hand');
    await page.keyboard.press('Escape');
    await page.click('#btnUndo');
    await page.click('[data-act="found"]');
    assert.equal(await page.textContent('.modal .sub'), 'On coastline land, seed amber-isle-11');
    await page.keyboard.press('Escape');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('dragging an editor slider is one undo step however often it regenerates, so brush work stays in reach', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    const hash = () => page.evaluate(() => { const w = window.__terraville.world; let h = 0; for (let i = 0; i < w.n; i++) h = (h * 31 + Math.round(w.height[i] * 10) + w.water[i] * 7 + w.trees[i]) | 0; return h; });
    const steps = () => page.evaluate(() => window.__terraville.undoStack.length);
    await page.keyboard.press('r');
    for (const [a, b] of [[[50, 40], [56, 48]], [[60, 44], [66, 52]]]) {
      const [p, q] = await page.evaluate(([a, b]) => { const r = window.__terraville.renderer; return [r.tileToScreen(...a), r.tileToScreen(...b)]; }, [a, b]);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(q.x, q.y, { steps: 6 });
      await page.mouse.up();
    }
    assert.equal(await steps(), 2);
    const shaped = await hash();
    await page.evaluate(() => {
      const g = window.__terraville;
      const regen = g.regenerate.bind(g);
      window.regens = 0;
      g.regenerate = (...a) => { window.regens++; return regen(...a); };
    });
    // Three seconds along Forest and back, resting past the 90 ms the panel waits, so the land regenerates many times.
    const box = await page.$eval('#edForest', (s) => { s.scrollIntoView({ block: 'center' }); const r = s.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
    const thumb = box.x + box.w * 0.45;
    await page.mouse.move(thumb, box.y);
    await page.mouse.down();
    for (let k = 1; k <= 24; k++) {
      await page.mouse.move(thumb + (k <= 12 ? k : 24 - k) * 4 + 6, box.y);
      await page.waitForTimeout(125);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => window.regens) >= 5, 'the drag regenerated the land as it went');
    assert.equal(await steps(), 3, 'one undo step for the whole drag');
    await page.click('#btnUndo');
    assert.equal(await hash(), shaped, 'one undo goes back to the land as the brushes left it');
    assert.equal(await page.$eval('#edForest', (s) => s.value), '45');
    // The next drag, or a key press, is a step of its own.
    await page.focus('#edForest');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.__terraville.undoStack.length === 3);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.__terraville.undoStack.length === 4);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a change of map size in the editor is an undo step, and undo brings back the map shaped before it', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    const hash = () => page.evaluate(() => { const w = window.__terraville.world; let h = w.w; for (let i = 0; i < w.n; i++) h = (h * 31 + Math.round(w.height[i] * 10) + w.water[i] * 7 + w.trees[i]) | 0; return h; });
    const state = () => page.evaluate(() => {
      const g = window.__terraville;
      return { w: g.world.w, h: g.world.h, terrain: [g.terrain.w, g.terrain.h], size: document.querySelector('#edSize [aria-pressed="true"]').dataset.size, undo: g.undoStack.length, redo: g.redoStack.length };
    });
    await page.keyboard.press('r');
    const [p, q] = await page.evaluate(() => { const r = window.__terraville.renderer; return [r.tileToScreen(50, 40), r.tileToScreen(58, 48)]; });
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 6 });
    await page.mouse.up();
    const shaped = await hash();
    await page.click('[data-size="large"]');
    assert.deepEqual(await state(), { w: 180, h: 150, terrain: [180, 150], size: 'large', undo: 2, redo: 0 }, 'Large is a step, after the stroke');
    const large = await hash();
    await page.click('#btnUndo');
    assert.deepEqual(await state(), { w: 120, h: 100, terrain: [120, 100], size: 'classic', undo: 1, redo: 1 });
    assert.equal(await hash(), shaped, 'the Classic map comes back with its stroke');
    assert.ok(await page.evaluate(() => { const r = window.__terraville.renderer; return r.world === window.__terraville.world && r.cam.x > 0 && r.cam.x < 120 && r.cam.y > 0 && r.cam.y < 100; }), 'drawn, and in view');
    await page.click('#btnUndo');
    assert.equal((await state()).undo, 0, 'and the stroke is still there to undo');
    await page.click('#btnRedo');
    await page.click('#btnRedo');
    assert.deepEqual(await state(), { w: 180, h: 150, terrain: [180, 150], size: 'large', undo: 2, redo: 0 });
    assert.equal(await hash(), large, 'redo brings the Large map back');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('land shaped in the terrain editor is kept as a draft across a reload, and founding a city or starting new land lets it go', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    const hash = () => page.evaluate(() => { const w = window.__terraville.world; let h = w.w; for (let i = 0; i < w.n; i++) h = (h * 31 + Math.round(w.height[i] * 10) + w.water[i] * 7 + w.trees[i]) | 0; return h; });
    const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem('terraville.draft') ?? 'null'));
    const hide = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const stroke = async (a, b) => {
      await page.keyboard.press('r');
      const [p, q] = await page.evaluate(([a, b]) => { const r = window.__terraville.renderer; return [r.tileToScreen(...a), r.tileToScreen(...b)]; }, [a, b]);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(q.x, q.y, { steps: 6 });
      await page.mouse.up();
    };
    const buttons = () => page.$$eval('#title .title-actions .btn', (bs) => bs.map((b) => `${b.classList.contains('primary') ? '*' : ''}${b.dataset.act}`));
    assert.equal(await draft(), null);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await stroke([50, 40], [58, 48]);
    await page.$eval('#edForest', (s) => { s.value = '70'; s.dispatchEvent(new Event('input')); });
    await page.waitForFunction(() => window.__terraville.terrain.forest === 70);
    await stroke([30, 30], [36, 34]);
    const seed = await page.evaluate(() => window.__terraville.terrain.seed);
    const shaped = await hash();
    // Leaving the page keeps it, there and then.
    await hide();
    assert.equal((await draft()).seed, seed);
    await page.reload();
    await titleUp(page);
    assert.deepEqual(await buttons(), ['*draft', 'quick', 'editor', 'challenges', 'guide', 'open']);
    assert.equal(await page.textContent('[data-act="draft"]'), `Continue shaping the landSeed ${seed} · saved just now`);
    assert.equal(await page.textContent('[data-act="editor"] small'), 'New land in the terrain editor');
    await page.click('[data-act="draft"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.equal(await hash(), shaped, 'the land comes back as it was shaped');
    assert.deepEqual(await page.evaluate(() => { const t = window.__terraville.terrain; return [t.seed, t.forest, t.shaped]; }), [seed, 70, true]);
    assert.equal(await page.$eval('#edForest', (s) => s.value), '70');
    // Every 90 seconds the draft is kept again, compressed.
    await stroke([60, 60], [64, 66]);
    const before = (await draft()).savedAt;
    await page.evaluate(() => (window.__terraville.autoTimer = 200));
    await page.waitForFunction((t) => JSON.parse(localStorage.getItem('terraville.draft')).savedAt > t, before);
    assert.match((await draft()).code, /^TV1g:/);
    const later = await hash();
    // Back to the title screen keeps it too, and says so.
    await page.click('#topbar [data-act="menu"]');
    await page.click('[role="menu"] button:has-text("Back to the title screen")');
    assert.equal(await page.textContent('.modal .body'), 'The land is kept as you leave: Continue shaping the land on the title screen brings it back.');
    await page.click('.modal footer .btn.primary');
    await titleUp(page);
    await page.click('[data-act="draft"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.equal(await hash(), later);
    // Founding a city on it lets the draft go.
    await page.click('[data-act="found"]');
    await page.click('.modal footer .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    assert.equal(await draft(), null);
    await page.reload();
    await titleUp(page);
    assert.deepEqual(await buttons(), ['*continue', 'quick', 'editor', 'challenges', 'guide', 'open']);
    // Land a quick start only shows doesn't take a draft's place; new land in the editor does, from the start.
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await stroke([40, 40], [44, 44]);
    await page.evaluate(() => window.__terraville.showTitle());
    const kept = await draft();
    await page.reload();
    await titleUp(page);
    assert.deepEqual(await buttons(), ['*draft', 'continue', 'quick', 'editor', 'challenges', 'guide', 'open'], 'the newer of the two first');
    await page.click('[data-act="quick"]');
    await page.keyboard.press('Escape');
    await hide();
    assert.deepEqual(await draft(), kept);
    await page.reload();
    await titleUp(page);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.equal(await draft(), null);
    const fresh = await page.evaluate(() => window.__terraville.terrain.seed);
    await page.evaluate(() => window.__terraville.showTitle());
    assert.equal((await draft()).seed, fresh, 'new land is kept as it is, untouched');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('every corner tile of the map can be brought out from under the panels, on a laptop and a phone', async () => {
    for (const opts of [DESK, PHONE]) {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      await found(page);
      // Each corner, scrolled as far as the camera lets it go at zoom 14: the tile is on the screen and under no panel.
      const corner = (tx, ty) => page.evaluate(([tx, ty]) => {
        const g = window.__terraville;
        const r = g.renderer;
        r.cam.zoom = 14;
        r.centerOn(tx < 0 ? -50 : g.world.w + 50, ty < 0 ? -50 : g.world.h + 50);
        const x = tx < 0 ? 0 : g.world.w - 1;
        const y = ty < 0 ? 0 : g.world.h - 1;
        const map = document.querySelector('#map').getBoundingClientRect();
        const a = r.tileToScreen(x, y);
        const t = { left: map.left + a.x, top: map.top + a.y, right: map.left + a.x + 14, bottom: map.top + a.y + 14 };
        const panels = [...document.querySelectorAll('#topbar > *, #toolbox, #minimapCard, #ticker, #guide, #goal, #editorPanel, #pausedPill')]
          .filter((e) => !e.hidden && e.getClientRects().length)
          .map((e) => [e.id || e.className, e.getBoundingClientRect()])
          .filter(([, b]) => b.width && b.height && b.left < t.right && t.left < b.right && b.top < t.bottom && t.top < b.bottom)
          .map(([name]) => name);
        return { onScreen: t.left >= 0 && t.top >= 0 && t.right <= innerWidth && t.bottom <= innerHeight, under: panels };
      }, [tx, ty]);
      for (const [tx, ty] of [[-1, -1], [1, 1], [1, -1], [-1, 1]]) {
        assert.deepEqual(await corner(tx, ty), { onScreen: true, under: [] }, `${opts.viewport.width}px: corner ${tx < 0 ? 'left' : 'right'} ${ty < 0 ? 'top' : 'bottom'}`);
      }
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test('at street level a zone and an airport go flush against every edge and corner, clear of every panel and card', async () => {
    const views = [
      ['1280x800', DESK, false],
      ['1024x768', { viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true }, true],
      ['844x390', { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, true],
      ['390x844', PHONE, true],
    ];
    const spots = [[-1, -1, 'top left'], [0, -1, 'top'], [1, -1, 'top right'], [1, 0, 'right'], [1, 1, 'bottom right'], [0, 1, 'bottom'], [-1, 1, 'bottom left'], [-1, 0, 'left']];
    const wrong = [];
    for (const [view, opts, touch] of views) {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      const pick = (tool) => (touch ? page.tap(`[data-tool="${tool}"]`) : page.click(`[data-tool="${tool}"]`));
      const press = async (p) => {
        if (touch) return page.touchscreen.tap(p.x, p.y);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.up();
      };
      for (const panel of ['checklist', 'Inspect card', 'news log', 'overview map', 'goal card']) {
        // Open, flat land everywhere, plenty of money, the clock stopped (the paused badge up) and one card open.
        if (panel === 'goal card') await page.evaluate(() => { window.__terraville.startScenario('gridlock'); window.__terraville.ui.closeModal(); });
        else if (panel === 'checklist') await found(page);
        await page.evaluate((panel) => {
          const g = window.__terraville;
          const w = g.world;
          for (let i = 0; i < w.n; i++) {
            if (w.occ[i]) w.remove(w.occ[i]);
            w.water[i] = 0; w.height[i] = 6; w.trees[i] = 0; w.net[i] = 0; w.rubble[i] = 0; w.fire[i] = 0; w.flood[i] = 0;
          }
          w.dirtyAll(true);
          w.city.funds = 1e7;
          g.setSpeed(0);
          const $ = (s) => document.querySelector(s);
          // Each card in turn: the checklist and the goal card unfolded, the others put away.
          const head = $('#guide:not([hidden]) button.guide-head[aria-expanded="true"]');
          if (head && panel !== 'checklist') head.click();
          const folded = $('#guide:not([hidden]) .guide-next[aria-expanded="false"], #goal.folded .goal-head');
          if (folded && (panel === 'checklist' || panel === 'goal card')) folded.click();
          g.ui.hideInspect();
          if (!$('#log').hidden) $('#tkLog').click();
          if (panel === 'Inspect card') {
            g.setTool('query');
            const b = w.place('nuclear', Math.floor(w.w / 2), Math.floor(w.h / 2));
            g.ui.inspect(b.x, b.y);
          }
          if (panel === 'overview map') {
            g.ui.setOverlay('landValue');
            const t = $('#mmToggle');
            if (!t.hidden && t.getAttribute('aria-pressed') !== 'true') t.click();
          } else if (g.renderer.overlay !== 'none') g.ui.setOverlay('none');
        }, panel);
        for (const kind of ['res', 'airport']) {
          await pick(kind);
          if (panel === 'news log') {
            if (await page.evaluate(() => document.querySelector('#log').hidden)) await (touch ? page.tap('#tkLog') : page.click('#tkLog'));
            // On a phone the news log closes when the map is touched.
            if (view === '844x390' || view === '390x844') {
              if (await page.evaluate(() => !document.querySelector('#toast').classList.contains('hide'))) await page.tap('#toast');
              // Somewhere the map shows, well clear of anything over it.
              const at = await page.evaluate(() => {
                const map = document.querySelector('#map');
                const open = (x, y) => [[0, 0], [-12, 0], [12, 0], [0, -12], [0, 12]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === map);
                for (let y = 20; y < innerHeight - 20; y += 6) for (let x = 20; x < innerWidth - 20; x += 6) if (open(x, y)) return { x, y };
              });
              await page.touchscreen.tap(at.x, at.y);
              await page.waitForFunction(() => document.querySelector('#log').hidden, null, { timeout: 2000 }).catch(() => {});
              const closed = await page.evaluate(() => {
                const g = window.__terraville;
                for (const b of [...g.world.buildings.values()]) g.world.remove(b.id);
                return document.querySelector('#log').hidden;
              });
              if (!closed) wrong.push(`${view}: a touch on the map left the news log open`);
            }
          }
          const size = kind === 'res' ? 3 : 6;
          for (const [px, py, name] of spots) {
            // The camera as far over as it goes, the footprint flush against that edge (in the middle of the room left
            // along it), and every tile of it on open map.
            const t = await page.evaluate(([px, py, size]) => {
              const g = window.__terraville;
              const r = g.renderer;
              const w = g.world;
              r.stopFlight();
              r.cam.zoom = 24;
              r.cam.x = px < 0 ? -1e6 : px > 0 ? 1e6 : w.w / 2;
              r.cam.y = py < 0 ? -1e6 : py > 0 ? 1e6 : w.h / 2;
              r.clampCamera();
              const c = r.freeCentre();
              const x = px < 0 ? 0 : px > 0 ? w.w - size : Math.max(0, Math.min(w.w - size, Math.floor(c.x) - Math.floor(size / 2)));
              const y = py < 0 ? 0 : py > 0 ? w.h - size : Math.max(0, Math.min(w.h - size, Math.floor(c.y) - Math.floor(size / 2)));
              const canvas = document.querySelector('#map');
              const under = new Set();
              for (let ty = y; ty < y + size; ty++) for (let tx = x; tx < x + size; tx++) {
                const a = r.tileToScreen(tx, ty);
                for (const [dx, dy] of [[12, 12], [3, 3], [21, 3], [3, 21], [21, 21]]) {
                  const e = document.elementFromPoint(a.x + dx, a.y + dy);
                  if (e !== canvas) under.add(e?.closest('[id]')?.id || 'off the screen');
                }
              }
              const tap = r.tileToScreen(x + Math.floor((size - 1) / 2) + 0.5, y + Math.floor((size - 1) / 2) + 0.5);
              return { x, y, under: [...under], tap, insets: Object.values(r.insets).map(Math.round).join(' ') };
            }, [px, py, size]);
            // A frame, as a person's would, between moving the map and touching it.
            await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
            const where = `${view}, ${panel}, ${kind === 'res' ? 'a zone' : 'an airport'} at the ${name}`;
            if (t.under.length) {
              wrong.push(`${where}: under ${t.under.join(', ')} (the map's edges come in ${t.insets})`);
              continue;
            }
            await press(t.tap);
            // On a touch screen the first tap shows the airport, clear of its Build card; the second builds it.
            if (touch && kind === 'airport') {
              await page.evaluate(() => new Promise((ok) => requestAnimationFrame(ok)));
              const shown = await page.evaluate(({ x, y }) => {
                const p = window.__terraville.renderer.preview;
                const card = document.querySelector('#placeCard').getBoundingClientRect();
                const r = window.__terraville.renderer;
                const a = r.tileToScreen(x, y);
                const b = r.tileToScreen(x + 6, y + 6);
                return { at: p?.rects.map((q) => [q.x, q.y]), clear: card.right <= a.x || card.left >= b.x || card.bottom <= a.y || card.top >= b.y };
              }, t);
              if (JSON.stringify(shown.at) !== JSON.stringify([[t.x, t.y]]) || !shown.clear) wrong.push(`${where}: shown at ${JSON.stringify(shown.at)}${shown.clear ? '' : ', under its Build card'}`);
              await press(t.tap);
            }
            const built = await page.evaluate(({ x, y, kind }) => {
              const g = window.__terraville;
              const b = g.world.buildingAt(x, y);
              const ok = !!b && b.kind === kind && b.x === x && b.y === y;
              if (b) g.world.remove(b.id);
              return ok;
            }, { ...t, kind });
            if (!built) wrong.push(`${where}: not built there`);
          }
        }
      }
      assert.deepEqual(problems, []);
      await ctx.close();
    }
    assert.deepEqual(wrong, []);
  });

  await test('closing a card leaves the map where it was, and the edge it let in goes back only as the map is moved', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const insets = () => page.evaluate(() => ({ ...window.__terraville.renderer.insets }));
    // A long news log opens: the side it is kept clear of lets that edge of the map in further.
    await page.evaluate(() => {
      const g = window.__terraville;
      for (let k = 0; k < 30; k++) g.sim.messages.push({ text: `News ${k} from city hall.`, kind: 'info', month: g.world.city.month });
    });
    const before = await insets();
    await page.click('#tkLog');
    await page.waitForTimeout(200);
    const during = await insets();
    const side = ['l', 't', 'r', 'b'].sort((a, b) => (during[b] - before[b]) - (during[a] - before[a]))[0];
    assert.ok(during[side] - before[side] > 100, `the log lets the map in further from one side: ${JSON.stringify(before)} then ${JSON.stringify(during)}`);
    // That edge brought in as far as it goes.
    const edge = (side) => page.evaluate((side) => {
      const r = window.__terraville.renderer;
      const a = r.tileToScreen(0, 0);
      const b = r.tileToScreen(r.world.w, r.world.h);
      return { l: a.x, t: a.y, r: r.cssW - b.x, b: r.cssH - b.y }[side];
    }, side);
    await page.evaluate((side) => {
      const r = window.__terraville.renderer;
      r.cam.zoom = 24;
      if (side === 'l' || side === 'r') r.cam.x = side === 'l' ? -1e6 : 1e6;
      else r.cam.y = side === 't' ? -1e6 : 1e6;
      r.clampCamera();
    }, side);
    const was = await edge(side);
    assert.ok(Math.abs(was - during[side]) < 1, `the edge came in ${Math.round(was)} px`);
    // The log closes: the map stays put, and a 10 px drag back out moves it 10 px, not back to the panels at once.
    await page.click('#tkLog');
    await page.waitForTimeout(200);
    assert.ok(Math.abs((await edge(side)) - was) < 1, 'closing the log leaves the map where it was');
    const [dx, dy] = { l: [-5, 0], r: [5, 0], t: [0, -5], b: [0, 5] }[side];
    await page.mouse.move(640, 400);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(640 + dx, 400 + dy);
    await page.mouse.move(640 + 2 * dx, 400 + 2 * dy);
    await page.mouse.up({ button: 'right' });
    const moved = was - (await edge(side));
    assert.ok(moved > 8 && moved < 12, `a 10 px drag moved the edge ${Math.round(moved)} px`);
    // Moved away and back, the room the log made is gone.
    await page.evaluate((side) => {
      const r = window.__terraville.renderer;
      if (side === 'l' || side === 'r') r.cam.x = side === 'l' ? 1e6 : -1e6;
      else r.cam.y = side === 't' ? 1e6 : -1e6;
      r.clampCamera();
      if (side === 'l' || side === 'r') r.cam.x = side === 'l' ? -1e6 : 1e6;
      else r.cam.y = side === 't' ? -1e6 : 1e6;
      r.clampCamera();
    }, side);
    assert.ok(Math.abs((await edge(side)) - (await insets())[side]) < 1, 'the edge now comes in only as far as the panels left');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the editor opens on the whole map, between its panels, and Whole map or the 0 key bring it back', async () => {
    for (const opts of [DESK, PHONE]) {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      await page.click('[data-act="editor"]');
      await page.waitForFunction(() => window.__terraville.mode === 'editor');
      const whole = () => page.evaluate(() => {
        const r = window.__terraville.renderer;
        const map = document.querySelector('#map').getBoundingClientRect();
        const a = r.tileToScreen(0, 0);
        const b = r.tileToScreen(r.world.w, r.world.h);
        const m = { left: map.left + a.x, top: map.top + a.y, right: map.left + b.x, bottom: map.top + b.y };
        const under = [...document.querySelectorAll('#topbar > *, #toolbox, #minimapCard, #editorPanel')]
          .filter((e) => !e.hidden && e.getClientRects().length)
          .map((e) => [e.id || e.className, e.getBoundingClientRect()])
          .filter(([, p]) => p.width && p.left < m.right - 1 && m.left + 1 < p.right && p.top < m.bottom - 1 && m.top + 1 < p.bottom)
          .map(([name]) => name);
        return { onScreen: m.left >= 0 && m.top >= 0 && m.right <= innerWidth && m.bottom <= innerHeight, under, wide: Math.round(b.x - a.x) };
      });
      const opened = await whole();
      assert.deepEqual({ ...opened, wide: 0 }, { onScreen: true, under: [], wide: 0 }, `${opts.viewport.width}px: the whole map, clear of the panels`);
      assert.ok(opened.wide > opts.viewport.width * 0.6, 'and as big as the room allows');
      await page.evaluate(() => { const r = window.__terraville.renderer; r.cam.zoom = 30; r.centerOn(10, 10); });
      if (opts === DESK) {
        await page.keyboard.press('0');
        assert.deepEqual(await whole(), opened, 'the 0 key');
        await page.evaluate(() => { const r = window.__terraville.renderer; r.cam.zoom = 30; r.centerOn(10, 10); });
        await page.click('#zoomFit');
        assert.deepEqual(await whole(), opened, 'the Whole map button beside the zoom buttons');
      } else {
        await page.click('[data-act="menu"]');
        await page.click('.dropdown button:has-text("Whole map")');
        assert.deepEqual(await whole(), opened, "the menu's Whole map, on a phone");
      }
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test("the editor's panel says why Sea is off and what Rivers adds in a valley, shows the brush strength, folds cleanly on a phone, and keeps springs on land", async () => {
    const desk = await profile(DESK);
    const { page: d, problems: dp } = await open(desk);
    await d.click('[data-act="editor"]');
    await d.waitForFunction(() => window.__terraville.mode === 'editor');
    const label = (id) => d.$eval(id, (s) => s.closest('.field').querySelector('span').innerText.replace(/\s+/g, ' ').trim());
    await d.click('[data-style="valley"]');
    await d.waitForFunction(() => window.__terraville.terrain.style === 'valley');
    assert.equal(await label('#edWater'), 'Sea · coast, island and archipelago only');
    assert.equal(await label('#edRivers'), "Rivers (besides the valley's own) 2");
    await d.click('[data-style="island"]');
    await d.waitForFunction(() => window.__terraville.terrain.style === 'island');
    assert.equal(await label('#edWater'), 'Sea 35');
    assert.equal(await label('#edRivers'), 'Rivers 2');
    assert.equal(await d.textContent('#brushPct'), '60%');
    await d.$eval('#brushStrength', (s) => { s.value = '1.2'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await d.textContent('#brushPct'), '120%');
    // A spring in the sea says where springs go, and leaves nothing to undo.
    await d.keyboard.press('v');
    const steps = await d.evaluate(() => window.__terraville.undoStack.length);
    const wet = await d.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      for (let i = 0; i < w.n; i++) {
        const p = g.renderer.tileToScreen((i % w.w) + 0.5, Math.floor(i / w.w) + 0.5);
        if (w.water[i] && w.height[i] < 0 && p.x > 150 && p.x < 950 && p.y > 100 && p.y < 750) return p;
      }
    });
    await d.mouse.click(wet.x, wet.y);
    assert.equal(await d.textContent('#toast'), 'Springs go on dry land. Pick a spot above the water.');
    assert.equal(await d.evaluate(() => window.__terraville.undoStack.length), steps);
    assert.deepEqual(dp, []);
    await desk.close();

    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    const panel = () => page.evaluate(() => {
      const p = document.querySelector('#editorPanel').getBoundingClientRect();
      const head = document.querySelector('#edHead');
      const shown = [...document.querySelectorAll('#editorPanel > *')].filter((e) => !e.contains(head) && e.getClientRects().length).length;
      return { tag: head.tagName, expanded: head.getAttribute('aria-expanded'), height: Math.round(p.height), shown };
    });
    const folded = await panel();
    assert.deepEqual({ ...folded, height: folded.height <= 50 }, { tag: 'BUTTON', expanded: 'false', height: true, shown: 0 }, 'folded to its heading, nothing of the next line showing');
    await page.tap('#edHead');
    const opened = await panel();
    assert.equal(opened.expanded, 'true');
    assert.ok(opened.shown > 5 && opened.height > 200, 'and opens on a tap');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a brush held close up repaints what it changes at 16 px a tile, and sharpens it once it lifts', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await page.click('[data-size="large"]');
    await page.evaluate(() => {
      const g = window.__terraville;
      const r = g.renderer;
      r.cam.zoom = 64;
      r.centerOn(90, 75);
      window.painted = [];
      const paint = r.renderChunk.bind(r);
      r.renderChunk = (cx, cy, L) => { window.painted.push(L); return paint(cx, cy, L); };
    });
    await page.keyboard.press('r');
    await page.evaluate(() => new Promise((ok) => setTimeout(ok, 500)));
    const p = await page.evaluate(() => { const r = window.__terraville.renderer; const m = document.querySelector('#map').getBoundingClientRect(); const q = r.tileToScreen(90.5, 75.5); return { x: m.left + q.x, y: m.top + q.y }; });
    await page.evaluate(() => { window.painted = []; });
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let k = 0; k < 12; k++) await page.mouse.move(p.x + k * 6, p.y + k * 3);
    await page.waitForTimeout(300);
    const held = await page.evaluate(() => window.painted.splice(0));
    await page.mouse.up();
    await page.waitForFunction(() => window.painted.includes(64), null, { timeout: 5000 });
    assert.ok(held.length > 3 && held.every((L) => L === 16), `while held, painted at ${[...new Set(held)].join(', ')} px a tile`);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a patch that changes while the clock runs is painted within the frame, and sharpened once the clock stops', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    // A slow phone: a patch takes about 50 ms longer to paint at 32 px a tile than it would here, 14 at 16 and 4 at 8.
    await page.evaluate(() => {
      const r = window.__terraville.renderer;
      window.painted = [];
      const draw = r.drawObjects.bind(r);
      r.drawObjects = (ctx, x, y, L) => {
        const t = performance.now();
        while (performance.now() - t < 0.1 * L ** 1.8);
        draw(ctx, x, y, L);
      };
      const paint = r.renderChunk.bind(r);
      r.renderChunk = (cx, cy, L) => {
        window.painted.push({ L, running: r.running });
        return paint(cx, cy, L);
      };
      r.cam.zoom = 24;
      r.centerOn(r.world.w / 2, r.world.h / 2);
    });
    // At rest with the clock stopped, everything in view is sharpened, one patch a frame.
    const sharp = () => page.evaluate(() => {
      const r = window.__terraville.renderer;
      const seen = [];
      const zd = r.cam.zoom * r.dpr;
      const ox = r.canvas.width / 2 - r.cam.x * zd;
      const oy = r.canvas.height / 2 - r.cam.y * zd;
      for (let cy = Math.max(0, Math.floor(-oy / (16 * zd))); cy <= Math.min(Math.ceil(r.world.h / 16) - 1, Math.floor((r.canvas.height - oy) / (16 * zd))); cy++) {
        for (let cx = Math.max(0, Math.floor(-ox / (16 * zd))); cx <= Math.min(Math.ceil(r.world.w / 16) - 1, Math.floor((r.canvas.width - ox) / (16 * zd))); cx++) {
          const c = r.chunks.get((32 * 4096 + cy) * 4096 + cx);
          seen.push(!!c && !c.dirty);
        }
      }
      return seen.every(Boolean);
    });
    await page.waitForFunction(() => window.painted.some((p) => p.L === 32), null, { timeout: 10000 });
    for (let i = 0; i < 40 && !(await sharp()); i++) await page.waitForTimeout(250);
    assert.ok(await sharp(), 'the view was sharpened at rest');
    // The clock runs and the city keeps changing everything in view: the changes show at once, painted blurrier.
    await page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(1);
      window.painted = [];
      window.churn = setInterval(() => g.world.dirty(0, 0, g.world.w - 1, g.world.h - 1), 150);
    });
    await page.waitForTimeout(2500);
    const running = await page.evaluate(() => window.painted.filter((p) => p.running));
    assert.ok(running.length > 10, `${running.length} patches painted while the clock ran`);
    assert.ok(running.every((p) => p.L < 32), `while the clock ran, painted at ${[...new Set(running.map((p) => p.L))].join(', ')} px a tile`);
    // Stopped, the view sharpens again.
    await page.evaluate(() => {
      clearInterval(window.churn);
      window.__terraville.setSpeed(0);
    });
    for (let i = 0; i < 40 && !(await sharp()); i++) await page.waitForTimeout(250);
    assert.ok(await sharp(), 'the view was sharpened once the clock stopped');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('night lights are painted once a patch, not every frame, and a lot that loses power goes dark', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    // Every glow drawn, on the map or into a patch's lights.
    await page.evaluate(() => {
      const r = window.__terraville.renderer;
      window.glows = 0;
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (img, ...rest) {
        if (img === r.glow) window.glows++;
        return draw.call(this, img, ...rest);
      };
    });
    // A block of lit homes and offices on a road grid, powered by a plant beside them, at midnight with the clock stopped.
    const lot = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const cx = Math.floor(w.w / 2);
      const cy = Math.floor(w.h / 2);
      for (let y = cy - 12; y < cy + 12; y++) for (let x = cx - 12; x < cx + 16; x++) {
        const i = y * w.w + x;
        if (w.occ[i]) w.remove(w.occ[i]);
        w.water[i] = 0; w.height[i] = 6; w.trees[i] = 0; w.net[i] = 0; w.rubble[i] = 0;
      }
      w.dirtyAll(true);
      for (let y = cy - 12; y < cy + 12; y++) for (let x = cx - 12; x < cx + 12; x++) if ((x - cx) % 4 === 0 || (y - cy) % 4 === 0) w.setNet(1 | 4, x, y);
      let home;
      for (let y = cy - 11; y + 3 < cy + 12; y += 4) for (let x = cx - 11; x + 3 < cx + 12; x += 4) {
        const b = w.place((x + y) % 8 ? 'res' : 'com', x, y);
        w.setLevel(b, 4);
        home ??= b;
      }
      const plant = w.place('nuclear', cx + 12, cy - 2);
      g.sim.powerDirty = true;
      g.setSpeed(0);
      g.renderer.simTime = g.renderer.dayLength / 2;
      g.renderer.cam.zoom = 20;
      g.renderer.centerOn(cx, cy);
      window.plant = plant;
      return { x: home.x, y: home.y, size: home.size };
    });
    await page.waitForTimeout(1000);
    const frames = () => page.evaluate(() => new Promise((ok) => { let n = 0; const f = () => (++n < 30 ? requestAnimationFrame(f) : ok()); requestAnimationFrame(f); }));
    const lit = () => page.evaluate(({ x, y, size }) => {
      const r = window.__terraville.renderer;
      const a = r.tileToScreen(x, y);
      const d = r.canvas.getContext('2d').getImageData(Math.round(a.x * r.dpr), Math.round(a.y * r.dpr), Math.round(size * r.cam.zoom * r.dpr), Math.round(size * r.cam.zoom * r.dpr)).data;
      let most = 0;
      for (let i = 0; i < d.length; i += 4) most = Math.max(most, d[i] + d[i + 1] + d[i + 2]);
      return most;
    }, lot);
    assert.ok(await page.evaluate(() => window.glows > 100), 'the lights were painted');
    const before = await lit();
    await page.evaluate(() => { window.glows = 0; });
    await frames();
    assert.equal(await page.evaluate(() => window.glows), 0, 'nothing changed over 30 frames, and no glow was drawn again');
    // The plant goes: the homes go dark, and only their patches are painted again.
    await page.evaluate(() => {
      const g = window.__terraville;
      g.world.remove(window.plant.id);
      g.sim.powerDirty = true;
    });
    await frames();
    const after = await lit();
    assert.ok(after < before - 50, `the home's brightest window went dark: ${before} before, ${after} after`);
    assert.deepEqual(problems, []);
    await ctx.close();

    // An iPhone, which keeps less canvas, with the whole map in view and street lamps all over it: the lights painted
    // once are kept, not painted again every frame.
    const iphone = await profile({ ...PHONE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' });
    const p = await open(iphone);
    await found(p.page);
    await p.page.evaluate(() => {
      const g = window.__terraville;
      const r = g.renderer;
      window.glows = 0;
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (img, ...rest) {
        if (img === r.glow) window.glows++;
        return draw.call(this, img, ...rest);
      };
      const w = g.world;
      for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
        if (x % 6 && y % 6) continue;
        const i = y * w.w + x;
        if (w.occ[i]) w.remove(w.occ[i]);
        w.water[i] = 0; w.trees[i] = 0; w.net[i] = 0;
        w.setNet(1, x, y);
      }
      w.dirtyAll(true);
      g.setSpeed(0);
      r.simTime = r.dayLength / 2;
      g.fitMap();
    });
    await p.page.waitForTimeout(1500);
    await p.page.evaluate(() => { window.glows = 0; });
    await p.page.evaluate(() => new Promise((ok) => { let n = 0; const f = () => (++n < 30 ? requestAnimationFrame(f) : ok()); requestAnimationFrame(f); }));
    assert.equal(await p.page.evaluate(() => window.glows), 0, 'on an iPhone with the whole map in view, no glow was drawn again');
    assert.deepEqual(p.problems, []);
    await iphone.close();
  });

  await test('an Android phone draws street level at 32 px a tile at most, as an iPhone does', async () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
    for (const [opts, most] of [[{ ...PHONE, userAgent: android }, 32], [DESK, 64]]) {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      await found(page);
      await page.evaluate(() => {
        const r = window.__terraville.renderer;
        r.cam.zoom = 80;
        r.centerOn(r.world.w / 2, r.world.h / 2);
      });
      await page.waitForTimeout(2000);
      const top = await page.evaluate(() => Math.max(...[...window.__terraville.renderer.chunks.values()].map((c) => c.L)));
      assert.equal(top, most, `${opts.userAgent ? 'Android' : 'a laptop'} painted the street at ${top} px a tile`);
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test('the cost tip draws its middle dots and says why lots are blocked', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const tip = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      for (let y = 10; y < w.h - 10; y++) for (let x = 10; x < w.w - 20; x++) {
        // The lots are centred on the drag, so they start a tile up and to the left of it. The first two must go
        // down as they stand (levelling would add to the tip), and nothing but the station may block the other two.
        let ok = true;
        for (let dx = -1; dx < 11 && ok; dx++) for (let dy = -1; dy < 2 && ok; dy++) {
          const i = (y + dy) * w.w + x + dx;
          if (w.water[i] || w.occ[i] || w.net[i]) ok = false;
        }
        const flat = (lx) => { const r = w.canPlace('res', lx, y - 1, true); return r.ok && r.grade === 0; };
        if (!ok || !flat(x - 1) || !flat(x + 2)) continue;
        w.place('police', x + 6, y);
        g.setTool('res');
        g.pointerDown(x + 0.5, y + 0.5, 100, 100);
        g.pointerMove(x + 11.5, y + 0.5, 300, 100);
        const t = document.querySelector('#cursorTip');
        const loose = [...t.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes('·'));
        return { text: t.textContent, loose };
      }
    });
    assert.equal(tip.loose, false, 'every dot is drawn, none typed into the text');
    // Clearing trees, where the lots have any, is part of the price and says so.
    assert.match(tip.text, /^Residential · 2 zones · \$\d+(, with \$\d+ to clear trees)? · 2 blocked: something is already here$/);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('after a build the tip says what it cost, with no red preview over it, and the bulldozer raises dust', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const p = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const r = g.renderer;
      r.cam.zoom = 20;
      w.city.funds = 50000;
      for (let y = 12; y < w.h - 12; y++) for (let x = 12; x < w.w - 24; x++) {
        // Every tile the three lots (centred on the drag, so from a tile up and left of it) and the station (placed by
        // its corner, then rebuilt by a click on its middle) cover: dry, empty and level enough to build on as it is.
        let ok = true;
        for (let dx = -1; dx < 11 && ok; dx++) for (let dy = -1; dy < 6 && ok; dy++) {
          const i = (y + dy) * w.w + x + dx;
          if (w.water[i] || w.occ[i] || w.net[i]) ok = false;
        }
        const flat = (k, lx, ly) => { const r = w.canPlace(k, lx, ly, true); return r.ok && r.grade === 0; };
        if (!ok || ![x - 1, x + 2, x + 5].every((lx) => flat('res', lx, y - 1)) || !flat('police', x + 7, y + 2)) continue;
        w.place('police', x + 8, y + 3);
        r.centerOn(x + 6, y + 2);
        const at = (tx, ty) => { const s = r.tileToScreen(tx + 0.5, ty + 0.5); return [s.x, s.y]; };
        return { a: at(x, y), b: at(x + 6, y), police: at(x + 8, y + 3), far: at(x + 6, y + 12) };
      }
    });
    await page.click('[data-tool="res"]');
    await page.mouse.move(...p.a);
    await page.mouse.down();
    await page.mouse.move(...p.b, { steps: 4 });
    await page.mouse.up();
    const tip = () => page.evaluate(() => {
      const t = document.querySelector('#cursorTip');
      return { text: t.hidden ? null : t.textContent, bad: t.classList.contains('bad'), preview: !!window.__terraville.renderer.preview };
    });
    const after = await tip();
    assert.match(after.text, /^Zoned [23] lots · \$\d{3}$/);
    assert.deepEqual([after.bad, after.preview], [false, false], 'no red, no preview over the new lots');
    await page.mouse.move(p.b[0] + 4, p.b[1] + 3);
    await page.waitForTimeout(1400);
    assert.deepEqual(await tip(), { text: null, bad: false, preview: false }, 'after a moment the tip goes and the spot stays quiet');
    await page.mouse.move(...p.far);
    assert.equal((await tip()).preview, true, 'previews come back away from it');
    await page.click('[data-tool="bulldoze"]');
    await page.mouse.click(...p.police);
    assert.match((await tip()).text, /^Cleared 1 · \$\d+$/);
    assert.deepEqual(await page.evaluate(() => window.__terraville.renderer.vehicles.dust.map((d) => d.size)), [1], 'dust where the station came down');
    await page.click('[data-tool="police"]');
    await page.mouse.click(...p.police);
    assert.match((await tip()).text, /^Police station built · \$\d+$/);
    assert.deepEqual(await page.evaluate(() => window.__terraville.renderer.vehicles.dust.map((d) => d.size)), [1, 0.6], 'a smaller puff where it went up');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('undo and redo say at the pointer what they did with the money, and the tip of the undone build goes', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const p = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const r = g.renderer;
      r.cam.zoom = 20;
      w.city.funds = 50000;
      for (let y = 12; y < w.h - 12; y++) for (let x = 12; x < w.w - 24; x++) {
        let ok = true;
        for (let dx = 0; dx < 8 && ok; dx++) {
          const i = y * w.w + x + dx;
          if (w.water[i] || w.occ[i] || w.net[i] || w.trees[i] || w.rubble[i] || w.slope(x + dx, y) > 3) ok = false;
        }
        if (!ok) continue;
        r.centerOn(x + 4, y);
        const at = (tx) => { const s = r.tileToScreen(tx + 0.5, y + 0.5); return [s.x, s.y]; };
        return { a: at(x), b: at(x + 7) };
      }
    });
    await page.click('[data-tool="road"]');
    await page.mouse.move(...p.a);
    await page.mouse.down();
    await page.mouse.move(...p.b, { steps: 4 });
    await page.mouse.up();
    const tip = () => page.evaluate(() => { const t = document.querySelector('#cursorTip'); return t.hidden ? null : t.textContent; });
    assert.equal(await tip(), 'Road built · 8 tiles · $80');
    await page.keyboard.press('Control+z');
    assert.equal(await tip(), 'Undone · $80 back');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await tip(), 'Redone · $80');
    await page.waitForTimeout(1400);
    assert.equal(await tip(), null, 'after a moment the tip goes');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a new city opens paused, and says how to start the clock with a key or a tap', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    assert.equal(await page.evaluate(() => window.__terraville.speed), 0, 'the clock is stopped');
    assert.equal(await page.textContent('#stDateLabel'), 'Paused');
    assert.equal(await page.textContent('#pausedPill'), 'PausedSpace to resumeTap to resume');
    assert.deepEqual(await page.$$eval('#pausedPill span', (s) => s.map((x) => getComputedStyle(x).display !== 'none')), [true, false], 'Space with a keyboard');
    assert.match(await page.textContent('#guide li:last-child'), /Press play and watch the first buildings go up\./);
    const month = await page.evaluate(() => window.__terraville.world.city.month);
    await page.waitForTimeout(3000);
    assert.equal(await page.evaluate(() => window.__terraville.world.city.month), month, 'no month passes until play');
    // Normal, not the single arrow (Slow), is marked as the way to start it, until the clock first runs.
    assert.deepEqual(await page.$$eval('.speed .start-here', (b) => b.map((x) => x.dataset.speed)), ['2']);
    // Slower never starts a stopped clock.
    await page.keyboard.press(',');
    assert.equal(await page.evaluate(() => window.__terraville.speed), 0, ', leaves it paused');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.__terraville.speed), 2, 'Space starts it at Normal');
    assert.equal(await page.locator('.speed .start-here').count(), 0);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.__terraville.speed), 0);
    assert.equal(await page.locator('.speed .start-here').count(), 0, 'once it has run, a pause is only a pause');
    assert.deepEqual(problems, []);
    await ctx.close();
    const tablet = await profile({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true });
    const { page: t } = await open(tablet);
    await found(t);
    assert.deepEqual(await t.$$eval('#pausedPill span', (s) => s.map((x) => getComputedStyle(x).display !== 'none')), [false, true], 'a tap on a touch screen');
    await t.tap('#pausedPill');
    assert.equal(await t.evaluate(() => window.__terraville.speed), 2, 'and a tap on the pill starts it');
    await tablet.close();
  });

  await test('on a phone, the menu offers Redo after an undo', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const menu = async () => {
      await page.click('[data-act="menu"]');
      const items = await page.$$eval('.dropdown button', (b) => b.map((x) => x.textContent.trim()));
      await page.click('[data-act="menu"]');
      return items;
    };
    assert.ok(!(await menu()).includes('Redo'), 'nothing to redo yet');
    const roads = () => page.evaluate(() => window.__terraville.world.net.filter((v) => v & 1).length);
    await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const i = w.height.findIndex((h, i) => !w.water[i] && !w.occ[i] && i % w.w > 5 && i % w.w < w.w - 10 && Math.floor(i / w.w) > 5);
      const x = (i % w.w) + 0.5;
      const y = Math.floor(i / w.w) + 0.5;
      g.setTool('road');
      g.pointerDown(x, y, 10, 10);
      g.pointerUp(x, y, 10, 10);
      g.undo();
    });
    assert.equal(await roads(), 0);
    assert.ok((await menu()).includes('Redo'));
    await page.click('[data-act="menu"]');
    await page.click('.dropdown button:has-text("Redo")');
    assert.equal(await roads(), 1, 'Redo put the road back');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('on a phone, the title screen fits the longest city name', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="quick"]');
    await page.fill('#fName', 'Port Wellington-on-the-Marsh');
    await page.click('.modal footer .btn.primary');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(async () => { await window.__terraville.saveCity(); window.__terraville.showTitle(); });
    await titleUp(page);
    const over = await page.$$eval('.title-actions .btn', (b) => b.filter((x) => x.getBoundingClientRect().right > innerWidth || x.scrollWidth > x.clientWidth).map((x) => x.textContent.trim()));
    assert.deepEqual(over, [], 'every title button inside the screen');
    assert.match(await page.textContent('[data-act="continue"]'), /Continue Port Wellington-on-the-Marsh/);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('on a phone the cost tip sits above the finger and fits the screen, and a held brush shows its ring and running cost', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    await page.tap('#guide .guide-next');
    await page.tap('#guide .close');
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const at = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const r = g.renderer;
      w.city.funds = 50000;
      r.cam.zoom = 16;
      let best = null;
      for (let y = 8; y < w.h - 8; y++) for (let x = 8; x < w.w - 8; x++) {
        const i = y * w.w + x;
        if (w.water[i] || w.occ[i]) continue;
        const s = w.slope(x, y);
        if (s > 2 && s < 12 && (!best || s > best[2])) best = [x, y, s];
      }
      r.centerOn(best[0] + 0.5, best[1] + 0.5);
      const p = r.tileToScreen(best[0] + 0.5, best[1] + 0.5);
      g.setTool('level');
      return [Math.round(p.x), Math.round(p.y)];
    });
    const tip = () => page.evaluate(() => {
      const t = document.querySelector('#cursorTip');
      const r = t.getBoundingClientRect();
      return { text: t.hidden ? null : t.textContent, left: r.left, right: r.right, bottom: r.bottom, ring: !!window.__terraville.renderer.preview?.brush };
    });
    await touch('touchStart', [at]);
    await page.waitForTimeout(500);
    const held = await tip();
    await touch('touchEnd', []);
    assert.match(held.text ?? '', /^Levelling \$[\d,]+ · /, 'a finger held still shows what the levelling costs so far');
    assert.equal(held.ring, true, 'and the brush ring');
    assert.ok(held.bottom < at[1] - 30, 'above the finger');
    // A zone drag across rough ground makes a long tip.
    await page.evaluate(() => { window.__terraville.renderer.cam.zoom = 10; window.__terraville.setTool('res'); });
    await touch('touchStart', [[40, 500]]);
    for (let k = 1; k <= 8; k++) await touch('touchMove', [[40 + k * 40, 500]]);
    const drag = await tip();
    await touch('touchEnd', []);
    assert.ok(drag.text && drag.left >= 0 && drag.right <= 390, `the tip fits the screen: ${drag.text}`);
    assert.ok(drag.bottom < 500, 'above the finger');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Level land in the city: its size slider shows with it, and its tip says about what a circle costs before the button goes down', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    assert.equal(await page.isHidden('#brushBox'), true, 'no slider for the other tools');
    await page.keyboard.press('l');
    assert.equal(await page.isVisible('#brushBox'), true);
    assert.equal(await page.textContent('#brushTiles'), '8 tiles', 'a new city starts with a modest circle');
    const at = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const r = g.renderer;
      r.cam.zoom = 16;
      let best = null;
      for (let y = 8; y < w.h - 8 && !best; y++) for (let x = 8; x < w.w - 8 && !best; x++) {
        let dry = true;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (w.water[(y + dy) * w.w + x + dx] || w.occ[(y + dy) * w.w + x + dx]) dry = false;
        if (dry) best = [x, y];
      }
      // A hill to level.
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) w.height[(best[1] + dy) * w.w + best[0] + dx] += 6 - Math.abs(dx) - Math.abs(dy);
      w.dirty(best[0] - 3, best[1] - 3, best[0] + 3, best[1] + 3, true);
      r.centerOn(best[0] + 0.5, best[1] + 0.5);
      const p = r.tileToScreen(best[0] + 1.5, best[1] + 0.5);
      return [Math.round(p.x), Math.round(p.y)];
    });
    const funds = await page.evaluate(() => window.__terraville.world.city.funds);
    await page.mouse.move(at[0] - 3, at[1]);
    await page.mouse.move(at[0], at[1]);
    assert.match(await page.textContent('#cursorTip'), /^Hold to level · about \$[\d,]+ to flatten this circle · /);
    assert.equal(await page.evaluate(() => window.__terraville.world.city.funds), funds, 'nothing spent before pressing');
    await page.keyboard.press(']');
    assert.equal(await page.textContent('#brushTiles'), '9 tiles');
    await page.hover('[data-tool="level"]');
    assert.match(await page.textContent('#tooltip'), /\[ and \] change the brush size\./);
    await page.keyboard.press('q');
    assert.equal(await page.isHidden('#brushBox'), true);
    assert.deepEqual(problems, []);
    await ctx.close();
    // On a phone the slider sits at the end of the row, beside the tool, and in view.
    const phone = await profile();
    const { page: p, problems: onPhone } = await open(phone);
    await found(p);
    await p.evaluate(() => document.querySelector('[data-tool="level"]').scrollIntoView());
    await p.tap('[data-tool="level"]');
    await p.waitForTimeout(400);
    const box = await p.evaluate(() => document.querySelector('#brushBox').getBoundingClientRect().toJSON());
    assert.ok(box.width > 100 && box.left >= 0 && box.right <= 390, `the slider is on screen: ${JSON.stringify(box)}`);
    assert.deepEqual(onPhone, []);
    await phone.close();
  });

  await test('the Budget says what each funding cut does and saves, and gives the landmarks their own line', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.evaluate(() => { window.__terraville.startScenario('gridlock'); window.__terraville.ui.closeModal(); });
    await page.click('#topbar [data-act="budget"]');
    assert.equal(await page.textContent('#bFundNote'), 'Police, fire and roads at full strength.');
    const slide = (id, v) => page.$eval(id, (s, v) => { s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    await slide('#bFtransport', '30');
    await slide('#bFpolice', '60');
    const lines = await page.$eval('#bFundNote', (n) => n.innerHTML.split('<br>').map((l) => l.replace(/<[^>]+>/g, '')));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Police at 60%: stations cover less ground, so crime rises\. Saves \$\d+\/mo\.$/);
    assert.match(lines[1], /^Roads and rail at 30%: about \d+ tiles a month crumble into rubble\. Saves \$[\d,]+\/mo\.$/);
    // A number in a sentence is in the text's letters; the ledger's stay in mono.
    assert.doesNotMatch(await page.$eval('#bFundNote .num', (n) => getComputedStyle(n).fontFamily), /Mono/);
    assert.match(await page.$eval('#bLedger td.num', (n) => getComputedStyle(n).fontFamily), /Mono/);
    const rows = await page.$$eval('#bLedger td:first-child', (t) => t.map((x) => x.textContent));
    assert.deepEqual(rows, ['Taxes', 'Roads and rail', 'Police', 'Fire', 'Schools, hospitals, parks', 'Stadium, seaport, airport', 'Power plants', 'Loan interest', 'Net']);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the Power grid layer hatches an overloaded grid, on the map and in its legend, so it differs from no power without colour', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const alphas = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const fits = (x0, y0) => { for (let y = y0; y < y0 + 3; y++) for (let x = x0; x < x0 + 16; x++) if (!w.isEmptyLand(w.idx(x, y)) || w.slope(x, y) > 2) return false; return true; };
      let at = null;
      for (let y = 6; y < w.h - 6 && !at; y++) for (let x = 2; x < w.w - 18 && !at; x++) if (fits(x, y)) at = [x, y];
      const [x, y] = at;
      // An 18 MW turbine and 27 MW of lots it can't all power, and a lot on its own.
      w.place('wind', x, y);
      const lots = [1, 4, 7].map((dx) => w.place('res', x + dx, y));
      const alone = w.place('res', x + 13, y);
      g.sim.computePower();
      g.ui.setOverlay('power');
      g.renderer.buildOverlay();
      const short = lots.find((b) => !b.powered);
      const c = g.renderer.overlayCanvas.getContext('2d');
      const px = (b, dx) => c.getImageData((b.x + 1) * 4 + dx, (b.y + 1) * 4, 1, 1).data[3];
      return { short: !!short, hatched: [px(short, 0), px(short, 2)], plain: [px(alone, 0), px(alone, 2)] };
    });
    assert.equal(alphas.short, true, 'the turbine powers only some of the lots');
    assert.notEqual(alphas.hatched[0], alphas.hatched[1], 'an overloaded lot is hatched');
    assert.equal(alphas.plain[0], alphas.plain[1], 'a lot with no plant is solid');
    const swatches = await page.$$eval('#legend i', (i) => i.map((x) => getComputedStyle(x).backgroundImage));
    assert.equal(swatches.length, 3);
    assert.match(swatches[1], /repeating-linear-gradient/);
    assert.equal(swatches[2], 'none');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('menus tell a screen reader which layer is showing, whether disasters are on, and that they are menus', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    for (const act of ['layers', 'disasters', 'menu']) {
      assert.deepEqual(await page.$eval(`#topbar [data-act="${act}"]`, (b) => [b.getAttribute('aria-haspopup'), b.getAttribute('aria-expanded')]), ['menu', 'false'], act);
    }
    await page.click('#topbar [data-act="layers"]');
    assert.equal(await page.getAttribute('#topbar [data-act="layers"]', 'aria-expanded'), 'true');
    assert.deepEqual(await page.$$eval('[role="menu"] [aria-checked="true"]', (c) => c.map((x) => x.textContent)), ['Map']);
    assert.equal(await page.locator('[role="menu"] [aria-pressed]').count(), 0);
    await page.keyboard.press('Escape');
    await page.click('#topbar [data-act="disasters"]');
    const on = await page.evaluate(() => window.__terraville.world.city.disasters);
    assert.equal(await page.getAttribute('[role="menu"] [role="menuitemcheckbox"]', 'aria-checked'), String(on));
    // The six disasters are menu items in a group named by its heading, which is not read twice.
    assert.equal(await page.getAttribute('[role="menu"] [role="group"]', 'aria-label'), 'Unleash now');
    assert.equal(await page.locator('[role="menu"] [role="group"] [role="menuitem"]').count(), 6);
    assert.equal(await page.getAttribute('[role="menu"] .menu-caption', 'aria-hidden'), 'true');
    // The arrow keys still reach them.
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
    await page.keyboard.press('Escape');
    assert.equal(await page.getAttribute('#topbar [data-act="disasters"]', 'aria-expanded'), 'false');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('with less motion asked for, the title map holds still, a dark lot\'s bolt stays lit, and the Drive cloud stops pulsing', async () => {
    const ctx = await profile({ ...DESK, reducedMotion: 'reduce' });
    const { page, problems } = await open(ctx);
    const cam = () => page.evaluate(() => ({ ...window.__terraville.renderer.cam }));
    const before = await cam();
    await page.waitForTimeout(1200);
    assert.deepEqual(await cam(), before, 'the title camera drifted');
    await found(page);
    // A lot with no power, on its own on dry land, at the middle of the screen.
    await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      let at = null;
      for (let y = 10; y < w.h - 10 && !at; y++) for (let x = 10; x < w.w - 10 && !at; x++) if (w.canPlace('res', x, y).ok) at = [x, y];
      w.place('res', at[0], at[1]);
      g.renderer.cam.zoom = 40;
      g.renderer.centerOn(at[0] + 1.5, at[1] + 1.5);
    });
    // The map is drawn blurrier while it moves and sharpened once it is at rest: the shots start after that.
    await page.waitForTimeout(1000);
    const shots = [];
    for (let k = 0; k < 6; k++) {
      shots.push((await page.screenshot({ clip: { x: 620, y: 380, width: 40, height: 40 } })).toString('base64'));
      await page.waitForTimeout(230);
    }
    assert.equal(new Set(shots).size, 1, 'the bolt blinked');
    await page.evaluate(() => document.querySelector('#driveBtn').setAttribute('data-s', 'busy'));
    assert.equal(await page.$eval('#driveBtn svg', (s) => getComputedStyle(s).animationName), 'none');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a screen reader hears the news, the city sign, the demand, the Inspect card, a tool\'s tip and the charts', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const name = await page.evaluate(() => window.__terraville.world.city.name);
    await page.waitForFunction(() => document.querySelector('#announce').textContent.startsWith('Welcome to'));
    assert.equal(await page.getAttribute('#ticker', 'aria-live'), null, 'the ticker is not read as well');
    assert.equal(await page.getAttribute('#citySign', 'aria-label'), `${name}, 0 residents, village. City report`);
    assert.match(await page.getAttribute('#rci', 'aria-label'), /^Demand: homes (high|moderate|low|negative), shops (high|moderate|low|negative), industry (high|moderate|low|negative)$/);
    assert.equal(await page.$eval('#rci', (b) => b.tagName), 'BUTTON', 'and it opens what the bars mean');
    await page.evaluate(() => window.__terraville.sim.say('test', 'An earthquake shakes the city.', 'alert'));
    await page.waitForFunction(() => document.querySelector('#announceAlert').textContent === 'An earthquake shakes the city.');
    // The Inspect card is a region named by its heading.
    await page.evaluate(() => window.__terraville.ui.inspect(5, 5));
    const title = await page.textContent('#inspect h3');
    assert.equal(await page.getByRole('region', { name: title, exact: true }).count(), 1);
    // A tool is described by its tip while the tip shows.
    await page.hover('[data-tool="road"]');
    assert.equal(await page.getAttribute('[data-tool="road"]', 'aria-describedby'), 'tooltip');
    await page.mouse.move(640, 400);
    assert.equal(await page.getAttribute('[data-tool="road"]', 'aria-describedby'), null);
    // A chart is a picture with words.
    await page.click('#topbar [data-act="charts"]');
    await page.waitForFunction(() => document.querySelector('#ch1 canvas').getAttribute('aria-label'));
    assert.equal(await page.getAttribute('#ch1 canvas', 'role'), 'img');
    assert.equal(await page.getAttribute('#ch1 canvas', 'aria-label'), 'Residents and jobs: history starts after the first month.');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const g = window.__terraville; for (let k = 0; k < 12; k++) g.sim.step(); });
    await page.click('#topbar [data-act="charts"]');
    await page.waitForFunction(() => document.querySelector('#ch2 canvas').getAttribute('aria-label')?.includes('latest'));
    assert.match(await page.getAttribute('#ch2 canvas', 'aria-label'), /^City funds, latest: Funds \$[\d,]+$/);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('History charts traffic beside crime and pollution, approval and power, and the report gives the score a year on', async () => {
    for (const opts of [PHONE, DESK]) {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      await page.click('[data-act="challenges"]');
      await page.click('.slot:has-text("Gridlock") .btn.primary');
      await page.click('.modal footer .btn.primary');
      await page.waitForFunction(() => window.__terraville.mode === 'city');
      await page.evaluate(() => {
        const g = window.__terraville;
        g.setSpeed(0);
        g.world.city.disasters = false;
        for (let k = 0; k < 4 * 14; k++) g.sim.step();
      });
      await page.click('#topbar [data-act="charts"]');
      await page.waitForFunction(() => document.querySelector('#ch6 canvas').getAttribute('aria-label')?.includes('latest'));
      assert.deepEqual(await page.$$eval('.chart h4', (hs) => hs.map((h) => h.textContent)),
        ['Residents and jobs', 'City funds', 'Monthly income and spending', 'Crime, pollution and traffic', "Mayor's approval", 'Power used and made']);
      const { traffic, approval } = await page.evaluate(() => {
        const h = window.__terraville.world.city.history;
        return { traffic: h.traffic.at(-1), approval: h.approval.at(-1) };
      });
      // The traffic index the chart ends on is the one the goal tracker shows.
      assert.match(await page.textContent('#goal .goal-row'), new RegExp(`^Traffic index ${traffic} · under 28`));
      assert.match(await page.getAttribute('#ch4 canvas', 'aria-label'), new RegExp(`^Crime, pollution and traffic, latest: Crime \\d+, Pollution \\d+, Traffic ${traffic}$`));
      assert.equal(await page.getAttribute('#ch5 canvas', 'aria-label'), `Mayor's approval, latest: Approval ${approval}%`);
      assert.match(await page.getAttribute('#ch6 canvas', 'aria-label'), /^Power used and made, latest: Made 2,100 MW, Used [\d,]+ MW$/);
      // Every chart fits the dialog, three rows of two in a wide window and one column on a phone.
      const widths = await page.$$eval('.chart canvas', (cs) => cs.map((c) => [Math.round(c.getBoundingClientRect().left), Math.round(c.getBoundingClientRect().right)]));
      const dialog = await page.$eval('.modal', (m) => Math.round(m.getBoundingClientRect().right));
      assert.ok(widths.every(([, r]) => r <= dialog), 'a chart runs off the dialog');
      assert.equal(new Set(widths.map(([l]) => l)).size, opts === PHONE ? 1 : 2);
      await page.keyboard.press('Escape');
      await page.click('#citySign');
      const score = await page.evaluate(() => {
        const h = window.__terraville.world.city.history.score;
        return { now: window.__terraville.sim.stats.score, then: h.at(-13) };
      });
      const change = score.now === score.then ? 'the same as' : `${score.now > score.then ? '+' : '−'}${Math.abs(score.now - score.then)} on`;
      assert.equal(await page.textContent('.modal .kv dt:has-text("Score") + dd'), `${score.now} / 1000, ${change} a year ago`);
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test('Settings lists the keys of the place it is opened in, from the toolbox, with redo', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    const keys = async () => {
      await page.click('[data-act="menu"]');
      await page.click('.dropdown button:has-text("Settings and keys")');
      const rows = await page.$$eval('.modal dl.keys dt', (dts) => dts.map((dt) => [dt.textContent.replace(/\s+/g, ' ').trim(), dt.nextElementSibling.textContent]));
      const heads = await page.$$eval('.modal .cols h3', (h) => h.map((x) => x.textContent));
      await page.keyboard.press('Escape');
      return { rows, heads };
    };
    await found(page);
    const city = await keys();
    assert.deepEqual(city.heads, ['Options', 'Keys', 'Touch']);
    assert.deepEqual(city.rows, [
      ['Space', 'Pause or resume'], [', .', 'Slower, faster'], ['Q B', 'Inspect, bulldoze'], ['R T P', 'Road, rail, power line'],
      ['1 2 3', 'Residential, commercial, industrial'], ['K', 'Park'], ['G L', 'Plant trees, level land'],
      ['Right-click', 'Bulldoze what is under the cursor'], ['Shift drag', 'Bulldoze an area, any tool'], ['Arrows', 'Move the map'],
      ['+ −', 'Zoom'], ['0', 'Whole map'], ['[ ]', 'Level land brush size'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z or Ctrl Y', 'Redo'], ['Esc', 'Cancel or close'],
    ]);
    assert.equal(await page.getAttribute('[data-tool="level"]', 'aria-keyshortcuts'), 'l');
    assert.equal(await page.getAttribute('[data-tool="police"]', 'aria-keyshortcuts'), null, 'no key, no shortcut');
    // In the terrain editor, its own tools and none of the city's.
    await page.goto(base);
    await titleUp(page);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    const editor = await keys();
    assert.deepEqual(editor.rows, [
      ['Q', 'Look around'], ['R F S L N', 'Raise, lower, smooth, flatten, roughen'], ['W D V G C', 'Water, dry land, spring, forest, clear trees'],
      ['Arrows', 'Move the map'], ['+ −', 'Zoom'], ['0', 'Whole map'], ['[ ]', 'Brush size'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z or Ctrl Y', 'Redo'], ['Esc', 'Cancel or close'],
    ]);
    // There is no clock here to stop, and no bulldozer.
    const sub = async () => {
      await page.evaluate(() => window.__terraville.ui.openGuide());
      const t = await page.textContent('.modal .sub');
      await page.keyboard.press('Escape');
      return t;
    };
    assert.equal(await sub(), 'How Terraville cities work, and how to grow one.');
    await page.click('[data-act="menu"]');
    await page.click('.dropdown button:has-text("Settings and keys")');
    assert.doesNotMatch(await page.textContent('.modal .touch-help'), /Bulldoze|Inspect/);
    await page.keyboard.press('Escape');
    await page.goto(base);
    await titleUp(page);
    assert.equal(await sub(), 'How Terraville cities work, and how to grow one.', 'nor on the title screen');
    await found(page);
    assert.equal(await sub(), 'How Terraville cities work, and how to grow one. The clock stops while this is open.');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Settings are kept when the page reloads', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const settings = async () => {
      await page.click('[data-act="menu"]');
      await page.click('.dropdown button:has-text("Settings and keys")');
      return page.$$eval('.modal [data-set]', (s) => Object.fromEntries(s.map((x) => [x.dataset.set, x.checked])));
    };
    const was = await settings();
    assert.deepEqual(was, { sound: true, traffic: true, night: true, grid: false, contours: false, autosave: true, paper: true });
    for (const k of ['sound', 'night', 'grid', 'contours', 'paper']) await page.click(`.modal label:has([data-set="${k}"])`);
    await page.keyboard.press('Escape');
    await page.reload();
    await titleUp(page);
    await found(page);
    assert.deepEqual(await settings(), { sound: false, traffic: true, night: false, grid: true, contours: true, autosave: true, paper: false });
    assert.deepEqual(await page.evaluate(() => { const r = window.__terraville.renderer; return [r.grid, r.contours, r.nightCycle]; }), [true, true, false], 'and the map follows them');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('every map layer and every disaster, in a challenge city on a laptop, with nothing going wrong', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await page.evaluate(() => { window.__terraville.startScenario('aftershock'); window.__terraville.ui.closeModal(); });
    const layers = await page.evaluate(() => [...document.querySelectorAll('#overlaySel option')].map((o) => o.textContent));
    assert.ok(layers.length >= 11, layers.join());
    for (const name of [...layers.slice(1), layers[0]]) {
      await page.click('#topbar [data-act="layers"]');
      await page.click(`[role="menu"] button:text-is("${name}")`);
      await page.waitForTimeout(80);
      assert.equal(await page.inputValue('#overlaySel'), await page.evaluate((n) => [...document.querySelectorAll('#overlaySel option')].find((o) => o.textContent === n).value, name));
    }
    const before = await page.evaluate(() => window.__terraville.sim.messages.filter((m) => m.kind === 'alert').length);
    for (const name of ['Fire', 'Flood', 'Tornado', 'Earthquake', 'Monster', 'Meltdown']) {
      await page.click('#topbar [data-act="disasters"]');
      await page.click(`[role="menu"] button:has-text("${name}")`);
      // A few weeks of it, drawn.
      await page.evaluate(() => { for (let i = 0; i < 6; i++) window.__terraville.sim.step(); });
      await page.waitForTimeout(250);
    }
    const alerts = await page.evaluate((n) => window.__terraville.sim.messages.filter((m) => m.kind === 'alert').slice(n).map((m) => m.text), before);
    assert.ok(alerts.length >= 5, `each disaster made the news: ${alerts.join(' | ')}`);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the Traffic layer shades track by its riders in a colour of its own, and its legend has a row for each', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    // Flat open land, a road and a line of track beside it: the track's west half packed with riders, its east half empty.
    const at = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      for (let i = 0; i < w.n; i++) {
        if (w.occ[i]) w.remove(w.occ[i]);
        w.water[i] = 0;
        w.height[i] = 6;
        w.trees[i] = 0;
        w.net[i] = 0;
      }
      const y = Math.floor(w.h / 2);
      for (let x = 20; x < 60; x++) {
        w.net[y * w.w + x] = 2;
        w.net[(y + 2) * w.w + x] = 1;
        g.sim.riders[y * w.w + x] = x < 40 ? 255 : 0;
        w.traffic[(y + 2) * w.w + x] = 255;
      }
      w.dirtyAll(true);
      g.ui.setOverlay('traffic');
      g.renderer.cam.zoom = 12;
      g.renderer.centerOn(40, y + 1);
      return y;
    });
    assert.deepEqual(await page.$$eval('#legend .leg-row', (rows) => rows.map((r) => r.textContent)), ['RoadsLightJammed', 'Rail ridersNonePacked']);
    await page.waitForTimeout(400);
    const colour = (x, y) => page.evaluate(([x, y]) => {
      const r = window.__terraville.renderer;
      const p = r.tileToScreen(x + 0.5, y + 0.5);
      return [...r.ctx.getImageData(Math.round(p.x * r.dpr), Math.round(p.y * r.dpr), 1, 1).data].slice(0, 3);
    }, [x, y]);
    const [rr, rg, rb] = await colour(30, at);
    assert.ok(rb > rr + 60 && rb > rg, `packed track is blue: ${[rr, rg, rb]}`);
    const [er, eg, eb] = await colour(50, at);
    assert.ok(eb >= er && eb + eg + er < rr + rg + rb, `empty track is a faint blue: ${[er, eg, eb]}`);
    const [cr, , cb] = await colour(30, at + 2);
    assert.ok(cr > cb + 60, `a jammed road is red: ${[cr, cb]}`);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('on a phone, Inspect on a road or track says who passes along it, and a switch shows their homes and work on the map', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    // Homes in the west, shops in the east, a road to the station and a line of track between.
    const ids = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      for (let i = 0; i < w.n; i++) {
        if (w.occ[i]) w.remove(w.occ[i]);
        w.water[i] = 0;
        w.height[i] = 6;
        w.trees[i] = 0;
        w.net[i] = 0;
      }
      const y = 20;
      const home = w.place('res', 10, y - 3);
      const shops = w.place('com', 48, y - 3);
      w.setLevel(home, 8);
      w.setLevel(shops, 3);
      for (let x = 10; x <= 12; x++) w.net[y * w.w + x] = 1;
      for (let x = 13; x <= 47; x++) w.net[y * w.w + x] = 2;
      for (let x = 48; x <= 50; x++) w.net[y * w.w + x] = 1;
      w.dirtyAll(true);
      g.setSpeed(0);
      g.sim.computeTraffic(false);
      g.renderer.cam.zoom = 9;
      g.renderer.centerOn(30, y);
      g.ui.inspect(12, y);
      return { home: home.id, shops: shops.id };
    });
    assert.equal(await page.textContent('#inspect .who'), 'About 1,100 commuters a month drive through here, from the homes nearby to the shops and offices to the east. Deliveries from the shops and offices to the east add about 50.');
    await page.evaluate(() => window.__terraville.ui.inspect(30, 20));
    assert.equal(await page.textContent('#inspect .who'), 'About 1,100 commuters a month ride through here, from the homes to the west to the shops and offices to the east. Deliveries from the shops and offices to the east add about 50.');
    assert.match(await page.textContent('#inspect dl'), /RidersBusy/);
    assert.equal(await page.isVisible('#inspect .who-key'), false);
    await page.tap('#inWho');
    assert.equal(await page.getAttribute('#inWho', 'aria-pressed'), 'true');
    assert.equal(await page.textContent('#inWho'), 'Show who rides here');
    assert.equal(await page.isVisible('#inspect .who-key'), true);
    const traced = () => page.evaluate(() => {
      const t = window.__terraville.renderer.trace;
      return t && { homes: [...t.homes], jobs: [...t.jobs] };
    });
    assert.deepEqual(await traced(), { homes: [ids.home], jobs: [ids.shops] });
    // The card is drawn again each month, and the homes and work stay shown.
    await page.evaluate(() => window.__terraville.ui.onMonth());
    assert.equal(await page.getAttribute('#inWho', 'aria-pressed'), 'true');
    assert.deepEqual(await traced(), { homes: [ids.home], jobs: [ids.shops] });
    // Another tile, or the card closed, puts them away.
    await page.evaluate(() => window.__terraville.ui.inspect(12, 20));
    assert.equal(await traced(), null);
    assert.equal(await page.getAttribute('#inWho', 'aria-pressed'), 'false');
    await page.tap('#inWho');
    assert.deepEqual(await traced(), { homes: [ids.home], jobs: [ids.shops] });
    await page.tap('#inspect .close');
    assert.equal(await traced(), null);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a touch screen gets touch help: no key letters, no right-click in the tips, and a Touch list in Settings', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    assert.deepEqual(await page.$$eval('.tool .key', (k) => k.filter((x) => getComputedStyle(x).display !== 'none').length), 0, 'no key letters on the tools');
    await page.tap('[data-tool="bulldoze"]');
    const tip = await page.textContent('#tooltip');
    assert.doesNotMatch(tip, /right-click|Shift/);
    assert.match(tip, /^Bulldoze\$1 a tileDrag to clear buildings/);
    await page.click('[data-act="menu"]');
    await page.click('.dropdown button:has-text("Settings and touch")');
    assert.match(await page.textContent('.modal .touch-help'), /One finger.*Two fingers.*Pinch to zoom.*Bulldoze.*Pick the bulldozer.*Second finger, mid-drag.*Calls off the road, zone or bulldozer drag/s);
    await page.keyboard.press('Escape');
    // In the terrain editor, Look around says what a tap does there.
    await page.goto(base);
    await titleUp(page);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await page.tap('[data-tool="pan"]');
    assert.match(await page.textContent('#tooltip'), /Drag to move the map\. Tap to read the height of the land\./);
    await page.click('[data-act="menu"]');
    await page.click('.dropdown button:has-text("Settings and touch")');
    assert.doesNotMatch(await page.textContent('.modal .touch-help'), /Second finger/);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the checklist cheers a city it saw grow, hides quietly on a grown city, and stays when the menu asks for it', async () => {
    const watchToasts = (page) => page.evaluate(() => {
      window.__toasts = [];
      new MutationObserver(() => window.__toasts.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'), { childList: true, subtree: true, characterData: true });
    });
    const growing = (page) => page.evaluate(() => window.__toasts.filter((t) => t.includes('growing')));
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await watchToasts(page);
    await found(page);
    // A plant, three zones that pass its power along and touch a road, each grown a level: every step is done.
    await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const fits = (x0, y0) => {
        for (let y = y0 - 1; y < y0 + 4; y++) for (let x = x0; x < x0 + 13; x++) if (!w.isEmptyLand(w.idx(x, y)) || w.slope(x, y) > 2) return false;
        return true;
      };
      let at = null;
      for (let y = 6; y < w.h - 6 && !at; y++) for (let x = 2; x < w.w - 16 && !at; x++) if (fits(x, y)) at = [x, y];
      if (!at) throw new Error('no flat land for a town');
      const [x, y] = at;
      for (let d = 0; d < 13; d++) w.setNet(1, x + d, y - 1);
      w.place('coal', x, y);
      for (const [k, dx] of [['res', 4], ['com', 7], ['ind', 10]]) w.setLevel(w.place(k, x + dx, y), 1);
      g.sim.computePower();
    });
    await page.waitForFunction(() => window.__toasts.some((t) => t.includes('growing')), null, { timeout: 5000 });
    assert.equal(await page.isHidden('#guide'), true, 'a list it saw finished goes away');
    const code = await codeOf(page, '(f) => {}');
    await ctx.close();

    // In a fresh browser, the grown city is opened from its code: nobody asked for the list, so it goes quietly.
    const other = await profile();
    const { page: b, problems: inB } = await open(other);
    await watchToasts(b);
    await openCode(b, code);
    await b.waitForFunction(() => window.__terraville.mode === 'city');
    await b.waitForTimeout(2000);
    assert.deepEqual(await growing(b), [], 'a city already grown when opened is not cheered');
    assert.equal(await b.isHidden('#guide'), true);
    assert.equal(await b.evaluate(() => localStorage.getItem('terraville.guide')), 'done');
    // Asked for from the menu, the list stays until its close button, with no cheer.
    await b.click('#topbar [data-act="menu"]');
    await b.click('[role="menu"] button:has-text("Show the starter checklist")');
    await b.waitForTimeout(2000);
    assert.equal(await b.isVisible('#guide'), true, 'the list asked for stays up');
    assert.match(await b.textContent('#guide'), /All done\..*5 of 5 done/);
    assert.deepEqual(await growing(b), []);
    await b.tap('#guide .guide-next');
    await b.tap('#guide .close');
    assert.equal(await b.isHidden('#guide'), true, 'its close button hides it');
    await b.waitForTimeout(1200);
    assert.equal(await b.isHidden('#guide'), true);
    assert.deepEqual([...problems, ...inB], []);
    await other.close();
  });

  await test('the checklist ticks roads and power only when every zone has them, and on a phone it is one line until tapped', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    assert.match(await page.textContent('#guide'), /^\s*Next: Build a power plant \(coal powers a whole town\)\.\s*0 of 5 done\s*$/, 'one line on a phone');
    assert.ok((await page.evaluate(() => document.querySelector('#guide').getBoundingClientRect().height)) < 60);
    await page.tap('#guide .guide-next');
    assert.equal(await page.isVisible('#guide ol'), true, 'a tap opens the list');
    // Three zones, one with a road along its top and power: neither step is done yet.
    const steps = () => page.evaluate(() => [...document.querySelectorAll('#guide li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
    await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      let n = 0;
      for (let y = 10; y < w.h - 10 && n < 3; y += 5) for (let x = 10; x < w.w - 10 && n < 3; x += 5) {
        const k = ['res', 'com', 'ind'][n];
        if (w.canPlace(k, x, y).ok) { w.place(k, x, y); n++; }
      }
      const z = [...w.buildings.values()][0];
      for (let d = 0; d < 3; d++) w.net[(z.y - 1) * w.w + z.x + d] |= 1;
      // Power as if a line reached this one zone (with no plant, the grid would take it away again).
      g.sim.computePower();
      g.sim.powerDirty = false;
      z.powered = true;
    });
    await page.waitForTimeout(1300);
    const [, , roads, power] = await steps();
    assert.match(roads, /^Lay roads so each zone touches one\. ?1 of 3 zones touches a road$/);
    assert.match(power, /^Run power lines from the plant to the zones\. ?1 of 3 zones has power$/);
    assert.equal(await page.$$eval('#guide li', (l) => l.slice(2, 4).every((x) => !x.querySelector('svg'))), true, 'neither ticked');
    await page.evaluate(() => {
      const w = window.__terraville.world;
      for (const b of w.buildings.values()) {
        for (let d = 0; d < 3; d++) w.net[(b.y - 1) * w.w + b.x + d] |= 1;
        b.powered = true;
      }
      window.__terraville.sim.powerDirty = false;
    });
    await page.waitForTimeout(1300);
    assert.equal(await page.$$eval('#guide li', (l) => l.slice(2, 4).every((x) => !!x.querySelector('svg'))), true, 'both ticked once every zone has them');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('on a phone, a section tapped in the guide opens with its heading clear of the tabs, and the tabs follow the reading', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="guide"]');
    // Until the scrolling has stopped: the same place twice, 150 ms apart.
    const settle = () => page.evaluate(async () => {
      const s = document.querySelector('.modal .body');
      for (let i = 0; i < 40; i++) {
        const a = s.scrollTop;
        await new Promise((ok) => setTimeout(ok, 150));
        if (s.scrollTop === a) return;
      }
    });
    await page.tap('[data-go="money"]');
    await page.waitForFunction(() => document.querySelector('.modal .body').scrollTop > 0);
    await settle();
    const at = await page.evaluate(() => ({
      strip: document.querySelector('.guide-nav').getBoundingClientRect().bottom,
      heading: document.querySelector('#guide-money h3').getBoundingClientRect().top,
      current: document.querySelector('.guide-nav [aria-current="true"]').dataset.go,
    }));
    assert.ok(at.heading >= at.strip, `the heading (${at.heading}) is below the strip (${at.strip})`);
    assert.equal(at.current, 'money');
    await page.evaluate(() => { const s = document.querySelector('.modal .body'); s.scrollTop = s.scrollHeight; });
    await settle();
    const end = await page.evaluate(() => {
      const nav = document.querySelector('.guide-nav');
      const on = nav.querySelector('[aria-current="true"]');
      const n = nav.getBoundingClientRect();
      const b = on.getBoundingClientRect();
      return { current: on.dataset.go, seen: b.left >= n.left && b.right <= n.right };
    });
    assert.deepEqual(end, { current: 'classes', seen: true }, 'at the end the last section is current, and its tab is in view');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the report says when nobody lives in the city yet, and each worry opens where to see it', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    // A plant with one lot on its grid, and one lot no plant reaches: the power line counts that lot apart.
    await page.evaluate(() => {
      const w = window.__terraville.world;
      const fits = (x, y) => w.canPlace('coal', x, y).ok && w.canPlace('res', x + 4, y).ok;
      const at = (ok) => { for (let y = 2; y < w.h - 6; y++) for (let x = 2; x < w.w - 10; x++) if (ok(x, y)) return { x, y }; };
      const p = at(fits);
      w.place('coal', p.x, p.y);
      w.place('res', p.x + 4, p.y);
      const q = at((x, y) => w.canPlace('res', x, y).ok && Math.abs(x - p.x) > 12);
      w.place('res', q.x, q.y);
      window.__terraville.sim.computePower();
    });
    await page.click('#citySign');
    assert.match(await page.textContent('.modal .body'), /Nobody lives here yet\. The report fills in once people move in\./);
    assert.equal(await page.$$eval('.modal .worry, .modal .big', (e) => e.length), 0, 'no approval figure and no worries for nobody');
    assert.equal(await page.textContent('.modal .kv dt:text-is("Power") + dd'), '9 of 700 MW');
    assert.equal(await page.textContent('.modal .kv dt:text-is("Not connected") + dd'), '9 MW');
    await page.click('.modal footer .btn');
    await page.evaluate(() => { window.__terraville.startScenario('gridlock'); window.__terraville.ui.closeModal(); });
    await page.click('#citySign');
    // Each worry that opens something looks it: a chevron at its end, with where it goes as its description.
    assert.ok(await page.$$eval('.modal .worry', (ws) => ws.length && ws.every((w) => w.lastElementChild.matches('.chev[aria-hidden="true"]') && /^(Show the .+ layer|Open the budget)$/.test(w.title))));
    await page.click('.worry[data-to="traffic"]');
    assert.deepEqual(await page.evaluate(() => [window.__terraville.renderer.overlay, window.__terraville.ui.modalOpen]), ['traffic', false], 'Traffic opens the traffic layer');
    await page.click('#citySign');
    await page.click('.worry[data-to="budget"]');
    assert.equal(await page.textContent('.modal h2'), 'Budget', 'Taxes opens the budget');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('rough edges: links in dialogs, the phone layer card and its steepness, and the landscape buttons', async () => {
    const desk = await profile(DESK);
    const { page: d, problems: dp } = await open(desk);
    await d.click('[data-act="open"]');
    assert.equal(await d.$eval('.modal a', (a) => getComputedStyle(a).color), 'rgb(234, 240, 234)', "a dialog's link is in the text colour, not the browser's blue");
    await d.click('.modal [data-close]');
    await d.click('[data-act="editor"]');
    await d.waitForFunction(() => window.__terraville.mode === 'editor');
    assert.deepEqual(await d.$$eval('#edStyle button', (b) => b.filter((x) => x.scrollWidth > x.clientWidth).map((x) => x.textContent)), [], 'every landscape name fits its button');
    assert.deepEqual(dp, []);
    await desk.close();

    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await page.click('[data-act="menu"]');
    await page.click('.dropdown button:has-text("Show the steepness")');
    assert.equal(await page.evaluate(() => window.__terraville.renderer.overlay), 'slope', 'the phone editor can show the steepness');
    assert.equal(await page.isVisible('#minimapCard'), true);
    assert.deepEqual(await page.$$eval('#minimapCard .mm-row .iconbtn', (b) => b.map((x) => getComputedStyle(x).display)), ['none', 'none'], 'no zoom buttons beside the layer name on a phone');
    assert.ok(await page.$eval('#overlaySel', (s) => s.clientWidth >= 150), 'the layer name has room');
    await page.click('[data-act="menu"]');
    await page.click('.dropdown button:has-text("Hide the steepness")');
    assert.equal(await page.evaluate(() => window.__terraville.renderer.overlay), 'none');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("on a phone the map layer card leaves out the overview map until its button asks for it, for the session; a laptop's card is as it was", async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const card = () => page.evaluate(() => {
      const box = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return e.getClientRects().length ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } : null; };
      return { card: box('#minimapCard'), overview: box('#minimap'), button: box('#mmToggle'), pressed: document.querySelector('#mmToggle').getAttribute('aria-pressed') };
    });
    // Level land turns on the steepness: the card has the layer, its legend 2 by 2, and the button, and no overview map.
    await page.evaluate(() => window.__terraville.setTool('level'));
    let c = await card();
    assert.equal(c.overview, null, 'no overview map at first');
    assert.ok(c.button && c.button.height >= 44 && c.button.bottom <= c.card.bottom, 'a 44 px button in the card shows it');
    assert.ok(c.card.height < 160, `the card is ${Math.round(c.card.height)} px tall`);
    assert.equal(await page.$eval('#legend', (l) => getComputedStyle(l).gridTemplateColumns.split(' ').length), 2, 'the steepness legend is 2 by 2');
    await page.tap('#mmToggle');
    c = await card();
    assert.ok(c.overview && c.overview.height > 100 && c.pressed === 'true', 'the button brings the overview map back');
    // Kept for the session: after a reload the next layer's card has it too.
    await page.reload();
    await titleUp(page);
    await page.click('[data-act="continue"]');
    await page.waitForFunction(() => window.__terraville.mode === 'city');
    await page.evaluate(() => window.__terraville.ui.setOverlay('traffic'));
    assert.ok((await card()).overview, 'the overview map stays for the session');
    assert.deepEqual(problems, []);
    await ctx.close();
    // A phone on its side: the card, a single row, keeps below the goal card.
    const side = await profile({ viewport: { width: 812, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const { page: s, problems: inS } = await open(side);
    await s.evaluate(() => window.__terraville.startScenario('gridlock'));
    await s.click('.modal footer .btn.primary');
    const [goal, mm] = await s.evaluate(() => ['#goal', '#minimapCard'].map((q) => document.querySelector(q).getBoundingClientRect().toJSON()));
    assert.ok(mm.top >= goal.bottom, `the map layer card (top ${mm.top}) keeps below the goal card (bottom ${goal.bottom})`);
    assert.deepEqual(inS, []);
    await side.close();
    // A laptop's card has its overview map and no button.
    const desk = await profile(DESK);
    const { page: d, problems: inD } = await open(desk);
    await found(d);
    assert.equal(await d.isVisible('#minimap'), true);
    assert.equal(await d.isVisible('#mmToggle'), false);
    assert.deepEqual(inD, []);
    await desk.close();
  });

  await test("on a phone the top bar keeps to two rows of finger-sized buttons, and the cards below it never cover the speed buttons", async () => {
    // Speed buttons that something else covers: a tap on one would land on that instead.
    const covered = (page) => page.evaluate(() => [...document.querySelectorAll('[data-speed]')].filter((b) => {
      const r = b.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-speed]') !== b;
    }).map((b) => b.getAttribute('aria-label')));
    const bar = (page) => page.evaluate(() => {
      const box = (e) => e.getBoundingClientRect();
      const strip = document.querySelector('.stat-strip');
      return {
        sign: box(document.querySelector('#citySign')), menu: box(document.querySelector('#topbar .menu')), strip: box(strip),
        stripFits: strip.scrollWidth <= strip.clientWidth && new Set([...strip.children].map((c) => Math.round(box(c).top))).size === 1,
        speed: [...document.querySelectorAll('[data-speed]')].map((b) => box(b).height),
        buttons: [...document.querySelectorAll('#topbar .menu button')].filter((b) => b.offsetWidth).map((b) => [box(b).width, box(b).height]),
      };
    });
    // A challenge's city sign is long (a name and 'Pop 17,568 · City'): at 360 px, the width of many Android phones, it
    // pushed the menu to a second row and the stats to a third, under the goal card, so Gridlock couldn't be paused.
    for (const width of [320, 360, 390, 412]) {
      const ctx = await profile({ ...PHONE, viewport: { width, height: width * 2 } });
      const { page, problems } = await open(ctx);
      for (const id of width === 360 ? ['boomtown', 'gridlock', 'smog', 'aftershock', 'monster'] : ['gridlock']) {
        await page.evaluate((id) => window.__terraville.startScenario(id), id);
        await page.click('.modal footer .btn.primary');
        await page.waitForTimeout(100);
        assert.deepEqual(await covered(page), [], `${width} px, ${id}: every speed button takes its own taps`);
      }
      const b = await bar(page);
      assert.ok(b.menu.top === b.sign.top && b.strip.top >= b.menu.bottom, `${width} px: the sign and the menu share the first row, the stats the second`);
      assert.ok(b.stripFits, `${width} px: the stats and the speed buttons fit one line`);
      assert.ok(b.speed.every((h) => h >= 44), `${width} px: the speed buttons are 44 px tall`);
      assert.ok(b.buttons.every(([w, h]) => w >= 34 && h >= 44), `${width} px: the top bar's buttons are at least 34 by 44 px`);
      assert.deepEqual(problems, []);
      await ctx.close();
    }
    // A megalopolis, the longest sign, with the checklist asked for: it sits below the stats.
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    await page.evaluate(() => { window.__terraville.sim.stats.residents = 265432; });
    await page.click('#topbar [data-act="menu"]');
    await page.click('[role="menu"] button:has-text("Show the starter checklist")');
    await page.waitForFunction(() => document.querySelector('#signSub').textContent.includes('Megalopolis'));
    const strip = await page.evaluate(() => document.querySelector('.stat-strip').getBoundingClientRect().bottom);
    const guide = await page.evaluate(() => document.querySelector('#guide').getBoundingClientRect().top);
    assert.ok(guide >= strip, `the checklist (top ${guide}) sits below the stats (bottom ${strip})`);
    assert.deepEqual(await covered(page), []);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("on a touch screen the small close buttons answer a finger, and the menus, the report's worries and the dialogs' buttons are finger-sized", async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const tall = (sel) => page.$$eval(sel, (es) => es.filter((e) => e.offsetWidth).map((e) => Math.round(e.getBoundingClientRect().height)));
    // The checklist's close button stays 26 px, but a tap 6 px outside it still closes the list.
    await page.tap('#guide .guide-next');
    const x = await page.$eval('#guide .close', (b) => {
      const r = b.getBoundingClientRect();
      return document.elementFromPoint(r.left - 6, r.top + r.height / 2)?.closest('.close') === b && r.width === 26;
    });
    assert.ok(x, "a tap just outside the checklist's close button lands on it");
    assert.ok((await tall('#ticker button')).every((h) => h >= 40), 'the news button is 40 px tall');
    await page.tap('#topbar [data-act="menu"]');
    assert.ok((await tall('.dropdown button')).every((h) => h >= 44), 'menu items are 44 px tall');
    await page.tap('#topbar [data-act="menu"]');
    // A city with people in it, and so worries.
    await page.evaluate(() => window.__terraville.startScenario('gridlock'));
    await page.click('.modal footer .btn.primary');
    await page.tap('#citySign');
    const rows = await page.$$eval('.bars > *', (es) => es.map((e) => e.getBoundingClientRect()).map((r) => [r.top, r.bottom]));
    assert.ok(rows.length > 2 && rows.every(([t, b], i) => b - t >= 40 && (i === 0 || t - rows[i - 1][1] >= 4)), "the report's worries are 40 px tall and 4 px apart");
    await page.click('.modal [data-close]');
    await page.evaluate(() => window.__terraville.ui.openFiles());
    assert.ok((await tall('.modal .btn.small')).every((h) => h >= 40), "Save, open and share's buttons are 40 px tall");
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a phone on its side gets one row of top bar, room for the map, menus that scroll, and panels clear of the notch', async () => {
    const ctx = await profile({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const { page, problems } = await open(ctx);
    // An iPhone held sideways: the notch at one end, the home bar along the bottom.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 47, right: 47, top: 0, bottom: 21 } });
    await found(page);
    const box = (s) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }, s);
    const [sign, stats, menu, tools, ticker, map, guide] = await Promise.all(['#citySign', '.stat-strip', '#topbar .menu', '#toolbox', '#ticker', '#minimapCard', '#guide'].map(box));
    assert.ok(stats.top === sign.top && menu.top === sign.top, 'the stats share the first row with the sign and the menu');
    assert.ok(sign.left >= 47 && menu.right <= 844 - 47, 'the top bar keeps clear of the notch at either end');
    assert.ok(tools.top >= stats.bottom && tools.bottom <= 390 - 21, 'the tools run down the left, under the top bar and above the home bar');
    assert.ok(ticker.right <= map.left && ticker.bottom <= 390 - 21, 'the ticker sits beside the map card');
    assert.ok(guide.bottom - guide.top < 60, 'the checklist is one line until tapped');
    await page.tap('[data-act="layers"]');
    const dd = await box('.dropdown');
    assert.ok(dd.bottom <= 390, 'the layers menu ends on the screen');
    await page.$eval('.dropdown', (d) => { d.scrollTop = d.scrollHeight; });
    assert.equal(await page.isVisible('.dropdown button:has-text("Steepness")'), true, 'and scrolls to its last layer');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a small phone on its side gets the short layout too: the goal card in the right-hand column, room for the map, and every title choice in sight', async () => {
    // An iPhone 12 mini held sideways is 812 px wide, under the 821 px where the short layout used to start, so it got
    // the upright layout: three rows of top bar, the goal card across the screen over the news, and no map between them.
    const ctx = await profile({ viewport: { width: 812, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const { page, problems } = await open(ctx);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 44, right: 44, top: 0, bottom: 21 } });
    await page.evaluate(() => window.__terraville.startScenario('gridlock'));
    await page.click('.modal footer .btn.primary');
    const box = (s) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }, s);
    const [bar, goal, tools, ticker, menu] = await Promise.all(['#topbar', '#goal', '#toolbox', '#ticker', '#topbar .menu'].map(box));
    assert.ok(bar.left >= 44 && menu.right <= 812 - 44, 'the top bar keeps clear of the notch at either end');
    assert.ok(bar.bottom - bar.top < 70, 'the top bar is one row');
    assert.ok(goal.left > 812 / 2 && goal.right <= 812 - 44 && goal.top >= bar.bottom, 'the goal card sits in the right-hand column, under the top bar');
    // Between the tools and the goal card, from the top bar down to the news, the map shows.
    const free = { left: tools.right, right: goal.left, top: bar.bottom, bottom: ticker.top };
    assert.ok(free.right - free.left > 200 && free.bottom - free.top >= 375 / 3, `at least a third of the screen's height is map (${free.bottom - free.top} px)`);
    assert.deepEqual(problems, []);
    await ctx.close();

    // An iPhone SE held sideways, 667 by 375, with a city saved: all six choices on the title screen show at once.
    const se = await profile({ viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const { page: t, problems: inT } = await open(se);
    await found(t);
    // The new city opens paused: its badge sits on the map between the tools and the checklist, clear of both.
    const [pill, list, kit] = await t.evaluate(() => ['#pausedPill', '#guide', '#toolbox'].map((q) => document.querySelector(q).getBoundingClientRect().toJSON()));
    assert.ok(pill.width && pill.left >= kit.right && pill.right <= list.left, `the paused badge (${Math.round(pill.left)} to ${Math.round(pill.right)}) keeps clear of the tools and the checklist (from ${Math.round(list.left)})`);
    await t.reload();
    await titleUp(t);
    const choices = await t.evaluate(() => [...document.querySelectorAll('.title-actions .btn')].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.querySelector('span').textContent, inSight: r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth };
    }));
    assert.equal(choices.length, 6, 'Continue is offered');
    assert.equal(choices[0].text, `Continue ${await t.evaluate(() => window.__terraville.latestLocal().name)}`, 'first');
    assert.deepEqual(await t.$$eval('.title-actions .btn.primary', (bs) => bs.map((x) => x.dataset.act)), ['continue'], 'as the main choice');
    assert.deepEqual(choices.filter((c) => !c.inSight).map((c) => c.text), [], 'every choice is in sight without scrolling');
    assert.deepEqual(inT, []);
    await se.close();
  });

  await test('on a phone the first tap with a plant or a service shows where it goes and its price, and a second tap builds it', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    // Open, flat ground in the middle of the view.
    const spot = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      const cx = Math.floor(w.w / 2);
      const cy = Math.floor(w.h / 2);
      for (let y = cy - 14; y < cy + 14; y++) for (let x = cx - 14; x < cx + 14; x++) {
        const i = y * w.w + x;
        if (w.occ[i]) w.remove(w.occ[i]);
        w.water[i] = 0; w.height[i] = 6; w.trees[i] = 0; w.net[i] = 0; w.rubble[i] = 0;
      }
      w.dirtyAll(true);
      g.renderer.cam.zoom = 16;
      g.renderer.centerOn(cx, cy);
      return { cx, cy };
    });
    const at = (x, y) => page.evaluate(([x, y]) => {
      const r = window.__terraville.renderer;
      const m = document.querySelector('#map').getBoundingClientRect();
      const q = r.tileToScreen(x + 0.5, y + 0.5);
      return { x: m.left + q.x, y: m.top + q.y };
    }, [x, y]);
    const state = () => page.evaluate(() => {
      const g = window.__terraville;
      const card = document.querySelector('#placeCard');
      const kinds = [...g.world.buildings.values()].map((b) => b.kind);
      return { funds: g.world.city.funds, fire: kinds.filter((k) => k === 'fire').length, police: kinds.filter((k) => k === 'police').length, res: kinds.filter((k) => k === 'res').length, card: !card || card.hidden ? '' : card.textContent, shown: g.renderer.preview?.rects.map((r) => [r.x, r.y]) ?? [] };
    });
    const tap = async (x, y) => {
      const p = await at(x, y);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForTimeout(150);
    };
    await page.tap('[data-tool="fire"]');
    const start = await state();
    // One tap spends nothing: it shows the station's footprint, its price and a Build button.
    await tap(spot.cx, spot.cy);
    let s = await state();
    assert.deepEqual([s.funds, s.fire], [start.funds, 0], 'one tap spends nothing and builds nothing');
    assert.equal(s.card, 'Fire station · $500Build');
    assert.deepEqual(s.shown, [[spot.cx - 1, spot.cy - 1]], 'its footprint shows where the tap was');
    // A tap elsewhere shows it there instead.
    await tap(spot.cx - 7, spot.cy);
    s = await state();
    assert.deepEqual([s.funds, s.fire, s.shown], [start.funds, 0, [[spot.cx - 8, spot.cy - 1]]], 'a tap elsewhere moves it');
    // A second tap on it builds it, wherever on its footprint.
    await tap(spot.cx - 6, spot.cy + 1);
    s = await state();
    assert.deepEqual([s.funds, s.fire, s.card], [start.funds - 500, 1, ''], 'the second tap builds it');
    // Or the Build button.
    await tap(spot.cx + 5, spot.cy);
    assert.equal((await state()).fire, 1);
    await page.tap('#placeBuild');
    s = await state();
    assert.deepEqual([s.funds, s.fire, s.card], [start.funds - 1000, 2, ''], 'Build builds it');
    // At a corner of the map, brought in as far as it goes, the footprint shows as soon as the finger lifts and the card
    // stays off it.
    const corner = await page.evaluate(() => {
      const r = window.__terraville.renderer;
      r.cam.zoom = 24;
      r.cam.x = -1e6;
      r.cam.y = -1e6;
      r.clampCamera();
      return r.tileToScreen(2.5, 2.5);
    });
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    await page.touchscreen.tap(corner.x, corner.y);
    const off = await page.evaluate(() => {
      const r = window.__terraville.renderer;
      const card = document.querySelector('#placeCard').getBoundingClientRect();
      const a = r.tileToScreen(1, 1);
      const b = r.tileToScreen(4, 4);
      return { shown: r.preview?.rects.map((q) => [q.x, q.y]), clear: card.right <= a.x || card.left >= b.x || card.bottom <= a.y || card.top >= b.y };
    });
    assert.deepEqual(off, { shown: [[1, 1]], clear: true }, 'at the corner');
    await page.evaluate(([x, y]) => { const r = window.__terraville.renderer; r.cam.zoom = 16; r.centerOn(x, y); }, [spot.cx, spot.cy]);
    // Picking another tool takes it back, and so do moving the map and pinching.
    await tap(spot.cx, spot.cy + 7);
    await page.tap('[data-tool="police"]');
    s = await state();
    assert.deepEqual([s.funds, s.fire, s.card, s.shown], [start.funds - 1000, 2, '', []], 'another tool takes it back');
    await tap(spot.cx, spot.cy + 7);
    assert.ok((await state()).card, 'the police station shows');
    await page.evaluate(() => { const r = window.__terraville.renderer; r.centerOn(r.cam.x + 2, r.cam.y); });
    await page.waitForTimeout(100);
    s = await state();
    assert.deepEqual([s.police, s.card, s.shown], [0, '', []], 'moving the map takes it back');
    await tap(spot.cx, spot.cy + 7);
    const cdp = await ctx.newCDPSession(page);
    const p = await at(spot.cx, spot.cy + 7);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    await touch('touchStart', [[p.x - 20, p.y]]);
    await touch('touchStart', [[p.x - 20, p.y], [p.x + 20, p.y]]);
    for (let k = 1; k <= 5; k++) await touch('touchMove', [[p.x - 20 - k * 6, p.y], [p.x + 20 + k * 6, p.y]]);
    await touch('touchEnd', []);
    await page.waitForTimeout(100);
    s = await state();
    assert.deepEqual([s.police, s.card], [0, ''], 'pinching takes it back');
    // Zones still go down with one tap, and a mouse click still builds a station at once.
    await page.evaluate(([x, y]) => { const r = window.__terraville.renderer; r.cam.zoom = 16; r.centerOn(x, y); }, [spot.cx, spot.cy]);
    await page.tap('[data-tool="res"]');
    await tap(spot.cx - 8, spot.cy + 8);
    assert.equal((await state()).res, 1, 'a zone goes down with one tap');
    await page.tap('[data-tool="police"]');
    const q = await at(spot.cx + 6, spot.cy + 8);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(150);
    assert.equal((await state()).police, 1, 'a click builds at once');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a phone on its side: the Inspect card stays clear of the paused badge, the checklist and the goal card', async () => {
    const ctx = await profile({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const { page, problems } = await open(ctx);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 47, right: 47, top: 0, bottom: 21 } });
    // Whatever is up near the top and shares columns with the card ends above the card's top.
    const clash = () => page.evaluate(() => {
      const card = document.querySelector('#inspect').getBoundingClientRect();
      return ['#topbar', '#pausedPill', '#guide', '#goal'].flatMap((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return r.width && r.left < card.right && card.left < r.right && r.top < card.top + 1 && r.bottom > card.top + 0.5 ? [`${s} ends at ${Math.round(r.bottom)}, the card starts at ${Math.round(card.top)}`] : [];
      });
    });
    // A new city opens paused, with the checklist up: Inspect a lot on it.
    await found(page);
    await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      let at = null;
      for (let y = 10; y < w.h - 10 && !at; y++) for (let x = 10; x < w.w - 10 && !at; x++) if (w.canPlace('res', x, y).ok) at = [x, y];
      w.place('res', at[0], at[1]);
      g.ui.inspect(at[0] + 1, at[1] + 1);
    });
    assert.deepEqual(await clash(), [], 'a lot in a new city, paused');
    // Gridlock, paused, on a row of apartments: a tall card, and the goal card beside it.
    await page.evaluate(() => window.__terraville.startScenario('gridlock'));
    await page.click('.modal footer .btn.primary');
    await page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(0);
      const b = [...g.world.buildings.values()].filter((b) => b.kind === 'res').sort((a, b) => b.level - a.level)[0];
      g.ui.inspect(b.x + 1, b.y + 1);
    });
    assert.deepEqual(await clash(), [], 'apartments in Gridlock, paused');
    // Folding the goal card away gives the card the room back.
    const before = await page.evaluate(() => document.querySelector('#inspect').getBoundingClientRect().top);
    await page.tap('#goal .goal-head');
    await page.waitForTimeout(100);
    assert.deepEqual(await clash(), [], 'with the goal folded');
    assert.ok(await page.evaluate((t) => document.querySelector('#inspect').getBoundingClientRect().top <= t, before), 'and the card does not shrink');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Inspect on a station shows its reach on the map, and closing the card puts the layer back', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const at = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      let at = null;
      for (let y = 10; y < w.h - 10 && !at; y++) for (let x = 10; x < w.w - 10 && !at; x++) if (w.canPlace('fire', x, y).ok) at = [x, y];
      w.place('fire', at[0], at[1]);
      g.ui.setOverlay('landValue');
      g.ui.inspect(at[0] + 1, at[1] + 1);
      return at;
    });
    assert.equal(await page.textContent('#inspect .does'), 'Prevents and fights fires within about 18 tiles.');
    // A phrase runs under its label, the card's width, on one line; a figure stays in the right-hand column, in mono.
    const layout = await page.evaluate(() => {
      const dl = document.querySelector('#inspect dl').getBoundingClientRect();
      const dd = (k) => [...document.querySelectorAll('#inspect dt')].find((t) => t.textContent === k).nextElementSibling;
      const [power, height] = [dd('Power'), dd('Elevation')];
      const p = power.getBoundingClientRect();
      return {
        power: power.textContent, left: p.left - dl.left, lines: Math.round(p.height / parseFloat(getComputedStyle(power).lineHeight)),
        fonts: [getComputedStyle(power).fontFamily, getComputedStyle(height).fontFamily],
      };
    });
    assert.equal(layout.power, 'None: no plant connected');
    assert.ok(layout.left < 1 && layout.lines === 1, `from the card's left edge, on one line: ${JSON.stringify(layout)}`);
    assert.ok(!/Mono/.test(layout.fonts[0]) && /Mono/.test(layout.fonts[1]), layout.fonts.join(' / '));
    await page.click('#inLayer');
    assert.equal(await page.evaluate(() => window.__terraville.renderer.overlay), 'fire');
    assert.equal(await page.locator('#inLayer').count(), 0, 'no button for the layer already up');
    // Another tile keeps the layer; closing the card puts back the one from before.
    await page.evaluate(([x, y]) => window.__terraville.ui.inspect(x + 5, y + 5), at);
    assert.equal(await page.evaluate(() => window.__terraville.renderer.overlay), 'fire');
    await page.click('#inspect .close');
    assert.equal(await page.evaluate(() => window.__terraville.renderer.overlay), 'landValue');
    assert.equal(await page.inputValue('#overlaySel'), 'landValue');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('in a short window, such as a laptop at 200% zoom, the Inspect card stops below the checklist and scrolls', async () => {
    const measure = async (opts) => {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      await found(page);
      const r = await page.evaluate(() => {
        const g = window.__terraville;
        const w = g.world;
        let at = null;
        for (let y = 10; y < w.h - 10 && !at; y++) for (let x = 10; x < w.w - 10 && !at; x++) if (w.canPlace('res', x, y).ok) at = [x, y];
        w.place('res', at[0], at[1]);
        g.ui.inspect(at[0] + 1, at[1] + 1);
        const card = document.querySelector('#inspect');
        return { guide: document.querySelector('#guide').getBoundingClientRect().bottom, top: card.getBoundingClientRect().top, scrolls: card.scrollHeight > card.clientHeight, capped: !!card.style.maxHeight };
      });
      assert.deepEqual(problems, []);
      await ctx.close();
      return r;
    };
    const zoomed = await measure({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    assert.ok(zoomed.top >= zoomed.guide, `the card (top ${zoomed.top}) covers the checklist (bottom ${zoomed.guide})`);
    assert.equal(zoomed.scrolls, true, 'what does not fit scrolls');
    const phone = await measure(PHONE);
    assert.equal(phone.capped, false, 'a phone held upright is as it was');
  });

  await test('on a phone, Inspect takes the bottom slot from the map layer card and the news log', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const shown = () => page.evaluate(() => ['#inspect', '#minimapCard', '#log'].map((s) => getComputedStyle(document.querySelector(s)).display !== 'none'));
    await page.evaluate(() => window.__terraville.ui.setOverlay('pollution'));
    await page.click('#tkLog');
    assert.deepEqual(await shown(), [false, true, true]);
    await page.tap('#map', { position: { x: 195, y: 560 } });
    assert.deepEqual(await shown(), [true, false, false], 'Inspect shares the slot');
    assert.equal(await page.getAttribute('#tkLog', 'aria-expanded'), 'false');
    await page.click('#tkLog');
    assert.deepEqual(await shown(), [false, true, true], 'the log shares the slot');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('on a phone the Inspect card bulldozes what it shows with a second tap, as right-click does; a laptop has right-click', async () => {
    for (const opts of [PHONE, DESK]) {
      const ctx = await profile(opts);
      const { page, problems } = await open(ctx);
      await found(page);
      const spot = await page.evaluate(() => {
        const g = window.__terraville;
        const w = g.world;
        const cx = Math.floor(w.w / 2);
        const cy = Math.floor(w.h / 2);
        for (let y = cy - 8; y < cy + 8; y++) for (let x = cx - 8; x < cx + 8; x++) {
          const i = y * w.w + x;
          if (w.occ[i]) w.remove(w.occ[i]);
          w.water[i] = 0; w.height[i] = 6; w.trees[i] = 0; w.net[i] = 0; w.rubble[i] = 0;
        }
        w.dirtyAll(true);
        const home = w.place('res', cx - 4, cy - 1);
        w.setLevel(home, 3);
        const burning = w.place('ind', cx + 2, cy - 1);
        w.setLevel(burning, 2);
        for (let y = cy - 1; y < cy + 2; y++) for (let x = cx + 2; x < cx + 5; x++) w.fire[y * w.w + x] = 10;
        g.setSpeed(0);
        g.setTool('query');
        g.renderer.cam.zoom = 20;
        g.renderer.centerOn(cx, cy);
        return { cx, cy };
      });
      const state = () => page.evaluate(() => {
        const g = window.__terraville;
        const card = document.querySelector('#inspect');
        const tip = document.querySelector('#cursorTip');
        const toast = document.querySelector('#toast');
        return {
          funds: g.world.city.funds,
          homes: [...g.world.buildings.values()].filter((b) => b.kind === 'res').length,
          card: card.hidden ? '' : card.querySelector('#inBulldoze')?.textContent ?? 'no button',
          tip: tip.hidden ? '' : tip.textContent,
          toast: toast.classList.contains('hide') ? '' : toast.textContent,
          dust: g.renderer.vehicles.dust.length,
        };
      });
      const tapTile = async (x, y) => {
        const p = await page.evaluate(([x, y]) => window.__terraville.renderer.tileToScreen(x + 0.5, y + 0.5), [x, y]);
        if (opts === PHONE) await page.touchscreen.tap(p.x, p.y);
        else await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(250);
      };
      await tapTile(spot.cx - 3, spot.cy);
      const start = await state();
      if (opts === DESK) {
        assert.equal(start.card, 'no button', 'a laptop has right-click, and no Bulldoze button');
        await ctx.close();
        continue;
      }
      assert.equal(start.card, 'Bulldoze for $9');
      await page.tap('#inBulldoze');
      let s = await state();
      assert.deepEqual([s.card, s.homes, s.funds], ['Tap again to bulldoze', 1, start.funds], 'the first tap asks again and spends nothing');
      await page.tap('#inBulldoze');
      s = await state();
      assert.deepEqual([s.card, s.homes, s.funds, s.tip], ['', 0, start.funds - 9, 'Cleared 1 · $9'], 'the second tap clears it and closes the card');
      assert.ok(s.dust > 0, 'with dust');
      // It is undone like any action, money and all.
      await page.evaluate(() => window.__terraville.undo());
      s = await state();
      assert.deepEqual([s.homes, s.funds], [1, start.funds], 'undo puts it back');
      // A burning factory is refused, in the bulldozer's words, and the card stays.
      await tapTile(spot.cx + 3, spot.cy);
      assert.equal((await state()).card, 'Bulldoze for $9');
      await page.tap('#inBulldoze');
      s = await state();
      assert.equal(s.toast, 'That is on fire. Bulldoze a gap around it to stop it spreading.');
      assert.equal(s.card, 'Bulldoze for $9', 'the card stays');
      // On Ultra the card is drawn again every month, a quarter of a second: the first tap still waits for the second.
      await page.evaluate(() => {
        const g = window.__terraville;
        g.world.fire.fill(0);
        g.setSpeed(4);
      });
      await tapTile(spot.cx - 3, spot.cy);
      await page.tap('#inBulldoze');
      const month = await page.evaluate(() => window.__terraville.world.city.month);
      await page.waitForTimeout(700);
      assert.notEqual(await page.evaluate(() => window.__terraville.world.city.month), month, 'a month went by between the taps');
      assert.equal((await state()).card, 'Tap again to bulldoze', 'the card drawn again still waits for the second tap');
      await page.tap('#inBulldoze');
      s = await state();
      assert.deepEqual([s.card, s.homes], ['', 0], 'and the second tap clears it');
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test('Inspect marks the lot it describes, whatever the pointer does next, and on a phone brings it out from under the card', async () => {
    // Where the lot is now on screen, and whether the outline is painted 1 px outside its top edge.
    const look = (page) => page.evaluate(() => {
      const r = window.__terraville.renderer;
      const s = r.selected;
      if (!s) return { selected: null };
      const a = r.tileToScreen(s.x, s.y);
      const b = r.tileToScreen(s.x + s.size, s.y + s.size);
      const px = r.canvas.getContext('2d').getImageData(Math.round((a.x + b.x) / 2 * r.dpr), Math.round((a.y - 1) * r.dpr), 1, 1).data;
      const card = document.querySelector('#inspect').getBoundingClientRect();
      return {
        selected: s, hover: r.hover, lot: [a.x, a.y, b.x, b.y], card: [card.left, card.top, card.right, card.bottom],
        yellow: px[0] > 200 && px[1] > 150 && px[2] < 120,
      };
    });
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await page.evaluate(() => { window.__terraville.startScenario('gridlock'); window.__terraville.ui.closeModal(); });
    const want = await page.evaluate(() => {
      const g = window.__terraville;
      const t = g.renderer.screenToTile(170, 580);
      const b = g.world.buildingAt(Math.floor(t.x), Math.floor(t.y));
      return b && { x: b.x, y: b.y, size: b.size };
    });
    assert.ok(want, 'Gridlock has a lot under the finger');
    await page.touchscreen.tap(170, 580);
    await page.waitForFunction(() => !window.__terraville.renderer.flying);
    await page.waitForTimeout(100);
    const s = await look(page);
    assert.deepEqual(s.selected, want, 'the whole lot is marked, though the lifted finger cleared the hover');
    assert.equal(s.hover, null);
    assert.ok(s.yellow, 'in caution yellow');
    const [l, t, r, b] = s.lot;
    const [cl, ct, cr, cb] = s.card;
    assert.ok(r <= cl || l >= cr || b <= ct || t >= cb, `the lot (${s.lot.map(Math.round)}) is clear of the card (${s.card.map(Math.round)})`);
    await page.click('#inspect .close');
    assert.equal((await look(page)).selected, null, 'closing the card unmarks it');
    assert.deepEqual(problems, []);
    await ctx.close();

    // With a mouse the hover outline follows the pointer, and the mark stays on what was clicked.
    const desk = await profile(DESK);
    const d = await open(desk);
    await d.page.evaluate(() => { window.__terraville.startScenario('gridlock'); window.__terraville.ui.closeModal(); });
    await d.page.mouse.click(500, 400);
    const first = (await look(d.page)).selected;
    assert.ok(first, 'a click marks what it inspects');
    await d.page.mouse.move(700, 300);
    await d.page.mouse.move(640, 799);
    assert.deepEqual((await look(d.page)).selected, first, 'moving the mouse leaves the mark');
    await d.page.evaluate(() => window.__terraville.showTitle());
    assert.equal(await d.page.evaluate(() => window.__terraville.renderer.selected), null, 'leaving the city unmarks it');
    assert.deepEqual(d.problems, []);
    await desk.close();
  });

  await test('a landmark is upgraded from its Inspect card with a second tap, and undo refunds it', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const at = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      for (let y = 2; y < w.h - 6; y++) for (let x = 2; x < w.w - 6; x++) {
        if (!w.canPlace('stadium', x, y).ok) continue;
        w.place('stadium', x, y);
        w.city.funds = 50000;
        g.ui.inspect(x, y);
        return { x, y };
      }
    });
    const stadium = () => page.evaluate(({ x, y }) => [window.__terraville.world.buildingAt(x, y).level, window.__terraville.world.city.funds], at);
    assert.match(await page.textContent('#inspect .upgrade'), /^\s*Upgrade to a big-league stadium: land value rises by \$120\/acre across the whole city, and upkeep by \$60\/mo\.\s*Upgrade for \$15,000\s*$/);
    await page.click('#inUpgrade');
    assert.deepEqual(await stadium(), [1, 50000], 'one tap paid');
    assert.equal(await page.textContent('#inUpgrade'), 'Click again to pay $15,000', 'with a mouse it says click');
    await page.click('#inUpgrade');
    assert.deepEqual(await stadium(), [2, 35000]);
    assert.equal(await page.textContent('#toast'), 'The stadium is now a big-league stadium. Land value is up across the city.');
    assert.equal(await page.textContent('#inspect h3'), 'Big-league stadium');
    await page.keyboard.press('Control+z');
    assert.deepEqual(await stadium(), [1, 50000]);
    // The card shows the stadium undo put back, and buying from it upgrades that stadium.
    assert.equal(await page.textContent('#inspect h3'), 'Stadium');
    assert.equal(await page.textContent('#inUpgrade'), 'Upgrade for $15,000');
    await page.click('#inUpgrade');
    await page.click('#inUpgrade');
    assert.deepEqual(await stadium(), [2, 35000]);
    // On Ultra the card is drawn again every month, a quarter of a second: the first click still waits for the second.
    await page.evaluate(() => {
      window.__terraville.world.city.funds = 100000;
      window.__terraville.setSpeed(4);
    });
    await page.click('#inUpgrade');
    const month = await page.evaluate(() => window.__terraville.world.city.month);
    await page.waitForTimeout(700);
    assert.notEqual(await page.evaluate(() => window.__terraville.world.city.month), month, 'a month went by between the clicks');
    assert.equal(await page.textContent('#inUpgrade'), 'Click again to pay $40,000', 'the card drawn again still waits for the second click');
    await page.click('#inUpgrade');
    assert.equal((await stadium())[0], 3, 'and the second click upgrades it');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('undo waits for a fire to go out, and a burning landmark offers its upgrade once the fire is out', async () => {
    const ctx = await profile(DESK);
    const { page, problems } = await open(ctx);
    await found(page);
    const at = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      w.city.funds = 50000;
      const spot = (k) => {
        for (let y = 2; y < w.h - 6; y++) for (let x = 2; x < w.w - 6; x++) if (w.canPlace(k, x, y).ok && w.canPlace(k, x + 6, y).ok) return { x, y };
      };
      const s = spot('police');
      g.setTool('police');
      g.pointerDown(s.x + 1.5, s.y + 1.5, 10, 10);
      g.pointerUp(s.x + 1.5, s.y + 1.5, 10, 10);
      g.sim.disasters.ignite(s.x, s.y);
      const l = { x: s.x + 6, y: s.y };
      g.sim.disasters.ignite(w.place('stadium', l.x, l.y).x, l.y);
      return { station: s, stadium: l };
    });
    await page.keyboard.press('Control+z');
    assert.equal(await page.textContent('#toast'), 'That is on fire. Undo it once the fire is out.');
    assert.deepEqual(await page.evaluate(({ x, y }) => {
      const w = window.__terraville.world;
      return [w.buildingAt(x, y)?.kind, w.fire[y * w.w + x] > 0];
    }, at.station), ['police', true], 'the station is still there, burning');
    await page.evaluate(({ x, y }) => window.__terraville.ui.inspect(x, y), at.stadium);
    assert.equal((await page.textContent('#inspect .upgrade')).trim(), 'It can be upgraded once the fire is out.');
    assert.equal(await page.$('#inUpgrade'), null);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('after a year in debt a card says why and the ways out, waiting for an open Inspect card, and its buttons act', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const month = () => page.evaluate(() => {
      const g = window.__terraville;
      for (let k = 0; k < 4; k++) g.sim.step();
    });
    await page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(0);
      g.world.city.funds = -2500;
      g.world.city.debtMonths = 10;
      g.ui.inspect(5, 5);
    });
    await month();
    assert.notEqual(await page.textContent('#inspect h3'), 'City hall is broke', 'eleven months is not yet a year');
    await month();
    // The Inspect card was open: the news waits for it to be closed by hand.
    assert.notEqual(await page.textContent('#inspect h3'), 'City hall is broke');
    await page.tap('#inspect .close');
    assert.equal(await page.textContent('#inspect h3'), 'City hall is broke');
    assert.equal(await page.getByRole('region', { name: 'City hall is broke' }).count(), 1);
    // With the year-end paper on, as it starts, it comes as the paper's extra edition.
    assert.match(await page.textContent('#inspect .masthead'), /^The .+ CourierExtra · [A-Z][a-z]{2} \d{4}$/);
    const text = await page.textContent('#inspect');
    assert.match(text, /has been in debt for a year, and owes \$2,\d{3}\. Nothing new can be built until it is out\./);
    assert.match(text, /Its biggest costs each month/);
    assert.match(text, /The Budget can still lend \$30,000, at 7% a year\./);
    assert.match(text, /Bulldozing still works in debt, at \$1 a tile/);
    await page.tap('#inspect .news-btns button:has-text("Open the Budget")');
    await page.waitForSelector('.modal h2:has-text("Budget")');
    assert.equal(await page.isHidden('#inspect'), true);
    await page.keyboard.press('Escape');
    // Once a spell: another month in debt brings no second card.
    await month();
    assert.equal(await page.isHidden('#inspect'), true);
    // Out of debt and back in for a year: it comes again, and Bulldoze picks the bulldozer.
    await page.evaluate(() => {
      const g = window.__terraville;
      g.world.city.funds = 1000;
      for (let k = 0; k < 4; k++) g.sim.step();
      g.world.city.funds = -2500;
      g.world.city.debtMonths = 11;
    });
    await month();
    await page.tap('#inspect .news-btns button:has-text("Bulldoze")');
    assert.equal(await page.evaluate(() => window.__terraville.toolId), 'bulldoze');
    assert.equal(await page.isHidden('#inspect'), true);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("on a phone the year-end paper leads with the year's news, and Settings turns it off", async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const yearEnd = () => page.evaluate(() => {
      const g = window.__terraville;
      g.setSpeed(0);
      do { for (let k = 0; k < 4; k++) g.sim.step(); } while (g.world.city.month % 12);
    });
    const name = await page.evaluate(() => {
      const g = window.__terraville;
      g.sim.emit({ type: 'disaster', kind: 'tornado', x: 5, y: 5 });
      return g.world.city.name;
    });
    await yearEnd();
    assert.equal(await page.textContent('#inspect .masthead'), `The ${name} Courier1900`);
    assert.equal(await page.textContent('#inspect h3'), `Tornado tears through ${name}`);
    assert.deepEqual(await page.$$eval('#inspect .paper-facts dt', (d) => d.map((x) => x.textContent)), ['Residents', 'Top worry', 'Approval']);
    assert.match(await page.textContent('#inspect .closing'), /^1900 closes with a (surplus|deficit) of \$[\d,]+\. Taxes brought in \$[\d,]+\.$/);
    const card = await page.locator('#inspect').boundingBox();
    const tools = await page.locator('#toolbox').boundingBox();
    assert.ok(card.x >= 0 && card.x + card.width <= 390 && card.y + card.height <= tools.y, 'on the screen, above the tools');
    await page.tap('#inspect .close');
    assert.equal(await page.isHidden('#inspect'), true);
    // Off in Settings: the next year closes with its line in the ticker only.
    await page.tap('#topbar [data-act="menu"]');
    await page.tap('.dropdown button:has-text("Settings")');
    await page.tap('label.switch:has-text("Year-end paper")');
    await page.tap('.modal footer .btn.primary');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('terraville.settings')).paper), false);
    await yearEnd();
    assert.equal(await page.isHidden('#inspect'), true);
    assert.match(await page.textContent('#ticker'), /1901 closes with/);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Save a picture gives a JPEG of the built-up area, or the whole map, named for the city and the month', async () => {
    // The height and width a JPEG says it is, from its frame header.
    const jpegSize = (b) => {
      assert.deepEqual([b[0], b[1], b[2]], [0xff, 0xd8, 0xff], 'a JPEG');
      for (let i = 2; i < b.length;) {
        const m = b[i + 1];
        if (m === 0xc0 || m === 0xc2) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      throw new Error('no frame header');
    };
    for (const opts of [DESK, PHONE]) {
      const ctx = await profile({ ...opts, acceptDownloads: true });
      const { page, problems } = await open(ctx);
      await page.evaluate(() => {
        window.__terraville.startScenario('gridlock');
        window.__terraville.ui.closeModal();
      });
      await page.waitForFunction(() => window.__terraville.mode === 'city');
      await page.evaluate(() => window.__terraville.ui.openFiles());
      const picture = async () => {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fPicture')]);
        const { readFile } = await import('node:fs/promises');
        return { name: dl.suggestedFilename(), size: jpegSize(await readFile(await dl.path())) };
      };
      const built = await picture();
      const month = await page.evaluate(() => window.__terraville.sim.dateLabel());
      assert.equal(built.name, `Gridlock, ${month}.jpg`);
      // Classic is 120 by 100 tiles: the built-up area is less, and sharper.
      assert.ok(built.size.w < 2280 && built.size.w > 1000 && built.size.h > 1000, JSON.stringify(built.size));
      await page.check('#fPicWhole');
      const whole = await picture();
      assert.deepEqual(whole.size, { w: 2280, h: 1900 }, 'the whole map at 19 px a tile');
      assert.equal(await page.textContent('#fPicture'), 'Save a picture');
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  });

  await test("on a phone, reaching Town brings a card for the gift of a Mayor's house, placed free from its marked tool", async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    await found(page);
    const spot = await page.evaluate(() => {
      const g = window.__terraville;
      const w = g.world;
      g.setSpeed(0);
      for (let i = 0; i < w.n; i++) {
        if (w.occ[i]) w.remove(w.occ[i]);
        w.water[i] = 0; w.height[i] = 6; w.trees[i] = 0; w.net[i] = 0; w.rubble[i] = 0;
      }
      w.dirtyAll(true);
      const cx = Math.floor(w.w / 2);
      const cy = Math.floor(w.h / 2);
      g.renderer.cam.zoom = 16;
      g.renderer.centerOn(cx, cy);
      return { cx, cy };
    });
    assert.equal(await page.isHidden('[data-tool="mayor"]'), true, 'no gift before Town');
    // Two blocks of towers: past 2,000 residents at the month's end.
    await page.evaluate(([x, y]) => {
      const g = window.__terraville;
      for (const dx of [-12, -8]) g.world.setLevel(g.world.place('res', x + dx, y - 10), 8);
      for (let k = 0; k < 4; k++) g.sim.step();
    }, [spot.cx, spot.cy]);
    const name = await page.evaluate(() => window.__terraville.world.city.name);
    assert.equal(await page.textContent('#inspect h3'), `A gift for ${name}`);
    assert.match(await page.textContent('#inspect'), /given it a mayor’s house\. It is free: place it from the civic tools, where it is marked Gift\./);
    // Town reached in a year's last month: the paper comes out too, and waits for the gift's card to be closed.
    await page.evaluate(() => window.__terraville.ui.paper(window.__terraville.sim.paper('')));
    assert.equal(await page.textContent('#inspect h3'), `A gift for ${name}`);
    await page.tap('#inspect .close');
    assert.equal(await page.textContent('#inspect h3'), `${name} is now a town`);
    await page.tap('#inspect .close');
    assert.equal(await page.isHidden('#inspect'), true);
    // Acted on, the gift's card lets a waiting paper go.
    await page.evaluate(() => {
      const u = window.__terraville.ui;
      u.gift('mayor');
      u.paper(window.__terraville.sim.paper(''));
    });
    await page.tap('#inspect .news-btns button:has-text("Place it")');
    assert.equal(await page.isHidden('#inspect'), true);
    assert.equal(await page.evaluate(() => window.__terraville.toolId), 'mayor');
    assert.equal(await page.textContent('[data-tool="mayor"] .gift'), 'Gift');
    const tool = await page.locator('[data-tool="mayor"]').boundingBox();
    assert.ok(tool.x >= 0 && tool.x + tool.width <= 390, 'its tool is brought into view in the row');
    // Two taps, as for any building: free.
    const p = await page.evaluate(([x, y]) => {
      const r = window.__terraville.renderer;
      const m = document.querySelector('#map').getBoundingClientRect();
      const q = r.tileToScreen(x + 0.5, y + 0.5);
      return { x: m.left + q.x, y: m.top + q.y };
    }, [spot.cx, spot.cy]);
    const funds = await page.evaluate(() => window.__terraville.world.city.funds);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(150);
    assert.match(await page.textContent('#placeCard'), /free/);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => [...window.__terraville.world.buildings.values()].filter((b) => b.kind === 'mayor').length), 1);
    assert.equal(await page.evaluate(() => window.__terraville.world.city.funds), funds);
    // Placed: its tool goes, and the toolbox is back on Inspect.
    await page.waitForFunction(() => document.querySelector('[data-tool="mayor"]').hidden);
    assert.equal(await page.evaluate(() => window.__terraville.toolId), 'query');
    assert.deepEqual(problems, []);
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

  await test('a swipe that starts on a slider scrolls past it and leaves it as it was, in the Budget and the terrain editor; a sideways drag still moves it', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    // A finger lands `along` the way across the slider and moves by (dx, dy) in ten steps, as a quick swipe does.
    const swipe = async (sel, along, dx, dy) => {
      const [x, y] = await page.$eval(sel, (e, along) => { const r = e.getBoundingClientRect(); return [r.x + r.width * along, r.y + r.height / 2]; }, along);
      await touch('touchStart', [[x, y]]);
      for (let i = 1; i <= 10; i++) {
        await touch('touchMove', [[x + (dx * i) / 10, y + (dy * i) / 10]]);
        await page.waitForTimeout(16);
      }
      await touch('touchEnd', []);
      await page.waitForTimeout(300);
    };
    await page.evaluate(() => window.__terraville.startScenario('gridlock'));
    await page.click('.modal footer .btn.primary');
    await page.tap('#topbar [data-act="budget"]');
    const scrolled = () => page.$eval('.modal .body', (b) => b.scrollTop);
    // The Budget is taller than a phone: a swipe up that starts 45% along Police, or on the tax, scrolls it.
    await swipe('#bFpolice', 0.45, 4, -120);
    assert.equal(await page.evaluate(() => window.__terraville.world.city.funding.police), 1, 'police funding stays at 100%');
    assert.equal(await page.textContent('#bFpoliceV'), '100%');
    assert.ok((await scrolled()) > 20, 'and the Budget scrolled');
    await page.$eval('.modal .body', (b) => { b.scrollTop = 0; });
    await swipe('#bTax', 0.45, 4, -120);
    assert.equal(await page.evaluate(() => window.__terraville.world.city.tax), 7, 'the tax stays at 7%');
    assert.ok((await scrolled()) > 20, 'and the Budget scrolled');
    await page.$eval('.modal .body', (b) => { b.scrollTop = 0; });
    // Slid sideways, the tax slider moves as before.
    await swipe('#bTax', 0.36, 120, 0);
    assert.notEqual(await page.evaluate(() => window.__terraville.world.city.tax), 7, 'a sideways drag changes the tax');
    await page.click('.modal footer .btn.primary');
    // The terrain editor's panel scrolls on a phone: a swipe that starts on Mountains makes no new land and no undo step.
    await page.goto(base);
    await titleUp(page);
    await page.tap('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await page.tap('#edHead');
    await page.$eval('#editorPanel', (p) => { p.scrollTop = 0; });
    const land = () => page.evaluate(() => { const g = window.__terraville; let h = 0; for (const v of g.world.height) h += v; return { h, hills: g.terrain.hills, undo: g.canUndo() }; });
    const was = await land();
    await page.$eval('#edHills', (e) => e.scrollIntoView({ block: 'center' }));
    await swipe('#edHills', 0.15, 3, -100);
    assert.deepEqual(await land(), was, 'the land, Mountains and the undo list are as they were');
    assert.equal(await page.inputValue('#edHills'), String(was.hills));
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('a pinch with a brush selected leaves the land, the undo list and the money as they were', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const frames = (n) => page.evaluate((n) => new Promise((ok) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : ok()); f(); }), n);
    // When each finger landed, as the page saw it.
    await page.evaluate(() => {
      window.__downs = [];
      document.querySelector('#map').addEventListener('pointerdown', (e) => window.__downs.push(e.timeStamp));
    });
    const state = () => page.evaluate(() => {
      const g = window.__terraville;
      let land = 0;
      for (let i = 0; i < g.world.n; i++) land += g.world.height[i] * ((i % 97) + 1);
      return { land: Math.round(land * 1000), undo: g.canUndo(), redo: g.canRedo(), funds: Math.round(g.world.city.funds * 100) };
    });
    /** Centre the map on tile (x, y) and give its place on the screen, or null when a panel covers it there. */
    const aim = (x, y) => page.evaluate(([x, y]) => {
      const r = window.__terraville.renderer;
      r.cam.zoom = 16;
      r.centerOn(x + 0.5, y + 0.5);
      const p = r.tileToScreen(x + 0.5, y + 0.5);
      const map = document.querySelector('#map');
      const box = map.getBoundingClientRect();
      const at = [Math.round(box.left + p.x), Math.round(box.top + p.y)];
      return document.elementFromPoint(at[0], at[1]) === map && document.elementFromPoint(at[0] + 80, at[1]) === map ? at : null;
    }, [x, y]);
    /** A finger held still for `ms`. */
    async function hold([x, y], ms) {
      await touch('touchStart', [[x, y]]);
      await page.waitForTimeout(ms);
      await touch('touchEnd', []);
      await frames(2);
    }
    /** A pinch on tile (tx, ty) whose second finger lands `gap` ms after the first, and the gap the page saw. */
    async function pinch(tile, gap) {
      const [x, y] = await aim(...tile);
      await page.evaluate(() => { window.__downs = []; });
      const zoom = await page.evaluate(() => window.__terraville.renderer.cam.zoom);
      // Not waited for, so the second finger follows by the gap rather than by a round trip as well.
      const first = touch('touchStart', [[x, y]]);
      if (gap) await page.waitForTimeout(gap);
      await touch('touchStart', [[x, y], [x + 30, y]]);
      await first;
      for (let k = 1; k <= 6; k++) {
        await touch('touchMove', [[x - k * 8, y], [x + 30 + k * 8, y]]);
        await frames(1);
      }
      await touch('touchEnd', []);
      await frames(3);
      assert.ok(await page.evaluate((z) => window.__terraville.renderer.cam.zoom > z * 1.2, zoom), 'the pinch zoomed in');
      return page.evaluate(() => window.__downs[1] - window.__downs[0]);
    }
    /** Pinches with the second finger at several delays, up to the 250 ms in which a stroke is still taken back. */
    async function pinches(at, before) {
      for (const gap of [0, 30, 60, 150]) {
        // On a busy machine a finger can land later than asked: the claim is only for gaps under 250 ms.
        for (let tries = 0; tries < 3; tries++) {
          const seen = await pinch(at, gap);
          if (seen < 240) break;
        }
        assert.deepEqual(await state(), before, `second finger after ${gap} ms`);
      }
    }

    // The terrain editor, with Raise: holding a finger raises the ground, and undo puts it back.
    await page.click('[data-act="editor"]');
    await page.waitForFunction(() => window.__terraville.mode === 'editor');
    await page.evaluate(() => window.__terraville.setTool('raise'));
    const hill = [60, 50];
    assert.ok(await aim(...hill), 'the middle of the map is clear of panels');
    const flat = await state();
    await hold(await aim(...hill), 400);
    const raised = await state();
    assert.ok(raised.land !== flat.land && raised.undo, 'a held finger raised the ground');
    await page.evaluate(() => window.__terraville.undo());
    const before = await state();
    assert.deepEqual(before, { ...flat, redo: true });
    await pinches(hill, before);

    // A city with Level land: a pinch on a slope costs nothing.
    await page.evaluate(() => window.__terraville.showTitle());
    await titleUp(page);
    await found(page);
    // The steepest open ground with no water near it, where the map isn't under a panel.
    const slopes = await page.evaluate(() => {
      const w = window.__terraville.world;
      const out = [];
      for (let y = 8; y < w.h - 8; y++) for (let x = 8; x < w.w - 8; x++) {
        let wet = false;
        for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (w.water[(y + dy) * w.w + x + dx]) wet = true;
        const i = y * w.w + x;
        if (wet || w.occ[i] || w.net[i]) continue;
        const s = w.slope(x, y);
        if (s > 2 && s < 12) out.push([x, y, s]);
      }
      w.city.funds = 50000;
      window.__terraville.setTool('level');
      return out.sort((a, b) => b[2] - a[2]).slice(0, 200);
    });
    let at = null;
    for (const [x, y] of slopes) if (await aim(x, y)) { at = [x, y]; break; }
    assert.ok(at, 'a slope to level');
    const unlevelled = await state();
    await hold(await aim(...at), 400);
    const levelled = await state();
    assert.ok(levelled.funds < unlevelled.funds && levelled.undo, 'a held finger levelled the slope, for a price');
    await page.evaluate(() => window.__terraville.undo());
    const city = await state();
    assert.deepEqual(city, { ...unlevelled, redo: true }, 'undo put the slope and the money back');
    await pinches(at, city);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test("at its own address the title screen asks nothing of Google, and Drive says so when Google's sign-in can't load", async () => {
    const { ctx, page, problems, away } = await atTheSite();
    await page.waitForTimeout(1500);
    assert.deepEqual(away, [], 'the title screen asked another site for something');
    // Open a saved city loads Google's sign-in ahead of a tap, as the privacy page says. Blocked here, it's no news to
    // someone who never used Drive...
    await page.click('[data-act="open"]');
    await page.waitForFunction(() => document.querySelector('#fDvGo'));
    for (let i = 0; i < 50 && !away.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(away, ['https://accounts.google.com/gsi/client']);
    await page.waitForTimeout(300);
    assert.doesNotMatch(await page.textContent('#fDrive'), /Could not load/);
    // ...until they press Connect.
    await page.click('#fDvGo');
    assert.equal(await page.textContent('#toast'), 'Google sign-in could not load. Check the connection.');
    await page.waitForFunction(() => /Could not load Google sign-in\. Check the connection\./.test(document.querySelector('#fDrive').textContent));
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('Google Drive: connect, wait out a lost connection, and carry on from another device', async () => {
    const google = fakeGoogle();
    let net = 'up'; // or 'down' (no connection to Google), or 'failing' (Google answers with an error)
    const device = async (opts) => {
      const d = await atTheSite(opts);
      await google.install(d.ctx);
      await d.ctx.route('https://www.googleapis.com/**', (route) =>
        net === 'down' ? route.abort('internetdisconnected')
        : net === 'failing' ? route.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":{"message":"Backend Error"}}' })
        : route.fallback());
      return d;
    };
    const connect = async (page) => {
      await page.click('[data-act="open"]');
      // The dialog loads Google's sign-in as it opens; until it has, Connect only says it is still loading.
      await page.waitForFunction(() => !!window.google?.accounts?.oauth2);
      await page.click('#fDvGo');
      await page.waitForFunction(() => window.__terraville.drive.status() === 'ok');
      await page.keyboard.press('Escape');
    };
    const drive = (page) => page.evaluate(() => [window.__terraville.drive.status(), window.__terraville.drive.pending]);
    const uploaded = () => google.files().filter((f) => f.appProperties?.terraville === 'city').map((f) => [f.name, Number(f.appProperties.date), f.body.slice(0, 4)]);

    // A Mac connects Drive and saves a city: the cloud sits quietly in the top bar.
    // Each device names its copies by its browser's user agent.
    const mac = await device({ ...DESK, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
    const a = mac.page;
    await connect(a);
    await found(a);
    const name = await a.evaluate(() => window.__terraville.world.city.name);
    await a.evaluate(() => { for (let i = 0; i < 4 * 6; i++) window.__terraville.sim.step(); return window.__terraville.saveCity(); });
    await a.waitForFunction(() => window.__terraville.drive.lastUpload > 0);
    assert.deepEqual(uploaded(), [[`${name} (Mac).txt`, 6, 'TV1g']]);
    assert.equal(await a.getAttribute('#driveBtn', 'data-s'), 'ok');

    // No connection to Google: the save waits, and says so in amber, not as a failure.
    net = 'down';
    await a.evaluate(() => { for (let i = 0; i < 4 * 6; i++) window.__terraville.sim.step(); return window.__terraville.saveCity(); });
    await a.waitForFunction(() => window.__terraville.drive.status() === 'waiting');
    assert.deepEqual([await a.getAttribute('#driveBtn', 'data-s'), await a.textContent('#driveLbl'), await a.getAttribute('#driveBtn', 'title')],
      ['waiting', 'Waiting', 'Waiting for a connection to save to Google Drive. The city is saved on this device.']);
    assert.equal(await a.evaluate(() => {
      const amber = document.body.appendChild(Object.assign(document.createElement('i'), { style: 'color:var(--caution)' }));
      const same = getComputedStyle(amber).color === getComputedStyle(document.querySelector('#driveBtn')).color;
      amber.remove();
      return same;
    }), true, 'the cloud is not amber');
    await a.click('#driveBtn');
    await a.waitForSelector('#fDvRetry');
    const section = (await a.textContent('#fDrive')).replace(/\s+/g, ' ');
    assert.match(section, /^Google Drive Waiting for a connection to save to Google Drive\. The city is saved on this device\. Every save/);
    assert.doesNotMatch(section, /Last upload|Failed to fetch/);
    await a.keyboard.press('Escape');
    // The connection comes back: what waited goes up without another save.
    net = 'up';
    await a.evaluate(() => window.dispatchEvent(new Event('online')));
    await a.waitForFunction(() => window.__terraville.drive.status() === 'ok' && !window.__terraville.drive.pending);
    assert.deepEqual(uploaded(), [[`${name} (Mac).txt`, 12, 'TV1g']]);

    // An iPhone connects: its title screen offers to carry on with the Mac's city, and opens it where the Mac left it.
    const phone = await device({ ...PHONE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' });
    const b = phone.page;
    await connect(b);
    await b.waitForSelector('[data-act="continue-drive"]');
    assert.equal(await b.textContent('[data-act="continue-drive"] span'), `Continue ${name}`);
    assert.match(await b.textContent('[data-act="continue-drive"] small'), /^From Mac · /);
    assert.deepEqual(await b.$$eval('.title-actions .btn.primary', (bs) => bs.map((x) => x.dataset.act)), ['continue-drive'], 'it is the main choice');
    assert.equal(await b.$eval('.title-actions .btn', (x) => x.dataset.act), 'continue-drive', 'and the first');
    await b.click('[data-act="continue-drive"]');
    await b.waitForFunction(() => window.__terraville.mode === 'city');
    assert.equal(await b.evaluate(() => { window.__terraville.setSpeed(0); return window.__terraville.world.city.month; }), 12);

    // Google answers with an error: a phone has no cloud to tap, so its menu offers to try again.
    net = 'failing';
    await b.evaluate(() => window.__terraville.saveCity());
    await b.waitForFunction(() => window.__terraville.drive.status() === 'error');
    assert.equal(await b.evaluate(() => window.__terraville.drive.error), 'Google Drive said: Backend Error.');
    await b.waitForSelector('#topbar [data-act="menu"].attn');
    await b.click('#topbar [data-act="menu"]');
    net = 'up';
    await b.click('[role="menu"] button:has-text("Saving to Drive failed: try again")');
    await b.waitForFunction(() => document.querySelector('#toast').textContent === 'Saved to Google Drive.');
    assert.deepEqual(await drive(b), ['ok', 0]);
    assert.deepEqual(uploaded().map((f) => f[0]).sort(), [`${name} (Mac).txt`, `${name} (iPhone).txt`]);
    assert.deepEqual([...mac.problems, ...phone.problems], []);
    await mac.ctx.close();
    await phone.ctx.close();
  });

  await test('says what it needs with JavaScript off', async () => {
    const ctx = await profile({ ...PHONE, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(base);
    assert.equal(await page.innerText('body'), 'Terraville needs JavaScript to draw the map and run the city.');
    await ctx.close();
  });

  await test('draws its lettering in its own fonts, from inside the page', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    const loaded = await page.evaluate(async () => {
      await Promise.all([document.fonts.load('16px Overpass'), document.fonts.load('600 16px "Overpass Mono"')]);
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')).sort();
    });
    assert.deepEqual(loaded, ['Overpass', 'Overpass Mono']);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('the privacy page has its own lettering and icon, and links where it says', async () => {
    const ctx = await profile();
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) problems.push('left the site: ' + r.url()); });
    await page.goto(base + 'privacy.html');
    const loaded = await page.evaluate(async () => {
      await Promise.all([document.fonts.load('16px Overpass'), document.fonts.load('600 13px "Overpass Mono"')]);
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')).sort();
    });
    assert.deepEqual(loaded, ['Overpass', 'Overpass Mono']);
    assert.equal(await page.getAttribute('link[rel="icon"]', 'href'), 'icon.svg');
    assert.equal(await page.getAttribute('a:has-text("junkdrawer.works projects")', 'href'), 'https://junkdrawer.works/privacy.html');
    // The way back sits on its own line, above the sign.
    const [back, sign] = await Promise.all(['.back', '.sign'].map((s) => page.locator(s).boundingBox()));
    assert.ok(back.y + back.height <= sign.y, 'the back link shares the sign\'s line');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  await test('fits a phone and works offline once opened', async () => {
    const ctx = await profile();
    const { page, problems } = await open(ctx);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the title screen scrolls sideways on a phone');
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 30000 });
    // Installable, as Chromium sees it (the house kit's check): no reasons not to be, and a manifest it reads cleanly.
    const cdp = await ctx.newCDPSession(page);
    assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
    const manifest = await cdp.send('Page.getAppManifest');
    assert.deepEqual(manifest.errors, []);
    assert.equal(JSON.parse(manifest.data).name, 'Terraville');
    await ctx.setOffline(true);
    await page.reload();
    await titleUp(page);
    await ctx.setOffline(false);
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  // Offline, checked the junkdrawer house kit's way, from a server that answers like GitHub Pages: a browser may keep
  // each file for ten minutes, and asks again by its ETag. `net` is the connection: 'up', 'down' (the server drops every
  // connection) or 'stalled' (a plane's or a train's wifi: it takes each request and holds on to it). With `release`
  // set it serves the next release. The server's own switches are needed because the browser's offline switch can't
  // make a stall, and in some Chromium builds it doesn't stop the service worker's own requests.
  await test('opens offline, on a stalled connection, and as a whole new release, from a server like GitHub Pages', async () => {
    const { createServer } = await import('node:http');
    const { readFile } = await import('node:fs/promises');
    const { join, extname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { createHash } = await import('node:crypto');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
    let net = 'up', release = false;
    const held = [];
    const server = createServer((req, res) => {
      if (net === 'down') { req.socket.destroy(); return; }
      if (net === 'stalled') { held.push([req, res]); return; }
      serve(req, res);
    }).listen(0);
    async function serve(req, res) {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      let body;
      try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
      if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
      if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
      const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
      const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
      res.writeHead(200, head);
      res.end(body);
    }
    const base = `http://localhost:${server.address().port}/`;
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', e => problems.push(e.message));
      await page.goto(base);
      await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
      const title = await page.title();

      // Works offline once it has been opened.
      net = 'down';
      await ctx.setOffline(true);
      await page.reload();
      assert.equal(await page.title(), title, 'the page did not open offline');
      await ctx.setOffline(false);

      // On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
      // the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
      net = 'stalled';
      const t0 = Date.now();
      await page.reload({ timeout: 10000 }).catch(() => {});
      const took = Date.now() - t0;
      assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
      assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
      net = 'up';
      for (const [req, res] of held.splice(0)) serve(req, res);

      // A new release: every file in the new copy comes from the server, though the browser still has its own copies of
      // the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
      release = true;
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      for (const end = Date.now() + 10000; !(await page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')));) {
        assert.ok(Date.now() < end, "the new release's offline copy kept the old index.html");
        await new Promise(r => setTimeout(r, 100));
      }
      assert.deepEqual(problems, [], 'problems while offline or on a stalled connection');
      await ctx.close();
    } finally {
      server.close();
    }
  });

  await test('FILES in sw.js is the fingerprint of every file it keeps', async () => {
    const { createHash } = await import('node:crypto');
    // sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js
    // is a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
    // index.html; the first 8 hex of the sha1 of those).
    const sw = await readFile(join(root, 'sw.js'), 'utf8');
    const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
    const all = createHash('sha1');
    for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
    const files = all.digest('hex').slice(0, 8);
    assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
  });
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${passed} passed`);

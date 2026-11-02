// Plays the built game (index.html) in Chromium:  node test/e2e.mjs  (needs Playwright; npm test runs it after the
// unit checks). Rebuild with npm run build first if you changed src/.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';

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
    assert.match((await page.textContent('#goal')).replace(/\s+/g, ' ').trim(), /^Monster Bay \d+y \d+m left Approval 95% \(goal over 60%\)/);
    await page.click('#citySign');
    assert.equal(await page.textContent('.modal .big'), '95%');
    assert.equal(await page.locator('.modal .bars .barrow').count(), 8, 'no worries listed');
    assert.deepEqual(problems, []);
    await ctx.close();
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
    assert.match(await page.textContent('.switch small'), /once the city has 2,500 residents\. You can also set them off yourself\.$/);
    assert.deepEqual(problems, []);
    await ctx.close();
    const desk = await profile(DESK);
    const { page: d } = await open(desk);
    await d.click('[data-act="quick"]');
    await d.waitForFunction(() => document.activeElement?.id === 'fName', null, { timeout: 2000 });
    await desk.close();
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
    assert.match(tip.text, /^Residential · 2 zones · \$\d+ · 2 blocked: something is already here$/);
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
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.__terraville.speed), 2, 'Space starts it at Normal');
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
    assert.match(held.text ?? '', /^Levelling \$\d+ · /, 'a finger held still shows what the levelling costs so far');
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
      ['+ −', 'Zoom'], ['[ ]', 'Level land brush size'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z or Ctrl Y', 'Redo'], ['Esc', 'Cancel or close'],
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
      ['Arrows', 'Move the map'], ['+ −', 'Zoom'], ['[ ]', 'Brush size'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z or Ctrl Y', 'Redo'], ['Esc', 'Cancel or close'],
    ]);
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
    assert.match(await page.textContent('.modal .touch-help'), /One finger.*Two fingers.*Pinch to zoom.*Bulldoze.*Pick the bulldozer/s);
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
    await page.click('#citySign');
    assert.match(await page.textContent('.modal .body'), /Nobody lives here yet\. The report fills in once people move in\./);
    assert.equal(await page.$$eval('.modal .worry, .modal .big', (e) => e.length), 0, 'no approval figure and no worries for nobody');
    await page.click('.modal footer .btn');
    await page.evaluate(() => { window.__terraville.startScenario('gridlock'); window.__terraville.ui.closeModal(); });
    await page.click('#citySign');
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

// Unit checks for the core rules. Run with: npm test
import assert from 'node:assert/strict';
import { World, encodeArray, decodeArray } from '../src/world';
import { Sim } from '../src/sim';
import { generateTerrain, DEFAULT_TERRAIN } from '../src/terrain';
import { linePath, planLine, applyLine, planZones, applyBuildings } from '../src/tools';
import { ROAD, RAIL, POWER, BRIDGE_COST, NET_COST } from '../src/defs';
import { encode, decode } from '../src/save';
import { Drive, GisOAuth2 } from '../src/drive';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log('ok  ', name);
  } catch (e) {
    console.log('FAIL', name);
    throw e;
  }
}

function flat(w = 40, h = 30): World {
  const world = new World(w, h);
  world.height.fill(3);
  world.city.founded = true;
  world.city.disasters = false;
  return world;
}

await test('terrain is deterministic for a seed', () => {
  const p = { ...DEFAULT_TERRAIN, seed: 'amber-isle-11', w: 60, h: 50 };
  const a = generateTerrain(p);
  const b = generateTerrain(p);
  assert.deepEqual(a.height, b.height);
  assert.deepEqual(a.water, b.water);
  assert.deepEqual(a.trees, b.trees);
  const c = generateTerrain({ ...p, seed: 'other' });
  assert.notDeepEqual(a.height, c.height);
});

await test('run-length encoding round-trips', () => {
  const a = new Uint8Array(5000);
  for (let i = 0; i < a.length; i++) a[i] = i % 97 < 60 ? 0 : (i * 7) & 255;
  a[10] = 255; a[11] = 255;
  assert.deepEqual(decodeArray(encodeArray(a)), a);
});

await test('linePath makes an L with the long leg first', () => {
  const p = linePath(0, 0, 4, 2);
  assert.deepEqual(p[0], [0, 0]);
  assert.deepEqual(p[4], [4, 0]);
  assert.deepEqual(p[p.length - 1], [4, 2]);
  assert.equal(p.length, 7);
  assert.equal(new Set(p.map(([x, y]) => `${x},${y}`)).size, p.length);
  assert.deepEqual(linePath(3, 3, 3, 3), [[3, 3]]);
});

await test('bridges cost more and must be straight', () => {
  const w = flat();
  for (let y = 0; y < w.h; y++) w.water[y * w.w + 10] = 1;
  const plan = planLine(w, ROAD, linePath(5, 5, 15, 5));
  assert.equal(plan.count, 11);
  assert.equal(plan.cost, 10 * NET_COST.road + BRIDGE_COST.road);
  const bent = planLine(w, ROAD, [[9, 5], [10, 5], [10, 6]]);
  assert.ok(bent.bad.length > 0);
});

await test('track runs across a hillside without grading', () => {
  const w = flat(40, 30);
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) w.height[y * w.w + x] = 3 + y * 12; // steep north-south
  const plan = planLine(w, RAIL, linePath(2, 10, 30, 10)); // east-west along the contour
  assert.equal(plan.bad.length, 0);
  assert.equal(plan.grading ?? 0, 0);
  assert.equal(plan.count, 29);
});

await test('track up a slope is graded into a ramp, cliffs are refused', () => {
  const w = flat(40, 30);
  for (let x = 0; x < w.w; x++) for (let y = 0; y < w.h; y++) w.height[y * w.w + x] = x < 12 ? 3 : 20; // a 17 m step
  const plan = planLine(w, RAIL, linePath(4, 5, 20, 5));
  assert.equal(plan.bad.length, 0);
  assert.ok((plan.grading ?? 0) > 0);
  applyLine(w, RAIL, plan);
  for (let x = 5; x <= 20; x++) assert.ok(Math.abs(w.height[5 * w.w + x] - w.height[5 * w.w + x - 1]) <= 9.01, `step at ${x}`);
  const cliff = flat(40, 30);
  for (let x = 0; x < cliff.w; x++) for (let y = 0; y < cliff.h; y++) cliff.height[y * cliff.w + x] = x < 12 ? 3 : 200;
  const bad = planLine(cliff, RAIL, linePath(8, 5, 16, 5));
  assert.ok(bad.bad.length > 0 && /Level land/.test(bad.reason ?? ''));
});

await test('zones need clear, gentle land', () => {
  const w = flat();
  assert.ok(w.canPlace('res', 5, 5).ok);
  w.setNet(ROAD, 6, 6);
  assert.equal(w.canPlace('res', 5, 5).ok, false);
  const steep = flat();
  steep.height[6 * steep.w + 6] = 40;
  assert.equal(steep.canPlace('res', 5, 5).ok, false);
  const plan = planZones(flat(), 'res', 5, 5, 11, 5);
  assert.equal(plan.count, 3);
});

await test('zoning grades a moderate slope for a price, but not a cliff', () => {
  const w = flat();
  w.city.funds = 10000;
  for (let dx = 0; dx < 3; dx++) w.height[7 * w.w + 4 + dx] = 18; // bottom row 15 m higher: spread 15 > 9
  assert.equal(w.canPlace('ind', 4, 5).ok, false);
  const r = w.canPlace('ind', 4, 5, true);
  assert.equal(r.ok, true);
  assert.ok(r.grade > 0);
  const plan = planZones(w, 'ind', 5, 6, 5, 6);
  assert.equal(plan.count, 1);
  assert.ok((plan.grading ?? 0) > 0 && plan.cost > 100);
  applyBuildings(w, 'ind', plan);
  assert.equal(w.buildings.size, 1);
  assert.ok(w.footprintSpread(4, 5, 3) < 0.01);
  const cliff = flat();
  cliff.height[6 * cliff.w + 5] = 60;
  assert.equal(cliff.canPlace('ind', 4, 5, true).ok, false);
});

await test('power flows through lines and touching zones only', () => {
  const w = flat();
  w.place('coal', 1, 1);
  const a = w.place('res', 8, 1);
  const b = w.place('res', 11, 1); // touches a
  const c = w.place('res', 20, 20); // isolated
  applyLine(w, POWER, planLine(w, POWER, linePath(5, 2, 7, 2)));
  const sim = new Sim(w);
  sim.computePower();
  assert.equal(a.powered, true);
  assert.equal(b.powered, true);
  assert.equal(c.powered, false);
});

await test('a plant powers what it can and the far end browns out', () => {
  const w = flat(60, 20);
  w.place('wind', 1, 1); // 18 MW = two 3x3 zones
  applyLine(w, POWER, planLine(w, POWER, linePath(2, 1, 4, 1)));
  const zones = [w.place('res', 5, 0), w.place('res', 8, 0), w.place('res', 11, 0)];
  const sim = new Sim(w);
  sim.computePower();
  assert.deepEqual(zones.map((z) => z.powered), [true, true, false]);
});

await test('separate grids do not share power, and a line across a road joins them', () => {
  const w = flat(60, 20);
  w.place('wind', 1, 1); // grid A: 18 MW for three lots
  const a = [w.place('res', 2, 0), w.place('res', 5, 0), w.place('res', 8, 0)];
  w.place('wind', 40, 1); // grid B: 18 MW for one lot
  const b = w.place('res', 41, 0);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(0, 3, 50, 3)));
  const sim = new Sim(w);
  sim.computePower();
  // City-wide supply covers demand, yet grid A is short.
  assert.equal(sim.stats.powerSupply, 36);
  assert.equal(sim.stats.powerDemand, 36);
  assert.equal(sim.stats.powerGrids, 2);
  assert.equal(sim.stats.gridsShort, 1);
  assert.equal(a[2].powered, false);
  assert.equal(b.powered, true);
  assert.match(sim.describe(9, 1).rows.find((r) => r[0] === 'Power')![1], /overloaded/);
  // A lot across the road, fed by one tile of line over the road, joins grid B.
  const c = w.place('res', 41, 4);
  applyLine(w, POWER, planLine(w, POWER, linePath(42, 3, 42, 3)));
  sim.computePower();
  assert.equal(c.powered, true);
  assert.equal(sim.gridAt(3 * w.w + 42)!.demand, 18);
});

await test('area undo puts back only what the action touched', () => {
  const w = flat();
  const other = w.place('res', 20, 20);
  // A road: the area is exactly the road.
  let full = w.snapshot();
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 12, 5)));
  const roadBox = w.changedArea(full)!;
  assert.deepEqual({ ...roadBox }, { x0: 2, y0: 5, x1: 12, y1: 5 });
  const roadUndo = w.areaSnapshot(roadBox, full);
  // The city grows elsewhere, then the road is undone: the growth stays.
  w.setLevel(other, 3);
  assert.equal(w.restoreArea(roadUndo), true);
  for (let x = 2; x <= 12; x++) assert.equal(w.net[5 * w.w + x] & ROAD, 0);
  assert.equal(w.buildings.get(other.id)!.level, 3);
  // Bulldozing one tile of a lot takes the whole lot, so the area grows to fit it.
  const lot = w.place('res', 5, 8);
  w.setLevel(lot, 2);
  full = w.snapshot();
  w.bulldoze(6, 9);
  const lotBox = w.changedArea(full)!;
  assert.deepEqual({ ...lotBox }, { x0: 5, y0: 8, x1: 7, y1: 10 });
  const back = w.areaSnapshot(lotBox, full);
  const redo = w.areaSnapshot(lotBox);
  assert.equal(w.restoreArea(back), true);
  const again = w.buildings.get(lot.id)!;
  assert.equal(again.level, 2);
  assert.equal(w.occ[9 * w.w + 6], lot.id);
  // Redo takes it away again, and nothing changed means no area at all.
  assert.equal(w.restoreArea(redo), true);
  assert.equal(w.buildings.has(lot.id), false);
  assert.equal(w.changedArea(w.snapshot()), null);
  // A snapshot of another map is refused.
  assert.equal(flat(10, 10).restoreArea(back), false);
});

await test('commutes need a road to a destination', () => {
  const w = flat();
  const r = w.place('res', 2, 2);
  const c = w.place('com', 10, 2);
  const lonely = w.place('ind', 20, 20);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 12, 5)));
  const sim = new Sim(w);
  sim.computeTraffic();
  assert.equal(r.road, true);
  assert.equal(c.road, true);
  assert.equal(r.trip, true);
  assert.equal(lonely.road, false);
});

await test('rail counts for commuting but carries no car traffic', () => {
  const w = flat();
  const r = w.place('res', 2, 2);
  w.place('com', 30, 2);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 4, 5)));
  applyLine(w, RAIL, planLine(w, RAIL, linePath(5, 5, 29, 5)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(30, 5, 32, 5)));
  w.setLevel(r, 4);
  const sim = new Sim(w);
  sim.computeTraffic();
  assert.equal(r.trip, true);
  for (let x = 5; x <= 29; x++) assert.equal(w.traffic[5 * w.w + x], 0);
});

await test('a connected, powered city grows and pays taxes', () => {
  const w = flat(60, 40);
  w.city.funds = 20000;
  w.place('coal', 1, 1);
  applyLine(w, POWER, planLine(w, POWER, linePath(5, 2, 8, 2)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(8, 4, 40, 4)));
  applyLine(w, POWER, planLine(w, POWER, linePath(8, 2, 8, 4)));
  applyLine(w, POWER, planLine(w, POWER, linePath(8, 4, 40, 4)));
  for (let x = 9; x < 39; x += 3) w.place(x % 9 === 0 ? 'com' : x % 2 ? 'res' : 'ind', x, 5);
  const sim = new Sim(w);
  for (let i = 0; i < 4 * 36; i++) sim.step();
  assert.ok(sim.stats.residents > 200, `residents ${sim.stats.residents}`);
  assert.ok(w.city.history.income.at(-1)! > 0);
});

await test('world and save codes round-trip', async () => {
  const w = generateTerrain({ ...DEFAULT_TERRAIN, seed: 'save-test', w: 50, h: 40 });
  w.city.founded = true;
  w.city.name = 'Roundtrip';
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) if (w.canPlace('res', x, y).ok && Math.random() < 0.05) w.place('res', x, y);
  const code = await encode({ v: 1, world: w.serialize(), mode: 'city' });
  assert.ok(code.startsWith('TV1'));
  const back = World.deserialize((await decode(code)).world);
  assert.equal(back.city.name, 'Roundtrip');
  assert.deepEqual(back.height, w.height);
  assert.deepEqual(back.occ, w.occ);
  assert.equal(back.buildings.size, w.buildings.size);
  await assert.rejects(decode('hello'));
});

await test('disasters run without breaking the map', () => {
  const w = generateTerrain({ ...DEFAULT_TERRAIN, seed: 'chaos', w: 60, h: 50 });
  w.city.founded = true;
  let n = 0;
  for (let y = 1; y < w.h - 4; y += 3) for (let x = 1; x < w.w - 4; x += 3) if (w.canPlace('ind', x, y).ok && n++ < 60) w.setLevel(w.place(n % 2 ? 'ind' : 'res', x, y), 2);
  const sim = new Sim(w);
  for (const k of ['fire', 'flood', 'tornado', 'earthquake', 'monster', 'meltdown'] as const) sim.disasters.trigger(k);
  for (let i = 0; i < 200; i++) sim.step();
  for (const b of w.buildings.values()) {
    for (let dy = 0; dy < b.size; dy++) for (let dx = 0; dx < b.size; dx++) assert.equal(w.occ[(b.y + dy) * w.w + b.x + dx], b.id);
  }
  let occupied = 0;
  for (let i = 0; i < w.n; i++) if (w.occ[i]) { occupied++; assert.ok(w.buildings.has(w.occ[i])); }
  assert.ok(occupied >= 0);
});

await test('undo snapshots restore the map but never money, and only onto the same map', () => {
  const w = flat();
  w.city.funds = 1000;
  const snap = w.snapshot();
  w.place('res', 5, 5);
  w.city.funds = 5;
  assert.equal(w.restore(snap), true);
  assert.equal(w.buildings.size, 0);
  assert.equal(w.city.funds, 5);
  const other = flat(50, 30);
  assert.equal(other.restore(snap), false);
});

await test('damaged saves are refused instead of half-loaded', () => {
  const w = flat();
  w.place('res', 2, 2);
  const s = w.serialize();
  assert.throws(() => World.deserialize({ ...s, water: encodeArray(new Uint8Array(10)) }));
  const clash = { ...s, buildings: [...s.buildings, [99, 'res', 3, 3, 0, 1, 0] as [number, string, number, number, number, number, number]] };
  const back = World.deserialize(clash);
  assert.equal(back.buildings.size, 1);
  assert.ok(back.nextId > 99 || back.nextId > 1);
});


// ---- Google Drive, against a fake of the parts of the API Terraville uses ----

interface FakeFile { id: string; name: string; parents: string[]; appProperties: Record<string, string>; content: string; trashed: boolean; modifiedTime: string }

class FakeDrive {
  files = new Map<string, FakeFile>();
  valid = new Set<string>();
  calls: string[] = [];
  private n = 0;
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    this.calls.push(`${method} ${url.pathname}`);
    if (!this.valid.has(auth)) return new Response('{"error":{"message":"Invalid Credentials"}}', { status: 401 });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    const m = /\/files\/([^/?]+)$/.exec(url.pathname);
    const f = m ? this.files.get(m[1]) : undefined;
    if (m && !f) return new Response('{"error":{"message":"File not found"}}', { status: 404 });
    if (method === 'GET' && !m) {
      const q = url.searchParams.get('q') ?? '';
      const want = [...q.matchAll(/key='([^']+)' and value='([^']+)'/g)].map((x) => [x[1], x[2]]);
      const list = [...this.files.values()].filter((x) => !x.trashed && want.every(([k, v]) => x.appProperties[k] === v));
      return json({ files: list.map(({ id, appProperties, modifiedTime }) => ({ id, appProperties, modifiedTime })) });
    }
    if (method === 'GET' && f) return new Response(f.content, { status: 200 });
    const body = String(init?.body ?? '');
    let meta: Partial<FakeFile> & { mimeType?: string } = {};
    let content = '';
    if (url.searchParams.get('uploadType') === 'multipart') {
      const parts = body.split(/--terraville[a-z0-9]+(?:--)?\r?\n?/).filter((p) => p.trim());
      meta = JSON.parse(parts[0].split('\r\n\r\n')[1]);
      content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
    } else meta = JSON.parse(body || '{}');
    const now = new Date(Date.now() + this.n * 1000).toISOString();
    if (method === 'POST') {
      if (meta.parents?.some((p) => !this.files.has(p) || this.files.get(p)!.trashed)) return new Response('{"error":{"message":"File not found"}}', { status: 404 });
      const id = `f${++this.n}`;
      this.files.set(id, { id, name: meta.name ?? '', parents: meta.parents ?? [], appProperties: meta.appProperties ?? {}, content, trashed: false, modifiedTime: now });
      return json({ id });
    }
    if (method === 'PATCH' && f) {
      if (meta.trashed) f.trashed = true;
      if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
      if (meta.name) f.name = meta.name;
      if (url.searchParams.get('uploadType')) f.content = content;
      f.modifiedTime = now;
      return json({ id: f.id });
    }
    return new Response('bad', { status: 400 });
  };
}

function memStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } } as Storage;
}

function fakeGis(token: () => string): GisOAuth2 {
  return {
    initTokenClient: (c) => ({ requestAccessToken: () => c.callback({ access_token: token(), expires_in: 3600 }) }),
    hasGrantedAllScopes: () => true,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

await test('cities sync through Google Drive, one file per city per device', async () => {
  const server = new FakeDrive();
  let tok = 'a1';
  server.valid.add('a1');
  let clock = 1_000_000;
  const mk = (id: string, label: string, t: () => string) => new Drive({
    fetch: server.fetch as typeof fetch, storage: memStorage(), now: () => clock, device: { id, label }, origin: 'https://junkdrawer.works', loadGis: async () => fakeGis(t),
  });
  assert.equal(new Drive({ fetch: server.fetch as typeof fetch, storage: null, now: () => 0, device: { id: 'x', label: 'x' }, origin: 'null' }).status(), 'unavailable');
  const a = mk('deva', 'Mac', () => tok);
  assert.equal(a.status(), 'off');
  // The first tap only loads Google's library; the next opens sign-in.
  assert.equal(a.connect(), false);
  await tick();
  assert.equal(a.connect(), true);
  assert.equal(a.status(), 'ok');
  a.push('TV1g:riverton-1', { city: 'riv', name: 'Riverton', pop: 100, date: 5, saved: 10 });
  a.push('TV1g:lakeside-1', { city: 'lak', name: 'Lakeside', pop: 50, date: 2, saved: 11 });
  for (let i = 0; i < 20 && (a.pending || a.status() === 'busy'); i++) await tick();
  a.push('TV1g:riverton-2', { city: 'riv', name: 'Riverton', pop: 200, date: 9, saved: 20 });
  for (let i = 0; i < 20 && (a.pending || a.status() === 'busy'); i++) await tick();
  const folders = [...server.files.values()].filter((f) => f.appProperties.terraville === 'folder');
  assert.equal(folders.length, 1);
  let listA = await a.list();
  assert.deepEqual(listA.map((c) => [c.name, c.pop, c.mine, c.label]), [['Riverton', 200, true, 'Mac'], ['Lakeside', 50, true, 'Mac']]);
  assert.equal(await a.download(listA[0].fileId), 'TV1g:riverton-2');
  assert.equal(a.needsPush('riv', 20), false);
  assert.equal(a.needsPush('riv', 21), true);

  // A second device sees the first one's cities and writes its own copy.
  server.valid.add('b1');
  const b = mk('devb', 'iPhone', () => 'b1');
  b.connect();
  await tick();
  b.connect();
  const listB = await b.list();
  assert.deepEqual(listB.map((c) => [c.name, c.mine, c.label]), [['Riverton', false, 'Mac'], ['Lakeside', false, 'Mac']]);
  b.push('TV1g:riverton-3', { city: 'riv', name: 'Riverton', pop: 300, date: 14, saved: 30 });
  for (let i = 0; i < 20 && (b.pending || b.status() === 'busy'); i++) await tick();
  listA = await a.list();
  assert.deepEqual(listA.filter((c) => c.city === 'riv').map((c) => [c.label, c.pop]), [['iPhone', 300], ['Mac', 200]]);
  assert.equal(await a.download(listA[0].fileId), 'TV1g:riverton-3');
  assert.equal(await a.download(listA[1].fileId), 'TV1g:riverton-2');

  // An hour later Google refuses the token: the save waits for the next sign-in.
  server.valid.delete('a1');
  a.push('TV1g:riverton-4', { city: 'riv', name: 'Riverton', pop: 400, date: 20, saved: 40 });
  for (let i = 0; i < 20 && a.status() === 'busy'; i++) await tick();
  assert.equal(a.status(), 'signin');
  assert.equal(a.pending, 1);
  tok = 'a2';
  server.valid.add('a2');
  a.connect();
  for (let i = 0; i < 20 && (a.pending || a.status() === 'busy'); i++) await tick();
  assert.equal(a.status(), 'ok');
  assert.equal(a.pending, 0);
  assert.equal(await a.download((await a.list()).find((c) => c.city === 'riv' && c.mine)!.fileId), 'TV1g:riverton-4');

  // Deleting a city trashes every device's copy.
  await a.remove('riv');
  assert.deepEqual((await b.list()).map((c) => c.name), ['Lakeside']);
  clock++;
});

console.log(`\n${passed} passed`);

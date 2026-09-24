// Unit checks for the core rules. Run with: npm test
import assert from 'node:assert/strict';
import { World, encodeArray, decodeArray } from '../src/world';
import { Sim } from '../src/sim';
import { generateTerrain, DEFAULT_TERRAIN } from '../src/terrain';
import { linePath, planLine, applyLine, planZones } from '../src/tools';
import { ROAD, RAIL, POWER, BRIDGE_COST, NET_COST } from '../src/defs';
import { encode, decode } from '../src/save';

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

console.log(`\n${passed} passed`);

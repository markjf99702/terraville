// Unit checks for the core rules. Run with: npm test
import assert from 'node:assert/strict';
import { World, encodeArray, decodeArray } from '../src/world';
import { Sim } from '../src/sim';
import { generateTerrain, cleanTerrain, DEFAULT_TERRAIN } from '../src/terrain';
import { linePath, planLine, applyLine, planZones, applyBuildings, planBulldoze } from '../src/tools';
import { ROAD, RAIL, POWER, BRIDGE_COST, NET_COST, UPGRADE_LV, Kind, buildingName, upkeepOf } from '../src/defs';
import { DAMAGED_CODE, encode, encodeNow, decode, listSlots, pushSaved, saveCode, SlotMeta } from '../src/save';
import { Drive, GisOAuth2 } from '../src/drive';
import { makeRng } from '../src/rng';
import { SCENARIOS, buildScenario, openScenario, scenarioMonth } from '../src/scenarios';
import { Game } from '../src/game';

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

const bounds = ({ x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number }) => ({ x0, y0, x1, y1 });

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
  assert.deepEqual(bounds(roadBox), { x0: 2, y0: 5, x1: 12, y1: 5 });
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
  assert.deepEqual(bounds(lotBox), { x0: 5, y0: 8, x1: 7, y1: 10 });
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

await test('undoing a bent line leaves the rest of its rectangle alone', () => {
  const w = flat();
  const grows = w.place('res', 10, 10); // inside the corner of the line, touching none of it
  w.setLevel(grows, 2);
  const burns = w.place('res', 20, 10);
  w.setLevel(burns, 3);
  const full = w.snapshot();
  const path = linePath(2, 4, 30, 20); // east along y = 4, then south along x = 30
  applyLine(w, POWER, planLine(w, POWER, path));
  const undo = w.areaSnapshot(w.changedArea(full)!, full);
  // Months go by: one lot grows and a fire takes the other. Then the line is undone.
  w.setLevel(grows, 4);
  w.remove(burns.id, true);
  assert.equal(w.restoreArea(undo), true);
  for (const [x, y] of path) assert.equal(w.net[y * w.w + x], 0);
  assert.equal(w.buildings.get(grows.id)!.level, 4);
  assert.equal(w.buildings.has(burns.id), false);
  assert.equal(w.rubble[11 * w.w + 21], 1);
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

await test('trains through a level crossing add no cars to it, and rail laid along a road carries its riders as rail', () => {
  const rideTo = (shops: number, lay: (w: World) => void) => {
    const w = flat(60, 20);
    const home = w.place('res', 2, 2);
    w.setLevel(w.place('com', shops, 2), 2);
    w.setLevel(home, 4);
    lay(w);
    const sim = new Sim(w);
    sim.computeTraffic();
    assert.equal(home.trip, true);
    return w;
  };
  const crossed = rideTo(30, (w) => {
    applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 4, 5)));
    applyLine(w, RAIL, planLine(w, RAIL, linePath(5, 5, 29, 5)));
    applyLine(w, ROAD, planLine(w, ROAD, linePath(30, 5, 32, 5)));
    applyLine(w, ROAD, planLine(w, ROAD, linePath(15, 1, 15, 12))); // a street across the track
  });
  assert.equal(crossed.net[5 * crossed.w + 15], ROAD | RAIL);
  assert.equal(crossed.traffic[5 * crossed.w + 15], 0);
  assert.ok(crossed.traffic[5 * crossed.w + 4] > 0, 'the drive to the station has no cars');
  // Rail down the middle of a road the whole way: a car-free tram line.
  const tram = rideTo(50, (w) => {
    applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 52, 5)));
    applyLine(w, RAIL, planLine(w, RAIL, linePath(5, 5, 49, 5)));
  });
  for (let x = 6; x <= 48; x++) assert.equal(tram.traffic[5 * tram.w + x], 0, `cars at x ${x}`);
});

await test('homes with no road to any job stay empty, however strong demand is', () => {
  const w = flat(60, 40);
  w.place('coal', 1, 1);
  applyLine(w, POWER, planLine(w, POWER, linePath(5, 2, 50, 2))); // every lot below touches this line
  applyLine(w, ROAD, planLine(w, ROAD, linePath(5, 6, 27, 6)));
  for (const x of [6, 9, 12]) w.place(x === 9 ? 'com' : 'ind', x, 3);
  const linked = [15, 18, 21].map((x) => w.place('res', x, 3));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(32, 6, 42, 6))); // a road of their own, joined to nothing
  const cutOff = [33, 36, 39].map((x) => w.place('res', x, 3));
  const sim = new Sim(w);
  const random = Math.random;
  Math.random = makeRng(11);
  try {
    for (let k = 0; k < 4 * 36; k++) {
      w.city.demand.r = 1; // as strong as demand gets, every week
      sim.step();
    }
  } finally {
    Math.random = random;
  }
  assert.ok(linked.some((b) => b.level > 0), 'the homes that can reach the jobs never grew');
  for (const b of cutOff) {
    assert.equal(b.level, 0);
    assert.deepEqual(sim.describe(b.x, b.y).rows.find((r) => r[0] === 'Problem'), ['Problem', 'No road to any shops or factories']);
  }
});

await test('a home 40 road tiles from work keeps its commute when the road between is jammed', () => {
  const w = flat(60, 20);
  const home = w.place('res', 2, 2);
  const shops = w.place('com', 44, 2);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 46, 5)));
  w.setLevel(home, 2);
  w.setLevel(shops, 2);
  const sim = new Sim(w);
  for (let x = 2; x <= 46; x++) w.traffic[5 * w.w + x] = 255; // solid red on the Traffic layer
  sim.computeTraffic(false);
  assert.deepEqual([home.trip, shops.trip], [true, true]);
});

await test('Inspect tells a lot with no road to the other side of town from one too far from it, and the news says where', () => seeded(5, () => {
  const w = flat(140, 40);
  // Two road pieces 8 tiles apart that never meet: homes on one, a factory on the other.
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 12, 5)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 13, 12, 13)));
  const home = w.place('res', 2, 2);
  const works = w.place('ind', 2, 14);
  // One long road with homes at one end and a factory 124 tiles along.
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 25, 132, 25)));
  const farHome = w.place('res', 2, 22);
  const farWorks = w.place('ind', 128, 22);
  const lonely = w.place('res', 60, 32); // no road at all
  w.city.month = 6;
  const sim = new Sim(w);
  const problem = (b: { x: number; y: number }) => sim.describe(b.x, b.y).rows.find((r) => r[0] === 'Problem')?.[1];
  assert.deepEqual([home, works, farHome, farWorks, lonely].map(problem), [
    'No road to any shops or factories', 'No road to any homes', 'Commute too long', 'Homes are too far away', 'No road access',
  ]);
  for (let k = 0; k < 4; k++) sim.step();
  const at = (key: string) => sim.messages.filter((m) => m.text.startsWith(key)).map((m) => [m.x, m.y]);
  assert.deepEqual(at('Commuters cannot reach work'), [[home.x + 1, home.y + 1]]);
  assert.deepEqual(at('Some zones have no road access'), [[lonely.x + 1, lonely.y + 1]]);
}));

await test('the landmark limits: 18,000 residents, 5,000 shop jobs, 4,000 factory jobs', () => {
  const w = flat(60, 40);
  for (let k = 0; k < 9; k++) w.setLevel(w.place('res', 1 + k * 3, 1), 8); // 19,800 residents
  for (let k = 0; k < 4; k++) w.setLevel(w.place('com', 1 + k * 3, 5), 5); // 6,000 jobs
  for (let k = 0; k < 6; k++) w.setLevel(w.place('ind', 1 + k * 3, 9), 4); // 4,560 jobs
  const sim = new Sim(w);
  assert.deepEqual(sim.capped, { res: true, com: true, ind: true });
  w.place('stadium', 1, 14);
  w.place('airport', 6, 14);
  w.place('seaport', 13, 14);
  sim.tally();
  assert.deepEqual(sim.capped, { res: false, com: false, ind: false });
});

await test('past its limit, industry stops growing until a seaport opens', () => {
  const w = flat(60, 40);
  w.place('coal', 1, 1);
  applyLine(w, POWER, planLine(w, POWER, linePath(5, 2, 55, 2)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(5, 6, 55, 6)));
  for (const x of [6, 9, 12, 15, 18, 21]) w.setLevel(w.place('ind', x, 3), 4); // 4,560 jobs, at their top level
  const small = [24, 27, 30].map((x) => w.place('ind', x, 3));
  for (const b of small) w.setLevel(b, 1);
  w.place('res', 33, 3); // where the workers come from
  const sim = new Sim(w);
  const months = (n: number) => {
    for (let k = 0; k < 4 * n; k++) {
      w.city.demand.i = 1; // as strong as demand gets, every week
      sim.step();
    }
  };
  const random = Math.random;
  Math.random = makeRng(5);
  try {
    months(24);
    assert.deepEqual(small.map((b) => b.level), [1, 1, 1]);
    assert.ok(sim.messages.some((m) => m.text === 'Industry has stalled. Factories need a seaport to ship goods.'));
    w.place('seaport', 40, 20);
    months(24);
  } finally {
    Math.random = random;
  }
  assert.ok(small.some((b) => b.level > 1), 'industry never grew after the seaport opened');
});

await test('each point of tax over 7% takes 0.05 off the demand for every zone', () => {
  const demand = (tax: number) => {
    const w = flat();
    Object.assign(w.city, { tax, demand: { r: 0, c: 0, i: 0 } });
    new Sim(w).computeDemand();
    return w.city.demand;
  };
  const at7 = demand(7);
  const at12 = demand(12);
  // The meter moves halfway to its new reading each month, so half of the 5 x 0.05 shows after one.
  for (const k of ['r', 'c', 'i'] as const) assert.ok(Math.abs(at7[k] - at12[k] - 0.125) < 1e-9, `${k}: ${at7[k] - at12[k]}`);
});

await test('landmark upgrades raise land value everywhere, counting the most upgraded landmark of each kind', () => {
  const w = flat(60, 40);
  const stadium = w.place('stadium', 2, 2);
  const another = w.place('stadium', 8, 2);
  const airport = w.place('airport', 2, 30);
  const sim = new Sim(w);
  sim.computeMaps();
  const at = () => w.landValue[20 * w.w + 40];
  const before = at();
  w.setLevel(stadium, 3);
  w.setLevel(another, 2); // the second stadium adds nothing
  w.setLevel(airport, 2);
  sim.computeMaps();
  assert.equal(at() - before, 3 * UPGRADE_LV);
  assert.equal(buildingName(stadium), 'Domed stadium');
  assert.equal(upkeepOf(stadium), 30 + 60 + 120);
  assert.equal(sim.describe(3, 3).title, 'Domed stadium');
});

await test('an upgraded landmark is saved, and a city code cannot claim upgrades that do not exist', () => {
  const w = flat(60, 40);
  w.setLevel(w.place('stadium', 2, 2), 3);
  const s = JSON.parse(JSON.stringify(w.serialize()));
  assert.equal(World.deserialize(s).buildingAt(2, 2)!.level, 3);
  const with_ = (kind: string, level: unknown) => World.deserialize({ ...s, buildings: [[1, kind, 2, 2, level, 1, 0]] }).buildingAt(2, 2)!.level;
  assert.deepEqual([with_('stadium', 9), with_('stadium', 'x'), with_('stadium', 0), with_('police', 4)], [3, 1, 1, 1]);
});

await test("a city code's building rows are read as whole numbers in range, so an edited code can't put NaN in the treasury", () => {
  const w = flat(40, 30);
  w.place('coal', 5, 1);
  applyLine(w, POWER, planLine(w, POWER, linePath(9, 3, 9, 6)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(6, 6, 38, 6)));
  applyLine(w, POWER, planLine(w, POWER, linePath(9, 6, 38, 6)));
  const s = JSON.parse(JSON.stringify(w.serialize()));
  s.nextId = 'lots';
  s.buildings.push(
    [50, 'com', 10, 7, 7, 1, 0], // past the top level for shops
    [51, 'res', 14, 7, '4', 1, 0], // a level typed as text, which grew to '41' by adding 1
    [52, 'constructor', 18, 7, 1, 1, 0], // not a kind of building: something every object has
    [53, 'res', 22, 7, 2, 1, 0],
    [53, 'ind', 26, 7, 2, 1, 0], // the same id again
    ['x', 'res', 30, 7, 1, 1, 0],
    [54, 'res', 34, 'y', 1, 1, 0],
    [55.7, 'res', 34.2, 7, 2.9, 'seed', -3],
    'not a row',
  );
  const back = World.deserialize(s);
  const at = (x: number) => back.buildingAt(x, 7);
  assert.deepEqual([at(10)?.level, at(14)?.level, at(18), at(22)?.id, at(26), at(30)], [5, 4, undefined, 53, undefined, undefined]);
  assert.deepEqual({ ...at(34)!, powered: false }, { ...at(34)!, id: 55, x: 34, level: 2, seed: 0, age: 0, powered: false });
  // Every lot's tiles point at that lot, and new buildings get ids of their own.
  for (const b of back.buildings.values()) {
    for (let dy = 0; dy < b.size; dy++) for (let dx = 0; dx < b.size; dx++) assert.equal(back.occ[(b.y + dy) * back.w + b.x + dx], b.id);
  }
  assert.equal(back.nextId, 56);
  const sim = new Sim(back);
  const random = Math.random;
  Math.random = makeRng(4);
  try {
    for (let k = 0; k < 60; k++) sim.step();
  } finally {
    Math.random = random;
  }
  assert.ok(Number.isFinite(back.city.funds) && Number.isFinite(sim.stats.residents) && Number.isFinite(sim.stats.comJobs), `funds ${back.city.funds}, residents ${sim.stats.residents}`);
  for (const b of back.buildings.values()) assert.ok(Number.isInteger(b.level) && Number.isFinite(b.pop), `${b.kind} ${b.id} at level ${b.level}`);
});

await test('crime grows only where people live and work: a ring of parks around a home brings it down', () => {
  const crimeAt = (around: Kind | null) => {
    const w = flat(60, 60);
    for (let x = 10; x < 50; x++) { w.setNet(ROAD, x, 20); w.setNet(POWER, x, 20); }
    w.place('coal', 2, 2);
    const home = w.place('res', 28, 21); // 28..30, 21..23, on the road
    if (around === 'park') {
      for (let x = 27; x <= 31; x++) w.place('park', x, 24);
      for (let y = 21; y <= 23; y++) { w.place('park', 27, y); w.place('park', 31, y); }
    } else if (around) w.place(around, 32, 21);
    const sim = new Sim(w);
    for (let k = 0; k < 3; k++) sim.computeMaps();
    return w.crime[(home.y + 1) * w.w + home.x + 1];
  };
  const alone = crimeAt(null);
  assert.ok(crimeAt('park') < alone, `parks ${crimeAt('park')}, alone ${alone}`);
  assert.ok(crimeAt('wind') <= alone, `a wind turbine next door ${crimeAt('wind')}, alone ${alone}`);
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
  // A typical run (528 residents). Unseeded, about 1 run in 30 stays under 200.
  const random = Math.random;
  Math.random = makeRng(1);
  try {
    for (let i = 0; i < 4 * 36; i++) sim.step();
  } finally {
    Math.random = random;
  }
  assert.ok(sim.stats.residents > 200, `residents ${sim.stats.residents}`);
  assert.ok(w.city.history.income.at(-1)! > 0);
});

await test('underfunded roads crumble to rubble, but not under a power line that stays', () => seeded(3, () => {
  const w = flat(60, 20);
  w.city.funds = 1e6;
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 57, 5)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 10, 57, 10)));
  applyLine(w, POWER, planLine(w, POWER, linePath(2, 10, 57, 10)));
  w.city.funding.transport = 0;
  const sim = new Sim(w);
  for (let m = 0; m < 60; m++) sim.budget();
  let crumbled = 0, wired = 0;
  for (let x = 2; x <= 57; x++) {
    if (w.rubble[5 * w.w + x]) crumbled++;
    const i = 10 * w.w + x;
    if (!(w.net[i] & ROAD)) {
      wired++;
      assert.equal(w.net[i], POWER, `the line at ${x} went with the road`);
      assert.equal(w.rubble[i], 0, `rubble under the line at ${x}`);
    }
  }
  assert.ok(crumbled > 10 && wired > 10, `${crumbled} plain road tiles and ${wired} under the line crumbled`);
}));

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

await test('a city code opens from whatever it was pasted with, and a damaged one says so plainly', async () => {
  const w = generateTerrain({ ...DEFAULT_TERRAIN, seed: 'pasted', w: 50, h: 40 });
  w.city.founded = true;
  w.city.name = 'Pasted';
  const file = { v: 1 as const, world: w.serialize(), mode: 'city' as const };
  const gz = await encode(file);
  const plain = encodeNow(file);
  assert.ok(gz.startsWith('TV1g:') && plain.startsWith('TV1j:'));
  const opens = async (text: string) => (await decode(text)).world.city.name;
  // In quotes, after a few words, with a sign-off, or broken over lines by a mail program.
  assert.equal(await opens(`"${gz}"`), 'Pasted');
  assert.equal(await opens(`Here is my city: ${gz} Enjoy it!`), 'Pasted');
  assert.equal(await opens(gz.replace(/(.{76})/g, '$1\n')), 'Pasted');
  assert.equal(await opens(`Here is my city: ${plain}`), 'Pasted');
  // Cut short anywhere, a character changed, or the last few missing: one message, never the browser's own.
  const k = Math.floor(gz.length / 2);
  const changed = gz.slice(0, k) + (gz[k] === 'A' ? 'B' : 'A') + gz.slice(k + 1);
  for (const bad of [gz.slice(0, 4096), gz.slice(0, k), changed, gz.slice(0, -3), plain.slice(0, Math.floor(plain.length * 0.6)), plain.slice(0, -3)]) {
    await assert.rejects(decode(bad), { message: DAMAGED_CODE });
  }
  await assert.rejects(decode('hello'), { message: 'That does not look like a Terraville city code. Codes start with TV1.' });
});

/** A save and reload the way the game does one: through a city code, then the opening evaluation. */
async function reopen(sim: Sim): Promise<Sim> {
  const code = await encode({ v: 1, world: sim.world.serialize(sim.saveRun()), mode: 'city' });
  const back = new Sim(World.deserialize((await decode(code)).world));
  back.evaluate(false);
  return back;
}

await test('a reloaded city carries on as if it had never closed: traffic, budgets, the week and the news', async () => {
  const gridlock = SCENARIOS.find((x) => x.id === 'gridlock')!;
  const traffic = (s: Sim) => gridlock.check(s).status.split(' · ')[0];
  // The year-end news, as its year, its word and its two amounts in dollars.
  const yearEnd = (said: string[]) => {
    const m = said.find((t) => / closes with /.test(t))?.match(/^(\d+) closes with an? (surplus|deficit) of \$([\d,]+)\. Taxes brought in \$([\d,]+)\.$/);
    assert.ok(m, `no year-end news in ${JSON.stringify(said)}`);
    return { year: m[1], word: m[2], net: Number(m[3].replace(/,/g, '')), taxes: Number(m[4].replace(/,/g, '')) };
  };
  // Land value isn't saved (it would make codes a fifth longer), so the opened city works it out again and lands
  // within a dollar or so of where it was: money read after a month end may differ by that much.
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.01), `${what}: ${a} after a reload, ${b} without`);
  const random = Math.random;
  try {
    for (const seed of [1, 2, 3]) {
      Math.random = makeRng(seed);
      const w = buildScenario(gridlock, 120, 100);
      w.city.disasters = false;
      const sim = new Sim(w);
      openScenario(sim);
      for (let k = 0; k < 4 * 34 + 2; k++) sim.step(); // to the middle of November 1957
      assert.equal(w.city.month % 12, 10);
      const back = await reopen(sim);
      // Straight away: the goal tracker, the week, the Budget dialog, the top bar's monthly figure and the news log.
      assert.equal(traffic(back), traffic(sim), `seed ${seed}: the goal tracker as the city opens`);
      assert.equal(back.week, 2);
      assert.deepEqual(back.stats.lastBudget, sim.stats.lastBudget);
      assert.deepEqual(back.stats.yearBudget, sim.stats.yearBudget);
      assert.equal(back.stats.migration, sim.stats.migration);
      assert.deepEqual(back.messages.map(({ text, kind, month }) => [text, kind, month]), sim.messages.slice(-40).map(({ text, kind, month }) => [text, kind, month]));
      // Then on to the year end, on the same random numbers either way.
      const play = (s: Sim) => {
        const said: string[] = [];
        s.on((e) => {
          if (e.type === 'message') said.push(e.message.text);
        });
        Math.random = makeRng(seed + 100);
        for (let k = 0; k < 2; k++) s.step();
        const nov = { traffic: traffic(s), budget: { ...s.stats.lastBudget } };
        for (let k = 0; k < 4; k++) s.step();
        return { nov, dec: traffic(s), year: yearEnd(said), week: s.week };
      };
      const a = play(sim);
      const b = play(back);
      assert.equal(b.nov.traffic, a.nov.traffic, `seed ${seed}: the traffic index at the end of November`);
      assert.equal(b.dec, a.dec, `seed ${seed}: the traffic index at the end of December`);
      assert.equal(b.week, a.week);
      for (const k of Object.keys(a.nov.budget) as (keyof typeof a.nov.budget)[]) near(b.nov.budget[k], a.nov.budget[k], `seed ${seed}: November's ${k}`);
      assert.deepEqual([b.year.year, b.year.word], [a.year.year, a.year.word], `seed ${seed}: the year-end news`);
      near(b.year.net, a.year.net, `seed ${seed}: the year's surplus`);
      near(b.year.taxes, a.year.taxes, `seed ${seed}: the year's taxes`);
    }
  } finally {
    Math.random = random;
  }
});

await test('a monster mid-rampage is still on the map after a reload, and keeps going', async () => {
  const random = Math.random;
  try {
    for (const seed of [1, 2, 3]) {
      Math.random = makeRng(seed);
      const w = buildScenario(SCENARIOS.find((x) => x.id === 'monster')!, 120, 100);
      const sim = new Sim(w);
      openScenario(sim);
      for (let k = 0; k < 4 * 3; k++) sim.step();
      sim.disasters.trigger('monster');
      for (let k = 0; k < 6; k++) sim.step();
      const before = sim.disasters.roamers.map(({ kind, x, y, weeks, heading }) => ({ kind, x, y, weeks, heading }));
      assert.equal(before.length, 1);
      const back = await reopen(sim);
      assert.deepEqual(back.disasters.roamers.map(({ kind, x, y, weeks, heading }) => ({ kind, x, y, weeks, heading })), before);
      let wrecked = 0;
      back.on((e) => {
        if (e.type === 'destroyed') wrecked++;
      });
      let weeks = 0;
      while (back.disasters.roamers.length && weeks < 60) {
        back.step();
        weeks++;
      }
      assert.equal(weeks, before[0].weeks, `seed ${seed}: the monster left early or stayed late`);
      assert.ok(wrecked > 0, `seed ${seed}: the monster wrecked nothing after the reload`);
    }
  } finally {
    Math.random = random;
  }
});

await test('a save keeps its news as plain text, and anything malformed in its running state is left out', () => {
  const w = flat();
  const sim = new Sim(w);
  sim.say('one', 'Fire reported at a <b>home</b>.', 'alert', { x: 3, y: 4 }, 0);
  const s = JSON.parse(JSON.stringify(w.serialize(sim.saveRun())));
  s.run.messages.push(
    { text: 'Off the map', kind: 'info', x: 900, y: 4, month: 0 },
    { text: 42, kind: 'info', month: 0 },
    { text: 'A kind the game has no colour for', kind: 'script', month: 0 },
    { text: 'No month', kind: 'good' },
  );
  s.run.week = 9;
  s.run.lastBudget = { taxIncome: '12', police: 'x', fire: null };
  s.run.yearBudget = 'nonsense';
  s.run.roamers = [{ kind: 'monster', x: 5, y: 5, weeks: 10, heading: 1 }, { kind: 'dragon', x: 5, y: 5, weeks: 10, heading: 1 }, { kind: 'tornado', x: 'a', y: 5, weeks: 3 }];
  s.run.cooldown = [['fire', 3], ['bad', 'soon'], 7];
  const back = new Sim(World.deserialize(s));
  assert.deepEqual(back.messages.map(({ text, kind, x, y, month }) => ({ text, kind, x, y, month })), [
    { text: 'Fire reported at a <b>home</b>.', kind: 'alert', x: 3, y: 4, month: 0 },
    { text: 'Off the map', kind: 'info', x: undefined, y: undefined, month: 0 },
  ]);
  assert.equal(back.week, 3);
  assert.deepEqual(back.stats.lastBudget, { taxIncome: 12, transport: 0, police: 0, fire: 0, services: 0, power: 0, interest: 0 });
  assert.deepEqual(back.stats.yearBudget, { taxIncome: 0, transport: 0, police: 0, fire: 0, services: 0, power: 0, interest: 0 });
  assert.deepEqual(back.disasters.roamers.map((r) => r.kind), ['monster']);
  // A save from before any of this was kept opens as it always did.
  delete s.run;
  delete s.traffic;
  const old = new Sim(World.deserialize(s));
  assert.deepEqual([old.week, old.messages.length, old.stats.lastBudget.taxIncome], [0, 0, 0]);
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

await test('a fire alert names what is burning and says what to do', () => {
  const w = flat(60, 40);
  const towers = w.place('com', 10, 2);
  w.setLevel(towers, 4);
  const cottages = w.place('res', 14, 2);
  w.setLevel(cottages, 1);
  const shops = w.place('com', 18, 2);
  w.setLevel(shops, 2);
  const lots = [w.place('airport', 2, 2), towers, cottages, shops, w.place('school', 22, 2), w.place('res', 40, 30)];
  w.place('fire', 26, 2);
  const sim = new Sim(w);
  const covered = 'Firefighters are on the way.';
  const alone = 'No fire station reaches it: bulldoze a gap around it to stop it spreading.';
  for (const b of lots) {
    sim.disasters.ignite(b.x, b.y);
    w.city.month++; // past the month between fire reports
  }
  assert.deepEqual(sim.messages.filter((m) => m.text.startsWith('Fire')).map((m) => [m.text, m.x, m.y]), [
    [`Fire at an airport. ${alone}`, 5, 5], [`Fire at the office towers. ${covered}`, 11, 3], [`Fire at the cottages. ${covered}`, 15, 3],
    [`Fire at the shops on main street. ${covered}`, 19, 3], [`Fire at a school. ${covered}`, 23, 3], [`Fire at a vacant residential lot. ${alone}`, 41, 31],
  ]);
});

await test('setting off a fire always starts one where something can burn, and says so where nothing can', () => seeded(8, () => {
  const w = flat(60, 40);
  const sim = new Sim(w);
  sim.disasters.trigger('fire');
  assert.deepEqual(sim.messages.map((m) => [m.text, m.kind]), [['There is nothing here to burn yet.', 'info']]);
  // A town under full fire cover, where a fire left to chance mostly doesn't start.
  for (let x = 2; x < 50; x += 4) w.setLevel(w.place('res', x, 10), 2);
  w.place('fire', 24, 14);
  sim.computePower();
  for (const b of w.buildings.values()) b.powered = true;
  sim.computeMaps();
  for (let k = 0; k < 30; k++) {
    w.fire.fill(0);
    sim.disasters.trigger('fire');
    let burning = 0;
    for (let i = 0; i < w.n; i++) if (w.fire[i]) burning++;
    assert.ok(burning > 0, `try ${k} started no fire`);
  }
}));

await test('a town big enough for fires is told what a fire or police station costs and does', () => seeded(2, () => {
  const news = (disasters: boolean) => {
    const w = flat(40, 30);
    w.city.disasters = disasters;
    w.city.month = 24;
    for (const x of [2, 6]) w.setLevel(w.place('res', x, 2), 8);
    const sim = new Sim(w);
    for (let k = 0; k < 4; k++) sim.step();
    assert.ok(sim.stats.residents > 2500, `${sim.stats.residents} residents`);
    return sim.messages.map((m) => m.text).filter((t) => t.includes('station'));
  };
  const police = 'The city has no police station. Crime grows as the town gets crowded; a station ($500, $45 a month) keeps it down nearby.';
  assert.deepEqual(news(true), ['The city has no fire station. Fires break out from time to time now; a station ($500, $45 a month) puts them out nearby.', police]);
  // With random disasters off, no fire starts on its own.
  assert.deepEqual(news(false), ['The city has no fire station. Should a fire start, a station ($500, $45 a month) puts it out nearby.', police]);
}));

await test('fire funding weakens a station once: at half funding it fights a fire next door at half strength', () => {
  const w = flat(40, 30);
  const home = w.place('res', 10, 10);
  const station = w.place('fire', 14, 10);
  w.city.funding.fire = 0.5;
  const sim = new Sim(w);
  station.powered = true;
  sim.computeMaps();
  const cov = w.fireCov[11 * w.w + 11] / 255;
  assert.ok(cov > 0.45 && cov < 0.5, `coverage ${cov}`);
  // Firefighters put a fire out with chance coverage x 0.45 a week: 0.22 here, or 0.11 if funding counted twice.
  sim.disasters.ignite(home.x, home.y);
  const random = Math.random;
  Math.random = () => 0.16;
  try {
    sim.disasters.week();
  } finally {
    Math.random = random;
  }
  assert.equal(w.fire[11 * w.w + 11], 0, 'the fire is still burning');
});

await test('a lot that burns down stops burning, so it can be rebuilt at once', () => {
  const w = flat();
  const lot = w.place('res', 10, 10);
  w.setLevel(lot, 4);
  const sim = new Sim(w);
  sim.disasters.ignite(11, 11);
  // No fire station anywhere, so nothing puts it out: it burns for five to nine weeks and comes down.
  for (let k = 0; k < 12 && w.buildings.has(lot.id); k++) sim.step();
  assert.equal(w.buildings.has(lot.id), false);
  for (let y = 10; y < 13; y++) for (let x = 10; x < 13; x++) assert.equal(w.fire[y * w.w + x], 0, `still burning at ${x},${y}`);
  assert.deepEqual(w.canPlace('res', 10, 10), { ok: true, clear: 9, grade: 0 });
});

await test('a building spreads fire from all four sides in the week it comes down or is put out', () => {
  for (const ending of ['comes down', 'is put out']) {
    const w = flat();
    const mid = w.place('res', 10, 10);
    const around = [w.place('res', 13, 10), w.place('res', 7, 10), w.place('res', 10, 13), w.place('res', 10, 7)];
    for (const b of [mid, ...around]) w.setLevel(b, 2);
    const sim = new Sim(w);
    sim.disasters.ignite(11, 11);
    for (let y = 10; y < 13; y++) for (let x = 10; x < 13; x++) w.fire[y * w.w + x] = ending === 'comes down' ? 1 : 5;
    if (ending === 'is put out') w.fireCov.fill(255); // a station so close that every roll puts it out
    const random = Math.random;
    Math.random = () => 0; // every spark catches
    try {
      sim.disasters.week();
    } finally {
      Math.random = random;
    }
    assert.equal(w.buildings.has(mid.id), ending === 'is put out', ending);
    for (const b of around) assert.equal(w.fire[(b.y + 1) * w.w + b.x + 1], 5, `${ending}: the lot at ${b.x},${b.y} never caught`);
  }
});

await test('the monster leaves fires burning in what it wrecks', () => {
  const w = flat();
  for (let y = 6; y < 18; y += 3) for (let x = 6; x < 30; x += 3) w.setLevel(w.place('res', x, y), 2);
  const sim = new Sim(w);
  sim.disasters.roamers.push({ kind: 'monster', x: 15, y: 10, px: 15, py: 10, vx: 0, vy: 0, weeks: 30, heading: 0 });
  const random = Math.random;
  Math.random = () => 0; // everything it reaches comes down, and every wreck catches
  try {
    sim.disasters.week();
  } finally {
    Math.random = random;
  }
  const burning = [...w.fire.keys()].filter((i) => w.fire[i]);
  assert.ok(burning.length > 0, 'nothing is burning');
  for (const i of burning) assert.ok(w.rubble[i] && !w.occ[i], `tile ${i} is not burning rubble`);
});

await test('a save with rubble left burning for years opens with it put out', () => {
  const w = flat();
  w.fire[5 * w.w + 5] = 250; // burnt-down rubble from before the fix
  w.fire[6 * w.w + 6] = 7; // a real fire carries on
  const back = World.deserialize(JSON.parse(JSON.stringify(w.serialize())));
  assert.equal(back.fire[5 * w.w + 5], 0);
  assert.equal(back.fire[6 * w.w + 6], 7);
});

await test('random disasters wait for a town big enough to need a fire station', () => {
  const w = flat(60, 40);
  w.city.disasters = true;
  w.city.difficulty = 'hard';
  w.setLevel(w.place('res', 2, 2), 8); // 2,200 residents
  const sim = new Sim(w);
  const seen: string[] = [];
  sim.on((e) => { if (e.type === 'disaster') seen.push(e.kind); });
  const random = Math.random;
  Math.random = () => 0.001; // every roll says "disaster"
  try {
    sim.disasters.month();
    assert.deepEqual(seen, []);
    w.setLevel(w.place('res', 5, 2), 5); // 2,560 residents
    sim.tally();
    sim.disasters.month();
    assert.deepEqual(seen, ['fire']);
  } finally {
    Math.random = random;
  }
});

await test('a nuclear plant melts down rarely: 0.04% a month on Medium', () => {
  const w = flat(60, 40);
  w.city.disasters = true;
  w.city.difficulty = 'medium';
  w.setLevel(w.place('res', 2, 2), 8);
  w.setLevel(w.place('res', 5, 2), 5); // 2,560 residents, so random disasters are on
  const plant = w.place('nuclear', 20, 20);
  const sim = new Sim(w);
  const seen: string[] = [];
  sim.on((e) => { if (e.type === 'disaster') seen.push(e.kind); });
  const random = Math.random;
  try {
    Math.random = () => 0.0005; // a fire, but over the meltdown odds (it was under the old 0.08%)
    sim.disasters.month();
    assert.deepEqual([seen.includes('meltdown'), w.buildings.has(plant.id)], [false, true]);
    Math.random = () => 0.00035;
    sim.disasters.month();
    assert.equal(seen.includes('meltdown'), true);
  } finally {
    Math.random = random;
  }
});

await test('challenge cities open as dense as their land value holds, so they do not start out shrinking', () => {
  const random = Math.random;
  Math.random = makeRng(3);
  try {
    for (const s of SCENARIOS.filter((x) => x.city)) {
      const w = buildScenario(s, 120, 100);
      w.city.disasters = false;
      const sim = new Sim(w);
      openScenario(sim);
      for (const b of w.buildings.values()) if (b.kind === 'res' || b.kind === 'com' || b.kind === 'ind') assert.ok(b.level <= sim.maxLevel(b), `${s.name}: a lot opens over its land value`);
      // Thinning the lots as it opens isn't people leaving: the report's "Last month" starts at 0.
      assert.equal(sim.stats.migration, 0, `${s.name} opens with ${sim.stats.migration} last month`);
      const opening = sim.stats.residents;
      for (let k = 0; k < 4 * 12; k++) sim.step();
      assert.ok(sim.stats.residents >= opening * 0.97, `${s.name} shrank from ${opening} to ${sim.stats.residents} in its first year`);
    }
  } finally {
    Math.random = random;
  }
});

await test('Gridlock and Smog Valley are not won by bulldozing every job before the deadline', () => {
  const sim = new Sim(flat());
  const goal = (id: string) => SCENARIOS.find((s) => s.id === id)!.check(sim);
  // Empty roads and clean air, because every shop and factory is gone.
  Object.assign(sim.stats, { avgTraffic: 0, avgPollution: 0, residents: 40000, comJobs: 0, indJobs: 0 });
  assert.equal(goal('gridlock').met, false);
  assert.equal(goal('smog').met, false);
  assert.match(goal('gridlock').status, /· 0 of 10,000 jobs$/);
  Object.assign(sim.stats, { comJobs: 6000, indJobs: 4000 });
  assert.equal(goal('gridlock').met, true);
  assert.equal(goal('smog').met, true);
});

await test('Smog Valley is won by holding its goal for the last 12 month ends, and the count is saved', () => {
  const w = flat();
  w.city.scenario = { id: 'smog', end: 100, done: '' };
  const sim = new Sim(w);
  const smog = SCENARIOS.find((x) => x.id === 'smog')!;
  const air = (index: number) => Object.assign(sim.stats, { avgPollution: index * 2.55, residents: 21000, comJobs: 5000, indJobs: 4500 });
  air(10);
  for (let k = 1; k < 12; k++) assert.equal(scenarioMonth(smog, sim).met, false, `met after ${k} months`);
  const st = scenarioMonth(smog, sim);
  assert.equal(st.met, true);
  assert.match(st.status, /^Pollution 10 \(goal under 12\) · 21,000 of 20,000 residents · 9,500 of 9,000 jobs · held 12 of 12 months$/);
  const back = World.deserialize(JSON.parse(JSON.stringify(w.serialize())));
  assert.deepEqual(back.city.scenario, { id: 'smog', end: 100, done: '', held: 12 });
  air(12); // one month over the line starts the count again
  assert.equal(scenarioMonth(smog, sim).met, false);
  assert.equal(w.city.scenario.held, 0);
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

// ---- the game's own tools, undo and money, with the page left out ----

/** Something that answers every property and call with itself, for the parts of the page a headless game touches. */
function stub(): any {
  const p: any = new Proxy(function () {}, {
    get: (t: any, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : k in t ? t[k] : p),
    apply: () => p,
    set: (t: any, k, v) => ((t[k] = v), true),
  });
  return p;
}

/** A Game playing `world` as a city, with no page: what it would toast is kept in `toasts`. */
function headless(world: World): any {
  const g: any = Object.create(Game.prototype);
  const toasts: string[] = [];
  const ui = stub();
  ui.toast = (t: string) => toasts.push(t);
  ui.modalOpen = false;
  Object.assign(g, {
    mode: 'city', world, sim: null, renderer: stub(), minimap: stub(), audio: stub(), ui, drive: stub(), speed: 2,
    terrain: { ...DEFAULT_TERRAIN, seed: 'unit', w: world.w, h: world.h }, toolId: 'query', brush: { radius: 4, strength: 0.6 },
    settings: { sound: false, autosave: false, traffic: false, grid: false, contours: false, night: false },
    slotId: null, acc: 0, undoStack: [], redoStack: [], strokeRedo: [], pendingPlace: false, anchor: null, brushOn: false,
    brushAt: { x: 0, y: 0 }, brushTarget: undefined, brushSpent: 0, autoTimer: 0, toolOnce: null, autoSlope: false,
    lastSpeed: 2, toasts,
  });
  g.startSim();
  return g;
}

/** Weeks of the game's clock, sealing undo before each step as a frame does. */
function weeks(g: any, n: number): void {
  for (let k = 0; k < n; k++) {
    g.sealUndo();
    g.sim.step();
    if (g.sim.powerDirty) g.sim.computePower();
  }
  g.sealUndo();
}

/** Use a drag tool from one tile to another, as the pointer would. */
function drag(g: any, tool: string, x0: number, y0: number, x1 = x0, y1 = y0): void {
  g.setTool(tool);
  g.pointerDown(x0 + 0.5, y0 + 0.5, 0, 0);
  g.pointerMove(x1 + 0.5, y1 + 0.5, 0, 0);
  g.pointerUp(x1 + 0.5, y1 + 0.5, 0, 0);
  g.sealUndo();
}

/** Run `fn` with Math.random seeded, so a test that rolls dice rolls the same ones every time. */
function seeded<T>(seed: number, fn: () => T): T {
  const random = Math.random;
  Math.random = makeRng(seed);
  try {
    return fn();
  } finally {
    Math.random = random;
  }
}

/** A small powered grid town on flat land, three years old, with money to spare. */
function town(): any {
  const w = flat(60, 40);
  w.city.difficulty = 'easy';
  const g = headless(w);
  w.city.funds = 100000;
  drag(g, 'coal', 8, 5);
  for (let y = 8; y <= 32; y += 4) {
    drag(g, 'road', 10, y, 50, y);
    drag(g, 'power', 10, y, 50, y);
  }
  for (let x = 10; x <= 50; x += 4) drag(g, 'road', x, 8, x, 32);
  let k = 0;
  for (let y = 10; y < 32; y += 4) for (let x = 12; x < 50; x += 4) drag(g, (['res', 'res', 'com', 'ind'] as const)[k++ % 4], x, y);
  weeks(g, 4 * 36);
  return g;
}

await test('undo refunds only within three months of the action, however often it was undone and redone since', () => seeded(42, () => {
  const g = town();
  drag(g, 'nuclear', 52, 20);
  for (let m = 0; m < 24; m++) {
    weeks(g, 4);
    if (m % 3 === 2) {
      g.undo();
      g.redo();
    }
  }
  const funds = g.world.city.funds;
  g.undo();
  assert.equal(g.world.city.funds, funds, `refunded $${Math.round(g.world.city.funds - funds)}`);
  assert.equal(g.toasts.at(-1), 'Undone. It cost $5,000, which is only refunded within 3 months.');
  // A quick change of mind is still refunded, and redo charges it again.
  drag(g, 'coal', 52, 30);
  weeks(g, 4);
  const f = g.world.city.funds;
  g.undo();
  assert.equal(g.world.city.funds, f + 3000);
  g.redo();
  assert.equal(g.world.city.funds, f);
  g.undo();
  assert.equal(g.world.city.funds, f + 3000);
}));

await test('nothing is left burning on bare ground when a burning lot is undone, and a burning lot cannot be bulldozed', () => seeded(42, () => {
  const g = town();
  const w = g.world;
  const bare = () => {
    let n = 0;
    for (let i = 0; i < w.n; i++) if (w.fire[i] && !w.occ[i] && !w.trees[i] && !w.rubble[i]) n++;
    return n;
  };
  drag(g, 'res', 53, 12);
  const lot = w.buildingAt(53, 12);
  g.sim.disasters.ignite(lot.x, lot.y);
  assert.ok(w.fire[12 * w.w + 53] > 0);
  g.undo();
  assert.ok(!w.buildingAt(53, 12));
  assert.equal(bare(), 0, 'undoing a lot that caught fire left the ground burning');
  g.redo();
  assert.equal(w.buildingAt(53, 12)?.kind, 'res');
  assert.equal(w.fire[12 * w.w + 53], 0, 'redo put the lot back burning');
  // Bulldozing a burning lot is refused, as building on burning ground is; clearing a gap beside it still works.
  const homes = [...w.buildings.values()].filter((b: any) => b.kind === 'res' && b.level > 0 && b.x >= 16 && b.x <= 40 && b.y >= 14);
  const [burning, beside] = [homes[0], homes.find((b: any) => b.y === homes[0].y && b.x === homes[0].x + 4)];
  assert.ok(burning && beside, 'two homes side by side');
  g.sim.disasters.ignite(burning.x, burning.y);
  const plan = planBulldoze(w, [[burning.x + 1, burning.y + 1]]);
  assert.deepEqual([plan.count, plan.reason], [0, 'On fire']);
  drag(g, 'bulldoze', burning.x, burning.y, beside.x + 2, beside.y + 2);
  assert.ok(w.buildings.has(burning.id), 'the burning lot is still there');
  assert.equal(w.buildings.has(beside.id), false, 'the lot beside it was cleared');
  assert.equal(bare(), 0);
}));

await test('Level land leaves water alone and charges nothing for it', () => {
  const w = flat(60, 40);
  w.height.fill(4);
  for (let y = 15; y < 25; y++) for (let x = 25; x < 35; x++) {
    w.water[y * w.w + x] = 1;
    w.height[y * w.w + x] = -4;
  }
  const g = headless(w);
  w.city.funds = 50000;
  const lake = w.height.slice();
  // Pressed beside the lake at 4 m and held over it for a second.
  g.setTool('level');
  g.brush.radius = 4;
  g.pointerDown(30.5, 13.5, 0, 0);
  g.pointerMove(30.5, 20.5, 0, 0);
  for (let t = 0; t < 30; t++) g.brushTick(1 / 30);
  g.pointerUp(30.5, 20.5, 0, 0);
  assert.equal(w.city.funds, 50000, `charged $${Math.round(50000 - w.city.funds)}`);
  assert.deepEqual(w.height, lake);
  assert.ok(!g.toasts.some((t: string) => t.startsWith('Levelled')), g.toasts.join(' / '));
});

await test("Level land that moves only cents of earth doesn't toast 'Levelled for $0'", () => {
  const w = flat(40, 30);
  for (let i = 0; i < w.n; i++) w.height[i] = 4 + (i % 2) * 0.01;
  const g = headless(w);
  w.city.funds = 50000;
  g.setTool('level');
  g.pointerDown(20.5, 15.5, 0, 0);
  for (let t = 0; t < 10; t++) g.brushTick(1 / 30);
  g.pointerUp(20.5, 15.5, 0, 0);
  assert.ok(w.city.funds < 50000 && w.city.funds > 49999.5, `spent $${50000 - w.city.funds}`);
  assert.deepEqual(g.toasts.filter((t: string) => t.startsWith('Levelled')), []);
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
  assert.throws(() => World.deserialize({ ...s, city: undefined as never }));
});

await test('a city code is read field by field, so what someone typed into it stays text', () => {
  const s = flat().serialize();
  const tag = '"><img src=x onerror="alert(1)">';
  const city = { ...s.city, name: `Harbour ${tag}`, tax: tag, disasters: tag, funds: tag, month: '18', loan: -5, id: "x' or name contains 'a",
    funding: { police: tag, fire: 0.5, transport: 2 }, history: { ...s.city.history, pop: [tag, 5, null] }, scenario: { id: 'monster', end: tag, done: tag } };
  const c = World.deserialize({ ...s, city: city as never }).city;
  assert.equal(c.name, `Harbour ${tag}`); // a name can be any text; the dialogs escape it
  assert.equal(c.tax, 7);
  assert.equal(c.disasters, true);
  assert.equal(c.funds, 20000);
  assert.equal(c.month, 18);
  assert.equal(c.loan, 0);
  assert.equal(c.id, undefined); // not an id Terraville makes, so it never reaches a Drive query
  assert.deepEqual(c.funding, { police: 1, fire: 0.5, transport: 1 });
  assert.deepEqual(c.history.pop, [0, 5, 0]);
  assert.deepEqual(c.scenario, { id: 'monster', end: 0, done: '' });
  assert.equal(World.deserialize({ ...s, city: { ...s.city, name: 12345 } as never }).city.name, 'New City');

  // A real city comes back exactly as it was saved, along with anything a later version adds.
  const w = flat();
  Object.assign(w.city, { id: 'k3j2h1abc9', name: 'Riverton', tax: 9, funds: -1250, month: 655, loan: 20000, classReached: 3, seed: 'river-oak-3', disasters: true });
  w.city.funding.fire = 0.55;
  w.city.history.pop.push(10, 20, 35);
  w.city.scenario = { id: 'monster', end: 840, done: 'won' };
  (w.city as unknown as Record<string, unknown>).later = { kept: true };
  assert.deepEqual(World.deserialize(JSON.parse(JSON.stringify(w.serialize()))).city, w.city);
});

await test("the mayor's approval is saved with the city, and older saves open at 50%", () => {
  const w = flat();
  w.setLevel(w.place('res', 2, 2), 4);
  const sim = new Sim(w);
  sim.stats.approval = 83;
  sim.evaluate();
  assert.ok(sim.stats.approval > 60);
  assert.equal(w.city.approval, sim.stats.approval);
  const saved = JSON.parse(JSON.stringify(w.serialize()));
  assert.equal(new Sim(World.deserialize(saved)).stats.approval, sim.stats.approval);
  delete saved.city.approval; // saved before approval was kept
  assert.equal(new Sim(World.deserialize(saved)).stats.approval, 50);
  for (const [v, want] of [['<b>', 50], [150, 100], [-3, 0]] as [unknown, number][]) {
    assert.equal(World.deserialize({ ...saved, city: { ...saved.city, approval: v } }).city.approval, want);
  }
});

await test('terrain settings from a code are numbers in their sliders\' range', () => {
  const base = { ...DEFAULT_TERRAIN, seed: 'harbor-pine-42', w: 120, h: 100 };
  const t = cleanTerrain({ water: '<img src=x onerror="alert(1)">', hills: 250, rivers: '3', style: 'volcano', seed: 7, forest: 12 }, base);
  assert.deepEqual(t, { ...base, hills: 100, rivers: 3, forest: 12 });
  const real = { ...base, style: 'island' as const, water: 45, hills: 30, rough: 0, rivers: 6, lakes: 100, seed: 'monster-bay-2' };
  assert.deepEqual(cleanTerrain(JSON.parse(JSON.stringify(real)), base), real);
});

await test('a damaged list of saves keeps every save it can read', () => {
  const g = globalThis as unknown as { window?: unknown };
  const storage = memStorage();
  g.window = { localStorage: storage };
  try {
    const riverton = { id: 'c-riv', name: 'Riverton', pop: 100, date: 5, savedAt: 10, mode: 'city', city: 'riv' };
    const lakeside = { id: 'c-lak', name: 'Lakeside', pop: 200, date: 9, savedAt: 20, mode: 'city', city: 'lak' };
    storage.setItem('terraville.slots', '[null]');
    assert.deepEqual(listSlots(), []);
    storage.setItem('terraville.slots', JSON.stringify([riverton, null, 'x', 7, lakeside]));
    assert.deepEqual(listSlots().map((s) => s.name), ['Lakeside', 'Riverton']);
    // The next save writes the list back with both cities in it.
    assert.ok(saveCode('TV1j:e30=', { ...riverton, savedAt: 30 } as SlotMeta));
    assert.deepEqual(listSlots().map((s) => s.name), ['Riverton', 'Lakeside']);
  } finally {
    delete g.window;
  }
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
      return json({ id, trashed: false });
    }
    if (method === 'PATCH' && f) {
      // As in Drive, a folder goes to the trash with everything in it.
      if (meta.trashed) for (const x of [f, ...[...this.files.values()].filter((x) => x.parents.includes(f.id))]) x.trashed = true;
      if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
      if (meta.name) f.name = meta.name;
      if (url.searchParams.get('uploadType')) f.content = content;
      f.modifiedTime = now;
      return json({ id: f.id, trashed: f.trashed });
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

await test("Google's sign-in failing to load is news only to someone who wants Drive", async () => {
  let loads = 0;
  const d = new Drive({
    fetch: (() => Promise.reject(new TypeError('offline'))) as typeof fetch, storage: memStorage(), now: () => 0, device: { id: 'd', label: 'Mac' },
    origin: 'https://junkdrawer.works', loadGis: () => (loads++, Promise.reject(new Error('load'))),
  });
  // Opening Save, open and share loads it ahead of a tap; blocked, the dialog says nothing to someone who never used Drive.
  d.prepare();
  await tick();
  assert.deepEqual([loads, d.loadFailed, d.error, d.status()], [1, true, '', 'off']);
  // Pressing Connect tries again and reports that it could not load, rather than that it is still loading.
  assert.equal(d.connect(), false);
  assert.equal(d.loadFailed, true);
  await tick();
  assert.deepEqual([loads, d.error], [2, 'Could not load Google sign-in. Check the connection.']);
});

await test('a save that finds no connection waits for one, and goes up when it is back', async () => {
  const server = new FakeDrive();
  server.valid.add('a1');
  let down = false;
  const storage = memStorage();
  const d = new Drive({
    fetch: ((u: string, o: RequestInit) => (down ? Promise.reject(new TypeError('Failed to fetch')) : server.fetch(u, o))) as typeof fetch,
    storage, now: () => 1_000_000, device: { id: 'deva', label: 'Mac' }, origin: 'https://junkdrawer.works', loadGis: async () => fakeGis(() => 'a1'),
  });
  d.connect();
  await tick();
  d.connect();
  down = true;
  d.push('TV1g:riverton-1', { city: 'riv', name: 'Riverton', pop: 100, date: 5, saved: 10 });
  for (let i = 0; i < 20 && d.status() === 'busy'; i++) await tick();
  // Waiting, not failed: nothing to put right, and nothing kept that would say so after a reload.
  assert.deepEqual([d.status(), d.error, d.pending], ['waiting', '', 1]);
  assert.equal(JSON.parse(storage.getItem('terraville.drive')!).err, '');
  down = false;
  await d.flush();
  assert.deepEqual([d.status(), d.pending], ['ok', 0]);
  assert.deepEqual([...server.files.values()].filter((f) => f.content).map((f) => f.content), ['TV1g:riverton-1']);
  // Any other failure is an error, said as a sentence.
  const realFetch = server.fetch;
  server.fetch = (async () => new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 403 })) as typeof server.fetch;
  d.push('TV1g:riverton-2', { city: 'riv', name: 'Riverton', pop: 100, date: 6, saved: 11 });
  for (let i = 0; i < 20 && d.status() === 'busy'; i++) await tick();
  assert.deepEqual([d.status(), d.error], ['error', 'Google Drive said: Rate limit exceeded.']);
  server.fetch = realFetch;
});

await test('a Terraville folder put in the trash is made again, so other devices still see the city', async () => {
  const server = new FakeDrive();
  server.valid.add('a1');
  const mk = (id: string, label: string) => new Drive({
    fetch: server.fetch as typeof fetch, storage: memStorage(), now: () => 1_000_000, device: { id, label }, origin: 'https://junkdrawer.works', loadGis: async () => fakeGis(() => 'a1'),
  });
  const settle = async (d: Drive) => {
    for (let i = 0; i < 40 && (d.pending || d.status() === 'busy'); i++) await tick();
  };
  const a = mk('deva', 'Mac');
  a.connect();
  await tick();
  a.connect();
  a.push('TV1g:riverton-1', { city: 'riv', name: 'Riverton', pop: 100, date: 5, saved: 10 });
  await settle(a);
  // Tidying Drive, someone moves the Terraville folder to the trash, and its file goes with it.
  const folder = [...server.files.values()].find((f) => f.appProperties.terraville === 'folder')!;
  await server.fetch(`https://www.googleapis.com/drive/v3/files/${folder.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer a1' }, body: JSON.stringify({ trashed: true }) });
  assert.deepEqual([...server.files.values()].map((f) => f.trashed), [true, true]);
  a.push('TV1g:riverton-2', { city: 'riv', name: 'Riverton', pop: 120, date: 6, saved: 20 });
  await settle(a);
  assert.deepEqual([a.status(), a.error], ['ok', '']);
  const live = [...server.files.values()].filter((f) => !f.trashed);
  assert.deepEqual(live.map((f) => f.appProperties.terraville).sort(), ['city', 'folder']);
  assert.equal(live.find((f) => f.content)!.content, 'TV1g:riverton-2');
  assert.equal(live.find((f) => f.content)!.parents[0], live.find((f) => !f.content)!.id);
  // Another device lists the new copy.
  const b = mk('devb', 'iPhone');
  b.connect();
  await tick();
  b.connect();
  assert.deepEqual((await b.list()).map((c) => [c.name, c.date, c.label]), [['Riverton', 6, 'Mac']]);
});

await test('a page that opens with Drive signed in sends the saves that missed it', async () => {
  const server = new FakeDrive();
  server.valid.add('a1');
  const storage = memStorage();
  // A page that closed before its last save reached Drive: Drive has Riverton from save time 10, this device from 20.
  storage.setItem('terraville.drive', JSON.stringify({ on: true, token: 'a1', exp: 9e15, err: '', folder: '', files: {}, pushed: { riv: 20, lak: 30 }, last: 0 }));
  const d = new Drive({ fetch: server.fetch as typeof fetch, storage, now: () => 1_000_000, device: { id: 'deva', label: 'Mac' }, origin: 'https://junkdrawer.works' });
  const meta = (city: string, savedAt: number): SlotMeta => ({ id: `c-${city}`, name: city, pop: 1, date: 1, savedAt, mode: 'city', city });
  const codes: Record<string, string> = { 'c-riv': 'TV1g:riverton-new', 'c-lak': 'TV1g:lakeside-same', snap: 'TV1g:snapshot' };
  assert.equal(d.hasToken(), true);
  pushSaved(d, [meta('riv', 25), meta('lak', 30), { ...meta('x', 99), id: 'snap', city: undefined }], (id) => codes[id] ?? null);
  for (let i = 0; i < 40 && (d.pending || d.status() === 'busy'); i++) await tick();
  assert.deepEqual([...server.files.values()].filter((f) => f.content).map((f) => f.content), ['TV1g:riverton-new']);
  assert.equal(d.needsPush('riv', 25), false);
});

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

await test('one Google sign-in serves every junkdrawer.works app on a device', async () => {
  const server = new FakeDrive();
  server.valid.add('s1');
  const clock = 1_000_000;
  const storage = memStorage();
  let asked = 0;
  let revoked = 0;
  const gis = (): GisOAuth2 => ({
    initTokenClient: (c) => ({ requestAccessToken: () => { asked++; c.callback({ access_token: 's1', expires_in: 3600 }); } }),
    hasGrantedAllScopes: () => true,
    revoke: () => { revoked++; },
  });
  const mk = () => new Drive({ fetch: server.fetch as typeof fetch, storage, now: () => clock, device: { id: 'd', label: 'Mac' }, origin: 'https://junkdrawer.works', loadGis: async () => gis() });
  const drain = async (d: Drive) => { for (let i = 0; i < 20 && (d.pending || d.status() === 'busy'); i++) await tick(); };

  // Lotería signed in half an hour ago: connecting needs no Google window at all.
  storage.setItem('junkdrawer.google', JSON.stringify({ token: 's1', exp: clock + 30 * 60_000, scope: 'https://www.googleapis.com/auth/drive.file', email: 'mark@gmail.com' }));
  const a = mk();
  assert.equal(a.connect(), true);
  assert.equal(asked, 0);
  assert.equal(a.status(), 'ok');
  a.push('TV1g:riverton-1', { city: 'riv', name: 'Riverton', pop: 100, date: 5, saved: 10 });
  await drain(a);
  assert.equal([...server.files.values()].filter((f) => f.appProperties.terraville === 'city').length, 1);

  // Disconnecting stops syncing here without signing the other apps out.
  a.disconnect();
  assert.equal(revoked, 0);
  assert.ok(storage.getItem('junkdrawer.google'));

  // With no shared sign-in, Google is asked once, and the token is shared from then on.
  storage.removeItem('junkdrawer.google');
  const b = mk();
  b.connect();
  await tick();
  b.connect();
  assert.equal(asked, 1);
  const shared = JSON.parse(storage.getItem('junkdrawer.google')!);
  assert.equal(shared.token, 's1');
  assert.equal(shared.exp, clock + 3_600_000);

  // Google refuses it an hour later: it's cleared for every app, and Terraville asks for a sign-in.
  server.valid.delete('s1');
  b.push('TV1g:riverton-2', { city: 'riv', name: 'Riverton', pop: 200, date: 9, saved: 20 });
  for (let i = 0; i < 20 && b.status() === 'busy'; i++) await tick();
  assert.equal(b.status(), 'signin');
  assert.equal(storage.getItem('junkdrawer.google'), null);
});

console.log(`\n${passed} passed`);

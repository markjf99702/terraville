// Unit checks for the core rules. Run with: npm test
import assert from 'node:assert/strict';
import { World, encodeArray, decodeArray } from '../src/world';
import { Sim, compass, passingSentence, ridersWord, spending } from '../src/sim';
import { generateTerrain, cleanTerrain, DEFAULT_TERRAIN, applyBrush, landReadout } from '../src/terrain';
import { linePath, planLine, applyLine, planZones, planPlace, applyBuildings, planBulldoze, levelCost } from '../src/tools';
import { ROAD, RAIL, POWER, BRIDGE_COST, NET_COST, UPGRADE_LV, EXPO_LV, HALL_CRIME, HALL_REACH, Kind, BUILDINGS, article, buildingName, cityClass, isZone, num, upkeepOf } from '../src/defs';
import { DAMAGED_CODE, challengeWins, citySlot, encode, encodeNow, decode, listSlots, pushSaved, readCode, recordWin, saveCode, SlotMeta } from '../src/save';
import { Drive, GisOAuth2 } from '../src/drive';
import { makeRng } from '../src/rng';
import { SCENARIOS, buildScenario, goalRowText, goalState, openScenario, scenarioMonth, scenarioNews, successLine, tideLine } from '../src/scenarios';
import { Game, priceIncludes } from '../src/game';
import { chartAxis, spreadLabels, tickLabel } from '../src/ui/charts';
import { cutOff } from '../src/render/renderer';
import { Vehicles } from '../src/render/vehicles';
import { ago, demandWords, landWords, worryWord } from '../src/ui/ui';
import { builtArea, pictureName, pictureScale } from '../src/ui/picture';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

/** The bodies of land on a map, largest first, in tiles. */
function landBodies(world: World): number[] {
  const { w, h, n } = world;
  const seen = new Uint8Array(n);
  const out: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || world.water[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let size = 0;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && !world.water[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    out.push(size);
  }
  return out.sort((a, b) => b - a);
}

await test('an archipelago is islands: several big ones, none with most of the land', () => {
  for (let k = 0; k < 5; k++) {
    const world = generateTerrain({ ...DEFAULT_TERRAIN, style: 'archipelago', seed: `probe-${k}-seed`, w: 120, h: 100 });
    const bodies = landBodies(world);
    const land = bodies.reduce((a, b) => a + b, 0);
    assert.ok(bodies.filter((b) => b >= 150).length >= 3, `probe-${k}-seed: three islands of 150 tiles or more`);
    assert.ok(bodies[0] < land * 0.6, `probe-${k}-seed: the largest holds ${Math.round((100 * bodies[0]) / land)}% of the land`);
  }
});

await test("the editor's land readout: flat for building, the largest landmass, rivers and lakes", () => {
  const world = new World(12, 10);
  world.height.fill(3);
  assert.deepEqual(landReadout(world), { flat: 1, largest: 1, rivers: 0, lakes: 0 });
  // A stream from edge to edge is a river, and parts the land 60 tiles to 50.
  for (let y = 0; y < 10; y++) world.water[y * 12 + 6] = 1;
  let r = landReadout(world);
  assert.deepEqual([r.flat, r.largest, r.rivers, r.lakes], [110 / 120, 60 / 110, 1, 0]);
  // A pond that reaches neither the sea nor the edge is a lake; one that reaches the sea (water below 0 m) is a river.
  world.water[2 * 12 + 2] = world.water[2 * 12 + 3] = 1;
  world.water[9 * 12 + 9] = 1;
  world.height[9 * 12 + 9] = -2;
  world.water[8 * 12 + 9] = 1;
  r = landReadout(world);
  assert.deepEqual([r.rivers, r.lakes], [2, 1]);
  // A peak 30 m up: no 3×3 lot over it varies by 9 m or less, so it isn't flat for building, though the lots beside it are.
  const peak = new World(9, 9);
  peak.height.fill(3);
  peak.height[4 * 9 + 4] = 30;
  r = landReadout(peak);
  assert.equal(r.flat, 80 / 81);
  // Generated land: a coast is mostly one landmass with room to build; an archipelago's largest island holds a fraction.
  for (const seed of ['amber-isle-11', 'cedar-bay-4']) {
    const coast = landReadout(generateTerrain({ ...DEFAULT_TERRAIN, seed, w: 120, h: 100 }));
    assert.ok(coast.flat > 0.45 && coast.flat < 0.7 && coast.largest > 0.9 && coast.lakes > 0, `${seed}: ${JSON.stringify(coast)}`);
    const none = landReadout(generateTerrain({ ...DEFAULT_TERRAIN, rivers: 0, seed, w: 120, h: 100 }));
    const six = landReadout(generateTerrain({ ...DEFAULT_TERRAIN, rivers: 6, seed, w: 120, h: 100 }));
    assert.ok(none.rivers === 0 && six.rivers >= 4, `${seed}: rivers ${none.rivers} at 0, ${six.rivers} at 6`);
    const isles = landReadout(generateTerrain({ ...DEFAULT_TERRAIN, style: 'archipelago', seed, w: 120, h: 100 }));
    assert.ok(isles.largest < 0.4, `${seed}: the largest island holds ${isles.largest}`);
  }
  assert.deepEqual(landWords({ flat: 0.544, largest: 0.98, rivers: 2, lakes: 19 }), ['Flat for building: *54%* of the map', 'Largest landmass: *98%* of the land', '*2* rivers · *19* lakes']);
  assert.equal(landWords({ flat: 0, largest: 0, rivers: 0, lakes: 1 })[2], 'No rivers · *1* lake');
  assert.equal(landWords({ flat: 0, largest: 0, rivers: 1, lakes: 0 })[2], '*1* river · no lakes');
});

await test('generated land has no specks: no islets under 6 tiles, no ponds of 1 or 2', () => {
  // Ponds are counted with their diagonals: water that meets the sea only at a corner, between two islands, is a strait.
  const ponds = (world: World) => {
    const seen = new Uint8Array(world.n);
    let count = 0;
    for (let s = 0; s < world.n; s++) {
      if (seen[s] || !world.water[s]) continue;
      const stack = [s];
      seen[s] = 1;
      let size = 0;
      while (stack.length) {
        const i = stack.pop()!;
        size++;
        const x = i % world.w, y = (i / world.w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * world.w + x + dx;
          if (world.inBounds(x + dx, y + dy) && !seen[j] && world.water[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (size <= 2) count++;
    }
    return count;
  };
  for (const style of ['coast', 'island', 'archipelago', 'lakes'] as const) {
    for (let k = 0; k < 3; k++) {
      const world = generateTerrain({ ...DEFAULT_TERRAIN, style, seed: `probe-${k}-seed`, w: 180, h: 150 });
      assert.equal(landBodies(world).filter((b) => b < 6).length, 0, `${style} probe-${k}-seed: islets`);
      assert.equal(ponds(world), 0, `${style} probe-${k}-seed: ponds`);
    }
  }
});

await test('the Lakes slider sets how many lakes there are, and Lake country has more at every step', () => {
  const lakes = (style: 'coast' | 'lakes', amount: number) => {
    let count = 0;
    for (let k = 0; k < 3; k++) {
      const world = generateTerrain({ ...DEFAULT_TERRAIN, style, seed: `probe-${k}-seed`, w: 120, h: 100, lakes: amount, rivers: 0 });
      const seen = new Uint8Array(world.n);
      for (let s = 0; s < world.n; s++) {
        if (seen[s] || !world.water[s] || world.height[s] < 0) continue;
        const stack = [s];
        seen[s] = 1;
        let size = 0;
        while (stack.length) {
          const i = stack.pop()!;
          size++;
          const x = i % world.w, y = (i / world.w) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const j = (y + dy) * world.w + x + dx;
            if (world.inBounds(x + dx, y + dy) && !seen[j] && world.water[j] && world.height[j] >= 0) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
        if (size >= 6) count++;
      }
    }
    return count / 3;
  };
  const coast = [10, 50, 100].map((v) => lakes('coast', v));
  assert.ok(coast[0] <= 5 && coast[1] >= 6 && coast[2] >= 18, `coast lakes at 10, 50, 100: ${coast.join(', ')}`);
  assert.ok(coast[0] < coast[1] && coast[1] < coast[2]);
  const country = [10, 50].map((v) => lakes('lakes', v));
  assert.ok(country[0] > coast[0] * 2 && country[1] > coast[1] * 2, `Lake country at 10 and 50: ${country.join(', ')}`);
});

await test('the challenges\' land is the land they were laid out on, whatever the generator has learned since', () => {
  // Checksums of the classic generator's land, taken before archipelagos had islands.
  const sum = (style: 'archipelago' | 'coast' | 'lakes', seed: string) => {
    const w = generateTerrain({ ...DEFAULT_TERRAIN, style, seed, w: 120, h: 100, classic: true });
    let h = 0;
    for (let i = 0; i < w.n; i++) h = (Math.imul(h, 31) + w.water[i] * 7 + w.trees[i] + Math.round(w.height[i] * 10)) | 0;
    return h;
  };
  assert.deepEqual([sum('archipelago', 'amber-isle-11'), sum('coast', 'boomtown-coast-7'), sum('lakes', 'gridlock-plain-3')], [1539356577, -1648787258, -1269814288]);
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

await test('a building pointed at near the edge of the map slides inside it, flush against the edge; elsewhere it is centred', () => {
  const w = flat(40, 30);
  const at = (kind: Kind, x: number, y: number) => {
    const p = planPlace(w, kind, x, y);
    return [p.count, ...(p.tiles[0] ?? p.bad[0]), p.reason ?? ''];
  };
  // A coal plant is 4 tiles, an airport 6: centred on the tile in the open, a tile up and left of the middle.
  assert.deepEqual(at('coal', 20, 15), [1, 19, 14, '']);
  assert.deepEqual(at('airport', 20, 15), [1, 18, 13, '']);
  // The last row and column, and each corner.
  assert.deepEqual(at('coal', 39, 29), [1, 36, 26, '']);
  assert.deepEqual(at('coal', 0, 0), [1, 0, 0, '']);
  assert.deepEqual(at('airport', 39, 0), [1, 34, 0, '']);
  assert.deepEqual(at('airport', 0, 29), [1, 0, 24, '']);
  assert.deepEqual(at('airport', 38, 15), [1, 34, 13, ''], 'two tiles in, an airport still reaches the edge');
  assert.deepEqual(at('wind', 39, 29), [1, 39, 29, '']);
  // Flush where that land is free; where it isn't, the card says why, at the edge, not off the map.
  w.setNet(ROAD, 37, 28);
  assert.deepEqual(at('coal', 39, 29), [0, 36, 26, 'Clear the roads and lines first']);
});

await test('steepness is measured between dry tiles: a beach beside deep sea is flat, a step on land still counts', () => {
  const w = flat(10, 10);
  w.height.fill(1);
  for (let y = 0; y < w.h; y++) for (let x = 0; x < 3; x++) {
    w.height[y * w.w + x] = -30;
    w.water[y * w.w + x] = 1;
  }
  assert.equal(w.slope(3, 5), 0, 'the beach at 1 m beside -30 m sea');
  w.height[5 * w.w + 6] = 11;
  assert.equal(w.slope(5, 5), 10, 'a 10 m step between two dry tiles');
  assert.equal(w.slope(6, 5), 10);
  // A tile with water all round has no dry neighbour to step to.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    w.water[(2 + dy) * w.w + 8 + dx] = 1;
    w.height[(2 + dy) * w.w + 8 + dx] = -10;
  }
  assert.equal(w.slope(8, 2), 0);
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

await test('a burning plant makes nothing, and Inspect and the news put a brownout down to the fire', () => seeded(6, () => {
  // Two turbines on one grid, kept apart by lines so the fire can't jump, for four lots: 36 MW for 36.
  const w = flat(60, 20);
  const burning = w.place('wind', 1, 1);
  applyLine(w, POWER, planLine(w, POWER, linePath(2, 1, 4, 1)));
  const lots = [w.place('res', 5, 0), w.place('res', 8, 0), w.place('res', 11, 0), w.place('res', 14, 0)];
  applyLine(w, POWER, planLine(w, POWER, linePath(17, 1, 19, 1)));
  w.place('wind', 20, 1);
  const sim = new Sim(w);
  sim.disasters.ignite(1, 1);
  sim.computePower();
  const row = (x: number, y: number, k: string) => sim.describe(x, y).rows.find((r) => r[0] === k)?.[1];
  assert.equal(row(1, 1, 'Power'), 'None: on fire');
  assert.equal(row(20, 1, 'Power'), 'Generating');
  const dark = lots.filter((b) => !b.powered);
  assert.equal(dark.length, 2);
  assert.equal(row(dark[0].x + 1, dark[0].y + 1, 'Power'), 'None: its power plant is on fire');
  assert.equal(row(dark[0].x + 1, dark[0].y + 1, 'Its grid'), 'Overloaded: needs 36 MW, makes 18; a plant is on fire');
  for (let k = 0; k < 4; k++) sim.step();
  assert.ok(w.fire[1 * w.w + 1] > 0, 'still burning at the month end');
  const brownout = sim.messages.filter((m) => m.text.startsWith('Brownouts'));
  assert.deepEqual(brownout.map((m) => m.text), ['Brownouts: the grid needs 36 MW but the plants make 18 MW while the wind turbine is on fire. The power comes back once the fire is out.']);
  void burning;
}));

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

await test('Inspect says how far a lot can grow where it stands, and why it is or is not growing', () => {
  const w = flat(40, 30);
  const home = w.place('res', 10, 10);
  const works = w.place('ind', 20, 10);
  const sim = new Sim(w);
  const ci = 11 * w.w + 11;
  // A spot set by hand: $6,000 an acre at the lot's centre, which growth reads, and $8,000 at its corner.
  const spot = ({ level = 7, lv = 150, pol = 0, svc = 0, demand = 0.5, trip = true, powered = true } = {}) => {
    w.setLevel(home, level);
    w.landValue[ci] = lv;
    w.landValue[10 * w.w + 10] = 200;
    w.pollution[ci] = pol;
    w.crime[ci] = 0;
    w.serviceCov[ci] = svc;
    w.city.demand.r = demand;
    Object.assign(home, { powered, road: true, trip });
    const d = sim.describe(10, 10);
    const read: Record<string, string | undefined> = { ...Object.fromEntries(d.rows), note: d.note };
    return read;
  };
  const full = spot();
  assert.equal(full['Land value'], '$6,000/acre');
  assert.equal(full['Can grow to'], 'Density 7');
  assert.equal(full.Outlook, 'Full for its land value');
  assert.equal(full.note, 'Density 7 is the most this land value allows. Density 8 (residential towers) needs $7,000/acre here.');
  // A school in reach counts for $1,200 towards the thresholds, so the same land value now allows towers.
  const school = spot({ svc: 255 });
  assert.deepEqual([school['Can grow to'], school.Outlook, school.note], ['Density 8', 'Growing', undefined]);
  assert.equal(spot({ level: 5 }).Outlook, 'Growing');
  sim.capped.res = true;
  assert.equal(spot({ level: 5 }).Outlook, 'Held at a landmark limit: build a stadium');
  sim.capped.res = false;
  assert.equal(spot({ level: 5, pol: 255, demand: 0.05 }).Outlook, 'Shrinking: pollution');
  assert.equal(spot({ level: 5, demand: -0.8 }).Outlook, 'Shrinking: low demand');
  assert.equal(spot({ level: 5, trip: false }).Outlook, 'Steady: no commute');
  assert.equal(spot({ level: 0, powered: false }).Outlook, 'Not growing: no power');
  const over = spot({ level: 7, lv: 100 });
  assert.equal(over.Outlook, 'Shrinking: land value too low');
  // Denser than its land allows: the row says what the land allows, not that the lot can 'grow' to less.
  assert.equal(over['Can grow to'], undefined);
  assert.match(over['Land value allows']!, /^Density [0-6]$/);
  assert.match(over.note!, /^Density [0-6] is the most this land value allows\. Keeping density 7 \([a-z ]+\) needs \$[\d,]+\/acre here\.$/);
  // Industry has no land value threshold.
  assert.equal(Object.fromEntries(sim.describe(works.x, works.y).rows)['Can grow to'], 'Density 4');
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

await test('riders are counted on the track they ride, from where they board to where they get off, and a spur nobody uses has none', async () => {
  const w = flat(60, 30);
  const home = w.place('res', 2, 2);
  w.setLevel(w.place('com', 40, 2), 3);
  w.setLevel(home, 8);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 4, 5)));
  applyLine(w, RAIL, planLine(w, RAIL, linePath(5, 5, 39, 5)));
  applyLine(w, RAIL, planLine(w, RAIL, linePath(20, 6, 20, 20))); // a spur off to nowhere
  applyLine(w, ROAD, planLine(w, ROAD, linePath(40, 5, 42, 5)));
  const sim = new Sim(w);
  sim.computeTraffic(false);
  const at = (x: number, y: number) => sim.riders[y * w.w + x];
  for (let x = 5; x <= 39; x++) assert.ok(at(x, 5) > 0, `no riders at x ${x}`);
  for (let y = 6; y <= 20; y++) assert.equal(at(20, y), 0, `riders on the spur at y ${y}`);
  assert.equal(at(4, 5), 0, 'the road to the station carries cars, not riders');
  const rows = (x: number, y: number) => Object.fromEntries(sim.describe(x, y).rows);
  // 2,200 residents, 1,100 of them commuting, all by train: Busy on the riders' scale.
  assert.equal(rows(12, 5).Riders, 'Busy');
  assert.equal(rows(20, 12).Riders, 'None');
  assert.equal(rows(4, 5).Riders, undefined);
  // Eased from month to month like the traffic, and not saved: a city opened again counts them afresh.
  const before = at(12, 5);
  const back = await reopen(sim);
  assert.equal(back.riders[5 * w.w + 12], before);
  assert.deepEqual([0, 1, 59, 60, 169, 170, 255].map(ridersWord), ['None', 'Light', 'Light', 'Busy', 'Busy', 'Packed', 'Packed']);
});

await test('Inspect on a road or track says who drives or rides along it, from where to where, worked out only when asked', () => {
  const w = flat(60, 30);
  const home = w.place('res', 2, 2);
  const shops = w.place('com', 40, 2);
  w.setLevel(shops, 3);
  w.setLevel(home, 8);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 4, 5)));
  applyLine(w, RAIL, planLine(w, RAIL, linePath(5, 5, 39, 5)));
  applyLine(w, RAIL, planLine(w, RAIL, linePath(20, 6, 20, 20)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(40, 5, 42, 5)));
  const sim = new Sim(w);
  sim.computeTraffic(false);
  const traffic = w.traffic.slice();
  const riders = sim.riders.slice();
  const say = (x: number, y: number) => {
    const p = sim.passing(x, y)!;
    return { p, text: passingSentence(p, !!(w.net[y * w.w + x] & ROAD), !!(w.net[y * w.w + x] & RAIL)) };
  };
  // 2,200 residents, 1,100 of them commuting, every one by train to the shops; the shops' deliveries ride it back.
  const track = say(12, 5);
  assert.equal(track.text, 'About 1,100 commuters a month ride through here, from the homes to the west to the shops and offices to the east. Deliveries from the shops and offices to the east add about 50.');
  assert.deepEqual([track.p.homes, track.p.jobs], [[home.id], [shops.id]]);
  // The road to the station: they drive along it from their own doorstep, and the deliveries to it.
  const road = say(4, 5);
  assert.equal(road.text, 'About 1,100 commuters a month drive through here, from the homes nearby to the shops and offices to the east. Deliveries from the shops and offices to the east add about 50.');
  assert.equal(say(20, 12).text, 'Nobody rides along here.');
  assert.equal(sim.passing(30, 20), null, 'open land');
  // Asking changes nothing the city keeps.
  assert.deepEqual([w.traffic, sim.riders], [traffic, riders]);
  assert.deepEqual([compass(0, -9), compass(-6, 6), compass(3, 2), compass(20, 1)], ['to the north', 'to the south-west', 'nearby', 'to the east']);
});

await test('more trains, and longer ones, run where more people ride, and a spur nobody rides sees few', () => {
  const w = flat(70, 40);
  applyLine(w, RAIL, planLine(w, RAIL, linePath(5, 10, 64, 10)));
  applyLine(w, RAIL, planLine(w, RAIL, linePath(30, 11, 30, 35))); // a spur off the middle of the line
  const riders = new Uint8Array(w.n);
  for (let x = 5; x <= 64; x++) riders[10 * w.w + x] = 200;
  const trains = (ride: Uint8Array | null) => seeded(5, () => {
    const v = new Vehicles(w);
    v.riders = ride;
    let onSpur = 0;
    let heads = 0;
    for (let k = 0; k < 600; k++) {
      v.update(0.1, true);
      for (const t of v.trains) {
        heads++;
        if (t.trail[0] % w.w === 30 && t.trail[0] > 10 * w.w + 30) onSpur++;
      }
    }
    return { n: v.trains.length, cars: v.trains.map((t) => t.cars), spur: onSpur / heads };
  });
  const busy = trains(riders);
  // 60 tiles at 200 riders: four trains of five cars, where the empty track gets one.
  assert.equal(busy.n, 4);
  assert.deepEqual(busy.cars, [5, 5, 5, 5]);
  assert.ok(busy.spur < 0.08, `trains spent ${(busy.spur * 100).toFixed(0)}% of their time on the empty spur`);
  // Nobody riding yet: one short train keeps the track alive.
  const empty = trains(new Uint8Array(w.n));
  assert.equal(empty.n, 1);
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
  assert.deepEqual(at('1 zone has no road access and cannot develop.'), [[lonely.x + 1, lonely.y + 1]]);
}));

await test('a road laid beside a lot takes its road sign away at once, though the commute waits for the month end', () => {
  const w = flat(60, 30);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 5, 40, 5)));
  w.place('res', 2, 2);
  w.place('com', 20, 2);
  const lonely = w.place('res', 10, 10); // no road
  const sim = new Sim(w);
  sim.computeTraffic();
  assert.deepEqual([lonely.road, cutOff(w, lonely)], [false, true]);
  // A stub of road along its bottom, with the clock stopped: the simulation hasn't looked again, the sign has.
  applyLine(w, ROAD, planLine(w, ROAD, linePath(10, 13, 12, 13)));
  assert.deepEqual([lonely.road, cutOff(w, lonely)], [false, false]);
  // At the month end the simulation sees the stub leads nowhere: no commute, so the sign is back.
  sim.computeTraffic();
  assert.deepEqual([lonely.road, lonely.trip, cutOff(w, lonely)], [true, false, true]);
  // Joined to the town, it can commute.
  applyLine(w, ROAD, planLine(w, ROAD, linePath(13, 13, 13, 6)));
  sim.computeTraffic();
  assert.deepEqual([lonely.trip, cutOff(w, lonely)], [true, false]);
  // Its roads bulldozed: the sign shows before the simulation has looked.
  for (let x = 10; x <= 13; x++) w.clearNet(x, 13);
  for (let y = 6; y <= 12; y++) w.clearNet(13, y);
  assert.deepEqual([lonely.road, cutOff(w, lonely)], [true, true]);
});

await test('with shops in demand, the advisor says why an empty shop lot cannot open before it asks for more land', () => {
  const w = flat(40, 30);
  w.city.month = 12;
  w.place('coal', 1, 1);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(1, 6, 38, 6)));
  const shop = w.place('com', 20, 3); // on the road, but no wire to the plant
  const advice = () => {
    const sim = new Sim(w);
    w.city.demand = { r: 0, c: 1, i: 0 };
    (sim as any).advise();
    return sim.messages.filter((m) => m.text.startsWith('Shops')).map(({ text, x, y }) => ({ text, x, y }));
  };
  assert.deepEqual(advice(), [{ text: 'Shops are in demand, but the empty commercial lot has no power.', x: shop.x + 1, y: shop.y + 1 }]);
  // Wired up, the lot is ready to open, and one is not enough.
  applyLine(w, POWER, planLine(w, POWER, linePath(5, 2, 20, 2)));
  assert.deepEqual(advice(), [{ text: 'Shops are in demand. Zone more commercial land.', x: undefined, y: undefined }]);
  // Powered but off the road: lots that cannot open are what to fix.
  const back = w.place('com', 24, 9);
  const back2 = w.place('com', 27, 9);
  applyLine(w, POWER, planLine(w, POWER, linePath(21, 2, 23, 2)));
  applyLine(w, POWER, planLine(w, POWER, linePath(23, 3, 23, 10)));
  const sim = new Sim(w);
  assert.deepEqual([back.powered, back2.powered, back.road, back2.road], [true, true, false, false]);
  assert.equal(sim.stats.vacantReady.com, 1);
  assert.deepEqual(advice(), [{ text: 'Shops are in demand. Zone more commercial land.', x: undefined, y: undefined }]);
  w.remove(shop.id);
  assert.deepEqual(advice(), [{ text: 'Shops are in demand, but the empty commercial lots have no road.', x: back.x + 1, y: back.y + 1 }]);
});

await test('the landmark limits: 18,000 residents, 5,000 shop jobs, 4,000 factory jobs', () => {
  const w = flat(60, 40);
  for (let k = 0; k < 9; k++) w.setLevel(w.place('res', 1 + k * 3, 1), 8); // 19,800 residents
  for (let k = 0; k < 4; k++) w.setLevel(w.place('com', 1 + k * 3, 5), 5); // 6,000 jobs
  for (let k = 0; k < 6; k++) w.setLevel(w.place('ind', 1 + k * 3, 9), 4); // 4,560 jobs
  const sim = new Sim(w);
  assert.deepEqual(sim.capped, { res: true, com: true, ind: true });
  // The news names each limit, as the toolbox tips do.
  sim.computeDemand();
  assert.deepEqual(sim.messages.map((m) => m.text), [
    'Housing has stopped at 18,000 residents until the city builds a stadium.',
    'Commerce has stopped at 5,000 jobs until the city builds an airport.',
    'Industry has stopped at 4,000 jobs until the city builds a seaport.',
  ]);
  assert.deepEqual(['stadium', 'airport', 'seaport'].map((k) => BUILDINGS[k as Kind].blurb), [
    'Needed before housing passes 18,000 residents.', 'Needed before commerce passes 5,000 jobs.', 'Needed before industry passes 4,000 jobs. Must touch water.',
  ]);
  assert.deepEqual(['international airport', 'jet terminal', 'Upgrade'].map(article), ['an', 'a', 'an']);
  w.place('stadium', 1, 14);
  w.place('airport', 6, 14);
  w.place('seaport', 13, 14);
  sim.tally();
  assert.deepEqual(sim.capped, { res: false, com: false, ind: false });
});

await test('the Budget puts the stadium, seaport and airport on a line of their own, and says what a road cut crumbles', () => {
  const w = flat(60, 40);
  w.place('school', 1, 1);
  w.place('park', 6, 1);
  w.place('police', 1, 6);
  const stadium = w.place('stadium', 10, 1);
  w.setLevel(stadium, 3); // domed: $30 + $60 + $120
  w.place('seaport', 16, 1);
  w.place('airport', 22, 1);
  for (let x = 1; x <= 50; x++) w.setNet(ROAD, x, 20);
  const sim = new Sim(w);
  sim.estimateBudget();
  const b = sim.stats.lastBudget;
  assert.equal(b.services, 40 + 0.3, 'schools, hospitals and parks');
  assert.equal(b.landmarks, 210 + 50 + 80, 'stadium, seaport and airport, upgrades and all');
  assert.equal(spending(b), b.transport + b.police + b.fire + 40.3 + 340 + b.power + b.interest, 'the total is what it was');
  // Kept in a save.
  const back = World.deserialize(JSON.parse(JSON.stringify(w.serialize(sim.saveRun()))));
  assert.equal(back.run!.lastBudget.landmarks, 340);
  // What each funded service costs at full funding, and what a cut to roads crumbles: (0.9 - funding) x 1.2% of the
  // 50 road tiles a month.
  assert.deepEqual(sim.fullUpkeep(), { police: 45, fire: 0, transport: b.transport });
  assert.equal(sim.crumbling(1), 0);
  assert.equal(sim.crumbling(0.9), 0);
  assert.ok(Math.abs(sim.crumbling(0.4) - 50 * 0.5 * 0.012) < 1e-9);
});

await test('Inspect says what a service does, and what land value a landmark adds across the city', () => {
  const w = flat(60, 40);
  const police = w.place('police', 1, 1);
  const coal = w.place('coal', 6, 1);
  const big = w.place('stadium', 12, 1);
  const small = w.place('stadium', 18, 1);
  const port = w.place('seaport', 24, 1);
  const sim = new Sim(w);
  const row = (b: { x: number; y: number }, k: string) => sim.describe(b.x, b.y).rows.find((r) => r[0] === k)?.[1];
  const does = (b: { x: number; y: number }) => sim.describe(b.x, b.y).does;
  assert.equal(does(police), 'Cuts crime within about 18 tiles');
  assert.equal(does(coal), 'Powers the zones its grid reaches, and pollutes heavily');
  // A built landmark does what the toolbox says it is needed for.
  assert.equal(does(big), 'Lets housing grow past 18,000 residents');
  assert.equal(does(port), 'Lets industry grow past 4,000 jobs');
  assert.equal(row(w.place('nuclear', 36, 1), 'Output'), '2,000 MW');
  assert.equal(row(police, 'Land value it adds'), undefined);
  assert.equal(row(big, 'Land value it adds'), 'None until it is upgraded');
  w.setLevel(big, 3);
  assert.equal(row(big, 'Land value it adds'), `+$${2 * UPGRADE_LV * 40}/acre across the city`);
  assert.equal(row(small, 'Land value it adds'), 'None: only the most upgraded counts');
  assert.equal(row(port, 'Land value it adds'), 'None until it is upgraded', 'each kind counts on its own');
  assert.equal(sim.landmarkValue(), 2 * UPGRADE_LV, 'the same sum the city adds');
  const zone = w.place('res', 30, 10);
  assert.equal(does(zone), undefined, 'a zone says what it holds instead');
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
    assert.ok(sim.messages.some((m) => m.text === 'Industry has stopped at 4,000 jobs until the city builds a seaport.'));
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

await test('the report counts taxes a worry only above the neutral 7%: Minor from 9%, Serious from 11%, Severe from 14%', () => {
  const at = (tax: number) => {
    const w = flat(40, 30);
    w.setLevel(w.place('res', 2, 2), 4);
    w.city.tax = tax;
    const sim = new Sim(w);
    sim.stats.approval = 50;
    sim.evaluate();
    return { word: worryWord(sim.stats.problems.find((p) => p.id === 'taxes')!.value), approval: sim.stats.approval };
  };
  assert.deepEqual([0, 4, 7, 8, 9, 10, 11, 13, 14, 20].map((t) => at(t).word), [
    'Fine', 'Fine', 'Fine', 'Fine', 'Minor', 'Minor', 'Serious', 'Serious', 'Severe', 'Severe',
  ]);
  // Approval: cutting taxes below 7% buys none, and every point above it costs some.
  assert.equal(at(4).approval, at(7).approval);
  assert.ok(at(9).approval < at(8).approval && at(8).approval < at(7).approval);
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

await test('the size classes: a town at 2,000 residents, a city at 10,000, and a megalopolis within reach at 250,000', () => {
  assert.deepEqual([1999, 2000, 9999, 10000, 49999, 50000, 99999, 100000, 249999, 250000, 600000].map(cityClass), [
    'Village', 'Town', 'Town', 'City', 'City', 'Capital', 'Capital', 'Metropolis', 'Metropolis', 'Megalopolis', 'Megalopolis',
  ]);
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

await test("a city's natural ground keeps the land's heights, water and trees, and nothing built on it", () => {
  const w = flat(20, 16);
  w.city.seed = 'harbor-pine-42';
  for (let i = 0; i < w.n; i++) w.height[i] = 2 + (i % 7);
  w.water.fill(1, 0, 20);
  w.trees[50] = 3;
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 8, 12, 8)));
  applyLine(w, ROAD, planLine(w, ROAD, linePath(2, 0, 2, 4)));
  applyBuildings(w, 'res', planZones(w, 'res', 5, 10, 5, 10));
  w.rubble[200] = 1;
  w.fire[201] = 2;
  w.flood[202] = 4;
  w.rad[203] = 9;
  assert.ok(w.buildings.size === 1 && w.net.some((v) => v) && w.water[2], 'a road crosses the water on a bridge');
  const g = w.naturalGround();
  assert.deepEqual([g.w, g.h, g.city.seed, g.city.founded, g.buildings.size], [20, 16, 'harbor-pine-42', false, 0]);
  assert.deepEqual([g.height, g.water, g.trees], [w.height, w.water, w.trees]);
  for (const layer of ['net', 'occ', 'rubble', 'fire', 'flood', 'rad'] as const) assert.ok(g[layer].every((v) => !v), layer);
  // The city it came from is as it was.
  assert.equal(w.buildings.size, 1);
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

await test('a reloaded city shows the figures it closed with: residents and land value do not jump as it opens', async () => {
  const monster = SCENARIOS.find((x) => x.id === 'monster')!;
  const random = Math.random;
  try {
    Math.random = makeRng(77);
    const w = buildScenario(monster, 120, 100);
    const sim = new Sim(w);
    openScenario(sim);
    for (let k = 0; k < 29; k++) sim.step(); // a week into a month
    const back = await reopen(sim);
    const figures = (s: Sim) => [s.stats.residents, s.stats.avgLandValue, s.stats.avgCrime, s.stats.comJobs + s.stats.indJobs, s.stats.cityClass, monster.check(s).status];
    assert.deepEqual(figures(back), figures(sim));
    // A code whose figures are damaged opens with them worked out afresh, rather than with nonsense.
    const run = JSON.parse(JSON.stringify(sim.saveRun()));
    run.readouts.residents = -5;
    const fresh = new Sim(World.deserialize(JSON.parse(JSON.stringify(w.serialize(run)))));
    assert.ok(fresh.stats.residents > 0 && Number.isFinite(fresh.stats.avgLandValue));
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
  assert.deepEqual(back.stats.lastBudget, { taxIncome: 12, transport: 0, police: 0, fire: 0, services: 0, landmarks: 0, power: 0, interest: 0 });
  assert.deepEqual(back.stats.yearBudget, { taxIncome: 0, transport: 0, police: 0, fire: 0, services: 0, landmarks: 0, power: 0, interest: 0 });
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
    // Out before the next starts beside it, which is then a fire of its own.
    for (let dy = 0; dy < b.size; dy++) for (let dx = 0; dx < b.size; dx++) w.fire[(b.y + dy) * w.w + b.x + dx] = 0;
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

await test('a town big enough for fires is told what a fire or police station costs and does, and when fires start', () => seeded(2, () => {
  const news = (disasters: boolean, levels = [8, 8]) => {
    const w = flat(40, 30);
    w.city.disasters = disasters;
    w.city.month = 24;
    levels.forEach((lv, k) => w.setLevel(w.place('res', 2 + 4 * k, 2), lv));
    const sim = new Sim(w);
    for (let k = 0; k < 4; k++) sim.step();
    const pop = sim.stats.residents;
    assert.ok(levels.length === 2 ? pop > 2500 && pop < 5000 : pop >= 5000, `${pop} residents`);
    return sim.messages.map((m) => m.text).filter((t) => t.includes('station'));
  };
  const police = 'The city has no police station. Crime grows as the town gets crowded; a station ($500, $45 a month) keeps it down nearby.';
  // Asked at 2,500 residents, before random fires start at 5,000.
  assert.deepEqual(news(true), ['The city has no fire station. Fires break out from time to time once it has 5,000 residents; a station ($500, $45 a month) puts them out nearby.', police]);
  assert.deepEqual(news(true, [8, 8, 7]), ['The city has no fire station. Fires break out from time to time now; a station ($500, $45 a month) puts them out nearby.', police]);
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
  // Caught from a lot that came down in the same week, with nothing else alight near it, it is still the same fire:
  // no new alert, and not out.
  const w = flat();
  const lot = w.place('res', 10, 10);
  const below = w.place('res', 10, 13);
  for (const b of [lot, below]) w.setLevel(b, 2);
  const sim = new Sim(w);
  sim.disasters.ignite(11, 11);
  for (let y = 10; y < 13; y++) for (let x = 10; x < 13; x++) w.fire[y * w.w + x] = 1;
  const random = Math.random;
  Math.random = () => 0;
  try {
    sim.disasters.week();
  } finally {
    Math.random = random;
  }
  assert.equal(w.buildings.has(lot.id), false);
  assert.ok(w.fire[14 * w.w + 11] > 0, 'the lot below never caught');
  assert.deepEqual(sim.messages.map((m) => m.text.split('.')[0]), ['Fire at the cottages']);
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

await test('a flood or a tornado over burning woods leaves no fire burning on bare ground', () => {
  const bare = (w: World) => {
    let n = 0;
    for (let i = 0; i < w.n; i++) if (w.fire[i] && !w.occ[i] && !w.trees[i] && !w.rubble[i]) n++;
    return n;
  };
  // A flood spreads over the wood from the shore, burning along its edge, and washes the trees away.
  seeded(3, () => {
    const w = flat(40, 30);
    w.height.fill(1);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 4; x++) { w.water[y * w.w + x] = 1; w.height[y * w.w + x] = -4; }
    for (let y = 5; y < 25; y++) for (let x = 4; x < 20; x++) w.trees[y * w.w + x] = 2;
    const sim = new Sim(w);
    for (let y = 5; y < 25; y++) w.fire[y * w.w + 4] = w.fire[y * w.w + 5] = 8;
    sim.disasters.trigger('flood');
    let flooded = 0, left = 0;
    for (let t = 0; t < 4; t++) {
      sim.step();
      left += bare(w);
    }
    for (let i = 0; i < w.n; i++) if (w.flood[i]) flooded++;
    assert.ok(flooded > 10, `the flood reached ${flooded} tiles`);
    assert.equal(left, 0, `${left} tile-weeks of fire on bare, flooded ground`);
  });
  // A tornado through a burning forest tears up the trees, and the fire in them goes with them.
  seeded(4, () => {
    const w = flat(40, 30);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 35; x++) { w.trees[y * w.w + x] = 3; w.fire[y * w.w + x] = 8; }
    const sim = new Sim(w);
    sim.disasters.roamers.push({ kind: 'tornado', x: 20, y: 15, px: 20, py: 15, vx: 0, vy: 0, weeks: 10, heading: 0 });
    for (let t = 0; t < 3; t++) {
      sim.step();
      assert.equal(bare(w), 0, `week ${t + 1}: fire on bare ground where the tornado went`);
    }
    let torn = 0;
    for (let y = 5; y < 25; y++) for (let x = 5; x < 35; x++) if (!w.trees[y * w.w + x]) torn++;
    assert.ok(torn > 5, `the tornado tore up ${torn} tiles of forest`);
  });
});

await test('the news names a tile on the map for every tornado and monster, even one that starts at the edge', () => {
  let off = 0, placed = 0;
  for (let k = 0; k < 40; k++) seeded(100 + k, () => {
    // Deep water down the east edge for the monster to rise from; the town hugs the west edge for the tornado.
    const w = flat(60, 40);
    for (let y = 0; y < 40; y++) for (let x = 56; x < 60; x++) { w.water[y * 60 + x] = 1; w.height[y * 60 + x] = -6; }
    w.place('coal', 2, 2);
    w.place('res', 2, 20);
    const sim = new Sim(w);
    sim.disasters.trigger(k % 2 ? 'monster' : 'tornado');
    for (const m of sim.messages) {
      if (m.x === undefined) continue;
      placed++;
      if (!w.inBounds(m.x, m.y!) || !Number.isInteger(m.x) || !Number.isInteger(m.y)) off++;
    }
    const r = sim.disasters.roamers[0];
    if (!(r.x >= 0 && r.y >= 0 && r.x < w.w && r.y < w.h)) off++;
  });
  assert.equal(placed, 40);
  assert.equal(off, 0, `${off} tornadoes and monsters named, or stood on, a spot off the map`);
});

await test('a save with rubble left burning for years opens with it put out', () => {
  const w = flat();
  w.fire[5 * w.w + 5] = 250; // burnt-down rubble from before the fix
  w.fire[6 * w.w + 6] = 7; // a real fire carries on
  const back = World.deserialize(JSON.parse(JSON.stringify(w.serialize())));
  assert.equal(back.fire[5 * w.w + 5], 0);
  assert.equal(back.fire[6 * w.w + 6], 7);
});

await test('random disasters wait for a city of 5,000 on every difficulty, well after it is asked for a fire station', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const w = flat(60, 40);
    w.city.disasters = true;
    w.city.difficulty = difficulty;
    w.setLevel(w.place('res', 2, 2), 8);
    w.setLevel(w.place('res', 5, 2), 8);
    w.setLevel(w.place('res', 8, 2), 5); // 4,760 residents
    const sim = new Sim(w);
    const seen: string[] = [];
    sim.on((e) => { if (e.type === 'disaster') seen.push(e.kind); });
    const random = Math.random;
    Math.random = () => 0.001; // every roll says "disaster"
    try {
      sim.disasters.month();
      assert.deepEqual(seen, [], difficulty);
      w.setLevel(w.place('res', 11, 2), 5); // 5,120 residents
      sim.tally();
      sim.disasters.month();
      assert.deepEqual(seen, ['fire'], difficulty);
    } finally {
      Math.random = random;
    }
  }
});

await test('a nuclear plant melts down rarely: 0.04% a month on Medium', () => {
  const w = flat(60, 40);
  w.city.disasters = true;
  w.city.difficulty = 'medium';
  w.setLevel(w.place('res', 2, 2), 8);
  w.setLevel(w.place('res', 5, 2), 8);
  w.setLevel(w.place('res', 8, 2), 7); // 5,800 residents, so random disasters are on
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

await test('challenge cities open with only the factories and shops their people keep busy, and keep those jobs', () => {
  const random = Math.random;
  try {
    for (const seed of [3, 7]) {
      Math.random = makeRng(seed);
      for (const s of SCENARIOS.filter((x) => x.city)) {
        const w = buildScenario(s, 120, 100);
        w.city.disasters = false;
        const sim = new Sim(w);
        openScenario(sim);
        const want = sim.jobsWanted();
        assert.ok(sim.stats.indJobs <= want.ind, `${s.name}: ${sim.stats.indJobs} factory jobs for ${Math.round(want.ind)} wanted`);
        assert.ok(sim.stats.comJobs <= want.com, `${s.name}: ${sim.stats.comJobs} shop jobs for ${Math.round(want.com)} wanted`);
        // Gridlock opened with 15,560 jobs and lost a third of them in its first year; Monster Bay lost two thirds.
        const opening = sim.stats.comJobs + sim.stats.indJobs;
        for (let k = 0; k < 4 * 12; k++) sim.step();
        const after = sim.stats.comJobs + sim.stats.indJobs;
        assert.ok(after >= opening * 0.9, `${s.name}, seed ${seed}: jobs fell from ${opening} to ${after} in the first year`);
      }
    }
  } finally {
    Math.random = random;
  }
});

await test("Monster Bay's monster comes ashore only while the pollution index is 9 or more, and the news says so six months ahead", () => seeded(5, () => {
  const s = SCENARIOS.find((x) => x.id === 'monster')!;
  const w = buildScenario(s, 120, 100);
  const sim = new Sim(w);
  openScenario(sim);
  const start = w.city.scenario!.end - 10 * 12;
  const news: string[] = [];
  sim.on((e) => {
    if (e.type === 'message') news.push(e.message.text);
  });
  /** A month end `since` months into the challenge, with the pollution index at `index`. */
  const at = (since: number, index: number) => {
    news.length = 0;
    w.city.month = start + since;
    sim.stats.avgPollution = index * 2.55;
    scenarioMonth(s, sim);
    return news.slice();
  };
  assert.deepEqual(at(3, 8), []);
  // Clean air: it shows itself, and leaves. It came every two years whatever the air was like.
  assert.deepEqual(at(9, 8), ['The monster surfaced in the bay, found the air clean and went back under.']);
  assert.equal(sim.disasters.roamers.length, 0);
  assert.deepEqual(at(27, 9), ['The monster surfaces in six months. Pollution index 9: at 9 or more, it comes ashore.']);
  assert.deepEqual(at(32, 9), []);
  assert.deepEqual(at(33, 9), ['A monster is coming ashore!']);
  assert.deepEqual(sim.disasters.roamers.map((r) => r.kind), ['monster']);
  assert.equal(s.check(Object.assign(sim, { stats: { ...sim.stats, residents: 18000, approval: 61 } })).met, true, '18,000 residents and approval over 60% is the goal');
}));

await test("Smog Valley's four coal plants stand among its homes, so their smoke counts where people live", () => seeded(1, () => {
  const smog = SCENARIOS.find((x) => x.id === 'smog')!;
  const w = buildScenario(smog, 120, 100);
  const sim = new Sim(w);
  openScenario(sim);
  const coal = [...w.buildings.values()].filter((b) => b.kind === 'coal');
  assert.equal(coal.length, 4);
  for (const p of coal) {
    const homes = [...w.buildings.values()].filter((b) => b.kind === 'res' && b.level > 0 && Math.max(Math.abs(b.x + 1 - (p.x + 2)), Math.abs(b.y + 1 - (p.y + 2))) <= 7);
    assert.ok(homes.length >= 4, `the coal plant at ${p.x},${p.y} has ${homes.length} homes round it`);
    assert.ok(p.powered, 'each plant is on the grid');
  }
  assert.equal(sim.stats.unpowered, 0);
  // Outside the town the four plants made 0.2 of the index; Smog Valley was won with all of them running.
  const index = () => sim.stats.avgPollution / 2.55;
  const withCoal = index();
  for (const p of coal) w.remove(p.id);
  sim.computeMaps();
  assert.ok(withCoal - index() >= 2, `the coal plants make ${(withCoal - index()).toFixed(1)} of the pollution index`);
}));

await test("High Water's tides come each April and October, a quarter of a metre higher each time, and the news says three months ahead how high and what is in the way", () => seeded(5, () => {
  const s = SCENARIOS.find((x) => x.id === 'tide')!;
  const w = buildScenario(s, 120, 100);
  const sim = new Sim(w);
  openScenario(sim);
  // The seafront is low and the plants are high: the first tide reaches nothing built, the last a good part of the city.
  const reach = (n: number) => sim.disasters.inReach(sim.disasters.tideReach(tideLine(n)).tiles);
  assert.equal(reach(0).length, 0);
  assert.ok(reach(19).filter((b) => b.kind === 'res').length >= 10, `the last tide reaches ${reach(19).length} buildings`);
  assert.ok(!reach(19).some((b) => BUILDINGS[b.kind].capacity), 'a power plant stands in the last tide’s way');
  const said: { text: string; x?: number }[] = [];
  sim.on((e) => {
    if (e.type === 'message') said.push(e.message);
  });
  const tides: [number, number][] = [];
  sim.disasters.tide = (level: number) => void tides.push([w.city.month % 12, level]);
  s.start!(sim);
  assert.deepEqual(said.map((m) => m.text), ['High tide in three months, up to 2 m. Nothing built is in its way.']);
  const start = w.city.scenario!.end - 10 * 12;
  for (let since = 1; since <= 10 * 12; since++) {
    w.city.month = start + since;
    if (since === 108) {
      said.length = 0;
      scenarioMonth(s, sim);
      // The tide of October 2056, 6.5 m: as many buildings as it would reach now, and Go there at the first of them.
      const lost = reach(18);
      assert.equal(said[0].text, `High tide in three months, up to 6.5 m. It would reach ${lost.length} buildings.`);
      assert.equal(said[0].x, lost[0].x + 1);
    } else scenarioMonth(s, sim);
  }
  // April is month 3 of a year, October month 9.
  assert.deepEqual(tides, new Array(20).fill(0).map((_, n) => [n % 2 ? 9 : 3, 2 + n * 0.25]));
  assert.equal(tides.at(-1)![1], 6.75);
}));

await test('High Water’s sea front holds a bank of Level land once the road and the factory by the little bridge are gone, as the guide says, and not before', () => seeded(1, () => {
  const s = SCENARIOS.find((x) => x.id === 'tide')!;
  const w = buildScenario(s, 120, 100);
  const sim = new Sim(w);
  openScenario(sim);
  const last = () => sim.disasters.tideReach(tideLine(19)).tiles;
  let x0 = Infinity, x1 = -Infinity;
  for (const b of w.buildings.values()) if (isZone(b.kind)) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + 3); }
  // Level land as the city has it (it leaves built tiles alone), pressed at 8 m and held over everything within two
  // tiles of the sea, along the city's width and twelve tiles past it each side.
  const bank = () => {
    for (let i = 0; i < w.n; i++) {
      const x = i % w.w, y = (i / w.w) | 0;
      if (x < x0 - 12 || x > x1 + 12 || w.water[i]) continue;
      let near = false;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (w.inBounds(x + dx, y + dy) && w.water[(y + dy) * w.w + x + dx]) near = true;
      if (near) applyBrush(w, 'level', x + 0.5, y + 0.5, { radius: 4, strength: 0.8, dt: 1, target: 8, protectBuilt: true });
    }
  };
  bank();
  // The ground under roads and buildings stays as it was, so the sea still gets in where it touches them.
  const lost = sim.disasters.inReach(last());
  assert.ok(lost.length >= 10, `${lost.length} buildings in the last tide's way`);
  const wet = (i: number) => [i - 1, i + 1, i - w.w, i + w.w].some((j) => w.water[j]);
  const gaps = last().filter((i) => (w.occ[i] || w.net[i]) && wet(i));
  const built = [...new Set(gaps.filter((i) => w.occ[i]).map((i) => w.buildings.get(w.occ[i])!))];
  assert.deepEqual(built.map((b) => b.kind), ['ind'], 'one factory stands at the water');
  assert.equal(lost[0], built[0], 'and the forecast’s Go there goes to it');
  assert.ok(gaps.every((i) => w.occ[i] || w.net[i] & ROAD), 'the rest is road');
  assert.ok(gaps.some((i) => [i - 1, i + 1].some((j) => w.water[j] && w.net[j] & ROAD)), 'beside a little bridge');
  // Bulldoze them, level again, and the bank keeps every tide out.
  for (const b of built) w.remove(b.id);
  for (const i of gaps) if (w.net[i]) w.clearNet(i % w.w, (i / w.w) | 0);
  bank();
  assert.equal(sim.disasters.inReach(last()).length, 0);
}));

await test('Crime Wave opens with no police and crime its people’s top worry, and a few police stations bring it under the line', () => seeded(3, () => {
  const s = SCENARIOS.find((x) => x.id === 'crime')!;
  const w = buildScenario(s, 120, 100);
  const sim = new Sim(w);
  openScenario(sim);
  sim.evaluate(false);
  const index = () => Math.round(sim.stats.avgCrime / 2.55);
  assert.equal([...w.buildings.values()].filter((b) => b.kind === 'police').length, 0);
  assert.equal(sim.stats.unpowered, 0);
  assert.ok(index() >= 15, `crime index ${index()} at the opening`);
  assert.equal(sim.stats.problems[0].id, 'crime');
  assert.equal(s.advise!(sim), `Crime index ${index()}: the goal is under 5. A police station cuts crime within about 18 tiles, and higher land value cuts it too.`);
  // Four stations in place of homes, one in the middle and three around it, as the guide's tip has it.
  let cx = 0, cy = 0, n = 0;
  for (const b of w.buildings.values()) if (b.kind === 'res' || b.kind === 'com' || b.kind === 'ind') { cx += b.x; cy += b.y; n++; }
  cx /= n;
  cy /= n;
  for (const [dx, dy] of [[0, 0], [15, 0], [-8, 13], [-8, -13]]) {
    let pick: { id: number; x: number; y: number; d: number } | undefined;
    for (const b of w.buildings.values()) {
      const d = Math.hypot(b.x - cx - dx, b.y - cy - dy);
      if (b.kind === 'res' && (!pick || d < pick.d)) pick = { id: b.id, x: b.x, y: b.y, d };
    }
    w.remove(pick!.id);
    w.place('police', pick!.x, pick!.y);
  }
  sim.computePower();
  sim.computeMaps();
  sim.computeMaps();
  assert.ok(index() < 5, `crime index ${index()} with four police stations`);
  assert.equal(s.advise!(sim), null);
}));

await test('Fallout opens with its downtown reactor melted down: one line says so, the ground is radioactive up to 12 tiles out, and the city is dark', () => seeded(2, () => {
  const s = SCENARIOS.find((x) => x.id === 'melt')!;
  const w = buildScenario(s, 120, 100);
  const sim = new Sim(w);
  openScenario(sim);
  const plant = [...w.buildings.values()].find((b) => b.kind === 'nuclear')!;
  const cx = plant.x + 2, cy = plant.y + 2;
  let mx = 0, my = 0, n = 0;
  for (const b of w.buildings.values()) if (b.kind === 'res' || b.kind === 'com' || b.kind === 'ind') { mx += b.x + 1; my += b.y + 1; n++; }
  assert.ok(Math.hypot(cx - mx / n, cy - my / n) < 8, 'the reactor stands downtown');
  const said: { text: string; kind: string; x?: number; y?: number }[] = [];
  sim.on((e) => {
    if (e.type === 'message') said.push(e.message);
  });
  s.start!(sim);
  assert.deepEqual(said.map((m) => [m.text, m.kind, m.x, m.y]), [['The downtown reactor has melted down. The ground round it is radioactive for years, and every zone is dark until another plant is built.', 'alert', cx, cy]]);
  assert.equal([...w.buildings.values()].filter((b) => b.kind === 'nuclear').length, 0);
  const far: number[] = [];
  for (let i = 0; i < w.n; i++) if (w.rad[i]) far.push(Math.hypot((i % w.w) - cx, ((i / w.w) | 0) - cy));
  assert.ok(far.length >= 100 && Math.max(...far) < 12, `${far.length} radioactive tiles, the farthest ${Math.max(...far).toFixed(1)} tiles out`);
  assert.ok(far.filter((d) => d >= 7).length >= 20, 'it reaches past the 7 tiles of an ordinary meltdown');
  sim.computePower();
  assert.equal(sim.stats.powerSupply, 0);
  // The advisor waits for the power before it talks about the radioactive ground.
  assert.equal(s.advise!(sim), null);
  // Any other meltdown keeps to 7 tiles.
  const town = flat(40, 30);
  town.place('nuclear', 18, 13);
  new Sim(town).disasters.trigger('meltdown');
  for (let i = 0; i < town.n; i++) if (town.rad[i]) assert.ok(Math.hypot((i % 40) - 20, ((i / 40) | 0) - 15) < 7);
  assert.ok(town.rad.some((r) => r > 0));
}));

await test("Aftershock's opening quakes strike under zones, and neither they nor its fires touch the power plants", () => {
  const random = Math.random;
  const aftershock = SCENARIOS.find((x) => x.id === 'aftershock')!;
  const plants = (w: World) => [...w.buildings.values()].filter((b) => BUILDINGS[b.kind].capacity);
  try {
    // On seed 2 a quake brought the nuclear plant down, and it melted down before the intro opened; on seeds 18 and
    // 30 an opening fire was lit on it, and on 21 on the coal plant, and each burnt down within weeks.
    for (const seed of [1, 2, 3, 18, 21, 30]) {
      Math.random = makeRng(seed);
      const w = buildScenario(aftershock, 120, 100);
      const sim = new Sim(w);
      openScenario(sim);
      const before = plants(w).map((b) => b.kind).sort();
      const zoneAt = new Set<number>();
      for (const b of w.buildings.values()) if (b.kind === 'res' || b.kind === 'com' || b.kind === 'ind') zoneAt.add((b.y + 1) * w.w + b.x + 1);
      const quakes: number[] = [];
      const said: string[] = [];
      sim.on((e) => {
        if (e.type === 'disaster' && e.kind === 'earthquake') quakes.push(Math.round(e.y) * w.w + Math.round(e.x));
        if (e.type === 'disaster' && e.kind === 'meltdown') said.push('meltdown');
        if (e.type === 'message') said.push(e.message.text);
      });
      aftershock.start!(sim);
      assert.equal(quakes.length, 3);
      assert.ok(quakes.every((i) => zoneAt.has(i)), `seed ${seed}: a quake struck away from the zones`);
      assert.deepEqual(plants(w).map((b) => b.kind).sort(), before, `seed ${seed}: the opening wrecked a power plant`);
      assert.ok(plants(w).every((b) => !w.fire[b.y * w.w + b.x]), `seed ${seed}: the opening set a power plant alight`);
      assert.ok(!said.some((t) => /meltdown/i.test(t)), `seed ${seed}: a meltdown at the opening`);
    }
  } finally {
    Math.random = random;
  }
  // A quake set off from the Disasters menu, or at random, can still bring a plant down.
  const w = flat(40, 30);
  w.place('coal', 18, 13);
  const sim = new Sim(w);
  seeded(1, () => {
    for (let k = 0; k < 12 && w.buildings.size; k++) sim.disasters.trigger('earthquake');
  });
  assert.equal(w.buildings.size, 0, 'a plain quake never touched the coal plant');
});

await test("Aftershock opens with one line for its quakes and fires, and they fall just as when each said its own", () => {
  const aftershock = SCENARIOS.find((x) => x.id === 'aftershock')!;
  const map = (w: World) => JSON.stringify([[...w.buildings.values()].map((b) => [b.id, b.kind, b.x, b.y, b.level]), [...w.fire], [...w.rubble], [...w.net]]);
  for (const seed of [1, 2, 3]) {
    const open = (loud: boolean) => seeded(seed, () => {
      const w = buildScenario(aftershock, 120, 100);
      const sim = new Sim(w);
      openScenario(sim);
      const from = sim.messages.length;
      if (!loud) aftershock.start!(sim);
      else {
        // The opening as it was, each quake and fire saying its own piece.
        for (let k = 0; k < 3; k++) sim.disasters.trigger('earthquake', { sparePlants: true });
        for (let k = 0; k < 4; k++) sim.disasters.trigger('fire', { sparePlants: true });
      }
      return { w, sim, news: sim.messages.slice(from) };
    });
    const quiet = open(false);
    const loud = open(true);
    assert.equal(map(quiet.w), map(loud.w), `seed ${seed}: the quiet opening changed what the quakes and fires did`);
    assert.equal(loud.news.filter((m) => m.text.startsWith('Earthquake!')).length, 3);
    assert.deepEqual(quiet.news.map((m) => [m.text, m.kind]), [['A major earthquake and two aftershocks have struck. Check for fires and broken roads.', 'alert']]);
    assert.ok(quiet.news[0].x !== undefined, 'with Go there, to the first quake');
    assert.ok([...quiet.w.fire].some((f) => f > 0), `seed ${seed}: nothing is burning`);
    // The opening's fires are one fire for the news, however far apart they started, and end with one line.
    quiet.w.city.disasters = false;
    const said = quiet.sim.messages.length;
    seeded(seed, () => {
      for (let k = 0; k < 40 && [...quiet.w.fire].some((f) => f > 0); k++) quiet.sim.step();
    });
    assert.ok(![...quiet.w.fire].some((f) => f > 0), `seed ${seed}: still burning after 40 weeks`);
    const fires = quiet.sim.messages.slice(said).filter((m) => /^(Fire at|The fires? (is|are) out)/.test(m.text)).map((m) => m.text);
    assert.equal(fires.length, 1, `seed ${seed}: ${JSON.stringify(fires)}`);
    assert.match(fires[0], /^The fires are out\.( They burned down (a building|\d+ buildings)\.)?$/);
  }
});

await test("Aftershock's opening line names a landmark the quakes brought down, and leaves lost stations unnamed", () => {
  const aftershock = SCENARIOS.find((x) => x.id === 'aftershock')!;
  const opening = (seed: number) => seeded(seed, () => {
    const w = buildScenario(aftershock, 120, 100);
    const sim = new Sim(w);
    openScenario(sim);
    const had = new Map([...w.buildings.values()].map((b) => [b.id, b.kind]));
    const from = sim.messages.length;
    aftershock.start!(sim);
    const lost = [...had].filter(([id]) => !w.buildings.has(id)).map(([, kind]) => kind).sort();
    return { lost: lost.filter((k) => !['res', 'com', 'ind'].includes(k)), line: sim.messages.slice(from).map((m) => m.text) };
  });
  // The airport fell, and the only sign was the advisor a month later, on commerce stopped at 5,000 jobs.
  assert.deepEqual(opening(43), { lost: ['airport'], line: ['A major earthquake and two aftershocks have struck. They brought down the airport. Check for fires and broken roads.'] });
  // A fire station came down with the stadium: only the stadium is named.
  assert.deepEqual(opening(31), { lost: ['fire', 'stadium'], line: ['A major earthquake and two aftershocks have struck. They brought down the stadium. Check for fires and broken roads.'] });
  // Police stations alone: the line is as it was.
  assert.deepEqual(opening(11), { lost: ['police'], line: ['A major earthquake and two aftershocks have struck. Check for fires and broken roads.'] });
});

await test('a fire is news once: spreading next door says nothing, and a fire across town says its own', () => seeded(9, () => {
  const w = flat(60, 40);
  const a = w.place('res', 5, 5), b = w.place('res', 8, 5), far = w.place('res', 40, 30);
  for (const lot of [a, b, far]) w.setLevel(lot, 2);
  const sim = new Sim(w);
  const alerts = () => sim.messages.filter((m) => m.text.startsWith('Fire at')).map((m) => [m.x, m.y]);
  sim.disasters.ignite(a.x, a.y);
  sim.step();
  sim.disasters.ignite(b.x, b.y);
  assert.ok(w.fire[b.y * w.w + b.x] > 0, 'the lot next door is alight');
  assert.deepEqual(alerts(), [[6, 6]], 'one alert for the fire and the lot next door');
  sim.disasters.ignite(far.x, far.y);
  assert.deepEqual(alerts(), [[6, 6], [41, 31]], 'a fire 30 tiles away the same month is news too');
  for (let k = 0; k < 3; k++) sim.step();
  assert.equal(alerts().length, 2, 'spreading is no news');
  assert.equal(sim.saveRun().cooldown.filter(([k]) => k.startsWith('fire')).length, 0, 'nothing kept per fire in the save');
  // Nor once the city is opened again: the fires burning then are the ones the news has told of.
  const back = new Sim(World.deserialize(JSON.parse(JSON.stringify(w.serialize(sim.saveRun())))));
  const told = back.messages.length;
  const next = back.world.place('res', 41, 27);
  back.world.setLevel(next, 2);
  back.disasters.ignite(next.x, next.y);
  for (let k = 0; k < 2; k++) back.step();
  assert.ok(back.world.fire[27 * w.w + 41] > 0 || !back.world.buildings.has(next.id), 'the lot next door caught');
  assert.deepEqual(back.messages.slice(told).filter((m) => m.text.startsWith('Fire at')), []);
}));

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

await test('each challenge lists its conditions as rows, ticked when met, without changing how it is judged', () => {
  const sim = new Sim(flat());
  const goal = (id: string) => SCENARIOS.find((s) => s.id === id)!.check(sim);
  const rows = (id: string) => goal(id).rows.map((r) => [goalRowText(r), r.met]);
  Object.assign(sim.stats, { avgTraffic: 25 * 2.55, avgPollution: 13 * 2.55, residents: 17544, comJobs: 9000, indJobs: 5960, approval: 58, score: 512 });
  assert.deepEqual(rows('boomtown'), [['Residents 17,544 / 12,000', true]]);
  assert.deepEqual(rows('gridlock'), [['Traffic index 25 · under 28', true], ['Residents 17,544 / 20,000', false], ['Jobs 14,960 / 10,000', true]]);
  assert.deepEqual(rows('smog'), [['Pollution index 13 · under 12', false], ['Residents 17,544 / 20,000', false], ['Jobs 14,960 / 9,000', true]]);
  assert.deepEqual(rows('aftershock'), [['Residents 17,544 / 45,000', false]]);
  assert.deepEqual(rows('monster'), [['Approval 58% · over 60%', false], ['Residents 17,544 / 18,000', false]]);
  assert.deepEqual(rows('tide'), [['Residents 17,544 / 20,000', false], ['City score 512 · over 500', true]]);
  assert.deepEqual(rows('crime'), [['Crime index 0 · under 5', true], ['Residents 17,544 / 22,000', false]]);
  assert.deepEqual(rows('melt'), [['Residents 17,544 / 34,000', false], ['City score 512 · over 500', true]]);
  // The goal is met when every row is, and the bar and the one-line status are as they were.
  assert.deepEqual([goal('gridlock').met, goal('gridlock').progress], [false, 0.5]);
  assert.equal(goal('gridlock').status, 'Traffic 25 (goal under 28) · 17,544 of 20,000 residents · 14,960 of 10,000 jobs');
  for (const stats of [{ residents: 60000, approval: 70, avgPollution: 5 }, { residents: 21000, approval: 61, avgTraffic: 70, score: 480, avgCrime: 12 * 2.55 }, { residents: 30000, comJobs: 0, indJobs: 0 }]) {
    Object.assign(sim.stats, stats);
    for (const s of SCENARIOS) assert.equal(s.check(sim).met, s.check(sim).rows.every((r) => r.met), `${s.name}: met and its rows disagree`);
  }
});

await test('a goal judged at the deadline says when; Smog Valley counts only the month-ends of its last 12, and the count is saved', () => {
  const w = flat();
  const sim = new Sim(w);
  const judged = (id: string) => {
    const s = SCENARIOS.find((x) => x.id === id)!;
    w.city.scenario = buildScenario(s, 40, 30).city.scenario;
    return goalState(s, sim).note;
  };
  assert.equal(judged('gridlock'), 'Judged at the end of 1960');
  assert.equal(judged('monster'), 'Judged at the end of 1966');
  assert.equal(judged('smog'), 'Judged at the end of 1975');
  assert.equal(judged('tide'), 'Judged at the end of 2056');
  assert.equal(judged('crime'), 'Judged at the end of 1981');
  assert.equal(judged('melt'), 'Judged at the end of 2014');
  assert.equal(judged('boomtown'), undefined, 'Boomtown is won the month it gets there');
  assert.equal(judged('aftershock'), undefined);
  const end = (1968 - 1900 + 8) * 12;
  w.city.scenario = { id: 'smog', end, done: '' };
  const smog = SCENARIOS.find((x) => x.id === 'smog')!;
  const air = (index: number) => Object.assign(sim.stats, { avgPollution: index * 2.55, residents: 21000, comJobs: 5000, indJobs: 4500 });
  const held = () => goalRowText(goalState(smog, sim).rows.at(-1)!);
  air(10);
  // Met from 1972 on: the run is counted, but the bar stays half full and unmet until the final year begins.
  for (let m = (1972 - 1900) * 12; m <= end - 12; m++) {
    w.city.month = m;
    const st = scenarioMonth(smog, sim);
    assert.deepEqual([st.met, st.progress], [false, 0.5], `the goal reads as met in month ${m}`);
  }
  assert.equal(held(), 'Held 37 months in a row · must hold through 1975');
  assert.equal(goalState(smog, sim).note, 'Judged at the end of 1975');
  // Through 1975 it fills, and only the deadline's month-end meets it.
  for (let m = end - 11; m < end; m++) {
    w.city.month = m;
    const st = scenarioMonth(smog, sim);
    assert.equal(st.met, false);
    assert.equal(st.progress, 0.5 + (0.5 * (m - end + 12)) / 12);
  }
  w.city.month = end;
  const st = scenarioMonth(smog, sim);
  assert.deepEqual([st.met, st.progress], [true, 1]);
  assert.match(st.status, /^Pollution 10 \(goal under 12\) · 21,000 of 20,000 residents · 9,500 of 9,000 jobs · held 12 of 12 months$/);
  assert.deepEqual(st.rows.map((r) => r.met), [true, true, true, true]);
  const back = World.deserialize(JSON.parse(JSON.stringify(w.serialize())));
  assert.deepEqual(back.city.scenario, { id: 'smog', end, done: '', held: 49 });
  air(12); // one month over the line starts the count again
  assert.equal(scenarioMonth(smog, sim).met, false);
  assert.equal(w.city.scenario.held, 0);
  assert.equal(held(), 'Held 0 months in a row · must hold through 1975');
  w.city.month = end + 1;
  air(10);
  scenarioMonth(smog, sim);
  assert.equal(held(), 'Held 1 month in a row · must hold through 1975');
});

await test("the advisor names a challenge's own problem every six months while it lasts, and warns once a year and three months out", () => {
  const w = flat();
  const stats: Partial<Sim['stats']> = { avgTraffic: 31 * 2.55, residents: 21000, comJobs: 6000, indJobs: 5000, avgPollution: 13 * 2.55, approval: 70 };
  /** The news from `from` months before a challenge's deadline to `to` months before it, on a city with `stats`. */
  const play = (id: string, from: number, to: number, each: (sim: Sim, left: number) => void = () => {}) => {
    const s = SCENARIOS.find((x) => x.id === id)!;
    w.city.scenario = buildScenario(s, 40, 30).city.scenario;
    const end = w.city.scenario!.end;
    const sim = new Sim(w);
    const said: string[] = [];
    sim.on((e) => {
      if (e.type === 'message') said.push(e.message.text);
    });
    for (let m = end - from; m < end - to; m++) {
      w.city.month = m;
      Object.assign(sim.stats, stats);
      each(sim, end - m);
      scenarioNews(s, sim, scenarioMonth(s, sim));
    }
    return said;
  };
  // Gridlock over the traffic line from two years out: the advice comes every six months, and the deadline twice.
  const traffic = 'Traffic index 31: the council wants it under 28. Rail into downtown takes commuters off the streets.';
  assert.deepEqual(play('gridlock', 24, 0), [
    traffic, traffic,
    'One year left: the goal is judged at the end of 1960. Not met yet: Traffic index 31 · under 28.',
    traffic, traffic,
    'Three months left. Not met yet: Traffic index 31 · under 28.',
  ]);
  // Under the line it says nothing of traffic.
  stats.avgTraffic = 25 * 2.55;
  assert.deepEqual(play('gridlock', 13, 2), ['One year left: the goal is judged at the end of 1960. The goal is met for now.', 'Three months left. The goal is met for now.']);
  assert.deepEqual(play('smog', 14, 10), ['Pollution index 13 where people live: the goal is under 12.', 'One year left: the goal must hold from now to the end.']);
  stats.residents = 9000;
  assert.deepEqual(play('boomtown', 13, 2), ['One year left. Not met yet: Residents 9,000 / 12,000.', 'Three months left. Not met yet: Residents 9,000 / 12,000.']);
  assert.deepEqual(play('aftershock', 13, 11), ['One year left. Not met yet: Residents 9,000 / 45,000.']);
  // Monster Bay's advice comes with the monster (here between its visits every two years, set loose by hand).
  const rampage = play('monster', 30, 20, (sim, left) => {
    if (left === 26) sim.disasters.roamers.push({ kind: 'monster', x: 5, y: 5, px: 5, py: 5, vx: 0, vy: 0, weeks: 30, heading: 0 });
  });
  // Then, with the index still at 13, the news six months before it next surfaces.
  assert.deepEqual(rampage, ['The monster heads for the smokiest spot in town.', 'The monster surfaces in six months. Pollution index 13: at 9 or more, it comes ashore.']);
  // Once the challenge is decided, the advisor lets it be.
  const quiet = play('gridlock', 13, 2, () => {
    w.city.scenario!.done = 'won';
  });
  assert.deepEqual(quiet, []);
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
    lastSpeed: 2, toasts, saveSeq: 0, keptSeq: new Map(), pushedSeq: new Map(),
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

await test('a year in debt in a row brings the broke card once a spell, counted across a save, with the costs, the tax that covers them and the loan room', async () => {
  const g = seeded(3, () => town());
  const sim: Sim = g.sim;
  const city = g.world.city;
  let broke = 0;
  sim.on((e) => { if (e.type === 'broke') broke++; });
  const months = (n: number) => seeded(4, () => weeks(g, 4 * n));
  city.funds = -5000;
  months(6);
  assert.equal(city.debtMonths, 6);
  // Out of debt for a month: the count starts again.
  city.funds = 50000;
  months(1);
  assert.equal(city.debtMonths, 0);
  city.funds = -5000;
  city.loan = 20000;
  months(11);
  assert.equal(broke, 0);
  // Kept with the city: a save opened again carries on counting.
  const back = await reopen(sim);
  assert.equal(back.world.city.debtMonths, 11);
  months(1);
  assert.equal(broke, 1, 'at twelve months');
  months(13);
  assert.equal(broke, 1, 'once for each spell in debt');
  const r = sim.brokeReport();
  assert.equal(r.owed, -city.funds);
  assert.equal(r.months, 25);
  assert.equal(r.loanRoom, 10000);
  // The three biggest costs, biggest first, as the Budget names them.
  const b = sim.stats.lastBudget;
  const lines = [['Roads and rail', b.transport], ['Police', b.police], ['Fire', b.fire], ['Schools, hospitals, parks', b.services], ['Stadium, seaport, airport', b.landmarks], ['Power plants', b.power], ['Loan interest', b.interest]] as [string, number][];
  assert.deepEqual(r.costs.map((c) => c.label), lines.filter((l) => l[1] >= 0.5).sort((a, c) => c[1] - a[1]).slice(0, 3).map((l) => l[0]));
  // The tax rate that covers them is the lowest that brings in what the city spends.
  assert.ok(r.covers !== null && sim.projectTax(r.covers) >= r.spend && sim.projectTax(r.covers - 1) < r.spend, `${r.covers}%`);
});

await test("the year's paper leads with its biggest news, lists the rest, and says how the city stands", async () => {
  const w = flat(60, 40);
  const sim = new Sim(w);
  w.city.name = 'Mapleford';
  w.city.month = 49 * 12; // the end of 1948, its paper made at the start of 1949
  const year = (set: (n: NonNullable<typeof w.city.year>) => void = () => {}) => {
    w.city.year = sim.newYear();
    set(w.city.year);
    return sim.paper('1948 closes with a surplus of $3,535. Taxes brought in $13,907.');
  };
  const quiet = year();
  assert.deepEqual([quiet.year, quiet.headline, quiet.also, quiet.change, quiet.broke], [1948, 'A quiet year in Mapleford', '', 0, null]);
  // What struck is remembered as it happens.
  sim.emit({ type: 'disaster', kind: 'fire', x: 1, y: 1 });
  assert.deepEqual(w.city.year!.disasters, ['fire']);
  const struck = year((n) => n.disasters.push('fire', 'flood', 'fire', 'earthquake'));
  assert.equal(struck.headline, 'Earthquake shakes Mapleford');
  assert.equal(struck.also, 'Also this year: a flood and two fires.');
  // A new size class, a landmark opened and another upgraded, brownouts and debt.
  const stadium = w.place('stadium', 40, 30);
  const port = w.place('airport', 10, 30);
  year((n) => {
    n.cls = 0;
    n.brownouts = 3;
    n.landmarks = [[port.id, 1]];
  });
  w.city.classReached = 1;
  w.setLevel(port, 2);
  w.city.funds = -900;
  const busy2 = sim.paper('');
  assert.equal(busy2.headline, 'Mapleford is now a town');
  assert.equal(busy2.also, 'Also this year: a new stadium, a jet terminal and brownouts.');
  // A year and more in debt is the biggest news there is, with the broke card's ways out.
  w.city.debtMonths = 14;
  const broke = sim.paper('');
  assert.equal(broke.headline, 'City hall is broke');
  assert.equal(broke.broke?.months, 14);
  assert.match(broke.also, /^Also this year: becoming a town, a new stadium and a jet terminal\.$/);
  w.city.debtMonths = 3;
  w.city.classReached = 0;
  w.remove(stadium.id);
  w.setLevel(port, 1);
  const red = year((n) => (n.landmarks = [[port.id, 1]]));
  assert.equal(red.headline, 'Mapleford ends 1948 in debt');
  w.city.funds = 1000;
  // Record growth: more new residents than any earlier year the history holds.
  const h = w.city.history.res;
  h.length = 0;
  for (let m = 0; m < 37; m++) h.push(m < 13 ? m * 50 : m < 25 ? 600 + (m - 12) * 20 : 840 + (m - 24) * 10);
  const grew = year((n) => (n.pop = sim.stats.residents - 900));
  assert.equal(grew.headline, 'Record year: 900 new residents');
  assert.equal(grew.change, 900);
});

await test("a fire that spreads through a block is one fire in the year's paper, and doesn't crowd out the year's quake", () => {
  const w = flat(60, 40);
  w.city.name = 'Mapleford';
  for (let y = 2; y < 30; y += 3) for (let x = 2; x < 50; x += 3) w.setLevel(w.place('res', x, y), 3);
  const sim = new Sim(w);
  w.city.year = sim.newYear();
  w.city.year.disasters.push('earthquake');
  let caught = 0;
  sim.on((e) => { if (e.type === 'destroyed') caught++; });
  seeded(7, () => {
    sim.disasters.ignite(20, 14);
    for (let k = 0; k < 40; k++) sim.disasters.week();
  });
  assert.ok(caught > 30, `the fire spread: ${caught} homes burned down`);
  assert.equal(sim.messages.filter((m) => m.text.startsWith('Fire at')).length, 1, 'the news told one fire');
  assert.deepEqual(w.city.year.disasters, ['earthquake', 'fire']);
  w.city.month = 12;
  const p = sim.paper('');
  assert.deepEqual([p.headline, p.also], ['Earthquake shakes Mapleford', 'Also this year: a fire.']);
});

await test("the year's news is kept with a save, starts again each year, and the paper comes at the year's end", async () => {
  const g = seeded(3, () => town());
  const sim: Sim = g.sim;
  const city = g.world.city;
  const papers: any[] = [];
  g.ui.paper = (p: any) => papers.push(p);
  g.settings.paper = true;
  while (city.month % 12 !== 6) seeded(5, () => weeks(g, 4));
  sim.emit({ type: 'disaster', kind: 'tornado', x: 1, y: 1 });
  city.year!.brownouts = 2;
  const back = await reopen(sim);
  assert.deepEqual([back.world.city.year!.disasters, back.world.city.year!.brownouts], [['tornado'], 2]);
  while (city.month % 12 !== 0) seeded(5, () => weeks(g, 4));
  assert.equal(papers.length, 1);
  assert.equal(papers[0].headline, `Tornado tears through ${city.name}`);
  assert.equal(papers[0].also, 'Also this year: brownouts.');
  assert.match(papers[0].closing, /^\d{4} closes with a (surplus|deficit) of \$[\d,]+\. Taxes brought in \$[\d,]+\.$/);
  assert.deepEqual([city.year!.disasters, city.year!.brownouts, city.year!.pop], [[], 0, sim.stats.residents]);
  // On Ultra a year passes in seconds: the paper waits for the clock to stop, the latest replacing the one before.
  g.speed = 4;
  seeded(5, () => weeks(g, 4 * 24));
  assert.equal(papers.length, 1);
  g.setSpeed(0);
  assert.equal(papers.length, 2);
  assert.equal(papers[1].year, 1900 + city.month / 12 - 1);
  // Turned off in Settings: no paper.
  g.settings.paper = false;
  g.setSpeed(2);
  seeded(5, () => weeks(g, 4 * 12));
  assert.equal(papers.length, 2);
});

await test("reaching Town gives the city a Mayor's house: free, placed once at a time, raising land value round it", async () => {
  const w = flat(60, 40);
  const g = headless(w);
  const sim: Sim = g.sim;
  const gifts: string[] = [];
  g.ui.gift = (k: string) => gifts.push(k);
  w.city.funds = 5000;
  assert.equal(w.canPlace('mayor', 30, 20).reason, 'Mayor’s house is a gift for reaching a size class');
  // Two blocks of towers: past 2,000 residents at the month's end.
  for (const x of [10, 14]) w.setLevel(w.place('res', x, 10), 8);
  seeded(2, () => weeks(g, 4));
  assert.equal(w.city.classReached, 1);
  assert.deepEqual([w.city.gifts, gifts], [['mayor'], ['mayor']]);
  assert.equal(g.giftReady('mayor'), true);
  // Kept with the city.
  assert.deepEqual((await reopen(sim)).world.city.gifts, ['mayor']);
  const before = w.landValue[21 * w.w + 31];
  const funds = w.city.funds;
  drag(g, 'mayor', 30, 20);
  const house = [...w.buildings.values()].find((b) => b.kind === 'mayor')!;
  assert.ok(house, 'placed');
  assert.equal(w.city.funds, funds, 'free');
  assert.equal(g.giftReady('mayor'), false);
  assert.equal(w.canPlace('mayor', 40, 30).reason, 'The city has its mayor’s house already');
  sim.computeMaps();
  assert.ok(w.landValue[21 * w.w + 31] - before >= 25, `land value at its door ${before} → ${w.landValue[21 * w.w + 31]}`);
  assert.ok(Math.abs(w.landValue[21 * w.w + 50] - w.landValue[21 * w.w + 52]) < 3, 'nothing far off');
  // Undone, it can be placed again; it is one at a time, not one ever.
  g.undo();
  assert.equal([...w.buildings.values()].some((b) => b.kind === 'mayor'), false);
  assert.equal(g.giftReady('mayor'), true);
  // A challenge city opens at its size class with no gift: it hasn't reached it here.
  const sc = headless(buildScenario(SCENARIOS.find((x) => x.id === 'gridlock')!));
  assert.deepEqual(sc.world.city.gifts, []);
});

await test('each size class past Town brings its own gift: a City hall that cuts crime and needs power, and three that raise land value without it', async () => {
  const w = flat(90, 60);
  const g = headless(w);
  const sim: Sim = g.sim;
  const cards: string[] = [];
  g.ui.gift = (k: string) => cards.push(k);
  w.city.funds = 5000;
  w.city.classReached = 1;
  w.city.gifts = ['mayor'];
  // Blocks of towers along the bottom of the map, 2,200 residents each, counted as at a month's end.
  let towers = 0;
  const reach = (n: number) => {
    for (; towers < n; towers++) w.setLevel(w.place('res', (towers % 29) * 3, 33 + Math.floor(towers / 29) * 3), 8);
    sim.tally();
    (sim as any).advise();
  };
  reach(5);
  assert.deepEqual([sim.stats.cityClass, w.city.gifts, cards], ['City', ['mayor', 'cityhall'], ['cityhall']]);
  reach(23);
  reach(46);
  reach(114);
  assert.equal(sim.stats.cityClass, 'Megalopolis');
  assert.deepEqual(w.city.gifts, ['mayor', 'cityhall', 'plaza', 'expo', 'monument']);
  assert.deepEqual(cards, ['cityhall', 'plaza', 'expo', 'monument'], 'a card for each');
  assert.deepEqual((await reopen(sim)).world.city.gifts, w.city.gifts, 'kept with the city');
  for (const k of ['cityhall', 'plaza', 'expo', 'monument']) assert.equal(g.giftReady(k), true, `${k} ready to place`);
  const at = (x: number, y: number) => y * w.w + x;
  const maps = () => {
    sim.computePower();
    sim.computeMaps();
    sim.computeMaps();
  };
  const row = (b: { x: number; y: number }, k: string) => sim.describe(b.x, b.y).rows.find((r) => r[0] === k)?.[1];
  const placed = (k: string) => [...w.buildings.values()].find((b) => b.kind === k)!;
  // The exhibition hall: the same lift on every tile of the city, near or far, and no power.
  maps();
  const spots = [at(5, 5), at(80, 25), at(45, 12)];
  const before = spots.map((i) => w.landValue[i]);
  drag(g, 'expo', 45, 20);
  maps();
  assert.deepEqual(spots.map((i, k) => w.landValue[i] - before[k]), [EXPO_LV, EXPO_LV, EXPO_LV]);
  assert.equal(sim.describe(45, 20).does, 'Raises land value across the whole city');
  assert.equal(row(placed('expo'), 'Land value it adds'), `+$${EXPO_LV * 40}/acre across the city`);
  assert.deepEqual([placed('expo').powered, row(placed('expo'), 'Power')], [false, 'Not needed']);
  // The plaza and the monument: a lift round them, the monument's reaching further, and no power.
  for (const [k, x, y, far] of [['plaza', 12, 8, 14], ['monument', 70, 8, 20]] as [string, number, number, number][]) {
    maps();
    const near = w.landValue[at(x + 2, y)];
    const edge = w.landValue[at(x + far - 3, y)];
    const beyond = w.landValue[at(x + far + 4, y)];
    drag(g, k, x, y);
    maps();
    const b = placed(k);
    assert.ok(w.landValue[at(x + 2, y)] - near >= 30, `${k} beside it: ${near} → ${w.landValue[at(x + 2, y)]}`);
    assert.ok(w.landValue[at(x + far - 3, y)] > edge, `${k} near the edge of its reach`);
    assert.equal(w.landValue[at(x + far + 4, y)], beyond, `${k}: nothing beyond its reach`);
    assert.deepEqual([b.powered, row(b, 'Power'), g.giftReady(k)], [false, 'Not needed', false]);
  }
  // The City hall cuts crime round it like a small police station, whatever the police budget, and needs power: a
  // third of its strength without it.
  maps();
  const mid = at(31, 21);
  assert.equal(w.policeCov[mid], 0);
  drag(g, 'cityhall', 31, 21);
  const hall = placed('cityhall');
  maps();
  assert.equal(row(hall, 'Power'), 'None: no plant connected');
  const dark = w.policeCov[mid];
  w.place('coal', hall.x + 3, hall.y);
  maps();
  assert.equal(row(hall, 'Power'), 'Connected');
  assert.ok(w.policeCov[mid] >= HALL_CRIME * 0.95 && Math.abs(dark - w.policeCov[mid] * 0.35) < 3, `unpowered ${dark}, powered ${w.policeCov[mid]}`);
  assert.ok(w.policeCov[at(31 + HALL_REACH - 3, 21)] > 0 && w.policeCov[at(31 + HALL_REACH + 2, 21)] === 0, 'about 12 tiles');
  w.city.funding.police = 0.5;
  maps();
  assert.ok(w.policeCov[mid] >= HALL_CRIME * 0.95, 'the police budget does not weaken it');
  assert.equal(sim.describe(hall.x, hall.y).does, `Cuts crime within about ${HALL_REACH} tiles`);
  // One of each at a time.
  assert.equal(w.canPlace('monument', 5, 20).reason, 'The city has its monument already');
});

await test("the Mayor's house needs no power, like a park: it takes none from the grid and passes none on", () => {
  const w = flat(60, 20);
  w.place('coal', 0, 0);
  const lot = w.place('res', 4, 0);
  const house = w.place('mayor', 7, 1);
  const beyond = w.place('res', 9, 0); // touches the house, not the lot
  const sim = new Sim(w);
  sim.computePower();
  assert.deepEqual([lot.powered, beyond.powered], [true, false], 'no power passes through it');
  assert.equal(sim.stats.powerDemand, 18, 'two lots draw power, the house none');
  assert.equal(sim.grids[0].demand, 9);
  const card = sim.describe(house.x, house.y);
  assert.equal(card.rows.find((r) => r[0] === 'Power')?.[1], 'Not needed');
  assert.equal(card.rows.find((r) => r[0] === 'Its grid'), undefined);
});

await test('on a device too slow for the speed, a frame runs one week of the clock and drops the rest', () => {
  const g = headless(flat());
  g.speed = 4; // Ultra: 14 weeks a second
  let steps = 0;
  g.sim.step = () => {
    steps++;
    const t = performance.now();
    while (performance.now() - t < 15); // a slow phone takes 54-99 ms
  };
  g.frame(0.3); // owes 4.2 weeks
  assert.equal(steps, 1);
  assert.ok(g.acc < 1, `still owes ${g.acc} weeks`);
  // Where weeks are quick, a frame catches up as before.
  g.sim.step = () => steps++;
  steps = 0;
  g.acc = 0;
  g.frame(0.3);
  assert.equal(steps, 4);
});

await test('with its only plant on fire, the city says so instead of asking for a power plant; with none and no money, it says how to pay for one', () => seeded(42, () => {
  const g = town();
  const w = g.world;
  const sim = g.sim;
  const plant = [...w.buildings.values()].find((b: any) => b.kind === 'coal');
  const home = [...w.buildings.values()].find((b: any) => b.kind === 'res' && b.level > 0);
  const from = sim.messages.length;
  sim.disasters.ignite(plant.x, plant.y);
  sim.computePower();
  const row = (b: any, k: string) => sim.describe(b.x + 1, b.y + 1).rows.find((r: string[]) => r[0] === k)?.[1];
  assert.equal(row(plant, 'Power'), 'None: on fire');
  assert.equal(row(home, 'Power'), 'None: its power plant is on fire');
  assert.match(row(home, 'Its grid'), /^Overloaded: needs \d+ MW, makes 0; a plant is on fire$/);
  weeks(g, 4);
  assert.ok(w.fire[plant.y * w.w + plant.x] > 0, 'still burning at the month end');
  const news = sim.messages.slice(from).map((m: any) => m.text);
  assert.equal(news.find((t: string) => /Build a power plant/.test(t)), undefined);
  assert.ok(news.includes('The coal plant is on fire, so nothing has power until it is out. A fire station within reach puts fires out sooner.'), news.join(' | '));
  // With no plant at all and $43 in the bank, the no-power line says how the city could pay for one.
  w.remove(plant.id);
  w.city.funds = 43;
  sim.computePower();
  weeks(g, 16);
  assert.match(sim.messages.filter((m: any) => m.text.startsWith('Zones are waiting')).at(-1).text, /Build a power plant and connect it\. The city has \$\d+: a loan from the Budget would pay for one\.$/);
  // Borrowed to the limit, it doesn't promise a loan.
  w.city.loan = 30000;
  w.city.funds = 43;
  weeks(g, 20);
  assert.equal(sim.messages.filter((m: any) => m.text.startsWith('Zones are waiting')).at(-1).text, 'Zones are waiting for electricity. Build a power plant and connect it.');
}));

await test("a town's only plant burning down is one alert that every zone is dark, and the fire's end says what it burned", () => seeded(42, () => {
  const g = town();
  const w = g.world;
  const sim = g.sim;
  const played: string[] = [];
  g.audio = { play: (s: string) => played.push(s) };
  const plant = [...w.buildings.values()].find((b: any) => b.kind === 'coal');
  const from = sim.messages.length;
  sim.disasters.ignite(plant.x, plant.y);
  let month = -1;
  for (let k = 0; k < 20 && w.buildings.has(plant.id); k++) {
    weeks(g, 1);
    if (!w.buildings.has(plant.id)) month = w.city.month;
  }
  assert.equal(w.buildings.has(plant.id), false, 'the plant never burned down');
  weeks(g, 4);
  const news = sim.messages.slice(from);
  const lost = news.filter((m: any) => /coal plant burned down/.test(m.text));
  assert.deepEqual(lost.map((m: any) => [m.text, m.kind, m.x, m.y]), [['The coal plant burned down. Every zone is dark until another plant is built.', 'alert', plant.x + 2, plant.y + 2]]);
  assert.equal(news.filter((m: any) => m.month === month && m.text.startsWith('Zones are waiting')).length, 0, 'the new-city line followed in the same month');
  assert.deepEqual(news.filter((m: any) => m.text.startsWith('The fire is out')).map((m: any) => [m.text, m.kind]), [['The fire is out. It burned down a building.', 'info']]);
  assert.equal(played.filter((s) => s === 'crumble').length, 1, 'one rumble as it came down');
}));

await test('a tornado or monster ends with one line on what it wrecked, and a lost station or landmark is news at its spot', () => {
  // Over open country it wrecks nothing, and says only that it is over.
  const empty = new Sim(flat());
  empty.disasters.roamers.push({ kind: 'tornado', x: 20, y: 15, px: 20, py: 15, vx: 0, vy: 0, weeks: 3, heading: 0 });
  for (let k = 0; k < 5; k++) empty.step();
  assert.deepEqual(empty.messages.filter((m) => /tornado/i.test(m.text)).map((m) => [m.text, m.kind]), [['The tornado has blown itself out.', 'info']]);
  // Through a town it counts the buildings it took: not the empty lots.
  const w = flat(60, 40);
  for (let y = 12; y < 28; y += 3) for (let x = 22; x < 38; x += 3) w.setLevel(w.place('res', x, y), y < 20 ? 2 : 0);
  const sim = new Sim(w);
  const monster = { kind: 'monster' as const, x: 30, y: 19, px: 30, py: 19, vx: 0, vy: 0, weeks: 1, heading: 0 };
  sim.disasters.roamers.push(monster);
  const random = Math.random;
  Math.random = () => 0; // everything it reaches comes down
  try {
    sim.disasters.week();
  } finally {
    Math.random = random;
  }
  const homes = (monster as any).wrecked;
  assert.ok(homes > 0, 'it wrecked nothing');
  assert.equal(sim.messages.at(-1)!.text, `The monster has gone back to the water. It wrecked ${homes === 1 ? 'a building' : `${homes} buildings`}.`);
  // A station or a landmark lost is news, named apart from another of its kind, and an alert for the last landmark.
  const t = flat(60, 40);
  const [p1, p2] = [t.place('police', 2, 2), t.place('police', 40, 30)];
  const stadium = t.place('stadium', 10, 10);
  const lot = t.place('res', 20, 20);
  t.setLevel(lot, 3);
  const park = t.place('park', 30, 2);
  const s2 = new Sim(t);
  s2.disasters.destroy(p1, 'tornado');
  s2.disasters.destroy(stadium, 'fire');
  s2.disasters.destroy(lot, 'earthquake');
  s2.disasters.destroy(park, 'flood');
  s2.disasters.destroy(p2, 'earthquake');
  assert.deepEqual(s2.messages.map((m) => [m.text, m.kind, m.x, m.y]), [
    ['The tornado wrecked a police station.', 'warn', 3, 3],
    ['The stadium burned down.', 'alert', 12, 12],
    ['The earthquake brought down the police station.', 'warn', 41, 31],
  ]);
});

await test('a flood says when its waters have gone down, and what they washed away; a save keeps the count', () => seeded(3, () => {
  const w = flat(40, 30);
  w.height.fill(1);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 4; x++) { w.water[y * w.w + x] = 1; w.height[y * w.w + x] = -4; }
  for (let y = 2; y < 28; y += 3) w.setLevel(w.place('res', 4, y), 2);
  let sim = new Sim(w);
  sim.disasters.trigger('flood');
  sim.step();
  const run = sim.saveRun();
  assert.ok(run.floodWrecked! > 0, 'the flood took nothing');
  sim = new Sim(World.deserialize(JSON.parse(JSON.stringify(w.serialize(run)))));
  for (let k = 0; k < 20; k++) sim.step();
  const down = sim.messages.filter((m) => m.text.startsWith('The flood waters'));
  assert.equal(down.length, 1);
  assert.match(down[0].text, /^The flood waters have gone down\. They washed away (a building|\d+ buildings)\.$/);
  assert.equal(down[0].kind, 'info');
}));

/**
 * A coast for the high tide: the sea along the west edge, a low plain at 1.5 m out to x = 19 with three houses on it,
 * high ground at 6 m beyond, and in the high ground a lake with a low shore of its own and a house on it.
 */
function tideCoast(): World {
  const w = flat(40, 30);
  for (let i = 0; i < w.n; i++) {
    const x = i % w.w, y = (i / w.w) | 0;
    w.height[i] = x < 4 ? -4 : x < 20 ? 1.5 : 6;
    if (x < 4) w.water[i] = 1;
    if (x >= 28 && x < 36 && y >= 10 && y < 18) w.height[i] = 1.5;
    if (x >= 30 && x < 34 && y >= 12 && y < 16) { w.water[i] = 1; w.height[i] = -2; }
  }
  for (const x of [5, 10, 15]) w.setLevel(w.place('res', x, 4), 2);
  w.setLevel(w.place('res', 29, 10), 2);
  return w;
}
const houses = (w: World) => [...w.buildings.values()].filter((b) => b.kind === 'res').map((b) => b.x).sort((a, b) => a - b);
const tideNews = (sim: Sim) => sim.messages.map((m) => m.text).filter((t) => /tide/.test(t));

await test('a high tide covers the land below its line that the sea reaches, and a bank above the line keeps it out', () => seeded(2, () => {
  const w = tideCoast();
  const sim = new Sim(w);
  // As far as five weeks take it: the whole plain, but neither the high ground nor the lake's own low shore.
  const reach = sim.disasters.tideReach(3);
  const plain = new Set<number>();
  for (let i = 0; i < w.n; i++) if (!w.water[i] && w.height[i] < 3 && i % w.w < 20) plain.add(i);
  assert.deepEqual(new Set(reach.tiles), plain);
  assert.deepEqual(sim.disasters.inReach(reach.tiles).map((b) => b.x), [5, 10, 15], 'nearest the sea first');
  sim.disasters.tide(3);
  assert.deepEqual(sim.messages.map((m) => [m.text, m.kind, m.x, m.y]), [['High tide: the sea is coming in over the land below 3 m.', 'alert', 6, 5]], 'Go there goes to the first house in its way');
  for (let k = 0; k < 12; k++) sim.step();
  assert.equal(w.flood.filter((f) => f > 0).length, 0, 'the tide has gone out');
  assert.deepEqual(houses(w), [29], 'only the house by the lake is left');
  assert.deepEqual(tideNews(sim), ['High tide: the sea is coming in over the land below 3 m.', 'The tide has gone out. It washed away 3 buildings.']);

  // A bank of land at 4 m along the shore, two tiles wide: the same tide covers only the beach in front of it, and the
  // house that stands half on the beach.
  const banked = tideCoast();
  for (let y = 0; y < 30; y++) for (const x of [6, 7]) banked.height[y * banked.w + x] = 4;
  const sim2 = new Sim(banked);
  assert.deepEqual(sim2.disasters.tideReach(3).tiles.map((i) => i % banked.w).sort(), [...new Array(30).fill(4), ...new Array(30).fill(5)]);
  sim2.disasters.tide(3);
  for (let k = 0; k < 12; k++) sim2.step();
  assert.deepEqual(houses(banked), [10, 15, 29]);
  assert.equal(tideNews(sim2).at(-1), 'The tide has gone out. It washed away a building.');
  // A bank right at the water's edge keeps all of it out, and the news says so.
  for (let y = 0; y < 30; y++) banked.height[y * banked.w + 4] = banked.height[y * banked.w + 5] = 4;
  const sim3 = new Sim(banked);
  sim3.disasters.tide(3);
  for (let k = 0; k < 12; k++) sim3.step();
  assert.deepEqual(tideNews(sim3), ['The high tide came up to 3 m, and the shore kept it out.']);
  assert.deepEqual(houses(banked), [10, 15, 29]);
}));

await test('a high tide under way keeps coming in after a reload, and ends as a tide', () => seeded(4, () => {
  const w = tideCoast();
  let sim = new Sim(w);
  sim.disasters.tide(3);
  sim.step();
  const run = sim.saveRun();
  assert.equal(run.floodTide, true);
  const back = World.deserialize(JSON.parse(JSON.stringify(w.serialize(run)))).run!;
  assert.deepEqual([back.floodTide, back.floodLevel, back.floodAge, back.floodWrecked], [true, 3, run.floodAge, run.floodWrecked]);
  sim = new Sim(World.deserialize(JSON.parse(JSON.stringify(w.serialize(run)))));
  for (let k = 0; k < 12; k++) sim.step();
  // Four tiles a week from the shore at x = 4: a week in, it is still coming, and reaches the house at x = 15.
  assert.deepEqual(houses(sim.world), [29]);
  assert.equal(tideNews(sim).at(-1), 'The tide has gone out. It washed away 3 buildings.');
  assert.equal(sim.saveRun().floodTide, false);
}));

await test('no other flood starts while a high tide is in: a random one waits, and one set off from the menu says so', () => seeded(6, () => {
  const w = tideCoast();
  Object.assign(w.city, { disasters: true, difficulty: 'medium' });
  const sim = new Sim(w);
  sim.disasters.tide(3);
  sim.step();
  // A month whose roll is a flood, in a town big enough for disasters.
  sim.stats.residents = 6000;
  const random = Math.random;
  let roll = true;
  Math.random = () => (roll ? ((roll = false), 0.063) : random());
  try {
    sim.disasters.month();
  } finally {
    Math.random = random;
  }
  assert.equal(roll, false);
  assert.equal(sim.saveRun().floodTide, true, 'still a tide');
  assert.ok(!sim.messages.some((m) => m.text === 'Flooding along the shore!'));
  sim.disasters.trigger('flood');
  assert.equal(sim.messages.at(-1)!.text, 'The high tide is in. Another flood can wait until it goes out.');
  for (let k = 0; k < 12; k++) sim.step();
  assert.deepEqual(houses(w), [29]);
  assert.equal(tideNews(sim).at(-1), 'The tide has gone out. It washed away 3 buildings.');
}));

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
  // The first undo past the three months said so; undone and redone since, it has cost nothing more.
  assert.deepEqual(g.toasts.filter((t: string) => t.startsWith('Undone')).slice(0, 2), ['Undone · $5,000 back', 'Undone · no refund after 3 months']);
  assert.equal(g.toasts.at(-1), 'Undone');
  // A quick change of mind is still refunded, and redo charges it again.
  drag(g, 'coal', 52, 30);
  weeks(g, 4);
  const f = g.world.city.funds;
  g.undo();
  assert.equal(g.world.city.funds, f + 3000);
  assert.equal(g.toasts.at(-1), 'Undone · $3,000 back');
  g.redo();
  assert.equal(g.world.city.funds, f);
  assert.equal(g.toasts.at(-1), 'Redone · $3,000');
  g.undo();
  assert.equal(g.world.city.funds, f + 3000);
}));

await test('passing a size class is news, a toast and a fanfare; an upgrade is news; only a surplus year ends with the coin', () => seeded(3, () => {
  const w = flat(40, 30);
  w.city.name = 'Mapleford';
  const g = headless(w);
  const played: string[] = [];
  g.audio = { play: (s: string) => played.push(s) };
  for (let k = 0; k < 7; k++) w.setLevel(w.place('res', 1 + (k % 4) * 9, 1 + Math.floor(k / 4) * 9), 8);
  weeks(g, 4);
  const passed = 'Mapleford has passed 10,000 residents and is now a city.';
  assert.deepEqual(g.sim.messages.filter((m: any) => m.text.includes('is now a')).map((m: any) => [m.text, m.kind]), [[passed, 'good']]);
  assert.deepEqual([g.toasts.filter((t: string) => t === passed).length, played.filter((s) => s === 'fanfare').length], [1, 1]);
  // A landmark upgrade goes in the news, at the landmark, with one fanfare.
  w.city.funds = 100000;
  const stadium = w.place('stadium', 30, 20);
  assert.equal(g.upgrade(stadium), true);
  const up = g.sim.messages.at(-1);
  assert.deepEqual([up.text, up.kind, up.x, up.y], ['The stadium is now a big-league stadium. Land value is up across the city.', 'good', 32, 22]);
  assert.equal(played.filter((s) => s === 'fanfare').length, 2);
  // The first year's taxes cover its costs; the second year's road upkeep has nothing to pay for it.
  weeks(g, 44);
  assert.match(g.sim.messages.at(-1).text, /^1900 closes with a surplus/);
  assert.equal(played.filter((s) => s === 'coin').length, 1);
  for (const b of [...w.buildings.values()]) w.remove(b.id);
  for (let y = 0; y < 30; y += 2) for (let x = 0; x < 40; x++) w.setNet(ROAD, x, y);
  weeks(g, 48);
  assert.match(g.sim.messages.filter((m: any) => m.text.startsWith('1901')).at(-1).text, /^1901 closes with a deficit/);
  assert.equal(played.filter((s) => s === 'coin').length, 1);
}));

await test('loans: up to $30,000 in all, repaid only with the money in hand, and their interest charged in the month', () => {
  const w = flat();
  w.city.funds = 1000;
  const sim = new Sim(w);
  assert.equal(sim.takeLoan(10000), true);
  assert.deepEqual([w.city.loan, w.city.funds], [10000, 11000]);
  assert.equal(sim.takeLoan(20000), true);
  assert.equal(sim.takeLoan(10000), false, 'no more than $30,000 owed at once');
  assert.deepEqual([w.city.loan, w.city.funds], [30000, 31000]);
  // 7% a year, a twelfth of it each month, in the ledger and out of the funds.
  const before = w.city.funds;
  sim.budget();
  const b = sim.stats.lastBudget;
  assert.equal(b.interest, 175);
  assert.equal(w.city.funds, before + b.taxIncome - spending(b));
  assert.ok(spending(b) >= 175);
  // Repaying needs the money.
  w.city.funds = 5000;
  assert.equal(sim.repayLoan(10000), false);
  assert.deepEqual([w.city.loan, w.city.funds], [30000, 5000]);
  w.city.funds = 12000;
  assert.equal(sim.repayLoan(10000), true);
  assert.deepEqual([w.city.loan, w.city.funds], [20000, 2000]);
  // More than is owed repays what is owed, and then there is nothing to repay.
  w.city.funds = 50000;
  assert.equal(sim.repayLoan(30000), true);
  assert.deepEqual([w.city.loan, w.city.funds], [0, 30000]);
  assert.equal(sim.repayLoan(10000), false);
  sim.budget();
  assert.equal(sim.stats.lastBudget.interest, 0);
});

await test('a challenge opens with its goal in the news and its real monthly balance, and a win says when', () => seeded(4, () => {
  const g = headless(flat(40, 30));
  for (const id of ['gridlock', 'aftershock']) {
    const s = SCENARIOS.find((x) => x.id === id)!;
    g.startScenario(id);
    const sim = g.sim;
    assert.deepEqual([sim.messages[0].text, sim.messages[0].kind], [`${s.goal} You have until ${s.year + s.years}.`, 'info']);
    const b = sim.stats.lastBudget;
    const net = b.taxIncome - spending(b);
    assert.ok(b.taxIncome > 300 && net > 0, `${id} opens at ${net}/mo`);
    assert.equal(g.world.city.funds, s.funds, 'the reckoning charged the city');
  }
  assert.ok(g.sim.messages.some((m: any) => m.kind === 'alert'), "Aftershock's earthquake is news after the goal");
  const aftershock = SCENARIOS.find((x) => x.id === 'aftershock')!;
  const end = (aftershock.year - 1900 + aftershock.years) * 12;
  assert.equal(successLine(aftershock, (1993 - 1900) * 12, end), 'Aftershock is a success in 1993, four years early.');
  assert.equal(successLine(aftershock, end - 12, end), 'Aftershock is a success in 1996, one year early.');
  assert.equal(successLine(aftershock, end - 5, end), 'Aftershock is a success in 1996, five months early.');
  assert.equal(successLine(aftershock, end, end), 'Aftershock is a success in 1997.');
}));

await test('a won challenge plays the fanfare, and a lost one its own falling sting rather than the misclick buzz', () => seeded(4, () => {
  const g = headless(flat(40, 30));
  const played: string[] = [];
  g.audio = { play: (s: string) => played.push(s), unlock: () => {} };
  g.startScenario('gridlock');
  g.world.city.month = g.world.city.scenario.end;
  g.checkScenario();
  assert.equal(g.world.city.scenario.done, 'lost');
  assert.deepEqual(played.filter((s) => ['sting', 'error', 'fanfare'].includes(s)), ['sting']);
  played.length = 0;
  g.startScenario('boomtown');
  g.sim.stats.residents = 12500;
  g.checkScenario();
  assert.equal(g.world.city.scenario.done, 'won');
  assert.deepEqual(played.filter((s) => ['sting', 'error', 'fanfare'].includes(s)), ['fanfare']);
}));

await test('a won challenge is kept in this browser with the year it was won, and a loss is not', () => seeded(4, () => {
  const glob = globalThis as unknown as { window?: unknown };
  const was = glob.window;
  const storage = memStorage();
  glob.window = { localStorage: storage };
  try {
    assert.deepEqual(challengeWins(), {});
    const g = headless(flat(40, 30));
    g.startScenario('gridlock');
    g.world.city.month = g.world.city.scenario.end;
    g.checkScenario();
    assert.deepEqual(challengeWins(), {}, 'a lost challenge is not kept');
    g.startScenario('boomtown');
    g.world.city.month += 30;
    g.sim.stats.residents = 12500;
    g.checkScenario();
    assert.deepEqual(challengeWins(), { boomtown: 1902 });
    // A later win in a later year leaves the earlier one; an earlier year replaces it.
    recordWin('boomtown', 1910);
    recordWin('boomtown', 1901);
    recordWin('smog', 1975);
    assert.deepEqual(challengeWins(), { boomtown: 1901, smog: 1975 });
    // Whatever else is in the key is left out.
    storage.setItem('terraville.wins', JSON.stringify({ boomtown: 'soon', smog: 1975.5, gridlock: 1960, monster: null }));
    assert.deepEqual(challengeWins(), { gridlock: 1960 });
    storage.setItem('terraville.wins', '[1993');
    assert.deepEqual(challengeWins(), {});
  } finally {
    glob.window = was;
  }
}));

await test("the city's first seaport, airport or stadium is news, with the limit it lifts and a fanfare; a second is not", () => seeded(5, () => {
  const w = flat(40, 30);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 3; x++) { w.water[y * w.w + x] = 1; w.height[y * w.w + x] = -4; }
  const g = headless(w);
  w.city.funds = 100000;
  const played: string[] = [];
  g.audio = { play: (s: string) => played.push(s), unlock: () => {} };
  const good = () => g.sim.messages.filter((m: any) => m.kind === 'good').map((m: any) => [m.text, m.x, m.y]);
  drag(g, 'seaport', 4, 4);
  assert.equal(w.buildingAt(4, 4)?.kind, 'seaport');
  const text = "The seaport is open. Industry won't stall at 4,000 jobs.";
  assert.deepEqual(good(), [[text, 5, 5]]);
  assert.equal(g.toasts.at(-1), text);
  assert.deepEqual(played, ['fanfare']);
  drag(g, 'seaport', 4, 14);
  assert.equal(w.buildingAt(4, 14)?.kind, 'seaport');
  assert.equal(good().length, 1, 'a second seaport is no news');
  assert.deepEqual(played, ['fanfare', 'build']);
  // Where the limit was holding the city back, it says growth can go on.
  g.sim.capped.res = true;
  drag(g, 'stadium', 20, 10);
  assert.equal(good().at(-1)[0], 'The stadium is open. Housing can grow past 18,000 residents.');
}));

await test("a challenge's result goes in the news: a win says when, and a loss names the first goal not met", () => seeded(4, () => {
  const g = headless(flat(40, 30));
  g.startScenario('boomtown');
  const boom = SCENARIOS.find((x) => x.id === 'boomtown')!;
  const sc = g.world.city.scenario;
  g.world.city.month = sc.end - 30;
  g.sim.stats.residents = 12500;
  g.checkScenario();
  assert.equal(sc.done, 'won');
  const won = g.sim.messages.at(-1);
  assert.deepEqual([won.text, won.kind, won.x], [successLine(boom, sc.end - 30, sc.end), 'good', undefined]);
  assert.equal(won.text, 'Boomtown is a success in 1912, two years early.');
  g.startScenario('gridlock');
  const gs = g.world.city.scenario;
  g.world.city.month = gs.end;
  g.checkScenario();
  assert.equal(gs.done, 'lost');
  const lost = g.sim.messages.at(-1);
  // Its traffic goal was met; its residents were not.
  assert.match(lost.text, /^Time ran out for Gridlock\. [\d,]+ of 20,000 residents\.$/);
  assert.equal(lost.kind, 'warn');
}));

await test("a challenge's deadline notices come from the game's own month ends, once each", () => seeded(5, () => {
  const g = headless(flat(40, 30));
  g.startScenario('gridlock');
  const sc = g.world.city.scenario;
  g.world.city.disasters = false;
  g.world.city.month = sc.end - 13;
  weeks(g, 4 * 11);
  const notices = g.sim.messages.filter((m: any) => /^(One year|Three months) left/.test(m.text)).map((m: any) => [m.text.split('.')[0], sc.end - m.month]);
  assert.deepEqual(notices, [['One year left: the goal is judged at the end of 1960', 12], ['Three months left', 3]]);
}));

await test('undo leaves alone what a disaster has wrecked since, and refunds nothing for it', () => seeded(42, () => {
  const g = town();
  const w = g.world;
  const refused = "That spot has been wrecked since, so it can't be undone.";
  drag(g, 'stadium', 54, 30);
  const stadium = [...w.buildings.values()].find((b) => b.kind === 'stadium')!;
  g.upgrade(stadium);
  weeks(g, 4);
  g.sim.disasters.destroy(w.buildings.get(stadium.id)!, 'tornado');
  const funds = w.city.funds;
  g.undo(); // the upgrade
  g.undo(); // the stadium
  assert.equal([...w.buildings.values()].some((b) => b.kind === 'stadium'), false, 'the stadium is back');
  assert.equal(w.city.funds, funds, 'refunded');
  assert.deepEqual(g.toasts.slice(-2), [refused, refused]);
  assert.equal(g.canRedo(), false);
  // A lot that burns down while Level land is held stays down when the stroke is undone, and the ground goes back.
  for (let y = 4; y < 20; y++) for (let x = 52; x < 60; x++) w.height[y * w.w + x] = 3 + ((x * 7 + y * 3) % 5);
  const lot = w.place('res', 55, 11);
  w.setLevel(lot, 2);
  const ground = w.height.slice();
  g.setTool('level');
  g.brush.radius = 5;
  g.pointerDown(54.5, 9.5, 0, 0);
  for (let t = 0; t < 10; t++) g.brushTick(1 / 30);
  g.sim.disasters.destroy(lot, 'fire');
  for (let t = 0; t < 10; t++) g.brushTick(1 / 30);
  g.pointerUp(54.5, 9.5, 0, 0);
  g.sealUndo();
  assert.notDeepEqual(w.height, ground, 'the stroke moved no earth');
  g.undo();
  assert.equal(w.buildings.has(lot.id), false, 'the burnt lot is back');
  assert.equal(w.rubble[12 * w.w + 56], 1);
  assert.deepEqual(w.height, ground);
  // Redo is refused too once a disaster has been at the spot since the undo.
  drag(g, 'park', 58, 2);
  g.undo();
  const park = 2 * w.w + 58;
  w.rubble[park] = 1; // as a wreck leaves it
  g.redo();
  assert.deepEqual([w.occ[park], g.toasts.at(-1)], [0, "That spot has been wrecked since, so it can't be redone."]);
}));

await test('undo and redo wait for a fire to go out, then leave no fire on bare ground; a burning lot cannot be bulldozed', () => seeded(42, () => {
  const g = town();
  const w = g.world;
  const bare = () => {
    let n = 0;
    for (let i = 0; i < w.n; i++) if (w.fire[i] && !w.occ[i] && !w.trees[i] && !w.rubble[i]) n++;
    return n;
  };
  const burning = (b: any) => {
    let n = 0;
    for (let dy = 0; dy < b.size; dy++) for (let dx = 0; dx < b.size; dx++) if (w.fire[(b.y + dy) * w.w + b.x + dx]) n++;
    return n;
  };
  const putOut = (b: any) => {
    for (let dy = 0; dy < b.size; dy++) for (let dx = 0; dx < b.size; dx++) w.fire[(b.y + dy) * w.w + b.x + dx] = 0;
  };
  drag(g, 'res', 53, 12);
  const lot = w.buildingAt(53, 12);
  g.sim.disasters.ignite(lot.x, lot.y);
  const funds = w.city.funds;
  g.undo();
  // Refused, as bulldozing it would be: the lot stays, still burning, and the undo waits for the fire.
  assert.equal(g.toasts.at(-1), 'That is on fire. Undo it once the fire is out.');
  assert.equal(w.buildingAt(53, 12)?.id, lot.id);
  assert.equal(burning(lot), 9);
  assert.deepEqual([w.city.funds, g.canUndo(), g.canRedo()], [funds, true, false]);
  // Once the fire is out, the undo goes ahead and leaves cold, bare ground.
  putOut(lot);
  g.undo();
  assert.ok(!w.buildingAt(53, 12));
  assert.equal(bare(), 0, 'undoing a lot that had burned left the ground burning');
  g.redo();
  assert.equal(w.buildingAt(53, 12)?.kind, 'res');
  assert.equal(w.fire[12 * w.w + 53], 0);
  // A station built six months ago and set alight: undo then redo can't bring it back standing and cold.
  drag(g, 'police', 54, 20);
  const station = w.buildingAt(54, 20);
  weeks(g, 24);
  g.sim.disasters.ignite(station.x, station.y);
  g.undo();
  g.redo();
  const now = w.buildingAt(54, 20);
  assert.ok(now && burning(now) > 0, `${now?.kind} standing with ${now ? burning(now) : 0} tiles burning`);
  // Redo waits too: a lot bulldozed, put back by undo, then set alight.
  putOut(now);
  const home = [...w.buildings.values()].find((b: any) => b.kind === 'res' && b.level > 0)!;
  drag(g, 'bulldoze', home.x + 1, home.y + 1);
  assert.equal(w.buildings.has(home.id), false);
  g.undo();
  g.sim.disasters.ignite(home.x, home.y);
  g.redo();
  assert.equal(g.toasts.at(-1), 'That is on fire. Redo it once the fire is out.');
  assert.ok(w.buildings.has(home.id) && burning(home) === 9, 'the burning lot is still there');
  assert.equal(g.canRedo(), true);
  putOut(home);
  g.redo();
  assert.equal(w.buildings.has(home.id), false);
  // Bulldozing a burning lot is refused, as building on burning ground is; clearing a gap beside it still works.
  const homes = [...w.buildings.values()].filter((b: any) => b.kind === 'res' && b.level > 0 && b.x >= 16 && b.x <= 40 && b.y >= 14);
  const [alight, beside] = [homes[0], homes.find((b: any) => b.y === homes[0].y && b.x === homes[0].x + 4)];
  assert.ok(alight && beside, 'two homes side by side');
  g.sim.disasters.ignite(alight.x, alight.y);
  const plan = planBulldoze(w, [[alight.x + 1, alight.y + 1]]);
  assert.deepEqual([plan.count, plan.reason], [0, 'On fire']);
  drag(g, 'bulldoze', alight.x, alight.y, beside.x + 2, beside.y + 2);
  assert.ok(w.buildings.has(alight.id), 'the burning lot is still there');
  assert.equal(w.buildings.has(beside.id), false, 'the lot beside it was cleared');
  assert.equal(bare(), 0);
}));

await test('a gap bulldozed beside a fire stays cleared: undo refuses it once the fire is out, and other bulldozing undoes as before', () => seeded(42, () => {
  const g = town();
  const w = g.world;
  const putOut = () => w.fire.fill(0);
  // Four built lots in a row, a road between each: a fire in the second, so the first and third are 2 tiles from it
  // and the fourth 6.
  const row = (b: any) => [-4, 0, 4, 8].map((dx) => w.buildingAt(b.x + dx, b.y)).filter((x: any, k: number) => x && x.level > 0 && x.x === b.x + 4 * k - 4);
  const lots = [...w.buildings.values()].map(row).find((r) => r.length === 4);
  assert.ok(lots, 'four built lots in a row');
  const [left, alight, beside, far] = lots;
  g.sim.disasters.ignite(alight.x, alight.y);
  const funds = w.city.funds;
  drag(g, 'bulldoze', beside.x + 1, beside.y + 1);
  drag(g, 'bulldoze', far.x + 1, far.y + 1);
  assert.deepEqual([w.buildings.has(beside.id), w.buildings.has(far.id)], [false, false]);
  const paid = funds - w.city.funds;
  // The fire goes out inside the three months that would refund the bulldozing. The lot 6 tiles from it undoes as
  // bulldozing always has, people, refund and all; the gap beside it stays cleared, and its cost stays spent.
  putOut();
  g.undo();
  assert.equal(w.buildingAt(far.x + 1, far.y + 1)?.id, far.id);
  const refund = w.city.funds - (funds - paid);
  assert.ok(refund > 0 && refund < paid, `refunded ${refund} of ${paid}`);
  g.undo();
  assert.equal(g.toasts.at(-1), 'That gap was a firebreak, so it stays cleared.');
  assert.equal(w.buildings.has(beside.id), false);
  assert.equal(w.city.funds, funds - paid + refund);
  // The firebreak stays as it is, so the lot undone after it can still be bulldozed again by redo.
  assert.equal(g.canRedo(), true);
  g.redo();
  assert.equal(w.buildings.has(far.id), false);
  assert.equal(w.city.funds, funds - paid);
  // Bulldozing undone with no fire near, then done again by redo beside a fire, is a firebreak too.
  drag(g, 'bulldoze', left.x + 1, left.y + 1);
  g.undo();
  assert.equal(w.buildingAt(left.x + 1, left.y + 1)?.id, left.id);
  g.sim.disasters.ignite(alight.x, alight.y);
  g.redo();
  assert.equal(w.buildings.has(left.id), false);
  putOut();
  g.undo();
  assert.equal(g.toasts.at(-1), 'That gap was a firebreak, so it stays cleared.');
  assert.equal(w.buildings.has(left.id), false);
}));

await test('a city founded on Easy starts with $20,000, on Medium $10,000, and on Hard $7,500', () => {
  const funds = (['easy', 'medium', 'hard'] as const).map((d) => {
    const g = headless(flat(40, 30));
    g.foundCity('Riverton', d, true);
    assert.equal(g.world.city.difficulty, d);
    return g.world.city.funds;
  });
  assert.deepEqual(funds, [20000, 10000, 7500]);
});

await test('a sandbox city builds, levels and upgrades for nothing, keeps its funds still at month end, and has no loans', () => seeded(7, () => {
  const g = headless(flat(60, 40));
  g.foundCity('Sandville', 'hard', false, true);
  const w: World = g.world;
  const city = w.city;
  // It plays as Medium, landmark limits and all, with nothing in the bank.
  assert.deepEqual([city.sandbox, city.difficulty, city.funds, city.disasters], [true, 'medium', 0, false]);
  drag(g, 'coal', 8, 5);
  drag(g, 'road', 10, 12, 50, 12);
  drag(g, 'power', 10, 12, 50, 12);
  drag(g, 'res', 12, 14, 24, 14);
  drag(g, 'stadium', 30, 20);
  const kinds = [...w.buildings.values()].map((b) => b.kind);
  for (const k of ['coal', 'res', 'stadium']) assert.ok(kinds.includes(k as Kind), `${k} built`);
  assert.ok(w.net[12 * w.w + 30] & ROAD, 'road laid');
  const stadium = [...w.buildings.values()].find((b) => b.kind === 'stadium')!;
  assert.equal(g.upgrade(stadium), true);
  assert.equal(stadium.level, 2);
  // Level land moves earth for nothing.
  for (let y = 30; y < 36; y++) for (let x = 40; x < 46; x++) w.height[y * w.w + x] = 3 + (x - 40) * 2;
  const before = w.height[32 * w.w + 44];
  g.setTool('level');
  g.pointerDown(41.5, 32.5, 0, 0);
  g.brushTick(0.5);
  g.pointerUp(41.5, 32.5, 0, 0);
  assert.ok(w.height[32 * w.w + 44] < before, 'the slope was levelled');
  assert.equal(city.funds, 0);
  // Undo says nothing about money: there was none to give back.
  g.undo();
  assert.equal(g.toasts.at(-1), 'Undone');
  // The month's upkeep shows on the ledger, but nothing is charged; there is nothing to borrow.
  weeks(g, 4 * 3);
  assert.ok(spending(g.sim.stats.lastBudget) > 0, 'the ledger counts the upkeep');
  assert.equal(city.funds, 0);
  assert.deepEqual(city.history.funds, [0, 0, 0]);
  assert.equal(city.debtMonths, 0);
  assert.equal(g.sim.takeLoan(10000), false);
  assert.equal(city.loan, 0);
  // Its year closes with no money said, in the news or the paper.
  const papers: { closing: string }[] = [];
  g.sim.on((e: { type: string; paper?: { closing: string } }) => { if (e.type === 'paper') papers.push(e.paper!); });
  weeks(g, 4 * 9);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].closing, '');
  assert.equal(g.sim.messages.some((m: { text: string }) => /closes with/.test(m.text)), false);
  assert.equal(city.funds, 0);
  // It stays a sandbox through a save, and a code that says anything but true is no sandbox.
  assert.equal(World.deserialize(JSON.parse(JSON.stringify(w.serialize()))).city.sandbox, true);
  const odd = JSON.parse(JSON.stringify(w.serialize()));
  odd.city.sandbox = 'yes';
  assert.equal('sandbox' in World.deserialize(odd).city, false);
  // The same coal plant in a city with money, at nothing in the bank, is refused.
  const m = headless(flat(60, 40));
  m.foundCity('Hardup', 'medium', false);
  m.world.city.funds = 0;
  drag(m, 'coal', 8, 5);
  assert.equal(m.world.buildings.size, 0);
  assert.equal('sandbox' in m.world.city, false);
  assert.match(m.toasts.at(-1), /^Not enough money/);
}));

await test('Escape on the map calls a Level land stroke begun with Enter off whole: the ground and the money go back', () => seeded(7, () => {
  const g = headless(flat(60, 40));
  g.foundCity('Gradeton', 'medium', false);
  const w: World = g.world;
  for (let y = 30; y < 36; y++) for (let x = 40; x < 46; x++) w.height[y * w.w + x] = 3 + (x - 40) * 2;
  const ground = Array.from(w.height);
  const funds = w.city.funds;
  const steps = g.undoStack.length;
  // The keyboard's cursor on the slope: Enter starts the brush, and it levels and spends while it runs.
  g.kbCursor = { x: 41, y: 32 };
  g.setTool('level');
  g.cursorEnter();
  assert.equal(g.brushOn, true);
  g.brushTick(0.5);
  assert.ok(w.height[32 * w.w + 44] < ground[32 * w.w + 44], 'the slope was being levelled');
  assert.ok(w.city.funds < funds, 'and paid for');
  // Escape calls it off, as it calls off a road: nothing of it is left, and nothing to undo.
  g.cursorCancel();
  assert.equal(g.brushOn, false);
  assert.deepEqual(Array.from(w.height), ground);
  assert.equal(w.city.funds, funds);
  assert.equal(g.undoStack.length, steps);
}));

await test('a landmark on fire is not offered an upgrade, and cannot be sold one', () => seeded(42, () => {
  const g = town();
  const w = g.world;
  drag(g, 'stadium', 55, 30);
  const stadium = [...w.buildings.values()].find((b) => b.kind === 'stadium')!;
  assert.ok(g.upgradeFor(stadium), 'offered before the fire');
  g.sim.disasters.ignite(stadium.x, stadium.y);
  const funds = w.city.funds;
  assert.equal(g.upgradeFor(stadium), undefined);
  assert.equal(g.upgrade(stadium), false);
  assert.deepEqual([w.city.funds, stadium.level], [funds, 1]);
  // The card's own question: would it be offered but for the fire? It would.
  assert.ok(g.upgradeFor(stadium, true));
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) w.fire[(stadium.y + dy) * w.w + stadium.x + dx] = 0;
  assert.ok(g.upgradeFor(stadium), 'offered again once the fire is out');
}));

/** Everything on a World a player can change, for comparing two moments. Heights are kept apart: see `sameMap`. */
function mapOf(w: World) {
  return {
    height: w.height.slice(),
    rest: JSON.stringify([[...w.water], [...w.trees], [...w.net], [...w.occ], [...w.rubble],
      [...w.buildings.values()].sort((a, b) => a.id - b.id).map((b) => [b.id, b.kind, b.x, b.y, b.level, b.pop])]),
  };
}

/** Whether two moments of a map match, heights to 0.1 mm as undo judges them (Level land undone can differ by less). */
function sameMap(a: ReturnType<typeof mapOf>, b: ReturnType<typeof mapOf>): boolean {
  return a.rest === b.rest && a.height.every((h, i) => Math.abs(h - b.height[i]) <= 1e-4);
}

/** What breaks the rules a World keeps, in words: empty when it is sound. */
function broken(w: World, sim: Sim): string[] {
  const errs: string[] = [];
  for (const b of w.buildings.values()) {
    for (let dy = 0; dy < b.size; dy++) for (let dx = 0; dx < b.size; dx++) {
      if (w.occ[(b.y + dy) * w.w + b.x + dx] !== b.id) errs.push(`${b.kind} ${b.id} at ${b.x},${b.y}: tile ${b.x + dx},${b.y + dy} is not marked as it`);
    }
  }
  for (let i = 0; i < w.n; i++) {
    const at = `${i % w.w},${(i / w.w) | 0}`;
    if (w.occ[i] && !w.buildings.has(w.occ[i])) errs.push(`${at} is marked as building ${w.occ[i]}, which is gone`);
    if (w.net[i] & ~7) errs.push(`${at} has network bits ${w.net[i]}`);
    if (!Number.isFinite(w.height[i])) errs.push(`${at} has no height`);
    if (w.fire[i] && !w.occ[i] && !w.trees[i] && !w.rubble[i]) errs.push(`${at} burns on bare ground`);
  }
  for (const k of ['r', 'c', 'i'] as const) if (!(Math.abs(w.city.demand[k]) <= 1)) errs.push(`demand ${k} is ${w.city.demand[k]}`);
  const st = sim.stats as any;
  for (const k of Object.keys(st)) if (typeof st[k] === 'number' && !Number.isFinite(st[k])) errs.push(`stats.${k} is ${st[k]}`);
  for (const [k, v] of Object.entries(st.lastBudget)) if (!Number.isFinite(v)) errs.push(`last month's ${k} is ${v}`);
  if (!Number.isFinite(w.city.funds)) errs.push(`funds are ${w.city.funds}`);
  return errs;
}

await test('random play keeps the World consistent', () => {
  const ZONES = ['res', 'com', 'ind'];
  const PLACES = ['police', 'fire', 'school', 'hospital', 'stadium', 'coal', 'nuclear', 'wind', 'solar', 'seaport', 'airport'];
  const DISASTERS = ['fire', 'flood', 'tornado', 'earthquake', 'monster', 'meltdown'] as const;
  for (const seed of [1, 2]) seeded(1000 + seed, () => {
    // The game rolls Math.random; the player's choices come from a stream of their own.
    const R = makeRng(7 + seed);
    const ri = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));
    const W = 72, H = 60;
    const world = generateTerrain({ ...DEFAULT_TERRAIN, seed: `fuzz-${seed}`, w: W, h: H, style: seed % 2 ? 'coast' : 'lakes' });
    Object.assign(world.city, { founded: true, difficulty: seed % 2 ? 'easy' : 'medium', disasters: false, funds: 60000, name: 'Fuzz' });
    const g = headless(world);
    const sim: Sim = g.sim;
    // A town on the driest, gentlest ground, so growth, power and disasters have something to work on.
    let site = { x: W / 2, y: H / 2, score: -Infinity };
    for (let y = 15; y < H - 15; y += 3) for (let x = 15; x < W - 15; x += 3) {
      let sc = 0;
      for (let dy = -14; dy <= 14; dy += 2) for (let dx = -14; dx <= 14; dx += 2) sc += world.water[(y + dy) * W + x + dx] ? -3 : world.slope(x + dx, y + dy) > 5 ? -1 : 1;
      if (sc > site.score) site = { x, y, score: sc };
    }
    const { x: cx, y: cy } = site;
    drag(g, 'coal', cx - 12, cy);
    for (let k = -12; k <= 12; k += 4) {
      drag(g, 'road', cx - 10, cy + k, cx + 14, cy + k);
      drag(g, 'power', cx - 10, cy + k, cx + 14, cy + k);
    }
    for (let k = -10; k <= 14; k += 4) drag(g, 'road', cx + k, cy - 12, cx + k, cy + 12);
    for (let k = 0; k < 30; k++) drag(g, ZONES[k % 3], cx - 8 + (k % 6) * 4, cy - 10 + Math.floor(k / 6) * 4);
    weeks(g, 52);
    world.city.disasters = true;
    world.city.funds = 200000;
    const px = () => Math.max(0, Math.min(W - 1, cx + ri(-24, 24)));
    const py = () => Math.max(0, Math.min(H - 1, cy + ri(-24, 24)));
    let ledger = 0;
    sim.on((e) => { if (e.type === 'month') ledger += sim.stats.lastBudget.taxIncome - spending(sim.stats.lastBudget); });
    for (let t = 0; t < 250; t++) {
      const roll = R();
      const fundsBefore = world.city.funds;
      const before = mapOf(world);
      const stack = g.undoStack.length;
      const top = g.undoStack.at(-1);
      let act = '';
      let undoable = true;
      const where = () => `seed ${seed}, step ${t} (${act})`;
      if (roll < 0.3) {
        act = 'weeks';
        undoable = false;
        ledger = 0;
        weeks(g, ri(1, 8));
        assert.ok(Math.abs(world.city.funds - fundsBefore - ledger) < 1e-6, `${where()}: funds moved ${world.city.funds - fundsBefore}, the budget ${ledger}`);
      } else if (roll < 0.4) {
        act = 'zone';
        const x = px(), y = py();
        drag(g, ZONES[ri(0, 2)], x, y, x + ri(-8, 8), y + ri(-8, 8));
      } else if (roll < 0.52) {
        act = ['road', 'rail', 'power'][ri(0, 2)];
        const x = px(), y = py();
        drag(g, act, x, y, x + ri(-20, 20), y + ri(-20, 20));
      } else if (roll < 0.58) {
        act = 'place';
        drag(g, PLACES[ri(0, PLACES.length - 1)], px(), py());
      } else if (roll < 0.62) {
        act = 'park';
        const x = px(), y = py();
        drag(g, 'park', x, y, x + ri(-3, 3), y + ri(-3, 3));
      } else if (roll < 0.66) {
        act = 'trees';
        const x = px(), y = py();
        drag(g, 'trees', x, y, x + ri(-4, 4), y + ri(-4, 4));
      } else if (roll < 0.72) {
        act = 'bulldoze';
        const x = px(), y = py();
        drag(g, 'bulldoze', x, y, x + ri(-5, 5), y + ri(-5, 5));
      } else if (roll < 0.76) {
        act = 'level';
        const x = px(), y = py(), frames = ri(3, 45);
        g.setTool('level');
        g.brush.radius = ri(1, 5);
        g.pointerDown(x + 0.5, y + 0.5, 0, 0);
        for (let k = 0; k < frames; k++) g.brushTick(1 / 30);
        g.pointerUp(x + 0.5, y + 0.5, 0, 0);
        g.sealUndo();
      } else if (roll < 0.78) {
        act = 'upgrade';
        const ups = [...world.buildings.values()].filter((b) => g.upgradeFor(b));
        if (ups.length) g.upgrade(ups[ri(0, ups.length - 1)]);
      } else if (roll < 0.85) {
        act = 'undo';
        undoable = false;
        g.undo();
      } else if (roll < 0.89) {
        act = 'redo';
        undoable = false;
        g.redo();
      } else if (roll < 0.93) {
        act = 'disaster';
        undoable = false;
        sim.disasters.trigger(DISASTERS[ri(0, 5)]);
      } else if (roll < 0.97) {
        act = 'save';
        undoable = false;
        const keep = (w: World) => JSON.stringify([mapOf(w).rest, [...w.height], [...w.fire], [...w.flood], [...w.rad], w.nextId, w.city]);
        const run = sim.saveRun();
        const back = World.deserialize(JSON.parse(JSON.stringify(world.serialize(run))));
        assert.equal(keep(back), keep(world), `${where()}: the map, its buildings or the city came back different`);
        const again = headless(back);
        assert.equal(JSON.stringify(again.sim.saveRun()), JSON.stringify(run), `${where()}: the running simulation came back different`);
        again.sim.dispose();
      } else {
        act = 'budget';
        undoable = false;
        world.city.tax = ri(0, 20);
        world.city.funding.police = ri(0, 20) / 20;
        world.city.funding.fire = ri(0, 20) / 20;
        world.city.funding.transport = R() < 0.5 ? 1 : ri(0, 20) / 20;
        if (R() < 0.5) sim.takeLoan(10000); else sim.repayLoan(10000);
      }
      const errs = broken(world, sim);
      assert.deepEqual(errs.slice(0, 3), [], `${where()}`);
      // An action undone at once puts back the map and the money; redone, it is the same again for the same price.
      const pushed = g.undoStack.length > stack || g.undoStack.at(-1) !== top;
      if (undoable && pushed) {
        const after = mapOf(world);
        const fundsAfter = world.city.funds;
        g.undo();
        // Unless the spot is on fire, when undo waits.
        if (g.undoStack.at(-1) === top) {
          assert.ok(sameMap(mapOf(world), before), `${where()}: undo did not put the map back`);
          assert.ok(Math.abs(world.city.funds - fundsBefore) < 1e-6, `${where()}: undo gave back ${world.city.funds - fundsAfter} of ${fundsBefore - fundsAfter}`);
          g.redo();
          assert.ok(sameMap(mapOf(world), after), `${where()}: redo did not give back the same map`);
          assert.ok(Math.abs(world.city.funds - fundsAfter) < 1e-6, `${where()}: redo charged ${fundsBefore - world.city.funds}, not ${fundsBefore - fundsAfter}`);
          assert.deepEqual(broken(world, sim).slice(0, 3), [], `${where()}, undone and redone`);
        }
      }
      if (world.city.funds < 20000) world.city.funds += 100000;
    }
  });
});

await test('the cost tip says what part of a price is bridges, and what part clears trees or rubble', () => {
  const w = flat(40, 30);
  for (let y = 0; y < w.h; y++) for (const x of [20, 21]) w.water[y * w.w + x] = 1;
  for (let y = 10; y < 13; y++) for (let x = 5; x < 8; x++) w.trees[y * w.w + x] = 2;
  w.rubble[10 * w.w + 9] = 1;
  const road = planLine(w, ROAD, linePath(15, 5, 25, 5));
  assert.deepEqual([road.count, road.bridges, road.bridgeCost, road.cost], [11, 2, 120, 9 * 10 + 120]);
  const lots = planZones(w, 'res', 6, 11, 9, 11);
  assert.deepEqual([lots.count, lots.clearing, lots.clears], [2, 10, 'trees and rubble']);
  const g = headless(w);
  const tips: string[] = [];
  g.ui.cursorTip = (_x: number, _y: number, html: string) => tips.push(html);
  const tip = (tool: string, x0: number, y0: number, x1: number, y1: number) => {
    g.setTool(tool);
    g.pointerDown(x0 + 0.5, y0 + 0.5, 0, 0);
    g.pointerMove(x1 + 0.5, y1 + 0.5, 0, 0);
    const t = tips.at(-1)!.replace(/<[^>]+>/g, '');
    g.cancelTool();
    return t;
  };
  assert.equal(tip('road', 15, 5, 25, 5), 'Road · 11 tiles · $210, with 2 bridge tiles ($120)');
  assert.equal(tip('power', 15, 7, 25, 7), 'Power line · 11 tiles · $95, with 2 tiles over water ($50)');
  assert.equal(tip('res', 6, 11, 6, 11), 'Residential · 1 zone · $109, with $9 to clear trees');
});

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

await test('before it is pressed, Level land says about what flattening its circle costs, and holding it costs that', () => {
  const w = flat(40, 30);
  // A 2 by 2 bump 5 m high in the circle: 20 m of earth at $2.
  for (const [x, y] of [[20, 14], [21, 14], [20, 15], [21, 15]]) w.height[y * w.w + x] = 8;
  // What Level land leaves alone costs nothing: water, a road, a building.
  w.water[16 * w.w + 23] = 1;
  w.height[16 * w.w + 23] = -2;
  w.setNet(ROAD, 24, 15);
  w.height[15 * w.w + 24] = 10;
  const home = w.place('res', 22, 18);
  for (let y = 18; y < 21; y++) for (let x = 22; x < 25; x++) w.height[y * w.w + x] = 9;
  assert.equal(levelCost(w, 22.5, 15.5, 4, 3), 40);
  assert.equal(levelCost(w, 22.5, 15.5, 1, 3), 0, 'a small circle misses the bump');
  const g = headless(w);
  const tips: string[] = [];
  g.ui.cursorTip = (_x: number, _y: number, html: string) => tips.push(html);
  w.city.funds = 50000;
  g.setTool('level');
  g.brush.radius = 4;
  g.pointerMove(22.5, 15.5, 0, 0);
  assert.match(tips.at(-1)!.replace(/<[^>]+>/g, ''), /^Hold to level · about \$40 to flatten this circle · /);
  g.pointerDown(22.5, 15.5, 0, 0);
  for (let t = 0; t < 120; t++) g.brushTick(1 / 30);
  g.pointerUp(22.5, 15.5, 0, 0);
  assert.ok(Math.abs(50000 - w.city.funds - 40) < 0.5, `spent $${50000 - w.city.funds}`);
  assert.equal(home.kind, 'res');
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
  // Real earth moved says what it cost, as a sentence like every other toast.
  for (let i = 0; i < w.n; i++) w.height[i] = 4 + (i % 3);
  g.pointerDown(20.5, 15.5, 0, 0);
  for (let t = 0; t < 10; t++) g.brushTick(1 / 30);
  g.pointerUp(20.5, 15.5, 0, 0);
  assert.match(g.toasts.filter((t: string) => t.startsWith('Levelled')).join(), /^Levelled for \$[\d,]+\.$/);
});

await test('a price says what else it takes in as one clause: bridges, then grading, then clearing', () => {
  const text = (p: Parameters<typeof priceIncludes>[0], line = false, power = false) => priceIncludes(p, line, power).replace(/<[^>]+>/g, '');
  assert.equal(text({}), '');
  assert.equal(text({ grading: 105, clearing: 2, clears: 'trees' }), ', with $105 to level the ground and $2 to clear trees');
  assert.equal(text({ grading: 40 }, true), ', with $40 to grade the slope');
  assert.equal(text({ bridges: 3, bridgeCost: 150, grading: 40, clearing: 6, clears: 'trees' }, true), ', with 3 bridge tiles ($150), $40 to grade the slope and $6 to clear trees');
  assert.equal(text({ bridges: 1, bridgeCost: 50 }, true, true), ', with 1 tile over water ($50)');
  assert.equal(text({ clearing: 1240, clears: 'trees and rubble' }), ', with $1,240 to clear trees and rubble');
  // The dollar figures stay in the figures' face.
  assert.equal((priceIncludes({ grading: 105, clearing: 2, clears: 'trees' }, false, false).match(/<span class="num">\$[\d,]+<\/span>/g) ?? []).length, 2);
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
    funding: { police: tag, fire: 0.5, transport: 2 }, history: { ...s.city.history, res: [tag, 5, null] }, scenario: { id: 'monster', end: tag, done: tag } };
  const c = World.deserialize({ ...s, city: city as never }).city;
  assert.equal(c.name, `Harbour ${tag}`); // a name can be any text; the dialogs escape it
  assert.equal(c.tax, 7);
  assert.equal(c.disasters, true);
  assert.equal(c.funds, 20000);
  assert.equal(c.month, 18);
  assert.equal(c.loan, 0);
  assert.equal(c.id, undefined); // not an id Terraville makes, so it never reaches a Drive query
  assert.deepEqual(c.funding, { police: 1, fire: 0.5, transport: 1 });
  assert.deepEqual(c.history.res, [0, 5, 0]);
  assert.deepEqual(c.scenario, { id: 'monster', end: 0, done: '' });
  assert.equal(World.deserialize({ ...s, city: { ...s.city, name: 12345 } as never }).city.name, 'New City');

  // A real city comes back exactly as it was saved, along with anything a later version adds.
  const w = flat();
  Object.assign(w.city, { id: 'k3j2h1abc9', name: 'Riverton', tax: 9, funds: -1250, month: 655, loan: 20000, classReached: 3, seed: 'river-oak-3', disasters: true });
  w.city.funding.fire = 0.55;
  w.city.history.res.push(10, 20, 35);
  w.city.scenario = { id: 'monster', end: 840, done: 'won', decided: 838, closed: true };
  (w.city as unknown as Record<string, unknown>).later = { kept: true };
  assert.deepEqual(World.deserialize(JSON.parse(JSON.stringify(w.serialize()))).city, w.city);
});

await test('history keeps traffic, approval, score and power each month, on the scales the goals and report use', () => seeded(7, () => {
  const w = flat();
  w.place('coal', 2, 2);
  for (let x = 0; x < 40; x++) w.setNet(ROAD, x, 8);
  for (let x = 6; x < 30; x++) w.setNet(POWER, x, 6);
  for (let x = 6; x < 30; x += 3) w.place(x < 15 ? 'res' : x < 24 ? 'com' : 'ind', x, 9);
  const sim = new Sim(w);
  const goal = (id: string) => SCENARIOS.find((x) => x.id === id)!.check(sim);
  const h = w.city.history;
  for (let m = 0; m < 14; m++) {
    for (let k = 0; k < 4; k++) sim.step();
    const s = sim.stats;
    assert.deepEqual(
      [h.res.at(-1), h.traffic.at(-1), h.pollution.at(-1), h.crime.at(-1), h.approval.at(-1), h.score.at(-1), h.powerUsed.at(-1), h.powerMade.at(-1)],
      // Traffic and pollution as Gridlock and Smog Valley read them for their goals.
      [s.residents, Number(goal('gridlock').rows[0].value), Number(goal('smog').rows[0].value), Math.round((s.avgCrime / 255) * 100), Math.round(s.approval), s.score, s.powerDemand, s.powerSupply],
    );
  }
  // Every series gets a value each month, and the residents are kept once.
  assert.deepEqual(Object.keys(h).sort(), ['approval', 'com', 'crime', 'expense', 'funds', 'income', 'ind', 'pollution', 'powerMade', 'powerUsed', 'res', 'score', 'traffic']);
  for (const [k, v] of Object.entries(h)) assert.equal(v.length, 14, k);
  assert.equal(h.powerMade.at(-1), 700);
  // A city saved before these were kept opens with them empty, and they start from its next month end.
  const old = JSON.parse(JSON.stringify(w.serialize()));
  for (const k of ['traffic', 'approval', 'score', 'powerUsed', 'powerMade']) delete old.city.history[k];
  const back = World.deserialize(old);
  assert.deepEqual([back.city.history.traffic, back.city.history.approval, back.city.history.score], [[], [], []]);
  assert.equal(back.city.history.res.length, 14);
  const again = new Sim(back);
  for (let k = 0; k < 4; k++) again.step();
  assert.deepEqual([back.city.history.res.length, back.city.history.traffic.length, back.city.history.powerMade.length], [15, 1, 1]);
}));

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
  assert.deepEqual(t, { ...base, hills: 100, rivers: 3, forest: 12, shaped: false });
  const real = { ...base, style: 'island' as const, water: 45, hills: 30, rough: 0, rivers: 6, lakes: 100, seed: 'monster-bay-2', shaped: true };
  assert.deepEqual(cleanTerrain(JSON.parse(JSON.stringify(real)), base), real);
  // Land shaped by hand says so only when the code says exactly that, whatever the settings it replaces said.
  assert.equal(cleanTerrain({ shaped: 'yes' }, { ...base, shaped: true }).shaped, false);
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

await test('a compressed save that finishes after a later one never puts the older city back, here or in Drive', async () => {
  const glob = globalThis as unknown as { window?: unknown; CompressionStream: unknown };
  const real = glob.CompressionStream;
  // Compression that finishes only when the test says, so two saves can finish in either order.
  const gates: (() => void)[] = [];
  glob.CompressionStream = class extends TransformStream<Uint8Array, Uint8Array> {
    constructor() {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      gates.push(open);
      super({ async transform(chunk, c) { await gate; c.enqueue(chunk); } });
    }
  };
  glob.window = { localStorage: memStorage() };
  try {
    const w = flat(40, 30);
    w.city.founded = true;
    const g = headless(w);
    const pushed: number[] = [];
    g.drive = { push: (_code: string, meta: { date: number }) => pushed.push(meta.date) };
    const slot = () => ({ date: listSlots()[0]?.date, code: readCode(citySlot(w.city.id!))?.slice(0, 5) });
    // The year-end autosave begins compressing, and the page is hidden half a year of play later, before it finishes.
    w.city.month = 12;
    const yearEnd = g.saveCity();
    w.city.month = 18;
    assert.equal(g.saveCityNow(), true);
    gates[0]();
    assert.equal(await yearEnd, true);
    assert.deepEqual(slot(), { date: 18, code: 'TV1j:' });
    // Two compressed saves finishing the other way round: the later one stays, and only it goes to Drive.
    w.city.month = 24;
    const first = g.saveCity();
    w.city.month = 30;
    const second = g.saveCity();
    gates[2]();
    assert.equal(await second, true);
    gates[1]();
    assert.equal(await first, true);
    assert.deepEqual([slot(), pushed], [{ date: 30, code: 'TV1g:' }, [12, 30]]);
    // Saves go on as usual after.
    w.city.month = 36;
    const next = g.saveCity();
    gates[3]();
    assert.equal(await next, true);
    assert.deepEqual([slot().date, pushed], [36, [12, 30, 36]]);
  } finally {
    glob.CompressionStream = real;
    delete glob.window;
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

await test("Delete everywhere puts every device's copy of a city in the Drive trash, and leaves the other cities", async () => {
  const server = new FakeDrive();
  server.valid.add('a1');
  const mk = (id: string, label: string) => new Drive({
    fetch: server.fetch as typeof fetch, storage: memStorage(), now: () => 1_000_000, device: { id, label }, origin: 'https://junkdrawer.works', loadGis: async () => fakeGis(() => 'a1'),
  });
  const settle = async (d: Drive) => {
    for (let i = 0; i < 40 && (d.pending || d.status() === 'busy'); i++) await tick();
  };
  const up = async (d: Drive, code: string, city: string, name: string, saved: number) => {
    d.push(code, { city, name, pop: 100, date: 5, saved });
    await settle(d);
  };
  const [a, b] = [mk('deva', 'Mac'), mk('devb', 'iPhone')];
  for (const d of [a, b]) {
    d.connect();
    await tick();
    d.connect();
  }
  await up(a, 'TV1g:riverton-mac', 'riv', 'Riverton', 10);
  await up(a, 'TV1g:lakeside-mac', 'lak', 'Lakeside', 11);
  await up(b, 'TV1g:riverton-iphone', 'riv', 'Riverton', 12);
  const live = () => [...server.files.values()].filter((f) => f.content && !f.trashed).map((f) => f.content).sort();
  assert.deepEqual(live(), ['TV1g:lakeside-mac', 'TV1g:riverton-iphone', 'TV1g:riverton-mac']);
  await a.remove('riv');
  assert.deepEqual(live(), ['TV1g:lakeside-mac'], "the iPhone's copy went too");
  assert.ok([...server.files.values()].some((f) => f.appProperties.terraville === 'folder' && !f.trashed), 'the folder stays for the others');
  assert.deepEqual((await b.list()).map((c) => c.name), ['Lakeside']);
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

await test('history axes label each tick as precisely as the step, and never repeat a label', () => {
  const labels = (min: number, max: number, o: { zero?: boolean; whole?: boolean }, money = false) => {
    const a = chartAxis(min, max, o);
    return a.ticks.map((v) => tickLabel(v, a, money));
  };
  // City funds between $25,000 and $27,000: steps of $500, which once read '$25k, $26k, $26k, $27k, $27k'.
  assert.deepEqual(labels(25000, 27000, { whole: true }, true), ['$25k', '$25.5k', '$26k', '$26.5k', '$27k']);
  // Residents to 15,000: thousands on every tick, not '5,000' beside '10k'.
  assert.deepEqual(labels(0, 15000, { zero: true, whole: true }), ['0', '5k', '10k', '15k']);
  assert.deepEqual(labels(0, 3200, { zero: true, whole: true }), ['0', '1,000', '2,000', '3,000', '4,000']);
  // Nobody yet: whole numbers in steps of at least 1, not '1 1 1 0 0 0'.
  assert.deepEqual(labels(0, 0, { zero: true, whole: true }), ['0', '1', '2', '3', '4']);
  assert.deepEqual(labels(0, 1, { zero: true, whole: true }), ['0', '1']);
  // A flat $20,000 for months: distinct ticks around it.
  const flat = labels(20000, 20000, { whole: true }, true);
  assert.equal(new Set(flat).size, flat.length);
  assert.ok(flat.includes('$20k'));
  assert.deepEqual(labels(-1200, 800, { zero: true, whole: true }, true), ['−$1,500', '−$1,000', '−$500', '$0', '$500', '$1,000']);
});

await test('line-end labels that would run below the chart are pushed up, not piled at the bottom', () => {
  // Three series all ending at zero, at the bottom edge (y = 100): they once all landed on 100.
  assert.deepEqual(spreadLabels([100, 100, 100], 0, 100, 13), [74, 87, 100]);
  // Apart already: left alone, in the order given.
  assert.deepEqual(spreadLabels([60, 10, 35], 0, 100, 13), [60, 10, 35]);
  assert.deepEqual(spreadLabels([50, 52], 0, 100, 13), [50, 63]);
});

await test("the RCI meter's card puts each bar in words, says when a landmark holds one, and what taxes do to all three", () => {
  const none = { res: false, com: false, ind: false };
  const w = demandWords({ r: 0.6, c: 0.1, i: -0.1 }, 7, none);
  assert.deepEqual(w.lines.map((l) => `${l.label}: ${l.text}`), ['Homes: strong demand, zone more residential', 'Shops: some demand', 'Factories: too many']);
  assert.equal(demandWords({ r: 0.09, c: -0.09, i: 0.45 }, 7, none).lines.map((l) => l.text).join(' / '), 'about enough / about enough / strong demand, zone more industrial');
  assert.equal(w.tax, 'Taxes at 7% leave all three as they are. Each point above 7% pulls them down.');
  assert.equal(demandWords({ r: 0, c: 0, i: 0 }, 11, none).tax, 'Taxes at 11% pull all three down: each point above 7% does.');
  assert.equal(demandWords({ r: 0, c: 0, i: 0 }, 5, none).tax, 'Taxes at 5% push all three up: each point below 7% does.');
  // A landmark limit holds the bar down whatever demand would be: the card says what lifts it.
  const held = demandWords({ r: 0.6, c: 0.6, i: 0.6 }, 7, { res: true, com: false, ind: true }).lines.map((l) => l.text);
  assert.deepEqual(held, ['held at 18,000 residents until the city builds a stadium', 'strong demand, zone more commercial', 'held at 4,000 jobs until the city builds a seaport']);
});

await test('a picture of the city takes in what is built with a margin and room for its sign, as sharp as its size allows', () => {
  const w = flat(120, 100);
  assert.deepEqual(builtArea(w), { x0: 0, y0: 0, x1: 120, y1: 100 }, 'nothing built: the whole map');
  w.place('res', 40, 30);
  w.place('com', 70, 50);
  applyLine(w, ROAD, planLine(w, ROAD, linePath(40, 33, 72, 33)));
  // Tiles 40-72 across and 30-52 down, 4 tiles of margin round them, and a seventh of the shorter side below for the sign.
  assert.deepEqual(builtArea(w), { x0: 36, y0: 26, x1: 77, y1: 62 });
  // A cottage alone: a small town's worth of map round it, kept on the map at its corner.
  const lone = flat(120, 100);
  lone.place('res', 0, 0);
  assert.deepEqual(builtArea(lone), { x0: 0, y0: 0, x1: 32, y1: 28 });
  // A Classic map whole at 19 px a tile, 2,280 by 1,900; a Large one at 13; a small town as sharp as the street view.
  assert.deepEqual([pictureScale(120, 100), pictureScale(180, 150), pictureScale(41, 35)], [19, 13, 32]);
  assert.equal(pictureName('Mapleford', 49 * 12 + 4), 'Mapleford, May 1949.jpg');
  assert.equal(pictureName('A/B: "C"', 0), 'A B C, Jan 1900.jpg');
});

await test('figures read with commas whatever language the browser speaks, and nothing in src/ asks the browser for its own', () => {
  assert.equal(num(33608), '33,608');
  assert.equal(num(-1234.6), '-1,235');
  assert.equal(num(700), '700');
  // An old save says the day it was made the same way for everyone.
  assert.match(ago(Date.UTC(2025, 2, 14, 12)), /^on 1[345] Mar 2025$/);
  // toLocaleString() with no argument writes 33.608 in a German browser, beside the copy's 45,000.
  const bare: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.ts$/.test(f.name)) {
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/\.toLocale(Date|Time)?String\(\s*\)/.test(line)) bare.push(`${p}:${i + 1}`);
        });
      }
    }
  };
  walk(join(process.cwd(), 'src'));
  assert.deepEqual(bare, [], 'use num() from defs.ts, and ago() or dateLabel() for dates');
});

console.log(`\n${passed} passed`);

// Headless balance run: a tidy grid city, simulated for decades.
// Usage: node run-test.mjs test/balance.ts [years] [tax] [upgrades] [seed=N]
//   upgrades: buy each landmark upgrade as soon as the city can afford it and keep $10,000 back.
//   seed=N: the same run every time, for comparing before and after a change.
import { World } from '../src/world';
import { Sim, spending } from '../src/sim';
import { ROAD, POWER, nextUpgrade } from '../src/defs';
import { makeRng } from '../src/rng';

const seed = process.argv.find((a) => a.startsWith('seed='));
if (seed) Math.random = makeRng(Number(seed.slice(5)));
const args = process.argv.slice(2).filter((a) => !a.startsWith('seed='));
const years = Number(args[0] ?? 30);
const tax = Number(args[1] ?? 7);
const upgrades = args[2] === 'upgrades';
const W = 120, H = 100;
const world = new World(W, H);
world.height.fill(5);
world.city.founded = true;
world.city.disasters = false;
world.city.funds = 20000;
world.city.tax = tax;
const x0 = 20, y0 = 16, x1 = 100, y1 = 84;
for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
  if ((x - x0) % 4 === 0 || (y - y0) % 4 === 0) world.setNet(ROAD, x, y);
  if ((y - y0) % 4 === 0) world.setNet(POWER, x, y);
}
for (let y = 0; y < H; y++) for (let x = 0; x < 3; x++) { world.water[y * W + x] = 1; world.height[y * W + x] = -5; }
world.place('seaport', 3, 40);
world.place('airport', 104, 20);
world.place('stadium', 104, 40);
world.place('police', 104, 50); world.place('fire', 104, 60); world.place('police', 10, 60); world.place('fire', 10, 70);
world.place('coal', x0 - 5, y0);
world.place('nuclear', x0 - 5, y0 + 30);
// Enough for every zone at full density (3,060 MW), so the grid never caps the city.
world.place('nuclear', x0 - 5, y0 + 6);
for (let y = y0; y < y0 + 36; y++) world.setNet(POWER, x0 - 1, y);
let k = 0;
for (let by = y0 + 1; by + 3 <= y1; by += 4) for (let bx = x0 + 1; bx + 3 <= x1; bx += 4) {
  const col = Math.floor((bx - x0) / 4);
  const kind = col < 4 ? 'ind' : col % 3 === 0 ? 'com' : 'res';
  if (world.canPlace(kind, bx, by).ok) { world.place(kind, bx, by); k++; }
}
const sim = new Sim(world);
console.log('zones', k);
let msgs = 0;
sim.on((e) => { if (e.type === 'message') msgs++; });
for (let m = 0; m < years * 12; m++) {
  for (let wk = 0; wk < 4; wk++) sim.step();
  if (upgrades) {
    const landmarks = [...world.buildings.values()].filter((b) => nextUpgrade(b)).sort((a, b) => nextUpgrade(a)!.cost - nextUpgrade(b)!.cost);
    const b = landmarks[0];
    if (b && world.city.funds >= nextUpgrade(b)!.cost + 10000) {
      const up = nextUpgrade(b)!;
      world.city.funds -= up.cost;
      world.setLevel(b, b.level + 1);
      console.log(`y${((m + 1) / 12).toFixed(1)} bought ${up.name} for $${up.cost.toLocaleString()}`);
    }
  }
  if ((m + 1) % 24 === 0) {
    const s = sim.stats, d = world.city.demand, b = s.lastBudget;
    const exp = spending(b);
    console.log(`y${String((m + 1) / 12).padStart(3)} pop ${String(s.residents).padStart(7)} com ${String(s.comJobs).padStart(6)} ind ${String(s.indJobs).padStart(6)} funds ${String(Math.round(world.city.funds)).padStart(7)} inc/mo ${String(Math.round(b.taxIncome)).padStart(5)} exp/mo ${String(Math.round(exp)).padStart(4)} R${d.r.toFixed(2)} C${d.c.toFixed(2)} I${d.i.toFixed(2)} lv ${s.avgLandValue.toFixed(0)} pol ${s.avgPollution.toFixed(0)} crime ${s.avgCrime.toFixed(0)} traf ${s.avgTraffic.toFixed(0)} appr ${s.approval.toFixed(0)} unpow ${s.unpowered} notrip ${s.noTrip} ${s.cityClass}`);
    if (s.unpowered > 0) console.log(`     warning: ${s.unpowered} zones have no power (${s.powerDemand} MW wanted, ${s.powerSupply} MW made), so the grid, not the city, is the limit`);
  }
}
console.log('messages', msgs, sim.messages.slice(-6).map(m => m.text));

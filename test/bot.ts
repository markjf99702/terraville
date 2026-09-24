// A simple player bot: grows a city block by block from starting funds,
// zoning whatever the RCI meter asks for. Prints a yearly summary.
// Usage: node run-test.mjs test/bot.ts [years] [difficulty]
import { World } from '../src/world';
import { Sim } from '../src/sim';
import { BUILDINGS, DIFFICULTIES, Kind, ROAD, POWER } from '../src/defs';
import { linePath, planLine, applyLine } from '../src/tools';

const years = Number(process.argv[2] ?? 30);
const diffId = (process.argv[3] ?? 'easy') as 'easy' | 'medium' | 'hard';
const W = 120, H = 100;
const world = new World(W, H);
world.height.fill(4);
for (let y = 0; y < H; y++) for (let x = 0; x < 4; x++) { world.water[y * W + x] = 1; world.height[y * W + x] = -4; }
const diff = DIFFICULTIES.find((d) => d.id === diffId)!;
world.city.founded = true;
world.city.disasters = false;
world.city.difficulty = diff.id;
world.city.funds = diff.funds;
const sim = new Sim(world);

const spend = (c: number) => { world.city.funds -= c; };
const buildLine = (bit: number, x0: number, y0: number, x1: number, y1: number) => {
  const plan = planLine(world, bit, linePath(x0, y0, x1, y1));
  if (plan.cost > world.city.funds) return false;
  applyLine(world, bit, plan); spend(plan.cost); return true;
};
const place = (k: Kind, x: number, y: number) => {
  if (!world.canPlace(k, x, y).ok || BUILDINGS[k].cost > world.city.funds) return false;
  world.place(k, x, y); spend(BUILDINGS[k].cost); return true;
};

// City grid origin; blocks are 3x3 lots between roads every 4 tiles.
const ox = 20, oy = 12;
const blocks: [number, number][] = [];
for (let r = 0; r < 20; r++) for (let c = 0; c < 22; c++) blocks.push([c, r]);
// Spiral-ish order: nearest to the centre first.
const cc = 0, cr = 0;
blocks.sort((a, b) => Math.hypot(a[0] - cc, a[1] - cr) - Math.hypot(b[0] - cc, b[1] - cr));
let next = 0;
place('coal', 10, 14);
buildLine(POWER, 14, 15, ox, 15);
let plants = 1;
const civic: Kind[] = [];

function zoneNext(kind: Kind): boolean {
  while (next < blocks.length) {
    const [c, r] = blocks[next];
    const bx = ox + c * 4 + 1, by = oy + r * 4 + 1;
    if (bx + 4 >= W || by + 4 >= H) { next++; continue; }
    const need = 4 * 10 * 2 + 100 + 30;
    if (world.city.funds < need) return false;
    buildLine(ROAD, bx - 1, by - 1, bx + 3, by - 1);
    buildLine(ROAD, bx - 1, by + 3, bx + 3, by + 3);
    buildLine(ROAD, bx - 1, by - 1, bx - 1, by + 3);
    buildLine(ROAD, bx + 3, by - 1, bx + 3, by + 3);
    buildLine(POWER, bx - 1, by - 1, bx + 3, by - 1);
    buildLine(POWER, bx - 1, by - 1, bx - 1, by + 3);
    next++;
    return place(kind, bx, by);
  }
  return false;
}

for (let m = 0; m < years * 12; m++) {
  for (let wk = 0; wk < 4; wk++) sim.step();
  const s = sim.stats, d = world.city.demand;
  // Zone for demand, a few lots a month at most.
  for (let k = 0; k < 3; k++) {
    const want: [Kind, number][] = [['res', d.r], ['com', d.c], ['ind', d.i]];
    want.sort((a, b) => b[1] - a[1]);
    const [kind, v] = want[0];
    const vacant = s.vacant[kind as 'res' | 'com' | 'ind'];
    if (v > 0.1 && vacant < 3) zoneNext(kind); else break;
  }
  if (s.powerDemand > s.powerSupply * 0.85 && world.city.funds > 3500) {
    for (let t = 0; t < 40; t++) { const x = 5 + (t % 3) * 5, y = 20 + plants * 5 + Math.floor(t / 3) * 5; if (place('coal', x, y)) { buildLine(POWER, x + 4, y + 1, ox, y + 1); plants++; break; } }
  }
  const civicWant: [Kind, number][] = [['police', 2500], ['fire', 3000], ['school', 6000], ['hospital', 12000], ['stadium', 17000], ['police', 15000], ['fire', 18000]];
  for (const [k, pop] of civicWant) {
    if (s.residents > pop && civic.filter((c) => c === k).length < civicWant.filter(([c, p]) => c === k && p <= s.residents).length) {
      if (zoneNext(k)) civic.push(k);
    }
  }
  if ((m + 1) % 36 === 0) {
    const b = s.lastBudget;
    const exp = b.transport + b.police + b.fire + b.services + b.power + b.interest;
    console.log(`y${String((m + 1) / 12).padStart(3)} pop ${String(s.residents).padStart(6)} jobs ${String(s.comJobs + s.indJobs).padStart(6)} zones ${s.zones.res}/${s.zones.com}/${s.zones.ind} funds ${String(Math.round(world.city.funds)).padStart(7)} +${Math.round(b.taxIncome)} -${Math.round(exp)} R${d.r.toFixed(2)} C${d.c.toFixed(2)} I${d.i.toFixed(2)} lv ${s.avgLandValue.toFixed(0)} traf ${s.avgTraffic.toFixed(0)} pol ${s.avgPollution.toFixed(0)} crime ${s.avgCrime.toFixed(0)} appr ${s.approval.toFixed(0)} unpow ${s.unpowered} notrip ${s.noTrip} ${s.cityClass}`);
  }
}

// Challenges: a ready-made city in trouble, a goal, and a deadline.
// A nod to the original's scenarios, with procedurally built cities.
import { BUILDINGS, Kind, POWER, RAIL, ROAD } from './defs';
import { Rng, makeRng, hashString } from './rng';
import { Sim } from './sim';
import { DEFAULT_TERRAIN, TerrainParams, generateTerrain } from './terrain';
import { World, newCityState } from './world';

export interface GoalState {
  /** 0-1 towards the goal. */
  progress: number;
  /** Short status such as "Traffic 62 of 40". */
  status: string;
  met: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  year: number;
  years: number;
  funds: number;
  blurb: string;
  goal: string;
  /** Win as soon as the goal is met, or only judge at the deadline. */
  kind: 'reach' | 'hold';
  terrain: Partial<TerrainParams>;
  city?: CityPlan;
  check(sim: Sim): GoalState;
  start?(sim: Sim): void;
  monthly?(sim: Sim): void;
}

interface CityPlan {
  /** Radius of the built-up area in blocks. */
  radius: number;
  /** Share of blocks by kind from the centre outward. */
  mix: (d: number, rng: Rng, side: number) => Kind | null;
  /** Density level from 0 (centre) to 1 (edge). */
  level: (kind: Kind, d: number, rng: Rng) => number;
  plants: Kind[];
  police: number;
  fire: number;
  rail?: boolean;
  extras?: Kind[];
  /** Roads around 2x2 groups of lots instead of every lot: fewer, busier streets. */
  superblocks?: boolean;
}

const idx = (v: number) => Math.round((v / 255) * 100);

export const SCENARIOS: Scenario[] = [
  {
    id: 'boomtown',
    name: 'Boomtown',
    year: 1900,
    years: 15,
    funds: 12000,
    blurb: 'A railway company has promised a station if a real town appears on this empty coast. Investors are watching.',
    goal: 'Reach 12,000 residents within 15 years.',
    kind: 'reach',
    terrain: { seed: 'boomtown-coast-7', style: 'coast', hills: 30, water: 35 },
    check: (sim) => {
      const r = sim.stats.residents;
      return { progress: Math.min(1, r / 12000), status: `${r.toLocaleString()} of 12,000 residents`, met: r >= 12000 };
    },
  },
  {
    id: 'gridlock',
    name: 'Gridlock',
    year: 1955,
    years: 6,
    funds: 25000,
    blurb: 'Everyone drives downtown and nobody gets there. Commuters sit in traffic for hours, and the council wants it fixed before the next election.',
    goal: 'Bring the traffic index below 30 while keeping at least 30,000 residents.',
    kind: 'hold',
    terrain: { seed: 'gridlock-plain-3', style: 'lakes', hills: 15, lakes: 15, forest: 25 },
    city: {
      radius: 5,
      superblocks: true,
      mix: (d, rng) => (d < 1.6 ? 'com' : d < 2.4 && rng() < 0.35 ? 'com' : d > 4.2 && rng() < 0.4 ? 'ind' : 'res'),
      level: (k, d, rng) => (k === 'com' ? (d < 1 ? 5 : 4) : k === 'res' ? Math.max(4, Math.round(7.2 - d * 0.6 + rng() - 0.5)) : 3 + Math.round(rng())),
      plants: ['coal', 'coal', 'coal'],
      police: 3,
      fire: 3,
      extras: ['stadium'],
    },
    check: (sim) => {
      const t = idx(sim.stats.avgTraffic);
      const r = sim.stats.residents;
      const met = t < 30 && r >= 30000;
      return { progress: Math.max(0, Math.min(1, (70 - t) / 40)) * (r >= 30000 ? 1 : 0.5), status: `Traffic ${t} (goal under 30) · ${r.toLocaleString()} of 30,000 residents`, met };
    },
  },
  {
    id: 'smog',
    name: 'Smog Valley',
    year: 1968,
    years: 8,
    funds: 30000,
    blurb: 'Factories line the river and coal smoke fills the valley. People are leaving. Clean the air without killing the jobs.',
    goal: 'Get the pollution index below 8 with at least 20,000 residents.',
    kind: 'hold',
    terrain: { seed: 'smog-valley-5', style: 'valley', hills: 40, rivers: 1, forest: 30 },
    city: {
      radius: 6,
      mix: (d, rng, side) => (side < 0.1 && rng() < 0.7 ? 'ind' : d < 1.2 ? 'com' : rng() < 0.06 ? 'ind' : rng() < 0.12 ? 'com' : 'res'),
      level: (k, d, rng) => (k === 'ind' ? 3 + Math.round(rng()) : k === 'com' ? 3 : Math.max(3, Math.round(6.5 - d * 0.5 + rng() - 0.5))),
      plants: ['coal', 'coal', 'coal', 'coal'],
      police: 2,
      fire: 2,
      extras: ['seaport'],
    },
    check: (sim) => {
      const p = idx(sim.stats.avgPollution);
      const r = sim.stats.residents;
      return { progress: Math.max(0, Math.min(1, (30 - p) / 22)) * (r >= 20000 ? 1 : 0.5), status: `Pollution ${p} (goal under 8) · ${r.toLocaleString()} of 20,000 residents`, met: p < 8 && r >= 20000 };
    },
  },
  {
    id: 'aftershock',
    name: 'Aftershock',
    year: 1989,
    years: 8,
    funds: 20000,
    blurb: 'A major earthquake has just struck. Fires are spreading and roads are broken. The city needs a steady hand.',
    goal: 'Rebuild and grow to 55,000 residents within 8 years.',
    kind: 'reach',
    terrain: { seed: 'aftershock-bay-9', style: 'coast', hills: 35, water: 30 },
    city: {
      radius: 7,
      mix: (d, rng) => (d < 1.8 ? 'com' : d > 5.8 && rng() < 0.5 ? 'ind' : rng() < 0.12 ? 'com' : 'res'),
      level: (k, d, rng) => (k === 'com' ? (d < 1.2 ? 5 : 4) : k === 'res' ? Math.max(4, Math.round(8 - d * 0.6 + rng() - 0.5)) : 3),
      plants: ['nuclear', 'coal'],
      police: 4,
      fire: 4,
      rail: true,
      extras: ['stadium', 'airport', 'school', 'hospital'],
    },
    start: (sim) => {
      for (let k = 0; k < 3; k++) sim.disasters.trigger('earthquake');
      for (let k = 0; k < 4; k++) sim.disasters.trigger('fire');
    },
    check: (sim) => {
      const r = sim.stats.residents;
      return { progress: Math.min(1, r / 55000), status: `${r.toLocaleString()} of 55,000 residents`, met: r >= 55000 };
    },
  },
  {
    id: 'monster',
    name: 'Monster Bay',
    year: 1957,
    years: 10,
    funds: 30000,
    blurb: 'Something lives in the bay, and it is drawn to smoke. It keeps coming back. Keep the people on your side.',
    goal: 'After 10 years, have at least 25,000 residents and approval above 60%.',
    kind: 'hold',
    terrain: { seed: 'monster-bay-2', style: 'island', hills: 30, water: 45 },
    city: {
      radius: 6,
      mix: (d, rng) => (d < 1.5 ? 'com' : rng() < 0.28 ? 'ind' : 'res'),
      level: (k, d, rng) => (k === 'res' ? Math.max(3, Math.round(7 - d * 0.7 + rng() - 0.5)) : k === 'com' ? 4 : 3 + Math.round(rng())),
      plants: ['coal', 'coal'],
      police: 3,
      fire: 3,
      extras: ['seaport'],
    },
    monthly: (sim) => {
      const sc = sim.world.city.scenario;
      if (!sc) return;
      const since = sim.world.city.month - (sc.end - 10 * 12);
      if (since % 24 === 9) sim.disasters.trigger('monster');
    },
    check: (sim) => {
      const a = Math.round(sim.stats.approval);
      const r = sim.stats.residents;
      return { progress: Math.min(1, r / 25000) * Math.min(1, a / 60), status: `Approval ${a}% (goal over 60%) · ${r.toLocaleString()} of 25,000 residents`, met: a > 60 && r >= 25000 };
    },
  },
];

/** Build the scenario's world, ready to hand to a Sim. */
export function buildScenario(s: Scenario, w = 120, h = 100): World {
  const params: TerrainParams = { ...DEFAULT_TERRAIN, seed: s.id, w, h, ...s.terrain };
  const world = generateTerrain(params);
  world.city = newCityState();
  world.city.name = s.name;
  world.city.difficulty = 'medium';
  world.city.funds = s.funds;
  world.city.founded = true;
  world.city.disasters = s.id === 'monster' ? false : true;
  world.city.seed = params.seed;
  world.city.month = (s.year - 1900) * 12;
  world.city.scenario = { id: s.id, end: world.city.month + s.years * 12, done: '' };
  if (s.city) layCity(world, s.city, makeRng(hashString(s.id)));
  return world;
}

function layCity(world: World, plan: CityPlan, rng: Rng): void {
  const { w, h } = world;
  // Find the flattest dry area for the grid.
  const span = plan.radius * 2 * 4 + 1;
  let best = { x: 4, y: 4, bad: Infinity };
  for (let y = 2; y + span < h - 2; y += 2) {
    for (let x = 2; x + span < w - 2; x += 2) {
      let bad = 0;
      for (let dy = 0; dy < span; dy += 2) {
        for (let dx = 0; dx < span; dx += 2) {
          const i = (y + dy) * w + x + dx;
          if (world.water[i]) bad += 3;
          else if (world.slope(x + dx, y + dy) > 4) bad += 1;
          const cx = dx - span / 2;
          const cy = dy - span / 2;
          if (cx * cx + cy * cy > (span / 2) * (span / 2)) bad -= world.water[i] ? 3 : 0;
        }
      }
      if (bad < best.bad) best = { x, y, bad };
    }
  }
  const ox = best.x;
  const oy = best.y;
  const stride = plan.superblocks ? 7 : 4;
  const per = plan.superblocks ? 2 : 1;
  const blocks = Math.ceil((plan.radius * 2 * 4) / stride);
  const centre = blocks / 2 - 0.5;
  const scale = stride / 4;
  // Level the site gently so zones fit.
  for (let y = oy; y < oy + span && y < h; y++) {
    for (let x = ox; x < ox + span && x < w; x++) {
      const i = y * w + x;
      if (world.water[i]) continue;
      const d = Math.hypot(x - ox - span / 2, y - oy - span / 2) / (span / 2);
      if (d > 1.05) continue;
      world.height[i] = world.height[i] * 0.35 + 4 * 0.65;
      world.trees[i] = 0;
    }
  }
  const inCity = (c: number, r: number) => Math.hypot(c - centre, r - centre) * scale <= plan.radius + 0.3;
  // Roads around every block in the disc, power along each block's top and left edges.
  for (let r = 0; r < blocks; r++) {
    for (let c = 0; c < blocks; c++) {
      if (!inCity(c, r)) continue;
      const bx = ox + c * stride;
      const by = oy + r * stride;
      for (let k = 0; k <= stride; k++) {
        net(world, ROAD, bx + k, by);
        net(world, ROAD, bx + k, by + stride);
        net(world, ROAD, bx, by + k);
        net(world, ROAD, bx + stride, by + k);
        net(world, POWER, bx + k, by);
        net(world, POWER, bx, by + k);
      }
    }
  }
  // Zones and services.
  const civic: Kind[] = [];
  for (let k = 0; k < plan.police; k++) civic.push('police');
  for (let k = 0; k < plan.fire; k++) civic.push('fire');
  for (const e of plan.extras ?? []) if (BUILDINGS[e].size === 3) civic.push(e);
  const slots: { x: number; y: number; d: number; a: number }[] = [];
  for (let r = 0; r < blocks; r++) {
    for (let c = 0; c < blocks; c++) {
      if (!inCity(c, r)) continue;
      for (let j = 0; j < per; j++) {
        for (let i = 0; i < per; i++) {
          const x = ox + c * stride + 1 + i * 3;
          const y = oy + r * stride + 1 + j * 3;
          const dx = (x + 1.5 - (ox + (centre + 0.5) * stride)) / 4;
          const dy = (y + 1.5 - (oy + (centre + 0.5) * stride)) / 4;
          slots.push({ x, y, d: Math.hypot(dx, dy), a: Math.atan2(dy, dx) });
        }
      }
    }
  }
  // Spread civic buildings around a ring halfway out.
  const civicAt = new Map<number, Kind>();
  civic.forEach((k, n) => {
    const a = (n / civic.length) * Math.PI * 2 + rng() * 0.3 - Math.PI;
    let bestSlot = -1;
    let bestScore = Infinity;
    slots.forEach((sl, si) => {
      if (civicAt.has(si)) return;
      const score = Math.abs(sl.d - plan.radius * 0.55) + Math.abs(Math.atan2(Math.sin(sl.a - a), Math.cos(sl.a - a))) * 2;
      if (score < bestScore) { bestScore = score; bestSlot = si; }
    });
    if (bestSlot >= 0) civicAt.set(bestSlot, k);
  });
  const sideAngle = rng() * Math.PI * 2;
  slots.forEach((sl, si) => {
    const { x, y, d, a } = sl;
    const civ = civicAt.get(si);
    const side = (Math.cos(a - sideAngle) + 1) / 2 < 0.25 && d > plan.radius * 0.5 ? 0 : 1;
    const kind = civ ?? plan.mix(d, rng, side);
    if (!kind) return;
    clear(world, x, y, 3);
    if (!world.canPlace(kind, x, y).ok) return;
    const b = world.place(kind, x, y, (rng() * 1e9) | 0);
    if (kind === 'res' || kind === 'com' || kind === 'ind') {
      const max = kind === 'res' ? 8 : kind === 'com' ? 5 : 4;
      world.setLevel(b, Math.max(1, Math.min(max, plan.level(kind, d, rng))));
    }
  });
  // Big buildings and plants just outside the grid, wired in.
  const outside: Kind[] = [...plan.plants, ...(plan.extras ?? []).filter((e) => BUILDINGS[e].size !== 3)];
  let angle = sideAngle + Math.PI;
  const cx = ox + span / 2;
  const cy = oy + span / 2;
  for (const kind of outside) {
    const size = BUILDINGS[kind].size;
    let placed = false;
    for (let t = 0; t < 60 && !placed; t++) {
      const a = angle + (t % 12) * 0.5;
      const rad = span / 2 + 2 + size / 2 + Math.floor(t / 12) * 3;
      const x = Math.round(cx + Math.cos(a) * rad - size / 2);
      const y = Math.round(cy + Math.sin(a) * rad - size / 2);
      if (x < 1 || y < 1 || x + size >= w - 1 || y + size >= h - 1) continue;
      clear(world, x, y, size, kind === 'seaport');
      if (world.canPlace(kind, x, y).ok) {
        world.place(kind, x, y);
        // Run a power line and a road back to the grid.
        wire(world, x + Math.floor(size / 2), y + Math.floor(size / 2), cx, cy, size);
        placed = true;
        angle = a + 0.9;
      }
    }
  }
  if (plan.rail) {
    const ry = oy + Math.floor(blocks / 2) * stride + 2;
    for (let x = 1; x < w - 1; x++) if (!world.occ[ry * w + x]) net(world, RAIL, x, ry);
  }
}

function net(world: World, bit: number, x: number, y: number): void {
  if (!world.inBounds(x, y)) return;
  const i = y * world.w + x;
  if (world.occ[i]) return;
  world.net[i] |= bit;
  world.trees[i] = 0;
  world.rubble[i] = 0;
}

function clear(world: World, x: number, y: number, s: number, keepWater = false): void {
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (!world.inBounds(x + dx, y + dy)) continue;
      const i = (y + dy) * world.w + x + dx;
      if (world.water[i] && keepWater) return;
    }
  }
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (!world.inBounds(x + dx, y + dy)) continue;
      const i = (y + dy) * world.w + x + dx;
      if (world.occ[i] || world.water[i]) continue;
      world.net[i] = 0;
      world.trees[i] = 0;
    }
  }
  // Flatten the footprint enough to build.
  let sum = 0;
  let n = 0;
  for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) if (world.inBounds(x + dx, y + dy)) { sum += world.height[(y + dy) * world.w + x + dx]; n++; }
  const avg = n ? Math.max(1, sum / n) : 2;
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (!world.inBounds(x + dx, y + dy)) continue;
      const i = (y + dy) * world.w + x + dx;
      if (!world.water[i]) world.height[i] = avg;
    }
  }
}

/** Road and power from (x, y) toward the city centre until they meet the grid. */
function wire(world: World, x: number, y: number, cx: number, cy: number, size: number): void {
  const steps = Math.ceil(Math.hypot(cx - x, cy - y));
  let started = false;
  for (let k = 0; k <= steps; k++) {
    const px = Math.round(x + ((cx - x) * k) / steps);
    const py = Math.round(y + ((cy - y) * k) / steps);
    if (!world.inBounds(px, py)) continue;
    const i = py * world.w + px;
    if (world.occ[i]) {
      if (started) break;
      continue;
    }
    started = true;
    const hit = (world.net[i] & POWER) !== 0;
    net(world, POWER, px, py);
    if (!world.water[i]) net(world, ROAD, px, py);
    // Fill diagonal steps so the line stays 4-connected.
    const nx = Math.round(x + ((cx - x) * (k + 1)) / steps);
    const ny = Math.round(y + ((cy - y) * (k + 1)) / steps);
    if (nx !== px && ny !== py && world.inBounds(nx, py) && !world.occ[py * world.w + nx]) {
      net(world, POWER, nx, py);
      if (!world.water[py * world.w + nx]) net(world, ROAD, nx, py);
    }
    if (hit && k > size) break;
  }
}

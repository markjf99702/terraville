// Challenges: a ready-made city in trouble, a goal, and a deadline.
// A nod to the original's scenarios, with procedurally built cities.
import { BUILDINGS, Kind, POWER, RAIL, ROAD, isZone, num, toIndex as idx } from './defs';
import { Rng, makeRng, hashString } from './rng';
import { Sim } from './sim';
import { DEFAULT_TERRAIN, TerrainParams, generateTerrain } from './terrain';
import { World, newCityState } from './world';

/** One condition of a goal, as the tracker lists it: 'Traffic index 25 · under 28', 'Residents 17,544 / 20,000'. */
export interface GoalRow {
  label: string;
  value: string;
  /** A count to reach ('20,000'), or a line to stay on the right side of ('under 28'). */
  goal: string;
  met: boolean;
}

export interface GoalState {
  /** 0-1 towards the goal. */
  progress: number;
  /** The whole goal on one line, such as "Traffic 25 (goal under 28) · 17,544 of 20,000 residents". */
  status: string;
  met: boolean;
  /** Each condition on its own. */
  rows: GoalRow[];
  /** For a goal judged only at the deadline, when that is: 'Judged at the end of 1960'. */
  note?: string;
}

/** Whether a row is a count to reach, '17,544 / 20,000', rather than a line to stay on the right side of. */
export function isCount(r: GoalRow): boolean {
  return /^\d/.test(r.goal);
}

/** A row as one line: 'Residents 17,544 / 20,000', 'Traffic index 25 · under 28'. */
export function goalRowText(r: GoalRow): string {
  return isCount(r) ? `${r.label} ${r.value} / ${r.goal}` : `${r.label} ${r.value} · ${r.goal}`;
}

const people = num;
/** A row for a count to reach. */
const atLeast = (label: string, n: number, goal: number): GoalRow => ({ label, value: people(n), goal: people(goal), met: n >= goal });

export interface Scenario {
  id: string;
  name: string;
  year: number;
  years: number;
  funds: number;
  blurb: string;
  goal: string;
  /** What the result dialog adds after a win, and after a loss. */
  win: string;
  lose: string;
  /** Win as soon as the goal is met, or only judge at the deadline. */
  kind: 'reach' | 'hold';
  /** For a 'hold' goal: the month-ends in a row, up to the deadline, that it must be met. */
  holdMonths?: number;
  terrain: Partial<TerrainParams>;
  city?: CityPlan;
  /** The goal as things stand right now. */
  check(sim: Sim): GoalState;
  start?(sim: Sim): void;
  monthly?(sim: Sim): void;
  /** The advisor's word on the challenge's own problem, while part of the goal is failing. */
  advise?(sim: Sim): string | null;
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


export const SCENARIOS: Scenario[] = [
  {
    id: 'boomtown',
    name: 'Boomtown',
    year: 1900,
    years: 15,
    funds: 12000,
    blurb: 'A railway company has promised a station if a real town appears on this empty coast. Investors are watching.',
    goal: 'Reach 12,000 residents within 15 years.',
    win: 'The railway company keeps its word: the station opens next spring.',
    lose: 'The investors have lost interest, and the railway will go somewhere else.',
    kind: 'reach',
    terrain: { seed: 'boomtown-coast-7', style: 'coast', hills: 30, water: 35 },
    check: (sim) => {
      const r = sim.stats.residents;
      return { progress: Math.min(1, r / 12000), status: `${num(r)} of 12,000 residents`, met: r >= 12000, rows: [atLeast('Residents', r, 12000)] };
    },
  },
  {
    id: 'gridlock',
    name: 'Gridlock',
    year: 1955,
    years: 6,
    funds: 25000,
    blurb: 'Everyone drives downtown, and the streets can only just take it. The council wants a bigger city and more jobs by the next election, without the traffic grinding to a halt.',
    goal: 'Keep the traffic index under 28 with at least 20,000 residents and 10,000 jobs.',
    win: 'The streets kept moving and the council was re-elected.',
    lose: 'The council went into the election with its promise unkept, and lost.',
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
      // Jobs count too: with no jobs there are no commutes, and bulldozing them all would clear the roads.
      const j = sim.stats.comJobs + sim.stats.indJobs;
      const size = r >= 20000 && j >= 10000;
      return {
        progress: Math.max(0, Math.min(1, (40 - t) / 12)) * (size ? 1 : 0.5),
        status: `Traffic ${t} (goal under 28) · ${num(r)} of 20,000 residents · ${num(j)} of 10,000 jobs`,
        met: t < 28 && size,
        rows: [{ label: 'Traffic index', value: String(t), goal: 'under 28', met: t < 28 }, atLeast('Residents', r, 20000), atLeast('Jobs', j, 10000)],
      };
    },
    advise: (sim) => {
      const t = idx(sim.stats.avgTraffic);
      return t >= 28 ? `Traffic index ${t}: the council wants it under 28. Rail into downtown takes commuters off the streets.` : null;
    },
  },
  {
    id: 'smog',
    name: 'Smog Valley',
    year: 1968,
    years: 8,
    funds: 30000,
    blurb: 'Factories line the river and coal smoke fills the valley. People are leaving. Clean the air without killing the jobs.',
    goal: 'Keep the pollution index under 12, with at least 20,000 residents and 9,000 jobs, for the last 12 months.',
    win: 'The air in the valley is clean, and people are staying.',
    lose: 'The valley is still waiting for clean air and steady work.',
    kind: 'hold',
    holdMonths: 12,
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
      const j = sim.stats.comJobs + sim.stats.indJobs;
      const size = r >= 20000 && j >= 9000;
      return {
        progress: Math.max(0, Math.min(1, (30 - p) / 18)) * (size ? 1 : 0.5),
        status: `Pollution ${p} (goal under 12) · ${num(r)} of 20,000 residents · ${num(j)} of 9,000 jobs`,
        met: p < 12 && size,
        rows: [{ label: 'Pollution index', value: String(p), goal: 'under 12', met: p < 12 }, atLeast('Residents', r, 20000), atLeast('Jobs', j, 9000)],
      };
    },
    advise: (sim) => {
      const p = idx(sim.stats.avgPollution);
      return p >= 12 ? `Pollution index ${p} where people live: the goal is under 12.` : null;
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
    win: 'The city is back on its feet.',
    lose: 'The city came through the quake, but the rebuilding fell short.',
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
      // The quakes strike under the zones, and neither they nor the fires touch the power plants: a
      // meltdown before the first click would be no fair start. One line says it all, at the first quake.
      let at: { x: number; y: number } | undefined;
      for (let k = 0; k < 3; k++) {
        sim.disasters.trigger('earthquake', { sparePlants: true, quiet: true });
        at ??= sim.disasters.lastQuake ?? undefined;
      }
      for (let k = 0; k < 4; k++) sim.disasters.trigger('fire', { sparePlants: true, quiet: true });
      sim.say('quake', 'A major earthquake and two aftershocks have struck. Check for fires and broken roads.', 'alert', at, 0);
    },
    check: (sim) => {
      const r = sim.stats.residents;
      return { progress: Math.min(1, r / 55000), status: `${num(r)} of 55,000 residents`, met: r >= 55000, rows: [atLeast('Residents', r, 55000)] };
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
    win: 'The monster still comes, and the city stands with you.',
    lose: 'The monster wore the city down before the deadline.',
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
      return {
        progress: Math.min(1, r / 25000) * Math.min(1, a / 60),
        status: `Approval ${a}% (goal over 60%) · ${num(r)} of 25,000 residents`,
        met: a > 60 && r >= 25000,
        rows: [{ label: 'Approval', value: `${a}%`, goal: 'over 60%', met: a > 60 }, atLeast('Residents', r, 25000)],
      };
    },
    // Said as it comes ashore (it stays about 30 weeks, so within the last month), once a visit.
    advise: (sim) => (sim.disasters.roamers.some((r) => r.kind === 'monster' && r.weeks >= 26) ? 'The monster heads for the smokiest spot in town.' : null),
  },
];

/**
 * A challenge's month end: its events for the month, then its goal. A goal that must hold to the end counts the
 * month-ends in a row it has been met, on the city, so the count survives a save.
 */
export function scenarioMonth(s: Scenario, sim: Sim): GoalState {
  const sc = sim.world.city.scenario;
  if (sc && !sc.done) s.monthly?.(sim);
  const now = s.check(sim);
  if (sc && !sc.done && s.holdMonths) sc.held = now.met ? (sc.held ?? 0) + 1 : 0;
  return goalState(s, sim, now);
}

/**
 * The advisor on a challenge, at a month end before the deadline: a year and three months before it, how things
 * stand; and while part of the goal is failing, the challenge's own advice, at most every six months.
 */
export function scenarioNews(s: Scenario, sim: Sim, st: GoalState): void {
  const sc = sim.world.city.scenario;
  if (!sc || sc.done) return;
  const left = sc.end - sim.world.city.month;
  const short = st.rows.filter((r) => !r.met);
  const stand = short.length ? ` Not met yet: ${short.map(goalRowText).join(', ')}.` : ' The goal is met for now.';
  if (left === 12) {
    const text = s.holdMonths ? 'One year left: the goal must hold from now to the end.'
      : s.kind === 'hold' ? `One year left: the goal is judged at the end of ${lastYear(sc.end)}.${stand}` : `One year left.${stand}`;
    sim.say('deadline', text, short.length ? 'warn' : 'info', undefined, 0);
  } else if (left === 3) {
    sim.say('deadline', `Three months left.${stand}`, short.length ? 'warn' : 'info', undefined, 0);
  }
  const line = s.advise?.(sim);
  if (line) sim.say(`advise-${s.id}`, line, 'warn', undefined, 6);
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/**
 * How a lost challenge is told in the news: the first condition that was not met, as the goal tracker words it:
 * 'Time ran out for Smog Valley. Pollution 14 (goal under 12).'
 */
export function timeUpLine(s: Scenario, st: GoalState): string {
  const parts = st.status.split(' · ');
  const part = parts[Math.max(0, st.rows.findIndex((r) => !r.met))] ?? parts[0];
  return `Time ran out for ${s.name}. ${part[0].toUpperCase()}${part.slice(1)}.`;
}

/** How a won challenge is announced: the year, and how far ahead of its deadline, at month index `month`. */
export function successLine(s: Scenario, month: number, end: number): string {
  const left = end - month;
  const count = (n: number, unit: string) => `${NUMBER_WORDS[n] ?? n} ${unit}${n === 1 ? '' : 's'}`;
  const early = left >= 12 ? `, ${count(Math.floor(left / 12), 'year')} early` : left > 0 ? `, ${count(left, 'month')} early` : '';
  return `${s.name} is a success in ${1900 + Math.floor(month / 12)}${early}.`;
}

/** The last year of a challenge, the one whose end is its deadline. */
export function lastYear(end: number): number {
  return 1900 + Math.floor((end - 1) / 12);
}

/**
 * The goal as the tracker shows it. A goal judged at the deadline says when; one that must hold for its last months
 * counts only the month-ends inside them toward being met, so it can't read as won years early.
 */
export function goalState(s: Scenario, sim: Sim, now = s.check(sim)): GoalState {
  const sc = sim.world.city.scenario;
  if (s.kind !== 'hold' || !sc) return now;
  const note = `Judged at the end of ${lastYear(sc.end)}`;
  if (!s.holdMonths) return { ...now, note };
  const need = s.holdMonths;
  const held = sc.held ?? 0;
  // The month-ends of the final stretch so far: none before it begins, all of them at the deadline.
  const inside = Math.max(0, Math.min(need, need - (sc.end - sim.world.city.month)));
  const counted = Math.min(held, inside);
  return {
    met: now.met && counted >= need,
    progress: now.met ? 0.5 + (0.5 * counted) / need : now.progress * 0.5,
    status: `${now.status} · held ${counted} of ${need} months`,
    rows: [...now.rows, { label: 'Held', value: `${held} month${held === 1 ? '' : 's'} in a row`, goal: `must hold through ${lastYear(sc.end)}`, met: counted >= need }],
    note,
  };
}

/**
 * Settle a challenge city as it opens: the month-end maps worked out, and every lot brought down to the density its
 * land value holds, so the city doesn't start out by shrinking. The challenge's own opening events come after.
 */
export function openScenario(sim: Sim): void {
  const passes = () => {
    for (let k = 0; k < 3; k++) {
      sim.computeTraffic();
      sim.computeMaps();
    }
  };
  passes();
  // Thinning some lots moves traffic and pollution about, which can lower land value elsewhere: settle in rounds.
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const b of sim.world.buildings.values()) {
      if (!isZone(b.kind)) continue;
      const max = sim.maxLevel(b);
      if (b.level > max) {
        sim.world.setLevel(b, max);
        changed = true;
      }
    }
    if (!changed) break;
    passes();
  }
  sim.tally();
  // Thinning the lots is how the city was laid out, not people leaving: it opens with no "Last month" loss.
  sim.lastPop = sim.stats.residents;
  sim.evaluate();
}

/** Build the scenario's world, ready to hand to a Sim. */
export function buildScenario(s: Scenario, w = 120, h = 100): World {
  // The land the challenge cities were laid out on, whatever the generator has learned since.
  const params: TerrainParams = { ...DEFAULT_TERRAIN, seed: s.id, w, h, ...s.terrain, classic: true };
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

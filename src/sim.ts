// The city simulation. One step is one week; four weeks make a month.
// Zones are re-evaluated a quarter at a time each week, and the expensive
// map passes (traffic, pollution, crime, land value) run at month end.
import {
  BUILDINGS, DIFFICULTIES, DISASTER_POP, DOES, GIFT_LV, GIFT_REACH, GIFTS, Kind, LANDMARK_LETS, LANDMARK_LIMITS, NET_UPKEEP, POWER, RAIL, ROAD, STATION_POP,
  START_YEAR, UPGRADE_LV, ZONE_LV_GATE, ZONE_POP, article, buildingName, cityClass, CITY_CLASSES, dateLabel, isZone, num, toIndex, upkeepOf,
} from './defs';

import { MinHeap } from './heap';
import { clamp } from './rng';
import { shoreDistance } from './terrain';
import { Building, READOUT_NUMBERS, SAVED_MESSAGES, SavedReadouts, SavedRun, World, YEAR_DISASTERS, YearNews } from './world';
import { Disasters } from './disasters';

/** The landmarks the year-end paper reports opening and upgrading. */
const LANDMARKS: Kind[] = ['stadium', 'seaport', 'airport'];

export type MessageKind = 'info' | 'good' | 'warn' | 'alert';

export interface Message {
  id: number;
  text: string;
  kind: MessageKind;
  x?: number;
  y?: number;
  month: number;
}

export interface Problem {
  id: string;
  label: string;
  /** 0-100, higher is worse. */
  value: number;
}

export interface Budget {
  taxIncome: number;
  transport: number;
  police: number;
  fire: number;
  /** Schools, hospitals and parks. */
  services: number;
  /** The stadium, seaport and airport, with their upgrades. */
  landmarks: number;
  power: number;
  interest: number;
}

/** What a budget spends on, line by line, as the Budget's ledger names each. */
export const COST_LINES: [Exclude<keyof Budget, 'taxIncome'>, string][] = [
  ['transport', 'Roads and rail'],
  ['police', 'Police'],
  ['fire', 'Fire'],
  ['services', 'Schools, hospitals, parks'],
  ['landmarks', 'Stadium, seaport, airport'],
  ['power', 'Power plants'],
  ['interest', 'Loan interest'],
];

/** The most a city can borrow, in $10,000 steps. */
export const LOAN_LIMIT = 30000;
/** Month ends in debt in a row before the city is told it is broke. */
export const BROKE_MONTHS = 12;

/** Why a city in debt is short, and the ways out, for the card a year in debt brings (see Sim.brokeReport). */
export interface BrokeReport {
  owed: number;
  months: number;
  /** The three biggest monthly costs, biggest first. */
  costs: { label: string; amount: number }[];
  income: number;
  spend: number;
  tax: number;
  /** The tax rate that would bring in what the city spends, as it stands; null if even the top rate would not. */
  covers: number | null;
  /** What the city can still borrow. */
  loanRoom: number;
}

/** The year-end paper: the year's biggest news as its headline, and how the city stands (see Sim.paper). */
export interface Paper {
  /** The year that closed. */
  year: number;
  headline: string;
  /** The rest of the year's news, briefly ('Also this year: two fires and a flood.'), or empty. */
  also: string;
  /** When the headline is a year and more in debt: why, and the ways out. */
  broke: BrokeReport | null;
  residents: number;
  /** Residents gained (or lost) since the year began. */
  change: number;
  /** The city report's top worry, with how bad it is (0-100). */
  worry: { label: string; value: number } | null;
  approval: number;
  /** The year's surplus or deficit, as the news ticker says it; empty for a sandbox, which has no money to speak of. */
  closing: string;
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number) => COUNT_WORDS[n] ?? num(n);
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Everything a budget spends. */
export function spending(b: Budget): number {
  return b.transport + b.police + b.fire + b.services + b.landmarks + b.power + b.interest;
}

/** The chance a month that each tile of road or rail crumbles, with roads and rail funded at `f` (none from 90% up). */
function crumbleChance(f: number): number {
  return f < 0.9 ? (0.9 - f) * 0.012 : 0;
}

export interface Stats {
  residents: number;
  comJobs: number;
  indJobs: number;
  workers: number;
  unemployment: number;
  powerSupply: number;
  powerDemand: number;
  /** Separate grids with at least one plant, and how many of them are short. */
  powerGrids: number;
  gridsShort: number;
  zones: { res: number; com: number; ind: number };
  vacant: { res: number; com: number; ind: number };
  /** Vacant lots that can open as soon as there is demand: powered, and on a road. */
  vacantReady: { res: number; com: number; ind: number };
  unpowered: number;
  noRoad: number;
  noTrip: number;
  avgLandValue: number;
  avgPollution: number;
  avgCrime: number;
  avgTraffic: number;
  fires: number;
  approval: number;
  score: number;
  problems: Problem[];
  lastBudget: Budget;
  yearBudget: Budget;
  cityClass: string;
  migration: number;
  hasStadium: boolean;
  hasAirport: boolean;
  hasSeaport: boolean;
}

export type SimEvent =
  | { type: 'message'; message: Message }
  | { type: 'month' }
  | { type: 'year'; surplus: boolean }
  | { type: 'class'; text: string; gift?: Kind }
  | { type: 'broke' }
  | { type: 'paper'; paper: Paper }
  | { type: 'grow'; b: Building }
  | { type: 'destroyed'; x: number; y: number; kind: Kind }
  | { type: 'disaster'; kind: string; x: number; y: number };

const MAX_TRIP = 80;
const MAX_HUBS = 24;
/**
 * The riders map is the trips carried along each tile of track, 0-255. A train carries far more than a road: one line
 * can take most of a 12,000-person town's commuters, about 1,900 trips at its busiest, so the scale is a sixth of the
 * traffic map's and a line fills it at about 1,300.
 */
const RIDE_SCALE = 0.2;

function emptyBudget(): Budget {
  return { taxIncome: 0, transport: 0, police: 0, fire: 0, services: 0, landmarks: 0, power: 0, interest: 0 };
}

export class Sim {
  world: World;
  week = 0;
  stats: Stats;
  messages: Message[] = [];
  disasters: Disasters;
  private msgId = 1;
  private cooldown = new Map<string, number>();
  private listeners: ((e: SimEvent) => void)[] = [];
  powerDirty = true;
  /** Static terrain appeal for land value: water views, trees, elevation. */
  private terrainAppeal: Float32Array;
  private distJob: Float32Array;
  private distRes: Float32Array;
  private heap: MinHeap;
  private hubFields: Float32Array[] = [];
  /** The job centres as the last traffic pass found them, each with the distance field in hubFields at its index. */
  private hubs: Hub[] = [];
  private cand: { k: number; w: number; start: number }[] = [];
  /** Whether the last traffic pass found any jobs, and any homes, for a commute to reach. */
  private anyJobs = false;
  private anyRes = false;
  /** Residents at the last month end: the report's "Last month" and approval's growth term count from here. */
  lastPop = 0;
  /** Kinds held at a landmark limit: no lot of that kind grows until the landmark is built. */
  capped = { res: false, com: false, ind: false };
  /** The month the city's last power plant was lost, which the news has said: no other word on power that month. */
  plantLost = -1;
  /**
   * The commuters riding along each tile of track, 0-255 on the traffic map's scale, eased from month to month as the
   * traffic is. Counted with the traffic, and like the land value it is not saved: a city opened from a save counts
   * them afresh.
   */
  riders: Uint8Array;

  constructor(world: World) {
    this.world = world;
    this.distJob = new Float32Array(world.n);
    this.distRes = new Float32Array(world.n);
    this.heap = new MinHeap(4096);
    this.terrainAppeal = new Float32Array(world.n);
    this.riders = new Uint8Array(world.n);
    this.stats = this.blankStats();
    this.stats.approval = world.city.approval ?? 50;
    this.disasters = new Disasters(this);
    this.refreshTerrainAppeal();
    this.unsubscribe = world.onDirty((_x0, _y0, _x1, _y1, terrain) => {
      this.powerDirty = true;
      if (terrain) this.terrainDirty = true;
    });
    // A saved city carries on where it was: its traffic map as it stood, rather than eased into from empty roads,
    // and the rest of what the simulation was in the middle of.
    const run = world.run;
    const kept = world.trafficSaved;
    world.run = null;
    world.trafficSaved = false;
    this.computePower();
    this.computeTraffic(!kept);
    // Twice: crime depends on land value, which is not saved.
    this.computeMaps();
    this.computeMaps();
    this.tally();
    this.lastPop = this.stats.residents;
    if (run) this.resume(run);
    // A city opening for the first time starts its year's news as it stands.
    world.city.year ??= this.newYear();
  }

  /** What a save keeps of the running simulation, beyond the map and the city. */
  saveRun(): SavedRun {
    return {
      week: this.week,
      lastBudget: { ...this.stats.lastBudget },
      yearBudget: { ...this.stats.yearBudget },
      lastPop: this.lastPop,
      migration: this.stats.migration,
      messages: this.messages.slice(-SAVED_MESSAGES).map(({ text, kind, x, y, month }) => ({ text, kind, x, y, month })),
      cooldown: [...this.cooldown],
      readouts: this.readouts(),
      ...this.disasters.saveRun(),
    };
  }

  /** The figures the sign, the Report and the goal tracker read, for a save. */
  private readouts(): SavedReadouts {
    const s = this.stats;
    const out = { zones: { ...s.zones }, vacant: { ...s.vacant }, vacantReady: { ...s.vacantReady }, cityClass: s.cityClass } as SavedReadouts;
    for (const k of READOUT_NUMBERS) out[k] = s[k];
    return out;
  }

  private resume(run: SavedRun): void {
    this.week = run.week;
    this.stats.lastBudget = { ...run.lastBudget };
    this.stats.yearBudget = { ...run.yearBudget };
    if (run.lastPop !== undefined) this.lastPop = run.lastPop;
    if (run.migration !== undefined) this.stats.migration = run.migration;
    this.messages = run.messages.map((m) => ({ ...m, id: this.msgId++ }));
    this.cooldown = new Map(run.cooldown);
    this.disasters.resume(run);
    // Recounted in the middle of a month, from maps worked out afresh, the figures would jump as the city opens: it
    // shows what it closed with until the next month end.
    const r = run.readouts;
    if (r) {
      Object.assign(this.stats, { zones: { ...r.zones }, vacant: { ...r.vacant }, vacantReady: { ...r.vacantReady }, cityClass: r.cityClass });
      for (const k of READOUT_NUMBERS) this.stats[k] = r[k];
    }
  }

  private terrainDirty = false;
  private unsubscribe: () => void;

  /** Stop listening to the world; call when this Sim is replaced. */
  dispose(): void {
    this.unsubscribe();
    this.listeners = [];
  }

  on(fn: (e: SimEvent) => void): void {
    this.listeners.push(fn);
  }

  emit(e: SimEvent): void {
    // The year's paper remembers what struck.
    const news = this.world.city.year;
    if (e.type === 'disaster' && news) {
      news.disasters.push(e.kind);
      if (news.disasters.length > YEAR_DISASTERS) news.disasters.shift();
    }
    for (const l of this.listeners) l(e);
  }

  /** The year's news as it begins: residents, size class and landmarks, and nothing struck yet. */
  newYear(): YearNews {
    const landmarks: [number, number][] = [];
    for (const b of this.world.buildings.values()) if (LANDMARKS.includes(b.kind)) landmarks.push([b.id, b.level]);
    return { pop: this.stats.residents, cls: this.world.city.classReached, disasters: [], brownouts: 0, landmarks };
  }

  /**
   * The year-end paper for the year just closed, from the year's news: its biggest story as the headline (a year in
   * debt, a disaster, a new size class, a landmark, record growth, brownouts, debt, or how the city grew), the rest
   * in a line, and how the city stands.
   */
  paper(closing: string): Paper {
    const world = this.world;
    const city = world.city;
    const s = this.stats;
    const news = city.year ?? this.newYear();
    const name = city.name;
    const year = START_YEAR + Math.floor(city.month / 12) - 1;
    const change = s.residents - news.pop;
    const items: { p: number; head: string; also: string }[] = [];
    const struck = new Map<string, number>();
    for (const k of news.disasters) struck.set(k, (struck.get(k) ?? 0) + 1);
    const n = (k: string) => struck.get(k) ?? 0;
    const broke = city.debtMonths >= BROKE_MONTHS;
    if (broke) items.push({ p: 100, head: 'City hall is broke', also: '' });
    if (n('meltdown')) items.push({ p: 90, head: 'Meltdown at the nuclear plant', also: 'a meltdown' });
    if (n('earthquake')) items.push({ p: 85, head: `Earthquake shakes ${name}`, also: n('earthquake') > 1 ? `${countWord(n('earthquake'))} earthquakes` : 'an earthquake' });
    if (city.classReached > news.cls) {
      const cls = CITY_CLASSES[city.classReached].name.toLowerCase();
      items.push({ p: 80, head: `${name} is now ${article(cls)} ${cls}`, also: `becoming ${article(cls)} ${cls}` });
    }
    if (n('monster')) items.push({ p: 75, head: 'A monster comes ashore', also: n('monster') > 1 ? `${countWord(n('monster'))} monsters` : 'a monster' });
    if (n('tornado')) items.push({ p: 70, head: `Tornado tears through ${name}`, also: n('tornado') > 1 ? `${countWord(n('tornado'))} tornadoes` : 'a tornado' });
    if (n('flood')) items.push({ p: 65, head: 'Flooding along the shore', also: n('flood') > 1 ? `${countWord(n('flood'))} floods` : 'a flood' });
    const was = new Map(news.landmarks);
    for (const b of world.buildings.values()) {
      if (!LANDMARKS.includes(b.kind)) continue;
      const base = BUILDINGS[b.kind].name.toLowerCase();
      const before = was.get(b.id);
      if (before === undefined) items.push({ p: 60, head: `${name} opens its ${base}`, also: `a new ${base}` });
      else if (b.level > before) {
        const now = buildingName(b).toLowerCase();
        items.push({ p: 55, head: `${name}’s ${base} is now ${article(now)} ${now}`, also: `${article(now)} ${now}` });
      }
    }
    // Record growth: more new residents than in any earlier year the history holds, and at least one to compare with.
    const res = city.history.res;
    let best = -Infinity;
    for (let k = 1; res.length - 1 - 12 * (k + 1) >= 0; k++) best = Math.max(best, res[res.length - 1 - 12 * k] - res[res.length - 1 - 12 * (k + 1)]);
    if (change >= 100 && best > -Infinity && change > best) items.push({ p: 50, head: `Record year: ${num(change)} new residents`, also: 'record growth' });
    if (n('fire')) items.push({ p: 45, head: n('fire') > 1 ? `${capital(countWord(n('fire')))} fires in ${name}` : `Fire in ${name}`, also: n('fire') > 1 ? `${countWord(n('fire'))} fires` : 'a fire' });
    if (news.brownouts) items.push({ p: 40, head: `Brownouts in ${name}`, also: 'brownouts' });
    if (city.funds < 0 && !broke) items.push({ p: 35, head: `${name} ends ${year} in debt`, also: 'debt' });
    items.sort((a, b) => b.p - a.p);
    const top = items.shift();
    const head = top?.head ?? (change > 0 ? `${name} grows by ${num(change)}` : change < 0 ? `${name} loses ${num(-change)} residents` : `A quiet year in ${name}`);
    const rest = items.slice(0, 3).map((i) => i.also);
    const also = rest.length ? `Also this year: ${rest.length > 1 ? `${rest.slice(0, -1).join(', ')} and ${rest[rest.length - 1]}` : rest[0]}.` : '';
    const worry = s.problems[0];
    return {
      year,
      headline: head,
      also,
      broke: broke ? this.brokeReport() : null,
      residents: s.residents,
      change,
      worry: worry ? { label: worry.label, value: worry.value } : null,
      approval: Math.round(s.approval),
      closing,
    };
  }

  private blankStats(): Stats {
    return {
      residents: 0, comJobs: 0, indJobs: 0, workers: 0, unemployment: 0,
      powerSupply: 0, powerDemand: 0, powerGrids: 0, gridsShort: 0,
      zones: { res: 0, com: 0, ind: 0 }, vacant: { res: 0, com: 0, ind: 0 }, vacantReady: { res: 0, com: 0, ind: 0 },
      unpowered: 0, noRoad: 0, noTrip: 0,
      avgLandValue: 0, avgPollution: 0, avgCrime: 0, avgTraffic: 0, fires: 0,
      approval: 50, score: 500, problems: [],
      lastBudget: emptyBudget(), yearBudget: emptyBudget(),
      cityClass: 'Village', migration: 0,
      hasStadium: false, hasAirport: false, hasSeaport: false,
    };
  }

  /**
   * Post a message, at most once per `cool` months for the same key. With no cooldown nothing is kept, so news keyed
   * by the thing it is about (each fire, each building lost) doesn't pile up in the save.
   */
  say(key: string, text: string, kind: MessageKind = 'info', at?: { x: number; y: number }, cool = 6): void {
    const month = this.world.city.month;
    const last = this.cooldown.get(key);
    if (last !== undefined && month - last < cool) return;
    if (cool > 0) this.cooldown.set(key, month);
    const m: Message = { id: this.msgId++, text, kind, month, x: at?.x, y: at?.y };
    this.messages.push(m);
    if (this.messages.length > 80) this.messages.shift();
    this.emit({ type: 'message', message: m });
  }

  // ---- main loop ----------------------------------------------------------

  step(): void {
    const world = this.world;
    if (this.terrainDirty) {
      this.refreshTerrainAppeal();
      this.terrainDirty = false;
    }
    if (this.powerDirty) this.computePower();
    this.disasters.week();

    for (const b of world.buildings.values()) {
      if (b.id % 4 !== this.week) continue;
      if (isZone(b.kind)) this.growZone(b);
    }

    this.week++;
    if (this.week >= 4) {
      this.week = 0;
      this.monthEnd();
    }
  }

  private monthEnd(): void {
    const world = this.world;
    const city = world.city;
    for (const b of world.buildings.values()) b.age++;
    this.computePower();
    this.computeTraffic();
    this.computeMaps();
    this.tally();
    this.computeDemand();
    this.budget();
    this.evaluate();
    this.advise();
    this.record();
    if (this.stats.gridsShort > 0 && city.year) city.year.brownouts = Math.min(12, city.year.brownouts + 1);
    this.disasters.month();
    city.month++;
    this.emit({ type: 'month' });
    if (city.month % 12 === 0) this.yearEnd();
  }

  private yearEnd(): void {
    const world = this.world;
    for (let i = 0; i < world.n; i++) {
      if (world.rad[i]) {
        world.rad[i]--;
        if (!world.rad[i]) world.dirty(i % world.w, (i / world.w) | 0, i % world.w, (i / world.w) | 0);
      }
    }
    const yb = this.stats.yearBudget;
    const net = yb.taxIncome - spending(yb);
    const year = 1900 + Math.floor(world.city.month / 12) - 1;
    // A sandbox's year closes with no money said: none came in or went out (its Budget still has the ledger).
    const sandbox = !!world.city.sandbox;
    const closing = sandbox ? '' : `${year} closes ${net >= 0 ? 'with a surplus of' : 'with a deficit of'} $${num(Math.abs(net))}. Taxes brought in $${num(yb.taxIncome)}.`;
    if (closing) this.say('year', closing, net >= 0 ? 'good' : 'warn', undefined, 0);
    this.stats.yearBudget = emptyBudget();
    this.emit({ type: 'year', surplus: !sandbox && net >= 0 });
    const paper = this.paper(closing);
    world.city.year = this.newYear();
    this.emit({ type: 'paper', paper });
  }

  // ---- power --------------------------------------------------------------

  private powerComp?: Int32Array;
  private powerQueue?: Int32Array;
  /** Supply and demand of each grid, indexed by its component id minus one. */
  grids: PowerGrid[] = [];

  /** The grid a tile belongs to, or null if no plant reaches it. */
  gridAt(i: number): PowerGrid | null {
    const c = this.powerComp ? this.powerComp[i] : 0;
    return c ? this.grids[c - 1] : null;
  }

  computePower(): void {
    const world = this.world;
    const { w, h, n } = world;
    const powered = world.powered;
    powered.fill(0);
    // Reused between calls: the game recomputes power every frame something
    // changes, not only on the weekly step.
    if (!this.powerComp || this.powerComp.length !== n) {
      this.powerComp = new Int32Array(n);
      this.powerQueue = new Int32Array(n);
    }
    const comp = this.powerComp;
    const queue = this.powerQueue!;
    comp.fill(0);
    let compId = 0;
    let supplyTotal = 0;
    this.grids = [];
    let demandTotal = 0;
    for (const b of world.buildings.values()) {
      b.powered = false;
      const def = BUILDINGS[b.kind];
      if (!def.capacity && !def.noPower) demandTotal += b.size * b.size;
    }

    const conducts = (i: number): boolean => {
      if (world.net[i] & POWER) return true;
      const id = world.occ[i];
      if (!id) return false;
      const b = world.buildings.get(id);
      return !!b && !BUILDINGS[b.kind].noPower;
    };

    for (const plant of world.buildings.values()) {
      const def = BUILDINGS[plant.kind];
      if (!def.capacity) continue;
      const start = plant.y * w + plant.x;
      if (comp[start]) continue;
      compId++;
      let head = 0;
      let tail = 0;
      comp[start] = compId;
      queue[tail++] = start;
      const order: Building[] = [];
      const seen = new Set<number>();
      let supply = 0;
      let burning = 0;
      while (head < tail) {
        const i = queue[head++];
        const id = world.occ[i];
        if (id && !seen.has(id)) {
          seen.add(id);
          const b = world.buildings.get(id)!;
          const bd = BUILDINGS[b.kind];
          if (bd.capacity) {
            // A burning plant produces nothing.
            if (!world.fire[b.y * w + b.x]) supply += bd.capacity;
            else burning += bd.capacity;
            b.powered = true;
          } else {
            order.push(b);
          }
        }
        const x = i % w;
        const y = (i / w) | 0;
        if (x > 0 && !comp[i - 1] && conducts(i - 1)) { comp[i - 1] = compId; queue[tail++] = i - 1; }
        if (x < w - 1 && !comp[i + 1] && conducts(i + 1)) { comp[i + 1] = compId; queue[tail++] = i + 1; }
        if (y > 0 && !comp[i - w] && conducts(i - w)) { comp[i - w] = compId; queue[tail++] = i - w; }
        if (y < h - 1 && !comp[i + w] && conducts(i + w)) { comp[i + w] = compId; queue[tail++] = i + w; }
      }
      supplyTotal += supply;
      let left = supply;
      let demand = 0;
      for (const b of order) {
        const need = b.size * b.size;
        demand += need;
        if (left >= need) {
          b.powered = true;
          left -= need;
        }
      }
      this.grids.push({ supply, demand, burning });
      // Line tiles light up on the overlay if the component has any supply.
      if (supply > 0) {
        for (let k = 0; k < tail; k++) {
          const i = queue[k];
          if (world.net[i] & POWER) powered[i] = 1;
        }
      }
    }
    for (const b of world.buildings.values()) {
      if (!b.powered) continue;
      for (let dy = 0; dy < b.size; dy++) {
        for (let dx = 0; dx < b.size; dx++) powered[(b.y + dy) * w + b.x + dx] = 1;
      }
    }
    this.stats.powerSupply = supplyTotal;
    this.stats.powerDemand = demandTotal;
    this.stats.powerGrids = this.grids.length;
    this.stats.gridsShort = this.grids.filter((g) => g.demand > g.supply).length;
    this.powerDirty = false;
  }

  // ---- traffic ------------------------------------------------------------

  /**
   * Trip lengths from `sources` over road and rail. With `jams` a road tile costs more the busier it is, which steers
   * the routes commuters take, and the search stops a little past the longest trip. Without, every road tile costs
   * the same and the search covers the whole network, so a tile left at Infinity has no route at all.
   */
  private dijkstra(sources: number[], dist: Float32Array, jams = true): void {
    const world = this.world;
    const { w, h } = world;
    dist.fill(Infinity);
    const heap = this.heap;
    heap.clear();
    for (const s of sources) {
      dist[s] = 0;
      heap.push(s, 0);
    }
    const net = world.net;
    const traffic = world.traffic;
    while (heap.size) {
      const d = heap.peekKey();
      const i = heap.pop();
      if (d > dist[i]) continue;
      if (jams && d > MAX_TRIP * 1.5) break;
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const v = net[j];
        if (!(v & (ROAD | RAIL))) continue;
        // Along the track a level crossing is still rail: only a trip that turns onto the road there pays road prices.
        const cost = v & RAIL && (!(v & ROAD) || net[i] & RAIL) ? 0.45 : jams ? 1 + traffic[j] / 90 : 1;
        const nd = d + cost;
        if (nd < dist[j]) {
          dist[j] = nd;
          heap.push(j, nd);
        }
      }
    }
  }

  /** Road or rail tiles on the ring around a building. */
  private perimeter(b: Building, out: number[]): void {
    const world = this.world;
    out.length = 0;
    const s = b.size;
    for (let d = 0; d < s; d++) {
      const pts = [[b.x + d, b.y - 1], [b.x + d, b.y + s], [b.x - 1, b.y + d], [b.x + s, b.y + d]];
      for (const [x, y] of pts) {
        if (!world.inBounds(x, y)) continue;
        const i = y * world.w + x;
        if (world.net[i] & (ROAD | RAIL)) out.push(i);
      }
    }
  }

  /**
   * Follow a distance field downhill from tile i, as a trip goes: `step` hears of each tile it passes, whether it drives
   * along it, and whether it rides a train along it, from where it boards to where it gets off. A train passing through
   * a level crossing puts no cars on it, and commuters who board or leave the train on a crossing don't either.
   */
  private walk(field: Float32Array, i: number, step: (i: number, car: boolean, train: boolean) => void): void {
    const { w, h } = this.world;
    const net = this.world.net;
    let steps = 0;
    // Whether the trip came onto tile i by rail; at the start, whether it can board a train there.
    let byRail = !!(net[i] & RAIL);
    // Whether it came onto tile i on a train (at the start it hasn't boarded one yet).
    let aboard = false;
    while (i >= 0 && field[i] > 0 && steps++ < MAX_TRIP * 2) {
      const x = i % w;
      const y = (i / w) | 0;
      let nxt = -1;
      let nd = field[i];
      if (x > 0 && field[i - 1] < nd) { nd = field[i - 1]; nxt = i - 1; }
      if (x < w - 1 && field[i + 1] < nd) { nd = field[i + 1]; nxt = i + 1; }
      if (y > 0 && field[i - w] < nd) { nd = field[i - w]; nxt = i - w; }
      if (y < h - 1 && field[i + w] < nd) { nd = field[i + w]; nxt = i + w; }
      const onRail = nxt >= 0 && !!(net[i] & RAIL) && !!(net[nxt] & RAIL);
      step(i, !!(net[i] & ROAD) && !(byRail && onRail), onRail || aboard);
      byRail = aboard = onRail;
      i = nxt;
    }
    if (i >= 0) step(i, !!(net[i] & ROAD) && !byRail, aboard);
  }

  /** Add a trip's volume to every road tile it drives along (`flow`), and every tile of track it rides along (`ride`). */
  private trace(field: Float32Array, i: number, vol: number, flow: Float32Array, ride: Float32Array): void {
    this.walk(field, i, (j, car, train) => {
      if (car) flow[j] += vol;
      if (train) ride[j] += vol;
    });
  }

  /**
   * The trips a zone's people make, as the traffic pass traces them: the distance field each follows, the tile it
   * starts from, its volume, and the job centre it goes to (-1 for the nearest homes or jobs). Homes send their
   * commuters to up to three job centres, weighted by jobs and distance; shops and factories send deliveries and
   * customers on short hops to the nearest homes. `best` is the zone's tile nearest a destination.
   */
  private trips(b: Building, ring: number[], best: number, out: (field: Float32Array, start: number, vol: number, hub: number) => void): void {
    if (b.kind !== 'res') {
      out(this.distRes, best, b.pop / 30, -1);
      return;
    }
    const vol = b.pop / 7;
    const hubs = this.hubs;
    const cand = this.cand;
    cand.length = 0;
    for (let k = 0; k < hubs.length; k++) {
      const f = this.hubFields[k];
      let s = -1;
      let d = Infinity;
      for (const i of ring) if (f[i] < d) { d = f[i]; s = i; }
      if (d > MAX_TRIP * 1.4) continue;
      cand.push({ k, w: hubs[k].jobs / ((d + 6) * (d + 6)), start: s });
    }
    if (!cand.length) {
      out(this.distJob, best, vol, -1);
      return;
    }
    cand.sort((a, c) => c.w - a.w);
    const n = Math.min(3, cand.length);
    let tw = 0;
    for (let k = 0; k < n; k++) tw += cand[k].w;
    for (let k = 0; k < n; k++) out(this.hubFields[cand[k].k], cand[k].start, (vol * cand[k].w) / tw, cand[k].k);
  }

  /**
   * Commuting. Every zone must reach its nearest destination within
   * MAX_TRIP to develop. Residents then spread their trips over the city's
   * job centres, weighted by jobs and distance, so traffic piles up on the
   * roads into downtown and the industrial districts rather than staying
   * next door.
   */
  /** With `blend` false the traffic map is left as it is: the paths and trips are worked out over it. */
  computeTraffic(blend = true): void {
    const world = this.world;
    const jobSrc: number[] = [];
    const resSrc: number[] = [];
    const ring: number[] = [];
    let anyJobs = false;
    let anyRes = false;
    const jobZones: Building[] = [];
    for (const b of world.buildings.values()) {
      if (!isZone(b.kind)) continue;
      this.perimeter(b, ring);
      if (b.kind === 'res') {
        anyRes = true;
        for (const i of ring) resSrc.push(i);
      } else {
        anyJobs = true;
        for (const i of ring) jobSrc.push(i);
        if (b.pop > 0) jobZones.push(b);
      }
    }
    // Whether a lot has a commute at all depends on distance alone, as the guide says ('within about 80 road
    // tiles'); jams only steer the routes to the job centres below.
    this.dijkstra(jobSrc, this.distJob, false);
    this.dijkstra(resSrc, this.distRes, false);

    // Job centres: the biggest employers, with nearby ones folded in.
    jobZones.sort((a, b) => b.pop - a.pop);
    const hubs: Hub[] = [];
    for (const b of jobZones) {
      let near: Hub | null = null;
      let nd = Infinity;
      for (const hb of hubs) {
        const d = Math.abs(hb.b.x - b.x) + Math.abs(hb.b.y - b.y);
        if (d < nd) { nd = d; near = hb; }
      }
      if (near && (nd < 9 || hubs.length >= MAX_HUBS)) {
        near.jobs += b.pop;
        near.lots.push(b);
      } else hubs.push({ b, jobs: b.pop, lots: [b] });
    }
    this.hubs = hubs;
    this.anyJobs = anyJobs;
    this.anyRes = anyRes;
    for (let k = 0; k < hubs.length; k++) {
      if (!this.hubFields[k] || this.hubFields[k].length !== world.n) this.hubFields[k] = new Float32Array(world.n);
      this.perimeter(hubs[k].b, ring);
      this.dijkstra(ring.slice(), this.hubFields[k]);
    }

    const flow = new Float32Array(world.n);
    const ride = new Float32Array(world.n);
    const net = world.net;
    const trace = (field: Float32Array, start: number, vol: number) => this.trace(field, start, vol, flow, ride);
    for (const b of world.buildings.values()) {
      if (!isZone(b.kind)) continue;
      this.perimeter(b, ring);
      let hasRoad = false;
      for (const i of ring) if (net[i] & ROAD) hasRoad = true;
      b.road = hasRoad;
      if (!ring.length) {
        b.trip = false;
        continue;
      }
      const field = b.kind === 'res' ? this.distJob : this.distRes;
      const anyDest = b.kind === 'res' ? anyJobs : anyRes;
      let best = -1;
      let bestD = Infinity;
      for (const i of ring) {
        if (field[i] < bestD) {
          bestD = field[i];
          best = i;
        }
      }
      if (!anyDest) {
        b.trip = true;
        continue;
      }
      b.trip = bestD <= MAX_TRIP;
      if (!b.trip || b.pop <= 0) continue;
      this.trips(b, ring, best, trace);
    }
    // Riders are eased in as the traffic is, and a city opened from a save counts them afresh: they are not saved.
    const riders = this.riders;
    for (let i = 0; i < world.n; i++) {
      const target = net[i] & RAIL ? Math.min(255, ride[i] * RIDE_SCALE) : 0;
      riders[i] = Math.round(blend ? riders[i] * 0.4 + target * 0.6 : target);
    }
    if (!blend) return;
    const traffic = world.traffic;
    for (let i = 0; i < world.n; i++) {
      if (!(net[i] & ROAD)) {
        traffic[i] = 0;
        continue;
      }
      const target = Math.min(255, flow[i] * 1.25);
      traffic[i] = Math.round(traffic[i] * 0.4 + target * 0.6);
    }
  }

  // ---- maps ---------------------------------------------------------------

  refreshTerrainAppeal(): void {
    const world = this.world;
    const { w, h, n } = world;
    const shore = shoreDistance(world, 6);
    const ta = this.terrainAppeal;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (world.water[i]) {
          ta[i] = 0;
          continue;
        }
        let v = 0;
        if (shore[i] <= 6) v += (7 - shore[i]) * 7;
        v += Math.min(24, Math.max(0, world.height[i]) / 7);
        ta[i] = v;
      }
    }
    // Trees nearby.
    const trees = new Float32Array(n);
    for (let i = 0; i < n; i++) trees[i] = world.trees[i] * 5;
    blur(trees, w, h, 2);
    for (let i = 0; i < n; i++) ta[i] += Math.min(22, trees[i]);
  }

  computeMaps(): void {
    const world = this.world;
    const { w, h, n } = world;
    const pol = new Float32Array(n);
    const dens = new Float32Array(n);
    const parks = new Float32Array(n);
    const gift = new Float32Array(n);
    const police = new Float32Array(n);
    const fire = new Float32Array(n);
    const service = new Float32Array(n);
    const funding = world.city.funding;
    let cxSum = 0;
    let cySum = 0;
    let wSum = 0;

    for (const b of world.buildings.values()) {
      const def = BUILDINGS[b.kind];
      const cx = b.x + b.size / 2;
      const cy = b.y + b.size / 2;
      const area = b.size * b.size;
      let p = def.pollution ?? 0;
      if (b.kind === 'ind') p = b.level * 42 + 20;
      if (b.kind === 'coal' && !b.powered) p *= 0.5;
      if (p) stampRect(pol, w, b.x, b.y, b.size, p);
      if (isZone(b.kind)) {
        const d = Math.min(255, (b.pop / area) * (b.kind === 'res' ? 1 : 0.8));
        stampRect(dens, w, b.x, b.y, b.size, d);
        cxSum += cx * (b.pop + 1);
        cySum += cy * (b.pop + 1);
        wSum += b.pop + 1;
      }
      if (b.kind === 'park') parks[b.y * w + b.x] += 60;
      if (b.kind === 'stadium') stampRect(parks, w, b.x, b.y, b.size, 20);
      if (b.kind === 'mayor') stampDisk(gift, w, h, cx, cy, GIFT_REACH, GIFT_LV);
      const eff = b.powered ? 1 : 0.35;
      if (b.kind === 'police') stampDisk(police, w, h, cx, cy, 18, 255 * funding.police * eff);
      if (b.kind === 'fire') stampDisk(fire, w, h, cx, cy, 18, 255 * funding.fire * eff);
      if (b.kind === 'school') stampDisk(service, w, h, cx, cy, 15, 170 * eff);
      if (b.kind === 'hospital') stampDisk(service, w, h, cx, cy, 18, 170 * eff);
    }
    for (let i = 0; i < n; i++) {
      const t = world.traffic[i];
      if (t) pol[i] += t * 0.55;
    }
    blur(pol, w, h, 2);
    blur(pol, w, h, 2);
    blur(dens, w, h, 1);
    blur(parks, w, h, 3);

    const ccx = wSum ? cxSum / wSum : w / 2;
    const ccy = wSum ? cySum / wSum : h / 2;
    const reach = Math.max(w, h) * 0.55;

    for (let i = 0; i < n; i++) {
      const tr = world.trees[i];
      const p = clamp(pol[i] * 1.25 - tr * 6 - parks[i] * 0.3, 0, 255);
      world.pollution[i] = p;
      world.density[i] = clamp(dens[i], 0, 255);
      world.policeCov[i] = clamp(police[i], 0, 255);
      world.fireCov[i] = clamp(fire[i], 0, 255);
      world.serviceCov[i] = clamp(service[i], 0, 255);
    }

    // Crime grows where people are crowded and land is cheap: where they live and work, not in parks, plants or stations.
    const crimeRaw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = world.occ[i] ? world.buildings.get(world.occ[i]) : undefined;
      if (!b || !isZone(b.kind)) continue;
      const lvPrev = world.landValue[i];
      crimeRaw[i] = world.density[i] * 0.75 + Math.max(0, 150 - lvPrev) * 0.5;
    }
    blur(crimeRaw, w, h, 2);

    let lvSum = 0, lvCount = 0, polSum = 0, crimeSum = 0, popTiles = 0;
    const landmarks = this.landmarkValue();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (world.water[i]) {
          world.landValue[i] = 0;
          world.crime[i] = 0;
          continue;
        }
        const d = Math.hypot(x - ccx, y - ccy);
        let lv = 34 + this.terrainAppeal[i] + Math.max(0, 1 - d / reach) * 48;
        lv += Math.min(40, parks[i] * 0.6);
        lv += gift[i];
        lv += world.serviceCov[i] * 0.22;
        lv -= world.pollution[i] * 0.7;
        lv -= world.crime[i] * 0.25;
        lv -= world.traffic[i] * 0.08;
        lv += landmarks;
        if (world.rad[i]) lv = 0;
        world.landValue[i] = clamp(Math.round(lv), 1, 255);
        const cr = clamp(crimeRaw[i] * 1.2 - world.policeCov[i] * 0.9, 0, 255);
        world.crime[i] = cr;
        if (world.occ[i]) {
          lvSum += world.landValue[i];
          lvCount++;
        }
        if (world.density[i] > 4) {
          polSum += world.pollution[i];
          crimeSum += cr;
          popTiles++;
        }
      }
    }
    this.stats.avgLandValue = lvCount ? lvSum / lvCount : 0;
    this.stats.avgPollution = popTiles ? polSum / popTiles : 0;
    this.stats.avgCrime = popTiles ? crimeSum / popTiles : 0;
    // Congestion on the roads people actually use.
    let trSum = 0, trCount = 0;
    for (let i = 0; i < n; i++) {
      if (world.net[i] & ROAD && world.traffic[i] > 6) {
        trSum += world.traffic[i];
        trCount++;
      }
    }
    this.stats.avgTraffic = trCount ? trSum / trCount : 0;
  }

  // ---- zones --------------------------------------------------------------

  private growZone(b: Building): void {
    const world = this.world;
    const k = b.kind as 'res' | 'com' | 'ind';
    const ci = (b.y + 1) * world.w + b.x + 1;
    if (world.fire[ci]) return;
    const r = Math.random();
    if (!b.powered || !b.road) {
      if (b.level > 0 && r < 0.18) this.setLevel(b, b.level - 1);
      return;
    }
    const { score, maxLevel } = this.growth(b);
    // Without a commute a lot never grows, however good its spot: the missing trip only weighs on the score below.
    // Nor does it past a landmark limit, where the meter is also held below the line.
    if (score > 0 && b.level < maxLevel && b.trip && !this.capped[k]) {
      if (r < 0.02 + score * 0.11) {
        this.setLevel(b, b.level + 1);
        this.emit({ type: 'grow', b });
      }
    } else if ((score < -0.12 || b.level > maxLevel) && b.level > 0) {
      if (r < 0.03 + Math.max(0, -score) * 0.2) this.setLevel(b, b.level - 1);
    }
  }

  /**
   * What decides whether a zone's lot grows, read at its centre as growZone reads it: the score (demand plus how good
   * the spot is, less a missing commute), the densest its land value allows, and how much each drag takes off.
   */
  growth(b: Building): Growth {
    const world = this.world;
    const k = b.kind as 'res' | 'com' | 'ind';
    const ci = (b.y + 1) * world.w + b.x + 1;
    const d = world.city.demand;
    const valve = k === 'res' ? d.r : k === 'com' ? d.c : d.i;
    const lv = world.landValue[ci] / 255;
    const pol = world.pollution[ci] / 255;
    const cr = world.crime[ci] / 255;
    const svc = world.serviceCov[ci] / 255;
    let local: number;
    let polWeight = 0, crWeight = 0;
    if (k === 'res') {
      local = 0.1 + lv * 0.9 - pol * 1.2 - cr * 0.6 + svc * 0.25;
      polWeight = 1.2;
      crWeight = 0.6;
    } else if (k === 'com') {
      local = 0.05 + lv * 0.7 - cr * 0.5 - pol * 0.25;
      polWeight = 0.25;
      crWeight = 0.5;
    } else local = 0.3 - lv * 0.15;
    const score = valve + local * 0.8 - (b.trip ? 0 : 0.9);
    const drags: [string, number][] = [
      ['low demand', Math.max(0, -valve)], ['pollution', pol * polWeight * 0.8], ['crime', cr * crWeight * 0.8], ['no commute', b.trip ? 0 : 0.9],
    ];
    return { score, maxLevel: this.maxLevel(b), drags };
  }

  /** The densest a zone's lot can be where it stands: its land value decides, and for homes, schools and hospitals nearby help. */
  maxLevel(b: Building): number {
    const world = this.world;
    const k = b.kind as 'res' | 'com' | 'ind';
    const ci = (b.y + 1) * world.w + b.x + 1;
    const svc = world.serviceCov[ci] / 255;
    const gate = ZONE_LV_GATE[k];
    let max = 0;
    for (let L = 0; L < gate.length; L++) if (world.landValue[ci] + (k === 'res' ? svc * 30 : 0) >= gate[L]) max = L;
    return max;
  }

  private setLevel(b: Building, level: number): void {
    // A new look when the lot is redeveloped.
    b.seed = (b.seed * 1103515245 + 12345) & 0x7fffffff;
    this.world.setLevel(b, level);
    this.powerDirty = true;
  }

  // ---- tallies --------------------------------------------------------------

  tally(): void {
    const s = this.stats;
    const world = this.world;
    let res = 0, com = 0, ind = 0;
    s.zones = { res: 0, com: 0, ind: 0 };
    s.vacant = { res: 0, com: 0, ind: 0 };
    s.vacantReady = { res: 0, com: 0, ind: 0 };
    s.unpowered = 0;
    s.noRoad = 0;
    s.noTrip = 0;
    s.hasStadium = s.hasAirport = s.hasSeaport = false;
    for (const b of world.buildings.values()) {
      if (b.kind === 'stadium') s.hasStadium = true;
      if (b.kind === 'airport') s.hasAirport = true;
      if (b.kind === 'seaport') s.hasSeaport = true;
      if (!isZone(b.kind)) continue;
      const k = b.kind as 'res' | 'com' | 'ind';
      s.zones[k]++;
      if (b.level === 0) {
        s.vacant[k]++;
        if (b.powered && b.road) s.vacantReady[k]++;
      }
      if (k === 'res') res += b.pop;
      else if (k === 'com') com += b.pop;
      else ind += b.pop;
      if (!b.powered) s.unpowered++;
      if (!b.road) s.noRoad++;
      else if (!b.trip) s.noTrip++;
    }
    s.residents = res;
    s.comJobs = com;
    s.indJobs = ind;
    const lim = LANDMARK_LIMITS;
    this.capped = { res: res > lim.res && !s.hasStadium, com: com > lim.com && !s.hasAirport, ind: ind > lim.ind && !s.hasSeaport };
    s.workers = Math.round(res * 0.5);
    s.unemployment = s.workers > 0 ? clamp(1 - (com + ind) / s.workers, 0, 1) : 0;
    let fires = 0;
    for (let i = 0; i < world.n; i++) if (world.fire[i]) fires++;
    s.fires = fires;
    s.cityClass = cityClass(res);
  }

  /** The jobs the city's people keep busy: shops for its residents and the factories' workers, factories for its residents. */
  jobsWanted(): { com: number; ind: number } {
    const s = this.stats;
    return { com: s.residents * 0.22 + s.indJobs * 0.12 + 60, ind: s.residents * 0.3 + 90 };
  }

  computeDemand(): void {
    const s = this.stats;
    const city = this.world.city;
    const R = s.residents;
    const Jc = s.comJobs;
    const Ji = s.indJobs;
    const rTarget = (Jc + Ji) * 2.05 + 220;
    const { com: cTarget, ind: iTarget } = this.jobsWanted();
    const valve = (target: number, cur: number) => ((target - cur) / (Math.max(target, cur) + 200)) * 2.2;
    // Each point of tax away from 7% pushes every bar down (or up, below 7%).
    const tax = (7 - city.tax) * 0.05;
    let r = valve(rTarget, R) + tax;
    let c = valve(cTarget, Jc) + tax;
    let i = valve(iTarget, Ji) + tax;
    if (this.capped.res) {
      r = Math.min(r, -0.05);
      this.say('stadium', `Housing has stopped at ${num(LANDMARK_LIMITS.res)} residents until the city builds a stadium.`, 'warn', undefined, 12);
    }
    if (this.capped.com) {
      c = Math.min(c, -0.05);
      this.say('airport', `Commerce has stopped at ${num(LANDMARK_LIMITS.com)} jobs until the city builds an airport.`, 'warn', undefined, 12);
    }
    if (this.capped.ind) {
      i = Math.min(i, -0.05);
      this.say('seaport', `Industry has stopped at ${num(LANDMARK_LIMITS.ind)} jobs until the city builds a seaport.`, 'warn', undefined, 12);
    }
    const d = city.demand;
    d.r = clamp(d.r * 0.5 + r * 0.5, -1, 1);
    d.c = clamp(d.c * 0.5 + c * 0.5, -1, 1);
    d.i = clamp(d.i * 0.5 + i * 0.5, -1, 1);
  }

  // ---- money ----------------------------------------------------------------

  /** A month's taxes and costs as the city stands, without charging them. */
  private reckon(): Budget {
    const world = this.world;
    const city = world.city;
    const counts = world.countNet();
    const b = emptyBudget();
    b.taxIncome = this.projectTax(city.tax);
    b.transport = (counts.road * NET_UPKEEP.road + counts.rail * NET_UPKEEP.rail + counts.bridge * NET_UPKEEP.bridge) * city.funding.transport;
    for (const bd of world.buildings.values()) {
      const def = BUILDINGS[bd.kind];
      if (bd.kind === 'police') b.police += def.upkeep * city.funding.police;
      else if (bd.kind === 'fire') b.fire += def.upkeep * city.funding.fire;
      else if (def.capacity) b.power += def.upkeep;
      else if (bd.kind === 'stadium' || bd.kind === 'seaport' || bd.kind === 'airport') b.landmarks += upkeepOf(bd);
      else b.services += upkeepOf(bd);
    }
    b.interest = city.loan * 0.07 / 12;
    return b;
  }

  /** Show what a month brings in and costs for a city that opens with no month behind it, such as a challenge's. */
  estimateBudget(): void {
    this.stats.lastBudget = this.reckon();
  }

  budget(): void {
    const world = this.world;
    const city = world.city;
    const s = this.stats;
    const b = this.reckon();
    // A sandbox keeps the ledger, but nothing comes in or goes out.
    if (!city.sandbox) city.funds += b.taxIncome - spending(b);
    s.lastBudget = b;
    const yb = s.yearBudget;
    for (const k of Object.keys(b) as (keyof Budget)[]) yb[k] += b[k];

    // Underfunded roads crumble.
    if (city.funding.transport < 0.9) {
      const decay = crumbleChance(city.funding.transport);
      for (let i = 0; i < world.n; i++) {
        if (world.net[i] & (ROAD | RAIL) && Math.random() < decay) {
          const x = i % world.w;
          const y = (i / world.w) | 0;
          world.clearNet(x, y, ROAD | RAIL);
          // A power line on the tile stays up, so no rubble is left under it.
          if (!world.water[i] && !world.net[i]) world.rubble[i] = 1;
          this.say('potholes', 'Underfunded roads are falling apart.', 'warn', { x, y }, 6);
        }
      }
    }
    if (city.funds < 0) this.say('debt', 'The city is in debt. Raise taxes, cut costs, or take a loan.', 'alert', undefined, 3);
    // A year in debt, in a row: no new rule, but a card says why, and the ways out.
    city.debtMonths = city.funds < 0 ? city.debtMonths + 1 : 0;
    if (city.debtMonths === BROKE_MONTHS) this.emit({ type: 'broke' });
  }

  /** Why the city is short of money, and the ways out: its biggest costs, the tax rate that would cover them, its loan room. */
  brokeReport(): BrokeReport {
    const city = this.world.city;
    const b = this.stats.lastBudget;
    const costs = COST_LINES.map(([k, label]) => ({ label, amount: b[k] }))
      .filter((c) => c.amount >= 0.5)
      .sort((a, c) => c.amount - a.amount)
      .slice(0, 3);
    const spend = spending(b);
    // Taxes grow in step with the rate: a point's worth, times the points needed.
    const point = this.projectTax(1);
    const need = point > 0 ? Math.ceil(spend / point - 1e-9) : Infinity;
    return {
      owed: Math.max(0, -city.funds),
      months: city.debtMonths,
      costs,
      income: b.taxIncome,
      spend,
      tax: city.tax,
      covers: need <= 20 ? need : null,
      loanRoom: Math.max(0, LOAN_LIMIT - city.loan),
    };
  }

  /** What police, fire, and roads and rail cost a month at full funding, as the city stands. */
  fullUpkeep(): { police: number; fire: number; transport: number } {
    const world = this.world;
    const counts = world.countNet();
    const cost = { police: 0, fire: 0, transport: counts.road * NET_UPKEEP.road + counts.rail * NET_UPKEEP.rail + counts.bridge * NET_UPKEEP.bridge };
    for (const bd of world.buildings.values()) if (bd.kind === 'police' || bd.kind === 'fire') cost[bd.kind] += BUILDINGS[bd.kind].upkeep;
    return cost;
  }

  /** About how many tiles of road and rail crumble a month with roads and rail funded at `f`. */
  crumbling(f = this.world.city.funding.transport): number {
    const net = this.world.net;
    let tiles = 0;
    for (let i = 0; i < net.length; i++) if (net[i] & (ROAD | RAIL)) tiles++;
    return tiles * crumbleChance(f);
  }

  /** Land value the landmark upgrades add to every tile: the most upgraded stadium, seaport and airport count. */
  landmarkValue(): number {
    const top = new Map<Kind, number>();
    for (const b of this.world.buildings.values()) if (b.level > 1 && !isZone(b.kind)) top.set(b.kind, Math.max(top.get(b.kind) ?? 1, b.level));
    let v = 0;
    for (const level of top.values()) v += (level - 1) * UPGRADE_LV;
    return v;
  }

  /**
   * What a landmark adds to every tile's land value: its upgrades, when it is the city's most upgraded of its kind (the
   * first, if two are level). 0 when none of its kind is upgraded yet, and null when another of its kind counts instead.
   */
  landmarkAdds(b: Building): number | null {
    let top: Building | undefined;
    for (const o of this.world.buildings.values()) if (o.kind === b.kind && (!top || o.level > top.level)) top = o;
    if (!top || top.level <= 1) return 0;
    return top === b ? (b.level - 1) * UPGRADE_LV : null;
  }

  /** Monthly tax income the city would collect at a given rate. */
  projectTax(tax: number): number {
    const s = this.stats;
    const diff = DIFFICULTIES.find((d) => d.id === this.world.city.difficulty) ?? DIFFICULTIES[0];
    const lvF = 0.55 + (s.avgLandValue / 255) * 0.9;
    return ((s.residents + (s.comJobs + s.indJobs) * 0.7) * (tax / 100) * lvF * diff.income) / 2.5;
  }

  takeLoan(amount: number): boolean {
    const city = this.world.city;
    if (city.sandbox || city.loan + amount > LOAN_LIMIT) return false;
    city.loan += amount;
    city.funds += amount;
    return true;
  }

  repayLoan(amount: number): boolean {
    const city = this.world.city;
    const a = Math.min(amount, city.loan);
    if (a <= 0 || city.funds < a) return false;
    city.loan -= a;
    city.funds -= a;
    return true;
  }

  // ---- how are we doing -------------------------------------------------------

  /**
   * The city's worries, the mayor's approval and the score. At a month end approval moves 30% of the way to the
   * city's mood; for a city just opened from a save (`monthEnd` false) it stays as it was saved.
   */
  evaluate(monthEnd = true): void {
    const s = this.stats;
    const city = this.world.city;
    const probs: Problem[] = [
      { id: 'crime', label: 'Crime', value: clamp((s.avgCrime / 255) * 160, 0, 100) },
      { id: 'pollution', label: 'Pollution', value: clamp((s.avgPollution / 255) * 170, 0, 100) },
      { id: 'housing', label: 'Housing costs', value: clamp(((s.avgLandValue - 60) / 195) * 90, 0, 100) },
      // Nobody minds the neutral 7%. Each point above it adds 10: Minor from 9%, Serious from 11%, Severe from 14%.
      { id: 'taxes', label: 'Taxes', value: clamp((city.tax - 7) * 10, 0, 100) },
      { id: 'traffic', label: 'Traffic', value: clamp((s.avgTraffic / 255) * 190, 0, 100) },
      { id: 'jobs', label: 'Unemployment', value: clamp(s.unemployment * 160, 0, 100) },
      { id: 'fire', label: 'Fires', value: clamp(s.fires * 4, 0, 100) },
      { id: 'power', label: 'Power', value: s.zones.res + s.zones.com + s.zones.ind > 0 ? clamp((s.unpowered / (s.zones.res + s.zones.com + s.zones.ind)) * 150, 0, 100) : 0 },
    ];
    probs.sort((a, b) => b.value - a.value);
    s.problems = probs;
    const weights: Record<string, number> = { crime: 0.2, pollution: 0.18, housing: 0.08, taxes: 0.14, traffic: 0.14, jobs: 0.14, fire: 0.06, power: 0.16 };
    let pain = 0;
    for (const p of probs) pain += p.value * weights[p.id];
    // Last month's growth, counted at a month end: a city just opened keeps the figure it was saved with.
    if (monthEnd) s.migration = s.residents - this.lastPop;
    const mood = clamp(88 - pain * 1.15 + clamp(s.migration / 60, -8, 8), 0, 100);
    if (monthEnd) s.approval = s.residents > 0 ? s.approval * 0.7 + mood * 0.3 : 50;
    // Kept with the city, so a saved city opens with the mood it had.
    city.approval = s.approval;
    const classIdx = CITY_CLASSES.findIndex((c) => c.name === s.cityClass);
    s.score = Math.round(clamp(s.approval * 7 + classIdx * 50 + Math.min(50, s.avgLandValue / 3), 0, 1000));
    if (monthEnd) this.lastPop = s.residents;
  }

  private advise(): void {
    const s = this.stats;
    const world = this.world;
    const city = world.city;
    const zones = s.zones.res + s.zones.com + s.zones.ind;
    const month = city.month;
    const plants = [...world.buildings.values()].filter((b) => BUILDINGS[b.kind].capacity);
    const onFire = (b: Building) => world.fire[b.y * world.w + b.x] > 0;
    if (zones > 0 && s.powerSupply === 0 && plants.length) {
      // Every plant is burning: the city has its power back once the fires are out.
      const covered = plants.some((b) => world.fireCov[(b.y + 1) * world.w + b.x + 1] > 0);
      const lead = plants.length === 1
        ? `The ${buildingName(plants[0]).toLowerCase()} is on fire, so nothing has power until it is out.`
        : 'Every power plant is on fire, so nothing has power until the fires are out.';
      this.say('plantfire', `${lead} ${covered ? 'Firefighters are on the way.' : 'A fire station within reach puts fires out sooner.'}`, 'warn', plants[0] && { x: plants[0].x + 1, y: plants[0].y + 1 }, 2);
    } else if (zones > 0 && s.powerSupply === 0) {
      // A plant lost this month has said so already, and that every zone is dark.
      if (this.plantLost !== month) this.say('noplant', `Zones are waiting for electricity. Build a power plant and connect it.${this.loanFor('coal')}`, 'warn', undefined, 4);
    } else if (s.gridsShort > 0) {
      // Judge each grid on its own: two plants only share if their grids join.
      let worst = this.grids[0];
      for (const g of this.grids) if (g.demand - g.supply > worst.demand - worst.supply) worst = g;
      const burning = worst.burning ? plants.find((b) => onFire(b) && this.gridAt(b.y * world.w + b.x) === worst) : undefined;
      let text: string;
      if (burning) {
        // Short because a plant on it is burning: more plants may not be what it needs.
        const which = `${this.grids.length > 1 ? `one of your ${this.grids.length} separate power grids needs ${num(worst.demand)} MW but its plants make` : `the grid needs ${num(worst.demand)} MW but the plants make`} ${num(worst.supply)} MW while the ${buildingName(burning).toLowerCase()} is on fire`;
        text = `Brownouts: ${which}. ${worst.demand <= worst.supply + worst.burning ? 'The power comes back once the fire is out.' : 'Even with it, the grid would be short: build another plant.'}`;
      } else {
        text = this.grids.length > 1
          ? `Brownouts: one of your ${this.grids.length} separate power grids needs ${num(worst.demand)} MW but its plants make ${num(worst.supply)} MW. Join it to a grid with power to spare, or build a plant on it.`
          : `Brownouts: the grid needs ${num(worst.demand)} MW but the plants make ${num(worst.supply)} MW. Build another plant.`;
      }
      this.say('brownout', text, 'warn', this.findUnpowered(true), 6);
    } else if (s.unpowered > 0 && month > 2) {
      this.say('unconnected', `${s.unpowered} zone${s.unpowered > 1 ? 's are' : ' is'} not connected to a power plant.`, 'warn', this.findUnpowered(false), 8);
    }
    if (s.noRoad > 0 && month > 1) {
      this.say('noroad', `${s.noRoad} zone${s.noRoad > 1 ? 's have' : ' has'} no road access and cannot develop.`, 'warn', this.findZone((b) => !b.road), 10);
    }
    if (s.noTrip > 2 && month > 3) {
      this.say('notrip', 'Commuters cannot reach work. Connect residential zones to commercial and industrial ones by road.', 'warn', this.findZone((b) => b.road && !b.trip), 10);
    }
    const d = city.demand;
    if (zones === 0) {
      if (month >= 2) this.say('nozones', 'Nothing is zoned yet. Pick Residential, Commercial or Industrial from the toolbox and drag across open land next to a road.', 'info', undefined, 12);
    } else {
      this.needLand('res', d.r, 'People want to move here', 'residential');
      this.needLand('com', d.c, 'Shops are in demand', 'commercial');
      this.needLand('ind', d.i, 'Factories are looking for space', 'industrial');
    }
    if (s.avgTraffic > 110) this.say('traffic', 'Traffic jams are getting bad. Add roads or rail.', 'warn', undefined, 12);
    if (s.avgPollution > 100) this.say('pollution', 'Pollution is choking the city.', 'warn', undefined, 12);
    if (s.avgCrime > 90) this.say('crime', 'Crime is rising. More police stations would help.', 'warn', undefined, 12);
    if (s.residents > 3000 && s.powerSupply > 0 && s.powerDemand > s.powerSupply * 0.9 && s.powerDemand <= s.powerSupply) {
      this.say('powerlow', `Power reserve is thin: ${num(s.powerSupply - s.powerDemand)} MW left.`, 'info', undefined, 12);
    }
    if (city.tax >= 13) this.say('tax', 'Citizens are grumbling about high taxes.', 'info', undefined, 12);
    let fireStations = 0, police = 0;
    for (const b of world.buildings.values()) {
      if (b.kind === 'fire') fireStations++;
      if (b.kind === 'police') police++;
    }
    // A town this size needs its first stations. Random disasters follow at DISASTER_POP, fire the commonest: say what a
    // station costs (but in a sandbox, where nothing does) and what it is for.
    const price = (k: Kind) => (city.sandbox ? '' : ` ($${num(BUILDINGS[k].cost)}, $${BUILDINGS[k].upkeep} a month)`);
    if (s.residents > STATION_POP && fireStations === 0) {
      this.say('needfire', !city.disasters
        ? `The city has no fire station. Should a fire start, a station${price('fire')} puts it out nearby.`
        : s.residents >= DISASTER_POP
          ? `The city has no fire station. Fires break out from time to time now; a station${price('fire')} puts them out nearby.`
          : `The city has no fire station. Fires break out from time to time once it has ${num(DISASTER_POP)} residents; a station${price('fire')} puts them out nearby.`, 'info', undefined, 18);
    }
    if (s.residents > STATION_POP && police === 0) {
      this.say('needpolice', `The city has no police station. Crime grows as the town gets crowded; a station${price('police')} keeps it down nearby.`, 'info', undefined, 18);
    }

    const idx = CITY_CLASSES.findIndex((c) => c.name === s.cityClass);
    if (idx > city.classReached) {
      // Each class passed on the way brings its gift, if it has one.
      let gift: Kind | undefined;
      for (let k = city.classReached + 1; k <= idx; k++) {
        const g = GIFTS[k];
        if (g && !city.gifts.includes(g)) {
          city.gifts.push(g);
          gift = g;
        }
      }
      city.classReached = idx;
      // 'Passed': the city may have grown well beyond the line by the month's end.
      const text = `${city.name} has passed ${num(CITY_CLASSES[idx].min)} residents and is now a ${CITY_CLASSES[idx].name.toLowerCase()}.`;
      this.say('class' + idx, text, 'good', undefined, 0);
      this.emit({ type: 'class', text, gift });
    }
  }

  /**
   * For a city that can't afford a building: how a loan would pay for it, when one would. Empty when the city has
   * the money, or has borrowed all it can.
   */
  private loanFor(k: Kind): string {
    const city = this.world.city;
    const cost = BUILDINGS[k].cost;
    if (city.sandbox || city.funds >= cost || city.loan + 10000 > 30000 || city.funds + 10000 < cost) return '';
    const has = Math.round(city.funds) < 0 ? `is $${num(-city.funds)} in debt` : `has $${num(city.funds)}`;
    return ` The city ${has}: a loan from the Budget would pay for one.`;
  }

  /**
   * With strong demand for a zone and fewer than two lots ready to take it, ask for more land; but when there are
   * empty lots of that zone and none can open, more land would sit dark beside them, so say what they lack instead.
   */
  private needLand(k: 'res' | 'com' | 'ind', demand: number, want: string, zone: string): void {
    const s = this.stats;
    if (demand <= 0.45 || s.vacantReady[k] >= 2) return;
    if (s.vacant[k] === 0 || s.vacantReady[k] > 0) {
      this.say('need' + k, `${want}. Zone more ${zone} land.`, 'info', undefined, 8);
      return;
    }
    let dark = 0, off = 0, first: Building | undefined;
    for (const b of this.world.buildings.values()) {
      if (b.kind !== k || b.level !== 0) continue;
      first ??= b;
      if (!b.powered) dark++;
      if (!b.road) off++;
    }
    const n = s.vacant[k];
    const lack = dark && off ? (dark === n && off === n ? 'no power and no road' : 'no power or no road') : dark ? 'no power' : 'no road';
    const lots = n > 1 ? `the empty ${zone} lots have` : `the empty ${zone} lot has`;
    this.say('need' + k, `${want}, but ${lots} ${lack}.`, 'info', first && { x: first.x + 1, y: first.y + 1 }, 8);
  }

  /** The middle of the first zone `is` picks out, for Go there. */
  private findZone(is: (b: Building) => boolean): { x: number; y: number } | undefined {
    for (const b of this.world.buildings.values()) if (isZone(b.kind) && is(b)) return { x: b.x + 1, y: b.y + 1 };
    return undefined;
  }

  /** Why a lot with a road has no commute: no route at all to the other side of town, or one too long. */
  private noCommute(b: Building): string {
    const home = b.kind === 'res';
    const field = home ? this.distJob : this.distRes;
    const ring: number[] = [];
    this.perimeter(b, ring);
    let best = Infinity;
    for (const i of ring) best = Math.min(best, field[i]);
    if (best === Infinity) return home ? 'No road to any shops or factories' : 'No road to any homes';
    return home ? 'Commute too long' : 'Homes are too far away';
  }

  private findUnpowered(short: boolean): { x: number; y: number } | undefined {
    for (const b of this.world.buildings.values()) {
      if (!isZone(b.kind) || b.powered) continue;
      if (!!this.gridAt(b.y * this.world.w + b.x) === short) return { x: b.x + 1, y: b.y + 1 };
    }
    return undefined;
  }

  private record(): void {
    const s = this.stats;
    const h = this.world.city.history;
    const b = s.lastBudget;
    const push = (arr: number[], v: number) => {
      arr.push(Math.round(v));
      if (arr.length > 1200) arr.shift();
    };
    push(h.res, s.residents);
    push(h.com, s.comJobs);
    push(h.ind, s.indJobs);
    push(h.funds, this.world.city.funds);
    push(h.crime, toIndex(s.avgCrime));
    push(h.pollution, toIndex(s.avgPollution));
    push(h.traffic, toIndex(s.avgTraffic));
    push(h.approval, s.approval);
    push(h.score, s.score);
    push(h.powerUsed, s.powerDemand);
    push(h.powerMade, s.powerSupply);
    push(h.income, b.taxIncome);
    push(h.expense, spending(b));
  }

  /**
   * Who drives, or rides a train, along the tile at (x, y): every zone's trips traced again as the last traffic pass
   * traced them, keeping those that pass here. Worked out only when asked, so the monthly pass costs no more for it.
   * Null for a tile with no road or track.
   */
  passing(x: number, y: number): Passing | null {
    const world = this.world;
    const at = y * world.w + x;
    if (!(world.net[at] & (ROAD | RAIL))) return null;
    const out: Passing = { drive: 0, ride: 0, driveDeliveries: 0, rideDeliveries: 0, from: '', to: '', toWhat: '', deliveryFrom: '', deliveryWhat: '', homes: [], jobs: [] };
    const ring: number[] = [];
    // People from each home and each shop or factory whose trips pass here, and to each job centre.
    const homes = new Map<Building, number>();
    const senders = new Map<Building, number>();
    const toHub = new Map<number, number>();
    for (const b of world.buildings.values()) {
      if (!isZone(b.kind) || !b.trip || b.pop <= 0) continue;
      const home = b.kind === 'res';
      if (!(home ? this.anyJobs : this.anyRes)) continue;
      this.perimeter(b, ring);
      if (!ring.length) continue;
      const field = home ? this.distJob : this.distRes;
      let best = -1;
      let bestD = Infinity;
      for (const i of ring) if (field[i] < bestD) { bestD = field[i]; best = i; }
      this.trips(b, ring, best, (f, start, vol, hub) => {
        let car = false;
        let train = false;
        this.walk(f, start, (j, c, t) => {
          if (j !== at) return;
          car ||= c;
          train ||= t;
        });
        if (!car && !train) return;
        const people = vol * PEOPLE_PER_VOL;
        if (home) {
          if (car) out.drive += people;
          if (train) out.ride += people;
          homes.set(b, (homes.get(b) ?? 0) + people);
          if (hub >= 0) toHub.set(hub, (toHub.get(hub) ?? 0) + people);
        } else {
          if (car) out.driveDeliveries += people;
          if (train) out.rideDeliveries += people;
          senders.set(b, (senders.get(b) ?? 0) + people);
        }
      });
    }
    /** Which way from here the middle of some places lies, weighting each by its people. */
    const towards = (places: Iterable<[Building, number]>): string => {
      let cx = 0;
      let cy = 0;
      let sum = 0;
      for (const [b, p] of places) {
        cx += (b.x + b.size / 2) * p;
        cy += (b.y + b.size / 2) * p;
        sum += p;
      }
      return sum > 0 ? compass(cx / sum - x - 0.5, cy / sum - y - 0.5) : '';
    };
    out.from = towards(homes);
    out.to = towards([...toHub].map(([k, p]) => [this.hubs[k].b, p] as [Building, number]));
    const jobs = new Set<Building>(senders.keys());
    let com = 0;
    let all = 0;
    for (const [k, p] of toHub) {
      const hub = this.hubs[k];
      let c = 0;
      for (const lot of hub.lots) {
        jobs.add(lot);
        if (lot.kind === 'com') c += lot.pop;
      }
      com += (c / hub.jobs) * p;
      all += p;
    }
    out.toWhat = jobsWord(com, all, 'jobs');
    let sentCom = 0;
    let sent = 0;
    for (const [b, p] of senders) {
      if (b.kind === 'com') sentCom += p;
      sent += p;
    }
    out.deliveryFrom = towards(senders);
    out.deliveryWhat = jobsWord(sentCom, sent, 'shops and factories');
    out.homes = [...homes.keys()].map((b) => b.id);
    out.jobs = [...jobs].map((b) => b.id);
    return out;
  }

  /** Human-readable description of a tile for the inspect tool: what a building is for, figures, and a note. */
  describe(x: number, y: number): { title: string; does?: string; rows: [string, string][]; note?: string } {
    const world = this.world;
    const i = y * world.w + x;
    const rows: [string, string][] = [];
    let title = 'Open land';
    let does: string | undefined;
    let note: string | undefined;
    // A zone's land value, pollution and crime are read at its centre, where its growth reads them.
    let at = i;
    const b = world.buildingAt(x, y);
    const net = world.net[i];
    if (b) {
      const def = BUILDINGS[b.kind];
      title = buildingName(b);
      if (isZone(b.kind)) {
        const k = b.kind as 'res' | 'com' | 'ind';
        title = zoneTitle(k, b.level);
        rows.push([k === 'res' ? 'Residents' : 'Jobs', num(b.pop)]);
        rows.push(['Density', `${b.level} of ${ZONE_POP[k].length - 1}`]);
        if (!b.road) rows.push(['Problem', 'No road access']);
        else if (!b.trip) rows.push(['Problem', this.noCommute(b)]);
        const g = this.growth(b);
        const top = ZONE_LV_GATE[k].length - 1;
        const allows = Math.min(top, g.maxLevel);
        // A lot already denser than its land value allows can't grow to less than it is.
        rows.push([b.level > allows ? 'Land value allows' : 'Can grow to', `Density ${allows}`]);
        rows.push(['Outlook', this.outlook(b, g)]);
        if (g.maxLevel < top) note = this.densityNote(b, g.maxLevel);
        at = (b.y + 1) * world.w + b.x + 1;
      }
      // A landmark that stands already does what the toolbox says it is needed for.
      if (!isZone(b.kind)) does = LANDMARK_LETS[b.kind as keyof typeof LANDMARK_LETS] ?? DOES[b.kind as keyof typeof DOES];
      if (def.capacity) rows.push(['Output', `${num(def.capacity)} MW`]);
      const grid = this.gridAt(b.y * world.w + b.x);
      rows.push(['Power',
        def.capacity ? (world.fire[b.y * world.w + b.x] ? 'None: on fire' : 'Generating') :
        def.noPower ? 'Not needed' :
        b.powered ? 'Connected' :
        // Short only because a plant is burning: the power comes back when the fire is out.
        grid && grid.demand <= grid.supply + grid.burning ? 'None: its power plant is on fire' :
        grid ? 'None: its grid is overloaded' : 'None: no plant connected']);
      if (grid) rows.push(['Its grid', gridLoad(grid)]);
      if (def.upkeep) rows.push(['Upkeep', `$${upkeepOf(b)}/mo`]);
      if (b.kind === 'stadium' || b.kind === 'seaport' || b.kind === 'airport') {
        const adds = this.landmarkAdds(b);
        rows.push(['Land value it adds', adds === null ? 'None: only the most upgraded counts' : adds ? `+$${num(adds * 40)}/acre across the city` : 'None until it is upgraded']);
      }
    } else if (world.water[i]) {
      title = net & ROAD ? 'Road bridge' : net & RAIL ? 'Rail bridge' : net & POWER ? 'Power line' : 'Water';
      if (net & ROAD) rows.push(['Traffic', level5(world.traffic[i])]);
      if (net & RAIL) rows.push(['Riders', ridersWord(this.riders[i])]);
      if (net & POWER) {
        const grid = this.gridAt(i);
        rows.push(['Its grid', grid ? gridLoad(grid) : 'No plant connected']);
      }
    } else if (net) {
      const parts = [];
      if (net & ROAD) parts.push('Road');
      if (net & RAIL) parts.push('Rail');
      if (net & POWER) parts.push('Power line');
      title = parts.join(' + ');
      if (net & ROAD) rows.push(['Traffic', level5(world.traffic[i])]);
      if (net & RAIL) rows.push(['Riders', ridersWord(this.riders[i])]);
      if (net & POWER) {
        const grid = this.gridAt(i);
        rows.push(['Its grid', grid ? gridLoad(grid) : 'No plant connected']);
      }
    } else if (world.rubble[i]) {
      title = 'Rubble';
    } else if (world.trees[i]) {
      title = ['', 'Scattered trees', 'Woods', 'Dense forest'][world.trees[i]];
    }
    if (world.fire[i]) rows.unshift(['Status', 'On fire']);
    if (world.flood[i]) rows.unshift(['Status', 'Flooded']);
    if (world.rad[i]) rows.unshift(['Status', `Radioactive for ${world.rad[i]} years`]);
    rows.push(['Elevation', `${Math.round(world.height[i])} m`]);
    if (!world.water[i]) {
      rows.push(['Land value', `$${num(world.landValue[at] * 40)}/acre`]);
      rows.push(['Pollution', level5(world.pollution[at])]);
      rows.push(['Crime', level5(world.crime[at])]);
    }
    return { title, does, rows, note };
  }

  /** Where a zone's lot is headed, from the same reckoning growZone makes, and the main reason when it isn't growing. */
  private outlook(b: Building, g: Growth): string {
    const k = b.kind as 'res' | 'com' | 'ind';
    const stalled = b.level > 0 ? 'Steady' : 'Not growing';
    if (!b.powered || !b.road) return `${b.level > 0 ? 'Shrinking' : 'Not growing'}: ${b.powered ? 'no road' : 'no power'}`;
    const drag = g.drags.reduce((a, c) => (c[1] > a[1] ? c : a), ['low demand', 0])[0];
    if (g.score > 0 && b.trip) {
      if (b.level > g.maxLevel) return 'Shrinking: land value too low';
      if (b.level === g.maxLevel) return 'Full for its land value';
      if (this.capped[k]) return `Held at a landmark limit: build ${{ res: 'a stadium', com: 'an airport', ind: 'a seaport' }[k]}`;
      return 'Growing';
    }
    if (b.level > 0 && g.score < -0.12) return `Shrinking: ${drag}`;
    if (b.level > g.maxLevel) return 'Shrinking: land value too low';
    return `${stalled}: ${drag}`;
  }

  /** What land value the next density needs at a lot held back by it. For homes, schools and hospitals in reach count. */
  private densityNote(b: Building, max: number): string {
    const world = this.world;
    const k = b.kind as 'res' | 'com' | 'ind';
    const ci = (b.y + 1) * world.w + b.x + 1;
    const bonus = k === 'res' ? (world.serviceCov[ci] / 255) * 30 : 0;
    // A lot denser than its land allows needs land value to keep what it is; any other, to reach the next density.
    const want = Math.max(b.level, max + 1);
    const need = Math.max(0, Math.ceil(ZONE_LV_GATE[k][want] - bonus)) * 40;
    return `Density ${max} is the most this land value allows. ${b.level > max ? `Keeping density ${want}` : `Density ${want}`} (${zoneTitle(k, want).toLowerCase()}) needs $${num(need)}/acre here.`;
  }

  dateLabel(): string {
    return dateLabel(this.world.city.month);
  }
}

/** A job centre: the biggest employer in a district, with the jobs of the lots folded into it. */
interface Hub {
  b: Building;
  jobs: number;
  lots: Building[];
}

/** Who passes along a tile of road or track, worked out when asked (see Sim.passing). */
export interface Passing {
  /** Commuters a month who drive along the tile, and who ride a train along it. */
  drive: number;
  ride: number;
  /** Deliveries and customers a month from shops and factories, by road and by train. */
  driveDeliveries: number;
  rideDeliveries: number;
  /** Where the commuters come from and go to, as words ('to the north-west', 'nearby'), and what they go to. */
  from: string;
  to: string;
  toWhat: string;
  /** Where the deliveries come from, and what from. */
  deliveryFrom: string;
  deliveryWhat: string;
  /** The homes, and the shops and factories, whose trips pass along the tile, by building id. */
  homes: number[];
  jobs: number[];
}

/** A count of people as the Inspect card says it: 'a few', '40', '1,200', '12,000'. */
function about(n: number): string {
  if (n < 10) return 'a few';
  const step = n < 100 ? 10 : n < 10000 ? 100 : 1000;
  return num(Math.round(n / step) * step);
}

/** What a set of job lots is, by the jobs in it: shops and offices, factories, or both. */
function jobsWord(com: number, all: number, both: string): string {
  return com >= all * 0.67 ? 'shops and offices' : com <= all * 0.33 ? 'factories' : both;
}

/**
 * Who passes along a tile, as the Inspect card says it: 'About 1,200 commuters a month drive through here, from the
 * homes to the north-west to the factories to the east.' `road` and `rail` say what the tile carries.
 */
export function passingSentence(p: Passing, road: boolean, rail: boolean): string {
  const people = p.drive + p.ride;
  const goods = p.driveDeliveries + p.rideDeliveries;
  if (people < 1 && goods < 1) return road && rail ? 'Nobody drives or rides along here.' : rail ? 'Nobody rides along here.' : 'Nobody drives along here.';
  const how = (d: number, r: number) =>
    d >= 1 && r >= 1 ? `drive across here, and about ${about(r)} ride through` : r >= 1 ? 'ride through here' : 'drive through here';
  const count = (d: number, r: number) => (d >= 1 && r >= 1 ? about(d) : about(d + r));
  let text = '';
  if (people >= 1) {
    const to = p.to ? `the ${p.toWhat} ${p.to}` : 'work';
    text = `About ${count(p.drive, p.ride)} commuters a month ${how(p.drive, p.ride)}, from the homes ${p.from} to ${to}.`;
    if (goods >= 1) text += ` Deliveries from the ${p.deliveryWhat} ${p.deliveryFrom} add about ${about(goods)}.`;
  } else {
    text = `About ${count(p.driveDeliveries, p.rideDeliveries)} deliveries a month ${how(p.driveDeliveries, p.rideDeliveries)}, from the ${p.deliveryWhat} ${p.deliveryFrom} to the homes nearest them.`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** People a trip's volume stands for: a home sends a seventh of its residents, and half of them work. */
const PEOPLE_PER_VOL = 3.5;

/** Which way (dx, dy) points, as a compass word, or 'nearby' for anywhere within a few tiles. */
export function compass(dx: number, dy: number): string {
  if (Math.hypot(dx, dy) < 5) return 'nearby';
  const a = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  return `to the ${names[((Math.round(a / 45) % 8) + 8) % 8]}`;
}

export interface Growth {
  score: number;
  maxLevel: number;
  /** What takes the score down, and by how much. */
  drags: [string, number][];
}

export interface PowerGrid {
  supply: number;
  demand: number;
  /** What its plants on fire would make, in MW: a burning plant makes nothing. */
  burning: number;
}

function gridLoad(g: PowerGrid): string {
  const load = g.demand > g.supply
    ? `Overloaded: needs ${num(g.demand)} MW, makes ${num(g.supply)}`
    : `${num(g.demand)} of ${num(g.supply)} MW used`;
  return g.burning ? `${load}; a plant is on fire` : load;
}

export function zoneTitle(k: 'res' | 'com' | 'ind', level: number): string {
  if (level === 0) return { res: 'Vacant residential lot', com: 'Vacant commercial lot', ind: 'Vacant industrial lot' }[k];
  if (k === 'res') return level <= 2 ? 'Cottages' : level <= 4 ? 'Houses' : level === 5 ? 'Row apartments' : level <= 7 ? 'Apartment blocks' : 'Residential towers';
  if (k === 'com') return ['', 'Corner shops', 'Main street', 'Offices', 'Office towers', 'Downtown skyscrapers'][level];
  return ['', 'Workshops', 'Warehouses', 'Factories', 'Heavy industry'][level];
}

/** How full the trains are along a tile of track, from the riders map. */
export function ridersWord(v: number): 'None' | 'Light' | 'Busy' | 'Packed' {
  return v <= 0 ? 'None' : v < 60 ? 'Light' : v < 170 ? 'Busy' : 'Packed';
}

function level5(v: number): string {
  if (v < 20) return 'None';
  if (v < 70) return 'Low';
  if (v < 130) return 'Moderate';
  if (v < 190) return 'High';
  return 'Very high';
}

function stampRect(map: Float32Array, w: number, x: number, y: number, s: number, v: number): void {
  for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) map[(y + dy) * w + x + dx] += v;
}

function stampDisk(map: Float32Array, w: number, h: number, cx: number, cy: number, r: number, v: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d < 1) map[y * w + x] += v * (1 - d * d * 0.7);
    }
  }
}

/** In-place separable box blur. */
export function blur(map: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += map[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[x] = sum / (2 * r + 1);
      sum += map[row + Math.min(w - 1, x + r + 1)] - map[row + Math.max(0, x - r)];
    }
    for (let x = 0; x < w; x++) map[row + x] = tmp[x];
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += map[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = sum / (2 * r + 1);
      sum += map[Math.min(h - 1, y + r + 1) * w + x] - map[Math.max(0, y - r) * w + x];
    }
    for (let y = 0; y < h; y++) map[y * w + x] = tmp[y];
  }
}

export type { Kind };

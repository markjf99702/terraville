// The city simulation. One step is one week; four weeks make a month.
// Zones are re-evaluated a quarter at a time each week, and the expensive
// map passes (traffic, pollution, crime, land value) run at month end.
import {
  BUILDINGS, DIFFICULTIES, Kind, NET_UPKEEP, POWER, RAIL, ROAD, ZONE_LV_GATE, ZONE_POP, cityClass,
  CITY_CLASSES, dateLabel, isZone,
} from './defs';
import { MinHeap } from './heap';
import { clamp } from './rng';
import { shoreDistance } from './terrain';
import { Building, World } from './world';
import { Disasters } from './disasters';

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
  services: number;
  power: number;
  interest: number;
}

export interface Stats {
  residents: number;
  comJobs: number;
  indJobs: number;
  workers: number;
  unemployment: number;
  powerSupply: number;
  powerDemand: number;
  zones: { res: number; com: number; ind: number };
  vacant: { res: number; com: number; ind: number };
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
  | { type: 'year' }
  | { type: 'grow'; b: Building }
  | { type: 'destroyed'; x: number; y: number }
  | { type: 'disaster'; kind: string; x: number; y: number };

const MAX_TRIP = 80;
const MAX_HUBS = 24;

function emptyBudget(): Budget {
  return { taxIncome: 0, transport: 0, police: 0, fire: 0, services: 0, power: 0, interest: 0 };
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
  private lastPop = 0;

  constructor(world: World) {
    this.world = world;
    this.distJob = new Float32Array(world.n);
    this.distRes = new Float32Array(world.n);
    this.heap = new MinHeap(4096);
    this.terrainAppeal = new Float32Array(world.n);
    this.stats = this.blankStats();
    this.disasters = new Disasters(this);
    this.refreshTerrainAppeal();
    world.onDirty((_x0, _y0, _x1, _y1, terrain) => {
      this.powerDirty = true;
      if (terrain) this.terrainDirty = true;
    });
    this.computePower();
    this.computeTraffic();
    this.computeMaps();
    this.tally();
    this.lastPop = this.stats.residents;
  }

  private terrainDirty = false;

  on(fn: (e: SimEvent) => void): void {
    this.listeners.push(fn);
  }

  emit(e: SimEvent): void {
    for (const l of this.listeners) l(e);
  }

  private blankStats(): Stats {
    return {
      residents: 0, comJobs: 0, indJobs: 0, workers: 0, unemployment: 0,
      powerSupply: 0, powerDemand: 0,
      zones: { res: 0, com: 0, ind: 0 }, vacant: { res: 0, com: 0, ind: 0 },
      unpowered: 0, noRoad: 0, noTrip: 0,
      avgLandValue: 0, avgPollution: 0, avgCrime: 0, avgTraffic: 0, fires: 0,
      approval: 50, score: 500, problems: [],
      lastBudget: emptyBudget(), yearBudget: emptyBudget(),
      cityClass: 'Village', migration: 0,
      hasStadium: false, hasAirport: false, hasSeaport: false,
    };
  }

  /** Post a message, at most once per `cool` months for the same key. */
  say(key: string, text: string, kind: MessageKind = 'info', at?: { x: number; y: number }, cool = 6): void {
    const month = this.world.city.month;
    const last = this.cooldown.get(key);
    if (last !== undefined && month - last < cool) return;
    this.cooldown.set(key, month);
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
    const net = yb.taxIncome - (yb.transport + yb.police + yb.fire + yb.services + yb.power + yb.interest);
    const year = 1900 + Math.floor(world.city.month / 12) - 1;
    this.say('year', `${year} closes ${net >= 0 ? 'with a surplus of' : 'with a deficit of'} $${Math.abs(Math.round(net)).toLocaleString()}. Taxes brought in $${Math.round(yb.taxIncome).toLocaleString()}.`, net >= 0 ? 'good' : 'warn', undefined, 0);
    this.stats.yearBudget = emptyBudget();
    this.emit({ type: 'year' });
  }

  // ---- power --------------------------------------------------------------

  computePower(): void {
    const world = this.world;
    const { w, h, n } = world;
    const powered = world.powered;
    powered.fill(0);
    const comp = new Int32Array(n);
    const queue = new Int32Array(n);
    let compId = 0;
    let supplyTotal = 0;
    let demandTotal = 0;
    for (const b of world.buildings.values()) {
      b.powered = false;
      const def = BUILDINGS[b.kind];
      if (!def.capacity && b.kind !== 'park') demandTotal += b.size * b.size;
    }

    const conducts = (i: number): boolean => {
      if (world.net[i] & POWER) return true;
      const id = world.occ[i];
      if (!id) return false;
      const b = world.buildings.get(id);
      return !!b && b.kind !== 'park';
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
      for (const b of order) {
        const need = b.size * b.size;
        if (left >= need) {
          b.powered = true;
          left -= need;
        }
      }
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
    this.powerDirty = false;
  }

  // ---- traffic ------------------------------------------------------------

  private dijkstra(sources: number[], dist: Float32Array): void {
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
      if (d > MAX_TRIP * 1.5) break;
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const v = net[j];
        if (!(v & (ROAD | RAIL))) continue;
        const cost = v & RAIL && !(v & ROAD) ? 0.45 : 1 + traffic[j] / 90;
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

  /** Follow a distance field downhill from tile i, adding vol to every road tile passed. */
  private trace(field: Float32Array, i: number, vol: number, flow: Float32Array): void {
    const { w, h } = this.world;
    const net = this.world.net;
    let steps = 0;
    while (i >= 0 && field[i] > 0 && steps++ < MAX_TRIP * 2) {
      if (net[i] & ROAD) flow[i] += vol;
      const x = i % w;
      const y = (i / w) | 0;
      let nxt = -1;
      let nd = field[i];
      if (x > 0 && field[i - 1] < nd) { nd = field[i - 1]; nxt = i - 1; }
      if (x < w - 1 && field[i + 1] < nd) { nd = field[i + 1]; nxt = i + 1; }
      if (y > 0 && field[i - w] < nd) { nd = field[i - w]; nxt = i - w; }
      if (y < h - 1 && field[i + w] < nd) { nd = field[i + w]; nxt = i + w; }
      i = nxt;
    }
    if (i >= 0 && net[i] & ROAD) flow[i] += vol;
  }

  /**
   * Commuting. Every zone must reach its nearest destination within
   * MAX_TRIP to develop. Residents then spread their trips over the city's
   * job centres, weighted by jobs and distance, so traffic piles up on the
   * roads into downtown and the industrial districts rather than staying
   * next door.
   */
  computeTraffic(): void {
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
    this.dijkstra(jobSrc, this.distJob);
    this.dijkstra(resSrc, this.distRes);

    // Job centres: the biggest employers, with nearby ones folded in.
    jobZones.sort((a, b) => b.pop - a.pop);
    const hubs: { b: Building; jobs: number }[] = [];
    for (const b of jobZones) {
      let near: { b: Building; jobs: number } | null = null;
      let nd = Infinity;
      for (const hb of hubs) {
        const d = Math.abs(hb.b.x - b.x) + Math.abs(hb.b.y - b.y);
        if (d < nd) { nd = d; near = hb; }
      }
      if (near && (nd < 9 || hubs.length >= MAX_HUBS)) near.jobs += b.pop;
      else hubs.push({ b, jobs: b.pop });
    }
    for (let k = 0; k < hubs.length; k++) {
      if (!this.hubFields[k] || this.hubFields[k].length !== world.n) this.hubFields[k] = new Float32Array(world.n);
      this.perimeter(hubs[k].b, ring);
      this.dijkstra(ring.slice(), this.hubFields[k]);
    }

    const flow = new Float32Array(world.n);
    const net = world.net;
    const cand: { k: number; w: number; start: number }[] = [];
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
      if (b.kind !== 'res') {
        // Deliveries and customers: short hops to the nearest homes.
        this.trace(field, best, b.pop / 30, flow);
        continue;
      }
      const vol = b.pop / 7;
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
        this.trace(field, best, vol, flow);
        continue;
      }
      cand.sort((a, c) => c.w - a.w);
      const n = Math.min(3, cand.length);
      let tw = 0;
      for (let k = 0; k < n; k++) tw += cand[k].w;
      for (let k = 0; k < n; k++) this.trace(this.hubFields[cand[k].k], cand[k].start, (vol * cand[k].w) / tw, flow);
    }
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

    // Crime grows where people are crowded and land is cheap.
    const crimeRaw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!world.occ[i]) continue;
      const lvPrev = world.landValue[i];
      crimeRaw[i] = world.density[i] * 0.75 + Math.max(0, 150 - lvPrev) * 0.5;
    }
    blur(crimeRaw, w, h, 2);

    let lvSum = 0, lvCount = 0, polSum = 0, crimeSum = 0, popTiles = 0;
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
        lv += world.serviceCov[i] * 0.22;
        lv -= world.pollution[i] * 0.7;
        lv -= world.crime[i] * 0.25;
        lv -= world.traffic[i] * 0.08;
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
    const d = world.city.demand;
    const valve = k === 'res' ? d.r : k === 'com' ? d.c : d.i;
    const lv = world.landValue[ci] / 255;
    const pol = world.pollution[ci] / 255;
    const cr = world.crime[ci] / 255;
    const svc = world.serviceCov[ci] / 255;
    let local: number;
    if (k === 'res') local = 0.1 + lv * 0.9 - pol * 1.2 - cr * 0.6 + svc * 0.25;
    else if (k === 'com') local = 0.05 + lv * 0.7 - cr * 0.5 - pol * 0.25;
    else local = 0.3 - lv * 0.15;
    const score = valve + local * 0.8 - (b.trip ? 0 : 0.9);

    const gate = ZONE_LV_GATE[k];
    let maxLevel = 0;
    for (let L = 0; L < gate.length; L++) {
      // Hospitals nearby let residential grow a notch denser.
      if (world.landValue[ci] + (k === 'res' ? svc * 30 : 0) >= gate[L]) maxLevel = L;
    }
    if (score > 0 && b.level < maxLevel) {
      if (r < 0.02 + score * 0.11) {
        this.setLevel(b, b.level + 1);
        this.emit({ type: 'grow', b });
      }
    } else if ((score < -0.12 || b.level > maxLevel) && b.level > 0) {
      if (r < 0.03 + Math.max(0, -score) * 0.2) this.setLevel(b, b.level - 1);
    }
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
      if (b.level === 0) s.vacant[k]++;
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
    s.workers = Math.round(res * 0.5);
    s.unemployment = s.workers > 0 ? clamp(1 - (com + ind) / s.workers, 0, 1) : 0;
    let fires = 0;
    for (let i = 0; i < world.n; i++) if (world.fire[i]) fires++;
    s.fires = fires;
    s.cityClass = cityClass(res);
  }

  computeDemand(): void {
    const s = this.stats;
    const city = this.world.city;
    const R = s.residents;
    const Jc = s.comJobs;
    const Ji = s.indJobs;
    const rTarget = (Jc + Ji) * 2.05 + 220;
    const cTarget = R * 0.22 + Ji * 0.12 + 60;
    const iTarget = R * 0.3 + 90;
    const valve = (target: number, cur: number) => ((target - cur) / (Math.max(target, cur) + 200)) * 2.2;
    const tax = (7 - city.tax) * 0.035;
    let r = valve(rTarget, R) + tax;
    let c = valve(cTarget, Jc) + tax;
    let i = valve(iTarget, Ji) + tax;
    if (R > 18000 && !s.hasStadium) {
      r = Math.min(r, -0.05);
      this.say('stadium', 'Residents want a stadium before more of them move in.', 'warn', undefined, 12);
    }
    if (Jc > 5000 && !s.hasAirport) {
      c = Math.min(c, -0.05);
      this.say('airport', 'Commerce has stalled. Businesses need an airport.', 'warn', undefined, 12);
    }
    if (Ji > 4000 && !s.hasSeaport) {
      i = Math.min(i, -0.05);
      this.say('seaport', 'Industry has stalled. Factories need a seaport to ship goods.', 'warn', undefined, 12);
    }
    const d = city.demand;
    d.r = clamp(d.r * 0.5 + r * 0.5, -1, 1);
    d.c = clamp(d.c * 0.5 + c * 0.5, -1, 1);
    d.i = clamp(d.i * 0.5 + i * 0.5, -1, 1);
  }

  // ---- money ----------------------------------------------------------------

  budget(): void {
    const world = this.world;
    const city = world.city;
    const s = this.stats;
    const taxIncome = this.projectTax(city.tax);
    const counts = world.countNet();
    const b = emptyBudget();
    b.taxIncome = taxIncome;
    b.transport = (counts.road * NET_UPKEEP.road + counts.rail * NET_UPKEEP.rail + counts.bridge * NET_UPKEEP.bridge) * city.funding.transport;
    for (const bd of world.buildings.values()) {
      const def = BUILDINGS[bd.kind];
      if (bd.kind === 'police') b.police += def.upkeep * city.funding.police;
      else if (bd.kind === 'fire') b.fire += def.upkeep * city.funding.fire;
      else if (def.capacity) b.power += def.upkeep;
      else b.services += def.upkeep;
    }
    b.interest = city.loan * 0.07 / 12;
    const spend = b.transport + b.police + b.fire + b.services + b.power + b.interest;
    city.funds += taxIncome - spend;
    s.lastBudget = b;
    const yb = s.yearBudget;
    for (const k of Object.keys(b) as (keyof Budget)[]) yb[k] += b[k];

    // Underfunded roads crumble.
    if (city.funding.transport < 0.9) {
      const decay = (0.9 - city.funding.transport) * 0.012;
      for (let i = 0; i < world.n; i++) {
        if (world.net[i] & (ROAD | RAIL) && Math.random() < decay) {
          const x = i % world.w;
          const y = (i / world.w) | 0;
          world.clearNet(x, y, ROAD | RAIL);
          if (!world.water[i]) world.rubble[i] = 1;
          this.say('potholes', 'Underfunded roads are falling apart.', 'warn', { x, y }, 6);
        }
      }
    }
    if (city.funds < 0) this.say('debt', 'The city is in debt. Raise taxes, cut costs, or take a loan.', 'alert', undefined, 3);
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
    if (city.loan + amount > 30000) return false;
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

  evaluate(): void {
    const s = this.stats;
    const city = this.world.city;
    const probs: Problem[] = [
      { id: 'crime', label: 'Crime', value: clamp((s.avgCrime / 255) * 160, 0, 100) },
      { id: 'pollution', label: 'Pollution', value: clamp((s.avgPollution / 255) * 170, 0, 100) },
      { id: 'housing', label: 'Housing costs', value: clamp(((s.avgLandValue - 60) / 195) * 90, 0, 100) },
      { id: 'taxes', label: 'Taxes', value: clamp((city.tax - 4) * 6.5, 0, 100) },
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
    const growth = s.residents - this.lastPop;
    s.migration = growth;
    const mood = clamp(88 - pain * 1.15 + clamp(growth / 60, -8, 8), 0, 100);
    s.approval = s.residents > 0 ? s.approval * 0.7 + mood * 0.3 : 50;
    const classIdx = CITY_CLASSES.findIndex((c) => c.name === s.cityClass);
    s.score = Math.round(clamp(s.approval * 7 + classIdx * 50 + Math.min(50, s.avgLandValue / 3), 0, 1000));
    this.lastPop = s.residents;
  }

  private advise(): void {
    const s = this.stats;
    const world = this.world;
    const city = world.city;
    const zones = s.zones.res + s.zones.com + s.zones.ind;
    const month = city.month;
    if (zones > 0 && s.powerSupply === 0) {
      this.say('noplant', 'Zones are waiting for electricity. Build a power plant and connect it.', 'warn', undefined, 4);
    } else if (s.unpowered > 0 && s.powerDemand > s.powerSupply) {
      this.say('brownout', `Brownouts: demand is ${s.powerDemand} MW but plants supply ${s.powerSupply} MW.`, 'warn', this.findUnpowered(), 6);
    } else if (s.unpowered > 0 && month > 2) {
      this.say('unconnected', `${s.unpowered} zone${s.unpowered > 1 ? 's are' : ' is'} not connected to the grid.`, 'warn', this.findUnpowered(), 8);
    }
    if (s.noRoad > 0 && month > 1) this.say('noroad', 'Some zones have no road access and cannot develop.', 'warn', undefined, 10);
    if (s.noTrip > 2 && month > 3) this.say('notrip', 'Commuters cannot reach work. Connect residential zones to commercial and industrial ones by road.', 'warn', undefined, 10);
    const d = city.demand;
    if (zones === 0) {
      if (month >= 2) this.say('nozones', 'Nothing is zoned yet. Pick Residential, Commercial or Industrial from the toolbox and drag across open land next to a road.', 'info', undefined, 12);
    } else if (d.r > 0.45 && s.vacant.res < 2) this.say('needres', 'People want to move here. Zone more residential land.', 'info', undefined, 8);
    if (zones > 0 && d.c > 0.45 && s.vacant.com < 2) this.say('needcom', 'Shops are in demand. Zone more commercial land.', 'info', undefined, 8);
    if (zones > 0 && d.i > 0.45 && s.vacant.ind < 2) this.say('needind', 'Factories are looking for space. Zone more industrial land.', 'info', undefined, 8);
    if (s.avgTraffic > 110) this.say('traffic', 'Traffic jams are getting bad. Add roads or rail.', 'warn', undefined, 12);
    if (s.avgPollution > 100) this.say('pollution', 'Pollution is choking the city.', 'warn', undefined, 12);
    if (s.avgCrime > 90) this.say('crime', 'Crime is rising. More police stations would help.', 'warn', undefined, 12);
    if (s.residents > 3000 && s.powerSupply > 0 && s.powerDemand > s.powerSupply * 0.9 && s.powerDemand <= s.powerSupply) {
      this.say('powerlow', `Power reserve is thin: ${s.powerSupply - s.powerDemand} MW left.`, 'info', undefined, 12);
    }
    if (city.tax >= 13) this.say('tax', 'Citizens are grumbling about high taxes.', 'info', undefined, 12);
    let fireStations = 0, police = 0;
    for (const b of world.buildings.values()) {
      if (b.kind === 'fire') fireStations++;
      if (b.kind === 'police') police++;
    }
    if (s.residents > 2500 && fireStations === 0) this.say('needfire', 'The city has no fire station.', 'info', undefined, 18);
    if (s.residents > 2500 && police === 0) this.say('needpolice', 'The city has no police station.', 'info', undefined, 18);

    const idx = CITY_CLASSES.findIndex((c) => c.name === s.cityClass);
    if (idx > city.classReached) {
      city.classReached = idx;
      this.say('class' + idx, `${city.name} has ${CITY_CLASSES[idx].min.toLocaleString()} residents and is now a ${CITY_CLASSES[idx].name.toLowerCase()}.`, 'good', undefined, 0);
    }
  }

  private findUnpowered(): { x: number; y: number } | undefined {
    for (const b of this.world.buildings.values()) {
      if (isZone(b.kind) && !b.powered) return { x: b.x + 1, y: b.y + 1 };
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
    push(h.pop, s.residents);
    push(h.res, s.residents);
    push(h.com, s.comJobs);
    push(h.ind, s.indJobs);
    push(h.funds, this.world.city.funds);
    push(h.crime, s.avgCrime);
    push(h.pollution, s.avgPollution);
    push(h.income, b.taxIncome);
    push(h.expense, b.transport + b.police + b.fire + b.services + b.power + b.interest);
  }

  /** Human-readable description of a tile for the inspect tool. */
  describe(x: number, y: number): { title: string; rows: [string, string][] } {
    const world = this.world;
    const i = y * world.w + x;
    const rows: [string, string][] = [];
    let title = 'Open land';
    const b = world.buildingAt(x, y);
    const net = world.net[i];
    if (b) {
      const def = BUILDINGS[b.kind];
      title = def.name;
      if (isZone(b.kind)) {
        const k = b.kind as 'res' | 'com' | 'ind';
        title = zoneTitle(k, b.level);
        rows.push([k === 'res' ? 'Residents' : 'Jobs', b.pop.toLocaleString()]);
        rows.push(['Density', `${b.level} of ${ZONE_POP[k].length - 1}`]);
        if (!b.road) rows.push(['Problem', 'No road access']);
        else if (!b.trip) rows.push(['Problem', 'Commute too long']);
      }
      if (def.capacity) rows.push(['Output', `${def.capacity} MW`]);
      rows.push(['Power', def.capacity ? 'Generating' : b.powered ? 'Connected' : b.kind === 'park' ? 'Not needed' : 'None']);
      if (def.upkeep) rows.push(['Upkeep', `$${def.upkeep}/mo`]);
    } else if (world.water[i]) {
      title = net & ROAD ? 'Road bridge' : net & RAIL ? 'Rail bridge' : net & POWER ? 'Power line' : 'Water';
    } else if (net) {
      const parts = [];
      if (net & ROAD) parts.push('Road');
      if (net & RAIL) parts.push('Rail');
      if (net & POWER) parts.push('Power line');
      title = parts.join(' + ');
      if (net & ROAD) rows.push(['Traffic', level5(world.traffic[i])]);
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
      rows.push(['Land value', `$${(world.landValue[i] * 40).toLocaleString()}/acre`]);
      rows.push(['Pollution', level5(world.pollution[i])]);
      rows.push(['Crime', level5(world.crime[i])]);
    }
    return { title, rows };
  }

  dateLabel(): string {
    return dateLabel(this.world.city.month);
  }
}

export function zoneTitle(k: 'res' | 'com' | 'ind', level: number): string {
  if (level === 0) return { res: 'Vacant residential lot', com: 'Vacant commercial lot', ind: 'Vacant industrial lot' }[k];
  if (k === 'res') return level <= 2 ? 'Cottages' : level <= 4 ? 'Houses' : level === 5 ? 'Row apartments' : level <= 7 ? 'Apartment blocks' : 'Residential towers';
  if (k === 'com') return ['', 'Corner shops', 'Main street', 'Offices', 'Office towers', 'Downtown skyscrapers'][level];
  return ['', 'Workshops', 'Warehouses', 'Factories', 'Heavy industry'][level];
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

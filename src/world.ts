// The map and everything built on it. Pure data plus placement rules; the
// simulation and renderer both read from here.
import {
  AUTO_GRADE, BUILDINGS, BuildingDef, Difficulty, Kind, POWER, RAIL, ROAD, isZone, ZONE_POP,
} from './defs';

export interface Building {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  size: number;
  level: number;
  pop: number;
  powered: boolean;
  seed: number;
  age: number;
  /** Zone has a road next to it. */
  road: boolean;
  /** Last month's commute found a destination. */
  trip: boolean;
}

export interface History {
  pop: number[];
  res: number[];
  com: number[];
  ind: number[];
  funds: number[];
  crime: number[];
  pollution: number[];
  income: number[];
  expense: number[];
}

export interface CityState {
  name: string;
  difficulty: Difficulty['id'];
  funds: number;
  month: number;
  tax: number;
  funding: { police: number; fire: number; transport: number };
  demand: { r: number; c: number; i: number };
  disasters: boolean;
  founded: boolean;
  seed: string;
  history: History;
  classReached: number;
  loan: number;
  /** Set when the city is a challenge: which one, the deadline month, and the outcome once decided. */
  scenario?: { id: string; end: number; done: '' | 'won' | 'lost' };
}

export function emptyHistory(): History {
  return { pop: [], res: [], com: [], ind: [], funds: [], crime: [], pollution: [], income: [], expense: [] };
}

export function newCityState(): CityState {
  return {
    name: 'New City',
    difficulty: 'easy',
    funds: 20000,
    month: 0,
    tax: 7,
    funding: { police: 1, fire: 1, transport: 1 },
    demand: { r: 0.4, c: 0.2, i: 0.3 },
    disasters: true,
    founded: false,
    seed: '',
    history: emptyHistory(),
    classReached: 0,
    loan: 0,
  };
}

export type DirtyListener = (x0: number, y0: number, x1: number, y1: number, terrain: boolean) => void;

export class World {
  readonly w: number;
  readonly h: number;
  readonly n: number;

  /** Ground elevation in metres. Sea level is 0. */
  height: Float32Array;
  water: Uint8Array;
  /** Tree density 0-3. */
  trees: Uint8Array;
  net: Uint8Array;
  /** Building id per tile, 0 for none. */
  occ: Int32Array;
  /** 1 = rubble that has to be cleared. */
  rubble: Uint8Array;
  /** Weeks of fire left on the tile. */
  fire: Uint8Array;
  /** Weeks of flood water left. */
  flood: Uint8Array;
  /** Years of fallout left. */
  rad: Uint8Array;

  // Maps written by the simulation, 0-255.
  powered: Uint8Array;
  traffic: Uint8Array;
  pollution: Uint8Array;
  crime: Uint8Array;
  landValue: Uint8Array;
  density: Uint8Array;
  policeCov: Uint8Array;
  fireCov: Uint8Array;
  serviceCov: Uint8Array;

  buildings = new Map<number, Building>();
  nextId = 1;
  city: CityState = newCityState();

  private listeners: DirtyListener[] = [];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = (this.n = w * h);
    this.height = new Float32Array(n);
    this.water = new Uint8Array(n);
    this.trees = new Uint8Array(n);
    this.net = new Uint8Array(n);
    this.occ = new Int32Array(n);
    this.rubble = new Uint8Array(n);
    this.fire = new Uint8Array(n);
    this.flood = new Uint8Array(n);
    this.rad = new Uint8Array(n);
    this.powered = new Uint8Array(n);
    this.traffic = new Uint8Array(n);
    this.pollution = new Uint8Array(n);
    this.crime = new Uint8Array(n);
    this.landValue = new Uint8Array(n);
    this.density = new Uint8Array(n);
    this.policeCov = new Uint8Array(n);
    this.fireCov = new Uint8Array(n);
    this.serviceCov = new Uint8Array(n);
  }

  onDirty(fn: DirtyListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Tell renderers that tiles in [x0,x1]x[y0,y1] changed. */
  dirty(x0: number, y0: number, x1: number, y1: number, terrain = false): void {
    for (const l of this.listeners) l(x0, y0, x1, y1, terrain);
  }

  dirtyAll(terrain = true): void {
    this.dirty(0, 0, this.w - 1, this.h - 1, terrain);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  buildingAt(x: number, y: number): Building | undefined {
    if (!this.inBounds(x, y)) return undefined;
    const id = this.occ[y * this.w + x];
    return id ? this.buildings.get(id) : undefined;
  }

  /** Largest height step from this tile to a 4-neighbour. */
  slope(x: number, y: number): number {
    const h0 = this.height[y * this.w + x];
    let m = 0;
    if (x > 0) m = Math.max(m, Math.abs(h0 - this.height[y * this.w + x - 1]));
    if (x < this.w - 1) m = Math.max(m, Math.abs(h0 - this.height[y * this.w + x + 1]));
    if (y > 0) m = Math.max(m, Math.abs(h0 - this.height[(y - 1) * this.w + x]));
    if (y < this.h - 1) m = Math.max(m, Math.abs(h0 - this.height[(y + 1) * this.w + x]));
    return m;
  }

  footprintSpread(x: number, y: number, size: number): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const h = this.height[(y + dy) * this.w + x + dx];
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return hi - lo;
  }

  // ---- buildings -------------------------------------------------------

  /**
   * Can `kind` go here? With grade=true a moderately steep lot is allowed and
   * `grade` reports the metres of earth that levelling it would move.
   */
  canPlace(kind: Kind, x: number, y: number, grade = false): { ok: boolean; reason?: string; clear: number; grade: number } {
    const def = BUILDINGS[kind];
    const s = def.size;
    if (x < 0 || y < 0 || x + s > this.w || y + s > this.h) return { ok: false, reason: 'Off the map', clear: 0, grade: 0 };
    let clear = 0;
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) {
        const i = (y + dy) * this.w + x + dx;
        if (this.water[i] || this.flood[i]) return { ok: false, reason: 'Needs dry land', clear: 0, grade: 0 };
        if (this.occ[i]) return { ok: false, reason: 'Something is already here', clear: 0, grade: 0 };
        if (this.net[i]) return { ok: false, reason: 'Clear the roads and lines first', clear: 0, grade: 0 };
        if (this.fire[i]) return { ok: false, reason: 'On fire', clear: 0, grade: 0 };
        if (this.rad[i]) return { ok: false, reason: 'Radioactive ground', clear: 0, grade: 0 };
        if (this.trees[i] || this.rubble[i]) clear++;
      }
    }
    if (def.needsShore && !this.touchesWater(x, y, s)) return { ok: false, reason: 'Must touch the shore', clear: 0, grade: 0 };
    const spread = this.footprintSpread(x, y, s);
    if (spread > def.maxSpread) {
      if (!grade || spread > def.maxSpread * AUTO_GRADE) {
        return { ok: false, reason: 'Too steep. Flatten it first with Level land (L), or pick gentler ground', clear: 0, grade: 0 };
      }
      return { ok: true, clear, grade: this.gradeInfo(x, y, s).moved };
    }
    return { ok: true, clear, grade: 0 };
  }

  /** Average height of a square lot and the metres of earth needed to make it flat. */
  gradeInfo(x: number, y: number, s: number): { avg: number; moved: number } {
    let sum = 0;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) sum += this.height[(y + dy) * this.w + x + dx];
    const avg = sum / (s * s);
    let moved = 0;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) moved += Math.abs(this.height[(y + dy) * this.w + x + dx] - avg);
    return { avg, moved };
  }

  /** Flatten a square lot to its average height. */
  grade(x: number, y: number, s: number): void {
    const { avg } = this.gradeInfo(x, y, s);
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) this.height[(y + dy) * this.w + x + dx] = Math.max(0.4, avg);
    this.dirty(x - 1, y - 1, x + s, y + s, true);
  }

  touchesWater(x: number, y: number, s: number): boolean {
    for (let d = -1; d <= s; d++) {
      const pts = [[x + d, y - 1], [x + d, y + s], [x - 1, y + d], [x + s, y + d]];
      for (const [px, py] of pts) {
        if (this.inBounds(px, py) && this.water[py * this.w + px]) return true;
      }
    }
    return false;
  }

  place(kind: Kind, x: number, y: number, seed?: number): Building {
    const def: BuildingDef = BUILDINGS[kind];
    const s = def.size;
    const id = this.nextId++;
    const b: Building = {
      id, kind, x, y, size: s,
      level: 0, pop: 0, powered: false,
      seed: seed ?? ((Math.random() * 0x7fffffff) | 0),
      age: 0, road: true, trip: true,
    };
    if (!isZone(kind)) b.level = 1;
    this.buildings.set(id, b);
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) {
        const i = (y + dy) * this.w + x + dx;
        this.occ[i] = id;
        this.trees[i] = 0;
        this.rubble[i] = 0;
      }
    }
    this.dirty(x - 1, y - 1, x + s, y + s);
    return b;
  }

  /** Remove a building. With rubble=true it leaves debris behind. */
  remove(id: number, rubble = false): void {
    const b = this.buildings.get(id);
    if (!b) return;
    for (let dy = 0; dy < b.size; dy++) {
      for (let dx = 0; dx < b.size; dx++) {
        const i = (b.y + dy) * this.w + b.x + dx;
        this.occ[i] = 0;
        if (rubble) this.rubble[i] = 1;
      }
    }
    this.buildings.delete(id);
    this.dirty(b.x - 1, b.y - 1, b.x + b.size, b.y + b.size);
  }

  setLevel(b: Building, level: number): void {
    b.level = level;
    if (isZone(b.kind)) b.pop = ZONE_POP[b.kind as 'res' | 'com' | 'ind'][level];
    this.dirty(b.x, b.y, b.x + b.size - 1, b.y + b.size - 1);
  }

  // ---- networks --------------------------------------------------------

  /** Can `bit` be laid on this tile? Returns the reason when not. */
  canNet(bit: number, x: number, y: number): string | null {
    if (!this.inBounds(x, y)) return 'Off the map';
    const i = y * this.w + x;
    if (this.occ[i]) return 'A building is in the way';
    if (this.rad[i]) return 'Radioactive ground';
    if (this.fire[i]) return 'On fire';
    // Slope is judged along the whole line, in planLine.
    return null;
  }

  setNet(bit: number, x: number, y: number): void {
    const i = y * this.w + x;
    this.net[i] |= bit;
    this.trees[i] = 0;
    this.rubble[i] = 0;
    this.dirty(x - 1, y - 1, x + 1, y + 1);
  }

  clearNet(x: number, y: number, bits = 0xff): void {
    const i = y * this.w + x;
    if (!(this.net[i] & bits)) return;
    this.net[i] &= ~bits;
    this.dirty(x - 1, y - 1, x + 1, y + 1);
  }

  /** Clear one tile. Returns true if anything was removed. */
  bulldoze(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = y * this.w + x;
    let did = false;
    if (this.occ[i]) {
      this.remove(this.occ[i]);
      did = true;
    }
    if (this.net[i]) {
      this.clearNet(x, y);
      did = true;
    }
    if (this.trees[i] || this.rubble[i]) {
      this.trees[i] = 0;
      this.rubble[i] = 0;
      this.dirty(x, y, x, y);
      did = true;
    }
    return did;
  }

  isEmptyLand(i: number): boolean {
    return !this.water[i] && !this.occ[i] && !this.net[i];
  }

  countNet(): { road: number; rail: number; bridge: number } {
    let road = 0, rail = 0, bridge = 0;
    for (let i = 0; i < this.n; i++) {
      const v = this.net[i];
      if (!v) continue;
      if (this.water[i] && v & (ROAD | RAIL)) bridge++;
      else {
        if (v & ROAD) road++;
        if (v & RAIL) rail++;
      }
    }
    return { road, rail, bridge };
  }

  // ---- persistence -----------------------------------------------------

  serialize(): SavedWorld {
    return {
      v: 1,
      w: this.w,
      h: this.h,
      height: encodeArray(new Uint8Array(this.height.buffer.slice(0))),
      water: encodeArray(this.water),
      trees: encodeArray(this.trees),
      net: encodeArray(this.net),
      rubble: encodeArray(this.rubble),
      fire: encodeArray(this.fire),
      flood: encodeArray(this.flood),
      rad: encodeArray(this.rad),
      buildings: [...this.buildings.values()].map((b) => [b.id, b.kind, b.x, b.y, b.level, b.seed, b.age]),
      nextId: this.nextId,
      city: JSON.parse(JSON.stringify(this.city)),
    };
  }

  static deserialize(s: SavedWorld): World {
    if (!(s.w > 0 && s.h > 0 && s.w <= 1024 && s.h <= 1024)) throw new Error('The saved map has an impossible size.');
    const w = new World(s.w, s.h);
    const n = s.w * s.h;
    const bytes = (a: Uint8Array, len: number, what: string) => {
      if (a.length !== len) throw new Error(`The saved ${what} layer is damaged.`);
      return a;
    };
    w.height = new Float32Array(bytes(decodeArray(s.height), n * 4, 'height').buffer);
    w.water = bytes(decodeArray(s.water), n, 'water');
    w.trees = bytes(decodeArray(s.trees), n, 'tree');
    w.net = bytes(decodeArray(s.net), n, 'road');
    w.rubble = bytes(decodeArray(s.rubble), n, 'rubble');
    w.fire = bytes(decodeArray(s.fire), n, 'fire');
    w.flood = bytes(decodeArray(s.flood), n, 'flood');
    w.rad = bytes(decodeArray(s.rad), n, 'radiation');
    for (const [id, kind, x, y, level, seed, age] of s.buildings) {
      const def = BUILDINGS[kind as Kind];
      if (!def || !(id > 0) || x < 0 || y < 0 || x + def.size > s.w || y + def.size > s.h) continue;
      let clash = false;
      for (let dy = 0; dy < def.size && !clash; dy++) for (let dx = 0; dx < def.size; dx++) if (w.occ[(y + dy) * s.w + x + dx]) clash = true;
      if (clash) continue;
      const b: Building = {
        id, kind: kind as Kind, x, y, size: def.size, level, pop: 0,
        powered: false, seed, age, road: true, trip: true,
      };
      if (isZone(b.kind)) b.pop = ZONE_POP[b.kind as 'res' | 'com' | 'ind'][level] ?? 0;
      w.buildings.set(id, b);
      for (let dy = 0; dy < def.size; dy++) {
        for (let dx = 0; dx < def.size; dx++) w.occ[(y + dy) * w.w + x + dx] = id;
      }
    }
    w.nextId = Math.max(s.nextId, ...[...w.buildings.keys()].map((k) => k + 1), 1);
    w.city = { ...newCityState(), ...s.city };
    w.city.history = { ...emptyHistory(), ...s.city.history };
    return w;
  }

  /** Cheap in-memory copy of everything the player can change, for undo. */
  snapshot(): WorldSnapshot {
    return {
      height: this.height.slice(),
      water: this.water.slice(),
      trees: this.trees.slice(),
      net: this.net.slice(),
      occ: this.occ.slice(),
      rubble: this.rubble.slice(),
      buildings: [...this.buildings.values()].map((b) => ({ ...b })),
      nextId: this.nextId,
    };
  }

  /** Put the map back as it was. Money is the caller's business. Returns false for a snapshot of another map. */
  restore(s: WorldSnapshot): boolean {
    if (s.height.length !== this.n) return false;
    this.height.set(s.height);
    this.water.set(s.water);
    this.trees.set(s.trees);
    this.net.set(s.net);
    this.occ.set(s.occ);
    this.rubble.set(s.rubble);
    this.buildings = new Map(s.buildings.map((b) => [b.id, { ...b }]));
    this.nextId = s.nextId;
    this.dirtyAll(true);
    return true;
  }
}

export interface WorldSnapshot {
  height: Float32Array;
  water: Uint8Array;
  trees: Uint8Array;
  net: Uint8Array;
  occ: Int32Array;
  rubble: Uint8Array;
  buildings: Building[];
  nextId: number;
}

export interface SavedWorld {
  v: number;
  w: number;
  h: number;
  height: string;
  water: string;
  trees: string;
  net: string;
  rubble: string;
  fire: string;
  flood: string;
  rad: string;
  buildings: [number, string, number, number, number, number, number][];
  nextId: number;
  city: CityState;
}

// Run-length + base64. Maps are mostly long runs of the same byte.
export function encodeArray(a: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let run = 1;
    while (i + run < a.length && a[i + run] === v && run < 255) run++;
    if (run >= 3 || v === 0xff) {
      out.push(0xff, run, v);
      i += run;
    } else {
      out.push(v);
      i++;
    }
  }
  let bin = '';
  const chunk = 0x8000;
  for (let j = 0; j < out.length; j += chunk) {
    bin += String.fromCharCode.apply(null, out.slice(j, j + chunk));
  }
  return `${a.length}:${btoa(bin)}`;
}

export function decodeArray(s: string): Uint8Array {
  const colon = s.indexOf(':');
  const len = parseInt(s.slice(0, colon), 10);
  const bin = atob(s.slice(colon + 1));
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < bin.length && o < len; ) {
    const c = bin.charCodeAt(i);
    if (c === 0xff) {
      const run = bin.charCodeAt(i + 1);
      const v = bin.charCodeAt(i + 2);
      out.fill(v, o, o + run);
      o += run;
      i += 3;
    } else {
      out[o++] = c;
      i++;
    }
  }
  return out;
}

export { ROAD, RAIL, POWER };

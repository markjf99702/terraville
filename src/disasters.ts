// Fires, floods, tornadoes, earthquakes, the monster, and meltdowns.
import { BUILDINGS, DIFFICULTIES, DISASTER_POP, FIRE_WEEKS, RAIL, ROAD, article, buildingName, isZone } from './defs';
import { type Sim, zoneTitle } from './sim';
import type { Building, SavedRun } from './world';

export type DisasterKind = 'fire' | 'flood' | 'tornado' | 'earthquake' | 'monster' | 'meltdown';

export const DISASTER_NAMES: Record<DisasterKind, string> = {
  fire: 'Fire',
  flood: 'Flood',
  tornado: 'Tornado',
  earthquake: 'Earthquake',
  monster: 'Monster',
  meltdown: 'Meltdown',
};

export interface Roamer {
  kind: 'tornado' | 'monster';
  x: number;
  y: number;
  /** Position one step ago, for smooth drawing between steps. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  weeks: number;
  heading: number;
  /** Buildings it has wrecked so far, for the line it ends with. */
  wrecked?: number;
}

/**
 * One fire and everything that caught from it: tiles alight within a few tiles of each other belong to the same one.
 * It is news once, when its first building catches, and once more when the last of it is out.
 */
interface Blaze {
  /** Where its first building caught, for Go there. */
  x: number;
  y: number;
  burned: number;
  /** Whether it has been news: a fire in woods or rubble isn't, until it reaches a building. */
  told: boolean;
  /** Several fires set off at once, quietly, by a challenge's opening: told as one, and out when all are. */
  many?: boolean;
}

/** How far inland a high tide gets from the shore where it comes in, in tiles: four a week for five weeks. */
export const TIDE_REACH = 20;

/** A tile's four neighbours on a map `w` wide and `h` high, -1 where it is the edge. */
function neighbours(i: number, w: number, h: number): number[] {
  const x = i % w, y = (i / w) | 0;
  return [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
}

/** How near a new fire must be to one already burning to be part of it, in tiles. */
const BLAZE_REACH = 6;

/** What a disaster does to a building it takes, in the news: 'The tornado wrecked the fire station.' */
const LOST: Record<string, (what: string) => string> = {
  fire: (what) => `${what[0].toUpperCase()}${what.slice(1)} burned down.`,
  tornado: (what) => `The tornado wrecked ${what}.`,
  monster: (what) => `The monster wrecked ${what}.`,
  earthquake: (what) => `The earthquake brought down ${what}.`,
  flood: (what) => `The flood washed away ${what}.`,
  meltdown: (what) => `The meltdown destroyed ${what}.`,
};

/** '6 buildings', or 'a building'. */
function buildings(n: number): string {
  return n === 1 ? 'a building' : `${n.toLocaleString('en-US')} buildings`;
}

export class Disasters {
  roamers: Roamer[] = [];
  /** Seconds of screen shake left; the renderer counts it down. */
  shake = 0;
  /** Where the latest earthquake struck. */
  lastQuake: { x: number; y: number } | null = null;
  private floodLevel = 0;
  private floodAge = 0;
  /** A high tide under way comes in from the whole shore, and further: see tide(). */
  private floodTide = false;
  /** Buildings the flood under way has washed away, for the line it ends with. */
  private floodWrecked = 0;
  /** While set, a disaster set off says nothing: a challenge's opening says it all in one line. */
  private quiet = false;
  /** Each burning tile's fire, by number, and each fire's record. */
  private blazeAt: Int32Array | null = null;
  private blazes = new Map<number, Blaze>();
  private nextBlaze = 1;
  /** The fire that fires set off quietly join. */
  private quietBlaze = 0;

  constructor(private sim: Sim) {}

  private get world() {
    return this.sim.world;
  }

  /** The news, unless a challenge's opening is saying it all in one line. */
  private say(...a: Parameters<Sim['say']>): void {
    if (!this.quiet) this.sim.say(...a);
  }

  /** A tornado or monster under way and a flood still rising, for a save. */
  saveRun(): Pick<SavedRun, 'roamers' | 'floodLevel' | 'floodAge' | 'floodWrecked' | 'floodTide'> {
    return {
      roamers: this.roamers.map(({ kind, x, y, vx, vy, weeks, heading, wrecked }) => ({ kind, x, y, vx, vy, weeks, heading, wrecked: wrecked ?? 0 })),
      floodLevel: this.floodLevel,
      floodAge: this.floodAge,
      floodWrecked: this.floodWrecked,
      floodTide: this.floodTide,
    };
  }

  resume(run: Pick<SavedRun, 'roamers' | 'floodLevel' | 'floodAge' | 'floodWrecked' | 'floodTide'>): void {
    this.roamers = run.roamers.map((r) => ({ ...r, px: r.x, py: r.y }));
    this.floodLevel = run.floodLevel;
    this.floodAge = run.floodAge;
    this.floodWrecked = run.floodWrecked ?? 0;
    this.floodTide = !!run.floodTide;
  }

  week(): void {
    this.spreadFire();
    this.spreadFlood();
    this.moveRoamers();
  }

  month(): void {
    const city = this.world.city;
    if (!city.disasters || !city.founded) return;
    const diff = DIFFICULTIES.find((d) => d.id === city.difficulty) ?? DIFFICULTIES[0];
    const f = diff.disasters;
    const pop = this.sim.stats.residents;
    if (pop < DISASTER_POP) return;
    const r = Math.random();
    // Rough monthly odds; fire is by far the most common.
    if (r < 0.06 * f) this.randomFire(false);
    else if (r < 0.06 * f + 0.006 * f) this.trigger('flood');
    else if (r < 0.066 * f + 0.004 * f) this.trigger('tornado');
    else if (r < 0.07 * f + 0.0025 * f) this.trigger('earthquake');
    else if (r < 0.0725 * f + 0.002 * f && this.sim.stats.avgPollution > 60) this.trigger('monster');
    // Each plant: about 11%, 21% and 32% over 50 years on Easy, Medium and Hard. Rarely, as the toolbox says.
    for (const b of this.world.buildings.values()) {
      if (b.kind === 'nuclear' && Math.random() < 0.0004 * f) this.meltdown(b);
    }
  }

  /**
   * Set off a disaster now, from the Disasters menu or a challenge's opening. `sparePlants` is for a challenge's
   * scripted opening: an earthquake strikes under a zone and leaves the power plants standing, and a fire starts
   * anywhere but a plant, so a challenge isn't lost to its own opening before the first click. `quiet` leaves the
   * news to the opening, which says it in one line; the dice fall as they would anyway.
   */
  trigger(kind: DisasterKind, o: { sparePlants?: boolean; quiet?: boolean } = {}): void {
    const was = this.quiet;
    this.quiet = was || !!o.quiet;
    try {
      this.setOff(kind, !!o.sparePlants);
    } finally {
      this.quiet = was;
    }
  }

  private setOff(kind: DisasterKind, sparePlants: boolean): void {
    switch (kind) {
      case 'fire': return this.randomFire(true, sparePlants);
      case 'flood': return this.startFlood();
      case 'tornado': return this.spawnRoamer('tornado');
      case 'earthquake': return this.earthquake(sparePlants);
      case 'monster': return this.spawnRoamer('monster');
      case 'meltdown': {
        const plants = [...this.world.buildings.values()].filter((b) => b.kind === 'nuclear');
        if (!plants.length) {
          this.say('nomelt', 'There is no nuclear plant to melt down.', 'info', undefined, 0);
          return;
        }
        this.meltdown(plants[Math.floor(Math.random() * plants.length)]);
      }
    }
  }

  // ---- fire ------------------------------------------------------------

  /**
   * A fire in a building. Left to chance, buildings far from fire stations are more likely to go up, and a city well
   * covered may get none; `forced` (set off from the menu) always starts one where there is something to burn.
   */
  private randomFire(forced: boolean, sparePlants = false): void {
    const world = this.world;
    const cands: Building[] = [];
    for (const b of world.buildings.values()) {
      if (b.kind === 'park' || (sparePlants && BUILDINGS[b.kind].capacity)) continue;
      if (b.kind === 'res' || b.kind === 'com' || b.kind === 'ind' ? b.level > 0 : true) cands.push(b);
    }
    if (!cands.length) {
      if (forced) this.say('nofire', 'There is nothing here to burn yet.', 'info', undefined, 0);
      return;
    }
    if (forced) {
      const cold = cands.filter((b) => !world.fire[b.y * world.w + b.x]);
      const b = cold[Math.floor(Math.random() * cold.length)];
      if (b) this.ignite(b.x, b.y);
      return;
    }
    for (let t = 0; t < 6; t++) {
      const b = cands[Math.floor(Math.random() * cands.length)];
      const cov = world.fireCov[(b.y + 1) * world.w + b.x + 1] / 255;
      if (Math.random() > cov * 0.85) {
        this.ignite(b.x, b.y);
        return;
      }
    }
  }

  /**
   * Set a tile (and the whole building on it) alight. A fire that starts near one already burning, or catches from
   * one (`from`, its number), is part of it and says nothing; one that starts away from any, or the first building a
   * fire in woods or rubble reaches, is news.
   */
  ignite(x: number, y: number, from = 0): void {
    const world = this.world;
    if (!world.inBounds(x, y)) return;
    const i = y * world.w + x;
    if (world.water[i] || world.fire[i]) return;
    const b = world.buildingAt(x, y);
    const weeks = 5 + Math.floor(Math.random() * (FIRE_WEEKS - 4));
    if (b) {
      const c = Math.floor(b.size / 2);
      const id = this.blazeFor(b.x, b.y, b.size, { x: b.x + c, y: b.y + c }, from);
      for (let dy = 0; dy < b.size; dy++) {
        for (let dx = 0; dx < b.size; dx++) this.light((b.y + dy) * world.w + b.x + dx, weeks, id);
      }
      world.dirty(b.x, b.y, b.x + b.size - 1, b.y + b.size - 1);
      const blaze = this.blazes.get(id)!;
      if (!blaze.told) {
        blaze.told = true;
        const covered = world.fireCov[(b.y + c) * world.w + b.x + c] > 0;
        const what = covered ? 'Firefighters are on the way.' : 'No fire station reaches it: bulldoze a gap around it to stop it spreading.';
        this.say('fire' + id, `Fire at ${firePlace(b)}. ${what}`, 'alert', { x: b.x + c, y: b.y + c }, 0);
      }
      this.sim.emit({ type: 'disaster', kind: 'fire', x, y });
      this.sim.powerDirty = true;
    } else if (world.trees[i]) {
      this.light(i, weeks, this.blazeFor(x, y, 1, { x, y }, from));
      world.dirty(x, y, x, y);
    }
  }

  /** Each tile's fire number, kept beside the fire layer. */
  private get blazeMap(): Int32Array {
    if (!this.blazeAt || this.blazeAt.length !== this.world.n) this.blazeAt = new Int32Array(this.world.n);
    return this.blazeAt;
  }

  private light(i: number, weeks: number, id: number): void {
    this.world.fire[i] = weeks;
    this.blazeMap[i] = id;
  }

  /**
   * The fire burning within reach of a square, or the one it caught from (`from`), joined into one if there are more
   * than one; or a new one, at `at`. Tiles in reach burning with no fire of their own (since the city was saved, say)
   * join it too.
   */
  private blazeFor(x0: number, y0: number, size: number, at: { x: number; y: number }, from = 0): number {
    const world = this.world;
    const map = this.blazeMap;
    // What it caught from may have come down, or been put out, this very week: it is the same fire all the same.
    let id = this.blazes.has(from) ? from : 0;
    const strays: number[] = [];
    for (let y = Math.max(0, y0 - BLAZE_REACH); y <= Math.min(world.h - 1, y0 + size - 1 + BLAZE_REACH); y++) {
      for (let x = Math.max(0, x0 - BLAZE_REACH); x <= Math.min(world.w - 1, x0 + size - 1 + BLAZE_REACH); x++) {
        const i = y * world.w + x;
        if (!world.fire[i]) continue;
        const near = map[i];
        if (!near || !this.blazes.has(near)) strays.push(i);
        else if (near !== id) id = id ? this.merge(id, near) : near;
      }
    }
    // Fires set off quietly, in a challenge's opening, have been news already, and are one fire for the news.
    if (!id && this.quiet && this.blazes.has(this.quietBlaze)) id = this.quietBlaze;
    if (!id) {
      id = this.nextBlaze++;
      this.blazes.set(id, { ...at, burned: 0, told: this.quiet, many: this.quiet });
      if (this.quiet) this.quietBlaze = id;
    }
    const blaze = this.blazes.get(id)!;
    for (const i of strays) {
      map[i] = id;
      // A building on fire when the city was saved was news then.
      if (world.occ[i]) blaze.told = true;
    }
    return id;
  }

  /** Two fires that have met are one from now on: the older keeps its place, and counts what both burned. */
  private merge(a: number, b: number): number {
    const [keep, gone] = a < b ? [a, b] : [b, a];
    const k = this.blazes.get(keep)!;
    const g = this.blazes.get(gone)!;
    k.burned += g.burned;
    k.told ||= g.told;
    k.many ||= g.many;
    if (this.quietBlaze === gone) this.quietBlaze = keep;
    this.blazes.delete(gone);
    const map = this.blazeMap;
    for (let i = 0; i < map.length; i++) if (map[i] === gone) map[i] = keep;
    return keep;
  }

  /**
   * Give each burning tile with no fire of its own (one burning when the city was saved, say) the fire near it, or a
   * fire of its own, so that what catches from it is no news.
   */
  private adoptStrays(burning: number[]): void {
    const w = this.world.w;
    const map = this.blazeMap;
    for (const i of burning) if (!map[i] || !this.blazes.has(map[i])) this.blazeFor(i % w, (i / w) | 0, 1, { x: i % w, y: (i / w) | 0 });
  }

  /** Each fire with nothing left alight is out: news, with what it burned down, if its start was. */
  private closeBlazes(): void {
    if (!this.blazes.size) return;
    const world = this.world;
    const map = this.blazeMap;
    const alight = new Set<number>();
    for (let i = 0; i < world.n; i++) if (world.fire[i]) alight.add(map[i]);
    for (const [id, f] of this.blazes) {
      if (alight.has(id)) continue;
      this.blazes.delete(id);
      if (!f.told) continue;
      const [out, it] = f.many ? ['The fires are out.', 'They'] : ['The fire is out.', 'It'];
      this.say('out' + id, `${out}${f.burned ? ` ${it} burned down ${buildings(f.burned)}.` : ''}`, 'info', { x: f.x, y: f.y }, 0);
    }
  }

  private spreadFire(): void {
    const world = this.world;
    const { w, h, n } = world;
    const fire = world.fire;
    const burning: number[] = [];
    for (let i = 0; i < n; i++) if (fire[i]) burning.push(i);
    this.adoptStrays(burning);
    if (!burning.length) {
      // Put out some other way since last week, by a flood, say.
      this.closeBlazes();
      return;
    }
    const handled = new Set<number>();
    for (const i of burning) {
      const x = i % w;
      const y = (i / w) | 0;
      // Coverage already falls with the stations' funding (computeMaps), so funding isn't counted again here.
      const cov = world.fireCov[i] / 255;
      // Spread to flammable neighbours.
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (fire[j] || world.water[j]) continue;
        const flammable = world.occ[j] ? world.buildings.get(world.occ[j])?.kind !== 'park' : world.trees[j] > 0;
        if (!flammable) continue;
        const p = (world.occ[j] ? 0.16 : 0.22) * (1 - cov * 0.9);
        if (Math.random() < p) this.ignite(nx, ny, this.blazeMap[i]);
      }
      // Put out, or burnt down along with the rest of its building, earlier in this pass: it still spread this
      // week, as above, but counting it down again would wrap 0 round to 255 weeks.
      if (!fire[i]) continue;
      const id = world.occ[i];
      if (id) {
        if (handled.has(id)) continue;
        handled.add(id);
        const b = world.buildings.get(id);
        if (!b) {
          fire[i] = 0;
          continue;
        }
        // Firefighters: coverage at the building can put it out in time.
        const put = Math.random() < cov * 0.45;
        const left = fire[i] - 1;
        for (let dy = 0; dy < b.size; dy++) {
          for (let dx = 0; dx < b.size; dx++) fire[(b.y + dy) * w + b.x + dx] = put ? 0 : left;
        }
        if (put) {
          world.dirty(b.x, b.y, b.x + b.size - 1, b.y + b.size - 1);
          this.sim.powerDirty = true;
        } else if (left <= 0) {
          this.destroy(b, 'fire');
        }
      } else {
        fire[i]--;
        if (Math.random() < cov * 0.4) fire[i] = 0;
        if (!fire[i]) {
          world.trees[i] = 0;
          world.dirty(x, y, x, y);
        }
      }
    }
    this.closeBlazes();
  }

  /** Set the rubble on a tile alight. It burns out by itself, and spreads to anything flammable next to it. */
  private burnRubble(x: number, y: number): void {
    const world = this.world;
    const i = y * world.w + x;
    if (world.water[i] || world.occ[i] || world.fire[i]) return;
    this.light(i, 5 + Math.floor(Math.random() * (FIRE_WEEKS - 4)), this.blazeFor(x, y, 1, { x, y }));
    world.dirty(x, y, x, y);
  }

  /**
   * Wreck a building, by `cause` ('fire', 'tornado' and so on), and count it against the fire, the flood or `by`, the
   * tornado or monster. Nuclear plants take the neighbourhood with them.
   */
  destroy(b: Building, cause: string, by?: Roamer): void {
    const world = this.world;
    if (!world.buildings.has(b.id)) return;
    // An empty lot or a park is no building to count.
    if (b.kind !== 'park' && !(isZone(b.kind) && b.level === 0)) {
      if (by) by.wrecked = (by.wrecked ?? 0) + 1;
      else if (cause === 'flood') this.floodWrecked++;
      else if (cause === 'fire') {
        const f = this.blazes.get(this.blazeMap[b.y * world.w + b.x]);
        if (f) f.burned++;
      }
    }
    for (let dy = 0; dy < b.size; dy++) {
      for (let dx = 0; dx < b.size; dx++) world.fire[(b.y + dy) * world.w + b.x + dx] = 0;
    }
    world.remove(b.id, true);
    this.sim.powerDirty = true;
    this.sim.emit({ type: 'destroyed', x: b.x + b.size / 2, y: b.y + b.size / 2, kind: b.kind });
    if (!isZone(b.kind) && b.kind !== 'park') this.lost(b, cause);
    if (b.kind === 'nuclear' && cause !== 'meltdown') this.meltdown(b);
  }

  /**
   * A power plant, service or landmark lost is news, at its spot: an alert for the city's last plant, which leaves every
   * zone dark, or its last landmark of a kind; a warning otherwise.
   */
  private lost(b: Building, cause: string): void {
    const world = this.world;
    const name = buildingName(b).toLowerCase();
    let others = false, plants = false, zones = false;
    for (const o of world.buildings.values()) {
      if (o.kind === b.kind) others = true;
      if (BUILDINGS[o.kind].capacity) plants = true;
      if (isZone(o.kind)) zones = true;
    }
    const lastPlant = !!BUILDINGS[b.kind].capacity && !plants;
    // A meltdown says so itself; only the dark that follows is more to say.
    if (cause === 'meltdown' && !lastPlant) return;
    const what = `${others ? article(name) : 'the'} ${name}`;
    let text = (LOST[cause] ?? LOST.earthquake)(what);
    if (lastPlant && zones) {
      text += ' Every zone is dark until another plant is built.';
      this.sim.plantLost = world.city.month;
    }
    const landmark = b.kind === 'stadium' || b.kind === 'seaport' || b.kind === 'airport';
    const c = Math.floor(b.size / 2);
    this.say('lost' + b.id, text, lastPlant || (landmark && !others) ? 'alert' : 'warn', { x: b.x + c, y: b.y + c }, 0);
  }

  private meltdown(b: Building): void {
    const world = this.world;
    const cx = b.x + 2;
    const cy = b.y + 2;
    if (world.buildings.has(b.id)) this.destroy(b, 'meltdown');
    for (let dy = -7; dy <= 7; dy++) {
      for (let dx = -7; dx <= 7; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!world.inBounds(x, y)) continue;
        const d = Math.hypot(dx, dy);
        const i = y * world.w + x;
        if (world.water[i]) continue;
        if (d < 7 && Math.random() < 0.55 - d * 0.05) world.rad[i] = 12 + Math.floor(Math.random() * 10);
        if (d < 5 && Math.random() < 0.2) this.ignite(x, y);
      }
    }
    world.dirty(cx - 8, cy - 8, cx + 8, cy + 8);
    this.shake = Math.max(this.shake, 1.2);
    this.say('meltdown', 'Nuclear meltdown! The area around the plant is contaminated for years.', 'alert', { x: cx, y: cy }, 0);
    this.sim.emit({ type: 'disaster', kind: 'meltdown', x: cx, y: cy });
  }

  // ---- flood -----------------------------------------------------------

  private startFlood(): void {
    const world = this.world;
    const { w, h } = world;
    const shore: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (world.water[i] || world.height[i] > 6) continue;
        if (world.water[i - 1] || world.water[i + 1] || world.water[i - w] || world.water[i + w]) shore.push(i);
      }
    }
    if (!shore.length) {
      this.say('noflood', 'No low shoreline for a flood.', 'info', undefined, 0);
      return;
    }
    // Prefer shoreline near the city.
    let pickI = shore[Math.floor(Math.random() * shore.length)];
    for (let t = 0; t < 30; t++) {
      const c = shore[Math.floor(Math.random() * shore.length)];
      if (world.density[c] > world.density[pickI]) pickI = c;
    }
    this.floodLevel = world.height[pickI] + 2.5 + Math.random() * 2.5;
    this.floodAge = 0;
    this.floodWrecked = 0;
    this.floodTide = false;
    world.flood[pickI] = 16;
    this.floodTile(pickI);
    const x = pickI % w;
    const y = (pickI / w) | 0;
    this.say('flood', 'Flooding along the shore!', 'alert', { x, y }, 0);
    this.sim.emit({ type: 'disaster', kind: 'flood', x, y });
  }

  /**
   * The land a high tide up to `level` metres would cover, as tide() floods it: every tile below the line that the sea
   * reaches over land below the line, within TIDE_REACH tiles of the shore where it comes in. The sea is the water
   * that reaches the edge of the map, so a lake or a river on its own floods nothing, and a bank of land above the line
   * keeps it out of whatever lies behind. The first tiles, those beside the sea, come first in the list.
   */
  tideReach(level: number): { tiles: number[]; first: number } {
    const world = this.world;
    const { w, h, n } = world;
    const sea = new Uint8Array(n);
    const q: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = i % w, y = (i / w) | 0;
      if (world.water[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) {
        sea[i] = 1;
        q.push(i);
      }
    }
    while (q.length) {
      const i = q.pop()!;
      for (const j of neighbours(i, w, h)) {
        if (j >= 0 && !sea[j] && world.water[j]) {
          sea[j] = 1;
          q.push(j);
        }
      }
    }
    const depth = new Int16Array(n).fill(-1);
    const tiles: number[] = [];
    for (let i = 0; i < n; i++) {
      if (world.water[i] || world.height[i] >= level) continue;
      if (neighbours(i, w, h).some((j) => j >= 0 && sea[j])) {
        depth[i] = 0;
        tiles.push(i);
      }
    }
    const first = tiles.length;
    for (let k = 0; k < tiles.length; k++) {
      const i = tiles[k];
      if (depth[i] >= TIDE_REACH) continue;
      for (const j of neighbours(i, w, h)) {
        if (j < 0 || depth[j] >= 0 || world.water[j] || world.height[j] >= level) continue;
        depth[j] = depth[i] + 1;
        tiles.push(j);
      }
    }
    return { tiles, first };
  }

  /** The buildings standing in a tide's way, as the news counts them: no empty lots or parks. */
  inReach(tiles: number[]): Building[] {
    const world = this.world;
    const seen = new Set<Building>();
    for (const i of tiles) {
      const b = world.occ[i] ? world.buildings.get(world.occ[i]) : undefined;
      if (b && b.kind !== 'park' && !(isZone(b.kind) && b.level === 0)) seen.add(b);
    }
    return [...seen];
  }

  /**
   * A high tide, as High Water has them: the sea comes in over the land below `level` metres from every stretch of
   * shore it washes at once, and keeps coming for five weeks, four tiles a week, as far as tideReach() says.
   */
  tide(level: number): void {
    const world = this.world;
    const { w } = world;
    const { tiles, first } = this.tideReach(level);
    if (!first) {
      this.say('flood', `The high tide came up to ${level} m, and the shore kept it out.`, 'good', undefined, 0);
      return;
    }
    const lost = this.inReach(tiles);
    this.floodLevel = level;
    this.floodAge = 0;
    this.floodWrecked = 0;
    this.floodTide = true;
    for (let k = 0; k < first; k++) {
      const i = tiles[k];
      world.flood[i] = 7 + Math.floor(Math.random() * 3);
      this.floodTile(i);
    }
    // For Go there: the first building in its way, or else where it comes ashore nearest the middle of the city.
    let spot = lost[0] ? (lost[0].y + 1) * w + lost[0].x + 1 : -1;
    if (spot < 0) {
      let cx = 0, cy = 0, c = 0;
      for (const b of world.buildings.values()) {
        cx += b.x;
        cy += b.y;
        c++;
      }
      [cx, cy] = c ? [cx / c, cy / c] : [w / 2, world.h / 2];
      let best = Infinity;
      for (let k = 0; k < first; k++) {
        const d = Math.hypot((tiles[k] % w) - cx, ((tiles[k] / w) | 0) - cy);
        if (d < best) { best = d; spot = tiles[k]; }
      }
    }
    const at = { x: spot % w, y: (spot / w) | 0 };
    this.say('flood', `High tide: the sea is coming in over the land below ${level} m.`, 'alert', at, 0);
    this.sim.emit({ type: 'disaster', kind: 'flood', ...at });
  }

  private floodTile(i: number): void {
    const world = this.world;
    const id = world.occ[i];
    if (id) {
      const b = world.buildings.get(id);
      if (b) this.destroy(b, 'flood');
    }
    // The water takes the trees, and any fire in them with them: a fire needs something to burn.
    world.trees[i] = 0;
    world.fire[i] = 0;
    const x = i % world.w;
    const y = (i / world.w) | 0;
    world.dirty(x, y, x, y);
  }

  private spreadFlood(): void {
    const world = this.world;
    const { w, n } = world;
    const flood = world.flood;
    let any = false;
    const grow: number[] = [];
    this.floodAge++;
    // A tide spreads four tiles a week; an ordinary flood one, here and there.
    for (let pass = 0; pass < (this.floodTide ? 4 : 1); pass++) {
      grow.length = 0;
      this.floodReach(grow);
      for (const j of grow) {
        if (flood[j]) continue;
        flood[j] = this.floodTide ? 7 + Math.floor(Math.random() * 3) - this.floodAge : 10 + Math.floor(Math.random() * 6);
        this.floodTile(j);
      }
    }
    for (let i = 0; i < n; i++) if (flood[i]) any = true;
    if (!any) return;
    let left = 0;
    for (let i = 0; i < n; i++) {
      if (!flood[i]) continue;
      flood[i]--;
      if (!flood[i]) {
        const x = i % w;
        const y = (i / w) | 0;
        world.dirty(x, y, x, y);
      } else left++;
    }
    if (!left) {
      const lost = this.floodWrecked;
      const [out, they] = this.floodTide ? ['The tide has gone out.', 'It'] : ['The flood waters have gone down.', 'They'];
      this.say('flooddown', `${out}${lost ? ` ${they} washed away ${buildings(lost)}.` : ''}`, 'info', undefined, 0);
      this.floodWrecked = 0;
      this.floodTide = false;
    }
  }

  /** The land next to the flood that it reaches this pass: a tide all the land below its line, a flood most of it. */
  private floodReach(grow: number[]): void {
    const world = this.world;
    const { w, h, n } = world;
    const flood = world.flood;
    if (this.floodAge >= 6) return;
    for (let i = 0; i < n; i++) {
      if (!flood[i]) continue;
      const x = i % w;
      const y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (flood[j] || world.water[j]) continue;
        if (this.floodTide ? world.height[j] < this.floodLevel : world.height[j] <= this.floodLevel && Math.random() < 0.6) grow.push(j);
      }
    }
  }

  // ---- tornado and monster -------------------------------------------

  private spawnRoamer(kind: 'tornado' | 'monster'): void {
    const world = this.world;
    const { w, h } = world;
    let x = Math.random() * w;
    let y = Math.random() * h;
    if (kind === 'monster') {
      // It comes out of the water, as monsters do.
      const water: number[] = [];
      for (let i = 0; i < world.n; i++) if (world.water[i] && world.height[i] < -2) water.push(i);
      if (water.length) {
        let best = water[Math.floor(Math.random() * water.length)];
        let bestD = Infinity;
        const target = this.pollutionPeak();
        for (let t = 0; t < 80; t++) {
          const c = water[Math.floor(Math.random() * water.length)];
          const d = Math.hypot((c % w) - target.x, ((c / w) | 0) - target.y);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        x = (best % w) + 0.5;
        y = ((best / w) | 0) + 0.5;
      }
    } else {
      // Tornadoes start somewhere near the city.
      let cx = w / 2, cy = h / 2, c = 0;
      for (const b of world.buildings.values()) {
        cx += b.x; cy += b.y; c++;
      }
      if (c) { cx /= c + 1; cy /= c + 1; }
      x = cx + (Math.random() - 0.5) * 30;
      y = cy + (Math.random() - 0.5) * 30;
    }
    // On the map from the start, so the news names a tile there, and Go there and a save keep it.
    x = Math.max(0.5, Math.min(w - 0.5, x));
    y = Math.max(0.5, Math.min(h - 0.5, y));
    const heading = Math.random() * Math.PI * 2;
    this.roamers.push({
      kind, x, y, px: x, py: y, vx: 0, vy: 0,
      weeks: kind === 'tornado' ? 14 + Math.floor(Math.random() * 10) : 30,
      heading,
    });
    const msg = kind === 'tornado' ? 'Tornado sighted!' : 'A monster is coming ashore!';
    // The tile it stands on: rounding would name the next one, past the edge from the last column.
    this.say(kind, msg, 'alert', { x: Math.floor(x), y: Math.floor(y) }, 0);
    this.sim.emit({ type: 'disaster', kind, x: Math.floor(x), y: Math.floor(y) });
  }

  private pollutionPeak(): { x: number; y: number } {
    const world = this.world;
    let best = 0;
    let bi = Math.floor(world.n / 2);
    for (let i = 0; i < world.n; i += 3) {
      if (world.pollution[i] > best) {
        best = world.pollution[i];
        bi = i;
      }
    }
    return { x: bi % world.w, y: (bi / world.w) | 0 };
  }

  private moveRoamers(): void {
    const world = this.world;
    for (const r of this.roamers) {
      r.px = r.x;
      r.py = r.y;
      if (r.kind === 'tornado') {
        r.heading += (Math.random() - 0.5) * 1.1;
        r.x += Math.cos(r.heading) * 1.4;
        r.y += Math.sin(r.heading) * 1.4;
      } else {
        const t = this.pollutionPeak();
        const want = Math.atan2(t.y - r.y, t.x - r.x);
        let dh = want - r.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        r.heading += dh * 0.35 + (Math.random() - 0.5) * 0.8;
        r.x += Math.cos(r.heading) * 1.1;
        r.y += Math.sin(r.heading) * 1.1;
      }
      r.x = Math.max(0.5, Math.min(world.w - 0.5, r.x));
      r.y = Math.max(0.5, Math.min(world.h - 0.5, r.y));
      r.weeks--;
      this.smash(r);
      if (r.weeks <= 0) {
        const n = r.wrecked ?? 0;
        const gone = r.kind === 'tornado' ? 'The tornado has blown itself out.' : 'The monster has gone back to the water.';
        this.say('gone', `${gone}${n ? ` It wrecked ${buildings(n)}.` : ''}`, 'info', undefined, 0);
      }
    }
    this.roamers = this.roamers.filter((r) => r.weeks > 0);
  }

  private smash(r: Roamer): void {
    const world = this.world;
    const rad = r.kind === 'tornado' ? 1 : 1.5;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.floor(r.x + dx);
        const y = Math.floor(r.y + dy);
        if (!world.inBounds(x, y) || Math.hypot(x + 0.5 - r.x, y + 0.5 - r.y) > rad + 0.5) continue;
        const i = y * world.w + x;
        const b = world.buildingAt(x, y);
        if (b && Math.random() < (r.kind === 'tornado' ? 0.55 : 0.7)) {
          this.destroy(b, r.kind, r);
          // The monster leaves the wreck burning, and it can spread from there. Setting the building alight first
          // would come to nothing, since destroy() puts out its whole footprint.
          if (r.kind === 'monster' && Math.random() < 0.3) this.burnRubble(x, y);
        }
        if (world.net[i] & (ROAD | RAIL) && !world.water[i] && Math.random() < 0.3) {
          world.clearNet(x, y);
          world.rubble[i] = 1;
        }
        if (world.trees[i] && r.kind === 'tornado') {
          world.trees[i] = 0;
          // With the trees gone, a fire in them has nothing left to burn.
          if (!world.occ[i] && !world.rubble[i]) world.fire[i] = 0;
          world.dirty(x, y, x, y);
        }
      }
    }
  }

  // ---- earthquake ------------------------------------------------------

  private earthquake(sparePlants = false): void {
    const world = this.world;
    let cx = Math.random() * world.w;
    let cy = Math.random() * world.h;
    const blds = [...world.buildings.values()];
    const under = sparePlants ? blds.filter((b) => isZone(b.kind)) : blds;
    if (under.length) {
      const b = under[Math.floor(Math.random() * under.length)];
      cx = b.x + 1;
      cy = b.y + 1;
    }
    const R = 16;
    for (const b of blds) {
      if (sparePlants && BUILDINGS[b.kind].capacity) continue;
      const d = Math.hypot(b.x + b.size / 2 - cx, b.y + b.size / 2 - cy);
      if (d > R) continue;
      const p = (1 - d / R) * 0.5;
      const roll = Math.random();
      if (roll < p * 0.6) this.destroy(b, 'earthquake');
      else if (roll < p * 0.8) this.ignite(b.x, b.y);
    }
    for (let y = Math.floor(cy - R); y <= cy + R; y++) {
      for (let x = Math.floor(cx - R); x <= cx + R; x++) {
        if (!world.inBounds(x, y)) continue;
        const d = Math.hypot(x - cx, y - cy);
        const i = y * world.w + x;
        if (d < R && world.net[i] & (ROAD | RAIL) && !world.water[i] && Math.random() < (1 - d / R) * 0.25) {
          world.clearNet(x, y);
          world.rubble[i] = 1;
        }
      }
    }
    this.shake = 2.5;
    this.lastQuake = { x: Math.floor(cx), y: Math.floor(cy) };
    this.say('quake', 'Earthquake! Check for fires and broken roads.', 'alert', { x: Math.floor(cx), y: Math.floor(cy) }, 0);
    this.sim.emit({ type: 'disaster', kind: 'earthquake', x: Math.floor(cx), y: Math.floor(cy) });
  }
}

/** What is burning, as a fire alert names it: 'the cottages', 'the office towers', 'a coal plant'. */
export function firePlace(b: Building): string {
  if (isZone(b.kind)) {
    const title = zoneTitle(b.kind as 'res' | 'com' | 'ind', b.level).toLowerCase();
    if (b.level === 0) return 'a ' + title;
    return title === 'main street' ? 'the shops on main street' : title === 'heavy industry' ? 'the heavy industrial plant' : 'the ' + title;
  }
  const name = buildingName(b).toLowerCase();
  return `${article(name)} ${name}`;
}

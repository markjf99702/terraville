// Fires, floods, tornadoes, earthquakes, the monster, and meltdowns.
import { BUILDINGS, DIFFICULTIES, RAIL, ROAD } from './defs';
import type { Sim } from './sim';
import type { Building } from './world';

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
}

export class Disasters {
  roamers: Roamer[] = [];
  /** Seconds of screen shake left; the renderer counts it down. */
  shake = 0;
  private floodLevel = 0;
  private floodAge = 0;

  constructor(private sim: Sim) {}

  private get world() {
    return this.sim.world;
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
    if (pop < 400) return;
    const r = Math.random();
    // Rough monthly odds; fire is by far the most common.
    if (r < 0.06 * f) this.trigger('fire');
    else if (r < 0.06 * f + 0.006 * f) this.trigger('flood');
    else if (r < 0.066 * f + 0.004 * f) this.trigger('tornado');
    else if (r < 0.07 * f + 0.0025 * f) this.trigger('earthquake');
    else if (r < 0.0725 * f + 0.002 * f && this.sim.stats.avgPollution > 60) this.trigger('monster');
    for (const b of this.world.buildings.values()) {
      if (b.kind === 'nuclear' && Math.random() < 0.0008 * f) this.meltdown(b);
    }
  }

  trigger(kind: DisasterKind): void {
    switch (kind) {
      case 'fire': return this.randomFire();
      case 'flood': return this.startFlood();
      case 'tornado': return this.spawnRoamer('tornado');
      case 'earthquake': return this.earthquake();
      case 'monster': return this.spawnRoamer('monster');
      case 'meltdown': {
        const plants = [...this.world.buildings.values()].filter((b) => b.kind === 'nuclear');
        if (!plants.length) {
          this.sim.say('nomelt', 'There is no nuclear plant to melt down.', 'info', undefined, 0);
          return;
        }
        this.meltdown(plants[Math.floor(Math.random() * plants.length)]);
      }
    }
  }

  // ---- fire ------------------------------------------------------------

  private randomFire(): void {
    const world = this.world;
    const cands: Building[] = [];
    for (const b of world.buildings.values()) {
      if (b.kind === 'park') continue;
      if (b.kind === 'res' || b.kind === 'com' || b.kind === 'ind' ? b.level > 0 : true) cands.push(b);
    }
    if (!cands.length) return;
    // Buildings far from fire stations are more likely to go up.
    for (let t = 0; t < 6; t++) {
      const b = cands[Math.floor(Math.random() * cands.length)];
      const cov = world.fireCov[(b.y + 1) * world.w + b.x + 1] / 255;
      if (Math.random() > cov * 0.85) {
        this.ignite(b.x, b.y);
        return;
      }
    }
  }

  /** Set a tile (and the whole building on it) alight. */
  ignite(x: number, y: number): void {
    const world = this.world;
    if (!world.inBounds(x, y)) return;
    const i = y * world.w + x;
    if (world.water[i] || world.fire[i]) return;
    const b = world.buildingAt(x, y);
    const weeks = 5 + Math.floor(Math.random() * 5);
    if (b) {
      for (let dy = 0; dy < b.size; dy++) {
        for (let dx = 0; dx < b.size; dx++) world.fire[(b.y + dy) * world.w + b.x + dx] = weeks;
      }
      world.dirty(b.x, b.y, b.x + b.size - 1, b.y + b.size - 1);
      this.sim.say('fire', `Fire reported at a ${BUILDINGS[b.kind].name.toLowerCase()}.`, 'alert', { x: b.x + 1, y: b.y + 1 }, 1);
      this.sim.emit({ type: 'disaster', kind: 'fire', x, y });
      this.sim.powerDirty = true;
    } else if (world.trees[i]) {
      world.fire[i] = weeks;
      world.dirty(x, y, x, y);
    }
  }

  private spreadFire(): void {
    const world = this.world;
    const { w, h, n } = world;
    const fire = world.fire;
    const burning: number[] = [];
    for (let i = 0; i < n; i++) if (fire[i]) burning.push(i);
    if (!burning.length) return;
    const fund = world.city.funding.fire;
    const handled = new Set<number>();
    for (const i of burning) {
      const x = i % w;
      const y = (i / w) | 0;
      const cov = (world.fireCov[i] / 255) * fund;
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
        if (Math.random() < p) this.ignite(nx, ny);
      }
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
  }

  /** Wreck a building. Nuclear plants take the neighbourhood with them. */
  destroy(b: Building, cause: string): void {
    const world = this.world;
    if (!world.buildings.has(b.id)) return;
    for (let dy = 0; dy < b.size; dy++) {
      for (let dx = 0; dx < b.size; dx++) world.fire[(b.y + dy) * world.w + b.x + dx] = 0;
    }
    world.remove(b.id, true);
    this.sim.powerDirty = true;
    this.sim.emit({ type: 'destroyed', x: b.x + b.size / 2, y: b.y + b.size / 2 });
    if (b.kind === 'nuclear' && cause !== 'meltdown') this.meltdown(b);
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
    this.sim.say('meltdown', 'Nuclear meltdown! The area around the plant is contaminated for years.', 'alert', { x: cx, y: cy }, 0);
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
      this.sim.say('noflood', 'No low shoreline for a flood.', 'info', undefined, 0);
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
    world.flood[pickI] = 16;
    this.floodTile(pickI);
    const x = pickI % w;
    const y = (pickI / w) | 0;
    this.sim.say('flood', 'Flooding along the shore!', 'alert', { x, y }, 0);
    this.sim.emit({ type: 'disaster', kind: 'flood', x, y });
  }

  private floodTile(i: number): void {
    const world = this.world;
    const id = world.occ[i];
    if (id) {
      const b = world.buildings.get(id);
      if (b) this.destroy(b, 'flood');
    }
    world.trees[i] = 0;
    const x = i % world.w;
    const y = (i / world.w) | 0;
    world.dirty(x, y, x, y);
  }

  private spreadFlood(): void {
    const world = this.world;
    const { w, h, n } = world;
    const flood = world.flood;
    let any = false;
    const grow: number[] = [];
    this.floodAge++;
    for (let i = 0; i < n; i++) {
      if (!flood[i]) continue;
      any = true;
      if (this.floodAge < 6) {
        const x = i % w;
        const y = (i / w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (flood[j] || world.water[j] || world.height[j] > this.floodLevel) continue;
          if (Math.random() < 0.6) grow.push(j);
        }
      }
    }
    for (const j of grow) {
      if (flood[j]) continue;
      flood[j] = 10 + Math.floor(Math.random() * 6);
      this.floodTile(j);
    }
    if (!any) return;
    for (let i = 0; i < n; i++) {
      if (!flood[i]) continue;
      flood[i]--;
      if (!flood[i]) {
        const x = i % w;
        const y = (i / w) | 0;
        world.dirty(x, y, x, y);
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
    const heading = Math.random() * Math.PI * 2;
    this.roamers.push({
      kind, x, y, px: x, py: y, vx: 0, vy: 0,
      weeks: kind === 'tornado' ? 14 + Math.floor(Math.random() * 10) : 30,
      heading,
    });
    const msg = kind === 'tornado' ? 'Tornado sighted!' : 'A monster is coming ashore!';
    this.sim.say(kind, msg, 'alert', { x: Math.round(x), y: Math.round(y) }, 0);
    this.sim.emit({ type: 'disaster', kind, x, y });
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
          this.destroy(b, r.kind);
          if (r.kind === 'monster' && Math.random() < 0.3) this.ignite(x, y);
        }
        if (world.net[i] & (ROAD | RAIL) && !world.water[i] && Math.random() < 0.3) {
          world.clearNet(x, y);
          world.rubble[i] = 1;
        }
        if (world.trees[i] && r.kind === 'tornado') {
          world.trees[i] = 0;
          world.dirty(x, y, x, y);
        }
      }
    }
  }

  // ---- earthquake ------------------------------------------------------

  private earthquake(): void {
    const world = this.world;
    let cx = Math.random() * world.w;
    let cy = Math.random() * world.h;
    const blds = [...world.buildings.values()];
    if (blds.length) {
      const b = blds[Math.floor(Math.random() * blds.length)];
      cx = b.x + 1;
      cy = b.y + 1;
    }
    const R = 16;
    for (const b of blds) {
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
    this.sim.say('quake', 'Earthquake! Check for fires and broken roads.', 'alert', { x: Math.round(cx), y: Math.round(cy) }, 0);
    this.sim.emit({ type: 'disaster', kind: 'earthquake', x: cx, y: cy });
  }
}

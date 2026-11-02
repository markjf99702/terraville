// Things that move but do not affect the simulation: trains on the track,
// planes leaving the airport, boats around the seaport, and dust clouds.
import { RAIL } from '../defs';
import type { World } from '../world';
import { CAR_COLORS, plane } from './sprites';

interface Train {
  /** Tile indices, head first. Each car occupies one step of this trail. */
  trail: number[];
  progress: number;
  speed: number;
  cars: number;
  color: string;
}

interface Plane {
  x: number;
  y: number;
  heading: number;
  speed: number;
  alt: number;
  age: number;
}

interface Boat {
  from: number;
  to: number;
  progress: number;
  home: number;
}

interface Dust {
  x: number;
  y: number;
  age: number;
  /** 1 for a building coming down; smaller and shorter for one going up. */
  size: number;
  life: number;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Vehicles {
  trains: Train[] = [];
  planes: Plane[] = [];
  boats: Boat[] = [];
  dust: Dust[] = [];
  private planeTimer = 8;
  private scanTimer = 0;
  private railTiles: number[] = [];
  /** The riders on each tile of track (see Sim.riders), when the world has a city; and their sum over the track. */
  riders: Uint8Array | null = null;
  private rideSum = 0;
  private airports: { x: number; y: number }[] = [];
  private ports: number[] = [];

  constructor(private world: World) {}

  setWorld(world: World): void {
    this.world = world;
    this.trains = [];
    this.planes = [];
    this.boats = [];
    this.dust = [];
    this.scanTimer = 0;
  }

  addDust(x: number, y: number, size = 1): void {
    this.dust.push({ x, y, age: 0, size, life: size >= 1 ? 2.5 : 1.4 });
  }

  private scan(): void {
    const world = this.world;
    this.railTiles = [];
    this.rideSum = 0;
    for (let i = 0; i < world.n; i++) {
      if (!(world.net[i] & RAIL)) continue;
      this.railTiles.push(i);
      this.rideSum += this.riders?.[i] ?? 0;
    }
    this.airports = [];
    this.ports = [];
    for (const b of world.buildings.values()) {
      if (b.kind === 'airport') this.airports.push({ x: b.x, y: b.y });
      if (b.kind === 'seaport') {
        // Find a water tile next to the port.
        for (let d = -1; d <= 4 && this.ports.length < 8; d++) {
          for (const [x, y] of [[b.x + d, b.y - 1], [b.x + d, b.y + 4], [b.x - 1, b.y + d], [b.x + 4, b.y + d]]) {
            if (world.inBounds(x, y) && world.water[y * world.w + x]) {
              this.ports.push(y * world.w + x);
              break;
            }
          }
        }
      }
    }
  }

  update(dt: number, running: boolean): void {
    const world = this.world;
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scan();
      this.scanTimer = 2;
    }
    for (const d of this.dust) d.age += dt;
    this.dust = this.dust.filter((d) => d.age < d.life);
    if (!running) return;

    // Trains: more of them, and longer, where more people ride. Track nobody rides gets one short train at most, so a
    // line in use is busy and an unused one looks it.
    const riders = this.riders;
    const want = this.rideSum > 0 ? Math.min(12, 1 + Math.round(this.rideSum / 4000)) : this.railTiles.length >= 28 ? 1 : 0;
    this.trains = this.trains.filter((t) => t.trail.length && world.net[t.trail[0]] & RAIL);
    while (this.trains.length < want && this.railTiles.length) {
      // Each starts somewhere people ride, by how many do.
      let start = this.railTiles[Math.floor(Math.random() * this.railTiles.length)];
      if (riders && this.rideSum > 0) {
        let r = Math.random() * this.rideSum;
        for (const i of this.railTiles) {
          r -= riders[i];
          if (r < 0) {
            start = i;
            break;
          }
        }
      }
      const full = (riders?.[start] ?? 0) / 255;
      this.trains.push({
        trail: [start],
        progress: 0,
        speed: 2.2 + Math.random() * 1.2,
        cars: 2 + Math.round(full * 4),
        color: Math.random() < 0.5 ? '#C0392B' : Math.random() < 0.5 ? '#2C3E50' : '#1F6F8B',
      });
    }
    if (this.trains.length > want) this.trains.length = want;
    for (const t of this.trains) {
      t.progress += t.speed * dt;
      while (t.progress >= 1) {
        t.progress -= 1;
        const next = this.nextRail(t);
        if (next < 0) {
          t.trail.reverse();
          t.progress = 0;
          break;
        }
        t.trail.unshift(next);
        if (t.trail.length > t.cars + 2) t.trail.pop();
      }
    }

    // Planes: a departure every so often.
    if (this.airports.length) {
      this.planeTimer -= dt;
      if (this.planeTimer <= 0) {
        const a = this.airports[Math.floor(Math.random() * this.airports.length)];
        this.planes.push({ x: a.x + 0.4, y: a.y + 1.12, heading: 0, speed: 0.6, alt: 0, age: 0 });
        this.planeTimer = 14 + Math.random() * 20;
      }
    }
    for (const p of this.planes) {
      p.age += dt;
      p.speed = Math.min(7, p.speed + dt * 1.6);
      if (p.age > 2.4) p.alt = Math.min(1, p.alt + dt * 0.25);
      if (p.alt > 0.4) p.heading += dt * 0.08;
      p.x += Math.cos(p.heading) * p.speed * dt;
      p.y += Math.sin(p.heading) * p.speed * dt;
    }
    this.planes = this.planes.filter((p) => p.x > -10 && p.y > -10 && p.x < world.w + 10 && p.y < world.h + 10);

    // Boats wander the water near the port.
    const wantBoats = Math.min(3, this.ports.length);
    this.boats = this.boats.filter((b) => world.water[b.to] && world.water[b.from]);
    while (this.boats.length < wantBoats) {
      const home = this.ports[this.boats.length % this.ports.length];
      this.boats.push({ from: home, to: home, progress: 1, home });
    }
    for (const b of this.boats) {
      b.progress += dt * 0.9;
      if (b.progress >= 1) {
        b.progress = 0;
        b.from = b.to;
        const x = b.from % world.w;
        const y = (b.from / world.w) | 0;
        const hx = b.home % world.w;
        const hy = (b.home / world.w) | 0;
        const opts: number[] = [];
        for (const [dx, dy] of DIRS) {
          const nx = x + dx;
          const ny = y + dy;
          if (!world.inBounds(nx, ny)) continue;
          const j = ny * world.w + nx;
          if (!world.water[j] || world.net[j]) continue;
          if (Math.hypot(nx - hx, ny - hy) > 14) continue;
          opts.push(j);
        }
        b.to = opts.length ? opts[Math.floor(Math.random() * opts.length)] : b.from;
      }
    }
  }

  private nextRail(t: Train): number {
    const world = this.world;
    const head = t.trail[0];
    const prev = t.trail[1] ?? -1;
    const x = head % world.w;
    const y = (head / world.w) | 0;
    const opts: number[] = [];
    const weights: number[] = [];
    let total = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!world.inBounds(nx, ny)) continue;
      const j = ny * world.w + nx;
      if (j === prev || !(world.net[j] & RAIL)) continue;
      // At a junction a train mostly runs on straight, and mostly takes the branch more people ride: a spur nobody
      // uses sees a train now and then.
      const wt = ((this.riders?.[j] ?? 0) + 8) * (prev >= 0 && j - head === head - prev ? 3 : 1);
      opts.push(j);
      weights.push(wt);
      total += wt;
    }
    if (!opts.length) return -1;
    let r = Math.random() * total;
    for (let k = 0; k < opts.length; k++) {
      r -= weights[k];
      if (r < 0) return opts[k];
    }
    return opts[opts.length - 1];
  }

  /** Draw in tile coordinates (the context is already scaled). */
  draw(ctx: CanvasRenderingContext2D, zoom: number): void {
    const world = this.world;
    const w = world.w;
    const center = (i: number): [number, number] => [(i % w) + 0.5, ((i / w) | 0) + 0.5];
    for (const t of this.trains) {
      for (let k = 0; k < Math.min(t.cars, t.trail.length - 1); k++) {
        const [ax, ay] = center(t.trail[k]);
        const [bx, by] = center(t.trail[k + 1]);
        // Car k sits `progress` of the way from trail[k+1] toward trail[k].
        const x = bx + (ax - bx) * t.progress;
        const y = by + (ay - by) * t.progress;
        const horiz = Math.abs(ax - bx) > Math.abs(ay - by);
        const len = 0.78;
        const wid = 0.24;
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        if (horiz) ctx.fillRect(x - len / 2 + 0.05, y - wid / 2 + 0.07, len, wid);
        else ctx.fillRect(x - wid / 2 + 0.05, y - len / 2 + 0.07, wid, len);
        ctx.fillStyle = k === 0 ? t.color : '#B8BEC4';
        if (horiz) ctx.fillRect(x - len / 2, y - wid / 2, len, wid);
        else ctx.fillRect(x - wid / 2, y - len / 2, wid, len);
        if (zoom > 16) {
          ctx.fillStyle = k === 0 ? '#F4D03F' : '#7F8C8D';
          if (horiz) ctx.fillRect(x - len / 2 + 0.06, y - wid / 2 + 0.05, len - 0.12, wid - 0.1);
          else ctx.fillRect(x - wid / 2 + 0.05, y - len / 2 + 0.06, wid - 0.1, len - 0.12);
        }
      }
    }
    for (const b of this.boats) {
      const [ax, ay] = center(b.from);
      const [bx, by] = center(b.to);
      const x = ax + (bx - ax) * b.progress;
      const y = ay + (by - ay) * b.progress;
      const ang = Math.atan2(by - ay, bx - ax);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(-0.3, 0);
      ctx.lineTo(-0.9, -0.2);
      ctx.lineTo(-0.9, 0.2);
      ctx.fill();
      ctx.fillStyle = '#2C3E50';
      ctx.beginPath();
      ctx.moveTo(0.42, 0);
      ctx.lineTo(0.22, -0.16);
      ctx.lineTo(-0.38, -0.16);
      ctx.lineTo(-0.38, 0.16);
      ctx.lineTo(0.22, 0.16);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = CAR_COLORS[(b.home % 5) + 1];
      ctx.fillRect(-0.3, -0.1, 0.36, 0.2);
      ctx.fillStyle = '#ECF0F1';
      ctx.fillRect(-0.36, -0.08, 0.1, 0.16);
      ctx.restore();
    }
    for (const p of this.planes) {
      const s = 1.1 + p.alt * 0.6;
      ctx.globalAlpha = 0.28;
      plane(ctx, p.x + p.alt * 1.6, p.y + p.alt * 1.1, s, p.heading, '#000');
      ctx.globalAlpha = 1;
      plane(ctx, p.x, p.y, s, p.heading, '#F5F6F7');
    }
    for (const d of this.dust) {
      const t = d.age / d.life;
      const s = d.size;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + d.x;
        const r = (0.3 + t * 1.4) * s;
        ctx.fillStyle = `rgba(150,138,120,${(1 - t) * 0.45})`;
        ctx.beginPath();
        ctx.arc(d.x + Math.cos(a) * r * 0.6, d.y + Math.sin(a) * r * 0.5 - t * 0.5 * s, (0.35 + t * 0.9) * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

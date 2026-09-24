// The map view. Static content (terrain, roads, buildings) is painted into
// 16x16-tile chunk canvases at one of four detail levels and cached; moving
// things (traffic, smoke, fire, disasters, tool previews) are drawn fresh
// every frame on top.
import { ROAD, isZone } from '../defs';
import type { Sim } from '../sim';
import type { World } from '../world';
import { hash3 } from '../rng';
import { TerrainField, paintTerrain } from './terrainPaint';
import { CAR_COLORS, DC, Emitter, buildingEmitters, drawBuilding, drawNet, drawRadiation, drawRubble, drawTrees } from './sprites';
import { Vehicles } from './vehicles';

const CS = 16;
const LODS = [8, 16, 32, 64];
// Safari and every iOS browser cap total canvas memory for a page, and once
// the cap is hit getContext() starts returning null. Stay well inside it there.
const WEBKIT = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent));
const PIXEL_BUDGET = WEBKIT ? 12_000_000 : 32_000_000;
const MAX_LOD = WEBKIT ? 32 : 64;

interface Chunk {
  canvas: HTMLCanvasElement;
  L: number;
  dirty: boolean;
  used: number;
  contours: boolean;
}

export type Overlay = 'none' | 'traffic' | 'pollution' | 'crime' | 'landValue' | 'density' | 'power' | 'police' | 'fire' | 'service' | 'slope';

export const OVERLAYS: { id: Overlay; name: string; color: string; low: string; high: string }[] = [
  { id: 'none', name: 'Map', color: '', low: '', high: '' },
  { id: 'landValue', name: 'Land value', color: '#2a78d6', low: 'Cheap', high: 'Prime' },
  { id: 'density', name: 'Population', color: '#4a3aa7', low: 'Sparse', high: 'Dense' },
  { id: 'traffic', name: 'Traffic', color: '#e34948', low: 'Light', high: 'Jammed' },
  { id: 'pollution', name: 'Pollution', color: '#8a5a1c', low: 'Clean', high: 'Filthy' },
  { id: 'crime', name: 'Crime', color: '#b2245c', low: 'Safe', high: 'Dangerous' },
  { id: 'power', name: 'Power grid', color: '#eda100', low: 'Powered', high: 'No power' },
  { id: 'police', name: 'Police reach', color: '#2a78d6', low: 'None', high: 'Full' },
  { id: 'fire', name: 'Fire cover', color: '#eb6834', low: 'None', high: 'Full' },
  { id: 'service', name: 'Schools & health', color: '#1baf7a', low: 'None', high: 'Full' },
  { id: 'slope', name: 'Steepness', color: '#eb6834', low: 'Flat', high: 'Cliff' },
];

/** Steepness classes for the slope layer, by the largest height step to a neighbour. */
export const SLOPE_CLASSES = [
  { max: 4.5, label: 'Flat', note: 'anything fits', alpha: 0 },
  { max: 9, label: 'Gentle', note: 'building here costs a little extra to level', alpha: 90 },
  { max: 14, label: 'Steep', note: 'roads and rail grade themselves, big lots may need Level land', alpha: 160 },
  { max: Infinity, label: 'Very steep', note: 'flatten it with Level land before building', alpha: 225 },
];

export interface Preview {
  tiles: [number, number][];
  bad: [number, number][];
  rects: { x: number; y: number; s: number; ok: boolean }[];
  brush?: { x: number; y: number; r: number };
  tint?: string;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  world!: World;
  sim: Sim | null = null;
  field!: TerrainField;
  vehicles!: Vehicles;
  cam = { x: 60, y: 50, zoom: 16 };
  dpr = 1;
  cssW = 800;
  cssH = 600;
  overlay: Overlay = 'none';
  contours = false;
  grid = false;
  showTraffic = true;
  /** Day and night cycle while the city runs. */
  nightCycle = true;
  /** Real seconds per simulated day-night cycle. */
  dayLength = 150;
  preview: Preview | null = null;
  hover: { x: number; y: number } | null = null;
  /** Whether the simulation clock is running (freezes traffic when paused). */
  running = false;
  /** Seconds, always ticking (water, blinking). */
  time = 0;
  /** Seconds, ticking only while the sim runs (cars, smoke drift). */
  simTime = 0;
  /** 0-1 progress between sim steps, for smooth disaster movement. */
  stepFrac = 0;
  shake = 0;

  private chunks = new Map<number, Chunk>();
  private pixels = 0;
  private cw = 0;
  private ch = 0;
  private waterDirty = false;
  private overlayCanvas: HTMLCanvasElement;
  private overlayDirty = true;
  private overlayAge = 0;
  private emitters = new Map<number, { key: string; list: Emitter[] }>();
  /** Tiles currently burning or flooded, rescanned a few times a second. */
  private hazards: number[] = [];
  private hazardTimer = 0;
  private unsubscribe: (() => void) | null = null;

  private glow: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.overlayCanvas = document.createElement('canvas');
    this.glow = document.createElement('canvas');
    this.glow.width = this.glow.height = 32;
    const g = this.glow.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,236,190,1)');
    grad.addColorStop(0.25, 'rgba(255,210,140,0.55)');
    grad.addColorStop(1, 'rgba(255,190,110,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }

  /** 0 at midday, up to about 0.55 in the middle of the night. */
  darkness(): number {
    if (!this.nightCycle || !this.world?.city.founded) return 0;
    const sun = Math.cos((this.simTime / this.dayLength) * Math.PI * 2);
    const t = Math.max(0, Math.min(1, (-sun - 0.3) / 0.55));
    return t * t * (3 - 2 * t) * 0.55;
  }

  setWorld(world: World, sim: Sim | null): void {
    this.unsubscribe?.();
    this.world = world;
    this.sim = sim;
    this.field = new TerrainField(world);
    if (!this.vehicles) this.vehicles = new Vehicles(world);
    else this.vehicles.setWorld(world);
    this.releaseChunks();
    this.emitters.clear();
    this.cw = Math.ceil(world.w / CS);
    this.ch = Math.ceil(world.h / CS);
    this.overlayCanvas.width = world.w;
    this.overlayCanvas.height = world.h;
    this.overlayDirty = true;
    this.unsubscribe = world.onDirty((x0, y0, x1, y1, terrain) => this.invalidate(x0, y0, x1, y1, terrain));
    // A cheap full-map pass at the lowest detail level to fall back on.
    for (let cy = 0; cy < this.ch; cy++) for (let cx = 0; cx < this.cw; cx++) this.renderChunk(cx, cy, 8);
  }

  invalidate(x0: number, y0: number, x1: number, y1: number, terrain: boolean): void {
    if (terrain) {
      this.field.updateColors(x0, y0, x1, y1);
      this.waterDirty = true;
    }
    const m = terrain ? 2 : 1;
    const cx0 = Math.max(0, Math.floor((x0 - m) / CS));
    const cy0 = Math.max(0, Math.floor((y0 - m) / CS));
    const cx1 = Math.min(this.cw - 1, Math.floor((x1 + m) / CS));
    const cy1 = Math.min(this.ch - 1, Math.floor((y1 + m) / CS));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const L of LODS) {
          const c = this.chunks.get(this.key(cx, cy, L));
          if (c) c.dirty = true;
        }
      }
    }
    this.overlayDirty = true;
  }

  invalidateAll(): void {
    for (const c of this.chunks.values()) c.dirty = true;
    this.overlayDirty = true;
  }

  setOverlay(o: Overlay): void {
    this.overlay = o;
    this.overlayDirty = true;
  }

  refreshOverlay(): void {
    this.overlayDirty = true;
  }

  private key(cx: number, cy: number, L: number): number {
    return (L * 4096 + cy) * 4096 + cx;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = dpr;
    const w = Math.round(this.cssW * dpr);
    const h = Math.round(this.cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // ---- camera ---------------------------------------------------------------

  minZoom(): number {
    return Math.max(2, Math.min(this.cssW / (this.world.w + 8), this.cssH / (this.world.h + 8)) * 0.9);
  }

  clampCamera(slack = 4): void {
    const z = this.cam.zoom;
    const halfW = this.cssW / 2 / z;
    const halfH = this.cssH / 2 / z;
    const w = this.world.w;
    const h = this.world.h;
    this.cam.x = halfW * 2 >= w ? w / 2 : Math.max(halfW - slack, Math.min(w - halfW + slack, this.cam.x));
    this.cam.y = halfH * 2 >= h ? h / 2 : Math.max(halfH - slack, Math.min(h - halfH + slack, this.cam.y));
  }

  screenToTile(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.cssW / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this.cssH / 2) / this.cam.zoom + this.cam.y,
    };
  }

  tileToScreen(tx: number, ty: number): { x: number; y: number } {
    return {
      x: (tx - this.cam.x) * this.cam.zoom + this.cssW / 2,
      y: (ty - this.cam.y) * this.cam.zoom + this.cssH / 2,
    };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToTile(sx, sy);
    this.cam.zoom = Math.max(this.minZoom(), Math.min(96, this.cam.zoom * factor));
    const after = this.screenToTile(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCamera();
  }

  centerOn(x: number, y: number): void {
    this.cam.x = x;
    this.cam.y = y;
    this.clampCamera();
  }

  // ---- chunks ---------------------------------------------------------------

  /** Free every cached chunk now rather than waiting for garbage collection. */
  private releaseChunks(keep?: (c: Chunk) => boolean): void {
    for (const [k, c] of this.chunks) {
      if (keep?.(c)) continue;
      this.chunks.delete(k);
      this.pixels -= c.canvas.width * c.canvas.height;
      c.canvas.width = 0;
      c.canvas.height = 0;
    }
    if (!keep) this.pixels = 0;
  }

  private renderChunk(cx: number, cy: number, L: number): Chunk | null {
    const k = this.key(cx, cy, L);
    let c = this.chunks.get(k);
    const size = CS * L;
    if (!c) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      c = { canvas, L, dirty: true, used: 0, contours: false };
      this.chunks.set(k, c);
      this.pixels += size * size;
    }
    let ctx = c.canvas.getContext('2d');
    if (!ctx) {
      // Out of canvas memory: drop everything not on screen and try once more.
      this.releaseChunks((o) => o === c || (o.L === 8 && o.used >= this.time - 1) || o.used >= this.time - 0.05);
      ctx = c.canvas.getContext('2d');
      if (!ctx) {
        this.chunks.delete(k);
        this.pixels -= size * size;
        c.canvas.width = 0;
        c.canvas.height = 0;
        return null;
      }
    }
    const tx0 = cx * CS;
    const ty0 = cy * CS;
    ctx.putImageData(paintTerrain(ctx, this.field, this.world, tx0, ty0, CS, L, this.contours), 0, 0);
    ctx.save();
    ctx.translate(-tx0 * L, -ty0 * L);
    this.drawObjects(ctx, tx0, ty0, L);
    ctx.restore();
    c.dirty = false;
    c.contours = this.contours;
    return c;
  }

  private drawObjects(ctx: CanvasRenderingContext2D, tx0: number, ty0: number, L: number): void {
    const world = this.world;
    const dc: DC = { ctx, L, world };
    const tx1 = Math.min(world.w, tx0 + CS);
    const ty1 = Math.min(world.h, ty0 + CS);
    const ids = new Set<number>();
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        const i = y * world.w + x;
        if (world.occ[i]) {
          ids.add(world.occ[i]);
          continue;
        }
        if (world.rubble[i]) drawRubble(dc, x, y);
        if (world.rad[i]) drawRadiation(dc, x, y);
        if (world.trees[i]) drawTrees(dc, x, y);
      }
    }
    // Networks after trees so wires pass over canopies at tile edges.
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        if (world.net[y * world.w + x]) drawNet(dc, x, y);
      }
    }
    const list = [...ids].map((id) => world.buildings.get(id)!).filter(Boolean);
    list.sort((a, b) => a.y + a.size - (b.y + b.size) || a.x - b.x);
    for (const b of list) drawBuilding(dc, b);
    if (this.grid && L >= 16) {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = tx0; x <= tx1; x++) {
        ctx.moveTo(x * L + 0.5, ty0 * L);
        ctx.lineTo(x * L + 0.5, ty1 * L);
      }
      for (let y = ty0; y <= ty1; y++) {
        ctx.moveTo(tx0 * L, y * L + 0.5);
        ctx.lineTo(tx1 * L, y * L + 0.5);
      }
      ctx.stroke();
    }
  }

  private evict(): void {
    if (this.pixels <= PIXEL_BUDGET) return;
    const list = [...this.chunks.entries()].filter(([, c]) => c.L > 8).sort((a, b) => a[1].used - b[1].used);
    for (const [k, c] of list) {
      if (this.pixels <= PIXEL_BUDGET * 0.8) break;
      this.chunks.delete(k);
      this.pixels -= c.canvas.width * c.canvas.height;
      c.canvas.width = 0;
      c.canvas.height = 0;
    }
  }

  // ---- frame ----------------------------------------------------------------

  frame(dt: number): void {
    this.time += dt;
    if (this.running) this.simTime += dt;
    if (this.waterDirty) {
      this.field.updateWater();
      this.waterDirty = false;
    }
    this.vehicles.update(dt, this.running);
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const zd = this.cam.zoom * this.dpr;
    let sx = 0;
    let sy = 0;
    const quake = this.sim?.disasters.shake ?? 0;
    if (quake > 0 && this.sim) {
      this.sim.disasters.shake = Math.max(0, quake - dt);
      const a = Math.min(1, quake) * 6 * this.dpr;
      sx = (Math.random() - 0.5) * a;
      sy = (Math.random() - 0.5) * a;
    }
    const ox = W / 2 - this.cam.x * zd + sx;
    const oy = H / 2 - this.cam.y * zd + sy;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0E1412';
    ctx.fillRect(0, 0, W, H);

    // Chunks.
    const wantL = Math.min(MAX_LOD, LODS.find((l) => l >= zd * 0.92) ?? 64);
    const cx0 = Math.max(0, Math.floor(-ox / (CS * zd)));
    const cy0 = Math.max(0, Math.floor(-oy / (CS * zd)));
    const cx1 = Math.min(this.cw - 1, Math.floor((W - ox) / (CS * zd)));
    const cy1 = Math.min(this.ch - 1, Math.floor((H - oy) / (CS * zd)));
    const start = performance.now();
    const budget = 10;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = zd > wantL ? 'low' : 'high';
    const todo: [number, number][] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) todo.push([cx, cy]);
    // Centre chunks first so the part you are looking at sharpens first.
    const ccx = (W / 2 - ox) / (CS * zd);
    const ccy = (H / 2 - oy) / (CS * zd);
    todo.sort((a, b) => Math.hypot(a[0] + 0.5 - ccx, a[1] + 0.5 - ccy) - Math.hypot(b[0] + 0.5 - ccx, b[1] + 0.5 - ccy));
    for (const [cx, cy] of todo) {
      let c = this.chunks.get(this.key(cx, cy, wantL));
      const stale = !c || c.dirty || c.contours !== this.contours;
      if (stale && (performance.now() - start < budget || !c && wantL === 8)) {
        c = this.renderChunk(cx, cy, wantL) ?? undefined;
      }
      if (!c) {
        for (const L of [...LODS].reverse()) {
          const alt = this.chunks.get(this.key(cx, cy, L));
          if (alt) {
            c = alt;
            break;
          }
        }
      }
      if (!c) continue;
      c.used = this.time;
      const x0 = Math.round(ox + cx * CS * zd);
      const y0 = Math.round(oy + cy * CS * zd);
      const x1 = Math.round(ox + (cx + 1) * CS * zd);
      const y1 = Math.round(oy + (cy + 1) * CS * zd);
      ctx.drawImage(c.canvas, x0, y0, x1 - x0, y1 - y0);
    }
    this.evict();

    // Everything else is drawn in tile units.
    ctx.setTransform(zd, 0, 0, zd, ox, oy);
    const vx0 = Math.max(0, Math.floor(-ox / zd) - 1);
    const vy0 = Math.max(0, Math.floor(-oy / zd) - 1);
    const vx1 = Math.min(this.world.w - 1, Math.ceil((W - ox) / zd) + 1);
    const vy1 = Math.min(this.world.h - 1, Math.ceil((H - oy) / zd) + 1);

    if (this.overlay !== 'none') this.drawOverlay(ctx);
    else {
      if (this.showTraffic && this.cam.zoom >= 10) this.drawCars(ctx, vx0, vy0, vx1, vy1);
      this.vehicles.draw(ctx, this.cam.zoom);
      const dark = this.darkness();
      if (dark > 0.01) this.drawNight(ctx, dark, vx0, vy0, vx1, vy1);
    }
    this.hazardTimer -= dt;
    if (this.hazardTimer <= 0) {
      this.hazardTimer = 0.2;
      this.hazards.length = 0;
      const { fire, flood, n } = this.world;
      for (let i = 0; i < n; i++) if (fire[i] || flood[i]) this.hazards.push(i);
    }
    if (this.hazards.length) this.drawHazards(ctx, vx0, vy0, vx1, vy1);
    if (this.cam.zoom >= 7) this.drawEmitters(ctx, vx0, vy0, vx1, vy1);
    if (this.sim && this.world.city.founded) this.drawPowerWarnings(ctx, vx0, vy0, vx1, vy1);
    this.drawRoamers(ctx);
    this.drawPreview(ctx);

    // Map edge.
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2 / zd;
    ctx.strokeRect(0, 0, this.world.w, this.world.h);
  }

  // ---- dynamic layers -------------------------------------------------------

  private drawCars(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    const world = this.world;
    const t = this.simTime;
    const len = 0.24;
    const wid = 0.13;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * world.w + x;
        if (!(world.net[i] & ROAD)) continue;
        const tr = world.traffic[i];
        if (tr < 4) continue;
        const dens = Math.min(0.85, tr / 200);
        const speed = 1.5 * (1 - Math.min(0.8, tr / 300));
        const n = y > 0 && world.net[i - world.w] & ROAD;
        const s = y < world.h - 1 && world.net[i + world.w] & ROAD;
        const w = x > 0 && world.net[i - 1] & ROAD;
        const e = x < world.w - 1 && world.net[i + 1] & ROAD;
        if (e || w) {
          for (const dir of [1, -1]) {
            const ly = y + (dir > 0 ? 0.64 : 0.36);
            const shift = dir * t * speed * 2.2;
            const q0 = Math.floor(x * 2.2 - shift) - 1;
            for (let q = q0; q <= q0 + 4; q++) {
              if (hash3(q, y, dir + 7) > dens) continue;
              const cx = (q + shift) / 2.2;
              if (cx < x || cx > x + 1) continue;
              if (cx < x + 0.5 ? !w : !e) continue;
              ctx.fillStyle = 'rgba(0,0,0,0.25)';
              ctx.fillRect(cx - len / 2 + 0.03, ly - wid / 2 + 0.04, len, wid);
              ctx.fillStyle = CAR_COLORS[Math.floor(hash3(q, y, dir + 11) * CAR_COLORS.length)];
              ctx.fillRect(cx - len / 2, ly - wid / 2, len, wid);
            }
          }
        }
        if (n || s) {
          for (const dir of [1, -1]) {
            const lx = x + (dir > 0 ? 0.36 : 0.64);
            const shift = dir * t * speed * 2.2;
            const q0 = Math.floor(y * 2.2 - shift) - 1;
            for (let q = q0; q <= q0 + 4; q++) {
              if (hash3(x, q, dir + 3) > dens) continue;
              const cy = (q + shift) / 2.2;
              if (cy < y || cy > y + 1) continue;
              if (cy < y + 0.5 ? !n : !s) continue;
              ctx.fillStyle = 'rgba(0,0,0,0.25)';
              ctx.fillRect(lx - wid / 2 + 0.03, cy - len / 2 + 0.04, wid, len);
              ctx.fillStyle = CAR_COLORS[Math.floor(hash3(x, q, dir + 13) * CAR_COLORS.length)];
              ctx.fillRect(lx - wid / 2, cy - len / 2, wid, len);
            }
          }
        }
      }
    }
  }

  private drawNight(ctx: CanvasRenderingContext2D, dark: number, x0: number, y0: number, x1: number, y1: number): void {
    const world = this.world;
    ctx.fillStyle = `rgba(10,16,46,${dark})`;
    ctx.fillRect(0, 0, world.w, world.h);
    ctx.globalCompositeOperation = 'lighter';
    const a = Math.min(1, dark * 1.7);
    // Street lamps on every other road tile.
    ctx.globalAlpha = a * 0.55;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * world.w + x;
        if (!(world.net[i] & ROAD) || (x + y) % 2) continue;
        ctx.drawImage(this.glow, x + 0.05, y + 0.05, 0.9, 0.9);
      }
    }
    // Lit windows.
    ctx.globalAlpha = a * 0.8;
    for (const b of world.buildings.values()) {
      if (b.x > x1 || b.y > y1 || b.x + b.size < x0 || b.y + b.size < y0) continue;
      if (world.city.founded && !b.powered && b.kind !== 'park') continue;
      const lights = b.kind === 'park' ? 1 : isZone(b.kind) ? b.level * 2 : b.size * 2;
      for (let k = 0; k < lights; k++) {
        const lx = b.x + 0.25 + hash3(b.id, k, 1) * (b.size - 0.5);
        const ly = b.y + 0.25 + hash3(b.id, k, 2) * (b.size - 0.5);
        const r = b.kind === 'park' ? 0.5 : 0.22 + hash3(b.id, k, 3) * 0.2;
        ctx.drawImage(this.glow, lx - r, ly - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private emittersFor(id: number): Emitter[] {
    const b = this.world.buildings.get(id)!;
    const key = `${b.seed}|${b.level}|${b.kind}`;
    const hit = this.emitters.get(id);
    if (hit && hit.key === key) return hit.list;
    const list = buildingEmitters(this.world, b);
    this.emitters.set(id, { key, list });
    return list;
  }

  private drawEmitters(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    const world = this.world;
    const t = this.simTime;
    const founded = world.city.founded;
    for (const b of world.buildings.values()) {
      if (b.x > x1 || b.y > y1 || b.x + b.size < x0 || b.y + b.size < y0) continue;
      if (b.kind !== 'ind' && b.kind !== 'coal' && b.kind !== 'nuclear' && b.kind !== 'wind' && b.kind !== 'com' && b.kind !== 'airport') continue;
      if (b.kind === 'ind' && b.level < 3) continue;
      if (b.kind === 'com' && b.level < 5) continue;
      const list = this.emittersFor(b.id);
      const active = !founded || b.powered || b.kind === 'wind' || b.kind === 'coal' || b.kind === 'nuclear';
      const seed = (b.seed % 1000) / 1000;
      for (const e of list) {
        if (e.kind === 'rotor') {
          const a = (this.time * (active ? 2.6 : 0.4) + seed * 6) % (Math.PI * 2);
          ctx.strokeStyle = '#F4F6F7';
          ctx.lineWidth = 0.06;
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (let k = 0; k < 3; k++) {
            const aa = a + (k * Math.PI * 2) / 3;
            ctx.moveTo(e.x, e.y);
            ctx.lineTo(e.x + Math.cos(aa) * e.size, e.y + Math.sin(aa) * e.size * 0.9);
          }
          ctx.stroke();
          ctx.lineCap = 'butt';
          continue;
        }
        if (e.kind === 'beacon') {
          if ((this.time + seed * 3) % 1.6 < 0.25) {
            ctx.fillStyle = '#FF3B30';
            ctx.beginPath();
            ctx.arc(e.x, e.y, 0.07, 0, Math.PI * 2);
            ctx.fill();
          }
          continue;
        }
        if (!active) continue;
        const steam = e.kind === 'steam';
        const puffs = steam ? 5 : 6;
        for (let k = 0; k < puffs; k++) {
          const ph = (t * (steam ? 0.22 : 0.35) + k / puffs + seed) % 1;
          const px = e.x + ph * (steam ? 0.6 : 1.1) + Math.sin(ph * 6 + k) * 0.08;
          const py = e.y - ph * (steam ? 0.9 : 1.2);
          const r = e.size * (steam ? 0.5 : 1) + ph * (steam ? 0.7 : 0.45);
          const a = (1 - ph) * (steam ? 0.45 : 0.5);
          ctx.fillStyle = steam ? `rgba(245,247,248,${a})` : `rgba(96,92,88,${a})`;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  private drawHazards(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    const world = this.world;
    const t = this.time;
    for (const i of this.hazards) {
      const x = i % world.w;
      const y = (i / world.w) | 0;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      {
        if (world.flood[i]) {
          ctx.fillStyle = 'rgba(64,122,170,0.78)';
          ctx.fillRect(x, y, 1, 1);
          ctx.strokeStyle = 'rgba(220,240,250,0.5)';
          ctx.lineWidth = 0.04;
          ctx.beginPath();
          const ph = (t * 0.8 + hash3(x, y, 1)) % 1;
          ctx.arc(x + 0.5, y + 0.5, 0.15 + ph * 0.3, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (world.fire[i]) {
          ctx.fillStyle = 'rgba(40,18,8,0.4)';
          ctx.fillRect(x, y, 1, 1);
          for (let k = 0; k < 3; k++) {
            const fx = x + 0.2 + hash3(x, y, k) * 0.6;
            const fy = y + 0.35 + hash3(x, y, k + 5) * 0.5;
            const fl = 0.22 + 0.08 * Math.sin(t * 11 + k * 2 + x);
            flame(ctx, fx, fy, fl);
          }
          const ph = (t * 0.5 + hash3(x, y, 9)) % 1;
          ctx.fillStyle = `rgba(60,55,50,${0.45 * (1 - ph)})`;
          ctx.beginPath();
          ctx.arc(x + 0.5 + ph * 0.6, y + 0.2 - ph * 1.2, 0.2 + ph * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  private drawPowerWarnings(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    if ((this.time % 1.2) > 0.75) return;
    for (const b of this.world.buildings.values()) {
      if (b.powered || !isZone(b.kind)) continue;
      if (b.x > x1 || b.y > y1 || b.x + b.size < x0 || b.y + b.size < y0) continue;
      bolt(ctx, b.x + 1.5, b.y + 1.5, 0.42);
    }
  }

  private drawRoamers(ctx: CanvasRenderingContext2D): void {
    if (!this.sim) return;
    const f = this.stepFrac;
    for (const r of this.sim.disasters.roamers) {
      const x = r.px + (r.x - r.px) * f;
      const y = r.py + (r.y - r.py) * f;
      if (r.kind === 'tornado') {
        for (let k = 0; k < 7; k++) {
          const a = this.time * 7 + k * 0.9;
          const rad = 0.25 + k * 0.17;
          ctx.fillStyle = `rgba(70,72,78,${0.32 - k * 0.03})`;
          ctx.beginPath();
          ctx.ellipse(x + Math.cos(a) * 0.12 * k, y - k * 0.28 + Math.sin(a) * 0.08 * k, rad, rad * 0.55, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#6B5B4B';
        for (let k = 0; k < 8; k++) {
          const a = this.time * 9 + k;
          ctx.fillRect(x + Math.cos(a) * (0.6 + (k % 3) * 0.3), y + Math.sin(a) * 0.4 - (k % 4) * 0.3, 0.1, 0.1);
        }
      } else {
        monster(ctx, x, y, r.heading, this.time);
      }
    }
  }

  private drawPreview(ctx: CanvasRenderingContext2D): void {
    const p = this.preview;
    const lw = 1.5 / (this.cam.zoom);
    if (this.hover && (!p || (!p.tiles.length && !p.rects.length && !p.bad.length && !p.brush))) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = lw;
      ctx.strokeRect(this.hover.x + lw / 2, this.hover.y + lw / 2, 1 - lw, 1 - lw);
    }
    if (!p) return;
    const tint = p.tint ?? '255,255,255';
    for (const [x, y] of p.tiles) {
      ctx.fillStyle = `rgba(${tint},0.32)`;
      ctx.fillRect(x, y, 1, 1);
    }
    for (const [x, y] of p.bad) {
      ctx.fillStyle = 'rgba(227,73,72,0.5)';
      ctx.fillRect(x, y, 1, 1);
    }
    for (const r of p.rects) {
      ctx.fillStyle = r.ok ? `rgba(${tint},0.28)` : 'rgba(227,73,72,0.4)';
      ctx.fillRect(r.x, r.y, r.s, r.s);
      ctx.strokeStyle = r.ok ? 'rgba(255,255,255,0.95)' : 'rgba(255,120,110,0.95)';
      ctx.lineWidth = lw * 1.4;
      ctx.strokeRect(r.x + lw, r.y + lw, r.s - lw * 2, r.s - lw * 2);
    }
    if (p.brush) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = lw * 1.2;
      ctx.beginPath();
      ctx.arc(p.brush.x, p.brush.y, p.brush.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.arc(p.brush.x, p.brush.y, p.brush.r + lw * 1.2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- overlays -------------------------------------------------------------

  private drawOverlay(ctx: CanvasRenderingContext2D): void {
    this.overlayAge += 1;
    if (this.overlayDirty || this.overlayAge > 90) {
      this.buildOverlay();
      this.overlayDirty = false;
      this.overlayAge = 0;
    }
    // Dim the map a little so the data reads.
    ctx.fillStyle = 'rgba(14,20,18,0.55)';
    ctx.fillRect(0, 0, this.world.w, this.world.h);
    ctx.imageSmoothingEnabled = this.overlay !== 'power' && this.overlay !== 'traffic' && this.overlay !== 'slope';
    ctx.drawImage(this.overlayCanvas, 0, 0, this.world.w, this.world.h);
    ctx.imageSmoothingEnabled = true;
  }

  private buildOverlay(): void {
    const world = this.world;
    const oc = this.overlayCanvas.getContext('2d')!;
    const img = oc.createImageData(world.w, world.h);
    const d = img.data;
    const def = OVERLAYS.find((o) => o.id === this.overlay)!;
    const base = parseInt(def.color.slice(1), 16);
    const cr = (base >> 16) & 255;
    const cg = (base >> 8) & 255;
    const cb = base & 255;
    const src: Uint8Array | null =
      this.overlay === 'traffic' ? world.traffic :
      this.overlay === 'pollution' ? world.pollution :
      this.overlay === 'crime' ? world.crime :
      this.overlay === 'landValue' ? world.landValue :
      this.overlay === 'density' ? world.density :
      this.overlay === 'police' ? world.policeCov :
      this.overlay === 'fire' ? world.fireCov :
      this.overlay === 'service' ? world.serviceCov : null;
    for (let i = 0; i < world.n; i++) {
      const o = i * 4;
      if (this.overlay === 'slope') {
        if (world.water[i]) continue;
        const s = world.slope(i % world.w, (i / world.w) | 0);
        const cls = SLOPE_CLASSES.find((c) => s <= c.max)!;
        if (!cls.alpha) continue;
        const dark = cls.alpha / 255;
        d[o] = cr * (1 - dark * 0.35); d[o + 1] = cg * (1 - dark * 0.45); d[o + 2] = cb * (1 - dark * 0.45); d[o + 3] = cls.alpha;
        continue;
      }
      if (this.overlay === 'power') {
        const id = world.occ[i];
        if (world.powered[i]) {
          d[o] = 242; d[o + 1] = 201; d[o + 2] = 76; d[o + 3] = 200;
        } else if (id && world.buildings.get(id)?.kind !== 'park') {
          d[o] = 227; d[o + 1] = 73; d[o + 2] = 72; d[o + 3] = 220;
        } else if (world.net[i] & 4) {
          d[o] = 120; d[o + 1] = 110; d[o + 2] = 90; d[o + 3] = 200;
        }
        continue;
      }
      if (!src) continue;
      let v = src[i] / 255;
      if (this.overlay === 'traffic' && !(world.net[i] & ROAD)) continue;
      if (world.water[i] && this.overlay !== 'pollution') continue;
      if (this.overlay === 'landValue') v = Math.max(0, (v - 0.1) / 0.8);
      v = Math.min(1, v);
      // One hue, light to dark, with opacity rising with the value.
      const k = 1 - v * 0.45;
      d[o] = cr + (255 - cr) * (1 - v) * 0.55 * k;
      d[o + 1] = cg + (255 - cg) * (1 - v) * 0.55 * k;
      d[o + 2] = cb + (255 - cb) * (1 - v) * 0.55 * k;
      d[o + 3] = 18 + Math.sqrt(v) * 225;
    }
    oc.putImageData(img, 0, 0);
  }
}

function flame(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#FF6A00';
  ctx.beginPath();
  ctx.moveTo(x, y - s * 1.6);
  ctx.quadraticCurveTo(x + s * 0.9, y - s * 0.2, x, y + s * 0.4);
  ctx.quadraticCurveTo(x - s * 0.9, y - s * 0.2, x, y - s * 1.6);
  ctx.fill();
  ctx.fillStyle = '#FFC93C';
  ctx.beginPath();
  ctx.moveTo(x, y - s * 0.9);
  ctx.quadraticCurveTo(x + s * 0.5, y, x, y + s * 0.3);
  ctx.quadraticCurveTo(x - s * 0.5, y, x, y - s * 0.9);
  ctx.fill();
}

function bolt(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = 'rgba(20,24,22,0.8)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#F2C94C';
  ctx.beginPath();
  ctx.moveTo(x + r * 0.15, y - r * 0.75);
  ctx.lineTo(x - r * 0.4, y + r * 0.1);
  ctx.lineTo(x - r * 0.02, y + r * 0.1);
  ctx.lineTo(x - r * 0.18, y + r * 0.75);
  ctx.lineTo(x + r * 0.42, y - r * 0.12);
  ctx.lineTo(x + r * 0.04, y - r * 0.12);
  ctx.closePath();
  ctx.fill();
}

function monster(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, t: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0.4, 0.5, 1.6, 1.0, heading, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(heading);
  const step = Math.sin(t * 6) * 0.25;
  ctx.fillStyle = '#2F6B3A';
  // Tail.
  ctx.beginPath();
  ctx.moveTo(-0.8, -0.3);
  ctx.quadraticCurveTo(-1.9, Math.sin(t * 3) * 0.5, -2.4, Math.sin(t * 3 + 1) * 0.3);
  ctx.quadraticCurveTo(-1.9, 0.2, -0.8, 0.3);
  ctx.fill();
  // Legs.
  for (const [lx, ly, ph] of [[0.5, -0.6, 1], [0.5, 0.6, -1], [-0.5, -0.6, -1], [-0.5, 0.6, 1]]) {
    ctx.beginPath();
    ctx.ellipse(lx + step * ph, ly, 0.28, 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#3C8448';
  ctx.beginPath();
  ctx.ellipse(0, 0, 1.1, 0.65, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#A9D18E';
  for (let k = 0; k < 5; k++) {
    ctx.beginPath();
    ctx.moveTo(-0.8 + k * 0.4, -0.08);
    ctx.lineTo(-0.6 + k * 0.4, 0);
    ctx.lineTo(-0.8 + k * 0.4, 0.08);
    ctx.fill();
  }
  ctx.fillStyle = '#3C8448';
  ctx.beginPath();
  ctx.ellipse(1.25, 0, 0.45, 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FF3B30';
  ctx.beginPath();
  ctx.arc(1.45, -0.15, 0.07, 0, Math.PI * 2);
  ctx.arc(1.45, 0.15, 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

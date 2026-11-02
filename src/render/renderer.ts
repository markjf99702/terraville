// The map view. Static content (terrain, roads, buildings) is painted into
// 16x16-tile chunk canvases at one of four detail levels and cached; moving
// things (traffic, smoke, fire, disasters, tool previews) are drawn fresh
// every frame on top.
import { BUILDINGS, ROAD, isZone } from '../defs';
import type { Sim } from '../sim';
import type { Building, World } from '../world';
import { lessMotion } from '../motion';
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
const ANDROID = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
const PIXEL_BUDGET = WEBKIT ? 12_000_000 : 32_000_000;
/**
 * Phones draw street level at 32 px a tile at most, as iPhones always have: a patch takes about 100 ms to paint at 32
 * on a slow phone, and 330 at 64.
 */
const MAX_LOD = WEBKIT || ANDROID ? 32 : 64;
/**
 * While a brush is held, the chunks it changes are redrawn at no more than this detail, and sharpened once it lifts: a
 * chunk takes about 8 ms to paint at 16 px a tile and 88 ms at 64.
 */
const BRUSH_LOD = 16;
/** A frame's share of time for painting patches that changed or came into view, in ms. */
const PAINT_MS = 8;
/**
 * And one longer paint a frame may take this long, in ms, while the clock runs, the map moves or a brush is held. A
 * patch takes about 1.5 ms to paint at 8 px a tile, 6 at 16, 22 at 32 and 80 at 64 on a laptop, and four or five times
 * that on a slow phone: a sharper copy than that waits for the clock to stop and the map to come to rest, and a
 * blurrier one shows meanwhile.
 */
const HITCH_MS = 40;
/**
 * A patch takes about this power of its detail to paint: 8 ms at 8 px a tile, 28 at 16, 100 at 32 and 330 at 64 on a
 * slow phone.
 */
const PAINT_POWER = 1.8;
/** The map has come to rest this long, in seconds, after the camera last moved. */
const SETTLE_S = 0.25;
/**
 * Night lights are painted once for each patch and laid over the dark every frame: a big city has thousands of them in
 * view. They are soft glows and scale up well, so they are painted at half the map's detail: 16 px a tile close in, and
 * 8 further out, where many more patches are in view.
 */
const LIGHT_LODS = [8, 16];
/** Canvas pixels the patches' night lights may hold between them. */
const LIGHT_BUDGET = WEBKIT ? 2_000_000 : 6_000_000;

interface Chunk {
  canvas: HTMLCanvasElement;
  L: number;
  dirty: boolean;
  used: number;
  contours: boolean;
}

/** A patch's street lamps and lit windows, painted together; no canvas when it has none. */
interface Lights {
  canvas: HTMLCanvasElement | null;
  dirty: boolean;
  used: number;
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

/** Steepness classes for the slope layer, by the largest height step to a dry neighbour. */
export const SLOPE_CLASSES = [
  { max: 4.5, label: 'Flat', note: 'anything fits', alpha: 0 },
  { max: 9, label: 'Gentle', note: 'building here costs a little extra to level', alpha: 90 },
  { max: 14, label: 'Steep', note: 'roads and rail grade themselves, big lots may need Level land', alpha: 160 },
  { max: Infinity, label: 'Very steep', note: 'flatten it with Level land before building', alpha: 225 },
];

/** Distances in from each side of the map's canvas, in CSS pixels. */
export interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}

const NO_INSETS: Insets = { l: 0, t: 0, r: 0, b: 0 };

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
  /**
   * How far the panels reach in over the map from each side, with a margin: each edge of the map may come in that far,
   * so that every tile can be brought clear of them. Measured by the page (see UI.measureInsets).
   */
  insets: Insets = { ...NO_INSETS };
  /**
   * How far each edge of the map may still come in past the insets, because it was there when a panel shrank or closed:
   * the map stays put rather than jump, and the extra room goes as the camera moves back in.
   */
  private held: Insets = { ...NO_INSETS };
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
  /** What the Inspect card describes: a building's footprint, or one tile. The pointer's hover never moves it. */
  selected: { x: number; y: number; size: number } | null = null;
  /** Whether the simulation clock is running (freezes traffic when paused). */
  running = false;
  /** Seconds, always ticking (water, blinking). */
  time = 0;
  /** Seconds, ticking only while the sim runs (cars, smoke drift). */
  simTime = 0;
  /** 0-1 progress between sim steps, for smooth disaster movement. */
  stepFrac = 0;
  /** A brush is being held down: see BRUSH_LOD. */
  brushing = false;
  shake = 0;

  private chunks = new Map<number, Chunk>();
  private pixels = 0;
  /** How long patches have taken to paint lately, in ms per detail to the PAINT_POWER: see PAINT_MS. */
  private paintRate = 0;
  /** Where the camera was last frame, and when it last moved, to tell when the map has come to rest. */
  private lastCam = { x: 0, y: 0, zoom: 1 };
  private movedAt = -Infinity;
  private lights = new Map<number, Lights>();
  private lightPixels = 0;
  /** The powered tiles as the night lights last saw them: a lot that loses power goes dark. */
  private litPower: Uint8Array | null = null;
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
  /** A camera move in progress (see flyTo): where it set out from and where it is going, in tiles and log zoom. */
  private flight: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; zoom: number; start: number; ms: number } | null = null;

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
    this.selected = null;
    this.flight = null;
    this.held = { ...NO_INSETS };
    this.field = new TerrainField(world);
    if (!this.vehicles) this.vehicles = new Vehicles(world);
    else this.vehicles.setWorld(world);
    this.releaseChunks();
    this.releaseLights();
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
        for (const L of LIGHT_LODS) {
          const l = this.lights.get(this.key(cx, cy, L));
          if (l) l.dirty = true;
        }
      }
    }
    this.overlayDirty = true;
  }

  invalidateAll(): void {
    for (const c of this.chunks.values()) c.dirty = true;
    for (const l of this.lights.values()) l.dirty = true;
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

  /**
   * Keep the map in view: each of its edges may come in from its side of the screen as far as `edge` says (the panels,
   * by default), and no further. A map smaller than the room left sits in the middle of it. The title screen's drift
   * passes no insets, so its map always fills the screen.
   */
  clampCamera(edge: Insets = this.insets): void {
    const z = this.cam.zoom;
    const own = edge === this.insets;
    const h = this.held;
    const e = own ? { l: Math.max(edge.l, h.l), t: Math.max(edge.t, h.t), r: Math.max(edge.r, h.r), b: Math.max(edge.b, h.b) } : edge;
    const fit = (at: number, view: number, size: number, lo: number, hi: number) => {
      const min = (view / 2 - lo) / z; // the map's near edge `lo` px in from the screen's
      const max = size - (view / 2 - hi) / z; // and its far edge `hi` px in from the other side
      return min > max ? (min + max) / 2 : Math.max(min, Math.min(max, at));
    };
    this.cam.x = fit(this.cam.x, this.cssW, this.world.w, e.l, e.r);
    this.cam.y = fit(this.cam.y, this.cssH, this.world.h, e.t, e.b);
    if (own) {
      const now = this.edgesIn();
      this.held = { l: Math.max(0, Math.min(h.l, now.l)), t: Math.max(0, Math.min(h.t, now.t)), r: Math.max(0, Math.min(h.r, now.r)), b: Math.max(0, Math.min(h.b, now.b)) };
    }
  }

  /** How far in from each side of the screen each edge of the map is now, in CSS pixels. */
  private edgesIn(): Insets {
    const a = this.tileToScreen(0, 0);
    const b = this.tileToScreen(this.world.w, this.world.h);
    return { l: a.x, t: a.y, r: this.cssW - b.x, b: this.cssH - b.y };
  }

  /**
   * Set how far the panels reach in over the map (see insets). An edge of the map that is in further than the new
   * insets allow, because a panel shrank or closed, is held there until the camera moves back in.
   */
  setInsets(e: Insets): void {
    const was = this.insets;
    this.insets = e;
    if (!this.world) return;
    const now = this.edgesIn();
    for (const k of ['l', 't', 'r', 'b'] as const) {
      // Only room the old insets gave, and the new ones don't, is held.
      if (e[k] < was[k]) this.held[k] = Math.max(this.held[k], Math.min(now[k], was[k]));
      if (this.held[k] <= e[k]) this.held[k] = 0;
    }
  }

  /** Zoom and move so the whole map fits in a rectangle of the screen (CSS pixels), in its middle. */
  fitRect(l: number, t: number, r: number, b: number): void {
    this.flight = null;
    this.held = { ...NO_INSETS };
    const { w, h } = this.world;
    const z = Math.max(this.minZoom(), Math.min(96, (r - l) / w, (b - t) / h));
    this.cam.zoom = z;
    this.cam.x = w / 2 - ((l + r) / 2 - this.cssW / 2) / z;
    this.cam.y = h / 2 - ((t + b) / 2 - this.cssH / 2) / z;
    this.clampCamera();
  }

  /** The whole map, in the room the panels leave. */
  fitWhole(): void {
    const e = this.insets;
    this.fitRect(e.l, e.t, this.cssW - e.r, this.cssH - e.b);
  }

  /** The tile in the middle of the room the panels leave. */
  freeCentre(): { x: number; y: number } {
    const e = this.insets;
    return this.screenToTile((e.l + this.cssW - e.r) / 2, (e.t + this.cssH - e.b) / 2);
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
    this.flight = null;
    const before = this.screenToTile(sx, sy);
    this.cam.zoom = Math.max(this.minZoom(), Math.min(96, this.cam.zoom * factor));
    const after = this.screenToTile(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCamera();
  }

  centerOn(x: number, y: number): void {
    this.flight = null;
    this.cam.x = x;
    this.cam.y = y;
    this.clampCamera();
  }

  /**
   * Move the camera to centre on (x, y) at `zoom`, easing in and out over `ms`: the position in tiles and the zoom in
   * its logarithm, so a zoom in feels as quick as a zoom out. With less motion asked for it jumps there. Anything else
   * that moves the camera (a drag, the wheel, a key) calls it off.
   */
  flyTo(x: number, y: number, zoom: number, ms = 450): void {
    const from = { ...this.cam };
    this.cam.zoom = Math.max(this.minZoom(), Math.min(96, zoom));
    this.centerOn(x, y);
    if (lessMotion() || ms <= 0) return;
    const to = { ...this.cam };
    if (Math.abs(to.x - from.x) < 0.01 && Math.abs(to.y - from.y) < 0.01 && Math.abs(to.zoom - from.zoom) < 0.01) return;
    this.cam.x = from.x;
    this.cam.y = from.y;
    this.cam.zoom = from.zoom;
    this.flight = { x0: from.x, y0: from.y, z0: Math.log(from.zoom), x1: to.x, y1: to.y, z1: Math.log(to.zoom), zoom: to.zoom, start: performance.now(), ms };
  }

  /** Call off a camera move in progress, leaving the camera where it has got to. */
  stopFlight(): void {
    this.flight = null;
  }

  /** Whether the camera is on its way somewhere (see flyTo). */
  get flying(): boolean {
    return this.flight !== null;
  }

  /** Move the camera along its flight, by the clock rather than by frames, so a slow device lands on time too. */
  private stepFlight(): void {
    const f = this.flight;
    if (!f) return;
    const t = Math.min(1, (performance.now() - f.start) / f.ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.cam.x = f.x0 + (f.x1 - f.x0) * e;
    this.cam.y = f.y0 + (f.y1 - f.y0) * e;
    this.cam.zoom = Math.exp(f.z0 + (f.z1 - f.z0) * e);
    if (t < 1) return;
    // It lands exactly where it was sent.
    this.cam.zoom = f.zoom;
    this.flight = null;
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
    const t0 = performance.now();
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
    // Painting time grows as the detail to the power 1.8, on a laptop or a slow phone alike: one figure, kept up to
    // date by every paint at any detail, says how fast this device is going.
    const rate = (performance.now() - t0) / L ** PAINT_POWER;
    this.paintRate = this.paintRate ? this.paintRate * 0.8 + rate * 0.2 : rate;
    return c;
  }

  /** How long a patch will take to paint at detail L, in ms, going by those painted so far. */
  private paintEstimate(L: number): number {
    return this.paintRate * L ** PAINT_POWER;
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
    this.stepFlight();
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
    // The map comes to rest once the camera stops (the title screen's slow drift doesn't count as moving).
    const cam = this.cam;
    const last = this.lastCam;
    if (Math.abs(cam.x - last.x) * cam.zoom > 40 * dt + 0.5 || Math.abs(cam.y - last.y) * cam.zoom > 40 * dt + 0.5 || Math.abs(Math.log(cam.zoom / last.zoom)) > 0.2 * dt + 0.001) this.movedAt = this.time;
    this.lastCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
    const still = !this.running && !this.brushing && this.time - this.movedAt >= SETTLE_S;
    const start = performance.now();
    ctx.imageSmoothingEnabled = true;
    const todo: [number, number][] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) todo.push([cx, cy]);
    // Centre chunks first so the part you are looking at sharpens first.
    const ccx = (W / 2 - ox) / (CS * zd);
    const ccy = (H / 2 - oy) / (CS * zd);
    todo.sort((a, b) => Math.hypot(a[0] + 0.5 - ccx, a[1] + 0.5 - ccy) - Math.hypot(b[0] + 0.5 - ccx, b[1] + 0.5 - ccy));
    // No map size is a whole number of chunks: the last column and row hang past the edge, painted with the edge
    // tiles stretched, so only the map itself is drawn and the overhang shows the same margin as the other sides.
    ctx.save();
    ctx.beginPath();
    const mx = Math.round(ox);
    const my = Math.round(oy);
    ctx.rect(mx, my, Math.round(ox + this.world.w * zd) - mx, Math.round(oy + this.world.h * zd) - my);
    ctx.clip();
    // A patch that changed or came into view is painted as sharp as the frame's share of time allows (see PAINT_MS),
    // or by the one longer paint each frame may take: with the clock stopped and the map at rest that one may be as
    // long as it needs, and it sharpens the patches nearest the middle one a frame.
    let long = false;
    let painted = false;
    for (const [cx, cy] of todo) {
      const fresh = (L: number): Chunk | undefined => {
        const o = this.chunks.get(this.key(cx, cy, L));
        return o && !o.dirty && o.contours === this.contours ? o : undefined;
      };
      let c = fresh(wantL);
      if (!c) {
        // Under a brush, a coarser copy only, sharpened once it lifts.
        const cap = this.brushing ? Math.min(wantL, BRUSH_LOD) : wantL;
        const floor = this.brushing ? cap : LODS[0];
        let have: Chunk | undefined;
        for (let k = LODS.length - 1; k >= 0 && !have; k--) have = fresh(LODS[k]);
        const left = PAINT_MS - (performance.now() - start);
        let L = 0;
        let slow = false;
        for (let k = LODS.indexOf(cap); k >= 0 && LODS[k] >= floor; k--) {
          const ms = this.paintEstimate(LODS[k]);
          if (ms <= left) L = LODS[k];
          else if (!long && (still ? LODS[k] === cap : ms <= HITCH_MS)) {
            L = LODS[k];
            slow = true;
          } else continue;
          break;
        }
        // A copy that shows the land as it is now will do unless this one is sharper, or the right size for a copy
        // that is sharper than needed.
        const better = !have || L > have.L || (have.L > wantL && L === wantL);
        if (L && better) {
          c = this.renderChunk(cx, cy, L) ?? have;
          long ||= slow;
          painted = true;
        } else if (have) c = have;
        else if (!painted && !long) {
          // Nothing at all fits the time left: the coarsest copy, so the frame gets something done.
          c = this.renderChunk(cx, cy, floor) ?? undefined;
          painted = true;
        }
      }
      if (!c) {
        // A copy from before the change, until there is time to paint it again.
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
      // A coarser copy blown up (under a brush, or until a sharper one is painted) is smoothed the cheap way.
      ctx.imageSmoothingQuality = zd > c.L ? 'low' : 'high';
      ctx.drawImage(c.canvas, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.restore();
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
      if (dark > 0.01) this.drawNight(ctx, dark, vx0, vy0, vx1, vy1, wantL >= 32 ? 16 : 8);
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
    if (this.sim && this.world.city.founded) this.drawWarnings(ctx, vx0, vy0, vx1, vy1);
    this.drawRoamers(ctx);
    this.drawPreview(ctx);
    this.drawSelected(ctx);

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

  private drawNight(ctx: CanvasRenderingContext2D, dark: number, x0: number, y0: number, x1: number, y1: number, LL: number): void {
    const world = this.world;
    ctx.fillStyle = `rgba(10,16,46,${dark})`;
    ctx.fillRect(0, 0, world.w, world.h);
    this.checkLitPower();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, dark * 1.7);
    // Each patch's lights as painted, the ones nearest the middle painted again first when they change; past this
    // frame's share of time, a patch shows its lights from before until the next frame.
    const cx0 = Math.floor(x0 / CS);
    const cy0 = Math.floor(y0 / CS);
    const cx1 = Math.floor(x1 / CS);
    const cy1 = Math.floor(y1 / CS);
    const start = performance.now();
    let painted = false;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        let l = this.lights.get(this.key(cx, cy, LL));
        if (!l || (l.dirty && (!painted || performance.now() - start < PAINT_MS / 2))) {
          l = this.paintLights(cx, cy, LL);
          painted = true;
        }
        l.used = this.time;
        if (l.canvas) ctx.drawImage(l.canvas, cx * CS, cy * CS, CS, CS);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.evictLights();
  }

  /**
   * Paint a patch's night lights, at full strength (the dark sets how strongly they show): street lamps on every other
   * road tile; lit windows and doors, where each building's drawing puts them; a park's lamp, and any building whose
   * drawing marks none, at spots of its own. A power plant shows none: its beacons and its smoke say it runs. A lot
   * without power stays dark. A glow near the patch's edge is painted in each patch it reaches.
   */
  private paintLights(cx: number, cy: number, LL: number): Lights {
    const k = this.key(cx, cy, LL);
    let l = this.lights.get(k);
    if (!l) {
      l = { canvas: null, dirty: false, used: this.time };
      this.lights.set(k, l);
    }
    l.dirty = false;
    const world = this.world;
    const tx0 = cx * CS;
    const ty0 = cy * CS;
    const tx1 = Math.min(world.w, tx0 + CS);
    const ty1 = Math.min(world.h, ty0 + CS);
    const lamps: number[] = [];
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) if (world.net[y * world.w + x] & ROAD && !((x + y) % 2)) lamps.push(x, y);
    }
    // Buildings on the patch or a tile beyond it, whose glows may reach in.
    const ids = new Set<number>();
    for (let y = Math.max(0, ty0 - 1); y < Math.min(world.h, ty1 + 1); y++) {
      for (let x = Math.max(0, tx0 - 1); x < Math.min(world.w, tx1 + 1); x++) {
        const id = world.occ[y * world.w + x];
        if (id) ids.add(id);
      }
    }
    const spots: number[] = [];
    for (const id of ids) {
      const b = world.buildings.get(id);
      if (!b || (world.city.founded && !b.powered && b.kind !== 'park') || BUILDINGS[b.kind].capacity) continue;
      let lit = false;
      if (b.kind !== 'park') {
        for (const e of this.emittersFor(b.id)) {
          if (e.kind !== 'light') continue;
          spots.push(e.x, e.y, e.size);
          lit = true;
        }
      }
      if (lit) continue;
      const n = b.kind === 'park' ? 1 : isZone(b.kind) ? b.level * 2 : b.size * 2;
      for (let j = 0; j < n; j++) {
        spots.push(b.x + 0.25 + hash3(b.id, j, 1) * (b.size - 0.5), b.y + 0.25 + hash3(b.id, j, 2) * (b.size - 0.5), b.kind === 'park' ? 0.5 : 0.22 + hash3(b.id, j, 3) * 0.2);
      }
    }
    if (!lamps.length && !spots.length) {
      this.dropLights(l);
      return l;
    }
    if (!l.canvas) {
      l.canvas = document.createElement('canvas');
      l.canvas.width = l.canvas.height = CS * LL;
      this.lightPixels += CS * LL * CS * LL;
    }
    const g = l.canvas.getContext('2d');
    if (!g) {
      this.dropLights(l);
      return l;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, l.canvas.width, l.canvas.height);
    g.setTransform(LL, 0, 0, LL, -tx0 * LL, -ty0 * LL);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.55;
    for (let j = 0; j < lamps.length; j += 2) g.drawImage(this.glow, lamps[j] + 0.05, lamps[j + 1] + 0.05, 0.9, 0.9);
    g.globalAlpha = 0.8;
    for (let j = 0; j < spots.length; j += 3) {
      const r = spots[j + 2];
      g.drawImage(this.glow, spots[j] - r, spots[j + 1] - r, r * 2, r * 2);
    }
    return l;
  }

  /** Lots whose power came or went since the lights were painted: their patches are painted again. */
  private checkLitPower(): void {
    const p = this.world.powered;
    const was = this.litPower;
    if (!was || was.length !== p.length) {
      this.litPower = p.slice();
      for (const l of this.lights.values()) l.dirty = true;
      return;
    }
    const w = this.world.w;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === was[i]) continue;
      was[i] = p[i];
      // A building's glow reaches a little past its lot.
      const x = i % w;
      const y = (i / w) | 0;
      for (let cy = Math.floor((y - 1) / CS); cy <= Math.floor((y + 1) / CS); cy++) {
        for (let cx = Math.floor((x - 1) / CS); cx <= Math.floor((x + 1) / CS); cx++) {
          for (const L of LIGHT_LODS) {
            const l = this.lights.get(this.key(cx, cy, L));
            if (l) l.dirty = true;
          }
        }
      }
    }
  }

  private dropLights(l: Lights): void {
    if (!l.canvas) return;
    this.lightPixels -= l.canvas.width * l.canvas.height;
    l.canvas.width = l.canvas.height = 0;
    l.canvas = null;
  }

  private releaseLights(): void {
    for (const l of this.lights.values()) this.dropLights(l);
    this.lights.clear();
    this.lightPixels = 0;
    this.litPower = null;
  }

  /** The lights of patches longest out of view go first, past LIGHT_BUDGET; those in view this frame stay. */
  private evictLights(): void {
    if (this.lightPixels <= LIGHT_BUDGET) return;
    const list = [...this.lights.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, l] of list) {
      if (this.lightPixels <= LIGHT_BUDGET * 0.8 || l.used >= this.time) break;
      this.dropLights(l);
      this.lights.delete(k);
    }
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
        if (e.kind === 'light') continue; // drawn by night (see paintLights)
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
    // Flood water first, a run of tiles to a fill, and its ripples in one stroke, only close enough in to see them: a
    // high tide can cover a thousand tiles and more, and a fill and a stroke for each cost a slow phone most of a frame.
    let ripples = false;
    ctx.fillStyle = 'rgba(64,122,170,0.78)';
    let run = -1;
    let runX = 0;
    let runY = 0;
    for (const i of this.hazards) {
      const x = i % world.w;
      const y = (i / world.w) | 0;
      if (x < x0 || x > x1 || y < y0 || y > y1 || !world.flood[i]) continue;
      if (run >= 0 && y === runY && x === runX + run) run++;
      else {
        if (run > 0) ctx.fillRect(runX, runY, run, 1);
        run = 1;
        runX = x;
        runY = y;
      }
      ripples = true;
    }
    if (run > 0) ctx.fillRect(runX, runY, run, 1);
    if (ripples && this.cam.zoom >= 10) {
      ctx.strokeStyle = 'rgba(220,240,250,0.5)';
      ctx.lineWidth = 0.04;
      ctx.beginPath();
      for (const i of this.hazards) {
        const x = i % world.w;
        const y = (i / world.w) | 0;
        if (x < x0 || x > x1 || y < y0 || y > y1 || !world.flood[i]) continue;
        const r = 0.15 + ((t * 0.8 + hash3(x, y, 1)) % 1) * 0.3;
        ctx.moveTo(x + 0.5 + r, y + 0.5);
        ctx.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    for (const i of this.hazards) {
      const x = i % world.w;
      const y = (i / world.w) | 0;
      if (x < x0 || x > x1 || y < y0 || y > y1 || !world.fire[i]) continue;
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

  /**
   * Over a zone that can't develop, a bolt for no power and a road sign for no road (or no commute along one), side by
   * side when it lacks both. They blink, or with less motion asked for, stay lit.
   */
  private drawWarnings(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    if (!lessMotion() && this.time % 1.2 > 0.75) return;
    for (const b of this.world.buildings.values()) {
      if (!isZone(b.kind)) continue;
      if (b.x > x1 || b.y > y1 || b.x + b.size < x0 || b.y + b.size < y0) continue;
      const dark = !b.powered;
      const cut = cutOff(this.world, b);
      if (!dark && !cut) continue;
      const both = dark && cut;
      if (dark) bolt(ctx, b.x + (both ? 1 : 1.5), b.y + 1.5, 0.42);
      if (cut) roadSign(ctx, b.x + (both ? 2 : 1.5), b.y + 1.5, 0.42);
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

  /**
   * The tile or building the Inspect card describes, in caution yellow over a dark edge (as the brush ring is drawn),
   * 2 px wide just outside its footprint so a finger's worth of neighbours can't be taken for it.
   */
  private drawSelected(ctx: CanvasRenderingContext2D): void {
    const s = this.selected;
    if (!s) return;
    const px = 1 / this.cam.zoom;
    ctx.strokeStyle = 'rgba(14,20,18,0.8)';
    ctx.lineWidth = 4 * px;
    ctx.strokeRect(s.x - px, s.y - px, s.size + 2 * px, s.size + 2 * px);
    ctx.strokeStyle = '#f2c14e';
    ctx.lineWidth = 2 * px;
    ctx.strokeRect(s.x - px, s.y - px, s.size + 2 * px, s.size + 2 * px);
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
    // The power layer is drawn at 4 pixels a tile, for the hatching on an overloaded grid; the rest at one.
    const S = this.overlay === 'power' ? POWER_PX : 1;
    if (this.overlayCanvas.width !== world.w * S || this.overlayCanvas.height !== world.h * S) {
      this.overlayCanvas.width = world.w * S;
      this.overlayCanvas.height = world.h * S;
    }
    const oc = this.overlayCanvas.getContext('2d')!;
    const img = oc.createImageData(world.w * S, world.h * S);
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
        let c: number[] | null = null;
        let hatch = false;
        if (world.powered[i]) c = [242, 201, 76, 200];
        else if (id && world.buildings.get(id)?.kind !== 'park') {
          // Connected to a plant but its grid is short (hatched, so it differs from the next without colour), or not
          // connected at all.
          if (this.sim?.gridAt(i)) {
            c = [240, 138, 60, 220];
            hatch = true;
          } else c = [227, 73, 72, 220];
        } else if (world.net[i] & 4) c = [120, 110, 90, 200];
        if (!c) continue;
        const tx = (i % world.w) * S;
        const ty = ((i / world.w) | 0) * S;
        for (let py = ty; py < ty + S; py++) {
          for (let px = tx; px < tx + S; px++) {
            const p = (py * world.w * S + px) * 4;
            d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2];
            // Every other diagonal at a lower alpha, running on across the tiles.
            d[p + 3] = hatch && (px + py) % 4 >= 2 ? 90 : c[3];
          }
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

/** Pixels a tile in the power layer's picture, enough for its hatching. */
const POWER_PX = 4;

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

/**
 * Whether a zone gets the road sign: no road along a side, looked at now (as the checklist does) so that a road just
 * laid takes the sign away at once, even with the clock stopped; or a road the simulation has seen too, but no commute
 * along it. The commute is judged only at a month's end, so until then a new road earns the benefit of the doubt.
 */
export function cutOff(world: World, b: Building): boolean {
  return !world.touchesRoad(b) || (b.road && !b.trip);
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

/** A caution-yellow diamond, like a road sign, with a road running up it, on the bolt's dark disc. */
function roadSign(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = 'rgba(20,24,22,0.8)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  const d = r * 0.72;
  ctx.fillStyle = '#F2C94C';
  ctx.beginPath();
  ctx.moveTo(x, y - d);
  ctx.lineTo(x + d, y);
  ctx.lineTo(x, y + d);
  ctx.lineTo(x - d, y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,24,22,0.9)';
  ctx.lineWidth = r * 0.11;
  ctx.beginPath();
  ctx.moveTo(x - d * 0.12, y - d * 0.5);
  ctx.lineTo(x - d * 0.32, y + d * 0.5);
  ctx.moveTo(x + d * 0.12, y - d * 0.5);
  ctx.lineTo(x + d * 0.32, y + d * 0.5);
  ctx.stroke();
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

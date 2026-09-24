// Terrain generation and the sculpting brushes used by the Terrain Editor.
import { MinHeap } from './heap';
import { Noise2D } from './noise';
import { clamp, hash3, hashString, makeRng, smoothstep } from './rng';
import { World } from './world';

export type TerrainStyle = 'coast' | 'island' | 'archipelago' | 'lakes' | 'valley';

export interface TerrainParams {
  seed: string;
  w: number;
  h: number;
  style: TerrainStyle;
  /** 0-100: share of the map that is sea (sea styles only). */
  water: number;
  /** 0-100: how mountainous. */
  hills: number;
  /** 0-100: small-scale ruggedness and coastline wiggle. */
  rough: number;
  /** Number of rivers, 0-6. */
  rivers: number;
  /** 0-100: how many inland lakes. */
  lakes: number;
  /** 0-100: forest cover. */
  forest: number;
}

export const DEFAULT_TERRAIN: Omit<TerrainParams, 'seed' | 'w' | 'h'> = {
  style: 'coast',
  water: 35,
  hills: 45,
  rough: 45,
  rivers: 2,
  lakes: 30,
  forest: 45,
};

export const STYLE_NAMES: Record<TerrainStyle, string> = {
  coast: 'Coastline',
  island: 'Island',
  archipelago: 'Archipelago',
  lakes: 'Lake country',
  valley: 'River valley',
};

export function hasSea(style: TerrainStyle): boolean {
  return style === 'coast' || style === 'island' || style === 'archipelago';
}

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function generateTerrain(p: TerrainParams): World {
  const { w, h } = p;
  const world = new World(w, h);
  const n = w * h;
  const seed = hashString(p.seed || 'terraville');
  const rng = makeRng(seed ^ 0x9e3779b9);
  const base = new Noise2D(seed);
  const warp = new Noise2D(seed + 1);
  const mtn = new Noise2D(seed + 2);
  const detail = new Noise2D(seed + 3);
  const forestN = new Noise2D(seed + 4);

  const S = 44; // feature scale in tiles
  const rough = p.rough / 100;
  const hills = p.hills / 100;
  const e = new Float32Array(n);
  // A smoother twin of `e` that drives elevation, so coastlines can be
  // intricate while the lowlands behind them stay buildable.
  const eh = new Float32Array(n);

  // Style mask parameters.
  const angle = rng() * Math.PI * 2;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const cx = w / 2 + (rng() - 0.5) * w * 0.1;
  const cy = h / 2 + (rng() - 0.5) * h * 0.1;
  // A sinuous valley line for the valley style.
  const vAngle = rng() * Math.PI;
  const vx = Math.cos(vAngle);
  const vy = Math.sin(vAngle);
  const vPhase = rng() * 10;
  const span = Math.hypot(w, h) / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / S;
      const v = y / S;
      const qx = warp.fbm(u * 0.8, v * 0.8, 3);
      const qy = warp.fbm(u * 0.8 + 5.2, v * 0.8 + 1.3, 3);
      const wAmt = 0.35 + rough * 0.6;
      let c = base.fbm(u + wAmt * qx, v + wAmt * qy, 5, 2, 0.42 + rough * 0.18);
      let cs = base.fbm(u + wAmt * qx, v + wAmt * qy, 2, 2, 0.45);
      const nx = (x - cx) / (w / 2);
      const ny = (y - cy) / (h / 2);
      let m = 0;
      switch (p.style) {
        case 'coast': {
          const t = ((x / w - 0.5) * dirX + (y / h - 0.5) * dirY) * 2;
          m = t * 0.75 + 0.05;
          break;
        }
        case 'island': {
          const r = Math.sqrt(nx * nx + ny * ny);
          m = 0.55 - r * 1.05;
          break;
        }
        case 'archipelago': {
          const r = Math.max(Math.abs(nx), Math.abs(ny));
          m = 0.05 - smoothstep(0.6, 1.0, r) * 0.8;
          c = base.fbm((u + wAmt * qx) * 1.8, (v + wAmt * qy) * 1.8, 5, 2, 0.5);
          cs = base.fbm((u + wAmt * qx) * 1.8, (v + wAmt * qy) * 1.8, 2, 2, 0.5);
          break;
        }
        case 'lakes': {
          // A gentle tilt so the country drains toward one edge.
          const t = ((x - w / 2) * dirX + (y - h / 2) * dirY) / span;
          m = 0.4 + t * 0.25;
          break;
        }
        case 'valley': {
          const along = (x - w / 2) * vx + (y - h / 2) * vy;
          const across = -(x - w / 2) * vy + (y - h / 2) * vx;
          const wiggle = Math.sin(along / 14 + vPhase) * 5 + base.get(along / 30, 3.3) * 6;
          const d = Math.abs(across - wiggle) / (Math.min(w, h) * 0.5);
          m = 0.1 + smoothstep(0.0, 0.9, d) * 0.45 + (along / span) * 0.18;
          cs *= 0.35 + smoothstep(0.05, 0.4, d) * 0.65;
          break;
        }
      }
      e[y * w + x] = c * 0.55 + m;
      eh[y * w + x] = cs * 0.55 + m;
    }
  }

  // Sea threshold from the requested water share.
  const sea = hasSea(p.style);
  let thr = -Infinity;
  let minH = Infinity;
  if (sea) {
    const frac = p.style === 'archipelago' ? 0.35 + (p.water / 100) * 0.4 : 0.08 + (p.water / 100) * 0.55;
    const sorted = Float32Array.from(e).sort();
    thr = sorted[Math.floor(clamp(frac, 0, 0.95) * (n - 1))];
  } else {
    for (let i = 0; i < n; i++) minH = Math.min(minH, e[i], eh[i]);
    thr = minH - 0.01;
  }

  // Elevation: gentle plains everywhere, plus mountain ranges confined to
  // regions picked by a very low-frequency mask. `hills` widens the regions
  // and raises the peaks.
  const hgt = world.height;
  const regionT = 0.55 - hills * 0.9;
  const peak = 30 + hills * 230;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = e[i] - thr;
      if (a < 0) {
        hgt[i] = Math.max(-40, a * 90 - 0.5);
        world.water[i] = 1;
        continue;
      }
      const ah = Math.max(0, eh[i] - thr);
      let height = 0.6 + a * 3 + ah * (14 + hills * 26);
      const region = mtn.fbm(x / 70 + 40, y / 70 - 12, 3);
      const mask = smoothstep(regionT - 0.12, regionT + 0.22, region) * smoothstep(0.06, 0.3, ah);
      if (mask > 0) {
        const r = mtn.ridged(x / (S * 0.9), y / (S * 0.9), 4);
        const bulk = 0.5 + 0.5 * mtn.fbm(x / 30, y / 30, 3);
        height += mask * peak * (0.55 * r * r + 0.45 * bulk * bulk) * mask;
      }
      height += detail.fbm(x / 7, y / 7, 3) * rough * (0.5 + height * 0.035);
      hgt[i] = Math.max(0.4, height);
    }
  }

  // Lake basins: dimples that the priority flood below will fill with water.
  const lakeCount = Math.round((p.lakes / 100) * (n / 2400) * (p.style === 'lakes' ? 3 : 1));
  for (let k = 0; k < lakeCount; k++) {
    const lx = Math.floor(rng() * w);
    const ly = Math.floor(rng() * h);
    if (world.water[ly * w + lx]) continue;
    const rad = 2.5 + rng() * (p.style === 'lakes' ? 6 : 4);
    const depth = 4 + rng() * 8;
    const r2 = Math.ceil(rad * 2);
    for (let dy = -r2; dy <= r2; dy++) {
      for (let dx = -r2; dx <= r2; dx++) {
        const x = lx + dx;
        const y = ly + dy;
        if (!world.inBounds(x, y)) continue;
        const i = y * w + x;
        if (world.water[i]) continue;
        const wob = 1 + detail.get(x / 4, y / 4) * 0.35;
        const d = Math.sqrt(dx * dx + dy * dy) / (rad * wob);
        if (d < 1.6) hgt[i] -= depth * Math.exp(-d * d * 1.4);
        if (hgt[i] < 0.4) hgt[i] = 0.4;
      }
    }
  }

  const { filled, down } = priorityFlood(world);

  if (p.lakes > 0) fillLakes(world, filled, p.lakes / 100);

  // Rivers from high springs down the flood-routed drainage.
  const springs = pickSprings(world, rng, p.rivers);
  if (p.style === 'valley') {
    // The valley always carries a main river from its high end.
    for (let along = span * 0.9; along > 0; along -= 2) {
      const wiggle = Math.sin(along / 14 + vPhase) * 5 + base.get(along / 30, 3.3) * 6;
      const x = Math.round(w / 2 + along * vx - wiggle * vy);
      const y = Math.round(h / 2 + along * vy + wiggle * vx);
      if (x > 1 && y > 1 && x < w - 2 && y < h - 2) {
        springs.unshift(y * w + x);
        break;
      }
    }
  }
  for (const s of springs) traceRiver(world, s, down, filled);

  // Forests.
  const forest = p.forest / 100;
  const shore = shoreDistance(world, 5);
  const t0 = 0.55 - forest * 1.15;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (world.water[i]) continue;
      let f = forestN.fbm(x / 22, y / 22, 4) + forestN.get(x / 5, y / 5) * 0.18;
      if (shore[i] <= 4) f += (5 - shore[i]) * 0.04;
      if (hgt[i] > 170) f -= (hgt[i] - 170) / 60;
      if (hgt[i] < 1.2 && shore[i] <= 1) f -= 0.5;
      const d = f - t0;
      if (d > 0) world.trees[i] = Math.min(3, 1 + Math.floor(d * 5));
    }
  }
  world.city.seed = p.seed;
  return world;
}

/**
 * Turn closed depressions into lakes. Each basin fills from its deepest point
 * up, but never beyond `cap` tiles, so wide flat hollows become a lake in the
 * middle of a meadow rather than an inland sea.
 */
function fillLakes(world: World, filled: Float32Array, amount: number): void {
  const { w, n } = world;
  const hgt = world.height;
  const seen = new Uint8Array(n);
  const cap = Math.round(30 + amount * 260);
  const minDepth = 1.2 - amount * 0.8;
  for (let s = 0; s < n; s++) {
    if (seen[s] || world.water[s] || filled[s] - hgt[s] < 0.3) continue;
    // Collect the basin.
    const basin: number[] = [s];
    seen[s] = 1;
    for (let k = 0; k < basin.length; k++) {
      const i = basin[k];
      const x = i % w;
      const y = (i / w) | 0;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!world.inBounds(nx, ny)) continue;
        const j = ny * w + nx;
        if (seen[j] || world.water[j] || filled[j] - hgt[j] < 0.3) continue;
        seen[j] = 1;
        basin.push(j);
      }
    }
    let maxDepth = 0;
    for (const i of basin) maxDepth = Math.max(maxDepth, filled[i] - hgt[i]);
    if (maxDepth < minDepth || basin.length < 3) continue;
    basin.sort((a, b) => (filled[b] - hgt[b]) - (filled[a] - hgt[a]));
    const take = Math.min(basin.length, cap);
    for (let k = 0; k < take; k++) world.water[basin[k]] = 1;
  }
}

/**
 * Priority flood (Barnes et al.): every land tile gets a downstream neighbour
 * such that following `down` always reaches the sea or the map edge, and
 * `filled` is the height water would pool to.
 */
export function priorityFlood(world: World): { filled: Float32Array; down: Int32Array } {
  const { w, h, n } = world;
  const filled = new Float32Array(n);
  const down = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n);
  const hgt = world.height;
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = (i / w) | 0;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    const sea = world.water[i] && hgt[i] < 0;
    if (edge || sea) {
      filled[i] = sea ? Math.min(hgt[i], 0) : hgt[i];
      done[i] = 1;
      heap.push(i, filled[i]);
    }
  }
  while (heap.size) {
    const i = heap.pop();
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (done[j]) continue;
      done[j] = 1;
      filled[j] = Math.max(hgt[j], filled[i] + 0.001);
      down[j] = i;
      heap.push(j, filled[j]);
    }
  }
  return { filled, down };
}

function pickSprings(world: World, rng: () => number, count: number): number[] {
  const { w, h, n } = world;
  const land: number[] = [];
  for (let i = 0; i < n; i++) if (!world.water[i]) land.push(i);
  if (!land.length || count <= 0) return [];
  land.sort((a, b) => world.height[b] - world.height[a]);
  const top = land.slice(0, Math.max(10, Math.floor(land.length * 0.3)));
  const out: number[] = [];
  const minD = Math.min(w, h) * 0.28;
  for (let tries = 0; tries < 400 && out.length < count; tries++) {
    const i = top[Math.floor(rng() * top.length)];
    const x = i % w;
    const y = (i / w) | 0;
    if (x < 3 || y < 3 || x > w - 4 || y > h - 4) continue;
    let ok = true;
    for (const j of out) {
      const d = Math.hypot((j % w) - x, ((j / w) | 0) - y);
      if (d < minD) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Carve a river from tile `start` following `down` pointers. Returns tiles touched. */
export function traceRiver(world: World, start: number, down: Int32Array, filled?: Float32Array): number[] {
  const { w } = world;
  const hgt = world.height;
  const path: number[] = [];
  let i = start;
  let guard = 0;
  while (i >= 0 && guard++ < world.n) {
    path.push(i);
    if (world.water[i] && hgt[i] < 0) break;
    i = down[i];
  }
  const touched: number[] = [];
  let level = hgt[start];
  for (let k = 0; k < path.length; k++) {
    const j = path[k];
    const x = j % w;
    const y = (j / w) | 0;
    const wasSea = world.water[j] && hgt[j] < 0;
    if (wasSea) break;
    if (!world.water[j]) {
      level = Math.min(level, hgt[j]);
      hgt[j] = Math.max(0.1, level - 0.8);
      level = hgt[j];
    } else if (filled) {
      level = Math.min(level, filled[j]);
    }
    world.water[j] = 1;
    world.trees[j] = 0;
    touched.push(j);
    // Wider downstream.
    const width = k > 70 ? 2 : k > 28 ? 1 : 0;
    if (width > 0) {
      const next = path[k + 1] ?? j;
      const ddx = (next % w) - x;
      const ddy = ((next / w) | 0) - y;
      const side = [[-ddy, ddx], [ddy, -ddx]];
      for (let s = 0; s < width; s++) {
        const [sx, sy] = side[s];
        const nx = x + sx;
        const ny = y + sy;
        if (!world.inBounds(nx, ny)) continue;
        const q = ny * w + nx;
        if (!world.water[q]) {
          world.water[q] = 1;
          world.trees[q] = 0;
          hgt[q] = Math.min(hgt[q], hgt[j] + 0.3);
          touched.push(q);
        }
      }
    }
    // Soften the banks into a valley.
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (!world.inBounds(nx, ny)) continue;
      const q = ny * w + nx;
      if (!world.water[q]) hgt[q] = hgt[q] * 0.6 + (hgt[j] + 1.2) * 0.4;
    }
  }
  return touched;
}

/** BFS distance (in tiles, capped) from each tile to the nearest water tile. */
export function shoreDistance(world: World, cap: number): Uint8Array {
  const { w, h, n } = world;
  const dist = new Uint8Array(n).fill(cap + 1);
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (world.water[i]) {
      dist[i] = 0;
      q[tail++] = i;
    }
  }
  while (head < tail) {
    const i = q[head++];
    const d = dist[i];
    if (d >= cap) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0 && dist[i - 1] > d + 1) { dist[i - 1] = d + 1; q[tail++] = i - 1; }
    if (x < w - 1 && dist[i + 1] > d + 1) { dist[i + 1] = d + 1; q[tail++] = i + 1; }
    if (y > 0 && dist[i - w] > d + 1) { dist[i - w] = d + 1; q[tail++] = i - w; }
    if (y < h - 1 && dist[i + w] > d + 1) { dist[i + w] = d + 1; q[tail++] = i + w; }
  }
  return dist;
}

// ---- sculpting ----------------------------------------------------------

export interface BrushOptions {
  radius: number;
  strength: number;
  /** Target height for flatten / level. */
  target?: number;
  /** Seconds since the last application, so holding the mouse is frame-rate independent. */
  dt: number;
  /** In city mode brushes leave built tiles alone. */
  protectBuilt?: boolean;
}

export interface BrushResult {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Total metres of earth moved (for the city-mode cost). */
  moved: number;
}

export function applyBrush(world: World, tool: string, cx: number, cy: number, o: BrushOptions): BrushResult {
  const { w } = world;
  const r = o.radius;
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(world.w - 1, Math.ceil(cx + r));
  const y1 = Math.min(world.h - 1, Math.ceil(cy + r));
  const hgt = world.height;
  const rate = o.strength * o.dt;
  let moved = 0;
  const src = tool === 'smooth' ? hgt.slice() : hgt;
  const t = performance.now() / 1000;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d > 1) continue;
      const f = 0.5 + 0.5 * Math.cos(Math.PI * d);
      const i = y * w + x;
      if (o.protectBuilt && (world.occ[i] || world.net[i])) continue;
      const before = hgt[i];
      switch (tool) {
        case 'raise':
          hgt[i] += rate * 18 * f;
          break;
        case 'lower':
          hgt[i] -= rate * 18 * f;
          break;
        case 'smooth': {
          let s = 0;
          let c = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (!world.inBounds(nx, ny)) continue;
              s += src[ny * w + nx];
              c++;
            }
          }
          hgt[i] += (s / c - hgt[i]) * Math.min(1, rate * 5 * f);
          break;
        }
        case 'flatten':
        case 'level': {
          const target = o.target ?? hgt[i];
          const k = tool === 'level' ? Math.min(1, rate * 6 * f + (f > 0.6 ? 0.25 : 0)) : Math.min(1, rate * 4 * f);
          hgt[i] += (target - hgt[i]) * k;
          break;
        }
        case 'roughen':
          hgt[i] += (hash3(x, y, (t * 10) | 0) - 0.5) * rate * 30 * f;
          break;
        case 'water':
          if (f > 0.35) {
            world.water[i] = 1;
            world.trees[i] = 0;
          }
          break;
        case 'land':
          if (f > 0.35 && world.water[i]) {
            world.water[i] = 0;
            if (hgt[i] < 0.5) hgt[i] = 0.5;
          }
          break;
        case 'forest':
          if (!world.water[i] && hash3(x, y, (t * 20) | 0) < rate * 6 * f) {
            world.trees[i] = Math.min(3, world.trees[i] + 1);
          }
          break;
        case 'clear':
          if (f > 0.3) world.trees[i] = 0;
          break;
      }
      if (tool === 'raise' || tool === 'lower' || tool === 'roughen') {
        hgt[i] = clamp(hgt[i], -40, 400);
        if (hgt[i] < 0 && before >= 0) {
          world.water[i] = 1;
          world.trees[i] = 0;
        } else if (hgt[i] >= 0 && before < 0 && world.water[i]) {
          world.water[i] = 0;
        }
      }
      moved += Math.abs(hgt[i] - before);
    }
  }
  world.dirty(x0 - 1, y0 - 1, x1 + 1, y1 + 1, true);
  return { x0, y0, x1, y1, moved };
}

/** Drop a spring on high ground and let it run to the sea or off the map. */
export function addSpring(world: World, x: number, y: number): number {
  if (!world.inBounds(x, y)) return 0;
  const { down, filled } = priorityFlood(world);
  const touched = traceRiver(world, y * world.w + x, down, filled);
  if (touched.length) world.dirtyAll(true);
  return touched.length;
}

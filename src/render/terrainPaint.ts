// Per-pixel terrain: hillshaded elevation colours, smooth coastlines with
// beaches, water depth, and optional contour lines. Values are stored at
// tile centres and interpolated bilinearly, which rounds off the tile grid.
import { World } from '../world';
import { RGB, hex } from './color';

const STOPS: [number, RGB][] = [
  [0, hex('#9DC06A')],
  [8, hex('#8DB75D')],
  [30, hex('#77A64F')],
  [70, hex('#6C9447')],
  [110, hex('#7F8A4F')],
  [150, hex('#8C7E60')],
  [200, hex('#958A7E')],
  [260, hex('#AEA79E')],
  [310, hex('#D6D3CE')],
  [340, hex('#F1F3F4')],
];

function elevColor(h: number, out: Float32Array, o: number): void {
  if (h <= STOPS[0][0]) {
    const c = STOPS[0][1];
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
    return;
  }
  for (let k = 1; k < STOPS.length; k++) {
    if (h <= STOPS[k][0]) {
      const [h0, c0] = STOPS[k - 1];
      const [h1, c1] = STOPS[k];
      const t = (h - h0) / (h1 - h0);
      out[o] = c0[0] + (c1[0] - c0[0]) * t;
      out[o + 1] = c0[1] + (c1[1] - c0[1]) * t;
      out[o + 2] = c0[2] + (c1[2] - c0[2]) * t;
      return;
    }
  }
  const c = STOPS[STOPS.length - 1][1];
  out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
}

const SHALLOW = hex('#6FB3CF');
const DEEP = hex('#2E5F8E');
const SAND = hex('#DCCB93');
const FOAM = hex('#CFE8EF');

// Light from the upper left, fairly low for readable relief.
const LX = -0.55;
const LY = -0.62;
const LZ = 0.56;

export class TerrainField {
  readonly w: number;
  readonly h: number;
  col: Float32Array;
  wat: Float32Array;
  deep: Float32Array;
  sandy: Float32Array;

  constructor(private world: World) {
    this.w = world.w;
    this.h = world.h;
    const n = world.n;
    this.col = new Float32Array(n * 3);
    this.wat = new Float32Array(n);
    this.deep = new Float32Array(n);
    this.sandy = new Float32Array(n);
    this.updateWater();
    this.updateColors(0, 0, world.w - 1, world.h - 1);
  }

  /** Water flags and depth (distance from shore) for the whole map. */
  updateWater(): void {
    const { w, h, n } = this.world;
    const water = this.world.water;
    const dist = new Uint8Array(n).fill(255);
    const q = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i++) {
      this.wat[i] = water[i] ? 1 : 0;
      if (!water[i]) {
        dist[i] = 0;
        q[tail++] = i;
      }
    }
    while (head < tail) {
      const i = q[head++];
      const d = dist[i];
      if (d >= 8) continue;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && dist[i - 1] > d + 1) { dist[i - 1] = d + 1; q[tail++] = i - 1; }
      if (x < w - 1 && dist[i + 1] > d + 1) { dist[i + 1] = d + 1; q[tail++] = i + 1; }
      if (y > 0 && dist[i - w] > d + 1) { dist[i - w] = d + 1; q[tail++] = i - w; }
      if (y < h - 1 && dist[i + w] > d + 1) { dist[i + w] = d + 1; q[tail++] = i + w; }
    }
    for (let i = 0; i < n; i++) {
      this.deep[i] = water[i] ? Math.min(1, (Math.min(dist[i], 9) - 0.5) / 6) : 0;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let near = false;
        if (!water[i]) {
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < w && ny < h && water[ny * w + nx] && this.world.height[ny * w + nx] < 0) {
                near = true;
                break;
              }
            }
          }
        }
        this.sandy[i] = near && this.world.height[i] < 3.5 ? 1 : 0;
      }
    }
  }

  updateColors(x0: number, y0: number, x1: number, y1: number): void {
    const { w, h } = this;
    const hg = this.world.height;
    const water = this.world.water;
    x0 = Math.max(0, x0 - 1);
    y0 = Math.max(0, y0 - 1);
    x1 = Math.min(w - 1, x1 + 1);
    y1 = Math.min(h - 1, y1 + 1);
    const ex = 1 / 16;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const o = i * 3;
        const hc = Math.max(0, hg[i]);
        const hl = Math.max(0, hg[y * w + Math.max(0, x - 1)]);
        const hr = Math.max(0, hg[y * w + Math.min(w - 1, x + 1)]);
        const hu = Math.max(0, hg[Math.max(0, y - 1) * w + x]);
        const hd = Math.max(0, hg[Math.min(h - 1, y + 1) * w + x]);
        const dzdx = ((hr - hl) / 2) * ex;
        const dzdy = ((hd - hu) / 2) * ex;
        const len = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        const nx = -dzdx / len;
        const ny = -dzdy / len;
        const nz = 1 / len;
        const d = nx * LX + ny * LY + nz * LZ;
        const lit = 0.7 + 0.55 * d;
        elevColor(water[i] ? 0 : hc, this.col, o);
        // Shadows lean blue, sunlit slopes lean warm.
        const warm = Math.max(0, lit - 1);
        const cool = Math.max(0, 1 - lit);
        this.col[o] *= lit * (1 + warm * 0.25 - cool * 0.12);
        this.col[o + 1] *= lit * (1 + warm * 0.12 - cool * 0.04);
        this.col[o + 2] *= lit * (1 - warm * 0.1 + cool * 0.22);
      }
    }
  }
}

function hash2(x: number, y: number): number {
  let hh = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  hh = Math.imul(hh ^ (hh >>> 13), 1274126177);
  return ((hh ^ (hh >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1): bilinear between hashed lattice points. */
function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix + seed, iy);
  const b = hash2(ix + 1 + seed, iy);
  const c = hash2(ix + seed, iy + 1);
  const d = hash2(ix + 1 + seed, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Paint a CS x CS block of tiles starting at (tx0, ty0) at L pixels per tile.
 * Returns ImageData ready for putImageData.
 */
export function paintTerrain(
  ctx: CanvasRenderingContext2D,
  field: TerrainField,
  world: World,
  tx0: number,
  ty0: number,
  CS: number,
  L: number,
  contours: boolean,
): ImageData {
  const W = CS * L;
  const img = ctx.createImageData(W, W);
  const data = img.data;
  const { w, h } = field;
  const col = field.col;
  const wat = field.wat;
  const deep = field.deep;
  const sandy = field.sandy;
  const hg = world.height;
  const grain = L >= 16 ? 16 / L : 1;
  const prevRow = new Float32Array(W);
  const interval = 10;

  for (let py = 0; py < W; py++) {
    const v = ty0 + (py + 0.5) / L - 0.5;
    let iy = Math.floor(v);
    const fy = v - iy;
    const y0 = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
    iy++;
    const y1 = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
    let prevH = 0;
    for (let px = 0; px < W; px++) {
      const u = tx0 + (px + 0.5) / L - 0.5;
      let ix = Math.floor(u);
      const fx = u - ix;
      const x0 = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
      ix++;
      const x1 = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
      const i00 = y0 * w + x0;
      const i10 = y0 * w + x1;
      const i01 = y1 * w + x0;
      const i11 = y1 * w + x1;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const wv = wat[i00] * w00 + wat[i10] * w10 + wat[i01] * w01 + wat[i11] * w11;
      const gx = Math.floor((tx0 * L + px) * grain);
      const gy = Math.floor((ty0 * L + py) * grain);
      const n = hash2(gx, gy);
      let r: number, g: number, b: number;
      const o = (py * W + px) * 4;
      if (wv > 0.5) {
        const dv = deep[i00] * w00 + deep[i10] * w10 + deep[i01] * w01 + deep[i11] * w11;
        r = SHALLOW[0] + (DEEP[0] - SHALLOW[0]) * dv;
        g = SHALLOW[1] + (DEEP[1] - SHALLOW[1]) * dv;
        b = SHALLOW[2] + (DEEP[2] - SHALLOW[2]) * dv;
        if (wv < 0.6) {
          const t = 1 - (wv - 0.5) / 0.1;
          r += (FOAM[0] - r) * t * 0.7;
          g += (FOAM[1] - g) * t * 0.7;
          b += (FOAM[2] - b) * t * 0.7;
        }
        const k = 0.97 + n * 0.05;
        r *= k; g *= k; b *= k;
      } else {
        const o00 = i00 * 3, o10 = i10 * 3, o01 = i01 * 3, o11 = i11 * 3;
        r = col[o00] * w00 + col[o10] * w10 + col[o01] * w01 + col[o11] * w11;
        g = col[o00 + 1] * w00 + col[o10 + 1] * w10 + col[o01 + 1] * w01 + col[o11 + 1] * w11;
        b = col[o00 + 2] * w00 + col[o10 + 2] * w10 + col[o01 + 2] * w01 + col[o11 + 2] * w11;
        if (wv > 0.12) {
          const sv = sandy[i00] * w00 + sandy[i10] * w10 + sandy[i01] * w01 + sandy[i11] * w11;
          if (sv > 0.2) {
            const t = Math.min(1, (wv - 0.12) / 0.2) * Math.min(1, sv * 1.6);
            r += (SAND[0] - r) * t;
            g += (SAND[1] - g) * t;
            b += (SAND[2] - b) * t;
          } else {
            // Steep banks: a darker wet edge.
            const t = Math.min(1, (wv - 0.12) / 0.38) * 0.25;
            r *= 1 - t; g *= 1 - t; b *= 1 - t;
          }
        }
        const k = 0.965 + n * 0.07;
        // Meadow patches: drier and lusher ground at two scales.
        const uu = tx0 + (px + 0.5) / L;
        const vv = ty0 + (py + 0.5) / L;
        const big = vnoise(uu * 0.45, vv * 0.45, 911) - 0.5;
        const small = L >= 16 ? vnoise(uu * 2.2, vv * 2.2, 313) - 0.5 : 0;
        const dry = big * 0.9 + small * 0.5;
        r *= k * (1 + dry * 0.16);
        g *= k * (1 + dry * 0.05 + small * 0.04);
        b *= k * (1 - dry * 0.12);
        if (contours) {
          const hv = hg[i00] * w00 + hg[i10] * w10 + hg[i01] * w01 + hg[i11] * w11;
          const band = Math.floor(hv / interval);
          const up = py > 0 ? Math.floor(prevRow[px] / interval) : band;
          const left = px > 0 ? Math.floor(prevH / interval) : band;
          if (hv > 0 && (band !== up || band !== left)) {
            const major = Math.max(band, up, left) % 5 === 0;
            const f = major ? 0.72 : 0.86;
            r *= f; g *= f; b *= f;
          }
          prevRow[px] = hv;
          prevH = hv;
        }
      }
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return img;
}
